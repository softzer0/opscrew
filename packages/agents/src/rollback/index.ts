/**
 * `opscrew rollback` (feature 019, ADR 0023): puts an environment back on an earlier version of
 * its own, with no build and no release command, after a `promote`-kind approval bound to its
 * hash, then pauses its automatic deploys until `--resume`.
 */
import type { GitHubClient } from "@opscrew/connector-github";
import { isServerlessProvider } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { LocalhostServices } from "../localhost/services";
import type { PromoteServices } from "../promote/types";
import type { PortainerServices, ProvisionServices } from "../provision/types";
import type { DeployPause } from "../shared/deploy-pause";
import type { DatabaseQuestion } from "./database";
import { rollbackLocal } from "./local";
import type { DatabaseChoice, DatabaseRecord } from "./record";
import { resumeDeploys } from "./resume";
import { requireRollbackable, rollbackRun } from "./run";
import { rollbackServer } from "./server";
import { rollbackSite } from "./site";
import type { LeftOutVersion, VersionsGitHubApi, VersionView } from "./types";

export { pinnedText, rotationWindowText } from "../shared/deploy-pause";
export type { DatabaseOffer } from "./database";
export { DATABASE_CHOICES } from "./record";
export type {
  DatabaseChoice,
  DatabaseQuestion,
  DatabaseRecord,
  DeployPause,
  LeftOutVersion,
  VersionView,
};

/**
 * `opscrew rollback` on the environment `deps` belong to (FR-1901–FR-1909): with `resume`, ends
 * the pause a rollback set ({@link resumeDeploys}); otherwise, once its plan shows it can roll
 * back ({@link requireRollbackable}), lists its versions (`list`) or goes back to one, by its
 * target: a site on Cloudflare's hosting or GitHub Pages ({@link rollbackSite}), this computer
 * ({@link rollbackLocal}), or a server or the user's Portainer ({@link rollbackServer}).
 * @throws OpsCrewError `PHASE_PRECONDITION` for each refusal, `PLAN_NOT_APPROVED` when
 * `approveHash` names another rollback, `APPROVAL_REFUSED` when the user does not approve, and
 * `COMMAND_FAILED` when the deploy run does not succeed.
 */
export async function rollback(deps: PhaseDeps, options: RollbackOptions): Promise<RollbackResult> {
  const run = await rollbackRun(deps, options);
  if (options.resume === true) return resumeDeploys(run);
  requireRollbackable(run);
  const provider = run.plan.target.provider;
  if (isServerlessProvider(provider)) return rollbackSite(run);
  if (provider === "localhost") return rollbackLocal(run);
  return rollbackServer(run);
}

/**
 * The GitHub and GHCR calls a rollback needs: the versions' (a `GitHubClient` or a test fake), and
 * the pause variable's writes.
 */
export type RollbackGitHubApi = VersionsGitHubApi &
  Pick<GitHubClient, "setRepoVariable" | "deleteRepoVariable">;

/**
 * Collaborators that talk to the outside world. Each defaults to the real implementation built
 * from `PhaseDeps`; tests replace them with fakes.
 */
export interface RollbackServices extends Omit<PromoteServices, "github"> {
  /** GitHub's API and registry (default: a client with the user's token); `null` means no token. */
  github?: RollbackGitHubApi | null;
  /** The clock of the wait for running deploys (tests). */
  now?: () => number;
  /** This computer (`target.provider: localhost`). */
  localhost?: LocalhostServices;
  /** The app's server's shell, given its address (default: ssh with the login `logs` uses). */
  remote?: ProvisionServices["remote"];
  /** The user's Portainer: its client (default: pinned to the confirmed certificate). */
  portainer?: PortainerServices;
}

export interface RollbackOptions {
  /**
   * `--to <commit|digest|version>`: the version to go back to (default: the deployment before the
   * one running, ADR 0023 D4). On a server a commit or a digest, or a prefix of either.
   */
  to?: string;
  /** `--list`: the versions there are, and the pause; read-only. */
  list?: boolean;
  /** `--resume`: ends the pause a rollback set. */
  resume?: boolean;
  /** `--deploy`, with `resume`: also deploys the branch's latest commit now. */
  deploy?: boolean;
  /**
   * `--approve <hash>`: the rollback hash the user reviewed. The rollback stops before asking when
   * its hash is now another one.
   */
  approveHash?: string;
  /** `--allow-old-secrets <names>`, on Cloudflare's hosting only, as `promote --version`. */
  allowOldSecrets?: string[];
  /**
   * `--database <choice>`: how a server's or this computer's rollback treats the database (plan.md
   * 12.5). Without it, `chooseDatabase` asks, or the default applies: the snapshot outside prod
   * when there is one, keep otherwise. A site refuses `snapshot` and `migrations`.
   */
  database?: DatabaseChoice;
  /** A terminal's question, asked when more than keep is offered and `database` is not given. */
  chooseDatabase?: (question: DatabaseQuestion) => Promise<DatabaseChoice>;
  services?: RollbackServices;
}

export type RollbackResult =
  | {
      kind: "list";
      /** Newest first, with their marks ({@link VersionView}). */
      versions: VersionView[];
      /** The environment's pause entry, when its deploys are paused. */
      paused?: DeployPause;
      /** The images left out, each with why (FR-1903); none on this computer and the sites. */
      leftOut: LeftOutVersion[];
    }
  | {
      kind: "rolled-back";
      /**
       * `deployed`: the version runs, and is recorded. `waiting`: the run waits in GitHub for a
       * required reviewer; the next `opscrew rollback` records it.
       */
      status: "deployed" | "waiting";
      target: VersionView;
      /** The version it ran before. */
      from?: VersionView;
      /** The deploy run (none on Cloudflare's hosting or this computer). */
      runUrl?: string;
      /** Whether its automatic deploys are paused now. */
      paused: boolean;
      /**
       * How it went back: an image by its digest, a Worker version, a GitHub Pages re-run, or
       * this computer's earlier image.
       */
      how: "image" | "worker" | "pages" | "local";
      /** What it did with the database (a server's or this computer's rollback). */
      database?: DatabaseRecord;
    }
  | {
      kind: "resumed";
      /** False when its deploys were not paused. */
      wasPaused: boolean;
      /**
       * With `--deploy`: the run that deploys the branch, its commit, and whether it deployed or
       * waits in GitHub for a required reviewer.
       */
      deployed?: { status: "deployed" | "waiting"; runUrl: string; commit: string };
    };
