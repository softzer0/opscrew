import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import type {
  ApplyStackOptions,
  CertificateDetails,
  PortainerClient,
  PortainerClientDeps,
  PortainerEndpoint,
} from "@opscrew/connector-portainer";
import type { ApplyOptions, ApplyResult, HostFacts, HostPlan } from "@opscrew/connector-ssh-host";
import type {
  CredentialCheck,
  IacEngine,
  PolicyResult,
  RemoteExec,
  ResourceChange,
  ResourceMove,
} from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { TcpConnect } from "@opscrew/secops";
import type { AccessLoginMethodsApi } from "../portainer/access";
import type { EnvAnswer, EnvQuestion, OwnServerConnection } from "../shared";
import type { ZeroTrustApi } from "./zero-trust";

/**
 * The Cloudflare calls provisioning needs (a `CloudflareClient` or a test fake). `listAccounts`
 * finds the account of a Cloudflare Tunnel when the zone does not name it.
 */
export type CloudflareApi = Pick<
  CloudflareClient,
  "verifyToken" | "findZone" | "listDnsRecords" | "inspectEntrypointRuleset" | "getIpRanges"
> &
  Partial<Pick<CloudflareClient, "listAccounts">>;

/**
 * The GitHub calls provisioning needs (a `GitHubClient` or a test fake). `createOrphanBranch`,
 * `replaceOrphanBranch` and `branchHoldsOnly` are needed only for the user's Portainer (its
 * `opscrew-deploy` branch; without `branchHoldsOnly` an existing branch is always replaced).
 */
export type GitHubApi = Pick<
  GitHubClient,
  | "getRepo"
  | "getActionsPublicKey"
  | "setActionsSecret"
  | "findOpenPullRequest"
  | "createPullRequest"
> &
  Partial<Pick<GitHubClient, "createOrphanBranch" | "replaceOrphanBranch" | "branchHoldsOnly">>;

/**
 * Collaborators that talk to the outside world. Each defaults to the real implementation built
 * from `PhaseDeps` (env, fetch, runner); tests replace them with fakes.
 */
export interface ProvisionServices {
  /** Picks the IaC engine (default: `selectEngine` from `@opscrew/iac-engine`). */
  engine?: (preference: EnginePreference) => Promise<IacEngine>;
  /** Credential check for the plan's provider (default: `vpsConnector` over its token). */
  provider?: { configured: boolean; verify(): Promise<CredentialCheck> };
  /** Cloudflare API (default: client from `CLOUDFLARE_API_TOKEN`); `null` means no token. */
  cloudflare?: CloudflareApi | null;
  /** GitHub REST API (default: client from `resolveGitHubToken`); `null` means no token. */
  github?: GitHubApi | null;
  tcpConnect?: TcpConnect;
  /** Remote shell on the new server (default: `SshRemoteExec` with the deploy key). */
  remote?: (host: string) => RemoteExec;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for wait loops. */
  now?: () => number;
  /** Interactive question for each production environment value (CLI prompt). */
  askEnv?: (question: EnvQuestion) => Promise<EnvAnswer>;
  /** A server the user owns: its shell, the host adapter and the Zero Trust lookup (fakes in tests). */
  own?: OwnServerServices;
  /**
   * The account's Cloudflare Access login methods, read for a Portainer subdomain (default:
   * Cloudflare's API with `CLOUDFLARE_API_TOKEN`).
   */
  accessLoginMethods?: AccessLoginMethodsApi;
  /** The user's Portainer (`target.provider: portainer`): its client and local randomness (fakes in tests). */
  portainer?: PortainerServices;
}

/**
 * Collaborators for the user's Portainer. Each defaults to the real implementation: the pinned
 * client of `@opscrew/connector-portainer`, a TLS handshake for the certificate's public key, and
 * Node's random bytes and UUIDs.
 */
export interface PortainerServices {
  /** The Portainer client (default: `portainerClient`, pinned to the confirmed certificate). */
  client?: (
    endpoint: PortainerEndpoint,
    token: string,
    deps: PortainerClientDeps,
  ) => PortainerClient;
  /** The certificate Portainer presents (default: `inspectCertificate`). */
  inspectCertificate?: (url: string) => Promise<CertificateDetails>;
  /** Random bytes for the value key (default: `crypto.randomBytes`). */
  randomBytes?: (size: number) => Uint8Array;
  /** A new webhook id (default: `crypto.randomUUID`). */
  randomUUID?: () => string;
  /** The stack apply's bounded wait (clock and sleep). */
  wait?: ApplyStackOptions["wait"];
  /** The Cloudflare account's Zero Trust organization (default: Cloudflare's API). */
  zeroTrust?: ZeroTrustApi;
}

/** The host adapter calls provision makes on a server the user owns. */
export interface HostAdapterApi {
  inspect(remote: RemoteExec): Promise<HostFacts>;
  apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult>;
}

/**
 * Collaborators for a server the user owns (`target.provider: own`). Each defaults to the real
 * implementation: an SSH shell with the recorded admin login, `@opscrew/connector-ssh-host`, and
 * Cloudflare's API with `CLOUDFLARE_API_TOKEN`.
 */
export interface OwnServerServices {
  /** The admin login's shell (default: `SshRemoteExec` with the login from `.opscrew/server.json`). */
  remote?: (connection: OwnServerConnection) => RemoteExec;
  /** Inspection and apply (default: `inspectHost` and `applyHostPlan`). */
  host?: Partial<HostAdapterApi>;
  /**
   * Proves after an SSH or firewall change that new logins still work (default: new SSH
   * connections as the deploy user and the admin login, see `ownServerLoginCheck`).
   */
  verifyLogin?: () => Promise<boolean>;
  /** The Cloudflare account's Zero Trust organization (default: Cloudflare's API). */
  zeroTrust?: ZeroTrustApi;
  /** Home directory for `~/` key paths (default: `HOME`, `USERPROFILE`, then the OS's). */
  homeDir?: string;
}

export interface ProvisionOptions {
  /** Plan and print the plan hash; do not apply. */
  planOnly?: boolean;
  /** Apply the saved plan with exactly this hash (from an earlier `--plan-only` run). */
  approvePlanHash?: string;
  /**
   * Every hash given with `--approve` (each names one plan). On a server the user owns there are
   * two plans: the saved infrastructure plan among them is applied as with `approvePlanHash`, and
   * the host plan is granted by the approval handler when its hash is one of them. The CLI's
   * non-interactive approval handler must approve `host-apply` requests by these hashes too.
   */
  approvePlanHashes?: readonly string[];
  /**
   * `--host-key SHA256:…`: the host key fingerprint of the user's own server, required on the
   * first connection when nobody can answer a prompt.
   */
  hostKey?: string;
  /**
   * The user's explicit choice for password logins on their own server, needed only when other
   * login users have a password and no SSH key: `off` turns password logins off anyway, `keep`
   * leaves them as they are. Without it such a server's SSH step is blocked.
   */
  passwordLogins?: "off" | "keep";
  /** Overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  /** Push the deploy branch and open a pull request (default true). */
  push?: boolean;
  /** Set the GitHub Actions deploy secrets (default true). */
  secrets?: boolean;
  /**
   * The user's Portainer: the app's image on GitHub Container Registry is public, so Portainer
   * pulls it without a registry entry. OpsCrew cannot see a package's visibility before the first
   * build, so it treats the image as private (a registry entry with a read-only token) unless told.
   */
  publicImage?: boolean;
  /**
   * The user's Portainer: send the repository token (`OPSCREW_REPO_READ_TOKEN`) or the registry
   * token (`OPSCREW_GHCR_READ_TOKEN`) again, after rotating it. Portainer never shows them back,
   * so OpsCrew replaces them only when asked; set it only on the run that should replace them.
   */
  replaceTokens?: { repository?: boolean; registry?: boolean };
  services?: ProvisionServices;
}

export interface ProvisionResult {
  planHash?: string;
  /** True when this run applied an infrastructure plan. */
  applied: boolean;
  /**
   * A server the user owns: the host plan's SHA-256 hash (its file is
   * `.opscrew/plans/host-<hash>.json`). With `--plan-only` it is the hash to approve.
   */
  hostPlanHash?: string;
  /** A server the user owns: true when this run applied host changes. */
  hostApplied?: boolean;
  /**
   * The user's Portainer: the stack plan's SHA-256 hash (its file is
   * `.opscrew/plans/stack-<hash>.json`). With `--plan-only` it is the hash to approve.
   */
  stackPlanHash?: string;
  /** The user's Portainer: true when this run changed something in Portainer. */
  stackApplied?: boolean;
  /** Root-module outputs after the run (server IPs, id, name, url). */
  outputs: Record<string, unknown>;
  /** Pull request with the generated files, when one was opened or already open. */
  prUrl?: string;
  /** Branch holding the generated files. */
  branch?: string;
}

/** What `--plan-only` saves beside the plan file so `--approve <hash>` can apply it later. */
export interface SavedPlan {
  planHash: string;
  planFile: string;
  dir: string;
  engine: IacEngine["info"];
  createdAt: string;
  changes: ResourceChange[];
  /** Resources the plan only renames in the state (`moved` blocks); absent when none. */
  moves?: ResourceMove[];
  counts: { create: number; update: number; delete: number; replace: number };
  hasDestroy: boolean;
  policy: PolicyResult[];
  /** The engine's `show -json` output, so later phases (secure) can re-check policies. */
  planJson?: unknown;
}
