import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { CLAUDE_AGENT_SDK_VERSION, ClaudeAgentRuntime } from "@opscrew/runtime-claude";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import { createPhaseDeps, sdkInstallConsent, withServices } from "./deps";
import { main } from "./program";
import { createTestContext } from "./test-context";
import type { UiPrompts } from "./ui/prompts";

// Counts every load of the Claude Agent SDK: commands without an AI step never load it.
const sdkLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  sdkLoads.count += 1;
  return importOriginal();
});

const SDK = "@anthropic-ai/claude-agent-sdk";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-sdk-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function confirmPrompts(answer: boolean | symbol, questions: string[]): UiPrompts {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected prompt");
  };
  return {
    select: unused,
    multiselect: unused,
    text: unused,
    password: unused,
    confirm: async ({ message }) => {
      questions.push(message);
      return answer;
    },
    isCancel: (value): value is symbol => typeof value === "symbol",
  };
}

describe("the Claude Agent SDK in the opscrew package", () => {
  it("is an optional peer pinned to the runtime's exact version, not a dependency", () => {
    const manifest = pkg as typeof pkg & {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain(SDK);
    expect(Object.keys(manifest.dependencies)).not.toContain("@anthropic-ai/sdk");
    expect(manifest.peerDependencies[SDK]).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(manifest.peerDependenciesMeta[SDK]?.optional).toBe(true);
    expect(manifest.devDependencies[SDK]).toBe(CLAUDE_AGENT_SDK_VERSION);
  });

  it("is not loaded by scan, --no-ai runs or a runtime that has not run a phase", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
    const env = {
      OPSCREW_HOME: path.join(dir, "home"),
      ANTHROPIC_API_KEY: fakeSecret("anthropic-key"),
    };
    const ctx = createTestContext({ cwd: dir, env });
    await main(["node", "opscrew", "scan", "--offline"], ctx);
    await main(["node", "opscrew", "analyze", "--no-ai"], ctx);
    expect(createPhaseDeps(ctx).runtime).toBeInstanceOf(ClaudeAgentRuntime);
    expect(ctx.output).toContain("SECURITY_SCAN.md");
    expect(sdkLoads.count).toBe(0);
  });
});

describe("sdkInstallConsent", () => {
  it("goes ahead with --yes, without asking", async () => {
    const questions: string[] = [];
    const ctx = withServices(createTestContext({ isInteractive: true }), {
      prompts: confirmPrompts(false, questions),
    });
    expect(await sdkInstallConsent(ctx, true)?.("Download?")).toBe(true);
    expect(questions).toEqual([]);
  });

  it("asks in a terminal, and a cancel is a no", async () => {
    const questions: string[] = [];
    const yes = withServices(createTestContext({ isInteractive: true }), {
      prompts: confirmPrompts(true, questions),
    });
    expect(await sdkInstallConsent(yes, false)?.("Download (about 300 MB, once)?")).toBe(true);
    expect(questions).toEqual(["Download (about 300 MB, once)?"]);
    const cancel = withServices(createTestContext({ isInteractive: true }), {
      prompts: confirmPrompts(Symbol("cancel"), []),
    });
    expect(await sdkInstallConsent(cancel, false)?.("Download?")).toBe(false);
  });

  it("has nobody to ask without a terminal or --yes", () => {
    expect(sdkInstallConsent(createTestContext(), false)).toBeUndefined();
  });
});
