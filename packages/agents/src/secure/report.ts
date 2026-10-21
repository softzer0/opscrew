import {
  type CheckResult,
  type PolicyResult,
  type ScanReport,
  SEVERITIES,
  type Severity,
} from "@opscrew/contracts";
import { plural } from "@opscrew/core";
import {
  DEEP_TOOL_NAME,
  type DeepToolResult,
  findingLocation,
  formatCounts,
  formatUtc,
  inlineCode,
  prose,
  renderScanSummary,
  SEVERITY_LABEL,
  SEVERITY_RANK,
  tableCell,
} from "@opscrew/secops";
import { provisionedElsewhereHint, summarizeChecks } from "../shared";

/** Everything `SECURITY_REPORT.md` shows. All values must already be secret-free. */
export interface SecurityReportInput {
  appName: string;
  /** OpsCrew version. */
  version: string;
  /** ISO-8601 time of the run. */
  generatedAt: string;
  /**
   * Server address the host checks and probes ran against; absent before provision and when the
   * address must stay private (behind Cloudflare's proxy).
   */
  host?: string;
  scan: ScanReport;
  /** Plan policy results; `undefined` when no engine plan was available to evaluate. */
  policies?: readonly PolicyResult[];
  /** Checks run on the server over SSH. */
  hostChecks: readonly CheckResult[];
  /** Probes from outside (open/closed ports, SSH password login). */
  probes: readonly CheckResult[];
  /** Why server checks were skipped, when they were. */
  hostChecksSkipped?: string;
  /**
   * The app runs in the user's Portainer: `hostChecks` are the read-only checks of its stacks
   * through Portainer's API, there are no outside probes, and `notes` say what stays the user's
   * (the host, backups).
   */
  portainer?: { notes: readonly string[]; probesSkipped: string };
  /** The deeper checks (`--deep`), one per tool; absent without it. */
  deep?: readonly DeepToolResult[];
}

/** One item that needs attention, from any section of the report. */
export interface SecurityProblem {
  severity: Severity;
  status: "fail" | "warn";
  area:
    | "Code scan"
    | "Infrastructure policy"
    | "Server"
    | "Portainer stacks"
    | "Outside probe"
    | "Deeper checks";
  /** What is wrong, in one line. */
  title: string;
  /** More detail: the finding's description, the policy message or what the check expects. */
  detail: string;
  fix?: string;
  where?: string;
}

/**
 * Why the server checks and probes were skipped when this computer does not know the server's
 * address.
 */
export const UNKNOWN_SERVER_ADDRESS = `OpsCrew does not know the server's address on this computer. If the app is deployed, ${provisionedElsewhereHint("opscrew secure")}; otherwise deploy it first.`;

const STATUS: Record<CheckResult["status"], string> = {
  pass: "Pass",
  fail: "**Fail**",
  warn: "Warn",
  skip: "Skip",
};

/** The results that count: known noise is listed apart. */
function counted(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((check) => check.noise === undefined);
}

function checkProblems(
  checks: readonly CheckResult[],
  area: SecurityProblem["area"],
): SecurityProblem[] {
  return checks
    .filter((check) => check.status === "fail" || check.status === "warn")
    .map((check) => ({
      severity: check.severity,
      status: check.status as "fail" | "warn",
      area,
      title: check.message,
      detail: `Expected: ${check.title}.`,
      ...(check.remediation !== undefined ? { fix: check.remediation } : {}),
      ...(check.target !== undefined ? { where: check.target } : {}),
    }));
}

/**
 * Every failure and warning in the report, most severe first (failures before warnings within a
 * severity, then in report order). Info-level scan findings are left out.
 */
export function securityProblems(input: SecurityReportInput): SecurityProblem[] {
  const all: SecurityProblem[] = [
    ...input.scan.findings
      .filter((finding) => finding.severity !== "info")
      .map((finding): SecurityProblem => {
        const where = findingLocation(finding);
        return {
          severity: finding.severity,
          status: "fail",
          area: "Code scan",
          title: finding.title,
          detail: finding.description,
          fix: finding.remediation,
          ...(where !== "" ? { where } : {}),
        };
      }),
    ...(input.policies ?? [])
      .filter((policy) => !policy.passed)
      .map(
        (policy): SecurityProblem => ({
          severity: policy.severity,
          status: "fail",
          area: "Infrastructure policy",
          title: policy.title,
          detail: policy.message,
          ...(policy.resource !== undefined ? { where: policy.resource } : {}),
        }),
      ),
    ...checkProblems(
      input.hostChecks,
      input.portainer !== undefined ? "Portainer stacks" : "Server",
    ),
    ...checkProblems(input.probes, "Outside probe"),
    ...(input.deep ?? []).flatMap((run) =>
      counted(run.results)
        .filter((check) => check.status === "fail" || check.status === "warn")
        .map(
          (check): SecurityProblem => ({
            severity: check.severity,
            status: check.status as "fail" | "warn",
            area: "Deeper checks",
            title: check.message,
            detail: `${DEEP_TOOL_NAME[run.tool]}: ${check.title}.`,
            ...(check.remediation !== undefined ? { fix: check.remediation } : {}),
            ...(check.target !== undefined ? { where: check.target } : {}),
          }),
        ),
    ),
  ];
  return all
    .map((problem, index) => ({ problem, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.problem.severity] - SEVERITY_RANK[a.problem.severity] ||
        (a.problem.status === b.problem.status ? 0 : a.problem.status === "fail" ? -1 : 1) ||
        a.index - b.index,
    )
    .map(({ problem }) => problem);
}

function countLine(problems: readonly SecurityProblem[]): string {
  const parts = SEVERITIES.map((severity) => ({
    severity,
    count: problems.filter((p) => p.severity === severity).length,
  }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.severity}`);
  return parts.join(", ");
}

function checkTable(checks: readonly CheckResult[]): string[] {
  return [
    "| Result | Severity | Check | Details |",
    "|---|---|---|---|",
    ...checks.map(
      (check) =>
        `| ${STATUS[check.status]} | ${SEVERITY_LABEL[check.severity]} | ${tableCell(check.title)} | ${tableCell(prose(check.message))} |`,
    ),
  ];
}

const DEEP_TOOL_ROLE: Readonly<Record<DeepToolResult["tool"], string>> = {
  lynis: "The server's own audit, run in a read-only container that leaves nothing behind.",
  "ssh-audit": "The SSH service, audited from this computer.",
  testssl: "The TLS visitors see, audited from this computer.",
};

/**
 * "Deeper checks": per tool its version, the hardening index (Lynis), the results that count (a
 * skip with how to enable it) and the known noise apart, with why.
 */
function deepSection(deep: readonly DeepToolResult[]): string[] {
  const out = [
    "## Deeper checks",
    "",
    "Run with `opscrew secure --deep`. They change nothing on the server.",
    "",
  ];
  for (const run of deep) {
    out.push(`### ${DEEP_TOOL_NAME[run.tool]} ${run.version}`, "", DEEP_TOOL_ROLE[run.tool], "");
    if (run.hardeningIndex !== undefined) {
      out.push(`Hardening index: **${run.hardeningIndex}** of 100.`, "");
    }
    const results = counted(run.results);
    if (results.length > 0) {
      out.push(
        "| Result | Severity | Check | Where | Details |",
        "|---|---|---|---|---|",
        ...results.map((check) => {
          const details =
            check.status === "skip" && check.remediation !== undefined
              ? `${check.message} ${check.remediation}`
              : check.message;
          return `| ${STATUS[check.status]} | ${SEVERITY_LABEL[check.severity]} | ${tableCell(check.title)} | ${tableCell(check.target ?? "")} | ${tableCell(prose(details))} |`;
        }),
        "",
      );
    }
    const noise = run.results.filter((check) => check.noise !== undefined);
    if (noise.length > 0) {
      out.push(
        "Known noise, set apart and not counted:",
        "",
        "| Check | Where | Details | Why it is set apart |",
        "|---|---|---|---|",
        ...noise.map(
          (check) =>
            `| ${tableCell(check.title)} | ${tableCell(check.target ?? "")} | ${tableCell(prose(check.message))} | ${tableCell(prose(check.noise ?? ""))} |`,
        ),
        "",
      );
    }
  }
  return out;
}

/**
 * `opscrew/SECURITY_REPORT.md`: scan summary, plan policy results, server hardening checks,
 * outside probes and a remediation list ordered by severity. Deterministic for a given input; it
 * contains only masked scan evidence (none is printed here) and no secret values.
 */
export function renderSecurityReport(input: SecurityReportInput): string {
  const problems = securityProblems(input);
  const failures = problems.filter((p) => p.status === "fail");
  const warnings = problems.filter((p) => p.status === "warn");
  const out: string[] = [
    `# OpsCrew security report: ${prose(input.appName)}`,
    "",
    `Checked on ${formatUtc(input.generatedAt)} with OpsCrew ${input.version}.${input.host ? ` Server: ${inlineCode(input.host)}.` : ""}`,
    "",
    "## Summary",
    "",
    failures.length === 0
      ? warnings.length === 0
        ? "**No problems found.**"
        : `**No failures**, ${plural(warnings.length, "warning")} to look at.`
      : `**${plural(failures.length, "problem")} to fix** (${countLine(failures)})${warnings.length > 0 ? ` and ${plural(warnings.length, "warning")}` : ""}.`,
    "",
    "| Area | Result |",
    "|---|---|",
    `| Code scan | ${formatCounts(input.scan)} |`,
    `| Infrastructure policies | ${
      input.policies === undefined
        ? "not evaluated (no infrastructure plan available)"
        : `${input.policies.filter((p) => p.passed).length} passed, ${input.policies.filter((p) => !p.passed).length} failed`
    } |`,
    `| ${input.portainer !== undefined ? "Stacks in your Portainer" : "Server hardening"} | ${input.hostChecksSkipped !== undefined ? "skipped" : summarizeChecks(input.hostChecks)} |`,
    `| Outside probes | ${input.probes.length === 0 ? "skipped" : summarizeChecks(input.probes)} |`,
    ...(input.deep !== undefined
      ? [
          `| Deeper checks | ${summarizeChecks(input.deep.flatMap((run) => counted(run.results)))} |`,
        ]
      : []),
    "",
    "## What to fix",
    "",
  ];

  if (problems.length === 0) {
    out.push("Nothing: every check passed.", "");
  } else {
    problems.forEach((problem, i) => {
      const where = problem.where ? ` — ${inlineCode(problem.where)}` : "";
      const kind = problem.status === "warn" ? " (warning)" : "";
      out.push(
        `${i + 1}. **${SEVERITY_LABEL[problem.severity]}${kind}** · ${problem.area}: ${prose(problem.title)}${where}`,
        `   ${prose(problem.detail)}`,
      );
      if (problem.fix !== undefined) out.push(`   **Fix:** ${prose(problem.fix)}`);
    });
    out.push("");
  }

  out.push("## Code scan", "", "| Severity | Findings |", "|---|---|");
  for (const severity of SEVERITIES) {
    out.push(`| ${SEVERITY_LABEL[severity]} | ${input.scan.counts[severity] ?? 0} |`);
  }
  out.push("");
  if (input.scan.findings.length > 0) {
    out.push("| Severity | Finding | Where | Rule |", "|---|---|---|---|");
    for (const finding of input.scan.findings) {
      const location = findingLocation(finding);
      const where = location === "" ? "" : inlineCode(location);
      out.push(
        `| ${SEVERITY_LABEL[finding.severity]} | ${tableCell(prose(finding.title))} | ${tableCell(where)} | ${tableCell(inlineCode(finding.ruleId))} |`,
      );
    }
    out.push("");
  }
  const notRun = input.scan.scanners.filter((scanner) => scanner.status !== "ran");
  if (notRun.length > 0) {
    out.push(
      `Not run: ${notRun.map((s) => `${s.id} (${s.status}${s.reason ? `: ${prose(s.reason)}` : ""})`).join("; ")}.`,
      "",
    );
  }

  out.push("## Infrastructure policies", "");
  if (input.policies === undefined) {
    out.push(
      "Not evaluated: no infrastructure plan was available. `opscrew provision` checks these policies before every apply.",
      "",
    );
  } else if (input.policies.length === 0) {
    out.push("No policies applied to the plan.", "");
  } else {
    out.push("| Result | Severity | Policy | Details |", "|---|---|---|---|");
    for (const policy of input.policies) {
      out.push(
        `| ${policy.passed ? "Pass" : "**Fail**"} | ${SEVERITY_LABEL[policy.severity]} | ${tableCell(policy.title)} | ${tableCell(prose(policy.message))} |`,
      );
    }
    out.push("");
  }

  if (input.portainer !== undefined) {
    out.push("## The app's stacks in your Portainer", "");
    if (input.hostChecksSkipped !== undefined) {
      out.push(`Skipped: ${prose(input.hostChecksSkipped)}`, "");
    } else {
      out.push(
        "Checked read-only through Portainer's API, with the certificate you confirmed.",
        "",
        ...checkTable(input.hostChecks),
        "",
      );
    }
    out.push(...input.portainer.notes.map((note) => prose(note)), "");
    out.push("## Outside probes", "", `Skipped: ${prose(input.portainer.probesSkipped)}`, "");
  } else {
    out.push("## Server hardening", "");
    if (input.hostChecksSkipped !== undefined) {
      out.push(`Skipped: ${prose(input.hostChecksSkipped)}`, "");
    } else {
      out.push(
        "Checked over SSH as the unprivileged `deploy` user (no sudo).",
        "",
        ...checkTable(input.hostChecks),
        "",
      );
    }
    out.push("## Outside probes", "");
  }

  if (input.portainer !== undefined) {
    // The user's Portainer host is never probed (said above).
  } else if (input.probes.length === 0) {
    out.push(`Skipped: ${UNKNOWN_SERVER_ADDRESS}`, "");
  } else {
    out.push(
      `Connections attempted from this machine to ${input.host ? inlineCode(input.host) : "the server"}.`,
      "",
      ...checkTable(input.probes),
      "",
    );
  }

  if (input.deep !== undefined) out.push(...deepSection(input.deep));

  out.push(
    "---",
    "",
    `Generated by OpsCrew ${input.version}. Run \`opscrew secure\` to refresh it. No secret values are included in this report.`,
    "",
  );
  return out.join("\n");
}

/** Short terminal summary: overall result, the most severe problems and where the report is. */
export function renderSecuritySummary(
  input: SecurityReportInput,
  options: { reportPath?: string; top?: number } = {},
): string {
  const problems = securityProblems(input);
  const failures = problems.filter((p) => p.status === "fail").length;
  const top = options.top ?? 10;
  const lines = [
    failures === 0
      ? `Security check of ${input.appName}: no failures${problems.length > 0 ? `, ${plural(problems.length, "warning")}` : ""}.`
      : `Security check of ${input.appName}: ${plural(failures, "problem")} to fix (${countLine(problems.filter((p) => p.status === "fail"))}).`,
  ];
  for (const problem of problems.slice(0, top)) {
    lines.push(
      `  ${problem.severity.toUpperCase().padEnd(8)}  ${problem.title.replace(/\r?\n/g, " ")}${problem.where ? `  (${problem.where})` : ""}`,
    );
  }
  if (problems.length > top) lines.push(`  …and ${problems.length - top} more`);
  lines.push(renderScanSummary(input.scan, { top: 0 }).trimEnd());
  if (options.reportPath !== undefined) lines.push(`Full report: ${options.reportPath}`);
  return `${lines.join("\n")}\n`;
}
