/**
 * `opscrew restore` in the user's Portainer (024 plan.md 4. and 6., D14), through its Docker API as
 * Portainer's snapshots are taken: the snapshot's record and the running version read from the
 * snapshots volume, the images from the stack's containers; once approved, the app's web, workers
 * and cron stop, the parts restored are copied as they are now (a snapshot by hand), and each part
 * is put back exactly as `partRestore` says (stop-only kinds stopped cleanly, put back by a busybox
 * one-off, started again; the databases loaded by a one-off of their own image with their
 * secrets), then the app starts. A restore that fails puts that copy back; when that fails too, the
 * app stays stopped and the message says where the copy is.
 */
import type { DockerContainer, MountSpec } from "@opscrew/connector-docker";
import type { GitHubClient } from "@opscrew/connector-github";
import { COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import { errorMessage, listText, OpsCrewError } from "@opscrew/core";
import {
  FILES_VOLUME,
  PORTAINER_COMPOSE_FILE,
  partRestore,
  portainerDeployBranch,
  portainerServiceEnvironment,
  processServices,
  RESTORED_IMAGE_FILE,
  type SnapshotPart,
  SQLITE_VOLUME,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { appFlag } from "../apps/choice";
import { NOTHING_CHANGED } from "../promote/shared";
import { shortDigest } from "../rollback/versions";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import { lowDisk } from "./disk";
import {
  box,
  DIR,
  failed,
  ofService,
  type PortainerPlace,
  type PortainerProbe,
  portainerPlace,
  portainerProbe,
  portainerTake,
  secretsFile,
  serviceOneOff,
  stackContainers,
  stackValues,
  stopCleanly,
  volumesOf,
  waitReady,
} from "./portainer";
import {
  approveRestore,
  checkImages,
  checkVersion,
  chooseParts,
  type Holder,
  type RestoredSnapshot,
  type RestoreSnapshotOptions,
} from "./restore-checks";
import {
  type BucketAbout,
  bucketAbout,
  bucketServers,
  copyToPortainer,
  offsiteBucket,
  type RestoreServices,
} from "./restore-offsite";
import type { SnapshotRun } from "./run";
import { aboutOf, snapshotIdAt } from "./store";

/**
 * The mark a rollback leaves on data it restored ({@link RESTORED_IMAGE_FILE}, 024 plan.md D19):
 * the image it is for, and the way out of a stuck rollback.
 */
export interface RestoredMark {
  image: string;
  /** The command that gets a stuck rollback out (the mark's second line). */
  wayOut: string;
  /**
   * The third line, `restored`: the data is the image's snapshot, whole, so the keep rollback to
   * that image may go ahead on it.
   */
  restored?: true;
}

/** Writes the mark, whole or not at all. */
export function markScript(mark: RestoredMark): string {
  const restored = mark.restored === true ? " restored" : "";
  return `umask 077 && printf '%s\\n' ${shellQuote(mark.image)} ${shellQuote(mark.wayOut)}${restored} > ${RESTORED_IMAGE_FILE}.tmp && mv ${RESTORED_IMAGE_FILE}.tmp ${RESTORED_IMAGE_FILE}`;
}

/** The mark in the snapshots volume (which exists), read-only; `undefined` without one. */
export async function readMarkIn(place: PortainerPlace): Promise<RestoredMark | undefined> {
  const read = await box(
    place,
    `if [ -f ${RESTORED_IMAGE_FILE} ]; then echo mark; cat ${RESTORED_IMAGE_FILE}; fi`,
    { readOnly: true },
  );
  if (read.exitCode !== 0) throw failed(`read ${RESTORED_IMAGE_FILE}`, read.exitCode);
  const [first, image = "", wayOut = "", third] = read.stdout.split(/\r?\n/);
  if (first !== "mark") return undefined;
  return { image, wayOut, ...(third === "restored" ? { restored: true as const } : {}) };
}

/**
 * True when the deploy branch's `compose.yaml` names `image` (by its digest), which Portainer
 * deploys; false when it names another or can't be read (`api` without `fileText` included).
 */
export async function deployBranchNames(
  plan: DeployPlan,
  github: { api: Partial<Pick<GitHubClient, "fileText">>; owner: string; repo: string },
  image: string,
): Promise<boolean> {
  const digest = image.slice(image.lastIndexOf("@") + 1);
  try {
    const text = await github.api.fileText?.(
      github.owner,
      github.repo,
      PORTAINER_COMPOSE_FILE,
      portainerDeployBranch(plan),
    );
    return text?.includes(`@${digest}`) === true;
  } catch {
    // Unread, it may name another version: the caller keeps that one off the data.
    return false;
  }
}

/** The record of the snapshot `id` in the volume (`about <json>`), when it is complete. */
export async function readRecord(
  place: PortainerPlace,
  id: string,
): Promise<BucketAbout | undefined> {
  const script = [
    `if [ -f ${DIR}/${id}/about.json ]; then printf 'about '; cat ${DIR}/${id}/about.json; fi`,
    "exit 0",
  ].join("\n");
  const result = await box(place, script, { readOnly: true });
  if (result.exitCode !== 0) throw failed("read its snapshots", result.exitCode);
  const text = /^about (\{.*\})$/m.exec(result.stdout)?.[1];
  const about = text === undefined ? undefined : aboutOf(text);
  return about?.id === id && text !== undefined ? { about, text } : undefined;
}

/**
 * The volume's probe with a free id for the copy taken just before a restore: the clock's second,
 * or the next one that neither holds a snapshot nor is `restoring`.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the volume's disk is too low for the copy.
 */
export async function probeFree(
  run: SnapshotRun,
  place: PortainerPlace,
  restoring: string,
): Promise<{ saved: string; probed: PortainerProbe }> {
  const { clock } = run.deps;
  let saved = snapshotIdAt(clock.now());
  let probed = await portainerProbe(place, saved);
  for (let second = 1; saved === restoring || probed.taken; second++) {
    saved = snapshotIdAt(new Date(clock.now().getTime() + second * 1000));
    probed = await portainerProbe(place, saved);
  }
  const low = lowDisk(probed.disk, "in your Portainer");
  if (low !== undefined) throw low;
  return { saved, probed };
}

/** The app stack's volume of each part of the app's own: SQLite's and the kept folder's. */
const APP_VOLUMES: Partial<Record<SnapshotPart["kind"], string>> = {
  sqlite: SQLITE_VOLUME,
  files: FILES_VOLUME,
};

/** The image the first container of each service in `containers` runs, by service. */
export function imagesOf(containers: readonly DockerContainer[]): Map<string, string> {
  const images = new Map<string, string>();
  for (const container of containers) {
    const service = container.labels[COMPOSE_SERVICE_LABEL];
    if (service !== undefined && !images.has(service)) images.set(service, container.image);
  }
  return images;
}

/**
 * Puts each of `parts` back from the snapshot `from` (`partRestore`): a part that stops has its
 * containers that ran before the restore (`ran`) stopped cleanly, put back by a busybox one-off
 * with its volumes read-write and the snapshots volume read-only, started again and waited for;
 * `load` runs in a one-off of the service's image with its secrets on the stack's network.
 */
export async function putBack(
  run: SnapshotRun,
  place: PortainerPlace,
  parts: readonly SnapshotPart[],
  from: string,
  ran: ReadonlySet<string>,
): Promise<void> {
  const { plan } = place;
  const values = await stackValues(run);
  for (const part of parts) {
    const restore = partRestore(part);
    const file = `${DIR}/${from}/${part.file}`;
    const containers = ofService(await stackContainers(place), part.name);
    const appVolume = APP_VOLUMES[part.kind];
    const mounts: MountSpec[] =
      appVolume !== undefined
        ? [{ type: "volume", source: `${place.stack}_${appVolume}`, target: "/data" }]
        : volumesOf(containers).map((mount) => ({ ...mount, readOnly: false }));
    const started = containers.filter((container) => ran.has(container.id));
    if (restore.stop) {
      await stopCleanly(
        place,
        part,
        started.filter((container) => container.state === "running"),
        "restore its files",
      );
    }
    if (restore.put !== undefined) {
      const put = await box(place, restore.put(file), { readOnly: true, mounts });
      if (put.exitCode !== 0) throw failed(`put back the files of ${part.name}`, put.exitCode);
    }
    if (restore.stop) {
      for (const container of started) await place.docker.startContainer(container.id);
      await waitReady(run, place, part, started);
    }
    if (restore.load !== undefined) {
      const service = plan.services.find((each) => each.name === part.name);
      if (service === undefined || part.image === undefined) {
        throw new OpsCrewError("INTERNAL", `The plan has no service ${part.name} to load.`, {
          hint: "This is a bug in OpsCrew; please report it.",
        });
      }
      const loaded = await serviceOneOff(place, {
        name: part.name,
        image: part.image,
        script: restore.load(file),
        secrets: secretsFile(run, portainerServiceEnvironment(plan, service), values, part.name),
        mounts: [{ type: "volume", source: place.volume, target: DIR, readOnly: true }],
        network: `${place.stack}_internal`,
      });
      if (loaded.exitCode !== 0) {
        throw failed(
          `restore ${part.name} (its output can quote data, so it is not shown)`,
          loaded.exitCode,
          `Check that ${part.name} runs in your Portainer (the stack ${place.stack}), then try again.`,
        );
      }
    }
    if (restore.after !== undefined) {
      const after = await box(place, restore.after, { readOnly: true, mounts });
      if (after.exitCode !== 0) throw failed(`finish the restore of ${part.name}`, after.exitCode);
    }
  }
}

/** The app's web, workers and cron among the stack's containers, which use its data. */
export function appContainers(run: SnapshotRun, containers: readonly DockerContainer[]) {
  const names = ["app", ...processServices(run.plan)];
  return containers.filter((container) =>
    names.includes(container.labels[COMPOSE_SERVICE_LABEL] ?? ""),
  );
}

/** The ids of the containers among `containers` that run. */
export function runningIds(containers: readonly DockerContainer[]): Set<string> {
  return new Set(
    containers
      .filter((container) => container.state === "running")
      .map((container) => container.id),
  );
}

/**
 * Before a restore in the user's Portainer: the app's running containers among `containers` stop,
 * `parts` are copied as they are now into the snapshot `saved` ({@link portainerTake}), and
 * `mark` runs (the rollback's mark). When one of them fails, the app starts again and the error
 * adds `failure`. Returns the containers that ran (`ran`) and how to start the app again.
 */
export async function stopAndSave(
  run: SnapshotRun,
  place: PortainerPlace,
  input: {
    containers: readonly DockerContainer[];
    saved: string;
    version: string;
    parts: readonly SnapshotPart[];
    failure: string;
    mark?: () => Promise<void>;
  },
): Promise<{ ran: Set<string>; startApp: () => Promise<void> }> {
  const ran = runningIds(input.containers);
  const app = appContainers(run, input.containers).filter((container) => ran.has(container.id));
  const startApp = async () => {
    for (const container of app) await place.docker.startContainer(container.id);
  };
  try {
    for (const container of app) await place.docker.stopContainer(container.id);
    await portainerTake(run, place, {
      id: input.saved,
      version: input.version,
      parts: input.parts,
    });
    await input.mark?.();
  } catch (error) {
    await startApp();
    throw new OpsCrewError(
      error instanceof OpsCrewError ? error.code : "COMMAND_FAILED",
      `${errorMessage(error)} ${input.failure}`,
      error instanceof OpsCrewError && error.hint !== undefined ? { hint: error.hint } : {},
    );
  }
  return { ran, startApp };
}

/** The repository whose deploy branch {@link settleMark} reads, or `undefined` without one. */
async function repositoryOf(run: SnapshotRun) {
  const { deps, services } = run;
  try {
    const api = services.github === undefined ? await githubClientFromToken(deps) : services.github;
    if (api === undefined || api === null) return undefined;
    return { api, ...(await githubCoordinates(gitClient(deps))) };
  } catch {
    return undefined;
  }
}

/**
 * Once the snapshot `id` of the version `version` (`sha256:<hex>`) is back whole: the mark a
 * stuck rollback left on the data ({@link RESTORED_IMAGE_FILE}), when its way out (its second line)
 * is this restore. When the deploy branch names that version, the mark goes and the stack's next
 * deploy starts; otherwise (or unread) Portainer would deploy another version on this data, so the
 * mark is rewritten for this version, whole, its way out the keep rollback to it, which writes it
 * back to the branch. Says which.
 */
async function settleMark(run: SnapshotRun, place: PortainerPlace, id: string, version: string) {
  const { deps, plan, environment } = run;
  const mark = await readMarkIn(place);
  if (mark === undefined || !new RegExp(`^opscrew restore ${id}( |$)`).test(mark.wayOut)) return;
  const image = `${mark.image.slice(0, mark.image.lastIndexOf("@"))}@${version}`;
  const repository = await repositoryOf(run);
  if (repository !== undefined && (await deployBranchNames(plan, repository, image))) {
    const removed = await box(place, `rm -f ${RESTORED_IMAGE_FILE}`);
    if (removed.exitCode !== 0) throw failed(`remove ${RESTORED_IMAGE_FILE}`, removed.exitCode);
    deps.reporter.info(
      `OpsCrew removed ${RESTORED_IMAGE_FILE}, which a rollback left to keep other versions off the data it restored: the stack's next deploy starts the app again (redeploy it in Portainer).`,
    );
    return;
  }
  // As `opscrew rollback` names itself: the app's and the environment's flags, always.
  const flags = `${await appFlag(deps.paths.root, deps.paths.app)} --env ${environment}`;
  const back = `opscrew rollback${flags} --to ${version} --database keep`;
  const marked = await box(place, markScript({ image, wayOut: back, restored: true }));
  if (marked.exitCode !== 0) throw failed(`rewrite ${RESTORED_IMAGE_FILE}`, marked.exitCode);
  const branch = portainerDeployBranch(plan);
  deps.reporter.warn(
    `The deploy branch ${branch} names another version than this snapshot's (${shortDigest(version)}), or OpsCrew could not read it, so Portainer would deploy that one on this data. OpsCrew marked the data for ${shortDigest(version)} in ${RESTORED_IMAGE_FILE} instead of removing the mark. Run \`${back}\`: it writes that version back to the branch, starts it, and removes the mark.`,
  );
}

/**
 * The restore in the user's Portainer: the record in the snapshots volume (or in the bucket with
 * `--from offsite`, copied into the volume once approved), the running version and the stack's
 * images read and checked, approved, then restored ({@link putBack}) between the app's stop and
 * start, with the copy taken just before put back on failure. A whole restore of the running
 * version's data also removes the mark of a stuck rollback.
 */
export async function restoreInPortainer(
  run: SnapshotRun,
  services: RestoreServices,
  id: string,
  options: RestoreSnapshotOptions,
): Promise<RestoredSnapshot> {
  const { deps, plan, environment, flags } = run;
  const place = await portainerPlace(run);
  // 1. What the volume holds and the stack runs, read-only; a free id for the copy just before.
  let record = await readRecord(place, id);
  const { saved, probed } = await probeFree(run, place, id);
  const containers = await stackContainers(place);
  // 2. The record: in the volume, or in the bucket when the volume lacks it (a complete snapshot in
  // the volume is used as it is, also with --from offsite; the bucket's copy replaces a folder
  // without about.json, which never completed).
  const bucket =
    options.from === "offsite" && record === undefined
      ? await offsiteBucket(run, services, `opscrew restore ${id}${flags} --from offsite`)
      : undefined;
  if (bucket !== undefined) {
    record = (await bucketServers(run, bucket, id)).includes(APP_SERVER)
      ? await bucketAbout(run, bucket, options.identity as string, id, APP_SERVER)
      : undefined;
  }
  if (record === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no snapshot ${id}${bucket === undefined ? " in your Portainer" : ` in its off-server ${bucket.noun}`}. ${NOTHING_CHANGED}`,
      { hint: `\`opscrew snapshot list${flags}\` shows its snapshots.` },
    );
  }
  const found: Omit<Holder, "parts"> = {
    server: APP_SERVER,
    name: "your Portainer",
    about: record.about,
    text: record.text,
    images: imagesOf(containers),
    planParts: snapshotParts(plan),
  };
  const [holder] = chooseParts(run, id, [found], options.only);
  const parts = (holder as Holder).parts;
  const allow = options.allowOtherVersion === true;
  checkVersion(run, id, record.about.version, probed.version, allow);
  checkImages(run, id, [holder as Holder], allow);
  const where = "in your Portainer";
  await approveRestore(run, {
    id,
    holders: [holder as Holder],
    where,
    options,
    approvalFile: false,
  });
  // 3. The copy from the bucket; then the app stops, the data is copied first, and restored.
  if (bucket !== undefined) {
    deps.reporter.step(
      `Copying the snapshot ${id} from the off-server ${bucket.noun} to your Portainer`,
    );
    await copyToPortainer(run, bucket, options.identity as string, place, {
      id,
      server: APP_SERVER,
      record,
    });
  }
  deps.reporter.step(
    `Restoring the snapshot ${id} in your Portainer: the app stops until its data is back`,
  );
  const { ran, startApp } = await stopAndSave(run, place, {
    containers,
    saved,
    version: probed.version,
    parts,
    failure:
      "So OpsCrew could not copy the current data before the restore, and changed nothing; the app runs again.",
  });
  const audit = (outcome: string) =>
    deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "restore a snapshot",
      target: "portainer",
      decision: "approved",
      detail: `${id}: ${parts.map((part) => part.name).join(", ")}: ${outcome}`,
    });
  try {
    await putBack(run, place, parts, id, ran);
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    try {
      await putBack(run, place, parts, saved, ran);
    } catch {
      await audit("failed, and its put-back failed too");
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `Restoring the snapshot ${id} failed (${said}), and putting the data back as it was before the restore failed too, so it may be partly changed, and the app was not started. The copy from just before the restore is the snapshot ${saved} in your Portainer.`,
        {
          hint: `Once the cause is fixed, restore it with \`opscrew restore ${saved}${flags}\`, then run \`opscrew status${flags}\`.`,
        },
      );
    }
    await startApp();
    await audit(`failed, put back as it was (${saved})`);
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Restoring the snapshot ${id} failed (${said}), so OpsCrew put the data back as it was before the restore (the snapshot ${saved}), and the app runs again: nothing changed.`,
      { hint: "Fix what it names, then try again." },
    );
  }
  await startApp();
  await audit("restored");
  // The whole snapshot of the version that runs is back: a stuck rollback's mark goes (D19).
  if (!allow && options.only === undefined) await settleMark(run, place, id, record.about.version);
  deps.reporter.success(
    `Restored the snapshot ${id} of ${environment} ${where} (${listText(parts.map((part) => part.name))}). The data from just before is the snapshot ${saved}: \`opscrew restore ${saved}${flags}\` puts it back.`,
  );
  return {
    id,
    where,
    services: parts.map((part) => ({ name: part.name })),
    saved: { [APP_SERVER]: saved },
  };
}
