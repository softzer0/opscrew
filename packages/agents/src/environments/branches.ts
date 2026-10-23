import type { GitClient } from "@opscrew/connector-github";
import { OpsCrewError, type ProjectPaths } from "@opscrew/core";
import {
  type DeployPlan,
  environmentsOf,
  type ProjectFacts,
  readArtifact,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { environmentPaths } from "./paths";

/**
 * The branch names that suggest an environment (FR-1537), each list in order of preference: the
 * trunk prod follows, then dev's and staging's.
 */
export const ENVIRONMENT_BRANCHES = {
  prod: ["main", "master", "trunk"],
  dev: ["develop", "development", "dev"],
  staging: ["staging", "stage", "release"],
} as const;

/** The environment a branch name suggests. */
export type BranchRole = keyof typeof ENVIRONMENT_BRANCHES;

/** The repository's branch for each environment it has one for: the first match in its list. */
export type BranchMatches = Partial<Record<BranchRole, string>>;

/** The branches among `branches` named like an environment ({@link ENVIRONMENT_BRANCHES}). */
export function matchBranches(branches: readonly string[]): BranchMatches {
  const have = new Set(branches);
  const matches: BranchMatches = {};
  for (const [role, names] of Object.entries(ENVIRONMENT_BRANCHES) as [
    BranchRole,
    readonly string[],
  ][]) {
    const found = names.find((name) => have.has(name));
    if (found !== undefined) matches[role] = found;
  }
  return matches;
}

/**
 * The branches of the repository on GitHub (`origin`) named like an environment: each name of
 * {@link ENVIRONMENT_BRANCHES} looked up at once with `git ls-remote`.
 * @throws OpsCrewError `COMMAND_FAILED` when git cannot reach the remote.
 */
export async function remoteEnvironmentBranches(git: GitClient): Promise<BranchMatches> {
  const names = Object.values(ENVIRONMENT_BRANCHES).flat();
  const shas = await Promise.all(names.map((name) => git.remoteBranchSha(name)));
  return matchBranches(names.filter((_, i) => shas[i] !== undefined));
}

/** The environment `name` suggests by its name (`dev`, `staging`, …), or none. */
export function branchRoleOf(name: string): Exclude<BranchRole, "prod"> | undefined {
  if ((ENVIRONMENT_BRANCHES.dev as readonly string[]).includes(name)) return "dev";
  if ((ENVIRONMENT_BRANCHES.staging as readonly string[]).includes(name)) return "staging";
  return undefined;
}

/**
 * Branch names OpsCrew writes into the deploy workflow: letters, digits, `.`, `_`, `/` and `-`,
 * never a GitHub Actions expression.
 */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/** True when the plan is deployed on each push to its `cicd.branch` (not promoted). */
export function followsBranch(plan: Pick<DeployPlan, "environment">): boolean {
  return plan.environment?.deploySource.from !== "promote";
}

/**
 * The branch an environment's files and deploy workflow live on, and its deploy runs run on: the
 * branch it follows (`cicd.branch`), or for a promoted environment the repository's
 * `defaultBranch`, where `opscrew promote` starts its workflow. A promoted plan's `cicd.branch` is
 * only kept for when it follows a branch again.
 */
export function workflowBranch(
  plan: Pick<DeployPlan, "cicd" | "environment">,
  defaultBranch: string,
): string {
  return followsBranch(plan) ? plan.cicd.branch : defaultBranch;
}

/**
 * The repository's default branch as analysis read it, the branch design gives prod and every new
 * environment: `origin`'s HEAD, else the checked-out branch, else `main`.
 */
export function defaultBranchOf(facts: Pick<ProjectFacts, "git">): string {
  return facts.git.defaultBranch ?? facts.git.currentBranch ?? "main";
}

/**
 * Refuses `branch` for the environment `paths` belong to when another environment of the app
 * follows it (its plan is deployed on each push to its own `cicd.branch`), since each push to it
 * would then build and deploy both. The repository's default branch ({@link defaultBranchOf} of
 * the analysis, `main` without one) is exempt: a new environment follows it unless told
 * otherwise, and promotion first has two environments follow it for a while.
 * @throws OpsCrewError `INVALID_INPUT` naming both environments.
 */
export async function requireBranchFree(paths: ProjectPaths, branch: string): Promise<void> {
  const analysis = await readOptionalArtifact("architecture", paths.files.architecture);
  if (branch === defaultBranchOf(analysis?.facts ?? { git: {} })) return;
  const name = paths.environment;
  for (const other of await environmentsOf(paths.root, paths.app)) {
    if (other === name) continue;
    const plan = await readArtifact("plan", environmentPaths(paths, other).files.plan);
    if (followsBranch(plan) && plan.cicd.branch === branch) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The ${other} environment already follows ${branch}, so the ${name} environment cannot follow it too: each push to ${branch} would then build and deploy both.`,
        {
          hint: `Name another branch for ${name}, or promote one of them from the other (\`opscrew env set ${name} --from ${other}\`).`,
        },
      );
    }
  }
}

/**
 * `--branch <name>` for the environment `paths` belong to: a branch the repository has on GitHub,
 * which no other environment of the app follows ({@link requireBranchFree}). Returns the branch,
 * trimmed.
 * @throws OpsCrewError `INVALID_INPUT` naming the branch, and the other environment when it
 * already follows it; `COMMAND_FAILED` when git cannot reach the remote.
 */
export async function requireBranch(
  paths: ProjectPaths,
  git: GitClient,
  requested: string,
): Promise<string> {
  const branch = requested.trim();
  const name = paths.environment;
  if (!BRANCH_NAME.test(branch) || branch.startsWith("-")) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${JSON.stringify(requested)} is not a branch name OpsCrew can deploy the ${name} environment from.`,
      { hint: "Name a branch of letters, digits, `.`, `_`, `/` and `-`, for example develop." },
    );
  }
  await requireBranchFree(paths, branch);
  if ((await git.remoteBranchSha(branch)) === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The repository on GitHub has no branch ${branch}, so no push to it could deploy the ${name} environment.`,
      { hint: `Push the branch first (\`git push -u origin ${branch}\`), or name one it has.` },
    );
  }
  return branch;
}

/**
 * The branch whose pushes build the images the promoted environment of `plan` (the one `paths`
 * belong to) is promoted with: the `cicd.branch` of the first environment along its sources that
 * follows a branch ({@link builderCicd}). `undefined` when `plan` follows a branch itself.
 * @throws OpsCrewError `PHASE_PRECONDITION` as {@link builderCicd} does.
 */
export async function builderBranch(
  paths: ProjectPaths,
  plan: DeployPlan,
): Promise<string | undefined> {
  return (await builderCicd(paths, plan))?.branch;
}

/**
 * The branch and workflow of the environment that builds what the promoted environment of `plan`
 * (the one `paths` belong to) is promoted with: the `cicd.branch` and `cicd.workflowPath` of the
 * first environment along its sources that follows a branch. `undefined` when `plan` follows a
 * branch itself.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the sources when one of them has no plan, or
 * they lead back to an environment already on the way.
 */
export async function builderCicd(
  paths: ProjectPaths,
  plan: DeployPlan,
): Promise<Pick<DeployPlan["cicd"], "branch" | "workflowPath"> | undefined> {
  const chain = [paths.environment];
  let current = plan;
  for (;;) {
    const source = current.environment?.deploySource;
    if (source?.from !== "promote") {
      if (chain.length === 1) return undefined;
      return { branch: current.cicd.branch, workflowPath: current.cicd.workflowPath };
    }
    const name = source.source;
    const looped = chain.includes(name);
    chain.push(name);
    const next = looped
      ? undefined
      : await readOptionalArtifact("plan", environmentPaths(paths, name).files.plan);
    if (next === undefined) {
      const path = chain.join(" ← ");
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `No environment builds the images of the ${paths.environment} environment: it is promoted along ${path}, and ${looped ? `${name} comes round again` : `${name} has no plan`}. Nothing was changed.`,
        {
          hint: `Have one of them built from its branch, for example \`opscrew env set ${chain[1]} --from main\`.`,
        },
      );
    }
    current = next;
  }
}
