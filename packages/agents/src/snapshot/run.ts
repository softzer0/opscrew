/**
 * What `opscrew snapshot`, `snapshot list` and `snapshot delete` share (024 plan.md 3.–4.): the
 * environment its deps belong to with the command its hints name, where its data lives, and the
 * refusals while a deploy or a move runs.
 */
import { githubConnector } from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, onOneServer, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { FINISH_COMMAND, MOVE_COMMAND } from "../move/window";
import { NOTHING_CHANGED } from "../promote/shared";
import { missing } from "../provision/credentials";
import { moveInProgress } from "../provision/guard";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import { runningDeploy } from "../shared/deploy-pause";
import { deploysOnTheirOwn } from "../status/deploys";
import type { SnapshotServices } from "./types";

/** One run of a snapshot command, on the environment its deps belong to. */
export interface SnapshotRun {
  deps: PhaseDeps;
  plan: DeployPlan;
  /** The environment's name. */
  environment: string;
  /** ` [--app <key>] [--env <env>]`: the flags of the commands the hints name. */
  flags: string;
  services: SnapshotServices;
}

/**
 * Where an environment's data lives: the app's servers (one OpsCrew created or the user's own,
 * and its extra servers), this computer, or the user's Portainer.
 */
export type SnapshotTarget = "servers" | "computer" | "portainer";

/** The run of a snapshot command on the environment `deps` belong to. */
export async function snapshotRun(
  deps: PhaseDeps,
  services: SnapshotServices = {},
): Promise<SnapshotRun> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const environment = deps.paths.environment;
  const flags = await commandFlags(deps.paths.root, environment, deps.paths.app);
  return { deps, plan, environment, flags, services };
}

/**
 * Where `run`'s data lives ({@link SnapshotTarget}).
 * @throws OpsCrewError `PHASE_PRECONDITION` for a site on Cloudflare's hosting or GitHub Pages,
 * which keeps no data OpsCrew snapshots.
 */
export function snapshotTarget(run: SnapshotRun): SnapshotTarget {
  const { provider } = run.plan.target;
  if (provider === "localhost") return "computer";
  if (provider === "portainer") return "portainer";
  if (onOneServer(provider)) return "servers";
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${run.environment} is a site on ${provider === "github-pages" ? "GitHub Pages" : "Cloudflare's hosting"}: it keeps no data on a server, so there is nothing to snapshot. ${NOTHING_CHANGED}`,
  );
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) before `what` (`take a snapshot`) while a move runs
 * (to another target, `opscrew retarget`, or of a service between the app's servers) or a run of
 * the environment's deploy workflow is queued or in progress, naming it. This computer without the
 * local runner deploys only through `opscrew provision`, whose lock the script waits for.
 */
export async function requireNoDeployOrMove(run: SnapshotRun, what: string): Promise<void> {
  const { deps, plan, environment, flags, services } = run;
  const retarget = moveInProgress(plan);
  if (retarget !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${retarget.message} OpsCrew does not ${what} while the app moves. ${NOTHING_CHANGED}`,
      { hint: retarget.hint },
    );
  }
  if (plan.move !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.move.service} moves between the app's servers, so OpsCrew does not ${what} until the move is finished. ${NOTHING_CHANGED}`,
      {
        hint: `Finish the move first: \`${MOVE_COMMAND}${flags}\` takes it on, and \`${FINISH_COMMAND}${flags}\` ends it once the app runs on the new copy. Then try again.`,
      },
    );
  }
  if (!deploysOnTheirOwn(plan)) return;
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  const api = services.github === undefined ? await githubClientFromToken(deps) : services.github;
  if (!api) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  const running = await runningDeploy({ api, owner, repo }, plan);
  if (running === undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `A run of ${environment}'s deploy workflow is queued or in progress: ${running.url}. OpsCrew does not ${what} during a deploy, so the two never race. ${NOTHING_CHANGED}`,
    { hint: "Let it end, then try again." },
  );
}
