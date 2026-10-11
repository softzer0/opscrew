import type { PolicyResult, Severity } from "@opscrew/contracts";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Policy checks on an engine plan (`show -json`) before the user is asked to approve it. Returns
 * passing and failing results; callers stop on any failed `critical` or `high` result.
 */
export function evaluatePlanPolicies(planJson: unknown, deployPlan: DeployPlan): PolicyResult[] {
  const resources = plannedResources(planJson);
  const results: PolicyResult[] = [];
  const servers = resources.filter((r) => r.type === "hcloud_server");
  const firewalls = resources.filter((r) => r.type === "hcloud_firewall");

  for (const server of servers) {
    results.push(
      result(
        "firewall-attached",
        "Server has a firewall",
        "high",
        isSet(server, "firewall_ids"),
        isSet(server, "firewall_ids")
          ? "The server is attached to a Hetzner Cloud firewall."
          : "The server has no firewall attached, so every port is reachable from the internet. Attach the OpsCrew firewall.",
        server.address,
      ),
      result(
        "ssh-keys-set",
        "Server uses SSH keys",
        "high",
        isSet(server, "ssh_keys"),
        isSet(server, "ssh_keys")
          ? "The server is created with an SSH key, so no root password is emailed or used."
          : "The server has no SSH key; Hetzner would create a root password. Add the deploy key.",
        server.address,
      ),
      result(
        "delete-protection",
        "Server is protected against accidental deletion",
        "medium",
        server.values.delete_protection === true,
        server.values.delete_protection === true
          ? "Delete and rebuild protection are on."
          : "Delete protection is off, so one wrong command could delete the server and its data. Turn it on.",
        server.address,
      ),
    );
    if (deployPlan.target.backups) {
      results.push(
        result(
          "backups-for-critical-data",
          "Automated backups are on",
          "high",
          server.values.backups === true,
          server.values.backups === true
            ? "Hetzner automated backups are enabled as the plan requires."
            : "The plan requires automated backups but the server has them turned off.",
          server.address,
        ),
      );
    }
  }

  const proxiedBehindCloudflare =
    deployPlan.dns.provider === "cloudflare" &&
    deployPlan.dns.proxied &&
    deployPlan.security.httpAllowedFrom === "cloudflare";

  for (const firewall of firewalls) {
    const openAdminPorts: string[] = [];
    const openWebPorts: string[] = [];
    for (const rule of firewallRules(firewall)) {
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
      if (!allowed.has(port)) openAdminPorts.push(`${protocol}/${port || "any"}`);
      else if (port === "80" || port === "443") openWebPorts.push(`${protocol}/${port}`);
    }
    results.push(
      result(
        "no-open-admin-ports",
        "Only SSH and web ports are open to the internet",
        "critical",
        openAdminPorts.length === 0,
        openAdminPorts.length === 0
          ? "Only ports 22, 80 and 443 accept traffic from anywhere."
          : `These ports are open to the whole internet: ${openAdminPorts.join(", ")}. Databases, caches and admin panels must never be public; remove those rules.`,
        firewall.address,
      ),
    );
    if (proxiedBehindCloudflare) {
      results.push(
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
  }

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

  if (servers.length > 0 && firewalls.length === 0) {
    results.push(
      result(
        "firewall-attached",
        "Server has a firewall",
        "high",
        false,
        "The plan creates a server but no firewall. Every port would be reachable from the internet.",
      ),
    );
  }
  return results;
}

/** Failed results at or above `high`; provisioning stops before approval when any exist. */
export function blockingPolicyFailures(results: PolicyResult[]): PolicyResult[] {
  return results.filter((r) => !r.passed && (r.severity === "critical" || r.severity === "high"));
}
