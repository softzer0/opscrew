import type { Finding, FindingCategory, ScanContext, Scanner, Severity } from "@opscrew/contracts";
import { findingId } from "../scan/finding";
import {
  asNumber,
  asRecord,
  asString,
  DEFAULT_TIMEOUT_MS,
  type ExternalScannerOptions,
  failure,
  parseJsonOutput,
  relativePath,
  resolveWhich,
} from "./shared";

const SEVERITY: Record<string, Severity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

const CONFIG_TYPES = new Set(["dockerfile", "docker-compose", "yaml", "json"]);

function toFindings(context: ScanContext, report: unknown): Finding[] {
  const scanned = new Set(context.files);
  const inProject = (target: string) =>
    scanned.has(target) || context.files.some((f) => f.startsWith(`${target}/`));
  const findings: Finding[] = [];
  const results = asRecord(report)?.Results;
  for (const result of Array.isArray(results) ? results : []) {
    const record = asRecord(result);
    const target = asString(record?.Target);
    if (!record || !target) continue;
    const file = relativePath(context.rootDir, target);
    if (!inProject(file)) continue;
    const type = asString(record.Type) ?? "";
    const category: FindingCategory = CONFIG_TYPES.has(type) ? "config" : "iac";
    const misconfigurations = Array.isArray(record.Misconfigurations)
      ? record.Misconfigurations
      : [];
    for (const item of misconfigurations) {
      const m = asRecord(item);
      const id = asString(m?.ID) ?? asString(m?.AVDID);
      if (!m || !id) continue;
      const status = asString(m.Status);
      if (status !== undefined && status !== "FAIL") continue;
      const line = asNumber(asRecord(m.CauseMetadata)?.StartLine);
      const message = asString(m.Message);
      const ruleId = `trivy/${id}`;
      const references = [
        asString(m.PrimaryURL),
        ...(Array.isArray(m.References) ? m.References : []),
      ]
        .filter((r): r is string => typeof r === "string" && r !== "")
        .slice(0, 3);
      findings.push({
        id: findingId(ruleId, file, line, `${ruleId}|${file}|${line ?? ""}|${message ?? ""}`),
        ruleId,
        title: asString(m.Title) ?? id,
        severity: SEVERITY[(asString(m.Severity) ?? "").toUpperCase()] ?? "info",
        category,
        file,
        ...(line !== undefined && line > 0 ? { line } : {}),
        ...(message
          ? { evidence: message.length > 200 ? `${message.slice(0, 199)}…` : message }
          : {}),
        description: asString(m.Description) ?? message ?? `Trivy check ${id} failed.`,
        remediation: asString(m.Resolution) ?? "Follow the linked guidance for this check.",
        ...(references.length > 0 ? { references: [...new Set(references)] } : {}),
        source: "trivy",
      });
    }
  }
  return findings;
}

/**
 * Trivy misconfiguration scanning (`trivy fs --scanners misconfig`). Skipped in offline mode because
 * Trivy may download its checks bundle.
 */
export function createTrivyScanner(options: ExternalScannerOptions = {}): Scanner & {
  skipReason(context: ScanContext): string | undefined;
} {
  const which = resolveWhich(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: "trivy",
    kind: "external",
    async isAvailable(context) {
      return !context.offline && which("trivy") !== undefined;
    },
    skipReason(context) {
      if (context.offline && which("trivy") !== undefined) {
        return "Offline mode: trivy may download its checks.";
      }
      return undefined;
    },
    async scan(context) {
      const bin = which("trivy");
      if (!bin) return [];
      const result = await context.runner.run(
        bin,
        ["fs", "--scanners", "misconfig", "--format", "json", "--quiet", context.rootDir],
        { cwd: context.rootDir, timeoutMs },
      );
      if (result.exitCode !== 0 || result.timedOut) throw failure("trivy", result);
      return toFindings(context, parseJsonOutput("trivy", result.stdout));
    },
  };
}
