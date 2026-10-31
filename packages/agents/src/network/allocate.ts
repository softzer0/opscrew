import { createHash } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import { APP_SERVER, type DeployPlan, type Network, networkInterface } from "@opscrew/plan-schema";
import { type KeyMaker, x25519KeyPair } from "./keys";

/** WireGuard's own port: the first OpsCrew network on a server listens there. */
const FIRST_PORT = 51820;
/** How many `/24` networks fit in 10.200.0.0/13. */
const RANGES = 2048;
/** The first address of 10.200.0.0/13, as a number. */
const RANGES_START = ipv4Number("10.200.0.0");
/** Extra servers take `.2` to `.99`; devices `.100` to `.254`. */
const FIRST_SERVER = 2;
const FIRST_DEVICE = 100;
const LAST_HOST = 254;

/** An IPv4 address as a number. */
function ipv4Number(address: string): number {
  return address.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** A number as an IPv4 address. */
function ipv4Text(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
}

/** The address `.host` of a `/24` range such as `10.200.4.0/24`. */
function hostAddress(range: string, host: number): string {
  return ipv4Text(ipv4Number(range.split("/")[0] ?? "") + host);
}

/** The last number of an IPv4 address. */
function hostOf(address: string): number {
  return Number(address.split(".")[3]);
}

/**
 * The network's `/24` for an app and environment: a stable hash of the app's name, key and
 * environment picks one of the 2048 inside 10.200.0.0/13, so two apps (or environments) of a
 * repository, or two repositories' apps on one server, differ.
 */
export function networkRange(plan: Pick<DeployPlan, "app" | "environment">): string {
  const identity = [plan.app.name, plan.app.key ?? "", plan.environment?.name ?? "prod"].join("\n");
  const index = createHash("sha256").update(identity).digest().readUInt32BE(0) % RANGES;
  return `${ipv4Text(RANGES_START + index * 256)}/24`;
}

/** What {@link allocateNetwork} reads of a server the user owns (ssh-host's inspection facts). */
export interface NetworkHostFacts {
  /** The UDP ports something listens on. */
  udpPortsInUse: readonly number[];
  /** The WireGuard interfaces configured on the host, up or down. */
  wireguardInterfaces: readonly string[];
}

/** {@link allocateNetwork}'s result: the plan's network, and the private keys it made. */
export interface AllocatedNetwork {
  network: Network;
  /** The new members' private keys by member name, for the generated values' `network`. */
  privateKeys: Record<string, string>;
}

/** The first port from 51820 that the host neither listens on nor has an interface for. */
function freePort(facts: NetworkHostFacts): number {
  const interfaces = new Set(facts.wireguardInterfaces);
  const used = new Set(facts.udpPortsInUse);
  let port = FIRST_PORT;
  while (used.has(port) || interfaces.has(networkInterface({ port }))) port += 1;
  return port;
}

/**
 * The plan's private network: one member per server in plan order (`app` first), with the app's
 * server at `.1` and new extra servers at the first free address from `.2`. Each new member listens
 * on 51820, or on a server the user owns on the first port its `facts` (by server name) show free,
 * and gets a key pair from `keys` (default Node's x25519). An existing network keeps its range,
 * devices, grants, public SSH and every kept member's address, port and public key; a server no
 * longer in the plan leaves it.
 * @throws Error when a new member is on a server the user owns whose facts are missing.
 */
export function allocateNetwork(
  plan: Pick<DeployPlan, "app" | "environment" | "target" | "servers" | "network">,
  facts: Readonly<Record<string, NetworkHostFacts>>,
  keys: KeyMaker = x25519KeyPair,
): AllocatedNetwork {
  const current = plan.network;
  const range = current?.range ?? networkRange(plan);
  const servers = [
    { name: APP_SERVER, own: plan.target.provider === "own" },
    ...(plan.servers ?? []).map((s) => ({ name: s.name, own: s.target.provider === "own" })),
  ];
  const kept = new Map(
    (current?.members ?? [])
      .filter((m) => servers.some((s) => s.name === m.name))
      .map((m) => [m.name, m]),
  );
  const taken = new Set([...kept.values()].map((m) => hostOf(m.address)));
  const privateKeys: Record<string, string> = {};
  const members = servers.map(({ name, own }) => {
    const member = kept.get(name);
    if (member !== undefined) return member;
    let host = name === APP_SERVER ? 1 : FIRST_SERVER;
    while (taken.has(host)) host += 1;
    if (host >= FIRST_DEVICE) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The private network ${range} has no free address for server ${name}: servers use .2 to .99.`,
        { hint: "Remove servers the app no longer uses from servers in the plan." },
      );
    }
    taken.add(host);
    let port = FIRST_PORT;
    if (own) {
      const found = facts[name];
      if (found === undefined) {
        throw new Error(`Server ${name} is the user's own, and its facts are needed for its port.`);
      }
      port = freePort(found);
    }
    const pair = keys();
    privateKeys[name] = pair.privateKey;
    return { name, address: hostAddress(range, host), port, publicKey: pair.publicKey };
  });
  return {
    network: {
      range,
      members,
      devices: current?.devices ?? [],
      grants: current?.grants ?? [],
      publicSsh: current?.publicSsh ?? true,
      ...(current?.publicSshAllowedCidrs !== undefined
        ? { publicSshAllowedCidrs: current.publicSshAllowedCidrs }
        : {}),
    },
    privateKeys,
  };
}

/**
 * The address for a new device: the first free one from `.100` to `.254` of the network's range.
 * @throws OpsCrewError `PHASE_PRECONDITION` when all of them are taken.
 */
export function nextDeviceAddress(network: Pick<Network, "range" | "devices">): string {
  const taken = new Set(network.devices.map((d) => hostOf(d.address)));
  for (let host = FIRST_DEVICE; host <= LAST_HOST; host += 1) {
    if (!taken.has(host)) return hostAddress(network.range, host);
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The private network ${network.range} has no free address for another device: devices use .100 to .254.`,
    { hint: "Remove a device you no longer use with `opscrew vpn remove <name>`, then try again." },
  );
}
