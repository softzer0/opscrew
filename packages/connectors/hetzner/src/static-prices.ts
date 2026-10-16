/**
 * Dated static fallback for Hetzner Cloud prices.
 *
 * Source: Hetzner Docs, "Hetzner Price Adjustment 15 June 2026"
 * (https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), "Cloud
 * servers" tables, prices valid for orders from 2026-06-15; checked against the live Cloud API on
 * 2026-10-14 (`static-prices.live.test.ts`), which added cpx02 and cpx12 in the EU and corrected
 * ccx63 in the USA. Monthly, EUR, net (excluding VAT) and excluding the primary IPv4. Live API
 * prices always win when a token works.
 */
export const STATIC_PRICES_AS_OF = "2026-10-14T00:00:00.000Z";

/** Price group a location belongs to in Hetzner's price list. */
export type StaticPriceGroup = "eu" | "us" | "sin";

export interface StaticLocation {
  /** Hetzner location id, for example `nbg1`. */
  id: string;
  /** City, for example `Nuremberg`. */
  name: string;
  /** Country code, checked against the API by the live price test. */
  country: string;
  group: StaticPriceGroup;
}

export const STATIC_LOCATIONS: readonly StaticLocation[] = [
  { id: "fsn1", name: "Falkenstein", country: "DE", group: "eu" },
  { id: "nbg1", name: "Nuremberg", country: "DE", group: "eu" },
  { id: "hel1", name: "Helsinki", country: "FI", group: "eu" },
  { id: "ash", name: "Ashburn", country: "US", group: "us" },
  { id: "hil", name: "Hillsboro", country: "US", group: "us" },
  { id: "sin", name: "Singapore", country: "SG", group: "sin" },
];

export interface StaticServerType {
  name: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  cpuType: "shared" | "dedicated";
  architecture: "x86" | "arm";
  /**
   * Net EUR monthly price per price group; a missing group means the type is not sold (or the
   * price is unknown) there.
   */
  prices: Partial<Record<StaticPriceGroup, number>>;
}

function type(
  name: string,
  vcpus: number,
  memoryGb: number,
  diskGb: number,
  prices: StaticServerType["prices"],
): StaticServerType {
  const cpuType = name.startsWith("ccx") ? "dedicated" : "shared";
  const architecture = name.startsWith("cax") ? "arm" : "x86";
  return { name, vcpus, memoryGb, diskGb, cpuType, architecture, prices };
}

/** Server types with their price per group (research.md "Hetzner prices", refreshed 2026-10-14). */
export const STATIC_SERVER_TYPES: readonly StaticServerType[] = [
  // Cost-optimized (shared, x86) — EU only.
  type("cx23", 2, 4, 40, { eu: 5.49 }),
  type("cx33", 4, 8, 80, { eu: 8.49 }),
  type("cx43", 8, 16, 160, { eu: 15.99 }),
  type("cx53", 16, 32, 320, { eu: 29.49 }),
  // Regular performance (shared, x86), current generation — EU and Singapore.
  type("cpx02", 1, 1, 20, { eu: 5.99, sin: 7.49 }),
  type("cpx12", 1, 2, 40, { eu: 11.49, sin: 15.49 }),
  type("cpx22", 2, 4, 80, { eu: 19.49, sin: 26.49 }),
  type("cpx32", 4, 8, 160, { eu: 35.49, sin: 48.99 }),
  type("cpx42", 8, 16, 320, { eu: 69.49, sin: 93.49 }),
  type("cpx52", 12, 24, 480, { eu: 100.49, sin: 134.49 }),
  type("cpx62", 16, 32, 640, { eu: 129.99, sin: 171.99 }),
  // Regular performance (shared, x86), previous generation — USA.
  type("cpx11", 2, 2, 40, { us: 17.49 }),
  type("cpx21", 3, 4, 80, { us: 31.99 }),
  type("cpx31", 4, 8, 160, { us: 62.49 }),
  type("cpx41", 8, 16, 240, { us: 120.49 }),
  type("cpx51", 16, 32, 360, { us: 237.99 }),
  // General purpose (dedicated, x86) — all groups.
  type("ccx13", 2, 8, 80, { eu: 42.99, us: 43.49, sin: 53.99 }),
  type("ccx23", 4, 16, 160, { eu: 85.99, us: 87.49, sin: 108.49 }),
  type("ccx33", 8, 32, 240, { eu: 138.49, us: 140.99, sin: 174.49 }),
  type("ccx43", 16, 64, 360, { eu: 275.99, us: 279.49, sin: 340.99 }),
  type("ccx53", 32, 128, 600, { eu: 533.49, us: 538.49, sin: 651.99 }),
  type("ccx63", 48, 192, 960, { eu: 853.49, us: 859.99, sin: 1036.49 }),
  // ARM (shared) — EU only. Listed for completeness; design excludes ARM.
  type("cax11", 2, 4, 40, { eu: 5.99 }),
  type("cax21", 4, 8, 80, { eu: 10.49 }),
  type("cax31", 8, 16, 160, { eu: 20.99 }),
  type("cax41", 16, 32, 320, { eu: 40.99 }),
];

/** Static extras: primary IPv4 per month (net EUR; not re-verified after June 2026). */
export const STATIC_IPV4_MONTHLY_EUR = 0.5;
/** Automated backups cost this percentage of the server price. */
export const STATIC_BACKUP_PERCENT = 20;
