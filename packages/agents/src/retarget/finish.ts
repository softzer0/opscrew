import { isUserFacingError, lowerFirst, OpsCrewError, upperFirst } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { dataWarning, serverData } from "../destroy/checks";
import {
  confirmDeletion,
  forgetHostKeys,
  remainingAfterDeletion,
  removeSnapshotRecord,
  snapshotKeptNote,
  snapshotWanted,
  takeSnapshotBeforeDelete,
} from "../destroy/deletion";
import { providerProfile } from "../providers";
import { publishDeploySetup } from "../provision";
import { describeChanges, trackedFiles } from "../shared";
import { reasonOf } from "../shared/errors";
import { runPhase } from "../shared/phase-status";
import { moveProvider } from "../shared/vps-target";
import { previousTarget } from "./layouts";
import { clearPending } from "./pending";
import { liftMoveProtection, moveRemoval, previewMoveRemoval, removeMoveServer } from "./removal";
import { endMoveServers, unknownOldServer } from "./servers";
import {
  auditStep,
  layoutOf,
  type MoveSession,
  moveOf,
  openSession,
  planFilePath,
  savePlan,
  waitsOf,
  warnUnusedApproval,
  writeFinalFiles,
} from "./session";
import { requireSwitchSettled } from "./switch";
import {
  ABORT_COMMAND,
  FINISH_ABORT_HINT,
  FINISH_COMMAND,
  providerWords,
  RUN_COMMAND,
  START_MOVE_HINT,
} from "./texts";
import type { FinishRetargetOptions, RetargetResult } from "./types";

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
  const tracked = new Set(await trackedFiles(session.deps, paths));
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
  const removal = moveRemoval(session, "old", old.provider, finishFlags(app, options.snapshot));
  const { del, words, texts } = removal;

  // 0. The new server must answer through the app's URL (Caddy started, URL checked); else the
  // old server is kept. `switched` is recorded right after the DNS switch, before this check.
  await requireSwitchSettled(session);

  // 1. Preview: only the old server's resources (the plan is discarded, never applied).
  const preview = await previewMoveRemoval(removal);
  const { serverInState, serverIds } = preview;
  // Only finishing up after the old server is gone may go on without its address.
  if (session.servers.from === undefined && preview.changes.length > 0) {
    throw unknownOldServer(FINISH_COMMAND);
  }
  const warning = dataWarning(session.plan, serverInState, old);
  const data = {
    serverData: serverData(session.plan).length > 0,
    backups: old.backups,
  };
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
      deleteProtection: providerProfile(old.provider).deleteProtection,
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
  const lift = await liftMoveProtection(removal, { serverInState, kept });
  if ("stop" in lift) return lift.stop;
  /** Said with every later stop: the old server is no longer protected against deletion. */
  const unprotected = lift.lifted
    ? ` Delete protection on the old ${words.noun} is already off; \`${FINISH_COMMAND}\` deletes it once you confirm again.`
    : "";

  // 4. The removal: a plan of the root without the old module, bounded to the confirmed preview.
  if (preview.changes.length > 0) {
    const stop = await removeMoveServer(removal, {
      preview,
      notes: [
        ...(warning ? [warning] : []),
        snapshotId !== undefined
          ? `Snapshot: ${texts.snapshotRef(snapshotId)} keeps a copy of the old ${words.noun} (${texts.snapshotBilled}; OpsCrew never deletes it).`
          : "Snapshot: none.",
      ],
      note: `${unprotected}${kept}`,
    });
    if (stop !== undefined) return stop;
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
  const written = await writeFinalFiles(session, finalPlan, layoutOf(session, "switched"), "all");
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

  // 6. The final files in a pull request, with the recovery copy when OpsCrew's local files
  // changed (a failure here does not undo the finished move).
  const branch = finalPlan.cicd.branch;
  const byHand = `commit the changed files under opscrew/ and open a pull request into ${branch} yourself, so the repository describes the new deployment.`;
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
    // A branch check (an earlier run's pull request) stops before anything is committed, and so
    // does a recovery copy another computer updated (restored first, then published by hand).
    const stopped = isUserFacingError(error) && error.code === "PHASE_PRECONDITION";
    const elsewhere = isUserFacingError(error) && error.code === "SECRETS_COPY_CHANGED_ELSEWHERE";
    deps.reporter.warn(
      deps.redactor.redact(
        stopped
          ? `The move is finished, but ${lowerFirst(error.message)}`
          : `The move is finished, but publishing the final files failed: ${reasonOf(error)}.`,
      ),
    );
    publish =
      stopped && error.hint !== undefined
        ? deps.redactor.redact(error.hint)
        : elsewhere && error.hint !== undefined
          ? `${error.hint} Then ${byHand}`
          : upperFirst(byHand);
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
      { hint: START_MOVE_HINT },
    );
  }
  if (move.abort !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The move is being aborted, so it cannot be finished. Nothing was changed.",
      { hint: FINISH_ABORT_HINT },
    );
  }
  if (move.step !== "switched") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Traffic does not go to the new server yet, so the old server cannot be deleted. Nothing was changed.",
      { hint: `Run \`${RUN_COMMAND}\` to continue the move, or \`${ABORT_COMMAND}\` to undo it.` },
    );
  }
  return runPhase(deps, "retarget", async () => {
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
  });
}
