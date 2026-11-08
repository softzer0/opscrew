/**
 * The snapshot store as `opscrew snapshot` reads it (024 plan.md 1., the contract between the
 * tasks): each snapshot's `about.json`, one line, the same on servers, this computer and
 * Portainer, and its `offsite.done` marker once the off-server copy is uploaded.
 */
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { NOTHING_CHANGED } from "../promote/shared";
import type { SnapshotKind } from "./types";

/** A snapshot's id: letters and digits (`20261106T190000Z`, or a release's 64-hex digest). */
export const SNAPSHOT_ID = /^[0-9A-Za-z]+$/;

/**
 * Stops (`INVALID_INPUT`) when `id` is no snapshot's id ({@link SNAPSHOT_ID}).
 * @throws OpsCrewError `INVALID_INPUT`.
 */
export function requireSnapshotId(id: string): void {
  if (SNAPSHOT_ID.test(id)) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${id} is no snapshot's id: an id has only letters and digits. ${NOTHING_CHANGED}`,
    { hint: "`opscrew snapshot list` shows each snapshot's id." },
  );
}

/** A kind of snapshot in an approval's words. */
export const KIND_WORDS: Record<SnapshotKind, string> = {
  manual: "taken by hand",
  release: "taken before a release",
  scheduled: "taken on the schedule",
  server: "of the whole server",
};

/** The snapshots' folder in the app's folder on a server and on this computer (plan.md 1.). */
export const SERVER_SNAPSHOTS = ".snapshots";

/**
 * A part's entry in `about.json`: its file and size, with the image its service ran (none for the
 * SQLite volume, and in snapshots taken before images were recorded) and the generation of the
 * service's values then (025: none is its first, 1), or left out (`skipped`), or `failed`.
 */
const ServiceEntrySchema = z.union([
  z.object({
    name: z.string().min(1),
    kind: z.string().min(1),
    file: z.string().min(1),
    size: z.number().int().nonnegative(),
    image: z.string().min(1).optional(),
    generation: z.int().min(1).optional(),
  }),
  z.object({ name: z.string().min(1), kind: z.string().min(1), failed: z.literal(true) }),
  z.object({ name: z.string().min(1), kind: z.string().min(1), skipped: z.literal(true) }),
]);

/** `about.json` (plan.md 1.): `version` is `sha256:<hex>`, or empty before any version was known. */
export const AboutSchema = z.object({
  id: z.string().regex(SNAPSHOT_ID),
  kind: z.enum(["manual", "release", "scheduled"]),
  taken: z.iso.datetime(),
  version: z.union([z.literal(""), z.string().regex(/^sha256:[0-9a-f]{64}$/)]),
  services: z.array(ServiceEntrySchema),
});

/** One snapshot's `about.json` on one machine. */
export type About = z.infer<typeof AboutSchema>;

/** What one machine's listing holds: each complete snapshot, which have an off-server copy. */
export interface Listing {
  abouts: About[];
  /** The ids whose folder has `offsite.done`. */
  offsite: Set<string>;
  /** How many `about.json` lines did not read as the store's contract. */
  unreadable: number;
}

/** The line a listing prints for a snapshot folder with `offsite.done`: `offsite <id>`. */
export const OFFSITE_LINE = "offsite";

/** One `about.json` line as the store's contract has it, or `undefined` when it isn't one. */
export function aboutOf(line: string): About | undefined {
  try {
    const about = AboutSchema.safeParse(JSON.parse(line));
    return about.success ? about.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The listing printed by {@link listingCommand} or Portainer's list: each `about.json` on a line of
 * its own, and `offsite <id>` for each folder with `offsite.done`. Other lines are ignored.
 */
export function readListing(stdout: string): Listing {
  const listing: Listing = { abouts: [], offsite: new Set(), unreadable: 0 };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const marker = new RegExp(`^${OFFSITE_LINE} ([0-9A-Za-z]+)$`).exec(line);
    if (marker?.[1] !== undefined) {
      listing.offsite.add(marker[1]);
      continue;
    }
    if (!line.startsWith("{")) continue;
    const about = aboutOf(line);
    if (about !== undefined) listing.abouts.push(about);
    else listing.unreadable++;
  }
  return listing;
}

/**
 * The shell lines that print `offsite <id>` for each snapshot folder under `dir` with
 * `offsite.done`, after its `about.json` lines.
 */
export function offsiteLines(dir: string): string {
  return `for f in ${dir}/*/offsite.done; do if [ -f "$f" ]; then d="\${f%/offsite.done}"; echo "${OFFSITE_LINE} \${d##*/}"; fi; done`;
}

/**
 * The running version a probe printed (`version <64 hex>`, read from `.env` or `.running`), as
 * `about.json` records it: `sha256:<hex>`, or empty without one.
 */
export function versionLine(stdout: string): string {
  const hex = /^version ([0-9a-f]{64})$/m.exec(stdout)?.[1];
  return hex === undefined ? "" : `sha256:${hex}`;
}

/** A snapshot's id by hand, its UTC time to the second: `20261106T190000Z`. */
export function snapshotIdAt(time: Date): string {
  return `${time.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}
