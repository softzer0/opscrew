import type { Finding } from "@opscrew/contracts";
import { maskSecret } from "@opscrew/core";
import { findingId } from "../scan/finding";
import {
  asNumber,
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

const REPORT_ARGS = [
  "--report-format",
  "json",
  "--report-path",
  "-",
  "--redact",
  "--no-banner",
  "--exit-code",
  "0",
];

/**
 * gitleaks secret scanning (`gitleaks dir`, falling back to `gitleaks detect --no-git` on versions
 * before 8.19). Only files OpsCrew scans are reported (ignored files such as `node_modules` or a
 * git-ignored `.env` are dropped); findings in git-tracked files are critical.
 */
export function createGitleaksScanner(options: ExternalScannerOptions = {}): ExternalScanner {
  return externalScanner(
    {
      id: "gitleaks",
      adds: "catch more kinds of leaked keys and tokens",
      async scan(context, runTool) {
        const run = (args: string[]) => runTool([...args, ...REPORT_ARGS]);
        let result = await run(["dir", context.rootDir]);
        if (result.exitCode !== 0 && isUsageError(result)) {
          result = await run(["detect", "--no-git", "--source", context.rootDir]);
        }
        if (result.exitCode !== 0) throw failure("gitleaks", result);
        const report = parseJsonOutput("gitleaks", result.stdout) ?? [];
        if (!Array.isArray(report)) throw new Error("gitleaks printed an unexpected report.");

        const scanned = new Set(context.files);
        const findings: Finding[] = [];
        for (const item of report) {
          const leak = asRecord(item);
          const rule = asString(leak?.RuleID);
          const path = asString(leak?.File);
          if (!leak || !rule || !path) continue;
          const file = relativePath(context.rootDir, path);
          if (!scanned.has(file)) continue;
          const line = asNumber(leak.StartLine);
          const secret = asString(leak.Secret);
          const tracked = context.gitTracked?.has(file) ?? false;
          const ruleId = `gitleaks/${rule}`;
          findings.push({
            id: findingId(
              ruleId,
              file,
              line,
              `${rule}|${file}|${line ?? ""}|${asNumber(leak.StartColumn) ?? ""}`,
            ),
            ruleId,
            title: `Possible secret: ${asString(leak.Description) ?? rule}`,
            severity: tracked ? "critical" : "high",
            category: "secret",
            file,
            ...(line !== undefined ? { line } : {}),
            evidence:
              secret === undefined || secret.includes("REDACTED")
                ? `${rule} match (redacted)`
                : maskSecret(secret),
            description: tracked
              ? "gitleaks found what looks like a credential in a file tracked by git. Anyone who can read the repository or its history can use it."
              : "gitleaks found what looks like a credential in a project file that is not ignored, so it can be committed by accident.",
            remediation:
              "If it is real, revoke and rotate it now, remove it from the code (and from git history if it was committed), and load it from an environment variable or secret store instead.",
            references: ["https://github.com/gitleaks/gitleaks"],
            source: "gitleaks",
          });
        }
        return findings;
      },
    },
    options,
  );
}
