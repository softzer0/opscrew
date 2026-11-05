/** What advise's rules share; not exported from the package. */
import type { ComputeOffer } from "@opscrew/contracts";
import { APP_SERVER, type CloudProvider, type CostEstimate } from "@opscrew/plan-schema";
import { convertMoney, pricedOffer } from "../../design/cost";
import { providerProfile } from "../../providers";
import {
  type Basis,
  type PriceList,
  type Proposal,
  type ProposalPrice,
  type Readings,
  type Reason,
  type ServerReadings,
  THRESHOLDS,
  type Urgency,
} from "../types";

/**
 * `85.1%`: a share above a threshold, to a tenth and rounded up, so it never reads at or under
 * the threshold it passed (the 1e-9 keeps float noise, such as 0.07 × 1000, from adding a tenth).
 */
export function percentAbove(share: number): string {
  return `${Math.ceil(share * 1000 - 1e-9) / 10}%`;
}

/** A fact of the plan or the catalogue, not a measured figure. */
export const PLAN: Basis = { kind: "plan" };

/** A server OpsCrew created, with its type's offer where it runs when the prices list it. */
export interface CloudServer {
  /** The plan's name: `app` or an extra server. */
  name: string;
  provider: CloudProvider;
  location: string;
  serverType: string;
  backups: boolean;
  /** {@link serverPrices}'s, when the readings have them. */
  prices?: { list: PriceList; offer: ComputeOffer };
}

/** A {@link CloudServer} whose type the prices list. */
export type PricedServer = CloudServer & { prices: { list: PriceList; offer: ComputeOffer } };

/** True when the readings' prices list `server`'s type. */
export function isPriced(server: CloudServer): server is PricedServer {
  return server.prices !== undefined;
}

/** The plan's servers OpsCrew created (the app's, then the extra ones), each with its prices. */
export function cloudServers(readings: Pick<Readings, "plan" | "prices">): CloudServer[] {
  const { plan } = readings;
  const targets = [
    { name: APP_SERVER, target: plan.target },
    ...(plan.servers ?? []).map(({ name, target }) => ({ name, target })),
  ];
  return targets.flatMap(({ name, target }) => {
    if (target.provider !== "hetzner" && target.provider !== "digitalocean") return [];
    const { provider, location, serverType, backups } = target;
    const prices = serverPrices(readings, target);
    return [
      {
        name,
        provider,
        location,
        serverType,
        backups,
        ...(prices === undefined ? {} : { prices }),
      },
    ];
  });
}

/** True when `offer` is on sale with `current`'s architecture and kind of CPU. */
export function sameKind(current: ComputeOffer, offer: ComputeOffer): boolean {
  return (
    offer.architecture === current.architecture &&
    offer.cpuType === current.cpuType &&
    offer.available &&
    !offer.deprecated
  );
}

/** The other types `server` can change to where it runs ({@link sameKind}). */
export function otherTypes({ prices: { list, offer: current } }: PricedServer): ComputeOffer[] {
  return list.offers.filter(
    (o) => o.id !== current.id && o.location === current.location && sameKind(current, o),
  );
}

/** What a type holds at least: `offer`'s memory and vCPUs, for `cheapestServerOffer`. */
export function sizeOf(offer: ComputeOffer): { memoryMb: number; vcpus: number } {
  return { memoryMb: offer.memoryGb * 1024, vcpus: offer.vcpus };
}

/** `cx33 (4 vCPU, 8 GB memory, 80 GB disk)`. */
export function offerText(offer: ComputeOffer): string {
  return `${offer.id} (${offer.vcpus} vCPU, ${offer.memoryGb} GB memory, ${offer.diskGb} GB disk)`;
}

/** A server's monthly price on `offer` from `list`: the server, its IPv4 address, its backups. */
export function serverCost(
  provider: CloudProvider,
  offer: ComputeOffer,
  list: PriceList,
  backups: boolean,
): CostEstimate {
  const { backupPercent } = providerProfile(provider);
  return pricedOffer(offer, list.extras, { backups, backupPercent }).cost;
}

/** Live when every price is; otherwise static, dated by the oldest static one. */
export function priceSource(
  prices: readonly { source: "live" | "static"; asOf?: string }[],
): Pick<ProposalPrice, "source" | "asOf"> {
  if (prices.every((p) => p.source === "live")) return { source: "live" };
  const dates = prices.flatMap((p) => (p.source === "live" || !p.asOf ? [] : [p.asOf]));
  return { source: "static", ...(dates.length === 0 ? {} : { asOf: dates.sort()[0] }) };
}

/** `before` and `after` a change, in `before`'s currency (`after` converted at the fixed rate). */
export function priceChange(before: CostEstimate, after: CostEstimate): ProposalPrice {
  const currency = before.monthly.currency;
  return {
    before: before.monthly.amount,
    after: convertMoney(after.monthly, currency).amount,
    currency,
    ...priceSource([before, after]),
  };
}

/** What changing `server`'s type to `offer` does to the app and the disk (research R5, S1). */
function typeChangeReasons(server: PricedServer, offer: ComputeOffer): Reason[] {
  const { displayName, serverNoun } = providerProfile(server.provider);
  const offline =
    server.provider === "digitalocean"
      ? `The app is offline while ${displayName} resizes the ${serverNoun}: about a minute per GB of disk in use, often less; its addresses stay the same.`
      : `The app is offline one to three minutes while ${displayName} restarts the ${serverNoun} on its new type; its addresses stay the same.`;
  const from = server.prices.offer.diskGb;
  const disk: Reason =
    offer.diskGb > from
      ? {
          text: `The change is one way: the disk grows from ${from} GB to ${offer.diskGb} GB, and ${displayName} can't make it smaller again.`,
          figure: `${from} GB to ${offer.diskGb} GB`,
          basis: PLAN,
        }
      : { text: `The disk stays ${from} GB.`, basis: PLAN };
  return [{ text: offline, basis: PLAN }, disk];
}

/**
 * The proposal to change `server`'s type to `offer` in the plan, with `reasons` and what the
 * change does, priced before and after (that server's price only).
 */
export function typeChange(
  server: PricedServer,
  offer: ComputeOffer,
  fields: Pick<Proposal, "id" | "category" | "urgency" | "reasons">,
): Proposal {
  const { name, provider, backups, prices } = server;
  return {
    ...fields,
    server: name,
    title: `Move server ${name} to ${offerText(offer)}`,
    reasons: [...fields.reasons, ...typeChangeReasons(server, offer)],
    price: priceChange(
      serverCost(provider, prices.offer, prices.list, backups),
      serverCost(provider, offer, prices.list, backups),
    ),
    apply: { kind: "plan", change: { kind: "server-type", server: name, serverType: offer.id } },
  };
}

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
