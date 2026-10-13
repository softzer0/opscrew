import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine } from "@opscrew/contracts";
import { ensureStateDir, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { type EnginePreference, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";

/** A server's public addresses. */
export interface ServerAddress {
  ipv4: string;
  ipv6?: string;
}

const AddressSchema = z.strictObject({ ipv4: z.ipv4(), ipv6: z.ipv6().optional() });

const ServerAddressesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The server that receives the app's traffic (the one `plan.deployment` describes). */
  deployment: AddressSchema.optional(),
  /** During `opscrew retarget`: the server being replaced and the new one, once created. */
  retarget: z
    .strictObject({ from: AddressSchema.optional(), next: AddressSchema.optional() })
    .optional(),
});

/**
 * `.opscrew/server.json`: the servers' IP addresses. They are kept in OpsCrew's local state
 * (gitignored), never in `opscrew/plan.yaml` or another committed file, so a public repository
 * does not reveal the origin behind Cloudflare's proxy.
 */
export type ServerAddresses = z.infer<typeof ServerAddressesSchema>;

const EMPTY: ServerAddresses = { schemaVersion: 1 };

/** The engine state file provision, destroy and drift use. */
const STATE_FILE = "prod.tfstate";

/** Path of `.opscrew/server.json`. */
export function serverAddressesFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "server.json");
}

/**
 * Reads `.opscrew/server.json`. A missing or unreadable file reads as empty: it is a local record
 * that {@link serverAddress} rebuilds from the infrastructure state.
 */
export async function readServerAddresses(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<ServerAddresses> {
  let text: string;
  try {
    text = await readFile(serverAddressesFile(paths), "utf8");
  } catch {
    return { ...EMPTY };
  }
  try {
    const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const parsed = ServerAddressesSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** Rewrites `.opscrew/server.json` (atomically, inside the gitignored `.opscrew/`). */
export async function updateServerAddresses(
  paths: ProjectPaths,
  update: (current: ServerAddresses) => ServerAddresses,
): Promise<ServerAddresses> {
  const next = ServerAddressesSchema.parse(update(await readServerAddresses(paths)));
  await ensureStateDir(paths);
  await writeFileAtomic(serverAddressesFile(paths), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Records the address of the server that receives the traffic; `undefined` forgets it. */
export async function recordServerAddress(
  paths: ProjectPaths,
  address: ServerAddress | undefined,
): Promise<void> {
  await updateServerAddresses(paths, ({ deployment: _old, ...rest }) =>
    address === undefined ? rest : { ...rest, deployment: address },
  );
}

/** The address in root-module outputs `<prefix>_ipv4` / `<prefix>_ipv6`, when valid. */
export function addressFromOutputs(
  outputs: Record<string, unknown>,
  prefix: "server" | "other_server" = "server",
): ServerAddress | undefined {
  const ipv4 = z.ipv4().safeParse(outputs[`${prefix}_ipv4`]);
  if (!ipv4.success) return undefined;
  const ipv6 = z.ipv6().safeParse(outputs[`${prefix}_ipv6`]);
  return { ipv4: ipv4.data, ...(ipv6.success ? { ipv6: ipv6.data } : {}) };
}

/** True when the plan records an applied deployment that was not destroyed since. */
export function hasDeployment(plan: Pick<DeployPlan, "deployment">): boolean {
  return plan.deployment.lastApplyAt !== undefined && plan.deployment.destroyedAt === undefined;
}

/** What {@link serverAddress} needs from the phase. */
export type ServerAddressDeps = Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor" | "clock">;

export interface ServerAddressOptions {
  /** Engine for the fallback (default: `selectEngine` with the plan's engine preference). */
  engine?: (preference: EnginePreference) => Promise<IacEngine>;
  /** Engine environment when the caller already built it (provider tokens, `TF_ENCRYPTION`). */
  engineEnv?: Record<string, string | undefined>;
}

async function nonEmpty(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

/** The root-module outputs read with the project's engine, or `undefined` when that fails. */
async function engineOutputs(
  deps: ServerAddressDeps,
  plan: DeployPlan,
  options: ServerAddressOptions,
): Promise<Record<string, unknown> | undefined> {
  try {
    const engine = options.engine
      ? await options.engine(plan.infra.engine)
      : await selectEngine(plan.infra.engine, {
          runner: deps.runner,
          env: deps.env,
          redactor: deps.redactor,
          now: () => deps.clock.now(),
        });
    let env = options.engineEnv;
    if (env === undefined) {
      env = { ...deps.env };
      if (engine.info.name === "tofu" && plan.infra.stateEncryption) {
        const passphrase = (
          await readFile(deps.paths.files.statePassphrase, "utf8").catch(() => "")
        ).trim();
        if (passphrase !== "") {
          deps.redactor.addLiteral(passphrase, "state-passphrase");
          env.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
        }
      }
    }
    return await engine.output(join(deps.paths.root, plan.infra.dir), { env });
  } catch {
    return undefined;
  }
}

/**
 * The address of the server that receives the app's traffic: from OpsCrew's local state
 * (`.opscrew/server.json`), else, for an applied deployment whose infrastructure state is on this
 * computer, from the OpenTofu/Terraform outputs (`server_ipv4`, `server_ipv6`), which are then
 * recorded in the local state. `undefined` when no server is known. Every command that needs the
 * address reads it here; it is never read from or written to `opscrew/plan.yaml`.
 */
export async function serverAddress(
  deps: ServerAddressDeps,
  plan: DeployPlan,
  options: ServerAddressOptions = {},
): Promise<ServerAddress | undefined> {
  const local = (await readServerAddresses(deps.paths)).deployment;
  if (local !== undefined) return local;
  if (!hasDeployment(plan)) return undefined;
  if (!(await nonEmpty(join(deps.paths.files.tfstateDir, STATE_FILE)))) return undefined;
  const outputs = await engineOutputs(deps, plan, options);
  const address = outputs === undefined ? undefined : addressFromOutputs(outputs);
  if (address !== undefined) {
    await recordServerAddress(deps.paths, address).catch(() => undefined);
  }
  return address;
}

/**
 * True when the app's domain is served through Cloudflare's proxy: the server's address must then
 * stay out of every committed file (plan, runbook, reports), or anyone could go around Cloudflare.
 */
export function hidesServerAddress(plan: Pick<DeployPlan, "dns">): boolean {
  return plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined && plan.dns.proxied;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` with every occurrence of the addresses replaced by `replacement` (default "the server"),
 * for files that are committed while the address must stay private.
 */
export function withoutServerAddress(
  text: string,
  addresses: readonly (ServerAddress | undefined)[],
  replacement = "the server",
): string {
  let out = text;
  for (const address of addresses) {
    if (address === undefined) continue;
    out = out.replace(
      new RegExp(`(?<![\\d.])${escapeRegExp(address.ipv4)}(?![\\d])`, "g"),
      replacement,
    );
    if (address.ipv6 !== undefined) {
      out = out.replace(
        new RegExp(`(?<![0-9a-f:])${escapeRegExp(address.ipv6)}(?![0-9a-f:])`, "gi"),
        replacement,
      );
    }
  }
  return out;
}

/**
 * `url` when it names a domain; `undefined` for a URL on an IP address, which must not be
 * committed (`deployment.url` in `opscrew/plan.yaml` only holds domain URLs).
 */
export function committableUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
  return z.ipv4().safeParse(host).success || z.ipv6().safeParse(host).success ? undefined : url;
}

/** `203.0.113.10` or `203.0.113.10 (IPv6 2001:db8::10)`, for terminal output. */
export function formatServerAddress(address: ServerAddress): string {
  return address.ipv6 === undefined ? address.ipv4 : `${address.ipv4} (IPv6 ${address.ipv6})`;
}
