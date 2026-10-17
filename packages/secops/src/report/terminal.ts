import { type ScanReport, SEVERITIES, type Severity } from "@opscrew/contracts";
import { findingLocation } from "./markdown";

export interface ScanSummaryOptions {
  /** Use ANSI colours. Default false. */
  color?: boolean;
  /** How many findings to list. Default 10. */
  top?: number;
  /** Repo-relative path of the Markdown report, printed at the end when given. */
  reportPath?: string;
}

const ANSI: Record<Severity, string> = {
  critical: "\u001b[1;31m",
  high: "\u001b[31m",
  medium: "\u001b[33m",
  low: "\u001b[36m",
  info: "\u001b[2m",
};
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

/** Counts line, e.g. `2 critical, 1 high, 0 medium, 3 low, 0 info`. */
export function formatCounts(report: ScanReport): string {
  return SEVERITIES.map((severity) => `${report.counts[severity] ?? 0} ${severity}`).join(", ");
}

/**
 * Short terminal summary: counts, a clear "no high or critical problems" line when that is the
 * case, the most severe findings (one line each), skipped or failed scanners, and where the full
 * report is. Deterministic; contains only masked data.
 */
export function renderScanSummary(report: ScanReport, options: ScanSummaryOptions = {}): string {
  const color = options.color ?? false;
  const top = Math.max(0, options.top ?? 10);
  const lines = [`OpsCrew scan of ${report.project}: ${formatCounts(report)}`];
  const serious = report.findings.some((f) => f.severity === "critical" || f.severity === "high");
  if (!serious) lines.push("No high or critical problems were found.");

  if (report.findings.length === 0) {
    lines.push("No problems found by the scanners that ran.");
  } else {
    const width = Math.max(...SEVERITIES.map((s) => s.length));
    for (const finding of report.findings.slice(0, top)) {
      const label = paint(
        finding.severity.toUpperCase().padEnd(width),
        ANSI[finding.severity],
        color,
      );
      const where = findingLocation(finding);
      lines.push(`  ${label}  ${finding.title}${where ? `  ${paint(where, DIM, color)}` : ""}`);
    }
    const more = report.findings.length - Math.min(top, report.findings.length);
    if (more > 0) lines.push(`  …and ${more} more`);
  }

  const notRun = report.scanners.filter((s) => s.status !== "ran");
  if (notRun.length > 0) {
    lines.push(
      `Not run: ${notRun.map((s) => `${s.id} (${s.status}${s.reason ? `: ${s.reason}` : ""})`).join("; ")}`,
    );
  }
  if (options.reportPath !== undefined) lines.push(`Full report: ${options.reportPath}`);
  return `${lines.join("\n")}\n`;
}
