/**
 * A fake SFTP host for tests: a `CommandRunner` that plays OpenSSH's `sftp -b` against files in
 * memory, with sftp's batch syntax (quoting, the `-` and `@` prefixes), its answers (the long
 * listing's lines, its error messages) and OpenSSH's `posix-rename`. Only `sftp` runs on it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";

/** A file, a folder or a symbolic link on the fake host. */
export type FakeSftpNode =
  | { type: "dir"; mode: number }
  | { type: "file"; mode: number; content: Uint8Array }
  | { type: "link"; target: string };

/** One `sftp` run: its arguments and its batch file's lines. */
export interface FakeSftpRun {
  args: readonly string[];
  lines: string[];
}

export interface FakeSftpOptions {
  /** The folder SFTP starts in, as `pwd` shows it (default `/home/web`). */
  home?: string;
}

/** A command's failure, with sftp's message. */
class Refused extends Error {}

/** A batch line's words, as sftp's parser reads them: quoted parts kept whole, `\"` and `\\` undone. */
export function batchWords(text: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote !== undefined) {
      if (char === "\\" && (text[i + 1] === quote || text[i + 1] === "\\")) {
        word = `${word ?? ""}${text[++i]}`;
      } else if (char === quote) {
        quote = undefined;
      } else {
        word = `${word ?? ""}${char}`;
      }
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else {
      word = `${word ?? ""}${char}`;
    }
  }
  if (quote !== undefined) throw new Refused("Unterminated quoted argument");
  if (word !== undefined) words.push(word);
  return words;
}

/** `rwx` letters of a mode, as `ls -l` shows them. */
function modeLetters(node: FakeSftpNode): string {
  const kind = node.type === "dir" ? "d" : node.type === "link" ? "l" : "-";
  const mode = node.type === "link" ? 0o777 : node.mode;
  const bits = [...Array(9)].map((_, i) => ((mode >> (8 - i)) & 1 ? "rwx"[i % 3] : "-"));
  return `${kind}${bits.join("")}`;
}

export class FakeSftpHost implements CommandRunner {
  /** Each path from the folder SFTP starts in (`""` is that folder) and what is there. */
  readonly nodes = new Map<string, FakeSftpNode>([["", { type: "dir", mode: 0o755 }]]);
  /** Every run, in order. */
  readonly runs: FakeSftpRun[] = [];
  /** When set, every run fails with it before any command: a refused key, a changed host key. */
  connectionFailure: { exitCode: number; stderr: string } | undefined;
  readonly home: string;

  constructor(options: FakeSftpOptions = {}) {
    this.home = options.home ?? "/home/web";
  }

  async run(
    command: string,
    args: readonly string[],
    _options?: CommandOptions,
  ): Promise<CommandResult> {
    if (command !== "sftp") throw new Error(`The fake SFTP host runs only sftp, not ${command}.`);
    const batch = args[args.indexOf("-b") + 1];
    if (batch === undefined) throw new Error("sftp ran without -b.");
    const lines = (await readFile(batch, "utf8")).split("\n").filter((text) => text !== "");
    this.runs.push({ args, lines });
    if (this.connectionFailure !== undefined) {
      return {
        exitCode: this.connectionFailure.exitCode,
        stdout: "",
        stderr: this.connectionFailure.stderr,
      };
    }
    let stdout = "";
    let stderr = "";
    for (const text of lines) {
      let rest = text.trim();
      const tolerate = rest.startsWith("-");
      if (tolerate) rest = rest.slice(1).trim();
      const echo = !rest.startsWith("@");
      if (!echo) rest = rest.slice(1).trim();
      if (echo) stdout += `sftp> ${rest}\n`;
      try {
        stdout += await this.#command(batchWords(rest));
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        stderr += `${error.message}\n`;
        if (!tolerate) return { exitCode: 1, stdout, stderr };
      }
    }
    return { exitCode: 0, stdout, stderr };
  }

  /** A file's content as text, following links; undefined when there is none. */
  text(path: string): string | undefined {
    const node = this.nodes.get(this.#resolve(path, true) ?? "\0");
    return node?.type === "file" ? new TextDecoder().decode(node.content) : undefined;
  }

  /** Writes a file, making the folders above it. */
  write(path: string, text: string, mode = 0o644): void {
    this.mkdir(posix.dirname(path));
    this.nodes.set(this.#key(path), {
      type: "file",
      mode,
      content: new TextEncoder().encode(text),
    });
  }

  /** Makes a folder and those above it. */
  mkdir(path: string): void {
    const key = this.#key(path);
    const parts = key === "" ? [] : key.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const level = parts.slice(0, i).join("/");
      if (!this.nodes.has(level)) this.nodes.set(level, { type: "dir", mode: 0o755 });
    }
  }

  /** A symbolic link's target, or undefined when `path` isn't one. */
  readlink(path: string): string | undefined {
    const node = this.nodes.get(this.#key(path));
    return node?.type === "link" ? node.target : undefined;
  }

  /** The mode of what is at `path` (not following a link). */
  modeOf(path: string): number | undefined {
    const node = this.nodes.get(this.#key(path));
    return node === undefined || node.type === "link" ? undefined : node.mode;
  }

  /** Every path below `path` (not following links), sorted. */
  paths(path = ""): string[] {
    const key = this.#key(path);
    return [...this.nodes.keys()]
      .filter((name) => name !== "" && (key === "" || name === key || name.startsWith(`${key}/`)))
      .sort();
  }

  /** A path as a key: relative to the home folder, normalized. */
  #key(path: string): string {
    const absolute = path.startsWith("/") ? path : posix.join(this.home, path);
    const normal = posix.normalize(absolute);
    if (normal === this.home) return "";
    if (normal.startsWith(`${this.home}/`)) return normal.slice(this.home.length + 1);
    return normal;
  }

  /** The absolute path sftp's messages name. */
  #absolute(path: string): string {
    const key = this.#key(path);
    return key === "" ? this.home : key.startsWith("/") ? key : `${this.home}/${key}`;
  }

  /**
   * The key of what `path` names, following links in its folders (and in its last part with
   * `follow`); undefined when a part isn't there.
   */
  #resolve(path: string, follow: boolean, depth = 0): string | undefined {
    if (depth > 20) return undefined;
    const parts = this.#key(path)
      .split("/")
      .filter((part) => part !== "");
    let at = "";
    for (const [i, part] of parts.entries()) {
      const next = at === "" ? part : `${at}/${part}`;
      const node = this.nodes.get(next);
      if (node === undefined) return i === parts.length - 1 ? next : undefined;
      if (node.type === "link" && (follow || i < parts.length - 1)) {
        const target = node.target.startsWith("/")
          ? node.target
          : posix.join(this.home, at, node.target);
        const resolved = this.#resolve(target, true, depth + 1);
        if (resolved === undefined) return undefined;
        at = resolved;
      } else {
        at = next;
      }
    }
    return at;
  }

  /** The folder `path` is in, resolved, which must be there. */
  #parentOf(path: string, what: string): string {
    const parent = this.#resolve(posix.dirname(this.#absolute(path)), true);
    if (parent === undefined || this.nodes.get(parent)?.type !== "dir") {
      throw new Refused(`${what} "${this.#absolute(path)}": No such file or directory`);
    }
    return parent;
  }

  /** The key a new entry at `path` takes (its folder resolved). */
  #newKey(path: string, what: string): string {
    const parent = this.#parentOf(path, what);
    const name = posix.basename(this.#key(path));
    return parent === "" ? name : `${parent}/${name}`;
  }

  async #command(words: string[]): Promise<string> {
    const [name, ...rest] = words;
    switch (name) {
      case "pwd":
        return `Remote working directory: ${this.home}\n`;
      case "mkdir": {
        const [path = ""] = rest;
        const key = this.#newKey(path, "remote mkdir");
        if (this.nodes.has(key))
          throw new Refused(`remote mkdir "${this.#absolute(path)}": Failure`);
        this.nodes.set(key, { type: "dir", mode: 0o755 });
        return "";
      }
      case "rmdir": {
        const [path = ""] = rest;
        const key = this.#key(path);
        const node = this.nodes.get(key);
        const children = [...this.nodes.keys()].some((other) => other.startsWith(`${key}/`));
        if (node?.type !== "dir" || children) {
          throw new Refused(`remote rmdir "${this.#absolute(path)}": Failure`);
        }
        this.nodes.delete(key);
        return "";
      }
      case "put": {
        const [local = "", remote = ""] = rest;
        const key = this.#newKey(remote, "remote open");
        if (this.nodes.get(key)?.type === "dir") {
          throw new Refused(`remote open "${this.#absolute(remote)}": Failure`);
        }
        const content = new Uint8Array(await readFile(local));
        this.nodes.set(key, { type: "file", mode: 0o644, content });
        return "";
      }
      case "get": {
        const [remote = "", local = ""] = rest;
        const key = this.#resolve(remote, true);
        const node = key === undefined ? undefined : this.nodes.get(key);
        if (node === undefined) throw new Refused(`File "${this.#absolute(remote)}" not found.`);
        if (node.type !== "file") {
          throw new Refused(`download ${this.#absolute(remote)}/: not a regular file`);
        }
        await writeFile(local, node.content);
        return "";
      }
      case "ln": {
        const [flag, target = "", link = ""] = rest;
        if (flag !== "-s") throw new Refused("The fake host makes symbolic links only.");
        const key = this.#newKey(link, "remote symlink");
        if (this.nodes.has(key)) {
          throw new Refused(`remote symlink "${this.#absolute(link)}": Failure`);
        }
        this.nodes.set(key, { type: "link", target });
        return "";
      }
      case "rename": {
        const [from = "", to = ""] = rest;
        const source = this.#newKey(from, "remote rename");
        const node = this.nodes.get(source);
        const target = this.#newKey(to, "remote rename");
        const there = this.nodes.get(target);
        const fails =
          node === undefined ||
          (there?.type === "dir" &&
            (node.type !== "dir" || this.paths(target).some((p) => p !== target))) ||
          (there !== undefined && there.type !== "dir" && node.type === "dir");
        if (fails) {
          throw new Refused(
            `remote rename "${this.#absolute(from)}" to "${this.#absolute(to)}": Failure`,
          );
        }
        for (const key of [...this.nodes.keys()]) {
          if (key === source || key.startsWith(`${source}/`)) {
            const value = this.nodes.get(key) as FakeSftpNode;
            this.nodes.delete(key);
            this.nodes.set(`${target}${key.slice(source.length)}`, value);
          }
        }
        return "";
      }
      case "rm": {
        const [path = ""] = rest;
        const key = this.#newKey(path, "remote delete");
        const node = this.nodes.get(key);
        if (node === undefined) {
          throw new Refused(`remote delete ${this.#absolute(path)}: No such file or directory`);
        }
        if (node.type === "dir")
          throw new Refused(`remote delete ${this.#absolute(path)}: Failure`);
        this.nodes.delete(key);
        return "";
      }
      case "chmod": {
        const [mode = "", path = ""] = rest;
        const key = this.#resolve(path, true);
        const node = key === undefined ? undefined : this.nodes.get(key);
        if (key === undefined || node === undefined || node.type === "link") {
          throw new Refused(
            `Couldn't setstat on "${this.#absolute(path)}": No such file or directory`,
          );
        }
        this.nodes.set(key, { ...node, mode: Number.parseInt(mode, 8) });
        return "";
      }
      case "ls":
        return this.#ls(rest);
      default:
        throw new Refused(`Invalid command "${name}".`);
    }
  }

  /** `ls -lan <path>` and `ls -1a <path>`: a folder's entries (with `.` and `..`), or one file. */
  #ls(words: string[]): string {
    const flags = words.filter((word) => word.startsWith("-")).join("");
    const [path = "."] = words.filter((word) => !word.startsWith("-"));
    const key = this.#resolve(path, true);
    const node = key === undefined ? undefined : this.nodes.get(key);
    if (key === undefined || node === undefined) {
      throw new Refused(`Can't ls: "${this.#absolute(path)}" not found`);
    }
    const shown = path.replace(/\/+$/, "");
    const entries: [string, FakeSftpNode][] =
      node.type === "dir"
        ? [
            [`${shown}/.`, node],
            [`${shown}/..`, { type: "dir", mode: 0o755 }],
            ...[...this.nodes.entries()]
              .filter(
                ([other]) => posix.dirname(other) === (key === "" ? "." : key) && other !== "",
              )
              .map(([other, child]): [string, FakeSftpNode] => [
                `${shown}/${posix.basename(other)}`,
                child,
              ])
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ]
        : [[shown, node]];
    return entries
      .map(([shownPath, entry]) =>
        flags.includes("l")
          ? `${modeLetters(entry)}    ? 1000     1000     ${String(entry.type === "file" ? entry.content.length : 4096).padStart(8)} Nov 13 10:00 ${shownPath}\n`
          : `${shownPath}\n`,
      )
      .join("");
  }
}
