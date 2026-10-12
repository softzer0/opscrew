import type { ComputeOffer, ProviderExtras } from "@opscrew/contracts";
import { AS_OF, MemoryCatalog, offer } from "./catalog";

/** DigitalOcean-like extras: daily backups at 30 %, IPv4 included (no separate price). */
export const DIGITALOCEAN_EXTRAS: Omit<ProviderExtras, "asOf" | "source"> = {
  backupPercent: 30,
  trafficPerTb: { amount: 10.24, currency: "USD" },
  pricesIncludeVat: false,
};

/** A DigitalOcean-like offer; defaults: shared x86 Basic size in fra1, USD, available, static. */
export function doOffer(
  init: Partial<ComputeOffer> &
    Pick<ComputeOffer, "id"> & { vcpus: number; memoryGb: number; diskGb: number; price: number },
): ComputeOffer {
  const { price, ...rest } = init;
  return offer({
    location: "fra1",
    description: init.cpuType === "dedicated" ? "CPU-Optimized" : "Basic",
    ...rest,
    provider: "digitalocean",
    price,
    monthly: { amount: price, currency: "USD" },
  });
}

/** An in-memory DigitalOcean catalogue; `extras` defaults to {@link DIGITALOCEAN_EXTRAS}. */
export function digitaloceanCatalog(
  offers: ComputeOffer[],
  extras: ConstructorParameters<typeof MemoryCatalog>[1] = DIGITALOCEAN_EXTRAS,
): MemoryCatalog {
  return new MemoryCatalog(offers, extras, "digitalocean");
}

/**
 * Droplet sizes in fra1 and ams3 (the eu-central and eu-north locations) at the published Basic
 * prices, two CPU-Optimized sizes, plus traps design must skip: a size too small for the app,
 * an unavailable size in fra1 and a cheap size in London (never offered for these regions).
 */
export function doEuCatalog(): MemoryCatalog {
  const both = (init: Parameters<typeof doOffer>[0]) => [
    doOffer({ ...init, location: "fra1" }),
    doOffer({ ...init, location: "ams3" }),
  ];
  return digitaloceanCatalog([
    ...both({ id: "s-1vcpu-1gb", vcpus: 1, memoryGb: 1, diskGb: 25, price: 6 }),
    doOffer({ id: "s-1vcpu-2gb", vcpus: 1, memoryGb: 2, diskGb: 50, price: 12 }),
    doOffer({ id: "s-1vcpu-2gb", vcpus: 1, memoryGb: 2, diskGb: 50, price: 12, location: "ams3" }),
    doOffer({ id: "s-2vcpu-2gb", vcpus: 2, memoryGb: 2, diskGb: 60, price: 18, available: false }),
    doOffer({ id: "s-2vcpu-2gb", vcpus: 2, memoryGb: 2, diskGb: 60, price: 18, location: "ams3" }),
    doOffer({ id: "s-1vcpu-512mb", vcpus: 4, memoryGb: 8, diskGb: 160, price: 1, location: "lon1" }),
    ...both({ id: "s-2vcpu-4gb", vcpus: 2, memoryGb: 4, diskGb: 80, price: 24 }),
    ...both({ id: "s-4vcpu-8gb", vcpus: 4, memoryGb: 8, diskGb: 160, price: 48 }),
    ...both({ id: "c-2", vcpus: 2, memoryGb: 4, diskGb: 25, price: 42, cpuType: "dedicated" }),
    ...both({ id: "c-4", vcpus: 4, memoryGb: 8, diskGb: 50, price: 84, cpuType: "dedicated" }),
  ]);
}

export { AS_OF };
