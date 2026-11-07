import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { ROLLBACK_APPROVAL_FILE, shellQuote, snapshotAboutPath } from "@opscrew/iac-templates";
import { removeScript } from "../database";

/**
 * The app's folder on a fake server for the database step: each command runs under `sh` with the
 * server's folder (`/srv/apps/<app>`) standing for a temp folder, through `sudo -n` as a plain
 * shell, and is recorded. The plain removal of the one-time approval, which every server rollback
 * sends, needs no `sh`. `answer` answers a command first (the own server's privilege probe).
 */
export class FakeAppFolder {
  readonly commands: string[] = [];
  /** The exit code every command gets instead, without running (a server that fails). */
  failWith: number | undefined;

  private constructor(
    readonly dir: string,
    private readonly serverDir: string,
    private readonly answer?: (command: string) => CommandResult | undefined,
  ) {}

  /** A fake folder for the server's `serverDir`. */
  static async create(
    serverDir: string,
    answer?: (command: string) => CommandResult | undefined,
  ): Promise<FakeAppFolder> {
    const dir = (await mkdtemp(join(tmpdir(), "opscrew-app-folder-"))).replace(/\\/g, "/");
    return new FakeAppFolder(dir, serverDir, answer);
  }

  remote(host = "server"): RemoteExec {
    return {
      host,
      run: async (command) => {
        this.commands.push(command);
        const answered = this.answer?.(command);
        if (answered !== undefined) return answered;
        if (this.failWith !== undefined) {
          return { exitCode: this.failWith, stdout: "", stderr: "failed" };
        }
        if (command === removeScript(this.serverDir)) {
          await rm(join(this.dir, ROLLBACK_APPROVAL_FILE), { force: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return this.sh(command.replace(/^sudo -n /, ""));
      },
    };
  }

  /** Runs `command` under `sh`, with the server's folder standing for this one. */
  sh(command: string): CommandResult {
    const script = command.split(shellQuote(this.serverDir)).join(shellQuote(this.dir));
    const run = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
  }

  /** Writes `text` to `path` in the folder. */
  async write(path: string, text: string): Promise<void> {
    const file = join(this.dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }

  /**
   * A complete release snapshot of the version `hex`, taken at `taken`: its `taken` file and its
   * `about.json` with `services` (by default PostgreSQL `db`), as the server's script writes them.
   */
  async snapshot(
    hex: string,
    taken: string,
    services: readonly object[] = [{ name: "db", kind: "postgres", file: "db.dump", size: 4 }],
  ): Promise<void> {
    const about = { id: hex, kind: "release", taken, version: `sha256:${hex}`, services };
    await this.write(`.snapshots/${hex}/taken`, `${taken}\n`);
    await this.write(snapshotAboutPath(hex), `${JSON.stringify(about)}\n`);
  }

  /** The text of `path` in the folder, or `undefined` when there is none. */
  read(path: string): Promise<string | undefined> {
    return readFile(join(this.dir, path), "utf8").catch(() => undefined);
  }
}
