import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { providerProfile } from "../providers";
import { loadMoveServers } from "./servers";
import {
  type MoveSession,
  markFailed,
  moveOf,
  openSession,
  readDeployKey,
  warnUnusedApproval,
} from "./session";
import { startMove } from "./start";
import { createStep, deployStep, renameStep } from "./steps";
import { completeSwitch, switchStep } from "./switch";
import { ABORT_COMMAND, RUN_COMMAND } from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";
import { recoverInterruptedWindow, stepBefore } from "./window";

/** Opens the run for a move that is already recorded in `opscrew/plan.yaml`. */
async function continueMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<MoveSession> {
  const move = plan.retarget;
  if (move === undefined) {
    throw new OpsCrewError("INTERNAL", "No move is recorded.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  const to = providerProfile(plan.target.provider).displayName;
  if (move.abort !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The move to ${to} is being aborted, so it cannot continue.`,
      { hint: `Run \`${ABORT_COMMAND}\` to complete the abort.` },
    );
  }
  if (options.to !== undefined && options.to !== plan.target.provider) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A move to ${to} is already in progress, so OpsCrew will not start another one.`,
      {
        hint: `Run \`${RUN_COMMAND}\` to continue it, or \`${ABORT_COMMAND}\` before the switch to undo it.`,
      },
    );
  }
  if (options.option !== undefined) {
    deps.reporter.warn(
      `--option only applies when a move starts; the move to ${to} continues with the server it chose.`,
    );
  }
  const services = options.services ?? {};
  // Users first: an interrupted maintenance window left the old app stopped. Starting it again
  // only needs the deploy key, so a missing token cannot keep the app offline.
  let current = plan;
  if (move.oldAppStoppedAt !== undefined && stepBefore(move.step, "migrated")) {
    const base = {
      deps,
      plan,
      services,
      deployKey: await readDeployKey(deps, RUN_COMMAND),
      servers: await loadMoveServers(deps, plan, RUN_COMMAND),
    };
    await recoverInterruptedWindow(base);
    current = base.plan;
  }
  return openSession(deps, current, {
    command: RUN_COMMAND,
    providers: [move.from.target.provider, plan.target.provider],
    services,
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.approvePlanHash !== undefined ? { approvePlanHash: options.approvePlanHash } : {}),
  });
}

/** Runs the steps from the last completed one until the move switched or a step stops. */
async function runSteps(session: MoveSession, options: RetargetOptions): Promise<RetargetResult> {
  for (;;) {
    const move = moveOf(session);
    let stop: RetargetResult | undefined;
    switch (move.step) {
      case "started":
        stop = await renameStep(session);
        break;
      case "renamed":
        stop = await createStep(session);
        break;
      case "created":
        stop = await deployStep(session);
        break;
      case "deployed":
      case "migrated":
        stop = await switchStep(session, options);
        break;
      case "switched":
        return completeSwitch(session);
    }
    if (stop !== undefined) return stop;
  }
}

/**
 * `opscrew retarget`: moves a live deployment to the other VPS provider inside the same root
 * module and state (ADR 0007), resuming from the last step recorded in `plan.retarget`:
 * start (options, summary, `confirmStart`) → rename (moves-only plan) → create (new server, SSH,
 * host key, cloud-init) → deploy (deploy secrets, deploy workflow, health over SSH, Caddy stopped)
 * → maintenance window (self-hosted Postgres only, rolled back on any failure) → switch (DNS plan,
 * or the user's confirmation without managed DNS) → Caddy, URL check, old app stopped. Every
 * infrastructure plan goes through policies and an approval bound to its hash; non-interactive
 * runs stop with the hash (`pendingPlanHash`) and continue with `approvePlanHash`.
 */
export async function runRetarget(
  deps: PhaseDeps,
  options: RetargetOptions = {},
): Promise<RetargetResult> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  try {
    const session =
      plan.retarget === undefined
        ? await startMove(deps, plan, options)
        : await continueMove(deps, plan, options);
    const result = await runSteps(session, options);
    warnUnusedApproval(session);
    return result;
  } catch (error) {
    await markFailed(deps, error);
    throw error;
  }
}
