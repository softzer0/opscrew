import type { GitHubClient } from "@opscrew/connector-github";
import type { PhaseDeps } from "../context";
import type { DriftReport } from "../drift";

/** The GitHub and GHCR calls a promotion needs (a `GitHubClient` or a test fake). */
export type PromoteGitHubApi = Pick<
  GitHubClient,
  | "getRepo"
  | "fileSha"
  | "getEnvironment"
  | "taggedDigest"
  | "imageProvenance"
  | "imagePlatforms"
  | "workflowRun"
  | "getWorkflowRun"
  | "dispatchWorkflow"
  | "waitForWorkflowRun"
>;

/**
 * Collaborators that talk to the outside world. Each defaults to the real implementation built
 * from `PhaseDeps`; tests replace them with fakes.
 */
export interface PromoteServices {
  /** GitHub's API and registry (default: a client with the user's token); `null` means no token. */
  github?: PromoteGitHubApi | null;
  /**
   * The target environment's read-only check, given the target's deps (default: `runDrift`). What
   * it finds `opscrew provision` would change stops the promotion.
   */
  drift?: (deps: PhaseDeps) => Promise<DriftReport>;
}

export interface PromoteOptions {
  /** The environment to deploy to (`--to`); its plan is promoted from another environment. */
  target: string;
  /**
   * `--digest sha256:…`: the image the source runs, or the target's previous image for a rollback
   * (default: the image the source runs, its `opscrew-<source>` label).
   */
  digest?: string;
  /**
   * `--approve <hash>`: the promotion hash the user reviewed. The promotion stops before asking
   * when its hash is now another one (the image, an environment or the target's plan changed).
   */
  approveHash?: string;
  services?: PromoteServices;
}

export interface PromoteResult {
  /**
   * `deployed`: the run succeeded and the image is recorded. `waiting`: the run still waits in
   * GitHub for a required reviewer, and nothing is recorded (a run that failed stops with an error).
   */
  status: "deployed" | "waiting";
  /** The image deployed, or to be deployed once the reviewer approves, by digest. */
  digest: string;
  /** The deploy workflow's run. */
  runUrl: string;
}
