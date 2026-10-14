import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, VpsProviderId } from "@opscrew/contracts";
import { ensureStateDir, OpsCrewError, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
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

/** A DNS name or a single host label; never starts with `-`, so `ssh` cannot read it as an option. */
const HostNameSchema = z
  .string()
  .regex(
    /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/,
  );

/**
 * Absolute path to a private key file: `/…`, `~/…`, `C:\…` or `C:/…` (spaces allowed). Never the
 * key itself, and never something `ssh` could read as an option: a leading `-` or a PEM marker
 * (`-----BEGIN`, `PRIVATE KEY`) is refused.
 */
const KeyPathSchema = z
  .string()
  .refine((path) => !path.startsWith("-"), { message: "must not start with -" })
  .refine((path) => !path.includes("-----BEGIN") && !path.includes("PRIVATE KEY"), {
    message: "must be the path to the key file, never the key itself",
  })
  .regex(/^(?:\/|~\/|[A-Za-z]:[\\/])[^\0\r\n]*$/, {
    message: "must be an absolute path such as ~/.ssh/id_ed25519",
  });

/**
 * How OpsCrew reaches a server the user owns over SSH. Local only: the address and the login never
 * reach `opscrew/plan.yaml`, pull requests or commit messages. No passwords or passphrases: the key
 * is referenced by path (or the SSH agent holds it).
 */
const OwnServerSchema = z
  .strictObject({
    /** IP address or host name the CLI connects to. */
    host: z.union([z.ipv4(), z.ipv6(), HostNameSchema]),
    /** SSH port. */
    port: z.int().min(1).max(65535).default(22),
    /** The admin login: root or a user with passwordless sudo. */
    user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/),
    /** Path to the private key; absent when the SSH agent holds the key. */
    keyPath: KeyPathSchema.optional(),
    /** Use the SSH agent. */
    agent: z.boolean(),
    /** The pinned host key fingerprint the user confirmed, for example `SHA256:` and 43 characters. */
    hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    /** The addresses DNS points to in public mode. */
    publicIpv4: z.ipv4().optional(),
    publicIpv6: z.ipv6().optional(),
  })
  .refine((own) => own.agent || own.keyPath !== undefined, {
    path: ["keyPath"],
    message: "is required unless the SSH agent is used",
  });

/** How OpsCrew connects to a server the user owns (`.opscrew/server.json` → `own`). */
export type OwnServerConnection = z.output<typeof OwnServerSchema>;
/** {@link OwnServerConnection} as written by callers (`port` defaults to 22). */
export type OwnServerConnectionInput = z.input<typeof OwnServerSchema>;

const ServerAddressesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The server that receives the app's traffic (the one `plan.deployment` describes). */
  deployment: AddressSchema.optional(),
  /** During `opscrew retarget`: the server being replaced and the new one, once created. */
  retarget: z
    .strictObject({ from: AddressSchema.optional(), next: AddressSchema.optional() })
    .optional(),
  /** A server the user owns (`target.provider: own`): how OpsCrew connects to it. */
  own: OwnServerSchema.optional(),
});

/**
 * `.opscrew/server.json`: the servers' IP addresses and, for a server the user owns, how OpsCrew
 * connects to it. They are kept in OpsCrew's local state (gitignored), never in
 * `opscrew/plan.yaml` or another committed file, so a public repository does not reveal the origin
 * behind Cloudflare's proxy.
 */
export type ServerAddresses = z.infer<typeof ServerAddressesSchema>;

const EMPTY: ServerAddresses = { schemaVersion: 1 };

/** The engine state file provision, destroy and drift use. */
const STATE_FILE = "prod.tfstate";

/** Path of `.opscrew/server.json`. */
export function serverAddressesFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "server.json");
}

/** `.opscrew/server.json` exists but cannot be used: OpsCrew never guesses past it. */
function damaged(reason: string): OpsCrewError {
  return new OpsCrewError(
    "ARTIFACT_INVALID",
    `OpsCrew's record of the server addresses on this computer (.opscrew/server.json) is damaged (${reason}), so OpsCrew stopped instead of guessing the servers' addresses.`,
    {
      hint: "Delete .opscrew/server.json and run the command again: OpsCrew then reads the addresses from the infrastructure state in .opscrew/tfstate. If that state is not on this computer, run OpsCrew on the computer that provisioned the server.",
    },
  );
}

/**
 * Reads `.opscrew/server.json`. A missing file reads as empty (a local record that
 * {@link serverAddress} rebuilds from the infrastructure state); a file that cannot be read or is
 * not a valid record stops with `ARTIFACT_INVALID`, never read as empty.
 */
export async function readServerAddresses(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<ServerAddresses> {
  let text: string;
  try {
    text = await readFile(serverAddressesFile(paths), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw damaged("it cannot be read");
  }
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw damaged("it is not valid JSON");
  }
  const parsed = ServerAddressesSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join(".") ?? "";
    throw damaged(where === "" ? "it is not a server record" : `${where} is not valid`);
  }
  return parsed.data;
}

/** Rewrites `.opscrew/server.json` (atomically, inside the gitignored `.opscrew/`). */
export async function updateServerAddresses(
  paths: ProjectPaths,
  update: (current: ServerAddresses) => z.input<typeof ServerAddressesSchema>,
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

/**
 * How OpsCrew connects to the server the user owns, from `.opscrew/server.json`; `undefined` when
 * none is recorded. A damaged file stops with `ARTIFACT_INVALID` (see {@link readServerAddresses}).
 */
export async function readOwnServer(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<OwnServerConnection | undefined> {
  return (await readServerAddresses(paths)).own;
}

/** Records how OpsCrew connects to the server the user owns; `undefined` forgets it. */
export async function recordOwnServer(
  paths: ProjectPaths,
  own: OwnServerConnectionInput | undefined,
): Promise<void> {
  await updateServerAddresses(paths, ({ own: _old, ...rest }) =>
    own === undefined ? rest : { ...rest, own },
  );
}

/** `{ ipv4, ipv6 }` when `ipv4` is a valid address (an invalid `ipv6` is left out). */
function addressOf(ipv4: unknown, ipv6: unknown): ServerAddress | undefined {
  const v4 = z.ipv4().safeParse(ipv4);
  if (!v4.success) return undefined;
  const v6 = z.ipv6().safeParse(ipv6);
  return { ipv4: v4.data, ...(v6.success ? { ipv6: v6.data } : {}) };
}

/**
 * The address of the server that receives the traffic, from the root-module outputs
 * `server_ipv4` / `server_ipv6`, when valid.
 */
export function addressFromOutputs(outputs: Record<string, unknown>): ServerAddress | undefined {
  return addressOf(outputs.server_ipv4, outputs.server_ipv6);
}

const ServersOutputSchema = z.record(
  z.string(),
  z.looseObject({ ipv4: z.unknown().optional(), ipv6: z.unknown().optional() }),
);

/**
 * The address of `provider`'s server from the root-module output `servers` (every server keyed by
 * its provider, whichever module holds it), when valid. A move always goes to another provider,
 * so this tells the server being replaced from the new one without guessing.
 */
export function serverOfProvider(
  outputs: Record<string, unknown>,
  provider: VpsProviderId,
): ServerAddress | undefined {
  const servers = ServersOutputSchema.safeParse(outputs.servers);
  if (!servers.success) return undefined;
  const entry = servers.data[provider];
  return entry === undefined ? undefined : addressOf(entry.ipv4, entry.ipv6);
}

/** True when the plan records an applied deployment that was not destroyed since. */
export function hasDeployment(plan: Pick<DeployPlan, "deployment">): boolean {
  return plan.deployment.lastApplyAt !== undefined && plan.deployment.destroyedAt === undefined;
}

/** What {@link serverAddress} needs from the phase. */
export type ServerAddressDeps = Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor" | "clock">;

export interface ServerAddressOptions {
  /** Engine for the fallback (default: `selectEngine` with {@link preference}). */
  engine?: (preference: EnginePreference) => Promise<IacEngine>;
  /** Engine preference (default: `plan.infra.engine`), for example from `--engine`. */
  preference?: EnginePreference;
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The root-module outputs in `dir`, read from the local state file `statePath`. An engine reads
 * outputs only once the root module is initialised with that backend path, which a computer with
 * a copy of `.opscrew/tfstate` but no `.terraform/` under the root module has not done: then
 * `init` (with `-backend-config=path=…`, as provision and drift run it) comes first, and it is run
 * once more and the read retried when the first read fails (an old or different initialisation).
 * The `init` is best effort; the read's own failure is what is thrown.
 */
export async function readOutputsAfterInit(
  engine: IacEngine,
  dir: string,
  statePath: string,
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const init = () => engine.init(dir, { env, backendConfig: { path: statePath } }).catch(() => {});
  let initialised = false;
  if (!(await isDirectory(join(dir, ".terraform")))) {
    await init();
    initialised = true;
  }
  try {
    return await engine.output(dir, { env });
  } catch (error) {
    if (initialised) throw error;
    await init();
    return engine.output(dir, { env });
  }
}

/** The root-module outputs read with the project's engine, or `undefined` when that fails. */
async function engineOutputs(
  deps: ServerAddressDeps,
  plan: DeployPlan,
  options: ServerAddressOptions,
): Promise<Record<string, unknown> | undefined> {
  const preference = options.preference ?? plan.infra.engine;
  try {
    const engine = options.engine
      ? await options.engine(preference)
      : await selectEngine(preference, {
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
    return await readOutputsAfterInit(
      engine,
      join(deps.paths.root, plan.infra.dir),
      join(deps.paths.files.tfstateDir, STATE_FILE),
      env,
    );
  } catch {
    return undefined;
  }
}

/**
 * The root-module outputs from the infrastructure state on this computer
 * (`.opscrew/tfstate/prod.tfstate`, decrypted with the state passphrase when there is one), read
 * with the project's engine; `undefined` without a state file or when the engine cannot read them.
 * Needs no provider credentials.
 */
export async function infrastructureOutputs(
  deps: ServerAddressDeps,
  plan: DeployPlan,
  options: ServerAddressOptions = {},
): Promise<Record<string, unknown> | undefined> {
  if (!(await nonEmpty(join(deps.paths.files.tfstateDir, STATE_FILE)))) return undefined;
  return engineOutputs(deps, plan, options);
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
  const outputs = await infrastructureOutputs(deps, plan, options);
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
