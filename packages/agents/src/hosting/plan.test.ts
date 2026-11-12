// Feature 027 (T2711): the hosting plans, their hash and their text (ADR 0030 D3).
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  type AgentPlan,
  type AppPlan,
  describeHostingPlan,
  HostingPlanSchema,
  hostingPlanFile,
  hostingPlanHash,
  panelSteps,
} from "./plan";

const PLAN: AgentPlan = {
  plan: "agent",
  panel: "plesk",
  account: "jdoe at plesk.example.com",
  environment: "prod",
  hostname: "notes.example.com",
  folder: "opscrew/notes-prod",
  steps: [
    {
      kind: "folder",
      files: [{ path: "agent.sh", mode: 0o700, sha256: "a".repeat(64) }],
    },
    {
      kind: "panel-step",
      id: "agent-cron",
      step: {
        operation: "addCron",
        what: "Add a task",
        where: "Websites & Domains → Scheduled Tasks → Add Task",
        value: "/bin/bash agent.sh",
      },
    },
  ],
};

describe("the hosting plans", () => {
  it("are hashed as SHA-256 of their canonical JSON, whatever the key order", () => {
    const reordered = JSON.parse(JSON.stringify({ ...PLAN, steps: PLAN.steps, plan: "agent" }));
    expect(hostingPlanHash(PLAN)).toMatch(/^[0-9a-f]{64}$/);
    expect(hostingPlanHash(reordered)).toBe(hostingPlanHash(PLAN));
    expect(hostingPlanHash({ ...PLAN, hostname: "admin.example.com" })).not.toBe(
      hostingPlanHash(PLAN),
    );
  });

  it("take fixed step kinds only", () => {
    expect(() =>
      HostingPlanSchema.parse({ ...PLAN, steps: [{ kind: "shell", command: "rm -rf ~" }] }),
    ).toThrow();
    // A file outside the home folder can't be planned.
    expect(() =>
      HostingPlanSchema.parse({
        ...PLAN,
        steps: [{ kind: "file", path: "../etc/passwd", mode: 0o600, sha256: "a".repeat(64) }],
      }),
    ).toThrow();
  });

  it("are saved per environment as hosting-<env>-agent.json and -app.json", async () => {
    const deps = await createTestPhaseDeps({ environment: "staging" });
    expect(hostingPlanFile(deps.paths, "staging", "agent").replaceAll("\\", "/")).toMatch(
      /\/plans\/hosting-staging-agent\.json$/,
    );
  });

  it("say what each step does, the panel's steps the user's, and end with the hash", () => {
    const hash = hostingPlanHash(PLAN);
    const text = describeHostingPlan(PLAN, hash);
    expect(text).toContain(
      "Hosting plan A (the agent) for notes.example.com on the Plesk account jdoe at plesk.example.com: 2 to change, 0 already in place.",
    );
    expect(text).toContain("Make ~/opscrew/notes-prod/ with agent.sh (0700)");
    expect(text).toContain("You, in Plesk: Add a task: /bin/bash agent.sh");
    expect(text.trimEnd().endsWith(`Hosting plan hash: ${hash}`)).toBe(true);
    expect(panelSteps(PLAN).map((step) => step.id)).toEqual(["agent-cron"]);
  });

  it("make the release signing key in the app's plan, its private half only in GitHub", () => {
    const app: AppPlan = { ...PLAN, plan: "app", steps: [{ kind: "signing-key" }] };
    const text = describeHostingPlan(app, hostingPlanHash(app));
    expect(text).toContain(
      "Make a new release signing key (ECDSA P-256): its private half into GitHub, its public half into ~/opscrew/notes-prod/keys/release.pub",
    );
    expect(text).toContain("never written on this computer or the account");
    // Plan A has no such step: nothing deploys before plan B.
    expect(() => HostingPlanSchema.parse({ ...PLAN, steps: [{ kind: "signing-key" }] })).toThrow();
  });
});
