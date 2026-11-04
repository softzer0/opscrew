/**
 * `drift` of self-hosted monitoring (feature 020): on each of the app's servers, Grafana Alloy's
 * Compose file, destinations and containers (the `alloy` step), and on the stack's own server the
 * stack's files and containers (the `monitoring` step), compared with what OpsCrew renders from
 * the plans now. Every difference names its server, never its address. Read-only.
 */
import { type HostFacts, inspectHost } from "@opscrew/connector-ssh-host";
import { errorText, isUserFacingError, listText, sha256Hex } from "@opscrew/core";
import { IMAGES, renderMonitoringStack } from "@opscrew/iac-templates";
import { type DeployPlan, monitoringOf, monitoringServerName } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { senderPlans } from "../monitoring/repository";
import { stoppedServices } from "../monitoring/status";
import { joinedOn } from "../network/owner";
import { monitoringAlloy, stackAddresses } from "../provision/monitoring";
import { appServers } from "../shared/servers";
import { serverShell } from "../status/servers";
import { AREA_TITLES, type HostDifference } from "./host";
import { namedDifferences, type ServersDriftOptions } from "./servers";

/**
 * A difference in the host step `step`, which provision puts back. Its title is read when used:
 * the drift modules import each other in a cycle, so `AREA_TITLES` may not exist while this loads.
 */
function stepDifference(step: "alloy" | "monitoring", detail: string): HostDifference {
  return { area: step, title: AREA_TITLES[step], detail, restoredByProvision: true };
}

/** How the Alloy on `server` differs from the `alloy` step provision plans for it. */
export function alloyDifferences(
  plan: DeployPlan,
  server: string,
  facts: Pick<HostFacts, "addons" | "alloy">,
): HostDifference[] {
  const alloy = facts.addons.alloy;
  if (!alloy.installed) {
    return [
      stepDifference(
        "alloy",
        "Grafana Alloy is not on this server, so it sends nothing to the monitoring stack.",
      ),
    ];
  }
  const planned = monitoringAlloy(plan, server);
  const wanted = planned.destinations ?? [];
  const sends = facts.alloy?.destinations ?? [];
  const out: string[] = [];
  if (wanted.join(" ") !== sends.join(" ")) {
    const words = (list: readonly string[]) =>
      list.length === 0
        ? "nowhere"
        : listText(
            list.map((d) => (d === "monitoring" ? "the monitoring stack" : "Grafana Cloud")),
          );
    out.push(`It sends to ${words(sends)}, and the plan says ${words(wanted)}.`);
  }
  if (alloy.composeSha256 !== sha256Hex(planned.files["compose.yaml"] as string)) {
    out.push("Its Compose file was edited, or the plan changed since the last provision.");
  }
  if (!alloy.running) out.push("It is not running.");
  return out.map((detail) => stepDifference("alloy", detail));
}

/**
 * How the stack on its server differs from the `monitoring` step provision renders from the
 * owner's plan and `senders`.
 */
export function stackDifferences(
  owner: DeployPlan,
  senders: readonly DeployPlan[],
  facts: Pick<HostFacts, "monitoring">,
): HostDifference[] {
  const stack = facts.monitoring;
  if (stack === undefined) {
    return [stepDifference("monitoring", "The monitoring stack is not on this server.")];
  }
  const rendered = renderMonitoringStack(owner, stackAddresses(owner, senders));
  const missing = rendered.filter((file) => stack.files[file.path] === undefined);
  const changed = rendered.filter(
    (file) =>
      stack.files[file.path] !== undefined && stack.files[file.path] !== sha256Hex(file.content),
  );
  const stopped = stoppedServices(stack.containers);
  return [
    ...(missing.length === 0
      ? []
      : [
          `${listText(missing.map((f) => f.path))} ${missing.length === 1 ? "is" : "are"} missing.`,
        ]),
    ...(changed.length === 0
      ? []
      : [
          `${listText(changed.map((f) => f.path))} ${changed.length === 1 ? "differs" : "differ"} from the plan: edited on the server, or the plan changed since the last provision.`,
        ]),
    ...(stopped.length === 0
      ? []
      : [`${listText(stopped)} ${stopped.length === 1 ? "is" : "are"} not running.`]),
  ].map((detail) => stepDifference("monitoring", detail));
}

/**
 * How each of the app's servers differs from what provision sets up for monitoring (none without
 * monitoring on): every server's Alloy, and on the stack's server when this plan owns it, the
 * stack rendered from the owner's plan and the senders whose interface is on that server (as
 * provision renders it). Each server is inspected read-only (as root through Docker on one OpsCrew
 * created); one that can't be reached adds a note and the rest stands. A sender's stack is its
 * owner's to compare.
 */
export async function monitoringDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  notes: string[],
  options: ServersDriftOptions = {},
): Promise<HostDifference[]> {
  const monitoring = monitoringOf(plan);
  if (monitoring === undefined) return [];
  const inspect = options.inspect ?? inspectHost;
  const stack = monitoring.where.kind === "shared" ? undefined : monitoringServerName(plan);
  const differences: HostDifference[] = [];
  for (const name of appServers(plan)) {
    try {
      const shell = await serverShell(deps, plan, name, options.services ?? {});
      deps.reporter.step(`Comparing the monitoring on server ${name} with what OpsCrew set up`);
      const facts = await inspect(
        shell.remote,
        shell.login.own ? {} : { rootImage: IMAGES.caddy.ref },
      );
      const found = alloyDifferences(plan, name, facts);
      if (name === stack) {
        const senders = (await senderPlans(deps, plan)).filter((s) => joinedOn(s, facts));
        found.push(...stackDifferences(plan, senders, facts));
      }
      differences.push(...namedDifferences(plan, name, found));
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      notes.push(`OpsCrew could not compare the monitoring on server ${name}. ${errorText(error)}`);
    }
  }
  return differences;
}
