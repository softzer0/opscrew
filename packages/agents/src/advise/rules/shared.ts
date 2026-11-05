/** What advise's rules share; not exported from the package. */
import type { ComputeOffer } from "@opscrew/contracts";
import {
  type PriceList,
  type Readings,
  type Reason,
  type ServerReadings,
  THRESHOLDS,
  type Urgency,
} from "../types";

/**
 * The price list of the server's provider and location, and its type's offer in it; `undefined`
 * when the catalogue wasn't read there or doesn't have the type.
 */
export function serverPrices(
  readings: Pick<Readings, "prices">,
  target: { provider: string; location: string; serverType: string },
): { list: PriceList; offer: ComputeOffer } | undefined {
  const list = readings.prices.find(
    (prices) => prices.provider === target.provider && prices.location === target.location,
  );
  const offer = list?.offers.find((candidate) => candidate.id === target.serverType);
  return list === undefined || offer === undefined ? undefined : { list, offer };
}

/** `53%`: a share as a whole percent. */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * A server's disk filling, with its reasons: full within `diskFullDays` at the last 7 days' pace
 * (`now` within `diskFullDaysNow`, else `soon`), or `diskHigh` full on the one reading (`soon`);
 * `undefined` when neither.
 */
export function diskFilling(
  server: string,
  { now, history }: ServerReadings,
): { urgency: Urgency; reasons: Reason[] } | undefined {
  const reasons: Reason[] = [];
  const days = history?.diskFullInDays;
  if (history !== undefined && days !== undefined && days <= THRESHOLDS.diskFullDays) {
    const rounded = `${Math.round(days)} days`;
    reasons.push({
      text: `Server ${server}'s disk is full in ${rounded} at the pace of the last 7 days.`,
      figure: rounded,
      basis: { kind: "history", days: history.days },
    });
  }
  const disk = now.server?.disk;
  const share = disk === undefined ? 0 : disk.usedBytes / (disk.usedBytes + disk.freeBytes);
  if (share >= THRESHOLDS.diskHigh) {
    reasons.push({
      text: `Server ${server}'s disk is ${percent(share)} full.`,
      figure: percent(share),
      basis: { kind: "one-reading", at: now.takenAt },
    });
  }
  if (reasons.length === 0) return undefined;
  const nowFull = days !== undefined && days <= THRESHOLDS.diskFullDaysNow;
  return { urgency: nowFull ? "now" : "soon", reasons };
}
