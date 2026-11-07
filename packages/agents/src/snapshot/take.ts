/**
 * `opscrew snapshot [--skip <service>]...` (US1, FR-2401, FR-2402): a data snapshot of every service
 * with data and the app's SQLite volume, filed where the data lives (plan.md 1.): on the app's
 * servers through their `snapshot.sh` (each part on its own server, one id for all, D8), on this
 * computer, or in the user's Portainer through its Docker API. The online kinds are copied while
 * they run; each stop-only service stops alone for its copy, after an approval naming it.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { type SnapshotPart, serviceSpec, snapshotParts } from "@opscrew/iac-templates";
import { APP_SERVER } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { STOP_SECONDS } from "../retarget/sides/types";
import { MAINTENANCE_WINDOW_TITLE, sizeText } from "../retarget/texts";
import { deleteOnHost } from "./delete";
import { DISK_COMMAND, type Disk, lowDisk, readDisk } from "./disk";
import {
  computerHost,
  dataServers,
  hostFailure,
  READ_TIMEOUT_MS,
  type ScriptHost,
  scriptCommand,
  serverHost,
  serverName,
} from "./hosts";
import { hostListing, mergeListings, type PlaceListing, portainerPlaceListing } from "./list";
import {
  type PortainerPlace,
  portainerPlace,
  portainerProbe,
  portainerTake,
  stopOnlySizes,
} from "./portainer";
import { requireNoDeployOrMove, type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { SNAPSHOT_ID, snapshotIdAt, versionLine } from "./store";
import type { SnapshotService, TakenSnapshot, TakeSnapshotOptions } from "./types";

/** How long the copies of one machine's parts may take. */
const TAKE_TIMEOUT_MS = 6 * 60 * 60_000;

/** What `opscrew snapshot` refuses with, after what. */
const NOTHING_TAKEN = "No snapshot was taken.";

/** The parts of the snapshot on one machine: all of them there, and those it copies. */
interface Place {
  /** The server's name (`app` on this computer and in Portainer). */
  server: string;
  /** Where it is, in words. */
  where: string;
  parts: SnapshotPart[];
  take: SnapshotPart[];
}

/** A part in words: `db (PostgreSQL)`, `sqlite (the app's SQLite files)`. */
function partWords(part: SnapshotPart): string {
  const kind = part.kind === "sqlite" ? "the app's SQLite files" : serviceSpec(part.kind).title;
  return `${part.name} (${kind})`;
}

/**
 * The summary's line of each part copied (FR-2402): the online ones while they run, each stop-only
 * one stopped alone for its copy, with how long, and its data's size where it is known (Portainer).
 */
function partLine(part: SnapshotPart, where: string, size: number | undefined): string {
  if (part.online) return `- ${partWords(part)} ${where}, while it runs`;
  const stop = `- ${partWords(part)} ${where}: it stops alone for its copy`;
  return size === undefined
    ? `${stop} (up to ${STOP_SECONDS} seconds to stop cleanly, then as long as copying its files takes) and starts again`
    : `${stop}, up to ${STOP_SECONDS} seconds to stop cleanly; its data, ${sizeText(size)}, is copied while it is stopped, and it starts again`;
}

/**
 * The machines with data of `run`'s target and their parts, with `skip`'s left out; a machine
 * whose every part is skipped takes none, and only those that take one are returned.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the environment keeps no data, `INVALID_INPUT`
 * for a `--skip` of no service with data, or one that leaves nothing to copy.
 */
function placesOf(run: SnapshotRun, skip: ReadonlySet<string>): Place[] {
  const { plan, environment, flags } = run;
  const target = snapshotTarget(run);
  const all: Omit<Place, "take">[] =
    target === "servers"
      ? dataServers(plan).map((server) => ({
          server,
          where: `on ${serverName(server)}`,
          parts: snapshotParts(plan, server),
        }))
      : [
          {
            server: APP_SERVER,
            where: target === "portainer" ? "in your Portainer" : "on this computer",
            parts: snapshotParts(plan),
          },
        ].filter((place) => place.parts.length > 0);
  const names = all.flatMap((place) => place.parts.map((part) => part.name));
  if (names.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no service that keeps data and no SQLite volume, so there is nothing to snapshot. ${NOTHING_TAKEN}`,
    );
  }
  const unknown = [...skip].filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(unknown)} ${unknown.length === 1 ? "is no service" : "are no services"} with data in ${environment}. ${NOTHING_TAKEN}`,
      {
        hint: `Name one of ${listText(names)} with --skip, then run \`opscrew snapshot${flags}\` again.`,
      },
    );
  }
  const places = all
    .map((place) => ({ ...place, take: place.parts.filter((part) => !skip.has(part.name)) }))
    .filter((place) => place.take.length > 0);
  if (places.length === 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--skip leaves out every service with data in ${environment}, so there is nothing to snapshot. ${NOTHING_TAKEN}`,
      { hint: `Leave a service out of --skip, then run \`opscrew snapshot${flags}\` again.` },
    );
  }
  return places;
}

/**
 * Shows what the snapshot copies (with each stop-only service's data size in `sizes`, where known)
 * and asks, when a stop-only service stops for its copy, the `remote-exec` approval of that
 * downtime (a maintenance window's title), before anything stops. Returns whether one was approved.
 * @throws OpsCrewError `APPROVAL_REFUSED` when it is not.
 */
async function approveSummary(
  run: SnapshotRun,
  places: readonly Place[],
  skip: ReadonlySet<string>,
  sizes: ReadonlyMap<string, number> = new Map(),
): Promise<boolean> {
  const { deps, environment, flags } = run;
  const lines = [
    `The snapshot of ${environment} copies:`,
    ...places.flatMap((place) =>
      place.take.map((part) => partLine(part, place.where, sizes.get(part.name))),
    ),
    ...(skip.size === 0 ? [] : [`Left out (--skip): ${listText([...skip])}.`]),
  ];
  deps.reporter.info(lines.join("\n"));
  const stopped = places.flatMap((place) => place.take.filter((part) => !part.online));
  if (stopped.length === 0) return false;
  const names = stopped.map((part) => part.name);
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `${MAINTENANCE_WINDOW_TITLE} stop ${listText(names)} of ${environment}, one at a time, for ${stopped.length === 1 ? "its" : "their"} copy in a snapshot`,
    details: [
      ...lines,
      `Only ${listText(names)} ${stopped.length === 1 ? "stops" : "stop"}; the app and every other service keep running.`,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError("APPROVAL_REFUSED", `Nothing was stopped. ${NOTHING_TAKEN}`, {
      hint: `Run \`opscrew snapshot${flags}\` again and approve it, or leave ${listText(names)} out with --skip.`,
    });
  }
  return true;
}

/** The running version's digest in the app's `.env` (`version <hex>`), as `snapshot.sh` reads it. */
const VERSION_COMMAND = `sed -n 's/^APP_IMAGE=.*@sha256:\\([0-9a-f]\\{64\\}\\)$/version \\1/p' .env 2> /dev/null; exit 0`;

/** The free disk and the running version on `host`, read-only. */
async function probe(run: SnapshotRun, host: ScriptHost): Promise<{ disk: Disk; version: string }> {
  const result = await host.run(`${DISK_COMMAND}; ${VERSION_COMMAND}`, READ_TIMEOUT_MS);
  const disk = result.exitCode === 0 ? readDisk(result.stdout) : undefined;
  if (disk === undefined) throw hostFailure(run, host, result, "read the free disk");
  return { disk, version: versionLine(result.stdout) };
}

/** The audit entry of a snapshot taken on `target` (never an address): its id and parts. */
function audited(
  run: SnapshotRun,
  input: { target: string; id: string; parts: readonly SnapshotPart[]; approved: boolean },
): Promise<void> {
  return run.deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "take a snapshot",
    target: input.target,
    ...(input.approved ? { decision: "approved" as const } : {}),
    detail: `${input.id}: ${input.parts.map((part) => part.name).join(", ")}`,
  });
}

/** The parts of the snapshot `id` as `listings` (its machines' new `about.json`) record them. */
function recorded(listings: readonly PlaceListing[], id: string): SnapshotService[] {
  const entry = mergeListings(listings).find((candidate) => candidate.id === id);
  if (entry !== undefined) return entry.services;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew took the snapshot ${id}, but its record (about.json) is not where the snapshots are.`,
    { hint: "Run `opscrew snapshot list` to see what is there, then try again." },
  );
}

/**
 * Removes the parts of `id` that `done`'s machines took, best effort, each audited; returns the
 * sentence the error adds: that they went, or which are left and how to delete them.
 */
async function removePartial(
  run: SnapshotRun,
  done: readonly ScriptHost[],
  id: string,
): Promise<string> {
  const left: string[] = [];
  for (const host of done) {
    const outcome = await deleteOnHost(run, host, id).catch(() => undefined);
    if (outcome === undefined) left.push(host.name);
    await run.deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "remove a partial snapshot",
      target: host.audit,
      detail: `${id}: ${outcome ?? "failed"}`,
    });
  }
  const names = listText(done.map((host) => host.name));
  if (left.length === 0) {
    return `OpsCrew removed the parts ${names} had taken, so no partial snapshot ${id} is left.`;
  }
  return `OpsCrew could not remove the parts ${listText(left)} had taken: delete them with \`opscrew snapshot delete ${id}${run.flags}\`.`;
}

/**
 * The snapshot on the app's servers or this computer: each machine's `snapshot.sh take manual`,
 * the app's server first, its id given to the others (`--id`, D8) and the app's running version
 * to all (`--version`); the stop-only parts named with `--stop`, `--skip`'s with `--skip`. A
 * machine that fails stops the snapshot, and the parts the machines before it took are removed.
 * The result's parts are those the new `about.json` files record.
 */
async function takeOnHosts(
  run: SnapshotRun,
  places: readonly Place[],
  skip: ReadonlySet<string>,
): Promise<TakenSnapshot> {
  const { deps } = run;
  const local = snapshotTarget(run) === "computer";
  const hosts = new Map<string, ScriptHost>();
  for (const place of places) {
    hosts.set(place.server, local ? await computerHost(run) : await serverHost(run, place.server));
  }
  const hostOf = (place: Place) => hosts.get(place.server) as ScriptHost;
  // 1. The disks and the running version, before anything is approved or stops.
  let version = "";
  for (const place of places) {
    const read = await probe(run, hostOf(place));
    const low = lowDisk(read.disk, hostOf(place).where);
    if (low !== undefined) throw low;
    if (place.server === APP_SERVER) version = read.version;
  }
  if (!hosts.has(APP_SERVER)) {
    const app = await serverHost(run, APP_SERVER);
    const read = await app.run(VERSION_COMMAND, READ_TIMEOUT_MS);
    if (read.exitCode !== 0) throw hostFailure(run, app, read, "read the version it runs");
    version = versionLine(read.stdout);
  }
  // 2. The summary, and the approval of each stop.
  const approved = await approveSummary(run, places, skip);
  // 3. Each machine's part, under one id.
  let id: string | undefined;
  const done: ScriptHost[] = [];
  for (const place of places) {
    const host = hostOf(place);
    const args = [
      "take",
      "manual",
      ...place.parts.filter((part) => skip.has(part.name)).flatMap((part) => ["--skip", part.name]),
      ...place.take.filter((part) => !part.online).flatMap((part) => ["--stop", part.name]),
      ...(id === undefined ? [] : ["--id", id]),
      ...(version === "" ? [] : ["--version", version]),
    ];
    deps.reporter.step(`Taking the snapshot ${host.where}`);
    const result = await host.run(scriptCommand(args), TAKE_TIMEOUT_MS);
    const printed = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
    if (result.exitCode !== 0 || !SNAPSHOT_ID.test(printed)) {
      const error = hostFailure(run, host, result, "take the snapshot");
      if (id === undefined) throw error;
      throw new OpsCrewError(error.code, `${error.message} ${await removePartial(run, done, id)}`, {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
    }
    id = printed;
    done.push(host);
    await audited(run, { target: host.audit, id, parts: place.take, approved });
  }
  const taken = id as string;
  const listings: PlaceListing[] = [];
  for (const host of done) listings.push(await hostListing(run, host));
  return {
    id: taken,
    where: `on ${listText(done.map((host) => host.name))}`,
    services: recorded(listings, taken),
  };
}

/**
 * Stops (`PHASE_PRECONDITION`) when the app's stack in the user's Portainer was last applied
 * without the snapshots volume (before snapshots by hand): its volume would be outside the
 * stack's record, so `destroy --delete-data` would leave it, and no version would be known.
 */
function requireSnapshotsVolume(run: SnapshotRun, portainer: PortainerPlace): void {
  if (portainer.recorded.includes(portainer.volume)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The app's stack in your Portainer has no snapshots volume yet: it was set up before snapshots by hand. ${NOTHING_TAKEN}`,
    {
      hint: `Run \`opscrew provision${run.flags}\` first (it adds the volume to the stack, and the running version to it), then \`opscrew snapshot${run.flags}\` again.`,
    },
  );
}

/**
 * The snapshot in the user's Portainer ({@link portainerTake}), its id this computer's time, its
 * parts those its new `about.json` records.
 */
async function takeInPortainer(
  run: SnapshotRun,
  place: Place,
  skip: ReadonlySet<string>,
): Promise<TakenSnapshot> {
  const { deps, environment } = run;
  const portainer = await portainerPlace(run);
  requireSnapshotsVolume(run, portainer);
  const id = snapshotIdAt(deps.clock.now());
  const read = await portainerProbe(portainer, id);
  if (read.taken) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `There is already a snapshot ${id} of ${environment} in your Portainer. ${NOTHING_TAKEN}`,
      { hint: "Run the command again in a moment." },
    );
  }
  const low = lowDisk(read.disk, "in your Portainer");
  if (low !== undefined) throw low;
  const sizes = await stopOnlySizes(portainer, place.take);
  const approved = await approveSummary(run, [place], skip, sizes);
  deps.reporter.step("Taking the snapshot in your Portainer");
  await portainerTake(run, portainer, { id, version: read.version, parts: place.take });
  await audited(run, { target: "portainer", id, parts: place.take, approved });
  return {
    id,
    where: "in your Portainer",
    services: recorded([await portainerPlaceListing(portainer)], id),
  };
}

/**
 * `opscrew snapshot` on the environment `deps` belong to: refused while a deploy or a move runs and
 * when a disk has less than 1 GiB or 10% free (saying how much is needed); otherwise shows what it
 * copies, asks to approve each stop-only service's stop, and takes the snapshot where the data
 * lives. Nothing it prints, audits or asks holds a password, a key, an address or data.
 * @throws OpsCrewError `PHASE_PRECONDITION` for each refusal, `INVALID_INPUT` for a wrong `--skip`,
 * `APPROVAL_REFUSED` when the stop is not approved, `COMMAND_FAILED` when a copy fails.
 */
export async function takeSnapshot(
  deps: PhaseDeps,
  options: TakeSnapshotOptions = {},
): Promise<TakenSnapshot> {
  const run = await snapshotRun(deps, options.services);
  const skip = new Set(options.skip ?? []);
  const places = placesOf(run, skip);
  await requireNoDeployOrMove(run, "take a snapshot");
  const taken =
    snapshotTarget(run) === "portainer"
      ? await takeInPortainer(run, places[0] as Place, skip)
      : await takeOnHosts(run, places, skip);
  deps.reporter.success(`Took the snapshot ${taken.id} of ${run.environment} ${taken.where}.`);
  return taken;
}
