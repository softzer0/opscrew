import type { DsRecord, Registrar } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { auditDomain } from "./common";
import { lookupPublishedDs } from "./connect-dns";
import {
  type ConnectState,
  dsWaitSeconds,
  laterSwitch,
  REMOVAL_MARGIN_SECONDS,
  readConnectState,
  writeConnectState,
} from "./connect-state";
import { type OtherRegistrarId, REGISTRAR_NAMES, registrarLinks } from "./registrars";
import { dsRecordText, sameDs } from "./switch";

/**
 * Old DNSSEC (DS) records before a nameserver switch (`domain connect`, and the move between
 * Cloudflare accounts): reading them, removing them through the registrar's API and noting how long
 * resolvers may still remember them. Switching nameservers while resolvers hold an old DS record
 * takes the domain offline for every visitor whose resolver checks DNSSEC.
 */

/** The DS records published for the domain now. */
export interface DsReading {
  /** What the registrar's API lists (registrars with DNSSEC in their API). */
  api?: DsRecord[];
  /** What the public DNS shows. */
  public: DsRecord[];
  /** Both combined: before the switch, every one of them is an old DS record. */
  records: DsRecord[];
  /** The public answer's TTL: how long its copy of the records has left (seconds). */
  ttlSeconds?: number;
  /** When they were read. */
  at: Date;
}

/** What reading the DS records needs. */
export interface DsContext {
  deps: PhaseDeps;
  domain: string;
  /** The registrar's API, when OpsCrew drives it; without one only the public DNS is read. */
  registrar?: Registrar;
}

/** What removing the old DS records and noting the wait needs. */
export interface DsRemovalContext extends DsContext {
  registrarId: OtherRegistrarId;
  registrar: Registrar;
  /** The note an earlier run wrote (`readConnectState`), if any: waits only ever grow. */
  state: ConnectState | undefined;
  /** The reading the approval showed (`readDs`): the records its API lists are removed. */
  ds: DsReading;
  /** The Cloudflare zone the nameservers switch to (noted, and named in the audit). */
  zoneId: string;
}

/** Whether the switch still waits for removed DS records to be forgotten (`dsWaitStatus`). */
export interface DsWaitStatus {
  /** True until `switchAfter` (and while old DS records were seen but no switch time is noted). */
  waiting: boolean;
  /** The earliest time the nameservers may switch, once noted. */
  switchAfter?: string;
  /** The wait (seconds) noted for the DS records' TTL. */
  waitSeconds: number;
}

/** Adds the records `extra` has and `list` lacks (same DS record: see `sameDs`). */
export function unionDs(list: readonly DsRecord[], extra: readonly DsRecord[]): DsRecord[] {
  const all = [...list];
  for (const record of extra) if (!all.some((r) => sameDs(r, record))) all.push(record);
  return all;
}

/**
 * The DS records published now: what the registrar's API lists (registrars with DNSSEC in their
 * API) and what the public DNS shows, combined. A failed public lookup stops the run: OpsCrew
 * never switches nameservers on a guess.
 */
export async function readDs(ctx: DsContext): Promise<DsReading> {
  const { registrar, domain, deps } = ctx;
  const at = deps.clock.now();
  const api =
    registrar?.capabilities.dnssec === true && registrar.listDsRecords !== undefined
      ? await registrar.listDsRecords(domain)
      : undefined;
  const published = await lookupPublishedDs(deps.fetch, domain);
  return {
    api,
    public: published.records,
    records: unionDs(api ?? [], published.records),
    ttlSeconds: published.ttlSeconds,
    at,
  };
}

/**
 * When the old DS records are gone from the public DNS at the earliest (milliseconds): when the
 * copy the public answer showed expires, and never before `after`.
 */
function publicGoneAt(ds: DsReading, after: Date): number {
  const expires =
    ds.public.length > 0 && ds.ttlSeconds !== undefined
      ? ds.at.getTime() + ds.ttlSeconds * 1000
      : after.getTime();
  return Math.max(after.getTime(), expires);
}

/** The wait for these DS records: their TTL within 24 and 48 hours, never shorter than noted. */
export function waitFor(state: ConnectState | undefined, ds: DsReading): number {
  return Math.max(dsWaitSeconds(ds.ttlSeconds), state?.waitSeconds ?? 0);
}

/**
 * The switch time once the old DS records were removed through the API (or are no longer listed
 * there) at `at`: the wait after the public DNS's copy expires, plus an hour in case the registry
 * publishes them a little longer, never earlier than the note says.
 */
export function switchAfterRemoval(
  state: ConnectState | undefined,
  ds: DsReading,
  at: Date,
): string {
  const wait = waitFor(state, ds) + REMOVAL_MARGIN_SECONDS;
  return laterSwitch(state, publicGoneAt(ds, at) + wait * 1000);
}

/**
 * The note while old DS records OpsCrew did not remove are published: when they were first seen
 * and the wait that starts once a run sees them gone.
 */
export function seenState(
  ctx: Pick<DsRemovalContext, "deps" | "domain" | "registrarId" | "state">,
  zoneId: string | undefined,
  ds: DsReading,
): ConnectState {
  return {
    domain: ctx.domain,
    registrar: ctx.registrarId,
    zoneId,
    dsSeen: ctx.state?.dsSeen ?? ctx.deps.clock.now().toISOString(),
    switchAfter: ctx.state?.switchAfter,
    waitSeconds: waitFor(ctx.state, ds),
  };
}

/** Removes DS records through the registrar's API (one call per key tag), each audited. */
async function removeDsRecords(
  ctx: DsRemovalContext,
  records: readonly DsRecord[],
  why: string,
): Promise<void> {
  const { deps, domain, registrar } = ctx;
  const name = REGISTRAR_NAMES[ctx.registrarId];
  const remove = registrar.removeDsRecord?.bind(registrar);
  if (records.length === 0 || remove === undefined) return;
  deps.reporter.step(`Removing DNSSEC (DS) records of ${domain} at ${name}…`);
  for (const keyTag of new Set(records.map((ds) => ds.keyTag))) {
    await remove(domain, keyTag);
    const removed = records
      .filter((ds) => ds.keyTag === keyTag)
      .map((ds) => `algorithm ${ds.algorithm}, digest type ${ds.digestType}`)
      .join("; ");
    await auditDomain(
      deps,
      "remove DS record",
      domain,
      `${name}: key tag ${keyTag} (${removed}), ${why}`,
    );
  }
}

/**
 * Removes the old DS records the registrar's API lists (`ctx.ds.api`) and notes in `stateFile`
 * when the nameservers may switch: the wait after the public DNS's copy expires, plus an hour. A
 * note is written before the first removal, so an interrupted run still waits. The caller asks
 * for the approval first. Stops before any change when the API cannot remove them. Returns the
 * note written. DS records only the public DNS shows (the API does not list them) are the
 * caller's to handle, as `domain connect` does: removed in the registrar's dashboard before
 * anything changes, or, after a removal, a later switch time while the public DNS still shows them.
 */
export async function removeDsAndWait(
  ctx: DsRemovalContext,
  stateFile: string,
): Promise<ConnectState & { switchAfter: string }> {
  const { deps, domain, registrar, ds, zoneId } = ctx;
  const listed = ds.api ?? [];
  if (listed.length > 0 && (!registrar.capabilities.dnssec || !registrar.removeDsRecord)) {
    const name = REGISTRAR_NAMES[ctx.registrarId];
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name}'s API cannot remove the DNSSEC (DS) records of ${domain}. Nothing was changed.`,
      {
        hint: `Remove them in ${name}'s dashboard (${registrarLinks(ctx.registrarId, deps.env).domains}): ${listed.map(dsRecordText).join("; ")}. Then run the command again.`,
      },
    );
  }
  const seen = seenState(ctx, zoneId, ds);
  await writeConnectState(stateFile, seen);
  await removeDsRecords(ctx, listed, `before switching to zone ${zoneId}`);
  const switchAfter = laterSwitch(
    seen,
    Date.parse(switchAfterRemoval(ctx.state, ds, deps.clock.now())),
  );
  const removed = {
    domain,
    registrar: ctx.registrarId,
    zoneId,
    switchAfter,
    waitSeconds: seen.waitSeconds,
  };
  await writeConnectState(stateFile, removed);
  return removed;
}

/**
 * Starts the noted wait at `now` for old DS records a run sees gone (they were seen, or removed by
 * a run interrupted before it noted the switch time): resolvers may hold them for the whole wait
 * from now on. Writes the note and returns the switch time (never earlier than noted).
 */
export async function startDsWait(
  stateFile: string,
  state: ConnectState,
  now: Date,
): Promise<string> {
  const switchAfter = laterSwitch(state, now.getTime() + state.waitSeconds * 1000);
  await writeConnectState(stateFile, { ...state, dsSeen: undefined, switchAfter });
  return switchAfter;
}

/**
 * The wait `stateFile`'s note says (see `removeDsAndWait`) at `now`, given the DS records read
 * now (`readDs`); undefined when there is no note. A note that saw old DS records but holds no
 * switch time (a removal interrupted before it noted one) starts its wait once the registrar's
 * API lists none (`startDsWait`, the note is updated); while the API still lists one, it waits
 * without a time. An unreadable note stops (see `readConnectState`).
 */
export async function dsWaitStatus(
  stateFile: string,
  now: Date,
  ds: DsReading,
): Promise<DsWaitStatus | undefined> {
  const state = await readConnectState(stateFile);
  if (state === undefined) return undefined;
  const { waitSeconds } = state;
  let { switchAfter } = state;
  if (state.dsSeen !== undefined || switchAfter === undefined) {
    if ((ds.api ?? []).length > 0) return { waiting: true, waitSeconds };
    switchAfter = await startDsWait(stateFile, state, now);
  }
  return { waiting: now.getTime() < Date.parse(switchAfter), switchAfter, waitSeconds };
}
