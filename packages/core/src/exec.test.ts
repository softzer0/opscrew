import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsCrewError } from "./errors";
import { findExecutable, NodeCommandRunner } from "./exec";

const node = process.execPath;
const isWindows = process.platform === "win32";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "opscrew-exec-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe("NodeCommandRunner", () => {
  const runner = new NodeCommandRunner();

  it("captures stdout, stderr and the exit code", async () => {
    const result = await runner.run(node, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 0",
    ]);
    expect(result).toEqual({ exitCode: 0, stdout: "out", stderr: "err" });
  });

  it("resolves non-zero exit codes instead of rejecting", async () => {
    const result = await runner.run(node, ["-e", "process.exit(3)"]);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBeUndefined();
  });

  it("passes arguments verbatim without a shell", async () => {
    const tricky = ["a b", "$(whoami)", "x;y", "&&", '"quoted"', "%PATH%"];
    const result = await runner.run(node, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...tricky,
    ]);
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it("uses cwd, env and input", async () => {
    const result = await runner.run(
      node,
      [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({cwd:process.cwd(),v:process.env.OPSCREW_TEST_VAR,u:'OPSCREW_UNSET' in process.env,d})))",
      ],
      {
        cwd: tmp,
        env: { ...process.env, OPSCREW_TEST_VAR: "hello", OPSCREW_UNSET: undefined },
        input: "piped input",
      },
    );
    const parsed = JSON.parse(result.stdout) as { cwd: string; v: string; u: boolean; d: string };
    expect(path.resolve(parsed.cwd).toLowerCase()).toBe(path.resolve(tmp).toLowerCase());
    expect(parsed.v).toBe("hello");
    expect(parsed.u).toBe(false);
    expect(parsed.d).toBe("piped input");
  });

  it("streams complete lines to onLine", async () => {
    const lines: Array<[string, string]> = [];
    const result = await runner.run(
      node,
      [
        "-e",
        "process.stdout.write('one\\r\\ntw'); setTimeout(()=>{process.stdout.write('o\\nthree'); process.stderr.write('warn\\n')}, 20)",
      ],
      { onLine: (line, stream) => lines.push([line, stream]) },
    );
    expect(result.stdout).toBe("one\r\ntwo\nthree");
    expect(lines.filter(([, s]) => s === "stdout").map(([l]) => l)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(lines.filter(([, s]) => s === "stderr").map(([l]) => l)).toEqual(["warn"]);
  });

  it("truncates output beyond maxOutputBytes", async () => {
    const small = new NodeCommandRunner({ maxOutputBytes: 1024 });
    const result = await small.run(node, ["-e", "process.stdout.write('x'.repeat(100000))"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("x".repeat(1024))).toBe(true);
    expect(result.stdout).toContain("[output truncated]");
    expect(result.stdout.length).toBeLessThan(1100);
  });

  it("lets one call raise the output limit, leaving the runner's default for the others", async () => {
    const small = new NodeCommandRunner({ maxOutputBytes: 1024 });
    const print = ["-e", "process.stdout.write('x'.repeat(100000))"];
    const lifted = await small.run(node, print, { maxOutputBytes: 200_000 });
    expect(lifted.stdout).toBe("x".repeat(100000));
    const capped = await small.run(node, print);
    expect(capped.stdout).toContain("[output truncated]");
  });

  it("kills the process tree on timeout and reports exit code 124", async () => {
    // The child starts a grandchild that would live forever, prints its pid, then hangs.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(g.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const started = Date.now();
    const result = await runner.run(node, ["-e", script], { timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitFor(() => !isAlive(grandchild), 5000)).toBe(true);
  }, 20_000);

  it("uses defaultTimeoutMs when no timeout is given", async () => {
    const quick = new NodeCommandRunner({ defaultTimeoutMs: 500 });
    const result = await quick.run(node, ["-e", "setInterval(() => {}, 1000)"]);
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
  }, 15_000);

  it("aborts via AbortSignal", async () => {
    const controller = new AbortController();
    const promise = runner.run(node, ["-e", "setInterval(() => {}, 1000)"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  }, 15_000);

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run(node, ["-e", ""], { signal: controller.signal })).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });

  it("reports a missing binary as a user-facing COMMAND_FAILED error", async () => {
    const error = await runner.run("opscrew-definitely-not-installed-xyz", ["--version"]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    const opsError = error as OpsCrewError;
    expect(opsError.code).toBe("COMMAND_FAILED");
    expect(opsError.message).toBe(
      "Could not run opscrew-definitely-not-installed-xyz: it is not installed or not on PATH.",
    );
    expect(opsError.hint).toBeTruthy();
  });
});

describe("findExecutable", () => {
  it("finds node on a PATH that contains its directory", () => {
    const env = { PATH: path.dirname(node), PATHEXT: ".EXE;.CMD;.BAT" };
    const found = findExecutable("node", env);
    expect(found).toBeDefined();
    expect(found?.toLowerCase()).toBe(node.toLowerCase());
  });

  it("returns undefined when the binary is not on PATH", () => {
    expect(findExecutable("opscrew-definitely-not-installed-xyz", { PATH: tmp })).toBeUndefined();
    expect(findExecutable("node", {})).toBeUndefined();
  });

  it("returns an absolute path for an explicit path that exists", () => {
    expect(findExecutable(node, {})?.toLowerCase()).toBe(node.toLowerCase());
  });

  it.runIf(isWindows)("uses PATHEXT on Windows and a case-insensitive Path key", async () => {
    const dir = path.join(tmp, "bin dir");
    await mkdir(dir);
    await writeFile(path.join(dir, "mytool.cmd"), "@echo off\r\n");
    expect(findExecutable("mytool", { Path: `"${dir}"`, PATHEXT: ".COM;.CMD" })).toBe(
      path.join(dir, "mytool.cmd"),
    );
    // default PATHEXT is .EXE;.CMD;.BAT
    expect(findExecutable("mytool", { Path: dir })).toBe(path.join(dir, "mytool.cmd"));
    expect(findExecutable("mytool", { Path: dir, PATHEXT: ".EXE" })).toBeUndefined();
  });

  it.runIf(!isWindows)("requires the execute bit on POSIX", async () => {
    const file = path.join(tmp, "mytool");
    await writeFile(file, "#!/bin/sh\n");
    expect(findExecutable("mytool", { PATH: tmp })).toBeUndefined();
    await chmod(file, 0o755);
    expect(findExecutable("mytool", { PATH: `/nonexistent${path.delimiter}${tmp}` })).toBe(file);
  });
});
