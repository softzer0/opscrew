/**
 * `status`'s snapshot section (024 US5 #2): the newest data snapshot of the environment, scheduled
 * ones included, with its time and result, and with the schedule on, each server whose last
 * scheduled snapshot, or its copy off the server, failed, read from `.snapshots/scheduled.log`:
 * the snapshot's id once it was taken, then what the off-server copy said. Read-only.
 */
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { SCHEDULED_LOG, scheduledFailed, scheduledLog } from "@opscrew/iac-templates";
import { type DeployPlan, snapshotScheduleOf } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { dataServers, type ScriptHost, serverHost } from "../snapshot/hosts";
import {
  hostListing,
  KIND_WORDS,
  mergeListings,
  type PlaceListing,
  portainerPlaceListing,
} from "../snapshot/list";
import { portainerPlace } from "../snapshot/portainer";
import { type SnapshotRun, snapshotTarget } from "../snapshot/run";
import { SERVER_SNAPSHOTS } from "../snapshot/store";
import type { SnapshotEntry, SnapshotServices } from "../snapshot/types";

/** A scheduled snapshot on a server that failed, or whose copy off the server failed. */
export interface ScheduledFailure {
  /** Where it failed, in words: `on the app's server`. */
  where: string;
  /** When its log was last written (ISO). */
  at: string;
  /** The snapshot's id when it was taken and only its off-server copy failed. */
  id?: string;
  /** What it said last, redacted. */
  said: string;
}

/** What `status` read of the snapshots. */
export interface SnapshotStatus {
  /** The newest snapshot; absent when there is none. */
  last?: SnapshotEntry;
  /** The servers whose last scheduled snapshot, or its off-server copy, failed. */
  scheduledFailures: ScheduledFailure[];
}

/** The lines the probe prints after the listing. */
const AT = "scheduled-at";
const SAID = "scheduled-said";
const RUNNING = "scheduled-running";

/** The app's start lock, which a snapshot being taken holds (`switch.ts`). */
const START_LOCK = ".start.lock";

/**
 * After the listing, when a scheduled snapshot ran: its log's time and lines, and whether a
 * snapshot is being taken now (a `.partial` folder while the start lock is held; one left by a
 * run that stopped is stale), whose log is not finished yet.
 */
const SCHEDULED_PROBE = [
  `if [ -f ${SCHEDULED_LOG} ]; then`,
  `echo "${AT} $(stat -c %Y ${SCHEDULED_LOG})";`,
  `sed 's/^/${SAID} /' ${SCHEDULED_LOG};`,
  `for d in ${SERVER_SNAPSHOTS}/*.partial; do if [ -d "$d" ]; then flock -n ${START_LOCK} true || echo ${RUNNING}; break; fi; done;`,
  "fi",
].join(" ");

/**
 * The failure the probe's lines in `stdout` show on `host`, if its last scheduled run failed: by
 * the scheduled check's reading of the log and rule (`scheduledLog`, `scheduledFailed`), unless a
 * snapshot is being taken.
 */
function failureOn(
  run: SnapshotRun,
  host: ScriptHost,
  stdout: string,
): ScheduledFailure | undefined {
  const lines = stdout.split(/\r?\n/);
  const seconds = Number(lines.find((line) => line.startsWith(`${AT} `))?.slice(AT.length + 1));
  if (!Number.isFinite(seconds) || lines.includes(RUNNING)) return undefined;
  const { id, after } = scheduledLog(
    lines.filter((line) => line.startsWith(`${SAID} `)).map((line) => line.slice(SAID.length + 1)),
  );
  if (!scheduledFailed({ ...(id === undefined ? {} : { id }), after: after.length })) {
    return undefined;
  }
  // What its copy off the server said after the id, or else the last line.
  const said = (id === undefined ? after.slice(-1) : after).map((line) => line.trim());
  return {
    where: host.where,
    at: new Date(seconds * 1000).toISOString(),
    ...(id === undefined ? {} : { id }),
    said: run.deps.redactor.redact(said.join(" ")).slice(0, 300),
  };
}

/**
 * The newest snapshot of `run`'s environment and, with the schedule on, the servers whose last
 * scheduled run failed ({@link SnapshotStatus}): on each server with data through its
 * `snapshot.sh`, or in the user's Portainer (whose scheduled parts that failed are in the snapshot
 * itself).
 */
async function readSnapshotStatus(run: SnapshotRun): Promise<SnapshotStatus> {
  const places: PlaceListing[] = [];
  const scheduledFailures: ScheduledFailure[] = [];
  if (snapshotTarget(run) === "portainer") {
    places.push(await portainerPlaceListing(await portainerPlace(run)));
  } else {
    const scheduled = snapshotScheduleOf(run.plan) !== undefined;
    for (const server of dataServers(run.plan)) {
      const host = await serverHost(run, server);
      const place = await hostListing(run, host, {
        ...(scheduled ? { probe: SCHEDULED_PROBE } : {}),
        what: "read the snapshots",
      });
      places.push(place);
      const failure = scheduled ? failureOn(run, host, place.stdout) : undefined;
      if (failure !== undefined) scheduledFailures.push(failure);
    }
  }
  const [last] = mergeListings(places).sort((a, b) => Date.parse(b.taken) - Date.parse(a.taken));
  return { ...(last === undefined ? {} : { last }), scheduledFailures };
}

/** A snapshot's result: every part copied, or which failed or were left out. */
function resultText(entry: SnapshotEntry): string {
  const named = (state: string) =>
    entry.services.filter((service) => service.state === state).map((service) => service.name);
  const failed = named("failed");
  const skipped = named("skipped");
  const parts = [
    ...(failed.length === 0 ? [] : [`the copy of ${listText(failed)} failed`]),
    ...(skipped.length === 0 ? [] : [`${listText(skipped)} left out`]),
  ];
  return parts.length === 0 ? "every part copied" : parts.join(", ");
}

/** `text` ending with a full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The section's lines of `status`, redacted by the caller. */
export function snapshotStatusLines(status: SnapshotStatus, flags: string): string[] {
  const { last } = status;
  return [
    last === undefined
      ? `Snapshots: none yet; \`opscrew snapshot${flags}\` takes one.`
      : `Last snapshot: ${last.id}, ${KIND_WORDS[last.kind]}, ${formatUtc(last.taken)}, ${resultText(last)}, ${last.where}${last.offsite ? ", copied off the server" : ""}.`,
    ...status.scheduledFailures.map((failure) => {
      const what =
        failure.id === undefined
          ? `The last scheduled snapshot ${failure.where}`
          : `The off-server copy of the scheduled snapshot ${failure.id} ${failure.where}`;
      const said = failure.said === "" ? "." : `: ${sentence(failure.said)}`;
      return `${what} failed at ${formatUtc(failure.at)}${said} Its output is in ${SCHEDULED_LOG} in the app's folder there.`;
    }),
  ];
}

/**
 * {@link readSnapshotStatus}'s lines with data to snapshot on a server or in Portainer, and a note
 * instead when they cannot be read; none otherwise (this computer among them, which takes no
 * scheduled snapshot: `opscrew snapshot list` lists its snapshots there).
 */
export async function snapshotStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: SnapshotServices,
): Promise<{ lines: string[]; snapshot?: SnapshotStatus }> {
  if (plan.target.provider === "localhost" || dataServers(plan).length === 0) return { lines: [] };
  const environment = deps.paths.environment;
  const flags = await commandFlags(deps.paths.root, environment, deps.paths.app);
  const run: SnapshotRun = { deps, plan, environment, flags, services };
  try {
    const snapshot = await readSnapshotStatus(run);
    return {
      lines: snapshotStatusLines(snapshot, flags).map((line) => deps.redactor.redact(line)),
      snapshot,
    };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { lines: [deps.redactor.redact(`Snapshots: ${errorText(error)}`)] };
  }
}
