import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeFetch, fakeSleep, fixture } from "./__fixtures__/fake-fetch";
import { DigitalOceanCatalog, StaticDigitalOceanCatalog } from "./catalog";
import { DigitalOceanClient } from "./client";
import { STATIC_PRICES_AS_OF } from "./static-prices";

const NOW = new Date("2026-10-12T12:00:00.000Z");

function liveCatalog() {
  const fake = fakeFetch({
    "/v2/sizes?page=1": { body: fixture("sizes-page1.json") },
    "/v2/sizes?page=2": { body: fixture("sizes-page2.json") },
    "/v2/regions": { body: fixture("regions.json") },
  });
  const client = new DigitalOceanClient({
    token: fakeSecret("digitalocean-token"),
    fetch: fake.fetch,
    sleep: fakeSleep().sleep,
  });
  return { catalog: new DigitalOceanCatalog(client, { now: () => NOW }), calls: fake.calls };
}

describe("DigitalOceanCatalog (live)", () => {
  it("lists available regions that offer sizes, named from the table or by the API", async () => {
    const { catalog } = liveCatalog();
    const locations = await catalog.listLocations();
    expect(locations).toEqual([
      { id: "fra1", name: "Frankfurt", city: "Frankfurt", country: "DE" },
      { id: "ams3", name: "Amsterdam", city: "Amsterdam", country: "NL" },
      { id: "xyz1", name: "Somewhere 1", country: "" },
    ]);
  });

  it("offers Basic regular (shared) and CPU-Optimized (dedicated) sizes only", async () => {
    const { catalog } = liveCatalog();
    const offers = await catalog.listOffers();
    expect(offers.map((o) => `${o.id}@${o.location}`)).toEqual([
      "s-1vcpu-1gb@ams3",
      "s-1vcpu-1gb@fra1",
      "s-1vcpu-1gb@nyc3",
      "s-2vcpu-4gb@fra1",
      "s-2vcpu-4gb@lon1",
      "c-2@fra1",
      "c-2@nyc3",
    ]);
    expect(offers.find((o) => o.id === "s-2vcpu-4gb")).toMatchObject({
      provider: "digitalocean",
      description: "Basic",
      vcpus: 2,
      memoryGb: 4,
      diskGb: 80,
      cpuType: "shared",
      architecture: "x86",
      monthly: { amount: 24, currency: "USD" },
      hourly: { amount: 0.03571, currency: "USD" },
      pricesIncludeVat: false,
      includedTrafficTb: 4,
      deprecated: false,
      available: true,
      source: "live",
      asOf: NOW.toISOString(),
    });
    expect(offers.find((o) => o.id === "c-2")).toMatchObject({
      cpuType: "dedicated",
      memoryGb: 4,
      monthly: { amount: 42, currency: "USD" },
    });
  });

  it("drops unavailable sizes, 512 MiB, premium, General Purpose and GPU sizes", async () => {
    const { catalog } = liveCatalog();
    const ids = new Set((await catalog.listOffers()).map((o) => o.id));
    for (const excluded of [
      "s-4vcpu-8gb",
      "s-1vcpu-512mb-10gb",
      "s-1vcpu-1gb-intel",
      "c2-2vcpu-4gb",
      "g-2vcpu-8gb",
      "gpu-h100x1-80gb",
    ]) {
      expect(ids.has(excluded)).toBe(false);
    }
  });

  it("filters by region and caches the sizes", async () => {
    const { catalog, calls } = liveCatalog();
    expect((await catalog.listOffers("fra1")).map((o) => o.id)).toEqual([
      "s-1vcpu-1gb",
      "s-2vcpu-4gb",
      "c-2",
    ]);
    expect((await catalog.listOffers("lon1")).map((o) => o.id)).toEqual(["s-2vcpu-4gb"]);
    expect(await catalog.listOffers("nowhere")).toEqual([]);
    expect(calls.filter((call) => call.url.pathname === "/v2/sizes")).toHaveLength(2);
  });

  it("retries the size list after a failure instead of caching the error", async () => {
    const fake = fakeFetch({
      "/v2/sizes?page=1": [
        { status: 500, body: { id: "server_error", message: "boom" } },
        { status: 500, body: { id: "server_error", message: "boom" } },
        { body: fixture("sizes-page1.json") },
      ],
      "/v2/sizes?page=2": { body: fixture("sizes-page2.json") },
    });
    const client = new DigitalOceanClient({
      token: fakeSecret("digitalocean-token"),
      fetch: fake.fetch,
      sleep: fakeSleep().sleep,
    });
    const catalog = new DigitalOceanCatalog(client, { now: () => NOW });
    await expect(catalog.listOffers()).rejects.toBeInstanceOf(OpsCrewError);
    expect((await catalog.listOffers()).length).toBeGreaterThan(0);
  });

  it("reports daily backups at 30 %, USD traffic and no separate IPv4 cost", async () => {
    const { catalog, calls } = liveCatalog();
    const extras = await catalog.extras("fra1");
    expect(extras).toEqual({
      backupPercent: 30,
      trafficPerTb: { amount: 10.24, currency: "USD" },
      pricesIncludeVat: false,
      source: "live",
      asOf: NOW.toISOString(),
    });
    expect(extras.ipv4Monthly).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("StaticDigitalOceanCatalog", () => {
  const catalog = new StaticDigitalOceanCatalog();

  it("is dated 2026-10-12", () => {
    expect(STATIC_PRICES_AS_OF.slice(0, 10)).toBe("2026-10-12");
    expect(catalog.asOf).toBe(STATIC_PRICES_AS_OF);
    expect(catalog.provider).toBe("digitalocean");
  });

  it("lists every Droplet region", async () => {
    const locations = await catalog.listLocations();
    expect(locations.map((l) => l.id)).toEqual([
      "nyc1",
      "nyc2",
      "nyc3",
      "sfo2",
      "sfo3",
      "ams3",
      "sgp1",
      "lon1",
      "fra1",
      "tor1",
      "blr1",
      "syd1",
      "atl1",
      "ric1",
      "mkc1",
      "mem1",
    ]);
    expect(locations.find((l) => l.id === "lon1")).toMatchObject({ name: "London", country: "GB" });
  });

  it("offers the dated Basic table in every region with USD prices", async () => {
    const offers = await catalog.listOffers("fra1");
    expect(offers.map((o) => [o.id, o.monthly.amount])).toEqual([
      ["s-1vcpu-1gb", 6],
      ["s-1vcpu-2gb", 12],
      ["s-2vcpu-2gb", 18],
      ["s-2vcpu-4gb", 24],
      ["s-4vcpu-8gb", 48],
    ]);
    expect(offers[0]).toMatchObject({
      provider: "digitalocean",
      vcpus: 1,
      memoryGb: 1,
      diskGb: 25,
      includedTrafficTb: 1,
      cpuType: "shared",
      architecture: "x86",
      monthly: { amount: 6, currency: "USD" },
      hourly: { amount: 0.00893, currency: "USD" },
      pricesIncludeVat: false,
      available: true,
      deprecated: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    });
    expect(await catalog.listOffers()).toHaveLength(16 * 5);
  });

  it("returns static extras and rejects unknown regions", async () => {
    expect(await catalog.extras("ams3")).toEqual({
      backupPercent: 30,
      trafficPerTb: { amount: 10.24, currency: "USD" },
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    });
    const error = (await catalog.extras("mars1").catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.hint).toContain("fra1");
  });
});
