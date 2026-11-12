import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { StaticContaboCatalog } from "./catalog";
import { STATIC_PRICES_AS_OF } from "./static-prices";

describe("StaticContaboCatalog", () => {
  it("offers the Cloud VPS plans at the monthly rate with their included snapshots", async () => {
    const offers = await new StaticContaboCatalog().listOffers("EU");
    expect(
      offers.map((o) => [o.id, o.description, o.vcpus, o.memoryGb, o.diskGb, o.monthly.amount]),
    ).toEqual([
      ["V153", "Cloud VPS 4", 4, 8, 100, 5.5],
      ["V154", "Cloud VPS 6", 6, 12, 200, 7.5],
      ["V155", "Cloud VPS 8", 8, 24, 300, 14],
      ["V156", "Cloud VPS 12", 12, 48, 400, 25],
    ]);
    expect(offers.map((o) => o.includedSnapshots)).toEqual([1, 2, 3, 3]);
    // A monthly Cloud VPS 4 costs a setup fee once (a checkout on 2026-11-12); the others none.
    expect(offers.map((o) => o.setupFee)).toEqual([
      { amount: 2, currency: "EUR" },
      undefined,
      undefined,
      undefined,
    ]);
    for (const offer of offers) {
      expect(offer).toMatchObject({
        provider: "contabo",
        location: "EU",
        cpuType: "shared",
        architecture: "x86",
        monthly: { currency: "EUR" },
        pricesIncludeVat: false,
        available: true,
        deprecated: false,
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      });
    }
  });

  it("offers every plan in each region OpsCrew uses, at the same price", async () => {
    const offers = await new StaticContaboCatalog().listOffers();
    expect([...new Set(offers.map((o) => o.location))]).toEqual([
      "EU",
      "US-east",
      "US-west",
      "SIN",
    ]);
    expect(offers).toHaveLength(16);
    expect(offers.filter((o) => o.id === "V153").map((o) => o.monthly.amount)).toEqual([
      5.5, 5.5, 5.5, 5.5,
    ]);
    expect(await new StaticContaboCatalog().listOffers("US-central")).toEqual([]);
  });

  it("is dated", () => {
    expect(new StaticContaboCatalog().asOf).toBe(STATIC_PRICES_AS_OF);
    expect(Number.isNaN(Date.parse(STATIC_PRICES_AS_OF))).toBe(false);
  });

  it("includes snapshots and has no provider backups", async () => {
    const extras = await new StaticContaboCatalog().extras("SIN");
    expect(extras).toEqual({
      snapshotsIncluded: true,
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    });
  });

  it("refuses a region it does not offer", async () => {
    const error = await new StaticContaboCatalog().extras("UK").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
  });
});
