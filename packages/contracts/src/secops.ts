import type { IsoDateTime, Severity } from "./common";
import type { CommandRunner, FetchLike } from "./io";

export type FindingCategory =
  | "secret"
  | "supabase"
  | "firebase"
  | "dependency"
  | "config"
  | "iac"
  | "host"
  | "exposure";

export interface Finding {
  /** Stable id: hash of ruleId + file + line + evidence fingerprint. */
  id: string;
  ruleId: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  /** Repo-relative POSIX path. */
  file?: string;
  line?: number;
  /** Masked evidence, never the full secret (for example `ghp_…(40 chars)`). */
  evidence?: string;
  /** What is wrong and why it matters, in plain English. */
  description: string;
  /** What to do about it, in plain English. */
  remediation: string;
  references?: string[];
  /** Scanner id that produced the finding, for example `opscrew-secrets`, `gitleaks`, `osv`. */
  source: string;
}

export interface ScanContext {
  /** Absolute project root. */
  rootDir: string;
  /** Repo-relative POSIX paths to scan (ignored and oversized files already removed). */
  files: readonly string[];
  /** Repo-relative POSIX paths tracked by git, when the project is a git repository. */
  gitTracked?: ReadonlySet<string>;
  readFile(relativePath: string): Promise<string>;
  /** When true, scanners MUST NOT use the network. */
  offline: boolean;
  fetch: FetchLike;
  runner: CommandRunner;
}

export interface Scanner {
  readonly id: string;
  readonly kind: "builtin" | "external";
  /** External scanners return false when their binary is not installed. */
  isAvailable(context: ScanContext): Promise<boolean>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export interface ScannerStatus {
  id: string;
  status: "ran" | "skipped" | "failed";
  /** Why it was skipped or how it failed, in plain English. */
  reason?: string;
  durationMs?: number;
}

export interface ScanReport {
  tool: "opscrew";
  version: string;
  /** Project directory name (never an absolute path, so reports are shareable). */
  project: string;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
  findings: Finding[];
  scanners: ScannerStatus[];
  counts: Record<Severity, number>;
}

/** Result of one verification or hardening check against a live deployment. */
export interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn" | "skip";
  severity: Severity;
  message: string;
  remediation?: string;
  /** Host, URL or resource checked. */
  target?: string;
}
