/**
 * Advise's cost rules (feature 021, US5; plan.md "4. The rules"): the servers above the interview's
 * budget, a cheaper type with at least the same CPUs, memory and disk where a server runs, and a
 * server with at least its vCPUs, memory and disk for less at another provider, compared on the
 * same basis. Prices come from the catalogues, live or dated.
 */
import type { ComputeOffer, Currency, Money, ProviderExtras } from "@opscrew/contracts";
import { formatMoney, plural, taxLabel, upperFirst } from "@opscrew/core";
import {
  APP_SERVER,
  type CloudProvider,
  type CostEstimate,
  isServerlessProvider,
  type Region,
  type Requirements,
} from "@opscrew/plan-schema";
import { backupsByDefault, backupsOnOrderPage, orderPageProviders } from "../../design/backups";
import {
  convertMoney,
  EXCHANGE_RATE_NOTE,
  offerTerms,
  priceLabel,
  roundCents,
} from "../../design/cost";
import { noResizeText, resizesInPlace } from "../../design/server-changes";
import { cheapestServerOffer } from "../../design/servers";
import { noProviderBackupsText } from "../../design/snapshots";
import { designWording } from "../../design/wording";
import { cancelTerm } from "../../destroy/texts";
import { providerProfile, VPS_PROVIDERS } from "../../providers";
import { hasExtraServers } from "../../shared/servers";
import type { Proposal, ProposalPrice, Readings, Reason } from "../types";
import {
  type CloudServer,
  cloudServers,
  isPriced,
  offerText,
  orderPageReasons,
  otherTypes,
  PLAN,
  type PricedServer,
  priceChange,
  priceSource,
  sameKind,
  serverCost,
  sizeOf,
  typeChange,
  withoutStop,
} from "./shared";
import { sizeRules } from "./size";

/** Prices compared across currencies, at design's fixed rate. */
const EXCHANGE_RATE: Reason = { text: withoutStop(EXCHANGE_RATE_NOTE), basis: PLAN };

/** A cheaper type where `server` runs with at least its CPUs, memory and disk (US5-2). */
function cheaperType(server: PricedServer): Proposal[] {
  const current = server.prices.offer;
  const offer = cheapestServerOffer(
    otherTypes(server).filter((o) => o.monthly.amount < current.monthly.amount),
    server.location,
    sizeOf(current),
    current.diskGb,
  );
  if (offer === undefined) return [];
  return [
    typeChange(server, offer, {
      id: `cost.${server.name}.cheaper-type`,
      category: "cost",
      urgency: "when-convenient",
      reasons: [
        {
          text: `${offer.id} has at least the CPUs, memory and disk of ${current.id}, for less`,
          basis: PLAN,
        },
      ],
    }),
  ];
}

/**
 * The highest standard VAT rate in the EU (Hungary's), in percent: the most VAT a price that
 * includes it can hold.
 */
const MOST_VAT_PERCENT = 27;

/** A move to another provider saves at least one part in this many of the server's price (10%). */
const MOVE_SAVING_PARTS = 10;

/** A move to another provider pays its setup fee back within this many months. */
const SETUP_FEE_MONTHS = 3;

/**
 * The app's server at `other` in `region`, with at least its CPUs, memory and disk, priced with
 * `backups`: the cheapest type at each of the region's locations, then the cheapest of those.
 */
function cheapestAt(
  readings: Readings,
  app: PricedServer,
  other: CloudProvider,
  region: Region,
  backups: boolean,
) {
  const current = app.prices.offer;
  const locations = providerProfile(other).regionLocations[region];
  return readings.prices
    .filter((list) => list.provider === other && locations.includes(list.location))
    .flatMap((list) => {
      const offers = list.offers.filter((o) => sameKind(current, o));
      const offer = cheapestServerOffer(offers, list.location, sizeOf(current), current.diskGb);
      return offer === undefined
        ? []
        : [{ other, offer, extras: list.extras, cost: serverCost(other, offer, list, backups) }];
    })
    .sort(
      (a, b) =>
        a.cost.monthly.amount - b.cost.monthly.amount ||
        locations.indexOf(a.offer.location) - locations.indexOf(b.offer.location),
    )[0];
}

/**
 * The automated backups each side of a move to `other` is priced with, so both have the same data
 * protection: none where either provider prices them only on its order page (Contabo's Auto
 * Backup has no price per plan, R15), so neither side counts them; the app's where both providers
 * offer them; none where `other` offers none (OpsCrew's
 * data snapshots replace them there); from a provider without them, the new server's as design
 * sets them (on in prod when the interview says the data matters: `backupsByDefault`), as the
 * move turns them on.
 */
function backupsOf(
  app: PricedServer,
  other: CloudProvider,
  requirements: Pick<Requirements, "dataCriticality">,
  environment: string,
): { before: boolean; after: boolean } {
  if (backupsOnOrderPage(other) || backupsOnOrderPage(app.provider)) {
    return { before: false, after: false };
  }
  if (!providerProfile(other).providerBackups) return { before: false, after: false };
  if (!providerProfile(app.provider).providerBackups) {
    return { before: false, after: backupsByDefault(requirements, environment) };
  }
  return { before: app.backups, after: app.backups };
}

/** An amount in whole cents, so the thresholds' edges don't depend on float noise. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * What a price after a change is multiplied by to compare it with the price before, whatever VAT
 * the user pays. OpsCrew has no VAT rate to put a price with VAT and one without on one basis, so a
 * price with VAT after one without is compared as it is (without VAT it is lower still), and a
 * price without VAT after one with it gets {@link MOST_VAT_PERCENT} on top.
 */
function vatFactor(vat: ProposalPrice["includesVat"]): number {
  return vat?.before === true && !vat.after ? 1 + MOST_VAT_PERCENT / 100 : 1;
}

/** The monthly saving of `price` that holds whatever VAT the user pays ({@link vatFactor}). */
function fairSaving(price: ProposalPrice): number {
  return roundCents(price.before - price.after * vatFactor(price.includesVat));
}

/**
 * `offer`'s setup fee in whole cents of `before`'s currency, on the same basis as the saving
 * ({@link vatFactor}); `undefined` when it has none.
 */
function feeCents(before: CostEstimate, offer: ComputeOffer): number | undefined {
  if (offer.setupFee === undefined) return undefined;
  const fee = convertMoney(offer.setupFee, before.monthly.currency).amount;
  const factor = vatFactor({ before: before.pricesIncludeVat, after: offer.pricesIncludeVat });
  return cents(fee * factor);
}

/**
 * True when a move whose fair `saving` a month is on `before` is worth proposing: it saves at
 * least one part in {@link MOVE_SAVING_PARTS} of `before` and pays the offer's setup fee, if any,
 * back within {@link SETUP_FEE_MONTHS} months; compared in whole cents.
 */
function worthMoving(before: CostEstimate, offer: ComputeOffer, saving: number): boolean {
  const fee = feeCents(before, offer);
  const covered = fee === undefined || fee <= cents(saving) * SETUP_FEE_MONTHS;
  return cents(saving) * MOVE_SAVING_PARTS >= cents(before.monthly.amount) && covered;
}

/** `€5.50 (incl. VAT, estimate as of 2026-11-11)`: a side's price, its VAT and where it is from. */
function sideText(cost: CostEstimate): string {
  const vat = taxLabel(cost.monthly.currency, cost.pricesIncludeVat);
  return `${formatMoney(cost.monthly)} (${vat}, ${priceLabel(cost)})`;
}

/** What a move from `here` to `there` says of VAT when only one side's price includes it. */
function vatReasons(
  names: { here: string; there: string },
  before: CostEstimate,
  after: CostEstimate,
): Reason[] {
  const { here, there } = names;
  if (before.pricesIncludeVat === after.pricesIncludeVat) return [];
  const text = after.pricesIncludeVat
    ? `${there}'s price includes VAT and ${here}'s doesn't: without VAT the saving is larger still (OpsCrew doesn't know your VAT rate to take it off)`
    : `${here}'s price includes VAT and ${there}'s doesn't: the saving holds even with ${MOST_VAT_PERCENT}% VAT on ${there}'s, the highest rate in the EU`;
  return [{ text, basis: PLAN }];
}

/**
 * The app's server for less at another provider OpsCrew moves apps to (the largest saving of
 * them), in the interview's region, with at least its vCPUs, memory and disk (US5-3): `opscrew
 * retarget`, which moves an app on one server only. Both sides are priced with the same data
 * protection ({@link backupsOf}), and the move is proposed only when the saving holds whatever VAT
 * the user pays ({@link fairSaving}), is at least 10% of the current server's monthly price and
 * pays any setup fee back within 3 months ({@link worthMoving}). Each side's price names its VAT and
 * its date; a provider with terms has them said, the setup fee with the months until the saving
 * covers it.
 */
function otherProvider(readings: Readings, app: PricedServer | undefined): Proposal[] {
  const { requirements, plan, flags } = readings;
  const region = requirements?.region;
  if (app === undefined || requirements === undefined || region === undefined) return [];
  if (hasExtraServers(plan)) return [];
  const { offer: current, list: here } = app.prices;
  const best = VPS_PROVIDERS.filter((id) => id !== app.provider)
    .flatMap((other) => {
      const backups = backupsOf(app, other, requirements, plan.environment?.name ?? "prod");
      const found = cheapestAt(readings, app, other, region, backups.after);
      if (found === undefined) return [];
      const before = serverCost(app.provider, current, here, backups.before);
      const price = priceChange(before, found.cost);
      const saving = fairSaving(price);
      return worthMoving(before, found.offer, saving)
        ? [{ ...found, backups, before, price, saving }]
        : [];
    })
    .sort((a, b) => b.saving - a.saving)[0];
  if (best === undefined) return [];
  const { other, offer, before, cost: after, price } = best;
  const names = { here: designWording(app.provider).name, there: designWording(other).name };
  const { there } = names;
  const place = providerProfile(other).locationNames[offer.location] ?? offer.location;
  const command = `opscrew retarget --to ${other}${flags}`;
  const cancelled = cancelTerm(app.provider) !== undefined;
  return [
    {
      id: `cost.${APP_SERVER}.other-provider`,
      category: "cost",
      urgency: "when-convenient",
      server: APP_SERVER,
      title: `Move the app to ${there}: ${offerText(offer)} in ${place}`,
      reasons: [
        {
          text: `A server with at least the vCPUs, memory and disk of ${current.id} costs less at ${there}: ${offer.id} there against ${current.id} at ${names.here}`,
          figure: `${sideText(after)} against ${sideText(before)} a month`,
          basis: PLAN,
        },
        ...(before.monthly.currency === after.monthly.currency ? [] : [EXCHANGE_RATE]),
        ...vatReasons(names, before, after),
        ...backupReasons(app, best, names, requirements),
        ...termReasons(best),
        ...snapshotReasons(current, { here: here.extras, there: best.extras }, names),
        ...(cancelled
          ? [
              {
                text: `${names.here} bills the old server to the end of its term, so the saving starts after it`,
                basis: PLAN,
              },
            ]
          : []),
        {
          text: `\`${command}\` moves the app with a short maintenance window: it creates the new server, copies the data and switches the domain, and \`--finish\` ${cancelled ? "cancels the old server at the end of its term" : "deletes the old server"}`,
          basis: PLAN,
        },
      ],
      price,
      apply: { kind: "command", command },
    },
  ];
}

/**
 * What a move says of the providers' backups when they differ: with the app's on and a provider
 * that prices them only on its order page on either side, that both prices leave them out; at a
 * new provider without them,
 * that OpsCrew's data snapshots replace them, that the app's were left out of its price and that
 * the off-server copy's bucket isn't counted; from a provider without them, the new server's
 * backups priced in when the interview's data has them on.
 */
function backupReasons(
  app: PricedServer,
  move: { other: CloudProvider; backups: { after: boolean } },
  names: { here: string; there: string },
  requirements: Pick<Requirements, "dataCriticality">,
): Reason[] {
  const { here, there } = names;
  const bucket = "the bucket for the snapshots' encrypted copy off the server isn't counted";
  const orderPage = [move.other, app.provider].find(backupsOnOrderPage);
  if (orderPage !== undefined) {
    return app.backups
      ? [
          { text: "Both prices leave out the automated backups", basis: PLAN },
          ...orderPageReasons(orderPage),
        ]
      : [];
  }
  if (!providerProfile(move.other).providerBackups) {
    return [
      { text: withoutStop(noProviderBackupsText(move.other)), basis: PLAN },
      {
        text: app.backups
          ? `${here}'s price is compared without its automated backups, which ${there} doesn't offer; ${bucket}`
          : upperFirst(bucket),
        basis: PLAN,
      },
    ];
  }
  if (providerProfile(app.provider).providerBackups || !move.backups.after) return [];
  return [
    {
      text: `${there}'s automated backups are on after the move, as the interview says the app's data is ${requirements.dataCriticality}, and priced in`,
      basis: PLAN,
    },
  ];
}

/**
 * The new provider's terms besides its monthly price (`offerTerms`: the setup fee, the minimum
 * term and the included snapshots), the months until the saving covers the setup fee, and that it
 * can't change a server's size in place.
 */
function termReasons(move: {
  other: CloudProvider;
  offer: ComputeOffer;
  extras: ProviderExtras;
  before: CostEstimate;
  saving: number;
}): Reason[] {
  const { other, offer, extras, before, saving } = move;
  const fee = feeCents(before, offer);
  const months = fee === undefined ? undefined : Math.ceil(fee / cents(saving));
  return [
    ...offerTerms(offer, extras).map((term) => ({ text: withoutStop(term), basis: PLAN })),
    ...(months === undefined
      ? []
      : [{ text: `The saving covers the setup fee in ${plural(months, "month")}`, basis: PLAN }]),
    ...(resizesInPlace(other) ? [] : [{ text: noResizeText(other), basis: PLAN }]),
  ];
}

/**
 * When the old provider's price includes whole-server snapshots and the new one's doesn't, that
 * the new provider charges for its own.
 */
function snapshotReasons(
  current: ComputeOffer,
  extras: { here: ProviderExtras; there: ProviderExtras },
  names: { here: string; there: string },
): Reason[] {
  const count = current.includedSnapshots;
  const lost = extras.here.snapshotsIncluded === true && extras.there.snapshotsIncluded !== true;
  if (count === undefined || !lost) return [];
  return [
    {
      text: `${names.here}'s price includes up to ${plural(count, "whole-server snapshot")}; ${names.there} charges for its own`,
      basis: PLAN,
    },
  ];
}

/**
 * The servers' `total` before and after `first`'s saving, in `currency`, with which side includes
 * VAT when one does: the total when a server's price does (`vat`), the total after when it did or
 * the proposal's price after includes VAT.
 */
function budgetPrice(
  servers: { total: number; currency: Currency; vat: boolean; costs: readonly CostEstimate[] },
  first: { price: ProposalPrice; saved: Money },
): ProposalPrice {
  const { total, currency, vat, costs } = servers;
  const after = vat || first.price.includesVat?.after === true;
  return {
    before: total,
    after: roundCents(total - first.saved.amount),
    currency,
    ...priceSource([...costs, first.price]),
    ...(after ? { includesVat: { before: vat, after } } : {}),
  };
}

/**
 * The servers OpsCrew created above the interview's budget (US5-1), by how much, naming the other
 * proposals that each bring them under on their own: `--apply` the first of them, or else choose
 * a cheaper option with `opscrew design`. Only when every server is priced.
 */
function overBudget(
  readings: Readings,
  servers: readonly CloudServer[],
  others: readonly Proposal[],
): Proposal[] {
  const { flags } = readings;
  const budget = readings.requirements?.budgetMonthly;
  const priced = servers.filter(isPriced);
  if (budget === undefined || priced.length === 0 || priced.length < servers.length) return [];
  const byName = new Map(
    priced.map((s) => [s.name, serverCost(s.provider, s.prices.offer, s.prices.list, s.backups)]),
  );
  const costs = [...byName.values()];
  const total = roundCents(
    costs.reduce((sum, cost) => sum + convertMoney(cost.monthly, budget.currency).amount, 0),
  );
  if (total <= budget.amount) return [];
  // A total that holds a price with VAT (Contabo's) is labelled as including it.
  const vat = costs.some((cost) => cost.pricesIncludeVat);
  const under = others.flatMap((proposal) => {
    const { price } = proposal;
    if (price === undefined) return [];
    // From the server's cost in the total: a move's price can leave out backups the new provider
    // doesn't offer, and the total goes without them too.
    const now = byName.get(proposal.server ?? "")?.monthly.amount ?? price.before;
    const saving = roundCents(now - price.before + fairSaving(price));
    if (saving <= 0) return [];
    const saved = convertMoney({ amount: saving, currency: price.currency }, budget.currency);
    return total - saved.amount <= budget.amount ? [{ proposal, price, saved }] : [];
  });
  const first = under[0];
  const money = (amount: number) => formatMoney({ amount, currency: budget.currency });
  const converted = costs.some((cost) => cost.monthly.currency !== budget.currency);
  return [
    {
      id: "cost.env.budget",
      category: "cost",
      urgency: "soon",
      title: `The servers cost ${money(roundCents(total - budget.amount))} a month above your budget`,
      reasons: [
        {
          text: "The servers OpsCrew created cost more than the budget you gave in the interview",
          figure: `${money(total)} (${taxLabel(budget.currency, vat)}) against ${formatMoney(budget)} a month`,
          basis: PLAN,
        },
        ...(converted ? [EXCHANGE_RATE] : []),
        // Backups priced only on a provider's order page are not in the total (Contabo's).
        ...orderPageProviders(priced).flatMap((provider) =>
          orderPageReasons(provider, "this total"),
        ),
        under.length > 0
          ? {
              text: `Each of these proposals brings them under it: ${under.map(({ proposal, saved }) => `${proposal.id} (saves ${formatMoney(saved)})`).join(", ")}`,
              basis: PLAN,
            }
          : {
              text: `None of the other proposals brings them under it on its own: choose a cheaper option with \`opscrew design${flags}\`, or raise the budget you gave in the interview`,
              basis: PLAN,
            },
      ],
      ...(first === undefined
        ? {}
        : { price: budgetPrice({ total, currency: budget.currency, vat, costs }, first) }),
      apply: {
        kind: "command",
        command:
          first === undefined
            ? `opscrew design${flags}`
            : `opscrew advise --apply ${first.proposal.id}${flags}`,
      },
    },
  ];
}

/**
 * The cost proposals (US5): over budget, a cheaper type, the other provider. Only servers OpsCrew
 * created are priced: none for the user's own server, a Portainer, this computer, Cloudflare's
 * hosting or GitHub Pages. A server the size rules already move to another type gets no cheaper
 * type from here.
 */
export function costRules(readings: Readings): Proposal[] {
  if (isServerlessProvider(readings.plan.target.provider)) return [];
  const size = sizeRules(readings);
  // The size rules price only a change of type (`typeChange`), also one by a move to a new server.
  const resized = new Set(
    size.flatMap((p) => (p.price !== undefined && p.server !== undefined ? [p.server] : [])),
  );
  const servers = cloudServers(readings);
  const priced = servers.filter(isPriced);
  const cheaper = priced.filter((s) => !resized.has(s.name)).flatMap(cheaperType);
  const moves = otherProvider(
    readings,
    priced.find((s) => s.name === APP_SERVER),
  );
  return [...overBudget(readings, servers, [...size, ...cheaper, ...moves]), ...cheaper, ...moves];
}
