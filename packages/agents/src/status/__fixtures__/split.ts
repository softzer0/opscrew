/**
 * A deployed app split over two Hetzner servers for the tests of `status`, `verify`, `secure` and
 * `logs` (feature 018): the app's server `app` (with the web process) and `data` (with Postgres,
 * `db`), on a private network with a laptop, and fake shells on both servers.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema, type Network } from "@opscrew/plan-schema";
import { allocateNetwork, type ReadNetworkServices, type WireGuardPeerState } from "../../network";
import { splitPlan } from "../../network/__fixtures__/plans";
import { updateServerAddresses } from "../../shared/server-record";
import { createTestPhaseDeps, testKeyMaker } from "../../testing";

export const NOW = new Date("2026-10-30T12:00:00.000Z");
export const APP_HOST = "203.0.113.10";
export const DATA_HOST = "203.0.113.20";
const MIB = 1024 ** 2;

/** The figures command's answer: 2 CPUs, 4 GB, a disk 50% full, and each container's figures. */
export function figuresOutput(containers: readonly string[]): string {
  return [
    "==opscrew-figures:cpus",
    "2",
    "==opscrew-figures:load",
    "0.52 0.40 0.31 1/123 4567",
    "==opscrew-figures:memory",
    "               total        used        free      shared  buff/cache   available",
    "Mem:      4000000000  1500000000   500000000     1000000  2000000000  2400000000",
    "==opscrew-figures:disk",
    "Filesystem        1-blocks        Used   Available Capacity Mounted on",
    "/dev/sda1      40000000000 20000000000 20000000000      50% /",
    "==opscrew-figures:stats",
    ...containers.map((name) =>
      JSON.stringify({ Name: name, CPUPerc: "1.50%", MemUsage: "100MiB / 512MiB" }),
    ),
    "==opscrew-figures:inspect",
    ...containers.map((name) =>
      JSON.stringify({
        name: `/${name}`,
        restarts: 0,
        startedAt: "2026-10-30T10:00:00Z",
        memoryLimit: 512 * MIB,
      }),
    ),
    "",
  ].join("\n");
}

/** What a fake server answers. */
export interface FakeServer {
  /** `docker ps`'s `name|state` lines. */
  ps: string;
  /** `docker ps`'s `service|ports` lines. */
  ports: string;
  /** The figures command's answer. */
  figures: string;
  /** What the privilege probe prints (default `docker`). */
  privilege?: string;
  /** The login reaches Docker only through `sudo -n`: any other command using Docker fails. */
  dockerThroughSudo?: boolean;
  /** Answers to any other command, by a part of it (default exit 0, no output). */
  other?: (command: string) => CommandResult | undefined;
}

/** The split app with its fakes. */
export interface SplitWorld {
  plan: DeployPlan;
  /** `10.200.x`: the app's server is `.1`, `data` `.2`, the laptop `.100`. */
  prefix: string;
  deps: Awaited<ReturnType<typeof createTestPhaseDeps>>;
  servers: Record<string, FakeServer>;
  /** Hosts that do not answer over SSH. */
  offline: Set<string>;
  remote: (host: string) => RemoteExec;
  commands: { host: string; command: string }[];
  /** The WireGuard read, faked (each server's probe answers through its shell). */
  network: ReadNetworkServices;
  /** Each server's peers' last handshake in seconds, by server and peer name. */
  handshakes: Record<string, Record<string, number | undefined>>;
}

/** What `ping -c 3 -q` prints with three replies. */
function pingOutput(address: string): string {
  return [
    `--- ${address} ping statistics ---`,
    "3 packets transmitted, 3 received, 0% packet loss, time 2003ms",
    "rtt min/avg/max/mdev = 0.712/0.844/0.991/0.114 ms",
  ].join("\n");
}

/**
 * The split app, deployed, with `network` changes (grants, public SSH) applied, the servers'
 * addresses recorded and the deploy key on this computer.
 */
export async function splitWorld(
  options: {
    network?: (network: Network, prefix: string) => Network;
    /** This computer's commands (default the test deps' runner). */
    runner?: CommandRunner;
    /** Server data is the user's own, logged in to as `admin` (default a Hetzner server). */
    data?: "cloud" | "own";
  } = {},
): Promise<SplitWorld> {
  const keys = testKeyMaker();
  const base = splitPlan({ data: options.data ?? "cloud" });
  const facts = {
    app: { udpPortsInUse: [], wireguardInterfaces: [] },
    data: { udpPortsInUse: [], wireguardInterfaces: [] },
  };
  const allocated = allocateNetwork(base, facts, keys).network;
  const prefix = allocated.range.split(".").slice(0, 3).join(".");
  const withLaptop: Network = {
    ...allocated,
    devices: [
      {
        name: "laptop",
        address: `${prefix}.100`,
        publicKey: keys().publicKey,
        addedAt: "2026-10-30T10:00:00.000Z",
      },
    ],
  };
  const network = options.network?.(withLaptop, prefix) ?? withLaptop;
  const plan = DeployPlanSchema.parse({
    ...base,
    network,
    deployment: {
      ...base.deployment,
      lastApplyAt: "2026-10-12T08:00:00.000Z",
      firstDeployAt: "2026-10-12T09:00:00.000Z",
    },
  });
  const deps = await createTestPhaseDeps({
    clock: { now: () => NOW },
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
  });
  await updateServerAddresses(deps.paths, () => ({
    schemaVersion: 1,
    deployment: { ipv4: APP_HOST },
    servers: { data: { ipv4: DATA_HOST } },
    ...(options.data === "own"
      ? { ownServers: { data: { host: DATA_HOST, port: 22, user: "admin", agent: true } } }
      : {}),
  }));
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  const servers: Record<string, FakeServer> = {
    [APP_HOST]: {
      ps: "shop-app-1|running\n",
      ports: "app|\n",
      figures: figuresOutput(["shop-app-1"]),
    },
    [DATA_HOST]: {
      ps: "shop-db-1|running\n",
      ports: `db|${prefix}.2:5432->5432/tcp\n`,
      figures: figuresOutput(["shop-db-1"]),
    },
  };
  const offline = new Set<string>();
  const commands: { host: string; command: string }[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    async run(command): Promise<CommandResult> {
      commands.push({ host, command });
      const server = servers[host];
      if (server === undefined || offline.has(host)) {
        return { exitCode: 255, stdout: "", stderr: "ssh: connect to host: Connection timed out" };
      }
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (command.startsWith("ping ")) return ok(pingOutput(command.split(" ").at(-1) ?? ""));
      if (command.includes("echo sudo-password")) return ok(`${server.privilege ?? "docker"}\n`);
      if (server.dockerThroughSudo && command.includes("docker") && !command.includes("sudo -n")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "permission denied while trying to connect to the Docker daemon socket",
        };
      }
      if (command.includes("{{.Names}}|{{.State}}")) return ok(server.ps);
      if (command.includes("{{.Ports}}")) return ok(server.ports);
      if (command.includes("==opscrew-figures:")) return ok(server.figures);
      return server.other?.(command) ?? ok("");
    },
  });
  const handshakes: Record<string, Record<string, number | undefined>> = {
    app: { data: 5, laptop: 60 },
    data: { app: 10, laptop: 400 },
  };
  const keyOf = (name: string) =>
    [...network.members, ...network.devices].find((m) => m.name === name)?.publicKey ?? "";
  const serverOf = (host: string) => (host === APP_HOST ? "app" : "data");
  const world: SplitWorld = {
    plan,
    prefix,
    deps,
    servers,
    offline,
    remote,
    commands,
    handshakes,
    network: {
      async readWireGuard(shell) {
        const peers = handshakes[serverOf(shell.host)] ?? {};
        return Object.entries(peers).map(
          ([peer, seconds]): WireGuardPeerState => ({
            publicKey: keyOf(peer),
            allowedIps: [],
            ...(seconds !== undefined
              ? { latestHandshake: new Date(NOW.getTime() - seconds * 1000) }
              : {}),
          }),
        );
      },
    },
  };
  return world;
}
