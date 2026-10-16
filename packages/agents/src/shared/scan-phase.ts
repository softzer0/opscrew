import type { Scanner, ScanReport } from "@opscrew/contracts";
import { ensureStateDir, writeFileAtomic } from "@opscrew/core";
import { formatCounts, renderScanMarkdown, runScan } from "@opscrew/secops";
import type { PhaseDeps } from "../context";

/** What {@link runScanPhase} found: the report and the warnings it reported on the way. */
export interface ScanPhaseResult {
  report: ScanReport;
  /** Problems with the scan itself (such as stopping at the file limit), each also reported. */
  warnings: string[];
}

/**
 * The `scan` phase of `opscrew scan` and `opscrew_scan`: runs every scanner (`scanners`, default
 * the built-in ones plus the installed external ones), writes `opscrew/SECURITY_SCAN.md` and
 * `.opscrew/scan.json` and records the phase. Warnings go to the reporter as they come, never
 * silently; a failure records the phase as failed and is thrown.
 */
export async function runScanPhase(
  deps: PhaseDeps,
  options: { offline: boolean; scanners?: readonly Scanner[] },
): Promise<ScanPhaseResult> {
  const { paths } = deps;
  const warnings: string[] = [];
  try {
    await ensureStateDir(paths);
    const report = await runScan(paths.root, {
      offline: options.offline,
      fetch: deps.fetch,
      runner: deps.runner,
      version: deps.version,
      now: () => deps.clock.now(),
      ...(options.scanners === undefined ? {} : { scanners: options.scanners }),
      onProgress: (event) => {
        if (event.type !== "warning") return;
        warnings.push(event.message);
        deps.reporter.warn(event.message);
      },
    });
    await writeFileAtomic(paths.files.scanReportMd, renderScanMarkdown(report), { mode: 0o644 });
    await writeFileAtomic(paths.files.scanReportJson, `${JSON.stringify(report, null, 2)}\n`);
    await deps.state.markPhase("scan", "ok", formatCounts(report));
    return { report, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.state
      .markPhase("scan", "failed", deps.redactor.redact(message).slice(0, 300))
      .catch(() => undefined);
    throw error;
  }
}
