import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUserFacingError } from "@opscrew/core";
import { FakeAgentRuntime, fakeSecret, materializeFixture } from "@opscrew/core/testing";
import {
  type Architecture,
  type ProjectFacts,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  ANALYST_SYSTEM_PROMPT,
  buildAnalystPrompt,
  DEFAULT_ANALYST_MODEL,
  renderArchitectureMarkdown,
  runAnalyze,
  summarizeFacts,
} from "./index";

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
/** The detect fixture with an Express API in `apps/api` and a Next.js app in `apps/web`. */
const TWO_APPS = fileURLToPath(
  new URL("../../../detect/test/fixtures/monorepo-two-apps/", import.meta.url),
);

async function project(example: string) {
  const root = await mkdtemp(join(tmpdir(), `opscrew-analyze-${example}-`));
  await materializeFixture(join(examples, example), root);
  return root;
}

function baseFacts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    name: "demo",
    languages: ["typescript"],
    packageManager: "npm",
    frameworks: [{ name: "express", path: "." }],
    appKind: "api",
    platformExport: { platform: "none", evidence: [] },
    build: { installCommand: "npm ci", startCommand: "npm start" },
    port: 3000,
    runtimeVersions: {},
    envVars: [],
    services: [],
    docker: { dockerfile: "Dockerfile" },
    healthEndpoint: "/health",
    monorepo: false,
    git: {},
    ...overrides,
  };
}

describe("summarizeFacts", () => {
  it("has no risks for a ready API and describes it in plain English", () => {
    const result = summarizeFacts(baseFacts());
    expect(result.risks).toEqual([]);
    expect(result.summary).toContain("demo is an API server built with Express (TypeScript).");
    expect(result.summary).toContain("It listens on port 3000.");
    expect(summarizeFacts(baseFacts())).toEqual(result);
  });

  it("reports every deterministic risk", () => {
    const { risks } = summarizeFacts(
      baseFacts({
        appKind: "ssr",
        docker: {},
        healthEndpoint: undefined,
        envVars: [
          { name: "DATABASE_URL", files: ["a.ts"], clientExposed: false, secretLikely: true },
          {
            name: "VITE_SERVICE_ROLE_KEY",
            files: ["b.ts"],
            clientExposed: true,
            secretLikely: true,
          },
        ],
        services: [{ kind: "sqlite", evidence: ["dependency:better-sqlite3"] }],
        monorepo: true,
      }),
      { appCandidates: ["apps/api", "apps/web"] },
    );
    const text = risks.join("\n");
    expect(text).toMatch(/several deployable apps \(`apps\/api` and `apps\/web`\)/);
    expect(text).toMatch(/no Dockerfile/);
    expect(text).toMatch(/No health-check endpoint/);
    expect(text).toMatch(/`VITE_SERVICE_ROLE_KEY` is exposed to the browser/);
    expect(text).not.toMatch(/`DATABASE_URL`/);
    expect(text).toMatch(/SQLite/);
    expect(risks).toHaveLength(5);
  });

  it("flags an unknown app kind and skips the health risk for static sites", () => {
    expect(summarizeFacts(baseFacts({ appKind: "unknown", frameworks: [] })).risks[0]).toMatch(
      /could not tell what kind of app/,
    );
    const spa = summarizeFacts(
      baseFacts({ appKind: "static-spa", healthEndpoint: undefined, docker: {} }),
    );
    expect(spa.risks.join("\n")).not.toMatch(/health-check/);
  });
});

describe("renderArchitectureMarkdown", () => {
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T12:00:00.000Z",
    generator: { tool: "opscrew", version: "1.2.3" },
    facts: baseFacts({
      envVars: [
        { name: "API_TOKEN", files: ["src/a.ts"], clientExposed: false, secretLikely: true },
        { name: "VITE_URL", files: ["src/b.ts"], clientExposed: true, secretLikely: false },
      ],
      services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
      platformExport: { platform: "lovable", evidence: ["devDependency:lovable-tagger"] },
    }),
    summary: "A summary.",
    risks: ["Risk one."],
    aiEnriched: true,
  };

  it("renders the sections in order with names only and a footer", () => {
    const md = renderArchitectureMarkdown(architecture);
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## Overview",
      "## Stack",
      "## Build and run",
      "## Configuration",
      "## Services",
      "## Platform export notes",
      "## Risks",
    ]);
    expect(md).toContain("| `VITE_URL` | **yes** | no | `src/b.ts` |");
    expect(md).toContain("| `API_TOKEN` | no | yes | `src/a.ts` |");
    expect(md).toContain("- PostgreSQL (evidence: `dependency:pg`)");
    expect(md).toContain("Exported from Lovable");
    expect(md).toContain("- Risk one.");
    expect(md).toContain("refined by the OpsCrew Analyst");
    expect(md).toMatch(/Generated by OpsCrew 1\.2\.3 on 2026-10-11T12:00:00\.000Z/);
    expect(md.endsWith("\n")).toBe(true);
  });

  it("says when nothing was found", () => {
    const md = renderArchitectureMarkdown({
      ...architecture,
      facts: baseFacts(),
      risks: [],
      aiEnriched: false,
    });
    expect(md).toContain("No environment variables were detected.");
    expect(md).toContain("No backing services were detected.");
    expect(md).toContain("No deployment risks were found.");
    expect(md).not.toContain("refined by");
  });
});

describe("Analyst prompts", () => {
  it("forbids secrets and .env/key files and keeps the analyst read-only", () => {
    expect(ANALYST_SYSTEM_PROMPT).toMatch(/read-only/);
    expect(ANALYST_SYSTEM_PROMPT).toMatch(/Never read `\.env`/);
    expect(ANALYST_SYSTEM_PROMPT).toMatch(/private keys/);
    expect(ANALYST_SYSTEM_PROMPT).toMatch(/Never print, quote or guess secret values/);
    expect(ANALYST_SYSTEM_PROMPT).toMatch(/deployment facts/);
  });

  it("names both VPS providers", () => {
    expect(ANALYST_SYSTEM_PROMPT).toContain("(Hetzner Cloud or DigitalOcean, Docker, Caddy)");
  });

  it("passes the facts as JSON", () => {
    const facts = baseFacts();
    const prompt = buildAnalystPrompt(facts, summarizeFacts(facts));
    expect(prompt).toContain(JSON.stringify(facts, null, 2));
  });
});

describe("runAnalyze", () => {
  it("writes the deterministic architecture for the Lovable example without AI", async () => {
    const root = await project("lovable-supabase");
    const deps = await createTestPhaseDeps({ root });
    const result = await runAnalyze(deps, { ai: false });

    const written = await readArtifact("architecture", deps.paths.files.architecture);
    expect(written).toEqual(result.architecture);
    expect(written.aiEnriched).toBe(false);
    expect(written.generatedAt).toBe("2026-10-11T12:00:00.000Z");
    expect(written.generator).toEqual({ tool: "opscrew", version: "0.0.0-test" });
    expect(written.facts.platformExport.platform).toBe("lovable");
    expect(written.facts.appKind).toBe("static-spa");
    expect(written.facts.services.map((s) => s.kind)).toContain("supabase");
    expect(written.facts.envVars.find((v) => v.name === "VITE_SUPABASE_URL")?.clientExposed).toBe(
      true,
    );
    expect(written.risks.join("\n")).toMatch(/no Dockerfile/);

    const md = await readFile(deps.paths.files.architectureMd, "utf8");
    expect(md).toBe(result.markdown);
    expect(md).toContain("# Architecture:");
    expect(md).toContain("Exported from Lovable");

    // The materialised .env holds fake secrets; none of them may reach the artefacts.
    const json = await readFile(deps.paths.files.architecture, "utf8");
    for (const kind of ["supabase-anon-jwt", "supabase-service-role-jwt"] as const) {
      for (const seed of ["opscrew", "env"]) {
        expect(json).not.toContain(fakeSecret(kind, seed));
        expect(md).not.toContain(fakeSecret(kind, seed));
      }
    }

    const state = await deps.state.read();
    expect(state.phases.analyze?.status).toBe("ok");
    expect(await deps.costs.entries()).toEqual([]);
    expect(result.costUsd).toBe(0);
  });

  it("detects the Next.js + Postgres example", async () => {
    const deps = await createTestPhaseDeps({ root: await project("nextjs-postgres") });
    const { architecture } = await runAnalyze(deps, { ai: false });
    expect(architecture.facts.appKind).toBe("ssr");
    expect(architecture.facts.port).toBe(3000);
    expect(architecture.facts.services.map((s) => s.kind)).toContain("postgres");
    expect(architecture.facts.envVars.find((v) => v.name === "DATABASE_URL")?.secretLikely).toBe(
      true,
    );
  });

  it("uses the deterministic result when no runtime is configured", async () => {
    const deps = await createTestPhaseDeps({ root: await project("static-vite") });
    const result = await runAnalyze(deps);
    expect(result.architecture.aiEnriched).toBe(false);
    expect(result.aiSkippedReason).toMatch(/No model/);
    expect(deps.reporter.text()).toMatch(/deterministic analysis/);
  });

  it("lets the Analyst refine summary, risks and selected facts", async () => {
    const runtime = new FakeAgentRuntime({
      phases: {
        analyze: {
          output: {
            summary: "  A Next.js shop that stores orders in PostgreSQL.  ",
            risks: [
              "Database migrations\nare not run on start.",
              "There is no Dockerfile. OpsCrew will add one when it prepares the code (`opscrew adapt`).",
            ],
            corrections: { healthEndpoint: "/api/health", port: 3000, appKind: "ssr" },
          },
          costUsd: 0.0123,
          turns: 7,
          model: "claude-haiku-5-5-20261001",
        },
      },
    });
    const deps = await createTestPhaseDeps({
      root: await project("nextjs-postgres"),
      runtime,
    });
    const deterministic = await runAnalyze(await createTestPhaseDeps({ root: deps.paths.root }), {
      ai: false,
    });
    const result = await runAnalyze(deps);

    expect(runtime.requests).toHaveLength(1);
    const request = runtime.requests[0];
    expect(request?.phase).toBe("analyze");
    expect(request?.profile).toBe("read-only");
    expect(request?.maxTurns).toBe(25);
    expect(request?.maxBudgetUsd).toBe(0.5);
    expect(request?.model).toBe(DEFAULT_ANALYST_MODEL);
    expect(DEFAULT_ANALYST_MODEL).toBe("claude-haiku-5-5");
    expect(request?.projectRoot).toBe(deps.paths.root);
    expect(request?.systemPrompt).toBe(ANALYST_SYSTEM_PROMPT);
    expect(request?.prompt).toContain(`"name": "${deterministic.architecture.facts.name}"`);
    expect(request?.builtinTools).toEqual(["Read", "Glob", "Grep"]);

    const { architecture } = result;
    expect(architecture.aiEnriched).toBe(true);
    expect(architecture.summary).toBe("A Next.js shop that stores orders in PostgreSQL.");
    expect(architecture.facts.healthEndpoint).toBe("/api/health");
    expect(architecture.risks).toContain("Database migrations are not run on start.");
    expect(architecture.risks.join("\n")).not.toMatch(/No health-check endpoint/);
    expect(architecture.risks.filter((r) => r.includes("no Dockerfile"))).toHaveLength(1);
    expect({ ...architecture.facts, healthEndpoint: undefined }).toEqual({
      ...deterministic.architecture.facts,
      healthEndpoint: undefined,
    });

    expect(await readArtifact("architecture", deps.paths.files.architecture)).toEqual(architecture);
    expect(await deps.costs.entries()).toEqual([
      {
        at: "2026-10-11T12:00:00.000Z",
        phase: "analyze",
        model: "claude-haiku-5-5-20261001",
        costUsd: 0.0123,
      },
    ]);
    expect(result.costUsd).toBe(0.0123);
    expect(deps.reporter.text()).toMatch(/\$0\.0123/);
    expect(deps.reporter.text()).toMatch(/corrected: health endpoint → \/api\/health/);
    expect((await deps.state.read()).phases.analyze?.summary).toMatch(/refined by the Analyst/);
  });

  it("honours a custom model and redacts secrets the model echoes", async () => {
    const token = fakeSecret("github-token");
    const runtime = new FakeAgentRuntime({
      phases: {
        analyze: {
          output: { summary: `Uses the token ${token}.`, risks: [`Leaked ${token} in code.`] },
        },
      },
    });
    const deps = await createTestPhaseDeps({ root: await project("static-vite"), runtime });
    const { architecture, markdown } = await runAnalyze(deps, { model: "claude-sonnet-5" });
    expect(runtime.requests[0]?.model).toBe("claude-sonnet-5");
    expect(JSON.stringify(architecture)).not.toContain(token);
    expect(markdown).not.toContain(token);
  });

  it("falls back to the deterministic result when the output is invalid", async () => {
    const runtime = new FakeAgentRuntime({
      phases: { analyze: { output: { summary: 42, risks: "none" }, costUsd: 0.01 } },
    });
    const deps = await createTestPhaseDeps({ root: await project("static-vite"), runtime });
    const result = await runAnalyze(deps);
    expect(result.architecture.aiEnriched).toBe(false);
    expect(result.aiSkippedReason).toMatch(/did not match/);
    expect(
      deps.reporter.lines.some((l) => l.level === "warn" && /Skipped the AI step/.test(l.message)),
    ).toBe(true);
    expect((await deps.state.read()).phases.analyze?.status).toBe("ok");
    expect(await deps.costs.total()).toBe(0.01);
    expect((await readArtifact("architecture", deps.paths.files.architecture)).aiEnriched).toBe(
      false,
    );
  });

  it("falls back when the run fails or the runtime throws", async () => {
    const failing = new FakeAgentRuntime({
      phases: {
        analyze: [
          { stopReason: "budget_exceeded", error: "The analyze phase hit its budget." },
          () => {
            throw new Error("socket hang up");
          },
        ],
      },
    });
    const deps = await createTestPhaseDeps({
      root: await project("static-vite"),
      runtime: failing,
    });
    const first = await runAnalyze(deps);
    expect(first.aiSkippedReason).toMatch(/hit its budget/);
    const second = await runAnalyze(deps);
    expect(second.aiSkippedReason).toMatch(/socket hang up/);
    expect(second.architecture.aiEnriched).toBe(false);
  });

  it("skips the model when the runtime is not configured", async () => {
    const runtime = new FakeAgentRuntime({
      availability: { ok: false, reason: "No API key was found.", hint: "Set ANTHROPIC_API_KEY." },
    });
    const deps = await createTestPhaseDeps({ root: await project("static-vite"), runtime });
    const result = await runAnalyze(deps);
    expect(runtime.requests).toHaveLength(0);
    expect(result.aiSkippedReason).toMatch(/No API key was found\. Set ANTHROPIC_API_KEY\./);
    expect(result.architecture.aiEnriched).toBe(false);
  });

  describe("in a repository with several apps", () => {
    async function twoApps() {
      const root = await mkdtemp(join(tmpdir(), "opscrew-analyze-two-apps-"));
      await materializeFixture(TWO_APPS, root);
      return createTestPhaseDeps({ root });
    }

    it("describes the root and reports the candidates when no app is chosen", async () => {
      const deps = await twoApps();
      const { architecture } = await runAnalyze(deps, { ai: false });
      expect(architecture.facts.appDir).toBe(".");
      expect(architecture.risks.join("\n")).toMatch(
        /several deployable apps \(`apps\/api` and `apps\/web`\)/,
      );
    });

    it("describes the app given with appDir, without the several-apps risk", async () => {
      const deps = await twoApps();
      const { architecture } = await runAnalyze(deps, { ai: false, appDir: "./apps/api/" });
      expect(architecture.facts.appDir).toBe("apps/api");
      expect(architecture.facts.appKind).toBe("api");
      expect(architecture.facts.frameworks.map((f) => f.name)).toEqual(["express"]);
      expect(architecture.risks.join("\n")).not.toMatch(/several deployable apps/);
      expect(architecture.summary).toContain("It lives in `apps/api` of a monorepo");
      expect((await deps.state.read()).phases.analyze?.summary).toMatch(/in apps\/api/);
    });

    it("takes the app chosen in requirements.yaml", async () => {
      const deps = await twoApps();
      await writeArtifact("requirements", deps.paths.files.requirements, {
        schemaVersion: 1,
        answeredAt: "2026-10-11T11:00:00.000Z",
        expectedMonthlyUsers: "<1k",
        budgetMonthly: { amount: 10, currency: "EUR" },
        region: "eu-central",
        uptime: "standard",
        dataCriticality: "none",
        dnsProvider: "none",
        keepExternalServices: [],
        appDir: "apps/web",
      });
      const { architecture } = await runAnalyze(deps, { ai: false });
      expect(architecture.facts.appDir).toBe("apps/web");
      expect(architecture.facts.appKind).toBe("ssr");
      expect(deps.reporter.text()).toMatch(/apps\/web \(chosen earlier/);

      // The option wins over the requirements.
      const option = await runAnalyze(deps, { ai: false, appDir: "apps/api" });
      expect(option.architecture.facts.appDir).toBe("apps/api");
      // ...and records the new choice there, so design never sees two different apps.
      expect((await readArtifact("requirements", deps.paths.files.requirements)).appDir).toBe(
        "apps/api",
      );
    });

    it("keeps the app chosen with --app on the next plain analyze, until --app .", async () => {
      const deps = await twoApps();
      await runAnalyze(deps, { ai: false, appDir: "apps/api" });
      const again = await runAnalyze(deps, { ai: false });
      expect(again.architecture.facts.appDir).toBe("apps/api");
      const reset = await runAnalyze(deps, { ai: false, appDir: "." });
      expect(reset.architecture.facts.appDir).toBe(".");
      const afterReset = await runAnalyze(deps, { ai: false });
      expect(afterReset.architecture.facts.appDir).toBe(".");
    });

    it("rejects an unknown app folder with the candidates and writes nothing", async () => {
      const deps = await twoApps();
      const error = await runAnalyze(deps, { ai: false, appDir: "apps/nope" }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      expect((error as Error).message).toMatch(/apps\/api, apps\/web/);
      expect(isUserFacingError(error)).toBe(true);
      await expect(readFile(deps.paths.files.architecture, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await deps.state.read()).phases.analyze?.status).toBe("failed");
    });
  });

  it("does not call the model with ai: false", async () => {
    const runtime = new FakeAgentRuntime();
    const deps = await createTestPhaseDeps({ root: await project("static-vite"), runtime });
    await runAnalyze(deps, { ai: false });
    expect(runtime.requests).toHaveLength(0);
  });
});
