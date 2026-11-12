/**
 * PHP's supported versions (feature 027, plan 9): each branch's end of active support and of
 * security support, as php.net lists them, so `opscrew secure` can say whether the PHP an app runs
 * on still gets security fixes. The table is dated: a branch released after it is unknown to it.
 */

/** When {@link PHP_BRANCHES} was read from php.net/supported-versions.php and php.net/eol.php. */
export const PHP_BRANCHES_READ = "2026-11-12";

/** Where PHP lists its supported versions, for a user's own look. */
export const PHP_SUPPORTED_VERSIONS_URL = "https://www.php.net/supported-versions.php";

/** A PHP branch: the last day of its bug fixes (when still listed) and of its security fixes, UTC. */
export interface PhpBranch {
  branch: string;
  activeUntil?: string;
  securityUntil: string;
}

/** PHP's branches from 5.6 on, newest first, as php.net listed them on {@link PHP_BRANCHES_READ}. */
export const PHP_BRANCHES: readonly PhpBranch[] = [
  { branch: "8.5", activeUntil: "2027-12-31", securityUntil: "2029-12-31" },
  { branch: "8.4", activeUntil: "2026-12-31", securityUntil: "2028-12-31" },
  { branch: "8.3", activeUntil: "2025-12-31", securityUntil: "2027-12-31" },
  { branch: "8.2", activeUntil: "2024-12-31", securityUntil: "2026-12-31" },
  { branch: "8.1", securityUntil: "2025-12-31" },
  { branch: "8.0", securityUntil: "2023-11-26" },
  { branch: "7.4", securityUntil: "2022-11-28" },
  { branch: "7.3", securityUntil: "2021-12-06" },
  { branch: "7.2", securityUntil: "2020-11-30" },
  { branch: "7.1", securityUntil: "2019-12-01" },
  { branch: "7.0", securityUntil: "2019-01-10" },
  { branch: "5.6", securityUntil: "2018-12-31" },
];

/**
 * Where a PHP version stands on `now`: `active` (bug and security fixes), `security` (security
 * fixes only), `end-of-life` (none since the day after `securityUntil`), or `unknown` (a branch
 * the table doesn't list).
 */
export type PhpSupport =
  | { state: "active" | "security" | "end-of-life"; branch: PhpBranch }
  | { state: "unknown" };

/** {@link PhpSupport} of `version` (`8.3` or `8.3.12`) on `now`, from {@link PHP_BRANCHES}. */
export function phpSupport(version: string, now: Date): PhpSupport {
  const branch = PHP_BRANCHES.find((b) => b.branch === /^\d+\.\d+/.exec(version)?.[0]);
  if (branch === undefined) return { state: "unknown" };
  const today = now.toISOString().slice(0, 10);
  if (today > branch.securityUntil) return { state: "end-of-life", branch };
  if (branch.activeUntil !== undefined && today <= branch.activeUntil) {
    return { state: "active", branch };
  }
  return { state: "security", branch };
}
