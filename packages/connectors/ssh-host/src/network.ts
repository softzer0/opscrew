/**
 * OpsCrew's private network on a server (the `network` step, ADR 0022): one WireGuard interface
 * per app and environment, `wg-opscrew<port - 51820>`, brought up by systemd's `wg-quick@<if>`.
 *
 * Its configuration holds no private key: wg-quick sets the key from a root-only key file once the
 * interface is up (`PostUp`). A keyless `wg syncconf` would wipe the key, so peer changes sync a
 * full temporary configuration whose `PrivateKey` is read from that file (research R5a, R5b).
 * Docker starts after every OpsCrew interface (a drop-in with `Wants=` and `After=`, never
 * `Requires=`: a failed interface must not stop the app's own containers), so the services
 * published on a private address come up after a reboot.
 */
import { z } from "zod";
import { canonicalIpv4Cidr, networkHolds } from "./parse";
import { HostnameSchema, type HostStep } from "./types";

/** The interfaces' configurations and key files (root only). */
export const WIREGUARD_DIR = "/etc/wireguard";
/** Docker's drop-in: Docker wants every OpsCrew interface and starts after them. */
export const NETWORK_DROP_IN = "/etc/systemd/system/docker.service.d/opscrew-network.conf";

/**
 * Docker's default address pools. A container reaching a port published on its own host's private
 * address goes through docker-proxy on the INPUT chain, where ufw's default deny would drop it
 * (health checks of Kafka and Redpanda, MongoDB's replica-set self-check): ufw lets these networks
 * reach the private address, on the ports of the services published there only.
 */
export const DOCKER_POOLS = ["172.16.0.0/12", "192.168.0.0/16"] as const;

/** The UDP port of `wg-opscrew0`; the interface of port `p` is `wg-opscrew<p - 51820>`. */
const FIRST_PORT = 51820;
const INTERFACE_PREFIX = "wg-opscrew";

/** The interface's configuration, without its private key. */
export function networkConfigPath(iface: string): string {
  return `${WIREGUARD_DIR}/${iface}.conf`;
}

/** The interface's private key (0600), written from standard input. */
export function networkKeyPath(iface: string): string {
  return `${WIREGUARD_DIR}/${iface}.key`;
}

/** The full configuration `wg syncconf` reads (0600 in /run), removed right after. */
export function networkSyncPath(iface: string): string {
  return `/run/opscrew-${iface}.conf`;
}

/** The systemd unit that brings the interface up. */
export function networkUnit(iface: string): string {
  return `wg-quick@${iface}.service`;
}

/** The UDP port an OpsCrew interface listens on (its name holds `port - 51820`). */
export function networkPort(iface: string): number {
  return FIRST_PORT + Number(iface.slice(INTERFACE_PREFIX.length));
}

/** A WireGuard key as the `wg` tools print it: the base64 of exactly 32 bytes. */
export const WireGuardKeySchema = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/, {
  message: "must be a WireGuard key: the base64 of 32 bytes (44 characters ending in =)",
});

/** An app's network interface on a server: `wg-opscrew<port - 51820>`. */
export const NetworkInterfaceSchema = z.string().regex(/^wg-opscrew\d{1,5}$/, {
  message: "must be wg-opscrew followed by a number, such as wg-opscrew0",
});

/** The dotted IPv4 address `text` is, in canonical form; null otherwise. */
function ipv4(text: string): string | null {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) && canonicalIpv4Cidr(text) === text ? text : null;
}

/** The last number of an IPv4 address: 0 is a `/24`'s network, 255 its broadcast address. */
function hostPart(address: string): number {
  return Number(address.slice(address.lastIndexOf(".") + 1));
}

/** The `/24` network of an address such as `10.200.4.2/24`: `10.200.4.0/24`. */
export function networkRange(address: string): string {
  const [ip = ""] = address.split("/");
  return canonicalIpv4Cidr(`${ip}/24`) ?? "";
}

/** `10.200.4.2/24`: a host's address in a `/24`. */
function isHostAddress(text: string): boolean {
  const [ip = "", prefix] = text.split("/");
  const host = ipv4(ip);
  return prefix === "24" && host !== null && hostPart(host) >= 1 && hostPart(host) <= 254;
}

/** `host:port`: an IPv4 address, an IPv6 address in brackets, or a domain name, then a port. */
function isEndpoint(text: string): boolean {
  const match = /^(.+):(\d{1,5})$/.exec(text);
  const host = match?.[1] ?? "";
  const port = Number(match?.[2]);
  if (port < 1 || port > 65535) return false;
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return host.includes(":");
  return ipv4(host) !== null || HostnameSchema.safeParse(host).success;
}

/** One peer of the interface: another server of the app, or a device. */
const PeerSchema = z.strictObject({
  /** `app`, an extra server's name or a device's name. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, {
    message: "must be a server's or a device's name",
  }),
  publicKey: WireGuardKeySchema,
  /** Where the peer listens, when it has a public address (devices roam: they have none). */
  endpoint: z
    .string()
    .refine(isEndpoint, {
      message: "must be host:port, such as 203.0.113.7:51820 or [2001:db8::7]:51820",
    })
    .optional(),
  /** The peer's private address as a `/32`. */
  allowedIp: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/32$/, {
    message: "must be a private address as a /32, such as 10.200.4.2/32",
  }),
  /** Seconds between keepalives, when this server has no public address. */
  keepalive: z.int().min(1).max(65535).optional(),
});

/**
 * The `network` step's parameters (contracts/split-placement.md "ssh-host"), which the agents
 * derive from the plan: this server's interface, private address (`/24`), UDP port and public
 * key, its peers, the host's other OpsCrew interfaces (for Docker's drop-in), the login's SSH
 * port (opened on the interface), and the TCP ports of the services published on the private
 * address (`localPorts`, which the host's own Docker networks may reach). The private key is
 * never one of them: it reaches the server on standard input only.
 */
export const NetworkStepParamsSchema = z
  .strictObject({
    interface: NetworkInterfaceSchema,
    address: z.string().refine(isHostAddress, {
      message: "must be this server's private address in a /24, such as 10.200.4.2/24",
    }),
    port: z.int().min(FIRST_PORT).max(65535),
    publicKey: WireGuardKeySchema,
    peers: z.array(PeerSchema),
    otherInterfaces: z.array(NetworkInterfaceSchema),
    /** The port SSH answers on (22 on the servers OpsCrew creates). */
    sshPort: z.int().min(1).max(65535),
    /** The TCP ports of the services published on the private address (`publishedOnNetwork`). */
    localPorts: z.array(z.int().min(1).max(65535)),
  })
  .superRefine((params, ctx) => {
    if (params.port !== networkPort(params.interface)) {
      ctx.addIssue({
        code: "custom",
        path: ["port"],
        message: `must be the port ${params.interface} is named after (${networkPort(params.interface)})`,
      });
    }
    const range = networkRange(params.address);
    for (const [i, peer] of params.peers.entries()) {
      const [ip = ""] = peer.allowedIp.split("/");
      const host = ipv4(ip);
      if (host === null || !networkHolds(range, host) || [0, 255].includes(hostPart(host))) {
        ctx.addIssue({
          code: "custom",
          path: ["peers", i, "allowedIp"],
          message: `must be a /32 inside the network's range ${range}`,
        });
      }
    }
    if (params.otherInterfaces.includes(params.interface)) {
      ctx.addIssue({
        code: "custom",
        path: ["otherInterfaces"],
        message: `must not hold this step's own interface ${params.interface}`,
      });
    }
  });
export type NetworkStepParams = z.infer<typeof NetworkStepParamsSchema>;

/** The peers in the order the files list them: by name. */
function sortedPeers(peers: NetworkStepParams["peers"]): NetworkStepParams["peers"] {
  return [...peers].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The step's parameters as a host plan keeps them (a step's parameters are flat): the peers as
 * JSON, by name, and the other interfaces and the local ports space-separated and sorted, so the
 * same network always gives the same plan hash.
 */
export function networkStepFields(params: NetworkStepParams): HostStep["params"] {
  const peers = sortedPeers(params.peers).map((peer) => ({
    name: peer.name,
    publicKey: peer.publicKey,
    ...(peer.endpoint === undefined ? {} : { endpoint: peer.endpoint }),
    allowedIp: peer.allowedIp,
    ...(peer.keepalive === undefined ? {} : { keepalive: peer.keepalive }),
  }));
  return {
    interface: params.interface,
    address: params.address,
    port: params.port,
    publicKey: params.publicKey,
    peers: JSON.stringify(peers),
    otherInterfaces: [...params.otherInterfaces].sort().join(" "),
    sshPort: params.sshPort,
    localPorts: [...new Set(params.localPorts)].sort((a, b) => a - b).join(" "),
  };
}

/** A host plan's `network` step parameters ({@link networkStepFields}) read back and checked. */
export const NetworkStepFieldsSchema = z
  .strictObject({
    interface: z.string(),
    address: z.string(),
    port: z.number(),
    publicKey: z.string(),
    peers: z.string().transform((text, ctx): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: "must be the peers as JSON" });
        return z.NEVER;
      }
    }),
    otherInterfaces: z.string().transform((text) => text.split(" ").filter((name) => name !== "")),
    sshPort: z.number(),
    localPorts: z.string().transform((text) =>
      text
        .split(" ")
        .filter((port) => port !== "")
        .map(Number),
    ),
  })
  .pipe(NetworkStepParamsSchema);

/** The `[Peer]` sections, by name: the configuration and the sync file hold the same ones. */
export function networkPeerSections(peers: NetworkStepParams["peers"]): string {
  return sortedPeers(peers)
    .map((peer) =>
      [
        "[Peer]",
        `# ${peer.name}`,
        `PublicKey = ${peer.publicKey}`,
        `AllowedIPs = ${peer.allowedIp}`,
        ...(peer.endpoint === undefined ? [] : [`Endpoint = ${peer.endpoint}`]),
        ...(peer.keepalive === undefined ? [] : [`PersistentKeepalive = ${peer.keepalive}`]),
        "",
      ].join("\n"),
    )
    .join("\n");
}

/** The interface's configuration in /etc/wireguard: everything but the private key. */
export function networkConfig(params: NetworkStepParams): string {
  const peers = networkPeerSections(params.peers);
  return `# Managed by OpsCrew: this server's private network (WireGuard). opscrew provision rewrites it.
# The private key is not in this file: wg-quick sets it from ${WIREGUARD_DIR}/%i.key once the
# interface is up.
[Interface]
Address = ${params.address}
ListenPort = ${params.port}
PostUp = wg set %i private-key ${WIREGUARD_DIR}/%i.key
${peers === "" ? "" : `\n${peers}`}`;
}

/** Docker's drop-in for the host's OpsCrew interfaces (`interfaces`, at least one). */
export function networkDropIn(interfaces: readonly string[]): string {
  const units = [...interfaces].sort().map(networkUnit).join(" ");
  return `# Managed by OpsCrew: Docker starts after OpsCrew's WireGuard interfaces, so the services
# published on their addresses come up after a reboot. It wants them without requiring them: an
# interface that fails does not stop the app's own containers. opscrew destroy removes this file.
[Unit]
Wants=${units}
After=${units}
`;
}

/**
 * The server's routes (`HostFacts.ipv4Routes`, `<network> dev <interface>`) that overlap the
 * network's `/24`, other than the route of its own interface.
 */
export function clashingRoutes(routes: readonly string[], params: NetworkStepParams): string[] {
  const range = networkRange(params.address);
  const [base = ""] = range.split("/");
  return routes.filter((route) => {
    const [network = "", , dev] = route.split(" ");
    const [start = ""] = network.split("/");
    return dev !== params.interface && (networkHolds(network, base) || networkHolds(range, start));
  });
}
