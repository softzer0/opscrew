import { rm } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, type ProjectPaths, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import { OTHER_REGISTRAR_IDS } from "./registrars";

/**
 * Shortest and longest wait (seconds) once old DS records are gone. Never less than 24 hours: a
 * lookup through a caching resolver reports the TTL that is left, not the TTL other resolvers
 * cached the record with.
 */
const DS_WAIT_SECONDS = { min: 86_400, max: 172_800 } as const;

const IsoSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)));

const ConnectStateSchema = z.strictObject({
  domain: z.string().min(1),
  registrar: z.enum(OTHER_REGISTRAR_IDS),
  /** The Cloudflare zone created for the domain, once there is one. */
  zoneId: z.string().min(1).optional(),
  /**
   * When a run first saw old DS records that OpsCrew did not remove itself. Set until a run sees
   * them gone: from then on the switch waits `waitSeconds`.
   */
  dsSeen: IsoSchema.optional(),
  /**
   * The earliest time the nameservers may switch: when resolvers have forgotten the old DS
   * records. Every run only ever moves it later. Absent until the records are removed through the
   * API or a run sees them gone.
   */
  switchAfter: IsoSchema.optional(),
  /** The longest wait (seconds) for the DS records' TTL that any run saw (see `dsWaitSeconds`). */
  waitSeconds: z.number().int().min(DS_WAIT_SECONDS.min).max(DS_WAIT_SECONDS.max),
});

/**
 * Local note about a domain being connected while its old DNSSEC (DS) records expire from
 * resolvers' caches. Resolvers keep the registry's DS record for its TTL (often a day), and
 * switching nameservers while they still hold the old one takes the domain offline for every
 * visitor whose resolver checks DNSSEC. So the switch waits until neither the registrar's API nor
 * the public DNS shows an old DS record and `switchAfter` has passed; this note keeps that time
 * between runs. Holds no contact data or secrets.
 */
export type ConnectState = z.infer<typeof ConnectStateSchema>;

/**
 * Extra wait after a removal through the registrar's API: the registry may keep publishing the DS
 * record for a while after the registrar accepted the delete.
 */
export const REMOVAL_MARGIN_SECONDS = 3600;

/** `<projectHome>/domain-connect.json`, next to the purchase record. */
export function connectStatePath(paths: ProjectPaths): string {
  return join(paths.projectHomeDir, "domain-connect.json");
}

/** The wait for a DS TTL: the TTL within 24 and 48 hours (24 hours when it is unknown). */
export function dsWaitSeconds(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isFinite(ttl)) return DS_WAIT_SECONDS.min;
  return Math.min(DS_WAIT_SECONDS.max, Math.max(DS_WAIT_SECONDS.min, Math.ceil(ttl)));
}

/**
 * The switch time for the note: `at` (milliseconds), unless the note's `switchAfter` is later. The
 * switch time only ever moves later.
 */
export function laterSwitch(state: ConnectState | undefined, at: number): string {
  const noted = state?.switchAfter === undefined ? at : Date.parse(state.switchAfter);
  return new Date(Math.max(noted, at)).toISOString();
}

/**
 * The note, or undefined when there is none. An unreadable note stops the run: OpsCrew cannot tell
 * whether old DS records were removed recently.
 */
export async function readConnectState(file: string): Promise<ConnectState | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const parsed = ConnectStateSchema.safeParse(data);
  if (!parsed.success) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew cannot read its note about connecting a domain (${file}), so it cannot tell when old DNSSEC records were removed.`,
      {
        hint: "If old DS records of the domain were removed in the last 48 hours, wait until 48 hours have passed. Then delete that file and run the command again.",
      },
    );
  }
  return parsed.data;
}

export async function writeConnectState(file: string, state: ConnectState): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

export async function removeConnectState(file: string): Promise<void> {
  await rm(file, { force: true });
}
