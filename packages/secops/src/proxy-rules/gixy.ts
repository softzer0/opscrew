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
 * The guard at the start of every regular expression OpsCrew writes for nginx (its translation of
 * `vercel.json`): no path with a CR or LF matches. gixy-ng does not read lookaheads.
 */
const OPSCREW_GUARD = "(?!.*[\\r\\n])";

/**
 * The repeated groups OpsCrew itself writes in its translation of `vercel.json`
 * (iac-templates' `edge/vercel-routing.ts`): a `*` or `+` parameter's path segments, and
 * `cleanUrls`/`trailingSlash`'s leading segments. Each repeats whole segments split by `/`.
 */
const OWN_REPEATS = ["(?:[^/]+)(?:/(?:[^/]+))*", "(?:[^/]+/)*"];

/**
 * True when gixy-ng's `regex_redos` reason ("Regex `…` is vulnerable") names a regular expression
 * whose only repeated groups are OpsCrew's own; a pattern the user wrote in `vercel.json` with a
 * repeated group of its own is not noise.
 */
function onlyOwnRepeats(reason: string | undefined): boolean {
  const regex = /^Regex `(.*)` is vulnerable/s.exec(reason ?? "")?.[1];
  if (regex === undefined) return false;
  const rest = OWN_REPEATS.reduce((text, own) => text.replaceAll(own, ""), regex);
  return !/\)[*+{]/.test(rest);
}

/** gixy-ng's advice that does not apply to a block OpsCrew wrote (one with its guard), with why. */
const OPSCREW_NOISE: Readonly<Record<string, string>> = {
  http_splitting: `The capture comes from a regular expression OpsCrew wrote, whose guard \`${OPSCREW_GUARD}\` matches no path with a CR or LF; gixy-ng does not read the guard.`,
  regex_redos:
    "A regular expression OpsCrew wrote from vercel.json: gixy-ng flags every repeated group that holds a quantifier, and its only ones are OpsCrew's, which repeat whole path segments split by `/` and cannot backtrack exponentially.",
};

/**
 * Runs gixy-ng (the `gixy` command) on an nginx configuration file when it is installed, and
 * returns its findings as advice (`warn` results with `source: "gixy-ng"`). Advice that does not
 * apply to what OpsCrew wrote gets `noise`: `http_splitting` on a block with OpsCrew's guard, and
 * `regex_redos` there too when the regular expression repeats nothing but OpsCrew's own groups.
 * Nothing is required: without gixy-ng the result is empty, and a run that fails gives one `skip`
 * result saying why.
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
    const reason = asString(issue.reason);
    const opscrews =
      asString(issue.config)?.includes(OPSCREW_GUARD) === true &&
      (plugin !== "regex_redos" || onlyOwnRepeats(reason));
    const noise = opscrews ? OPSCREW_NOISE[plugin] : undefined;
    return [
      {
        id: `gixy-ng/${plugin}`,
        title: summary,
        status: "warn",
        severity: SEVERITY[asString(issue.severity)?.toUpperCase() ?? ""] ?? "info",
        message: reason ?? asString(issue.description) ?? summary,
        ...(reference ? { remediation: `See ${reference}` } : {}),
        source: "gixy-ng",
        ...(noise ? { noise } : {}),
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
