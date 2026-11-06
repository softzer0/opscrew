import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { requireNoSharedPreviews } from "../previews/host";
import { runPhase } from "../shared/phase-status";
import { type MoveSession, moveBase, moveOf, openSession, warnUnusedApproval } from "./session";
import { cloudProviders, placeWords } from "./sides";
import { startMove } from "./start";
import { deployStep, prepareStep, renameStep } from "./steps";
import { completeSwitch, switchStep } from "./switch";
import { ABORT_COMMAND, FINISH_ABORT_HINT, RUN_COMMAND } from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";
import { recoverInterruptedWindow, stepBefore } from "./window";

/** Opens the run for a move that is already recorded in `opscrew/plan.yaml`. */
async function continueMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<MoveSession> {
  const move = moveOf({ plan });
  const to = placeWords(plan.target);
  if (move.abort !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The move to ${to} is being aborted, so it cannot continue.`,
      { hint: FINISH_ABORT_HINT },
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
  if (
    options.ownServer !== undefined ||
    options.portainer !== undefined ||
    options.empty !== undefined
  ) {
    deps.reporter.warn(
      `The new side's answers and --empty only apply when a move starts; the move to ${to} continues as it started.`,
    );
  }
  if (options.keepBucket !== undefined) {
    deps.reporter.warn(
      "--keep-bucket: the bucket's choice was made at the start; it stays as chosen.",
    );
  }
  const services = options.services ?? {};
  // Users first: an interrupted maintenance window left the old app stopped. Starting it again
  // only needs the deploy key (and the infrastructure state when the local record is gone; the
  // Portainer token for the user's Portainer), so a missing cloud token cannot keep it offline.
  let current = plan;
  if (move.oldAppStoppedAt !== undefined && stepBefore(move.step, "migrated")) {
    const base = await moveBase(deps, plan, {
      command: RUN_COMMAND,
      services,
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
    });
    await recoverInterruptedWindow(base);
    current = base.plan;
  }
  return openSession(deps, current, {
    command: RUN_COMMAND,
    providers: cloudProviders({ plan }),
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
        stop = await prepareStep(session, options);
        break;
      case "created":
        stop = await deployStep(session, options);
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
 * `opscrew retarget`: moves a live deployment between any two server targets (a cloud provider,
 * the user's own server, the user's Portainer; ADR 0027) inside the same root module and state
 * (ADR 0007), resuming from the last step recorded in `plan.retarget`: start (the new target,
 * the refusals, the data's sizes and what starts empty, the summary, `confirmStart`) → rename (a
 * cloud old side's moves-only plan) → create (the new side's `prepare`: a server's plan, a host
 * plan, Portainer checked) → deploy (deploy secrets, the workflow's pull request when it differs,
 * the new side's deploy, its edge stopped) → maintenance window (every data mount copied, Postgres
 * dumped, rolled back on any failure) → switch (DNS plan, or the user's confirmation without
 * managed DNS) → the new edge, URL check, old app stopped. Every plan goes through its approval
 * bound to its hash; non-interactive runs stop with the hash (`pendingPlanHash`) and continue
 * with `approvePlanHash`.
 */
export async function runRetarget(
  deps: PhaseDeps,
  options: RetargetOptions = {},
): Promise<RetargetResult> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const name = deps.paths.environment;
  if (plan.environment?.previews !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} is a preview environment: its previews come and go with pull requests, so OpsCrew does not move it to another provider. Nothing was changed.`,
      {
        hint: `To run the previews elsewhere, remove the environment (\`opscrew destroy --env ${name}\`, then \`opscrew env remove ${name}\`) and add it again with \`opscrew env add ${name} --previews --target <provider>\`.`,
      },
    );
  }
  // Not while another environment's previews run on this one's server (FR-2230).
  await requireNoSharedPreviews(
    deps.paths,
    `moving ${name} to another provider`,
    `opscrew retarget${await commandFlags(deps.paths.root, name, deps.paths.app)}`,
  );
  return runPhase(deps, "retarget", async () => {
    const session =
      plan.retarget === undefined
        ? await startMove(deps, plan, options)
        : await continueMove(deps, plan, options);
    const result = await runSteps(session, options);
    warnUnusedApproval(session);
    return result;
  });
}
