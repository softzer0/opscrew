import type { Reporter, ScanReport, Severity } from "@opscrew/contracts";
import { SEVERITIES } from "@opscrew/contracts";
import { ensureStateDir, isUserFacingError, toPosixRelative, writeFileAtomic } from "@opscrew/core";
import {
  formatCounts,
  renderScanMarkdown,
  renderScanSummary,
  runScan,
  SEVERITY_RANK,
} from "@opscrew/secops";
import { type Command, CommanderError } from "commander";
import { type CliContext, colorEnabled } from "../context";
import { createPhaseDeps } from "../deps";
import { CliExit } from "../exit";
import { printNextSteps } from "../ui/output";

/** Exit code when a finding is at or above `--fail-on`. */
export const SCAN_FINDINGS_EXIT_CODE = 1;
/** Exit code when the scan could not run (bad option, unreadable project, write failure). */
export const SCAN_ERROR_EXIT_CODE = 2;

interface ScanFlags {
  offline?: boolean;
  failOn: string;
  json?: boolean;
}

/** True when `report` has a finding at or above `failOn`. */
export function failsAt(report: ScanReport, failOn: Severity): boolean {
  return report.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
}

/** Reporter for `--json`: progress is dropped so stdout holds only the JSON; problems go to stderr. */
function quietReporter(ctx: CliContext): Reporter {
  return {
    step: () => {},
    info: () => {},
    success: () => {},
    warn: (message) => ctx.reporter.warn(message),
    error: (message) => ctx.reporter.error(message),
  };
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
    .exitOverride((error) => {
      // Usage errors (unknown option, missing value) are errors: exit 2, as FR-101 asks.
      if (error.exitCode === 0) throw error;
      throw new CommanderError(SCAN_ERROR_EXIT_CODE, error.code, error.message);
    })
    .action(async (flags: ScanFlags) => {
      const failOn = flags.failOn.trim().toLowerCase();
      if (!(SEVERITIES as readonly string[]).includes(failOn)) {
        ctx.reporter.error(
          `--fail-on must be one of ${SEVERITIES.join(", ")}, not "${flags.failOn}".`,
        );
        throw new CliExit(SCAN_ERROR_EXIT_CODE);
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
      if (failed) throw new CliExit(SCAN_FINDINGS_EXIT_CODE);
    });
}

async function scan(
  ctx: CliContext,
  options: { offline: boolean; json: boolean },
): Promise<ScanReport> {
  const deps = createPhaseDeps(ctx, {
    ai: false,
    ...(options.json ? { reporter: quietReporter(ctx) } : {}),
  });
  const { paths, reporter } = deps;
  try {
    await ensureStateDir(paths);
    reporter.step(`Scanning the repository${options.offline ? " (offline)" : ""}`);
    const report = await runScan(paths.root, {
      offline: options.offline,
      fetch: deps.fetch,
      runner: deps.runner,
      version: deps.version,
      now: () => deps.clock.now(),
      // Warnings (such as the scan stopping at the file limit) must never be silent.
      onProgress: (event) => {
        if (event.type === "warning") reporter.warn(event.message);
      },
    });
    await writeFileAtomic(paths.files.scanReportMd, renderScanMarkdown(report), { mode: 0o644 });
    await writeFileAtomic(paths.files.scanReportJson, `${JSON.stringify(report, null, 2)}\n`);
    reporter.success(
      `Wrote ${toPosixRelative(paths.root, paths.files.scanReportMd)} and ${toPosixRelative(paths.root, paths.files.scanReportJson)}.`,
    );
    await deps.state.markPhase("scan", "ok", formatCounts(report));
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await deps.state.markPhase("scan", "failed", deps.redactor.redact(message).slice(0, 300));
    } catch {
      // Keep the original error.
    }
    if (isUserFacingError(error)) {
      ctx.reporter.error(error.message);
      if (error.hint && !error.message.includes(error.hint)) ctx.stderr(`  ${error.hint}\n`);
    } else {
      ctx.reporter.error(`The scan could not finish: ${message}`);
      if (ctx.env.OPSCREW_DEBUG === "1" && error instanceof Error && error.stack !== undefined) {
        ctx.stderr(`${error.stack}\n`);
      } else {
        ctx.stderr("  Re-run with OPSCREW_DEBUG=1 to see the details.\n");
      }
    }
    throw new CliExit(SCAN_ERROR_EXIT_CODE);
  }
}
