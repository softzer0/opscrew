import { OpsCrewError } from "@opscrew/core";

/** A host plan's step or a stack plan's change, as the adapters list them. */
export interface AdapterPlanItem {
  title: string;
  state: "change" | "in-place" | "blocked";
  reason?: string;
}

/** A blocking finding of an adapter's inspection or plan. */
export interface AdapterFinding {
  code: string;
  message: string;
  hint: string;
}

/**
 * The plain-English plan shown before an adapter's approval (`host-apply`, `stack-apply`):
 * `heading` with the counts, every item with its state and reason, the findings, `note`, then the
 * hash as `<label>: <hash>`.
 */
export function describeAdapterPlan(input: {
  heading: string;
  items: readonly AdapterPlanItem[];
  findings: readonly AdapterFinding[];
  note: string;
  hashLabel: string;
  hash: string;
}): string {
  const count = (state: string) => input.items.filter((item) => item.state === state).length;
  const blocked = count("blocked");
  const lines = [
    `${input.heading}: ${count("change")} to change, ${count("in-place")} already in place${blocked > 0 ? `, ${blocked} blocked` : ""}.`,
  ];
  for (const item of input.items) {
    if (item.state === "in-place") {
      lines.push(`  ✓ ${item.title} (already in place)`);
      continue;
    }
    lines.push(`  ${item.state === "change" ? "~" : "✗"} ${item.title}`);
    if (item.reason !== undefined) lines.push(`      ${item.reason}`);
  }
  for (const finding of input.findings) {
    lines.push(`  ! ${finding.message}`, `      ${finding.hint}`);
  }
  lines.push(input.note, `${input.hashLabel}: ${input.hash}`);
  return lines.join("\n");
}

/**
 * The plain stop (`PHASE_PRECONDITION`, nothing changed) for an adapter plan's findings or blocked
 * items: `cannot`, "so it" `nothing` (default `changed nothing`) and the findings (else the blocked
 * items with their reasons), with the findings' hints, `extraHint` when given, or `fallbackHint`
 * when there are none.
 */
export function adapterBlocked(input: {
  cannot: string;
  nothing?: string;
  findings: readonly AdapterFinding[];
  blocked: readonly AdapterPlanItem[];
  extraHint?: string;
  fallbackHint: string;
}): OpsCrewError {
  const reasons =
    input.findings.length > 0
      ? input.findings.map((finding) => finding.message)
      : input.blocked.map((item) => `${item.title}: ${item.reason ?? "blocked"}`);
  const hints = [...new Set(input.findings.map((finding) => finding.hint))];
  if (input.extraHint !== undefined) hints.push(input.extraHint);
  return planStop(
    `${input.cannot}, so it ${input.nothing ?? "changed nothing"}:`,
    reasons.map((reason) => `- ${reason}`),
    hints.length > 0 ? hints.join(" ") : input.fallbackHint,
  );
}

/**
 * The plain stop (`PHASE_PRECONDITION`) when a plan would do more than its step may: `message`,
 * then each problem on its own indented line, and `hint`. Callers check first that there are
 * problems.
 */
export function planStop(message: string, problems: readonly string[], hint: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    [message, ...problems.map((problem) => `  ${problem}`)].join("\n"),
    { hint },
  );
}
