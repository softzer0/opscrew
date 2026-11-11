import type { PlannedFirewallRule, PlannedResourceJson, ProviderSecOps } from "@opscrew/contracts";
import { isRecord } from "@opscrew/core";

/** Resource address without `count`/`for_each` keys: `module.a[0].x.y["k"]` becomes `module.a.x.y`. */
function configAddress(address: string): string {
  return address.replace(/\[[^\]]*\]/g, "");
}

/**
 * Droplet addresses (without instance keys) that each `digitalocean_firewall` references in its
 * `droplet_ids` expression, read from the plan's `configuration` section. Droplet ids are unknown
 * before apply, so these references are the only way to see the attachment on a first plan.
 */
function firewallDropletReferences(planJson: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (module: unknown, prefix: string) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.type !== "digitalocean_firewall") continue;
      if (typeof resource.address !== "string") continue;
      const expressions = isRecord(resource.expressions) ? resource.expressions : {};
      const dropletIds = isRecord(expressions.droplet_ids) ? expressions.droplet_ids : {};
      const references = Array.isArray(dropletIds.references) ? dropletIds.references : [];
      const droplets = new Set<string>();
      for (const reference of references) {
        if (typeof reference !== "string") continue;
        const target = configAddress(reference).replace(/\.id$/, "");
        if (/^digitalocean_droplet\.[^.]+$/.test(target)) droplets.add(`${prefix}${target}`);
      }
      out.set(`${prefix}${resource.address}`, droplets);
    }
    const calls = isRecord(module.module_calls) ? module.module_calls : {};
    for (const [name, call] of Object.entries(calls)) {
      if (isRecord(call)) walk(call.module, `${prefix}module.${name}.`);
    }
  };
  if (isRecord(planJson) && isRecord(planJson.configuration)) {
    walk(planJson.configuration.root_module, "");
  }
  return out;
}

interface DigitalOceanInboundRule {
  protocol?: string;
  port_range?: string | null;
  source_addresses?: string[];
}

/** `inbound_rule` blocks of a `digitalocean_firewall`, in the Hetzner rule shape. */
function digitalOceanInboundRules(resource: PlannedResourceJson): PlannedFirewallRule[] {
  const rules = resource.values.inbound_rule;
  if (!Array.isArray(rules)) return [];
  return rules.filter(isRecord).map((raw) => {
    const rule = raw as DigitalOceanInboundRule;
    const range = rule.port_range ?? "";
    return {
      direction: "in",
      protocol: rule.protocol ?? "",
      // DigitalOcean writes "all" (or "0", or nothing) for every port; all mean "any".
      port: range === "all" || range === "0" ? "" : range,
      source_ips: rule.source_addresses ?? [],
    };
  });
}

/** SecOps's checks of a plan's Droplets and DigitalOcean Cloud Firewalls. */
export const SECOPS: ProviderSecOps = {
  noun: "Droplet",
  rules: digitalOceanInboundRules,
  attached: (droplet, firewalls, planJson) => {
    const id = droplet.values.id;
    const target = configAddress(droplet.address);
    const references = firewallDropletReferences(planJson);
    return firewalls.some((firewall) => {
      const ids = firewall.values.droplet_ids;
      if (id !== undefined && id !== null && id !== "" && Array.isArray(ids)) {
        if (ids.some((value) => String(value) === String(id))) return true;
      }
      return references.get(configAddress(firewall.address))?.has(target) ?? false;
    });
  },
  attachedText: "The Droplet is attached to a DigitalOcean Cloud Firewall.",
  unattachedText:
    "No firewall lists this Droplet, so every port is reachable from the internet. Attach the OpsCrew firewall.",
  keylessText:
    "The Droplet has no SSH key; DigitalOcean would email a root password. Add the deploy key.",
  backupsText: "DigitalOcean automated backups are enabled as the plan requires.",
};
