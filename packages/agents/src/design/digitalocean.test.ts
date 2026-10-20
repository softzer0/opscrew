import { DesignOptionListSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  autoBuild,
  digitaloceanCatalog,
  doEuCatalog,
  doOffer,
  euCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
} from "../testing";
import { buildDesignOptions } from "./options";
import { optionToPlan } from "./plan";
import { regionLocations } from "./sizing";

const doRequirements = (overrides: Parameters<typeof makeRequirements>[0] = {}) =>
  makeRequirements({ provider: "digitalocean", ...overrides });

describe("regionLocations for DigitalOcean", () => {
  it("maps regions to Droplet regions from the provider profile", () => {
    expect(regionLocations("eu-central", "digitalocean")).toEqual(["fra1", "ams3"]);
    expect(regionLocations("eu-north", "digitalocean")).toEqual(["ams3"]);
    expect(regionLocations("us-east", "digitalocean")).toEqual(["nyc3", "nyc1", "atl1"]);
    // Hetzner stays the default.
    expect(regionLocations("eu-north")).toEqual(["hel1"]);
  });
});

describe("buildDesignOptions on DigitalOcean", () => {
  it("US1-2: offers Droplet sizes in Frankfurt or Amsterdam priced in USD with 30 % daily backups", async () => {
    const catalog = doEuCatalog();
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: doRequirements({
        dataCriticality: "important",
        budgetMonthly: { amount: 20, currency: "EUR" },
      }),
      catalog,
    });
    expect(DesignOptionListSchema.safeParse(options).success).toBe(true);
    expect(catalog.requested).toEqual(["fra1", "ams3"]);
    expect(options.map((o) => o.id)).toEqual([
      "digitalocean-single-s-1vcpu-2gb-fra1",
      "digitalocean-single-s-2vcpu-4gb-fra1",
    ]);

    const [lean] = options;
    expect(lean?.target).toMatchObject({
      provider: "digitalocean",
      location: "fra1",
      serverType: "s-1vcpu-2gb",
      cpuType: "shared",
    });
    expect(lean?.title).toBe("Lean: s-1vcpu-2gb in Frankfurt on DigitalOcean");
    expect(lean?.summary).toContain("One s-1vcpu-2gb DigitalOcean Droplet");
    expect(lean?.summary).toContain("in Frankfurt (fra1)");
    expect(lean?.summary).toContain("$15.60/month");
    // DigitalOcean's USD prices exclude sales tax; "VAT" stays for Hetzner's EUR prices.
    expect(lean?.summary).toContain("excluding tax)");
    expect(lean?.summary).not.toContain("VAT");
    // IPv4 is included in the Droplet price, so it has no line of its own.
    expect(lean?.cost.breakdown).toEqual([
      { item: "Server s-1vcpu-2gb (fra1)", monthly: { amount: 12, currency: "USD" } },
      {
        item: "Automated backups (30% of the server price)",
        monthly: { amount: 3.6, currency: "USD" },
      },
    ]);
    expect(lean?.cost.monthly).toEqual({ amount: 15.6, currency: "USD" });

    // The EUR budget is compared at the fixed rate, and the option says the conversion is approximate.
    expect(lean).toMatchObject({ fitsBudget: true, recommended: true });
    const tradeoffs = lean?.tradeoffs.join(" ") ?? "";
    expect(tradeoffs).toContain("About €14.18/month in your budget currency.");
    expect(tradeoffs).toContain("fixed approximate rate of 1 EUR = 1.10 USD");
    expect(tradeoffs).toContain("DigitalOcean's published price list");
    expect(tradeoffs).toContain("set DIGITALOCEAN_TOKEN for live prices");
    expect(tradeoffs).not.toContain("HCLOUD_TOKEN");
    expect(tradeoffs).not.toContain("Hetzner");
  });

  it("says when a converted EUR budget is exceeded", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: doRequirements({ budgetMonthly: { amount: 10, currency: "EUR" } }),
      catalog: doEuCatalog(),
    });
    // $12.00 = €10.91.
    expect(options[0]?.fitsBudget).toBe(false);
    expect(options[0]?.tradeoffs.join(" ")).toContain(
      "Costs €10.91/month, above your budget of €10.00/month. Converted at a fixed approximate rate",
    );
  });

  it("compares a USD budget directly", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: doRequirements({ budgetMonthly: { amount: 12, currency: "USD" } }),
      catalog: doEuCatalog(),
    });
    expect(options[0]).toMatchObject({ fitsBudget: true, recommended: true });
    expect(options[0]?.tradeoffs.join(" ")).not.toContain("1 EUR = 1.10 USD");
  });

  it("uses Amsterdam for eu-north and says why", async () => {
    const catalog = doEuCatalog();
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: doRequirements({ region: "eu-north" }),
      catalog,
    });
    expect(catalog.requested).toEqual(["ams3"]);
    expect(options.every((o) => o.target.location === "ams3")).toBe(true);
    expect(options[0]?.title).toBe("Lean: s-1vcpu-2gb in Amsterdam on DigitalOcean");
    for (const option of options) {
      expect(option.tradeoffs.join(" ")).toContain(
        "DigitalOcean has no data centre in northern Europe, so OpsCrew uses Amsterdam",
      );
    }
  });

  it("offers a CPU-Optimized size as Dedicated for high uptime", async () => {
    const options = await buildDesignOptions({
      facts: makeFacts(),
      requirements: doRequirements({
        uptime: "high",
        budgetMonthly: { amount: 1000, currency: "USD" },
      }),
      catalog: doEuCatalog(),
    });
    const dedicated = options.filter((o) => o.target.cpuType === "dedicated");
    // c-2 has too little disk; c-4 is the cheapest dedicated size that fits.
    expect(dedicated.map((o) => o.id)).toEqual(["digitalocean-single-c-4-fra1"]);
    expect(dedicated[0]?.title.startsWith("Dedicated")).toBe(true);
  });

  it("falls back to the profile's 30 % when the catalogue gives no backup percentage", async () => {
    const options = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: doRequirements({ dataCriticality: "important" }),
      catalog: digitaloceanCatalog(
        [doOffer({ id: "s-1vcpu-2gb", vcpus: 1, memoryGb: 2, diskGb: 50, price: 12 })],
        { pricesIncludeVat: false },
      ),
    });
    expect(options[0]?.cost.breakdown.at(-1)).toEqual({
      item: "Automated backups (30% of the server price)",
      monthly: { amount: 3.6, currency: "USD" },
    });
  });

  it("names DigitalOcean Droplets when no size fits", async () => {
    const error = await buildDesignOptions({
      facts: nextPostgresFacts(),
      requirements: doRequirements({ expectedMonthlyUsers: ">100k" }),
      catalog: doEuCatalog(),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(
        "No available x86 DigitalOcean Droplet in Frankfurt or Amsterdam",
      ),
    });
  });

  it("refuses a catalogue of another provider", async () => {
    await expect(
      buildDesignOptions({
        facts: staticSpaFacts(),
        requirements: doRequirements(),
        catalog: euCatalog(),
      }),
    ).rejects.toThrow(/digitalocean catalogue but got the hetzner one/);
  });
});

describe("optionToPlan on DigitalOcean", () => {
  it("records the provider and the DigitalOcean Ubuntu image", async () => {
    const [option] = await buildDesignOptions({
      facts: staticSpaFacts(),
      requirements: doRequirements(),
      catalog: doEuCatalog(),
    });
    if (option === undefined) throw new Error("no option");
    const plan = optionToPlan(option, {
      facts: staticSpaFacts(),
      requirements: doRequirements(),
      now: new Date("2026-10-12T10:00:00.000Z"),
      codeChanges: [],
      build: autoBuild(staticSpaFacts()),
    });
    expect(plan.target).toEqual({
      provider: "digitalocean",
      mode: "vps-compose",
      location: "fra1",
      serverType: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      backups: false,
      edge: "caddy",
    });
    expect(plan.cost.monthly).toEqual({ amount: 12, currency: "USD" });
  });
});
