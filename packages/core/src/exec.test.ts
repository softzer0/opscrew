import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsCrewError } from "./errors";
import { findExecutable, NodeCommandRunner, nodeShimScript } from "./exec";

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

/** `npm.cmd` as the Node.js installer writes it. */
const NODE_INSTALLER_NPM_CMD = String.raw`:: Created by npm, please don't edit manually.
@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "NPM_PREFIX_JS=%~dp0\node_modules\npm\bin\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\node_modules\npm\bin\npm-cli.js"
)
IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (
  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"
)

"%NODE_EXE%" "%NPM_CLI_JS%" %*
`.replaceAll("\n", "\r\n");

/** A shim as npm's `cmd-shim` writes it for a global package (`pnpm.cmd`, `yarn.cmd`...). */
function cmdShim(entry: string): string {
  return String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\ENTRY" %*
`
    .replace("ENTRY", entry)
    .replaceAll("\n", "\r\n");
}

describe("nodeShimScript", () => {
  const dir = path.resolve("shim-dir");

  it("finds npm's script in the Node.js installer's npm.cmd", () => {
    expect(nodeShimScript(NODE_INSTALLER_NPM_CMD, dir)).toBe(
      path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    );
  });

  it("finds the script of a cmd-shim", () => {
    expect(nodeShimScript(cmdShim(String.raw`node_modules\pnpm\bin\pnpm.cjs`), dir)).toBe(
      path.join(dir, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    );
  });

  it("finds nothing in a batch file that does not start a Node.js script", () => {
    expect(nodeShimScript(String.raw`"%~dp0\tool.exe" "%~dp0\x.js" %*`, dir)).toBeUndefined();
    expect(nodeShimScript(String.raw`"%~dp0\node.exe" "%~dp0\x.py" %*`, dir)).toBeUndefined();
    expect(nodeShimScript("@echo off\r\necho hello\r\n", dir)).toBeUndefined();
  });

  it("gives up on variables that keep doubling", () => {
    const doubling = Array.from({ length: 40 }, (_, i) => `SET "V${i + 1}=%V${i}%%V${i}%"`);
    const shim = [`SET "V0=%~dp0\\x"`, ...doubling, `"%~dp0\\node.exe" "%V40%.js" %*`].join("\r\n");
    expect(nodeShimScript(shim, dir)).toBeUndefined();
  });
});

describe.runIf(isWindows)("NodeCommandRunner with Windows command shims", () => {
  const runner = new NodeCommandRunner({ defaultTimeoutMs: 20_000 });

  it("starts a Node.js shim's script with the arguments unchanged, through no shell", async () => {
    const bin = path.join(tmp, "bin dir");
    await mkdir(path.join(bin, "node_modules", "tool"), { recursive: true });
    await writeFile(
      path.join(bin, "node_modules", "tool", "cli.js"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    await writeFile(path.join(bin, "tool.cmd"), cmdShim(String.raw`node_modules\tool\cli.js`));
    // What cmd.exe would read as a second command, a variable or an escape.
    const args = ["a b", "x & echo injected", '"quoted"', "%PATH%", "^caret", "a|b", "back\\"];
    const result = await runner.run(path.join(bin, "tool.cmd"), args);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("refuses a batch file that is not a Node.js shim, without running it", async () => {
    const shim = path.join(tmp, "other.bat");
    await writeFile(shim, "@echo off\r\necho ran > ran.txt\r\n");
    const error = await runner.run(shim, [], { cwd: tmp }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("COMMAND_FAILED");
    expect((error as OpsCrewError).message).toBe(
      `Could not run ${shim}: on Windows OpsCrew starts programs, and Node.js command shims by their full path; this batch file is neither.`,
    );
  });

  it("refuses a Node.js shim given by a relative path", async () => {
    await mkdir(path.join(tmp, "node_modules", "tool"), { recursive: true });
    await writeFile(path.join(tmp, "node_modules", "tool", "cli.js"), "");
    await writeFile(path.join(tmp, "tool.cmd"), cmdShim(String.raw`node_modules\tool\cli.js`));
    const error = await runner.run("tool.cmd", [], { cwd: tmp }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as OpsCrewError).message).toContain("this batch file is neither");
  });

  const npm = findExecutable("npm");
  it.runIf(npm !== undefined)("runs this computer's npm through its npm.cmd", async () => {
    const result = await runner.run(npm as string, ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
