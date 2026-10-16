import type { CommandResult, Finding, ScanContext, Scanner } from "@opscrew/contracts";
import { findExecutable, isRecord } from "@opscrew/core";

/** Options shared by the external scanner adapters. */
export interface ExternalScannerOptions {
  /** Locates executables (default: `findExecutable` on `process.env`). */
  which?: (name: string) => string | undefined;
  /** Per-command timeout (default 5 minutes). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** Where to get each optional scanner (all three are also in Homebrew under the same name). */
const INSTALL_URLS = {
  gitleaks: "https://github.com/gitleaks/gitleaks#installing",
  "osv-scanner": "https://google.github.io/osv-scanner/installation/",
  trivy: "https://trivy.dev/latest/getting-started/installation/",
} as const;

/** An optional external scanner: available when its binary is installed (and, maybe, online). */
export type ExternalScanner = Scanner & { skipReason(context: ScanContext): string | undefined };

/** What sets one external tool apart, for {@link externalScanner}. */
export interface ExternalTool {
  id: keyof typeof INSTALL_URLS;
  /** What the tool adds, for the reason shown when it is not installed. */
  adds: string;
  /** Why the tool is skipped in offline mode; a tool without one runs offline too. */
  offline?: string;
  /** Runs the tool (`run` runs its binary in the project folder) and maps its report. */
  scan(context: ScanContext, run: (args: string[]) => Promise<CommandResult>): Promise<Finding[]>;
}

/** The scanner for `tool`: found with `options.which`, run with `options.timeoutMs`. */
export function externalScanner(
  tool: ExternalTool,
  options: ExternalScannerOptions,
): ExternalScanner {
  const which = options.which ?? ((name: string) => findExecutable(name));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const online = (context: ScanContext) => tool.offline === undefined || !context.offline;
  return {
    id: tool.id,
    kind: "external",
    async isAvailable(context) {
      return online(context) && which(tool.id) !== undefined;
    },
    skipReason(context) {
      if (which(tool.id) === undefined) {
        return `${tool.id} is not installed. Install it to ${tool.adds}: \`brew install ${tool.id}\` on macOS or Linux, otherwise see ${INSTALL_URLS[tool.id]}`;
      }
      return online(context) ? undefined : tool.offline;
    },
    async scan(context) {
      const bin = which(tool.id);
      if (!bin) return [];
      return tool.scan(context, (args) =>
        context.runner.run(bin, args, { cwd: context.rootDir, timeoutMs }),
      );
    },
  };
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
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
