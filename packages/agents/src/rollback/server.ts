/**
 * The rollback of an environment on a server (one OpsCrew created, or the user's own), on the
 * user's Portainer, or promoted from another environment (plan.md 2., 5.): an earlier image of its
 * own, deployed by its digest through its deploy workflow's rollback dispatch, which builds
 * nothing and runs no release command, with the environment's deploys paused from then on.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  errorMessage,
  OpsCrewError,
  sha256Hex,
  toPosixRelative,
} from "@opscrew/core";
import {
  checkEnvironmentKey,
  portainerStackTemplatePath,
  RESTORED_IMAGE_FILE,
  ROLLBACK_INPUTS,
} from "@opscrew/iac-templates";
import { formatUtc } from "@opscrew/secops";
import { workflowBranch } from "../environments/branches";
import { appImageOf, imageReference } from "../promote/image";
import { clearPendingPromotion, readPromotion, writePromotion } from "../promote/record";
import { requireRollbackServices } from "../promote/run";
import { gitBlobSha, movePaused, NOTHING_CHANGED, requireApplied } from "../promote/shared";
import { approve, guardText, reviewedEnvironment } from "../promote/site";
import {
  type DeployPause,
  deployPauseOf,
  restoreDeployPause,
  runningDeploy,
  setDeployPause,
  waitForDeploys,
} from "../shared/deploy-pause";
import { auditFinishedRun, deployRunFailure, dispatchAndFollow } from "../shared/deploy-run";
import { codeOf } from "../shared/errors";
import {
  APPROVAL_SECONDS,
  type DatabaseStep,
  databaseOutcome,
  databaseStep,
  earlierChange,
  removeDatabaseApproval,
  restoreHint,
} from "./database";
import type { RollbackResult } from "./index";
import {
  finishPortainerRestore,
  PutBackFailedError,
  readMark,
  undoPortainerRestore,
} from "./portainer";
import {
  imageRollbackHash,
  PENDING_ROLLBACK_FILE,
  type PendingRollback,
  type RolledBack,
  readPendingRollback,
  writePendingRollback,
  writeRollback,
} from "./record";
import { type RollbackRepository, type RollbackRun, rollbackRepository } from "./run";
import type { Version, VersionsContext, VersionView } from "./types";
import {
  checkOldPlan,
  chooseVersion,
  commitWords,
  listVersions,
  shortDigest,
  shortImage,
  versionText,
} from "./versions";

/** A version in a few words: `<short commit> "<message>"`, or its short digest without a commit. */
function shortText(version: VersionView & { digest: string }): string {
  return version.commit === undefined
    ? shortDigest(version.digest)
    : commitWords(version.commit, version.message);
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
function moveRefusal(run: RollbackRun, since: string): OpsCrewError {
  return movePaused({
    target: run.environment,
    since,
    why: "and a rollback must not deploy during the move",
    flags: run.flags,
    command: run.command,
    what: "rollback",
  });
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
    `A run of ${run.environment}'s deploy workflow is queued or in progress: ${running.url}. OpsCrew rolls back only between deploys, so the two never race. ${NOTHING_CHANGED}`,
    { hint: `Let it end, then run \`${run.command}\` again.` },
  );
}

/**
 * Just after the pause is set: waits for the deploys created before it; when one still runs after
 * 30 minutes, or the wait fails, puts back the pause entry `pauseBefore` and stops.
 * @throws OpsCrewError `COMMAND_FAILED` from `waitForDeploys`, saying the pause is back.
 */
async function waitAfterPause(
  run: RollbackRun,
  github: RollbackRepository,
  pauseBefore: DeployPause | undefined,
): Promise<void> {
  const { deps, plan, environment, command, services } = run;
  try {
    await waitForDeploys(deps, github, plan, services, {
      outcome: `the rollback did not start, and OpsCrew put ${environment}'s deploy pause back as it was. ${NOTHING_CHANGED}`,
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
  await auditFinishedRun(deps, last);
  const { database } = pending;
  // The pending file goes only once what it holds is put back or recorded.
  if (last.conclusion !== "success") {
    const changesData = database !== undefined && database.choice !== "keep";
    let data = changesData ? ` ${DATABASE_FAILED}` : "";
    if (pending.saved !== undefined) {
      // In the user's Portainer, the copy from before the restore goes back first. When that
      // fails, the pause stays and its message names the restore that is the way out, which
      // `--resume` follows once this record is gone.
      const ran = imageReference(appImageOf(deps, plan, github), pending.from.digest);
      try {
        data = ` ${await undoPortainerRestore(run, github, pending.saved, ran)}`;
      } catch (error) {
        // A failure that changed nothing keeps this record: the next rollback tries again.
        if (error instanceof PutBackFailedError) {
          await clearPendingPromotion(deps.paths, PENDING_ROLLBACK_FILE);
        }
        throw error;
      }
    } else if (changesData) {
      // The run ended: its one-time approval, if it left one unused, is of no use now.
      await clearApproval(run, () => removeDatabaseApproval(run));
    }
    await restoreDeployPause(deps, github, plan, pending.pauseBefore ?? undefined);
    await clearPendingPromotion(deps.paths, PENDING_ROLLBACK_FILE);
    deps.reporter.warn(
      `${environment}'s rollback run that waited for a reviewer did not succeed (${last.conclusion ?? "no result"}): ${last.htmlUrl}.${data} OpsCrew put ${environment}'s deploy pause back as it was, and goes on with a new rollback.`,
    );
    return undefined;
  }
  // The mark goes first: when that fails, this record stays, so the next rollback finishes.
  if (pending.saved !== undefined || pending.unmark === true) await finishPortainerRestore(run);
  await recordRollback(run, {
    ...target,
    from: pending.from,
    runUrl: last.htmlUrl,
    at: deps.clock.now().toISOString(),
    hash: pending.hash,
    ...(database !== undefined ? { database } : {}),
  });
  await clearPendingPromotion(deps.paths, PENDING_ROLLBACK_FILE);
  const outcome =
    database === undefined ? "" : ` ${databaseOutcome(database, plan, shortText(target))}`;
  deps.reporter.success(
    `${environment} runs ${shortText(target)} again (${last.htmlUrl}).${outcome}`,
  );
  deps.reporter.info(pausedText(run));
  return { ...result, status: "deployed", ...(database !== undefined ? { database } : {}) };
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

/**
 * Why a rollback run that was to change data may have failed: its database step, or an expired
 * one-time approval (the start script refuses one that names its image).
 */
const DATABASE_FAILED =
  "When its database step failed, the start step put the database back as it was just before, and the run's log names the step's own log. When the one-time approval of the database step had expired, the start step stopped before any change.";

/**
 * Removes the database step's one-time approval (`remove`) once no run can use it: the dispatch
 * was refused, or the run ended. A removal that fails is said, since the approval stays until it
 * expires.
 */
async function clearApproval(run: RollbackRun, remove: () => Promise<void>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    run.deps.reporter.warn(
      `${errorMessage(error)} The one-time approval of the database step stays on the server until it expires, ${APPROVAL_SECONDS / 60} minutes after OpsCrew left it.`,
    );
  }
}

/**
 * The way out a mark on restored data names when the rollback to the version that ran, with keep,
 * gets the deploy branch back (`portainer.ts`): its target's digest.
 */
const WAY_OUT_ROLLBACK = /^opscrew rollback\b.* --to (sha256:[0-9a-f]{64}) --database keep$/;

/**
 * True when the stack template on `branch` (where the rollback's run deploys from) is the one
 * committed here, by its git blob, as the deploy workflow is checked: its guard keeps other
 * versions off data a rollback restored.
 */
async function templateApplied(
  run: RollbackRun,
  github: RollbackRepository,
  branch: string,
): Promise<boolean> {
  const path = portainerStackTemplatePath(run.plan);
  const committed = await readFile(join(run.deps.paths.root, path), "utf8").catch(() => undefined);
  if (committed === undefined) return false;
  const onBranch = await github.api.fileSha(github.owner, github.repo, path, branch);
  return onBranch === gitBlobSha(committed.replace(/\r\n/g, "\n"));
}

/**
 * Undoes what the database step's `leave` did once no run can use it (the dispatch was refused, or
 * the run failed), and returns what the failure's message adds of the data: in the user's
 * Portainer, the copy from before the restore put back (`PutBackFailedError`, the pause kept, when
 * that fails); elsewhere, the one-time approval removed.
 */
async function undoDatabase(run: RollbackRun, database: DatabaseStep): Promise<string> {
  if (database.portainer !== undefined) {
    const said = await database.portainer.undo();
    return said === "" ? "" : ` ${said}`;
  }
  await clearApproval(run, database.clear);
  return database.confirmPhrase === undefined ? "" : ` ${DATABASE_FAILED}`;
}

/**
 * After the pause is set: waits for the deploys created just before it, leaves the database
 * step's one-time approval on the server (or removes an earlier one), then starts the workflow
 * with the target's digest and commit tag and `rollback`, and follows its run. A failed or
 * cancelled run, a dispatch GitHub definitely refused, or a wait that never ended puts back the
 * pause entry `pauseBefore`, and the first two remove the one-time approval; a run that may have
 * started keeps both, and says so.
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
    database: DatabaseStep;
    /** The pending record of the run `runId`, for the next `opscrew rollback` to follow it. */
    pendingOf: (runId: number) => PendingRollback;
  },
): Promise<{ status: "deployed" | "waiting"; runId: number; runUrl: string; expires?: string }> {
  const { deps, plan, environment, command, flags } = run;
  const { workflowFile, branch, target, database } = input;
  await waitAfterPause(run, github, input.pauseBefore);
  let expires: string | undefined;
  try {
    expires = await database.leave();
  } catch (error) {
    // The data may be partly changed: the pause stays, so nothing deploys onto it.
    if (error instanceof PutBackFailedError) throw error;
    await restoreDeployPause(deps, github, plan, input.pauseBefore);
    const hint = error instanceof OpsCrewError ? error.hint : undefined;
    // Said once, also after a refusal that says it (the disk too full for the copy).
    const said = errorMessage(error).replace(` ${NOTHING_CHANGED}`, "");
    throw new OpsCrewError(
      codeOf(error),
      `${said} The rollback did not start, and OpsCrew put ${environment}'s deploy pause back as it was. ${NOTHING_CHANGED}`,
      hint !== undefined ? { hint } : {},
    );
  }
  deps.reporter.step(
    `Starting ${workflowFile} on ${branch} with the digest of ${shortText(target)}: no build, and no release command`,
  );
  try {
    const done = await dispatchAndFollow(deps, github, {
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
    });
    return { ...done, ...(expires !== undefined ? { expires } : {}) };
  } catch (error) {
    const failure = deployRunFailure(error);
    if (failure.kind === "failed") {
      // The start step used the one-time approval, or never ran: it is of no use now.
      let data: string;
      try {
        data = await undoDatabase(run, database);
      } catch (undone) {
        // A put-back in Portainer that changed nothing yet: the next rollback tries again.
        if (database.portainer !== undefined && !(undone instanceof PutBackFailedError)) {
          await writePendingRollback(deps.paths, input.pendingOf(failure.runId));
        }
        throw undone;
      }
      await restoreDeployPause(deps, github, plan, input.pauseBefore);
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `The rollback of ${environment} did not succeed (${failure.conclusion ?? "no result"}): ${failure.runUrl}. When the earlier version fails its checks, the automatic switch back returns ${environment} to the version it ran, ${input.from}.${data} OpsCrew put ${environment}'s deploy pause back as it was.`,
        {
          hint: `Open the run to see which job failed; \`opscrew logs --failed${flags}\` shows the earlier version's last lines when it failed its health check. Then roll back to another version (\`${command} --list\`), or deploy a fix forward.`,
        },
      );
    }
    const hint = error instanceof OpsCrewError ? error.hint : undefined;
    // A definite refusal started nothing.
    if (failure.kind === "refused") {
      const data = await undoDatabase(run, database);
      await restoreDeployPause(deps, github, plan, input.pauseBefore);
      if (database.portainer === undefined) throw error;
      throw new OpsCrewError(
        codeOf(error),
        `${errorMessage(error)}${data} OpsCrew put ${environment}'s deploy pause back as it was.`,
        hint !== undefined ? { hint } : {},
      );
    }
    const saved = database.portainer?.saved;
    if (saved === undefined) {
      throw new OpsCrewError(
        codeOf(error),
        `${errorMessage(error)} ${environment}'s deploys stay paused, pinned to ${shortText(target)}: \`${command} --resume\` ends the pause.`,
        hint !== undefined ? { hint } : {},
      );
    }
    // In Portainer the data stays restored and marked: the next rollback follows the run.
    const runId = failure.kind === "unknown" ? failure.runId : undefined;
    if (runId !== undefined) await writePendingRollback(deps.paths, input.pendingOf(runId));
    throw new OpsCrewError(
      codeOf(error),
      `${errorMessage(error)} The snapshot of ${shortText(target)} stays restored in your Portainer, marked so that no other version starts on it, with the app stopped until the run starts ${shortText(target)}; the copy from just before is the snapshot ${saved}. ${environment}'s deploys stay paused.`,
      {
        hint:
          runId !== undefined
            ? `Once the run ended, run \`${command}\`: it records the rollback, or puts that copy back if the run failed.`
            : `Once the run ended, run \`${command}\`: it names the way out of the restored data.`,
      },
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
 * 4. no run of its deploy workflow is queued or in progress (ADR 0023 D6); in the user's
 *    Portainer, while a rollback that did not end left the data marked (`RESTORED_IMAGE_FILE`),
 *    only the mark's way out goes ahead, the keep rollback to the version it names (D19);
 * 5. the version: the one before the running one, or `--to`'s, among its versions
 *    (`listVersions`, `chooseVersion`), with the services it ran with still in the plan, and how
 *    to treat the database ({@link databaseStep});
 * 6. the `promote` approval, bound to {@link imageRollbackHash} of the environment, the current
 *    digest, the target digest, the plan's hash and the database step; never granted by `--yes`.
 *    A database choice that changes data is approved like a destroy: the environment's app name
 *    typed (`--confirm` in a script);
 * 7. the pause set, the deploys created just before it waited for, the database step's one-time
 *    approval left on the server (in the user's Portainer, its snapshot restored, D19), the
 *    workflow dispatched with the digest, the commit tag and `rollback`, and its run followed;
 * 8. recorded once the run succeeded (`rollback.json`, and `promotion.json` when promoted), or as
 *    pending while it waits for a reviewer; the pause is put back when it failed.
 */
export async function rollbackServer(run: RollbackRun): Promise<RollbackResult> {
  const { deps, options, plan, environment, command, services } = run;
  const github = await rollbackRepository(deps, services);
  const ctx: VersionsContext = { image: appImageOf(deps, plan, github), plan, paths: deps.paths };
  if (options.list === true) {
    deps.reporter.step(`Reading ${environment}'s versions in GitHub Container Registry`);
    const list = await listVersions(deps, ctx);
    const paused = await deployPauseOf(github, plan);
    return {
      kind: "list",
      versions: list.versions,
      ...(paused !== undefined ? { paused } : {}),
      leftOut: list.leftOut,
    };
  }

  // 1.–4. A pending rollback, the pause, the plan applied and no deploy running.
  const followed = await checkPending(run, github);
  if (followed !== undefined) return followed;
  const pause = await deployPauseOf(github, plan);
  if (pause?.reason === "move") throw moveRefusal(run, pause.since);
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

  // In the user's Portainer, data a rollback restored and marked: only its way out goes ahead.
  const mark = plan.target.provider === "portainer" ? await readMark(run) : undefined;
  const markedTo = mark === undefined ? undefined : WAY_OUT_ROLLBACK.exec(mark.wayOut)?.[1];

  // 5. The version, and what it ran with.
  deps.reporter.step(`Reading ${environment}'s versions in GitHub Container Registry`);
  const list = await listVersions(deps, ctx);
  // After a rollback that couldn't put the data on extra servers back, `--to` the running version
  // with the snapshot restores the copies it saved, once its start step had switched (D7).
  const earlier =
    options.to !== undefined && options.database === "snapshot" && list.running !== undefined
      ? await earlierChange(run, list.running)
      : undefined;
  const {
    target,
    running: current,
    runningDigest,
  } = chooseVersion(list, {
    environment,
    ...(options.to !== undefined ? { to: options.to } : {}),
    command,
    ...(earlier?.switched === true || markedTo !== undefined ? { allowRunning: true } : {}),
    ...(earlier !== undefined && !earlier.switched && list.running !== undefined
      ? { runningHint: restoreHint(run, earlier, list.running) }
      : {}),
  });
  if (mark !== undefined && (markedTo !== target.digest || options.database !== "keep")) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment}'s data in your Portainer is marked for ${shortImage(mark.image)} by a rollback that did not end (${RESTORED_IMAGE_FILE}), so OpsCrew starts no other rollback on it. ${NOTHING_CHANGED}`,
      { hint: `Run \`${mark.wayOut}\`.` },
    );
  }
  const added = await servicesLines(run, ctx, target);
  const reviewed = await reviewedEnvironment(plan, github);
  const database = await databaseStep(run, {
    current: runningDigest,
    target: target.digest,
    words: shortText(target),
    ...(plan.target.provider === "portainer"
      ? {
          portainer: {
            ...(reviewed !== undefined ? { reviewed } : {}),
            templateApplied: await templateApplied(run, github, branch),
            images: { current: imageReference(ctx.image, runningDigest), target: target.image },
            github,
          },
        }
      : {}),
  });
  // The run's success removes the mark: the snapshot's, or the one this way out was for.
  const unmarks = database.portainer !== undefined || mark !== undefined;

  // 6. The approval, bound to the rollback's hash. It says whether GitHub also asks a reviewer.
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const hash = imageRollbackHash({
    environment: checkEnvironmentKey(plan),
    current: runningDigest,
    target: target.digest,
    targetPlanHash,
    ...(database.binding !== undefined ? { database: database.binding } : {}),
  });
  const nowText = current !== undefined ? versionText(current) : shortDigest(runningDigest);
  const url = plan.deployment.url;
  await approve(
    { deps, approveHash: options.approveHash, target: environment, what: "rollback" },
    {
      title: `Roll ${environment} back to ${target.commit.slice(0, 7)} (${shortDigest(target.digest)})`,
      details: [
        `Now: ${nowText}`,
        `Back to: ${versionText(target)}`,
        `Image: ${target.image}, built by ${target.runUrl}`,
        ...database.lines,
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
        guardText(reviewed),
      ].join("\n"),
      hash,
      later: `${command} --to ${target.digest}${database.flags} --approve ${hash}`,
      ...(database.confirmPhrase !== undefined ? { confirmPhrase: database.confirmPhrase } : {}),
    },
  );

  const from = {
    digest: runningDigest,
    ...(current !== undefined ? { commit: current.commit } : {}),
  };
  /** What the next `opscrew rollback` follows of the run `runId`. */
  const pendingOf = (runId: number): PendingRollback => ({
    digest: target.digest,
    commit: target.commit,
    from,
    runId,
    at: deps.clock.now().toISOString(),
    hash,
    pauseBefore: pauseBefore ?? null,
    database: database.record,
    ...(database.portainer?.saved !== undefined ? { saved: database.portainer.saved } : {}),
    ...(unmarks ? { unmark: true as const } : {}),
  });

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
    throw moveRefusal(run, pauseBefore.since);
  }
  const outcome = await dispatchRollback(run, github, {
    workflowFile,
    branch,
    target,
    from: nowText,
    hash,
    pauseBefore,
    database,
    pendingOf,
  });

  // 8. The record.
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
    await writePendingRollback(deps.paths, pendingOf(outcome.runId));
    const expiry =
      outcome.expires === undefined
        ? ""
        : ` The database step's one-time approval on the server expires at ${formatUtc(outcome.expires)}: if the run starts later, it stops before any change and \`${command}\` asks again.`;
    deps.reporter.warn(`${stillWaiting(run, outcome.runUrl, shortText(target))}${expiry}`);
    return { ...result, status: "waiting" };
  }
  if (unmarks) {
    // The mark goes first; when that fails, the pending record lets the next rollback finish.
    try {
      await finishPortainerRestore(run);
    } catch (error) {
      await writePendingRollback(deps.paths, pendingOf(outcome.runId));
      throw error;
    }
  }
  await recordRollback(run, {
    digest: target.digest,
    commit: target.commit,
    from,
    runUrl: outcome.runUrl,
    at,
    hash,
    database: database.record,
  });
  deps.reporter.success(
    `${environment} runs ${shortText(target)} again (${shortDigest(target.digest)}, ${outcome.runUrl}): no build, and no release command ran. ${database.outcome}`,
  );
  deps.reporter.info(pausedText(run));
  return { ...result, status: "deployed", database: database.record };
}
