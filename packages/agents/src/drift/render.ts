import { engineLabel } from "@opscrew/iac-engine";
import { PORTAINER_DEPLOY_BRANCH, portainerDeployBranch } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { planWhere } from "../runners/words";
import { CHANGE_SYMBOL } from "../shared";
import type { HostDifference } from "./host";
import type { DriftReport } from "./types";

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** How the report names the environment: its plan file, ` --env <name>` and Portainer's branch. */
interface Where {
  file: string;
  flag: string;
  branch: string;
}

/** {@link Where} of the environment `plan` belongs to; prod's without a plan. */
function whereOf(plan: DeployPlan | undefined): Where {
  return plan === undefined
    ? { file: "opscrew/plan.yaml", flag: "", branch: PORTAINER_DEPLOY_BRANCH }
    : { ...planWhere(plan), branch: portainerDeployBranch(plan) };
}

/**
 * The "next steps" after a drift report, for the terminal. On a server the user owns, changes are
 * made on the server (over SSH) or in the Cloudflare dashboard; there is no provider console, and
 * `opscrew provision` puts back only some of the server's differences (the report says which).
 * `plan` is the checked environment's, whose plan file and `--env` the steps name (prod's without).
 */
export function driftNextSteps(
  report: Pick<DriftReport, "clean" | "provider"> & Partial<Pick<DriftReport, "host">>,
  plan?: DeployPlan,
): string[] {
  const { file, flag, branch } = whereOf(plan);
  const provision = `\`opscrew provision${flag}\``;
  const again = `run \`opscrew drift${flag}\` again`;
  if (report.provider === "portainer") {
    return report.clean
      ? [
          `nothing to do; ${again} after changes in Portainer, on the ${branch} branch or in the Cloudflare dashboard.`,
        ]
      : [
          `to put back what OpsCrew set up in your Portainer and apply pending code, run ${provision} (it shows the plans first and changes nothing without your approval).`,
          `to keep a change made in Portainer or in the Cloudflare dashboard, update ${file} to match before you provision again.`,
        ];
  }
  if (report.provider === "localhost") {
    return report.clean
      ? [`nothing to do; ${again} after changes to the stack on this computer.`]
      : [
          `to put back what OpsCrew set up on this computer, run ${provision} (it shows the local plan first and changes nothing without your approval).`,
          `to keep a change, make it in ${file} before you provision again.`,
        ];
  }
  if (report.provider === "own") {
    if (report.clean) {
      return [
        `nothing to do; ${again} after changes on the server (ssh) or in the Cloudflare dashboard.`,
      ];
    }
    const leftAlone = (report.host?.differences ?? []).some((item) => !item.restoredByProvision);
    return [
      leftAlone
        ? `to undo what the report lists as put back by ${provision} and apply pending code, run ${provision} (it shows the plans first and changes nothing without your approval).`
        : `to undo changes made outside OpsCrew and apply pending code, run ${provision} (it shows the plans first and changes nothing without your approval).`,
      ...(leftAlone
        ? [
            `for the differences on your server that ${provision} leaves alone, follow the step the report gives with each.`,
          ]
        : []),
      `to keep a change made on the server (ssh) or in the Cloudflare dashboard, update ${file} to match before you provision again.`,
    ];
  }
  const cloud = providerProfile(report.provider).displayName;
  return report.clean
    ? [`nothing to do; ${again} after changes in the ${cloud} or Cloudflare console.`]
    : [
        `to undo changes made outside OpsCrew and apply pending code, run ${provision} (it shows the plan first).`,
        ...((report.host?.differences.length ?? 0) > 0
          ? ["for the app's containers on the server, follow the step the report gives with each."]
          : []),
        `to keep a change made in the console, update ${file} to match before you provision again.`,
      ];
}

/**
 * The host part of the report: the differences `opscrew provision` puts back (the steps of its host
 * plan), then the ones it leaves alone (ufw rules added later, other default policies, the runtime
 * files and containers, OpsCrew's record, what stops provision), each group with what that means.
 * Never promises that provision restores what it does not.
 */
function hostSection(host: readonly HostDifference[], flag: string): string[] {
  const provision = `\`opscrew provision${flag}\``;
  const restored = host.filter((item) => item.restoredByProvision);
  const others = host.filter((item) => !item.restoredByProvision);
  const blocked = others.some((item) => item.area === "server");
  const lines = [`Your server differs from what OpsCrew set up (${host.length}).`];
  if (restored.length > 0) {
    lines.push(`Put back by ${provision} (${restored.length}):`);
    for (const item of restored) lines.push(`  ~ ${item.title}: ${item.detail}`);
    lines.push(
      blocked
        ? `${provision} changes nothing on the server until what OpsCrew found (below) is fixed; then it shows a host plan for these, and nothing changes until you approve it. If you changed one of them on purpose, keep in mind that the next provision undoes it.`
        : `${provision} shows a host plan for these first, and nothing on the server changes until you approve it. If you changed one of them on purpose, keep in mind that the next provision undoes it.`,
    );
  }
  if (others.length > 0) {
    lines.push(`Left alone by ${provision} (${others.length}):`);
    for (const item of others) lines.push(`  ~ ${item.title}: ${item.detail}`);
    lines.push(
      `${provision} does not change these; where something needs doing, it is said with each.`,
    );
  }
  return lines;
}

/**
 * Plain-text drift report for the terminal: resources changed outside OpsCrew (attribute names,
 * never values), pending infrastructure changes and generated files that differ, in the report's
 * (sorted) order; edited and missing files are listed together by path. `plan` is the checked
 * environment's, whose plan file and `--env` the report names (prod's without).
 */
export function renderDriftReport(report: DriftReport, plan?: DeployPlan): string {
  const { file, flag } = whereOf(plan);
  const provision = `\`opscrew provision${flag}\``;
  const lines = [
    report.engine === undefined
      ? `OpsCrew drift check (this computer, ${report.checkedAt})`
      : `OpsCrew drift check (${engineLabel(report.engine.name)} ${report.engine.version}, ${report.checkedAt})`,
    "",
  ];
  const { drift, pending, foreignDnsRecords: foreign } = report;
  const portainer = report.provider === "portainer";
  const local = report.provider === "localhost";
  // The user's Portainer, like their own server, has only Cloudflare's dashboard as a console.
  const cloud =
    report.provider === "own" || report.provider === "portainer" || report.provider === "localhost"
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
      local
        ? "The deployment matches the plan: the stack on this computer is as OpsCrew set it up, and the generated files agree."
        : portainer
          ? "The deployment matches the plan: OpsCrew's stacks in your Portainer, the deploy branch, the Cloudflare resources, the state, the infrastructure code and the generated files all agree."
          : ownServer
            ? "The deployment matches the plan: your server is set up as OpsCrew left it, and the Cloudflare resources, the state, the infrastructure code and the generated files all agree."
            : "The deployment matches the plan: the live infrastructure, the state, the infrastructure code and the generated files all agree.",
      ...notes,
    );
    return lines.join("\n");
  }

  if (host.length > 0 && local) {
    lines.push(
      `The stack on this computer differs from what OpsCrew set up (${host.length}):`,
      ...host.map((item) => `  ~ ${item.title}: ${item.detail}`),
      `${provision} puts these back: it shows its local plan first, and nothing changes until you approve it.`,
      "",
    );
  } else if (host.length > 0) lines.push(...hostSection(host, flag), "");
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
      `${provision} shows a stack plan for what it puts back in Portainer, and nothing changes until you approve it; what it does not put back says what to do with it. Values are compared only as keyed fingerprints and never shown.`,
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
      `${provision} would undo these changes and restore what ${file} describes.`,
      `To keep a change instead, update ${file} to match it (for example with \`opscrew design${flag}\`), then run ${provision} and review its plan.`,
      "",
    );
  }

  if (foreign.length > 0) {
    lines.push(
      `DNS records at the app's hostname that OpsCrew did not create (${foreign.length}), for example added in the Cloudflare dashboard:`,
    );
    for (const record of foreign) lines.push(`  ! ${record.type} ${record.name} ${record.content}`);
    lines.push(
      `They can send visitors somewhere else than the server, and ${provision} stops until they are gone: delete them in the Cloudflare dashboard (DNS → Records) unless you put them there on purpose.`,
      "",
    );
  }

  if (pending.length > 0) {
    const drifted = new Set(drift.map((d) => d.address));
    lines.push(`Pending changes (${pending.length}), what ${provision} would apply now:`);
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
    lines.push(`Files that differ from what OpsCrew renders from ${file} (${files.length}):`);
    for (const item of files) lines.push(`  ${item.label.padEnd(7)}  ${item.path}`);
    lines.push(
      `OpsCrew regenerates these files: ${provision} would overwrite the edits and add the missing files. To keep an edit, make the same change in ${file} instead.`,
      "",
    );
  }

  if (notes.length > 0) lines.push(...notes, "");
  lines.push("Nothing was changed: `opscrew drift` only reads.");
  return lines.join("\n");
}
