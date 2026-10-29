import { spawnSync } from "node:child_process";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { BASH_AVAILABLE } from "./__fixtures__/shell-harness";
import { localExec } from "./local";
import { asLogin, shellQuote } from "./shell";

/** Whether a real `sh` (dash on Debian and Ubuntu) can run here. */
const SH_AVAILABLE = process.platform !== "win32" && spawnSync("sh", ["-c", "exit 0"]).status === 0;

/** A runner that records each call and answers `exitCode` 0. */
function fakeRunner() {
  const calls: { command: string; args: readonly string[]; options?: CommandOptions }[] = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, ...(options !== undefined && { options }) });
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  };
  return { calls, runner };
}

/** A runner that really spawns the command (for the real-shell checks). */
const spawnRunner: CommandRunner = {
  async run(command, args, options): Promise<CommandResult> {
    const run = spawnSync(command, [...args], {
      input: options?.input ?? "",
      env: options?.env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
  },
};

describe("localExec", () => {
  it("pipes the command to <shell> -s with the local roots set, in forward-slash form", async () => {
    const { calls, runner } = fakeRunner();
    const exec = localExec({
      runner,
      shell: "C:/Program Files/Git/bin/bash.exe",
      env: { PATH: "/usr/bin", HOME: "/c/Users/me" },
      homeDir: "D:\\Users\\me\\.opscrew",
    });
    expect(exec.host).toBe("localhost");
    const result = await exec.run("echo hi", { timeoutMs: 5000 });
    expect(result.stdout).toBe("ok\n");
    expect(calls).toEqual([
      {
        command: "C:/Program Files/Git/bin/bash.exe",
        args: ["-s"],
        options: {
          env: {
            PATH: "/usr/bin",
            HOME: "/c/Users/me",
            OPSCREW_APPS_DIR: "D:/Users/me/.opscrew/local/srv/apps",
            OPSCREW_EDGE_DIR: "D:/Users/me/.opscrew/local/srv/edge",
            MSYS_NO_PATHCONV: "1",
            MSYS2_ARG_CONV_EXCL: "*",
          },
          input: "{\necho hi\n} ; exit $?\n",
          timeoutMs: 5000,
        },
      },
    ]);
  });

  it("pipes stdin input into the command with printf, and never runs anything through sudo", async () => {
    const { calls, runner } = fakeRunner();
    const exec = localExec({ runner, shell: "sh", env: {}, homeDir: "/home/me/.opscrew" });
    await exec.run("read -r x", { input: "it's\n" });
    expect(calls[0]?.options?.input).toBe(
      `printf '%s' ${shellQuote("it's\n")} | {\nread -r x\n} ; exit $?\n`,
    );
    expect(calls[0]?.options?.env?.OPSCREW_EDGE_DIR).toBe("/home/me/.opscrew/local/srv/edge");
    await expect(exec.run("sudo -n sh -c 'id'")).rejects.toThrow(
      "OpsCrew never runs anything as root on this computer.",
    );
    expect(calls).toHaveLength(1);
  });

  it.skipIf(!BASH_AVAILABLE)(
    "runs a script in a real shell: it reads its stdin and the roots, and unread input never runs",
    async () => {
      const exec = localExec({
        runner: spawnRunner,
        shell: "bash",
        env: { PATH: process.env.PATH },
        homeDir: "D:\\opscrew-home",
      });
      const script = `set -eu
IFS= read -r secret
printf 'apps=%s edge=%s secret=%s\\n' "$OPSCREW_APPS_DIR" "$OPSCREW_EDGE_DIR" "\${#secret}"
exit 3`;
      const result = await exec.run(asLogin(script), { input: "abc\necho LEFT-OVER-RAN\n" });
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe(
        "apps=D:/opscrew-home/local/srv/apps edge=D:/opscrew-home/local/srv/edge secret=3\n",
      );
      const ignored = await exec.run("echo done", { input: "echo LEFT-OVER-RAN\n" });
      expect(ignored).toMatchObject({ exitCode: 0, stdout: "done\n" });
      // A program the shell starts gets /api/health as it is (no Windows path conversion).
      const argument = await exec.run(
        `"${process.execPath.replaceAll("\\", "/")}" -e 'console.log(process.argv[1])' /api/health`,
      );
      expect(argument).toMatchObject({ exitCode: 0, stdout: "/api/health\n" });
    },
  );

  it.skipIf(!SH_AVAILABLE)(
    "gives the command its input byte for byte in the real sh, and returns its exit code",
    async () => {
      const exec = localExec({
        runner: spawnRunner,
        shell: "sh",
        env: { PATH: process.env.PATH },
        homeDir: "/home/me/.opscrew",
      });
      const input = "it's $HOME \\n \\ `x` %s\nsecond line\n";
      expect(await exec.run("cat", { input })).toMatchObject({ exitCode: 0, stdout: input });
      expect(await exec.run("cat > /dev/null; exit 7", { input })).toMatchObject({ exitCode: 7 });
    },
  );
});
