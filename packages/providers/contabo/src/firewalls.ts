import type { FirewallApi, WantedFirewall, WantedFirewallRule } from "@opscrew/contracts";
import { listText, OpsCrewError, plural } from "@opscrew/core";
import type {
  ContaboClient,
  ContaboFirewall,
  ContaboFirewallRule,
  FirewallRuleRequest,
} from "./client";
import { instanceId } from "./servers";

/** How long Contabo may take to protect each server after a change (10 minutes). */
const PROTECT_TIMEOUT_MS = 10 * 60_000;

/** An inbound rule as OpsCrew compares and describes it. */
interface Rule {
  protocol: string;
  ports: readonly string[];
  ipv4: readonly string[];
  ipv6: readonly string[];
  active: boolean;
}

/** How a firewall at Contabo differs from the wanted one. */
interface Difference {
  missingRules: Rule[];
  extraRules: Rule[];
  description: boolean;
  inactive: boolean;
  addServers: string[];
  removeServers: string[];
}

/**
 * Contabo's firewalls, which its Terraform provider cannot manage (ADR 0029, D8; research R6,
 * R7): each is found by its exact name and made exactly what the server module wants. Contabo's
 * own "Block all traffic" rule, the only `drop` rule a firewall can have, is never compared,
 * written or deleted.
 */
export function contaboFirewallApi(client: ContaboClient): FirewallApi {
  /** The firewall named exactly `name`, or none; two or more stop before any change. */
  async function find(name: string): Promise<ContaboFirewall | undefined> {
    const named = (await client.listFirewalls(name)).filter((firewall) => firewall.name === name);
    if (named.length > 1) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Contabo has ${named.length} firewalls named ${name}.`,
        {
          hint: "Delete or rename the ones OpsCrew did not create in Contabo's Customer Control Panel, then try again.",
        },
      );
    }
    return named[0];
  }

  return {
    async sync(wanted: WantedFirewall): Promise<string[]> {
      check(wanted);
      const label = `Contabo's firewall ${wanted.name}`;
      const changes: string[] = [];
      let firewall = await find(wanted.name);
      if (firewall === undefined) {
        firewall = await client.createFirewall({
          name: wanted.name,
          description: wanted.description,
          status: "active",
          rules: { inbound: wanted.rules.map(request) },
        });
        changes.push(`Created ${label} with ${plural(wanted.rules.length, "rule")}.`);
      }
      const id = firewall.firewallId;
      const difference = compare(firewall, wanted);
      if (difference.missingRules.length > 0 || difference.extraRules.length > 0) {
        await client.setFirewallRules(id, wanted.rules.map(request));
        changes.push(
          ...difference.missingRules.map((rule) => `Added the rule ${ruleText(rule)} to ${label}.`),
          ...difference.extraRules.map(
            (rule) => `Removed the rule ${ruleText(rule)} from ${label}.`,
          ),
        );
      }
      if (difference.description || difference.inactive) {
        await client.updateFirewall(id, { description: wanted.description, status: "active" });
        if (difference.description) changes.push(`Set the description of ${label}.`);
        if (difference.inactive) changes.push(`Turned on ${label}.`);
      }
      for (const server of difference.addServers) {
        await client.assignFirewall(id, instanceId(server));
        changes.push(`Added server ${server} to ${label}.`);
      }
      for (const server of difference.removeServers) {
        await client.unassignFirewall(id, instanceId(server));
        changes.push(`Removed server ${server} from ${label}.`);
      }
      if (wanted.serverIds.length > 0) {
        await client.waitForFirewall(id, wanted.serverIds, { timeoutMs: PROTECT_TIMEOUT_MS });
      }
      return changes;
    },

    async differences(wanted: WantedFirewall): Promise<string[]> {
      const firewall = await find(wanted.name);
      if (firewall === undefined) return [`Contabo has no firewall named ${wanted.name}.`];
      const label = `Contabo's firewall ${wanted.name}`;
      const difference = compare(firewall, wanted);
      return [
        ...difference.missingRules.map((rule) => `${label} lacks the rule ${ruleText(rule)}.`),
        ...difference.extraRules.map(
          (rule) => `${label} has a rule OpsCrew did not write: ${ruleText(rule)}.`,
        ),
        ...(difference.description
          ? [
              `The description of ${label} is "${firewall.description ?? ""}", not "${wanted.description}".`,
            ]
          : []),
        ...(difference.inactive ? [`${label} is inactive, so it filters nothing.`] : []),
        ...difference.addServers.map((server) => `${label} does not protect server ${server}.`),
        ...difference.removeServers.map((server) => `${label} also protects server ${server}.`),
      ];
    },

    /**
     * Removes every server the firewall protects first (Contabo may refuse to delete a firewall
     * that still protects one, and a cancelled server lives until its term ends), then deletes it.
     */
    async remove(name: string): Promise<boolean> {
      const firewall = await find(name);
      if (firewall === undefined) return false;
      const servers = new Set([
        ...firewall.instances,
        ...firewall.instanceStatus.map((entry) => entry.instanceId),
      ]);
      for (const server of servers) {
        await client.unassignFirewall(firewall.firewallId, instanceId(server));
      }
      await client.deleteFirewall(firewall.firewallId);
      return true;
    },
  };
}

/**
 * Refuses, before any call, a rule with an empty source list (Contabo reads it as any source) and
 * a server id that is not a Contabo instance id.
 */
function check(wanted: WantedFirewall): void {
  for (const rule of wanted.rules) {
    if (rule.ipv4.length > 0 && rule.ipv6.length > 0) continue;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew won't write the rule ${ruleText(wantedRule(rule))} into Contabo's firewall ${wanted.name}: it has an empty source list, and Contabo reads an empty list as any source.`,
      {
        hint: "OpsCrew's Contabo module gives a family with no network 127.0.0.1/32 or ::1/128. If the module was edited, restore that; otherwise please report this to OpsCrew.",
      },
    );
  }
  for (const server of wanted.serverIds) instanceId(server);
}

/** How the firewall at Contabo differs from `wanted`, Contabo's own drop rule left out. */
function compare(firewall: ContaboFirewall, wanted: WantedFirewall): Difference {
  const have = firewall.rules.inbound.filter((rule) => rule.action !== "drop").map(readRule);
  const want = wanted.rules.map(wantedRule);
  const haveKeys = new Set(have.map(ruleKey));
  const wantKeys = new Set(want.map(ruleKey));
  return {
    missingRules: want.filter((rule) => !haveKeys.has(ruleKey(rule))),
    extraRules: have.filter((rule) => !wantKeys.has(ruleKey(rule))),
    description: (firewall.description ?? "") !== wanted.description,
    inactive: firewall.status !== "active",
    addServers: wanted.serverIds.filter((server) => !firewall.instances.includes(server)),
    removeServers: firewall.instances.filter((server) => !wanted.serverIds.includes(server)),
  };
}

function wantedRule(rule: WantedFirewallRule): Rule {
  return {
    protocol: rule.protocol,
    ports: rule.ports,
    ipv4: rule.ipv4,
    ipv6: rule.ipv6,
    active: true,
  };
}

function readRule(rule: ContaboFirewallRule): Rule {
  return {
    protocol: rule.protocol,
    ports: rule.destPorts,
    ipv4: rule.srcCidr.ipv4,
    ipv6: rule.srcCidr.ipv6,
    active: rule.status === "active",
  };
}

/** A rule's identity: the order of its ports and sources does not matter. */
function ruleKey(rule: Rule): string {
  const sorted = (values: readonly string[]) => [...values].sort();
  return JSON.stringify([
    rule.protocol,
    sorted(rule.ports),
    sorted(rule.ipv4),
    sorted(rule.ipv6),
    rule.active,
  ]);
}

/** `TCP port 22 from 203.0.113.0/24 and ::1/128`; an empty family reads as any address. */
function ruleText(rule: Rule): string {
  const protocol = rule.protocol === "" ? "any protocol" : rule.protocol.toUpperCase();
  const ports =
    rule.ports.length === 0
      ? ""
      : ` ${rule.ports.length === 1 ? "port" : "ports"} ${listText(rule.ports)}`;
  const sources = [
    ...(rule.ipv4.length === 0 ? ["any IPv4 address"] : rule.ipv4),
    ...(rule.ipv6.length === 0 ? ["any IPv6 address"] : rule.ipv6),
  ];
  return `${protocol}${ports} from ${listText(sources)}${rule.active ? "" : " (inactive)"}`;
}

/** A wanted rule as Contabo takes it. */
function request(rule: WantedFirewallRule): FirewallRuleRequest {
  return {
    protocol: rule.protocol,
    destPorts: rule.ports,
    srcCidr: { ipv4: rule.ipv4, ipv6: rule.ipv6 },
    action: "accept",
    status: "active",
  };
}
