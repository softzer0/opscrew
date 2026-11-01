/**
 * The rollback of a site on Cloudflare's hosting or GitHub Pages, through the target's own version
 * history (plan.md 5., FR-1909): a Worker version activated again, with no build, or an earlier
 * GitHub Pages run re-run, which builds its commit again. Each goes through promote's checks and
 * its `promote` approval, and pauses the environment's deploys just before the change (ADR 0023
 * D2).
 */
import { posix } from "node:path";
import type { WorkerVersion } from "@opscrew/connector-cloudflare";
import type { PagesRun } from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import type { CloudflareWorkersDeployTarget } from "@opscrew/plan-schema";
import { workflowBranch } from "../environments/branches";
import { requireApplied } from "../promote/shared";
import {
  accountOf,
  oldSecretNames,
  rollBackPages,
  rollBackWorker,
  type SiteRun,
  siteWorkflow,
} from "../promote/site";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import { type DeployPause, deployPauseOf } from "../shared/deploy-pause";
import { pagesMarks, previousWorkerVersion, runningVersions, versionBuild } from "../status/site";
import type { RollbackResult } from "./index";
import { NOTHING, type RollbackRepository, type RollbackRun, rollbackRepository } from "./run";
import { pausedText, pausedWhile, requireNoDeployRunning, UNKNOWN_COMMIT } from "./server";
import type { VersionMark, VersionView } from "./types";

/** The refusal when the environment ran no version before the one running (FR-1907). */
function onlyOne(run: RollbackRun, what: string): OpsCrewError {
  const { command } = run;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${what}, so there is nothing to roll back to. ${NOTHING}`,
    {
      hint: `\`${command} --list\` lists its versions; once another one has deployed, \`${command}\` goes back to the one before.`,
    },
  );
}

/**
 * Promote's site rollback with this command and `--to`, its refusals worded for a rollback.
 * @throws OpsCrewError `INVALID_INPUT` for an `--allow-old-secrets` name that is not a secret's.
 */
function siteRun(run: RollbackRun): SiteRun {
  const { deps, options, plan, environment, command, services } = run;
  return {
    deps,
    target: environment,
    plan,
    paths: deps.paths,
    services,
    command,
    versionFlag: "--to",
    approveHash: options.approveHash,
    ...(options.allowOldSecrets !== undefined
      ? { allowOldSecrets: oldSecretNames(options.allowOldSecrets, "rollback") }
      : {}),
    what: "rollback",
  };
}

/**
 * Stops before any change (FR-1907) unless the site's plan is applied and the deploy workflow on
 * the branch it runs on is the one the plan generates, which pauses (an older one has no pause
 * condition), and no run of it is queued or in progress.
 */
async function requireDeployable(run: RollbackRun, github: RollbackRepository): Promise<void> {
  const { deps, plan, environment, command, services } = run;
  await requireApplied(deps, {
    target: environment,
    plan,
    paths: deps.paths,
    github,
    services,
    command,
    branch: workflowBranch(plan, github.defaultBranch),
    workflow: await siteWorkflow(deps.paths, plan),
    what: "rollback",
  });
  await requireNoDeployRunning(run, github);
}

/** A version's marks, left out when it has none. */
function marked(view: VersionView, marks: VersionMark[]): VersionView {
  return marks.length > 0 ? { ...view, marks } : view;
}

/** The list's answer: the versions, and the environment's pause. */
function listed(versions: VersionView[], paused: DeployPause | undefined): RollbackResult {
  return { kind: "list", versions, ...(paused !== undefined ? { paused } : {}), leftOut: 0 };
}

/**
 * The commit OpsCrew's deploy workflow built a Worker version from (the run its message names);
 * {@link UNKNOWN_COMMIT} for a version uploaded otherwise, or a run GitHub no longer has.
 */
async function builtFrom(github: RollbackRepository, version: WorkerVersion): Promise<string> {
  const build = versionBuild(version);
  if (build === undefined) return UNKNOWN_COMMIT;
  const record = await github.api.workflowRun(github.owner, github.repo, build.runId);
  return record?.headSha ?? UNKNOWN_COMMIT;
}

/**
 * Cloudflare's hosting: by default the newest version uploaded before the one running (ADR 0023
 * D4), or `--to <version>`; `--list` gives the Worker's versions.
 * After {@link requireDeployable}, says before the approval that nothing is rebuilt, then
 * `rollBackWorker` checks the version (secrets changed since it ran, `--allow-old-secrets`) and
 * activates it, the pause set just before the activation.
 */
async function rollbackWorker(run: RollbackRun): Promise<RollbackResult> {
  const { deps, options, plan, environment, services } = run;
  const site = siteRun(run);
  const { worker } = plan.target as CloudflareWorkersDeployTarget;
  const github = await rollbackRepository(deps, services);
  const accountId = await accountOf(site, plan, environment);
  const client = sharedCloudflareClient(deps, services);
  deps.reporter.step(`Reading the versions of the Worker ${worker} at Cloudflare`);
  const versions = (await client.listWorkerVersions(accountId, worker)) ?? [];
  const { running } = runningVersions(
    (await client.listWorkerDeployments(accountId, worker)) ?? [],
  );
  const previous = previousWorkerVersion(versions, running?.versionId);
  if (options.list === true) {
    const views = versions.map((version) =>
      marked({ version: version.id, builtAt: version.createdOn }, [
        ...(version.id === running?.versionId ? (["running"] as const) : []),
        ...(version === previous ? (["previous"] as const) : []),
      ]),
    );
    return listed(views, await deployPauseOf(github, plan));
  }

  await requireDeployable(run, github);
  const to = options.to?.trim() ?? previous?.id;
  if (to === undefined) {
    throw onlyOne(
      run,
      `The Worker ${worker} of ${environment} has no version uploaded before the one it runs`,
    );
  }
  const chosen = versions.find((version) => version.id === to);
  const commit = chosen === undefined ? UNKNOWN_COMMIT : await builtFrom(github, chosen);
  deps.reporter.info(
    "Cloudflare serves that Worker version at 100% within a minute; nothing is rebuilt.",
  );
  await pausedWhile(run, github, { image: to, commit }, (beforeChange) =>
    rollBackWorker({ ...site, beforeChange }, to),
  );
  deps.reporter.info(pausedText(run));
  return {
    kind: "rolled-back",
    status: "deployed",
    target: { version: to, ...(chosen !== undefined ? { builtAt: chosen.createdOn } : {}) },
    ...(running !== undefined ? { from: { version: running.versionId } } : {}),
    paused: true,
    how: "worker",
  };
}

/** A GitHub Pages run as the list shows it, with its marks ({@link pagesMarks}). */
function pagesView(run: PagesRun, marks: { running?: PagesRun; previous?: PagesRun }): VersionView {
  return marked({ version: String(run.runId), commit: run.headSha, builtAt: run.startedAt }, [
    ...(run === marks.running ? (["running"] as const) : []),
    ...(run === marks.previous ? (["previous"] as const) : []),
  ]);
}

/** The run `--to` names among `runs`: by its id, else by its commit or a prefix of 7 or more. */
function pagesRunOf(runs: readonly PagesRun[], to: string): PagesRun | undefined {
  const wanted = to.toLowerCase();
  const byId = runs.find((run) => String(run.runId) === wanted);
  if (byId !== undefined || !/^[0-9a-f]{7,40}$/.test(wanted)) return byId;
  return runs.find((run) => run.headSha.startsWith(wanted));
}

/**
 * GitHub Pages: by default the newest run created before the one that published the site now
 * ({@link pagesMarks}), or `--to <run id | commit>`; `--list` gives the successful runs. After
 * {@link requireDeployable}, says before the approval that GitHub builds that commit again, for up
 * to 30 days, then `rollBackPages` re-runs it, the pause set just before the re-run (the workflow
 * lets a re-run deploy).
 */
async function rollbackPages(run: RollbackRun): Promise<RollbackResult> {
  const { deps, options, plan, environment, command, services } = run;
  const github = await rollbackRepository(deps, services);
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const runs = await github.api.pagesRuns(github.owner, github.repo, workflowFile);
  const paused = await deployPauseOf(github, plan);
  const marks = pagesMarks(runs, paused);
  if (options.list === true) {
    return listed(
      runs.map((known) => pagesView(known, marks)),
      paused,
    );
  }

  await requireDeployable(run, github);
  const to = options.to?.trim();
  const chosen = to === undefined ? marks.previous : pagesRunOf(runs, to);
  if (chosen === undefined) {
    if (to === undefined) {
      throw onlyOne(
        run,
        `No successful run of ${workflowFile} was created before the one that published ${environment}'s site now`,
      );
    }
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${to} is neither the id nor the commit of a successful run of ${workflowFile}, ${environment}'s site workflow. ${NOTHING}`,
      { hint: `\`${command} --list\` lists the runs; name one with --to <run id | commit>.` },
    );
  }
  const now = marks.running;
  deps.reporter.info(
    `GitHub re-runs that run: it builds the site again from ${chosen.headSha.slice(0, 7)}, and a base image or a dependency may have changed since; GitHub re-runs a run for up to 30 days.`,
  );
  const version = String(chosen.runId);
  const pinned = {
    image: version,
    commit: chosen.headSha,
    ...(now !== undefined && now !== chosen ? { from: now.headSha } : {}),
  };
  const outcome = await pausedWhile(run, github, pinned, (beforeChange) =>
    rollBackPages({ ...siteRun(run), beforeChange }, version),
  );
  deps.reporter.info(pausedText(run));
  return {
    kind: "rolled-back",
    status: outcome.status,
    target: pagesView(chosen, marks),
    ...(now !== undefined ? { from: pagesView(now, marks) } : {}),
    ...(outcome.runUrl !== undefined ? { runUrl: outcome.runUrl } : {}),
    paused: true,
    how: "pages",
  };
}

/**
 * A site's rollback, or its `--list`: a Worker version on Cloudflare's hosting
 * ({@link rollbackWorker}), a re-run on GitHub Pages ({@link rollbackPages}).
 * @throws OpsCrewError `PHASE_PRECONDITION` for each refusal, `PLAN_NOT_APPROVED` when
 * `approveHash` names another rollback, `APPROVAL_REFUSED` when the user does not approve, and
 * `COMMAND_FAILED` when the Pages run does not succeed or a deploy still runs 30 minutes after
 * the pause.
 */
export async function rollbackSite(run: RollbackRun): Promise<RollbackResult> {
  return run.plan.target.provider === "github-pages" ? rollbackPages(run) : rollbackWorker(run);
}
