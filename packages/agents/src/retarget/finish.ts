import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  assertDeletionPlan,
  confirmDeletion,
  type DeletionSession,
  dataWarning,
  describeChanges,
  destroyTexts,
  forgetHostKeys,
  previewDeletion,
  remainingAfterDeletion,
  removeSnapshotRecord,
  snapshotKeptNote,
  snapshotWanted,
  takeSnapshotBeforeDelete,
  unprotectPlanProblems,
} from "../destroy";
import { providerProfile } from "../providers";
import { publishDeploySetup } from "../provision";
import { moveProvider } from "../shared/vps-target";
import { moveLayout, previousTarget, protectionVariable } from "./layouts";
import { clearPending } from "./pending";
import { deletionStep, planHeading } from "./plans";
import { endMoveServers, unknownOldServer } from "./servers";
import {
  auditStep,
  type MoveSession,
  markFailed,
  moveOf,
  openSession,
  planFilePath,
  recordApply,
  savePlan,
  useLayout,
  waitsOf,
  warnUnusedApproval,
  writeFinalFiles,
} from "./session";
import { pendingStop, reasonOf } from "./steps";
import { requireSwitchSettled } from "./switch";
import { ABORT_COMMAND, FINISH_COMMAND, providerWords, RUN_COMMAND, resourcesText } from "./texts";
import type { FinishRetargetOptions, RetargetResult } from "./types";

/** Every resource of the old server lives under this prefix during a move. */
const PREVIOUS = "module.server_previous.";

/** The flags a scripted finish repeats with each `--approve <hash>`. */
function finishFlags(app: string, snapshot: FinishRetargetOptions["snapshot"]): string[] {
  return [
    "--confirm",
    app,
    ...(snapshot === true ? ["--snapshot"] : snapshot === false ? ["--no-snapshot"] : []),
  ];
}

/** Paths among `paths` that git tracks (a deleted tracked file is staged with `git add`). */
async function trackedPaths(session: MoveSession, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const result = await session.deps.runner.run("git", [
    "-C",
    session.deps.paths.root,
    "ls-files",
    "--",
    ...paths,
  ]);
  if (result.exitCode !== 0) return [];
  const tracked = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()));
  return paths.filter((path) => tracked.has(path));
}

async function finish(
  session: MoveSession,
  options: FinishRetargetOptions,
): Promise<RetargetResult> {
  const { deps, services } = session;
  const move = moveOf(session);
  const app = session.plan.app.name;
  const old = previousTarget(move);
  const fresh = session.plan.target;
  const words = providerWords(old.provider);
  const texts = destroyTexts(old.provider);
  const profile = providerProfile(old.provider);
  const flags = finishFlags(app, options.snapshot);
  const del: DeletionSession = {
    deps,
    provider: old.provider,
    app,
    command: FINISH_COMMAND,
    what: "removal of the old server",
    phase: "retarget",
    engine: session.engine,
    env: session.env,
    dir: session.dir,
    stamp: deps.clock.now().toISOString().replace(/[:.]/g, "-"),
  };

  // 0. The new server must answer through the app's URL (Caddy started, URL checked); else the
  // old server is kept. `switched` is recorded right after the DNS switch, before this check.
  await requireSwitchSettled(session);

  // 1. Preview: only the old server's resources (the plan is discarded, never applied).
  deps.reporter.step(`Planning the removal of the old ${words.noun} to see what it deletes`);
  await useLayout(session, "finish", moveLayout("finish", old, fresh));
  const preview = await previewDeletion(del, {
    suffix: "retarget-finish-preview",
    prefix: PREVIOUS,
  });
  const { serverInState, serverIds } = preview;
  // Only finishing up after the old server is gone may go on without its address.
  if (session.servers.from === undefined && preview.changes.length > 0) {
    throw unknownOldServer(FINISH_COMMAND);
  }
  const warning = dataWarning(session.plan, serverInState, old);
  const data = { postgres: session.plan.services.postgres, backups: old.backups };
  const snapshotFirst = serverInState && snapshotWanted(options.snapshot, data);
  if (preview.changes.length > 0) {
    deps.reporter.info(
      [
        `Finishing the move deletes these resources of the old ${words.noun} on ${words.name}:`,
        ...describeChanges(preview.changes),
      ].join("\n"),
    );
    if (warning) deps.reporter.warn(warning);
    if (snapshotFirst) {
      deps.reporter.info(
        `A snapshot of the old ${words.noun} is taken first, so its data can be restored later (${texts.snapshotBilling}; \`--no-snapshot\` skips it).`,
      );
    }
  } else {
    deps.reporter.info(`The old ${words.noun} is already deleted; OpsCrew finishes the cleanup.`);
  }
  await confirmDeletion(
    del,
    {
      name: app,
      provider: old.provider,
      deleteProtection: profile.deleteProtection,
      resources: preview.changes,
      snapshot: snapshotFirst,
      ...(warning ? { dataWarning: warning } : {}),
    },
    options.confirm,
  );

  // 2. Snapshot (after the typed name, before anything is deleted).
  const servers = services.servers?.[old.provider];
  const snapshotId = await takeSnapshotBeforeDelete(del, {
    server: { inState: serverInState, ids: serverIds },
    choice: options.snapshot ?? "auto",
    data,
    purpose: "retarget",
    ...(servers ? { servers } : {}),
    ...waitsOf(services),
  });
  const kept = snapshotKeptNote(texts, snapshotId);

  // 3. Delete protection (Hetzner): a plan that may only turn it off, in the switched layout.
  const switched = moveLayout("switched", old, fresh);
  const variable = protectionVariable(switched, "server_previous");
  /** Said with every later stop: the old server is no longer protected against deletion. */
  let unprotected = "";
  if (variable !== undefined && serverInState) {
    deps.reporter.step(`Planning to lift delete protection on the old ${words.noun}`);
    await useLayout(session, "switched", switched);
    const lifted = await deletionStep(session, del, {
      action: "finish-unprotect",
      suffix: "retarget-unprotect",
      vars: { [variable]: "false" },
      check: (summary) => {
        const problems = unprotectPlanProblems(summary.changes, summary.planJson, {
          prefix: PREVIOUS,
        });
        if (problems.length === 0) return;
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          [
            `Lifting the delete protection on the old ${words.noun} would also change other things, so OpsCrew stopped. Nothing was deleted.${kept}`,
            ...problems.map((problem) => `  ${problem}`),
          ].join("\n"),
          {
            hint: `The infrastructure no longer matches what OpsCrew applied. Check the ${words.noun}s in ${texts.console}, then run \`${FINISH_COMMAND}\` again.`,
          },
        );
      },
      request: (summary) => ({
        kind: "iac-apply",
        title: `Lift delete protection on the old ${words.noun} ${app}`,
        details: [
          planHeading(summary),
          ...describeChanges(summary.changes),
          `This only turns off the old ${words.noun}'s delete and rebuild protection so that the next plan can delete it. Nothing is deleted yet.`,
          `Plan hash: ${summary.planHash}`,
        ].join("\n"),
        planHash: summary.planHash,
      }),
      refused: (approval, planHash) =>
        new OpsCrewError(
          "APPROVAL_REFUSED",
          `Delete protection on the old ${words.noun} was not lifted${approval.reason ? ` (${approval.reason})` : ""}. Nothing was deleted.${kept}`,
          {
            hint: `Run \`${FINISH_COMMAND}\` again when you are ready (in scripts: \`${FINISH_COMMAND} ${flags.join(" ")} --approve ${planHash}\`).`,
          },
        ),
      allowDestroy: false,
      what: "lifting delete protection on the old server",
      hint: `Fix the cause shown above, then run \`${FINISH_COMMAND}\` again. Nothing was deleted.`,
    });
    if (lifted.kind === "pending") return pendingStop(session, lifted.planHash, flags);
    if (lifted.kind === "applied") {
      await recordApply(session, lifted);
      deps.reporter.success(`Delete protection on the old ${words.noun} is off.`);
    } else {
      deps.reporter.info(`Delete protection on the old ${words.noun} is already off.`);
    }
    unprotected = ` Delete protection on the old ${words.noun} is already off; \`${FINISH_COMMAND}\` deletes it once you confirm again.`;
    await useLayout(session, "finish", moveLayout("finish", old, fresh));
  }

  // 4. The removal: a plan of the root without the old module, bounded to the confirmed preview.
  if (preview.changes.length > 0) {
    deps.reporter.step(`Planning the removal of the old ${words.noun}`);
    const removed = await deletionStep(session, del, {
      action: "finish-destroy",
      suffix: "retarget-finish",
      check: (summary) =>
        assertDeletionPlan(
          del,
          summary,
          { prefix: PREVIOUS, confirmed: preview.addresses, serverIds },
          {
            note: `Nothing was deleted.${unprotected}${kept}`,
            hint: `Run \`${FINISH_COMMAND}\` again to see the current list and confirm it.`,
          },
        ),
      request: (summary) => ({
        kind: "iac-apply",
        title: `Delete the old ${words.noun} ${app} on ${words.name} (${resourcesText(summary.changes.length)} to delete)`,
        details: [
          planHeading(summary),
          ...describeChanges(summary.changes),
          ...(warning ? [warning] : []),
          snapshotId !== undefined
            ? `Snapshot: ${texts.snapshotRef(snapshotId)} keeps a copy of the old ${words.noun} (${texts.snapshotBilled}; OpsCrew never deletes it).`
            : "Snapshot: none.",
          `Plan hash: ${summary.planHash}`,
        ].join("\n"),
        planHash: summary.planHash,
        allowDestroy: true,
        confirmPhrase: app,
      }),
      refused: (approval, planHash) =>
        new OpsCrewError(
          "APPROVAL_REFUSED",
          `The removal of the old ${words.noun} was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing was deleted.${unprotected}${kept}`,
          {
            hint: `Run \`${FINISH_COMMAND}\` again and type ${app} when you are ready (in scripts: \`${FINISH_COMMAND} ${flags.join(" ")} --approve ${planHash}\`).`,
          },
        ),
      allowDestroy: true,
      what: "deleting the old server",
      hint: `Fix the cause shown above, then run \`${FINISH_COMMAND}\` again; it continues with what is left.`,
    });
    if (removed.kind === "pending") return pendingStop(session, removed.planHash, flags);
    if (removed.kind === "applied") {
      await recordApply(session, removed);
      deps.reporter.success(
        `Deleted the old ${words.noun} (${resourcesText(preview.changes.length)}).`,
      );
    }
  }

  // 5. Cleanup: host keys, final files, plan, snapshot record, phase.
  const from = session.servers.from;
  if (from === undefined) {
    // Host keys are pinned by address; without it they cannot be told from the new server's.
    deps.reporter.info(
      `OpsCrew no longer knows the old ${words.noun}'s address on this computer, so its SSH host key stays in OpsCrew's known_hosts (${deps.paths.files.knownHosts}). It is harmless; you can delete the old ${words.noun}'s lines there.`,
    );
  } else if ((await forgetHostKeys(deps, [from.ipv4, from.ipv6])) > 0) {
    deps.reporter.info(`Removed the old ${words.noun}'s SSH host key from OpsCrew's known_hosts.`);
  }
  const { retarget: _finished, ...finalPlan } = session.plan;
  const written = await writeFinalFiles(session, finalPlan, switched, "all");
  await savePlan(session, finalPlan);
  await removeSnapshotRecord(deps, "retarget");
  await clearPending(deps);
  await endMoveServers(deps, session.servers.next);
  const freshWords = providerWords(moveProvider(fresh));
  await deps.state.markPhase("retarget", "ok", `moved to ${freshWords.name}`);
  await auditStep(
    session,
    "finished",
    `old ${old.provider} server deleted${snapshotId !== undefined ? `, ${texts.snapshotRef(snapshotId)} kept` : ""}; the deployment runs on ${fresh.provider}`,
  );
  deps.reporter.success(
    `The move of ${app} to ${freshWords.name} is finished; the old ${words.noun} is deleted.`,
  );

  // 6. The final files in a pull request (a failure here does not undo the finished move).
  const branch = finalPlan.cicd.branch;
  let publish: string;
  try {
    const published = await publishDeploySetup(deps, {
      git: session.git,
      github: session.github,
      plan: finalPlan,
      paths: [
        ...written.files.map((file) => file.path),
        planFilePath(session),
        ...(await trackedPaths(session, written.removed)),
      ],
      push: true,
      secretsStored: true,
      phase: "retarget",
    });
    publish = published.prUrl
      ? `Merge ${published.prUrl} so the repository describes the new deployment.`
      : `Push the branch ${published.branch} and open a pull request into ${branch} so the repository describes the new deployment.`;
  } catch (error) {
    // A branch check (an earlier run's pull request) stops before anything is committed.
    const stopped = isUserFacingError(error) && error.code === "PHASE_PRECONDITION";
    deps.reporter.warn(
      deps.redactor.redact(
        stopped
          ? `The move is finished, but ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}`
          : `The move is finished, but publishing the final files failed: ${reasonOf(error)}.`,
      ),
    );
    publish =
      stopped && error.hint !== undefined
        ? deps.redactor.redact(error.hint)
        : `Commit the changed files under opscrew/ and open a pull request into ${branch} yourself, so the repository describes the new deployment.`;
  }
  const remaining = remainingAfterDeletion({
    provider: old.provider,
    app,
    snapshotId,
    backups: old.backups,
  });
  if (remaining.length > 0) {
    deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  }
  return {
    step: "finished",
    done: true,
    ...(snapshotId !== undefined ? { snapshotId } : {}),
    next: [publish, ...remaining],
  };
}

/**
 * `opscrew retarget --finish` (only after the switch): previews the removal of the old server
 * (deletes only under `module.server_previous.`), asks for the typed app name, takes a snapshot
 * (by default when the database or backups lived there), lifts Hetzner delete protection with a
 * plan that may change nothing else, applies a removal plan bounded to the confirmed preview and
 * server, forgets the old host key, writes the final files and publishes them in a pull request,
 * and clears the move from `opscrew/plan.yaml`.
 */
export async function finishRetarget(
  deps: PhaseDeps,
  options: FinishRetargetOptions = {},
): Promise<RetargetResult> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const move = plan.retarget;
  if (move === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "No move to another provider is in progress, so there is nothing to finish.",
      { hint: `Start one with \`${RUN_COMMAND} --to <provider>\`.` },
    );
  }
  if (move.abort !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The move is being aborted, so it cannot be finished. Nothing was changed.",
      { hint: `Run \`${ABORT_COMMAND}\` to complete the abort.` },
    );
  }
  if (move.step !== "switched") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Traffic does not go to the new server yet, so the old server cannot be deleted. Nothing was changed.",
      { hint: `Run \`${RUN_COMMAND}\` to continue the move, or \`${ABORT_COMMAND}\` to undo it.` },
    );
  }
  try {
    const session = await openSession(deps, plan, {
      command: FINISH_COMMAND,
      providers: [move.from.target.provider, moveProvider(plan.target)],
      services: options.services ?? {},
      oldServerOptional: true,
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
      ...(options.approvePlanHash !== undefined
        ? { approvePlanHash: options.approvePlanHash }
        : {}),
    });
    const result = await finish(session, options);
    warnUnusedApproval(session);
    return result;
  } catch (error) {
    await markFailed(deps, error);
    throw error;
  }
}
