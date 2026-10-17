import type { CheckResult, Severity } from "@opscrew/contracts";
import { plural } from "@opscrew/core";

/** The mark a check list shows before each check: `✓` passed, `!` warning, `✗` failed, `-` skipped. */
export const CHECK_MARK: Readonly<Record<CheckResult["status"], string>> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
  skip: "-",
};

/** One check's result; `remediation` and `target` only when given. */
export function checkResult(
  id: string,
  title: string,
  severity: Severity,
  status: CheckResult["status"],
  message: string,
  extra: { remediation?: string; target?: string } = {},
): CheckResult {
  return {
    id,
    title,
    severity,
    status,
    message,
    ...(extra.remediation !== undefined ? { remediation: extra.remediation } : {}),
    ...(extra.target !== undefined ? { target: extra.target } : {}),
  };
}

/** `check` with `edit` applied to the texts it shows: title, message, remediation and target. */
export function editCheckText(check: CheckResult, edit: (text: string) => string): CheckResult {
  return {
    ...check,
    title: edit(check.title),
    message: edit(check.message),
    ...(check.remediation !== undefined ? { remediation: edit(check.remediation) } : {}),
    ...(check.target !== undefined ? { target: edit(check.target) } : {}),
  };
}

/** One-line summary of check results, e.g. `9 passed, 1 failed, 1 warning, 0 skipped`. */
export function summarizeChecks(checks: readonly CheckResult[]): string {
  const count = (status: CheckResult["status"]) =>
    checks.filter((check) => check.status === status).length;
  return `${count("pass")} passed, ${count("fail")} failed, ${plural(count("warn"), "warning")}, ${count("skip")} skipped`;
}
