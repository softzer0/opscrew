import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import type {
  ApplyStackOptions,
  CertificateDetails,
  DeployBranch,
  PortainerClient,
  PortainerClientDeps,
  PortainerEndpoint,
} from "@opscrew/connector-portainer";

import type { HostFacts } from "@opscrew/connector-ssh-host";
import type {
  CredentialCheck,
  IacEngine,
  PolicyResult,
  RemoteExec,
  ResourceChange,
  ResourceMove,
} from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { CloudProvider } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import type { LocalhostServices } from "../localhost/services";
import type { CloudRunnerHost } from "../runners/cloud";
import type { RunnerGitHubApi } from "../runners/github";
import type { RunnerHostServices } from "../runners/machine";
import type { RefreshRecoveryOptions } from "../secrets";
import type { EnvAnswer, EnvQuestion, HostAdapterApi, OwnServerConnection } from "../shared";
import type { StorageKey, StorageKeyQuestion } from "./storage";

/**
 * The Cloudflare calls provisioning needs (a `CloudflareClient` or a test fake). `listAccounts`
 * finds the account of a Cloudflare Tunnel when the zone does not name it.
 */
export type CloudflareApi = Pick<
  CloudflareClient,
  "verifyToken" | "findZone" | "listDnsRecords" | "getIpRanges" | "listAccounts"
>;

/**
 * A one-file branch OpsCrew writes: only ever a deploy branch, `opscrew-deploy` or
 * `opscrew-deploy-<env>` (the type allows no other name).
 */
type DeployBranchInput = Parameters<GitHubClient["createOrphanBranch"]>[0] & {
  branch: DeployBranch;
};

/**
 * The GitHub calls provisioning needs (a `GitHubClient` or a test fake). The branch calls are
 * used only for the user's Portainer, and only on the environment's deploy branch.
 */
export type GitHubApi = Pick<
  GitHubClient,
  | "getRepo"
  | "getActionsPublicKey"
  | "deleteActionsSecret"
  | "setActionsSecret"
  | "actionsSecretExists"
  | "findOpenPullRequest"
  | "createPullRequest"
  | "dispatchWorkflow"
  // A move's maintenance window waits for the app's deploys that run.
  | "listWorkflowRuns"
  // Where an environment's deploy secrets live, once the app has several (`checkSecretsPlacement`).
  | "environmentCapability"
  | "getEnvironment"
  | "putEnvironment"
  // The rules of a GitHub environment OpsCrew created: its default reviewer and branch rule.
  | "account"
  | "addDeploymentBranch"
  | "listDeploymentBranches"
  | "environmentPublicKey"
  | "setEnvironmentSecret"
  | "deleteEnvironmentSecret"
  // The scheduled check: its workflow's state, its open alerts, pauses and the included minutes.
  | "checkWorkflowState"
  | "openIssues"
  | "getRepoVariable"
  | "setRepoVariable"
  | "deleteRepoVariable"
  | "includedMinutes"
> & {
  createOrphanBranch(input: DeployBranchInput): Promise<{ commit: string }>;
  replaceOrphanBranch(input: DeployBranchInput): Promise<{ commit: string; previous: string }>;
  branchHoldsOnly(
    owner: string,
    repo: string,
    branch: DeployBranch,
    file: { path: string; content: string },
  ): Promise<boolean>;
};

/**
 * Collaborators that talk to the outside world. Each defaults to the real implementation built
 * from `PhaseDeps` (env, fetch, runner); tests replace them with fakes.
 */
export interface ProvisionServices {
  /** Picks the IaC engine (default: `selectEngine` from `@opscrew/iac-engine`). */
  engine?: (preference: EnginePreference) => Promise<IacEngine>;
  /** Credential check for the plan's provider (default: `vpsConnector` over its token). */
  provider?: { configured: boolean; verify(): Promise<CredentialCheck> };
  /**
   * Credential checks of the providers of the extra servers OpsCrew creates, other than the app
   * server's, by provider (default: `vpsConnector` over each one's token).
   */
  providers?: Partial<
    Record<CloudProvider, { configured: boolean; verify(): Promise<CredentialCheck> }>
  >;
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
  /**
   * Interactive question for the scheduled check's webhook address, asked with `prompt` (CLI
   * prompt, hidden input); `undefined` when the user cancels. Never logged.
   */
  askCheckWebhook?: (question: {
    kind: "slack" | "discord" | "ntfy";
    prompt: string;
  }) => Promise<string | undefined>;
  /**
   * Interactive question for the key of the app's bucket at a provider, asked once with the
   * console steps (CLI prompt, hidden input). Never logged.
   */
  askStorageKey?: (question: StorageKeyQuestion) => Promise<StorageKey>;
  /**
   * GitHub Pages: interactive question for the value of GitHub's domain verification record, which
   * GitHub shows only on its settings `page` once `domain` is added there (CLI prompt). Not a
   * secret: it is public in DNS.
   */
  askPagesVerification?: (question: { domain: string; page: string }) => Promise<string>;
  /** A server the user owns: its shell and the host adapter (fakes in tests). */
  own?: OwnServerServices;
  /**
   * The Cloudflare client for what OpsCrew apps share: OpsCrew's rules in the zone and the
   * account's Zero Trust organization and one-time PIN login (default: Cloudflare's client with
   * `CLOUDFLARE_API_TOKEN`).
   */
  sharedCloudflare?: CloudflareClient;
  /** The user's Portainer (`target.provider: portainer`): its client and local randomness (fakes in tests). */
  portainer?: PortainerServices;
  /** Finds an optional tool on `PATH`, such as gixy-ng (default: `findExecutable`). */
  which?: (name: string) => string | undefined;
  /** The localhost target: this computer's OS, CPU, ports, requests and GHCR (fakes in tests). */
  localhost?: LocalhostServices;
  /** GitHub's runner API for a self-hosted runner (default: the client of the user's token). */
  runnerGitHub?: RunnerGitHubApi;
  /**
   * The server's runner on a server OpsCrew created: its inspection and apply as deploy (default:
   * `inspectRunners` and `applyHostPlan`; a fake in tests).
   */
  runnerHost?: CloudRunnerHost;
  /**
   * The scheduled check's key on a server OpsCrew created: the host adapter's apply as deploy
   * (default: `applyHostPlan`; a fake in tests).
   */
  checkHost?: Pick<HostAdapterApi, "apply">;
  /**
   * The private network's host plans on the servers OpsCrew created, as deploy, who becomes root
   * through Docker in the image `rootImage` names (default: `inspectHost` and `applyHostPlan`; a
   * fake in tests).
   */
  serverHost?: {
    inspect(remote: RemoteExec, options: { rootImage: string }): Promise<HostFacts>;
    apply: HostAdapterApi["apply"];
  };
  /**
   * The runner machine of `runner: host`: its admin login's shell and the host adapter (default:
   * SSH with its recorded login, `inspectHost` and `applyHostPlan`; fakes in tests).
   */
  runnerMachine?: RunnerHostServices;
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
}

/**
 * Collaborators for a server the user owns (`target.provider: own`). Each defaults to the real
 * implementation: an SSH shell with the recorded admin login and `@opscrew/connector-ssh-host`.
 */
export interface OwnServerServices {
  /** The admin login's shell (default: `SshRemoteExec` with the login from `.opscrew/server.json`). */
  remote?: (connection: OwnServerConnection) => RemoteExec;
  /** Inspection and apply (default: `inspectHost` and `applyHostPlan`). */
  host?: HostAdapterApi;
  /**
   * Proves after an SSH or firewall change that new logins still work (default: new SSH
   * connections as the deploy user and the admin login, see `ownServerLoginCheck`).
   */
  verifyLogin?: () => Promise<boolean>;
  /** Home directory for `~/` key paths (default: `HOME`, `USERPROFILE`, then the OS's). */
  homeDir?: string;
}

export interface ProvisionOptions {
  /** Plan and print the plan hash; do not apply. */
  planOnly?: boolean;
  /**
   * Every hash given with `--approve` (each names one plan of an earlier `--plan-only` run). The
   * saved infrastructure plan among them is applied instead of planning again (on servers OpsCrew
   * creates: the first one that names a saved plan, else the first other than this run's
   * Cloudflare plan); a Cloudflare, host or stack plan is granted by the approval handler when its
   * hash is one of them, so the CLI's non-interactive handler approves those requests by these
   * hashes.
   */
  approveHashes?: readonly string[];
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
  /**
   * What the recovery copy's first key needs, asked only when the first copy is made: the user's
   * own age recipient, or the file to write a new key to (a prompt or `--key-out`), and a backup
   * recipient.
   */
  recovery?: Pick<RefreshRecoveryOptions, "recipient" | "keyOut" | "backup">;
  /**
   * GitHub Pages: `--pages-verification <value>`, the value of GitHub's domain verification record
   * from the GitHub account's Pages settings. It replaces the one an earlier run recorded.
   */
  pagesVerification?: string;
  services?: ProvisionServices;
}

export interface ProvisionResult {
  planHash?: string;
  /**
   * The Cloudflare plan's SHA-256 hash (OpsCrew's shared rules and Zero Trust pieces), when it has
   * changes: applied by this run or, with `--plan-only`, the hash to approve.
   */
  cloudflarePlanHash?: string;
  /**
   * The Cloudflare plan with `cloudflarePlanHash` deletes OpsCrew's rule (or a ruleset it created),
   * so approving it needs the app's name typed (`--confirm <app>` in scripts).
   */
  cloudflarePlanDeletes?: true;
  /**
   * The `storage` root's plan hash (the app's bucket), when it has changes: applied by this run
   * or, with `--plan-only`, the hash to approve.
   */
  storagePlanHash?: string;
  /** True when this run applied an infrastructure plan. */
  applied: boolean;
  /**
   * A server the user owns: the host plan's SHA-256 hash (its file is
   * `.opscrew/plans/host-<hash>.json`). With `--plan-only` it is the hash to approve.
   */
  hostPlanHash?: string;
  /** A server the user owns: true when this run applied host changes. */
  hostApplied?: boolean;
  /** With `--plan-only`: the scheduled check key's host plan hash (`check-key`), to approve too. */
  checkKeyPlanHash?: string;
  /**
   * The runner machines' host plan hashes (each file is `.opscrew/plans/host-<hash>.json`): the
   * environment's runner removed from each machine it left, then, with `runner: host`, installed on
   * its machine. With `--plan-only` they are the hashes to approve.
   */
  runnerHostPlanHashes?: string[];
  /**
   * The host plans of the app's servers in the plan's order (feature 018; each file is
   * `.opscrew/plans/host-<hash>.json`): each extra server's own-server setup, and each server's
   * private network. With `--plan-only` they are the hashes to approve, one per plan.
   */
  serverHostPlanHashes?: string[];
  /**
   * The user's Portainer: the stack plan's SHA-256 hash (its file is
   * `.opscrew/plans/stack-<hash>.json`). With `--plan-only` it is the hash to approve.
   */
  stackPlanHash?: string;
  /**
   * The user's Portainer, with `--plan-only`: the stack plan follows the Cloudflare plan, because
   * the stack's Caddy needs the origin certificate it creates (`stackPlanHash` is then absent).
   */
  stackFollowsOriginTls?: true;
  /** The user's Portainer: true when this run changed something in Portainer. */
  stackApplied?: boolean;
  /**
   * The localhost target: the local plan's SHA-256 hash (its file is
   * `.opscrew/plans/local-<hash>.json`). With `--plan-only` it is the hash to approve.
   */
  localPlanHash?: string;
  /** The localhost target: true when this run changed the stack on this computer. */
  localApplied?: boolean;
  /**
   * GitHub Pages: the Pages plan's SHA-256 hash (its file is `.opscrew/plans/pages-<hash>.json`),
   * when it has changes. With `--plan-only` it is the hash to approve.
   */
  pagesPlanHash?: string;
  /**
   * GitHub Pages: the plan hash of the domain verification record's root (`iac-apply`), when it
   * has changes; `planHash` is the site's DNS records. With `--plan-only` it is the hash to approve.
   */
  pagesVerificationPlanHash?: string;
  /** Root-module outputs after the run (server IPs, id, name, url). */
  outputs: Record<string, unknown>;
  /** Pull request with the generated files, when one was opened or already open. */
  prUrl?: string;
  /** Branch holding the generated files. */
  branch?: string;
  /**
   * The branch the pull request goes into, where the environment's workflow lives
   * (`workflowBranch`: the branch it follows, or the default branch for a promoted environment).
   */
  base?: string;
  /**
   * False when the deployment files did not change and GitHub has them, so nothing was committed
   * or pushed and no pull request was opened (`prUrl` is then one still open from earlier); absent
   * when the run stopped before that step.
   */
  published?: boolean;
  /** Whether this run pushed `branch` to GitHub; false with `published` means it still needs a push. */
  pushed?: boolean;
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
  /** When this plan was applied; absent while it waits for its approval. */
  appliedAt?: string;
}
