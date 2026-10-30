import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordServerAddress } from "../shared";
import { createTestPhaseDeps, SERVER_IPV4, testPlan } from "../testing";
import { APP_HOST, DATA_HOST, splitWorld } from "./__fixtures__/split";
import { componentStatusReport } from "./run";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const MIB = 1024 ** 2;

/** The figures command's answer: 2 CPUs, 4 GB, a disk 50% full, and each container's figures. */
function figures(containers: { name: string; memoryMb: number }[]): string {
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
    ...containers.map((c) =>
      JSON.stringify({ Name: c.name, CPUPerc: "1.50%", MemUsage: "100MiB / 512MiB" }),
    ),
    "==opscrew-figures:inspect",
    ...containers.map((c) =>
      JSON.stringify({
        name: `/${c.name}`,
        restarts: 0,
        startedAt: "2026-10-30T10:00:00Z",
        memoryLimit: c.memoryMb * MIB,
      }),
    ),
    "",
  ].join("\n");
}

/** What a fake server answers: its containers (`docker ps`), its figures. */
interface FakeServer {
  ps: string;
  figures: string;
}

/** Shells on fake servers by address, recording each command with its server's address. */
function fakeServers(servers: Record<string, FakeServer>) {
  const commands: { host: string; command: string }[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    async run(command): Promise<CommandResult> {
      commands.push({ host, command });
      const server = servers[host];
      if (server === undefined) return { exitCode: 255, stdout: "", stderr: "timed out" };
      if (command.includes("'{{.Names}}|{{.State}}'")) {
        return { exitCode: 0, stdout: server.ps, stderr: "" };
      }
      return { exitCode: 0, stdout: server.figures, stderr: "" };
    },
  });
  return { remote, commands };
}

/** `plan`, deployed and seen running. */
function deployed(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    deployment: { ...plan.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
  });
}

async function serverDeps() {
  const deps = await createTestPhaseDeps({ clock: { now: () => NOW } });
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  return deps;
}

describe("status of a plan without servers or a network", () => {
  it("shows exactly what it showed before split placement", async () => {
    const deps = await serverDeps();
    const servers = fakeServers({
      [SERVER_IPV4]: {
        ps: "shop-app-1|running\nshop-db-1|running\n",
        figures: figures([
          { name: "shop-app-1", memoryMb: 512 },
          { name: "shop-db-1", memoryMb: 512 },
        ]),
      },
    });
    const report = await componentStatusReport(deps, deployed(testPlan({ deployed: true })), {
      services: { remote: servers.remote },
    });
    expect(report.lines).toMatchSnapshot();
    expect(Object.keys(report).sort()).toEqual(["lines", "resources", "status"]);
  });
});

describe("status of an app on two servers", () => {
  it("shows each server by name with its components and figures, then the private network", async () => {
    const w = await splitWorld({
      network: (network) => ({
        ...network,
        grants: [{ device: "laptop", service: "db", access: "read-only" }],
      }),
    });
    const report = await componentStatusReport(w.deps, w.plan, {
      services: { remote: w.remote },
      network: w.network,
    });
    const range = w.plan.network?.range;
    expect(report.lines).toEqual([
      "Components on server app:",
      "  The web process (app): running",
      "",
      "Resources on server app (read now):",
      expect.stringMatching(/^ {2}Server app: load 0\.52/),
      expect.stringMatching(/^ {2}The web process \(app\): CPU 1\.5%/),
      "",
      "Components on server data:",
      "  PostgreSQL (db): running",
      "",
      "Resources on server data (read now):",
      expect.stringMatching(/^ {2}Server data: load 0\.52/),
      expect.stringMatching(/^ {2}PostgreSQL \(db\): CPU 1\.5%/),
      "",
      `Private network (${range}):`,
      "  app to data: up, last handshake 5 seconds ago, round trip 0.8 ms",
      "  data to app: up, last handshake 10 seconds ago",
      "  Device laptop (" +
        `${w.prefix}.100): last handshake with server app 1 minute ago, with server data 6 minutes ago`,
      "  Access: device laptop to PostgreSQL (db), read-only",
      "  Public SSH: open on every server",
    ]);
    // The data for the MCP server: every server, the links, the devices without keys, the grants.
    expect(
      report.servers?.map((s) => [s.name, s.status?.components.map((c) => c.service)]),
    ).toEqual([
      ["app", ["app"]],
      ["data", ["db"]],
    ]);
    expect(report.links).toHaveLength(4);
    expect(report.devices).toEqual([{ name: "laptop", address: `${w.prefix}.100` }]);
    expect(report.grants).toEqual([{ device: "laptop", service: "db", access: "read-only" }]);
    // Each server is read on its own shell; the probe gave the privilege, the reads are audited.
    expect(new Set(w.commands.map((c) => c.host))).toEqual(new Set([APP_HOST, DATA_HOST]));
    const audit = w.deps.audit.entries;
    expect(audit.map((e: { target?: string }) => e.target)).toContain("server data");
    expect(JSON.stringify(audit)).not.toContain(DATA_HOST);
  });

  it("flags a service that should be published on the private address and isn't, with provision", async () => {
    const w = await splitWorld();
    const data = w.servers[DATA_HOST];
    if (data !== undefined) data.ports = "db|\n";
    const report = await componentStatusReport(w.deps, w.plan, {
      services: { remote: w.remote },
      network: w.network,
    });
    expect(report.lines.at(-1)).toBe(
      `  Warning: PostgreSQL (db) on server data is not published on its private address ${w.prefix}.2:5432, so the app can't reach it. Run \`opscrew provision\` to fix it.`,
    );
    expect(report.servers?.[1]?.unpublished).toEqual([
      { service: "db", port: 5432, address: `${w.prefix}.2` },
    ]);
  });

  it("names a server it cannot reach, and its links as not read", async () => {
    const w = await splitWorld();
    w.offline.add(DATA_HOST);
    const report = await componentStatusReport(w.deps, w.plan, {
      services: { remote: w.remote },
      network: w.network,
    });
    expect(report.lines).toContain("Components on server data (from opscrew/plan.yaml):");
    expect(report.lines).toContainEqual(
      expect.stringMatching(/^OpsCrew could not read server data\. /),
    );
    expect(report.lines).toContain(
      "  data to app: not read: OpsCrew could not reach server data over SSH",
    );
    expect(report.lines).toContainEqual(
      expect.stringMatching(/^ {2}Device laptop .*with server data not read$/),
    );
  });

  it("says when a server's login cannot become root to read the network", async () => {
    const w = await splitWorld();
    const data = w.servers[DATA_HOST];
    if (data !== undefined) data.privilege = "sudo-password";
    const report = await componentStatusReport(w.deps, w.plan, {
      services: { remote: w.remote },
      network: w.network,
    });
    expect(report.lines).toContain(
      "  data to app: not read: OpsCrew can't read the private network on server data without root (give its login passwordless sudo)",
    );
  });

  it("lists every server's planned components before the first deploy, and no network read", async () => {
    const w = await splitWorld();
    const { firstDeployAt: _f, ...deployment } = w.plan.deployment;
    const report = await componentStatusReport(
      w.deps,
      { ...w.plan, deployment },
      { services: { remote: w.remote }, network: w.network },
    );
    expect(report.lines).toEqual([
      "Components on server app (from opscrew/plan.yaml):",
      "  The web process (app)",
      "",
      "Components on server data (from opscrew/plan.yaml):",
      "  PostgreSQL (db)",
    ]);
    expect(w.commands).toEqual([]);
  });

  it("reads Docker through sudo on an own server whose login needs it, probed once", async () => {
    const w = await splitWorld({ data: "own" });
    const data = w.servers[DATA_HOST];
    if (data !== undefined) {
      data.privilege = "sudo";
      data.dockerThroughSudo = true;
    }
    const report = await componentStatusReport(w.deps, w.plan, {
      services: { remote: w.remote },
      network: w.network,
    });
    expect(report.lines).toContain("  PostgreSQL (db): running");
    expect(report.servers?.[1]?.unpublished).toEqual([]);
    const onData = w.commands.filter((c) => c.host === DATA_HOST).map((c) => c.command);
    expect(onData.filter((c) => c.includes("{{.Names}}|{{.State}}"))).toEqual([
      expect.stringMatching(/^sudo -n sh -c /),
    ]);
    // Once by `serverShell`, once by the network's read.
    expect(onData.filter((c) => c.includes("echo sudo-password"))).toHaveLength(2);
  });

  it("names an extra server's failed read with its own next step", async () => {
    const w = await splitWorld({ data: "own" });
    const data = w.servers[DATA_HOST];
    if (data !== undefined) data.dockerThroughSudo = true;
    const report = await componentStatusReport(w.deps, w.plan, {
      services: { remote: w.remote },
      network: w.network,
    });
    expect(report.lines).toContain(
      "OpsCrew could not read server data. OpsCrew could not read the app's containers on the server over SSH (exit code 1). Check that server data is on and that this computer reaches it over SSH, then run `opscrew status` again.",
    );
  });

  it("shows closed public SSH and no devices", async () => {
    const w = await splitWorld({
      network: (network) => ({ ...network, devices: [], publicSsh: false }),
    });
    const report = await componentStatusReport(w.deps, w.plan, {
      services: { remote: w.remote },
      network: w.network,
    });
    expect(report.lines.slice(-4)).toEqual([
      "  data to app: up, last handshake 10 seconds ago",
      "  Devices: none",
      "  Access to databases and caches: none",
      "  Public SSH: closed on every server (SSH answers only on the private network)",
    ]);
  });
});
