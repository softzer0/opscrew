import type { DeployTarget, VpsProvider } from "@opscrew/plan-schema";

/** Category of a rendered file, used for diff summaries and approvals. */
export type RenderedFileKind = "infra" | "runtime" | "workflow" | "docker" | "doc";

/** A file OpsCrew writes into the user's repository. */
export interface RenderedFile {
  /** Repo-relative POSIX path, for example `opscrew/infra/prod/main.tf`. */
  path: string;
  /** File content with LF line endings and a trailing newline. */
  content: string;
  kind: RenderedFileKind;
  /** Optional POSIX file mode, for example `0o644`. */
  mode?: number;
}

/**
 * Secret-free inputs for rendering, in addition to the deploy plan. Never put tokens, passwords or
 * private keys here: rendered files are committed.
 */
export interface RenderContext {
  opscrewVersion: string;
  /** Repository that builds and deploys the app (GHCR image `ghcr.io/<owner>/<repo>`). */
  github: { owner: string; repo: string };
  /** Deploy key public half (`ssh-ed25519 AAAA… comment`). */
  deploySshPublicKey: string;
  /** Email for TLS certificate registration (Caddy ACME). */
  acmeEmail?: string;
  cloudflare?: {
    zoneId: string;
    /** False when the zone already has its own `http_config_settings` entrypoint ruleset. */
    manageConfigRule: boolean;
    /** False when the zone already has its own `http_request_firewall_custom` entrypoint ruleset. */
    manageWafRules: boolean;
    /** Cloudflare edge ranges used to restrict ports 80/443 when proxied. */
    ipRanges?: { ipv4: string[]; ipv6: string[] };
  };
  /** Known after the first apply; used for the no-domain health URL and the runbook. */
  serverIpv4?: string;
  serverIpv6?: string;
  /** Digest-pinned image for the optional Trivy scan step, e.g. `aquasec/trivy:0.75.0@sha256:…`. */
  trivyImage?: string;
  /** OpsCrew project id (names `~/.opscrew/projects/<id>/` in the runbook; never an absolute path). */
  projectId?: string;
  /**
   * Which server modules the root module contains during a move to another provider
   * (`opscrew retarget`). Without it the root module deploys `plan.target` as `module "server"`.
   */
  layout?: InfraLayout;
}

/** Server modules of the root module while a deployment moves to another provider. */
export interface InfraLayout {
  /** `module "server"` and the target it deploys; absent when the configuration has none. */
  server?: DeployTarget;
  /** `module "server_previous"`: the server being replaced. */
  previous?: DeployTarget;
  /** A `moved` block for the moves-only plans (rename before creating, rename back on abort). */
  moved?: { from: ServerModule; to: ServerModule };
  /** The module the DNS module and the `server_*` outputs follow (the one that gets traffic). */
  live: ServerModule;
  /** Every provider whose `required_providers` entry, provider block and module are rendered. */
  providers: readonly VpsProvider[];
}

/** The two server module names a root module can contain. */
export type ServerModule = "server" | "server_previous";
