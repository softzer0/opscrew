import type { DeployPlan } from "@opscrew/plan-schema";

/** What names an app's environment in a plan: a further app's key and the environment's name. */
export interface AppEnvironment {
  app: Pick<DeployPlan["app"], "key">;
  environment?: Pick<NonNullable<DeployPlan["environment"]>, "name"> | undefined;
}

/**
 * `root` (`opscrew`, `.opscrew` or the project's home folder) for an app's environment
 * (data-model.md "Apps in a repository"): `root` itself for the repository's first app's prod,
 * `<root>/environments/<env>` for its other environments, `<root>/apps/<key>` and
 * `<root>/apps/<key>/environments/<env>` for the further app `plan.app.key`. `environment` is the
 * plan's own unless given; `prod` is prod.
 */
export function appFolder(
  root: string,
  plan: AppEnvironment,
  environment: string | undefined = plan.environment?.name,
): string {
  const key = plan.app.key;
  const app = key === undefined ? root : `${root}/apps/${key}`;
  return environment === undefined || environment === "prod"
    ? app
    : `${app}/environments/${environment}`;
}

/**
 * The repository folder of an app's environment's committed artefacts, {@link appFolder} of
 * `opscrew`: `opscrew` for the first app's prod, `opscrew/environments/<env>`,
 * `opscrew/apps/<key>` or `opscrew/apps/<key>/environments/<env>`.
 */
export function artefactsFolder(plan: AppEnvironment, environment?: string): string {
  return appFolder("opscrew", plan, environment);
}

/**
 * The repository folder of the environment's runtime files, `<artefactsFolder>/runtime`
 * ({@link artefactsFolder}): `opscrew/runtime` for the first app's prod,
 * `opscrew/environments/<env>/runtime` for a named environment, `opscrew/apps/<key>/…` for a
 * further app. Every rendered runtime file, and every workflow step that names one, is under it.
 */
export function runtimeDir(plan: AppEnvironment): string {
  return `${artefactsFolder(plan)}/runtime`;
}
