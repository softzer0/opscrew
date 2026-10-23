import { APP_KEY_MESSAGE, APP_KEY_PATTERN, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { RepoPathSchema } from "./enums";

export { APP_KEY_MESSAGE, APP_KEY_PATTERN };

/**
 * A further app's key (`plan.app.key`, `opscrew/apps/<key>/`): an environment's name rules, and
 * never `prod` ({@link APP_KEY_PATTERN}).
 */
export const AppKeySchema = z.string().regex(APP_KEY_PATTERN, { message: APP_KEY_MESSAGE });

/**
 * `opscrew/apps/<key>/app.yaml`: a further app's record, which `opscrew app add` writes. The key
 * is the folder's name. The repository's first app has none.
 */
export const AppRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The app's folder in the repository, `.` for the repository's root. */
  dir: RepoPathSchema,
});
export type AppRecord = z.infer<typeof AppRecordSchema>;

/** The branches OpsCrew opens: adapt's code changes, and provision's deploy setup. */
export type AppBranchBase = "opscrew/prepare-deploy" | "opscrew/deploy-setup";

/**
 * The parts of every derived name: a further app's key, then the environment's name (none for
 * prod, given as `prod` or left out). The first app's prod has none.
 */
function parts(app: string | undefined, env: string | undefined): string[] {
  return [app, env === "prod" ? undefined : env].filter((part) => part !== undefined);
}

/**
 * The deploy workflow of an app's environment: `.github/workflows/opscrew-deploy[-<key>][-<env>].yml`
 * (the first app's prod: `opscrew-deploy.yml`). `env` is the environment's name; `prod` or none
 * is prod.
 */
export function workflowPathFor(app?: string, env?: string): string {
  const suffix = parts(app, env)
    .map((part) => `-${part}`)
    .join("");
  return `.github/workflows/opscrew-deploy${suffix}.yml`;
}

/**
 * The infrastructure root of an app's environment: `opscrew/infra/prod` for the first app's prod,
 * `opscrew/infra/<env>` for its other environments, `opscrew/infra/<key>` and
 * `opscrew/infra/<key>-<env>` for a further app.
 */
export function infraDirFor(app?: string, env?: string): string {
  const name = parts(app, env).join("-");
  return `opscrew/infra/${name === "" ? "prod" : name}`;
}

/**
 * What the names of an app's environment's deploy secrets start with: `OPSCREW_`, then the key
 * and the environment's name in upper case with `_` for `-`, each followed by `_`
 * (`OPSCREW_DOCS_STAGING_`). The first app's prod's is `OPSCREW_`, so its names stay as they are.
 */
export function deploySecretPrefix(app?: string, env?: string): string {
  const named = parts(app, env).map((part) => `${part.toUpperCase().replaceAll("-", "_")}_`);
  return `OPSCREW_${named.join("")}`;
}

/**
 * GitHub Pages' own GitHub environment, which its deploy job runs in and `opscrew destroy` deletes
 * with the site: never an app's environment's.
 */
const GITHUB_PAGES_ENVIRONMENT = "github-pages";

/**
 * The GitHub environment an app's environment's deploy job runs in when its secrets live in one:
 * `production` for the first app's prod, `<env>` for its other environments, `<key>-production`
 * and `<key>-<env>` for a further app.
 * @throws OpsCrewError `INVALID_INPUT` when that would be `github-pages`, GitHub Pages' own: the
 * name rules refuse an environment of that name, and this refuses a key and a name that join into
 * it (the environment `pages` of the app `github`).
 */
export function githubEnvironmentFor(app?: string, env?: string): string {
  const named = env === "prod" ? undefined : env;
  const name = [...(app === undefined ? [] : [app]), named ?? "production"].join("-");
  if (name === GITHUB_PAGES_ENVIRONMENT) {
    const which =
      app === undefined ? `The environment "${named}"` : `The app ${app}'s environment "${named}"`;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${which} would deploy in the GitHub environment github-pages, which belongs to GitHub Pages: OpsCrew deletes it when it destroys a Pages site.`,
      { hint: "Give the environment another name." },
    );
  }
  return name;
}

/**
 * The app's image on GitHub Container Registry, in lower case as GHCR names it:
 * `ghcr.io/<owner>/<repo>` for the first app, `ghcr.io/<owner>/<repo>/<key>` for a further app.
 * `repo` is the repository's `<owner>/<repo>`. Every environment of the app pushes to it.
 */
export function ghcrImageFor(repo: string, app?: string): string {
  return `ghcr.io/${repo}${app === undefined ? "" : `/${app}`}`.toLowerCase();
}

/** The branch OpsCrew opens for an app: `base` for the first app, `<base>-<key>` for a further app. */
export function appBranch(base: AppBranchBase, app?: string): string {
  return app === undefined ? base : `${base}-${app}`;
}

/**
 * Every name of an app's environment that must differ from every other app's and environment's
 * in the repository, each as a phrase naming its kind (`the workflow file …`), so equal phrases are
 * a clash and can be shown as they are: the workflow file, the infrastructure folder, the GitHub
 * environment, what its deploy secrets' names start with, and, given the plan's `app.name`
 * (`name`), the app name its resources and concurrency group are named after. The branches and the
 * image follow the key alone, so they are not listed here.
 * @throws OpsCrewError `INVALID_INPUT` for an app's environment whose GitHub environment would be
 * GitHub Pages' own ({@link githubEnvironmentFor}).
 */
export function derivedNames(app?: string, env?: string, name?: string): string[] {
  return [
    `the workflow file ${workflowPathFor(app, env)}`,
    `the infrastructure folder ${infraDirFor(app, env)}`,
    `the GitHub environment ${githubEnvironmentFor(app, env)}`,
    `the secret names starting with ${deploySecretPrefix(app, env)}`,
    ...(name === undefined ? [] : [`the app name ${name} (resource names and concurrency group)`]),
  ];
}
