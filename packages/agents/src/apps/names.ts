import { join } from "node:path";
import { exists, OpsCrewError, type ProjectPaths, upperFirst } from "@opscrew/core";
import {
  appsOf,
  cleanRepoPath,
  type DeployPlan,
  derivedNames,
  environmentsOf,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { appFlag, mayHaveFurtherApps } from "./choice";
import { appPaths } from "./list";

/** One environment of one app of the repository, with its plan once it is designed. */
export interface AppEnvironmentPlan {
  /** A further app's key; absent for the repository's first app. */
  app?: string;
  environment: string;
  plan?: DeployPlan;
}

/**
 * Every environment of every app in the repository `paths` belong to (`appsOf`, then each app's
 * `environmentsOf`), each with its plan: an app's prod is listed before it has a plan.
 */
export async function repositoryEnvironments(paths: ProjectPaths): Promise<AppEnvironmentPlan[]> {
  const found: AppEnvironmentPlan[] = [];
  for (const { key } of await appsOf(paths.root)) {
    const names = await environmentsOf(paths.root, key);
    for (const environment of names.includes("prod") ? names : ["prod", ...names]) {
      const plan = await readOptionalArtifact("plan", appPaths(paths, key, environment).files.plan);
      found.push({
        ...(key === undefined ? {} : { app: key }),
        environment,
        ...(plan === undefined ? {} : { plan }),
      });
    }
  }
  return found;
}

/**
 * Every app and environment of the repository but `candidate` ({@link repositoryEnvironments});
 * none, with no file read, for the first app's prod while the repository has no other (no
 * `opscrew/apps/` or `opscrew/environments/`): as before them, its design may be writing an
 * unreadable plan anew, which `environmentsOf` would refuse.
 */
async function othersOf(
  paths: ProjectPaths,
  candidate: AppEnvironmentPlan,
): Promise<AppEnvironmentPlan[]> {
  if (
    candidate.app === undefined &&
    candidate.environment === "prod" &&
    !(await mayHaveFurtherApps(paths.root)) &&
    !(await exists(join(paths.root, "opscrew", "environments")))
  ) {
    return [];
  }
  return (await repositoryEnvironments(paths)).filter(
    (other) => other.app !== candidate.app || other.environment !== candidate.environment,
  );
}

/** An app's environment in a sentence: `the first app's prod`, `the app docs's environment qa`. */
export function environmentText({ app, environment }: AppEnvironmentPlan): string {
  const owner = app === undefined ? "the first app's" : `the app ${app}'s`;
  return environment === "prod" ? `${owner} prod` : `${owner} environment ${environment}`;
}

/**
 * Every name of `entry` that no other app or environment of the repository may share, as phrases
 * (`derivedNames`): those its key and environment give, with its app name (the plan's; before
 * design a further app's prod is named after its key), and the plan's own workflow file and
 * infrastructure folder, which the user may have set by hand.
 * @throws OpsCrewError `INVALID_INPUT` when its GitHub environment would be GitHub Pages' own.
 */
function namesOf(entry: AppEnvironmentPlan & { name?: string }): string[] {
  const { app, environment, plan } = entry;
  const name =
    entry.name ?? plan?.app.name ?? (environment === "prod" && app !== undefined ? app : undefined);
  return [
    ...new Set([
      ...derivedNames(app, environment, name),
      ...(plan === undefined
        ? []
        : [
            `the workflow file ${cleanRepoPath(plan.cicd.workflowPath)}`,
            `the infrastructure folder ${cleanRepoPath(plan.infra.dir)}`,
          ]),
    ]),
  ];
}

/**
 * The uniqueness check of `opscrew app add`, `opscrew env add` and design (FR-1615): refuses the
 * app's environment `candidate` (with its app name `name`, or the plan design is about to write)
 * when one of its names ({@link namesOf}) is already another app's or environment's in the
 * repository `paths` belong to, read from their plans ({@link othersOf}). `hint` says what to
 * change.
 * @throws OpsCrewError `INVALID_INPUT` naming the clash and the one that has it; nothing changed.
 */
export async function requireUniqueNames(
  paths: ProjectPaths,
  candidate: AppEnvironmentPlan & { name?: string },
  hint: string,
): Promise<void> {
  const mine = namesOf(candidate);
  for (const other of await othersOf(paths, candidate)) {
    const clash = namesOf(other).find((name) => mine.includes(name));
    if (clash === undefined) continue;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${upperFirst(environmentText(candidate))} would have ${clash}, which ${environmentText(other)} already has: no two apps or environments of a repository may share it. Nothing was changed.`,
      { hint },
    );
  }
}

/**
 * Refuses `candidate` on GitHub Pages when another app or environment of the repository `paths`
 * belong to already publishes there: a repository has one Pages site.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the one already there; nothing changed.
 */
export async function requireOnePagesSite(
  paths: ProjectPaths,
  candidate: AppEnvironmentPlan,
): Promise<void> {
  for (const other of await othersOf(paths, candidate)) {
    if (other.plan?.target.provider !== "github-pages") continue;
    const app = await appFlag(paths.root, candidate.app);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Pages publishes one site per repository, and ${environmentText(other)} is already on it, so ${environmentText(candidate)} cannot be. Nothing was written.`,
      {
        hint: `Choose another target for this one with \`opscrew interview${app}\` (Cloudflare has no such limit), or move the other one off GitHub Pages first.`,
      },
    );
  }
}
