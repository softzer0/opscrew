import { runScanPhase } from "@opscrew/agents";
import type { ScanReport, Severity } from "@opscrew/contracts";
import { SEVERITIES } from "@opscrew/contracts";
import { toPosixRelative } from "@opscrew/core";
import { renderScanSummary, SEVERITY_RANK } from "@opscrew/secops";
import type { Command } from "commander";
import { type CliContext, colorEnabled } from "../context";
import { createPhaseDeps } from "../deps";
import { CliExit, ERROR_EXIT_CODE, printError, REFUSED_EXIT_CODE } from "../exit";
import { quietReporter } from "../reporter";
import { printNextSteps } from "../ui/output";

interface ScanFlags {
  offline?: boolean;
  failOn: string;
  json?: boolean;
}

/** True when `report` has a finding at or above `failOn`. */
function failsAt(report: ScanReport, failOn: Severity): boolean {
  return report.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
}

/**
 * `opscrew scan`: runs every built-in scanner (plus installed external ones), writes
 * `opscrew/SECURITY_SCAN.md` and `.opscrew/scan.json`, prints a summary (or the JSON report with
 * `--json`) and exits 1 when a finding is at or above `--fail-on`, 0 otherwise and 2 on error
 * (FR-101).
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("scan")
    .description("Scan the repository for security problems (free, no model needed)")
    .option("--offline", "Do not use the network (skips the dependency vulnerability lookup)")
    .option(
      "--fail-on <severity>",
      `Exit 1 when a finding is at or above this severity (${SEVERITIES.join(", ")})`,
      "high",
    )
    .option("--json", "Print the full report as JSON instead of the summary")
    .action(async (flags: ScanFlags) => {
      const failOn = flags.failOn.trim().toLowerCase();
      if (!(SEVERITIES as readonly string[]).includes(failOn)) {
        ctx.reporter.error(
          `--fail-on must be one of ${SEVERITIES.join(", ")}, not "${flags.failOn}".`,
        );
        throw new CliExit(ERROR_EXIT_CODE);
      }
      const json = flags.json === true;
      const report = await scan(ctx, { offline: flags.offline === true, json });
      if (json) {
        ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        ctx.stdout(
          renderScanSummary(report, {
            color: colorEnabled(ctx.env, ctx.isInteractive),
            reportPath: "opscrew/SECURITY_SCAN.md",
          }),
        );
      }
      const failed = failsAt(report, failOn as Severity);
      if (!json) {
        printNextSteps(ctx, [
          ...(failed
            ? [
                `fix the ${failOn === "critical" ? "critical" : `${failOn} or worse`} findings listed in opscrew/SECURITY_SCAN.md, then run \`opscrew scan\` again.`,
              ]
            : []),
          "run `opscrew analyze` to describe how the app is built and what it needs.",
        ]);
      }
      if (failed) throw new CliExit(REFUSED_EXIT_CODE);
    });
}

/** The scan phase in the terminal; any failure exits 2 (FR-101), never 1 like a finding. */
async function scan(
  ctx: CliContext,
  options: { offline: boolean; json: boolean },
): Promise<ScanReport> {
  // Progress is dropped for `--json` so stdout holds only the JSON; problems go to stderr.
  const deps = createPhaseDeps(ctx, {
    ai: false,
    ...(options.json ? { reporter: quietReporter(ctx.reporter) } : {}),
  });
  const { paths, reporter } = deps;
  reporter.step(`Scanning the repository${options.offline ? " (offline)" : ""}`);
  try {
    const { report } = await runScanPhase(deps, { offline: options.offline });
    reporter.success(
      `Wrote ${toPosixRelative(paths.root, paths.files.scanReportMd)} and ${toPosixRelative(paths.root, paths.files.scanReportJson)}.`,
    );
    return report;
  } catch (error) {
    printError(ctx, error, { unexpected: "The scan could not finish" });
    throw new CliExit(ERROR_EXIT_CODE);
  }
}
