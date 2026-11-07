/**
 * The rollback's snapshot in the user's Portainer (024 plan.md D14, D19): the snapshot taken when
 * the target stopped running, read from the stack's snapshots volume, and once approved restored by
 * this computer before the rollback's run, through `opscrew restore`'s pieces. The switch runs in
 * the workflow, out of this computer's reach, so the restored data is marked for the target
 * (`RESTORED_IMAGE_FILE`, with the way out of a stuck rollback on its second line): until the
 * rollback ends, the stack starts no other version on it, the workflow's revert after a failed
 * health check included. The mark goes once the run succeeded; when it failed, the copy taken just
 * before goes back first and the version that ran starts again.
 */
import { errorMessage, listText, OpsCrewError } from "@opscrew/core";
import {
  PORTAINER_COMPOSE_FILE,
  portainerDeployBranch,
  RESTORED_IMAGE_FILE,
  RUNNING_IMAGE_FILE,
  type SnapshotPart,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import { keepSnapshotsOf } from "@opscrew/plan-schema";
import { NOTHING_CHANGED } from "../promote/shared";
import {
  box,
  failed,
  type PortainerPlace,
  portainerPlace,
  portainerTake,
  stackContainers,
} from "../snapshot/portainer";
import { appContainers, probeFree, putBack, readRecord } from "../snapshot/restore-portainer";
import type { SnapshotRun } from "../snapshot/run";
import type { About } from "../snapshot/store";
import { hexOf } from "./database";
import type { RollbackRepository, RollbackRun } from "./run";

/** The target's complete snapshot in the snapshots volume, and the parts it puts back. */
export interface PortainerSnapshot {
  about: About;
  /** The parts the plan has that the snapshot holds a copy of. */
  parts: SnapshotPart[];
}

/** What the rollback learnt of the target's snapshot in the user's Portainer. */
export type PortainerRead =
  | { snapshot: PortainerSnapshot }
  /** Why it is not offered; `unreachable` when this computer could not connect to Portainer. */
  | { why: string; unreachable?: true };

/** `run` as the snapshot commands reach the user's Portainer. */
function snapshotRunOf(run: RollbackRun): SnapshotRun {
  const { deps, plan, environment, flags, services } = run;
  return {
    deps,
    plan,
    environment,
    flags,
    services: services.portainer === undefined ? {} : { portainer: services.portainer },
  };
}

/**
 * The snapshots volume through Portainer, or `undefined` when this computer can't connect to it (no
 * connection or key recorded here, or no answer): only these errors mean it can't reach Portainer.
 */
async function reachVolume(
  run: RollbackRun,
): Promise<{ place: PortainerPlace; exists: boolean } | undefined> {
  try {
    const place = await portainerPlace(snapshotRunOf(run));
    return { place, exists: await place.docker.volumeExists(place.volume) };
  } catch (error) {
    if (error instanceof OpsCrewError) return undefined;
    throw error;
  }
}

/** The parts of `about` that the plan still has, each with its copy in the snapshot. */
function partsOf(run: RollbackRun, about: About): SnapshotPart[] {
  const copied = new Set(
    about.services.filter((entry) => "file" in entry).map((entry) => entry.name),
  );
  return snapshotParts(run.plan).filter((part) => copied.has(part.name));
}

/**
 * Reads the snapshot `hex` (the target's digest, the name of the snapshot taken when it stopped
 * running) in the stack's snapshots volume, read-only: offered only when it is complete (its
 * `about.json`, no part failed, the target's version) and holds a copy of a part the plan has.
 */
export async function readPortainerSnapshot(
  run: RollbackRun,
  hex: string,
  words: string,
): Promise<PortainerRead> {
  const reached = await reachVolume(run);
  if (reached === undefined) {
    return {
      why: `This computer can't reach ${run.environment}'s Portainer, so OpsCrew offers only to keep the database as it is: the snapshot needs this computer to reach it (the computer that provisioned it, or one restored from the recovery copy, with PORTAINER_API_KEY set).`,
      unreachable: true,
    };
  }
  const about = reached.exists ? (await readRecord(reached.place, hex))?.about : undefined;
  if (about === undefined) {
    return {
      why: `Your Portainer keeps no complete snapshot of ${words}: a deploy takes one when it replaces a version, and keeps those of the last ${keepSnapshotsOf(run.plan)}.`,
    };
  }
  const lost = about.services.filter((entry) => "failed" in entry).map((entry) => entry.name);
  if (lost.length > 0) {
    return {
      why: `The snapshot of ${words} in your Portainer is incomplete: the copy of ${listText(lost)} failed.`,
    };
  }
  if (about.version !== `sha256:${hex}`) {
    return {
      why: `The snapshot ${hex} in your Portainer records another version (${about.version === "" ? "none" : about.version}) than ${words}, so its data may not fit it.`,
    };
  }
  const parts = partsOf(run, about);
  if (parts.length === 0) {
    return {
      why: `The snapshot of ${words} in your Portainer holds no copy of any service ${run.environment} has now.`,
    };
  }
  return { snapshot: { about, parts } };
}

/** The mark on data a rollback restored: the image it is for, and the way out of a stuck one. */
export interface RestoredMark {
  image: string;
  /** The command that gets a stuck rollback out (the mark's second line). */
  wayOut: string;
}

/** Writes the mark naming `mark.image` and `mark.wayOut`, whole or not at all. */
function markScript(mark: RestoredMark): string {
  return `umask 077 && printf '%s\\n%s\\n' ${shellQuote(mark.image)} ${shellQuote(mark.wayOut)} > ${RESTORED_IMAGE_FILE}.tmp && mv ${RESTORED_IMAGE_FILE}.tmp ${RESTORED_IMAGE_FILE}`;
}

/**
 * The mark in the stack's snapshots volume, read-only; `undefined` without one, or when this
 * computer can't reach the user's Portainer (the stack's guard then still holds).
 */
export async function readMark(run: RollbackRun): Promise<RestoredMark | undefined> {
  const reached = await reachVolume(run);
  if (reached?.exists !== true) return undefined;
  const read = await box(
    reached.place,
    `if [ -f ${RESTORED_IMAGE_FILE} ]; then echo mark; cat ${RESTORED_IMAGE_FILE}; fi`,
    { readOnly: true },
  );
  if (read.exitCode !== 0) throw failed(`read ${RESTORED_IMAGE_FILE}`, read.exitCode);
  const [first, image = "", wayOut = ""] = read.stdout.split(/\r?\n/);
  return first === "mark" ? { image, wayOut } : undefined;
}

/**
 * A put-back that failed once the data had changed: the app stays stopped and the deploys stay
 * paused, so no version runs on it; its message names the way out, which the mark names too.
 */
export class PutBackFailedError extends OpsCrewError {}

/**
 * The way out of a rollback stuck on restored data: the restore of the copy `saved` taken just
 * before, which puts the data from before back and removes the mark.
 */
function wayOut(run: RollbackRun, saved: string): string {
  return `opscrew restore ${saved}${run.flags}`;
}

/** The refusal after `what` failed (`said`) and putting the copy `saved` back failed too. */
function putBackFailed(run: RollbackRun, what: string, said: string, saved: string) {
  const { environment, command } = run;
  return new PutBackFailedError(
    "COMMAND_FAILED",
    `${what} failed (${said.replace(/\.$/, "")}), and putting back the data as it was before the rollback failed too, so it may be partly changed. The app stays stopped in your Portainer and ${environment}'s deploys stay paused, so no version runs on it. The copy from just before the rollback is the snapshot ${saved} in your Portainer.`,
    {
      hint: `Once the cause is fixed, run \`${wayOut(run, saved)}\`: it puts that copy back and removes ${RESTORED_IMAGE_FILE}. Then run \`${command} --resume\` and redeploy the stack in Portainer.`,
    },
  );
}

/** Audits a step of the restore in the user's Portainer. */
function audit(run: RollbackRun, detail: string) {
  return run.deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "restore a snapshot for a rollback",
    target: "portainer",
    decision: "approved",
    detail,
  });
}

/** The restore of the target's snapshot in the user's Portainer, once the rollback is approved. */
export interface PortainerRestore {
  /** The copy of the data taken just before the restore, once {@link leave} took it. */
  saved?: string;
  /**
   * Before the dispatch, with the deploys paused: stops the app, copies its data as it is now,
   * marks the data for the target, restores the snapshot and leaves the app stopped for the run.
   * A failure before the copy changed nothing; one after it puts the copy back, then removes the
   * mark and starts the app.
   * @throws PutBackFailedError when that put-back fails too: the mark stays, naming the way out.
   */
  leave(): Promise<void>;
  /** Once the run failed or never started: {@link undoPortainerRestore}, when leave took a copy. */
  undo(): Promise<string>;
  /**
   * Once a pending record follows a run OpsCrew lost track of: the mark's way out becomes
   * `command`, the rollback that follows that run and then removes the mark or puts the copy back.
   * A rewrite that fails is said; the mark then still names the copy's restore.
   */
  followedBy(command: string): Promise<void>;
}

/**
 * The restore of `snapshot` (the target's, `hex`, named `words`) for `run`'s rollback, from the
 * image running now (`images.current`) to the target's (`images.target`, which the mark names);
 * `github` is the repository whose deploy branch the undo reads.
 */
export function portainerRestore(
  run: RollbackRun,
  input: {
    hex: string;
    words: string;
    snapshot: PortainerSnapshot;
    images: { current: string; target: string };
    github: RollbackRepository;
  },
): PortainerRestore {
  const { hex, words, snapshot, images, github } = input;
  const { parts } = snapshot;
  const names = parts.map((part) => part.name).join(", ");
  const restore: PortainerRestore = {
    async leave() {
      const snap = snapshotRunOf(run);
      const place = await portainerPlace(snap);
      const { saved, probed } = await probeFree(snap, place, hex);
      const containers = await stackContainers(place);
      const ran = new Set(
        containers
          .filter((container) => container.state === "running")
          .map((container) => container.id),
      );
      const app = appContainers(snap, containers).filter((container) => ran.has(container.id));
      const startApp = async () => {
        for (const container of app) await place.docker.startContainer(container.id);
      };
      run.deps.reporter.step(
        `Restoring the snapshot of ${words} in your Portainer: the app stops until the rollback starts ${words}`,
      );
      try {
        for (const container of app) await place.docker.stopContainer(container.id);
        await portainerTake(snap, place, { id: saved, version: probed.version, parts });
        // The mark first: from here on no other version starts on this data.
        const marked = await box(
          place,
          markScript({ image: images.target, wayOut: wayOut(run, saved) }),
        );
        if (marked.exitCode !== 0) {
          throw failed(`mark the data for ${words}`, marked.exitCode);
        }
      } catch (error) {
        await startApp();
        throw new OpsCrewError(
          error instanceof OpsCrewError ? error.code : "COMMAND_FAILED",
          `${errorMessage(error)} So OpsCrew could not copy and mark the current data before the restore; the app runs again.`,
          error instanceof OpsCrewError && error.hint !== undefined ? { hint: error.hint } : {},
        );
      }
      restore.saved = saved;
      try {
        await putBack(snap, place, parts, hex, ran);
      } catch (error) {
        const said = errorMessage(error);
        try {
          await putBack(snap, place, parts, saved, ran);
          // Only once the copy is back.
          const unmarked = await box(place, `rm -f ${RESTORED_IMAGE_FILE}`);
          if (unmarked.exitCode !== 0) {
            throw failed(`remove ${RESTORED_IMAGE_FILE}`, unmarked.exitCode);
          }
        } catch {
          await audit(run, `${hex}: ${names}: failed, and its put-back failed too (${saved})`);
          throw putBackFailed(run, `Restoring the snapshot of ${words}`, said, saved);
        }
        await startApp();
        await audit(run, `${hex}: ${names}: failed, put back as it was (${saved})`);
        throw new OpsCrewError(
          "COMMAND_FAILED",
          `Restoring the snapshot of ${words} failed (${said.replace(/\.$/, "")}), so OpsCrew put the data back as it was (the snapshot ${saved}), and the app runs again.`,
          { hint: "Fix what it names, then try again." },
        );
      }
      await audit(run, `${hex}: ${names}: restored for the rollback to ${images.target}`);
    },
    async undo() {
      if (restore.saved === undefined) return "";
      return undoPortainerRestore(run, github, restore.saved, images.current);
    },
    async followedBy(command) {
      const failure = await portainerPlace(snapshotRunOf(run))
        .then((place) => box(place, markScript({ image: images.target, wayOut: command })))
        .then((marked) =>
          marked.exitCode === 0
            ? undefined
            : failed(`rewrite ${RESTORED_IMAGE_FILE}`, marked.exitCode).message,
        )
        .catch((error: unknown) => errorMessage(error));
      if (failure === undefined) return;
      run.deps.reporter.warn(
        `${failure} Its way out stays \`${wayOut(run, restore.saved ?? "")}\`, which works once the run failed; \`${command}\` follows the run either way.`,
      );
    },
  };
  return restore;
}

/** Once the rollback's run succeeded: removes the mark, so the next deploy runs as usual. */
export async function finishPortainerRestore(run: RollbackRun): Promise<void> {
  const place = await portainerPlace(snapshotRunOf(run));
  const removed = await box(place, `rm -f ${RESTORED_IMAGE_FILE}`);
  if (removed.exitCode === 0) return;
  throw failed(
    `remove ${RESTORED_IMAGE_FILE}`,
    removed.exitCode,
    `The rollback itself succeeded; until that file is gone, the next deploy stops before its release. Check that your Portainer environment runs, then run \`${run.command}\` again: it removes the file and records the rollback.`,
  );
}

/** True when the deploy branch's `compose.yaml` names the image `image` (by its digest). */
async function branchNames(run: RollbackRun, github: RollbackRepository, image: string) {
  const digest = image.slice(image.lastIndexOf("@") + 1);
  const branch = portainerDeployBranch(run.plan);
  try {
    const text = await github.api.fileText(
      github.owner,
      github.repo,
      PORTAINER_COMPOSE_FILE,
      branch,
    );
    return text?.includes(`@${digest}`) === true;
  } catch {
    // Unread, it may name another version: the mark then keeps that one off the data.
    return false;
  }
}

/**
 * Once the rollback's run failed or never started:
 * 1. what is there is read, changing nothing; a failure here says so, and the next
 *    `opscrew rollback` tries again;
 * 2. the app's containers stop, `.running` names `image` (the image that ran) again, and the copy
 *    `saved` taken just before the restore goes back;
 * 3. the mark goes when the deploy branch names `image`; otherwise (the workflow's revert was
 *    cancelled or could not push) it is rewritten for `image`, its way out the rollback to it,
 *    which writes it back to the branch;
 * 4. the app's containers of that image start.
 *
 * Returns what the failure's message says of the data.
 * @throws PutBackFailedError when step 2 or 3 failed, the app stopped and the mark kept.
 */
export async function undoPortainerRestore(
  run: RollbackRun,
  github: RollbackRepository,
  saved: string,
  image: string,
): Promise<string> {
  const snap = snapshotRunOf(run);
  let read: {
    place: PortainerPlace;
    about: About;
    containers: Awaited<ReturnType<typeof stackContainers>>;
  };
  try {
    const place = await portainerPlace(snap);
    const record = await readRecord(place, saved);
    if (record === undefined) {
      throw new OpsCrewError("COMMAND_FAILED", `Your Portainer has no snapshot ${saved}.`);
    }
    read = { place, about: record.about, containers: await stackContainers(place) };
  } catch (error) {
    throw new OpsCrewError(
      error instanceof OpsCrewError ? error.code : "COMMAND_FAILED",
      `${errorMessage(error).replace(` ${NOTHING_CHANGED}`, "")} So OpsCrew did not put back the data from before the rollback yet (the snapshot ${saved}), and the app stays stopped. ${NOTHING_CHANGED}`,
      { hint: `Once the cause is fixed, run \`${run.command}\` again: it puts that data back.` },
    );
  }
  const { place, containers } = read;
  const onBranch = await branchNames(run, github, image);
  const digest = image.slice(image.lastIndexOf("@") + 1);
  const back = `${run.command} --to ${digest} --database keep`;
  try {
    const ran = new Set(
      containers
        .filter((container) => container.state === "running")
        .map((container) => container.id),
    );
    for (const container of appContainers(snap, containers)) {
      if (ran.has(container.id)) await place.docker.stopContainer(container.id);
    }
    // `.running` first: the mark keeps every version off the data meanwhile, and once a put-back
    // failed, `opscrew restore` of the copy finds the version it was taken with.
    const reset = await box(
      place,
      `printf '%s\\n' ${shellQuote(image)} > ${RUNNING_IMAGE_FILE}.tmp && mv ${RUNNING_IMAGE_FILE}.tmp ${RUNNING_IMAGE_FILE}`,
    );
    if (reset.exitCode !== 0) {
      throw failed("name the version that ran in the snapshots volume", reset.exitCode);
    }
    await putBack(snap, place, partsOf(run, read.about), saved, ran);
    const unmarked = await box(
      place,
      onBranch ? `rm -f ${RESTORED_IMAGE_FILE}` : markScript({ image, wayOut: back }),
    );
    if (unmarked.exitCode !== 0) {
      throw failed(`${onBranch ? "remove" : "rewrite"} ${RESTORED_IMAGE_FILE}`, unmarked.exitCode);
    }
  } catch (error) {
    await audit(run, `the put-back of ${saved} failed`);
    throw putBackFailed(run, "The rollback", errorMessage(error), saved);
  }
  const want = hexOf(image);
  const again = appContainers(snap, await stackContainers(place)).filter(
    (container) => hexOf(container.image) === want,
  );
  for (const container of again) await place.docker.startContainer(container.id);
  await audit(run, `put back as it was (${saved})${onBranch ? "" : `, marked for ${image}`}`);
  const said = `OpsCrew put the data back as it was before the rollback (the snapshot ${saved})`;
  const started =
    again.length > 0
      ? `${said} and started the version that ran again.`
      : `${said}, but your Portainer has no container of the version that ran left, so the app stays stopped${onBranch ? `: redeploy the stack ${place.stack} in Portainer` : ""}.`;
  if (onBranch) return started;
  const branch = portainerDeployBranch(run.plan);
  return `${started} The deploy branch ${branch} still names the version the rollback went to (the workflow's revert was cancelled or could not push), so OpsCrew marked the data for the version that ran: no other version starts on it. To write that version back to the branch, run \`${back}\`, or write the compose.yaml of the commit before the newest one back to ${branch} by hand.`;
}
