import { type ProjectPaths, resolveProjectPaths } from "@opscrew/core";

/**
 * The paths of the environment `name` of the app `paths` belong to (`paths.app`, a further app's
 * key, kept), beside `paths`: the same project and OpsCrew home.
 */
export function environmentPaths(paths: ProjectPaths, name: string): ProjectPaths {
  return resolveProjectPaths(paths.root, {
    env: { OPSCREW_HOME: paths.homeDir },
    ...(paths.app === undefined ? {} : { app: paths.app }),
    environment: name,
  });
}
