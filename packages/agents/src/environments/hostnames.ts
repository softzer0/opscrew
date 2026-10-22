import { join } from "node:path";
import { exists, OpsCrewError, type ProjectPaths, toPosixRelative } from "@opscrew/core";
import { siteHosts } from "@opscrew/iac-templates";
import { type DeployPlan, environmentsOf, readArtifact } from "@opscrew/plan-schema";
import { environmentPaths } from "./paths";

/**
 * Design's and provision's check that the plan of the environment `paths` belong to serves the
 * app on hostnames of its own (`siteHosts`): another environment of the app already using one
 * stops (`INVALID_INPUT`, nothing changed), so one environment's records never point at another's
 * server. An app with prod alone has nothing to compare, and its files are not read.
 */
export async function requireOwnHostnames(paths: ProjectPaths, plan: DeployPlan): Promise<void> {
  const env = paths.environment;
  const mine = siteHosts(plan);
  if (mine.length === 0) return;
  // Prod without other environments: as before them (its design may be writing an unreadable
  // plan anew, which `environmentsOf` would refuse).
  const folder = join(environmentPaths(paths, "prod").artefactsDir, "environments");
  if (env === "prod" && !(await exists(folder))) return;
  for (const name of await environmentsOf(paths.root)) {
    if (name === env) continue;
    const other = await readArtifact("plan", environmentPaths(paths, name).files.plan);
    const taken = siteHosts(other).find((hostname) => mine.includes(hostname));
    if (taken === undefined) continue;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${taken} is already the ${name} environment's hostname, and every environment needs its own. Nothing was changed.`,
      {
        hint:
          env === "prod"
            ? "Answer another domain with `opscrew interview`, then run `opscrew design` again."
            : `Give ${env} another hostname (domain) in ${toPosixRelative(paths.root, paths.files.requirements)}, then run \`opscrew design --env ${env}\` again.`,
      },
    );
  }
}
