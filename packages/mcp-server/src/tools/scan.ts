import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runScanPhase } from "@opscrew/agents";
import { toPosixRelative } from "@opscrew/core";
import { renderScanSummary } from "@opscrew/secops";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { IDEMPOTENT_WRITE, projectDirInput, runTool } from "./shared";

/** Severities at or above which a finding counts as blocking in the summary. */
const BLOCKING = ["critical", "high"] as const;

/**
 * `opscrew_scan`: the free security scan. Runs every built-in scanner (plus installed external
 * ones), writes `opscrew/SECURITY_SCAN.md` and `.opscrew/scan.json`, records the `scan` phase and
 * returns the counts, the most severe findings (masked evidence) and the report path.
 */
export function registerScanTool(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_scan",
    {
      title: "Security scan",
      description:
        "Scan the repository for security problems: leaked keys, Supabase service-role keys in frontend code, tables without row-level security, open Firebase rules, risky Docker or framework settings and known-vulnerable dependencies. Writes opscrew/SECURITY_SCAN.md and returns the counts per severity and the most severe findings with masked evidence. No model is used; the only network use is the dependency lookup, which `offline: true` turns off.",
      inputSchema: {
        ...projectDirInput,
        offline: z
          .boolean()
          .optional()
          .describe(
            "Skip the dependency vulnerability lookup so no package names are sent to the OSV database. Default false.",
          ),
        top: z
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many findings to return, most severe first. Default 10."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, offline, top }) =>
      runTool(deps, "opscrew_scan", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        const { paths } = phase;
        const limit = top ?? 10;
        const reportPath = toPosixRelative(paths.root, paths.files.scanReportMd);
        const jsonPath = toPosixRelative(paths.root, paths.files.scanReportJson);
        const { report, warnings } = await runScanPhase(phase, {
          offline: offline ?? false,
          scanners: deps.scanners(),
        });

        const blocking = report.findings.filter((f) =>
          (BLOCKING as readonly string[]).includes(f.severity),
        ).length;
        // The summary itself says when no high or critical problems were found.
        const summary = renderScanSummary(report, { top: limit, reportPath }).trimEnd();
        const verdict =
          blocking === 0
            ? undefined
            : `${blocking} high or critical problem${blocking === 1 ? "" : "s"} need${blocking === 1 ? "s" : ""} attention before deploying.`;
        const text = [
          ...warnings.map((warning) => `Warning: ${warning}`),
          summary,
          ...(verdict ? [verdict] : []),
        ].join("\n\n");
        return {
          text,
          data: {
            warnings,
            project: report.project,
            counts: report.counts,
            totalFindings: report.findings.length,
            blockingFindings: blocking,
            findings: report.findings.slice(0, limit).map((f) => ({
              id: f.id,
              ruleId: f.ruleId,
              severity: f.severity,
              category: f.category,
              title: f.title,
              file: f.file,
              line: f.line,
              evidence: f.evidence,
              remediation: f.remediation,
            })),
            scanners: report.scanners,
            reportPath,
            jsonReportPath: jsonPath,
            offline: offline ?? false,
          },
        };
      }),
  );
}
