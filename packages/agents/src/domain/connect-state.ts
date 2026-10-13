import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import type { OtherRegistrarId } from "./registrars";

/**
 * Local note about a domain being connected while its old DNSSEC (DS) records expire from
 * resolvers' caches. Resolvers keep the registry's DS record for its TTL (often a day), and
 * switching nameservers while they still hold the old one takes the domain offline for every
 * visitor whose resolver checks DNSSEC. So the switch waits until neither the registrar's API nor
 * the public DNS shows an old DS record and the later of the removal and the public "gone" time
 * is older than the wait; this note keeps the times between runs. Holds no contact data or
 * secrets.
 */
export interface ConnectState {
  domain: string;
  registrar: OtherRegistrarId;
  /** The Cloudflare zone created for the domain, once there is one. */
  zoneId?: string;
  /** When a run first saw old DS records published. */
  dsSeenAt?: string;
  /** When OpsCrew removed the old DS records through the registrar's API. */
  dsRemovedAt?: string;
  /**
   * When the old DS records are gone from the public DNS: the first run that saw them gone, or,
   * while the public DNS still shows them, when its copy expires (refreshed on every such run).
   */
  dsGoneSeenAt?: string;
  /** How long to wait once the old DS records are gone (seconds, 24 to 48 hours). */
  dsTtlSeconds: number;
}

/**
 * Shortest, default and longest wait (seconds) between the DS removal and the switch. Never less
 * than 24 hours: a lookup through a caching resolver reports the TTL that is left, not the TTL
 * other resolvers cached the record with.
 */
export const DS_WAIT_SECONDS = { min: 86_400, fallback: 86_400, max: 172_800 } as const;

const IsoSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)));

const ConnectStateSchema = z.object({
  domain: z.string().min(1),
  registrar: z.enum(["porkbun", "namecheap", "godaddy"]),
  zoneId: z.string().min(1).optional(),
  dsSeenAt: IsoSchema.optional(),
  dsRemovedAt: IsoSchema.optional(),
  dsGoneSeenAt: IsoSchema.optional(),
  dsTtlSeconds: z.number().int().min(DS_WAIT_SECONDS.min).max(DS_WAIT_SECONDS.max),
});

/** `<projectHome>/domain-connect.json`, next to the purchase record. */
export function connectStatePath(paths: ProjectPaths): string {
  return join(paths.projectHomeDir, "domain-connect.json");
}

/** The wait for a DS TTL: the TTL within 24 and 48 hours (24 hours when it is unknown). */
export function dsWaitSeconds(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isFinite(ttl)) return DS_WAIT_SECONDS.fallback;
  return Math.min(DS_WAIT_SECONDS.max, Math.max(DS_WAIT_SECONDS.min, Math.ceil(ttl)));
}

/**
 * Extra wait after a removal through the registrar's API: the registry may keep publishing the DS
 * record for a while after the registrar accepted the delete.
 */
export const REMOVAL_MARGIN_SECONDS = 3600;

/**
 * When the nameservers may switch: the later of the removal through the API and the public "gone"
 * time, plus the wait, plus an hour when OpsCrew removed the records through the API. Undefined
 * when neither time is recorded yet.
 */
export function switchSafeAt(state: ConnectState): Date | undefined {
  const times = [state.dsRemovedAt, state.dsGoneSeenAt]
    .filter((t): t is string => t !== undefined)
    .map((t) => Date.parse(t));
  if (times.length === 0) return undefined;
  const margin = state.dsRemovedAt === undefined ? 0 : REMOVAL_MARGIN_SECONDS;
  return new Date(Math.max(...times) + (state.dsTtlSeconds + margin) * 1000);
}

/**
 * The note, or undefined when there is none. An unreadable note stops the run: OpsCrew cannot tell
 * whether old DS records were removed recently.
 */
export async function readConnectState(file: string): Promise<ConnectState | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  const { zoneId, dsSeenAt, dsRemovedAt, dsGoneSeenAt, ...required } = parsed.data;
  return {
    ...required,
    ...(zoneId === undefined ? {} : { zoneId }),
    ...(dsSeenAt === undefined ? {} : { dsSeenAt }),
    ...(dsRemovedAt === undefined ? {} : { dsRemovedAt }),
    ...(dsGoneSeenAt === undefined ? {} : { dsGoneSeenAt }),
  };
}

export async function writeConnectState(file: string, state: ConnectState): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

export async function removeConnectState(file: string): Promise<void> {
  await rm(file, { force: true });
}
