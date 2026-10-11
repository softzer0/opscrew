import type { Finding, ScanContext, Scanner } from "@opscrew/contracts";
import {
  dependencyFinding,
  type OsvVulnerability,
  type PackageRef,
  severityFromScore,
} from "../rules/deps";
import {
  asRecord,
  asString,
  DEFAULT_TIMEOUT_MS,
  type ExternalScannerOptions,
  failure,
  isUsageError,
  parseJsonOutput,
  relativePath,
  resolveWhich,
} from "./shared";

/** osv-scanner exit codes that still mean "the scan ran": none found, found, no packages. */
const OK_EXIT_CODES = new Set([0, 1, 128]);

function toFindings(context: ScanContext, report: unknown): Finding[] {
  const findings: Finding[] = [];
  const results = asRecord(report)?.results;
  for (const result of Array.isArray(results) ? results : []) {
    const sourcePath = asString(asRecord(asRecord(result)?.source)?.path);
    const file = sourcePath ? relativePath(context.rootDir, sourcePath) : "";
    const packages = asRecord(result)?.packages;
    for (const entry of Array.isArray(packages) ? packages : []) {
      const record = asRecord(entry);
      const info = asRecord(record?.package);
      const name = asString(info?.name);
      const version = asString(info?.version);
      if (!record || !name || !version) continue;
      const pkg: PackageRef = { ecosystem: asString(info?.ecosystem) ?? "", name, version, file };
      const vulns = (Array.isArray(record.vulnerabilities) ? record.vulnerabilities : [])
        .map(asRecord)
        .filter((v): v is Record<string, unknown> => typeof v?.id === "string")
        .map((v) => v as unknown as OsvVulnerability);
      const byId = new Map(vulns.map((v) => [v.id, v]));
      const groups = (Array.isArray(record.groups) ? record.groups : []).map(asRecord);
      const covered = new Set<string>();
      for (const group of groups) {
        const ids = Array.isArray(group?.ids)
          ? group.ids.filter((id) => typeof id === "string")
          : [];
        const vuln = ids.map((id) => byId.get(id)).find((v) => v !== undefined);
        if (!vuln) continue;
        for (const id of ids) covered.add(id);
        const score = Number.parseFloat(asString(group?.max_severity) ?? "");
        findings.push(
          dependencyFinding(pkg, vuln, {
            source: "osv-scanner",
            ...(Number.isFinite(score) ? { severity: severityFromScore(score) } : {}),
          }),
        );
      }
      for (const vuln of vulns) {
        if (!covered.has(vuln.id))
          findings.push(dependencyFinding(pkg, vuln, { source: "osv-scanner" }));
      }
    }
  }
  return findings;
}

/**
 * osv-scanner (`osv-scanner scan source -r`, falling back to the v1 syntax). Needs the network, so
 * it is skipped in offline mode; when it runs, the OSV API scanner skips itself as superseded.
 */
export function createOsvScannerCli(options: ExternalScannerOptions = {}): Scanner & {
  skipReason(context: ScanContext): string | undefined;
} {
  const which = resolveWhich(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: "osv-scanner",
    kind: "external",
    async isAvailable(context) {
      return !context.offline && which("osv-scanner") !== undefined;
    },
    skipReason(context) {
      if (context.offline && which("osv-scanner") !== undefined) {
        return "Offline mode: osv-scanner needs the network.";
      }
      return undefined;
    },
    async scan(context) {
      const bin = which("osv-scanner");
      if (!bin) return [];
      const run = (args: string[]) =>
        context.runner.run(bin, args, { cwd: context.rootDir, timeoutMs });
      let result = await run(["scan", "source", "-r", "--format", "json", context.rootDir]);
      if (!OK_EXIT_CODES.has(result.exitCode) && isUsageError(result)) {
        result = await run(["--format", "json", "-r", context.rootDir]);
      }
      if (!OK_EXIT_CODES.has(result.exitCode) || result.timedOut)
        throw failure("osv-scanner", result);
      if (result.exitCode === 128) return [];
      return toFindings(context, parseJsonOutput("osv-scanner", result.stdout));
    },
  };
}
