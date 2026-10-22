/** How the runners name an environment in GitHub, on this computer and in their messages. */
import { runnerLabel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { environmentFlag } from "../environments/choice";

/** `<app>-<env>` (`shop-prod`, `shop-staging`): the runner's label without `opscrew-`. */
export function runnerSuffix(plan: DeployPlan): string {
  return runnerLabel(plan).slice("opscrew-".length);
}

/** The plan's file in the repository: `opscrew/plan.yaml`, or the named environment's. */
export function planFile(plan: DeployPlan): string {
  const name = plan.environment?.name;
  return name === undefined ? "opscrew/plan.yaml" : `opscrew/environments/${name}/plan.yaml`;
}

/**
 * ` --env <name>` for a named environment's commands, "" for prod: for text made where the app's
 * environments are not read (drift's and verify's sync renderers). Prefer {@link planWhere}, which
 * also names `--env prod` beside other environments.
 */
export function namedEnvironmentFlag(plan: DeployPlan): string {
  const name = plan.environment?.name;
  return name === undefined ? "" : ` --env ${name}`;
}

/**
 * The plan's file in the repository, and ` --env <name>` for the commands of its environment while
 * the app in `root` has several (prod's included, `environmentFlag`); "" with prod alone.
 */
export async function planWhere(
  root: string,
  plan: DeployPlan,
): Promise<{ file: string; flag: string }> {
  return {
    file: planFile(plan),
    flag: await environmentFlag(root, plan.environment?.name ?? "prod"),
  };
}
