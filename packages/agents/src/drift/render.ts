import type { ResourceAction } from "@opscrew/contracts";
import { engineLabel } from "@opscrew/iac-engine";
import type { DriftReport } from "./types";

const SYMBOL: Record<ResourceAction, string> = {
  create: "+",
  update: "~",
  delete: "-",
  replace: "±",
  read: "?",
  "no-op": " ",
};

const byAddress = (a: { address: string }, b: { address: string }) =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Plain-text drift report for the terminal: resources changed outside OpsCrew (attribute names,
 * never values), pending infrastructure changes and generated files that differ. Deterministic:
 * the same report always renders the same text, whatever the order of its lists.
 */
export function renderDriftReport(report: DriftReport): string {
  const lines = [
    `OpsCrew drift check (${engineLabel(report.engine.name)} ${report.engine.version}, ${report.checkedAt})`,
    "",
  ];
  const drift = [...report.drift].sort(byAddress);
  const pending = [...report.pending].sort(byAddress);
  const files = [
    ...report.files.changed.map((path) => ({ path, label: "changed" })),
    ...report.files.created.map((path) => ({ path, label: "missing" })),
  ].sort((a, b) => byText(a.path, b.path) || byText(a.label, b.label));

  if (drift.length === 0 && pending.length === 0 && files.length === 0) {
    lines.push(
      "The deployment matches the plan: the live infrastructure, the state, the infrastructure code and the generated files all agree.",
    );
    return lines.join("\n");
  }

  if (drift.length > 0) {
    lines.push(
      `Resources changed outside OpsCrew (${drift.length}), for example in the Hetzner or Cloudflare console:`,
    );
    for (const item of drift) {
      if (item.action === "delete") {
        lines.push(`  - ${item.address} no longer exists`);
      } else {
        const names = [...item.attributes].sort(byText);
        lines.push(
          `  ~ ${item.address}: ${names.length > 0 ? names.join(", ") : "attributes"} changed`,
        );
      }
    }
    lines.push(
      "`opscrew provision` would undo these changes and restore what opscrew/plan.yaml describes.",
      "To keep a change instead, update opscrew/plan.yaml to match it (for example with `opscrew design`), then run `opscrew provision` and review its plan.",
      "",
    );
  }

  if (pending.length > 0) {
    const drifted = new Set(drift.map((d) => d.address));
    lines.push(`Pending changes (${pending.length}), what \`opscrew provision\` would apply now:`);
    for (const item of pending) {
      const why = drifted.has(item.address)
        ? "undoes the change outside OpsCrew"
        : "not applied yet";
      lines.push(`  ${SYMBOL[item.action]} ${item.action.padEnd(7)}  ${item.address} (${why})`);
    }
    lines.push("");
  }

  if (files.length > 0) {
    lines.push(
      `Files that differ from what OpsCrew renders from opscrew/plan.yaml (${files.length}):`,
    );
    for (const file of files) lines.push(`  ${file.label.padEnd(7)}  ${file.path}`);
    lines.push(
      "OpsCrew regenerates these files: `opscrew provision` would overwrite the edits and add the missing files. To keep an edit, make the same change in opscrew/plan.yaml instead.",
      "",
    );
  }

  lines.push("Nothing was changed: `opscrew drift` only reads.");
  return lines.join("\n");
}
