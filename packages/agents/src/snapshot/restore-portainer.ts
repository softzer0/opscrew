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
import { listText, OpsCrewError } from "@opscrew/core";
import {
  partRestore,
  portainerServiceEnvironment,
  processServices,
  type SnapshotPart,
  SQLITE_VOLUME,
  snapshotParts,
} from "@opscrew/iac-templates";
import { APP_SERVER } from "@opscrew/plan-schema";
import { NOTHING_CHANGED } from "../promote/shared";
import { lowDisk } from "./disk";
import {
  box,
  DIR,
  failed,
  ofService,
  type PortainerPlace,
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
  bucketCopies,
  bucketObjects,
  copyToPortainer,
  offsiteBucket,
  type RestoreServices,
} from "./restore-offsite";
import type { SnapshotRun } from "./run";
import { AboutSchema, snapshotIdAt } from "./store";

/** The record of the snapshot `id` in the volume (`about <json>`), and whether its folder is there. */
async function readRecord(
  place: PortainerPlace,
  id: string,
): Promise<{ record?: BucketAbout; present: boolean }> {
  const script = [
    `if [ -f ${DIR}/${id}/about.json ]; then printf 'about '; cat ${DIR}/${id}/about.json; fi`,
    `if [ -e ${DIR}/${id} ]; then echo present; fi`,
    "exit 0",
  ].join("\n");
  const result = await box(place, script, { readOnly: true });
  if (result.exitCode !== 0) throw failed("read its snapshots", result.exitCode);
  const present = /^present$/m.test(result.stdout);
  const text = /^about (\{.*\})$/m.exec(result.stdout)?.[1];
  if (text === undefined) return { present };
  try {
    const about = AboutSchema.safeParse(JSON.parse(text));
    return about.success && about.data.id === id
      ? { record: { about: about.data, text }, present }
      : { present };
  } catch {
    return { present };
  }
}

/** The image the first container of each service in `containers` runs, by service. */
function imagesOf(containers: readonly DockerContainer[]): Map<string, string> {
  const images = new Map<string, string>();
  for (const container of containers) {
    const service = container.labels["com.docker.compose.service"];
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
async function putBack(
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
    const mounts: MountSpec[] =
      part.kind === "sqlite"
        ? [{ type: "volume", source: `${place.stack}_${SQLITE_VOLUME}`, target: "/data" }]
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
function appContainers(run: SnapshotRun, containers: readonly DockerContainer[]) {
  const names = ["app", ...processServices(run.plan)];
  return containers.filter((container) =>
    names.includes(container.labels["com.docker.compose.service"] ?? ""),
  );
}

/**
 * The restore in the user's Portainer: the record in the snapshots volume (or in the bucket with
 * `--from offsite`, copied into the volume once approved), the running version and the stack's
 * images read and checked, approved, then restored ({@link putBack}) between the app's stop and
 * start, with the copy taken just before put back on failure.
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
  const read = await readRecord(place, id);
  let saved = snapshotIdAt(deps.clock.now());
  let probed = await portainerProbe(place, saved);
  for (let second = 1; saved === id || probed.taken; second++) {
    saved = snapshotIdAt(new Date(deps.clock.now().getTime() + second * 1000));
    probed = await portainerProbe(place, saved);
  }
  const low = lowDisk(probed.disk, "in your Portainer");
  if (low !== undefined) throw low;
  const containers = await stackContainers(place);
  // 2. The record: in the volume, or in the bucket.
  let record = read.record;
  const bucket =
    options.from === "offsite"
      ? await offsiteBucket(run, services, `opscrew restore ${id}${flags} --from offsite`)
      : undefined;
  if (bucket !== undefined) {
    if (read.present) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The snapshot ${id} is in your Portainer already, so its copy in the bucket is not needed. ${NOTHING_CHANGED}`,
        { hint: `Restore it from there: \`opscrew restore ${id}${flags}\`.` },
      );
    }
    const objects = await bucketObjects(run, bucket, id);
    const servers = bucketCopies(objects.map((object) => `${id}/${object}`)).get(id) ?? [];
    record = servers.includes(APP_SERVER)
      ? await bucketAbout(run, bucket, options.identity as string, id, APP_SERVER)
      : undefined;
  }
  if (record === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no snapshot ${id}${bucket === undefined ? " in your Portainer" : " in its off-server bucket"}. ${NOTHING_CHANGED}`,
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
    deps.reporter.step(`Copying the snapshot ${id} from the off-server bucket to your Portainer`);
    await copyToPortainer(run, bucket, options.identity as string, place, {
      id,
      server: APP_SERVER,
      record,
      files: record.about.services.flatMap((entry) =>
        "file" in entry ? [{ file: entry.file, size: entry.size }] : [],
      ),
    });
  }
  const ran = new Set(
    containers
      .filter((container) => container.state === "running")
      .map((container) => container.id),
  );
  const app = appContainers(run, containers).filter((container) => ran.has(container.id));
  const startApp = async () => {
    for (const container of app) await place.docker.startContainer(container.id);
  };
  deps.reporter.step(
    `Restoring the snapshot ${id} in your Portainer: the app stops until its data is back`,
  );
  for (const container of app) await place.docker.stopContainer(container.id);
  try {
    await portainerTake(run, place, { id: saved, version: probed.version, parts });
  } catch (error) {
    await startApp();
    throw error instanceof OpsCrewError
      ? new OpsCrewError(
          error.code,
          `${error.message} So OpsCrew could not copy the current data before the restore, and changed nothing; the app runs again.`,
          { ...(error.hint === undefined ? {} : { hint: error.hint }) },
        )
      : error;
  }
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
