/**
 * OpsCrew's network filter (the `network-filter` step, ADR 0022): on each app's private network,
 * only the app's servers and the devices granted access reach what Docker publishes on the
 * server's private address. Docker routes published ports in the nat table, before ufw, so the
 * filter sits in Docker's own `DOCKER-USER` chain, as the web filter does: chain `OPSCREW-<if>`,
 * jumped to from `DOCKER-USER`, with an `ACCEPT` per source and a `DROP` per port, all on new
 * connections whose original destination is the private address and port (research R5a, R5b).
 * It matches on any input interface, so traffic to the private address that arrives another way
 * (a LAN that routes the range through the server) is dropped too.
 *
 * One script per interface (`/usr/local/sbin/opscrew-network-filter-<if>`) rebuilds the chain in
 * one atomic change. The templated unit `opscrew-network-filter@<if>.service` runs it before
 * Docker, and Docker's drop-in for that instance requires it, so Docker never publishes a port on
 * the private address without the filter (fail closed).
 */
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { NetworkInterfaceSchema } from "./network";
import { canonicalIpv4Cidr, linesOf, parseNetworkFilterRules } from "./parse";
import { type HostPrivilege, rootCall } from "./privilege";
import { APT_FUNCTIONS, buildScript } from "./shell";
import { dockerBackendCheck } from "./web-filter";

/** The templated unit every interface's filter runs from. */
export const NETWORK_FILTER_UNIT = "/etc/systemd/system/opscrew-network-filter@.service";
/** The scripts' common prefix; the interface's name follows it. */
export const NETWORK_FILTER_SCRIPT_PREFIX = "/usr/local/sbin/opscrew-network-filter-";

/** The script that installs the interface's rules (run by its unit, and by the step's apply). */
export function networkFilterScriptPath(iface: string): string {
  return `${NETWORK_FILTER_SCRIPT_PREFIX}${iface}`;
}

/** The unit instance that runs the interface's script before Docker. */
export function networkFilterService(iface: string): string {
  return `opscrew-network-filter@${iface}.service`;
}

/** Docker's drop-in for the interface's filter: Docker requires the unit instance. */
export function networkFilterDropInPath(iface: string): string {
  return `/etc/systemd/system/docker.service.d/opscrew-network-filter-${iface}.conf`;
}

/** OpsCrew's chain for the interface; `DOCKER-USER` jumps to it. */
export function networkFilterChain(iface: string): string {
  return `OPSCREW-${iface}`;
}

/** A dotted IPv4 address in canonical form, such as `10.200.4.2`. */
const Ipv4AddressSchema = z
  .string()
  .refine((text) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) && canonicalIpv4Cidr(text) === text, {
    message: "must be an IPv4 address such as 10.200.4.2",
  });

/** Who may open one port published on the private address. */
export interface NetworkFilterRule {
  port: number;
  /** The private addresses that may open it (the app's server, granted devices). */
  sources: string[];
}

/**
 * The `network-filter` step's parameters (contracts/split-placement.md "ssh-host"): the interface,
 * this server's private address, and per published port the addresses that may open it. An empty
 * rule list removes the interface's filter.
 */
export const NetworkFilterParamsSchema = z
  .strictObject({
    interface: NetworkInterfaceSchema,
    address: Ipv4AddressSchema,
    rules: z.array(
      z.strictObject({
        port: z.int().min(1).max(65535),
        sources: z.array(Ipv4AddressSchema),
      }),
    ),
  })
  .superRefine((params, ctx) => {
    const ports = params.rules.map((rule) => rule.port);
    if (new Set(ports).size !== ports.length) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "must name each port once" });
    }
  });
export type NetworkFilterParams = z.infer<typeof NetworkFilterParamsSchema>;

/** The rules by port, each with its sources sorted and without duplicates. */
function sortedRules(rules: readonly NetworkFilterRule[]): NetworkFilterRule[] {
  return [...rules]
    .sort((a, b) => a.port - b.port)
    .map((rule) => ({ port: rule.port, sources: [...new Set(rule.sources)].sort() }));
}

/**
 * The step's parameters as a host plan keeps them (flat): the rules as `<port>=<source>,...`,
 * space-separated, by port, so the same filter always gives the same plan hash.
 */
export function networkFilterFields(params: NetworkFilterParams): Record<string, string> {
  return {
    interface: params.interface,
    address: params.address,
    rules: sortedRules(params.rules)
      .map((rule) => `${rule.port}=${rule.sources.join(",")}`)
      .join(" "),
  };
}

/** A host plan's `network-filter` parameters ({@link networkFilterFields}) read back and checked. */
export const NetworkFilterFieldsSchema = z
  .strictObject({
    interface: z.string(),
    address: z.string(),
    rules: z.string().transform((text, ctx): unknown => {
      const rules = text.split(" ").filter((item) => item !== "");
      return rules.map((item) => {
        const match = /^(\d{1,5})=(.*)$/.exec(item);
        if (match === null) {
          ctx.addIssue({ code: "custom", message: "must be <port>=<source>,... per port" });
          return z.NEVER;
        }
        const sources = (match[2] ?? "").split(",").filter((source) => source !== "");
        return { port: Number(match[1]), sources };
      });
    }),
  })
  .pipe(NetworkFilterParamsSchema);

/** The chain's rules, in the form `iptables-restore` takes after `-A <chain>`, in order. */
export function networkFilterRuleSpecs(params: NetworkFilterParams): string[] {
  return sortedRules(params.rules).flatMap((rule) => {
    const match = `-p tcp -m conntrack --ctstate NEW --ctorigdst ${params.address} --ctorigdstport ${rule.port} --ctdir ORIGINAL`;
    return [
      ...rule.sources.map((source) => `-s ${source}/32 ${match} -j ACCEPT`),
      `${match} -j DROP`,
    ];
  });
}

/**
 * The interface's script on the server, with its rules in it (its SHA-256 is what the step
 * checks). `--check` only says, by its exit code, whether the chain and the jump are in place.
 */
export function networkFilterScript(params: NetworkFilterParams): string {
  const iface = params.interface;
  return `#!/bin/sh
# Managed by OpsCrew: on the private network ${iface}, only the app's servers and the devices
# granted access reach what Docker publishes on ${params.address}. ${networkFilterService(iface)}
# runs this before Docker, and Docker requires that service: when the filter cannot be installed,
# Docker does not start. \`opscrew provision\` rewrites it; \`opscrew destroy\` removes it.
set -eu
# PATH comes from systemd (or from OpsCrew's step, which runs it once right away).
CHAIN='${networkFilterChain(iface)}'
fail() {
  echo "opscrew-network-filter: $1" >&2
  exit 1
}
# The chain's rules, one per line: per port, the addresses that may open it, then a drop.
rules() {
  cat <<'OPSCREW_RULES'
${networkFilterRuleSpecs(params).join("\n")}
OPSCREW_RULES
}
# The chain holds exactly these rules, and DOCKER-USER jumps to it.
in_place() {
  iptables -w -C DOCKER-USER -j "$CHAIN" 2>/dev/null || return 1
  [ "$(iptables -w -S "$CHAIN" 2>/dev/null | grep -c '^-A ')" -eq "$(rules | grep -c .)" ] || return 1
  rules | while read -r spec; do
    # The rule's words are split on purpose.
    iptables -w -C "$CHAIN" $spec 2>/dev/null || exit 1
  done
}
if [ "\${1:-}" = --check ]; then
  if in_place; then exit 0; fi
  exit 1
fi
${dockerBackendCheck("OpsCrew's network filter")}
command -v iptables >/dev/null 2>&1 || fail "iptables is not installed."
command -v iptables-restore >/dev/null 2>&1 || fail "iptables-restore is not installed."
# OpsCrew's chain in one atomic change.
{
  echo '*filter'
  echo ":$CHAIN - [0:0]"
  rules | sed "s/^/-A $CHAIN /"
  echo 'COMMIT'
} | iptables-restore -w --noflush
# Before Docker starts DOCKER-USER may not exist yet; Docker keeps it and its rules.
iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || iptables -w -N DOCKER-USER
if ! iptables -w -C DOCKER-USER -j "$CHAIN" 2>/dev/null; then
  # Right after OpsCrew's web filter's jumps, which stay the first rules of DOCKER-USER.
  n=$(iptables -w -S DOCKER-USER | grep '^-A ' | awk '!/ -j OPSCREW-WEB$/ { exit } { n = NR } END { print n + 1 }')
  iptables -w -I DOCKER-USER "$n" -j "$CHAIN"
fi
`;
}

/** The templated unit: it runs an interface's script before Docker. */
export const NETWORK_FILTER_UNIT_TEXT = `# Managed by OpsCrew: on an app's private network, only the app's servers and the granted devices
# reach what Docker publishes on the server's private address. Docker requires each instance
# (docker.service.d/opscrew-network-filter-<interface>.conf), so it does not start without the
# filter. \`opscrew destroy\` removes it.
[Unit]
Description=OpsCrew network filter on %i: only the app's servers and granted devices reach its private address
After=local-fs.target ufw.service firewalld.service nftables.service netfilter-persistent.service iptables.service ip6tables.service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${NETWORK_FILTER_SCRIPT_PREFIX}%i

[Install]
WantedBy=multi-user.target
`;

/** Docker's drop-in for the interface's filter: Docker starts only after it, and not when it fails. */
export function networkFilterDropIn(iface: string): string {
  const service = networkFilterService(iface);
  return `# Managed by OpsCrew: Docker starts only after OpsCrew's network filter on ${iface} is in place,
# and not at all when it fails (fail closed). \`opscrew destroy\` removes this file.
[Unit]
Requires=${service}
After=${service}
`;
}

/** The read-only script of {@link readNetworkFilter}: the jump, then the chain's rules. */
export function readNetworkFilterScript(iface: string): string {
  return buildScript(
    "network-filter.read",
    { CHAIN: networkFilterChain(iface) },
    `${APT_FUNCTIONS}
command -v iptables >/dev/null 2>&1 || fail 'iptables is not installed on the server.'
if iptables -w -C DOCKER-USER -j "$CHAIN" 2>/dev/null; then echo 'jump yes'; else echo 'jump no'; fi
if iptables -w -n -L "$CHAIN" >/dev/null 2>&1; then iptables -w -S "$CHAIN"; fi`,
  );
}

/**
 * OpsCrew's network filter on the interface `iface` as the server has it: each filtered port with
 * the private addresses its chain accepts, read as root the way `privilege` says (`rootImage` is
 * the `docker` privilege's image, as `ApplyOptions.rootImage`). Undefined when the chain does not
 * exist or `DOCKER-USER` does not jump to it, so nothing is filtered. Read-only. Throws
 * COMMAND_FAILED when the server cannot be reached or cannot read its firewall.
 */
export async function readNetworkFilter(
  remote: RemoteExec,
  iface: string,
  privilege: HostPrivilege,
  rootImage?: string,
): Promise<NetworkFilterRule[] | undefined> {
  if (!NetworkInterfaceSchema.safeParse(iface).success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "That is not one of OpsCrew's WireGuard interfaces (wg-opscrew followed by a number).",
    );
  }
  const call = rootCall(privilege, readNetworkFilterScript(iface), undefined, rootImage);
  const options = { timeoutMs: 60_000, ...(call.input === undefined ? {} : { input: call.input }) };
  let result: Awaited<ReturnType<RemoteExec["run"]>>;
  try {
    result = await remote.run(call.command, options);
  } catch (error) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "OpsCrew could not read the private network's filter on the server.",
      { hint: "Check that the server is reachable over SSH, then try again.", cause: error },
    );
  }
  const lines = linesOf(result.stdout);
  if (result.exitCode !== 0 || !lines.some((line) => line.startsWith("jump "))) {
    const own = linesOf(result.stderr)
      .filter((line) => line.startsWith("opscrew: "))
      .map((line) => line.slice("opscrew: ".length));
    throw new OpsCrewError(
      "COMMAND_FAILED",
      own.length > 0
        ? own.join(" ")
        : `OpsCrew could not read the filter of ${iface} on the server.`,
      { hint: "Check that the server is reachable over SSH, then try again." },
    );
  }
  const chain = networkFilterChain(iface);
  if (!lines.includes("jump yes") || !lines.includes(`-N ${chain}`)) return undefined;
  return parseNetworkFilterRules(lines);
}
