/** How the runners name an environment in GitHub, on this computer and in their messages. */

import { resolveProjectPaths, toPosixRelative } from "@opscrew/core";
import { runnerLabel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { commandFlags } from "../environments/choice";

/** `<app>-<env>` (`shop-prod`, `shop-staging`): the runner's label without `opscrew-`. */
export function runnerSuffix(plan: DeployPlan): string {
  return runnerLabel(plan).slice("opscrew-".length);
}

/**
 * The plan's file in the repository: `opscrew/plan.yaml`, or the named environment's, a further
 * app's in its own folder (`opscrew/apps/<key>/…`).
 */
export function planFile(plan: Pick<DeployPlan, "app" | "environment">): string {
  // Only the layout is needed, so any root does: the path is shown relative to it.
  const paths = resolveProjectPaths(".", {
    env: {},
    app: plan.app.key,
    environment: plan.environment?.name,
  });
  return toPosixRelative(paths.root, paths.files.plan);
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
 * The plan's file in the repository, and the flags of the commands of its app's environment
 * (`commandFlags`): a further app's ` --app <key>`, then ` --env <name>` while the app has several
 * environments (prod's included); "" for the first app alone with prod alone.
 */
export async function planWhere(
  root: string,
  plan: DeployPlan,
): Promise<{ file: string; flag: string }> {
  return {
    file: planFile(plan),
    flag: await commandFlags(root, plan.environment?.name ?? "prod", plan.app.key),
  };
}

/**
 * Where an environment's deploy job runs, in words: `GitHub's machines`, `a runner on the server`,
 * `a runner on this computer` or `the runner machine home` (`machine` names it).
 */
export function deployJobPlace(
  runner: NonNullable<DeployPlan["environment"]>["runner"],
  machine: string | undefined,
): string {
  if (runner === "host") return `the runner machine ${machine}`;
  if (runner === "github") return "GitHub's machines";
  return `a runner on ${runner === "server" ? "the server" : "this computer"}`;
}
