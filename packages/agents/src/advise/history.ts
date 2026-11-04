import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ServerHistory } from "./types";

/**
 * The environment's servers' 14 days from the self-hosted stack, by the plan's server name;
 * `undefined` without monitoring.
 */
export async function readHistory(
  _deps: PhaseDeps,
  _plan: DeployPlan,
): Promise<Record<string, ServerHistory> | undefined> {
  throw new Error("not implemented yet");
}
