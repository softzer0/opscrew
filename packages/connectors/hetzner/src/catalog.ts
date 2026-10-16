import type {
  ComputeCatalog,
  ComputeLocation,
  ComputeOffer,
  Currency,
  ProviderExtras,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { HetznerClient, HetznerPricing, HetznerServerType } from "./client";
import {
  STATIC_BACKUP_PERCENT,
  STATIC_IPV4_MONTHLY_EUR,
  STATIC_LOCATIONS,
  STATIC_PRICES_AS_OF,
  STATIC_SERVER_TYPES,
} from "./static-prices";

export interface HetznerCatalogOptions {
  /** Injectable clock for `asOf`. */
  now?: () => Date;
}

/** Live Hetzner catalogue read from the Cloud API (net prices, availability, deprecation). */
export class HetznerCatalog implements ComputeCatalog {
  readonly provider = "hetzner" as const;
  private readonly now: () => Date;
  private serverTypes?: Promise<HetznerServerType[]>;
  private pricing?: Promise<HetznerPricing>;

  constructor(
    private readonly client: HetznerClient,
    options: HetznerCatalogOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async listLocations(): Promise<ComputeLocation[]> {
    const locations = await this.client.listLocations();
    return locations.map((location) => ({
      id: location.name,
      name: location.city ?? location.description ?? location.name,
      country: location.country,
    }));
  }

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    this.serverTypes ??= this.client.listServerTypes();
    const types = await this.serverTypes.catch((error: unknown) => {
      this.serverTypes = undefined;
      throw error;
    });
    const asOf = this.now().toISOString();
    const offers: ComputeOffer[] = [];
    for (const type of types) {
      const typeDeprecated =
        (type.deprecated !== undefined && type.deprecated !== null && type.deprecated !== false) ||
        (type.deprecation !== undefined && type.deprecation !== null);
      for (const price of type.prices) {
        if (location !== undefined && price.location !== location) continue;
        const entry = type.locations?.find((l) => l.name === price.location);
        const offer: ComputeOffer = {
          provider: "hetzner",
          id: type.name,
          vcpus: type.cores,
          memoryGb: type.memory,
          diskGb: type.disk,
          cpuType: type.cpu_type === "dedicated" ? "dedicated" : "shared",
          architecture: type.architecture === "arm" ? "arm" : "x86",
          location: price.location,
          monthly: { amount: price.price_monthly.net, currency: "EUR" },
          pricesIncludeVat: false,
          deprecated:
            typeDeprecated || (entry?.deprecation !== undefined && entry.deprecation !== null),
          // Older responses have no `locations[]`: assume available and let the API decide.
          available:
            type.locations === undefined ? true : (entry?.available ?? entry !== undefined),
          source: "live",
          asOf,
        };
        if (type.description !== undefined) offer.description = type.description;
        offers.push(offer);
      }
    }
    return offers;
  }

  async extras(location: string): Promise<ProviderExtras> {
    this.pricing ??= this.client.getPricing();
    const pricing = await this.pricing.catch((error: unknown) => {
      this.pricing = undefined;
      throw error;
    });
    const currency = toCurrency(pricing.currency);
    const out: ProviderExtras = {
      pricesIncludeVat: false,
      source: "live",
      asOf: this.now().toISOString(),
    };
    const ipv4 = pricing.primary_ips
      ?.find((ip) => ip.type === "ipv4")
      ?.prices.find((p) => p.location === location);
    if (ipv4 !== undefined) out.ipv4Monthly = { amount: ipv4.price_monthly.net, currency };
    if (pricing.server_backup !== undefined) out.backupPercent = pricing.server_backup.percentage;
    return out;
  }
}

function toCurrency(value: string): Currency {
  if (value === "EUR" || value === "USD") return value;
  throw new OpsCrewError("PROVIDER_ERROR", `Hetzner reported an unsupported currency: ${value}.`);
}

/**
 * Offline catalogue over the dated table in `static-prices.ts` (`source: "static"`). Every offer is
 * marked available because availability is unknown offline; offers without a known price are
 * omitted.
 */
export class StaticHetznerCatalog implements ComputeCatalog {
  readonly provider = "hetzner" as const;
  /** Date of the price list this catalogue is built from. */
  readonly asOf = STATIC_PRICES_AS_OF;

  async listLocations(): Promise<ComputeLocation[]> {
    return STATIC_LOCATIONS.map(({ id, name, country }) => ({ id, name, country }));
  }

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    const offers: ComputeOffer[] = [];
    for (const loc of STATIC_LOCATIONS) {
      if (location !== undefined && loc.id !== location) continue;
      for (const type of STATIC_SERVER_TYPES) {
        const monthly = type.prices[loc.group];
        if (monthly === undefined) continue;
        offers.push({
          provider: "hetzner",
          id: type.name,
          vcpus: type.vcpus,
          memoryGb: type.memoryGb,
          diskGb: type.diskGb,
          cpuType: type.cpuType,
          architecture: type.architecture,
          location: loc.id,
          monthly: { amount: monthly, currency: "EUR" },
          pricesIncludeVat: false,
          deprecated: false,
          available: true,
          source: "static",
          asOf: STATIC_PRICES_AS_OF,
        });
      }
    }
    return offers;
  }

  async extras(location: string): Promise<ProviderExtras> {
    if (!STATIC_LOCATIONS.some((loc) => loc.id === location)) {
      throw new OpsCrewError("INVALID_INPUT", `Unknown Hetzner location: ${location}.`, {
        hint: `Use one of ${STATIC_LOCATIONS.map((loc) => loc.id).join(", ")}.`,
      });
    }
    return {
      ipv4Monthly: { amount: STATIC_IPV4_MONTHLY_EUR, currency: "EUR" },
      backupPercent: STATIC_BACKUP_PERCENT,
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    };
  }
}
