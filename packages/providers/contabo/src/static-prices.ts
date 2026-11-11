/**
 * Contabo's Cloud VPS prices. Contabo has no price API, so every Contabo price comes from this
 * dated table, and it is checked against contabo.com before each release.
 *
 * Source: https://contabo.com/en/vps/, read 2026-11-11. EUR a month at the standard (monthly
 * term) rate, including VAT as the page shows its prices; the cheaper 12- and 24-month rates are
 * not offered (plan decision 5). The page names no regional surcharge, so every region has the
 * EU price. It says a one-time setup fee applies to Cloud VPS 4 on a monthly term but not its
 * amount, so that offer has no `setupFee` yet. Product ids: https://api.contabo.com/ (create
 * instance, `productId`).
 */
export const STATIC_PRICES_AS_OF = "2026-11-11T00:00:00.000Z";

/** Contabo's regions OpsCrew offers (EU, US-east, US-west, SIN). */
export const STATIC_REGIONS: readonly string[] = ["EU", "US-east", "US-west", "SIN"];

export interface StaticPlan {
  /** Contabo's `productId`. */
  productId: string;
  name: string;
  vcpus: number;
  memoryGb: number;
  /** SSD. */
  diskGb: number;
  /** EUR a month on a monthly term, including VAT. */
  monthly: number;
  /** EUR once, when the server is created on a monthly term. */
  setupFee?: number;
  /** Whole-server snapshots the plan includes. */
  includedSnapshots: number;
}

/** Cloud VPS plans with SSD disks. */
export const STATIC_PLANS: readonly StaticPlan[] = [
  {
    productId: "V153",
    name: "Cloud VPS 4",
    vcpus: 4,
    memoryGb: 8,
    diskGb: 100,
    monthly: 5.5,
    includedSnapshots: 1,
  },
  {
    productId: "V154",
    name: "Cloud VPS 6",
    vcpus: 6,
    memoryGb: 12,
    diskGb: 200,
    monthly: 7.5,
    includedSnapshots: 2,
  },
  {
    productId: "V155",
    name: "Cloud VPS 8",
    vcpus: 8,
    memoryGb: 24,
    diskGb: 300,
    monthly: 14,
    includedSnapshots: 3,
  },
  {
    productId: "V156",
    name: "Cloud VPS 12",
    vcpus: 12,
    memoryGb: 48,
    diskGb: 400,
    monthly: 25,
    includedSnapshots: 3,
  },
];
