/**
 * The rollback of an environment on a server (one OpsCrew created, or the user's own), on the
 * user's Portainer, or promoted from another environment (plan.md 2., 5.): an earlier image of its
 * own, deployed by its digest through its deploy workflow's rollback dispatch, which builds
 * nothing and runs no release command, with the environment's deploys paused from then on.
 */
import {
  canonicalJson,
  errorMessage,
  OpsCrewError,
  sha256Hex,
  toPosixRelative,
} from "@opscrew/core";
import { checkEnvironmentKey, ROLLBACK_INPUTS } from "@opscrew/iac-templates";
import { workflowBranch } from "../environments/branches";
import { ghcrReadCredential } from "../localhost/image";
import { clearPendingPromotion, readPromotion, writePromotion } from "../promote/record";
import { requireRollbackServices } from "../promote/run";
import { requireApplied } from "../promote/shared";
import { secretsEnvironment } from "../provision/secrets";
import { PlanRefusedError } from "../shared";
import {
  type DeployPause,
  deployPauseOf,
  restoreDeployPause,
  runningDeploy,
  setDeployPause,
  waitForDeploys,
} from "../shared/deploy-pause";
import { type DispatchRepository, dispatchAndFollow } from "../shared/deploy-run";
import { codeOf } from "../shared/errors";
import type { RollbackResult } from "./index";
import {
  imageRollbackHash,
  PENDING_ROLLBACK_FILE,
  type RolledBack,
  readPendingRollback,
  writePendingRollback,
  writeRollback,
} from "./record";
import { NOTHING, type RollbackRepository, type RollbackRun, rollbackRepository } from "./run";
import type { Version, VersionsContext, VersionView } from "./types";
import { checkOldPlan, chooseVersion, listVersions, shortDigest, versionText } from "./versions";

/** A version in a few words: `<short commit> "<message>"`, or its short digest without a commit. */
function shortText(version: VersionView & { digest: string }): string {
  if (version.commit === undefined) return shortDigest(version.digest);
  const message = version.message === undefined ? "" : ` "${version.message}"`;
  return `${version.commit.slice(0, 7)}${message}`;
}

/** The environment's image on GHCR, read with `OPSCREW_GHCR_READ_TOKEN` when it is set. */
function versionsContext(run: RollbackRun, github: RollbackRepository): VersionsContext {
  const { deps, plan } = run;
  const credential = ghcrReadCredential(deps, github.owner);
  return {
    image: {
      github: github.api,
      owner: github.owner,
      repo: github.repo,
      key: plan.app.key,
      ...(credential !== undefined ? { credential } : {}),
    },
    plan,
    paths: deps.paths,
  };
}

/** The promoted environment's source, or `undefined` for one that follows its branch. */
function sourceOf(run: RollbackRun): string | undefined {
  const deploySource = run.plan.environment?.deploySource;
  return deploySource?.from === "promote" ? deploySource.source : undefined;
}

/** What the output says once the environment runs the earlier version: paused, and how to resume. */
export function pausedText(run: RollbackRun): string {
  const { environment, command, plan } = run;
  const source = sourceOf(run);
  if (source !== undefined) {
    return `${environment}'s deploys are paused: \`opscrew promote --to ${environment}\` refuses until they resume. Once ${source} runs the fix, run \`${command} --resume\`, then \`opscrew promote --to ${environment}\`.`;
  }
  const branch = plan.cicd.branch;
  return `${environment}'s deploys are paused: a push to ${branch} builds but doesn't deploy. When the fix is pushed, run \`${command} --resume\` (add --deploy to deploy ${branch}'s latest commit now).`;
}

/** The refusal while a move's window, since `since`, pauses the environment's deploys. */
function movePaused(run: RollbackRun, since: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The deploys of ${run.environment} are paused since ${since} while a service moves between the app's servers, and a rollback must not deploy during the move. ${NOTHING}`,
    {
      hint: `Run \`opscrew provision${run.flags}\`: it ends the move's maintenance window. Then run \`${run.command}\` again.`,
    },
  );
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) while a run of the environment's deploy workflow is
 * queued or in progress (FR-1907, ADR 0023 D6), naming it.
 */
export async function requireNoDeployRunning(
  run: RollbackRun,
  github: RollbackRepository,
): Promise<void> {
  const running = await runningDeploy(github, run.plan);
  if (running === undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `A run of ${run.environment}'s deploy workflow is queued or in progress: ${running.url}. OpsCrew rolls back only between deploys, so the two never race. ${NOTHING}`,
    { hint: `Let it end, then run \`${run.command}\` again.` },
  );
}

/**
 * Just after the pause is set: waits for the deploys created before it; when one still runs after
 * 30 minutes, or the wait fails, puts back the pause entry `pauseBefore` and stops.
 * @throws OpsCrewError `COMMAND_FAILED` from `waitForDeploys`, saying the pause is back.
 */
export async function waitAfterPause(
  run: RollbackRun,
  github: RollbackRepository,
  pauseBefore: DeployPause | undefined,
): Promise<void> {
  const { deps, plan, environment, command, services } = run;
  try {
    await waitForDeploys(deps, github, plan, services, {
      outcome: `the rollback did not start, and OpsCrew put ${environment}'s deploy pause back as it was. ${NOTHING}`,
      hint: `Let it end (https://github.com/${github.owner}/${github.repo}/actions), then run \`${command}\` again.`,
    });
  } catch (error) {
    await restoreDeployPause(deps, github, plan, pauseBefore);
    throw error;
  }
}

/** A pause entry's commit when OpsCrew cannot tell which commit the version was built from. */
export const UNKNOWN_COMMIT = "unknown";

/** What a rollback's pause entry names: the version it goes back to, and the commits. */
export type PinnedVersion = Omit<Extract<DeployPause, { reason: "rollback" }>, "reason" | "since">;

/**
 * Runs `change`, which calls `beforeChange` once nothing can stop it but the change itself: that
 * pauses the environment's deploys with `pinned`, then waits for the deploys created just before
 * (`waitAfterPause`, which puts the pause back itself when one still runs). Any error after that
 * puts back the entry the pause replaced, and says so.
 */
export async function pausedWhile<T>(
  run: RollbackRun,
  github: RollbackRepository,
  pinned: PinnedVersion,
  change: (beforeChange: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const { deps, plan, environment } = run;
  const pause: { set: boolean; replaced?: DeployPause } = { set: false };
  try {
    return await change(async () => {
      deps.reporter.step(`Pausing ${environment}'s deploys`);
      const replaced = await setDeployPause(deps, github, plan, {
        reason: "rollback",
        since: deps.clock.now().toISOString(),
        ...pinned,
      });
      await waitAfterPause(run, github, replaced);
      pause.set = true;
      if (replaced !== undefined) pause.replaced = replaced;
    });
  } catch (error) {
    if (!pause.set) throw error;
    await restoreDeployPause(deps, github, plan, pause.replaced);
    if (!(error instanceof OpsCrewError)) throw error;
    throw new OpsCrewError(
      error.code,
      `${error.message} OpsCrew put ${environment}'s deploy pause back as it was.`,
      error.hint !== undefined ? { hint: error.hint } : {},
    );
  }
}

/** A rollback run still waiting for its required reviewer, and what the next run does. */
function stillWaiting(run: RollbackRun, url: string, target: string): string {
  const { environment, command } = run;
  return `${environment}'s rollback run waits in GitHub for a required reviewer: ${url}. Once they approve it, the run deploys ${target}; ${environment}'s deploys stay paused meanwhile. Run \`${command}\` again once the run has finished: it records the rollback, or puts the pause back if the run failed.`;
}

/**
 * Records a rollback that succeeded: `rollback.json`, and for a promoted environment its
 * `promotion.json` too, so a later promotion or rollback checks against what runs (US4 #5).
 */
async function recordRollback(
  run: RollbackRun,
  rolledBack: RolledBack & { runUrl: string },
): Promise<void> {
  const { deps, plan } = run;
  await writeRollback(deps.paths, rolledBack);
  const source = sourceOf(run);
  if (source === undefined) return;
  await writePromotion(deps.paths, {
    digest: rolledBack.digest,
    source,
    runUrl: rolledBack.runUrl,
    at: rolledBack.at,
    services: plan.services.map((service) => service.name),
  });
}

/**
 * The environment's pending rollback, whose run was left waiting for a reviewer: recorded once
 * that run succeeded (the result, with no new dispatch), reported again while it has not finished
 * (`waiting`), and forgotten when it failed or was cancelled, with the pause entry it replaced put
 * back, so a new rollback goes ahead (`undefined`, as without one).
 */
async function checkPending(
  run: RollbackRun,
  github: RollbackRepository,
): Promise<RollbackResult | undefined> {
  const { deps, plan, environment } = run;
  const pending = await readPendingRollback(deps.paths);
  if (pending === undefined) return undefined;
  deps.reporter.step(`Checking ${environment}'s rollback run that waited for a reviewer`);
  const last = await github.api.getWorkflowRun(github.owner, github.repo, pending.runId);
  const target = { digest: pending.digest, commit: pending.commit };
  const result = {
    kind: "rolled-back",
    target,
    from: pending.from,
    runUrl: last.htmlUrl,
    paused: true,
    how: "image",
  } as const;
  if (last.status !== "completed") {
    deps.reporter.warn(
      last.status === "waiting"
        ? stillWaiting(run, last.htmlUrl, shortText(target))
        : `${environment}'s rollback run ${last.htmlUrl} has not finished yet. Run \`${run.command}\` again once it has: it records the rollback, or puts the pause back if the run failed.`,
    );
    return { ...result, status: "waiting" };
  }
  const ok = last.conclusion === "success";
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "deploy workflow",
    target: last.htmlUrl,
    decision: ok ? "approved" : "refused",
    detail: `workflow run ${last.id} finished: ${last.conclusion ?? "no result"}`,
  });
  // The pending file goes only once what it holds is put back or recorded.
  if (!ok) {
    await restoreDeployPause(deps, github, plan, pending.pauseBefore ?? undefined);
    await clearPendingPromotion(deps.paths, PENDING_ROLLBACK_FILE);
    deps.reporter.warn(
      `${environment}'s rollback run that waited for a reviewer did not succeed (${last.conclusion ?? "no result"}): ${last.htmlUrl}. OpsCrew put ${environment}'s deploy pause back as it was, and goes on with a new rollback.`,
    );
    return undefined;
  }
  await recordRollback(run, {
    ...target,
    from: pending.from,
    runUrl: last.htmlUrl,
    at: deps.clock.now().toISOString(),
    hash: pending.hash,
  });
  await clearPendingPromotion(deps.paths, PENDING_ROLLBACK_FILE);
  deps.reporter.success(`${environment} runs ${shortText(target)} again (${last.htmlUrl}).`);
  deps.reporter.info(pausedText(run));
  return { ...result, status: "deployed" };
}

/**
 * What the approval adds of the earlier version against today's plan: a promoted environment's
 * against the services its recorded promotion ran with (`promotion.json`), a branch-following
 * one's against its plan at that commit; each says when it could not check.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming a service the earlier version ran with that
 * the plan no longer has.
 */
async function servicesLines(
  run: RollbackRun,
  ctx: VersionsContext,
  target: Version,
): Promise<string[]> {
  const { deps, plan, environment, command } = run;
  const source = sourceOf(run);
  if (source !== undefined) {
    const record = await readPromotion(deps.paths);
    const parts = {
      target: environment,
      source,
      digest: target.digest,
      command,
      what: "rollback",
    } as const;
    if (requireRollbackServices(parts, plan, record)) return [];
    return [
      `OpsCrew has no record on this computer of what that image ran with, so it cannot check it against ${environment}'s plan: a component removed since that image ran is not brought back.`,
    ];
  }
  const { unchecked, added } = await checkOldPlan(ctx, target, command);
  if (!unchecked) return added;
  return [
    `OpsCrew could not read ${environment}'s plan at ${target.commit.slice(0, 7)} in GitHub, so it did not check that version against today's plan: a service removed since then is not brought back.`,
  ];
}

/** A run as `waitForWorkflowRun` gives it once it ended or waits for a reviewer. */
type FinishedRun = Awaited<ReturnType<DispatchRepository["api"]["waitForWorkflowRun"]>>;

/**
 * After the pause is set: waits for the deploys created just before it, then starts the workflow
 * with the target's digest and commit tag and `rollback`, and follows its run. A failed or
 * cancelled run, a dispatch GitHub definitely refused, or a wait that never ended puts back the
 * pause entry `pauseBefore`; a run that may have started keeps the pause, and says so.
 * @throws OpsCrewError `COMMAND_FAILED` naming the run when it did not succeed, and
 * `dispatchAndFollow`'s errors otherwise.
 */
async function dispatchRollback(
  run: RollbackRun,
  github: RollbackRepository,
  input: {
    workflowFile: string;
    branch: string;
    target: Version;
    from: string;
    hash: string;
    pauseBefore: DeployPause | undefined;
  },
): Promise<{ status: "deployed" | "waiting"; runId: number; runUrl: string }> {
  const { deps, plan, environment, command, flags } = run;
  const { workflowFile, branch, target } = input;
  const restore = () => restoreDeployPause(deps, github, plan, input.pauseBefore);
  await waitAfterPause(run, github, input.pauseBefore);
  // Which of `dispatchAndFollow`'s failures happened: whether GitHub accepted the dispatch, and the
  // run once it ended.
  let accepted = false;
  let finished: FinishedRun | undefined;
  const api: DispatchRepository["api"] = {
    dispatchWorkflow: (owner, repo, file, ref, inputs, onAccepted) =>
      github.api.dispatchWorkflow(owner, repo, file, ref, inputs, async () => {
        accepted = true;
        await onAccepted?.();
      }),
    waitForWorkflowRun: async (owner, repo, options) => {
      finished = await github.api.waitForWorkflowRun(owner, repo, options);
      return finished;
    },
  };
  deps.reporter.step(
    `Starting ${workflowFile} on ${branch} with the digest of ${shortText(target)}: no build, and no release command`,
  );
  try {
    return await dispatchAndFollow(
      deps,
      { ...github, api },
      {
        workflowFile,
        ref: branch,
        inputs: {
          [ROLLBACK_INPUTS.digest]: target.digest,
          [ROLLBACK_INPUTS.tag]: target.tag,
          [ROLLBACK_INPUTS.rollback]: "true",
        },
        target: environment,
        command,
        detail: `${workflowFile} on ${branch} with ${target.digest}, a rollback (hash ${input.hash})`,
      },
    );
  } catch (error) {
    if (finished?.status === "completed" && finished.conclusion !== "success") {
      await restore();
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `The rollback of ${environment} did not succeed (${finished.conclusion ?? "no result"}): ${finished.htmlUrl}. When the earlier version fails its checks, the automatic switch back returns ${environment} to the version it ran, ${input.from}. OpsCrew put ${environment}'s deploy pause back as it was.`,
        {
          hint: `Open the run to see which job failed; \`opscrew logs --failed${flags}\` shows the earlier version's last lines when it failed its health check. Then roll back to another version (\`${command} --list\`), or deploy a fix forward.`,
        },
      );
    }
    const code = codeOf(error);
    // A definite refusal started nothing, as `dispatchAndFollow` tells it apart: GitHub's 404 or
    // 422, or a token it refused.
    if (!accepted && (code === "PHASE_PRECONDITION" || code.startsWith("CREDENTIALS_"))) {
      await restore();
      throw error;
    }
    const hint = error instanceof OpsCrewError ? error.hint : undefined;
    throw new OpsCrewError(
      code,
      `${errorMessage(error)} ${environment}'s deploys stay paused, pinned to ${shortText(target)}: \`${command} --resume\` ends the pause.`,
      hint !== undefined ? { hint } : {},
    );
  }
}

/**
 * `opscrew rollback` of a server environment, promoted or not, and on the user's Portainer
 * (plan.md 2.). With `list`, its versions and its pause (read-only). Otherwise, each refusal
 * before any change:
 * 1. a rollback left waiting for a reviewer is recorded first, or its pause put back;
 * 2. a move's window pausing the deploys refuses;
 * 3. the environment is applied, and the workflow on the branch it runs on (`workflowBranch`) is
 *    the one its plan generates (`requireApplied`), which a workflow from before 019 is not;
 * 4. no run of its deploy workflow is queued or in progress (ADR 0023 D6);
 * 5. the version: the one before the running one, or `--to`'s, among its versions
 *    (`listVersions`, `chooseVersion`), with the services it ran with still in the plan;
 * 6. the `promote` approval, bound to {@link imageRollbackHash} of the environment, the current
 *    digest, the target digest and the plan's hash; never granted by `--yes`;
 * 7. the pause set, the deploys created just before it waited for, the workflow dispatched with
 *    the digest, the commit tag and `rollback`, and its run followed;
 * 8. recorded once the run succeeded (`rollback.json`, and `promotion.json` when promoted), or as
 *    pending while it waits for a reviewer; the pause is put back when it failed.
 */
export async function rollbackServer(run: RollbackRun): Promise<RollbackResult> {
  const { deps, options, plan, environment, command, services } = run;
  const github = await rollbackRepository(deps, services);
  const ctx = versionsContext(run, github);
  if (options.list === true) {
    deps.reporter.step(`Reading ${environment}'s versions in GitHub Container Registry`);
    const list = await listVersions(deps, ctx);
    const paused = await deployPauseOf(github, plan);
    return {
      kind: "list",
      versions: list.versions,
      ...(paused !== undefined ? { paused } : {}),
      leftOut: list.leftOut.length,
    };
  }

  // 1.–4. A pending rollback, the pause, the plan applied and no deploy running.
  const followed = await checkPending(run, github);
  if (followed !== undefined) return followed;
  const pause = await deployPauseOf(github, plan);
  if (pause?.reason === "move") throw movePaused(run, pause.since);
  const branch = workflowBranch(plan, github.defaultBranch);
  const workflowFile = await requireApplied(deps, {
    target: environment,
    plan,
    paths: deps.paths,
    github,
    services,
    command,
    branch,
    what: "rollback",
  });
  await requireNoDeployRunning(run, github);

  // 5. The version, and what it ran with.
  deps.reporter.step(`Reading ${environment}'s versions in GitHub Container Registry`);
  const list = await listVersions(deps, ctx);
  const { target, running: current } = chooseVersion(list, {
    environment,
    ...(options.to !== undefined ? { to: options.to } : {}),
    command,
  });
  // `chooseVersion` stops when no image is labelled as running.
  const currentDigest = list.running as string;
  const added = await servicesLines(run, ctx, target);

  // 6. The approval, bound to the rollback's hash. It says whether GitHub also asks a reviewer.
  const environmentName = secretsEnvironment(plan);
  const reviewers =
    environmentName === undefined
      ? []
      : ((await github.api.getEnvironment(github.owner, github.repo, environmentName))?.reviewers ??
        []);
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const hash = imageRollbackHash({
    environment: checkEnvironmentKey(plan),
    current: currentDigest,
    target: target.digest,
    targetPlanHash,
  });
  const nowText = current !== undefined ? versionText(current) : shortDigest(currentDigest);
  const url = plan.deployment.url;
  const details = [
    `Now: ${nowText}`,
    `Back to: ${versionText(target)}`,
    `Image: ${target.image}, built by ${target.runUrl}`,
    "The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.",
    ...added,
    `Target: ${environment}${url !== undefined ? ` (${url})` : ""}, ${toPosixRelative(deps.paths.root, deps.paths.files.plan)} with plan hash ${targetPlanHash}; nothing is waiting for \`opscrew provision\``,
    `Deploy: ${workflowFile} on ${branch}, given the digest; nothing is rebuilt. Afterwards ${environment}'s deploys pause until \`${command} --resume\`.`,
    ...(plan.supplyChain.sign
      ? [
          "Signature: the workflow checks the image's cosign signature before anything is deployed (supplyChain.sign)",
        ]
      : []),
    `Rollback hash: ${hash}`,
    "",
    reviewers.length > 0
      ? `GitHub also asks a required reviewer of the GitHub environment ${environmentName} before the deploy job runs: that review is the real gate. OpsCrew's approval guards against mistakes.`
      : "OpsCrew's approval guards against mistakes, not against someone with write access to the repository, who can start the workflow themselves.",
  ].join("\n");
  deps.reporter.info(details);
  const later = `${command} --to ${target.digest} --approve ${hash}`;
  if (options.approveHash !== undefined && options.approveHash.toLowerCase() !== hash) {
    throw new OpsCrewError(
      "PLAN_NOT_APPROVED",
      `The rollback you approved (${options.approveHash}) is not this one: the version ${environment} runs, the version to go back to or ${environment}'s plan changed since you reviewed it. ${NOTHING}`,
      { hint: `Review the rollback above; to apply it, run: ${later}` },
    );
  }
  const approval = await deps.approvals.request({
    kind: "promote",
    title: `Roll ${environment} back to ${target.commit.slice(0, 7)} (${shortDigest(target.digest)})`,
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "rollback",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: NOTHING,
      hint: `To roll back later without prompts, run: ${later}`,
    });
  }
  await deps.approvals.assertApprovedPromotion(hash);

  // 7. The pause, then the workflow with the digest, and its run.
  deps.reporter.step(`Pausing ${environment}'s deploys`);
  const pauseBefore = await setDeployPause(deps, github, plan, {
    reason: "rollback",
    since: deps.clock.now().toISOString(),
    image: target.digest,
    commit: target.commit,
    ...(current !== undefined ? { from: current.commit } : {}),
  });
  // A move's window that started since the check above: its entry goes back, and nothing deploys.
  if (pauseBefore?.reason === "move") {
    await restoreDeployPause(deps, github, plan, pauseBefore);
    throw movePaused(run, pauseBefore.since);
  }
  const outcome = await dispatchRollback(run, github, {
    workflowFile,
    branch,
    target,
    from: nowText,
    hash,
    pauseBefore,
  });

  // 8. The record.
  const from = {
    digest: currentDigest,
    ...(current !== undefined ? { commit: current.commit } : {}),
  };
  const at = deps.clock.now().toISOString();
  const result = {
    kind: "rolled-back",
    target,
    from: current ?? from,
    runUrl: outcome.runUrl,
    paused: true,
    how: "image",
  } as const;
  if (outcome.status === "waiting") {
    await writePendingRollback(deps.paths, {
      digest: target.digest,
      commit: target.commit,
      from,
      runId: outcome.runId,
      at,
      hash,
      pauseBefore: pauseBefore ?? null,
    });
    deps.reporter.warn(stillWaiting(run, outcome.runUrl, shortText(target)));
    return { ...result, status: "waiting" };
  }
  await recordRollback(run, {
    digest: target.digest,
    commit: target.commit,
    from,
    runUrl: outcome.runUrl,
    at,
    hash,
  });
  deps.reporter.success(
    `${environment} runs ${shortText(target)} again (${shortDigest(target.digest)}, ${outcome.runUrl}): no build, and no release command ran.`,
  );
  deps.reporter.info(pausedText(run));
  return { ...result, status: "deployed" };
}
