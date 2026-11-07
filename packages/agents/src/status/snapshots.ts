/**
 * `status`'s snapshot section (024 US5 #2): the newest data snapshot of the environment, scheduled
 * ones included, with its time and result, and on each server a scheduled snapshot that failed
 * since, read from `.snapshots/scheduled.log` (its id when it succeeded, else why it failed).
 * Read-only.
 */
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { SCHEDULED_LOG } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import {
  dataServers,
  hostFailure,
  READ_TIMEOUT_MS,
  type ScriptHost,
  scriptCommand,
  serverHost,
} from "../snapshot/hosts";
import { mergeListings, type PlaceListing, portainerPlaceListing } from "../snapshot/list";
import { portainerPlace } from "../snapshot/portainer";
import { type SnapshotRun, snapshotTarget } from "../snapshot/run";
import { offsiteLines, readListing, SERVER_SNAPSHOTS, SNAPSHOT_ID } from "../snapshot/store";
import type { SnapshotEntry, SnapshotServices } from "../snapshot/types";

/** A scheduled snapshot on a server that failed: when, and the last line it wrote. */
export interface ScheduledFailure {
  /** Where it failed, in words: `on the app's server`. */
  where: string;
  /** When its log was last written (ISO). */
  at: string;
  /** Its last line, redacted. */
  said: string;
}

/** What `status` read of the snapshots. */
export interface SnapshotStatus {
  /** The newest snapshot; absent when there is none. */
  last?: SnapshotEntry;
  /** The servers whose last scheduled snapshot failed. */
  scheduledFailures: ScheduledFailure[];
}

/** The lines the probe prints after the listing. */
const AT = "scheduled-at";
const SAID = "scheduled-said";
const RUNNING = "scheduled-running";

/**
 * After the listing, when a scheduled snapshot ran: its log's time and last line, and whether a
 * snapshot is being taken now (a `.partial` folder), whose log is not finished yet.
 */
const SCHEDULED_PROBE = [
  `if [ -f ${SCHEDULED_LOG} ]; then`,
  `echo "${AT} $(stat -c %Y ${SCHEDULED_LOG})";`,
  `echo "${SAID} $(tail -n 1 ${SCHEDULED_LOG})";`,
  `for d in ${SERVER_SNAPSHOTS}/*.partial; do if [ -d "$d" ]; then echo ${RUNNING}; break; fi; done;`,
  "fi",
].join(" ");

/** `host`'s listing and its scheduled snapshot's failure, if its last one failed. */
async function readHost(
  run: SnapshotRun,
  host: ScriptHost,
): Promise<{ place: PlaceListing; failure?: ScheduledFailure }> {
  const command = `{ ${scriptCommand(["list"])} && ${offsiteLines(SERVER_SNAPSHOTS)}; } || exit $?; ${SCHEDULED_PROBE}`;
  const result = await host.run(command, READ_TIMEOUT_MS);
  if (result.exitCode !== 0) throw hostFailure(run, host, result, "read the snapshots");
  const place: PlaceListing = {
    name: host.name,
    where: host.where,
    ...(host.local ? {} : { server: host.server }),
    listing: readListing(result.stdout),
    host,
  };
  const lines = result.stdout.split(/\r?\n/);
  const seconds = Number(lines.find((line) => line.startsWith(`${AT} `))?.slice(AT.length + 1));
  const said = (
    lines.find((line) => line.startsWith(`${SAID} `))?.slice(SAID.length + 1) ?? ""
  ).trim();
  // A scheduled snapshot that succeeded ends its log with its id; one being taken has not ended it.
  const failed = Number.isFinite(seconds) && !SNAPSHOT_ID.test(said) && !lines.includes(RUNNING);
  if (!failed) return { place };
  return {
    place,
    failure: {
      where: host.where,
      at: new Date(seconds * 1000).toISOString(),
      said: run.deps.redactor.redact(said).slice(0, 300),
    },
  };
}

/**
 * The newest snapshot of `plan`'s environment and the servers whose last scheduled snapshot failed
 * ({@link SnapshotStatus}): on each server with data through its `snapshot.sh`, or in the user's
 * Portainer (whose scheduled parts that failed are in the snapshot itself). Not on this computer,
 * which takes no scheduled snapshot: `opscrew snapshot list` lists its snapshots there.
 */
async function readSnapshotStatus(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: SnapshotServices = {},
): Promise<SnapshotStatus> {
  const environment = deps.paths.environment;
  const flags = await commandFlags(deps.paths.root, environment, deps.paths.app);
  const run: SnapshotRun = { deps, plan, environment, flags, services };
  const places: PlaceListing[] = [];
  const scheduledFailures: ScheduledFailure[] = [];
  if (snapshotTarget(run) === "portainer") {
    places.push(await portainerPlaceListing(await portainerPlace(run)));
  } else {
    for (const server of dataServers(plan)) {
      const read = await readHost(run, await serverHost(run, server));
      places.push(read.place);
      if (read.failure !== undefined) scheduledFailures.push(read.failure);
    }
  }
  const [last] = mergeListings(places).sort((a, b) => Date.parse(b.taken) - Date.parse(a.taken));
  return { ...(last === undefined ? {} : { last }), scheduledFailures };
}

/** A snapshot's kind in words. */
const KIND_WORDS: Record<SnapshotEntry["kind"], string> = {
  manual: "by hand",
  release: "before a release",
  scheduled: "scheduled",
  server: "whole server",
};

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

/** The section's lines of `status`, redacted by the caller. */
export function snapshotStatusLines(status: SnapshotStatus, flags: string): string[] {
  const { last } = status;
  return [
    last === undefined
      ? `Snapshots: none yet; \`opscrew snapshot${flags}\` takes one.`
      : `Last snapshot: ${last.id}, ${KIND_WORDS[last.kind]}, ${formatUtc(last.taken)}, ${resultText(last)}, ${last.where}${last.offsite ? ", copied off the server" : ""}.`,
    ...status.scheduledFailures.map(
      (failure) =>
        `The last scheduled snapshot ${failure.where} failed at ${formatUtc(failure.at)}${failure.said === "" ? "." : `: ${failure.said}${/[.!?]$/.test(failure.said) ? "" : "."}`} Its output is in ${SCHEDULED_LOG} in the app's folder there.`,
    ),
  ];
}

/**
 * {@link readSnapshotStatus}'s lines with data to snapshot on a server or in Portainer, and a note
 * instead when they cannot be read; none otherwise (this computer among them).
 */
export async function snapshotStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: SnapshotServices,
): Promise<{ lines: string[]; snapshot?: SnapshotStatus }> {
  if (plan.target.provider === "localhost" || dataServers(plan).length === 0) return { lines: [] };
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  try {
    const snapshot = await readSnapshotStatus(deps, plan, services);
    return {
      lines: snapshotStatusLines(snapshot, flags).map((line) => deps.redactor.redact(line)),
      snapshot,
    };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return {
      lines: [deps.redactor.redact(`OpsCrew could not read the snapshots. ${errorText(error)}`)],
    };
  }
}
