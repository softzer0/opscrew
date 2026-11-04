import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";

/**
 * Applies the proposal `id`: a plan proposal writes only its field of the plan, a command proposal
 * returns its command.
 */
export async function applyProposal(
  _deps: PhaseDeps,
  _plan: DeployPlan,
  _id: string,
): Promise<{ plan: DeployPlan; summary: string } | { command: string }> {
  throw new Error("not implemented yet");
}
