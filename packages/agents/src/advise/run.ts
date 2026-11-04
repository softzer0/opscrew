import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { AdviceReport } from "./types";

/** What `runAdvise` reads through besides `deps`. */
export type RunAdviseOptions = Record<string, never>;

/** Reads the environment, runs the rules and reports the proposals; changes nothing. */
export async function runAdvise(
  _deps: PhaseDeps,
  _plan: DeployPlan,
  _options?: RunAdviseOptions,
): Promise<AdviceReport> {
  throw new Error("not implemented yet");
}
