import { type ProjectPaths, resolveProjectPaths } from "@opscrew/core";

/** The paths of the app's environment `name`, beside `paths`: the same project and OpsCrew home. */
export function environmentPaths(paths: ProjectPaths, name: string): ProjectPaths {
  return resolveProjectPaths(paths.root, {
    env: { OPSCREW_HOME: paths.homeDir },
    environment: name,
  });
}

/** The environment's infrastructure root, `opscrew/infra/<env>` (prod's `opscrew/infra/prod`). */
export function environmentInfraDir(name: string): string {
  return `opscrew/infra/${name}`;
}

/**
 * The environment's deploy workflow: prod's `.github/workflows/opscrew-deploy.yml`, any other's
 * `.github/workflows/opscrew-deploy-<env>.yml`.
 */
export function environmentWorkflowPath(name: string): string {
  return `.github/workflows/opscrew-deploy${name === "prod" ? "" : `-${name}`}.yml`;
}
