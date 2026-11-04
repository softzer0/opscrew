/**
 * `drift` of self-hosted monitoring (feature 020): on each of the app's servers, Grafana Alloy's
 * Compose file, destinations and containers (the `alloy` step), and on the stack's own server the
 * stack's files and containers (the `monitoring` step), compared with what OpsCrew renders from
 * the plans now. Every difference names its server, never its address. Read-only.
 */
import { type HostFacts, inspectHost } from "@opscrew/connector-ssh-host";
import { errorText, isUserFacingError, listText, sha256Hex } from "@opscrew/core";
import {
  type AlloyDestinations,
  IMAGES,
  type MonitoringStackInput,
  renderAlloyCompose,
  renderMonitoringStack,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type MonitoringSettings,
  monitoringOf,
  monitoringServerName,
  networkInterface,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { senderPlans } from "../monitoring/repository";
import { appServers } from "../shared/servers";
import { serverShell } from "../status/servers";
import { AREA_TITLES, type HostDifference } from "./host";
import { namedDifferences, type ServersDriftOptions } from "./servers";

/** The private address on `plan`'s network of its member `server`, with that network's others. */
function networkOf(plan: DeployPlan, server: string): MonitoringStackInput["networks"] {
  const network = plan.network;
  const self = network?.members.find((m) => m.name === server);
  if (network === undefined || self === undefined) return [];
  return [
    {
      address: self.address,
      servers: network.members.filter((m) => m.name !== server).map((m) => m.address),
      devices: network.devices.map((d) => d.address),
    },
  ];
}

/**
 * The stack's input as provision builds it: the owner's network first, then each sender's (its
 * outside member), the senders in the order given; Grafana on the private addresses when any
 * network has devices.
 */
export function monitoringStackInput(
  owner: DeployPlan,
  senders: readonly DeployPlan[],
): MonitoringStackInput {
  const networks = [
    ...networkOf(owner, monitoringServerName(owner) as string),
    ...senders.flatMap((sender) => networkOf(sender, monitoringServerName(sender) as string)),
  ];
  return {
    settings: monitoringOf(owner) as MonitoringSettings,
    networks,
    hasDevices: networks.some((network) => network.devices.length > 0),
    plan: owner,
  };
}

/** Where the Alloy on `server` sends: the stack's front, and from the app's server Grafana Cloud. */
function alloyDestinations(plan: DeployPlan, server: string): AlloyDestinations {
  const stack = monitoringServerName(plan) as string;
  const own = monitoringOf(plan)?.where.kind !== "shared" && stack === server;
  const address = own
    ? "front"
    : (plan.network?.members.find((m) => m.name === stack)?.address ?? "front");
  const grafana = plan.observability?.grafanaCloud;
  return {
    ...(server === APP_SERVER && grafana?.enabled ? { grafanaCloud: grafana } : {}),
    monitoring: { address },
  };
}

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
  const destinations = alloyDestinations(plan, server);
  const wanted = [
    ...(destinations.grafanaCloud === undefined ? [] : ["grafanaCloud"]),
    "monitoring",
  ];
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
  if (alloy.composeSha256 !== sha256Hex(renderAlloyCompose(plan, server, destinations))) {
    out.push("Its Compose file was edited, or the plan changed since the last provision.");
  }
  if (!alloy.running) out.push("It is not running.");
  return out.map((detail) => stepDifference("alloy", detail));
}

/** How the stack on its server differs from the `monitoring` step rendered from `input`. */
export function stackDifferences(
  input: MonitoringStackInput,
  facts: Pick<HostFacts, "monitoring">,
): HostDifference[] {
  const stack = facts.monitoring;
  if (stack === undefined) {
    return [stepDifference("monitoring", "The monitoring stack is not on this server.")];
  }
  const rendered = renderMonitoringStack(input);
  const missing = rendered.filter((file) => stack.files[file.path] === undefined);
  const changed = rendered.filter(
    (file) =>
      stack.files[file.path] !== undefined && stack.files[file.path] !== sha256Hex(file.content),
  );
  const stopped = ["prometheus", "loki", "grafana", "front"].filter(
    (service) => !stack.containers.some((c) => c.name.includes(`-${service}-`) && c.running),
  );
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
        const senders = (await senderPlans(deps, plan)).filter((sender) => {
          const member = sender.network?.members.find(
            (m) => m.name === monitoringServerName(sender),
          );
          return (
            member !== undefined && facts.wireguardInterfaces.includes(networkInterface(member))
          );
        });
        found.push(...stackDifferences(monitoringStackInput(plan, senders), facts));
      }
      differences.push(...namedDifferences(plan, name, found));
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      notes.push(`OpsCrew could not compare the monitoring on server ${name}. ${errorText(error)}`);
    }
  }
  return differences;
}
