import type { CheckResult, CommandRunner, Severity } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import {
  asRecord,
  asString,
  type ExternalScannerOptions,
  failure,
  parseJsonOutput,
} from "../external/shared";

const DEFAULT_TIMEOUT_MS = 60_000;

const SEVERITY: Record<string, Severity> = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

/**
 * Runs gixy-ng (the `gixy` command) on an nginx configuration file when it is installed, and
 * returns its findings as advice (`warn` results with `source: "gixy-ng"`). Nothing is required:
 * without gixy-ng the result is empty, and a run that fails gives one `skip` result saying why.
 */
export async function runGixy(
  file: string,
  exec: CommandRunner,
  options: ExternalScannerOptions = {},
): Promise<CheckResult[]> {
  const bin = (options.which ?? ((name: string) => findExecutable(name)))("gixy");
  if (bin === undefined) return [];
  const result = await exec.run(bin, ["-f", "json", file], {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (result.timedOut) return [skipped(file, failure("gixy-ng", result).message)];
  let report: unknown;
  try {
    report = parseJsonOutput("gixy-ng", result.stdout);
  } catch (error) {
    return [skipped(file, (error as Error).message)];
  }
  // gixy exits with 1 when it found something, so the report decides, not the exit code.
  if (report === undefined && result.exitCode === 0) return [];
  if (!Array.isArray(report)) return [skipped(file, failure("gixy-ng", result).message)];
  return report.flatMap((item): CheckResult[] => {
    const issue = asRecord(item);
    const plugin = asString(issue?.plugin);
    if (!issue || !plugin) return [];
    const summary = asString(issue.summary) ?? plugin;
    const reference = asString(issue.reference);
    return [
      {
        id: `gixy-ng/${plugin}`,
        title: summary,
        status: "warn",
        severity: SEVERITY[asString(issue.severity)?.toUpperCase() ?? ""] ?? "info",
        message: asString(issue.reason) ?? asString(issue.description) ?? summary,
        ...(reference ? { remediation: `See ${reference}` } : {}),
        source: "gixy-ng",
      },
    ];
  });
}

function skipped(file: string, reason: string): CheckResult {
  return {
    id: "gixy-ng",
    title: "gixy-ng advice",
    status: "skip",
    severity: "info",
    message: `gixy-ng could not check ${file}: ${reason}`,
    source: "gixy-ng",
  };
}
