import { z } from "zod";
import { MAX_COMPOSE_BYTES } from "./constants";

/** Version of the host plan format (`HostPlan.schemaVersion`). */
export const HOST_PLAN_SCHEMA_VERSION = 1;

/** Host steps in the order a setup plan runs them. */
export const HOST_STEP_IDS = [
  "docker",
  "deploy-user",
  "sshd",
  "ufw",
  "unattended-upgrades",
  "runtime-dirs",
  "app-marker",
  "tunnel-connector",
  "portainer",
] as const;

export type HostStepId = (typeof HOST_STEP_IDS)[number];

export const HostStepIdSchema = z.enum(HOST_STEP_IDS);

const ParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export interface HostStep {
  id: HostStepId;
  /** Plain English, e.g. "Install Docker Engine 28.x from Docker's repository". */
  title: string;
  state: "in-place" | "change" | "blocked";
  /** Why it is blocked, or what is already there. */
  reason?: string;
  /** Non-secret parameters the step's script uses (ports, user names, versions). */
  params: Readonly<Record<string, string | number | boolean>>;
}

export interface HostFinding {
  code: string;
  message: string;
  hint: string;
}

export interface HostPlan {
  schemaVersion: 1;
  purpose: "setup" | "teardown" | "undo";
  app: string;
  steps: readonly HostStep[];
  findings: readonly HostFinding[];
  deleteData?: boolean;
}

/** zod schema for a saved host plan (unknown keys are refused so the hash covers everything). */
export const HostPlanSchema = z.strictObject({
  schemaVersion: z.literal(HOST_PLAN_SCHEMA_VERSION),
  purpose: z.enum(["setup", "teardown", "undo"]),
  app: z.string().max(64),
  steps: z.array(
    z.strictObject({
      id: HostStepIdSchema,
      title: z.string().min(1),
      state: z.enum(["in-place", "change", "blocked"]),
      reason: z.string().optional(),
      params: z.record(z.string(), ParamValueSchema),
    }),
  ),
  findings: z.array(
    z.strictObject({ code: z.string().min(1), message: z.string().min(1), hint: z.string() }),
  ),
  deleteData: z.boolean().optional(),
});

export interface DesiredHost {
  app: string;
  projectId: string;
  admin: { user: string; isRoot: boolean };
  deploy: { user: "deploy"; publicKey: string };
  sshPort: number;
  access: "public" | "tunnel";
  /**
   * Tunnel mode: the connector's Compose file as rendered by `@opscrew/iac-templates`
   * (`renderTunnelConnectorCompose`). It reads `TUNNEL_TOKEN` from `tunnel.env` beside it, which
   * the adapter writes from the token supplied at apply. Required when `access` is `tunnel`.
   */
  tunnel?: { compose: string };
  /**
   * Portainer CE, when on: the pinned version and its Compose files as rendered by
   * `renderPortainerCompose` (`initial` reads the one-time `./admin_password`, `final` does not).
   */
  portainer?: { version: string; compose: { initial: string; final: string } };
  /**
   * Explicit choice for password logins, needed only when some login user has a password and no
   * SSH key (turning passwords off would lock them out). `true` turns them off anyway, `false`
   * leaves the server's password setting alone. Ignored when every password user has a key.
   */
  disablePasswords?: boolean;
}

/** Single-line OpenSSH public key (`type base64 [comment]`); never a private key. */
const PUBLIC_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n\0]{0,200})?$/;

/** A rendered Compose file: non-empty text without NUL bytes, at most 16 KiB. */
export const ComposeTextSchema = z
  .string()
  .min(1)
  .max(MAX_COMPOSE_BYTES)
  .refine((text) => !text.includes("\0"), { message: "must not contain NUL bytes" });

export const DesiredHostSchema = z
  .strictObject({
    app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, {
      message: "must be lower-case letters, digits and dashes",
    }),
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
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
    tunnel: z
      .strictObject({
        compose: ComposeTextSchema.refine((text) => text.includes("tunnel.env"), {
          message: "must read the token from tunnel.env",
        }),
      })
      .optional(),
    portainer: z
      .strictObject({
        version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, {
          message: "must be a pinned version such as 2.33.1",
        }),
        compose: z.strictObject({
          initial: ComposeTextSchema.refine((text) => text.includes("admin_password"), {
            message: "must read the one-time admin_password file",
          }),
          final: ComposeTextSchema,
        }),
      })
      .optional(),
    disablePasswords: z.boolean().optional(),
  })
  .refine((desired) => desired.access !== "tunnel" || desired.tunnel !== undefined, {
    message: "the tunnel connector's Compose file is required in tunnel mode",
    path: ["tunnel"],
  });

export interface ApplyOptions {
  /** The hash the user approved; apply refuses any other plan. */
  approvedHash: string;
  /** Supplied at apply, never part of the plan. */
  secrets?: { tunnelToken?: string; portainerPassword?: string };
  /** Opens NEW connections (deploy user, admin login); true when both work. */
  verifyLogin: () => Promise<boolean>;
  /** Seconds before the server undoes an sshd/ufw change on its own (default 180). */
  deadManSeconds?: number;
}

export interface ApplyResult {
  applied: HostStepId[];
  skipped: HostStepId[];
}
