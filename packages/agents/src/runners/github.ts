/**
 * What the self-hosted runners need from GitHub (contracts/runners.md "GitHub connector"): the
 * repository, its visibility and fork-PR approval policy, runner tokens and registrations. The
 * policy is changed only after a `github-settings` approval.
 */
import type { ForkPrApprovalPolicy, GitHubClient } from "@opscrew/connector-github";
import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { runnerLabel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";

/** The GitHub calls the runners make (the GitHub connector's client, or a fake in tests). */
export type RunnerGitHubApi = Pick<
  GitHubClient,
  | "runnerRegistrationToken"
  | "runnerRemoveToken"
  | "listRunners"
  | "deleteRunner"
  | "repositoryVisibility"
  | "forkPrApprovalPolicy"
  | "setForkPrApprovalPolicy"
>;

/** The project's GitHub repository (the `origin` remote) and the client that reaches it. */
export interface RunnerRepository {
  api: RunnerGitHubApi;
  owner: string;
  repo: string;
}

/** The policy under which every outside contributor's workflow runs need an approval. */
export const SAFE_FORK_PR_POLICY = "all_external_contributors" satisfies ForkPrApprovalPolicy;

/**
 * The `github-settings` change a public repository needs before a self-hosted runner may serve it:
 * every outside contributor's workflow runs then wait for an approval.
 */
export interface GithubSettingsChange {
  /** `<owner>/<repo>`. */
  repository: string;
  forkPrApproval: { from: ForkPrApprovalPolicy; to: typeof SAFE_FORK_PR_POLICY };
}

/**
 * The project's repository with `api`, or the client of the user's GitHub token (registered with
 * the redactor).
 * @throws OpsCrewError `PHASE_PRECONDITION` without a GitHub remote or a token.
 */
export async function runnerRepository(
  deps: PhaseDeps,
  api?: RunnerGitHubApi,
): Promise<RunnerRepository> {
  const coordinates = await githubCoordinates(gitClient(deps));
  const client = api ?? (await githubClientFromToken(deps));
  if (client === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A self-hosted runner needs GitHub's runner API, and no GitHub token was found.",
      {
        hint: "Set GITHUB_TOKEN (or log in with `gh auth login`) with Administration (Read and write) on the repository, then run the command again.",
      },
    );
  }
  return { api: client, ...coordinates };
}

/**
 * {@link runnerRepository}, read once and only when first needed (a runner's token or
 * registration), so a run that needs neither never asks for a GitHub token; `known` when given.
 */
export function lazyRepository(
  deps: PhaseDeps,
  api?: RunnerGitHubApi,
  known?: RunnerRepository,
): () => Promise<RunnerRepository> {
  let repository: Promise<RunnerRepository> | undefined;
  return () => {
    repository ??= known !== undefined ? Promise.resolve(known) : runnerRepository(deps, api);
    return repository;
  };
}

/** `https://github.com/<owner>/<repo>`, which a runner registers with. */
export function repositoryUrl(repository: Pick<RunnerRepository, "owner" | "repo">): string {
  return `https://github.com/${repository.owner}/${repository.repo}`;
}

/**
 * Whether a self-hosted runner may serve the repository (FR-1527): a private or internal one
 * always; a public one only when every outside contributor's workflow runs need an approval.
 * Otherwise `settings` is the change that allows it, and `refusal` says why OpsCrew refuses
 * without it (GitHub's own warning).
 */
export async function checkRunnerRepository(
  repository: RunnerRepository,
): Promise<{ settings?: GithubSettingsChange; refusal?: string }> {
  const { api, owner, repo } = repository;
  if ((await api.repositoryVisibility(owner, repo)) !== "public") return {};
  const policy = await api.forkPrApprovalPolicy(owner, repo);
  if (policy === SAFE_FORK_PR_POLICY) return {};
  return {
    settings: {
      repository: `${owner}/${repo}`,
      forkPrApproval: { from: policy, to: SAFE_FORK_PR_POLICY },
    },
    refusal: `${owner}/${repo} is public, and GitHub says self-hosted runners should almost never serve a public repository: a pull request from a fork could run its own code on the runner's machine. OpsCrew uses one there only when every outside contributor's workflow runs need your approval first, which is not set (the repository's approval policy is ${policy}).`,
  };
}

/**
 * Applies `settings` after its `github-settings` approval (audited); declined, it stops with
 * `refusal` and nothing changed. With `planOnly` it only says that the change is asked for first.
 */
export async function applyRunnerSettings(
  deps: PhaseDeps,
  repository: RunnerRepository,
  check: { settings: GithubSettingsChange; refusal: string },
  /** `phase`: the phase the audit names (none for the local runner, which is no phase). */
  run: { phase?: PhaseName; command: string; planOnly?: boolean },
): Promise<void> {
  const { settings, refusal } = check;
  const what = `require your approval for every outside contributor's workflow runs in ${settings.repository}`;
  if (run.planOnly === true) {
    deps.reporter.info(
      `${refusal} Applying this plan first asks to ${what}; a plan-only run changes nothing at GitHub.`,
    );
    return;
  }
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title: `Require approval for outside contributors' workflow runs in ${settings.repository}`,
    details: [
      refusal,
      `OpsCrew sets the repository's approval policy for fork pull requests from ${settings.forkPrApproval.from} to ${settings.forkPrApproval.to}, so the self-hosted runner never runs an outside contributor's workflow before you approve it.`,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError("APPROVAL_REFUSED", `${refusal} Nothing was changed.`, {
      hint: `Make the repository private, set environment.runner to github in the plan, or run \`${run.command}\` again and approve the change to ${what}.`,
    });
  }
  const { api, owner, repo } = repository;
  await api.setForkPrApprovalPolicy(owner, repo, settings.forkPrApproval.to);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `set the fork pull request approval policy to ${settings.forkPrApproval.to}`,
    ...(run.phase !== undefined ? { phase: run.phase } : {}),
    target: settings.repository,
    decision: "approved",
  });
}

/**
 * Deletes the environment's runner registrations through GitHub's API (those with its label,
 * `opscrew-<app>-<env>`, and with `name`, only that one); audited. Returns how many it deleted.
 */
export async function deleteRegistrations(
  deps: Pick<PhaseDeps, "audit">,
  repository: RunnerRepository,
  plan: DeployPlan,
  run: { phase?: PhaseName; name?: string },
): Promise<number> {
  const { api, owner, repo } = repository;
  const label = runnerLabel(plan);
  const registered = (await api.listRunners(owner, repo)).filter(
    (runner) =>
      runner.labels.includes(label) && (run.name === undefined || runner.name === run.name),
  );
  for (const runner of registered) {
    await api.deleteRunner(owner, repo, runner.id);
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `delete the self-hosted runner ${runner.name}`,
      ...(run.phase !== undefined ? { phase: run.phase } : {}),
      target: `${owner}/${repo}`,
      decision: "approved",
    });
  }
  return registered.length;
}
