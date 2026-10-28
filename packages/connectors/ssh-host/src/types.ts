import { z } from "zod";
import { ECDSA_HOST_KEY_TYPES, HOST_SYSCTL_KEYS, MAX_COMPOSE_BYTES } from "./constants";
import { canonicalIpv4Cidr, canonicalSshSource } from "./parse";

/** Version of the host plan format (`HostPlan.schemaVersion`). */
export const HOST_PLAN_SCHEMA_VERSION = 1;

/**
 * Host steps in the order a setup plan runs them. `deploy-key`, `app-dirs`, `app-record`,
 * `github-runner` and `tunnel-connector` are the app's own; `edge` only appears in a teardown (the
 * edge goes with the last app). `check-key`, `beszel` and `alloy` are planned by `planAddon` (and
 * removed by a teardown).
 */
export const HOST_STEP_IDS = [
  "package-repair",
  "docker",
  "docker-daemon",
  "deploy-user",
  "deploy-key",
  "sshd",
  "ufw",
  "ssh-firewall",
  "web-filter",
  "fail2ban",
  "unattended-upgrades",
  "sysctl",
  "runtime-dirs",
  "app-dirs",
  "app-record",
  "github-runner",
  "edge",
  "tunnel-connector",
  "portainer",
  "check-key",
  "beszel",
  "alloy",
] as const;

export type HostStepId = (typeof HOST_STEP_IDS)[number];

export const HostStepIdSchema = z.enum(HOST_STEP_IDS);

/** An OpsCrew app name, as plan-schema allows it. */
export const AppNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, {
  message: "must be lower-case letters, digits and dashes",
});

/** The id of the project folder an app on the server belongs to (its record names it). */
export const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);

/** A lower-case domain name such as `shop.example.com`. */
export const HostnameSchema = z
  .string()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/,
    { message: "must be a lower-case domain name such as shop.example.com" },
  );

/**
 * How an app is served, which sets the server's firewall stance: `public` (DNS only: the web
 * ports open to everyone), `web-filter` (behind Cloudflare's proxy: the web ports open to
 * Cloudflare's addresses only) or `tunnel` (through a Cloudflare Tunnel: no web port open).
 */
export const AccessModeSchema = z.enum(["public", "web-filter", "tunnel"]);
export type AccessMode = z.infer<typeof AccessModeSchema>;

/** A Compose service name. */
export const ServiceNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, {
  message: "must be a Compose service name",
});

/** A pinned Portainer CE version. */
export const PortainerVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, {
  message: "must be a pinned version such as 2.33.1",
});

const HostStepSchema = z.strictObject({
  id: HostStepIdSchema,
  /** Plain English, e.g. "Install Docker Engine 28.x from Docker's repository". */
  title: z.string().min(1),
  state: z.enum(["in-place", "change", "blocked"]),
  /** `shared` by every OpsCrew app on the server, or `app`: the plan's app's own. */
  scope: z.enum(["shared", "app"]),
  /** Why it is blocked, or what is already there. */
  reason: z.string().optional(),
  /** Non-secret parameters the step's script uses (ports, user names, versions). */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type HostStep = z.infer<typeof HostStepSchema>;

const HostFindingSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  hint: z.string(),
});
export type HostFinding = z.infer<typeof HostFindingSchema>;

/** zod schema for a saved host plan (unknown keys are refused so the hash covers everything). */
export const HostPlanSchema = z.strictObject({
  schemaVersion: z.literal(HOST_PLAN_SCHEMA_VERSION),
  purpose: z.enum(["setup", "teardown", "undo"]),
  /** The app the plan is for; "" for a plan that is no one app's (an undo, a runner machine's). */
  app: z.string().max(64),
  steps: z.array(HostStepSchema),
  findings: z.array(HostFindingSchema),
  deleteData: z.boolean().optional(),
  /**
   * The other apps set up on the server when the plan was made (by name, with their deploy keys).
   * The apply refuses the plan when they changed since: the shared parts, the deploy keys and the
   * edge were planned for them.
   */
  otherApps: z.array(z.strictObject({ app: z.string(), deployKey: z.string() })).optional(),
});
export type HostPlan = z.infer<typeof HostPlanSchema>;

/** Single-line OpenSSH public key (`type base64 [comment]`); never a private key. */
const PUBLIC_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n\0]{0,200})?$/;

/** One OpenSSH public key line (`type base64 [comment]`), never a private key. */
export const PublicKeyLineSchema = z
  .string()
  .regex(PUBLIC_KEY_RE, { message: "must be one OpenSSH public key line" });

/** A rendered Compose file: non-empty text without NUL bytes, at most 16 KiB. */
export const ComposeTextSchema = z
  .string()
  .min(1)
  .max(MAX_COMPOSE_BYTES)
  .refine((text) => !text.includes("\0"), { message: "must not contain NUL bytes" });

/** A Cloudflare Tunnel id (a UUID; not secret). */
export const TunnelIdSchema = z.string().regex(/^[0-9A-Fa-f-]{8,64}$/, {
  message: "must be a Cloudflare Tunnel id",
});

/** A GitHub repository's URL, `https://github.com/<owner>/<repo>`. */
export const RepositoryUrlSchema = z
  .string()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, {
    message: "must be https://github.com/<owner>/<repo>",
  });

/** The two URLs name one repository: GitHub's owner and repository names ignore case. */
export function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The app's GitHub Actions runner on the server (`DesiredHost.runner`): the pinned release, its
 * archive's SHA-256, and how it registers with the repository. Never a token: the registration
 * token is fetched while the plan is applied (`ApplyOptions.runnerToken`).
 */
export const DesiredRunnerSchema = z.strictObject({
  /** `opscrew-<app>-<env>`: the deploy job asks for it with `runs-on`. */
  label: z.string().regex(/^opscrew-[a-z0-9][a-z0-9-]{0,80}$/, {
    message: "must be opscrew- followed by lower-case letters, digits and dashes",
  }),
  /** `<host>-<app>-<env>`: the runner's name on GitHub. */
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
    message: "must be letters, digits, dots, dashes and underscores",
  }),
  repositoryUrl: RepositoryUrlSchema,
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, {
    message: "must be a pinned version such as 2.338.0",
  }),
  /** The release archive's URL, from the pin (`TOOLS.githubRunner` in `@opscrew/iac-templates`). */
  url: z
    .string()
    .regex(
      /^https:\/\/github\.com\/actions\/runner\/releases\/download\/v[0-9.]+\/actions-runner-linux-(?:x64|arm64)-[0-9.]+\.tar\.gz$/,
      { message: "must be a release archive of github.com/actions/runner" },
    ),
  /** The archive's SHA-256, checked on the server before anything in it runs. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { message: "must be a SHA-256 in lower-case hex" }),
  /** The release archive for the server's architecture. */
  asset: z.enum(["linux-x64", "linux-arm64"]),
});
export type DesiredRunner = z.infer<typeof DesiredRunnerSchema>;

/** More SSH sources (`sshFrom`) than anyone names by hand. */
export const MAX_SSH_SOURCES = 32;

/** The algorithm of the host key a project pinned (its known_hosts holds it). */
const HostKeyTypeSchema = z.enum(["ssh-ed25519", "ssh-rsa", ...ECDSA_HOST_KEY_TYPES]);

/** An IPv4 or IPv6 address or network that may reach a runner machine's SSH (`sshFrom`). */
const SshSourceSchema = z.string().refine((text) => canonicalSshSource(text) !== null, {
  message:
    "must be an IPv4 or IPv6 address or network such as 203.0.113.7, 198.51.100.0/24 or 2001:db8::/32",
});

/**
 * A runner machine's part of the project (`planRunnerHost`): the project's repository, and the
 * runners of the environments the plan names, each by its app name (`<app>-<env>`): installed
 * with `runner`, removed without. Runners it does not name are left alone.
 */
export const DesiredRunnerHostSchema = z
  .strictObject({
    /** A runner folder whose `.opscrew-runner` names another repository is never touched. */
    repositoryUrl: RepositoryUrlSchema,
    runners: z.array(
      z.strictObject({ app: AppNameSchema, runner: DesiredRunnerSchema.optional() }),
    ),
    /**
     * The machine's hardening, off by default and each part on its own (FR-1536). A part the
     * machine has from OpsCrew and `harden` leaves out is removed. `ssh`: the own server's SSH
     * hardening (key-only logins, no root login), with its automatic undo. `firewall`: OpsCrew's
     * nftables table `inet opscrew`, which lets only `sshFrom` reach port 22 (no default: a guess
     * at this computer's address could lock the user out when it changes).
     */
    harden: z
      .strictObject({
        ssh: z.literal(true).optional(),
        firewall: z
          .strictObject({ sshFrom: z.array(SshSourceSchema).min(1).max(MAX_SSH_SOURCES) })
          .optional(),
      })
      .optional(),
    /** The pinned host key's algorithm; needed with `harden.ssh` (see `DesiredHost.hostKeyType`). */
    hostKeyType: HostKeyTypeSchema.optional(),
  })
  .refine((host) => host.harden?.ssh !== true || host.hostKeyType !== undefined, {
    message: "is needed to harden SSH",
    path: ["hostKeyType"],
  })
  .refine((host) => new Set(host.runners.map((item) => item.app)).size === host.runners.length, {
    message: "must name each app once",
    path: ["runners"],
  })
  .refine(
    (host) =>
      host.runners.every(
        (item) =>
          item.runner === undefined ||
          sameRepository(item.runner.repositoryUrl, host.repositoryUrl),
      ),
    { message: "must be the project's repository", path: ["runners"] },
  );
export type DesiredRunnerHost = z.infer<typeof DesiredRunnerHostSchema>;

/** More IPv4 ranges than Cloudflare has ever published. */
export const MAX_WEB_FILTER_RANGES = 100;

/** An IPv4 network (Cloudflare's ranges). */
const Ipv4NetworkSchema = z.string().refine((text) => canonicalIpv4Cidr(text) !== null, {
  message: "must be an IPv4 network such as 173.245.48.0/20",
});

export const DesiredHostSchema = z
  .strictObject({
    app: AppNameSchema,
    projectId: ProjectIdSchema,
    /**
     * The project's repository: a runner folder whose `.opscrew-runner` names another is never
     * replaced or removed.
     */
    repositoryUrl: RepositoryUrlSchema,
    /** The app's hostnames; no other app on the server may hold one of them. */
    hostnames: z.array(HostnameSchema).max(50),
    /** The app's backing services (plan.yaml's `services` names: db, cache ...), kept in its record. */
    services: z.array(ServiceNameSchema).max(50),
    /** The sum of the memory limits of the app's containers, in MB, kept in its record. */
    memoryMb: z.number().int().positive().max(1_048_576),
    admin: z.strictObject({
      user: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/),
      isRoot: z.boolean(),
    }),
    deploy: z.strictObject({
      user: z.literal("deploy"),
      publicKey: z
        .string()
        .regex(PUBLIC_KEY_RE, { message: "must be one OpenSSH public key line" }),
    }),
    sshPort: z.number().int().min(1).max(65535),
    /**
     * The algorithm of the server's host key the project pinned (its known_hosts and the deploy
     * secrets hold it). An ECDSA key keeps the ECDSA host key offered, so the pinned key still
     * works; otherwise only the ED25519 and RSA host keys are.
     */
    hostKeyType: HostKeyTypeSchema,
    access: z.enum(["public", "tunnel"]),
    /**
     * Tunnel mode: the app's own connector's Compose file as rendered by `@opscrew/iac-templates`
     * (`renderTunnelConnectorCompose`), run as the project `<app>-tunnel` in
     * `/srv/opscrew/cloudflared/<app>`. It reads `TUNNEL_TOKEN` from `tunnel.env` beside it, which
     * the adapter writes from the token supplied at apply. `tunnelId` (not secret) is recorded next
     * to the connector: a different id means a new tunnel, so its token is written again and the
     * connector restarted. Required when `access` is `tunnel`.
     */
    tunnel: z
      .strictObject({
        compose: ComposeTextSchema.refine((text) => text.includes("tunnel.env"), {
          message: "must read the token from tunnel.env",
        }),
        tunnelId: TunnelIdSchema,
      })
      .optional(),
    /**
     * Portainer CE, when on: the pinned version and its Compose files as rendered by
     * `renderPortainerCompose` (`initial` reads the one-time `./admin_password`, `final` does not).
     */
    portainer: z
      .strictObject({
        version: PortainerVersionSchema,
        compose: z.strictObject({
          initial: ComposeTextSchema.refine((text) => text.includes("admin_password"), {
            message: "must read the one-time admin_password file",
          }),
          final: ComposeTextSchema,
        }),
      })
      .optional(),
    /**
     * Only when the site is served directly behind Cloudflare's proxy (the user's explicit choice):
     * Cloudflare's current IPv4 ranges for the `web-filter` step, which lets only them reach the web
     * ports (80 and 443) Docker publishes. The site is published on IPv4 only in this mode (nothing
     * listens on IPv6 80/443). The plan stores them sorted and without duplicates, so the same ranges
     * in any order give the same plan hash.
     */
    webFilter: z
      .strictObject({
        ipv4: z.array(Ipv4NetworkSchema).min(1).max(MAX_WEB_FILTER_RANGES),
      })
      .optional(),
    /**
     * Kernel settings the app's services need (`vm.max_map_count` for the search engines), each
     * a minimum: the `sysctl` step writes them to `/etc/sysctl.d/90-opscrew.conf` and applies
     * them, keeping a value the server already has that is at least as high.
     */
    sysctl: z.partialRecord(z.enum(HOST_SYSCTL_KEYS), z.string().regex(/^\d{1,10}$/)).optional(),
    /**
     * The app's GitHub Actions runner (`runner: server`), installed by the `github-runner` step in
     * `/srv/runners/<app>` and run as deploy's systemd user service. Absent: a runner the app has
     * there is removed.
     */
    runner: DesiredRunnerSchema.optional(),
    /**
     * Explicit choice for password logins, needed only when some login user has a password and no
     * SSH key (turning passwords off would lock them out). `true` turns them off anyway, `false`
     * leaves the server's password setting alone. Ignored when every password user has a key.
     */
    disablePasswords: z.boolean().optional(),
  })
  .refine((desired) => desired.access !== "tunnel" || desired.tunnel !== undefined, {
    message: "the tunnel connector's Compose file is required in tunnel mode",
    path: ["tunnel"],
  })
  .refine((desired) => desired.access === "public" || desired.webFilter === undefined, {
    message: "the web filter is only for a site served directly (public mode)",
    path: ["webFilter"],
  })
  .refine(
    (desired) =>
      desired.runner === undefined ||
      sameRepository(desired.runner.repositoryUrl, desired.repositoryUrl),
    { message: "must be the project's repository", path: ["runner"] },
  );
export type DesiredHost = z.infer<typeof DesiredHostSchema>;

/** The secrets a host plan's steps may need, each checked by name before it is sent. */
export interface ApplySecrets {
  /** The app's Cloudflare Tunnel token (`tunnel-connector`). */
  tunnelToken?: string;
  /** Portainer's first admin password (`portainer`). */
  portainerPassword?: string;
  /** Beszel's dashboard password, hub mode (`beszel`): 16 to 128 letters, digits, `-` and `_`. */
  beszelPassword?: string;
  /** Beszel's agent token (`beszel`): 48 hex digits in hub mode, the user's hub's in agent mode. */
  beszelToken?: string;
  /**
   * The Beszel hub's private Ed25519 key, an unencrypted OpenSSH private key, hub mode (`beszel`).
   * The step writes it to the hub's `data/id_ed25519`; its public half is the step's `hubKey`.
   */
  beszelHubKey?: string;
  /** The Grafana Cloud access policy token (`alloy`). */
  grafanaCloudToken?: string;
}

export type SecretName = keyof ApplySecrets;

export interface ApplyOptions {
  /** The hash the user approved; apply refuses any other plan. */
  approvedHash: string;
  /** What the user runs again once a problem is fixed (for example `opscrew provision`); errors name it. */
  command: string;
  /** Supplied at apply, never part of the plan; they reach the server only on stdin. */
  secrets?: ApplySecrets;
  /**
   * Fetches a GitHub token for the `github-runner` step: a registration token to install the
   * runner, a remove token to remove it. Called only when that step runs, never for one in place;
   * the token goes to the server on stdin only and is never part of the plan.
   */
  runnerToken?: (kind: "registration" | "remove") => Promise<string>;
  /** Opens NEW connections (deploy user, admin login); true when both work. */
  verifyLogin: () => Promise<boolean>;
  /** Seconds before the server undoes an sshd/ufw change on its own (default 180). */
  deadManSeconds?: number;
  /** OpsCrew version written to the host record (default: this package's version). */
  version?: string;
  /** Clock for the host record's timestamps (default: the system clock). */
  now?: () => Date;
}

export interface ApplyResult {
  applied: HostStepId[];
  skipped: HostStepId[];
  /**
   * The apps whose GitHub Actions runner was removed from the server without GitHub unregistering
   * it (it never registered, or `config.sh remove` failed): the caller deletes those registrations
   * through GitHub's API. Absent when there are none.
   */
  stillRegistered?: string[];
}
