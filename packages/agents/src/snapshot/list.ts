/**
 * `opscrew snapshot list` (US2, FR-2403): the data snapshots on the app's servers (each part where
 * its server keeps it, one snapshot per id), on this computer or in the user's Portainer, and the
 * providers' whole-server snapshots, each with whether its off-server copy is uploaded
 * (`offsite.done`), and the copies only the off-server bucket still holds, their server gone (read
 * from this computer). Read-only.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { APP_SERVER } from "@opscrew/plan-schema";
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
  serverName,
} from "./hosts";
import { type PortainerPlace, portainerListing, portainerPlace } from "./portainer";
import { providerSnapshots } from "./provider";
import {
  bucketAbout,
  bucketCopies,
  bucketObjects,
  hideIdentity,
  type OffsiteBucket,
  offsiteBucket,
  type RestoreServices,
} from "./restore-offsite";
import { type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { type About, type Listing, offsiteLines, readListing, SERVER_SNAPSHOTS } from "./store";
import type { SnapshotCommandOptions, SnapshotEntry, SnapshotService } from "./types";

/** One machine's listing, with where its parts are and the machine itself. */
export type PlaceListing = {
  /** The place in words: `the app's server`, `server data`, `this computer`, `your Portainer`. */
  name: string;
  /** Where it is, in words: `on the app's server`, `in your Portainer`. */
  where: string;
  /** The server's name in the plan, for the parts on a server. */
  server?: string;
  listing: Listing;
} & ({ host: ScriptHost } | { portainer: PortainerPlace });

/**
 * `host`'s snapshots: its `snapshot.sh list` and the `offsite.done` markers, then `probe`'s lines
 * when given (`status`'s), all in `stdout`; `what` follows "could not" in a failure.
 */
export async function hostListing(
  run: SnapshotRun,
  host: ScriptHost,
  o: { probe?: string; what?: string } = {},
): Promise<PlaceListing & { stdout: string }> {
  const listing = `${scriptCommand(["list"])} && ${offsiteLines(SERVER_SNAPSHOTS)}`;
  const command = o.probe === undefined ? listing : `{ ${listing}; } || exit $?; ${o.probe}`;
  const result = await host.run(command, READ_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw hostFailure(run, host, result, o.what ?? "list the snapshots");
  }
  return {
    stdout: result.stdout,
    name: host.name,
    where: host.where,
    ...(host.local ? {} : { server: host.server }),
    listing: readListing(result.stdout),
    host,
  };
}

/** `place`'s snapshots in the user's Portainer. */
export async function portainerPlaceListing(place: PortainerPlace): Promise<PlaceListing> {
  const listing = await portainerListing(place);
  return { name: "your Portainer", where: "in your Portainer", listing, portainer: place };
}

/** The data snapshots' listings of `run`'s target, one per machine that holds data. */
export async function dataListings(run: SnapshotRun): Promise<PlaceListing[]> {
  const target = snapshotTarget(run);
  if (target === "portainer") return [await portainerPlaceListing(await portainerPlace(run))];
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
export function mergeListings(
  listings: readonly Pick<PlaceListing, "name" | "server" | "listing">[],
): SnapshotEntry[] {
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

/** `opscrew snapshot list`'s options. */
export interface ListSnapshotsOptions extends SnapshotCommandOptions {
  /**
   * The recovery copy's age key, or its key file's text: the records of the copies only the
   * off-server bucket holds are decrypted with it here; without it, only their ids are said.
   */
  identity?: string;
  services?: RestoreServices;
}

/**
 * The copies in the bucket (`bucket`) whose snapshot no machine holds any more (`known` are the
 * ids the machines hold): with `identity`, each part's `about.json` decrypted here and merged as
 * the machines' are, `where` the bucket; without it, only their ids, said in a line, since nothing
 * else of them can be read without the key.
 */
export async function bucketEntries(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  known: ReadonlySet<string>,
  identity: string | undefined,
): Promise<SnapshotEntry[]> {
  const copies = [...bucketCopies(await bucketObjects(run, bucket))].filter(
    ([id]) => !known.has(id),
  );
  if (copies.length === 0) return [];
  if (identity === undefined) {
    run.deps.reporter.warn(
      `The off-server bucket ${bucket.name} also holds ${copies.length === 1 ? "the copy" : "the copies"} ${listText(copies.map(([id]) => id))}, which no server holds any more. Their records are encrypted: run \`opscrew snapshot list${run.flags} --key-file <path>\` with the recovery copy's age key file to list what they hold.`,
    );
    return [];
  }
  const listings: Pick<PlaceListing, "name" | "server" | "listing">[] = [];
  for (const [id, servers] of copies) {
    for (const server of servers) {
      const { about } = await bucketAbout(run, bucket, identity, id, server);
      listings.push({
        name: serverName(server),
        ...(server === APP_SERVER ? {} : { server }),
        listing: { abouts: [about], offsite: new Set([id]), unreadable: 0 },
      });
    }
  }
  return mergeListings(listings).map((entry) => ({
    ...entry,
    where: `only in the off-server bucket ${bucket.name}`,
    offsite: true,
  }));
}

/**
 * The bucket of `run`'s off-server copies, or `undefined` without one, or when this computer has
 * no key for it or no rclone, which a warning says: what reads the machines goes on without it.
 */
export async function readableBucket(
  run: SnapshotRun,
  services: RestoreServices,
  command: string,
): Promise<OffsiteBucket | undefined> {
  try {
    return await offsiteBucket(run, services, command);
  } catch (error) {
    if (!(error instanceof OpsCrewError)) throw error;
    if (error.code !== "CREDENTIALS_MISSING" && error.code !== "PHASE_PRECONDITION") throw error;
    run.deps.reporter.warn(
      `The off-server bucket is not read: ${error.message}${error.hint === undefined ? "" : ` ${error.hint}`}`,
    );
    return undefined;
  }
}

/**
 * Every snapshot of the environment `deps` belong to, newest first ({@link SnapshotEntry}): its
 * data snapshots ({@link dataListings}, {@link mergeListings}), the copies only its off-server
 * bucket holds ({@link bucketEntries}; the bucket is left out with a warning when this computer
 * has no key for it or no rclone) and, on servers OpsCrew created, the providers' whole-server
 * snapshots. A record that does not read as the store's contract is left out with a warning.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a site, and when a machine is not reachable or
 * its listing fails.
 */
export async function listSnapshots(
  deps: PhaseDeps,
  options: ListSnapshotsOptions = {},
): Promise<SnapshotEntry[]> {
  const run = await snapshotRun(deps, options.services);
  hideIdentity(run, options.identity);
  const listings = await dataListings(run);
  for (const { where, listing } of listings) {
    if (listing.unreadable === 0) continue;
    deps.reporter.warn(
      `${listing.unreadable} snapshot record${listing.unreadable === 1 ? "" : "s"} ${where} could not be read, so ${listing.unreadable === 1 ? "it is" : "they are"} not listed.`,
    );
  }
  const data = mergeListings(listings);
  const bucket = await readableBucket(
    run,
    options.services ?? {},
    `opscrew snapshot list${run.flags}`,
  );
  const copies =
    bucket === undefined
      ? []
      : await bucketEntries(run, bucket, new Set(data.map((entry) => entry.id)), options.identity);
  const whole =
    snapshotTarget(run) === "servers"
      ? (await providerSnapshots(run)).map((found) => found.entry)
      : [];
  return [...data, ...copies, ...whole].sort(newestFirst);
}

/** A kind of snapshot in words. */
export const KIND_WORDS: Record<SnapshotEntry["kind"], string> = {
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
