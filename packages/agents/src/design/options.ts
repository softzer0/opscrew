import type {
  ComputeCatalog,
  ComputeOffer,
  Money,
  ProviderExtras,
  VpsProviderId,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  type CostEstimate,
  type DesignOption,
  DesignOptionListSchema,
  type ProjectFacts,
  type Requirements,
} from "@opscrew/plan-schema";
import { requestedProvider } from "../providers";
import { convertMoney, costFor, EXCHANGE_RATE_NOTE, formatMoney, priceLabel } from "./cost";
import { regionLocations, type Sizing, sizeFor } from "./sizing";
import { type DesignWording, designWording } from "./wording";

export interface BuildDesignOptionsInput {
  facts: ProjectFacts;
  requirements: Requirements;
  catalog: ComputeCatalog;
  /** Current time; used to say how old a static price table is. Defaults to the catalogue date. */
  now?: Date;
}

/** Option tiers, in display order. */
export type DesignTier = "lean" | "comfortable" | "dedicated";

/** Static price tables older than this many days get an extra warning in the tradeoffs. */
const STALE_PRICE_DAYS = 180;

interface Candidate {
  offer: ComputeOffer;
  cost: CostEstimate;
}

/**
 * Two or three deployment options for the app on the requested provider (`requirements.provider`,
 * Hetzner when unset; plan.md "Interview, design and code changes"): **Lean** (cheapest shared
 * server meeting the need), **Comfortable** (cheapest shared server with at least twice the needed
 * memory, bigger than Lean) and **Dedicated** (cheapest dedicated-vCPU server, only for `high`
 * uptime or 10k+ users). ARM, deprecated and unavailable server types are excluded; each server
 * type is offered in the first location of the region (from the provider profile) where it is
 * available. Prices stay in the catalogue's currency; the budget is compared at the fixed
 * approximate exchange rate. Exactly one option is recommended. Validated with
 * `DesignOptionListSchema`.
 * @throws OpsCrewError `INVALID_INPUT` when no server in the region meets the need.
 * @throws Error when the catalogue belongs to another provider (a bug, never user input).
 */
export async function buildDesignOptions(input: BuildDesignOptionsInput): Promise<DesignOption[]> {
  const { facts, requirements, catalog } = input;
  const provider = requestedProvider(requirements);
  if (catalog.provider !== provider) {
    throw new Error(`Design needs the ${provider} catalogue but got the ${catalog.provider} one.`);
  }
  const wording = designWording(provider);
  const { profile } = wording;
  const sizing = sizeFor(facts, requirements);
  const locations = regionLocations(requirements.region, provider);
  const backups = requirements.dataCriticality !== "none";

  const offers = (await Promise.all(locations.map((location) => catalog.listOffers(location))))
    .flat()
    .filter(
      (offer) =>
        offer.architecture === "x86" &&
        !offer.deprecated &&
        offer.available &&
        locations.includes(offer.location),
    );
  // One offer per server type: the first location (in region order) where it is available.
  const byType = new Map<string, ComputeOffer>();
  for (const location of locations) {
    for (const offer of offers) {
      if (offer.location === location && !byType.has(offer.id)) byType.set(offer.id, offer);
    }
  }

  const extrasCache = new Map<string, Promise<ProviderExtras>>();
  const extrasFor = (location: string) => {
    let extras = extrasCache.get(location);
    if (extras === undefined) {
      extras = catalog.extras(location);
      extrasCache.set(location, extras);
    }
    return extras;
  };
  const candidates: Candidate[] = [];
  for (const offer of byType.values()) {
    if (!meets(offer, sizing)) continue;
    const extras = await extrasFor(offer.location);
    const cost = costFor(offer, extras, { backups, backupPercent: profile.backupPercent });
    candidates.push({ offer, cost });
  }
  candidates.sort(cheapestFirst);

  const shared = candidates.filter((c) => c.offer.cpuType === "shared");
  const lean = shared[0];
  const comfortable = shared.find(
    (c) =>
      c.offer.memoryGb >= 2 * sizing.memoryGb &&
      (lean === undefined || c.offer.memoryGb > lean.offer.memoryGb),
  );
  const wantsDedicated =
    requirements.uptime === "high" ||
    requirements.expectedMonthlyUsers === "10k-100k" ||
    requirements.expectedMonthlyUsers === ">100k";
  const dedicated = wantsDedicated
    ? candidates.find((c) => c.offer.cpuType === "dedicated")
    : undefined;

  const picked: [DesignTier, Candidate][] = [];
  if (lean) picked.push(["lean", lean]);
  if (comfortable) picked.push(["comfortable", comfortable]);
  if (dedicated) picked.push(["dedicated", dedicated]);
  if (picked.length === 0) {
    const where = locations.map((l) => profile.locationNames[l] ?? l).join(" or ");
    throw new OpsCrewError(
      "INVALID_INPUT",
      `No available x86 ${wording.name} ${profile.serverNoun} in ${where} has the ${sizing.vcpus} vCPU, ${sizing.memoryGb} GB memory and ${sizing.diskGb} GB disk this app needs.`,
      {
        hint: "Run `opscrew interview` again and choose another region or a smaller expected number of users.",
      },
    );
  }

  const budget = requirements.budgetMonthly;
  const fits = (cost: CostEstimate) =>
    convertMoney(cost.monthly, budget.currency).amount <= budget.amount;
  const recommendedTier = chooseRecommended(picked, requirements, fits);

  const options = picked.map(([tier, candidate]) =>
    toOption(tier, candidate, {
      provider,
      wording,
      regionNote: profile.regionNotes[requirements.region],
      sizing,
      backups,
      budget,
      fitsBudget: fits(candidate.cost),
      recommended: tier === recommendedTier,
      now: input.now,
    }),
  );
  return DesignOptionListSchema.parse(options);
}

function meets(offer: ComputeOffer, sizing: Sizing): boolean {
  return (
    offer.vcpus >= sizing.vcpus &&
    offer.memoryGb >= sizing.memoryGb &&
    offer.diskGb >= sizing.diskGb
  );
}

function cheapestFirst(a: Candidate, b: Candidate): number {
  return (
    a.cost.monthly.amount - b.cost.monthly.amount ||
    b.offer.memoryGb - a.offer.memoryGb ||
    (a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0)
  );
}

/**
 * Lean when it fits the budget and uptime is not `high`; else Comfortable when it fits; else the
 * cheapest option.
 */
function chooseRecommended(
  picked: readonly [DesignTier, Candidate][],
  requirements: Requirements,
  fits: (cost: CostEstimate) => boolean,
): DesignTier {
  const find = (tier: DesignTier) => picked.find(([t]) => t === tier)?.[1];
  const lean = find("lean");
  if (lean && fits(lean.cost) && requirements.uptime !== "high") return "lean";
  const comfortable = find("comfortable");
  if (comfortable && fits(comfortable.cost)) return "comfortable";
  const cheapest = [...picked].sort(([, a], [, b]) => cheapestFirst(a, b))[0];
  return (cheapest as [DesignTier, Candidate])[0];
}

const TIER_TITLES: Record<DesignTier, string> = {
  lean: "Lean",
  comfortable: "Comfortable",
  dedicated: "Dedicated",
};

const TIER_TRADEOFFS: Record<DesignTier, string[]> = {
  lean: [
    "Cheapest server that meets the estimated need, with little headroom for traffic spikes.",
    "Shared vCPUs can slow down when other customers on the same host are busy.",
  ],
  comfortable: [
    "At least twice the memory the app needs, so it can grow without resizing the server.",
    "Shared vCPUs can slow down when other customers on the same host are busy.",
  ],
  dedicated: [
    "Dedicated vCPUs give steady performance under sustained load.",
    "Costs several times more than a shared server of similar size.",
  ],
};

function toOption(
  tier: DesignTier,
  { offer, cost }: Candidate,
  context: {
    provider: VpsProviderId;
    wording: DesignWording;
    /** Why the region maps to a location outside it, when it does. */
    regionNote: string | undefined;
    sizing: Sizing;
    backups: boolean;
    budget: Money;
    fitsBudget: boolean;
    recommended: boolean;
    now: Date | undefined;
  },
): DesignOption {
  const { provider, wording, sizing, backups, budget } = context;
  const place = wording.profile.locationNames[offer.location] ?? offer.location;
  const price = `${formatMoney(cost.monthly)}/month (${priceLabel(cost)}, ${cost.pricesIncludeVat ? "including" : "excluding"} VAT)`;
  const containers = [
    "the app",
    ...(sizing.services.postgres ? ["Postgres"] : []),
    ...(sizing.services.redis ? ["Redis"] : []),
  ];
  const summary = [
    `One ${offer.id} ${wording.summaryNoun} (${offer.vcpus} ${offer.cpuType} vCPU, ${offer.memoryGb} GB memory, ${offer.diskGb} GB disk) in ${place} (${offer.location}) running ${joinWords(containers)} with Docker Compose behind Caddy.`,
    `${price}.`,
    backups ? "Automated backups are on." : "Automated backups are off.",
  ].join(" ");

  const tradeoffs = [...TIER_TRADEOFFS[tier]];
  if (context.regionNote !== undefined) tradeoffs.push(context.regionNote);
  tradeoffs.push("A single server: if it fails, the app is down until the server is restored.");
  if (sizing.services.postgres) {
    tradeoffs.push(
      "Postgres runs in a container on the same server; restoring it relies on the server backups.",
    );
  }
  if (!backups) {
    tradeoffs.push("No automated backups, because you said losing the data would not matter.");
  }
  const budgetPrice = convertMoney(cost.monthly, budget.currency);
  const crossCurrency = budget.currency !== cost.monthly.currency;
  if (!context.fitsBudget) {
    tradeoffs.push(
      `Costs ${formatMoney(budgetPrice)}/month, above your budget of ${formatMoney(budget)}/month.${crossCurrency ? ` ${EXCHANGE_RATE_NOTE}` : ""}`,
    );
  } else if (crossCurrency) {
    tradeoffs.push(
      `About ${formatMoney(budgetPrice)}/month in your budget currency. ${EXCHANGE_RATE_NOTE}`,
    );
  }
  if (cost.source === "static") {
    tradeoffs.push(
      `Prices are an ${priceLabel(cost)} from ${wording.name}'s published price list and availability was not checked; set ${wording.tokenVar} for live prices.`,
    );
    const ageDays =
      context.now === undefined
        ? 0
        : Math.floor((context.now.getTime() - Date.parse(cost.asOf)) / 86_400_000);
    if (ageDays > STALE_PRICE_DAYS) {
      tradeoffs.push(`The price list is ${ageDays} days old; prices may have changed.`);
    }
  }

  return {
    id: `${provider}-single-${offer.id}-${offer.location}`,
    title: `${TIER_TITLES[tier]}: ${offer.id} in ${place}${wording.titleSuffix}`,
    summary,
    target: {
      provider,
      location: offer.location,
      serverType: offer.id,
      vcpus: offer.vcpus,
      memoryGb: offer.memoryGb,
      diskGb: offer.diskGb,
      cpuType: offer.cpuType,
      architecture: offer.architecture,
    },
    services: { ...sizing.services },
    externalServices: [...sizing.externalServices],
    backups,
    cost,
    fitsBudget: context.fitsBudget,
    recommended: context.recommended,
    tradeoffs,
  };
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The cheapest option's monthly cost converted to the budget currency. */
export function minimumMonthlyCost(
  options: readonly DesignOption[],
  currency: Money["currency"],
): Money | undefined {
  const amounts = options.map((option) => convertMoney(option.cost.monthly, currency));
  return amounts.sort((a, b) => a.amount - b.amount)[0];
}
