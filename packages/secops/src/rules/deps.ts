import type { FetchLike, Finding, ScanContext, Scanner, Severity } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import {
  collectLockedPackages,
  isLockfile,
  type LockedPackage,
  SUPPORTED_LOCKFILES,
} from "../lockfiles";
import { findingId } from "../scan/finding";

export const OSV_API = "https://api.osv.dev/v1";
const BATCH_SIZE = 500;
const MAX_DETAILS = 100;
const DETAIL_CONCURRENCY = 8;
const MAX_PAGES = 3;
const TIMEOUT_MS = 15_000;

/** A pinned package as reported by a lockfile or by osv-scanner (any ecosystem). */
export type PackageRef = Pick<LockedPackage, "name" | "version" | "file"> & { ecosystem: string };

/** The subset of an OSV vulnerability record OpsCrew reads. */
export interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type?: string; score?: string }[];
  database_specific?: { severity?: unknown };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type?: string; events?: Record<string, string>[] }[];
    ecosystem_specific?: { severity?: unknown };
    database_specific?: { severity?: unknown };
  }[];
  references?: { type?: string; url?: string }[];
}

const LABEL_SEVERITY: Record<string, Severity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MODERATE: "medium",
  MEDIUM: "medium",
  LOW: "low",
};

/** Maps a CVSS base score to a severity (≥ 9 critical, ≥ 7 high, ≥ 4 medium, ≥ 0.1 low). */
export function severityFromScore(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score >= 0.1) return "low";
  return "info";
}

const CVSS3 = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

function roundUp(value: number): number {
  const scaled = Math.round(value * 100_000);
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}

/** CVSS v3.0/v3.1 base score from a vector string, or undefined when it is not a valid v3 vector. */
export function cvss3BaseScore(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//.test(vector)) return undefined;
  const metrics = new Map(
    vector
      .split("/")
      .slice(1)
      .map((part) => part.split(":") as [string, string]),
  );
  const pick = <T extends Record<string, number>>(table: T, key: string): number | undefined =>
    table[metrics.get(key) as keyof T];
  const scope = metrics.get("S");
  const av = pick(CVSS3.AV, "AV");
  const ac = pick(CVSS3.AC, "AC");
  const ui = pick(CVSS3.UI, "UI");
  const c = pick(CVSS3.CIA, "C");
  const i = pick(CVSS3.CIA, "I");
  const a = pick(CVSS3.CIA, "A");
  const prKey = metrics.get("PR");
  const pr =
    prKey === "N"
      ? 0.85
      : prKey === "L"
        ? scope === "C"
          ? 0.68
          : 0.62
        : prKey === "H"
          ? scope === "C"
            ? 0.5
            : 0.27
          : undefined;
  if ([av, ac, ui, c, i, a, pr].some((v) => v === undefined) || (scope !== "U" && scope !== "C")) {
    return undefined;
  }
  const iss = 1 - (1 - (c as number)) * (1 - (i as number)) * (1 - (a as number));
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  const exploitability = 8.22 * (av as number) * (ac as number) * (pr as number) * (ui as number);
  if (impact <= 0) return 0;
  return scope === "U"
    ? roundUp(Math.min(impact + exploitability, 10))
    : roundUp(Math.min(1.08 * (impact + exploitability), 10));
}

function labelSeverity(value: unknown): Severity | undefined {
  return typeof value === "string" ? LABEL_SEVERITY[value.toUpperCase()] : undefined;
}

/**
 * Severity of an OSV record: the advisory's label (`CRITICAL/HIGH/MODERATE/LOW`) when present,
 * else the CVSS v3 base score (or a bare numeric score), else `medium`.
 */
export function osvSeverity(vuln: OsvVulnerability): Severity {
  const labelled =
    labelSeverity(vuln.database_specific?.severity) ??
    vuln.affected
      ?.map(
        (a) =>
          labelSeverity(a.database_specific?.severity) ??
          labelSeverity(a.ecosystem_specific?.severity),
      )
      .find((s) => s !== undefined);
  if (labelled) return labelled;
  for (const entry of vuln.severity ?? []) {
    const score = entry.score ?? "";
    const numeric = /^\d+(?:\.\d+)?$/.test(score) ? Number(score) : cvss3BaseScore(score);
    if (numeric !== undefined) return severityFromScore(numeric);
  }
  return "medium";
}

/** Compares dotted versions numerically segment by segment (tolerant of pre-release suffixes). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l - r;
    return String(l) < String(r) ? -1 : 1;
  }
  return 0;
}

/** The lowest fixed version above the installed one for this package, when the record has one. */
export function fixedVersion(
  vuln: OsvVulnerability,
  pkg: Pick<LockedPackage, "name" | "version">,
): string | undefined {
  const fixes: string[] = [];
  for (const affected of vuln.affected ?? []) {
    const name = affected.package?.name;
    if (name !== undefined && name.toLowerCase() !== pkg.name.toLowerCase()) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) if (event.fixed) fixes.push(event.fixed);
    }
  }
  const above = fixes.filter((v) => compareVersions(v, pkg.version) > 0).sort(compareVersions);
  return above[0];
}

/** Rule id `deps/<GHSA-or-CVE-id>`: the record id when it is one, else its first GHSA/CVE alias. */
export function depsRuleId(vuln: Pick<OsvVulnerability, "id" | "aliases">): string {
  const preferred = [vuln.id, ...(vuln.aliases ?? [])].find((id) => /^(GHSA|CVE)-/.test(id));
  return `deps/${preferred ?? vuln.id}`;
}

function shorten(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Builds the finding for one vulnerable package (shared by the OSV API and osv-scanner paths). */
export function dependencyFinding(
  pkg: PackageRef,
  vuln: OsvVulnerability,
  options: { source: string; severity?: Severity },
): Finding {
  const ruleId = depsRuleId(vuln);
  const fixed = fixedVersion(vuln, pkg);
  const about = vuln.summary ?? (vuln.details ? shorten(vuln.details) : undefined);
  const references = [
    `https://osv.dev/vulnerability/${vuln.id}`,
    ...(vuln.references ?? [])
      .filter((r) => r.type === "ADVISORY" && typeof r.url === "string")
      .map((r) => r.url as string)
      .slice(0, 2),
  ];
  return {
    id: findingId(ruleId, pkg.file, undefined, `${pkg.ecosystem}:${pkg.name}@${pkg.version}`),
    ruleId,
    title: `${pkg.name} ${pkg.version} has a known vulnerability (${vuln.id})`,
    severity: options.severity ?? osvSeverity(vuln),
    category: "dependency",
    file: pkg.file,
    evidence: `${pkg.name}@${pkg.version}`,
    description: about
      ? `${pkg.name} ${pkg.version}: ${about}`
      : `${pkg.name} ${pkg.version} is affected by ${vuln.id}.`,
    remediation: fixed
      ? `Upgrade ${pkg.name} to ${fixed} or later, then regenerate ${pkg.file}.`
      : `No fixed version of ${pkg.name} is published yet. Read the advisory and remove or replace the package if the vulnerable code path is used.`,
    references: [...new Set(references)],
    source: options.source,
  };
}

async function osvRequest(fetch: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `Could not reach api.osv.dev (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!response.ok) throw new Error(`api.osv.dev answered HTTP ${response.status}.`);
  return response.json();
}

interface BatchResult {
  vulns?: { id?: string }[];
  next_page_token?: string;
}

/** Vulnerability ids per package (index-aligned with `packages`), following page tokens. */
async function queryBatch(
  fetch: FetchLike,
  packages: readonly LockedPackage[],
): Promise<string[][]> {
  const ids: string[][] = packages.map(() => []);
  for (let start = 0; start < packages.length; start += BATCH_SIZE) {
    let pending = packages.slice(start, start + BATCH_SIZE).map((pkg, offset) => ({
      index: start + offset,
      pkg,
      pageToken: undefined as string | undefined,
    }));
    for (let page = 0; page <= MAX_PAGES && pending.length > 0; page++) {
      const body = {
        queries: pending.map(({ pkg, pageToken }) => ({
          package: { name: pkg.name, ecosystem: pkg.ecosystem },
          version: pkg.version,
          ...(pageToken ? { page_token: pageToken } : {}),
        })),
      };
      const json = (await osvRequest(fetch, `${OSV_API}/querybatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })) as { results?: BatchResult[] };
      const results = Array.isArray(json?.results) ? json.results : [];
      const next: typeof pending = [];
      pending.forEach((item, i) => {
        const result = results[i];
        for (const vuln of result?.vulns ?? []) {
          if (typeof vuln.id === "string") ids[item.index]?.push(vuln.id);
        }
        if (result?.next_page_token) next.push({ ...item, pageToken: result.next_page_token });
      });
      pending = next;
    }
  }
  return ids;
}

async function vulnDetails(fetch: FetchLike, id: string): Promise<OsvVulnerability> {
  let response: Response;
  try {
    response = await fetch(`${OSV_API}/vulns/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Could not reach api.osv.dev (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!response.ok) return { id }; // details are optional; the id alone still makes a finding
  const json = (await response.json()) as OsvVulnerability;
  return typeof json?.id === "string" ? json : { id };
}

export interface OsvScannerOptions {
  /** Locates executables (default: `findExecutable` on `process.env`). */
  which?: (name: string) => string | undefined;
}

/**
 * Dependency vulnerabilities from the OSV API (`osv`): skipped offline, when no supported lockfile
 * exists, or when `osv-scanner` is installed (it supersedes the API lookup).
 */
export function createOsvScanner(options: OsvScannerOptions = {}): Scanner & {
  skipReason(context: ScanContext): string | undefined;
} {
  const which = options.which ?? ((name: string) => findExecutable(name));
  const hasLockfile = (context: ScanContext) => context.files.some(isLockfile);
  return {
    id: "osv",
    kind: "builtin",
    async isAvailable(context) {
      return !context.offline && hasLockfile(context) && which("osv-scanner") === undefined;
    },
    skipReason(context) {
      if (context.offline) return "Offline mode: dependency lookups need api.osv.dev.";
      if (!hasLockfile(context)) {
        return `No supported lockfile found (${SUPPORTED_LOCKFILES.join(", ")}).`;
      }
      if (which("osv-scanner") !== undefined)
        return "Superseded by osv-scanner, which is installed.";
      return undefined;
    },
    async scan(context) {
      const packages = await collectLockedPackages(context);
      if (packages.length === 0) return [];
      const idsPerPackage = await queryBatch(context.fetch, packages);
      const unique = [...new Set(idsPerPackage.flat())];
      const details = new Map<string, OsvVulnerability>();
      const wanted = unique.slice(0, MAX_DETAILS);
      for (let i = 0; i < wanted.length; i += DETAIL_CONCURRENCY) {
        const chunk = wanted.slice(i, i + DETAIL_CONCURRENCY);
        const records = await Promise.all(chunk.map((id) => vulnDetails(context.fetch, id)));
        for (const [j, id] of chunk.entries()) details.set(id, records[j] ?? { id });
      }
      const findings: Finding[] = [];
      packages.forEach((pkg, index) => {
        for (const id of new Set(idsPerPackage[index])) {
          findings.push(dependencyFinding(pkg, details.get(id) ?? { id }, { source: "osv" }));
        }
      });
      return findings;
    },
  };
}
