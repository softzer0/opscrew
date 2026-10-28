import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FakeWorkerFigures, FakeZone } from "@opscrew/connector-cloudflare/testing";
import { PortainerApiError, type PortainerClient } from "@opscrew/connector-portainer";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { shellQuote } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { recordOwnServer, recordPortainerConnection, recordServerAddress } from "../shared";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  fakeCertificate,
  fakeCloudflare,
  fakeSharedCloudflare,
  OWN_IPV4,
  ownPlan,
  ownRunner,
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerPlan,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import {
  INSPECT_FORMAT,
  type ResourceReading,
  readResources,
  resourceFlags,
  resourceLines,
  serverFiguresCommand,
} from "./resources";
import { componentStatusReport } from "./run";

/** `base`, deployed, with a worker. */
function withWorker(base: DeployPlan = testPlan({ deployed: true })): DeployPlan {
  return DeployPlanSchema.parse({
    ...base,
    deployment: { ...base.deployment, firstDeployAt: "2026-10-10T09:00:00.000Z" },
    processes: { workers: [{ name: "worker", command: "node worker.js", source: "procfile" }] },
  });
}

const MIB = 1024 ** 2;

/** A stats line as `docker stats --format '{{json .}}'` prints it. */
function stats(name: string, cpu: string, memory: string): string {
  return JSON.stringify({
    BlockIO: "0B / 0B",
    CPUPerc: cpu,
    Container: "0123456789ab",
    ID: "0123456789ab",
    MemPerc: "1.00%",
    MemUsage: memory,
    Name: name,
    NetIO: "1kB / 2kB",
    PIDs: "12",
  });
}

/**
 * The server command's output: 2 CPUs, 4 GB of memory, a disk 90% full, the web process at 95% of
 * its 512 MB limit, a worker that restarted twice, and a stray `Config.Env` value in its line.
 */
function serverOutput(secret: string): string {
  return [
    "==opscrew-figures:cpus",
    "2",
    "==opscrew-figures:load",
    "0.52 0.40 0.31 1/123 4567",
    "==opscrew-figures:memory",
    "               total        used        free      shared  buff/cache   available",
    "Mem:      4000000000  1500000000   500000000     1000000  2000000000  2400000000",
    "Swap:              0           0           0",
    "==opscrew-figures:disk",
    "Filesystem        1-blocks        Used   Available Capacity Mounted on",
    "/dev/sda1      40000000000 36000000000  4000000000      90% /",
    "==opscrew-figures:stats",
    stats("shop-app-1", "3.25%", "486.4MiB / 512MiB"),
    stats("shop-worker-1", "0.10%", "40MiB / 3.725GiB"),
    stats("shop-release-1", "0.00%", "0B / 0B"),
    "Error response from daemon: something unrelated",
    "==opscrew-figures:inspect",
    JSON.stringify({
      name: "/shop-app-1",
      restarts: 0,
      startedAt: "2026-10-11T09:59:59.123456789Z",
      memoryLimit: 512 * MIB,
    }),
    JSON.stringify({
      name: "/shop-worker-1",
      restarts: 2,
      startedAt: "2026-10-11T11:30:00Z",
      memoryLimit: 0,
      Env: [`DATABASE_PASSWORD=${secret}`],
    }),
    JSON.stringify({
      name: "/shop-release-1",
      restarts: 0,
      startedAt: "2026-10-11T09:00:00Z",
      memoryLimit: 0,
    }),
    "",
  ].join("\n");
}

/**
 * A shell on the server: the figures command gets `figures` (exiting with `exitCode`), `docker ps`
 * gets `ps`.
 */
function shell(figures: string, exitCode = 0, ps = "shop-app-1|running\nshop-worker-1|running\n") {
  const commands: string[] = [];
  const hosts: string[] = [];
  const run = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    return command.startsWith("docker ps -a")
      ? { exitCode: 0, stdout: ps, stderr: "" }
      : { exitCode, stdout: figures, stderr: "" };
  };
  const remote = (host: string): RemoteExec => {
    hosts.push(host);
    return { host, run };
  };
  return { remote, run, commands, hosts };
}

/** Phase deps that know the server's address and have the project's deploy key. */
async function serverDeps() {
  const deps = await createTestPhaseDeps();
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  return deps;
}

describe("the server command", () => {
  it("is fixed: the project's containers, and inspect with only four fields, never Config.Env", () => {
    const command = serverFiguresCommand("shop");
    for (const part of ["nproc", "cat /proc/loadavg", "free -b", "df -P -B1 /"]) {
      expect(command).toContain(part);
    }
    expect(command).toContain(
      "docker ps -aq --filter label=com.docker.compose.project=shop --filter label=com.docker.compose.oneoff=False",
    );
    expect(command).toContain("docker stats --no-stream --format '{{json .}}' $ids");
    expect(command).toContain(`docker inspect --format '${INSPECT_FORMAT}' $ids`);
    expect(INSPECT_FORMAT.match(/\{\{[^}]*\}\}/g)).toEqual([
      "{{json .Name}}",
      "{{.RestartCount}}",
      "{{json .State.StartedAt}}",
      "{{.HostConfig.Memory}}",
    ]);
    expect(command).not.toMatch(/Env|\.Config/);
  });

  it("refuses a project name that is not Compose's", () => {
    expect(() => serverFiguresCommand("shop; rm -rf /")).toThrow(/Not a Compose project name/);
    expect(() => serverFiguresCommand("$(id)")).toThrow();
  });
});

describe("readResources on a server OpsCrew created", () => {
  it("parses the command's answer with a container at 95% of its limit and a disk 90% full", async () => {
    const deps = await serverDeps();
    const plan = withWorker();
    const secret = fakeSecret("generic-password", "database-password");
    const ssh = shell(serverOutput(secret));

    const reading = await readResources(deps, plan, { services: { remote: ssh.remote } });

    expect(ssh.hosts).toEqual([SERVER_IPV4]);
    expect(ssh.commands).toEqual([serverFiguresCommand("shop")]);
    expect(reading.takenAt).toBe("2026-10-11T12:00:00.000Z");
    expect(reading.server).toEqual({
      cpus: 2,
      load1: 0.52,
      load5: 0.4,
      load15: 0.31,
      memory: { usedBytes: 1_600_000_000, totalBytes: 4_000_000_000 },
      disk: { usedBytes: 36_000_000_000, freeBytes: 4_000_000_000, totalBytes: 40_000_000_000 },
    });
    // The release one-shot and the unrelated line are left out.
    expect(reading.containers).toEqual([
      {
        service: "app",
        cpuPercent: 3.25,
        memory: { usedBytes: Math.round(486.4 * MIB), limitBytes: 512 * MIB },
        restarts: 0,
        startedAt: "2026-10-11T09:59:59.123456789Z",
      },
      {
        service: "worker",
        cpuPercent: 0.1,
        memory: { usedBytes: 40 * MIB },
        restarts: 2,
        startedAt: "2026-10-11T11:30:00Z",
      },
    ]);
    expect(reading.unavailable).toEqual([]);
    expect(reading.flags.map(({ figure, severity }) => [figure, severity])).toEqual([
      ["the server's disk", "warning"],
      ["the memory of the web process (app)", "warning"],
      ["the restarts of the worker (worker)", "warning"],
    ]);
    // No Config.Env value anywhere in the reading.
    expect(JSON.stringify(reading)).not.toContain(secret);
    expect(JSON.stringify(reading)).not.toContain("DATABASE_PASSWORD");
    // Audited without the address.
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        action: "read the server's and the app's figures (read-only)",
        target: "server",
      }),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(SERVER_IPV4);

    expect(resourceLines(plan, reading, new Date("2026-10-11T12:00:00.000Z"))).toEqual([
      "Resources (read now):",
      "  Server: load 0.52, 0.40, 0.31 (1, 5 and 15 minutes) on 2 CPUs; memory 1.5 GB used of 3.7 GB; disk 33.5 GB used, 3.7 GB free of 37.3 GB (90% full)",
      "  The web process (app): CPU 3.3%, memory 486 MB of 512 MB (95%), 0 restarts, started 2 hours ago",
      "  The worker (worker): CPU 0.1%, memory 40 MB (no limit), 2 restarts, started 30 minutes ago",
      "  Warning: The server's disk is 90% full (3.7 GB free). When it is full, the database and the app can no longer write, and deploys fail. Free space: old images (`docker image prune` as the deploy user) and logs usually fill it. Or give the server a bigger disk.",
      "  Warning: The web process (app) uses 95% of its 512 MB memory limit. At the limit, the system stops it and Docker starts it again. Raise its `memoryMb` in opscrew/plan.yaml and run `opscrew provision` (it shows the plan first), or find what in the app holds on to memory.",
      "  Warning: The worker (worker) restarted 2 times since the last deploy: it stopped (it crashed or ran out of memory) and Docker started it again. See why in its logs: `opscrew logs --service worker`.",
    ]);
  });

  it("names the server's figures as unavailable when their part of the answer is unreadable", async () => {
    const deps = await serverDeps();
    const ssh = shell("==opscrew-figures:cpus\nnproc: command not found\n");
    const reading = await readResources(deps, withWorker(), { services: { remote: ssh.remote } });
    expect(reading.server).toBeUndefined();
    expect(reading.containers).toEqual([]);
    expect(reading.unavailable).toEqual([
      "the server's load, memory and disk (OpsCrew could not read them from its answer)",
    ]);
  });

  it("a step that failed (exit 1) leaves the rest of the figures; ssh's 255 is an error", async () => {
    const deps = await serverDeps();
    const failed = shell(serverOutput(fakeSecret("generic-password", "database-password")), 1);
    const reading = await readResources(deps, withWorker(), {
      services: { remote: failed.remote },
    });
    expect(reading.server?.cpus).toBe(2);
    expect(reading.containers).toHaveLength(2);

    const unreachable = shell("", 255);
    await expect(
      readResources(deps, withWorker(), { services: { remote: unreachable.remote } }),
    ).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("the command runs in the C locale and ends with true", () => {
    const command = serverFiguresCommand("shop");
    expect(command.startsWith("export LC_ALL=C; ")).toBe(true);
    expect(command.endsWith("; true")).toBe(true);
  });
});

describe("readResources on a server the user owns", () => {
  it("runs the command over the admin login, as root where it can, audited without the address", async () => {
    const deps = await createTestPhaseDeps({ runner: ownRunner() });
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "alice",
      agent: true,
      reachable: true,
    });
    const admin = shell(serverOutput(fakeSecret("generic-password", "database-password")));
    const logins: string[] = [];
    const reading = await readResources(deps, withWorker(ownPlan({ deployed: true })), {
      hostKey: ED25519_FINGERPRINT,
      services: {
        own: {
          remote: (connection) => {
            logins.push(connection.user);
            return { host: connection.host, run: admin.run };
          },
        },
      },
    });

    expect(logins).toEqual(["alice"]);
    const command = shellQuote(serverFiguresCommand("shop"));
    // The login test, then the figures: as root, with sudo -n, or as the login.
    expect(admin.commands).toEqual([
      "true",
      `if [ "$(id -u)" = 0 ]; then sh -c ${command}; elif sudo -n true 2>/dev/null </dev/null; then sudo -n sh -c ${command}; else sh -c ${command}; fi`,
    ]);
    expect(reading.server?.disk?.usedBytes).toBe(36_000_000_000);
    expect(deps.audit.entries.at(-1)).toMatchObject({
      kind: "remote-exec",
      action: "read the server's and the app's figures (read-only)",
      target: "own server",
    });
    expect(JSON.stringify(deps.audit.entries)).not.toContain(OWN_IPV4);
  });
});

describe("resourceFlags", () => {
  const plan = withWorker();
  const server = (usedPercent: number) => ({
    cpus: 1,
    memory: { totalBytes: 1 },
    disk: {
      usedBytes: usedPercent * 1_000_000,
      freeBytes: (100 - usedPercent) * 1_000_000,
      totalBytes: 100_000_000,
    },
  });
  const flagsOf = (figures: Pick<ResourceReading, "server" | "containers">) =>
    resourceFlags(plan, { ...figures, unavailable: [] }).map((f) => [f.figure, f.severity]);

  it("the disk at 85% is a warning, at 95% high, below 85% nothing (secure's thresholds)", () => {
    expect(flagsOf({ server: server(84), containers: [] })).toEqual([]);
    expect(flagsOf({ server: server(85), containers: [] })).toEqual([
      ["the server's disk", "warning"],
    ]);
    expect(flagsOf({ server: server(95), containers: [] })).toEqual([
      ["the server's disk", "high"],
    ]);
  });

  it("memory at 90% of a limit is a warning; without a limit, or below, nothing", () => {
    const container = (usedBytes: number, limitBytes?: number) => ({
      service: "app",
      cpuPercent: 1,
      memory: { usedBytes, ...(limitBytes !== undefined ? { limitBytes } : {}) },
      restarts: 0,
      startedAt: "2026-10-11T10:00:00Z",
    });
    expect(flagsOf({ containers: [container(89, 100), container(500)] })).toEqual([]);
    expect(flagsOf({ containers: [container(90, 100)] })).toEqual([
      ["the memory of the web process (app)", "warning"],
    ]);
  });

  it("the cron jobs' memory fix names app.memoryMb, a worker's its own memoryMb", () => {
    const cron = DeployPlanSchema.parse({
      ...plan,
      processes: {
        ...plan.processes,
        cron: [{ name: "cleanup", schedule: "0 3 * * *", command: "node cleanup.js" }],
      },
    });
    const full = (service: string) => ({
      service,
      cpuPercent: 1,
      memory: { usedBytes: 95, limitBytes: 100 },
      restarts: 0,
      startedAt: "2026-10-11T10:00:00Z",
    });
    const [cronFlag, workerFlag] = resourceFlags(cron, {
      containers: [full("cron"), full("worker")],
      unavailable: [],
    });
    expect(cronFlag?.fix).toMatch(
      /^Raise `app\.memoryMb` \(the cron jobs run with the web process's memory\) in opscrew\/plan\.yaml/,
    );
    expect(workerFlag?.fix).toMatch(/^Raise its `memoryMb` in opscrew\/plan\.yaml/);
  });
});

describe("readResources in the user's Portainer", () => {
  /**
   * Phase deps with a recorded Portainer, and a client whose token's user cannot read the worker
   * and sees no database; `dockerInfo` answers Docker's totals by default.
   */
  async function portainer(
    dockerInfo = async () => ({ swarmActive: false, cpus: 4, memoryBytes: 8 * 1024 * MIB }),
  ) {
    const token = fakeSecret("generic-password", "portainer-token");
    const deps = await createTestPhaseDeps({
      env: { OPSCREW_HOME: join(await mkdtemp(join(tmpdir(), "opscrew-figures-")), "home") },
    });
    deps.env.PORTAINER_API_KEY = token;
    await recordPortainerConnection(deps.paths, {
      url: PORTAINER_URL,
      certFingerprint: fakeCertificate().fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
    });
    const read: string[] = [];
    const client = () =>
      ({
        listContainers: async () => [
          { id: "c-app", project: "opscrew-shop", service: "app", running: true },
          { id: "c-worker", project: "opscrew-shop", service: "worker", running: true },
          { id: "c-tunnel", project: "opscrew-shop", service: "cloudflared", running: true },
          { id: "c-other", project: "media", service: "app", running: true },
        ],
        dockerInfo,
        containerStats: async (_env: number, id: string) => {
          read.push(`stats ${id}`);
          return { cpuPercent: 12.5, memoryUsedBytes: 100 * MIB };
        },
        containerInspect: async (_env: number, id: string) => {
          read.push(`inspect ${id}`);
          if (id === "c-worker") {
            throw new PortainerApiError(
              "PROVIDER_ERROR",
              403,
              "Portainer refused.",
              "Use another.",
            );
          }
          return {
            restartCount: 1,
            startedAt: "2026-10-11T11:00:00Z",
            memoryLimitBytes: 512 * MIB,
          };
        },
      }) as unknown as PortainerClient;
    return { deps, client, read };
  }

  it("Docker's /info failing leaves the containers' figures, and names the totals", async () => {
    const { deps, client } = await portainer(async () => {
      throw new PortainerApiError("PROVIDER_ERROR", 500, "Portainer failed.", "Try again.");
    });
    const reading = await readResources(deps, withWorker(portainerPlan({ deployed: true })), {
      services: { portainer: { client } },
    });
    expect(reading.server).toBeUndefined();
    expect(reading.containers.map((c) => c.service)).toEqual(["app"]);
    expect(reading.unavailable[0]).toBe(
      "the host's CPUs, memory, load and disk (Portainer did not give Docker's figures for them)",
    );
  });

  it("reads each container through Portainer, with the host's disk not available", async () => {
    const { deps, client, read } = await portainer();
    const reading = await readResources(deps, withWorker(portainerPlan({ deployed: true })), {
      services: { portainer: { client } },
    });

    expect(read.sort()).toEqual([
      "inspect c-app",
      "inspect c-worker",
      "stats c-app",
      "stats c-worker",
    ]);
    expect(reading.server).toEqual({ cpus: 4, memory: { totalBytes: 8 * 1024 * MIB } });
    expect(reading.containers).toEqual([
      {
        service: "app",
        cpuPercent: 12.5,
        memory: { usedBytes: 100 * MIB, limitBytes: 512 * MIB },
        restarts: 1,
        startedAt: "2026-10-11T11:00:00Z",
      },
    ]);
    // The worker the token's user cannot read, and the database it cannot see, are named as not
    // visible to that user, never as absent.
    expect(reading.unavailable).toEqual([
      "the host's load, memory in use and disk (Docker's API through Portainer does not give them)",
      "the figures of db and worker: no container of theirs is visible to the token's user (a standard user's token sees only that user's own stacks; use an administrator's token, or the token of the user who deployed the stack, as PORTAINER_API_KEY)",
    ]);
    expect(reading.flags.map((f) => f.figure)).toEqual(["the restarts of the web process (app)"]);
    expect(JSON.stringify(reading)).not.toContain(PORTAINER_HOST);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({ kind: "provider-call", target: "portainer" }),
    ]);
  });
});

describe("readResources on this computer", () => {
  it("reads the Compose project's containers and docker info's totals through the runner", async () => {
    const secret = fakeSecret("generic-password", "local-password");
    const runner = new ScriptedRunner((command, args) => {
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (command !== "docker") return ok("");
      if (args[0] === "ps") {
        return ok("opscrew-shop-app-1|app\nopscrew-shop-release-1|release\n");
      }
      if (args[0] === "stats")
        return ok(`${stats("opscrew-shop-app-1", "1.50%", "64MiB / 512MiB")}\n`);
      if (args[0] === "inspect") {
        return ok(
          `${JSON.stringify({ name: "/opscrew-shop-app-1", restarts: 0, startedAt: "2026-10-11T11:59:30Z", memoryLimit: 512 * MIB, Config: { Env: [`X=${secret}`] } })}\n`,
        );
      }
      if (args[0] === "info") return ok('{"cpus":8,"memoryBytes":8589934592}\n');
      return ok("");
    });
    const deps = await createTestPhaseDeps({ runner });

    const reading = await readResources(deps, localPlan());

    expect(runner.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "ps -a",
      "stats --no-stream",
      "inspect --format",
      "info --format",
    ]);
    expect(runner.calls[1]?.args.at(-1)).toBe("opscrew-shop-app-1");
    expect(reading.server).toEqual({ cpus: 8, memory: { totalBytes: 8589934592 } });
    expect(reading.containers).toEqual([
      {
        service: "app",
        cpuPercent: 1.5,
        memory: { usedBytes: 64 * MIB, limitBytes: 512 * MIB },
        restarts: 0,
        startedAt: "2026-10-11T11:59:30Z",
      },
    ]);
    expect(reading.unavailable).toEqual([
      "this computer's load, memory in use and disk (OpsCrew reads only Docker's figures here)",
    ]);
    expect(JSON.stringify(reading)).not.toContain(secret);
    expect(resourceLines(localPlan(), reading, new Date("2026-10-11T12:00:00.000Z"))).toEqual([
      "Resources (read now):",
      "  Server: 8 CPUs; memory 8.0 GB",
      "  The web process (app): CPU 1.5%, memory 64 MB of 512 MB (13%), 0 restarts, started less than a minute ago",
      "  Not available: this computer's load, memory in use and disk (OpsCrew reads only Docker's figures here)",
    ]);
  });
});

describe("readResources on the server-less targets", () => {
  /** Deps with a Cloudflare token, and the account's Worker `example-app` with `figures`. */
  async function cloudflare(figures?: FakeWorkerFigures) {
    const zone = new FakeZone();
    if (figures !== undefined) zone.figures.set("example-app", figures);
    const deps = await createTestPhaseDeps();
    deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "status-figures");
    const services = { cloudflare: fakeCloudflare(), sharedCloudflare: fakeSharedCloudflare(zone) };
    return { zone, deps, services };
  }

  it("a server-rendered app on Cloudflare: the Worker's last 24 hours against Workers Free", async () => {
    const { zone, deps, services } = await cloudflare({
      requests: 12_345,
      errors: 7,
      cpuTimeP50: 1_250,
      cpuTimeP99: 8_400,
    });
    const plan = sitePlan({ render: "ssr", deployed: true });

    const reading = await readResources(deps, plan, { services });

    expect(reading).toEqual({
      takenAt: "2026-10-11T12:00:00.000Z",
      containers: [],
      edgeRequests: {
        since: "2026-10-10T12:00:00.000Z",
        requests: 12_345,
        errors: 7,
        cpuTimeP50Ms: 1.25,
        cpuTimeP99Ms: 8.4,
      },
      unavailable: [],
      flags: [],
    });
    const query = zone.calls.find((call) => call.path === "/graphql");
    expect(query?.body).toMatchObject({
      variables: { since: "2026-10-10T12:00:00.000Z", worker: "example-app" },
    });
    expect(resourceLines(plan, reading, new Date("2026-10-11T12:00:00.000Z"))).toEqual([
      "Resources (read now):",
      "  The Worker (last 24 hours): 12,345 requests (12% of Workers Free's 100,000 a day), 7 errors; CPU time per request 1.3 ms median and 8.4 ms at the 99th percentile (Workers Free allows 10 ms)",
      "  Requests served from the site's files run no code, so they are not counted. Errors are only the exceptions the Worker threw, not its 4xx or 5xx answers. The figures lag about a minute.",
    ]);
  });

  it("a static site on Cloudflare runs no code, so it has no figures and says so", async () => {
    const { zone, deps, services } = await cloudflare();
    const reading = await readResources(deps, sitePlan({ deployed: true }), { services });
    expect(reading.edgeRequests).toBeUndefined();
    expect(reading.unavailable).toEqual([
      "request figures (Cloudflare serves the site's files without running any code, so it counts no requests)",
    ]);
    expect(zone.calls).toEqual([]);
  });

  it("names the permission when Cloudflare refuses the figures, under the site's lines", async () => {
    const { zone, deps, services } = await cloudflare();
    zone.denied.add("analytics");
    const report = await componentStatusReport(deps, sitePlan({ render: "ssr", deployed: true }), {
      services,
    });
    expect(report.resources).toBeUndefined();
    expect(report.lines.at(-1)).toMatch(
      /^OpsCrew could not read the resource figures\. Cloudflare refused the request to read the figures of the Worker example-app: .*Workers Scripts → Edit/,
    );
  });

  it("GitHub Pages has none, and says so", async () => {
    const deps = await createTestPhaseDeps();
    const reading = await readResources(deps, sitePlan({ provider: "github-pages" }));
    expect(reading.server).toBeUndefined();
    expect(reading.unavailable).toEqual([
      "resource figures (GitHub Pages serves the site's files without running any code, so there are none)",
    ]);
  });
});

describe("componentStatusReport with the figures", () => {
  it("adds the figures after the components and returns the reading", async () => {
    const deps = await serverDeps();
    const plan = withWorker();
    const ssh = shell(serverOutput(fakeSecret("generic-password", "database-password")));

    const report = await componentStatusReport(deps, plan, { services: { remote: ssh.remote } });

    expect(report.lines.slice(0, 7)).toEqual([
      "Components:",
      "  The web process (app): running",
      "  The worker (worker): running",
      "  PostgreSQL (db): no container",
      "",
      "Resources (read now):",
      expect.stringMatching(/^ {2}Server: load 0\.52/),
    ]);
    expect(report.resources?.containers.map((c) => c.service)).toEqual(["app", "worker"]);
    expect(report.check).toBeUndefined();
  });

  it("a figures read that fails leaves a note under the components", async () => {
    const deps = await serverDeps();
    const remote = (host: string): RemoteExec => ({
      host,
      run: async (command) =>
        command.startsWith("docker ps -a")
          ? { exitCode: 0, stdout: "shop-app-1|running\n", stderr: "" }
          : { exitCode: 255, stdout: "", stderr: "" },
    });
    const report = await componentStatusReport(deps, withWorker(), { services: { remote } });
    expect(report.lines.slice(-2)).toEqual([
      "",
      expect.stringMatching(
        /^OpsCrew could not read the resource figures\. OpsCrew could not read the server's figures over SSH \(exit code 255\)\. Check that the server is on/,
      ),
    ]);
    expect(report.status).toBeDefined();
    expect(report.resources).toBeUndefined();
  });
});
