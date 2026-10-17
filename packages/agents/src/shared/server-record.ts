import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureStateDir,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  stripBom,
  writeFileAtomic,
} from "@opscrew/core";
import { PortainerWebSchema } from "@opscrew/plan-schema";
import { z } from "zod";

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

/**
 * A stack OpsCrew created in Portainer: always named `opscrew-…`, never one of the user's own. The
 * same rules as the Portainer adapter's record (`CreatedRecordSchema`): an app name may end with a
 * dash, as plan-schema allows, so `opscrew-shop-` and `opscrew-shop--updater` are OpsCrew's names.
 */
const CreatedStackSchema = z.strictObject({
  /** Portainer's stack id. */
  id: z.int().positive(),
  name: z.string().regex(/^opscrew-[a-z0-9][a-z0-9-]{0,60}$/, {
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
    /** The environment's CPU architecture, read when the user picked it (design: target.arch). */
    arch: z.enum(["amd64", "arm64"]).optional(),
    /** How a new image reaches Portainer, as answered (design: target.redeploy). */
    redeploy: z.enum(["updater", "cloudflare"]).optional(),
    /** How visitors reach the app, as answered: tunnel, proxy with its port, or caddy (design: target.web). */
    web: PortainerWebSchema.optional(),
    /**
     * The app's image is public on GitHub Container Registry, as the user said (`--public-image`),
     * so Portainer pulls it without a registry entry; recorded after a successful stack step and
     * used until the user says otherwise.
     */
    publicImage: z.boolean().optional(),
    /**
     * How visitors reached the app (web mode, and the port for `proxy`) when OpsCrew last set up
     * its stacks, recorded after a successful stack step; the next run compares it with the plan's
     * to say when the route changes.
     */
    appliedWeb: PortainerWebSchema.optional(),
    /** Everything OpsCrew created in Portainer, so destroy removes exactly that. */
    created: z
      .strictObject({
        /** At most one stack per role: the app, the updater and the Cloudflare connector. */
        stacks: z
          .array(CreatedStackSchema)
          .max(3)
          .default(() => []),
        /** The registry entry OpsCrew added (admin token only). */
        registryId: z.int().positive().optional(),
        /** The app stack's named volumes, recorded at apply (deleted only with `--delete-data`). */
        volumes: z
          .array(
            z
              .string()
              .max(255)
              .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, { message: "must be a volume name" }),
          )
          .max(64)
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
    const roles = new Set<string>();
    portainer.created.stacks.forEach((stack, i) => {
      if (ids.has(stack.id) || names.has(stack.name) || roles.has(stack.role)) {
        ctx.addIssue({
          code: "custom",
          path: ["created", "stacks", i],
          message: "lists a stack twice",
        });
      }
      ids.add(stack.id);
      names.add(stack.name);
      roles.add(stack.role);
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

/** Path of `.opscrew/server.json`. */
export function serverAddressesFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "server.json");
}

/**
 * Where to run `command` when the server's address is not on this computer (a fresh clone): it is
 * kept in the `.opscrew/` folder of the computer that provisioned the server, never in the
 * repository. Starts in lower case, to continue a sentence.
 */
export function provisionedElsewhereHint(command: string): string {
  return `run \`${command}\` on the computer that provisioned the server (its \`.opscrew/\` folder holds the address)`;
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
  let text: string | undefined;
  try {
    text = await readTextIfExists(serverAddressesFile(paths));
  } catch {
    throw damaged("it cannot be read");
  }
  if (text === undefined) return { ...EMPTY };
  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
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
