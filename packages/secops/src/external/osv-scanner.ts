import type { Finding, ScanContext } from "@opscrew/contracts";
import {
  dependencyFinding,
  type OsvVulnerability,
  type PackageRef,
  severityFromScore,
} from "../rules/deps";
import {
  asRecord,
  asString,
  type ExternalScanner,
  type ExternalScannerOptions,
  externalScanner,
  failure,
  isUsageError,
  parseJsonOutput,
  relativePath,
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
export function createOsvScannerCli(options: ExternalScannerOptions = {}): ExternalScanner {
  return externalScanner(
    {
      id: "osv-scanner",
      adds: "check dependencies in more lockfile formats against the OSV database",
      offline: "Offline mode: osv-scanner needs the network.",
      async scan(context, run) {
        let result = await run(["scan", "source", "-r", "--format", "json", context.rootDir]);
        if (!OK_EXIT_CODES.has(result.exitCode) && isUsageError(result)) {
          result = await run(["--format", "json", "-r", context.rootDir]);
        }
        if (!OK_EXIT_CODES.has(result.exitCode) || result.timedOut) {
          throw failure("osv-scanner", result);
        }
        if (result.exitCode === 128) return [];
        return toFindings(context, parseJsonOutput("osv-scanner", result.stdout));
      },
    },
    options,
  );
}
