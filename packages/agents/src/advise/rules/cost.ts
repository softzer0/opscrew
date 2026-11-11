/**
 * Advise's cost rules (feature 021, US5; plan.md "4. The rules"): the servers above the interview's
 * budget, a cheaper type with at least the same CPUs, memory and disk where a server runs, and the
 * same server for less at another provider. Prices come from the catalogues, live or dated.
 */
import { formatMoney } from "@opscrew/core";
import {
  APP_SERVER,
  type CloudProvider,
  isServerlessProvider,
  type Region,
} from "@opscrew/plan-schema";
import { convertMoney, EXCHANGE_RATE_NOTE, offerTerms, roundCents } from "../../design/cost";
import { cheapestServerOffer } from "../../design/servers";
import { designWording } from "../../design/wording";
import { providerProfile, VPS_PROVIDERS } from "../../providers";
import { hasExtraServers } from "../../shared/servers";
import type { Proposal, Readings, Reason } from "../types";
import {
  type CloudServer,
  cloudServers,
  isPriced,
  offerText,
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
 * The app's server at `other` in `region`, with at least its CPUs, memory and disk: the cheapest
 * type at each of the region's locations, then the cheapest of those.
 */
function cheapestAt(readings: Readings, app: PricedServer, other: CloudProvider, region: Region) {
  const current = app.prices.offer;
  const locations = providerProfile(other).regionLocations[region];
  return readings.prices
    .filter((list) => list.provider === other && locations.includes(list.location))
    .flatMap((list) => {
      const offers = list.offers.filter((o) => sameKind(current, o));
      const offer = cheapestServerOffer(offers, list.location, sizeOf(current), current.diskGb);
      return offer === undefined
        ? []
        : [
            {
              other,
              offer,
              extras: list.extras,
              cost: serverCost(other, offer, list, app.backups),
            },
          ];
    })
    .sort(
      (a, b) =>
        a.cost.monthly.amount - b.cost.monthly.amount ||
        locations.indexOf(a.offer.location) - locations.indexOf(b.offer.location),
    )[0];
}

/**
 * The app's server for less at another provider OpsCrew moves apps to (the cheapest of them), in
 * the interview's region, with at least its CPUs, memory and disk (US5-3): `opscrew retarget`,
 * which moves an app on one server only.
 */
function otherProvider(readings: Readings, app: PricedServer | undefined): Proposal[] {
  const { requirements, plan, flags } = readings;
  const region = requirements?.region;
  if (app === undefined || region === undefined || hasExtraServers(plan)) return [];
  const { offer: current, list: here } = app.prices;
  const before = serverCost(app.provider, current, here, app.backups);
  const best = VPS_PROVIDERS.filter((id) => id !== app.provider)
    .flatMap((id) => cheapestAt(readings, app, id, region) ?? [])
    .map((found) => ({ ...found, price: priceChange(before, found.cost) }))
    .sort((a, b) => a.price.after - b.price.after)[0];
  if (best === undefined) return [];
  const { other, price } = best;
  if (price.after >= price.before) return [];
  const there = designWording(other).name;
  const place = providerProfile(other).locationNames[best.offer.location] ?? best.offer.location;
  const command = `opscrew retarget --to ${other}${flags}`;
  return [
    {
      id: `cost.${APP_SERVER}.other-provider`,
      category: "cost",
      urgency: "when-convenient",
      server: APP_SERVER,
      title: `Move the app to ${there}: ${offerText(best.offer)} in ${place}`,
      reasons: [
        {
          text: `The same server costs less at ${there}: ${best.offer.id} there against ${current.id} at ${designWording(app.provider).name}`,
          figure: `${formatMoney(best.cost.monthly)} against ${formatMoney(before.monthly)} a month`,
          basis: PLAN,
        },
        ...(before.monthly.currency === best.cost.monthly.currency ? [] : [EXCHANGE_RATE]),
        ...offerTerms(best.offer, best.extras).map((term) => ({
          text: withoutStop(term),
          basis: PLAN,
        })),
        {
          text: `\`${command}\` moves the app with a short maintenance window: it creates the new server, copies the data and switches the domain, and \`--finish\` deletes the old server`,
          basis: PLAN,
        },
      ],
      price,
      apply: { kind: "command", command },
    },
  ];
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
  const costs = priced.map((s) => serverCost(s.provider, s.prices.offer, s.prices.list, s.backups));
  const total = roundCents(
    costs.reduce((sum, cost) => sum + convertMoney(cost.monthly, budget.currency).amount, 0),
  );
  if (total <= budget.amount) return [];
  const under = others.flatMap((proposal) => {
    const { price } = proposal;
    if (price === undefined || price.after >= price.before) return [];
    const saved = convertMoney(
      { amount: price.before - price.after, currency: price.currency },
      budget.currency,
    );
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
          figure: `${money(total)} against ${formatMoney(budget)} a month`,
          basis: PLAN,
        },
        ...(converted ? [EXCHANGE_RATE] : []),
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
        : {
            price: {
              before: total,
              after: roundCents(total - first.saved.amount),
              currency: budget.currency,
              ...priceSource([...costs, first.price]),
            },
          }),
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
