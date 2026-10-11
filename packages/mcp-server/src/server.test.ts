import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestPhaseDeps, forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { defaultScanners } from "@opscrew/secops";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpscrewMcpDeps } from "./deps";
import { createOpscrewMcpServer, PLANNING_TOOLS } from "./server";

/** Lets a test lower the scan's file limit (20,000) so truncation can be tested on a small fixture. */
const limits = vi.hoisted(() => ({ maxFiles: undefined as number | undefined }));
vi.mock("@opscrew/secops", async (importOriginal) => {
  const secops = await importOriginal<typeof import("@opscrew/secops")>();
  return {
    ...secops,
    runScan: (root: string, options: Parameters<typeof secops.runScan>[1]) =>
      secops.runScan(
        root,
        limits.maxFiles === undefined ? options : { ...options, maxFiles: limits.maxFiles },
      ),
  };
});

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));

/** Every fake secret value the fixtures can contain; none may appear in any tool output. */
const FAKE_VALUES = [
  fakeSecret("supabase-service-role-jwt"),
  fakeSecret("supabase-service-role-jwt", "env"),
  fakeSecret("supabase-anon-jwt"),
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  limits.maxFiles = undefined;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Copies `examples/<name>` into a temp dir (fake-secret markers expanded). */
async function fixture(name: string): Promise<string> {
  const dir = await tempDir(`opscrew-mcp-${name}-`);
  await materializeFixture(path.join(EXAMPLES, name), dir);
  return dir;
}

interface Harness {
  client: Client;
  /** Every tool result returned so far, for the secret-leak assertion. */
  outputs: CallToolResult[];
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  fetchCalls: string[];
}

async function connect(cwd: string, overrides: Partial<OpscrewMcpDeps> = {}): Promise<Harness> {
  const home = await tempDir("opscrew-mcp-home-");
  const scratch = await tempDir("opscrew-mcp-scratch-");
  const fetchCalls: string[] = [];
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: home },
    fetch: async (input, init) => {
      fetchCalls.push(String(input));
      return forbiddenFetch(input, init);
    },
    runner: new ScriptedRunner(),
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
    cwd,
    scanners: () => defaultScanners({ includeExternal: false }),
    tmpDir: scratch,
    ...overrides,
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const outputs: CallToolResult[] = [];
  return {
    client,
    outputs,
    fetchCalls,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      outputs.push(result);
      return result;
    },
  };
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

function expectNoFakeSecrets(outputs: readonly CallToolResult[]) {
  const all = JSON.stringify(outputs);
  for (const value of FAKE_VALUES) expect(all).not.toContain(value);
}

const ANSWERS = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "10 EUR",
  region: "eu-central",
  uptime: "best-effort",
};

describe("createOpscrewMcpServer", () => {
  it("lists the seven planning tools with descriptions, schemas and annotations", async () => {
    const h = await connect(await fixture("static-vite"));
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of PLANNING_TOOLS) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.title).toBeTruthy();
      expect(tool?.description?.length).toBeGreaterThan(40);
      expect(tool?.inputSchema.type).toBe("object");
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("projectDir");
    }
    for (const name of [
      "opscrew_detect",
      "opscrew_interview_questions",
      "opscrew_design_options",
      "opscrew_status",
    ]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    // the scan writes its report files, so it is not read-only (but it never destroys anything)
    for (const name of ["opscrew_scan", "opscrew_save_requirements", "opscrew_select_design"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
    expect(byName.get("opscrew_select_design")?.inputSchema.required).toContain("optionId");
    expect(byName.get("opscrew_save_requirements")?.inputSchema.required).toContain("answers");
  });

  it("opscrew_scan returns counts, masked top findings and the report path", async () => {
    const dir = await fixture("lovable-supabase");
    const h = await connect(dir);
    const result = await h.call("opscrew_scan", { offline: true, top: 5 });
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data.reportPath).toBe("opscrew/SECURITY_SCAN.md");
    expect(data.counts.critical).toBeGreaterThan(0);
    expect(data.findings.length).toBeLessThanOrEqual(5);
    expect(data.findings[0].severity).toBe("critical");
    expect(data.offline).toBe(true);
    const all = await h.call("opscrew_scan", { offline: true, top: 100 });
    const ruleIds = dataOf(all).findings.map((f: { ruleId: string }) => f.ruleId);
    expect(ruleIds).toEqual(
      expect.arrayContaining(["supabase/service-role-in-client", "supabase/rls-disabled"]),
    );
    expect(textOf(result)).toContain("opscrew/SECURITY_SCAN.md");
    expect(textOf(result)).toMatch(/high or critical problems? needs? attention/);
    expect(existsSync(path.join(dir, "opscrew", "SECURITY_SCAN.md"))).toBe(true);
    expect(existsSync(path.join(dir, ".opscrew", "scan.json"))).toBe(true);
    const state = JSON.parse(await readFile(path.join(dir, ".opscrew", "state.json"), "utf8"));
    expect(state.phases.scan.status).toBe("ok");
    expect(h.fetchCalls).toEqual([]);
    const report = await readFile(path.join(dir, "opscrew", "SECURITY_SCAN.md"), "utf8");
    for (const value of FAKE_VALUES) expect(report).not.toContain(value);
    expectNoFakeSecrets(h.outputs);
  });

  it("opscrew_scan reports a clean fixture as clean", async () => {
    const h = await connect(await fixture("static-vite"));
    const result = await h.call("opscrew_scan", { offline: true });
    expect(result.isError).toBeFalsy();
    expect(dataOf(result).blockingFindings).toBe(0);
    expect(dataOf(result).warnings).toEqual([]);
    expect(textOf(result)).toContain("No high or critical problems were found.");
    expect(textOf(result)).not.toContain("Warning:");
  });

  it("opscrew_scan includes the warning when the scan stops at the file limit", async () => {
    const h = await connect(await fixture("static-vite"));
    limits.maxFiles = 2;
    const result = await h.call("opscrew_scan", { offline: true });
    expect(result.isError).toBeFalsy();
    expect(dataOf(result).warnings).toEqual([expect.stringMatching(/more than 2 files/)]);
    expect(textOf(result)).toMatch(/^Warning: .*more than 2 files.*were not checked/);
  });

  it("opscrew_detect returns the facts and writes nothing", async () => {
    const dir = await fixture("nextjs-postgres");
    const h = await connect(dir);
    const result = await h.call("opscrew_detect", { projectDir: dir });
    expect(result.isError).toBeFalsy();
    const { facts, summary } = dataOf(result);
    expect(facts.appKind).toBe("ssr");
    expect(facts.port).toBe(3000);
    expect(facts.services.map((s: { kind: string }) => s.kind)).toContain("postgres");
    expect(
      facts.envVars.find((v: { name: string }) => v.name === "DATABASE_URL").secretLikely,
    ).toBe(true);
    expect(summary).toBeTruthy();
    expect(textOf(result)).toContain("App kind: ssr");
    expect(existsSync(path.join(dir, "opscrew"))).toBe(false);
    expect(existsSync(path.join(dir, ".opscrew"))).toBe(false);
  });

  it("opscrew_interview_questions skips inferable questions and writes nothing", async () => {
    const dir = await fixture("static-vite");
    const h = await connect(dir);
    const result = await h.call("opscrew_interview_questions");
    expect(result.isError).toBeFalsy();
    const ids = dataOf(result).questions.map((q: { id: string }) => q.id);
    expect(ids).toEqual(
      expect.arrayContaining(["expectedMonthlyUsers", "budgetMonthly", "region"]),
    );
    expect(ids).not.toContain("dataCriticality");
    expect(dataOf(result).inferred.dataCriticality).toBe("none");
    expect(dataOf(result).prefilled).toBe(false);
    expect(textOf(result)).toContain("opscrew_save_requirements");
    expect(existsSync(path.join(dir, "opscrew"))).toBe(false);
  });

  it("opscrew_save_requirements writes requirements.yaml and reports invalid answers", async () => {
    const dir = await fixture("static-vite");
    const h = await connect(dir);
    const missing = await h.call("opscrew_save_requirements", {
      answers: { expectedMonthlyUsers: "<1k" },
    });
    expect(missing.isError).toBe(true);
    expect(dataOf(missing).error.code).toBe("INVALID_INPUT");
    expect(dataOf(missing).error.message).toContain("budgetMonthly");
    expect(textOf(missing)).toContain("Next step: Ask the user");

    const unknown = await h.call("opscrew_save_requirements", {
      answers: { ...ANSWERS, colour: "blue" },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("colour");

    const saved = await h.call("opscrew_save_requirements", { answers: ANSWERS });
    expect(saved.isError).toBeFalsy();
    expect(dataOf(saved).requirements.budgetMonthly).toEqual({ amount: 10, currency: "EUR" });
    expect(dataOf(saved).requirements.dataCriticality).toBe("none");
    expect(dataOf(saved).file).toBe("opscrew/requirements.yaml");
    expect(existsSync(path.join(dir, "opscrew", "requirements.yaml"))).toBe(true);

    const again = await h.call("opscrew_interview_questions");
    expect(dataOf(again).prefilled).toBe(true);
  });

  it("opscrew_design_options needs requirements, then previews options without writing", async () => {
    const dir = await fixture("static-vite");
    const h = await connect(dir);
    const early = await h.call("opscrew_design_options");
    expect(early.isError).toBe(true);
    expect(dataOf(early).error.code).toBe("PHASE_PRECONDITION");
    expect(dataOf(early).error.hint).toContain("opscrew_save_requirements");

    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const result = await h.call("opscrew_design_options");
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data.options.length).toBeGreaterThanOrEqual(2);
    expect(data.options.length).toBeLessThanOrEqual(3);
    expect(data.options.filter((o: { recommended: boolean }) => o.recommended)).toHaveLength(1);
    expect(data.priceSource).toBe("static");
    expect(data.warnings.join(" ")).toContain("HCLOUD_TOKEN");
    expect(textOf(result)).toContain("estimate");
    expect(textOf(result)).toContain(data.recommendedId);
    expect(existsSync(path.join(dir, "opscrew", "plan.yaml"))).toBe(false);
    expect(existsSync(path.join(dir, "opscrew", "architecture.json"))).toBe(false);
    const state = JSON.parse(await readFile(path.join(dir, ".opscrew", "state.json"), "utf8"));
    expect(state.phases.design).toBeUndefined();
    expect(h.fetchCalls).toEqual([]);
  });

  it("opscrew_select_design writes plan.yaml (and architecture.json when missing)", async () => {
    const dir = await fixture("nextjs-postgres");
    const h = await connect(dir);
    await h.call("opscrew_save_requirements", {
      answers: { ...ANSWERS, budgetMonthly: "30 EUR", dataCriticality: "critical" },
    });
    const options = dataOf(await h.call("opscrew_design_options"));
    const chosenId = options.options[options.options.length - 1].id;
    const result = await h.call("opscrew_select_design", { optionId: chosenId });
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data.chosen.id).toBe(chosenId);
    expect(data.planFile).toBe("opscrew/plan.yaml");
    expect(data.codeChanges.map((c: { kind: string }) => c.kind)).toContain("dockerfile");
    expect(textOf(result)).toContain("Wrote opscrew/architecture.json");
    expect(existsSync(path.join(dir, "opscrew", "plan.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, "opscrew", "architecture.json"))).toBe(true);
    const plan = await readFile(path.join(dir, "opscrew", "plan.yaml"), "utf8");
    expect(plan).toContain(data.chosen.target.serverType);

    const wrong = await h.call("opscrew_select_design", { optionId: "no-such-option" });
    expect(wrong.isError).toBe(true);
    expect(dataOf(wrong).error.code).toBe("INVALID_INPUT");
    expect(dataOf(wrong).error.hint).toContain("opscrew_design_options");
    expect(await readFile(path.join(dir, "opscrew", "plan.yaml"), "utf8")).toBe(plan);
  });

  it("opscrew_status lists phases, artefacts and the next step", async () => {
    const dir = await fixture("static-vite");
    const h = await connect(dir);
    const fresh = await h.call("opscrew_status");
    expect(fresh.isError).toBeFalsy();
    expect(dataOf(fresh).nextStep).toContain("opscrew_scan");
    expect(dataOf(fresh).artifacts.plan).toEqual({ path: "opscrew/plan.yaml", exists: false });

    await h.call("opscrew_scan", { offline: true });
    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const later = await h.call("opscrew_status");
    const data = dataOf(later);
    expect(data.phases.scan.status).toBe("ok");
    expect(data.phases.interview.status).toBe("ok");
    expect(data.artifacts.requirements.exists).toBe(true);
    expect(data.nextStep).toContain("opscrew_design_options");
    expect(textOf(later)).toMatch(/scan\s+ok/);
  });

  it("maps a bad projectDir to an isError result with a hint", async () => {
    const h = await connect(await fixture("static-vite"));
    const relative = await h.call("opscrew_detect", { projectDir: "relative/dir" });
    expect(relative.isError).toBe(true);
    expect(dataOf(relative).error.code).toBe("INVALID_INPUT");
    expect(textOf(relative)).toContain("Next step:");
    const missing = await h.call("opscrew_status", {
      projectDir: path.join(tmpdir(), "opscrew-does-not-exist-12345"),
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("does not exist");
  });

  it("runs the whole planning flow on the Lovable fixture without leaking a fake secret", async () => {
    const dir = await fixture("lovable-supabase");
    const logs: string[] = [];
    const h = await connect(dir, {
      env: { DEMO_API_TOKEN: fakeSecret("generic-password") },
      log: (message) => logs.push(message),
      // The factory hook: build PhaseDeps with the test helper, keeping the collecting reporter.
      createPhaseDeps: (projectDir, extras) =>
        createTestPhaseDeps({
          root: projectDir,
          reporter: extras.reporter,
          redactor: extras.redactor,
          clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
        }),
    });
    for (const result of [
      await h.call("opscrew_scan", { offline: true, top: 100 }),
      await h.call("opscrew_detect"),
      await h.call("opscrew_interview_questions"),
      await h.call("opscrew_save_requirements", {
        answers: {
          ...ANSWERS,
          dataCriticality: "important",
          notes: `token ${fakeSecret("generic-password")} key ${fakeSecret("supabase-service-role-jwt")}`,
        },
      }),
      await h.call("opscrew_design_options"),
    ]) {
      expect(result.isError, textOf(result)).toBeFalsy();
    }
    const options = dataOf(h.outputs[h.outputs.length - 1] as CallToolResult);
    const selected = await h.call("opscrew_select_design", { optionId: options.recommendedId });
    expect(selected.isError, textOf(selected)).toBeFalsy();
    const status = await h.call("opscrew_status");
    expect(dataOf(status).phases.design.status).toBe("ok");
    expect(dataOf(h.outputs[1] as CallToolResult).facts.platformExport.platform).toBe("lovable");

    expectNoFakeSecrets(h.outputs);
    // A value from a secret-named env var is redacted even where no pattern rule matches it.
    expect(JSON.stringify(h.outputs)).not.toContain(fakeSecret("generic-password"));
    expect(textOf(h.outputs[3] as CallToolResult)).toContain("Saved opscrew/requirements.yaml");
    expect(logs.join("\n")).not.toContain(fakeSecret("generic-password"));
    for (const file of ["opscrew/plan.yaml", ".opscrew/scan.json", "opscrew/SECURITY_SCAN.md"]) {
      const text = await readFile(path.join(dir, file), "utf8");
      for (const value of FAKE_VALUES) expect(text, file).not.toContain(value);
    }
  });
});
