import type { PhaseDeps } from "@opscrew/agents";
import type { CliContext } from "../context";

/** `$0.0123` for small amounts, `$1.23` from one dollar up. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

/**
 * Prints the model spend of this run and the project total from `.opscrew/costs.jsonl`. Call it
 * only when a model ran.
 */
export async function printCosts(ctx: CliContext, deps: PhaseDeps, runUsd: number): Promise<void> {
  let total: number | undefined;
  try {
    total = await deps.costs.total();
  } catch {
    total = undefined;
  }
  const project = total === undefined ? "" : `; ${formatUsd(total)} in total for this project`;
  ctx.stdout(`Model cost: ${formatUsd(runUsd)} for this run${project}.\n`);
}

/** `rows` (the header first) as plain text: each column as wide as its widest cell. */
export function textTable(rows: readonly (readonly string[])[]): string {
  const widths = (rows[0] ?? []).map((_, i) =>
    Math.max(...rows.map((row) => (row[i] ?? "").length)),
  );
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
    )
    .join("\n");
}

/** Prints the next steps as a short list. */
export function printNextSteps(ctx: CliContext, steps: readonly string[]): void {
  if (steps.length === 0) return;
  if (steps.length === 1) {
    ctx.stdout(`\nNext: ${steps[0]}\n`);
    return;
  }
  ctx.stdout(`\nNext:\n${steps.map((step) => `  - ${step}`).join("\n")}\n`);
}
