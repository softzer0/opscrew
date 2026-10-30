import type { ComputeCatalog, ComputeOffer, Currency } from "@opscrew/contracts";
import { formatMoney, listText, OpsCrewError } from "@opscrew/core";
import { DRAGONFLY_MIN_VCPUS, serviceSpec } from "@opscrew/iac-templates";
import {
  type CloudProvider,
  type CostEstimate,
  CostEstimateSchema,
  type DeployTarget,
  type ExtraServer,
  type PlanService,
  type Region,
} from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { memoryHeadroom, SYSTEM_RESERVE_MB } from "../shared/memory";
import {
  convertMoney,
  EXCHANGE_RATE_NOTE,
  pricedOffer,
  priceLabel,
  roundCents,
  USD_PER_EUR,
} from "./cost";
import type { EditedServer } from "./placement-edits";
import { regionLocations } from "./sizing";
import { designWording } from "./wording";

/** An extra server's target as the user wrote it, for a server OpsCrew creates. */
export type EditedCloudTarget = Exclude<NonNullable<EditedServer["target"]>, { provider: "own" }>;

/** An extra server as design completed it, with what runs on it and its price. */
export interface DesignedServer {
  /** The plan's entry (`servers[]`). */
  server: ExtraServer;
  /** The enabled services placed on it. */
  services: PlanService[];
  vcpus: number;
  memoryGb: number;
  /** A server OpsCrew creates: its monthly price, in its provider's currency. */
  cost?: CostEstimate;
  /** A server the user owns: its operating system, as inspection read it. */
  os?: string;
  /** Plain warnings: little memory left free, or too little for its services. */
  warnings: string[];
}

/** A server OpsCrew creates, as design completed it: its type, location and price. */
export interface DesignedCloudServer extends DesignedServer {
  server: { name: string; target: Exclude<ExtraServer["target"], { provider: "own" }> };
  cost: CostEstimate;
}

/**
 * What a server for `services` alone must hold, as the app's server is sized: their memory limits
 * plus the system's share, at least each one's smallest comfortable server, and with Dragonfly at
 * least 2 vCPUs.
 */
export function extraServerNeed(services: readonly PlanService[]): {
  memoryMb: number;
  vcpus: number;
} {
  const running = services.filter((service) => service.enabled);
  const limits = running.reduce((sum, service) => sum + service.memoryMb, SYSTEM_RESERVE_MB);
  const smallest = Math.max(
    0,
    ...running.map((service) => serviceSpec(service.kind).memory.smallestServerMb),
  );
  const dragonfly = running.some((service) => service.kind === "dragonfly");
  return { memoryMb: Math.max(limits, smallest), vcpus: dragonfly ? DRAGONFLY_MIN_VCPUS : 1 };
}

/** Cheapest first, then the smaller memory, then by name. */
function cheapestFirst(a: ComputeOffer, b: ComputeOffer): number {
  return (
    a.monthly.amount - b.monthly.amount ||
    a.memoryGb - b.memoryGb ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The smallest server type of `catalog` in `location` for a server that runs only `services`: the
 * cheapest available x86 type that is not deprecated and whose memory holds what
 * {@link extraServerNeed} asks for; `undefined` when none does.
 */
export async function sizeExtraServer(
  catalog: ComputeCatalog,
  location: string,
  services: readonly PlanService[],
): Promise<ComputeOffer | undefined> {
  const need = extraServerNeed(services);
  return (await catalog.listOffers(location))
    .filter(
      (offer) =>
        offer.location === location &&
        offer.architecture === "x86" &&
        !offer.deprecated &&
        offer.available &&
        offer.memoryGb * 1024 >= need.memoryMb &&
        offer.vcpus >= need.vcpus,
    )
    .sort(cheapestFirst)[0];
}

/** {@link designCloudServer}'s input. */
export interface CloudServerInput {
  name: string;
  /** Its target as the user wrote it. */
  target: EditedCloudTarget | undefined;
  /** The enabled services placed on it. */
  services: PlanService[];
  /** The app's server, whose provider and location a new server takes. */
  app: DeployTarget;
  /** The region the user asked for: another provider's first location there. */
  region: Region | undefined;
  /** Automated backups unless the target says. */
  backups: boolean;
  /** The provider's catalogue, read for the server's location. */
  catalogFor: (provider: CloudProvider, location: string) => Promise<ComputeCatalog>;
}

/**
 * An extra server OpsCrew creates, completed from what the user wrote: the app server's provider,
 * and its location (another provider's: its first location in the region), sized by
 * {@link sizeExtraServer} unless the user set a type, with its monthly price, and a warning when
 * its services leave little of its memory free, as for the app's server.
 * @throws OpsCrewError `INVALID_INPUT` when its provider or location cannot be defaulted (the app
 * runs on the user's own server), or its type is not offered there or cannot hold its services.
 */
export async function designCloudServer(input: CloudServerInput): Promise<DesignedCloudServer> {
  const { name, target = {}, services, app } = input;
  const appCloud = app.provider === "hetzner" || app.provider === "digitalocean" ? app : undefined;
  const provider = target.provider ?? appCloud?.provider;
  const location =
    target.location ??
    (provider !== undefined && provider === appCloud?.provider
      ? appCloud.location
      : provider !== undefined && input.region !== undefined
        ? regionLocations(input.region, provider)[0]
        : undefined);
  if (provider === undefined || location === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Server ${name} has no ${provider === undefined ? "provider" : "location"}, and the app's server is your own, so OpsCrew has none to give it. plan.yaml was not changed.`,
      {
        hint: `Set servers[].target.provider (hetzner or digitalocean) and servers[].target.location for server ${name} in opscrew/plan.yaml, then run \`opscrew design\` again.`,
      },
    );
  }
  const catalog = await input.catalogFor(provider, location);
  if (catalog.provider !== provider) {
    throw new Error(`Design needs the ${provider} catalogue but got the ${catalog.provider} one.`);
  }
  const wording = designWording(provider);
  const sized = await sizeExtraServer(catalog, location, services);
  const { serverType } = target;
  const need = extraServerNeed(services);
  const needs = `${Math.round((need.memoryMb / 1024) * 10) / 10} GB of memory${need.vcpus > 1 ? ` and ${need.vcpus} vCPUs` : ""}`;
  const placed = listText(services.map((s) => s.name));
  if (serverType === undefined && sized === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `No available x86 ${wording.name} ${wording.profile.serverNoun} in ${location} has the ${needs} server ${name} needs for ${placed} and the system. plan.yaml was not changed.`,
      {
        hint: `Set another location for server ${name} (servers[].target.location in opscrew/plan.yaml), or lower its services' memory limits, then run \`opscrew design\` again.`,
      },
    );
  }
  // A type the user set is kept whatever its availability, as long as it is offered there.
  const offer =
    serverType === undefined
      ? sized
      : (await catalog.listOffers(location)).find(
          (o) => o.id === serverType && o.location === location,
        );
  if (offer === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${wording.name} offers no ${wording.profile.serverNoun} type ${serverType} in ${location}, which server ${name} names (servers[].target.serverType). plan.yaml was not changed.`,
      {
        hint: `Choose a type ${wording.name} offers there${sized === undefined ? "" : `, such as ${sized.id}`}, or leave serverType out so OpsCrew sizes the server for its services, then run \`opscrew design\` again.`,
      },
    );
  }
  // The smallest type that holds them, when it is another.
  const instead = sized === undefined || sized.id === offer.id ? "" : `, such as ${sized.id},`;
  if (offer.memoryGb * 1024 < need.memoryMb || offer.vcpus < need.vcpus) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Server ${name} is a ${offer.id} (${offer.vcpus} vCPU, ${offer.memoryGb} GB memory), but ${placed} on it need ${needs} with the system's share. plan.yaml was not changed.`,
      {
        hint: `Choose a bigger type for server ${name}${instead} or leave serverType out so OpsCrew sizes the server for its services, then run \`opscrew design\` again.`,
      },
    );
  }
  const limitsMb = services.reduce((sum, service) => sum + service.memoryMb, 0);
  const headroom = memoryHeadroom(offer.memoryGb * 1024, limitsMb, 0);
  const warnings = headroom.low
    ? [
        `Server ${name} (${offer.id}) keeps only ${Math.max(0, Math.round(headroom.free * 100))}% of its memory free after its services' memory limits and the system, so a service that grows can make the server run out of memory. Choose a bigger type for it${instead} or lower a memory limit in opscrew/plan.yaml.`,
      ]
    : [];
  const backups = target.backups ?? input.backups;
  const extras = await catalog.extras(location);
  const { cost } = pricedOffer(offer, extras, {
    backups,
    backupPercent: providerProfile(provider).backupPercent,
  });
  return {
    server: {
      name,
      target: {
        provider,
        mode: "vps-compose",
        location,
        serverType: offer.id,
        ...(target.image === undefined ? {} : { image: target.image }),
        backups,
      },
    },
    services,
    vcpus: offer.vcpus,
    memoryGb: offer.memoryGb,
    cost,
    warnings,
  };
}

/** `Hetzner cx23 in Falkenstein (fsn1), 2 vCPU and 4 GB memory`. */
function cloudServerText(
  provider: CloudProvider,
  serverType: string,
  location: string,
  size: { vcpus: number; memoryGb: number },
): string {
  const wording = designWording(provider);
  const place = wording.profile.locationNames[location];
  return `${wording.name} ${serverType} in ${place === undefined ? location : `${place} (${location})`}, ${size.vcpus} vCPU and ${size.memoryGb} GB memory`;
}

/** `Server db: Hetzner cx23 in Falkenstein (fsn1), 2 vCPU and 4 GB memory, €6.09/month (…).` */
export function serverLine(server: DesignedServer): string {
  const { name, target } = server.server;
  if (target.provider === "own") {
    const os = server.os === undefined ? "" : `, ${server.os}`;
    return `Server ${name}: your own server (${server.vcpus} vCPU, ${server.memoryGb} GB memory${os}), no server cost.`;
  }
  const what = cloudServerText(target.provider, target.serverType, target.location, server);
  const price =
    server.cost === undefined
      ? ""
      : `, ${formatMoney(server.cost.monthly)}/month (${priceLabel(server.cost)})`;
  return `Server ${name}: ${what}${price}.`;
}

/**
 * The plan's cost with the extra servers OpsCrew creates: the app server's lines (`app`), then one
 * line per extra server (its server, IPv4 address and backups together), converted to the app
 * server's currency at the fixed rate when its provider prices in another, and their total. Live
 * only when every price is; dated by the first that is not. `app` itself without such servers.
 */
export function totalCost(app: CostEstimate, servers: readonly DesignedServer[]): CostEstimate {
  const priced = servers.filter(
    (s): s is DesignedCloudServer => s.server.target.provider !== "own" && s.cost !== undefined,
  );
  if (priced.length === 0) return app;
  const currency: Currency = app.monthly.currency;
  const lines = priced.map(({ server, cost }) => {
    const { target } = server;
    const ipv4 = cost.breakdown.some((line) => line.item.startsWith("Primary IPv4 address"));
    const included = [
      ...(ipv4 ? ["its IPv4 address"] : []),
      ...(target.backups ? ["backups"] : []),
    ];
    const extras = included.length === 0 ? "" : `, with ${listText(included)}`;
    const where = ` (${target.serverType} in ${target.location})`;
    const converted =
      cost.monthly.currency === currency
        ? ""
        : `, ${formatMoney(cost.monthly)} converted at 1 EUR = ${USD_PER_EUR.toFixed(2)} USD`;
    return {
      item: `Server ${server.name}${where}${extras}${converted}`,
      monthly: convertMoney(cost.monthly, currency),
    };
  });
  const breakdown = [...app.breakdown, ...lines];
  const amount = breakdown.reduce((sum, line) => sum + line.monthly.amount, 0);
  const notLive = [app, ...priced.map((s) => s.cost)].find((cost) => cost.source !== "live");
  return CostEstimateSchema.parse({
    monthly: { amount: roundCents(amount), currency },
    breakdown,
    pricesIncludeVat: app.pricesIncludeVat,
    source: notLive === undefined ? "live" : "static",
    asOf: notLive?.asOf ?? app.asOf,
  });
}

/**
 * `Monthly total for the app's 2 servers: €12.18 (estimate as of 2026-09-01).`, with the exchange
 * rate when a server's price was converted.
 */
export function totalLine(total: CostEstimate, servers: readonly DesignedServer[]): string {
  const converted = servers.some(
    (s) => s.cost !== undefined && s.cost.monthly.currency !== total.monthly.currency,
  );
  return `Monthly total for the app's ${servers.length + 1} servers: ${formatMoney(total.monthly)} (${priceLabel(total)}).${converted ? ` ${EXCHANGE_RATE_NOTE}` : ""}`;
}
