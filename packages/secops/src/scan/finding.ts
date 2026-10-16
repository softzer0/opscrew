import { type Finding, SEVERITIES, type Severity } from "@opscrew/contracts";
import { sha256Hex } from "@opscrew/core";

/** Numeric rank per severity; higher is more severe (`critical` = 4 … `info` = 0). */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * Stable finding id: the first 16 hex characters of
 * `sha256(ruleId|file|line|sha256(rawMatch))`. The raw match is only hashed, never stored.
 */
export function findingId(
  ruleId: string,
  file: string | undefined,
  line: number | undefined,
  rawMatch: string,
): string {
  const fingerprint = sha256Hex(rawMatch);
  return sha256Hex(`${ruleId}|${file ?? ""}|${line ?? ""}|${fingerprint}`).slice(0, 16);
}

/** Input for {@link createFinding}: a finding without `id`, plus the raw match to fingerprint. */
export type FindingInput = Omit<Finding, "id"> & {
  /** The exact text that matched (hashed into the id; never stored in the finding). */
  rawMatch: string;
};

/** Builds a {@link Finding} with its stable id. Optional fields left `undefined` are omitted. */
export function createFinding(input: FindingInput): Finding {
  const { rawMatch, ...rest } = input;
  const finding: Finding = { id: findingId(rest.ruleId, rest.file, rest.line, rawMatch), ...rest };
  for (const key of Object.keys(finding) as Array<keyof Finding>) {
    if (finding[key] === undefined) delete finding[key];
  }
  return finding;
}

function compareOptional<T extends string | number>(a: T | undefined, b: T | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

/**
 * Returns a new array sorted by severity (most severe first), then file, then line (findings
 * without a file or line last), then rule id and id, so the order is fully deterministic.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      compareOptional(a.file, b.file) ||
      compareOptional(a.line, b.line) ||
      compareOptional(a.ruleId, b.ruleId) ||
      compareOptional(a.id, b.id),
  );
}

/** Number of findings per severity (every severity present, zero when none). */
export function countFindings(findings: readonly Finding[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
    Severity,
    number
  >;
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}
