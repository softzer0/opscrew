import { STATIC_PRICES_AS_OF, StaticHetznerCatalog } from "@opscrew/connector-hetzner";
import type { ProviderExtras } from "@opscrew/contracts";
import { CostEstimateSchema, DesignOptionListSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  AS_OF,
  euCatalog,
  MemoryCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  offer,
  staticSpaFacts,
} from "./__fixtures__/catalog";
import { convertMoney, costFor, EXCHANGE_RATE_NOTE } from "./cost";
import { buildDesignOptions, minimumMonthlyCost } from "./options";

const extras: ProviderExtras = {
  ipv4Monthly: { amount: 0.5, currency: "EUR" },
  backupPercent: 20,
  pricesIncludeVat: false,
  source: "static",
  asOf: AS_OF,
};

describe("costFor", () => {
  it("adds server, IPv4 and backups with a breakdown that sums to the total", () => {
    const cost = costFor(
      offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49 }),
      extras,
      {
        backups: true,
      },
    );
    expect(cost.breakdown).toEqual([
      { item: "Server cx23 (nbg1)", monthly: { amount: 5.49, currency: "EUR" } },
      { item: "Primary IPv4 address", monthly: { amount: 0.5, currency: "EUR" } },
      {
        item: "Automated backups (20% of the server price)",
        monthly: { amount: 1.1, currency: "EUR" },
      },
    ]);
    expect(cost.monthly).toEqual({ amount: 7.09, currency: "EUR" });
    expect(cost).toMatchObject({ pricesIncludeVat: false, source: "static", asOf: AS_OF });
    expect(CostEstimateSchema.safeParse(cost).success).toBe(true);
  });

  it("omits backups when off and IPv4 when the provider has no price for it", () => {
    const cost = costFor(
      offer({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49 }),
      { pricesIncludeVat: false, source: "live", asOf: AS_OF },
      { backups: false },
    );
    expect(cost.breakdown.map((line) => line.item)).toEqual(["Server cx33 (nbg1)"]);
    expect(cost.monthly.amount).toBe(8.49);
    // A static offer keeps the whole estimate static.
    expect(cost.source).toBe("static");
  });

  it("keeps sums exact to the cent over many prices", () => {
    for (let cents = 1; cents < 5000; cents += 37) {
      const price = cents / 100 + 0.005;
      const cost = costFor(offer({ id: "x", vcpus: 1, memoryGb: 1, diskGb: 1, price }), extras, {
        backups: true,
      });
      const sum = cost.breakdown.reduce((s, l) => s + l.monthly.amount, 0);
      expect(Math.abs(sum - cost.monthly.amount)).toBeLessThan(0.005);
      expect(Number.isInteger(Math.round(cost.monthly.amount * 100))).toBe(true);
    }
  });
});

describe("convertMoney", () => {
  it("converts at 1 EUR = 1.10 USD", () => {
    expect(convertMoney({ amount: 10, currency: "EUR" }, "USD")).toEqual({
      amount: 11,
      currency: "USD",
    });
    expect(convertMoney({ amount: 11, currency: "USD" }, "EUR")).toEqual({
      amount: 10,
      currency: "EUR",
    });
    expect(convertMoney({ amount: 5.555, currency: "EUR" }, "EUR").amount).toBe(5.56);
  });
});

describe("buildDesignOptions", () => {
  it("US3-1: a small static site gets the smallest available x86 server in Nuremberg or Falkenstein, within budget and recommended", async () => {
    const catalog = euCatalog();
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements({ budgetMonthly: { amount: 10, currency: "EUR" } }),
      catalog,
    });
    expect(DesignOptionListSchema.safeParse(options).success).toBe(true);
    expect(catalog.requested).toEqual(["nbg1", "fsn1"]);

    const [lean, comfortable, ...rest] = options;
    expect(rest).toEqual([]);
    // cx13 is unavailable in nbg1, so the first location where it is available wins.
    expect(lean?.target).toMatchObject({
      serverType: "cx13",
      location: "fsn1",
      architecture: "x86",
      cpuType: "shared",
    });
    expect(lean?.id).toBe("hetzner-single-cx13-fsn1");
    expect(lean?.title).toBe("Lean: cx13 in Falkenstein");
    expect(lean?.cost.breakdown.map((line) => line.item)).toEqual([
      "Server cx13 (fsn1)",
      "Primary IPv4 address",
    ]);
    expect(lean?.cost.monthly).toEqual({ amount: 4.69, currency: "EUR" });
    expect(lean).toMatchObject({ fitsBudget: true, recommended: true, backups: false });
    expect(lean?.services).toEqual({ postgres: false, redis: false });

    expect(comfortable?.target).toMatchObject({ serverType: "cx33", location: "nbg1" });
    expect(comfortable?.title.startsWith("Comfortable")).toBe(true);
    expect(comfortable).toMatchObject({ fitsBudget: true, recommended: false });
  });

  it("never offers ARM, deprecated, unavailable or out-of-region servers", async () => {
    const options = await buildDesignOptions({
      facts: makeFacts(),
      requirements: makeRequirements({
        uptime: "high",
        budgetMonthly: { amount: 500, currency: "EUR" },
      }),
      catalog: euCatalog(),
    });
    const picked = options.map((o) => `${o.target.serverType}@${o.target.location}`);
    expect(picked).toEqual(["cx13@fsn1", "cx33@nbg1", "ccx13@nbg1"]);
    for (const trap of ["cax11", "cx22", "cx11"]) {
      expect(options.some((o) => o.target.serverType === trap)).toBe(false);
    }
    expect(options.every((o) => o.target.architecture === "x86")).toBe(true);
    expect(options.every((o) => ["nbg1", "fsn1"].includes(o.target.location))).toBe(true);
  });

  it("US3-2: Next.js + Postgres with critical data self-hosts Postgres with backups in every option", async () => {
    const options = await buildDesignOptions({
      facts: nextPostgresFacts(),
      requirements: makeRequirements({
        expectedMonthlyUsers: "1k-10k",
        dataCriticality: "critical",
        budgetMonthly: { amount: 30, currency: "EUR" },
      }),
      catalog: euCatalog(),
    });
    expect(options.map((o) => o.target.serverType)).toEqual(["cx33", "cx43"]);
    for (const option of options) {
      expect(option.services.postgres).toBe(true);
      expect(option.backups).toBe(true);
      expect(option.summary).toContain("Postgres");
      const backup = option.cost.breakdown.find((l) => l.item.startsWith("Automated backups"));
      const server = option.cost.breakdown[0]?.monthly.amount ?? 0;
      expect(backup?.monthly.amount).toBeCloseTo(server * 0.2, 2);
    }
    expect(options[0]?.cost.monthly.amount).toBe(10.69);
    expect(options[0]?.recommended).toBe(true);
  });

  it("US3-3: a budget below the cheapest option still shows options, none fitting, the cheapest recommended", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements({ budgetMonthly: { amount: 3, currency: "EUR" } }),
      catalog: euCatalog(),
    });
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.some((o) => o.fitsBudget)).toBe(false);
    expect(options.filter((o) => o.recommended).map((o) => o.target.serverType)).toEqual(["cx13"]);
    expect(options[0]?.tradeoffs.join(" ")).toContain("above your budget of €3.00/month");
    expect(minimumMonthlyCost(options, "EUR")).toEqual({ amount: 4.69, currency: "EUR" });
  });

  it("US3-4: static prices are labelled as a dated estimate; live prices are labelled live", async () => {
    const statics = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements(),
      catalog: new StaticHetznerCatalog(),
    });
    expect(statics.length).toBeGreaterThanOrEqual(2);
    for (const option of statics) {
      expect(option.cost.source).toBe("static");
      expect(option.summary).toContain(`estimate as of ${STATIC_PRICES_AS_OF.slice(0, 10)}`);
      expect(option.summary).toMatch(/(including|excluding) VAT\)/);
      expect(option.tradeoffs.join(" ")).toContain("HCLOUD_TOKEN");
    }
    // The static table's cheapest eu-central x86 server, never the ARM cax11.
    expect(statics[0]?.target).toMatchObject({ serverType: "cx23", location: "nbg1" });

    const live = new MemoryCatalog(
      [
        offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49, source: "live" }),
        offer({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49, source: "live" }),
      ],
      { ipv4Monthly: { amount: 0.5, currency: "EUR" }, pricesIncludeVat: false, source: "live" },
    );
    const lives = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements(),
      catalog: live,
    });
    for (const option of lives) {
      expect(option.cost.source).toBe("live");
      expect(option.summary).toContain("live price");
      expect(option.summary).not.toContain("estimate");
    }
  });

  it("warns when the static price list is old", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements(),
      catalog: euCatalog(),
      now: new Date("2027-09-01T00:00:00.000Z"),
    });
    expect(options[0]?.tradeoffs.join(" ")).toContain("The price list is 365 days old");
  });

  it.each([
    ["standard uptime and <1k users", { uptime: "standard", expectedMonthlyUsers: "<1k" }, false],
    [
      "standard uptime and 1k-10k users",
      { uptime: "standard", expectedMonthlyUsers: "1k-10k" },
      false,
    ],
    ["high uptime", { uptime: "high", expectedMonthlyUsers: "<1k" }, true],
    ["10k-100k users", { uptime: "best-effort", expectedMonthlyUsers: "10k-100k" }, true],
    [">100k users", { uptime: "standard", expectedMonthlyUsers: ">100k" }, true],
  ] as const)(
    "offers Dedicated only for high uptime or 10k+ users (%s)",
    async (_label, req, expected) => {
      const options = await buildDesignOptions({
        facts: makeFacts(),
        requirements: makeRequirements({
          ...req,
          budgetMonthly: { amount: 1000, currency: "EUR" },
        }),
        catalog: euCatalog(),
      });
      const dedicated = options.filter((o) => o.target.cpuType === "dedicated");
      expect(dedicated.length).toBe(expected ? 1 : 0);
      if (expected) expect(dedicated[0]?.title.startsWith("Dedicated")).toBe(true);
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.length).toBeLessThanOrEqual(3);
    },
  );

  it("recommends Comfortable for high uptime when it fits, otherwise Lean", async () => {
    const high = await buildDesignOptions({
      facts: makeFacts(),
      requirements: makeRequirements({
        uptime: "high",
        budgetMonthly: { amount: 50, currency: "EUR" },
      }),
      catalog: euCatalog(),
    });
    expect(high.find((o) => o.recommended)?.title.startsWith("Comfortable")).toBe(true);

    const tight = await buildDesignOptions({
      facts: makeFacts(),
      requirements: makeRequirements({
        uptime: "high",
        budgetMonthly: { amount: 5, currency: "EUR" },
      }),
      catalog: euCatalog(),
    });
    expect(tight.find((o) => o.recommended)?.title.startsWith("Lean")).toBe(true);

    // A single qualifying server is still offered and recommended.
    const single = await buildDesignOptions({
      facts: makeFacts(),
      requirements: makeRequirements({ budgetMonthly: { amount: 9, currency: "EUR" } }),
      catalog: new MemoryCatalog([
        offer({ id: "a", vcpus: 1, memoryGb: 2, diskGb: 40, price: 9.5 }),
        offer({ id: "b", vcpus: 2, memoryGb: 4, diskGb: 40, price: 8.4 }),
      ]),
    });
    expect(single.map((o) => [o.title, o.recommended])).toEqual([["Lean: b in Nuremberg", true]]);
  });

  it("compares a USD budget at 1 EUR = 1.10 USD and says so", async () => {
    const fits = await buildDesignOptions({
      facts: staticSpaFacts(),
      // Lean costs €4.69 = $5.16.
      requirements: makeRequirements({ budgetMonthly: { amount: 5.2, currency: "USD" } }),
      catalog: euCatalog(),
    });
    expect(fits[0]).toMatchObject({ fitsBudget: true, recommended: true });
    expect(fits[0]?.tradeoffs.join(" ")).toContain("1 EUR = 1.10 USD");

    const over = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements({ budgetMonthly: { amount: 5.1, currency: "USD" } }),
      catalog: euCatalog(),
    });
    expect(over[0]?.fitsBudget).toBe(false);
    expect(over[0]?.tradeoffs.join(" ")).toContain(
      "Costs $5.16/month, above your budget of $5.10/month",
    );
  });

  it("produces the same options and ids every time", async () => {
    const input = () => ({
      facts: nextPostgresFacts(),
      requirements: makeRequirements({
        uptime: "high" as const,
        dataCriticality: "important" as const,
      }),
      catalog: euCatalog(),
    });
    const first = await buildDesignOptions(input());
    const second = await buildDesignOptions(input());
    expect(second).toEqual(first);
    expect(first.map((o) => o.id)).toEqual([
      "hetzner-single-cx33-nbg1",
      "hetzner-single-cx43-nbg1",
      "hetzner-single-ccx13-nbg1",
    ]);
  });

  it("explains what to do when no server in the region is big enough", async () => {
    const promise = buildDesignOptions({
      facts: nextPostgresFacts(),
      requirements: makeRequirements({ expectedMonthlyUsers: ">100k" }),
      catalog: new MemoryCatalog([
        offer({ id: "tiny", vcpus: 1, memoryGb: 1, diskGb: 20, price: 1 }),
      ]),
    });
    await expect(promise).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("Nuremberg or Falkenstein"),
      hint: expect.stringContaining("opscrew interview"),
    });
  });
});

describe("live prices with published rates (DigitalOcean)", () => {
  const TABLE_AS_OF = "2026-10-12T00:00:00.000Z";
  const LIVE_AS_OF = "2026-10-14T09:00:00.000Z";
  /** DigitalOcean's extras: the API has no backup or traffic rates, so they are the dated table's. */
  const published: ProviderExtras = {
    backupPercent: 30,
    trafficPerTb: { amount: 10.24, currency: "USD" },
    pricesIncludeVat: false,
    source: "static",
    asOf: TABLE_AS_OF,
  };
  const liveDroplet = (
    id: string,
    vcpus: number,
    memoryGb: number,
    diskGb: number,
    price: number,
  ) =>
    offer({
      id,
      vcpus,
      memoryGb,
      diskGb,
      price,
      provider: "digitalocean",
      location: "fra1",
      monthly: { amount: price, currency: "USD" },
      source: "live",
      asOf: LIVE_AS_OF,
    });
  const liveCatalog = () =>
    new MemoryCatalog(
      [liveDroplet("s-1vcpu-2gb", 1, 2, 50, 12), liveDroplet("s-2vcpu-4gb", 2, 4, 80, 24)],
      published,
      "digitalocean",
    );

  it("names the published rate and its date on the backup line and never labels it live", () => {
    const cost = costFor(liveDroplet("s-1vcpu-2gb", 1, 2, 50, 12), published, { backups: true });
    expect(cost.breakdown).toEqual([
      { item: "Server s-1vcpu-2gb (fra1)", monthly: { amount: 12, currency: "USD" } },
      {
        item: "Automated backups (30% of the server price, DigitalOcean's published rate as of 2026-10-12)",
        monthly: { amount: 3.6, currency: "USD" },
      },
    ]);
    // The total includes a number the API did not return, so it is not live.
    expect(cost).toMatchObject({ source: "static", asOf: TABLE_AS_OF });
    expect(CostEstimateSchema.safeParse(cost).success).toBe(true);
  });

  it("stays live when no published rate is used", () => {
    const cost = costFor(liveDroplet("s-1vcpu-2gb", 1, 2, 50, 12), published, { backups: false });
    expect(cost.breakdown.map((line) => line.item)).toEqual(["Server s-1vcpu-2gb (fra1)"]);
    expect(cost).toMatchObject({ source: "live", asOf: LIVE_AS_OF });
  });

  it("keeps the Droplet price live in the option and never asks for the token it already has", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements({ provider: "digitalocean", dataCriticality: "important" }),
      catalog: liveCatalog(),
      now: new Date(LIVE_AS_OF),
    });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.summary).toContain(
        "(live Droplet price, backups at DigitalOcean's published rate as of 2026-10-12, excluding tax)",
      );
      const tradeoffs = option.tradeoffs.join(" ");
      expect(tradeoffs).toContain(
        "The Droplet price is live from DigitalOcean; the backup price uses DigitalOcean's published rate as of 2026-10-12, because the API does not return it.",
      );
      expect(tradeoffs).not.toContain("DIGITALOCEAN_TOKEN");
      expect(tradeoffs).not.toContain("availability was not checked");
    }
  });

  it("warns when the published rate is old", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements({ provider: "digitalocean", dataCriticality: "important" }),
      catalog: liveCatalog(),
      now: new Date("2027-10-12T00:00:00.000Z"),
    });
    expect(options[0]?.tradeoffs.join(" ")).toContain(
      "The published rate is 365 days old; it may have changed.",
    );
  });

  it("labels the option live when backups are off", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements({ provider: "digitalocean", dataCriticality: "none" }),
      catalog: liveCatalog(),
    });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.cost.source).toBe("live");
      expect(option.summary).toContain("(live price, excluding tax)");
      expect(option.tradeoffs.join(" ")).not.toMatch(/DIGITALOCEAN_TOKEN|published/);
    }
  });
});

describe("live prices without a backup rate from the API", () => {
  const LIVE_AS_OF = "2026-10-14T09:00:00.000Z";
  /** Live extras whose `/pricing` answer had no backup percentage. */
  const liveExtras: ProviderExtras = {
    ipv4Monthly: { amount: 0.5, currency: "EUR" },
    pricesIncludeVat: false,
    source: "live",
    asOf: LIVE_AS_OF,
  };
  const liveServer = (id: string, vcpus: number, memoryGb: number, diskGb: number, price: number) =>
    offer({ id, vcpus, memoryGb, diskGb, price, source: "live", asOf: LIVE_AS_OF });

  it("never labels OpsCrew's fallback percentage live", () => {
    const cost = costFor(liveServer("cx23", 2, 4, 40, 5.49), liveExtras, {
      backups: true,
      backupPercent: 20,
    });
    expect(cost.breakdown.at(-1)).toEqual({
      item: "Automated backups (20% of the server price, OpsCrew's default rate, not from Hetzner's API)",
      monthly: { amount: 1.1, currency: "EUR" },
    });
    expect(cost).toMatchObject({ source: "static", asOf: LIVE_AS_OF });
    // The live IPv4 price keeps its plain line.
    expect(cost.breakdown[1]?.item).toBe("Primary IPv4 address");
    expect(CostEstimateSchema.safeParse(cost).success).toBe(true);
  });

  it("says so in the option without asking for the token it already has", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: makeRequirements({ dataCriticality: "important" }),
      catalog: new MemoryCatalog(
        [liveServer("cx23", 2, 4, 40, 5.49), liveServer("cx33", 4, 8, 80, 8.49)],
        liveExtras,
      ),
      now: new Date(LIVE_AS_OF),
    });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.cost.source).toBe("static");
      expect(option.summary).toContain(
        "(live server price, backups at OpsCrew's default rate, excluding VAT)",
      );
      const tradeoffs = option.tradeoffs.join(" ");
      expect(tradeoffs).toContain(
        "The server price is live from Hetzner; the backup price uses OpsCrew's default rate, because Hetzner's API did not return one.",
      );
      expect(tradeoffs).not.toContain("HCLOUD_TOKEN");
      expect(tradeoffs).not.toContain("days old");
    }
  });
});

describe("EXCHANGE_RATE_NOTE", () => {
  it("keeps the fixed approximate rate and says how to get an exact figure", () => {
    expect(EXCHANGE_RATE_NOTE).toBe(
      "Converted at a fixed approximate rate of 1 EUR = 1.10 USD. For an exact figure, look up today's rate, or ask your AI assistant to search the web for it and convert.",
    );
  });
});
