import type {
  ComputeCatalog,
  ComputeOffer,
  Money,
  ProviderExtras,
  VpsProviderId,
} from "@opscrew/contracts";
import { formatMoney, OpsCrewError } from "@opscrew/core";
import { EDGE_PROXIES, type EdgeProxy } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type CostEstimate,
  type DesignOption,
  DesignOptionListSchema,
  type ProjectFacts,
  type Requirements,
  serviceOf,
} from "@opscrew/plan-schema";
import { requestedProvider, requestedRegion } from "../providers";
import { memoryHeadroom, SYSTEM_RESERVE_MB } from "../shared/memory";
import { type Components, memoryText } from "./components";
import {
  convertMoney,
  EXCHANGE_RATE_NOTE,
  type NonLiveRates,
  pricedOffer,
  priceLabel,
} from "./cost";
import { keptTypeText, type ServerSize } from "./server-changes";
import { containersText, regionLocations, type Sizing, sizeFor } from "./sizing";
import { type DesignWording, designWording } from "./wording";

export interface BuildDesignOptionsInput {
  facts: ProjectFacts;
  requirements: Requirements;
  catalog: ComputeCatalog;
  /** Current time; used to say how old a static price table is. Defaults to the catalogue date. */
  now?: Date;
  /** What runs next to the app (`designComponents`); by default designed from the facts. */
  components?: Components;
  /** The server's proxy (`target.edge`), whose memory the sizing counts; Caddy by default. */
  edge?: EdgeProxy;
  /** The app's server as deployed on this provider (`deployedAppServer`), which keeps its disk. */
  deployed?: ServerSize;
}

/** Option tiers, in display order. */
export type DesignTier = "lean" | "comfortable" | "dedicated";

/** Static price tables older than this many days get an extra warning in the tradeoffs. */
const STALE_PRICE_DAYS = 180;

interface Candidate {
  offer: ComputeOffer;
  cost: CostEstimate;
  /** Rates in the estimate of a live offer that were not read from the API. */
  rates: NonLiveRates;
  /** Why it is the deployed server's type, standing in for one with a smaller disk. */
  kept?: string;
  /** Why it replaces the deployed server: no type where that runs meets the need. */
  moved?: string;
}

/**
 * Two or three deployment options for the app on the requested provider (`requirements.provider`,
 * Hetzner when unset; plan.md "Interview, design and code changes"): **Lean** (cheapest shared
 * server meeting the need), **Comfortable** (cheapest shared server with at least twice the needed
 * memory, bigger than Lean) and **Dedicated** (cheapest dedicated-vCPU server, only for `high`
 * uptime or 10k+ users). ARM, deprecated and unavailable server types are excluded; each server
 * type is offered in the first location of the region (from the provider profile) where it is
 * available. A deployed server (`deployed`) in the region gets only types where it runs, and other
 * locations only when none there meets the need, each such option saying it replaces the server
 * (a region the user changed replaces it anyway). Where it
 * runs, no type with a smaller disk than its own is offered (neither provider can make a disk
 * smaller), and its own type is when it meets the need, saying why when a cheaper type was left
 * out for its disk. Prices stay in the catalogue's currency; the budget is compared at the fixed
 * approximate exchange rate. Exactly one option is recommended. Validated with `DesignOptionListSchema`. A server the user owns has its
 * own single option (`buildOwnServerOption`).
 * @throws OpsCrewError `INVALID_INPUT` when no server in the region meets the need.
 * @throws Error when the catalogue belongs to another provider (a bug, never user input).
 */
export async function buildDesignOptions(input: BuildDesignOptionsInput): Promise<DesignOption[]> {
  return (await buildDesignOptionSet(input)).options;
}

/** {@link buildDesignOptionSet}'s result. */
export interface DesignOptionSet {
  options: DesignOption[];
  /** Why an option keeps the deployed server's type (`keptTypeText`), by option id. */
  kept: Map<string, string>;
}

/**
 * {@link buildDesignOptions}, with why each option that keeps the deployed server's type does, for
 * design to say once that option is chosen.
 */
export async function buildDesignOptionSet(
  input: BuildDesignOptionsInput,
): Promise<DesignOptionSet> {
  const { facts, requirements, catalog } = input;
  const provider = requestedProvider(requirements);
  if (catalog.provider !== provider) {
    throw new Error(`Design needs the ${provider} catalogue but got the ${catalog.provider} one.`);
  }
  const wording = designWording(provider);
  const { profile } = wording;
  const region = requestedRegion(requirements);
  if (region === undefined) throw new Error(`${provider} requirements need a region.`);
  const sizing = sizeFor(facts, requirements, input.components, input.edge);
  const locations = regionLocations(region, provider);
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
  // One offer per server type: the first location (in region order) where it is available, the
  // deployed server's first, since another location replaces the server with its data.
  const { deployed } = input;
  const home =
    deployed !== undefined && locations.includes(deployed.location) ? deployed.location : undefined;
  const order =
    home === undefined ? locations : [home, ...locations.filter((location) => location !== home)];
  const byType = new Map<string, ComputeOffer>();
  for (const location of order) {
    for (const offer of offers) {
      if (offer.location === location && !byType.has(offer.id)) byType.set(offer.id, offer);
    }
  }

  const pricing = { backups, backupPercent: profile.backupPercent };
  const extrasCache = new Map<string, Promise<ProviderExtras>>();
  const extrasFor = (location: string) => {
    let extras = extrasCache.get(location);
    if (extras === undefined) {
      extras = catalog.extras(location);
      extrasCache.set(location, extras);
    }
    return extras;
  };
  // The deployed server's type, when it runs in the region: no type with a smaller disk is offered
  // where it runs (neither provider can make a disk smaller), and it is offered itself.
  const current =
    home === undefined
      ? undefined
      : (await catalog.listOffers(home)).find(
          (offer) => offer.id === deployed?.serverType && offer.location === home,
        );
  const isCurrent = (offer: ComputeOffer) =>
    offer.id === current?.id && offer.location === current.location;
  let candidates: Candidate[] = [];
  const shrinking: Candidate[] = [];
  const offered = [...byType.values()];
  if (current !== undefined && !offered.some(isCurrent)) offered.push(current);
  for (const offer of offered) {
    if (!meets(offer, sizing)) continue;
    const extras = await extrasFor(offer.location);
    const candidate = { offer, ...pricedOffer(offer, extras, pricing) };
    const shrinks =
      current !== undefined && offer.location === current.location && offer.diskGb < current.diskGb;
    (shrinks ? shrinking : candidates).push(candidate);
  }
  // A deployed server stays where it runs; another location only when no type there meets the need.
  if (home !== undefined) {
    const there = candidates.filter((c) => c.offer.location === home);
    if (there.length > 0) candidates = there;
    else {
      const noun = profile.serverNoun;
      const moved = `No ${noun} type in ${profile.locationNames[home] ?? home} (${home}), where your ${noun} runs, meets the need, so this option replaces it: the next \`opscrew provision\` creates a new ${noun} and deletes the old one together with the data on it.`;
      for (const candidate of candidates) candidate.moved = moved;
    }
  }
  candidates.sort(cheapestFirst);
  // The deployed type, the cheapest of its CPU kind left, names the cheapest of that kind left out
  // for its smaller disk.
  const cheapestOf = (list: Candidate[], cpu: string | undefined) =>
    list.filter((c) => c.offer.cpuType === cpu).sort(cheapestFirst)[0];
  const own = cheapestOf(candidates, current?.cpuType);
  const smaller = cheapestOf(shrinking, current?.cpuType);
  if (
    own !== undefined &&
    isCurrent(own.offer) &&
    smaller !== undefined &&
    cheapestFirst(smaller, own) < 0
  ) {
    own.kept = keptTypeText(APP_SERVER, provider, smaller.offer.id, own.offer.id);
  }

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
    const memory = Math.round(sizing.memoryGb * 10) / 10;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `No available x86 ${wording.name} ${profile.serverNoun} in ${where} has the ${sizing.vcpus} vCPU, ${memory} GB memory and ${sizing.diskGb} GB disk this app needs (its containers' memory limits add up to ${sizing.limitsMb} MB, plus ${sizing.edgeMb + SYSTEM_RESERVE_MB} MB for OpsCrew's edge and the system).`,
      {
        hint: "Run `opscrew interview` again and choose another region or a smaller expected number of users, or lower the memory limits in opscrew/plan.yaml, then run `opscrew design` again.",
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
      regionNote: profile.regionNotes[region],
      sizing,
      backups,
      budget,
      fitsBudget: fits(candidate.cost),
      recommended: tier === recommendedTier,
      now: input.now,
    }),
  );
  const parsed = DesignOptionListSchema.parse(options);
  const kept = new Map<string, string>();
  parsed.forEach((option, i) => {
    const why = picked[i]?.[1].kept;
    if (why !== undefined) kept.set(option.id, why);
  });
  return { options: parsed, kept };
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
  { offer, cost, rates, kept, moved }: Candidate,
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
  // EUR prices are quoted with or without VAT; USD prices (DigitalOcean) exclude sales tax.
  const tax = cost.monthly.currency === "EUR" ? "VAT" : "tax";
  // A live server price with rates not read from the API (DigitalOcean's published backup rate).
  const notLive = [
    ...(rates.ipv4 ? [{ what: "IPv4", the: "the IPv4 price", ...rates.ipv4 }] : []),
    ...(rates.backups ? [{ what: "backups", the: "the backup price", ...rates.backups }] : []),
  ];
  const mixed = offer.source === "live" && notLive.length > 0;
  const label = mixed
    ? `live ${wording.profile.serverNoun} price, ${notLive.map((r) => `${r.what} at ${r.rate}`).join(", ")}`
    : priceLabel(cost);
  const price = `${formatMoney(cost.monthly)}/month (${label}, ${cost.pricesIncludeVat ? "including" : "excluding"} ${tax})`;
  const serverMb = offer.memoryGb * 1024;
  const summary = [
    `One ${offer.id} ${wording.summaryNoun} (${offer.vcpus} ${offer.cpuType} vCPU, ${offer.memoryGb} GB memory, ${offer.diskGb} GB disk) in ${place} (${offer.location}) running ${containersText(sizing)} with Docker Compose behind ${EDGE_PROXIES[sizing.edge].label}.`,
    `${price}.`,
    backups ? "Automated backups are on." : "Automated backups are off.",
    memoryText(sizing.components, serverMb, sizing.edgeMb, cost.monthly),
  ].join(" ");

  const tradeoffs = [
    ...(moved === undefined ? [] : [moved]),
    ...(kept === undefined ? [] : [kept]),
    ...TIER_TRADEOFFS[tier],
  ];
  const headroom = memoryHeadroom(serverMb, sizing.limitsMb, sizing.edgeMb);
  if (headroom.low) tradeoffs.push(lowHeadroomText(offer.id, headroom.free));
  if (context.regionNote !== undefined) tradeoffs.push(context.regionNote);
  tradeoffs.push("A single server: if it fails, the app is down until the server is restored.");
  if (serviceOf(sizing, "postgres")) {
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
      mixed
        ? `The ${wording.profile.serverNoun} price is live from ${wording.name}; ${notLive.map((r) => `${r.the} uses ${r.rate}, because ${r.reason}`).join("; ")}.`
        : `Prices are an ${priceLabel(cost)} from ${wording.name}'s published price list and availability was not checked; set ${wording.tokenVar} for live prices.`,
    );
    const ageDays =
      context.now === undefined
        ? 0
        : Math.floor((context.now.getTime() - Date.parse(cost.asOf)) / 86_400_000);
    if (ageDays > STALE_PRICE_DAYS) {
      tradeoffs.push(
        mixed
          ? `The published rate is ${ageDays} days old; it may have changed.`
          : `The price list is ${ageDays} days old; prices may have changed.`,
      );
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
    services: [...sizing.services],
    externalServices: [...sizing.externalServices],
    backups,
    cost,
    fitsBudget: context.fitsBudget,
    recommended: context.recommended,
    tradeoffs,
  };
}

/**
 * The warning for a server whose memory the containers' limits leave less than 15% of free, after
 * OpsCrew's edge and the system's reserve.
 */
export function lowHeadroomText(serverType: string, free: number): string {
  return `The ${serverType} server keeps only ${Math.max(0, Math.round(free * 100))}% of its memory free after the containers' memory limits, OpsCrew's edge and the system, so a container that grows can make the server run out of memory. Choose a bigger option, or lower a memory limit in opscrew/plan.yaml.`;
}

/** The cheapest option's monthly cost converted to the budget currency. */
export function minimumMonthlyCost(
  options: readonly DesignOption[],
  currency: Money["currency"],
): Money | undefined {
  const amounts = options.map((option) => convertMoney(option.cost.monthly, currency));
  return amounts.sort((a, b) => a.amount - b.amount)[0];
}
