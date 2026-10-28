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
  /**
   * The scheduled check's authorized_keys line for the deploy user
   * (`restrict,command="df -P -B1 /" <key> opscrew-check:<owner>/<repo>`), which a new cloud
   * server gets at its first boot; absent without the check (the files stay as they were).
   */
  checkKeyLine?: string;
  /** Email for TLS certificate registration (Caddy ACME). */
  acmeEmail?: string;
  cloudflare?: {
    zoneId: string;
    /**
     * Cloudflare account id. Required when the plan uses a Cloudflare Tunnel (an own server in
     * tunnel mode, or a Portainer subdomain) or Cloudflare's hosting (a Worker): tunnels, Access
     * and Workers belong to the account.
     */
    accountId?: string;
    /**
     * Id of the account's one-time PIN login method, which OpsCrew creates outside the IaC
     * configuration when the account has none. Required with a Portainer subdomain (Portainer's
     * login).
     */
    oneTimePinIdentityProviderId?: string;
  };
  /**
   * Cloudflare's IP ranges (IPv4, then IPv6, from Cloudflare's API). When Cloudflare's proxy
   * serves the app's hostnames, a cloud firewall opens ports 80/443 only to them, and requests from
   * them carry the visitor's address in `CF-Connecting-IP`, which the server's proxy then uses as
   * the client's address: nginx in the app's site, Caddy in the edge's main configuration and the
   * app's site. Every app on a server should get the same ranges, since the edge's file is shared.
   */
  cloudflareRanges?: readonly string[] | undefined;
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
   * For a promoted environment: the `cicd.branch` of the environment that builds the images it is
   * promoted with (the first of its sources that follows a branch). Its workflow's verify job
   * requires the image's build run on that branch. Absent for a plan that follows a branch.
   */
  builderBranch?: string | undefined;
  /**
   * For a promoted environment on Cloudflare's hosting: the `cicd.workflowPath` of the environment
   * that builds the sites it is promoted with (the first of its sources that follows a branch, as
   * for {@link builderBranch}). Its deploy job requires the build's run to be of that workflow.
   * Absent for a plan that follows a branch.
   */
  builderWorkflowPath?: string | undefined;
  /**
   * The folders of the repository's other apps (`appsOf`'s `dir`). The deploy workflow of an app
   * at the repository root leaves them out of its push filter unless its `app.sharedPaths` names
   * them, so a change to another app alone does not deploy it.
   */
  otherAppDirs?: readonly string[] | undefined;
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
