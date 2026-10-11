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

/** Prints the next steps as a short list. */
export function printNextSteps(ctx: CliContext, steps: readonly string[]): void {
  if (steps.length === 0) return;
  if (steps.length === 1) {
    ctx.stdout(`\nNext: ${steps[0]}\n`);
    return;
  }
  ctx.stdout(`\nNext:\n${steps.map((step) => `  - ${step}`).join("\n")}\n`);
}
