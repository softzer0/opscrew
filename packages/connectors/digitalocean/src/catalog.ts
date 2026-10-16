import type { ComputeCatalog, ComputeOffer, ProviderExtras } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { DigitalOceanClient, DigitalOceanSize } from "./client";
import { BACKUP_PERCENT, STATIC_PRICES_AS_OF, STATIC_REGIONS, STATIC_SIZES } from "./static-prices";

/** Basic regular sizes (`s-<n>vcpu-<m>gb`); premium Intel/AMD and 512 MiB variants do not match. */
const BASIC_SLUG = /^s-\d+vcpu-\d+gb$/;
/** CPU-Optimized regular sizes (`c-<n>`). */
const CPU_OPTIMIZED_SLUG = /^c-\d+$/;

export interface DigitalOceanCatalogOptions {
  /** Injectable clock for `asOf`. */
  now?: () => Date;
}

/** The OpsCrew CPU type of a size, or `undefined` when OpsCrew does not offer it. */
function cpuTypeOf(size: DigitalOceanSize): ComputeOffer["cpuType"] | undefined {
  if (size.description === "Basic" && BASIC_SLUG.test(size.slug) && size.memory >= 1024) {
    return "shared";
  }
  if (size.description === "CPU-Optimized" && CPU_OPTIMIZED_SLUG.test(size.slug)) {
    return "dedicated";
  }
  return undefined;
}

/**
 * Live DigitalOcean catalogue read from the API: Basic regular sizes (shared) and CPU-Optimized
 * sizes (dedicated), only where the API reports them available. Prices in USD, excluding tax.
 */
export class DigitalOceanCatalog implements ComputeCatalog {
  readonly provider = "digitalocean" as const;
  private readonly now: () => Date;
  private sizes?: Promise<DigitalOceanSize[]>;

  constructor(
    private readonly client: DigitalOceanClient,
    options: DigitalOceanCatalogOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    this.sizes ??= this.client.listSizes();
    const sizes = await this.sizes.catch((error: unknown) => {
      this.sizes = undefined;
      throw error;
    });
    const asOf = this.now().toISOString();
    const offers: ComputeOffer[] = [];
    for (const size of sizes) {
      const cpuType = cpuTypeOf(size);
      if (cpuType === undefined || !size.available) continue;
      for (const region of size.regions) {
        if (location !== undefined && region !== location) continue;
        const offer: ComputeOffer = {
          provider: "digitalocean",
          id: size.slug,
          vcpus: size.vcpus,
          memoryGb: Math.round((size.memory / 1024) * 100) / 100,
          diskGb: size.disk,
          cpuType,
          architecture: "x86",
          location: region,
          monthly: { amount: size.price_monthly, currency: "USD" },
          pricesIncludeVat: false,
          deprecated: false,
          available: true,
          source: "live",
          asOf,
        };
        if (size.description) offer.description = size.description;
        offers.push(offer);
      }
    }
    return offers;
  }

  /**
   * Daily backup percentage, IPv4 included in the Droplet price. The API does not return the rate,
   * so it comes from DigitalOcean's published price page in `static-prices.ts` and is labelled
   * `static` with that table's date, never `live`.
   */
  async extras(_location: string): Promise<ProviderExtras> {
    return publishedExtras();
  }
}

/**
 * Offline catalogue over the dated Basic table in `static-prices.ts` (`source: "static"`) for every
 * Droplet region. Every offer is marked available because availability is unknown offline.
 */
export class StaticDigitalOceanCatalog implements ComputeCatalog {
  readonly provider = "digitalocean" as const;
  /** Date of the price list this catalogue is built from. */
  readonly asOf = STATIC_PRICES_AS_OF;

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    const offers: ComputeOffer[] = [];
    for (const region of STATIC_REGIONS) {
      if (location !== undefined && region !== location) continue;
      for (const size of STATIC_SIZES) {
        offers.push({
          provider: "digitalocean",
          id: size.slug,
          description: "Basic",
          vcpus: size.vcpus,
          memoryGb: size.memoryGb,
          diskGb: size.diskGb,
          cpuType: "shared",
          architecture: "x86",
          location: region,
          monthly: { amount: size.monthly, currency: "USD" },
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
    if (!STATIC_REGIONS.includes(location)) {
      throw new OpsCrewError("INVALID_INPUT", `Unknown DigitalOcean region: ${location}.`, {
        hint: `Use one of ${STATIC_REGIONS.join(", ")}.`,
      });
    }
    return publishedExtras();
  }
}

/** The backup percentage from the dated published price table. */
function publishedExtras(): ProviderExtras {
  return {
    backupPercent: BACKUP_PERCENT,
    pricesIncludeVat: false,
    source: "static",
    asOf: STATIC_PRICES_AS_OF,
  };
}
