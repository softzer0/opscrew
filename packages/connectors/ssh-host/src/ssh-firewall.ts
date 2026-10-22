// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell, not JavaScript templates.
/**
 * OpsCrew's SSH firewall for a runner machine (`harden.firewall`, FR-1536): an nftables table of
 * its own, `inet opscrew`, whose input chain accepts SSH (the TCP ports sshd listens on) from the
 * sources the user named and drops other traffic to those ports, over IPv4 and IPv6. Its chain's
 * policy is accept, so it changes no other port, rule, table or default policy: ufw, firewalld and
 * the machine's own nftables tables stay as they are (a packet must pass every base chain of the
 * input hook, so the table only ever adds a restriction).
 *
 * It persists through a unit of OpsCrew's own that loads {@link SSH_FIREWALL_RULES} at boot, not
 * through `/etc/nftables.conf`: that file is the user's and starts with `flush ruleset`, Debian
 * and Ubuntu read no drop-in folder from it, and their nftables service is off by default. The
 * unit loads the table again when the nftables service restarts or reloads (both flush every
 * table).
 */
import { listText, sha256Hex } from "@opscrew/core";
import { OPSCREW_DIR } from "./constants";
import { canonicalSshSource } from "./parse";

/** OpsCrew's own nftables table (family and name). */
export const SSH_FIREWALL_TABLE = "inet opscrew";
/** The rules the unit loads at boot. */
export const SSH_FIREWALL_RULES = `${OPSCREW_DIR}/nftables-ssh.nft`;
export const SSH_FIREWALL_SERVICE = "opscrew-ssh-firewall.service";
export const SSH_FIREWALL_UNIT = `/etc/systemd/system/${SSH_FIREWALL_SERVICE}`;

/** What the table lets in: the sources ({@link sshSources}) and SSH's ports (sorted). */
export interface SshFirewall {
  sources: readonly string[];
  ports: readonly number[];
}

/**
 * The sources as nft prints them ({@link canonicalSshSource}), without duplicates, IPv4 first,
 * each family sorted, so the same sources in any order give the same plan hash.
 */
export function sshSources(list: readonly string[]): string[] {
  const sources = new Set<string>();
  for (const text of list) {
    const source = canonicalSshSource(text);
    if (source === null) throw new Error(`not an SSH source: ${text.slice(0, 60)}`);
    sources.add(source);
  }
  const sorted = [...sources].sort();
  return [...sorted.filter((s) => !s.includes(":")), ...sorted.filter((s) => s.includes(":"))];
}

/** `port 22`, or `ports 22 and 2222`. */
export function sshPortsText(ports: readonly number[]): string {
  return `${ports.length === 1 ? "port" : "ports"} ${listText(ports.map(String))}`;
}

/** The chain's rules: each SSH port from each source, then the drop of the rest of each port. */
function ruleLines({ sources, ports }: SshFirewall): string[] {
  return [
    ...ports.flatMap((port) =>
      sources.map((s) => `${s.includes(":") ? "ip6" : "ip"} saddr ${s} tcp dport ${port} accept`),
    ),
    ...ports.map((port) => `tcp dport ${port} drop`),
  ];
}

/**
 * The rules file. Loading it replaces OpsCrew's table in one transaction (the table is created
 * first, so the delete never fails), so loading it again never adds a second copy of the rules.
 */
export function sshFirewallRules(firewall: SshFirewall): string {
  return `#!/usr/sbin/nft -f
# Managed by OpsCrew: SSH (${sshPortsText(firewall.ports)}) only from the sources you named.
# ${SSH_FIREWALL_SERVICE} loads it at boot. It is OpsCrew's own table (${SSH_FIREWALL_TABLE});
# no other table, rule or default policy is touched. Turning the SSH firewall off deletes the
# table and this file.
add table ${SSH_FIREWALL_TABLE}
delete table ${SSH_FIREWALL_TABLE}
table ${SSH_FIREWALL_TABLE} {
\tchain input {
\t\ttype filter hook input priority 0; policy accept;
${ruleLines(firewall)
  .map((line) => `\t\t${line}`)
  .join("\n")}
\t}
}
`;
}

/** The table as {@link SSH_FIREWALL_FUNCTIONS}' `nft_table` prints it once the rules are loaded. */
export function sshFirewallListing(firewall: SshFirewall): string {
  const lines = [
    `table ${SSH_FIREWALL_TABLE} {`,
    "chain input {",
    "type filter hook input priority filter; policy accept;",
    ...ruleLines(firewall),
    "}",
    "}",
  ];
  return `${lines.join("|")}|`;
}

/** The unit that loads the rules at boot, and again after the nftables service flushes them. */
export const SSH_FIREWALL_UNIT_TEXT = `# Managed by OpsCrew: SSH on this machine only from the sources you named, in OpsCrew's own
# nftables table ${SSH_FIREWALL_TABLE}. Turning the SSH firewall off removes it.
[Unit]
Description=OpsCrew SSH firewall: SSH only from the sources you named (nftables table ${SSH_FIREWALL_TABLE})
After=local-fs.target ufw.service firewalld.service nftables.service netfilter-persistent.service
PartOf=nftables.service
ReloadPropagatedFrom=nftables.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${SSH_FIREWALL_RULES}
ExecReload=/usr/sbin/nft -f ${SSH_FIREWALL_RULES}

[Install]
WantedBy=multi-user.target
`;

/** SHA-256 of the two files the step writes. */
export function sshFirewallFileHashes(firewall: SshFirewall): { rules: string; unit: string } {
  return {
    rules: sha256Hex(sshFirewallRules(firewall)),
    unit: sha256Hex(SSH_FIREWALL_UNIT_TEXT),
  };
}

/**
 * Shell functions shared by the inspection and the step's scripts:
 * - `nft_table` prints OpsCrew's table as nft lists it, one statement per line without its
 *   indentation, the lines joined with `|` (nothing when there is no such table). Older nft
 *   prints the chain's priority as 0, newer as filter.
 * - `ssh_connection` prints OpsCrew's `$SSH_CONNECTION` (`<address> <port> <server address>
 *   <server port>`), read from the nearest process that has it (sudo does not pass it on).
 */
export const SSH_FIREWALL_FUNCTIONS = `nft_table() {
  nft list table ${SSH_FIREWALL_TABLE} 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/ priority 0;/ priority filter;/' -e '/^$/d' | tr '\\n' '|'
}
ssh_connection() {
  conn=\${SSH_CONNECTION:-}
  pid=$$
  while [ -z "$conn" ] && [ "$pid" -gt 1 ]; do
    pid=$(sed -n 's/^.*) [A-Za-z] \\([0-9][0-9]*\\) .*$/\\1/p' "/proc/$pid/stat" 2>/dev/null) || pid=''
    [ -n "$pid" ] || break
    conn=$(tr '\\000' '\\n' 2>/dev/null < "/proc/$pid/environ" | sed -n 's/^SSH_CONNECTION=//p' | head -n 1) || conn=''
  done
  printf '%s\\n' "$conn"
}`;
