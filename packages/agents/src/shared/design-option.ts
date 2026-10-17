import { formatMoney } from "@opscrew/core";
import type { DesignOption } from "@opscrew/plan-schema";
import { priceLabel } from "../design/cost";

/**
 * One design option as it is listed for the user to choose from: `Title (id): €6.09/month, live
 * price — fits the budget, recommended`.
 */
export function designOptionLine(option: DesignOption): string {
  const marks = [
    option.fitsBudget ? "fits the budget" : "over budget",
    ...(option.recommended ? ["recommended"] : []),
  ];
  return `${option.title} (${option.id}): ${formatMoney(option.cost.monthly)}/month, ${priceLabel(option.cost)} — ${marks.join(", ")}`;
}
