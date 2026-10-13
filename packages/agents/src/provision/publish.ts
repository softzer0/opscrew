import type { GitClient, PullRequest } from "@opscrew/connector-github";
import type { PhaseName } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import type { GitHubSetup } from "./credentials";

/** Branch holding the generated deployment files. */
export const DEPLOY_SETUP_BRANCH = "opscrew/deploy-setup";

export interface PublishResult {
  branch: string;
  commit?: string;
  prUrl?: string;
  pushed: boolean;
}

/**
 * Pull request body for the generated deployment files. `secretsStored` (default true) says
 * whether the GitHub Actions deploy secrets are known to be stored for this server; when they are
 * not, the body tells the user to run `opscrew provision` in a terminal before merging.
 */
export function deploySetupPullRequestBody(
  plan: DeployPlan,
  version: string,
  options: { secretsStored?: boolean } = {},
): string {
  const profile = providerProfile(planProvider(plan));
  const host = plan.dns.domain ?? plan.deployment.serverIpv4 ?? `the new ${profile.serverNoun}`;
  const nextStep =
    options.secretsStored === false
      ? [
          "The server is already running, but OpsCrew has no record of storing the deploy secrets in GitHub Actions for it, so a deploy would fail.",
          `**Before merging, run \`opscrew provision\` in a terminal in the project directory.** It finds no infrastructure changes, asks for the production environment values and stores the secrets. After that, merging this pull request deploys the app to ${host}. When the first deploy finishes, run \`opscrew verify\`.`,
        ]
      : [
          `The server is already running and the deploy secrets are stored in GitHub Actions. **Merging this pull request deploys the app to ${host}.** After the first deploy finishes, run \`opscrew verify\`.`,
        ];
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`opscrew/plan.yaml\` for **${plan.app.name}**:`,
    "",
    `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: infrastructure code for the ${profile.displayName} ${profile.serverNoun}${plan.dns.provider === "cloudflare" ? " and the Cloudflare DNS records" : ""} (works with OpenTofu and Terraform).`,
    "- `opscrew/runtime/`: Docker Compose and Caddy configuration for the server.",
    `- \`${plan.cicd.workflowPath}\`: builds the image, pushes it to GitHub Container Registry and deploys it on every push to \`${plan.cicd.branch}\`, rolling back when the health check fails.`,
    "- `opscrew/plan.yaml`: the plan with the server's addresses.",
    "",
    ...nextStep,
    "",
    "Review checklist:",
    "- [ ] The workflow only uses pinned, first-party actions.",
    "- [ ] The firewall rules in the infrastructure code match what you expect.",
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}

/** The branch the deployment files go on, and the open pull request from it that a run adds to. */
export interface DeployBranch {
  branch: string;
  pullRequest?: PullRequest;
}

/** Phases that publish the deployment files. */
export type PublishPhase = Extract<PhaseName, "provision" | "dns" | "retarget">;

/** {@link DEPLOY_SETUP_BRANCH}, then `-2`, `-3`, … */
function deployBranchName(i: number): string {
  return i === 1 ? DEPLOY_SETUP_BRANCH : `${DEPLOY_SETUP_BRANCH}-${i}`;
}

/** What to do when the final files of a finished move were not published. */
const PUBLISH_BY_HAND =
  "commit the changed files under opscrew/ on a new branch and open a pull request yourself, so the repository describes the deployment.";

/**
 * A branch-check stop. Before a provision (or dns) run nothing has changed yet, and the user runs
 * the command again; at the end of a finished retarget only the final files were not published,
 * and the user publishes them by hand.
 */
function branchStop(
  phase: PublishPhase,
  reason: string,
  hints: { rerun: string; retarget: string },
): OpsCrewError {
  if (phase === "retarget") {
    return new OpsCrewError(
      "PHASE_PRECONDITION",
      `The final files were not published; ${reason}.`,
      {
        hint: hints.retarget,
      },
    );
  }
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${reason.charAt(0).toUpperCase()}${reason.slice(1)}, so OpsCrew did not change anything.`,
    { hint: hints.rerun },
  );
}

/**
 * The branch for the deployment files chosen without reaching GitHub: the first of
 * {@link DEPLOY_SETUP_BRANCH}, `-2`, … that is the current branch or does not exist in this clone,
 * so a stale local branch (its pull request merged long ago) is never committed on.
 */
export async function localDeployBranch(git: GitClient): Promise<string> {
  const current = await git.currentBranch();
  for (let i = 1; i <= 100; i++) {
    const branch = deployBranchName(i);
    if (branch === current || !(await git.branchExists(branch))) return branch;
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `There are already 100 ${DEPLOY_SETUP_BRANCH} branches in this clone, so OpsCrew did not create another one.`,
    {
      hint: `Delete the old ones with \`git branch -D ${DEPLOY_SETUP_BRANCH}-<n>\`, then try again.`,
    },
  );
}

/**
 * Picks the branch for the deployment files before anything changes, so the push never collides
 * with a branch an earlier run left on GitHub: {@link DEPLOY_SETUP_BRANCH}, or the next free
 * `-2`, `-3`, …. A branch on GitHub whose pull request is merged or closed is skipped (never
 * pushed to), and so is a branch only this clone has unless it is the current branch (a stale
 * local branch is never committed on). One with an open pull request is added to when this clone
 * is on that branch and the push is a fast-forward (its head is in this clone's branch, so OpsCrew
 * pushed it from here); otherwise this throws `PHASE_PRECONDITION` naming the pull request, and
 * nothing is force-pushed. When GitHub cannot be reached through git, it warns and picks the branch
 * from this clone alone ({@link localDeployBranch}). `phase` (default `provision`) words a stop for
 * the command that publishes: a finished retarget says the final files were not published.
 */
export async function chooseDeployBranch(
  deps: PhaseDeps,
  git: GitClient,
  github: GitHubSetup,
  phase: PublishPhase = "provision",
): Promise<DeployBranch> {
  const command = `opscrew ${phase}`;
  const current = await git.currentBranch();
  for (let i = 1; i <= 100; i++) {
    const branch = deployBranchName(i);
    let sha: string | undefined;
    try {
      sha = await git.remoteBranchSha(branch);
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      const local = await localDeployBranch(git);
      deps.reporter.warn(
        deps.redactor.redact(
          `OpsCrew could not check GitHub for a branch left by an earlier run (${error.message}). It continues with ${local}.`,
        ),
      );
      return { branch: local };
    }
    if (sha === undefined) {
      if (branch !== current && (await git.branchExists(branch))) {
        deps.reporter.info(
          `${branch} is only in this clone, from an earlier run, and you are not on it, so OpsCrew leaves it alone.`,
        );
        continue;
      }
      return { branch };
    }
    const open = await github.api.findOpenPullRequest(github.owner, github.repo, branch);
    if (open === undefined) {
      deps.reporter.info(
        `${branch} is already on GitHub from an earlier run, and no pull request from it is open, so OpsCrew leaves it alone.`,
      );
      continue;
    }
    if ((await git.branchExists(branch)) && (await git.isAncestor(sha, branch))) {
      if (current === branch) {
        deps.reporter.info(`Adding to the open pull request ${open.url} (branch ${branch}).`);
        return { branch, pullRequest: open };
      }
      throw branchStop(
        phase,
        `the pull request ${open.url} from an earlier OpsCrew run is still open and the files belong on its branch ${branch}, but this clone is on ${current}`,
        {
          rerun: `Run \`git checkout ${branch}\`, then run \`${command}\` again. To start a new pull request instead, merge or close ${open.url} first.`,
          retarget: `Add them to ${open.url} by committing the changed files under opscrew/ on ${branch} and pushing it, or merge or close that pull request, then ${PUBLISH_BY_HAND}`,
        },
      );
    }
    throw branchStop(
      phase,
      `the pull request ${open.url} from an earlier OpsCrew run is still open, and its branch ${branch} has commits this clone does not have`,
      {
        rerun: `Merge or close it on GitHub, then run \`${command}\` again. To add to it instead, bring its commits here first (\`git fetch origin ${branch}\`, \`git checkout ${branch}\`, \`git pull\`).`,
        retarget: `Merge or close it on GitHub, then ${PUBLISH_BY_HAND}`,
      },
    );
  }
  throw branchStop(phase, `there are already 100 ${DEPLOY_SETUP_BRANCH} branches on GitHub`, {
    rerun: "Delete the old ones on GitHub, then try again.",
    retarget: `Delete the old ones on GitHub, then ${PUBLISH_BY_HAND}`,
  });
}

/**
 * Commits the generated files and the plan on the deploy branch (`input.branch`, chosen with
 * {@link chooseDeployBranch} before anything changed; when absent it is chosen here, or with
 * {@link localDeployBranch} without a push), then (when `push`) pushes it and opens a pull request
 * into the deploy branch, each after its own approval. A refused push or pull request is not an
 * error: the commit stays local and the user is told how to continue.
 */
export async function publishDeploySetup(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: DeployPlan;
    paths: readonly string[];
    push: boolean;
    /** Whether the deploy secrets are known to be stored for this server (default true). */
    secretsStored?: boolean;
    /** Phase recorded in the audit log and named in branch-check stops (default `provision`). */
    phase?: PublishPhase;
    /** The branch from {@link chooseDeployBranch}, when the caller chose it up front. */
    branch?: DeployBranch;
  },
): Promise<PublishResult> {
  const { git, github, plan } = input;
  const phase = input.phase ?? "provision";
  const body = deploySetupPullRequestBody(plan, deps.version, {
    secretsStored: input.secretsStored !== false,
  });
  const chosen =
    input.branch ??
    (input.push
      ? await chooseDeployBranch(deps, git, github, phase)
      : { branch: await localDeployBranch(git) });
  const branch = chosen.branch;
  if ((await git.currentBranch()) !== branch) {
    if (await git.branchExists(branch)) await git.checkout(branch);
    else await git.createBranch(branch);
  }
  await git.add(input.paths);
  const staged = (await git.status()).some((e) => e.code[0] !== " " && e.code[0] !== "?");
  let commit: string | undefined;
  if (staged) {
    commit = await git.commit(
      `chore(opscrew): deployment infrastructure for ${plan.app.name}\n\nGenerated by OpsCrew ${deps.version} from opscrew/plan.yaml.`,
    );
    await deps.audit.append({
      kind: "git",
      actor: "opscrew",
      action: "commit",
      phase,
      target: branch,
      detail: commit,
    });
    deps.reporter.success(`Committed the deployment files on branch ${branch}.`);
  }
  const result: PublishResult = { branch, pushed: false, ...(commit ? { commit } : {}) };
  if (!input.push) {
    deps.reporter.info(
      `The files are committed on ${branch}. Push it and open a pull request into ${plan.cicd.branch} when you are ready.`,
    );
    return result;
  }

  const repo = `${github.owner}/${github.repo}`;
  const push = await deps.approvals.request({
    kind: "git-push",
    title: `Push branch ${branch} to ${repo}`,
    details: `Files:\n${input.paths.map((p) => `  ${p}`).join("\n")}`,
  });
  if (!push.approved) {
    deps.reporter.warn(
      `Not pushed. The commit stays on the local branch ${branch}; push it yourself and open a pull request into ${plan.cicd.branch}.`,
    );
    return result;
  }
  await git.push(branch, { setUpstream: true });
  result.pushed = true;
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "push",
    phase,
    target: `${repo}:${branch}`,
    decision: "approved",
  });

  const existing =
    chosen.pullRequest ?? (await github.api.findOpenPullRequest(github.owner, github.repo, branch));
  if (existing) {
    deps.reporter.info(`The pull request is already open: ${existing.url}`);
    result.prUrl = existing.url;
    return result;
  }
  const title = `OpsCrew: deployment infrastructure for ${plan.app.name}`;
  const pr = await deps.approvals.request({
    kind: "pull-request",
    title: `Open the pull request "${title}" into ${plan.cicd.branch}`,
    details: body,
  });
  if (!pr.approved) {
    deps.reporter.warn(
      `No pull request opened. Open one from ${branch} into ${plan.cicd.branch} when you are ready.`,
    );
    return result;
  }
  const opened = await github.api.createPullRequest({
    owner: github.owner,
    repo: github.repo,
    head: branch,
    base: plan.cicd.branch,
    title,
    body,
  });
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "pull-request",
    phase,
    target: opened.url,
    decision: "approved",
  });
  deps.reporter.success(`Opened ${opened.url}`);
  result.prUrl = opened.url;
  return result;
}
