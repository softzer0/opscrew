/**
 * Runs OpsCrew's real host scripts in a real POSIX shell against a temporary directory tree.
 *
 * - Absolute paths the scripts touch (`/etc/opscrew`, `/srv`, `/etc/ssh`, ...) are moved under a
 *   temporary root, so nothing outside it is ever read or written.
 * - The scripts' fixed `PATH=` line is replaced by `<root>/bin` followed by the test machine's
 *   PATH, and every command that would change the machine (systemctl, docker, ufw, apt-get,
 *   useradd, ...) is a stub executable there that logs its arguments. Child scripts (an undo.sh
 *   run by `sh`) see the same stubs.
 * - Scripts run from a file, so stdin is free for secrets.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Paths the scripts use that the harness moves under its root. */
const MOVED = [
  "/etc/opscrew",
  "/etc/ssh",
  "/etc/docker",
  "/etc/fail2ban",
  "/etc/apt",
  "/etc/default/ufw",
  "/etc/os-release",
  "/etc/nsswitch.conf",
  "/etc/pam.d",
  "/srv",
  "/home",
  "/run/sshd",
  "/var/lib/opscrew-ready",
  "/var/lib/dpkg",
  "/var/log/opscrew",
];

const SCRIPT_PATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function bash(args: string[]): string {
  const run = spawnSync("bash", args, { encoding: "utf8" });
  if (run.error) throw run.error;
  return run.stdout.trim();
}

export const BASH_AVAILABLE = spawnSync("bash", ["-c", "true"]).error === undefined;

export interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export class ShellHarness {
  /** Native path of the temporary root. */
  readonly dir: string;
  /** The same root as the shell sees it. */
  readonly root: string;
  private readonly realInstall: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "opscrew-sh-"));
    this.root = bash(["-c", 'cd "$1" && pwd', "_", this.dir]);
    this.realInstall = bash(["-c", "command -v install"]);
    mkdirSync(join(this.dir, "bin"), { recursive: true });
    mkdirSync(join(this.dir, "state"), { recursive: true });
    mkdirSync(join(this.dir, "work"), { recursive: true });
    // `install -o/-g` would need real users, and some test machines cannot chmod directories in a
    // temp tree: the stub drops owner, group and mode (not under test) and calls the real one.
    this.stub(
      "install",
      `skip=no
for a do
  shift
  if [ "$skip" = yes ]; then skip=no; continue; fi
  case "$a" in -o|-g|-m) skip=yes; continue ;; esac
  set -- "$@" "$a"
done
exec '${this.realInstall}' "$@"`,
      { log: false },
    );
    for (const name of ["chown", "usermod", "useradd", "userdel", "groupdel", "pkill", "sleep"]) {
      this.stub(name, "exit 0");
    }
    // Not every test machine has util-linux's flock (Git Bash does not); the scripts run one at a
    // time here, so the lock is always free. The handshake's marks are what the tests check.
    this.stub("flock", "exit 0", { log: false });
  }

  /** Path under the root, native (for fs calls). */
  native(path: string): string {
    return join(this.dir, path);
  }

  /** Path under the root as the shell sees it. */
  posix(path: string): string {
    return `${this.root}${path}`;
  }

  write(path: string, content: string): void {
    const file = this.native(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  read(path: string): string | undefined {
    const file = this.native(path);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  exists(path: string): boolean {
    return existsSync(this.native(path));
  }

  /**
   * A stub command: logs `name args` to the calls log, then runs `body` (a shell snippet; `$S` is
   * a state directory the stubs can share).
   */
  stub(name: string, body: string, options: { log?: boolean } = {}): void {
    const file = join(this.dir, "bin", name);
    const log = options.log === false ? "" : `echo "${name} $*" >> '${this.root}/calls.log'\n`;
    writeFileSync(file, `#!/bin/sh\nS='${this.root}/state'\n${log}${body}\n`);
    chmodSync(file, 0o755);
  }

  /** Every logged stub call, `name args`, in order. */
  calls(): string[] {
    return (this.read("/calls.log") ?? "").split("\n").filter(Boolean);
  }

  clearCalls(): void {
    rmSync(this.native("/calls.log"), { force: true });
  }

  /** The script with its paths moved under the root and the stubs first on PATH. */
  rooted(script: string): string {
    const moved = new RegExp(`(${MOVED.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
    // The stubs, then only the system's own tool directories: the test machine's PATH may hold
    // spaces and parentheses ("Program Files (x86)"), and the PATH line also sits inside quoted
    // strings the scripts write into undo scripts.
    return script
      .replaceAll(SCRIPT_PATH, `PATH=${this.root}/bin:/usr/bin:/bin`)
      .replace(moved, `${this.root}$1`);
  }

  /** Runs `script` with sh from a file in the root's work directory; `input` goes to stdin. */
  run(script: string, input?: string): ShellResult {
    const file = join(this.dir, "script.sh");
    writeFileSync(file, this.rooted(script));
    const run = spawnSync("sh", [`${this.root}/script.sh`], {
      cwd: join(this.dir, "work"),
      input: input ?? "",
      encoding: "utf8",
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  /** Runs a script that already lies under the root (an undo.sh written by a script). */
  runFile(path: string): ShellResult {
    const run = spawnSync("sh", [this.posix(path)], { cwd: join(this.dir, "work"), encoding: "utf8" });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
