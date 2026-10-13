import {
  ABORT_COMMAND,
  FINISH_COMMAND,
  formatMoney,
  providerProfile,
  type RetargetSummary,
  RUN_COMMAND,
} from "@opscrew/agents";
import type { DeployPlan, Retarget } from "@opscrew/plan-schema";

/** What each completed step of a move means, in plain words. */
const STEP_WORDS: Record<Retarget["step"], string> = {
  started: "move started, nothing created yet",
  renamed: "current server renamed in the infrastructure state",
  created: "new server created",
  deployed: "app deployed on the new server",
  migrated: "database copied to the new server",
  switched: "traffic switched to the new server",
};

/**
 * The `retarget` line of `opscrew status` for a move in progress: source and target providers,
 * the last completed step and the command to run next. `undefined` when no move is recorded.
 */
export function retargetStatusLine(plan: DeployPlan): string | undefined {
  const move = plan.retarget;
  if (move === undefined) return undefined;
  const from = providerProfile(move.from.target.provider).displayName;
  const to = providerProfile(plan.target.provider).displayName;
  let state: string;
  let next: string;
  if (move.abort !== undefined) {
    state = `being aborted (last completed abort step: ${move.abort.step})`;
    next = `run \`${ABORT_COMMAND}\` to complete the abort`;
  } else if (move.step === "switched") {
    state = `last completed step: switched (${STEP_WORDS.switched})`;
    next = `run \`${FINISH_COMMAND}\` to delete the old server once the app works on the new one`;
  } else {
    const stopped =
      move.oldAppStoppedAt !== undefined ? "; the app on the old server is stopped" : "";
    state = `last completed step: ${move.step} (${STEP_WORDS[move.step]})${stopped}`;
    next = `run \`${RUN_COMMAND}\` to continue, or \`${ABORT_COMMAND}\` to undo the move`;
  }
  return `  retarget  moving from ${from} to ${to}; ${state}; next: ${next}.`;
}

/** The yes/no question asked after the move's summary (printed by the phase) in a terminal. */
export function startQuestion(summary: RetargetSummary): string {
  const to = providerProfile(summary.to.provider);
  const downtime =
    summary.expectedDowntimeMinutes === undefined
      ? "no maintenance window"
      : `about ${summary.expectedDowntimeMinutes} minutes of downtime during the database copy`;
  return `Start the move to ${to.displayName}? It costs ${formatMoney(summary.extraMonthly)} per month extra while both servers run, with ${downtime}.`;
}
