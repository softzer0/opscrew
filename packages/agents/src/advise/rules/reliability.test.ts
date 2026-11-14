import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../../localhost/__fixtures__/computer";
import { networked, splitPlan } from "../../network/__fixtures__/plans";
import { makeRequirements, ownPlan, testPlan } from "../../testing";
import { pagesTestPlan } from "../../testing/pages";
import { portainerPlan } from "../../testing/portainer";
import { previewTestPlan } from "../../testing/previews";
import { sitePlan } from "../../testing/serverless";
import { THRESHOLDS } from "../types";
import {
  AT,
  contaboTable,
  container,
  history,
  reading,
  readingsOf,
  validated,
} from "./__fixtures__/rule-readings";
import { reliabilityRules } from "./reliability";

const rules = validated(reliabilityRules);

/** The test plan with its check on, so only what a test sets is proposed. */
function checked(plan: DeployPlan): DeployPlan {
  return { ...plan, observability: { ...plan.observability, check: { enabled: true } } };
}

const important = makeRequirements({ dataCriticality: "important" });

function withoutBackups(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, target: { ...plan.target, backups: false } });
}

describe("reliabilityRules: backups", () => {
  it("proposes backups for a server without them when the data is important, priced", () => {
    const plan = checked(withoutBackups(testPlan()));
    expect(rules(readingsOf(plan, { requirements: important }))).toEqual([
      {
        id: "reliability.app.backups",
        category: "reliability",
        urgency: "when-convenient",
        server: "app",
        title: "Turn on automated backups for server app",
        reasons: [
          {
            text: "The interview says the app's data is important, and server app has no automated backups: a broken disk or a wrong command would lose it",
            basis: { kind: "plan" },
          },
        ],
        // cx23 €5.49 + IPv4 €0.50; backups 20% of €5.49 = €1.10. Live prices carry no date.
        price: { before: 5.99, after: 7.09, currency: "EUR", source: "live" },
        apply: { kind: "plan", change: { kind: "backups", server: "app", enabled: true } },
      },
    ]);
  });

  it("names critical data, and an extra server's backups by its name", () => {
    const { plan: split } = networked(splitPlan());
    const plan = checked({
      ...split,
      servers: split.servers?.map((server) => ({
        ...server,
        target: { ...server.target, backups: false },
      })),
    });
    const [proposal, ...rest] = rules(
      readingsOf(plan, { requirements: makeRequirements({ dataCriticality: "critical" }) }),
    );
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      id: "reliability.data.backups",
      server: "data",
      reasons: [{ text: expect.stringContaining("the app's data is critical, and server data") }],
      price: { before: 5.99, after: 7.09 },
      apply: { kind: "plan", change: { kind: "backups", server: "data", enabled: true } },
    });
  });

  it("proposes Contabo's in prod as priced on Contabo's order page, never with a € figure", async () => {
    const plan = checked(withoutBackups(testPlan({ provider: "contabo" })));
    const [proposal, ...rest] = rules(
      readingsOf(plan, { requirements: important, prices: [await contaboTable()] }),
    );
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      id: "reliability.app.backups",
      title: "Turn on automated backups for server app",
      reasons: [
        { text: expect.stringContaining("the app's data is important, and server app") },
        {
          text: "Contabo's automated backups are priced on Contabo's order page: Contabo publishes no price per plan for them",
          basis: { kind: "plan" },
        },
      ],
      apply: { kind: "plan", change: { kind: "backups", server: "app", enabled: true } },
    });
    expect(proposal?.price).toBeUndefined();
  });

  it("proposes them without a price when the server's type has none", () => {
    const plan = checked(withoutBackups(testPlan()));
    const [proposal] = rules(readingsOf(plan, { requirements: important, prices: [] }));
    expect(proposal?.id).toBe("reliability.app.backups");
    expect(proposal?.price).toBeUndefined();
  });

  it("proposes nothing with backups on, data that matters little, no interview or no cloud server", () => {
    const off = checked(withoutBackups(testPlan()));
    expect(rules(readingsOf(checked(testPlan()), { requirements: important }))).toEqual([]);
    const none = makeRequirements({ dataCriticality: "none" });
    expect(rules(readingsOf(off, { requirements: none }))).toEqual([]);
    expect(rules(readingsOf(off))).toEqual([]);
    // An own server gets no provider backups; with its snapshots scheduled and copied off, nothing.
    const own = { ...checked(ownPlan()), snapshots: SNAPSHOTS_ON };
    expect(rules(readingsOf(own, { requirements: important }))).toEqual([]);
  });

  it("proposes them only in prod: dev and staging rely on OpsCrew's own snapshots (T2750)", () => {
    const base = checked(withoutBackups(testPlan()));
    for (const name of ["staging", "dev"]) {
      const plan = DeployPlanSchema.parse({
        ...base,
        app: { ...base.app, name: `shop-${name}` },
        environment: { name },
      });
      const critical = makeRequirements({ dataCriticality: "critical" });
      const ids = rules(readingsOf(plan, { requirements: critical })).map((p) => p.id);
      expect(ids).not.toContain("reliability.app.backups");
    }
  });
});

/** Scheduled snapshots with their off-server copy. */
const SNAPSHOTS_ON = {
  schedule: { every: "weekly", keep: 4 },
  offsite: { provider: "r2" as const, bucket: "shop-prod-backups" },
};

describe("reliabilityRules: snapshots on an own server or Portainer (024)", () => {
  it("proposes the schedule and the copy off the server on R2 when the data matters, priced", () => {
    const plan = checked(ownPlan());
    expect(rules(readingsOf(plan, { requirements: important, flags: " --app web" }))).toEqual([
      {
        id: "reliability.env.snapshot-schedule",
        category: "reliability",
        urgency: "when-convenient",
        title: "Take snapshots of the app's data on a schedule",
        reasons: [
          {
            text: "The interview says the app's data is important, and nothing backs it up on your server: no snapshot is taken unless someone runs `opscrew snapshot --app web`",
            basis: { kind: "plan" },
          },
        ],
        apply: { kind: "command", command: "opscrew snapshot schedule on --app web" },
      },
      {
        id: "reliability.env.snapshot-offsite",
        category: "reliability",
        urgency: "when-convenient",
        title: "Keep an encrypted copy of each snapshot off the server",
        reasons: [
          {
            text: "The interview says the app's data is important, and its snapshots stay on your server: losing it loses them too. The copy is encrypted to the recovery copy's age key, which only you hold",
            basis: { kind: "plan" },
          },
        ],
        // provision's price data: R2's bucket costs nothing below its free storage.
        price: { before: 0, after: 0, currency: "USD", source: "static", asOf: "2026-10-19" },
        apply: { kind: "command", command: "opscrew snapshot offsite on --to r2 --app web" },
      },
    ]);
  });

  it("in Portainer without a domain on Cloudflare, names the other providers by hand", () => {
    const plan = checked({
      ...portainerPlan({ domain: null, web: { mode: "proxy", port: 8080 } }),
      snapshots: { schedule: SNAPSHOTS_ON.schedule },
    });
    const critical = makeRequirements({ dataCriticality: "critical" });
    expect(rules(readingsOf(plan, { requirements: critical }))).toEqual([
      expect.objectContaining({
        id: "reliability.env.snapshot-offsite",
        title: "Keep an encrypted copy of each snapshot off the host",
        reasons: [
          expect.objectContaining({
            text: expect.stringContaining("its snapshots stay on the Portainer host"),
          }),
        ],
        apply: {
          kind: "manual",
          text: "Run `opscrew snapshot offsite on --to hetzner --region <region>` (or `--to digitalocean`) with the region the copies should be in, or keep them in your own S3-compatible bucket or on your own machine over SFTP (`--to s3`, `--to sftp`)",
        },
      }),
    ]);
  });

  it("proposes neither on a cloud server, for data that matters little, without data or for previews", () => {
    const ids = (plan: DeployPlan, requirements = important) =>
      rules(readingsOf(checked(plan), { requirements })).map((proposal) => proposal.id);
    expect(ids(testPlan())).toEqual([]);
    expect(ids(ownPlan(), makeRequirements({ dataCriticality: "none" }))).toEqual([]);
    expect(ids(ownPlan({ postgres: false }))).toEqual([]);
    expect(ids(previewTestPlan({ own: true }))).toEqual([]);
  });
});

describe("reliabilityRules: the scheduled check", () => {
  it("proposes turning it on for prod (free)", () => {
    expect(rules(readingsOf(testPlan()))).toEqual([
      {
        id: "reliability.env.check",
        category: "reliability",
        urgency: "when-convenient",
        title: "Turn on the scheduled check for prod",
        reasons: [
          {
            text: "The scheduled check is off for prod, so nobody is told when the app stops answering. It runs in the repository's GitHub Actions and opens an issue when the app fails; it adds no server cost",
            basis: { kind: "plan" },
          },
        ],
        apply: { kind: "plan", change: { kind: "check", enabled: true } },
      },
    ]);
  });

  it("proposes nothing when it is on, for another environment or on this computer", () => {
    expect(rules(readingsOf(checked(testPlan())))).toEqual([]);
    const base = testPlan();
    const staging = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, name: "shop-staging" },
      environment: { name: "staging" },
    });
    expect(rules(readingsOf(staging))).toEqual([]);
    expect(rules(readingsOf(localPlan()))).toEqual([]);
  });
});

describe("reliabilityRules: a flapping check", () => {
  const issue = (number: number, day: string) => ({
    number,
    createdAt: `2026-${day}T03:00:00Z`,
    closedAt: `2026-${day}T03:20:00Z`,
  });

  it(`reports ${THRESHOLDS.checkFlaps} issues in the period, with their dates`, () => {
    const check = [issue(7, "11-02"), issue(5, "10-25"), issue(6, "10-30")];
    const flags = " --app api --env staging";
    expect(rules(readingsOf(checked(testPlan()), { check, flags }))).toEqual([
      {
        id: "reliability.env.check-flaps",
        category: "reliability",
        urgency: "soon",
        title: "Find out why the app keeps failing its scheduled check",
        reasons: [
          {
            text: "The scheduled check opened its issue on 2026-10-25, 2026-10-30 and 2026-11-02: the app stopped answering and came back each time",
            figure: "3 issues in 14 days",
            basis: { kind: "account" },
          },
          {
            text: "Look at the app's logs around those dates, and at `opscrew status --app api --env staging` for a server short of memory or disk",
            basis: { kind: "plan" },
          },
        ],
        apply: { kind: "command", command: "opscrew logs --since 14d --app api --env staging" },
      },
    ]);
  });

  it("names a day once however many issues it opened", () => {
    const check = [issue(1, "10-25"), issue(2, "10-25"), issue(3, "10-30")];
    const [proposal] = rules(readingsOf(checked(testPlan()), { check }));
    expect(proposal?.reasons[0]?.text).toContain("on 2026-10-25 and 2026-10-30:");
  });

  it(`reports nothing for ${THRESHOLDS.checkFlaps - 1} issues or when the issues weren't read`, () => {
    const check = [issue(1, "10-25"), issue(2, "10-30")];
    expect(rules(readingsOf(checked(testPlan()), { check }))).toEqual([]);
    expect(rules(readingsOf(checked(testPlan())))).toEqual([]);
  });
});

describe("reliabilityRules: restart loops", () => {
  it(`reports a container restarted ${THRESHOLDS.restarts} times in its history`, () => {
    const servers = {
      app: {
        now: reading({
          containers: [container("app", { restarts: 9 }), container("db", { restarts: 9 })],
        }),
        history: history({
          days: 5.2,
          containers: [
            { service: "app", restarts: THRESHOLDS.restarts - 1 },
            { service: "db", restarts: THRESHOLDS.restarts },
          ],
        }),
      },
    };
    expect(rules(readingsOf(checked(testPlan()), { servers }))).toEqual([
      {
        id: "reliability.app.restart-loop-db",
        category: "reliability",
        urgency: "soon",
        server: "app",
        title: "Find out why db keeps restarting on server app",
        reasons: [
          {
            text: "Its container keeps restarting; deploys don't count, as each starts a new container",
            figure: "3 restarts",
            basis: { kind: "history", days: 5.2 },
          },
        ],
        apply: { kind: "command", command: "opscrew logs --service db" },
      },
    ]);
  });

  it("uses the one reading's count without history", () => {
    const servers = {
      app: {
        now: reading({
          containers: [container("db", { restarts: 2 }), container("app", { restarts: 3 })],
        }),
      },
    };
    const flags = " --env staging";
    expect(rules(readingsOf(checked(testPlan()), { servers, flags }))).toEqual([
      expect.objectContaining({
        id: "reliability.app.restart-loop-app",
        title: "Find out why app keeps restarting on server app",
        reasons: [
          {
            text: "Its container has kept restarting since it was last deployed",
            figure: "3 restarts",
            basis: { kind: "one-reading", at: AT },
          },
        ],
        apply: { kind: "command", command: "opscrew logs --service app --env staging" },
      }),
    ]);
  });

  it("names the part as `logs` does: the edge's Caddy in a Portainer stack, else no part", () => {
    const servers = {
      app: {
        now: reading({
          containers: [container("caddy", { restarts: 4 }), container("unknown", { restarts: 5 })],
        }),
      },
    };
    const plan = checked(portainerPlan({ web: { mode: "caddy" } }));
    const commands = rules(readingsOf(plan, { servers })).map((p) => p.apply);
    expect(commands).toEqual([
      { kind: "command", command: "opscrew logs --service edge" },
      { kind: "command", command: "opscrew logs" },
    ]);
  });
});

describe("reliabilityRules: targets", () => {
  it("proposes nothing for Cloudflare's hosting or GitHub Pages", () => {
    const check = [1, 2, 3].map((number) => ({ number, createdAt: "2026-11-01T00:00:00Z" }));
    for (const plan of [sitePlan(), pagesTestPlan()]) {
      expect(rules(readingsOf(plan, { check, requirements: important }))).toEqual([]);
    }
  });
});
