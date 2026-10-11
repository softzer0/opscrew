import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { FakeAgentRuntime, fakeSecret } from "@opscrew/core/testing";
import { ClaudeAgentRuntime } from "@opscrew/runtime-claude";
import { describe, expect, it } from "vitest";
import { createPhaseDeps, modelOption, promptsOf, servicesOf, withServices } from "./deps";
import { createTestContext } from "./test-context";
import { clackPrompts } from "./ui/prompts";

const root = path.resolve("project-root");
const home = path.resolve("opscrew-home");

describe("createPhaseDeps", () => {
  it("builds paths, stores and defaults from the context", () => {
    const ctx = createTestContext({ cwd: root, env: { OPSCREW_HOME: home } });
    const deps = createPhaseDeps(ctx);
    expect(deps.paths.root).toBe(root);
    expect(deps.paths.homeDir).toBe(home);
    expect(deps.runner).toBeInstanceOf(NodeCommandRunner);
    expect(typeof deps.fetch).toBe("function");
    expect(deps.reporter).toBe(ctx.reporter);
    expect(deps.redactor).toBe(ctx.redactor);
    expect(deps.version).toBe(ctx.version);
    expect(deps.interactive).toBe(false);
    expect(deps.runtime).toBeUndefined();
  });

  it("registers the environment's secrets with the redactor", () => {
    const token = fakeSecret("hcloud-token");
    const ctx = createTestContext({ cwd: root, env: { HCLOUD_TOKEN: token } });
    const deps = createPhaseDeps(ctx);
    expect(deps.redactor.redact(`token ${token}`)).not.toContain(token);
  });

  it("adds the Claude runtime only when credentials exist and --no-ai is not given", () => {
    const env = { OPSCREW_HOME: home, ANTHROPIC_API_KEY: fakeSecret("anthropic-key") };
    const ctx = createTestContext({ cwd: root, env });
    expect(createPhaseDeps(ctx).runtime).toBeInstanceOf(ClaudeAgentRuntime);
    expect(createPhaseDeps(ctx, { ai: false }).runtime).toBeUndefined();
    const bedrock = createTestContext({ cwd: root, env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
    expect(createPhaseDeps(bedrock).runtime).toBeInstanceOf(ClaudeAgentRuntime);
  });

  it("uses attached services, but never a runtime with --no-ai", async () => {
    const runtime = new FakeAgentRuntime();
    const clock = { now: () => new Date("2026-10-11T00:00:00.000Z") };
    const ctx = withServices(createTestContext({ cwd: root, env: { OPSCREW_HOME: home } }), {
      runtime,
      clock,
    });
    expect(createPhaseDeps(ctx).runtime).toBe(runtime);
    expect(createPhaseDeps(ctx).clock).toBe(clock);
    expect(createPhaseDeps(ctx, { ai: false }).runtime).toBeUndefined();
    expect(servicesOf(createTestContext())).toEqual({});
    expect(promptsOf(createTestContext())).toBe(clackPrompts);
  });

  it("refuses non-plan approvals without a terminal and records them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-deps-"));
    try {
      const ctx = createTestContext({
        cwd: path.join(dir, "app"),
        env: { OPSCREW_HOME: path.join(dir, "home") },
      });
      const deps = createPhaseDeps(ctx, { approvePlanHash: "a".repeat(64) });
      const record = await deps.approvals.request({
        kind: "repo-write",
        title: "Commit 2 files",
        details: "",
      });
      expect(record.approved).toBe(false);
      expect(record.reason).toContain("needs a human approval");
      const apply = await deps.approvals.request({
        kind: "iac-apply",
        title: "Apply the plan",
        details: "",
        planHash: "A".repeat(64),
      });
      expect(apply.approved).toBe(true);
      const stored = await readFile(deps.paths.files.approvals, "utf8");
      expect(stored).toContain("Commit 2 files");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("modelOption", () => {
  it("prefers --model, then OPSCREW_MODEL", () => {
    const ctx = createTestContext({ env: { OPSCREW_MODEL: "from-env" } });
    expect(modelOption(ctx, "flag")).toBe("flag");
    expect(modelOption(ctx, undefined)).toBe("from-env");
    expect(modelOption(createTestContext(), " ")).toBeUndefined();
  });
});
