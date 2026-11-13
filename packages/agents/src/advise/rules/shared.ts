/**
 * What advise's rules share; not exported from the package.
 *
 * A reason's `text` states its claim, without a closing full stop; its `figure`, when it has one,
 * holds the measured or priced number once, and the report adds it after the text in parentheses.
 */
import type { ComputeOffer } from "@opscrew/contracts";
import { plural } from "@opscrew/core";
import {
  APP_SERVER,
  type CloudProvider,
  type CostEstimate,
  type DeployPlan,
  type ExtraServer,
  isCloudTarget,
} from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { backupsOnOrderPage, orderPageBackupsText } from "../../design/backups";
import { convertMoney, costFor } from "../../design/cost";
import { noResizeText, resizesInPlace, resizeWaysText } from "../../design/server-changes";
import { providerProfile } from "../../providers";
import type { ResourceReading } from "../../status";
import {
  type Basis,
  type PriceList,
  type Proposal,
  type ProposalPrice,
  type Readings,
  type Reason,
  type ServerHistory,
  type ServerReadings,
  THRESHOLDS,
  type Urgency,
} from "../types";

/** A fact of the plan or the catalogue, not a measured figure. */
export const PLAN: Basis = { kind: "plan" };

/** Figures over `history`'s days. */
export function historyBasis(history: Pick<ServerHistory, "days">): Basis {
  return { kind: "history", days: history.days };
}

/** A figure of the one reading `now`. */
export function readingBasis(now: Pick<ResourceReading, "takenAt">): Basis {
  return { kind: "one-reading", at: now.takenAt };
}

/** A sentence written elsewhere, as a reason's text: without its closing full stop. */
export function withoutStop(sentence: string): string {
  return sentence.replace(/\.$/, "");
}

/** The plan's servers by name: the app's, then the extra ones. */
export function planTargets(
  plan: Pick<DeployPlan, "target" | "servers">,
): { name: string; target: DeployPlan["target"] | ExtraServer["target"] }[] {
  return [
    { name: APP_SERVER, target: plan.target },
    ...(plan.servers ?? []).map(({ name, target }) => ({ name, target })),
  ];
}

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
  return planTargets(readings.plan).flatMap(({ name, target }) => {
    if (!isCloudTarget(target)) return [];
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
  return costFor(offer, list.extras, { backups, backupPercent });
}

/** Live when every price is; otherwise static, dated by the oldest static one. */
export function priceSource(
  prices: readonly { source: "live" | "static"; asOf?: string }[],
): Pick<ProposalPrice, "source" | "asOf"> {
  if (prices.every((p) => p.source === "live")) return { source: "live" };
  const dates = prices.flatMap((p) => (p.source === "live" || !p.asOf ? [] : [p.asOf]));
  return { source: "static", ...(dates.length === 0 ? {} : { asOf: dates.sort()[0] }) };
}

/**
 * `before` and `after` a change, in `before`'s currency (`after` converted at the fixed rate), with
 * which side includes VAT when one does.
 */
export function priceChange(before: CostEstimate, after: CostEstimate): ProposalPrice {
  const currency = before.monthly.currency;
  const vat = before.pricesIncludeVat || after.pricesIncludeVat;
  return {
    before: before.monthly.amount,
    after: convertMoney(after.monthly, currency).amount,
    currency,
    ...priceSource([before, after]),
    ...(vat
      ? { includesVat: { before: before.pricesIncludeVat, after: after.pricesIncludeVat } }
      : {}),
  };
}

/**
 * What changing `server`'s type to `offer` does to the app and the disk (research R5, S1), at a
 * provider that changes a server's size in place.
 */
function typeChangeReasons(server: PricedServer, offer: ComputeOffer): Reason[] {
  const { displayName, texts } = cloudProvider(server.provider);
  // Present for every provider that resizes in place.
  const offline = texts.resizeOffline;
  const from = server.prices.offer.diskGb;
  const disk =
    offer.diskGb > from
      ? `The change is one way: the disk grows from ${from} GB to ${offer.diskGb} GB, and ${displayName} can't make it smaller again`
      : `The disk stays ${from} GB`;
  return [
    ...(offline === undefined ? [] : [{ text: offline, basis: PLAN }]),
    { text: disk, basis: PLAN },
  ];
}

/**
 * The proposal to change `server`'s type to `offer` in the plan, with `reasons` and what the
 * change does, priced before and after (that server's price only). At a provider that can't change
 * a server's size in place, the plan is not changed: the proposal says why and names the two ways,
 * by hand (`resizeWaysText`).
 */
export function typeChange(
  server: PricedServer,
  offer: ComputeOffer,
  fields: Pick<Proposal, "id" | "category" | "urgency" | "reasons">,
): Proposal {
  const { name, provider, backups, prices } = server;
  const price = priceChange(
    serverCost(provider, prices.offer, prices.list, backups),
    serverCost(provider, offer, prices.list, backups),
  );
  const unpriced = backups ? orderPageReasons(provider, "either price") : [];
  if (!resizesInPlace(provider)) {
    return {
      ...fields,
      server: name,
      title: `Move server ${name} to a new ${offerText(offer)}`,
      reasons: [...fields.reasons, { text: noResizeText(provider), basis: PLAN }, ...unpriced],
      price,
      apply: { kind: "manual", text: resizeWaysText(provider) },
    };
  }
  return {
    ...fields,
    server: name,
    title: `Move server ${name} to ${offerText(offer)}`,
    reasons: [...fields.reasons, ...typeChangeReasons(server, offer), ...unpriced],
    price,
    apply: { kind: "plan", change: { kind: "server-type", server: name, serverType: offer.id } },
  };
}

/**
 * That backups priced only on `provider`'s order page (Contabo's Auto Backup) are not in `what`
 * (`this total`, `either price`): none at every other provider.
 */
export function orderPageReasons(provider: string, what: string): Reason[] {
  if (!backupsOnOrderPage(provider)) return [];
  return [{ text: withoutStop(orderPageBackupsText(provider, what)), basis: PLAN }];
}

/**
 * The price list of the server's provider and location, and its type's offer in it; `undefined`
 * when the catalogue wasn't read there or doesn't have the type.
 */
function serverPrices(
  readings: Pick<Readings, "prices">,
  target: { provider: string; location: string; serverType: string },
): { list: PriceList; offer: ComputeOffer } | undefined {
  const list = readings.prices.find(
    (prices) => prices.provider === target.provider && prices.location === target.location,
  );
  const offer = list?.offers.find((candidate) => candidate.id === target.serverType);
  return list === undefined || offer === undefined ? undefined : { list, offer };
}

/**
 * `85.1%`: a share above a threshold, to a tenth and rounded up, so it never reads at or under
 * the threshold it passed (the 1e-9 keeps float noise, such as 0.07 × 1000, from adding a tenth).
 */
export function percentAbove(share: number): string {
  return `${Math.ceil(share * 1000 - 1e-9) / 10}%`;
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
    reasons.push({
      text: `Server ${server}'s disk is filling at the pace of the last 7 days`,
      figure: `full in ${plural(Math.round(days), "day")}`,
      basis: historyBasis(history),
    });
  }
  const disk = now.server?.disk;
  const share = disk === undefined ? 0 : disk.usedBytes / (disk.usedBytes + disk.freeBytes);
  if (share >= THRESHOLDS.diskHigh) {
    reasons.push({
      text: `Server ${server}'s disk is nearly full`,
      figure: `${percent(share)} in use`,
      basis: readingBasis(now),
    });
  }
  if (reasons.length === 0) return undefined;
  const nowFull = days !== undefined && days <= THRESHOLDS.diskFullDaysNow;
  return { urgency: nowFull ? "now" : "soon", reasons };
}
