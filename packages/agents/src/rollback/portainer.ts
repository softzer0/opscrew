/**
 * The rollback's snapshot in the user's Portainer (024 plan.md D14, D19): the snapshot taken when
 * the target stopped running, read from the stack's snapshots volume, and once approved restored by
 * this computer before the rollback's run, through `opscrew restore`'s pieces. The switch runs in
 * the workflow, out of this computer's reach, so the restored data is marked for the target
 * (`RESTORED_IMAGE_FILE`): until the rollback ends, the stack starts no other version on it, the
 * workflow's revert after a failed health check included. The mark goes once the run succeeded;
 * when it failed, the copy taken just before goes back first and the version that ran starts again.
 */
import { errorMessage, listText, OpsCrewError } from "@opscrew/core";
import {
  RESTORED_IMAGE_FILE,
  RUNNING_IMAGE_FILE,
  type SnapshotPart,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import { keepSnapshotsOf } from "@opscrew/plan-schema";
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
import type { RollbackRun } from "./run";

/** The target's complete snapshot in the snapshots volume, and the parts it puts back. */
export interface PortainerSnapshot {
  about: About;
  /** The parts the plan has that the snapshot holds a copy of. */
  parts: SnapshotPart[];
}

/** What the rollback learnt of the target's snapshot in the user's Portainer. */
export type PortainerRead =
  | { snapshot: PortainerSnapshot }
  /** Why it is not offered; `unreachable` when this computer could not ask Portainer at all. */
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
  const snap = snapshotRunOf(run);
  let about: About | undefined;
  try {
    const place = await portainerPlace(snap);
    about = (await place.docker.volumeExists(place.volume))
      ? (await readRecord(place, hex))?.about
      : undefined;
  } catch (error) {
    if (!(error instanceof OpsCrewError)) throw error;
    return {
      why: `This computer can't reach ${run.environment}'s Portainer, so OpsCrew offers only to keep the database as it is: the snapshot needs this computer to reach it (the computer that provisioned it, or one restored from the recovery copy, with PORTAINER_API_KEY set).`,
      unreachable: true,
    };
  }
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

/**
 * A put-back that failed once the data had changed: the app stays stopped and the deploys stay
 * paused, so no version runs on it; its message names the copy taken just before.
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
   * restores the snapshot, marks the data for the target and leaves the app stopped for the run.
   * A failure before the copy changed nothing; one after it puts the copy back and starts the app.
   * @throws PutBackFailedError when that put-back fails too.
   */
  leave(): Promise<void>;
  /** Once the run succeeded: removes the mark ({@link finishPortainerRestore}). */
  finish(): Promise<void>;
  /** Once the run failed or never started: {@link undoPortainerRestore}, when leave took a copy. */
  undo(): Promise<string>;
}

/**
 * The restore of `snapshot` (the target's, `hex`, named `words`) for `run`'s rollback, from the
 * image running now (`images.current`) to the target's (`images.target`, which the mark names).
 */
export function portainerRestore(
  run: RollbackRun,
  input: {
    hex: string;
    words: string;
    snapshot: PortainerSnapshot;
    images: { current: string; target: string };
  },
): PortainerRestore {
  const { hex, words, snapshot, images } = input;
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
      } catch (error) {
        await startApp();
        throw new OpsCrewError(
          error instanceof OpsCrewError ? error.code : "COMMAND_FAILED",
          `${errorMessage(error)} So OpsCrew could not copy the current data before the restore; the app runs again.`,
          error instanceof OpsCrewError && error.hint !== undefined ? { hint: error.hint } : {},
        );
      }
      restore.saved = saved;
      try {
        await putBack(snap, place, parts, hex, ran);
        const marked = await box(
          place,
          `umask 077 && printf '%s\\n%s\\n' ${shellQuote(images.target)} ${shellQuote(wayOut(run, saved))} > ${RESTORED_IMAGE_FILE}.tmp && mv ${RESTORED_IMAGE_FILE}.tmp ${RESTORED_IMAGE_FILE}`,
        );
        if (marked.exitCode !== 0) {
          throw failed(`mark the restored data for ${words}`, marked.exitCode);
        }
      } catch (error) {
        const said = errorMessage(error);
        try {
          await putBack(snap, place, parts, saved, ran);
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
    finish: () => finishPortainerRestore(run),
    async undo() {
      if (restore.saved === undefined) return "";
      return undoPortainerRestore(run, restore.saved, images.current);
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
    `The rollback itself succeeded. That file keeps every other version off the restored data: until it is gone from the volume ${place.volume}, the next deploy stops before its release. Check that your Portainer environment runs, then remove it.`,
  );
}

/**
 * Once the rollback's run failed or never started: the app's containers stopped, `.running` naming
 * `image` (the image that ran) again, the copy `saved` taken just before the restore put back and
 * the mark removed, then the app's containers of that image started. Returns what the failure's
 * message says of the data.
 * @throws PutBackFailedError when the copy could not be put back, the app stopped.
 */
export async function undoPortainerRestore(
  run: RollbackRun,
  saved: string,
  image: string,
): Promise<string> {
  const snap = snapshotRunOf(run);
  const putBackAll = async (): Promise<PortainerPlace> => {
    const place = await portainerPlace(snap);
    const record = await readRecord(place, saved);
    if (record === undefined) {
      throw new OpsCrewError("COMMAND_FAILED", `Your Portainer has no snapshot ${saved}.`);
    }
    const containers = await stackContainers(place);
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
    await putBack(snap, place, partsOf(run, record.about), saved, ran);
    const unmarked = await box(place, `rm -f ${RESTORED_IMAGE_FILE}`);
    if (unmarked.exitCode !== 0) throw failed(`remove ${RESTORED_IMAGE_FILE}`, unmarked.exitCode);
    return place;
  };
  let place: PortainerPlace;
  try {
    place = await putBackAll();
  } catch (error) {
    await audit(run, `the put-back of ${saved} failed`);
    throw putBackFailed(run, "The rollback", errorMessage(error), saved);
  }
  const want = hexOf(image);
  const again = appContainers(snap, await stackContainers(place)).filter(
    (container) => hexOf(container.image) === want,
  );
  for (const container of again) await place.docker.startContainer(container.id);
  await audit(run, `put back as it was (${saved})`);
  const back = `OpsCrew put the data back as it was before the rollback (the snapshot ${saved})`;
  return again.length > 0
    ? `${back} and started the version that ran again.`
    : `${back}, but your Portainer has no container of the version that ran left, so the app stays stopped: redeploy the stack ${place.stack} in Portainer.`;
}
