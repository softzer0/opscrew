import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { moveProvider } from "../shared/vps-target";

/** What to say while `opscrew retarget` is moving the deployment. */
export interface MoveInProgress {
  message: string;
  hint: string;
}

/**
 * The plain-English notice for a move in progress (`plan.retarget` exists), or `undefined` when
 * no move is under way. `plan.target` is already the provider the move goes to. Once an abort
 * began (`retarget.abort`), the move can only be aborted, so the hint names only the abort.
 */
export function moveInProgress(
  plan: Pick<DeployPlan, "target" | "retarget">,
): MoveInProgress | undefined {
  if (plan.retarget === undefined) return undefined;
  const to = providerProfile(moveProvider(plan.target)).displayName;
  if (plan.retarget.abort !== undefined) {
    return {
      message: `A move to ${to} is being aborted.`,
      hint: "Run `opscrew retarget --abort` to finish the abort; it continues where it stopped and puts the app back on the previous server.",
    };
  }
  return {
    message: `A move to ${to} is in progress.`,
    hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
  };
}

/**
 * Stops with `PHASE_PRECONDITION` while a move to another provider is in progress, so provision,
 * design, dns and drift never act on a half-moved deployment.
 */
export function requireNoMoveInProgress(plan: Pick<DeployPlan, "target" | "retarget">): void {
  const move = moveInProgress(plan);
  if (move !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", move.message, { hint: move.hint });
  }
}
