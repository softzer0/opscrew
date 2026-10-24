import { cleanRepoPath, type DeployPlan, workflowPathFor } from "@opscrew/plan-schema";
import { serverlessTarget } from "../serverless/site";
import type { RenderContext } from "../types";

/** The filter pattern of every file in the repository folder `dir`: `<dir>/**`. */
export function inFolder(dir: string): string {
  return `${cleanRepoPath(dir)}/**`;
}

/**
 * The filter patterns of an `app.sharedPaths` entry, a folder or a file: the path itself and
 * everything in it; every path for the repository root (`.`).
 */
function sharedPatterns(path: string): string[] {
  return path === "." ? ["**"] : [path, `${path}/**`];
}

/** True when the repository path `path` is `dir` or lies inside it. */
function within(dir: string, path: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}

/**
 * Every app's deploy workflow (`workflowPathFor`): `.github/workflows/opscrew-deploy*.yml`, which
 * GitHub's `*` matches within the folder only.
 */
const DEPLOY_WORKFLOWS = workflowPathFor().replace(/\.yml$/, "*.yml");

/**
 * The `paths` filter of a deploy workflow's push trigger, in GitHub's syntax (`*`, `**`, a `!`
 * pattern leaves out what the patterns before it matched, and the last pattern a path matches
 * decides), so that a push deploys the app only when it changes a path the run reads: the
 * app's folder (`app.buildContext`), the folders and files of `app.sharedPaths`, the workflow
 * file itself, and `reads`, the patterns of what else the renderer's steps read (the Dockerfile,
 * the repository root's files, OpsCrew's files for the run).
 *
 * An app whose folder is the repository root reads nearly everything, so its filter starts from
 * every path and leaves out what its run never reads: OpsCrew's own files (`opscrew/**`: the
 * infrastructure, the reports, the other environments' and apps' files), every other deploy
 * workflow, and the folders of the repository's other apps (`ctx.otherAppDirs`) that are not
 * within one of its shared folders. Its shared folders and `reads` then come back.
 */
export function pushPaths(
  plan: DeployPlan,
  reads: readonly string[],
  ctx: Pick<RenderContext, "otherAppDirs">,
): string[] {
  const own = cleanRepoPath(plan.app.buildContext);
  const shared = (plan.app.sharedPaths ?? []).map(cleanRepoPath);
  const always = [...shared.flatMap(sharedPatterns), ...reads, plan.cicd.workflowPath];
  if (own !== ".") return [...new Set([inFolder(own), ...always])];
  const apart = (ctx.otherAppDirs ?? [])
    .map(cleanRepoPath)
    .filter((dir) => dir !== "." && !shared.some((folder) => within(folder, dir)));
  return [
    ...new Set([
      "**",
      "!opscrew/**",
      `!${DEPLOY_WORKFLOWS}`,
      ...apart.map((dir) => `!${inFolder(dir)}`),
      ...always,
    ]),
  ];
}

/**
 * Every file directly at the repository root but Markdown (GitHub's `*` stays out of folders): a
 * workspace's package.json, lockfile, workspace file and settings (`.npmrc`, `.yarnrc.yml`,
 * `bunfig.toml`), and the shared configuration a build extends (`tsconfig.base.json`,
 * `turbo.json`).
 */
const ROOT_FILES = ["*", "!*.md"] as const;

/**
 * The repository root's files a server-less site's build reads besides its folder
 * (`siteBuildSteps`): for a Node.js site in a folder, whose package manager installs from the
 * workspace root and whose build may read the root's configuration, {@link ROOT_FILES}; none for
 * Hugo, for files published as they are, or at the root (the folder holds them).
 */
export function siteReads(plan: DeployPlan): readonly string[] {
  const { site } = serverlessTarget(plan);
  if (site.tool !== "node") return [];
  return cleanRepoPath(plan.app.buildContext) === "." ? [] : ROOT_FILES;
}
