import {
  ABORT_COMMAND,
  FINISH_COMMAND,
  placeWords,
  type RetargetSummary,
  RUN_COMMAND,
  sideWords,
} from "@opscrew/agents";
import { formatMoney } from "@opscrew/core";
import type { DeployPlan, DeployTarget, Retarget } from "@opscrew/plan-schema";
import { isCloudProvider } from "@opscrew/plan-schema";

/** `on the new server …`, `in your Portainer`: where the app runs on a side. */
const onSide = (target: Pick<DeployTarget, "provider">, which: "old" | "new") =>
  `${target.provider === "portainer" ? "in" : "on"} ${sideWords(target, which)}`;

/** What each completed step of a move means, in plain words, for any two sides. */
function stepWords(
  step: Retarget["step"],
  from: Pick<DeployTarget, "provider">,
  to: Pick<DeployTarget, "provider">,
): string {
  switch (step) {
    case "started":
      return "move started, nothing created yet";
    case "renamed":
      return isCloudProvider(from.provider)
        ? "current server renamed in the infrastructure state"
        : "infrastructure state ready for the move";
    case "created":
      return `${sideWords(to, "new")} ${isCloudProvider(to.provider) ? "created" : "prepared"}`;
    case "deployed":
      return `app deployed ${onSide(to, "new")}`;
    case "migrated":
      return `data copied to ${sideWords(to, "new")}`;
    case "switched":
      return `traffic switched to ${sideWords(to, "new")}`;
  }
}

/**
 * The `retarget` line of `opscrew status` for a move in progress between any two server targets:
 * where it moves from and to, the last completed step and the command to run next. `undefined`
 * when no move is recorded.
 */
export function retargetStatusLine(plan: DeployPlan): string | undefined {
  const move = plan.retarget;
  if (move === undefined) return undefined;
  const from = move.from.target;
  const to = plan.target;
  let state: string;
  let next: string;
  if (move.abort !== undefined) {
    state = `being aborted (last completed abort step: ${move.abort.step})`;
    next = `run \`${ABORT_COMMAND}\` to complete the abort`;
  } else if (move.step === "switched") {
    state = `last completed step: switched (${stepWords("switched", from, to)})`;
    const old = sideWords(from, "old");
    next = `run \`${FINISH_COMMAND}\` to ${isCloudProvider(from.provider) ? `delete ${old}` : `remove the app from ${old}`} once the app works ${onSide(to, "new")}`;
  } else {
    const stopped =
      move.oldAppStoppedAt !== undefined ? `; the app ${onSide(from, "old")} is stopped` : "";
    state = `last completed step: ${move.step} (${stepWords(move.step, from, to)})${stopped}`;
    next = `run \`${RUN_COMMAND}\` to continue, or \`${ABORT_COMMAND}\` to undo the move`;
  }
  return `  retarget  moving from ${placeWords(from)} to ${placeWords(to)}; ${state}; next: ${next}.`;
}

/** The yes/no question asked after the move's summary (printed by the phase) in a terminal. */
export function startQuestion(summary: RetargetSummary): string {
  const to = placeWords(summary.to);
  const cost =
    summary.extraMonthly.amount > 0
      ? `It costs ${formatMoney(summary.extraMonthly)} per month extra while both run`
      : "It adds no monthly cost";
  const downtime =
    summary.expectedDowntimeMinutes === undefined
      ? "no maintenance window"
      : `about ${summary.expectedDowntimeMinutes} minutes of downtime while the data is copied`;
  return `Start the move to ${to}? ${cost}, with ${downtime}.`;
}
