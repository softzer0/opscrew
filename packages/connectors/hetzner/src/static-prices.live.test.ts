/**
 * Checks the dated static price table in `static-prices.ts` against the live Hetzner Cloud API, so
 * the table and `STATIC_PRICES_AS_OF` are refreshed before a release (docs/e2e.md). Read-only:
 * `GET /server_types`, `GET /locations` and `GET /pricing`. Runs only when
 * OPSCREW_E2E_HCLOUD_TOKEN is set and is skipped otherwise, so normal runs and CI never call the
 * API. A failure lists every difference at once and never includes the token.
 */
import { describe, expect, it } from "vitest";
import {
  HetznerClient,
  type HetznerLocation,
  type HetznerPricing,
  type HetznerServerType,
} from "./client";
import {
  STATIC_BACKUP_PERCENT,
  STATIC_IPV4_MONTHLY_EUR,
  STATIC_LOCATIONS,
  STATIC_PRICES_AS_OF,
  STATIC_SERVER_TYPES,
} from "./static-prices";

const token = process.env.OPSCREW_E2E_HCLOUD_TOKEN;

/** `5.49` for a monthly price; the table keeps cents. */
const cents = (amount: number) => Math.round(amount * 100);
/** Hourly prices are kept to four decimals in the table. */
const tenThousandths = (amount: number) => Math.round(amount * 10_000);

/** True when the API says the type can no longer be ordered in `location` (or anywhere). */
function deprecatedIn(type: HetznerServerType, location: string): boolean {
  const typeLevel =
    (type.deprecated !== undefined && type.deprecated !== null && type.deprecated !== false) ||
    (type.deprecation !== undefined && type.deprecation !== null);
  const entry = type.locations?.find((l) => l.name === location);
  return typeLevel || (entry?.deprecation !== undefined && entry.deprecation !== null);
}

/**
 * Every difference between the static table and the live API: locations, server types and their
 * specs, monthly (to the cent) and hourly (to the table's four decimals) net prices per location,
 * the primary IPv4 price and the backup percentage. Deprecated live types are not expected in the
 * table; a table entry the API marks deprecated is a difference.
 */
function compareWithLive(
  types: readonly HetznerServerType[],
  locations: readonly HetznerLocation[],
  pricing: HetznerPricing,
): string[] {
  const out: string[] = [];

  // Locations: both sides, plus country, city and network zone.
  const liveLocations = new Map(locations.map((l) => [l.name, l]));
  for (const ours of STATIC_LOCATIONS) {
    const live = liveLocations.get(ours.id);
    if (live === undefined) {
      out.push(`Location ${ours.id}: in the table, not in the API.`);
      continue;
    }
    if (live.country !== ours.country) {
      out.push(`Location ${ours.id}: country ${ours.country} in the table, ${live.country} live.`);
    }
    if (live.city !== undefined && live.city !== ours.city) {
      out.push(`Location ${ours.id}: city "${ours.city}" in the table, "${live.city}" live.`);
    }
    if (live.network_zone !== undefined && live.network_zone !== ours.networkZone) {
      out.push(
        `Location ${ours.id}: network zone ${ours.networkZone} in the table, ${live.network_zone} live.`,
      );
    }
  }
  const ourLocationIds = new Set(STATIC_LOCATIONS.map((l) => l.id));
  for (const live of locations) {
    if (!ourLocationIds.has(live.name)) {
      out.push(`Location ${live.name}: in the API, not in the table.`);
    }
  }

  // Server types: specs, then the price in every table location.
  const liveTypes = new Map(types.map((t) => [t.name, t]));
  for (const ours of STATIC_SERVER_TYPES) {
    const live = liveTypes.get(ours.name);
    if (live === undefined) {
      out.push(`Server type ${ours.name}: in the table, not in the API.`);
      continue;
    }
    const specs: [string, number | string, number | string][] = [
      ["vCPUs", ours.vcpus, live.cores],
      ["memory GB", ours.memoryGb, live.memory],
      ["disk GB", ours.diskGb, live.disk],
      ["CPU type", ours.cpuType, live.cpu_type],
      ["architecture", ours.architecture, live.architecture ?? "x86"],
    ];
    for (const [what, table, api] of specs) {
      if (table !== api)
        out.push(`Server type ${ours.name}: ${what} ${table} in the table, ${api} live.`);
    }
  }
  for (const location of STATIC_LOCATIONS) {
    for (const ours of STATIC_SERVER_TYPES) {
      const live = liveTypes.get(ours.name);
      if (live === undefined) continue;
      const table = ours.prices[location.group];
      const price = live.prices.find((p) => p.location === location.id);
      const sold = price !== undefined && !deprecatedIn(live, location.id);
      const where = `${ours.name} in ${location.id} (${location.group} group)`;
      if (table === undefined) {
        if (sold) out.push(`${where}: sold live, missing from the table.`);
        continue;
      }
      if (price === undefined) {
        out.push(`${where}: in the table, no live price.`);
        continue;
      }
      if (!sold) out.push(`${where}: in the table, deprecated live.`);
      const [monthly, hourly] = table;
      if (cents(monthly) !== cents(price.price_monthly.net)) {
        out.push(`${where}: monthly €${monthly} in the table, €${price.price_monthly.net} live.`);
      }
      if (tenThousandths(hourly) !== tenThousandths(price.price_hourly.net)) {
        out.push(`${where}: hourly €${hourly} in the table, €${price.price_hourly.net} live.`);
      }
    }
  }
  const ourTypeNames = new Set(STATIC_SERVER_TYPES.map((t) => t.name));
  for (const live of types) {
    if (ourTypeNames.has(live.name)) continue;
    const soldIn = live.prices
      .map((p) => p.location)
      .filter((l) => ourLocationIds.has(l) && !deprecatedIn(live, l));
    if (soldIn.length > 0) {
      out.push(`Server type ${live.name}: sold live in ${soldIn.join(", ")}, not in the table.`);
    }
  }

  // Extras: currency, primary IPv4 per location, backup percentage.
  if (pricing.currency !== "EUR") {
    out.push(`Pricing currency: EUR in the table, ${pricing.currency} live.`);
  }
  const ipv4 = pricing.primary_ips?.find((ip) => ip.type === "ipv4");
  for (const location of STATIC_LOCATIONS) {
    const live = ipv4?.prices.find((p) => p.location === location.id);
    if (live === undefined) {
      out.push(`Primary IPv4 in ${location.id}: in the table, no live price.`);
    } else if (cents(live.price_monthly.net) !== cents(STATIC_IPV4_MONTHLY_EUR)) {
      out.push(
        `Primary IPv4 in ${location.id}: €${STATIC_IPV4_MONTHLY_EUR} a month in the table, €${live.price_monthly.net} live.`,
      );
    }
  }
  const backup = pricing.server_backup?.percentage;
  if (backup === undefined) {
    out.push("Backup percentage: in the table, not in the API.");
  } else if (backup !== STATIC_BACKUP_PERCENT) {
    out.push(`Backup percentage: ${STATIC_BACKUP_PERCENT}% in the table, ${backup}% live.`);
  }
  return out;
}

/** What the live API returns when the table is up to date. */
function apiFromTable(): {
  types: HetznerServerType[];
  locations: HetznerLocation[];
  pricing: HetznerPricing;
} {
  const types = STATIC_SERVER_TYPES.map((type, id) => ({
    id,
    name: type.name,
    cores: type.vcpus,
    memory: type.memoryGb,
    disk: type.diskGb,
    cpu_type: type.cpuType,
    architecture: type.architecture,
    prices: STATIC_LOCATIONS.flatMap((location) => {
      const price = type.prices[location.group];
      if (price === undefined) return [];
      const [monthly, hourly] = price;
      return [
        {
          location: location.id,
          price_monthly: { net: monthly, gross: monthly },
          price_hourly: { net: hourly, gross: hourly },
        },
      ];
    }),
  }));
  const locations = STATIC_LOCATIONS.map((location, id) => ({
    id,
    name: location.id,
    country: location.country,
    city: location.city,
    network_zone: location.networkZone,
  }));
  const ipv4 = { net: STATIC_IPV4_MONTHLY_EUR, gross: STATIC_IPV4_MONTHLY_EUR };
  const pricing = {
    currency: "EUR",
    primary_ips: [
      {
        type: "ipv4",
        prices: STATIC_LOCATIONS.map((l) => ({ location: l.id, price_monthly: ipv4 })),
      },
    ],
    server_backup: { percentage: STATIC_BACKUP_PERCENT },
  };
  return { types, locations, pricing };
}

describe("Hetzner price table comparison (offline)", () => {
  it("finds no difference when the API matches the table", () => {
    const { types, locations, pricing } = apiFromTable();
    expect(compareWithLive(types, locations, pricing)).toEqual([]);
  });

  it("lists every difference and what is missing on either side", () => {
    const { types, locations, pricing } = apiFromTable();
    const cx23 = types.find((t) => t.name === "cx23");
    const cx33 = types.find((t) => t.name === "cx33");
    if (cx23 === undefined || cx33 === undefined) throw new Error("table changed");
    cx23.prices = cx23.prices.map((p) =>
      p.location === "nbg1" ? { ...p, price_monthly: { net: 6.49, gross: 6.49 } } : p,
    );
    cx33.deprecation = { announced: "2026-01-01T00:00:00Z" };
    const differences = compareWithLive(
      [
        ...types.filter((t) => t.name !== "cax11"),
        { ...cx23, id: 999, name: "cx99" },
        // Deprecated and not in the table: not a difference.
        { ...cx23, id: 998, name: "cx11", deprecation: { announced: "2025-01-01T00:00:00Z" } },
      ],
      [...locations.filter((l) => l.name !== "hil"), { id: 99, name: "xyz1", country: "DE" }],
      { ...pricing, server_backup: { percentage: 25 } },
    );
    expect(differences).toEqual(
      expect.arrayContaining([
        "Location hil: in the table, not in the API.",
        "Location xyz1: in the API, not in the table.",
        "Server type cax11: in the table, not in the API.",
        "cx23 in nbg1 (eu group): monthly €5.49 in the table, €6.49 live.",
        "cx33 in nbg1 (eu group): in the table, deprecated live.",
        "Server type cx99: sold live in fsn1, nbg1, hel1, not in the table.",
        "Backup percentage: 20% in the table, 25% live.",
      ]),
    );
    expect(differences.join("\n")).not.toContain("cx11");
  });
});

describe.skipIf(!token)(
  "Hetzner static price table matches the live API (needs OPSCREW_E2E_HCLOUD_TOKEN, skipped without it)",
  () => {
    it("has the same locations, server types, prices, IPv4 price and backup percentage", async () => {
      const client = new HetznerClient({ token: token ?? "" });
      const [types, locations, pricing] = await Promise.all([
        client.listServerTypes(),
        client.listLocations(),
        client.getPricing(),
      ]);
      const differences = compareWithLive(types, locations, pricing);
      if (differences.length > 0) {
        expect.fail(
          [
            `${differences.length} difference(s) between packages/connectors/hetzner/src/static-prices.ts (as of ${STATIC_PRICES_AS_OF.slice(0, 10)}) and the live Hetzner Cloud API:`,
            ...differences.map((d) => `- ${d}`),
            "Update the table and STATIC_PRICES_AS_OF from the live values.",
          ].join("\n"),
        );
      }
    }, 60_000);
  },
);
