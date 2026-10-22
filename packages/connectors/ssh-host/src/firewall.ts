/**
 * Detects a firewall other than ufw that already filters incoming traffic. OpsCrew never adds a
 * second firewall: rules from Docker, ufw itself and well-known helpers (fail2ban, CrowdSec,
 * Tailscale, libvirt, Kubernetes networking) are not counted.
 */
import { plural } from "@opscrew/core";

/**
 * Chains and nftables tables that belong to tools OpsCrew can live next to, and OpsCrew's own
 * (a runner machine's SSH firewall, the nftables table `inet opscrew`).
 */
const KNOWN_PREFIXES = [
  "opscrew",
  "ufw",
  "f2b-",
  "fail2ban",
  "ts-",
  "tailscale",
  "docker",
  "libvirt",
  "kube",
  "cilium",
  "cali-",
  "crowdsec",
  "sshguard",
];

function known(name: string): boolean {
  const lower = name.toLowerCase();
  return KNOWN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * `iptables-save` / `ip6tables-save`: the INPUT chain of the filter table drops by default (while
 * ufw is off) or has rules that do not jump to a known tool's chain.
 */
export function foreignIptables(text: string, ufwActive: boolean, label: string): string[] {
  let table = "";
  let policy = "ACCEPT";
  let unmanaged = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("*")) {
      table = line.slice(1);
      continue;
    }
    if (table !== "filter") continue;
    const policyMatch = /^:INPUT\s+(\S+)/.exec(line);
    if (policyMatch?.[1]) {
      policy = policyMatch[1];
      continue;
    }
    if (!line.startsWith("-A INPUT ")) continue;
    const target = /\s-[jg]\s+(\S+)/.exec(line)?.[1] ?? "";
    if (known(target) || /--match-set\s+(crowdsec|f2b)/i.test(line)) continue;
    unmanaged += 1;
  }
  const found: string[] = [];
  if (!ufwActive && (policy === "DROP" || policy === "REJECT")) {
    found.push(`${label} drops incoming traffic by default (INPUT policy ${policy})`);
  }
  if (unmanaged > 0) {
    found.push(
      `${label} has ${plural(unmanaged, "rule")} in the INPUT chain that ufw does not manage`,
    );
  }
  return found;
}

/** Tables iptables-nft manages; their rules are read through `iptables-save` instead. */
const XTABLES = new Set(["filter", "nat", "mangle", "raw", "security"]);

/** `nft list ruleset`: native nftables tables whose input chain drops or rejects traffic. */
export function foreignNft(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let table: { family: string; name: string } | undefined;
  let inChain = false;
  let inputHook = false;
  let filters = false;
  const finishChain = () => {
    if (table && inputHook && filters) {
      const id = `${table.family} ${table.name}`;
      const text = `nftables table ${id} filters incoming traffic`;
      if (!found.includes(text)) found.push(text);
    }
    inChain = false;
    inputHook = false;
    filters = false;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (depth === 0) {
      const match = /^table\s+(\S+)\s+(\S+)\s*\{/.exec(line);
      if (match?.[1] && match[2]) {
        const family = match[1];
        const name = match[2];
        const skip =
          known(name) ||
          ((family === "ip" || family === "ip6") && XTABLES.has(name)) ||
          !["ip", "ip6", "inet"].includes(family);
        table = skip ? undefined : { family, name };
      }
    } else if (depth === 1 && /^chain\s+\S+\s*\{/.test(line)) {
      inChain = true;
    } else if (inChain && depth === 2) {
      if (/\bhook\s+input\b/.test(line)) {
        inputHook = true;
        if (/\bpolicy\s+drop\b/.test(line)) filters = true;
      } else if (/(^|\s)(drop|reject)(\s|;|$)/.test(line)) {
        filters = true;
      }
    }
    depth += opens - closes;
    if (inChain && depth <= 1) finishChain();
    if (depth <= 0) {
      depth = 0;
      table = undefined;
    }
  }
  return found;
}

/** All other firewalls found, in plain words; empty when ufw may be used. */
export function foreignFirewalls(input: {
  units: Map<string, string>;
  ufwActive: boolean;
  iptables: string;
  ip6tables: string;
  nft: string;
}): string[] {
  const found: string[] = [];
  if (input.units.get("firewalld") === "active") found.push("firewalld is running");
  if (input.units.get("nftables") === "active") {
    found.push("the nftables service is active (it loads /etc/nftables.conf)");
  }
  found.push(...foreignIptables(input.iptables, input.ufwActive, "iptables"));
  found.push(...foreignIptables(input.ip6tables, input.ufwActive, "ip6tables"));
  found.push(...foreignNft(input.nft));
  return found;
}
