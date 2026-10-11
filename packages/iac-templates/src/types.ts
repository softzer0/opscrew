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
  /** Pinned image reference for the optional Trivy scan step, e.g. `aquasec/trivy:0.75.0`. */
  trivyImage?: string;
  /** OpsCrew project id (names `~/.opscrew/projects/<id>/` in the runbook; never an absolute path). */
  projectId?: string;
}
