import { rm } from "node:fs/promises";
import { isUserFacingError, listText, lowerFirst, OpsCrewError, upperFirst } from "@opscrew/core";
import {
  isCloudProvider,
  isServerlessTarget,
  type PortainerDeployTarget,
  readArtifact,
} from "@opscrew/plan-schema";
import { resumeCheck } from "../check/provision";
import type { PhaseDeps } from "../context";
import {
  forgetHostKeys,
  readSnapshotRecord,
  remainingAfterDeletion,
  removeSnapshotRecord,
} from "../destroy/deletion";
import { deleteDeployBranch } from "../destroy/portainer";
import { commandFlags } from "../environments/choice";
import { publishDeploySetup } from "../provision";
import { previousBucketKeyFile } from "../provision/storage";
import { deployBranchOf, readOldOwnServer, trackedFiles } from "../shared";
import { reasonOf } from "../shared/errors";
import { runPhase } from "../shared/phase-status";
import { deleteOldBucket, movingBucketKeys, writeStorageFiles } from "./bucket";
import { previousCloud, previousTarget } from "./layouts";
import { endMoveKey, leaveMoveNetwork } from "./network";
import { clearPending } from "./pending";
import { endMoveServers } from "./servers";
import {
  auditStep,
  layoutOf,
  type MoveSession,
  moveOf,
  openSession,
  planFilePath,
  savePlan,
  warnUnusedApproval,
  writeFinalFiles,
} from "./session";
import { cloudProviders, moveSide, placeWords, sideWords } from "./sides";
import { finishSiteMove } from "./site-end";
import { requireSwitchSettled } from "./switch";
import {
  ABORT_COMMAND,
  FINISH_ABORT_HINT,
  FINISH_COMMAND,
  RUN_COMMAND,
  START_MOVE_HINT,
} from "./texts";
import type { FinishRetargetOptions, RetargetResult } from "./types";

/** Paths among `paths` that git tracks (a deleted tracked file is staged with `git add`). */
async function trackedPaths(session: MoveSession, paths: readonly string[]): Promise<string[]> {
  const tracked = new Set(await trackedFiles(session.deps, paths));
  return paths.filter((path) => tracked.has(path));
}

/** The snapshot the old cloud server's removal took (or an earlier run took), from its record. */
async function takenSnapshot(session: MoveSession): Promise<string | undefined> {
  const recorded = await readSnapshotRecord(session.deps, "retarget", undefined);
  return recorded?.provider === previousCloud(moveOf(session)).provider
    ? recorded.snapshotId
    : undefined;
}

/**
 * `--finish`'s removal of the old side, through the side's `remove` after the typed app name: a
 * cloud server (a snapshot first when wanted), only the app on the user's own server (a teardown
 * host plan), only the app's stacks and volumes in their Portainer. Never the user's server,
 * Portainer or its environment (SC-2304). Without a `confirm` hook nothing is confirmed, so nothing
 * is deleted. Returns a script's stop, else the snapshot a cloud side kept.
 */
export async function removeOldSide(
  session: MoveSession,
  options: Pick<FinishRetargetOptions, "snapshot" | "confirm">,
): Promise<{ stop: RetargetResult } | { snapshotId: string | undefined }> {
  const side = moveSide(
    session,
    "old",
    options.snapshot !== undefined ? { snapshot: options.snapshot } : {},
  );
  const stop = await side.remove(session, options.confirm ?? (async () => false));
  if (stop !== undefined) return { stop };
  return { snapshotId: side.kind === "cloud" ? await takenSnapshot(session) : undefined };
}

/**
 * After a move from Portainer: deletes the deploy branch the old side's stack was built from,
 * behind a `git-push` approval of its own. Returns what remains when it stays: refused, or GitHub
 * failed (a warning says so; the move is finished either way).
 */
export async function deleteOldDeployBranch(
  session: MoveSession,
  from: PortainerDeployTarget,
): Promise<string | undefined> {
  const { deps, github } = session;
  const plan = { ...session.plan, target: from };
  const deleted = await deleteDeployBranch(
    deps,
    { api: session.githubApi, owner: github.owner, repo: github.repo },
    plan,
    { phase: "retarget", ask: true },
  );
  if (deleted) return undefined;
  const branch = deployBranchOf(plan);
  return `The branch ${branch} of ${github.owner}/${github.repo}, from which your Portainer built the app's stack: delete it on GitHub (or with \`git push origin --delete ${branch}\`).`;
}

async function finish(
  session: MoveSession,
  options: FinishRetargetOptions,
): Promise<RetargetResult> {
  const { deps } = session;
  const move = moveOf(session);
  const app = session.plan.app.name;
  const from = move.from.target;
  const fresh = session.plan.target;
  const old = sideWords(from, "old");
  const cloud = isCloudProvider(from.provider);

  // 0. The new side must answer through the app's URL (edge started, URL checked); else the old
  // side is kept. `switched` is recorded right after the DNS switch, before this check.
  await requireSwitchSettled(session);
  // Both buckets' keys when the move took the bucket along, before anything is deleted.
  const keys = await movingBucketKeys(session);

  // 0b. The old app server leaves the private network of the servers that stay.
  const left = await leaveMoveNetwork(session);
  if (left !== undefined) return left;

  // 1. The old side's removal, after the typed name.
  const removed = await removeOldSide(session, options);
  if ("stop" in removed) return removed.stop;
  const { snapshotId } = removed;
  const gone = cloud
    ? `${old} is deleted`
    : `the app is removed from ${from.provider === "own" ? old : "your Portainer"}`;

  // 1b. The bucket the move took along: the one being left, after its own typed name (FR-2311).
  const bucket = keys === undefined ? { remaining: [] } : await deleteOldBucket(session, keys);
  if ("stop" in bucket) return bucket.stop;

  // 2. Cleanup: host keys, the Portainer deploy branch, final files, plan, snapshot record, phase.
  const remaining: string[] = [...bucket.remaining];
  // The devices' configurations name the old app server, with its key and address.
  const devices = session.plan.network?.devices.map((device) => device.name) ?? [];
  if (move.from.member !== undefined && devices.length > 0) {
    const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
    remaining.push(
      `The WireGuard configurations of your devices (${listText(devices)}) name the old app server, which is gone: get each device a new one with \`opscrew vpn add <device> --again${flag}\` and import it in its WireGuard app.`,
    );
  }
  if (from.provider === "portainer") {
    const branch = await deleteOldDeployBranch(session, from);
    if (branch !== undefined) remaining.push(branch);
  } else if (session.servers.from === undefined) {
    // Host keys are pinned by address; without it they cannot be told from the new server's.
    deps.reporter.info(
      `OpsCrew no longer knows the address of ${old} on this computer, so its SSH host key stays in OpsCrew's known_hosts (${deps.paths.files.knownHosts}). It is harmless; you can delete its lines there.`,
    );
  } else if (
    (await forgetHostKeys(deps, [
      session.servers.from.ipv4,
      session.servers.from.ipv6,
      // The user's own old server: its admin login's host too, where OpsCrew pinned its key.
      ...(from.provider === "own" ? [(await readOldOwnServer(deps.paths))?.host] : []),
    ])) > 0
  ) {
    deps.reporter.info(`Removed the SSH host key of ${old} from OpsCrew's known_hosts.`);
  }
  const { retarget: _finished, ...finalPlan } = session.plan;
  const written = await writeFinalFiles(session, finalPlan, layoutOf(session, "switched"), "all");
  const storage = keys === undefined ? [] : await writeStorageFiles(session, finalPlan);
  await endMoveKey(deps, move, "finished");
  await savePlan(session, finalPlan);
  await removeSnapshotRecord(deps, "retarget");
  await clearPending(deps);
  // A run killed while the engine ran may have left the key of the bucket being left there.
  await rm(previousBucketKeyFile(deps.paths), { force: true });
  await endMoveServers(deps, session.servers.next);
  const place = placeWords(fresh);
  await deps.state.markPhase("retarget", "ok", `moved to ${place}`);
  if (cloud) {
    const { provider, backups } = previousTarget(move);
    remaining.unshift(...remainingAfterDeletion({ provider, app, snapshotId, backups }));
  }
  await auditStep(
    session,
    "finished",
    `${gone}${snapshotId !== undefined ? `, snapshot ${snapshotId} kept` : ""}; the deployment runs on ${fresh.provider}`,
  );
  deps.reporter.success(`The move of ${app} to ${place} is finished; ${gone}.`);
  // The scheduled check watches the app again (it was paused for the maintenance window).
  await resumeCheck(deps, session.github, finalPlan, {
    command: "opscrew provision",
    phase: "retarget",
  });

  // 3. The final files in a pull request, with the recovery copy when OpsCrew's local files
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
        ...storage.map((file) => file.path),
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
 * `opscrew retarget --finish` (only after the switch): checks that the new side serves the app,
 * removes the old side after the typed app name (a cloud server with its snapshot first when
 * wanted; only the app on the user's own server or in their Portainer, never the server or the
 * environment), forgets the old server's host key or deletes the old Portainer deploy branch,
 * writes the final files and publishes them in a pull request, and clears the move from
 * `opscrew/plan.yaml`.
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
  // A site's move between site hosts finishes in steps of its own (plan.md "6.").
  if (isServerlessTarget(plan.target)) return finishSiteMove(deps, plan, options);
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
      providers: cloudProviders({ plan }),
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
