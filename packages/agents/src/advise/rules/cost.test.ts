import { STATIC_PRICES_AS_OF } from "@opscrew/connector-hetzner";
import type { Money } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { EXCHANGE_RATE_NOTE } from "../../design/cost";
import { makeRequirements, offer, ownPlan, portainerPlan, testPlan } from "../../testing";
import { sitePlan } from "../../testing/serverless";
import type { PriceList, Proposal } from "../types";
import {
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
    expect(why).toContain("$15.60");
    expect(why).toContain("€10.69");
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
    expect(why).toContain("[€23.89 against €15.00 a month]");
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
    expect(texts(budget)).toContain("[€14.18 against €10.00 a month]");
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
