// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell, not JavaScript templates.
/**
 * OpsCrew's web filter for a site served directly behind Cloudflare's proxy: Docker-published
 * ports bypass ufw (Docker routes them in the nat table, before ufw's INPUT rules), so the filter
 * sits in Docker's own `DOCKER-USER` chain. For new connections whose original destination port is
 * 80 or 443 (`conntrack --ctstate DNAT --ctorigdstport`), Cloudflare's ranges pass and everything
 * else is dropped. A unit runs it before Docker, and Docker requires that unit, so Docker never
 * publishes ports without the filter (fail closed).
 *
 * IPv4 only: in this mode the site is published on IPv4 only (Caddy binds `0.0.0.0`, no AAAA
 * record), because Docker serves an IPv6 host port of a container without IPv6 through
 * docker-proxy on the INPUT path, which `DOCKER-USER` never sees. A kernel without IPv6 therefore
 * never stops Docker at boot.
 *
 * Docker keeps an existing `DOCKER-USER` chain and its rules when it starts (moby's
 * `setupUserChain` only creates the chain when it is missing and adds the jump from `FORWARD`), so
 * the filter can be installed before Docker. Docker's nftables backend has no `DOCKER-USER` chain:
 * the filter refuses it.
 */
import { sha256Hex } from "@opscrew/core";
import { canonicalIpv4Cidr } from "./parse";

/** The script that installs the rules (run by the unit at boot, and by the step's apply). */
export const WEB_FILTER_SCRIPT = "/usr/local/sbin/opscrew-web-filter";
/** The unit that runs it before Docker. */
export const WEB_FILTER_SERVICE = "opscrew-web-filter.service";
export const WEB_FILTER_UNIT = `/etc/systemd/system/${WEB_FILTER_SERVICE}`;
/** Docker's drop-in: Docker requires the filter and starts after it. */
export const WEB_FILTER_DROP_IN = "/etc/systemd/system/docker.service.d/opscrew-web-filter.conf";
/** OpsCrew's own chain; `DOCKER-USER` jumps to it. */
export const WEB_FILTER_CHAIN = "OPSCREW-WEB";

/** The `web-filter` step's ranges: Cloudflare's IPv4 ranges, canonical, sorted, without duplicates. */
export interface WebFilterRanges {
  ipv4: string[];
}

/** IPv4 networks in the form iptables prints them, sorted and without duplicates. */
export function sortedNetworks(list: readonly string[]): string[] {
  const networks = new Set<string>();
  for (const text of list) {
    const network = canonicalIpv4Cidr(text);
    if (network === null) throw new Error(`not an IPv4 network: ${text.slice(0, 60)}`);
    networks.add(network);
  }
  return [...networks].sort();
}

/**
 * Lines that refuse a Docker that does not filter its ports through iptables: its daemon.json, or
 * its unit's command line and environment (`systemctl show docker`), name the nftables backend or
 * turn iptables off. `filter` names the filter that cannot work then ("OpsCrew's web filter").
 */
export function dockerBackendCheck(filter: string): string {
  return `if [ -f /etc/docker/daemon.json ] && grep -Eq '"firewall-backend"[[:space:]]*:[[:space:]]*"nftables"' /etc/docker/daemon.json; then
  fail "Docker is set to its nftables firewall backend (/etc/docker/daemon.json), which has no DOCKER-USER chain, so ${filter} cannot work."
fi
if [ -f /etc/docker/daemon.json ] && grep -Eq '"iptables"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json; then
  fail "Docker does not manage iptables (\\"iptables\\": false in /etc/docker/daemon.json), so ${filter} cannot work."
fi
docker_unit=$(systemctl show docker -p ExecStart -p Environment 2>/dev/null) || docker_unit=''
case "$docker_unit" in
  *firewall-backend=nftables* | *"firewall-backend nftables"* | *DOCKER_FIREWALL_BACKEND=nftables*)
    fail "Docker's service is set to its nftables firewall backend, which has no DOCKER-USER chain, so ${filter} cannot work." ;;
  *--iptables=false*)
    fail "Docker's service does not manage iptables (--iptables=false), so ${filter} cannot work." ;;
esac`;
}

/** {@link dockerBackendCheck} for the web filter. */
export const WEB_FILTER_BACKEND_CHECK = dockerBackendCheck("OpsCrew's web filter");

/**
 * Shell functions for the filter's rules, shared by the script on the server and the step's
 * checks: `leading_ok` (OpsCrew's three jumps are the first rules of DOCKER-USER) and
 * `chain_ok <networks>` (the chain lets exactly those networks pass and drops the rest).
 */
export const WEB_FILTER_FUNCTIONS = `leading_ok() {
  top=$(iptables -w -S DOCKER-USER 2>/dev/null | grep '^-A ' | head -n 3) || return 1
  for spec in 'tcp 80' 'tcp 443' 'udp 443'; do
    proto=\${spec% *}
    port=\${spec#* }
    printf '%s\\n' "$top" | grep -- "-p $proto " | grep -- "--ctorigdstport $port " | grep -q -- " -j ${WEB_FILTER_CHAIN}\\$" || return 1
  done
}
chain_ok() {
  iptables -w -n -L ${WEB_FILTER_CHAIN} >/dev/null 2>&1 || return 1
  rules=$(iptables -w -S ${WEB_FILTER_CHAIN} | grep -c '^-A ') || return 1
  n=0
  for net in $1; do
    n=$((n + 1))
    iptables -w -C ${WEB_FILTER_CHAIN} -s "$net" -j RETURN 2>/dev/null || return 1
  done
  [ "$rules" -eq $((n + 1)) ] || return 1
  [ "$(iptables -w -S ${WEB_FILTER_CHAIN} | grep '^-A ' | tail -n 1)" = "-A ${WEB_FILTER_CHAIN} -j DROP" ]
}`;

/** The script on the server, with the ranges in it (its SHA-256 is what the step checks). */
export function webFilterScript(ranges: WebFilterRanges): string {
  return `#!/bin/sh
# Managed by OpsCrew: only Cloudflare's addresses reach the web ports (80 and 443) that Docker
# publishes (IPv4; the site is not published on IPv6). ${WEB_FILTER_SERVICE} runs this before
# Docker, and Docker requires that service: when the filter cannot be installed, Docker does not
# start. \`opscrew destroy --undo-host\` removes it; \`opscrew provision\` updates the ranges.
set -eu
# PATH comes from systemd (or from OpsCrew's step, which runs it once right away).
IPV4='${ranges.ipv4.join(" ")}'
fail() {
  echo "opscrew-web-filter: $1" >&2
  exit 1
}
${WEB_FILTER_BACKEND_CHECK}
${WEB_FILTER_FUNCTIONS}
command -v iptables >/dev/null 2>&1 || fail "iptables is not installed."
command -v iptables-restore >/dev/null 2>&1 || fail "iptables-restore is not installed."
# OpsCrew's chain in one atomic change: Cloudflare's ranges pass, everything else is dropped.
{
  echo '*filter'
  echo ':${WEB_FILTER_CHAIN} - [0:0]'
  for net in $IPV4; do echo "-A ${WEB_FILTER_CHAIN} -s $net -j RETURN"; done
  echo '-A ${WEB_FILTER_CHAIN} -j DROP'
  echo 'COMMIT'
} | iptables-restore -w --noflush
# Before Docker starts DOCKER-USER may not exist yet; Docker keeps it and its rules.
iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || iptables -w -N DOCKER-USER
# The jumps for new connections to published ports 80 and 443 come first in DOCKER-USER.
if ! leading_ok; then
  for spec in 'udp 443' 'tcp 443' 'tcp 80'; do
    set -- $spec
    iptables -w -I DOCKER-USER 1 -p "$1" -m conntrack --ctstate DNAT --ctorigdstport "$2" --ctdir ORIGINAL -j ${WEB_FILTER_CHAIN}
  done
  # Older copies of the jumps further down go, from the bottom up. The chain is listed again
  # before each delete, and rule n goes only while it still is one of OpsCrew's jumps (another
  # program may have changed the chain in between).
  iptables -w -S DOCKER-USER | grep '^-A ' | awk 'NR > 3 && / -j ${WEB_FILTER_CHAIN}$/ { print NR }' | sort -rn |
    while read -r n; do
      rule=$(iptables -w -S DOCKER-USER | grep '^-A ' | sed -n "\${n}p")
      case "$rule" in
        *" -j ${WEB_FILTER_CHAIN}") iptables -w -D DOCKER-USER "$n" ;;
      esac
    done
fi
`;
}

/** The unit that runs the script before Docker (Docker requires it through the drop-in). */
export const WEB_FILTER_UNIT_TEXT = `# Managed by OpsCrew: only Cloudflare's addresses reach the web ports that Docker publishes.
# Docker requires this service (docker.service.d/opscrew-web-filter.conf), so it does not start
# without the filter. \`opscrew destroy --undo-host\` removes it.
[Unit]
Description=OpsCrew web filter: only Cloudflare reaches ports 80 and 443 that Docker publishes
After=local-fs.target ufw.service firewalld.service nftables.service netfilter-persistent.service iptables.service ip6tables.service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${WEB_FILTER_SCRIPT}

[Install]
WantedBy=multi-user.target
`;

/** Docker's drop-in: Docker starts only after the filter, and not at all when it fails. */
export const WEB_FILTER_DROP_IN_TEXT = `# Managed by OpsCrew: Docker starts only after OpsCrew's web filter is in place, and not at all
# when it fails (fail closed). \`opscrew destroy --undo-host\` removes this file.
[Unit]
Requires=${WEB_FILTER_SERVICE}
After=${WEB_FILTER_SERVICE}
`;

/** SHA-256 of the three files the step writes for these ranges. */
export function webFilterFileHashes(ranges: WebFilterRanges): {
  script: string;
  unit: string;
  dropIn: string;
} {
  return {
    script: sha256Hex(webFilterScript(ranges)),
    unit: sha256Hex(WEB_FILTER_UNIT_TEXT),
    dropIn: sha256Hex(WEB_FILTER_DROP_IN_TEXT),
  };
}
