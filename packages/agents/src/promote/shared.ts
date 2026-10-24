import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { githubConnector } from "@opscrew/connector-github";
import { listText, OpsCrewError, type ProjectPaths } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type DriftReport, runDrift } from "../drift";
import { missing } from "../provision/credentials";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import type { PromoteGitHubApi, PromoteServices } from "./types";

/** What every refusal of a promotion ends with. */
export const NOTHING = "Nothing was deployed.";

/** How many pending changes a refusal names before it says how many more there are. */
const LISTED = 5;

/** The GitHub repository a promotion deploys from, with the API and its default branch. */
export interface PromoteRepository {
  api: PromoteGitHubApi;
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** The GitHub repository the promotion deploys from, with the API and its default branch. */
export async function githubRepository(
  deps: PhaseDeps,
  services: PromoteServices,
): Promise<PromoteRepository> {
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  const api = services.github === undefined ? await githubClientFromToken(deps) : services.github;
  if (!api) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  const { defaultBranch } = await api.getRepo(owner, repo);
  return { api, owner, repo, defaultBranch };
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
function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing deployed) unless the target environment `target` (its plan
 * and paths) has nothing `opscrew provision` would apply (read-only drift) and the deploy workflow
 * on the default branch is the one its plan generates (by git blob hash), so the approval names
 * what will run. On a server, drift compares the generated files, so the repository's copy is the
 * one the plan generates; a site's drift compares none, so its caller passes `workflow`, the
 * workflow rendered from the plan, which must be the default branch's. Returns the workflow's file
 * name, which the promotion starts.
 */
export async function requireApplied(
  deps: PhaseDeps,
  input: {
    target: string;
    plan: DeployPlan;
    paths: ProjectPaths;
    github: PromoteRepository;
    services: PromoteServices;
    command: string;
    /** A site: the workflow its plan generates (its text), as provision renders it. */
    workflow?: string;
  },
): Promise<string> {
  const { target, plan, github, command } = input;
  const provisionFirst = `Run \`opscrew provision --env ${target}\` first, then \`${command}\` again.`;
  deps.reporter.step(`Checking ${target} for changes not applied yet (read-only)`);
  const report = await (input.services.drift ?? runDrift)({ ...deps, paths: input.paths });
  const pending = pendingChanges(report);
  if (pending.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment has changes that are not applied yet: ${shortList(pending)}. OpsCrew promotes only to an environment whose plan is applied, so the approval names what will run. ${NOTHING}`,
      { hint: provisionFirst },
    );
  }
  const { workflowPath } = plan.cicd;
  const { defaultBranch } = github;
  // A site's, rendered from its plan; a server's, the repository's copy, which drift found equal
  // to the rendered one. Its blob is with LF line endings, as provision writes and commits it.
  const rendered = (
    input.workflow ?? (await readFile(join(deps.paths.root, workflowPath), "utf8"))
  ).replace(/\r\n/g, "\n");
  const onDefault = await github.api.fileSha(
    github.owner,
    github.repo,
    workflowPath,
    defaultBranch,
  );
  if (onDefault !== gitBlobSha(rendered)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      onDefault === undefined
        ? `The default branch ${defaultBranch} has no ${workflowPath}, the deploy workflow ${target}'s plan generates, so GitHub cannot start it. ${NOTHING}`
        : `The deploy workflow on the default branch ${defaultBranch} (${workflowPath}) is not the one ${target}'s plan generates, so its run would not do what this promotion shows. ${NOTHING}`,
      {
        hint:
          input.workflow !== undefined && onDefault !== undefined
            ? `Run \`opscrew provision --env ${target}\`: its pull request brings the workflow up to date with the plan. Merge it, then run \`${command}\` again.`
            : `Merge the deploy-setup pull request \`opscrew provision --env ${target}\` opened (or run it, if none is open), then run \`${command}\` again.`,
      },
    );
  }
  return posix.basename(workflowPath);
}
