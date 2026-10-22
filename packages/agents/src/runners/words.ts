/** How the runners name an environment in GitHub, on this computer and in their messages. */
import { runnerLabel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";

/** `<app>-<env>` (`shop-prod`, `shop-staging`): the runner's label without `opscrew-`. */
export function runnerSuffix(plan: DeployPlan): string {
  return runnerLabel(plan).slice("opscrew-".length);
}

/**
 * The plan's file in the repository, and ` --env <name>` for the commands of a named environment
 * (none for prod).
 */
export function planWhere(plan: DeployPlan): { file: string; flag: string } {
  const name = plan.environment?.name;
  return name === undefined
    ? { file: "opscrew/plan.yaml", flag: "" }
    : { file: `opscrew/environments/${name}/plan.yaml`, flag: ` --env ${name}` };
}
