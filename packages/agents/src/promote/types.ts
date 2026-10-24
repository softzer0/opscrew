import type { CloudflareClient } from "@opscrew/connector-cloudflare";
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
  | "imageFacts"
  | "workflowRun"
  | "getWorkflowRun"
  | "dispatchWorkflow"
  | "waitForWorkflowRun"
  | "pagesRuns"
  | "rerunWorkflowRun"
  | "runArtifacts"
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
  /** Cloudflare's API for a site on Cloudflare's hosting (default: `CLOUDFLARE_API_TOKEN`'s). */
  sharedCloudflare?: CloudflareClient;
  /** The delay between reads of a re-run GitHub Pages run until GitHub shows it (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface PromoteOptions {
  /**
   * The environment to deploy to (`--to`): one promoted from another environment, or with
   * `version` any environment of a site on Cloudflare's hosting or GitHub Pages.
   */
  target: string;
  /**
   * `--digest sha256:…`: the image the source runs, or the target's previous image for a rollback
   * (default: the image the source runs, its `opscrew-<source>` label). Servers only.
   */
  digest?: string;
  /**
   * `--version <id>`, a rollback on a server-less target: on Cloudflare's hosting a version of the
   * environment's own Worker, activated again; on GitHub Pages an earlier successful run of its
   * workflow, re-run.
   */
  version?: string;
  /**
   * `--allow-old-secrets <names>`, with `version` on Cloudflare's hosting: the secrets Cloudflare
   * listed as changed since that Worker version was active, whose old values the user accepts.
   * Only then is the version activated anyway (Cloudflare's `force`); it runs with those values.
   */
  allowOldSecrets?: string[];
  /**
   * `--approve <hash>`: the promotion hash the user reviewed. The promotion stops before asking
   * when its hash is now another one (the image, an environment or the target's plan changed).
   */
  approveHash?: string;
  services?: PromoteServices;
}

export interface PromoteResult {
  /**
   * `deployed`: the run succeeded (and on a server the image is recorded), or the version is
   * active. `waiting`: the run still waits in GitHub for a required reviewer, and nothing is
   * recorded (a run that failed stops with an error).
   */
  status: "deployed" | "waiting";
  /** Servers: the image deployed, or to be deployed once the reviewer approves, by digest. */
  digest?: string;
  /** Cloudflare's hosting: the build a promotion deployed, by its run and SHA-256. */
  build?: { runId: number; sha256: string };
  /**
   * A rollback on a server-less target: the Worker version activated, or the GitHub Pages run
   * re-run (by its id).
   */
  version?: string;
  /** The deploy workflow's run (none for a rollback on Cloudflare, which runs no workflow). */
  runUrl?: string;
}
