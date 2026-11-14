import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { CommandResult, CommandRunner, HostingFiles } from "@opscrew/contracts";
import { OpsCrewError, octalMode, Redactor, readTar } from "@opscrew/core";
import { checkRemotePath, type ListedEntry, parseListing, quote } from "./batch";

/** How OpsCrew logs in to an SFTP host. */
export interface SftpLogin {
  host: string;
  port: number;
  user: string;
  /** The path of the user's private key file on this computer (never the key itself). */
  keyFile: string;
  /** A known_hosts file that pins the host key the user confirmed. */
  knownHostsFile: string;
}

export interface SftpFilesOptions {
  runner: CommandRunner;
  /** Shared redactor for sftp's messages; a private one is used when omitted. */
  redactor?: Redactor;
  /**
   * Where this computer's side of a run is written for its length: the batch file, the files to
   * upload, a file read (default: the system's temporary folder).
   */
  tempDir?: string;
  /** A fresh random part for temporary names on the host (default: 8 random bytes as hex). */
  randomName?: () => string;
  /** Per sftp run (default 10 minutes). */
  timeoutMs?: number;
}

/** A host's name or address (an IPv6 one without brackets): no blank, `@` or `/`, never first `-`. */
const HOST = /^[^\s@/-][^\s@/]*$/;
/** An SFTP user: no blank, never starting with `-`. */
const USER = /^[^\s-]\S*$/;

/** sftp's words for a path that isn't there (`get`, `ls`). */
const NOT_FOUND = /^(?:File ".*" not found\.|Can't ls: ".*" not found)\r?$/m;

/** One command of a batch file: its text, `-` to go on when it fails, `@` not to echo it. */
const line = (command: string, options: { tolerate?: boolean } = {}) =>
  `${options.tolerate === true ? "-" : ""}@${command}`;

/** The last line sftp printed to stderr that says something. */
function lastSaid(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text !== "" && !/^Connection closed\.?$/.test(text));
  return (lines.at(-1) ?? "no reason given").replace(/\.$/, "");
}

/**
 * The files of an SFTP host's user (feature 027, ADR 0030 D6), through OpenSSH's `sftp -b` run by
 * the injected runner: batch mode, the user's key file only, and the host key pinned in the
 * known_hosts file the user confirmed (`StrictHostKeyChecking=yes`), so a host that presents any
 * other key gets nothing. Every path in a batch file is quoted ({@link quote}), and one with a line
 * break is refused before anything is sent. A run uses `mkdir`, `put`, `chmod`, `ln -s`, `rename`
 * (OpenSSH's `posix-rename@openssh.com`, which replaces its target in one step), `rm`, `rmdir`,
 * `ls` and `get`. Paths are relative to the folder SFTP starts in, or absolute, and never contain
 * `..`. It serves SFTP-only hosts, and Plesk, whose customer API has no file calls.
 */
export class SftpFiles implements HostingFiles {
  readonly #login: SftpLogin;
  readonly #runner: CommandRunner;
  readonly #redactor: Redactor;
  readonly #tempDir: string | undefined;
  readonly #randomName: () => string;
  readonly #timeoutMs: number;
  #batches = 0;

  constructor(login: SftpLogin, options: SftpFilesOptions) {
    const host = login.host.replace(/^\[(.*)\]$/, "$1");
    if (!HOST.test(host)) {
      throw new OpsCrewError("INVALID_INPUT", `${JSON.stringify(login.host)} isn't a host's name.`);
    }
    if (!USER.test(login.user)) {
      throw new OpsCrewError("INVALID_INPUT", `${JSON.stringify(login.user)} isn't a user name.`);
    }
    if (!Number.isInteger(login.port) || login.port < 1 || login.port > 65535) {
      throw new OpsCrewError("INVALID_INPUT", `${login.port} isn't a port number.`);
    }
    this.#login = { ...login, host };
    this.#runner = options.runner;
    this.#redactor = options.redactor ?? new Redactor();
    this.#tempDir = options.tempDir;
    this.#randomName = options.randomName ?? (() => randomBytes(8).toString("hex"));
    this.#timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  }

  /**
   * Uploads the content under a fresh temporary name beside `path`, gives it `mode`, then renames
   * it over `path` in one step; the temporary file is removed again when a step fails.
   */
  async writeFile(path: string, content: Uint8Array, mode: number): Promise<void> {
    checkRemotePath(path, "A file's path");
    const octal = octalMode(mode);
    const temporary = posix.join(posix.dirname(path), `.opscrew-${this.#randomName()}.tmp`);
    await this.#session(async (dir) => {
      const local = join(dir, "upload");
      await writeFile(local, content, { mode: 0o600 });
      await this.#replacing(dir, temporary, `write ${path}`, [
        line(`put ${quote(local)} ${quote(temporary)}`),
        line(`chmod ${octal} ${quote(temporary)}`),
        line(`rename ${quote(temporary)} ${quote(path)}`),
      ]);
    });
  }

  /**
   * Unpacks the archive on this computer and makes its entries in `folder` (`"."`, the folder SFTP
   * starts in, or one made level by level when missing): each folder made when missing and given
   * its mode, each file and link under a temporary name renamed into place.
   */
  async uploadTar(folder: string, tar: Uint8Array): Promise<void> {
    const base = folder === "." ? "" : checkRemotePath(folder, "A folder's path");
    const entries = readTar(tar);
    const where = (name: string) => (base === "" ? name : `${base}/${name}`);
    await this.#session(async (dir) => {
      const lines = levels(base).map((level) => line(`mkdir ${quote(level)}`, { tolerate: true }));
      for (const [i, entry] of entries.entries()) {
        const path = where(entry.name);
        if (entry.type === "dir") {
          lines.push(
            line(`mkdir ${quote(path)}`, { tolerate: true }),
            line(`chmod ${octalMode(entry.mode)} ${quote(path)}`),
          );
          continue;
        }
        const temporary = `${path}.opscrew-${this.#randomName()}`;
        if (entry.type === "file") {
          const local = join(dir, `entry-${i}`);
          await writeFile(local, entry.content, { mode: 0o600 });
          lines.push(
            line(`put ${quote(local)} ${quote(temporary)}`),
            line(`chmod ${octalMode(entry.mode)} ${quote(temporary)}`),
          );
        } else {
          lines.push(line(`ln -s ${quote(entry.target)} ${quote(temporary)}`));
        }
        lines.push(line(`rename ${quote(temporary)} ${quote(path)}`));
      }
      await this.#run(
        dir,
        lines,
        `make the files in ${folder === "." ? "the home folder" : folder}`,
      );
    });
  }

  /** The file's content as text (`get` into a temporary file here), or undefined when it isn't there. */
  async readFile(path: string): Promise<string | undefined> {
    checkRemotePath(path, "A file's path");
    return this.#session(async (dir) => {
      const local = join(dir, "download");
      const result = await this.#batch(dir, [line(`get ${quote(path)} ${quote(local)}`)]);
      if (result.exitCode !== 0) {
        if (NOT_FOUND.test(result.stderr)) return undefined;
        throw this.#failure(result, `read ${path}`);
      }
      return readFile(local, "utf8");
    });
  }

  /** The names in `folder` (`ls -lan`), hidden ones included, or undefined when it isn't there. */
  async list(folder: string): Promise<string[] | undefined> {
    const entries = await this.#listing(folder);
    return entries
      ?.filter((entry) => entry.name !== "." && entry.name !== "..")
      .map((entry) => entry.name);
  }

  /**
   * Removes a file or a link (`rm`), or a folder with everything in it: listed a level at a time,
   * one connection each, then its files and links removed and its folders from the deepest up. A
   * link is never followed. A path that isn't there counts as removed.
   */
  async remove(path: string): Promise<void> {
    checkRemotePath(path, "A path to remove");
    const parent = posix.dirname(path);
    const name = posix.basename(path);
    const entry = (await this.#listing(parent))?.find((listed) => listed.name === name);
    if (entry === undefined) return;
    if (entry.type !== "dir") {
      await this.#session((dir) => this.#run(dir, [line(`rm ${quote(path)}`)], `remove ${path}`));
      return;
    }
    const folders = [path];
    const files: string[] = [];
    for (let level = [path]; level.length > 0; ) {
      const listed = await this.#session((dir) =>
        this.#run(
          dir,
          level.map((folder) => line(`ls -lan ${quote(folder)}`)),
          `list ${path}`,
        ),
      );
      const next: string[] = [];
      for (const child of parseListing(listed.stdout)) {
        if (child.name === "." || child.name === "..") continue;
        if (child.type === "dir") next.push(child.path);
        else files.push(child.path);
      }
      folders.push(...next);
      level = next;
    }
    await this.#session((dir) =>
      this.#run(
        dir,
        [
          ...files.map((file) => line(`rm ${quote(file)}`)),
          ...folders.reverse().map((folder) => line(`rmdir ${quote(folder)}`)),
        ],
        `remove ${path}`,
      ),
    );
  }

  /**
   * Points the symbolic link `path` at `target` (relative to the link's folder) in one step: a new
   * link under a temporary name beside it (`ln -s`), renamed over it (`rename`, OpenSSH's
   * `posix-rename`), so a reader sees the old link or the new one, never none.
   */
  async link(path: string, target: string): Promise<void> {
    checkRemotePath(path, "A link's path");
    const temporary = posix.join(posix.dirname(path), `.opscrew-${this.#randomName()}.link`);
    await this.#session((dir) =>
      this.#replacing(dir, temporary, `point ${path} at ${target}`, [
        line(`ln -s ${quote(target)} ${quote(temporary)}`),
        line(`rename ${quote(temporary)} ${quote(path)}`),
      ]),
    );
  }

  /** The long listing of `folder`, or undefined when it isn't there. */
  async #listing(folder: string): Promise<ListedEntry[] | undefined> {
    if (folder !== ".") checkRemotePath(folder, "A folder's path");
    return this.#session(async (dir) => {
      const result = await this.#batch(dir, [line(`ls -lan ${quote(folder)}`)]);
      if (result.exitCode === 0) return parseListing(result.stdout);
      if (NOT_FOUND.test(result.stderr)) return undefined;
      throw this.#failure(result, `list ${folder}`);
    });
  }

  /**
   * Runs `lines`, which end by renaming `temporary` into place; when they fail, the temporary
   * name is removed again before the failure is thrown.
   */
  async #replacing(
    dir: string,
    temporary: string,
    what: string,
    lines: readonly string[],
  ): Promise<void> {
    const result = await this.#batch(dir, lines);
    if (result.exitCode === 0) return;
    await this.#batch(dir, [line(`rm ${quote(temporary)}`, { tolerate: true })]).catch(
      () => undefined,
    );
    throw this.#failure(result, what);
  }

  /** Runs `lines`; a failure is thrown as what OpsCrew couldn't do (`what`). */
  async #run(dir: string, lines: readonly string[], what: string): Promise<CommandResult> {
    const result = await this.#batch(dir, lines);
    if (result.exitCode !== 0) throw this.#failure(result, what);
    return result;
  }

  /** `sftp -b <batch file>` with `lines`, in the run's folder `dir`. */
  async #batch(dir: string, lines: readonly string[]): Promise<CommandResult> {
    const batch = join(dir, `batch-${++this.#batches}`);
    await writeFile(batch, `${lines.join("\n")}\n`, { mode: 0o600 });
    const { host, port, user, keyFile, knownHostsFile } = this.#login;
    return this.#runner.run(
      "sftp",
      [
        "-b",
        batch,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile="${knownHostsFile}"`,
        "-o",
        "IdentitiesOnly=yes",
        "-i",
        keyFile,
        "-P",
        String(port),
        `${user}@${host.includes(":") ? `[${host}]` : host}`,
      ],
      { timeoutMs: this.#timeoutMs },
    );
  }

  /** A temporary folder on this computer for one run, removed afterwards. */
  async #session<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(this.#tempDir ?? tmpdir(), "opscrew-sftp-"));
    try {
      return await work(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** What sftp said when a run failed, as an error that says what to do. */
  #failure(result: CommandResult, what: string): OpsCrewError {
    const { host, port } = this.#login;
    const where = `${host} (port ${port})`;
    const said = this.#redactor.redact(lastSaid(result.stderr));
    if (
      /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)
    ) {
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `The SFTP host at ${where} didn't present the host key you confirmed, so OpsCrew sent nothing.`,
        {
          hint: "If your host really changed its key, run `opscrew interview` and confirm the new one. Otherwise someone may be intercepting the connection.",
        },
      );
    }
    if (/Permission denied \(/.test(result.stderr)) {
      return new OpsCrewError(
        "CREDENTIALS_INVALID",
        `The SFTP host at ${where} refused the key ${this.#login.keyFile} for ${this.#login.user}.`,
        {
          hint: "Check the user and the key file you gave OpsCrew, and that your host accepts that key.",
        },
      );
    }
    if (result.timedOut === true || result.exitCode === 255) {
      return new OpsCrewError(
        "PROVIDER_ERROR",
        `OpsCrew couldn't ${what} over SFTP at ${where}: ${result.timedOut === true ? "it took too long" : said}.`,
        { hint: "Check that this computer can reach your SFTP host on that port, then try again." },
      );
    }
    return new OpsCrewError(
      "PROVIDER_ERROR",
      `The SFTP host at ${where} refused to ${what}: ${said}.`,
      { hint: "Check that the SFTP user may change that folder, then try again." },
    );
  }
}

/** Each level of `path` from the top: `a`, `a/b`, `a/b/c` (`/a`, `/a/b` for an absolute one). */
function levels(path: string): string[] {
  if (path === "") return [];
  const absolute = path.startsWith("/");
  const parts = (absolute ? path.slice(1) : path).split("/");
  return parts.map((_, i) => `${absolute ? "/" : ""}${parts.slice(0, i + 1).join("/")}`);
}
