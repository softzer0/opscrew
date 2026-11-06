import { isIP } from "node:net";
import type { NetworkFilterParams, NetworkStepParams } from "@opscrew/connector-ssh-host";
import {
  APP_SERVER,
  type DeployPlan,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  monitoringServerName,
  networkInterface,
} from "@opscrew/plan-schema";
import { hasPublicAddress, PREVIOUS_MEMBER } from "./endpoints";

/** The keepalive (seconds) on every server-to-server link; never toward a device. */
export const KEEPALIVE_SECONDS = 25;

/** `host:port` as WireGuard's `Endpoint` takes it (an IPv6 address in brackets). */
export function wireGuardEndpoint(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/** What {@link networkSteps} needs besides the plan. */
export interface ServerNetworkFacts {
  /**
   * The public address of each server on the network that has one, by name (`publicEndpoints`):
   * the monitoring server another environment owns too.
   */
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

/** What the network's steps read of a plan. */
type NetworkPlan = Pick<DeployPlan, "network" | "target" | "observability" | "retarget">;

/**
 * The plan's network and the server `server` on it, with the servers it links to: the other
 * members and, during a move to another app server (`retarget.from.member`), the old app server as
 * the peer {@link PREVIOUS_MEMBER} on every server but the new app server, until `--finish`.
 */
function onNetwork(plan: NetworkPlan, server: string) {
  const network = plan.network;
  const self = network?.members.find((m) => m.name === server);
  if (network === undefined || self === undefined) {
    throw new Error(`Server "${server}" is not on the plan's private network.`);
  }
  const previous = server === APP_SERVER ? undefined : plan.retarget?.from.member;
  const others = [
    ...network.members.filter((m) => m.name !== server),
    ...(previous === undefined ? [] : [{ ...previous, name: PREVIOUS_MEMBER }]),
  ];
  return { network, self, others, previous };
}

/**
 * The `network-filter` rules of the server `server`: a service's published port admits the app's
 * server and the devices granted that service; a dashboard's, every device. On a server without a
 * public address no device is admitted: none can reach it. On the server the monitoring stack runs
 * on (`monitoringServerName`; for a plan that sends to another environment's, its interface for
 * this network), the stack's front admits the network's other servers, which push to it, and
 * Grafana every device. Nothing else admits the monitoring server: it only receives (with the
 * stack on the app's server, the app reaches its services as it always does). During a move to
 * another app server, the old app server is admitted wherever the app's server is, until
 * `--finish`.
 * @throws Error when the plan has no network or the server is not on it.
 */
export function networkFilterRules(
  plan: NetworkPlan,
  server: string,
  published: ServerNetworkFacts["published"],
): NetworkFilterParams["rules"] {
  const { network, others, previous } = onNetwork(plan, server);
  const app = network.members.find((m) => m.name === APP_SERVER)?.address;
  // Devices peer only with servers that have a public address: no other server admits them.
  const admitted = hasPublicAddress(plan, server);
  const devices = () => (admitted ? network.devices.map((d) => d.address) : []);
  const deviceAddress = (name: string) =>
    admitted ? network.devices.find((d) => d.name === name)?.address : undefined;
  const rules = published.map(({ service, port, dashboard }) => {
    if (dashboard === true) return { port, sources: devices() };
    const granted = network.grants
      .filter((g) => g.service === service)
      .map((g) => deviceAddress(g.device));
    const sources = [...new Set([app, previous?.address, ...granted])].filter(
      (a): a is string => a !== undefined,
    );
    return { port, sources };
  });
  if (server !== monitoringServerName(plan)) return rules;
  // The stack's own server's Alloy pushes over a Docker network, never the private address.
  const servers = others.map((m) => m.address);
  return [
    ...rules,
    { port: MONITORING_PUSH_PORT, sources: servers },
    { port: MONITORING_GRAFANA_PORT, sources: devices() },
  ];
}

/** The host's other OpsCrew interfaces than `iface`, which Docker's drop-in waits for. */
function otherInterfaces(wireguardInterfaces: readonly string[], iface: string): string[] {
  return wireguardInterfaces.filter((name) => name !== iface && OPSCREW_INTERFACE.test(name));
}

/**
 * The `network` and `network-filter` params of the server `server` (`app`, an extra server, or the
 * monitoring server another environment owns, for its interface on this plan's network), without
 * the `network` step's `localPorts`. Its peers are every other server, with an endpoint
 * when that server has a public address and a 25-second keepalive, so every link between servers
 * stays up even when idle, and, when this server has a public address, every device (whose own
 * configuration keeps its link up). Its filter has {@link networkFilterRules}, and is planned for
 * every server on the network, even with no rules: after the per-port rules it drops every other
 * new connection to the private address (the default deny). During a move to another app server
 * the old app server is a peer too ({@link PREVIOUS_MEMBER}, its endpoint by that name), except on
 * the new app server.
 * @throws Error when the plan has no network or the server is not on it.
 */
export function networkSteps(
  plan: NetworkPlan,
  server: string,
  facts: ServerNetworkFacts,
): { network: Omit<NetworkStepParams, "localPorts">; filter: NetworkFilterParams } {
  const { network, self, others } = onNetwork(plan, server);
  const iface = networkInterface(self);
  const servers = others.map((m) => {
    const host = facts.endpoints[m.name];
    return {
      name: m.name,
      publicKey: m.publicKey,
      ...(host !== undefined ? { endpoint: wireGuardEndpoint(host, m.port) } : {}),
      allowedIp: `${m.address}/32`,
      keepalive: KEEPALIVE_SECONDS,
    };
  });
  const devices = hasPublicAddress(plan, server)
    ? network.devices.map((d) => ({
        name: d.name,
        publicKey: d.publicKey,
        allowedIp: `${d.address}/32`,
      }))
    : [];
  return {
    network: {
      interface: iface,
      address: `${self.address}/${network.range.split("/")[1]}`,
      port: self.port,
      publicKey: self.publicKey,
      peers: [...servers, ...devices],
      otherInterfaces: otherInterfaces(facts.wireguardInterfaces, iface),
      sshPort: facts.sshPort,
    },
    filter: {
      interface: iface,
      address: self.address,
      rules: networkFilterRules(plan, server, facts.published),
    },
  };
}

/**
 * The `network` and `network-filter` removal params of the interface `iface` on a server, for a
 * member that left the network: the monitoring server another environment owns, once this one
 * turned monitoring off or was destroyed. The filter goes, then the interface, and Docker's
 * drop-in keeps the host's other OpsCrew interfaces (its facts).
 */
export function networkRemovalSteps(
  iface: string,
  facts: Pick<ServerNetworkFacts, "wireguardInterfaces">,
): {
  network: { interface: string; remove: true; otherInterfaces: string[] };
  filter: { interface: string; remove: true };
} {
  return {
    network: {
      interface: iface,
      remove: true,
      otherInterfaces: otherInterfaces(facts.wireguardInterfaces, iface),
    },
    filter: { interface: iface, remove: true },
  };
}
