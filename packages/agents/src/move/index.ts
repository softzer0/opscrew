import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ProvisionServices } from "../provision/types";

/**
 * Moves a live service between the app's servers (`plan.move`, FR-1809), resumable at each step.
 * Provision calls it once everything else is set up. Not available yet: it stops with a plain
 * message (T1811 brings the move).
 */
export async function runMove(
  _deps: PhaseDeps,
  input: { plan: DeployPlan; services: ProvisionServices },
): Promise<DeployPlan> {
  const move = input.plan.move;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Moving ${move?.service ?? "a service"} to another server is not available yet. Everything else is set up.`,
    { hint: "Run `opscrew provision` again with a version of OpsCrew that moves services." },
  );
}
