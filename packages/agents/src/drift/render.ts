import { engineLabel } from "@opscrew/iac-engine";
import { providerProfile } from "../providers";
import { CHANGE_SYMBOL } from "../shared";
import type { HostDifference } from "./host";
import type { DriftReport } from "./types";

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The "next steps" after a drift report, for the terminal. On a server the user owns, changes are
 * made on the server (over SSH) or in the Cloudflare dashboard; there is no provider console, and
 * `opscrew provision` puts back only some of the server's differences (the report says which).
 */
export function driftNextSteps(
  report: Pick<DriftReport, "clean" | "provider"> & Partial<Pick<DriftReport, "host">>,
): string[] {
  if (report.provider === "portainer") {
    return report.clean
      ? [
          "nothing to do; run `opscrew drift` again after changes in Portainer, on the opscrew-deploy branch or in the Cloudflare dashboard.",
        ]
      : [
          "to put back what OpsCrew set up in your Portainer and apply pending code, run `opscrew provision` (it shows the plans first and changes nothing without your approval).",
          "to keep a change made in Portainer or in the Cloudflare dashboard, update opscrew/plan.yaml to match before you provision again.",
        ];
  }
  if (report.provider === "own") {
    if (report.clean) {
      return [
        "nothing to do; run `opscrew drift` again after changes on the server (ssh) or in the Cloudflare dashboard.",
      ];
    }
    const leftAlone = (report.host?.differences ?? []).some((item) => !item.restoredByProvision);
    return [
      leftAlone
        ? "to undo what the report lists as put back by `opscrew provision` and apply pending code, run `opscrew provision` (it shows the plans first and changes nothing without your approval)."
        : "to undo changes made outside OpsCrew and apply pending code, run `opscrew provision` (it shows the plans first and changes nothing without your approval).",
      ...(leftAlone
        ? [
            "for the differences on your server that `opscrew provision` leaves alone, follow the step the report gives with each.",
          ]
        : []),
      "to keep a change made on the server (ssh) or in the Cloudflare dashboard, update opscrew/plan.yaml to match before you provision again.",
    ];
  }
  const cloud = providerProfile(report.provider).displayName;
  return report.clean
    ? [
        `nothing to do; run \`opscrew drift\` again after changes in the ${cloud} or Cloudflare console.`,
      ]
    : [
        "to undo changes made outside OpsCrew and apply pending code, run `opscrew provision` (it shows the plan first).",
        ...((report.host?.differences.length ?? 0) > 0
          ? ["for the app's containers on the server, follow the step the report gives with each."]
          : []),
        "to keep a change made in the console, update opscrew/plan.yaml to match before you provision again.",
      ];
}

/**
 * The host part of the report: the differences `opscrew provision` puts back (the steps of its host
 * plan), then the ones it leaves alone (ufw rules added later, other default policies, the runtime
 * files and containers, OpsCrew's record, what stops provision), each group with what that means.
 * Never promises that provision restores what it does not.
 */
function hostSection(host: readonly HostDifference[]): string[] {
  const restored = host.filter((item) => item.restoredByProvision);
  const others = host.filter((item) => !item.restoredByProvision);
  const blocked = others.some((item) => item.area === "server");
  const lines = [`Your server differs from what OpsCrew set up (${host.length}).`];
  if (restored.length > 0) {
    lines.push(`Put back by \`opscrew provision\` (${restored.length}):`);
    for (const item of restored) lines.push(`  ~ ${item.title}: ${item.detail}`);
    lines.push(
      blocked
        ? "`opscrew provision` changes nothing on the server until what OpsCrew found (below) is fixed; then it shows a host plan for these, and nothing changes until you approve it. If you changed one of them on purpose, keep in mind that the next provision undoes it."
        : "`opscrew provision` shows a host plan for these first, and nothing on the server changes until you approve it. If you changed one of them on purpose, keep in mind that the next provision undoes it.",
    );
  }
  if (others.length > 0) {
    lines.push(`Left alone by \`opscrew provision\` (${others.length}):`);
    for (const item of others) lines.push(`  ~ ${item.title}: ${item.detail}`);
    lines.push(
      "`opscrew provision` does not change these; where something needs doing, it is said with each.",
    );
  }
  return lines;
}

/**
 * Plain-text drift report for the terminal: resources changed outside OpsCrew (attribute names,
 * never values), pending infrastructure changes and generated files that differ, in the report's
 * (sorted) order; edited and missing files are listed together by path.
 */
export function renderDriftReport(report: DriftReport): string {
  const lines = [
    `OpsCrew drift check (${engineLabel(report.engine.name)} ${report.engine.version}, ${report.checkedAt})`,
    "",
  ];
  const { drift, pending, foreignDnsRecords: foreign } = report;
  const portainer = report.provider === "portainer";
  // The user's Portainer, like their own server, has only Cloudflare's dashboard as a console.
  const cloud =
    report.provider === "own" || report.provider === "portainer"
      ? undefined
      : providerProfile(report.provider).displayName;
  const ownServer = cloud === undefined;
  const host = report.host?.differences ?? [];
  const stacks = report.portainer?.differences ?? [];
  const rules = report.cloudflareRules ?? [];
  const files = [
    ...report.files.changed.map((path) => ({ path, label: "changed" })),
    ...report.files.created.map((path) => ({ path, label: "missing" })),
  ].sort((a, b) => byText(a.path, b.path) || byText(a.label, b.label));
  const notes = (report.notes ?? []).map((note) => `Note: ${note}`);
  if (
    drift.length === 0 &&
    pending.length === 0 &&
    files.length === 0 &&
    foreign.length === 0 &&
    host.length === 0 &&
    stacks.length === 0 &&
    rules.length === 0
  ) {
    lines.push(
      portainer
        ? "The deployment matches the plan: OpsCrew's stacks in your Portainer, the deploy branch, the Cloudflare resources, the state, the infrastructure code and the generated files all agree."
        : ownServer
          ? "The deployment matches the plan: your server is set up as OpsCrew left it, and the Cloudflare resources, the state, the infrastructure code and the generated files all agree."
          : "The deployment matches the plan: the live infrastructure, the state, the infrastructure code and the generated files all agree.",
      ...notes,
    );
    return lines.join("\n");
  }

  if (host.length > 0) lines.push(...hostSection(host), "");
  if (stacks.length > 0) {
    const environment = report.portainer?.environment;
    lines.push(
      `Your Portainer${environment ? ` (environment "${environment}")` : ""} or the deploy branch differs from what OpsCrew sets up (${stacks.length}):`,
    );
    for (const item of stacks) {
      lines.push(`  ~ ${item.title}`);
      if (item.detail !== undefined) lines.push(`      ${item.detail}`);
    }
    lines.push(
      "`opscrew provision` shows a stack plan for what it puts back in Portainer, and nothing changes until you approve it; what it does not put back says what to do with it. Values are compared only as keyed fingerprints and never shown.",
      "",
    );
  }

  if (rules.length > 0) {
    lines.push(
      `OpsCrew's shared rules or the app's origin TLS in the Cloudflare zone differ from what this app's record lists (${rules.length}):`,
    );
    for (const item of rules) lines.push(`  ~ ${item.title}`, `      ${item.detail}`);
    lines.push("");
  }

  if (drift.length > 0) {
    lines.push(
      ownServer
        ? `Resources changed outside OpsCrew (${drift.length}), for example in the Cloudflare dashboard:`
        : `Resources changed outside OpsCrew (${drift.length}), for example in the ${cloud} or Cloudflare console:`,
    );
    for (const item of drift) {
      if (item.action === "delete") {
        lines.push(`  - ${item.address} no longer exists`);
      } else {
        const names = item.attributes.length > 0 ? item.attributes.join(", ") : "attributes";
        lines.push(`  ~ ${item.address}: ${names} changed`);
      }
    }
    lines.push(
      "`opscrew provision` would undo these changes and restore what opscrew/plan.yaml describes.",
      "To keep a change instead, update opscrew/plan.yaml to match it (for example with `opscrew design`), then run `opscrew provision` and review its plan.",
      "",
    );
  }

  if (foreign.length > 0) {
    lines.push(
      `DNS records at the app's hostname that OpsCrew did not create (${foreign.length}), for example added in the Cloudflare dashboard:`,
    );
    for (const record of foreign) lines.push(`  ! ${record.type} ${record.name} ${record.content}`);
    lines.push(
      "They can send visitors somewhere else than the server, and `opscrew provision` stops until they are gone: delete them in the Cloudflare dashboard (DNS → Records) unless you put them there on purpose.",
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
      lines.push(
        `  ${CHANGE_SYMBOL[item.action]} ${item.action.padEnd(7)}  ${item.address} (${why})`,
      );
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

  if (notes.length > 0) lines.push(...notes, "");
  lines.push("Nothing was changed: `opscrew drift` only reads.");
  return lines.join("\n");
}
