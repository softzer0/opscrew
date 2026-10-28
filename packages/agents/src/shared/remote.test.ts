import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandOptions, CommandRunner } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedRunner } from "../testing";
import {
  MAX_INLINE_COMMAND_BYTES,
  remoteInvocation,
  SshRemoteExec,
  sshArgs,
  stdinBootstrap,
} from "./remote";

const target = { host: "203.0.113.10", keyFile: "k", knownHostsFile: "kh" };

/** A multi-line command longer than the inline limit, with non-ASCII text in it. */
function longCommand(body: string): string {
  const padding = Array.from({ length: 60 }, (_, i) => `# Zeile ${i}: Grüße, naïve café — ✓`);
  return [body, ...padding, "exit 7"].join("\n");
}

describe("remoteInvocation", () => {
  it("keeps short single-line commands exactly as they are", () => {
    expect(remoteInvocation("uptime")).toEqual({ command: "uptime" });
    expect(remoteInvocation("cat > /tmp/x", "value\n")).toEqual({
      command: "cat > /tmp/x",
      input: "value\n",
    });
    const atLimit = "x".repeat(MAX_INLINE_COMMAND_BYTES);
    expect(remoteInvocation(atLimit)).toEqual({ command: atLimit });
  });

  it("sends long commands over stdin behind a fixed bootstrap, counting UTF-8 bytes", () => {
    const command = longCommand("echo hello");
    const bytes = Buffer.byteLength(command, "utf8");
    expect(bytes).toBeGreaterThan(command.length);
    expect(remoteInvocation(command)).toEqual({ command: stdinBootstrap(bytes), input: command });
    const secret = fakeSecret("generic-password");
    expect(remoteInvocation(command, `${secret}\n`)).toEqual({
      command: stdinBootstrap(bytes),
      input: `${command}${secret}\n`,
    });
  });

  it("counts bytes, not characters, against the limit", () => {
    const command = "é".repeat(1_001); // 1,001 characters, 2,002 bytes
    expect(remoteInvocation(command).command).toBe(stdinBootstrap(2_002));
  });

  it("sends any command with a newline over stdin", () => {
    const command = "echo one\necho two";
    expect(remoteInvocation(command)).toEqual({
      command: stdinBootstrap(Buffer.byteLength(command)),
      input: command,
    });
  });

  it("uses this exact bootstrap", () => {
    expect(stdinBootstrap(1234)).toBe(
      "umask 077; f=$(mktemp) || exit 125; trap 'rm -f \"$f\"' EXIT HUP INT TERM; " +
        'dd bs=1 count=1234 of="$f" 2>/dev/null; ' +
        '[ $(wc -c < "$f") -eq 1234 ] || ' +
        '{ echo "opscrew: the command did not arrive in full" >&2; exit 125; }; ' +
        'sh "$f"; exit $?',
    );
    expect(Buffer.byteLength(stdinBootstrap(10_000_000))).toBeLessThan(300);
  });
});

describe("SshRemoteExec with long commands", () => {
  it("passes the bootstrap as the last ssh argument and the command on stdin", async () => {
    const runner = new ScriptedRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const remote = new SshRemoteExec({ ...target, runner });
    const secret = fakeSecret("generic-password");
    const command = longCommand("IFS= read -r s");
    await remote.run(command, { input: `${secret}\n`, timeoutMs: 5_000 });
    await remote.run(command);
    const bytes = Buffer.byteLength(command);
    expect(runner.calls[0]?.args).toEqual([...sshArgs(target), stdinBootstrap(bytes)]);
    expect(runner.calls[0]?.options?.input).toBe(`${command}${secret}\n`);
    expect(runner.calls[0]?.options?.timeoutMs).toBe(5_000);
    expect(runner.calls[0]?.args.join(" ")).not.toContain(secret);
    expect(runner.calls[1]?.options?.input).toBe(command);
    expect(runner.calls[1]?.options?.timeoutMs).toBe(60_000);
  });
});

describe("SshRemoteExec streaming", () => {
  it("passes each output line to onLine as the runner reads it, with its stream", async () => {
    const runner = new ScriptedRunner((_command, _args, options) => {
      options?.onLine?.("2026-10-28T10:00:00Z web started", "stdout");
      options?.onLine?.("2026-10-28T10:00:01Z web warning", "stderr");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const remote = new SshRemoteExec({ ...target, runner });
    const lines: [string, string][] = [];
    await remote.run("docker logs --follow web", {
      onLine: (stream, line) => lines.push([stream, line]),
    });
    expect(lines).toEqual([
      ["stdout", "2026-10-28T10:00:00Z web started"],
      ["stderr", "2026-10-28T10:00:01Z web warning"],
    ]);
  });

  it("stops the command through signal", async () => {
    const runner = new ScriptedRunner(
      (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The command was aborted.", "AbortError")),
          );
          options?.onLine?.("first", "stdout");
        }),
    );
    const remote = new SshRemoteExec({ ...target, runner });
    const stop = new AbortController();
    const running = remote.run("docker logs --follow web", {
      signal: stop.signal,
      onLine: () => stop.abort(),
    });
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.calls[0]?.options?.signal).toBe(stop.signal);
  });

  it("adds no streaming options when none are given", async () => {
    const runner = new ScriptedRunner();
    await new SshRemoteExec({ ...target, runner }).run("uptime");
    expect(runner.calls[0]?.options).toEqual({ timeoutMs: 60_000 });
  });
});

function findShell(): string | undefined {
  const candidates = [findExecutable("sh"), findExecutable("bash")];
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    candidates.push(
      findExecutable(join(programFiles, "Git", "bin", "sh.exe")),
      findExecutable(join(programFiles, "Git", "bin", "bash.exe")),
    );
  }
  return candidates.find(
    (shell) => shell !== undefined && spawnSync(shell, ["-c", "exit 3"]).status === 3,
  );
}

const shell = findShell();
if (shell === undefined) {
  console.warn(
    "Skipping the bootstrap behaviour tests: no POSIX shell (sh or bash) found on this machine.",
  );
}

/** Runs what `SshRemoteExec` would send over ssh in a local shell, as the server's login shell would. */
class LocalShellRunner implements CommandRunner {
  readonly #inner = new NodeCommandRunner();
  constructor(
    readonly shellPath: string,
    readonly tempDir: string,
  ) {}

  run(_command: string, args: readonly string[], options: CommandOptions = {}) {
    const remoteCommand = args[args.length - 1] ?? "";
    return this.#inner.run(this.shellPath, ["-c", remoteCommand], {
      ...options,
      env: { ...process.env, TMPDIR: this.tempDir.replaceAll("\\", "/") },
    });
  }
}

describe.skipIf(shell === undefined)("the bootstrap in a real shell", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), "opscrew-remote-"));
    const runner = new LocalShellRunner(shell as string, dir);
    return { dir, runner, remote: new SshRemoteExec({ ...target, runner }) };
  }

  it("runs a long multi-line command that reads a secret from stdin and keeps its exit code", async () => {
    const { dir, remote } = await setup();
    const secret = fakeSecret("generic-password");
    const command = longCommand(
      [
        "echo started",
        "IFS= read -r s",
        'printf "secret:%s\\n" "$s"',
        'if grep -qF -- "$s" "$0"; then echo "secret-in-file"; fi',
        'if [ -f "$0" ]; then echo "file-present"; fi',
        "echo umask:$(umask)",
        'printf "%s\\n" "Grüße ✓"',
      ].join("\n"),
    );
    expect(Buffer.byteLength(command)).toBeGreaterThan(MAX_INLINE_COMMAND_BYTES);
    const result = await remote.run(command, { input: `${secret}\nunused\n` });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("started\n");
    expect(result.stdout).toContain(`secret:${secret}\n`);
    expect(result.stdout).toContain("file-present\n");
    expect(result.stdout).toContain("Grüße ✓\n");
    expect(result.stdout).toMatch(/umask:0*77\n/);
    expect(result.stdout).not.toContain("secret-in-file");
    expect(await readdir(dir)).toEqual([]);
  });

  it("runs a command longer than Windows passes on a command line, without input", async () => {
    const { dir, remote } = await setup();
    // The live failure: an MSYS program got only the first 8,186 characters of 10,852.
    const padding = longCommand(":").replace(/\nexit 7$/, "");
    const command = [...Array.from({ length: 6 }, () => padding), "echo alone", "exit 7"].join(
      "\n",
    );
    expect(Buffer.byteLength(command)).toBeGreaterThan(12_000);
    const result = await remote.run(command);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("alone\n");
    expect(await readdir(dir)).toEqual([]);
  });

  it("streams a running command's lines and stops it through signal", async () => {
    const { remote } = await setup();
    const stop = new AbortController();
    const lines: [string, string][] = [];
    const running = remote.run("echo one; echo two >&2; sleep 30; echo never", {
      signal: stop.signal,
      onLine: (stream, line) => {
        lines.push([stream, line]);
        if (line === "two") stop.abort();
      },
    });
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(lines).toEqual([
      ["stdout", "one"],
      ["stderr", "two"],
    ]);
  });

  it("fails without running anything when the command arrives truncated or not at all", async () => {
    const { dir, runner } = await setup();
    const command = longCommand("echo ran");
    const bytes = Buffer.byteLength(command);
    const partial = Buffer.from(command)
      .subarray(0, bytes - 100)
      .toString("utf8");
    for (const input of [partial, ""]) {
      const result = await runner.run("ssh", [stdinBootstrap(bytes)], { input });
      expect(result.exitCode).toBe(125);
      expect(result.stdout).not.toContain("ran");
      expect(result.stderr).toContain("did not arrive in full");
      expect(await readdir(dir)).toEqual([]);
    }
  });
});
