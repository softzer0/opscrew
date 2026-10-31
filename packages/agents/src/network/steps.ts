import { isIP } from "node:net";
import { APP_SERVER, type DeployPlan, networkInterface } from "@opscrew/plan-schema";
import { hasPublicAddress } from "./endpoints";

/** The keepalive (seconds) on every server-to-server link; never toward a device. */
export const KEEPALIVE_SECONDS = 25;

/** `host:port` as WireGuard's `Endpoint` takes it (an IPv6 address in brackets). */
export function wireGuardEndpoint(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/** A peer of a server's WireGuard interface. */
export interface NetworkPeer {
  /** The peer's name: a server (`app` or an extra server's) or a device. */
  name: string;
  publicKey: string;
  /** `host:port`, for a server with a public address. */
  endpoint?: string;
  /** The peer's private address as a `/32`. */
  allowedIp: string;
  /** Seconds between keepalives: toward every other server, never toward a device. */
  keepalive?: number;
}

/** The host adapter's `network` step for one server (the private key travels separately). */
export interface NetworkStepParams {
  /** `wg-opscrew<k>`. */
  interface: string;
  /** The server's private address with the range's prefix, such as `10.200.4.2/24`. */
  address: string;
  port: number;
  /** The server's own public key. */
  publicKey: string;
  peers: NetworkPeer[];
  /** The host's other OpsCrew interfaces, for Docker's drop-in. */
  otherInterfaces: string[];
  /** The port SSH listens on, allowed on the interface. */
  sshPort: number;
}

/** The host adapter's `network-filter` step: who may open each port published on the address. */
export interface NetworkFilterParams {
  interface: string;
  /** The server's private address. */
  address: string;
  /** Per published port, who may open it; every other new connection is dropped. */
  rules: { port: number; sources: string[] }[];
}

/** What {@link networkSteps} needs besides the plan. */
export interface ServerNetworkFacts {
  /** The public address of each server that has one, by name (`publicEndpoints`). */
  endpoints: Readonly<Record<string, string>>;
  /** The WireGuard interfaces on this server (its inspection facts; none on a new cloud server). */
  wireguardInterfaces: readonly string[];
  /**
   * Each port published on this server's private address (iac-templates' `publishedOnNetwork`);
   * `dashboard` marks a dashboard's (Beszel's, Portainer's).
   */
  published: readonly { service: string; port: number; dashboard?: boolean }[];
  /** The port sshd listens on, from the server's facts (`networkSshPort`). */
  sshPort: number;
}

/** OpsCrew's own interfaces: `wg-opscrew<k>`. */
const OPSCREW_INTERFACE = /^wg-opscrew\d+$/;

/**
 * The `network` and `network-filter` params of the server `server` (`app` or an extra server).
 * Its peers are every other server, with an endpoint when that server has a public address and a
 * 25-second keepalive, so every link between servers stays up even when idle, and, when this server
 * has a public address, every device (whose own configuration keeps its link up). A service's
 * published port admits the app's server and the devices granted that service; a dashboard's,
 * every device. On a server without a public address no device is admitted: none can reach it.
 * The filter is planned for every server on the network, even with no rules: after the per-port
 * rules it drops every other new connection to the private address (the default deny).
 * @throws Error when the plan has no network or the server is not on it.
 */
export function networkSteps(
  plan: Pick<DeployPlan, "network" | "target">,
  server: string,
  facts: ServerNetworkFacts,
): { network: NetworkStepParams; filter: NetworkFilterParams } {
  const network = plan.network;
  const self = network?.members.find((m) => m.name === server);
  if (network === undefined || self === undefined) {
    throw new Error(`Server "${server}" is not on the plan's private network.`);
  }
  const iface = networkInterface(self);
  const reachable = facts.endpoints[server] !== undefined;
  const servers: NetworkPeer[] = network.members
    .filter((m) => m.name !== server)
    .map((m) => {
      const host = facts.endpoints[m.name];
      return {
        name: m.name,
        publicKey: m.publicKey,
        ...(host !== undefined ? { endpoint: wireGuardEndpoint(host, m.port) } : {}),
        allowedIp: `${m.address}/32`,
        keepalive: KEEPALIVE_SECONDS,
      };
    });
  const devices: NetworkPeer[] = reachable
    ? network.devices.map((d) => ({
        name: d.name,
        publicKey: d.publicKey,
        allowedIp: `${d.address}/32`,
      }))
    : [];
  const app = network.members.find((m) => m.name === APP_SERVER)?.address;
  // Devices peer only with servers that have a public address: no other server admits them.
  const admitted = hasPublicAddress(plan, server);
  const deviceAddress = (name: string) =>
    admitted ? network.devices.find((d) => d.name === name)?.address : undefined;
  const rules = facts.published.map(({ service, port, dashboard }) => {
    if (dashboard === true) {
      return { port, sources: admitted ? network.devices.map((d) => d.address) : [] };
    }
    const granted = network.grants
      .filter((g) => g.service === service)
      .map((g) => deviceAddress(g.device));
    const sources = [...new Set([app, ...granted])].filter((a): a is string => a !== undefined);
    return { port, sources };
  });
  return {
    network: {
      interface: iface,
      address: `${self.address}/${network.range.split("/")[1]}`,
      port: self.port,
      publicKey: self.publicKey,
      peers: [...servers, ...devices],
      otherInterfaces: facts.wireguardInterfaces.filter(
        (name) => name !== iface && OPSCREW_INTERFACE.test(name),
      ),
      sshPort: facts.sshPort,
    },
    filter: { interface: iface, address: self.address, rules },
  };
}
