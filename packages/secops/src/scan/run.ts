import path from "node:path";
import type {
  CommandRunner,
  FetchLike,
  Finding,
  ScanContext,
  Scanner,
  ScannerStatus,
  ScanReport,
} from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { defaultScanners } from "../scanners";
import { createScanContext, type ScanContextOptions } from "./context";
import { countFindings, SEVERITY_RANK, sortFindings } from "./finding";

/**
 * Optional extension a scanner may implement to explain why `isAvailable` returned false (for
 * example "offline mode" or "superseded by osv-scanner"). The engine falls back to a generic
 * reason when it is absent.
 */
export interface ScannerSkipReason {
  skipReason?(context: ScanContext): string | undefined;
}

/** Progress events emitted by {@link runScan}, one `started` and one final event per scanner. */
export type ScanProgressEvent =
  | { type: "started"; scanner: string }
  | {
      type: "finished";
      scanner: string;
      status: ScannerStatus["status"];
      reason?: string;
      findings: number;
    };

/** Options for {@link runScan}. */
export interface RunScanOptions {
  /** When true, no scanner may use the network. */
  offline: boolean;
  fetch: FetchLike;
  runner: CommandRunner;
  /** Scanners to run (default: `defaultScanners()`). */
  scanners?: readonly Scanner[];
  /** OpsCrew version written into the report. */
  version: string;
  onProgress?: (event: ScanProgressEvent) => void;
  /** Stop listing project files after this many (see `createScanContext`). */
  maxFiles?: number;
  /** Clock for `startedAt` / `finishedAt` (default: `new Date()`). */
  now?: () => Date;
}

/** Scanners running at the same time. */
const CONCURRENCY = 4;

interface ScannerOutcome {
  status: ScannerStatus;
  findings: Finding[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error !== "" ? error : "unknown error";
}

/** Removes the absolute project root from user-visible text and masks anything secret-shaped. */
function createSanitizer(rootDir: string): (text: string) => string {
  const redactor = new Redactor();
  // Never strip a bare filesystem root such as `/` or `C:\`.
  const isFsRoot = path.parse(rootDir).root === rootDir;
  const roots = isFsRoot
    ? []
    : [...new Set([rootDir, rootDir.replace(/\\/g, "/")])].sort((a, b) => b.length - a.length);
  // `<root>/x` → `x`, a bare `<root>` → `.`; `<root>-other` (a sibling directory) is left alone.
  const pattern =
    roots.length === 0
      ? undefined
      : new RegExp(
          `(?:${roots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:[\\\\/]|(?![\\w.-]))`,
          // Windows paths are case-insensitive (`d:\app` and `D:\app` are the same directory).
          process.platform === "win32" ? "gi" : "g",
        );
  return (text) => {
    const out = pattern
      ? text.replace(pattern, (match) => (/[\\/]$/.test(match) ? "" : "."))
      : text;
    return redactor.redact(out);
  };
}

/** Repo-relative POSIX path for a finding's `file`, or `undefined` when it lies outside the root. */
function normalizeFile(rootDir: string, file: string): string | undefined {
  const posix = file.replace(/\\/g, "/");
  if (!path.isAbsolute(file) && !/^[A-Za-z]:\//.test(posix)) {
    return posix.replace(/^\.\//, "");
  }
  const relative = path.relative(rootDir, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function sanitizeFinding(
  finding: Finding,
  rootDir: string,
  sanitize: (text: string) => string,
): Finding {
  const out: Finding = {
    ...finding,
    title: sanitize(finding.title),
    description: sanitize(finding.description),
    remediation: sanitize(finding.remediation),
  };
  if (finding.evidence !== undefined) out.evidence = sanitize(finding.evidence);
  if (finding.references !== undefined) out.references = [...finding.references];
  if (finding.file !== undefined) {
    const file = normalizeFile(rootDir, finding.file);
    if (file === undefined) {
      // A line number without its file is meaningless.
      delete out.file;
      delete out.line;
    } else {
      out.file = file;
    }
  }
  return out;
}

/** Rules from different scanners that report the same problem at the same place. */
const SHARED_FAMILIES: Readonly<Record<string, string>> = {
  "config/client-exposed-secret": "client-exposed-secret-env",
  "supabase/service-role-env-exposed": "client-exposed-secret-env",
};

/**
 * Duplicate family for findings at the same file and line. Different scanners report the same
 * leaked value under different rule names, so every secret shares one family; a few equivalent
 * rules share a named family; everything else uses the rule id.
 */
function ruleFamily(finding: Finding): string {
  if (finding.category === "secret") return "secret";
  return SHARED_FAMILIES[finding.ruleId] ?? finding.ruleId;
}

/**
 * Removes duplicates: the same finding id, or the same (file, line, family) reported by a
 * different scanner or by the same rule. The most severe finding wins; ties keep the first
 * (scanner order).
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const kept: Array<Finding | undefined> = [];
  const byId = new Set<string>();
  const byLocation = new Map<string, number[]>();
  for (const finding of findings) {
    if (byId.has(finding.id)) continue;
    byId.add(finding.id);
    if (finding.file === undefined || finding.line === undefined) {
      kept.push(finding);
      continue;
    }
    const key = `${finding.file}\0${finding.line}\0${ruleFamily(finding)}`;
    const indexes = byLocation.get(key) ?? [];
    const duplicateIndex = indexes.find((index) => {
      const other = kept[index];
      return (
        other !== undefined && (other.source !== finding.source || other.ruleId === finding.ruleId)
      );
    });
    if (duplicateIndex !== undefined) {
      const other = kept[duplicateIndex];
      if (other && SEVERITY_RANK[finding.severity] > SEVERITY_RANK[other.severity]) {
        kept[duplicateIndex] = finding;
      }
      continue;
    }
    indexes.push(kept.length);
    byLocation.set(key, indexes);
    kept.push(finding);
  }
  return kept.filter((finding): finding is Finding => finding !== undefined);
}

async function runOne(
  scanner: Scanner,
  context: ScanContext,
  sanitize: (text: string) => string,
): Promise<ScannerOutcome> {
  const started = performance.now();
  const duration = () => Math.round(performance.now() - started);
  try {
    if (!(await scanner.isAvailable(context))) {
      const custom = (scanner as Scanner & ScannerSkipReason).skipReason?.(context);
      const reason =
        custom ??
        (scanner.kind === "external"
          ? `${scanner.id} is not installed; install it for extra coverage.`
          : "Not available for this project.");
      return {
        status: { id: scanner.id, status: "skipped", reason: sanitize(reason) },
        findings: [],
      };
    }
    const findings = await scanner.scan(context);
    return { status: { id: scanner.id, status: "ran", durationMs: duration() }, findings };
  } catch (error) {
    return {
      status: {
        id: scanner.id,
        status: "failed",
        reason: sanitize(`${scanner.id} failed: ${errorMessage(error)}`),
        durationMs: duration(),
      },
      findings: [],
    };
  }
}

/**
 * Runs every available scanner (at most four at a time) over `root` and returns the report:
 * per-scanner status (ran / skipped / failed with reason and duration; one scanner failing never
 * stops the scan), findings deduplicated, sanitized (repo-relative paths, secret-shaped text
 * masked) and sorted, counts per severity, and `project` = the directory name.
 */
export async function runScan(root: string, options: RunScanOptions): Promise<ScanReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const scanners = options.scanners ?? defaultScanners();
  const contextOptions: ScanContextOptions = {
    offline: options.offline,
    fetch: options.fetch,
    runner: options.runner,
  };
  if (options.maxFiles !== undefined) contextOptions.maxFiles = options.maxFiles;
  const context = await createScanContext(root, contextOptions);
  const sanitize = createSanitizer(context.rootDir);
  const notify = (event: ScanProgressEvent) => {
    try {
      options.onProgress?.(event);
    } catch {
      // A failing progress callback must not break the scan.
    }
  };

  const outcomes: ScannerOutcome[] = new Array(scanners.length);
  let next = 0;
  const worker = async () => {
    while (next < scanners.length) {
      const index = next++;
      const scanner = scanners[index];
      if (!scanner) continue;
      notify({ type: "started", scanner: scanner.id });
      const outcome = await runOne(scanner, context, sanitize);
      outcomes[index] = outcome;
      const event: ScanProgressEvent = {
        type: "finished",
        scanner: scanner.id,
        status: outcome.status.status,
        findings: outcome.findings.length,
      };
      if (outcome.status.reason !== undefined) event.reason = outcome.status.reason;
      notify(event);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scanners.length) }, worker));

  const raw = outcomes.flatMap((outcome) => outcome.findings);
  const findings = sortFindings(
    dedupeFindings(raw.map((finding) => sanitizeFinding(finding, context.rootDir, sanitize))),
  );
  return {
    tool: "opscrew",
    version: options.version,
    project: path.basename(context.rootDir),
    startedAt,
    finishedAt: now().toISOString(),
    findings,
    scanners: outcomes.map((outcome) => outcome.status),
    counts: countFindings(findings),
  };
}
