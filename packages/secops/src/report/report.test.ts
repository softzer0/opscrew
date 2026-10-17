import type { Finding, ScanReport } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  findingLocation,
  inlineCode,
  prose,
  renderScanMarkdown,
  renderScanSummary,
  SEVERITY_LABEL,
  tableCell,
} from "../index";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "0000000000000001",
    ruleId: "secrets/github-token",
    title: "GitHub token committed to the repository",
    severity: "critical",
    category: "secret",
    file: "src/config.ts",
    line: 3,
    evidence: "ghp_…(40 chars)",
    description: "A GitHub token is stored in the source code, so anyone with the code can use it.",
    remediation: "Revoke the token in GitHub settings, then read it from an environment variable.",
    references: ["https://docs.github.com/en/authentication"],
    source: "opscrew-secrets",
    ...overrides,
  };
}

function report(findings: Finding[], overrides: Partial<ScanReport> = {}): ScanReport {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return {
    tool: "opscrew",
    version: "0.1.0",
    project: "habit-tracker",
    startedAt: "2026-10-11T12:00:00.000Z",
    finishedAt: "2026-10-11T12:00:03.000Z",
    findings,
    scanners: [
      { id: "opscrew-secrets", status: "ran", durationMs: 120 },
      { id: "osv", status: "skipped", reason: "offline mode" },
      { id: "gitleaks", status: "skipped", reason: "gitleaks is not installed" },
    ],
    counts,
    ...overrides,
  };
}

const mixed = report([
  finding({}),
  finding({
    id: "0000000000000002",
    ruleId: "supabase/rls-disabled",
    title: "Table `profiles` has no row-level security",
    severity: "high",
    category: "supabase",
    file: "supabase/migrations/20260101000000_init.sql",
    line: 3,
    evidence: undefined,
    description: "Anyone with the public anon key can read and change every row.",
    remediation: "Enable row-level security and add policies | ownership checks.",
    references: undefined,
    source: "opscrew-supabase",
  }),
  finding({
    id: "0000000000000003",
    ruleId: "config/dockerfile-latest",
    title: "Base image uses `latest`",
    severity: "low",
    category: "config",
    file: "Dockerfile",
    line: undefined,
    evidence: "FROM node:latest",
    source: "opscrew-config",
  }),
]);

describe("renderScanMarkdown", () => {
  it("renders an empty report", () => {
    expect(renderScanMarkdown(report([]))).toMatchSnapshot();
  });

  it("renders a mixed report grouped by severity", () => {
    const md = renderScanMarkdown(mixed);
    expect(md).toMatchSnapshot();
    expect(md.indexOf("## Critical")).toBeLessThan(md.indexOf("## High"));
    expect(md.indexOf("## High")).toBeLessThan(md.indexOf("## Low"));
    expect(md).not.toContain("## Medium");
  });

  it("renders failed and skipped scanners", () => {
    const md = renderScanMarkdown(
      report([], {
        scanners: [{ id: "trivy", status: "failed", reason: "exit code 2 | bad json" }],
      }),
    );
    expect(md).toContain("| trivy | failed | exit code 2 \\| bad json |");
  });

  it("is deterministic and contains no absolute paths or raw secrets", () => {
    const secret = fakeSecret("github-token");
    const safe = report([finding({ evidence: `${secret.slice(0, 4)}…(${secret.length} chars)` })]);
    const a = renderScanMarkdown(safe);
    expect(renderScanMarkdown(safe)).toBe(a);
    expect(a).not.toContain(secret);
    expect(a).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });
});

describe("renderScanSummary", () => {
  it("lists counts, top findings, skipped scanners and the report path", () => {
    const text = renderScanSummary(mixed, { reportPath: "opscrew/SECURITY_SCAN.md", top: 2 });
    expect(text).toMatchSnapshot();
    expect(text).toContain("1 critical, 1 high, 0 medium, 1 low, 0 info");
    expect(text).toContain("…and 1 more");
    expect(text).not.toContain("\u001b[");
  });

  it("colours severities only when asked", () => {
    expect(renderScanSummary(mixed, { color: true })).toContain("\u001b[1;31mCRITICAL");
  });

  it("says when nothing was found", () => {
    const text = renderScanSummary(report([]));
    expect(text).toContain("No problems found");
    expect(text).toContain("No high or critical problems were found.");
  });

  it("says clearly that nothing serious was found when only medium or low findings remain (US1 AS2)", () => {
    const minor = report([
      finding({ id: "0000000000000004", severity: "medium", ruleId: "config/dockerfile-root" }),
      finding({ id: "0000000000000005", severity: "low", ruleId: "config/dockerfile-latest" }),
    ]);
    const text = renderScanSummary(minor);
    expect(text).toContain("No high or critical problems were found.");
    expect(text).toContain("MEDIUM");
    expect(renderScanSummary(mixed)).not.toContain("No high or critical");
  });
});

describe("helpers", () => {
  it("keeps inline code valid around backticks", () => {
    expect(inlineCode("a`b")).toBe("`` a`b ``");
    expect(inlineCode("plain")).toBe("`plain`");
  });

  it("escapes table cells", () => {
    expect(tableCell("a | b\nc")).toBe("a \\| b c");
  });

  it("labels severities for headings and tables", () => {
    expect(SEVERITY_LABEL.critical).toBe("Critical");
    expect(SEVERITY_LABEL.info).toBe("Info");
  });

  it("keeps scanner prose on one line and neutralises raw HTML", () => {
    expect(prose("  a\n\nb <script> ")).toBe("a b &lt;script>");
  });

  it("names where a finding is: file and line, the file alone, or nothing", () => {
    expect(findingLocation(finding({}))).toBe("src/config.ts:3");
    expect(findingLocation(finding({ line: undefined }))).toBe("src/config.ts");
    expect(findingLocation(finding({ file: undefined, line: undefined }))).toBe("");
  });
});
