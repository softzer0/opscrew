/**
 * A fake machine for the snapshot commands: the app's folder is a temp folder, each command runs
 * under `sh` there as the deploy user's shell would (the run-as-deploy wrapper unwrapped), with
 * `df` answering the folder's `disk` and a `snapshot.sh` shim that records its arguments and acts
 * like the real script on the store: `take` writes `.snapshots/<id>/about.json` and prints the id,
 * `list` prints each complete one, `delete` removes one.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { shellQuote } from "@opscrew/iac-templates";

/** True when `sh` runs here (Git's on Windows). */
export const SH_AVAILABLE = spawnSync("sh", ["-c", "exit 0"]).status === 0;

/** The shim of `snapshot.sh`: `take.exit` (with `take.stderr`) makes `take` fail. */
const SHIM = `echo "$*" >> calls.log
case "$1" in
  list)
    for f in .snapshots/*/about.json; do
      case "$f" in *.partial/* | *.taking/*) continue ;; esac
      if [ -f "$f" ]; then cat "$f"; fi
    done ;;
  delete) rm -rf ".snapshots/$2" ;;
  take)
    if [ -f take.exit ]; then cat take.stderr >&2; exit "$(cat take.exit)"; fi
    id="$(cat next.id)"; version=""; shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in --id) id="$2" ;; --version) version="$2" ;; esac
      shift 2
    done
    mkdir -p ".snapshots/$id"
    printf '{"id":"%s","kind":"manual","taken":"2026-11-06T19:00:00Z","version":"%s","services":[]}\\n' "$id" "$version" > ".snapshots/$id/about.json"
    echo "$id" ;;
esac
`;

/** The wrapper `hosts.ts` puts around a server's command, with the command quoted for `sh -c`. */
const WRAPPED = /^cd ('[^']*') \|\| exit 3; if \[ "\$\(id -u\)" = 0 \]; then runuser -u deploy -- sh -c ('(?:[^']|'\\'')*'); else sh -c \2; fi$/s;

/** `'…'` as `shellQuote` writes it, unquoted. */
function unquote(quoted: string): string {
  return quoted.slice(1, -1).replaceAll("'\\''", "'");
}

export class FakeSnapshotServer {
  /** Every command as it was sent. */
  readonly commands: string[] = [];
  /** Answers a command first (a failure, an unreachable server). */
  answer: ((command: string) => CommandResult | undefined) | undefined;

  private constructor(
    readonly dir: string,
    private readonly serverDir: string,
  ) {}

  /** A fake machine whose app's folder is `serverDir`, with `snapshot.sh`, a free disk and `.env`. */
  static async create(
    serverDir: string,
    o: { version?: string; script?: boolean } = {},
  ): Promise<FakeSnapshotServer> {
    const dir = (await mkdtemp(join(tmpdir(), "opscrew-snapshot-server-"))).replace(/\\/g, "/");
    const server = new FakeSnapshotServer(dir, serverDir);
    if (o.script !== false) await server.write("snapshot.sh", SHIM);
    await server.write("next.id", "20261106T190000Z\n");
    // 40 GiB with 20 GiB free.
    await server.disk(41_943_040, 20_971_520);
    if (o.version !== undefined) {
      await server.write(".env", `APP_IMAGE=ghcr.io/acme/shop@sha256:${o.version}\n`);
    }
    return server;
  }

  /** The disk `df -Pk .` reports, in KiB. */
  disk(totalKb: number, freeKb: number): Promise<void> {
    return this.write("df.out", `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ${totalKb} ${totalKb - freeKb} ${freeKb} 50% /\n`);
  }

  /** The shell of this machine: a server's (wrapped) or this computer's (`"$OPSCREW_APPS_DIR"`). */
  remote(host = "server"): RemoteExec {
    return {
      host,
      run: async (command) => {
        this.commands.push(command);
        const answered = this.answer?.(command);
        if (answered !== undefined) return answered;
        return this.sh(command);
      },
    };
  }

  /** Runs the command under `sh` in the folder, with `df` answering `df.out`. */
  sh(command: string): CommandResult {
    // A login that reaches Docker through passwordless sudo: `sudo -n sh -c '<command>'`.
    const sudo = /^sudo -n sh -c ('(?:[^']|'\\'')*')$/s.exec(command)?.[1];
    const wrapped = WRAPPED.exec(sudo === undefined ? command : unquote(sudo));
    const inner =
      wrapped === null
        ? command.replace(/^cd "\$OPSCREW_APPS_DIR"\/'[^']*' \|\| exit 3; /, "")
        : (() => {
            if (unquote(wrapped[1] ?? "") !== this.serverDir) throw new Error(`cd to ${wrapped[1]}`);
            return unquote(wrapped[2] ?? "");
          })();
    const script = `df() { cat df.out; }\ncd ${shellQuote(this.dir)} || exit 3\n${inner}`;
    const run = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
  }

  /** The arguments `snapshot.sh` was called with, one call per line. */
  async calls(): Promise<string[]> {
    const text = (await this.read("calls.log")) ?? "";
    return text.split("\n").filter((line) => line !== "");
  }

  async write(path: string, text: string): Promise<void> {
    const file = join(this.dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }

  read(path: string): Promise<string | undefined> {
    return readFile(join(this.dir, path), "utf8").catch(() => undefined);
  }
}
