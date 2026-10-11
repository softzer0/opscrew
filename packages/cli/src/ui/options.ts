import { convertMoney, EXCHANGE_RATE_NOTE, formatMoney, priceLabel } from "@opscrew/agents";
import type { DesignOption, Money } from "@opscrew/plan-schema";
import { cancelled, clackPrompts, type UiPrompts } from "./prompts";

/** Marker shown next to the recommended option. */
export const RECOMMENDED_MARKER = "★ recommended";

export interface ChooseOptionOptions {
  /** Prompts to ask with (default clack). */
  prompts?: UiPrompts;
  /** Where the cost table is printed (normally `ctx.stdout`, which redacts). */
  write: (text: string) => void;
  /** The user's monthly budget, shown above the table and converted when currencies differ. */
  budget?: Money;
}

const gb = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)} GB`;

function pad(cells: string[][]): string[] {
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? "").length)));
  return cells.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths?.[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * Renders the design options as a plain-text table: id, server, size, location, monthly cost,
 * whether it fits the budget, and the recommended marker. Followed by each option's trade-offs and
 * where the prices come from. Deterministic, so it can be tested and printed anywhere.
 */
export function renderOptionsTable(options: readonly DesignOption[], budget?: Money): string {
  const rows = [
    ["", "Option", "Server", "Size", "Location", "Per month", "Budget", ""],
    ...options.map((option, index) => {
      const { target } = option;
      let monthly = formatMoney(option.cost.monthly);
      if (budget !== undefined && budget.currency !== option.cost.monthly.currency) {
        monthly += ` (≈ ${formatMoney(convertMoney(option.cost.monthly, budget.currency))})`;
      }
      return [
        `${index + 1}.`,
        option.id,
        `${target.serverType} (${target.cpuType})`,
        `${target.vcpus} vCPU, ${gb(target.memoryGb)} RAM, ${gb(target.diskGb)} disk`,
        target.location,
        monthly,
        option.fitsBudget ? "fits" : "over budget",
        option.recommended ? RECOMMENDED_MARKER : "",
      ];
    }),
  ];
  const lines = [""];
  if (budget !== undefined) lines.push(`Your budget: ${formatMoney(budget)} per month`, "");
  lines.push(...pad(rows), "");
  for (const option of options) {
    lines.push(`${option.title} (${option.id}): ${option.summary}`);
    for (const tradeoff of option.tradeoffs) lines.push(`  - ${tradeoff}`);
  }
  const labels = [...new Set(options.map((option) => priceLabel(option.cost)))];
  lines.push("", `Prices: ${labels.join("; ")}.`);
  if (
    budget !== undefined &&
    options.some((option) => option.cost.monthly.currency !== budget.currency)
  ) {
    lines.push(EXCHANGE_RATE_NOTE);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Prints the cost table and asks which option to use, starting on the recommended one. Returns the
 * chosen option id. Cancelling throws a user-facing error.
 */
export async function chooseOption(
  options: readonly DesignOption[],
  settings: ChooseOptionOptions,
): Promise<string> {
  const prompts = settings.prompts ?? clackPrompts;
  settings.write(renderOptionsTable(options, settings.budget));
  const recommended = options.find((option) => option.recommended);
  const answer = await prompts.select({
    message: "Which option should OpsCrew plan?",
    options: options.map((option) => ({
      value: option.id,
      label: `${option.title}: ${formatMoney(option.cost.monthly)}/month`,
      hint: [
        option.fitsBudget ? "fits the budget" : "over budget",
        ...(option.recommended ? [RECOMMENDED_MARKER] : []),
      ].join(", "),
    })),
    ...(recommended === undefined ? {} : { initialValue: recommended.id }),
  });
  if (prompts.isCancel(answer)) throw cancelled("the choice", "opscrew design");
  return answer;
}
