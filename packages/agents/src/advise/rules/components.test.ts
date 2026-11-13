import { ADDON_MEMORY_DEFAULTS, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { storagePrice } from "../../design/storage";
import { MONITORING_VERSIONS } from "../../monitoring/settings";
import { networked, splitPlan } from "../../network/__fixtures__/plans";
import { makeRequirements, ownPlan, testPlan } from "../../testing";
import { pagesTestPlan } from "../../testing/pages";
import { sitePlan } from "../../testing/serverless";
import { type Readings, type ServerReadings, THRESHOLDS } from "../types";
import { AT, GB, history, MB, reading, readingsOf, validated } from "./__fixtures__/rule-readings";
import { componentRules } from "./components";

const rules = validated(componentRules);

/** The app's server (4 GB) at `memory` (p95), Postgres's container at `postgresGb` (p95). */
function shortServer(memory: number, postgresGb: number): Record<string, ServerReadings> {
  return {
    app: {
      now: reading(),
      history: history({
        memoryP95: memory,
        containers: [
          { service: "app", memoryP95: 900 * MB },
          { service: "db", memoryP95: postgresGb * GB },
        ],
      }),
    },
  };
}

describe("componentRules: Postgres on its own server", () => {
  it(`proposes it above ${THRESHOLDS.databaseShare * 100}% of a short server's memory, priced`, () => {
    const readings = readingsOf(testPlan(), {
      servers: shortServer(0.9, 2.1),
      flags: " --env staging",
    });
    expect(rules(readings)).toEqual([
      {
        id: "components.app.database-server",
        category: "components",
        urgency: "when-convenient",
        server: "app",
        title: "Give Postgres (db) a server of its own, a cx23",
        reasons: [
          {
            text: "Postgres (db) takes over 50% of server app's memory at the 95th percentile",
            figure: "52.5% of 4.0 GB",
            basis: { kind: "history", days: 14 },
          },
          {
            text: "A server of its own for Postgres is the other way to a larger one: server app's memory in use at the 95th percentile is above 85%",
            figure: "90% of 4.0 GB",
            basis: { kind: "history", days: 14 },
          },
          {
            text: "Provision copies its data to the new server; the app is offline about 2 minutes, plus a minute for every 100 MB",
            basis: { kind: "plan" },
          },
        ],
        // Each cx23: €5.49 + IPv4 €0.50 + backups €1.10. Live prices carry no date.
        price: { before: 7.09, after: 14.18, currency: "EUR", source: "live" },
        apply: {
          kind: "manual",
          text: "Add a server db (servers in opscrew/plan.yaml) and set server: db on the Postgres service, then run `opscrew design --env staging` and `opscrew provision --env staging`",
        },
      },
    ]);
  });

  it("proposes nothing at exactly the share, at exactly 85% of memory, or without history", () => {
    const at = (memory: number, postgresGb: number) =>
      rules(readingsOf(testPlan(), { servers: shortServer(memory, postgresGb) }));
    expect(at(0.9, 4 * THRESHOLDS.databaseShare)).toEqual([]);
    expect(at(THRESHOLDS.memoryHigh, 3)).toEqual([]);
    expect(at(0.86, 2.1)).toHaveLength(1);
    // Just above both thresholds, the figures never read at them.
    const [edge] = at(0.8501, 4 * 0.501);
    expect(edge?.reasons.map((r) => r.figure)).toEqual([
      "50.1% of 4.0 GB",
      "85.1% of 4.0 GB",
      undefined,
    ]);
    const once = { app: { now: reading({ memory: 0.95 }) } };
    expect(rules(readingsOf(testPlan(), { servers: once }))).toEqual([]);
  });

  it("sizes the server as design does: Grafana Alloy's containers on it push it to a cx33", () => {
    // Postgres at 3500 MB: with the system's 384 MB it fits a 4 GB cx23; Alloy's 288 MB doesn't.
    const base = testPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      services: base.services.map((s) =>
        s.kind === "postgres" ? { ...s, name: "primary-database", memoryMb: 3500 } : s,
      ),
      observability: {
        monitoring: {
          enabled: true,
          versions: MONITORING_VERSIONS,
          retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 },
          memoryMb: { ...ADDON_MEMORY_DEFAULTS.monitoring },
          where: { kind: "app" },
        },
      },
    });
    const servers = {
      app: {
        now: reading(),
        history: history({
          memoryP95: 0.9,
          containers: [{ service: "primary-database", memoryP95: 2.5 * GB }],
        }),
      },
    };
    const [proposal] = rules(readingsOf(plan, { servers }));
    expect(proposal?.title).toBe("Give Postgres (primary-database) a server of its own, a cx33");
    // cx23 €7.09 with backups; cx33 €8.49 + €0.50 + backups €1.70.
    expect(proposal?.price).toMatchObject({ before: 7.09, after: 17.78 });
    expect(proposal?.apply).toMatchObject({
      text: expect.stringContaining(
        "Add a server db (servers in opscrew/plan.yaml) and set server: db",
      ),
    });
    const without = { ...plan, observability: {} };
    const [smaller] = rules(readingsOf(without, { servers }));
    expect(smaller?.title).toBe("Give Postgres (primary-database) a server of its own, a cx23");
  });

  it("prices the new server without backups when the interview says the data doesn't matter", () => {
    const requirements = makeRequirements({ dataCriticality: "none" });
    const [proposal] = rules(
      readingsOf(testPlan(), { servers: shortServer(0.9, 2.1), requirements }),
    );
    // The app's cx23 keeps its backups (€7.09); the new cx23 is €5.99.
    expect(proposal?.price).toMatchObject({ before: 7.09, after: 13.08 });
  });

  it("prices the new server without backups outside prod, whatever the data (T2750)", () => {
    const base = testPlan();
    const staging = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, name: "shop-staging" },
      environment: { name: "staging" },
    });
    const requirements = makeRequirements({ dataCriticality: "critical" });
    const [proposal] = rules(readingsOf(staging, { servers: shortServer(0.9, 2.1), requirements }));
    // The app's cx23 keeps the backups its plan has (€7.09); the new cx23 is €5.99.
    expect(proposal?.price).toMatchObject({ before: 7.09, after: 13.08 });
  });

  it("proposes it without a price when the catalogue has none", () => {
    const [proposal] = rules(
      readingsOf(testPlan(), { servers: shortServer(0.9, 2.1), prices: [] }),
    );
    expect(proposal?.title).toBe("Give Postgres (db) a server of its own");
    expect(proposal?.price).toBeUndefined();
  });

  it("proposes nothing for Postgres already elsewhere or on the user's own server", () => {
    const { plan: split } = networked(splitPlan());
    expect(rules(readingsOf(split, { servers: shortServer(0.9, 3) }))).toEqual([]);
    expect(rules(readingsOf(ownPlan(), { servers: shortServer(0.9, 3) }))).toEqual([]);
  });
});

/** The test plan with its files in Garage on the app's server. */
function garagePlan(): DeployPlan {
  const base = testPlan();
  return DeployPlanSchema.parse({
    ...base,
    services: [
      ...base.services,
      { kind: "garage", version: "2.4", memoryMb: 64, reason: "uploads", licence: "AGPL-3.0" },
    ],
    storage: {
      objectStorage: {
        provider: "garage",
        bucket: "shop-uploads",
        region: "garage",
        expected: { storageGb: 10, egressGbPerMonth: 50 },
        price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
      },
    },
  });
}

function filling(server: ServerReadings, overrides: Partial<Readings> = {}) {
  return rules(
    readingsOf(garagePlan(), {
      servers: { app: server },
      requirements: makeRequirements(),
      ...overrides,
    }),
  );
}

describe("componentRules: object storage", () => {
  const hetzner = storagePrice("hetzner", { storageGb: 10, egressGbPerMonth: 50 });

  it(`proposes it for a disk full within ${THRESHOLDS.diskFullDays} days while Garage keeps the files`, () => {
    const proposals = filling(
      { now: reading(), history: history({ diskFullInDays: THRESHOLDS.diskFullDays }) },
      { flags: " --app api" },
    );
    expect(proposals).toEqual([
      {
        id: "components.app.object-storage",
        category: "components",
        urgency: "soon",
        server: "app",
        title: "Keep the app's files in Hetzner Object Storage instead of on server app",
        reasons: [
          {
            text: "Server app's disk is filling at the pace of the last 7 days",
            figure: "full in 30 days",
            basis: { kind: "history", days: 14 },
          },
          {
            text: `The app keeps its files in Garage on server app. Hetzner Object Storage keeps them off it, priced for 10 GB stored and 50 GB sent a month (storage.objectStorage.expected). ${hetzner.note?.slice(0, -1)}`,
            basis: { kind: "plan" },
          },
        ],
        price: {
          before: 0,
          after: hetzner.amount,
          currency: "EUR",
          source: "static",
          asOf: hetzner.checkedOn,
        },
        apply: {
          kind: "manual",
          text: "Set storage.objectStorage.provider to hetzner in opscrew/plan.yaml, run `opscrew design --app api` and `opscrew provision --app api`, then copy the files from Garage to the new bucket",
        },
      },
    ]);
  });

  it(`is now within ${THRESHOLDS.diskFullDaysNow} days, and says nothing just past ${THRESHOLDS.diskFullDays}`, () => {
    const within = (days: number) =>
      filling({ now: reading(), history: history({ diskFullInDays: days }) });
    expect(within(THRESHOLDS.diskFullDaysNow)[0]?.urgency).toBe("now");
    expect(within(THRESHOLDS.diskFullDaysNow + 0.1)[0]?.urgency).toBe("soon");
    expect(within(THRESHOLDS.diskFullDays + 0.1)).toEqual([]);
  });

  it(`proposes it on one reading at ${THRESHOLDS.diskHigh * 100}% full, not below`, () => {
    expect(filling({ now: reading({ disk: THRESHOLDS.diskHigh }) })[0]?.reasons[0]).toEqual({
      text: "Server app's disk is nearly full",
      figure: "85% in use",
      basis: { kind: "one-reading", at: AT },
    });
    expect(filling({ now: reading({ disk: 0.84 }) })).toEqual([]);
  });

  it("proposes nothing without Garage, without the interview or with nowhere else to go", () => {
    const full = { app: { now: reading({ disk: 0.95 }) } };
    expect(
      rules(readingsOf(testPlan(), { servers: full, requirements: makeRequirements() })),
    ).toEqual([]);
    expect(rules(readingsOf(garagePlan(), { servers: full }))).toEqual([]);
    const own = makeRequirements({ provider: "own", region: undefined });
    expect(filling({ now: reading({ disk: 0.95 }) }, { requirements: own })).toEqual([]);
  });
});

describe("componentRules: targets", () => {
  it("proposes nothing for Cloudflare's hosting or GitHub Pages", () => {
    for (const plan of [sitePlan(), pagesTestPlan()]) {
      const servers = { app: { now: reading({ disk: 0.95 }) } };
      expect(rules(readingsOf(plan, { servers }))).toEqual([]);
    }
  });
});
