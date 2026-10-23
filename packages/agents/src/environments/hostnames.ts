import { join } from "node:path";
import { exists, OpsCrewError, type ProjectPaths, toPosixRelative } from "@opscrew/core";
import { siteHosts } from "@opscrew/iac-templates";
import { type DeployPlan, environmentsOf, readArtifact } from "@opscrew/plan-schema";
import { appFlag, mayHaveFurtherApps } from "../apps/choice";
import { type AppEnvironmentPlan, environmentText, repositoryEnvironments } from "../apps/names";
import { environmentPaths } from "./paths";

/**
 * Design's and provision's check that the plan of the environment `paths` belong to serves the
 * app on hostnames of its own (`siteHosts`): another environment of the app, or of another app of
 * the repository, already using one stops (`INVALID_INPUT`, nothing changed), so one's records
 * never point at another's server or site. A first app with prod alone and no further app has
 * nothing to compare, and its files are not read.
 */
export async function requireOwnHostnames(paths: ProjectPaths, plan: DeployPlan): Promise<void> {
  const env = paths.environment;
  const mine = siteHosts(plan);
  if (mine.length === 0) return;
  // The first app alone: as before further apps; with prod alone, as before environments (its
  // design may be writing an unreadable plan anew, which `environmentsOf` would refuse).
  const alone = paths.app === undefined && !(await mayHaveFurtherApps(paths.root));
  const folder = join(environmentPaths(paths, "prod").artefactsDir, "environments");
  if (alone && env === "prod" && !(await exists(folder))) return;
  const others: AppEnvironmentPlan[] = alone
    ? await Promise.all(
        (await environmentsOf(paths.root)).map(async (environment) => ({
          environment,
          plan: await readArtifact("plan", environmentPaths(paths, environment).files.plan),
        })),
      )
    : await repositoryEnvironments(paths);
  for (const other of others) {
    if (other.plan === undefined || (other.app === paths.app && other.environment === env)) {
      continue;
    }
    const taken = siteHosts(other.plan).find((hostname) => mine.includes(hostname));
    if (taken === undefined) continue;
    const app = await appFlag(paths.root, paths.app);
    throw new OpsCrewError(
      "INVALID_INPUT",
      other.app === paths.app
        ? `${taken} is already the ${other.environment} environment's hostname, and every environment needs its own. Nothing was changed.`
        : `${taken} is already the hostname of ${environmentText(other)}, and every app needs its own. Nothing was changed.`,
      {
        hint:
          env === "prod"
            ? `Answer another domain with \`opscrew interview${app}\`, then run \`opscrew design${app}\` again.`
            : `Give ${env} another hostname (domain) in ${toPosixRelative(paths.root, paths.files.requirements)}, then run \`opscrew design${app} --env ${env}\` again.`,
      },
    );
  }
}
