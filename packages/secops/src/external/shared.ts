import type { CommandResult } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";

/** Options shared by the external scanner adapters. */
export interface ExternalScannerOptions {
  /** Locates executables (default: `findExecutable` on `process.env`). */
  which?: (name: string) => string | undefined;
  /** Per-command timeout (default 5 minutes). */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 300_000;

export function resolveWhich(
  options: ExternalScannerOptions,
): (name: string) => string | undefined {
  return options.which ?? ((name: string) => findExecutable(name));
}

/** Repo-relative POSIX path for a path an external tool printed (absolute or relative). */
export function relativePath(rootDir: string, path: string): string {
  const root = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  let file = path.replace(/\\/g, "/");
  const caseInsensitive = /^[A-Za-z]:\//.test(root);
  const starts = caseInsensitive
    ? file.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : file.startsWith(`${root}/`);
  if (starts) file = file.slice(root.length + 1);
  return file.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Parses a tool's JSON report from stdout, skipping any log noise before the first `{` or `[`. */
export function parseJsonOutput(tool: string, stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start === -1) {
    if (stdout.trim() === "") return undefined;
    throw new Error(`${tool} did not print a JSON report.`);
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`${tool} printed a report that is not valid JSON.`);
  }
}

/** Last few lines of a failed command's output, for the scanner's failure reason. */
export function failure(tool: string, result: CommandResult): Error {
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ");
  const why = result.timedOut ? "timed out" : `exited with code ${result.exitCode}`;
  return new Error(`${tool} ${why}${detail ? `: ${detail}` : "."}`);
}

/** True when a CLI rejected the subcommand or flags (an older or newer syntax is needed). */
export function isUsageError(result: CommandResult): boolean {
  return /unknown (?:command|flag|shorthand)|flag provided but not defined|no help topic|incorrect usage/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
