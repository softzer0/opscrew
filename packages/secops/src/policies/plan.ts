import type {
  PlannedFirewallRule,
  PlannedResourceJson,
  PolicyResult,
  ProviderSecOps,
  Severity,
} from "@opscrew/contracts";
import { isRecord } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";

const OPEN_TO_ALL = new Set(["0.0.0.0/0", "::/0"]);
const PUBLIC_TCP_PORTS = new Set(["22", "80", "443"]);
const PUBLIC_UDP_PORTS = new Set(["443"]);

/**
 * True when the plan asks for the provider's automated backups of the server it creates; never
 * for a server the user owns (or a Portainer target, which has no server).
 */
function planWantsBackups(target: { provider: string; backups?: boolean }): boolean {
  return CLOUD_PROVIDERS.some((p) => p.id === target.provider) && target.backups === true;
}

/**
 * True when the plan asks for backups of the server at `address`: an extra server's module
 * (`module.server_<name>`) follows its own entry in `servers` (the monitoring server keeps none),
 * the app's server and a move's old copy the plan's target.
 */
function serverWantsBackups(deployPlan: DeployPlan, address: string): boolean {
  const name = /^module.server_([^.]+)./.exec(address)?.[1];
  const extra = deployPlan.servers?.find((server) => server.name === name);
  return planWantsBackups(extra?.target ?? deployPlan.target);
}

/** Flattens `planned_values` (root and child modules) and merges `after_unknown` from changes. */
export function plannedResources(planJson: unknown): PlannedResourceJson[] {
  if (!isRecord(planJson)) return [];
  const unknownByAddress = new Map<string, Record<string, unknown>>();
  const changes = Array.isArray(planJson.resource_changes) ? planJson.resource_changes : [];
  for (const change of changes) {
    if (!isRecord(change) || typeof change.address !== "string" || !isRecord(change.change))
      continue;
    const afterUnknown = change.change.after_unknown;
    if (isRecord(afterUnknown)) unknownByAddress.set(change.address, afterUnknown);
  }
  const out: PlannedResourceJson[] = [];
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
function isSet(resource: PlannedResourceJson, attribute: string): boolean {
  const value = resource.values[attribute];
  if (Array.isArray(value)) return value.length > 0 || resource.unknown[attribute] !== undefined;
  if (value !== undefined && value !== null && value !== "") return true;
  const unknown = resource.unknown[attribute];
  return unknown === true || (Array.isArray(unknown) && unknown.length > 0);
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
 * Ports open to the whole internet: ones that must never be public, web ports, SSH and the private
 * network's WireGuard ports (`wireguard`, the UDP ports the plan's network members listen on).
 */
function openPorts(
  rules: PlannedFirewallRule[],
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
  firewall: PlannedResourceJson,
  rules: PlannedFirewallRule[],
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
  firewall: PlannedResourceJson,
  rules: PlannedFirewallRule[],
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
interface ProviderChecks extends ProviderSecOps {
  /** Resource types of the server and of its cloud firewall. */
  server: string;
  firewall: string;
  /** Whether the server has delete and rebuild protection to check. */
  deleteProtection: boolean;
}

/** The registry's providers, in its order: the order the results are reported in. */
const PROVIDERS: readonly ProviderChecks[] = CLOUD_PROVIDERS.map((provider) => ({
  ...provider.texts.secops,
  server: provider.terraform.serverResourceType,
  firewall: provider.terraform.firewallResourceType,
  deleteProtection: provider.offering.deleteProtection,
}));

/** The server and firewall policies of one provider (spec 004 plan "Security checks"). */
function providerPolicies(
  provider: ProviderChecks,
  planJson: unknown,
  resources: PlannedResourceJson[],
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
    if (serverWantsBackups(deployPlan, server.address)) {
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
