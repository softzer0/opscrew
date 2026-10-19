/**
 * Monthly object storage prices, one formula per provider, for the use design expects
 * (`storage.objectStorage.expected`). No provider publishes these through an API OpsCrew reads, so
 * each table names its source and the date it was checked (research.md R3); refresh them at
 * release time. Amounts exclude VAT and are not rounded.
 */

/** The use a price is estimated for: GB stored all month and GB sent out a month. */
export interface StorageUse {
  storageGb: number;
  egressGbPerMonth: number;
}

/** A monthly estimate with where its figures come from. */
export interface StoragePrice {
  amount: number;
  currency: "USD" | "EUR";
  /** What the user should know about the figure, such as a base price charged per account. */
  note?: string;
  source: string;
  /** The day the source was read, `YYYY-MM-DD`. */
  checkedOn: string;
}

const CHECKED_ON = "2026-10-19";
const GB_PER_GIB = 2 ** 30 / 1e9;

/** The part of `used` beyond the `included` amount. */
const over = (used: number, included: number) => Math.max(0, used - included);

/** Each object storage provider's monthly price, keyed like `storage.objectStorage.provider`. */
export const STORAGE_PRICES = {
  /**
   * Cloudflare R2 Standard: USD 0.015 per GB-month after 10 GB-months, Class A operations
   * USD 4.50 and Class B USD 0.36 per million after 1 and 10 million free, no egress charge.
   * Cloudflare bills each started GB-month and million. Operations are estimated from use,
   * conservatively with objects of about 1 MB: every stored object written once a month (1,000
   * Class A per GB stored) and one read per MB sent out (1,000 Class B per GB).
   */
  r2: {
    monthlyPrice({ storageGb, egressGbPerMonth }: StorageUse): StoragePrice {
      const storage = 0.015 * Math.ceil(over(storageGb, 10));
      const classA = 4.5 * Math.ceil(over(storageGb * 1_000, 1e6) / 1e6);
      const classB = 0.36 * Math.ceil(over(egressGbPerMonth * 1_000, 1e7) / 1e6);
      return {
        amount: storage + classA + classB,
        currency: "USD",
        source: "https://developers.cloudflare.com/r2/pricing/",
        checkedOn: CHECKED_ON,
      };
    },
  },
  /**
   * DigitalOcean Spaces: USD 5 a month with 250 GiB stored and 1,024 GiB out, then USD 0.02 per
   * GiB stored and USD 0.01 per GiB out. The base is per account: "Each subscription allows you
   * to create multiple Spaces buckets", and the included amounts are "shared between all buckets".
   */
  digitalocean: {
    monthlyPrice({ storageGb, egressGbPerMonth }: StorageUse): StoragePrice {
      const storedGib = storageGb / GB_PER_GIB;
      const egressGib = egressGbPerMonth / GB_PER_GIB;
      return {
        amount: 5 + 0.02 * over(storedGib, 250) + 0.01 * over(egressGib, 1_024),
        currency: "USD",
        note:
          "DigitalOcean charges the base price once per account, for all its Spaces buckets. If " +
          "your account already pays it, this app adds only what it uses beyond the shared quota.",
        source: "https://docs.digitalocean.com/products/spaces/details/pricing/",
        checkedOn: CHECKED_ON,
      };
    },
  },
  /**
   * Hetzner Object Storage: EUR 6.49 a month per account while any bucket exists, including
   * 744 TB-hours stored (1 TB all month) and 1.116 TB out in a 31-day month, then EUR 6.26 per
   * TB-month stored and EUR 1.00 per TB out (1 TB = 1,000 GB). The estimate uses a 31-day month.
   * The quota rules: https://docs.hetzner.com/storage/object-storage/overview (same date).
   */
  hetzner: {
    monthlyPrice({ storageGb, egressGbPerMonth }: StorageUse): StoragePrice {
      const storedTb = storageGb / 1_000;
      const egressTb = egressGbPerMonth / 1_000;
      return {
        amount: 6.49 + 6.26 * over(storedTb, 1) + 1.0 * over(egressTb, 1.116),
        currency: "EUR",
        note:
          "Hetzner charges the base price once per account, for every hour any bucket exists. If " +
          "your account already pays it, this app adds only what it uses beyond the shared quota.",
        source: "https://www.hetzner.com/storage/object-storage/",
        checkedOn: CHECKED_ON,
      };
    },
  },
  /** Garage on the user's own server or Portainer: no charge beyond the server. */
  garage: {
    monthlyPrice(_use: StorageUse): StoragePrice {
      return {
        amount: 0,
        currency: "USD",
        note: "Garage keeps the objects on the server's own disk, so it costs nothing extra.",
        source: "https://garagehq.deuxfleurs.fr/documentation/quick-start/",
        checkedOn: CHECKED_ON,
      };
    },
  },
} as const satisfies Record<string, { monthlyPrice(use: StorageUse): StoragePrice }>;
