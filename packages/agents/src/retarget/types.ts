import type { GitHubClient } from "@opscrew/connector-github";
import type {
  ComputeCatalog,
  CredentialCheck,
  Money,
  ServerSnapshotApi,
  VpsProviderId,
} from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type {
  CloudProvider,
  DeployTarget,
  DesignOption,
  Retarget,
  ServerlessProvider,
} from "@opscrew/plan-schema";
import type { DestroyPreview } from "../destroy";
import type { OwnServerAnswers } from "../interview/own-server";
import type { PortainerAnswers } from "../interview/portainer";
import type { GitHubApi, ProvisionServices } from "../provision";
import type { ServerAddress } from "../shared";

/** The GitHub calls a move needs: the deploy secrets plus running the deploy workflow. */
export interface RetargetGitHubApi extends GitHubApi, Pick<GitHubClient, "deleteBranch"> {
  /** Waits for the dispatched run `runId` to complete. */
  waitForWorkflowRun(
    owner: string,
    repo: string,
    options: {
      workflowFile: string;
      ref: string;
      runId: number;
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
    | "engine"
    | "cloudflare"
    | "tcpConnect"
    | "remote"
    | "askEnv"
    | "askStorageKey"
    // The sides on the user's own server and in their Portainer.
    | "own"
    | "runnerGitHub"
    | "portainer"
    // A site's move: OpsCrew's rules in the zone, and the Pages verification record's value.
    | "sharedCloudflare"
    | "askPagesVerification"
  > {
  /** Credential checks per provider (default: `vpsConnector(id).verifyCredentials`). */
  providers?: Partial<
    Record<VpsProviderId, { configured: boolean; verify(): Promise<CredentialCheck> }>
  >;
  /** GitHub REST API (default: client from `resolveGitHubToken`); `null` means no token. */
  github?: RetargetGitHubApi | null;
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

/** The targets a move goes to: a cloud provider, the user's own server, the user's Portainer. */
export type MoveTargetId = CloudProvider | "own" | "portainer";

/** One of the app's data mounts on the old side, as the summary lists it. */
export interface MoveData {
  /** The service whose data it is; `app` for the app's own files, `monitoring` for its stack's. */
  owner: string;
  /** Where the service mounts it in its container (`/var/lib/postgresql/data`). */
  key: string;
  /** Its size on the old side, in bytes. */
  bytes: number;
  /** Copied in the maintenance window (true), or the new side starts with it empty (false). */
  copy: boolean;
}

/** What the move will do, shown before anything changes. */
export interface RetargetSummary {
  /** The side being left (`plan.retarget.from.target`). */
  from: DeployTarget;
  /** The new side (`plan.target`). */
  to: DeployTarget;
  /** Plain-English steps in order. */
  steps: string[];
  /** Monthly price of the new side, paid on top while both run (nothing on the user's own). */
  extraMonthly: Money;
  /** Each data mount on the old side, its size and whether it is copied or starts empty. */
  data: MoveData[];
  /** Rough length of the maintenance window; undefined when nothing is copied (no window). */
  expectedDowntimeMinutes?: number;
  /**
   * What changes with the new side, each with its reason: the image builder and the deploy
   * strategy design picks for it (empty when they stay). They go into opscrew/plan.yaml.
   */
  changes: string[];
}

/**
 * The question for one owner of data on the old side when it is not named with `--empty`: copy
 * its data (the default) or start it empty on the new side.
 */
export interface EmptyQuestion {
  /** A service's name, `app` (the app's own files) or `monitoring`. */
  owner: string;
  /** Its size on the old side, in bytes. */
  bytes: number;
  /** What starting empty loses, in one sentence. */
  loses: string;
}

export interface RetargetOptions {
  /**
   * Where to move to (default: `requirements.provider`). Must be another place than the plan's: a
   * server target for an app on a server, the other site host for a site.
   */
  to?: MoveTargetId | ServerlessProvider;
  /** Design option id to use instead of asking (a move to a cloud provider). */
  option?: string;
  /**
   * `--to own`: how OpsCrew reaches the new server (the interview's server questions, or the
   * answers file's `server.*`). It must be reachable from the internet and serve the app
   * directly: a Cloudflare Tunnel is refused.
   */
  ownServer?: OwnServerAnswers;
  /** `--host-key SHA256:…`: the new own server's host key, needed when nobody can confirm it. */
  hostKey?: string;
  /** `--password-logins off|keep`: the choice about other users' password logins there. */
  passwordLogins?: "off" | "keep";
  /**
   * `--to portainer`: the Portainer answers, Portainer reached and its certificate confirmed as
   * the interview does (`portainer.*`). Web mode `caddy` with the default updater only.
   */
  portainer?: PortainerAnswers;
  /**
   * `--to portainer`: the public address of the environment's host, where its Caddy serves the
   * app: the app's DNS records point there. Kept in OpsCrew's local state only.
   */
  portainerAddress?: ServerAddress;
  /** `--public-image`: the app's image is public on GitHub Container Registry (Portainer). */
  publicImage?: boolean;
  /**
   * `--pages-verification <value>`: the value of GitHub's domain verification record, for a site
   * moving to GitHub Pages (as `opscrew provision` takes it).
   */
  pagesVerification?: string;
  /**
   * `--empty <service>`: what starts empty on the new side instead of being copied: a service on
   * the app's server, `app` for the app's own files, `monitoring` for its stack's.
   */
  empty?: readonly string[];
  /**
   * Asks for each owner of data not named in `empty` whether to copy it (true, the default) or
   * start it empty; without it everything else is copied.
   */
  chooseEmpty?: (question: EmptyQuestion) => Promise<boolean>;
  /**
   * `--keep-bucket`: the app's bucket at the cloud provider being left stays there (and keeps
   * billing) instead of moving to the new provider's object storage.
   */
  keepBucket?: boolean;
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
