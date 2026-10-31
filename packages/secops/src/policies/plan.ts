import type { PolicyResult, Severity } from "@opscrew/contracts";
import { isRecord } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";

/** One managed resource from an engine plan, with known values and unknown-at-plan-time markers. */
export interface PlannedResource {
  address: string;
  type: string;
  name: string;
  values: Record<string, unknown>;
  /** Attributes that will be known only after apply (true or nested structure of booleans). */
  unknown: Record<string, unknown>;
}

const OPEN_TO_ALL = new Set(["0.0.0.0/0", "::/0"]);
const PUBLIC_TCP_PORTS = new Set(["22", "80", "443"]);
const PUBLIC_UDP_PORTS = new Set(["443"]);

/**
 * True when the plan asks for the provider's automated backups of the server it creates; never
 * for a server the user owns (or a Portainer target, which has no server).
 */
function planWantsBackups(deployPlan: Pick<DeployPlan, "target">): boolean {
  const { target } = deployPlan;
  return (target.provider === "hetzner" || target.provider === "digitalocean") && target.backups;
}

/** Flattens `planned_values` (root and child modules) and merges `after_unknown` from changes. */
export function plannedResources(planJson: unknown): PlannedResource[] {
  if (!isRecord(planJson)) return [];
  const unknownByAddress = new Map<string, Record<string, unknown>>();
  const changes = Array.isArray(planJson.resource_changes) ? planJson.resource_changes : [];
  for (const change of changes) {
    if (!isRecord(change) || typeof change.address !== "string" || !isRecord(change.change))
      continue;
    const afterUnknown = change.change.after_unknown;
    if (isRecord(afterUnknown)) unknownByAddress.set(change.address, afterUnknown);
  }
  const out: PlannedResource[] = [];
  const walk = (module: unknown) => {
    if (!isRecord(module)) return;
    for (const resource of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(resource) || resource.mode === "data") continue;
      if (typeof resource.address !== "string" || typeof resource.type !== "string") continue;
      out.push({
        address: resource.address,
        type: resource.type,
        name: typeof resource.name === "string" ? resource.name : resource.address,
        values: isRecord(resource.values) ? resource.values : {},
        unknown: unknownByAddress.get(resource.address) ?? {},
      });
    }
    for (const child of Array.isArray(module.child_modules) ? module.child_modules : [])
      walk(child);
  };
  const planned = planJson.planned_values;
  if (isRecord(planned)) walk(planned.root_module);
  return out;
}

/** True when an attribute has a non-empty known value or will be set during apply. */
function isSet(resource: PlannedResource, attribute: string): boolean {
  const value = resource.values[attribute];
  if (Array.isArray(value)) return value.length > 0 || resource.unknown[attribute] !== undefined;
  if (value !== undefined && value !== null && value !== "") return true;
  const unknown = resource.unknown[attribute];
  return unknown === true || (Array.isArray(unknown) && unknown.length > 0);
}

interface FirewallRule {
  direction?: string;
  protocol?: string;
  port?: string | null;
  source_ips?: string[];
}

function firewallRules(resource: PlannedResource): FirewallRule[] {
  const rules = resource.values.rule;
  return Array.isArray(rules) ? rules.filter(isRecord).map((r) => r as FirewallRule) : [];
}

function result(
  policyId: string,
  title: string,
  severity: Severity,
  passed: boolean,
  message: string,
  resource?: string,
): PolicyResult {
  return { policyId, title, severity, passed, message, ...(resource ? { resource } : {}) };
}

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
function digitalOceanInboundRules(resource: PlannedResource): FirewallRule[] {
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

/**
 * Ports open to the whole internet: ones that must never be public, web ports, SSH and the private
 * network's WireGuard ports (`wireguard`, the UDP ports the plan's network members listen on).
 */
function openPorts(
  rules: FirewallRule[],
  wireguard: ReadonlySet<string> = new Set(),
): { admin: string[]; web: string[]; ssh: boolean; wireguard: string[] } {
  const admin: string[] = [];
  const web: string[] = [];
  const network: string[] = [];
  let ssh = false;
  for (const rule of rules) {
    if ((rule.direction ?? "in") !== "in") continue;
    const open = (rule.source_ips ?? []).some((ip) => OPEN_TO_ALL.has(ip));
    if (!open) continue;
    const protocol = (rule.protocol ?? "").toLowerCase();
    const port = rule.port ?? "";
    if (protocol === "icmp") continue;
    const allowed =
      protocol === "tcp"
        ? PUBLIC_TCP_PORTS
        : protocol === "udp"
          ? PUBLIC_UDP_PORTS
          : new Set<string>();
    if (protocol === "udp" && wireguard.has(port)) network.push(port);
    else if (!allowed.has(port)) admin.push(`${protocol}/${port || "any"}`);
    else if (port === "80" || port === "443") web.push(`${protocol}/${port}`);
    else ssh = true;
  }
  return { admin, web, ssh, wireguard: network };
}

/** SSH (port 22) may be open to the whole internet only when the plan allows it. */
function sshPolicyResult(
  firewall: PlannedResource,
  rules: FirewallRule[],
  deployPlan: DeployPlan,
): PolicyResult {
  const planned = deployPlan.security.sshAllowedCidrs.some((cidr) => OPEN_TO_ALL.has(cidr));
  const open = openPorts(rules).ssh;
  return result(
    "ssh-not-public",
    "SSH is open only as planned",
    "high",
    !open || planned,
    !open
      ? "SSH (port 22) accepts only the planned address ranges."
      : planned
        ? "SSH (port 22) is open to the internet as the plan allows; only key logins are accepted."
        : "SSH (port 22) is open to the whole internet, but the plan limits it to specific address ranges. Restrict the firewall rule to those ranges.",
    firewall.address,
  );
}

/** `no-open-admin-ports` and, behind Cloudflare, `origin-cloudflare-only` for one firewall. */
function openPortResults(
  firewall: PlannedResource,
  rules: FirewallRule[],
  proxiedBehindCloudflare: boolean,
  deployPlan: DeployPlan,
): PolicyResult[] {
  const networkPorts = new Set((deployPlan.network?.members ?? []).map((m) => String(m.port)));
  const open = openPorts(rules, networkPorts);
  const { admin: openAdminPorts, web: openWebPorts } = open;
  const wireguard = [...new Set(open.wireguard)];
  const tunnel =
    wireguard.length === 0
      ? ""
      : `, and the private network's WireGuard ${wireguard.length === 1 ? "port" : "ports"} (UDP ${wireguard.join(", ")}),`;
  const out = [
    result(
      "no-open-admin-ports",
      "Only SSH and web ports are open to the internet",
      "critical",
      openAdminPorts.length === 0,
      openAdminPorts.length === 0
        ? `Only ports 22, 80 and 443${tunnel} accept traffic from anywhere.`
        : `These ports are open to the whole internet: ${openAdminPorts.join(", ")}. Databases, caches and admin panels must never be public; remove those rules.`,
      firewall.address,
    ),
  ];
  if (proxiedBehindCloudflare) {
    out.push(
      result(
        "origin-cloudflare-only",
        "Web ports accept only Cloudflare",
        "medium",
        openWebPorts.length === 0,
        openWebPorts.length === 0
          ? "Ports 80 and 443 accept only Cloudflare's IP ranges, so attackers cannot bypass the proxy."
          : `Ports ${openWebPorts.join(", ")} are open to everyone even though traffic should come through Cloudflare. Restrict them to Cloudflare's IP ranges.`,
        firewall.address,
      ),
    );
  }
  return out;
}

/** What differs between the providers whose servers the policies check. */
interface ProviderChecks {
  /** Resource types of the server and of its cloud firewall. */
  server: string;
  firewall: string;
  /** "server" or "Droplet". */
  noun: string;
  /** The firewall's inbound rules in the Hetzner shape. */
  rules(firewall: PlannedResource): FirewallRule[];
  /** True when one of `firewalls` is attached to `server`. */
  attached(server: PlannedResource, firewalls: PlannedResource[], planJson: unknown): boolean;
  /** Messages of `firewall-attached`, `ssh-keys-set` and `backups-for-critical-data`. */
  attachedText: string;
  unattachedText: string;
  keylessText: string;
  backupsText: string;
  /** Whether the server has delete and rebuild protection to check. */
  deleteProtection: boolean;
}

/** Hetzner first, then DigitalOcean: the order the results are reported in. */
const PROVIDERS: readonly ProviderChecks[] = [
  {
    server: "hcloud_server",
    firewall: "hcloud_firewall",
    noun: "server",
    rules: firewallRules,
    attached: (server) => isSet(server, "firewall_ids"),
    attachedText: "The server is attached to a Hetzner Cloud firewall.",
    unattachedText:
      "The server has no firewall attached, so every port is reachable from the internet. Attach the OpsCrew firewall.",
    keylessText:
      "The server has no SSH key; Hetzner would create a root password. Add the deploy key.",
    backupsText: "Hetzner automated backups are enabled as the plan requires.",
    deleteProtection: true,
  },
  {
    server: "digitalocean_droplet",
    firewall: "digitalocean_firewall",
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
    deleteProtection: false,
  },
];

/** The server and firewall policies of one provider (spec 004 plan "Security checks"). */
function providerPolicies(
  provider: ProviderChecks,
  planJson: unknown,
  resources: PlannedResource[],
  deployPlan: DeployPlan,
  proxiedBehindCloudflare: boolean,
): PolicyResult[] {
  const results: PolicyResult[] = [];
  const servers = resources.filter((r) => r.type === provider.server);
  const firewalls = resources.filter((r) => r.type === provider.firewall);
  const { noun } = provider;

  for (const server of servers) {
    const hasFirewall = provider.attached(server, firewalls, planJson);
    const hasKeys = isSet(server, "ssh_keys");
    results.push(
      result(
        "firewall-attached",
        "Server has a firewall",
        "high",
        hasFirewall,
        hasFirewall ? provider.attachedText : provider.unattachedText,
        server.address,
      ),
      result(
        "ssh-keys-set",
        "Server uses SSH keys",
        "high",
        hasKeys,
        hasKeys
          ? `The ${noun} is created with an SSH key, so no root password is emailed or used.`
          : provider.keylessText,
        server.address,
      ),
    );
    if (provider.deleteProtection) {
      const protectedServer = server.values.delete_protection === true;
      results.push(
        result(
          "delete-protection",
          "Server is protected against accidental deletion",
          "medium",
          protectedServer,
          protectedServer
            ? "Delete and rebuild protection are on."
            : "Delete protection is off, so one wrong command could delete the server and its data. Turn it on.",
          server.address,
        ),
      );
    }
    if (planWantsBackups(deployPlan)) {
      const backups = server.values.backups === true;
      results.push(
        result(
          "backups-for-critical-data",
          "Automated backups are on",
          "high",
          backups,
          backups
            ? provider.backupsText
            : `The plan requires automated backups but the ${noun} has them turned off.`,
          server.address,
        ),
      );
    }
  }

  for (const firewall of firewalls) {
    const rules = provider.rules(firewall);
    results.push(...openPortResults(firewall, rules, proxiedBehindCloudflare, deployPlan));
    results.push(sshPolicyResult(firewall, rules, deployPlan));
  }

  if (servers.length > 0 && firewalls.length === 0) {
    results.push(
      result(
        "firewall-attached",
        "Server has a firewall",
        "high",
        false,
        `The plan creates a ${noun} but no firewall. Every port would be reachable from the internet.`,
      ),
    );
  }
  return results;
}

/**
 * Policy checks on an engine plan (`show -json`) before the user is asked to approve it. Returns
 * passing and failing results; callers stop on any failed `critical` or `high` result. A Portainer
 * target's root (Cloudflare Tunnels, their routes and Access, no server) is evaluated like any
 * other: the server and firewall policies find nothing to check there.
 */
export function evaluatePlanPolicies(planJson: unknown, deployPlan: DeployPlan): PolicyResult[] {
  const resources = plannedResources(planJson);
  const proxiedBehindCloudflare =
    deployPlan.dns.provider === "cloudflare" &&
    deployPlan.dns.proxied &&
    deployPlan.security.httpAllowedFrom === "cloudflare";
  const results = PROVIDERS.flatMap((provider) =>
    providerPolicies(provider, planJson, resources, deployPlan, proxiedBehindCloudflare),
  );

  if (deployPlan.dns.provider === "cloudflare" && deployPlan.dns.proxied && deployPlan.dns.domain) {
    const domain = deployPlan.dns.domain;
    const appRecords = resources.filter(
      (r) =>
        r.type === "cloudflare_dns_record" &&
        (r.values.type === "A" || r.values.type === "AAAA") &&
        r.values.name === domain,
    );
    for (const record of appRecords) {
      results.push(
        result(
          "dns-proxied",
          "DNS record goes through Cloudflare",
          "low",
          record.values.proxied === true,
          record.values.proxied === true
            ? `${domain} is proxied through Cloudflare (hides the server IP, adds the WAF).`
            : `${domain} points straight at the server; turn on Cloudflare proxying.`,
          record.address,
        ),
      );
    }
  }
  return results;
}
/** Failed results at or above `high`; provisioning stops before approval when any exist. */
export function blockingPolicyFailures(results: PolicyResult[]): PolicyResult[] {
  return results.filter((r) => !r.passed && (r.severity === "critical" || r.severity === "high"));
}
