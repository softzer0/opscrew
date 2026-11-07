import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { type GitHubClient, githubConnector } from "@opscrew/connector-github";
import { listText, OpsCrewError, type ProjectPaths, upperFirst } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type DriftReport, runDrift } from "../drift";
import { missing } from "../provision/credentials";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import { pinnedText, readableDeployPause } from "../shared/deploy-pause";
import type { PromoteGitHubApi, PromoteServices } from "./types";

/** What every refusal of a promotion ends with. */
export const NOTHING = "Nothing was deployed.";

/** What every refusal of a rollback ends with. */
export const NOTHING_CHANGED = "Nothing was changed.";

/**
 * What a shared check refuses for, which its refusals name: `opscrew promote` (a promotion, the
 * default) or `opscrew rollback` (a rollback, whose refusals end {@link NOTHING_CHANGED}).
 */
export type CheckedFor = "promotion" | "rollback";

/**
 * What a refusal for `what` ends with: a promotion's {@link NOTHING}, a rollback's
 * {@link NOTHING_CHANGED}.
 */
export function nothingChanged(what: CheckedFor): string {
  return what === "rollback" ? NOTHING_CHANGED : NOTHING;
}

/** How many pending changes a refusal names before it says how many more there are. */
const LISTED = 5;

/**
 * The GitHub repository a promotion deploys from, with the API (`Api`, promote's calls by
 * default) and its default branch.
 */
export interface PromoteRepository<Api extends PromoteGitHubApi = PromoteGitHubApi> {
  api: Api;
  owner: string;
  repo: string;
  defaultBranch: string;
}

/**
 * The GitHub repository the promotion deploys from, with its default branch, and the API
 * `services.github` gives (a test fake), else a `GitHubClient` with the user's token.
 */
export async function githubRepository<Api extends PromoteGitHubApi>(
  deps: PhaseDeps,
  services: { github?: Api | null },
): Promise<PromoteRepository<Api | GitHubClient>> {
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  const api = services.github === undefined ? await githubClientFromToken(deps) : services.github;
  if (!api) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  const { defaultBranch } = await api.getRepo(owner, repo);
  return { api, owner, repo, defaultBranch };
}

/**
 * The refusal while a move's maintenance window, since `since`, pauses the deploys of `target`:
 * `why` says what that would do to this promotion or rollback; `flags` are the target's in
 * `opscrew provision`'s command.
 */
export function movePaused(input: {
  target: string;
  since: string;
  why: string;
  flags: string;
  command: string;
  what: CheckedFor;
}): OpsCrewError {
  const { target, since, flags, command, what } = input;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The deploys of ${target} are paused since ${since} while a service moves between the app's servers, ${input.why}. ${nothingChanged(what)}`,
    {
      hint: `Run \`opscrew provision${flags}\`: it ends the move's maintenance window. Then run \`${command}\` again.`,
    },
  );
}

/**
 * Every difference the target's check found that `opscrew provision` would apply: the
 * infrastructure plan's changes, the generated files that differ from the plan or are missing, the
 * server's differences provision puts back, OpsCrew's Cloudflare rules and the Portainer stack plan.
 * Not the Portainer deploy branch: the deploy workflow itself writes it again.
 */
function pendingChanges(report: DriftReport): string[] {
  return [
    ...report.pending.map((change) => `${change.address} (${change.action})`),
    ...report.files.changed.map((file) => `${file} (generated file changed)`),
    ...report.files.created.map((file) => `${file} (generated file missing)`),
    ...(report.host?.differences ?? [])
      .filter((difference) => difference.restoredByProvision)
      .map((difference) => `${difference.title} (on the server)`),
    ...(report.cloudflareRules ?? []).map((difference) => difference.title),
    ...(report.portainer?.differences ?? [])
      .filter((difference) => difference.area !== "deploy-branch")
      .map((difference) => difference.title),
  ];
}

/** At most {@link LISTED} items, then how many more. */
function shortList(items: readonly string[]): string {
  const more = items.length - LISTED;
  return more > 0 ? `${items.slice(0, LISTED).join(", ")} and ${more} more` : listText(items);
}

/** The git blob SHA-1 of a file's text, as GitHub's contents API names it. */
export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** What {@link requireWorkflowApplied} checks, and the words of its refusals. */
interface WorkflowCheck {
  target: string;
  plan: DeployPlan;
  github: PromoteRepository;
  command: string;
  /** The branch the workflow is started on. */
  branch: string;
  /**
   * The workflow the plan generates (its text), as provision renders it; without it, the
   * repository's copy, which only drift can tell is the plan's.
   */
  workflow?: string;
  what?: CheckedFor;
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing deployed) unless the target environment `target` (its plan
 * and paths) has nothing `opscrew provision` would apply (read-only drift) and the deploy workflow
 * on `branch` (promote's: the default branch) is the one its plan generates
 * ({@link requireWorkflowApplied}), so the approval names what will run. On a server, drift
 * compares the generated files, so the repository's copy is the one the plan generates; a site's
 * drift compares none, so its caller passes `workflow`, the workflow rendered from the plan. The
 * refusals name `what` the caller checks for (default a promotion) and its `command`. Returns
 * the workflow's file name, which the caller starts.
 */
export async function requireApplied(
  deps: PhaseDeps,
  input: WorkflowCheck & { paths: ProjectPaths; services: PromoteServices },
): Promise<string> {
  const { target, command } = input;
  const what = input.what ?? "promotion";
  deps.reporter.step(`Checking ${target} for changes not applied yet (read-only)`);
  const report = await (input.services.drift ?? runDrift)({ ...deps, paths: input.paths });
  const pending = pendingChanges(report);
  if (pending.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment has changes that are not applied yet: ${shortList(pending)}. ${what === "rollback" ? "OpsCrew rolls back only an environment" : "OpsCrew promotes only to an environment"} whose plan is applied, so the approval names what will run. ${nothingChanged(what)}`,
      { hint: `Run \`opscrew provision --env ${target}\` first, then \`${command}\` again.` },
    );
  }
  return requireWorkflowApplied(deps, input);
}

/**
 * The workflow half of {@link requireApplied}, without drift (this computer's local runner, where
 * drift counts a broken app's stopped containers as pending): stops (`PHASE_PRECONDITION`) unless
 * the deploy workflow on `branch` is the one the plan generates, by git blob hash. Returns the
 * workflow's file name.
 */
export async function requireWorkflowApplied(
  deps: PhaseDeps,
  input: WorkflowCheck,
): Promise<string> {
  const { target, plan, github, command, branch } = input;
  const what = input.what ?? "promotion";
  const nothing = nothingChanged(what);
  const { workflowPath } = plan.cicd;
  const where =
    branch === github.defaultBranch ? `the default branch ${branch}` : `the branch ${branch}`;
  // A site's, rendered from its plan; a server's, the repository's copy, which drift found equal
  // to the rendered one. Its blob is with LF line endings, as provision writes and commits it.
  const rendered = (
    input.workflow ?? (await readFile(join(deps.paths.root, workflowPath), "utf8"))
  ).replace(/\r\n/g, "\n");
  const onBranch = await github.api.fileSha(github.owner, github.repo, workflowPath, branch);
  if (onBranch !== gitBlobSha(rendered)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      onBranch === undefined
        ? `${upperFirst(where)} has no ${workflowPath}, the deploy workflow ${target}'s plan generates, so GitHub cannot start it. ${nothing}`
        : `The deploy workflow on ${where} (${workflowPath}) is not the one ${target}'s plan generates, so its run would not do what this ${what} shows. ${nothing}`,
      {
        hint:
          input.workflow !== undefined && onBranch !== undefined
            ? `Run \`opscrew provision --env ${target}\`: its pull request brings the workflow up to date with the plan. Merge it, then run \`${command}\` again.`
            : `Merge the deploy-setup pull request \`opscrew provision --env ${target}\` opened (or run it, if none is open), then run \`${command}\` again.`,
      },
    );
  }
  return posix.basename(workflowPath);
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing deployed) while the target's deploys are paused, by a
 * rollback or a move's window: the promotion's deploy run would skip its deploy job, and the
 * promotion would be recorded without ever running. A token that may not read the variable
 * counts as not paused ({@link readableDeployPause}), so promote needs no new permission.
 */
export async function requireNotPaused(
  github: PromoteRepository,
  plan: DeployPlan,
  target: string,
  command: string,
): Promise<void> {
  const pause = await readableDeployPause(github, plan);
  if (pause === undefined) return;
  const skipped = "so a promotion's deploy run would skip its deploy job";
  if (pause.reason === "rollback") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The deploys of ${target} are paused since ${pause.since}: ${pinnedText(pause)}, ${skipped}. ${NOTHING}`,
      { hint: `Run \`opscrew rollback --env ${target} --resume\`, then \`${command}\` again.` },
    );
  }
  throw movePaused({
    target,
    since: pause.since,
    why: skipped,
    flags: ` --env ${target}`,
    command,
    what: "promotion",
  });
}
