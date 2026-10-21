import type {
  CommandRunner,
  ComputeCatalog,
  CredentialCheck,
  Money,
  ServerSnapshotApi,
  VpsProviderId,
} from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { CloudDeployTarget, DesignOption, Retarget } from "@opscrew/plan-schema";
import type { DestroyPreview } from "../destroy";
import type { GitHubApi, ProvisionServices } from "../provision";

/** The GitHub calls a move needs: the deploy secrets plus running the deploy workflow. */
export interface RetargetGitHubApi extends GitHubApi {
  /** Waits for the dispatched run (by id, else the newest dispatch run on `ref` since `since`). */
  waitForWorkflowRun(
    owner: string,
    repo: string,
    options: {
      workflowFile: string;
      ref: string;
      runId?: number;
      /** ISO time just before the dispatch. */
      since: string;
      timeoutMs?: number;
      pollMs?: number;
    },
  ): Promise<{ id: number; conclusion: string | null; htmlUrl: string }>;
}

/**
 * Collaborators that talk to the outside world. Each defaults to the real implementation built
 * from `PhaseDeps`; tests replace them with fakes.
 */
export interface RetargetServices
  extends Pick<
    ProvisionServices,
    "engine" | "cloudflare" | "tcpConnect" | "remote" | "askEnv" | "askStorageKey"
  > {
  /** Credential checks per provider (default: `vpsConnector(id).verifyCredentials`). */
  providers?: Partial<
    Record<VpsProviderId, { configured: boolean; verify(): Promise<CredentialCheck> }>
  >;
  /** GitHub REST API (default: client from `resolveGitHubToken`); `null` means no token. */
  github?: RetargetGitHubApi | null;
  /** Runs `scp -3` between the servers (default: `deps.runner`). */
  runner?: CommandRunner;
  /** Server lookup and snapshots per provider (default: `vpsConnector(id).servers`). */
  servers?: Partial<Record<VpsProviderId, ServerSnapshotApi>>;
  /**
   * Price catalogues per provider, for the new server's options and the old server's cost after
   * an abort (default: the provider connector's live catalogue, else its dated price list).
   */
  catalogs?: Partial<Record<VpsProviderId, ComputeCatalog>>;
  /**
   * The addresses a hostname resolves to from this computer, to confirm a DNS change the user made
   * (default: `dns.promises.lookup` with `all: true`).
   */
  resolve?: (hostname: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for wait loops. */
  now?: () => number;
}

/** What the move will do, shown before anything changes. */
export interface RetargetSummary {
  from: CloudDeployTarget;
  to: CloudDeployTarget;
  /** Plain-English steps in order. */
  steps: string[];
  /** Monthly price of the new server, paid on top while both servers run. */
  extraMonthly: Money;
  /** Size of the self-hosted database; undefined without one (no maintenance window). */
  databaseBytes?: number;
  /** Rough length of the maintenance window. */
  expectedDowntimeMinutes?: number;
  /**
   * What changes with the new server, each with its reason: the image builder and the deploy
   * strategy design picks for it (empty when they stay). They go into opscrew/plan.yaml.
   */
  changes: string[];
}

export interface RetargetOptions {
  /** Provider to move to (default: `requirements.provider`). Must differ from the plan's. */
  to?: VpsProviderId;
  /** Design option id to use instead of asking. */
  option?: string;
  /** Apply the saved plan with this hash (from an earlier non-interactive run) and continue. */
  approvePlanHash?: string;
  /** Allow the maintenance window without a prompt (non-interactive runs). */
  allowDowntime?: boolean;
  /** The user switched DNS themselves (DNS provider `other` or `none`). */
  dnsSwitched?: boolean;
  /** Overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  services?: RetargetServices;
  /** Picks a design option (CLI prompt); without it the recommended option is used. */
  choose?: (options: DesignOption[]) => Promise<string>;
  /** Shown once before the first change; returning false stops with nothing changed. */
  confirmStart?: (summary: RetargetSummary) => Promise<boolean>;
}

export interface FinishRetargetOptions {
  /** Snapshot the old server first: `auto` (default) when it held the database or backups. */
  snapshot?: "auto" | boolean;
  approvePlanHash?: string;
  engine?: EnginePreference;
  services?: RetargetServices;
  /** Typed confirmation of the old server's deletion (the CLI asks for the app name). */
  confirm?: (preview: DestroyPreview) => Promise<boolean>;
}

export interface AbortRetargetOptions {
  approvePlanHash?: string;
  engine?: EnginePreference;
  services?: RetargetServices;
  /** Typed confirmation of the new server's deletion (the CLI asks for the app name). */
  confirm?: (preview: DestroyPreview) => Promise<boolean>;
}

export interface RetargetResult {
  /** The step the move reached, or `finished` / `aborted`. */
  step: Retarget["step"] | "finished" | "aborted";
  /**
   * True when the command did all it can: the move switched (`runRetarget`), finished or aborted.
   * False when it stopped on purpose (a plan to approve, a flag to pass); `next` says how to go on.
   */
  done: boolean;
  /** Set when a non-interactive run stopped before an apply: approve it with this hash. */
  pendingPlanHash?: string;
  /** Snapshot of the old server taken by `--finish`, when one was taken. */
  snapshotId?: string;
  /** Plain-English next steps for the CLI to print. */
  next: string[];
}
