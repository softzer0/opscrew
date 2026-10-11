import type { ComputeLocation } from "@opscrew/contracts";

/**
 * Dated static fallback for Hetzner Cloud prices.
 *
 * Source: Hetzner Docs, "Hetzner Price Adjustment 15 June 2026"
 * (https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), "Cloud
 * servers" tables, prices valid for orders from 2026-06-15. Monthly and hourly, EUR, net
 * (excluding VAT) and excluding the primary IPv4. Live API prices always win when a token works.
 */
export const STATIC_PRICES_AS_OF = "2026-06-15T00:00:00.000Z";

/** Price group a location belongs to in Hetzner's price list. */
export type StaticPriceGroup = "eu" | "us" | "sin";

export interface StaticLocation extends ComputeLocation {
  group: StaticPriceGroup;
}

export const STATIC_LOCATIONS: readonly StaticLocation[] = [
  {
    id: "fsn1",
    name: "Falkenstein",
    city: "Falkenstein",
    country: "DE",
    networkZone: "eu-central",
    group: "eu",
  },
  {
    id: "nbg1",
    name: "Nuremberg",
    city: "Nuremberg",
    country: "DE",
    networkZone: "eu-central",
    group: "eu",
  },
  {
    id: "hel1",
    name: "Helsinki",
    city: "Helsinki",
    country: "FI",
    networkZone: "eu-central",
    group: "eu",
  },
  {
    id: "ash",
    name: "Ashburn",
    city: "Ashburn, VA",
    country: "US",
    networkZone: "us-east",
    group: "us",
  },
  {
    id: "hil",
    name: "Hillsboro",
    city: "Hillsboro, OR",
    country: "US",
    networkZone: "us-west",
    group: "us",
  },
  {
    id: "sin",
    name: "Singapore",
    city: "Singapore",
    country: "SG",
    networkZone: "ap-southeast",
    group: "sin",
  },
];

/** Net EUR prices: `[monthly, hourly]`. */
export type StaticPrice = readonly [monthly: number, hourly: number];

export interface StaticServerType {
  name: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  cpuType: "shared" | "dedicated";
  architecture: "x86" | "arm";
  /** Prices per price group; a missing group means the type is not sold (or price unknown) there. */
  prices: Partial<Record<StaticPriceGroup, StaticPrice>>;
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

/** Server types with their price per group, exactly as in research.md "Hetzner prices". */
export const STATIC_SERVER_TYPES: readonly StaticServerType[] = [
  // Cost-optimized (shared, x86) — EU only.
  type("cx23", 2, 4, 40, { eu: [5.49, 0.0088] }),
  type("cx33", 4, 8, 80, { eu: [8.49, 0.0136] }),
  type("cx43", 8, 16, 160, { eu: [15.99, 0.0256] }),
  type("cx53", 16, 32, 320, { eu: [29.49, 0.0473] }),
  // Regular performance (shared, x86), current generation — EU and Singapore.
  type("cpx12", 1, 2, 40, { sin: [15.49, 0.0248] }),
  type("cpx22", 2, 4, 80, { eu: [19.49, 0.0312], sin: [26.49, 0.0425] }),
  type("cpx32", 4, 8, 160, { eu: [35.49, 0.0569], sin: [48.99, 0.0785] }),
  type("cpx42", 8, 16, 320, { eu: [69.49, 0.1114], sin: [93.49, 0.1498] }),
  type("cpx52", 12, 24, 480, { eu: [100.49, 0.161], sin: [134.49, 0.2155] }),
  type("cpx62", 16, 32, 640, { eu: [129.99, 0.2083], sin: [171.99, 0.2756] }),
  // Regular performance (shared, x86), previous generation — USA.
  type("cpx11", 2, 2, 40, { us: [17.49, 0.028] }),
  type("cpx21", 3, 4, 80, { us: [31.99, 0.0513] }),
  type("cpx31", 4, 8, 160, { us: [62.49, 0.1001] }),
  type("cpx41", 8, 16, 240, { us: [120.49, 0.1931] }),
  type("cpx51", 16, 32, 360, { us: [237.99, 0.3814] }),
  // General purpose (dedicated, x86) — all groups.
  type("ccx13", 2, 8, 80, { eu: [42.99, 0.0689], us: [43.49, 0.0697], sin: [53.99, 0.0865] }),
  type("ccx23", 4, 16, 160, { eu: [85.99, 0.1378], us: [87.49, 0.1402], sin: [108.49, 0.1739] }),
  type("ccx33", 8, 32, 240, { eu: [138.49, 0.2219], us: [140.99, 0.2259], sin: [174.49, 0.2796] }),
  type("ccx43", 16, 64, 360, { eu: [275.99, 0.4423], us: [279.49, 0.4479], sin: [340.99, 0.5465] }),
  type("ccx53", 32, 128, 600, { eu: [533.49, 0.855], us: [538.49, 0.863], sin: [651.99, 1.0449] }),
  type("ccx63", 48, 192, 960, {
    eu: [853.49, 1.3678],
    us: [853.49, 1.3782],
    sin: [1036.49, 1.661],
  }),
  // ARM (shared) — EU only. Listed for completeness; design excludes ARM.
  type("cax11", 2, 4, 40, { eu: [5.99, 0.0096] }),
  type("cax21", 4, 8, 80, { eu: [10.49, 0.0168] }),
  type("cax31", 8, 16, 160, { eu: [20.99, 0.0336] }),
  type("cax41", 16, 32, 320, { eu: [40.99, 0.0657] }),
];

/** Static extras: primary IPv4 per month (net EUR; not re-verified after June 2026). */
export const STATIC_IPV4_MONTHLY_EUR = 0.5;
/** Automated backups cost this percentage of the server price. */
export const STATIC_BACKUP_PERCENT = 20;
