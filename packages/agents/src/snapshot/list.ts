/**
 * `opscrew snapshot list` (US2, FR-2403): the data snapshots on the app's servers (each part where
 * its server keeps it, one snapshot per id), on this computer or in the user's Portainer, and the
 * providers' whole-server snapshots, each with whether its off-server copy is uploaded. Read-only.
 * The bucket's copies of a server that is gone are `opscrew restore --from offsite`'s (T2408).
 */
import { listText } from "@opscrew/core";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { sizeText } from "../retarget/texts";
import { shortDigest } from "../rollback/versions";
import {
  computerHost,
  dataServers,
  hostFailure,
  READ_TIMEOUT_MS,
  type ScriptHost,
  scriptCommand,
  serverHost,
} from "./hosts";
import { portainerListing, portainerPlace } from "./portainer";
import { providerSnapshots } from "./provider";
import { type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { type About, type Listing, offsiteLines, readListing, SERVER_SNAPSHOTS } from "./store";
import type { SnapshotCommandOptions, SnapshotEntry, SnapshotService } from "./types";

/** One machine's listing, with where its parts are. */
export interface PlaceListing {
  /** The place in words: `the app's server`, `server data`, `this computer`, `your Portainer`. */
  name: string;
  /** Where it is, in words: `on the app's server`, `in your Portainer`. */
  where: string;
  /** The server's name in the plan, for the parts on a server. */
  server?: string;
  listing: Listing;
}

/** `host`'s snapshots: its `snapshot.sh list` and the `offsite.done` markers. */
export async function hostListing(run: SnapshotRun, host: ScriptHost): Promise<PlaceListing> {
  const command = `${scriptCommand(["list"])} && ${offsiteLines(SERVER_SNAPSHOTS)}`;
  const result = await host.run(command, READ_TIMEOUT_MS);
  if (result.exitCode !== 0) throw hostFailure(run, host, result, "list the snapshots");
  return {
    name: host.name,
    where: host.where,
    ...(host.audit === "this computer" ? {} : { server: host.server }),
    listing: readListing(result.stdout),
  };
}

/** The data snapshots' listings of `run`'s target, one per machine that holds data. */
export async function dataListings(run: SnapshotRun): Promise<PlaceListing[]> {
  const target = snapshotTarget(run);
  if (target === "portainer") {
    const listing = await portainerListing(await portainerPlace(run));
    return [{ name: "your Portainer", where: "in your Portainer", listing }];
  }
  if (target === "computer") return [await hostListing(run, await computerHost(run))];
  const listings: PlaceListing[] = [];
  for (const server of dataServers(run.plan)) {
    listings.push(await hostListing(run, await serverHost(run, server)));
  }
  return listings;
}

/** A part of `about` as the list shows it, on `server`. */
function serviceOf(entry: About["services"][number], server: string | undefined): SnapshotService {
  const base = { name: entry.name, kind: entry.kind, ...(server === undefined ? {} : { server }) };
  if ("file" in entry) return { ...base, state: "copied", size: entry.size };
  return { ...base, state: "failed" in entry ? "failed" : "skipped" };
}

/**
 * One snapshot per id across `listings` (D8: a snapshot's parts on several servers share its id),
 * its kind, time and version the first machine's (the app's server first), its size the parts'
 * added up, and its off-server copy there only when every part has one.
 */
export function mergeListings(listings: readonly PlaceListing[]): SnapshotEntry[] {
  const byId = new Map<string, { entry: SnapshotEntry; places: string[] }>();
  for (const { name, server, listing } of listings) {
    for (const about of listing.abouts) {
      const services = about.services.map((entry) => serviceOf(entry, server));
      const size = services.reduce((total, service) => total + (service.size ?? 0), 0);
      const offsite = listing.offsite.has(about.id);
      const known = byId.get(about.id);
      if (known === undefined) {
        byId.set(about.id, {
          places: [name],
          entry: {
            id: about.id,
            kind: about.kind,
            taken: about.taken,
            version: about.version,
            size,
            services,
            where: "",
            offsite,
          },
        });
        continue;
      }
      known.places.push(name);
      known.entry.services.push(...services);
      known.entry.size = (known.entry.size ?? 0) + size;
      known.entry.offsite &&= offsite;
      if (known.entry.version === "") known.entry.version = about.version;
    }
  }
  return [...byId.values()].map(({ entry, places }) => ({
    ...entry,
    where: `${places[0] === "your Portainer" ? "in" : "on"} ${listText(places)}`,
  }));
}

/** Newest first. */
function newestFirst(a: SnapshotEntry, b: SnapshotEntry): number {
  return Date.parse(b.taken) - Date.parse(a.taken);
}

/**
 * Every snapshot of the environment `deps` belong to, newest first ({@link SnapshotEntry}): its
 * data snapshots ({@link dataListings}, {@link mergeListings}) and, on servers OpsCrew created,
 * the providers' whole-server snapshots. A record that does not read as the store's contract is
 * left out with a warning.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a site, and when a machine is not reachable or
 * its listing fails.
 */
export async function listSnapshots(
  deps: PhaseDeps,
  options: SnapshotCommandOptions = {},
): Promise<SnapshotEntry[]> {
  const run = await snapshotRun(deps, options.services);
  const listings = await dataListings(run);
  for (const { where, listing } of listings) {
    if (listing.unreadable === 0) continue;
    deps.reporter.warn(
      `${listing.unreadable} snapshot record${listing.unreadable === 1 ? "" : "s"} ${where} could not be read, so ${listing.unreadable === 1 ? "it is" : "they are"} not listed.`,
    );
  }
  const whole =
    snapshotTarget(run) === "servers"
      ? (await providerSnapshots(run)).map((found) => found.entry)
      : [];
  return [...mergeListings(listings), ...whole].sort(newestFirst);
}

/** A kind of snapshot in words. */
const KIND_WORDS: Record<SnapshotEntry["kind"], string> = {
  manual: "by hand",
  release: "before a release",
  scheduled: "scheduled",
  server: "whole server",
};

/** One line per snapshot, newest first, as `opscrew snapshot list` prints them; none says so. */
export function snapshotListLines(entries: readonly SnapshotEntry[]): string[] {
  if (entries.length === 0) return ["No snapshots yet: `opscrew snapshot` takes one."];
  return entries.map((entry) => {
    const copied = entry.services.filter((service) => service.state === "copied");
    const left = entry.services.filter((service) => service.state !== "copied");
    const details = [
      KIND_WORDS[entry.kind],
      formatUtc(entry.taken),
      ...(entry.kind === "server"
        ? []
        : [entry.version === "" ? "version unknown" : `version ${shortDigest(entry.version)}`]),
      ...(entry.size === undefined ? [] : [sizeText(entry.size)]),
      ...(copied.length === 0 ? [] : [listText(copied.map((service) => service.name))]),
      ...(left.length === 0
        ? []
        : [`left out: ${listText(left.map((service) => `${service.name} (${service.state})`))}`]),
      entry.where,
      ...(entry.offsite ? ["copied off the server"] : []),
    ];
    return `${entry.id}: ${details.join(", ")}`;
  });
}
