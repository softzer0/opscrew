/**
 * `opscrew addon disable monitoring`: the self-hosted monitoring taken out of the plan. Only the
 * plan changes; provision removes what runs, the server and the stack's data after the typed name.
 */
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  isOutsideMember,
  type MonitoringSettings,
  monitoringOf,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { withoutServerCost } from "../design/servers";
import { commandFlags } from "../environments/choice";
import { planFile } from "../runners/words";
import { writePlanIfChanged } from "../shared/plan-file";
import type { MonitoringChange } from "./enable";
import { senderPlans } from "./repository";
import { withMonitoring } from "./settings";

/** What provision removes once monitoring left the plan, by where it ran. */
function removalText(plan: DeployPlan, monitoring: MonitoringSettings, flag: string): string {
  const provision = `\`opscrew provision${flag}\``;
  const { where } = monitoring;
  const alloy =
    plan.observability?.grafanaCloud?.enabled === true
      ? "Grafana Alloy from this environment's servers (on the app's server it stays for Grafana Cloud)"
      : "Grafana Alloy from this environment's servers";
  switch (where.kind) {
    case "server":
      return `${provision} removes ${alloy}, then deletes server ${where.server} with the figures and logs it keeps, after you type its name.`;
    case "app":
      return `${provision} removes ${alloy} and the monitoring stack from the app's server; its figures and logs are deleted only after you type the app's name.`;
    case "shared":
      return `${provision} removes ${alloy} and takes server ${where.owner.server} off this environment's private network; what this environment already sent stays there until its retention ends.`;
  }
}

/**
 * `opscrew addon disable monitoring` (FR-2023, FR-2024): removes `observability.monitoring` from
 * the plan, with the monitoring server's entry and network member (or a shared server's outside
 * member) and its line in the cost. Nothing else changes: provision removes what runs.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change, while other environments send to
 * this one's monitoring server, naming their plans.
 */
export async function monitoringDisable(
  deps: PhaseDeps,
  plan: DeployPlan,
): Promise<MonitoringChange> {
  const monitoring = monitoringOf(plan);
  if (monitoring === undefined) {
    return {
      plan,
      summary: "Self-hosted monitoring is already off for this app; nothing changed.",
    };
  }
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const { where } = monitoring;
  if (where.kind !== "shared") {
    const senders = await senderPlans(deps, plan);
    if (senders.length > 0) {
      const commands = await Promise.all(
        senders.map(
          async (sender) =>
            `\`opscrew addon disable monitoring${await commandFlags(deps.paths.root, sender.environment?.name ?? "prod", sender.app.key)}\``,
        ),
      );
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Other environments send their figures and logs to this environment's monitoring: ${senders.map(planFile).join(", ")}. Nothing was changed.`,
        {
          hint: `Turn monitoring off there first (${commands.join(", ")}, each followed by \`opscrew provision\` with the same options), then run this command again.`,
        },
      );
    }
  }
  const server = where.kind === "server" ? where.server : undefined;
  const servers = (plan.servers ?? []).filter((s) => s.name !== server);
  const network =
    plan.network === undefined
      ? undefined
      : {
          ...plan.network,
          members: plan.network.members.filter(
            (member) => member.name !== server && !isOutsideMember(plan, member),
          ),
        };
  const after = withMonitoring(plan, undefined, {
    servers: servers.length === 0 ? undefined : servers,
    network,
    cost: server === undefined ? plan.cost : withoutServerCost(plan.cost, server),
  });
  await writePlanIfChanged(deps, after);
  return {
    plan: after,
    summary: `Self-hosted monitoring is off in the plan. ${removalText(plan, monitoring, flag)} Only ${planFile(plan)} changed.`,
  };
}
