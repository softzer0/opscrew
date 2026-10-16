import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeSleep, fixture, hetznerFetch } from "./__fixtures__/fixtures";
import { HetznerCatalog, StaticHetznerCatalog } from "./catalog";
import { HetznerClient } from "./client";
import { STATIC_PRICES_AS_OF } from "./static-prices";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function liveCatalog() {
  const fake = hetznerFetch({
    "/server_types?page=1": { body: fixture("server-types-page1.json") },
    "/server_types?page=2": { body: fixture("server-types-page2.json") },
    "/pricing": { body: fixture("pricing.json") },
  });
  const client = new HetznerClient({
    token: fakeSecret("hcloud-token"),
    fetch: fake.fetch,
    sleep: fakeSleep().sleep,
  });
  return { catalog: new HetznerCatalog(client, { now: () => NOW }), calls: fake.calls };
}

describe("HetznerCatalog (live)", () => {
  it("returns one offer per (server type, location price) with net prices", async () => {
    const { catalog } = liveCatalog();
    const offers = await catalog.listOffers();
    expect(offers.map((o) => `${o.id}@${o.location}`)).toEqual([
      "cx23@fsn1",
      "cx23@nbg1",
      "cpx22@hel1",
      "cpx22@ash",
      "cx22@nbg1",
      "cax11@fsn1",
    ]);
    const cx23 = offers[0];
    expect(cx23).toMatchObject({
      provider: "hetzner",
      vcpus: 2,
      memoryGb: 4,
      diskGb: 40,
      cpuType: "shared",
      architecture: "x86",
      monthly: { amount: 5.49, currency: "EUR" },
      pricesIncludeVat: false,
      source: "live",
      asOf: NOW.toISOString(),
    });
  });

  it("derives availability from the type's locations (missing list → available)", async () => {
    const { catalog } = liveCatalog();
    const offers = await catalog.listOffers();
    const by = (key: string) => offers.find((o) => `${o.id}@${o.location}` === key);
    expect(by("cx23@fsn1")?.available).toBe(true);
    expect(by("cx23@nbg1")?.available).toBe(false);
    expect(by("cpx22@ash")?.available).toBe(false); // not listed in locations[]
    expect(by("cax11@fsn1")?.available).toBe(true); // no locations[] on older responses
  });

  it("flags deprecated types and per-location deprecations, and reports ARM", async () => {
    const { catalog } = liveCatalog();
    const offers = await catalog.listOffers();
    const by = (key: string) => offers.find((o) => `${o.id}@${o.location}` === key);
    expect(by("cx22@nbg1")?.deprecated).toBe(true);
    expect(by("cpx22@hel1")?.deprecated).toBe(true);
    expect(by("cx23@fsn1")?.deprecated).toBe(false);
    expect(by("cax11@fsn1")).toMatchObject({ architecture: "arm", deprecated: false });
  });

  it("filters by location and caches server types", async () => {
    const { catalog, calls } = liveCatalog();
    const fsn1 = await catalog.listOffers("fsn1");
    expect(fsn1.map((o) => o.id)).toEqual(["cx23", "cax11"]);
    await catalog.listOffers("nbg1");
    expect(calls.filter((c) => c.path.startsWith("/server_types?"))).toHaveLength(2);
  });

  it("reads extras: IPv4 per location and backup percent", async () => {
    const { catalog } = liveCatalog();
    expect(await catalog.extras("fsn1")).toEqual({
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      backupPercent: 20,
      pricesIncludeVat: false,
      source: "live",
      asOf: NOW.toISOString(),
    });
    expect((await catalog.extras("ash")).ipv4Monthly).toEqual({ amount: 0.6, currency: "EUR" });
    expect((await catalog.extras("sin")).ipv4Monthly).toBeUndefined();
  });
});

describe("StaticHetznerCatalog", () => {
  const catalog = new StaticHetznerCatalog();

  it("is dated and labelled static", async () => {
    expect(catalog.asOf).toBe("2026-10-14T00:00:00.000Z");
    const offers = await catalog.listOffers();
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer).toMatchObject({
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
        pricesIncludeVat: false,
        available: true,
        deprecated: false,
      });
    }
  });

  it("encodes the research.md price table per location group", async () => {
    const find = async (location: string, id: string) =>
      (await catalog.listOffers(location)).find((o) => o.id === id);
    expect(await find("nbg1", "cx23")).toMatchObject({
      vcpus: 2,
      memoryGb: 4,
      diskGb: 40,
      cpuType: "shared",
      architecture: "x86",
      monthly: { amount: 5.49, currency: "EUR" },
    });
    expect((await find("hel1", "cpx22"))?.monthly.amount).toBe(19.49);
    expect((await find("sin", "cpx22"))?.monthly.amount).toBe(26.49);
    expect((await find("ash", "ccx13"))?.monthly.amount).toBe(43.49);
    expect(await find("hil", "ccx63")).toMatchObject({
      cpuType: "dedicated",
      monthly: { amount: 859.99 },
    });
    expect((await find("fsn1", "cax11"))?.architecture).toBe("arm");
  });

  it("omits offers with unknown prices", async () => {
    const ash = await catalog.listOffers("ash");
    expect(ash.some((o) => o.id === "cx23")).toBe(false);
    expect(ash.some((o) => o.id === "cpx22")).toBe(false);
    expect(ash.map((o) => o.id)).toContain("cpx11");
    expect((await catalog.listOffers("sin")).some((o) => o.id === "cax11")).toBe(false);
    expect(await catalog.listOffers("nowhere")).toEqual([]);
    expect(await catalog.listOffers()).toHaveLength(3 * 21 + 2 * 11 + 13);
  });

  it("offers six locations and static extras", async () => {
    expect([...new Set((await catalog.listOffers()).map((o) => o.location))]).toEqual([
      "fsn1",
      "nbg1",
      "hel1",
      "ash",
      "hil",
      "sin",
    ]);
    expect(await catalog.extras("hel1")).toEqual({
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      backupPercent: 20,
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    });
    await expect(catalog.extras("mars")).rejects.toBeInstanceOf(OpsCrewError);
  });
});
