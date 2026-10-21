import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpsCrewError, ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { version } from "../package.json";
import { ALL_COMMANDS } from "./commands/index";
import { createProgram, main, runProgram } from "./program";
import { createTestContext, type TestContext } from "./test-context";

const argv = (...args: string[]) => ["node", "opscrew", ...args];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew cli "));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("opscrew program", () => {
  it("prints the version and exits 0", async () => {
    const ctx = createTestContext({ version });
    expect(await main(argv("--version"), ctx)).toBe(0);
    expect(ctx.output.trim()).toBe(version);
  });

  it("prints help with the brand line and every command", async () => {
    const ctx = createTestContext();
    expect(await main(argv("--help"), ctx)).toBe(0);
    expect(ctx.output).toContain("Usage: opscrew");
    expect(ctx.output).toContain("OpsCrew");
    expect(ctx.output).toContain("--cwd <dir>");
    for (const name of [
      "init",
      "scan",
      "analyze",
      "interview",
      "design",
      "adapt",
      "provision",
      "dns",
      "domain",
      "secure",
      "verify",
      "drift",
      "portainer",
      "retarget",
      "destroy",
      "mcp",
      "status",
      "secrets",
    ]) {
      expect(ctx.output).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
    }
    expect(ALL_COMMANDS).toHaveLength(18);
  });

  it("exits 2 for an unknown command", async () => {
    const ctx = createTestContext();
    expect(await main(argv("nope"), ctx)).toBe(2);
    expect(ctx.errors).toContain("unknown command");
  });
});

describe("opscrew status", () => {
  it("says no phases have run in a fresh directory", async () => {
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toBe("No phases have run yet. Start with `opscrew scan`.\n");
  });

  it("lists recorded phases with status and time", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    const clock = { now: () => new Date("2026-10-11T08:30:00.000Z") };
    const store = new ProjectStateStore(paths.files.state, clock);
    await store.markPhase("scan", "ok", "2 findings");
    await store.markPhase("analyze", "failed");

    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toMatch(/scan\s+ok\s+2026-10-11T08:30:00.000Z\s+2 findings/);
    expect(ctx.output).toMatch(/analyze\s+failed\s+2026-10-11T08:30:00.000Z/);
    expect(ctx.output).toMatch(/design\s+not run/);
    // A move and the Portainer add-on are rows only once they ran.
    expect(ctx.output).not.toMatch(/retarget\s+not run/);
    expect(ctx.output).not.toMatch(/portainer\s+not run/);

    await store.markPhase("portainer", "ok", "on");
    const later = createTestContext({ cwd: dir });
    expect(await main(argv("status"), later)).toBe(0);
    expect(later.output).toMatch(/portainer\s+ok\s+2026-10-11T08:30:00.000Z\s+on/);
    expect(later.output).not.toMatch(/retarget\s+not run/);
  });

  it("honours the global --cwd option", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    await new ProjectStateStore(paths.files.state).markPhase("scan", "ok");
    const ctx = createTestContext({ cwd: tmpdir() });
    expect(await main(argv("--cwd", dir, "status"), ctx)).toBe(0);
    expect(ctx.output).toMatch(/scan\s+ok/);
  });
});

describe("error mapping", () => {
  const withFailingCommands = (ctx: TestContext) => {
    const program = createProgram(ctx);
    program.command("boom").action(() => {
      throw new OpsCrewError("INVALID_INPUT", "That input is wrong.", {
        hint: "Pass a valid value.",
      });
    });
    program.command("crash").action(() => {
      throw new Error("kaboom");
    });
    return program;
  };

  it("prints a user-facing error and its hint without a stack trace, exit 2", async () => {
    const ctx = createTestContext();
    expect(await runProgram(withFailingCommands(ctx), argv("boom"), ctx)).toBe(2);
    expect(ctx.errors).toBe("✗ That input is wrong.\n  Pass a valid value.\n");
  });

  it("reports unexpected errors without a stack trace unless OPSCREW_DEBUG=1", async () => {
    const quiet = createTestContext();
    expect(await runProgram(withFailingCommands(quiet), argv("crash"), quiet)).toBe(2);
    expect(quiet.errors).toContain("✗ Something went wrong: kaboom");
    expect(quiet.errors).toContain("OPSCREW_DEBUG=1");
    expect(quiet.errors).not.toMatch(/\n\s+at /);

    const debug = createTestContext({ env: { OPSCREW_DEBUG: "1" } });
    expect(await runProgram(withFailingCommands(debug), argv("boom"), debug)).toBe(2);
    expect(await runProgram(withFailingCommands(debug), argv("crash"), debug)).toBe(2);
    expect(debug.errors).toMatch(/\n\s+at /);
  });

  it("maps an invalid state file to a plain-English error", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    await new ProjectStateStore(paths.files.state).markPhase("scan", "ok");
    await writeFile(paths.files.state, "{not json");
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(2);
    expect(ctx.errors).toContain("is not a valid OpsCrew state file.");
    expect(ctx.errors).toContain("Delete the file to reset");
  });

  it("redacts secrets in error output", async () => {
    const ctx = createTestContext();
    const secret = `value-${"x".repeat(24)}`;
    ctx.redactor.addLiteral(secret, "HCLOUD_TOKEN");
    const program = createProgram(ctx);
    program.command("leak").action(() => {
      throw new OpsCrewError("PROVIDER_ERROR", `Token ${secret} was rejected.`);
    });
    expect(await runProgram(program, argv("leak"), ctx)).toBe(2);
    expect(ctx.errors).not.toContain(secret);
    expect(ctx.errors).toContain("HCLOUD_TOKEN");
  });
});
