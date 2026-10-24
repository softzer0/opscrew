import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CommandOptions, CommandResult, CommandRunner, Reporter } from "@opscrew/contracts";
import { DefaultToolPolicy, MemoryAuditLog } from "@opscrew/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAgentSdkOptions, QueryFn } from "./index";

// Counts every load of the real SDK module: nothing may load it before a phase runs.
const sdkLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  sdkLoads.count += 1;
  return importOriginal();
});

const SDK = "@anthropic-ai/claude-agent-sdk";

let tmp: string;
let homeDir: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "opscrew-sdk-"));
  homeDir = path.join(tmp, "home", ".opscrew");
  // A stand-in npm on PATH: the fake runner never starts it.
  const bin = path.join(tmp, "bin");
  await mkdir(bin);
  const npm = path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  await writeFile(npm, "");
  await chmod(npm, 0o755);
  env = { PATH: bin, PATHEXT: ".EXE;.CMD" };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "All done.",
  total_cost_usd: 0,
  session_id: "session-1",
} as unknown as SDKMessage;

const fakeQuery: QueryFn = () =>
  (async function* () {
    yield success;
  })();

/** Records npm's runs and writes the package npm would install (`version`). */
class FakeNpm implements CommandRunner {
  readonly runs: { command: string; args: string[] }[] = [];
  constructor(
    private readonly version: string,
    private readonly exitCode = 0,
  ) {}
  async run(
    command: string,
    args: readonly string[],
    _options?: CommandOptions,
  ): Promise<CommandResult> {
    this.runs.push({ command, args: [...args] });
    if (this.exitCode !== 0) return { exitCode: this.exitCode, stdout: "", stderr: NPM_E404 };
    const prefix = args[args.indexOf("--prefix") + 1] as string;
    await writeInstalled(prefix, this.version);
    return { exitCode: 0, stdout: "added 12 packages", stderr: "" };
  }
}

/** What npm 10 prints when the package is not found: the cause first, the log file last. */
const NPM_E404 = [
  "npm error code E404",
  `npm error 404 Not Found - GET https://registry.npmjs.org/${SDK} - Not found`,
  "npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/debug-0.log",
  "",
].join("\n");

/** Writes the SDK as npm installs it, with this computer's Claude Code binary unless `binary` is false. */
async function writeInstalled(prefix: string, version: string, binary = true): Promise<void> {
  const modules = path.join(prefix, "node_modules", "@anthropic-ai");
  const dir = path.join(modules, "claude-agent-sdk");
  await mkdir(dir, { recursive: true });
  const manifest = { name: SDK, version, exports: { ".": { default: "./sdk.mjs" } } };
  await writeFile(path.join(dir, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "sdk.mjs"), "export const query = () => {};\n");
  if (!binary) return;
  const platform = path.join(modules, `claude-agent-sdk-${process.platform}-${process.arch}`);
  await mkdir(platform, { recursive: true });
  await writeFile(path.join(platform, "package.json"), JSON.stringify({ version }));
  await writeFile(path.join(platform, process.platform === "win32" ? "claude.exe" : "claude"), "");
}

/** An importer where the SDK does not resolve by name; file URLs load the fake SDK. */
function importer() {
  const specifiers: string[] = [];
  const importModule = async (specifier: string) => {
    specifiers.push(specifier);
    if (specifier.startsWith("file:")) return { query: fakeQuery };
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
  return { specifiers, importModule };
}

function reporter(): Reporter & { lines: string[] } {
  const lines: string[] = [];
  const log = (message: string) => void lines.push(message);
  return { lines, step: log, info: log, success: log, warn: log, error: log };
}

async function runtimeWith(sdk: Partial<ClaudeAgentSdkOptions> & { runner: CommandRunner }) {
  const { ClaudeAgentRuntime } = await import("./index");
  return new ClaudeAgentRuntime({
    policy: new DefaultToolPolicy(),
    audit: new MemoryAuditLog(),
    redact: (text) => text,
    env,
    sdk: { homeDir, reporter: reporter(), ...sdk },
  });
}

const phase = {
  phase: "analyze",
  systemPrompt: "You are the Analyst.",
  prompt: "Describe this repository.",
  projectRoot: path.resolve("opscrew-test-project"),
  profile: "read-only",
} as const;

describe("the Claude Agent SDK on demand", () => {
  it("is not loaded by importing the runtime or building it", async () => {
    const { ClaudeAgentRuntime, CLAUDE_AGENT_SDK_VERSION } = await import("./index");
    const runtime = new ClaudeAgentRuntime({
      policy: new DefaultToolPolicy(),
      audit: new MemoryAuditLog(),
      redact: (text) => text,
      env,
      sdk: { homeDir, runner: new FakeNpm(CLAUDE_AGENT_SDK_VERSION), reporter: reporter() },
    });
    await runtime.isConfigured();
    expect(sdkLoads.count).toBe(0);
  });

  it("is pinned to the exact version the package is built with", async () => {
    const { CLAUDE_AGENT_SDK_VERSION } = await import("./index");
    expect(CLAUDE_AGENT_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const installed = new URL(
      "../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      import.meta.url,
    );
    const { version } = JSON.parse(await readFile(installed, "utf8")) as { version: string };
    expect(version).toBe(CLAUDE_AGENT_SDK_VERSION);
  });

  it("uses a copy Node.js resolves, without installing", async () => {
    const runner = new FakeNpm("0.0.0");
    const specifiers: string[] = [];
    const runtime = await runtimeWith({
      runner,
      importModule: async (specifier) => {
        specifiers.push(specifier);
        return { query: fakeQuery };
      },
      confirmInstall: async () => {
        throw new Error("must not ask");
      },
    });
    const result = await runtime.runPhase(phase);
    expect(result).toMatchObject({ ok: true, text: "All done." });
    expect(specifiers).toEqual([SDK]);
    expect(runner.runs).toEqual([]);
  });

  it("asks, installs that version into OpsCrew's folder through the runner, and loads it", async () => {
    const { CLAUDE_AGENT_SDK_VERSION } = await import("./index");
    const runner = new FakeNpm(CLAUDE_AGENT_SDK_VERSION);
    const { specifiers, importModule } = importer();
    const questions: string[] = [];
    const progress = reporter();
    const runtime = await runtimeWith({
      runner,
      importModule,
      reporter: progress,
      confirmInstall: async (question) => {
        questions.push(question);
        return true;
      },
    });

    const result = await runtime.runPhase(phase);
    expect(result).toMatchObject({ ok: true, text: "All done." });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("about 300 MB, once");
    const dir = path.join(homeDir, "claude-agent-sdk");
    expect(runner.runs).toEqual([
      {
        command: path.join(tmp, "bin", process.platform === "win32" ? "npm.cmd" : "npm"),
        args: [
          "install",
          "--prefix",
          dir,
          "--ignore-scripts",
          `${SDK}@${CLAUDE_AGENT_SDK_VERSION}`,
        ],
      },
    ]);
    expect(specifiers[1]).toMatch(/^file:.*claude-agent-sdk\/sdk\.mjs$/);
    expect(progress.lines.join("\n")).toContain("Installed the Claude Agent SDK.");

    // A second phase of the run loads nothing again.
    await runtime.runPhase(phase);
    expect(specifiers).toHaveLength(2);
  });

  it("reuses the install on a later run, and installs again over another version", async () => {
    const { CLAUDE_AGENT_SDK_VERSION } = await import("./index");
    const dir = path.join(homeDir, "claude-agent-sdk");
    await writeInstalled(dir, CLAUDE_AGENT_SDK_VERSION);
    const later = new FakeNpm(CLAUDE_AGENT_SDK_VERSION);
    const reused = await runtimeWith({ runner: later, importModule: importer().importModule });
    expect((await reused.runPhase(phase)).ok).toBe(true);
    expect(later.runs).toEqual([]);

    await writeInstalled(dir, "0.0.1");
    const questions: string[] = [];
    const upgrade = new FakeNpm(CLAUDE_AGENT_SDK_VERSION);
    const upgraded = await runtimeWith({
      runner: upgrade,
      importModule: importer().importModule,
      confirmInstall: async (question) => {
        questions.push(question);
        return true;
      },
    });
    expect((await upgraded.runPhase(phase)).ok).toBe(true);
    expect(upgrade.runs).toHaveLength(1);
    expect(questions[0]).toContain(
      `the Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION}, and the copy in ${dir} is version 0.0.1.`,
    );
    expect(questions[0]).not.toContain("not installed yet");
  });

  it("asks to install again over a copy without its Claude Code binary", async () => {
    const { CLAUDE_AGENT_SDK_VERSION } = await import("./index");
    // What npm leaves, exiting 0, when the binary's package failed: only the main package.
    await writeInstalled(path.join(homeDir, "claude-agent-sdk"), CLAUDE_AGENT_SDK_VERSION, false);
    const questions: string[] = [];
    const runner = new FakeNpm(CLAUDE_AGENT_SDK_VERSION);
    const runtime = await runtimeWith({
      runner,
      importModule: importer().importModule,
      confirmInstall: async (question) => {
        questions.push(question);
        return true;
      },
    });
    expect((await runtime.runPhase(phase)).ok).toBe(true);
    expect(questions[0]).toContain("has no Claude Code binary for this computer");
    expect(runner.runs).toHaveLength(1);
  });

  it("stops with the install command when the user says no", async () => {
    const { CLAUDE_AGENT_SDK_VERSION } = await import("./index");
    const runner = new FakeNpm(CLAUDE_AGENT_SDK_VERSION);
    const runtime = await runtimeWith({
      runner,
      importModule: importer().importModule,
      confirmInstall: async () => false,
    });
    const result = await runtime.runPhase(phase);
    expect(result).toMatchObject({ ok: false, stopReason: "error" });
    const dir = path.join(homeDir, "claude-agent-sdk");
    expect(result.error).toContain(
      `npm install --prefix "${dir}" --ignore-scripts ${SDK}@${CLAUDE_AGENT_SDK_VERSION}`,
    );
    expect(runner.runs).toEqual([]);
  });

  it("stops with the install command when nobody can answer", async () => {
    const runner = new FakeNpm("0.0.0");
    const runtime = await runtimeWith({ runner, importModule: importer().importModule });
    const result = await runtime.runPhase(phase);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/about 300 MB, once.*Install it with `npm install --prefix/);
    expect(runner.runs).toEqual([]);
  });

  it("explains a failed install", async () => {
    const runner = new FakeNpm("0.0.0", 1);
    const runtime = await runtimeWith({
      runner,
      importModule: importer().importModule,
      confirmInstall: async () => true,
    });
    const result = await runtime.runPhase(phase);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      "npm could not install the Claude Agent SDK (npm error code E404).",
    );
  });
});
