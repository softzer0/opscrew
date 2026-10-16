/**
 * Checks the dated static price table in `static-prices.ts` against the live DigitalOcean API, so
 * the table and `STATIC_PRICES_AS_OF` are refreshed before a release (docs/e2e.md). Read-only:
 * `GET /v2/sizes` and `GET /v2/regions`. The live check runs only when
 * OPSCREW_E2E_DIGITALOCEAN_TOKEN is set and is skipped otherwise, so normal runs and CI never call
 * the API; the offline checks of the comparison itself always run. A failure lists every
 * difference at once and never includes the token.
 *
 * The API has no backup or traffic prices, so `BACKUP_PERCENT` and `TRAFFIC_PER_TB_USD` are checked
 * by hand against https://www.digitalocean.com/pricing/droplets (docs/e2e.md).
 */
import { describe, expect, it } from "vitest";
import { DigitalOceanClient, type DigitalOceanRegion, type DigitalOceanSize } from "./client";
import {
  STATIC_PRICES_AS_OF,
  STATIC_REGIONS,
  STATIC_SIZES,
  type StaticSize,
} from "./static-prices";

const token = process.env.OPSCREW_E2E_DIGITALOCEAN_TOKEN;

/** Basic regular sizes, the same filter as the live catalogue's shared sizes. */
const BASIC_SLUG = /^s-\d+vcpu-\d+gb$/;
const cents = (amount: number) => Math.round(amount * 100);

/**
 * Every difference between the static table and the live API: Droplet regions on both sides; for
 * each table size its specs, monthly price (to the cent), availability and every table region it
 * is not sold in; and live Basic sizes missing from the table. The table deliberately lists only the Basic sizes up to
 * its most expensive one (bigger and CPU-Optimized sizes come from the live API only), so larger
 * live sizes are not differences.
 */
function compareWithLive(
  sizes: readonly DigitalOceanSize[],
  regions: readonly DigitalOceanRegion[],
): string[] {
  const out: string[] = [];

  const liveRegions = regions.filter((r) => r.available && r.sizes.length > 0).map((r) => r.slug);
  for (const slug of STATIC_REGIONS) {
    if (!liveRegions.includes(slug)) out.push(`Region ${slug}: in the table, not offered live.`);
  }
  for (const slug of liveRegions) {
    if (!STATIC_REGIONS.includes(slug)) out.push(`Region ${slug}: offered live, not in the table.`);
  }

  const live = new Map(sizes.map((s) => [s.slug, s]));
  for (const ours of STATIC_SIZES) {
    const size = live.get(ours.slug);
    if (size === undefined) {
      out.push(`Size ${ours.slug}: in the table, not in the API.`);
      continue;
    }
    const specs: [string, number | string, number | string][] = [
      ["description", "Basic", size.description ?? "(none)"],
      ["vCPUs", ours.vcpus, size.vcpus],
      ["memory GB", ours.memoryGb, size.memory / 1024],
      ["disk GB", ours.diskGb, size.disk],
    ];
    for (const [what, table, api] of specs) {
      if (table !== api) out.push(`Size ${ours.slug}: ${what} ${table} in the table, ${api} live.`);
    }
    if (cents(ours.monthly) !== cents(size.price_monthly)) {
      out.push(
        `Size ${ours.slug}: monthly $${ours.monthly} in the table, $${size.price_monthly} live.`,
      );
    }
    if (!size.available) out.push(`Size ${ours.slug}: in the table, not available live.`);
    const missing = STATIC_REGIONS.filter(
      (region) => liveRegions.includes(region) && !size.regions.includes(region),
    );
    if (missing.length > 0) {
      out.push(
        `Size ${ours.slug}: in the table for every region, not sold in ${missing.join(", ")}.`,
      );
    }
  }

  const ours = new Set(STATIC_SIZES.map((s) => s.slug));
  const ceiling = Math.max(...STATIC_SIZES.map((s) => s.monthly));
  for (const size of sizes) {
    const basic = size.description === "Basic" && BASIC_SLUG.test(size.slug) && size.memory >= 1024;
    if (basic && size.available && !ours.has(size.slug) && size.price_monthly <= ceiling) {
      out.push(`Size ${size.slug}: Basic at $${size.price_monthly} live, not in the table.`);
    }
  }
  return out;
}

/** The API's view of a table size: what the live API returns when the table is up to date. */
function apiSize(size: StaticSize, regions: readonly string[] = STATIC_REGIONS): DigitalOceanSize {
  return {
    slug: size.slug,
    description: "Basic",
    vcpus: size.vcpus,
    memory: size.memoryGb * 1024,
    disk: size.diskGb,
    price_monthly: size.monthly,
    regions: [...regions],
    available: true,
  };
}

const apiRegions = (slugs: readonly string[]): DigitalOceanRegion[] =>
  slugs.map((slug) => ({ slug, name: slug, sizes: ["s-1vcpu-1gb"], available: true }));

describe("DigitalOcean price table comparison (offline)", () => {
  it("finds no difference when the API matches the table", () => {
    expect(
      compareWithLive(
        STATIC_SIZES.map((s) => apiSize(s)),
        apiRegions(STATIC_REGIONS),
      ),
    ).toEqual([]);
  });

  it("lists every difference and what is missing on either side", () => {
    const [first, second, ...rest] = STATIC_SIZES;
    if (first === undefined || second === undefined) throw new Error("table too small");
    const sizes = [
      { ...apiSize(first), price_monthly: first.monthly + 1 },
      ...rest.map((s) =>
        apiSize(
          s,
          STATIC_REGIONS.filter((r) => r !== "fra1"),
        ),
      ),
      { ...apiSize(first), slug: "s-1vcpu-3gb", price_monthly: 9 },
      // Bigger than every table size: not expected in the table.
      { ...apiSize(first), slug: "s-8vcpu-16gb", price_monthly: 96 },
    ];
    const regions = apiRegions([...STATIC_REGIONS.filter((r) => r !== "ric1"), "xyz1"]);
    const differences = compareWithLive(sizes, regions);
    expect(differences).toEqual(
      expect.arrayContaining([
        "Region ric1: in the table, not offered live.",
        "Region xyz1: offered live, not in the table.",
        `Size ${first.slug}: monthly $${first.monthly} in the table, $${first.monthly + 1} live.`,
        `Size ${second.slug}: in the table, not in the API.`,
        "Size s-1vcpu-3gb: Basic at $9 live, not in the table.",
      ]),
    );
    expect(differences.filter((d) => d.endsWith("not sold in fra1."))).toHaveLength(rest.length);
    expect(differences.join("\n")).not.toContain("s-8vcpu-16gb");
  });
});

describe.skipIf(!token)(
  "DigitalOcean static price table matches the live API (needs OPSCREW_E2E_DIGITALOCEAN_TOKEN, skipped without it)",
  () => {
    it("has the same regions, Basic sizes and prices", async () => {
      const client = new DigitalOceanClient({ token: token ?? "" });
      const [sizes, regions] = await Promise.all([client.listSizes(), client.listRegions()]);
      const differences = compareWithLive(sizes, regions);
      if (differences.length > 0) {
        expect.fail(
          [
            `${differences.length} difference(s) between packages/connectors/digitalocean/src/static-prices.ts (as of ${STATIC_PRICES_AS_OF.slice(0, 10)}) and the live DigitalOcean API:`,
            ...differences.map((d) => `- ${d}`),
            "Update the table and STATIC_PRICES_AS_OF from the live values.",
          ].join("\n"),
        );
      }
    }, 60_000);
  },
);
