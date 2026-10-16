import type { ApprovalRequest, Money } from "@opscrew/contracts";

/** Signed amount with currency, for example `+€4.51` or `-$2.00`. */
function moneyChange(money: Money): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
    signDisplay: "always",
  }).format(money.amount);
}

/**
 * What every approval prompt (the terminal's and the MCP dialog's) shows below the request's
 * title: the details, the policy checks that did not pass, the change in the monthly cost and a
 * warning when the change deletes something. Each part ends with an empty line.
 */
export function approvalRequestLines(request: ApprovalRequest): string[] {
  const lines: string[] = [];
  if (request.details.trim() !== "") lines.push(request.details.trimEnd(), "");
  const failures = (request.policy ?? []).filter((result) => !result.passed);
  if (failures.length > 0) {
    lines.push("Policy checks that did not pass:");
    for (const f of failures) {
      const where = f.resource === undefined ? "" : ` (${f.resource})`;
      lines.push(`  ✗ [${f.severity}] ${f.title}${where}: ${f.message}`);
    }
    lines.push("");
  }
  if (request.costDelta !== undefined) {
    lines.push(`Monthly cost change: ${moneyChange(request.costDelta)}`, "");
  }
  if (request.allowDestroy === true) {
    lines.push("WARNING: this change deletes or replaces resources.", "");
  }
  return lines;
}
