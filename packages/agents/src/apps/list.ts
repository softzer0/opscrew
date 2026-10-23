import { type ProjectPaths, resolveProjectPaths } from "@opscrew/core";
import { appsOf, environmentsOf, readArtifact } from "@opscrew/plan-schema";
import { environmentDeployed } from "../environments/list";

/** One app of the repository, as `opscrew app list` shows it. */
export interface AppSummary {
  /** A further app's key; absent for the repository's first app. */
  key?: string;
  /** The app's folder in the repository, `.` for the repository's root. */
  dir: string;
  /** Whether something of one of its environments may be running or left behind. */
  deployed: boolean;
}

/**
 * The paths of the app `key` (a further app's; `undefined`: the first app) at its environment
 * `environment` (prod by default), beside `paths`: the same project and OpsCrew home.
 */
export function appPaths(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  key: string | undefined,
  environment?: string,
): ProjectPaths {
  return resolveProjectPaths(paths.root, {
    env: { OPSCREW_HOME: paths.homeDir },
    ...(key === undefined ? {} : { app: key }),
    ...(environment === undefined ? {} : { environment }),
  });
}

/**
 * The environments of the app `key` (`environmentsOf`) that may have something running or left
 * behind (`environmentDeployed`), in their order.
 */
export async function deployedEnvironments(
  paths: ProjectPaths,
  key: string | undefined,
): Promise<string[]> {
  const deployed: string[] = [];
  for (const name of await environmentsOf(paths.root, key)) {
    const own = appPaths(paths, key, name);
    if (await environmentDeployed(own, await readArtifact("plan", own.files.plan))) {
      deployed.push(name);
    }
  }
  return deployed;
}

/**
 * The repository's apps in their order (`appsOf`: the first app, then the further apps by key),
 * each with its folder and whether it is deployed. `paths` are any of the repository's.
 */
export async function listApps(paths: ProjectPaths): Promise<AppSummary[]> {
  const apps = await appsOf(paths.root);
  return Promise.all(
    apps.map(async ({ key, dir }) => ({
      ...(key === undefined ? {} : { key }),
      dir,
      deployed: (await deployedEnvironments(paths, key)).length > 0,
    })),
  );
}
