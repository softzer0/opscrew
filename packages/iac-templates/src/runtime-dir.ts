import type { DeployPlan } from "@opscrew/plan-schema";

/**
 * The repository folder of the environment's runtime files (data-model.md "Paths per
 * environment"): `opscrew/runtime` for prod, `opscrew/environments/<env>/runtime` for a named
 * environment. Every rendered runtime file, and every workflow step that names one, is under it.
 */
export function runtimeDir(plan: DeployPlan): string {
  const env = plan.environment?.name;
  return env === undefined ? "opscrew/runtime" : `opscrew/environments/${env}/runtime`;
}
