import { CodeChangeKindSchema, type ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makePlan, nextChanges, nextFacts } from "./__fixtures__/repo";
import { playbookFor, playbookInstructions } from "./playbooks";
import { djangoPlaybook } from "./playbooks/django";
import { fastapiPlaybook } from "./playbooks/fastapi";
import { genericPlaybook } from "./playbooks/generic";
import { nextjsPlaybook } from "./playbooks/nextjs";
import { nodeServerPlaybook } from "./playbooks/node-server";
import { staticSpaPlaybook } from "./playbooks/static-spa";
import {
  buildCodeChangePrompt,
  CODE_CHANGE_MODEL,
  CODE_CHANGE_SYSTEM_PROMPT,
  CodeChangeReportSchema,
  manualInstructions,
} from "./prompts";

const facts = (overrides: Partial<ProjectFacts>): ProjectFacts => ({
  ...nextFacts(),
  ...overrides,
});

describe("playbooks", () => {
  it("picks the playbook for the container stack", () => {
    expect(playbookFor(nextFacts()).id).toBe("nextjs");
    expect(
      playbookFor(facts({ frameworks: [{ name: "express", path: "." }], appKind: "api" })).id,
    ).toBe("node-server");
    expect(
      playbookFor(facts({ frameworks: [{ name: "vite", path: "." }], appKind: "static-spa" })).id,
    ).toBe("static-spa");
    expect(
      playbookFor(
        facts({
          languages: ["python"],
          frameworks: [{ name: "fastapi", path: "." }],
          appKind: "api",
        }),
      ).id,
    ).toBe("fastapi");
    expect(
      playbookFor(
        facts({
          languages: ["python"],
          frameworks: [{ name: "django", path: "." }],
          appKind: "fullstack",
        }),
      ).id,
    ).toBe("django");
    expect(playbookFor(facts({ languages: ["go"], frameworks: [], appKind: "unknown" })).id).toBe(
      "generic",
    );
  });

  it("has instructions and acceptance checks for every kind in every playbook", () => {
    for (const playbook of [
      nextjsPlaybook,
      nodeServerPlaybook,
      staticSpaPlaybook,
      fastapiPlaybook,
      djangoPlaybook,
      genericPlaybook,
    ]) {
      expect(playbook.guidance.length).toBeGreaterThan(0);
      for (const kind of CodeChangeKindSchema.options) {
        const { step, checks } = playbookInstructions(playbook, kind);
        expect(step.length, `${playbook.id}/${kind}`).toBeGreaterThan(20);
        expect(checks.length, `${playbook.id}/${kind}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("Code-change prompts", () => {
  it("states the safety rules in the system prompt", () => {
    expect(CODE_CHANGE_MODEL).toBe("claude-opus-5-5");
    for (const rule of [
      "Edit only the files listed",
      "Keep the app's behaviour the same",
      "Never read, print or copy secrets",
      "Do not add dependencies unless",
      "addedDependencies",
      "Never edit anything under opscrew/",
      "Do not commit, push",
      '"applied"',
      '"skipped"',
    ]) {
      expect(CODE_CHANGE_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it("lists each change with its file, playbook step and acceptance checks", () => {
    const changes = nextChanges().filter(
      (c) => c.kind === "health-endpoint" || c.kind === "build-config",
    );
    const prompt = buildCodeChangePrompt({
      facts: nextFacts(),
      plan: makePlan(nextChanges()),
      changes,
      playbook: playbookFor(nextFacts()),
    });
    expect(prompt).toContain("## Playbook: Next.js (standalone server)");
    expect(prompt).toContain("### health-endpoint (health-endpoint)");
    expect(prompt).toContain("- File: app/api/health/route.ts");
    expect(prompt).toContain("Response.json");
    expect(prompt).toContain("`GET /api/health` returns 200");
    expect(prompt).toContain('output: "standalone"');
    expect(prompt).toContain("Health check path: /api/health");
    expect(prompt).toContain("DATABASE_URL, STRIPE_SECRET_KEY");
    expect(prompt).toContain("Report exactly these change ids: health-endpoint, build-config.");
    expect(prompt).not.toContain("### dockerfile");
    expect(prompt).not.toContain("App folder");
  });

  it("names the app folder of an app in a monorepo", () => {
    const facts = {
      ...nextFacts(),
      monorepo: true,
      appDir: "apps/web",
      frameworks: [{ name: "next", path: "apps/web" }],
    };
    const plan = makePlan(nextChanges());
    const prompt = buildCodeChangePrompt({
      facts,
      plan: { ...plan, app: { ...plan.app, dockerfile: "apps/web/Dockerfile" } },
      changes: nextChanges().filter((c) => c.kind === "health-endpoint"),
      playbook: playbookFor(facts),
    });
    expect(prompt).toContain("- App folder: apps/web");
    expect(prompt).toContain("never the other apps");
    expect(prompt).toContain("built from the repository root with apps/web/Dockerfile");
  });

  it("validates the agent report", () => {
    expect(CodeChangeReportSchema.parse({ changes: [{ id: "a", status: "applied" }] })).toEqual({
      changes: [{ id: "a", status: "applied", notes: "" }],
      addedDependencies: [],
    });
    expect(
      CodeChangeReportSchema.safeParse({ changes: [{ id: "a", status: "done" }] }).success,
    ).toBe(false);
    expect(CodeChangeReportSchema.safeParse({ changes: [], extra: 1 }).success).toBe(false);
  });

  it("writes manual instructions with the done-when checks", () => {
    const change = nextChanges().find((c) => c.kind === "build-config");
    const text = manualInstructions(change as NonNullable<typeof change>, playbookFor(nextFacts()));
    expect(text).toMatch(/^next\.config\.mjs: /);
    expect(text).toContain("Done when:");
  });
});
