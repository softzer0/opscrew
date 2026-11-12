/**
 * The batch files `sftp -b` reads (OpenSSH's client): one command per line, every path quoted.
 * A line may start with `-` (its failure doesn't stop the batch) and then `@` (it isn't echoed).
 */
import { OpsCrewError } from "@opscrew/core";

/**
 * `path` as one argument of a batch line: in double quotes, with `\` and `"` escaped by a
 * backslash. sftp's own parser then keeps it whole, and keeps `*`, `?` and `[` literal, also for
 * the commands that expand patterns (`get`, `put`, `ls`, `rm`, `chmod`).
 * @throws OpsCrewError `INVALID_INPUT` for a path with a line break or a NUL, which no batch line
 * can hold.
 */
export function quote(path: string): string {
  if (/[\0\r\n]/.test(path)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${JSON.stringify(path)} holds a line break, which OpsCrew never sends over SFTP.`,
    );
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Whether `path` is one OpsCrew uses on an SFTP host: not empty, no line break or NUL, and no `.`,
 * `..` or empty part. It may be absolute, or relative to the folder SFTP starts in (the home
 * folder).
 */
export function isRemotePath(path: string): boolean {
  const parts = (path.startsWith("/") ? path.slice(1) : path).split("/");
  return (
    path !== "" &&
    !/[\0\r\n]/.test(path) &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/**
 * `path`, checked with {@link isRemotePath}.
 * @throws OpsCrewError `INVALID_INPUT` naming `what`.
 */
export function checkRemotePath(path: string, what: string): string {
  if (!isRemotePath(path)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${what} must be a path on the SFTP host without "..", empty parts or line breaks (${JSON.stringify(path)}).`,
    );
  }
  return path;
}

/** One entry of a long listing (`ls -lan`). */
export interface ListedEntry {
  type: "dir" | "link" | "file" | "other";
  /** The path as sftp prints it: the listed folder's path as given, `/`, the entry's name. */
  path: string;
  name: string;
}

/**
 * A line of `ls -lan`: the mode (its first letter the type), the link count (`?` from a server),
 * the owner's and group's numbers, the size, the date in three fields (`Nov 13 10:00` or
 * `Nov 13  2025`), then the path after one space.
 */
const LISTED = /^([-dlbcps?])\S*\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+ (.+)$/;

const TYPES: Readonly<Record<string, ListedEntry["type"]>> = { d: "dir", l: "link", "-": "file" };

/** The entries of `ls -lan` output (lines that aren't entries are skipped), `.` and `..` included. */
export function parseListing(stdout: string): ListedEntry[] {
  const entries: ListedEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = LISTED.exec(line);
    if (match === null) continue;
    const [, letter = "", path = ""] = match;
    entries.push({
      type: TYPES[letter] ?? "other",
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
    });
  }
  return entries;
}
