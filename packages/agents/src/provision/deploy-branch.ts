import type { GitClient } from "@opscrew/connector-github";
import { DEPLOY_COMPOSE_FILE, type DeployBranch } from "@opscrew/connector-portainer";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { renderPlaceholderStack } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { deployBranchOf } from "../shared";
import type { GitHubSetup } from "./credentials";
import type { ProvisionPhase } from "./steps";

/** True when GitHub has the deploy branch (read through git, which reaches the repository). */
async function deployBranchExists(git: GitClient, branch: DeployBranch): Promise<boolean> {
  try {
    return (await git.remoteBranchSha(branch)) !== undefined;
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `OpsCrew could not check GitHub for the ${branch} branch, which Portainer deploys the app from. Nothing in Portainer was changed.`,
      {
        hint: "Check that this computer can reach GitHub (`git ls-remote origin`), then try again.",
      },
    );
  }
}

/**
 * Where the deploy branch stands: `absent`, holding exactly the placeholder (`placeholder`: one
 * commit without parents and only its file, read through the GitHub client), or holding anything
 * else (`other`).
 */
export async function deployBranchState(
  git: GitClient,
  github: GitHubSetup,
  plan: DeployPlan,
): Promise<"absent" | "placeholder" | "other"> {
  const branch = deployBranchOf(plan);
  if (!(await deployBranchExists(git, branch))) return "absent";
  const placeholder = renderPlaceholderStack(plan);
  const only = await github.api.branchHoldsOnly(github.owner, github.repo, branch, {
    path: placeholder.path,
    content: placeholder.content,
  });
  return only ? "placeholder" : "other";
}

/**
 * Starts the deploy branch with the placeholder stack file before the app's stack is created
 * (research R11): Portainer deploys a Git stack as soon as it is created, before the first image
 * exists. A missing branch is created; one that exists already (left by an earlier deployment,
 * perhaps of another setup, whose stack file Portainer would otherwise deploy as it is) is pointed
 * at a new commit holding only the placeholder (the ref is force-updated; its earlier commits leave
 * the branch). Either way behind its own `git-push` approval, and only for the plan's deploy branch
 * (`opscrew-deploy`, or `opscrew-deploy-<env>` in another environment).
 */
export async function startDeployBranch(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: DeployPlan;
    phase: ProvisionPhase;
    /** The Cloudflare plan was applied in this run (said when the user refuses). */
    cloudflareApplied: boolean;
  },
): Promise<void> {
  const { github, plan } = input;
  const { api } = github;
  const branch = deployBranchOf(plan);
  const state = await deployBranchState(input.git, github, plan);
  if (state === "placeholder") {
    // An earlier run of this setup already started it (for example its stack-apply was refused).
    deps.reporter.info(
      `The branch ${branch} already holds only the placeholder ${DEPLOY_COMPOSE_FILE}; it stays as it is.`,
    );
    return;
  }
  const replace = state === "other";
  const placeholder = renderPlaceholderStack(plan);
  const repo = `${github.owner}/${github.repo}`;
  const nothingYet = input.cloudflareApplied
    ? "The Cloudflare changes are applied; nothing in Portainer was changed."
    : "Nothing in Portainer was changed.";
  const approval = await deps.approvals.request({
    kind: "git-push",
    title: replace
      ? `Replace the branch ${branch} in ${repo} with a placeholder ${DEPLOY_COMPOSE_FILE}`
      : `Create the branch ${branch} in ${repo} with a placeholder ${DEPLOY_COMPOSE_FILE}`,
    details: [
      replace
        ? `Portainer builds the app's stack from the ${branch} branch, which still holds the stack file of an earlier deployment (perhaps of another setup), and the stack is created anew. So that Portainer does not start that file, OpsCrew points the branch at a new commit holding only this placeholder (its earlier commits leave the branch), which runs one small container that only sleeps (no ports, no secrets) until the deploy workflow's next run writes the app:`
        : `Portainer builds the app's stack from the ${branch} branch. Until the deploy workflow's first run writes the app there, the branch holds only this placeholder, which runs one small container that only sleeps (no ports, no secrets):`,
      "",
      placeholder.content,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      replace
        ? `The ${branch} branch was not replaced, so OpsCrew does not create the app's stack in Portainer from its earlier file. ${nothingYet}`
        : `The ${branch} branch was not created, so OpsCrew cannot create the app's stack in Portainer. ${nothingYet}`,
      { hint: `Run \`opscrew ${input.phase}\` again when you are ready; it continues from here.` },
    );
  }
  const change: Parameters<GitHubSetup["api"]["createOrphanBranch"]>[0] = {
    owner: github.owner,
    repo: github.repo,
    branch,
    path: placeholder.path,
    content: placeholder.content,
    message: "OpsCrew: placeholder until the first deploy",
  };
  let detail: string;
  if (replace) {
    const replaced = await api.replaceOrphanBranch(change);
    detail = `placeholder ${replaced.commit}, replacing ${replaced.previous}`;
  } else {
    detail = `placeholder ${(await api.createOrphanBranch(change)).commit}`;
  }
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "push",
    phase: input.phase,
    target: `${repo}:${branch}`,
    decision: "approved",
    detail,
  });
  deps.reporter.success(
    replace
      ? `Replaced the branch ${branch} with a placeholder ${DEPLOY_COMPOSE_FILE}; the deploy workflow's next run writes the app there.`
      : `Created the branch ${branch} with a placeholder ${DEPLOY_COMPOSE_FILE}.`,
  );
}
