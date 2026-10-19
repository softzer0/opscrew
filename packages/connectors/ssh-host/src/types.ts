import { z } from "zod";
import { HOST_SYSCTL_KEYS, MAX_COMPOSE_BYTES } from "./constants";
import { canonicalIpv4Cidr } from "./parse";

/** Version of the host plan format (`HostPlan.schemaVersion`). */
export const HOST_PLAN_SCHEMA_VERSION = 1;

/**
 * Host steps in the order a setup plan runs them. `deploy-key`, `app-dirs`, `app-record` and
 * `tunnel-connector` are the app's own; `edge` only appears in a teardown (the edge goes with the
 * last app).
 */
export const HOST_STEP_IDS = [
  "package-repair",
  "docker",
  "docker-daemon",
  "deploy-user",
  "deploy-key",
  "sshd",
  "ufw",
  "web-filter",
  "fail2ban",
  "unattended-upgrades",
  "sysctl",
  "runtime-dirs",
  "app-dirs",
  "app-record",
  "edge",
  "tunnel-connector",
  "portainer",
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
  });
export type DesiredHost = z.infer<typeof DesiredHostSchema>;

export interface ApplyOptions {
  /** The hash the user approved; apply refuses any other plan. */
  approvedHash: string;
  /** What the user runs again once a problem is fixed (for example `opscrew provision`); errors name it. */
  command: string;
  /** Supplied at apply, never part of the plan. */
  secrets?: { tunnelToken?: string; portainerPassword?: string };
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
}
