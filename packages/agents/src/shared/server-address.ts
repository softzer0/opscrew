import { readFile, rename, rm, stat } from "node:fs/promises";
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
    /**
     * The pinned host key fingerprint the user confirmed, for example `SHA256:` and 43 characters.
     * Absent until the first connection: the interview records the login, provision pins the key.
     */
    hostKey: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
      .optional(),
    /**
     * True when the internet reaches the server directly; false means a Cloudflare Tunnel (the
     * interview's answer, which design turns into the plan's `target.access`).
     */
    reachable: z.boolean().optional(),
    /**
     * How the site is served when the internet reaches the server and its domain is on
     * Cloudflare (the interview's answer): through a Cloudflare Tunnel (the default when absent),
     * directly behind Cloudflare's proxy with OpsCrew's web filter (`proxy`, the user's explicit
     * choice), or directly with DNS only. Design turns it into the plan's `target.access` and
     * `dns.proxied`.
     */
    serve: z.enum(["tunnel", "proxy", "dns-only"]).optional(),
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

/** Host names Portainer may be reached on over plain HTTP: this computer only. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Portainer's address as the user gave it: `https://…` (for example `https://nas.lan:9443`), or
 * `http://` only to this computer (`localhost`, `127.0.0.1`, `[::1]`). Never a login or a query
 * string, so no secret can ride along.
 */
const PortainerUrlSchema = z
  .url({ protocol: /^https?$/ })
  .refine(
    (url) => {
      const parsed = new URL(url);
      return parsed.username === "" && parsed.password === "" && parsed.search === "";
    },
    { message: "must be Portainer's address without a login or query string" },
  )
  .refine(
    (url) => {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || LOOPBACK_HOSTS.has(parsed.hostname);
    },
    { message: "must use https:// unless Portainer runs on this computer (http://localhost)" },
  );

/**
 * The SHA-256 fingerprint of Portainer's certificate the user confirmed: `SHA256:` and 64 hex
 * characters (optionally in colon-separated pairs, as `openssl x509 -fingerprint -sha256` prints
 * them) or 43 unpadded base64 characters.
 */
const CertFingerprintSchema = z
  .string()
  .regex(/^SHA256:(?:[0-9A-Fa-f]{64}|[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}|[A-Za-z0-9+/]{43})$/, {
    message: "must be a SHA-256 certificate fingerprint such as SHA256:AB:CD:…",
  });

/** A stack OpsCrew created in Portainer: always named `opscrew-…`, never one of the user's own. */
const CreatedStackSchema = z.strictObject({
  /** Portainer's stack id. */
  id: z.int().positive(),
  name: z.string().regex(/^opscrew-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, {
    message: "must be a stack OpsCrew names opscrew-<app>…",
  }),
  role: z.enum(["app", "updater", "tunnel-connector"]),
});

/**
 * How OpsCrew reaches the Portainer the user runs, and what it created there. Local only: the
 * address never reaches `opscrew/plan.yaml`, pull requests or commit messages. The access token is
 * never stored (it comes from `PORTAINER_API_KEY`), nor the stack webhook (a secret kept in the
 * user's OpsCrew folder).
 */
const PortainerConnectionSchema = z
  .strictObject({
    url: PortainerUrlSchema,
    /** Absent for plain HTTP to this computer, and until the user confirms the certificate. */
    certFingerprint: CertFingerprintSchema.optional(),
    /** The environment (a single Docker host) the user picked. */
    environmentId: z.int().positive(),
    environmentName: z.string().regex(/^[^\0\r\n]*\S[^\0\r\n]*$/, {
      message: "must be the environment's name on one line",
    }),
    /** Everything OpsCrew created in Portainer, so destroy removes exactly that. */
    created: z
      .strictObject({
        stacks: z.array(CreatedStackSchema).default(() => []),
        /** The registry entry OpsCrew added (admin token only). */
        registryId: z.int().positive().optional(),
        /** The app stack's named volumes, recorded at apply (deleted only with `--delete-data`). */
        volumes: z
          .array(
            z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, { message: "must be a volume name" }),
          )
          .default(() => []),
      })
      .prefault({}),
  })
  .superRefine((portainer, ctx) => {
    if (portainer.certFingerprint !== undefined && new URL(portainer.url).protocol === "http:") {
      ctx.addIssue({
        code: "custom",
        path: ["certFingerprint"],
        message: "is only for https:// (plain HTTP has no certificate)",
      });
    }
    const ids = new Set<number>();
    const names = new Set<string>();
    portainer.created.stacks.forEach((stack, i) => {
      if (ids.has(stack.id) || names.has(stack.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["created", "stacks", i],
          message: "lists a stack twice",
        });
      }
      ids.add(stack.id);
      names.add(stack.name);
    });
  });

/** How OpsCrew reaches the user's Portainer and what it created there (`server.json` → `portainer`). */
export type PortainerConnection = z.output<typeof PortainerConnectionSchema>;
/** {@link PortainerConnection} as written by callers (`created` defaults to empty lists). */
export type PortainerConnectionInput = z.input<typeof PortainerConnectionSchema>;

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
  /** A Portainer the user runs (`target.provider: portainer`): how OpsCrew reaches it. */
  portainer: PortainerConnectionSchema.optional(),
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
export const STATE_FILE = "prod.tfstate";

/** Path of `.opscrew/server.json`. */
export function serverAddressesFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "server.json");
}

/** Where {@link setAsideServerAddresses} keeps a damaged `.opscrew/server.json`. */
export function damagedServerAddressesFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "server.json.damaged");
}

/**
 * `.opscrew/server.json` exists but cannot be used: OpsCrew never guesses past it. A damaged file
 * cannot tell which target it held, so the hint covers all three: a server the user owns (whose
 * connection and pinned host key must not simply be deleted), the user's Portainer (whose record
 * of the stacks OpsCrew created must not be deleted either) and a cloud server (whose addresses
 * come back from the infrastructure state).
 */
function damaged(reason: string): OpsCrewError {
  return new OpsCrewError(
    "ARTIFACT_INVALID",
    `OpsCrew's record of the servers on this computer (.opscrew/server.json) is damaged (${reason}), so OpsCrew stopped instead of guessing the servers' addresses.`,
    {
      hint: "Fix the JSON in .opscrew/server.json and run the command again. If this project deploys to your own server, do not delete the file: run `opscrew interview` again instead, which keeps the damaged file as .opscrew/server.json.damaged, and confirm the server's host key again when OpsCrew next connects. If this project deploys to your Portainer, do not delete the file: it lists the stacks OpsCrew created there, which only OpsCrew's record lets it update or remove. For Hetzner Cloud or DigitalOcean you can also start over. Delete .opscrew/server.json and run the command again: OpsCrew then reads the addresses from the infrastructure state in .opscrew/tfstate. If that state is not on this computer, run OpsCrew on the computer that provisioned the server.",
    },
  );
}

/**
 * Moves a damaged `.opscrew/server.json` to `.opscrew/server.json.damaged` (replacing an older
 * copy) so a fresh record can be written, and returns the copy's path; `undefined` when the file
 * is missing or valid (nothing is moved then). Only `opscrew interview` uses it, after the user
 * gave the connection again: the addresses of a cloud deployment come back from the
 * infrastructure state, and the server's host key is confirmed again at the next connection.
 */
export async function setAsideServerAddresses(paths: ProjectPaths): Promise<string | undefined> {
  try {
    await readServerAddresses(paths);
    return undefined;
  } catch (error) {
    if (!(error instanceof OpsCrewError && error.code === "ARTIFACT_INVALID")) throw error;
  }
  const copy = damagedServerAddressesFile(paths);
  await rm(copy, { force: true });
  await rename(serverAddressesFile(paths), copy);
  return copy;
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

/**
 * How OpsCrew reaches the user's Portainer and what it created there, from `.opscrew/server.json`;
 * `undefined` when none is recorded. A damaged file stops with `ARTIFACT_INVALID` (see
 * {@link readServerAddresses}).
 */
export async function readPortainerConnection(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<PortainerConnection | undefined> {
  return (await readServerAddresses(paths)).portainer;
}

/** Records how OpsCrew reaches the user's Portainer and what it created; `undefined` forgets it. */
export async function recordPortainerConnection(
  paths: ProjectPaths,
  portainer: PortainerConnectionInput | undefined,
): Promise<void> {
  await updateServerAddresses(paths, ({ portainer: _old, ...rest }) =>
    portainer === undefined ? rest : { ...rest, portainer },
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
