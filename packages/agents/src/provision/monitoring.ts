/**
 * Provision's monitoring: the host plans that set up the network, the filter, Alloy and the stack
 * on each server. A stub until the provision task fills it.
 */
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { HostPlanStep } from "../shared/host-plan";

/** The monitoring host plans for the plan's servers, in the order provision applies them. */
export async function monitoringHostPlans(
  _deps: PhaseDeps,
  _plan: DeployPlan,
): Promise<HostPlanStep[]> {
  throw new Error("monitoringHostPlans is not implemented yet.");
}
