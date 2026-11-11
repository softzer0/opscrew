import type { ComputeCatalog, ComputeOffer, ProviderExtras } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { STATIC_PLANS, STATIC_PRICES_AS_OF, STATIC_REGIONS } from "./static-prices";

/**
 * Contabo's catalogue over the dated table in `static-prices.ts` (`source: "static"`), in every
 * region OpsCrew offers. Contabo has no price API, so it is the only one. Every offer is marked
 * available because availability is unknown offline.
 */
export class StaticContaboCatalog implements ComputeCatalog {
  readonly provider = "contabo" as const;
  /** Date of the price list this catalogue is built from. */
  readonly asOf = STATIC_PRICES_AS_OF;

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    const offers: ComputeOffer[] = [];
    for (const region of STATIC_REGIONS) {
      if (location !== undefined && region !== location) continue;
      for (const plan of STATIC_PLANS) {
        offers.push({
          provider: "contabo",
          id: plan.productId,
          description: plan.name,
          vcpus: plan.vcpus,
          memoryGb: plan.memoryGb,
          diskGb: plan.diskGb,
          cpuType: "shared",
          architecture: "x86",
          location: region,
          monthly: { amount: plan.monthly, currency: "EUR" },
          pricesIncludeVat: true,
          deprecated: false,
          available: true,
          source: "static",
          asOf: STATIC_PRICES_AS_OF,
          ...(plan.setupFee !== undefined && {
            setupFee: { amount: plan.setupFee, currency: "EUR" },
          }),
          includedSnapshots: plan.includedSnapshots,
        });
      }
    }
    return offers;
  }

  /** Snapshots included up to each offer's count; no provider backups; IPv4 in the price. */
  async extras(location: string): Promise<ProviderExtras> {
    if (!STATIC_REGIONS.includes(location)) {
      throw new OpsCrewError("INVALID_INPUT", `Unknown Contabo region: ${location}.`, {
        hint: `Use one of ${STATIC_REGIONS.join(", ")}.`,
      });
    }
    return {
      snapshotsIncluded: true,
      pricesIncludeVat: true,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    };
  }
}
