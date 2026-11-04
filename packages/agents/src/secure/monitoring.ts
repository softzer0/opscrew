/**
 * `secure`'s checks of self-hosted monitoring (feature 020, US3, FR-2014): Grafana and the stack's
 * front are published only on private addresses (Grafana also on the server's loopback, for the
 * tunnel), and on this environment's network the filter admits to the front only the network's
 * servers and to Grafana only its devices. The outside probes of the stack's server (only SSH
 * answers; WireGuard's port is UDP) are the extra server's, with the stack's ports added
 * (`servicePorts`). Every result names the server, never its public address. Read-only.
 */
import { BlockList, isIP } from "node:net";
import { probePrivilege } from "@opscrew/connector-ssh-host";
import type { CheckResult } from "@opscrew/contracts";
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { IMAGES, MONITORING_PROJECT } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  monitoringOf,
  monitoringServerName,
  networkInterface,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { monitoringStack } from "../monitoring/status";
import { networkFilterRules } from "../network";
import { checkResult } from "../shared";
import { readPublishedPorts, serverShell } from "../status/servers";
import { memberName, type ServerSecurityOptions } from "./servers";

/** The private IPv4 ranges a private network's addresses come from. */
const PRIVATE = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["100.64.0.0", 10],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  return list;
})();

/** True for a private IPv4 address; false for `0.0.0.0`, `::` and every public address. */
function isPrivate(address: string): boolean {
  return isIP(address) === 4 && PRIVATE.check(address, "ipv4");
}

/**
 * A binding's address in the committed report: the wildcards and private or loopback addresses as
 * they are, never a public address.
 */
function addressWords(address: string): string {
  if (address === "0.0.0.0" || address === "::" || address === "[::]") {
    return `every address (${address})`;
  }
  return isPrivate(address) || address === "127.0.0.1" ? address : "a public address";
}

/** The stack's services, in words. */
const WORDS: Record<string, string> = {
  grafana: "Grafana",
  front: "the stack's front (the servers' push paths)",
  prometheus: "Prometheus (its query API)",
  loki: "Loki (its query API)",
};

/**
 * True for a binding that lets the stack be reached outside the private network: Prometheus or
 * Loki published at all (neither query API may be reachable, FR-2014), Grafana or the front on
 * anything but a private address (Grafana also on 127.0.0.1, for the tunnel).
 */
function exposes(p: { service: string; address: string }): boolean {
  if (p.service === "prometheus" || p.service === "loki") return true;
  if (p.service !== "grafana" && p.service !== "front") return false;
  return !isPrivate(p.address) && !(p.service === "grafana" && p.address === "127.0.0.1");
}

const PUBLISHED = {
  id: "monitoring-private",
  title: "Grafana and the monitoring stack's front answer only on the private network",
};
const FILTER = {
  id: "monitoring-filter",
  title:
    "The private network's filter admits only the servers to the front and the devices to Grafana",
};

/**
 * The monitoring checks of a plan with monitoring on (none without), on the stack's server (a
 * sender's: the owner's, with the owner's login): what the stack publishes, and this network's
 * filter for its two ports. A server that can't be read gives one warning with the reason.
 */
export async function monitoringSecurityChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: Pick<ServerSecurityOptions, "remote" | "readNetworkFilter">,
): Promise<CheckResult[]> {
  if (monitoringOf(plan) === undefined) return [];
  try {
    const stack = await monitoringStack(deps, plan);
    const target = `server ${stack.server}`;
    const shell = await serverShell(
      stack.deps,
      stack.plan,
      stack.server,
      options.remote === undefined ? {} : { remote: options.remote },
    );
    deps.reporter.step(`Checking the monitoring stack's published ports on ${target}`);
    const published = await readPublishedPorts(shell.docker, MONITORING_PROJECT);
    const exposed = published.filter(exposes);
    const checks = [
      exposed.length > 0
        ? checkResult(
            PUBLISHED.id,
            PUBLISHED.title,
            "critical",
            "fail",
            `On ${target}, ${listText(exposed.map((p) => `${WORDS[p.service]} is published on ${addressWords(p.address)} (port ${p.port})`))}, so the stack can be reached outside the private network.`,
            {
              target,
              remediation: `Run \`opscrew provision\`: it shows the stack's host plan for ${target}, which publishes Grafana only on 127.0.0.1 and the private addresses, the front only on the private addresses, and neither Prometheus nor Loki.`,
            },
          )
        : checkResult(
            PUBLISHED.id,
            PUBLISHED.title,
            "critical",
            "pass",
            `On ${target}, Grafana is published only on 127.0.0.1 and private addresses, the front only on private addresses, and neither Prometheus nor Loki.`,
            { target },
          ),
    ];
    const { network } = plan;
    const member = network?.members.find((m) => m.name === monitoringServerName(plan));
    if (network === undefined || member === undefined) return checks;
    const privilege = await probePrivilege(shell.remote);
    if (privilege !== "root" && privilege !== "sudo" && privilege !== "docker") {
      return [
        ...checks,
        checkResult(
          FILTER.id,
          FILTER.title,
          "critical",
          "warn",
          `OpsCrew can't read the network's filter on ${target} without root, so it was not checked.`,
          {
            target,
            remediation: `Give the login OpsCrew uses on ${target} passwordless sudo, then run \`opscrew secure\` again.`,
          },
        ),
      ];
    }
    const iface = networkInterface(member);
    const rules = await options.readNetworkFilter(shell.remote, iface, privilege, IMAGES.caddy.ref);
    const fix = {
      target,
      remediation: `Run \`opscrew provision\`: it shows the network-filter host plan for ${target}.`,
    };
    if (rules === undefined) {
      return [
        ...checks,
        checkResult(
          FILTER.id,
          FILTER.title,
          "critical",
          "fail",
          `On ${target}, the filter on ${iface} is missing, so any address on the private network can reach Grafana and the front.`,
          fix,
        ),
      ];
    }
    const wanted = networkFilterRules(plan, member.name, []).filter(
      (rule) => rule.port === MONITORING_PUSH_PORT || rule.port === MONITORING_GRAFANA_PORT,
    );
    return [...checks, filterCheck(network, target, wanted, rules, fix)];
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return [
      checkResult(
        PUBLISHED.id,
        PUBLISHED.title,
        "high",
        "warn",
        `OpsCrew could not read the monitoring stack's server. ${errorText(error)}`,
      ),
    ];
  }
}

/** The filter's rules for the two ports against `wanted`: missing or extra sources, by port. */
function filterCheck(
  network: NonNullable<DeployPlan["network"]>,
  target: string,
  wanted: { port: number; sources: string[] }[],
  rules: { port: number; sources: string[] }[],
  fix: { target: string; remediation: string },
): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const want of wanted) {
    const what = want.port === MONITORING_PUSH_PORT ? WORDS.front : WORDS.grafana;
    const rule = rules.find((r) => r.port === want.port);
    if (rule === undefined) {
      failures.push(
        `it has no rule for ${what} (port ${want.port}), so any address on the network can connect to it`,
      );
      continue;
    }
    const others = rule.sources.filter((source) => !want.sources.includes(source));
    if (others.length > 0) {
      failures.push(
        `it also admits ${listText(others.map((a) => memberName(network, a)))} to ${what}`,
      );
    }
    const missing = want.sources.filter((source) => !rule.sources.includes(source));
    if (missing.length > 0) {
      warnings.push(
        `it does not admit ${listText(missing.map((a) => memberName(network, a)))} to ${what}`,
      );
    }
  }
  if (failures.length > 0) {
    return checkResult(
      FILTER.id,
      FILTER.title,
      "critical",
      "fail",
      `On ${target}, the network's filter: ${[...failures, ...warnings].join("; ")}.`,
      fix,
    );
  }
  if (warnings.length > 0) {
    return checkResult(
      FILTER.id,
      FILTER.title,
      "critical",
      "warn",
      `On ${target}, the network's filter: ${warnings.join("; ")}.`,
      fix,
    );
  }
  return checkResult(
    FILTER.id,
    FILTER.title,
    "critical",
    "pass",
    `On ${target}, the network's filter admits only the network's servers to the front and only its devices to Grafana.`,
    { target },
  );
}
