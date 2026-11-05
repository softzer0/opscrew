import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../../localhost/__fixtures__/computer";
import { networked, splitPlan } from "../../network/__fixtures__/plans";
import { makeRequirements, ownPlan, testPlan } from "../../testing";
import { pagesTestPlan } from "../../testing/pages";
import { portainerPlan } from "../../testing/portainer";
import { sitePlan } from "../../testing/serverless";
import { THRESHOLDS } from "../types";
import { AT, container, history, reading, readingsOf } from "./__fixtures__/rule-readings";
import { reliabilityRules } from "./reliability";

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
    expect(reliabilityRules(readingsOf(plan, { requirements: important }))).toEqual([
      {
        id: "reliability.app.backups",
        category: "reliability",
        urgency: "when-convenient",
        server: "app",
        title: "Turn on automated backups for server app",
        reasons: [
          {
            text: "The interview says the app's data is important, and server app has no automated backups: a broken disk or a wrong command would lose it.",
            figure: "important",
            basis: { kind: "plan" },
          },
        ],
        // cx23 €5.49 + IPv4 €0.50; backups 20% of €5.49 = €1.10.
        price: { before: 5.99, after: 7.09, currency: "EUR", source: "live", asOf: AT },
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
    const [proposal, ...rest] = reliabilityRules(
      readingsOf(plan, { requirements: makeRequirements({ dataCriticality: "critical" }) }),
    );
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      id: "reliability.data.backups",
      server: "data",
      reasons: [{ figure: "critical" }],
      price: { before: 5.99, after: 7.09 },
      apply: { kind: "plan", change: { kind: "backups", server: "data", enabled: true } },
    });
  });

  it("proposes them without a price when the server's type has none", () => {
    const plan = checked(withoutBackups(testPlan()));
    const [proposal] = reliabilityRules(readingsOf(plan, { requirements: important, prices: [] }));
    expect(proposal?.id).toBe("reliability.app.backups");
    expect(proposal?.price).toBeUndefined();
  });

  it("proposes nothing with backups on, data that matters little, no interview or no cloud server", () => {
    const off = checked(withoutBackups(testPlan()));
    expect(reliabilityRules(readingsOf(checked(testPlan()), { requirements: important }))).toEqual(
      [],
    );
    const none = makeRequirements({ dataCriticality: "none" });
    expect(reliabilityRules(readingsOf(off, { requirements: none }))).toEqual([]);
    expect(reliabilityRules(readingsOf(off))).toEqual([]);
    expect(reliabilityRules(readingsOf(checked(ownPlan()), { requirements: important }))).toEqual(
      [],
    );
  });
});

describe("reliabilityRules: the scheduled check", () => {
  it("proposes turning it on for prod (free)", () => {
    expect(reliabilityRules(readingsOf(testPlan()))).toEqual([
      {
        id: "reliability.env.check",
        category: "reliability",
        urgency: "when-convenient",
        title: "Turn on the scheduled check for prod",
        reasons: [
          {
            text: "The scheduled check is off for prod, so nobody is told when the app stops answering. It runs in the repository's GitHub Actions and opens an issue when the app fails; it adds no server cost.",
            basis: { kind: "plan" },
          },
        ],
        apply: { kind: "plan", change: { kind: "check", enabled: true } },
      },
    ]);
  });

  it("proposes nothing when it is on, for another environment or on this computer", () => {
    expect(reliabilityRules(readingsOf(checked(testPlan())))).toEqual([]);
    const base = testPlan();
    const staging = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, name: "shop-staging" },
      environment: { name: "staging" },
    });
    expect(reliabilityRules(readingsOf(staging))).toEqual([]);
    expect(reliabilityRules(readingsOf(localPlan()))).toEqual([]);
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
    expect(reliabilityRules(readingsOf(checked(testPlan()), { check, flags }))).toEqual([
      {
        id: "reliability.env.check-flaps",
        category: "reliability",
        urgency: "soon",
        title: "Find out why the app keeps failing its scheduled check",
        reasons: [
          {
            text: "The scheduled check opened its issue 3 times in 14 days, on 2026-10-25, 2026-10-30 and 2026-11-02: the app stopped answering and came back each time. Look at the app's logs around those dates, and at `opscrew status --app api --env staging` for a server short of memory or disk.",
            figure: "3 issues",
            basis: { kind: "account" },
          },
        ],
        apply: { kind: "command", command: "opscrew logs --since 14d --app api --env staging" },
      },
    ]);
  });

  it("names a day once however many issues it opened", () => {
    const check = [issue(1, "10-25"), issue(2, "10-25"), issue(3, "10-30")];
    const [proposal] = reliabilityRules(readingsOf(checked(testPlan()), { check }));
    expect(proposal?.reasons[0]?.text).toContain("on 2026-10-25 and 2026-10-30:");
  });

  it(`reports nothing for ${THRESHOLDS.checkFlaps - 1} issues or when the issues weren't read`, () => {
    const check = [issue(1, "10-25"), issue(2, "10-30")];
    expect(reliabilityRules(readingsOf(checked(testPlan()), { check }))).toEqual([]);
    expect(reliabilityRules(readingsOf(checked(testPlan())))).toEqual([]);
  });
});

describe("reliabilityRules: restart loops", () => {
  it(`reports a container restarted ${THRESHOLDS.restarts} times in its history`, () => {
    const servers = {
      app: {
        now: reading({ containers: [container("app", 9), container("db", 9)] }),
        history: history({
          days: 5.2,
          containers: [
            { service: "app", restarts: THRESHOLDS.restarts - 1 },
            { service: "db", restarts: THRESHOLDS.restarts },
          ],
        }),
      },
    };
    expect(reliabilityRules(readingsOf(checked(testPlan()), { servers }))).toEqual([
      {
        id: "reliability.app.restart-loop-db",
        category: "reliability",
        urgency: "soon",
        server: "app",
        title: "Find out why db keeps restarting on server app",
        reasons: [
          {
            text: "Its container restarted 3 times in 5 days; deploys don't count, as each starts a new container.",
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
      app: { now: reading({ containers: [container("db", 2), container("app", 3)] }) },
    };
    const flags = " --env staging";
    expect(reliabilityRules(readingsOf(checked(testPlan()), { servers, flags }))).toEqual([
      expect.objectContaining({
        id: "reliability.app.restart-loop-app",
        title: "Find out why app keeps restarting on server app",
        reasons: [
          {
            text: "Its container restarted 3 times since it was last deployed.",
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
      app: { now: reading({ containers: [container("caddy", 4), container("unknown", 5)] }) },
    };
    const plan = checked(portainerPlan({ web: { mode: "caddy" } }));
    const commands = reliabilityRules(readingsOf(plan, { servers })).map((p) => p.apply);
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
      expect(reliabilityRules(readingsOf(plan, { check, requirements: important }))).toEqual([]);
    }
  });
});
