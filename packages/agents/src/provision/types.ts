import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
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
import type { EnvAnswer, EnvQuestion } from "../shared";

/** The Cloudflare calls provisioning needs (a `CloudflareClient` or a test fake). */
export type CloudflareApi = Pick<
  CloudflareClient,
  "verifyToken" | "findZone" | "listDnsRecords" | "inspectEntrypointRuleset" | "getIpRanges"
>;

/** The GitHub calls provisioning needs (a `GitHubClient` or a test fake). */
export type GitHubApi = Pick<
  GitHubClient,
  | "getRepo"
  | "getActionsPublicKey"
  | "setActionsSecret"
  | "findOpenPullRequest"
  | "createPullRequest"
>;

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
}

export interface ProvisionOptions {
  /** Plan and print the plan hash; do not apply. */
  planOnly?: boolean;
  /** Apply the saved plan with exactly this hash (from an earlier `--plan-only` run). */
  approvePlanHash?: string;
  /** Overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  /** Push the deploy branch and open a pull request (default true). */
  push?: boolean;
  /** Set the GitHub Actions deploy secrets (default true). */
  secrets?: boolean;
  services?: ProvisionServices;
}

export interface ProvisionResult {
  planHash?: string;
  /** True when this run applied an infrastructure plan. */
  applied: boolean;
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
