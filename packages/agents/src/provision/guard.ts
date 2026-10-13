import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";

/** What to say while `opscrew retarget` is moving the deployment. */
export interface MoveInProgress {
  message: string;
  hint: string;
}

/**
 * The plain-English notice for a move in progress (`plan.retarget` exists), or `undefined` when
 * no move is under way. `plan.target` is already the provider the move goes to.
 */
export function moveInProgress(
  plan: Pick<DeployPlan, "target" | "retarget">,
): MoveInProgress | undefined {
  if (plan.retarget === undefined) return undefined;
  return {
    message: `A move to ${providerProfile(plan.target.provider).displayName} is in progress.`,
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
