import type { ComputeOffer, Money } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { STATIC_PRICES_AS_OF } from "@opscrew/provider-hetzner";
import { describe, expect, it } from "vitest";
import { EXCHANGE_RATE_NOTE } from "../../design/cost";
import { makeRequirements, offer, ownPlan, portainerPlan, testPlan } from "../../testing";
import { sitePlan } from "../../testing/serverless";
import type { PriceList, Proposal } from "../types";
import {
  contaboTable,
  digitaloceanTable,
  hetznerTable,
  history,
  ids,
  onThisComputer,
  reading,
  readingsOf,
  server,
  texts,
  validated,
  withDataServer,
  withServerType,
} from "./__fixtures__/rule-readings";
import { costRules } from "./cost";
import { sizeRules } from "./size";

/** The deployed example on Hetzner (cx23 in nbg1, backups on). */
const plan = testPlan({ deployed: true });
/** The same app on a cpx22: 2 vCPU, 4 GB and 80 GB like a cx33's disk, for more than a cx33. */
const cpx22 = withServerType(plan, "cpx22");

const costed = validated(costRules);

/** The cost proposals of `appPlan`'s quiet server with `budget`, at Hetzner's prices in nbg1. */
async function costApp(
  appPlan: DeployPlan,
  budget?: Money,
  prices?: PriceList[],
): Promise<Proposal[]> {
  return costed(
    readingsOf(appPlan, {
      servers: { app: server(reading()) },
      prices: prices ?? [await hetznerTable()],
      ...(budget === undefined
        ? {}
        : { requirements: makeRequirements({ budgetMonthly: budget }) }),
    }),
  );
}

describe("costRules: a cheaper type", () => {
  it("proposes the cheapest type with at least the same CPUs, memory and disk where it runs", async () => {
    const proposals = await costApp(cpx22);
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "cost.app.cheaper-type",
        category: "cost",
        urgency: "when-convenient",
        server: "app",
        title: "Move server app to cx33 (4 vCPU, 8 GB memory, 80 GB disk)",
        // cpx22 and cx33 with the IPv4 address and 20% for backups, from the static table.
        price: {
          before: 23.89,
          after: 10.69,
          currency: "EUR",
          source: "static",
          asOf: STATIC_PRICES_AS_OF,
        },
        apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
      }),
    ]);
    const why = texts(proposals[0]);
    expect(why).toContain("cx33 has at least the CPUs, memory and disk of cpx22, for less []");
    expect(why).toContain("The disk stays 80 GB");
    expect(why).toContain("offline one to three minutes");
  });

  it("prices from a live catalogue as live", async () => {
    const [cheaper] = await costApp(cpx22, undefined, [await hetznerTable("nbg1", "live")]);
    expect(cheaper?.price).toEqual({
      before: 23.89,
      after: 10.69,
      currency: "EUR",
      source: "live",
    });
  });

  it("proposes nothing for the cheapest type, nor for one at the same price", async () => {
    expect(await costApp(plan)).toEqual([]);
    const line: PriceList = {
      provider: "hetzner",
      location: "nbg1",
      offers: [
        offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49 }),
        offer({ id: "twin", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49 }),
        offer({ id: "less", vcpus: 2, memoryGb: 2, diskGb: 40, price: 3 }),
      ],
      extras: { pricesIncludeVat: false, source: "static", asOf: "2026-09-01T00:00:00.000Z" },
    };
    expect(await costApp(plan, undefined, [line])).toEqual([]);
  });

  it("leaves a server the size rules move to another type to them", async () => {
    const prices = [await hetznerTable()];
    const readings = readingsOf(cpx22, {
      servers: { app: server(reading(), history({ memoryP95: 0.9 })) },
      prices,
    });
    // The larger type is cx33 too, and costs less than the cpx22.
    expect(sizeRules(readings)).toEqual([
      expect.objectContaining({
        id: "size.app.larger",
        price: expect.objectContaining({ after: 10.69 }),
      }),
    ]);
    expect(costed(readings)).toEqual([]);
  });

  it("prices an extra server at its own location", async () => {
    const twoServers = withDataServer(plan, "cpx22");
    const prices = [await hetznerTable()];
    const servers = { app: server(reading()), data: server(reading()) };
    expect(ids(costed(readingsOf(twoServers, { servers: servers, prices })))).toEqual([
      "cost.data.cheaper-type",
    ]);
  });
});

describe("costRules: the other provider", () => {
  const eu = makeRequirements({
    provider: "digitalocean",
    region: "eu-central",
    budgetMonthly: { amount: 50, currency: "USD" },
  });
  const droplet = testPlan({ deployed: true, provider: "digitalocean" });
  const prices = async () => [
    await digitaloceanTable("fra1"),
    await digitaloceanTable("ams3"),
    await hetznerTable("nbg1"),
    await hetznerTable("fsn1"),
  ];

  it("names `opscrew retarget` when the same server costs less at the other provider", async () => {
    const readings = readingsOf(droplet, {
      servers: { app: server(reading({ cpus: 1 })) },
      prices: await prices(),
      requirements: eu,
    });
    const proposals = costed(readings);
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "cost.app.other-provider",
        category: "cost",
        urgency: "when-convenient",
        server: "app",
        title: "Move the app to Hetzner: cx33 (4 vCPU, 8 GB memory, 80 GB disk) in Nuremberg",
        // $12 with 30% for backups, against €10.69 at 1.10 USD a euro.
        price: {
          before: 15.6,
          after: 11.76,
          currency: "USD",
          source: "static",
          asOf: "2026-10-12T00:00:00.000Z",
        },
        apply: { kind: "command", command: "opscrew retarget --to hetzner" },
      }),
    ]);
    const why = texts(proposals[0]);
    expect(why).toContain(
      "A server with at least the vCPUs, memory and disk of s-1vcpu-2gb costs less at Hetzner: cx33 there against s-1vcpu-2gb at DigitalOcean [€10.69 (excl. VAT, estimate as of 2026-10-14) against $15.60 (excl. tax, estimate as of 2026-10-12) a month]",
    );
    // Both providers' prices exclude VAT, both offer backups and neither has terms.
    expect(why).not.toMatch(
      /includes VAT|automatic backups|contract runs|in place|--finish` cancels/,
    );
    expect(why).toContain(`${EXCHANGE_RATE_NOTE.slice(0, -1)} []`);
    expect(why).toContain("maintenance window");
  });

  it("proposes no move when the other provider costs more", async () => {
    const readings = readingsOf(plan, {
      servers: { app: server(reading()) },
      prices: await prices(),
      requirements: makeRequirements(),
    });
    expect(costed(readings)).toEqual([]);
  });

  it("proposes no move for an app on several servers, or without a region", async () => {
    const several = readingsOf(withDataServer(droplet), {
      servers: { app: server(reading({ cpus: 1 })) },
      prices: await prices(),
      requirements: eu,
    });
    expect(ids(costed(several))).not.toContain("cost.app.other-provider");
    const noRegion = readingsOf(droplet, {
      servers: { app: server(reading({ cpus: 1 })) },
      prices: await prices(),
    });
    expect(costed(noRegion)).toEqual([]);
  });

  it("adds the app's and the environment's flags to every command", async () => {
    const flags = " --app shop --env staging";
    const moving = costed(
      readingsOf(droplet, {
        servers: { app: server(reading({ cpus: 1 })) },
        prices: await prices(),
        requirements: eu,
        flags,
      }),
    );
    expect(moving[0]?.apply).toEqual({
      kind: "command",
      command: "opscrew retarget --to hetzner --app shop --env staging",
    });
    expect(texts(moving[0])).toContain("`opscrew retarget --to hetzner --app shop --env staging`");

    const hetzner = await hetznerTable();
    const budget = (appPlan: DeployPlan, amount: number) =>
      readingsOf(appPlan, {
        servers: { app: server(reading()) },
        prices: [hetzner],
        requirements: makeRequirements({ budgetMonthly: { amount, currency: "EUR" } }),
        flags,
      });
    expect(costed(budget(cpx22, 15))[0]?.apply).toEqual({
      kind: "command",
      command: "opscrew advise --apply cost.app.cheaper-type --app shop --env staging",
    });
    const [none] = costed(budget(plan, 5));
    expect(none?.apply).toEqual({
      kind: "command",
      command: "opscrew design --app shop --env staging",
    });
    expect(texts(none)).toContain("`opscrew design --app shop --env staging`");
  });
});

describe("costRules: the other provider on the same basis (Contabo)", () => {
  const important = makeRequirements({ dataCriticality: "important" });
  /** Contabo's Auto Backup has no price per plan (R15): both sides go without backups. */
  const BOTH_LEFT_OUT =
    "Both prices leave out the automated backups: Contabo publishes no price per plan for its own, only on its order page";
  const CONTABO_AS_OF = "2026-11-11T00:00:00.000Z";

  /** Contabo's prices in its EU region: `offers` (VAT included, as its price list has them). */
  function contaboList(...offers: ComputeOffer[]): PriceList {
    return {
      provider: "contabo",
      location: "EU",
      offers,
      extras: {
        snapshotsIncluded: true,
        pricesIncludeVat: true,
        source: "static",
        asOf: CONTABO_AS_OF,
      },
    };
  }

  /** A Contabo plan in its EU region. */
  function vps(init: Parameters<typeof offer>[0]): ComputeOffer {
    return offer({
      provider: "contabo",
      location: "EU",
      pricesIncludeVat: true,
      asOf: CONTABO_AS_OF,
      includedSnapshots: 1,
      ...init,
    });
  }

  /** The cost proposals of `appPlan`'s quiet server against `prices`, with `requirements`. */
  async function moveOf(appPlan: DeployPlan, prices: PriceList[], requirements = important) {
    const proposals = costed(
      readingsOf(appPlan, { servers: { app: server(reading()) }, prices, requirements }),
    );
    return proposals.find((p) => p.id === "cost.app.other-provider");
  }

  it("compares a Hetzner server without its backups, as Contabo prices its own only on its order page, naming each side", async () => {
    const move = await moveOf(cpx22, [await hetznerTable(), await contaboTable()]);
    expect(move).toMatchObject({
      title: "Move the app to Contabo: V153 (4 vCPU, 8 GB memory, 100 GB disk) in Germany",
      // cpx22 with its IPv4 address and without its 20% for backups, against Contabo's price
      // without its Auto Backup, both without VAT.
      price: {
        before: 19.99,
        after: 5.5,
        currency: "EUR",
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      },
      apply: { kind: "command", command: "opscrew retarget --to contabo" },
    });
    const why = texts(move);
    expect(why).toContain(
      "A server with at least the vCPUs, memory and disk of cpx22 costs less at Contabo: V153 there against cpx22 at Hetzner [€5.50 (excl. VAT, estimate as of 2026-11-11) against €19.99 (excl. VAT, estimate as of 2026-10-14) a month]",
    );
    expect(move?.price).not.toHaveProperty("includesVat");
    expect(why).not.toContain("same server");
    expect(why).not.toContain("includes VAT");
    expect(why).toContain(BOTH_LEFT_OUT);
    expect(why).not.toContain("offers no automatic backups");
    expect(move?.price?.after).not.toBe(0);
    expect(why).toContain(
      "The contract runs at least 1 month; a removal ends it at the end of the term",
    );
    expect(why).toContain("Contabo can't change a server's size in place");
    expect(why).toContain("Whole-server snapshots are included in the price, up to 1");
    expect(why).toContain("`--finish` deletes the old server");
    // Cloud VPS 4's €2.00 setup fee against a saving of €14.49 a month.
    expect(why).toContain("The saving covers the setup fee in 1 month");
  });

  it("counts a move's saving toward the budget from the server's whole price, backups included", async () => {
    const readings = readingsOf(cpx22, {
      servers: { app: server(reading()) },
      prices: [await hetznerTable(), await contaboTable()],
      requirements: makeRequirements({
        dataCriticality: "important",
        budgetMonthly: { amount: 8, currency: "EUR" },
      }),
    });
    const [budget] = costed(readings);
    // €23.89 with backups less €18.39 is Contabo's €5.50; the cx33's €10.69 stays above €8.
    expect(budget).toMatchObject({
      id: "cost.env.budget",
      price: {
        before: 23.89,
        after: 5.5,
        currency: "EUR",
      },
      apply: { kind: "command", command: "opscrew advise --apply cost.app.other-provider" },
    });
    const why = texts(budget);
    expect(why).toContain("[€23.89 (excl. VAT) against €8.00 a month]");
    expect(why).toContain("brings them under it: cost.app.other-provider (saves €18.39)");
  });

  it("proposes no move that saves less than 10% of the server's price", async () => {
    // €5.50 against the cx23's €5.99 without backups: €0.49, about 8%.
    expect(await moveOf(plan, [await hetznerTable(), await contaboTable()])).toBeUndefined();
    const at = (price: number) => vps({ id: "V-edge", vcpus: 2, memoryGb: 4, diskGb: 40, price });
    // €0.60 is 10% of €5.99 and more; €0.59 is less.
    expect(await moveOf(plan, [await hetznerTable(), contaboList(at(5.39))])).toBeDefined();
    expect(await moveOf(plan, [await hetznerTable(), contaboList(at(5.4))])).toBeUndefined();
  });

  /** Hetzner's cx23 at €6.50 with its IPv4 address: €7.00 a month without backups. */
  const sevenEuros: PriceList = {
    provider: "hetzner",
    location: "nbg1",
    offers: [offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 6.5 })],
    extras: {
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    },
  };

  it("compares the edges in whole cents", async () => {
    // €0.70 on €7.00 is exactly 10%, which 0.7 >= 7 * 0.1 would miss.
    const at = vps({ id: "V-cent", vcpus: 2, memoryGb: 4, diskGb: 40, price: 6.3 });
    expect(await moveOf(plan, [sevenEuros, contaboList(at)])).toBeDefined();
    // A €2.10 fee is exactly 3 months of €0.70.
    const fee = { ...at, setupFee: { amount: 2.1, currency: "EUR" as const } };
    const move = await moveOf(plan, [sevenEuros, contaboList(fee)]);
    expect(texts(move)).toContain("The saving covers the setup fee in 3 months []");
  });

  it("proposes no move that only the left-out backups paid for", async () => {
    // €6.50 is below the cx23's €7.09 with backups, but not its €5.99 without them.
    const dear = vps({ id: "V-dear", vcpus: 2, memoryGb: 4, diskGb: 40, price: 6.5 });
    expect(await moveOf(plan, [await hetznerTable(), contaboList(dear)])).toBeUndefined();
  });

  it("names the setup fee once, with the months until the saving covers it, within 3 months", async () => {
    // €4.99 against €5.99: €1.00 saved a month.
    const fee = (amount: number) => ({
      ...vps({ id: "V-fee", vcpus: 2, memoryGb: 4, diskGb: 40, price: 4.99 }),
      setupFee: { amount, currency: "EUR" as const },
    });
    const move = await moveOf(plan, [await hetznerTable(), contaboList(fee(3))]);
    const why = texts(move);
    expect(why).toContain(
      "Plus a one-time setup fee of €3.00 (incl. VAT) when the server is created, not part of the monthly price []",
    );
    expect(why).toContain("The saving covers the setup fee in 3 months []");
    expect(why.match(/one-time setup fee/g)).toHaveLength(1);
    expect(await moveOf(plan, [await hetznerTable(), contaboList(fee(3.01))])).toBeUndefined();
  });

  it("says Contabo's backups are not in the total over the budget, never counting them at €0", async () => {
    const readings = readingsOf(testPlan({ deployed: true, provider: "contabo", backups: true }), {
      servers: { app: server(reading()) },
      prices: [await contaboTable()],
      requirements: makeRequirements({
        dataCriticality: "important",
        budgetMonthly: { amount: 4, currency: "EUR" },
      }),
    });
    const budget = costed(readings).find((p) => p.id === "cost.env.budget");
    const why = texts(budget);
    expect(why).toContain("[€5.50 (excl. VAT) against €4.00 a month]");
    expect(why).toContain(
      "Contabo's automated backups are not in this total: they are priced on Contabo's order page",
    );
  });

  describe("from Contabo", () => {
    // Auto Backup off, as the tests about VAT and terms aren't about it.
    const contabo = testPlan({ deployed: true, provider: "contabo", backups: false });
    /** A Contabo plan of a cx33's size, at `price` with VAT. */
    const plan33 = (price: number) => vps({ id: "V-33", vcpus: 4, memoryGb: 8, diskGb: 80, price });
    const fromContabo = async (price: number, requirements = important, backups = false) =>
      moveOf(
        { ...contabo, target: { ...contabo.target, serverType: "V-33", backups } } as DeployPlan,
        [contaboList(plan33(price)), await hetznerTable("nbg1"), await hetznerTable("fsn1")],
        requirements,
      );

    it("leaves the backups out of both sides when Contabo's are on, and names the term before the saving", async () => {
      const move = await fromContabo(20, important, true);
      expect(move).toMatchObject({
        title: "Move the app to Hetzner: cx33 (4 vCPU, 8 GB memory, 80 GB disk) in Nuremberg",
        // cx33 with its IPv4 address, without its backups, as Contabo's have no price to compare.
        price: {
          before: 20,
          after: 8.99,
          currency: "EUR",
          includesVat: { before: true, after: false },
        },
        apply: { kind: "command", command: "opscrew retarget --to hetzner" },
      });
      const why = texts(move);
      expect(why).toContain(
        "Contabo's price includes VAT and Hetzner's doesn't: the saving holds even with 27% VAT on Hetzner's, the highest rate in the EU",
      );
      expect(why).toContain(BOTH_LEFT_OUT);
      expect(why).not.toContain("priced in");
      expect(why).toContain(
        "Contabo bills the old server to the end of its term, so the saving starts after it",
      );
      expect(why).toContain("`--finish` cancels the old server at the end of its term");
      expect(why).not.toContain("deletes the old server");
      expect(why).not.toContain("The contract runs at least");
      expect(why).toContain(
        "Contabo's price includes up to 1 whole-server snapshot; Hetzner charges for its own []",
      );
    });

    it("prices the new server without backups, and says nothing of them, when Contabo's are off", async () => {
      const move = await fromContabo(20);
      expect(move?.price).toMatchObject({ before: 20, after: 8.99 });
      expect(texts(move)).not.toContain("automated backups");
    });

    it("prices the new server without backups outside prod, whatever the data (T2750)", async () => {
      const staging = {
        ...contabo,
        app: { ...contabo.app, name: "shop-staging" },
        environment: { name: "staging" },
        target: { ...contabo.target, serverType: "V-33" },
      } as DeployPlan;
      const move = await moveOf(
        staging,
        [contaboList(plan33(20)), await hetznerTable("nbg1"), await hetznerTable("fsn1")],
        makeRequirements({ dataCriticality: "critical" }),
      );
      expect(move?.price).toMatchObject({ before: 20, after: 8.99 });
      expect(texts(move)).not.toContain("automated backups");
    });

    it("counts toward the budget only the saving that holds whatever VAT you pay", async () => {
      const budgetOf = async (amount: number) => {
        const readings = readingsOf(
          { ...contabo, target: { ...contabo.target, serverType: "V-33" } } as DeployPlan,
          {
            servers: { app: server(reading()) },
            prices: [contaboList(plan33(20)), await hetznerTable("nbg1")],
            requirements: makeRequirements({ budgetMonthly: { amount, currency: "EUR" } }),
          },
        );
        return costed(readings).find((p) => p.id === "cost.env.budget");
      };
      // €20 against Hetzner's €8.99, €11.42 with 27% VAT: €8.58 saved whatever VAT you pay.
      const budget = await budgetOf(12);
      expect(budget?.price).toMatchObject({
        before: 20,
        after: 11.42,
        includesVat: { before: true, after: true },
      });
      const why = texts(budget);
      expect(why).toContain("[€20.00 (incl. VAT) against €12.00 a month]");
      expect(why).toContain("cost.app.other-provider (saves €8.58)");
      // €20 less €8.99 would be under €11, but not €20 less €8.58.
      expect(texts(await budgetOf(11))).toContain(
        "None of the other proposals brings them under it",
      );
    });

    it("proposes no move when VAT could explain the gap", async () => {
      // €8.99 is 18% below €11 without VAT, but €11.42 with 27% VAT on it.
      expect(await fromContabo(11, makeRequirements())).toBeUndefined();
      // €13 less €11.42 is €1.58, more than 10% of €13.
      expect(await fromContabo(13, makeRequirements())).toBeDefined();
    });
  });
});

describe("costRules: the budget", () => {
  it("says by how much the servers pass the budget, and which proposal brings them under", async () => {
    const proposals = await costApp(cpx22, { amount: 15, currency: "EUR" });
    expect(ids(proposals)).toEqual(["cost.env.budget", "cost.app.cheaper-type"]);
    const [budget] = proposals;
    expect(budget).toMatchObject({
      category: "cost",
      urgency: "soon",
      title: "The servers cost €8.89 a month above your budget",
      price: {
        before: 23.89,
        after: 10.69,
        currency: "EUR",
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      },
      apply: { kind: "command", command: "opscrew advise --apply cost.app.cheaper-type" },
    });
    expect(budget?.server).toBeUndefined();
    const why = texts(budget);
    expect(why).toContain("[€23.89 (excl. VAT) against €15.00 a month]");
    expect(why).toContain("cost.app.cheaper-type (saves €13.20)");
  });

  it("is over only above the budget", async () => {
    expect(ids(await costApp(cpx22, { amount: 23.89, currency: "EUR" }))).toEqual([
      "cost.app.cheaper-type",
    ]);
    expect(ids(await costApp(cpx22, { amount: 23.88, currency: "EUR" }))[0]).toBe(
      "cost.env.budget",
    );
  });

  it("points to design, or a higher budget, when no proposal brings it under", async () => {
    const [budget] = await costApp(plan, { amount: 5, currency: "EUR" });
    expect(budget).toMatchObject({
      id: "cost.env.budget",
      apply: { kind: "command", command: "opscrew design" },
    });
    expect(budget?.price).toBeUndefined();
    expect(texts(budget)).toContain("or raise the budget you gave in the interview");
  });

  it("compares a budget in another currency at the fixed rate, saying so", async () => {
    const [budget] = await costApp(cpx22, { amount: 20, currency: "USD" });
    expect(budget).toMatchObject({
      id: "cost.env.budget",
      price: { before: 26.28, after: 11.76, currency: "USD" },
    });
    expect(texts(budget)).toContain(`${EXCHANGE_RATE_NOTE.slice(0, -1)} []`);
  });

  it("adds up every server OpsCrew created", async () => {
    const twoServers = withDataServer(plan);
    const readings = readingsOf(twoServers, {
      servers: { app: server(reading()), data: server(reading()) },
      prices: [await hetznerTable()],
      requirements: makeRequirements({ budgetMonthly: { amount: 10, currency: "EUR" } }),
    });
    const [budget] = costed(readings);
    expect(budget).toMatchObject({ id: "cost.env.budget" });
    expect(texts(budget)).toContain("[€14.18 (excl. VAT) against €10.00 a month]");
  });
});

describe("costRules: targets", () => {
  const tight = makeRequirements({ budgetMonthly: { amount: 1, currency: "EUR" } });

  it("proposes no price for a server the user owns, a Portainer or a site", async () => {
    const prices = [await hetznerTable()];
    const targets = [
      ownPlan({ deployed: true }),
      portainerPlan(),
      onThisComputer(plan),
      sitePlan(),
    ];
    for (const target of targets) {
      const readings = readingsOf(target, {
        servers: { app: server(reading()) },
        prices,
        requirements: tight,
      });
      expect(costed(readings)).toEqual([]);
    }
  });

  it("puts no server address in a proposal", async () => {
    const proposals = await costApp(cpx22, { amount: 15, currency: "EUR" });
    expect(proposals.length).toBeGreaterThan(0);
    expect(JSON.stringify(proposals)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b|203\.0\.113|2001:db8/);
  });
});
