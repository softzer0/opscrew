import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { IMAGES } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { updateServerAddresses } from "../shared/server-record";
import { createTestPhaseDeps, testKeyMaker } from "../testing";
import { splitPlan, withNetwork } from "./__fixtures__/plans";
import { allocateNetwork } from "./allocate";
import { type ReadNetworkServices, readNetwork, type WireGuardPeerState } from "./read";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function pingOutput(address: string, received: number): string {
  return [
    `PING ${address} (${address}) 56(84) bytes of data.`,
    "",
    `--- ${address} ping statistics ---`,
    `3 packets transmitted, ${received} received, ${received === 0 ? 100 : 0}% packet loss, time 2003ms`,
    ...(received > 0 ? ["rtt min/avg/max/mdev = 0.712/0.844/0.991/0.114 ms"] : []),
    "",
  ].join("\n");
}

/** A split plan on the network with a laptop, and fake shells and WireGuard reads per server. */
async function world(options: {
  app?: "cloud" | "own";
  data?: "cloud" | "own";
  pingReplies?: number;
  /** Servers whose ssh fails and whose WireGuard read throws. */
  offline?: string[];
  handshakes: Record<string, Record<string, number | undefined>>;
}) {
  const keys = testKeyMaker();
  const base = splitPlan({ app: options.app ?? "cloud", data: options.data ?? "cloud" });
  const facts = {
    app: { udpPortsInUse: [], wireguardInterfaces: [] },
    data: { udpPortsInUse: [], wireguardInterfaces: [] },
  };
  const { network } = allocateNetwork(base, facts, keys);
  const prefix = network.range.split(".").slice(0, 3).join(".");
  const plan = withNetwork(base, {
    ...network,
    devices: [
      {
        name: "laptop",
        address: `${prefix}.100`,
        publicKey: keys().publicKey,
        addedAt: "2026-10-30T10:00:00.000Z",
      },
    ],
  });
  const deps = await createTestPhaseDeps({ clock: { now: () => NOW } });
  const login = { port: 22, agent: true };
  await updateServerAddresses(deps.paths, () => ({
    schemaVersion: 1,
    deployment: { ipv4: "203.0.113.10" },
    servers: { data: { ipv4: "203.0.113.20" } },
    own: { ...login, host: "203.0.113.10", user: "root" },
    ownServers: { data: { ...login, host: "203.0.113.20", user: "admin" } },
  }));
  const commands: { server: string; command: string }[] = [];
  const reads: { server: string; iface: string; privilege: string; rootImage: string }[] = [];
  const remote = (server: string): RemoteExec => ({
    host: server,
    async run(command): Promise<CommandResult> {
      commands.push({ server, command });
      if (options.offline?.includes(server)) {
        return { exitCode: 255, stdout: "", stderr: "ssh: connect to host: Connection timed out" };
      }
      const address = command.split(" ").at(-1) ?? "";
      const received = options.pingReplies ?? 3;
      return { exitCode: received > 0 ? 0 : 1, stdout: pingOutput(address, received), stderr: "" };
    },
  });
  const keyOf = (name: string) =>
    [...(plan.network?.members ?? []), ...(plan.network?.devices ?? [])].find(
      (m) => m.name === name,
    )?.publicKey ?? "";
  const services: ReadNetworkServices = {
    remote: async (server) => remote(server),
    async readWireGuard(shell, iface, privilege, { rootImage }) {
      reads.push({ server: shell.host, iface, privilege, rootImage });
      if (options.offline?.includes(shell.host)) throw new Error("wg show failed");
      return Object.entries(options.handshakes[shell.host] ?? {}).map(
        ([peer, seconds]): WireGuardPeerState => ({
          publicKey: keyOf(peer),
          allowedIps: [],
          ...(seconds !== undefined ? { latestHandshake: ago(seconds) } : {}),
        }),
      );
    },
  };
  return { plan, prefix, deps, services, commands, reads };
}

describe("readNetwork", () => {
  it("reads every server's links, with the round trip the app's server measured", async () => {
    const w = await world({
      handshakes: {
        app: { data: 5, laptop: 60 },
        data: { app: 10, laptop: 400 },
      },
    });
    const links = await readNetwork(w.deps, w.plan, w.services);
    expect(links).toEqual([
      { from: "app", to: "data", up: true, handshakeAgeSeconds: 5, roundTripMs: 0.8 },
      { from: "app", to: "laptop", up: true, handshakeAgeSeconds: 60 },
      { from: "data", to: "app", up: true, handshakeAgeSeconds: 10 },
      { from: "data", to: "laptop", up: false, handshakeAgeSeconds: 400 },
    ]);
    expect(w.commands).toEqual([{ server: "app", command: `ping -c 3 -q ${w.prefix}.2` }]);
    // Servers OpsCrew created are read through Docker, with the pinned Caddy image.
    expect(w.reads).toEqual([
      { server: "app", iface: "wg-opscrew0", privilege: "docker", rootImage: IMAGES.caddy.ref },
      { server: "data", iface: "wg-opscrew0", privilege: "docker", rootImage: IMAGES.caddy.ref },
    ]);
  });

  it("shows a link down when its last handshake is old or missing, and no round trip without a reply", async () => {
    const w = await world({
      pingReplies: 0,
      handshakes: { app: { data: 200 }, data: { app: 20, laptop: undefined } },
    });
    const links = await readNetwork(w.deps, w.plan, w.services);
    expect(links).toEqual([
      { from: "app", to: "data", up: false, handshakeAgeSeconds: 200 },
      { from: "app", to: "laptop", up: false },
      { from: "data", to: "app", up: true, handshakeAgeSeconds: 20 },
      { from: "data", to: "laptop", up: false },
    ]);
  });

  it("reports the links of a server it cannot reach or read as down, and reads the others", async () => {
    const handshakes = { app: { data: 5, laptop: 60 }, data: { app: 10, laptop: 30 } };
    const dataDown = await world({ offline: ["data"], handshakes });
    expect(await readNetwork(dataDown.deps, dataDown.plan, dataDown.services)).toEqual([
      { from: "app", to: "data", up: true, handshakeAgeSeconds: 5, roundTripMs: 0.8 },
      { from: "app", to: "laptop", up: true, handshakeAgeSeconds: 60 },
      { from: "data", to: "app", up: false, reason: "unreachable" },
      { from: "data", to: "laptop", up: false, reason: "unreachable" },
    ]);

    const appDown = await world({ offline: ["app"], handshakes });
    expect(await readNetwork(appDown.deps, appDown.plan, appDown.services)).toEqual([
      { from: "app", to: "data", up: false, reason: "unreachable" },
      { from: "app", to: "laptop", up: false, reason: "unreachable" },
      { from: "data", to: "app", up: true, handshakeAgeSeconds: 10 },
      { from: "data", to: "laptop", up: true, handshakeAgeSeconds: 30 },
    ]);
    expect(appDown.reads.map((r) => r.server)).toEqual(["data"]);

    // Its shell could not even be made (for example, its address is not on this computer).
    const noShell = await world({ handshakes });
    const remote = noShell.services.remote;
    const services: ReadNetworkServices = {
      ...noShell.services,
      remote: async (server) => {
        if (server === "data") throw new Error("no address");
        return (await remote?.(server)) as RemoteExec;
      },
    };
    const links = await readNetwork(noShell.deps, noShell.plan, services);
    expect(links.filter((l) => l.from === "data").map((l) => l.reason)).toEqual([
      "unreachable",
      "unreachable",
    ]);
  });

  it("reads the user's own servers as root, or through sudo", async () => {
    const w = await world({ app: "own", data: "own", handshakes: {} });
    await readNetwork(w.deps, w.plan, w.services);
    expect(w.reads.map((r) => [r.server, r.privilege])).toEqual([
      ["app", "root"],
      ["data", "sudo"],
    ]);
  });

  it("reads nothing without a network", async () => {
    const w = await world({ handshakes: {} });
    const { network: _n, ...plan } = w.plan;
    expect(await readNetwork(w.deps, plan as DeployPlan, w.services)).toEqual([]);
    expect(w.commands).toEqual([]);
  });
});
