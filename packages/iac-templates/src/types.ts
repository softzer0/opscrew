import type { CloudDeployTarget, CloudProvider } from "@opscrew/plan-schema";

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
    /**
     * Cloudflare account id. Required when the plan uses a Cloudflare Tunnel (an own server in
     * tunnel mode, or a Portainer subdomain): tunnels and Access belong to the account.
     */
    accountId?: string;
    /**
     * True when OpsCrew must create the account's Zero Trust organization: the account has none
     * yet, or this configuration's state already holds the one OpsCrew created
     * (`module.access.cloudflare_zero_trust_organization.this[0]`). Used whenever the plan has
     * Cloudflare Access (tunnel mode's SSH hostname or a Portainer subdomain); default false.
     */
    createZeroTrustOrganization?: boolean;
    /**
     * Id of the account's existing one-time PIN login method. Leave it unset when the account has
     * none, or when this configuration's state already holds the one OpsCrew created
     * (`module.access.cloudflare_zero_trust_access_identity_provider.one_time_pin[0]`): the module
     * then creates (or keeps) its own. Used only with a Portainer subdomain.
     */
    oneTimePinIdentityProviderId?: string;
  };
  /**
   * The SSH port on a server the user owns: the login port in public mode (the port this computer
   * and GitHub Actions connect to, which differs from sshd's when a router forwards it), sshd's
   * port in tunnel mode (from inspection, `sshd -T`). Default 22, must be an integer 1-65535. In
   * tunnel mode the tunnel routes the SSH hostname to `ssh://localhost:<port>`; in public mode the
   * deploy workflow's `ssh`/`scp` calls use it. The runbook's direct SSH commands use it in both
   * modes.
   */
  sshPort?: number;
  /**
   * The server's addresses from OpsCrew's local state (they are never in the plan), for the
   * runbook. The runbook leaves them out when the domain is behind Cloudflare's proxy.
   */
  serverIpv4?: string;
  serverIpv6?: string;
  /** OpsCrew project id (names `~/.opscrew/projects/<id>/` in the runbook; never an absolute path). */
  projectId?: string;
  /**
   * Which server modules the root module contains during a move to another provider
   * (`opscrew retarget`), from `moveLayout`. Without it the root module deploys `plan.target` as
   * `module "server"`.
   */
  layout?: InfraLayout;
}

/**
 * Server modules of the root module while a deployment moves to another provider. Only servers
 * OpsCrew creates move, so its servers and providers are cloud ones.
 */
export interface InfraLayout {
  /** `module "server"` and the target it deploys; absent when the configuration has none. */
  server?: CloudDeployTarget;
  /** `module "server_previous"`: the server being replaced. */
  previous?: CloudDeployTarget;
  /** A `moved` block for the moves-only plans (rename before creating, rename back on abort). */
  moved?: { from: ServerModule; to: ServerModule };
  /** The module the DNS module and the `server_*` outputs follow (the one that gets traffic). */
  live: ServerModule;
  /** Every provider whose `required_providers` entry, provider block and module are rendered. */
  providers: readonly CloudProvider[];
}

/** The two server module names a root module can contain. */
export type ServerModule = "server" | "server_previous";
