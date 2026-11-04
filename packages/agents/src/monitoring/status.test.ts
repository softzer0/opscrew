/** Monitoring's status, open, verify, secure and drift, against fake servers. */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import { renderAlloyCompose, renderMonitoringStack } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { addonOpen, addonStatus } from "../addons/status";
import {
  alloyDifferences,
  monitoringDrift,
  monitoringStackInput,
  stackDifferences,
} from "../drift/monitoring";
import { monitoredPlan, senderPlan, withNetwork } from "../network/__fixtures__/plans";
import { allocateNetwork, type NetworkHostFacts } from "../network/allocate";
import { monitoringSecurityChecks } from "../secure/monitoring";
import { servicePorts } from "../secure/services";
import { generatedValuesFile } from "../shared/app-secrets";
import { updateServerAddresses } from "../shared/server-record";
import { monitoringStatusReport } from "../status/monitoring";
import {
  createTestPhaseDeps,
  freshFacts,
  type ScriptedRunner,
  type TestPhaseDeps,
  testKeyMaker,
} from "../testing";
import { monitoringChecks } from "../verify/monitoring";
import { MONITORING_STATUS_COMMAND, monitoringStatus } from "./status";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const SECONDS = NOW.getTime() / 1000;
/** Public addresses: none may appear in any output. */
const IPS = {
  app: "203.0.113.10",
  data: "203.0.113.20",
  monitoring: "203.0.113.30",
  stagingApp: "203.0.113.11",
  stagingData: "203.0.113.21",
};
const SHARED_FACTS: Record<string, NetworkHostFacts> = {
  monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
};

/** `plan` on its private network (with a laptop when `devices`), deployed and seen running. */
function onNetwork(
  plan: Omit<DeployPlan, "network">,
  options: {
    facts?: Record<string, NetworkHostFacts>;
    devices?: boolean;
    publicSsh?: boolean;
  } = {},
): DeployPlan {
  const keys = testKeyMaker(plan.app.name);
  const { network } = allocateNetwork(plan, options.facts ?? {}, keys);
  const prefix = network.range.split(".").slice(0, 3).join(".");
  const full = withNetwork(plan, {
    ...network,
    devices: options.devices
      ? [
          {
            name: "laptop",
            address: `${prefix}.100`,
            publicKey: keys().publicKey,
            addedAt: "2026-11-01T10:00:00.000Z",
          },
        ]
      : [],
    ...(options.publicSsh === false
      ? { publicSsh: false, publicSshAllowedCidrs: ["0.0.0.0/0"] }
      : {}),
  });
  return DeployPlanSchema.parse({
    ...full,
    ...(options.publicSsh === false ? { security: { ...full.security, sshAllowedCidrs: [] } } : {}),
    deployment: {
      ...full.deployment,
      lastApplyAt: "2026-11-01T09:00:00.000Z",
      firstDeployAt: "2026-11-01T09:30:00.000Z",
    },
  });
}

function address(plan: DeployPlan, name: string): string {
  const member = plan.network?.members.find((m) => m.name === name);
  if (member === undefined) throw new Error(name);
  return member.address;
}

/** Prometheus's answer: each `[app, env, server]` with its last figures `ago` seconds before now. */
function figuresAnswer(rows: [string, string, string, number][]): string {
  return JSON.stringify({
    status: "success",
    data: {
      resultType: "vector",
      result: rows.map(([app, env, server, ago]) => ({
        metric: { app, env, server },
        value: [SECONDS, String(SECONDS - ago)],
      })),
    },
  });
}

/** Loki's answer: each `[app, env, server]` with lines in the minute `ago` seconds before now. */
function logsAnswer(rows: [string, string, string, number][]): string {
  return JSON.stringify({
    status: "success",
    data: {
      resultType: "matrix",
      result: rows.map(([app, env, server, ago]) => ({
        metric: { app, env, server },
        values: [
          [SECONDS - ago - 600, "3"],
          [SECONDS - ago, "12"],
        ],
      })),
    },
  });
}

/** What the stack's server answers: every container up, staging's app server silent. */
function stackAnswer(options: { figures?: string; logs?: string } = {}): string {
  return [
    "==opscrew-monitoring:containers",
    "opscrew-monitoring-prometheus-1|running|Up 2 hours (healthy)",
    "opscrew-monitoring-loki-1|running|Up 2 hours",
    "opscrew-monitoring-grafana-1|running|Up 2 hours (healthy)",
    "opscrew-monitoring-front-1|running|Up 2 hours (healthy)",
    "shop-app-1|running|Up 2 hours",
    "==opscrew-monitoring:memory",
    "opscrew-monitoring-prometheus-1|120.5MiB / 512MiB",
    "opscrew-monitoring-loki-1|98MiB / 384MiB",
    "opscrew-monitoring-grafana-1|210MiB / 384MiB",
    "opscrew-monitoring-front-1|12MiB / 64MiB",
    "==opscrew-monitoring:figures",
    options.figures ??
      figuresAnswer([
        ["shop", "prod", "app", 20],
        ["shop", "prod", "data", 15],
        ["shop", "prod", "monitoring", 10],
        ["shop-staging", "staging", "app", 900],
        ["shop-staging", "staging", "data", 30],
        ["old", "prod", "app", 5],
      ]),
    "",
    "==opscrew-monitoring:logs",
    options.logs ??
      logsAnswer([
        ["shop", "prod", "app", 60],
        ["shop-staging", "staging", "app", 1200],
      ]),
    "",
    "==opscrew-monitoring:disk",
    "1048576\t/v/prometheus",
    "2048\t/v/loki",
    "",
  ].join("\n");
}

/** Shells on fake servers by address, recording each command; only the stack's server answers. */
function fakeServers(stackHost: string, stdout: string) {
  const commands: { host: string; command: string }[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    async run(command): Promise<CommandResult> {
      commands.push({ host, command });
      if (host === stackHost && command === MONITORING_STATUS_COMMAND) {
        return { exitCode: 0, stdout, stderr: "" };
      }
      return { exitCode: 255, stdout: "", stderr: "ssh: connect to host: Connection timed out" };
    },
  });
  return { remote, commands };
}

/** Prod owning its monitoring server, and staging sending to it, in one repository. */
async function repository(options: { devices?: boolean; publicSsh?: boolean } = {}) {
  const prod = await createTestPhaseDeps({ clock: { now: () => NOW } });
  const owner = onNetwork(monitoredPlan(), options);
  await writeArtifact("plan", prod.paths.files.plan, owner);
  await updateServerAddresses(prod.paths, (current) => ({
    ...current,
    deployment: { ipv4: IPS.app },
    servers: { data: { ipv4: IPS.data }, monitoring: { ipv4: IPS.monitoring } },
  }));
  const staging = await createTestPhaseDeps({
    clock: { now: () => NOW },
    root: prod.paths.root,
    environment: "staging",
  });
  const sender = onNetwork(senderPlan(), { facts: SHARED_FACTS });
  await writeArtifact("plan", staging.paths.files.plan, sender);
  await updateServerAddresses(staging.paths, (current) => ({
    ...current,
    deployment: { ipv4: IPS.stagingApp },
    servers: { data: { ipv4: IPS.stagingData } },
  }));
  // Grafana's password, as provision keeps it with the owner's generated values.
  const password = randomBytes(16).toString("hex");
  const values = generatedValuesFile(prod);
  await mkdir(dirname(values), { recursive: true });
  await writeFile(values, JSON.stringify({ monitoring: { grafanaAdminPassword: password } }));
  return { prod, owner, staging, sender, password };
}

/** Nothing secret or public in what `deps` printed and audited. */
function expectNoLeak(deps: TestPhaseDeps, ...more: string[]) {
  const said = [deps.reporter.text(), JSON.stringify(deps.audit.entries), ...more].join("\n");
  for (const ip of Object.values(IPS)) expect(said).not.toContain(ip);
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("monitoringStatus", () => {
  it("reads the owner's stack with one fixed read-only command, every answer parsed", async () => {
    const r = await repository();
    const servers = fakeServers(IPS.monitoring, stackAnswer());
    const reading = await monitoringStatus(r.prod, r.owner, { remote: servers.remote });
    expect(servers.commands).toEqual([
      { host: IPS.monitoring, command: MONITORING_STATUS_COMMAND },
    ]);
    expect(MONITORING_STATUS_COMMAND).toContain(
      "docker ps -a --filter label=com.docker.compose.project=opscrew-monitoring",
    );
    expect(MONITORING_STATUS_COMMAND).toContain(
      "query=max%20by%20(app%2C%20env%2C%20server)%20(timestamp(node_load1))",
    );
    expect(reading.stack).toEqual({ app: "shop", env: "prod", server: "monitoring" });
    expect(reading.containers).toEqual([
      {
        name: "opscrew-monitoring-prometheus-1",
        running: true,
        memory: "120.5MiB / 512MiB",
        healthy: true,
      },
      { name: "opscrew-monitoring-loki-1", running: true, memory: "98MiB / 384MiB" },
      {
        name: "opscrew-monitoring-grafana-1",
        running: true,
        memory: "210MiB / 384MiB",
        healthy: true,
      },
      { name: "opscrew-monitoring-front-1", running: true, memory: "12MiB / 64MiB", healthy: true },
    ]);
    // Every server of both environments, in repository order; a series of no plan is left out.
    expect(reading.servers).toEqual([
      {
        app: "shop",
        env: "prod",
        server: "app",
        lastFigures: "2026-11-04T11:59:40.000Z",
        lastLog: "2026-11-04T11:59:00.000Z",
        silent: false,
      },
      {
        app: "shop",
        env: "prod",
        server: "data",
        lastFigures: "2026-11-04T11:59:45.000Z",
        silent: false,
      },
      {
        app: "shop",
        env: "prod",
        server: "monitoring",
        lastFigures: "2026-11-04T11:59:50.000Z",
        silent: false,
      },
      {
        app: "shop-staging",
        env: "staging",
        server: "app",
        lastFigures: "2026-11-04T11:45:00.000Z",
        lastLog: "2026-11-04T11:40:00.000Z",
        silent: true,
      },
      {
        app: "shop-staging",
        env: "staging",
        server: "data",
        lastFigures: "2026-11-04T11:59:30.000Z",
        silent: false,
      },
    ]);
    expect(reading.disk).toEqual({ figuresBytes: 1024 ** 3, logsBytes: 2 * 1024 ** 2 });
    expect(reading.retention).toEqual({ metricsDays: 15, logsDays: 7, metricsMaxGb: 24 });
    expect(reading.unanswered).toEqual([]);
    expect(r.prod.audit.entries).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        target: "server monitoring",
        decision: "allow",
      }),
    ]);
    expectNoLeak(r.prod);
  });

  it("a sender reads its owner's stack with the owner's login", async () => {
    const r = await repository();
    const servers = fakeServers(IPS.monitoring, stackAnswer());
    const reading = await monitoringStatus(r.staging, r.sender, { remote: servers.remote });
    expect(servers.commands.map((c) => c.host)).toEqual([IPS.monitoring]);
    expect(reading.stack).toEqual({ app: "shop", env: "prod", server: "monitoring" });
    expect(reading.servers.filter((s) => s.silent).map((s) => s.server)).toEqual(["app"]);
    expectNoLeak(r.staging);
  });

  it("flags nothing silent when Prometheus does not answer, and says so", async () => {
    const r = await repository();
    const servers = fakeServers(IPS.monitoring, stackAnswer({ figures: "", logs: "not json" }));
    const reading = await monitoringStatus(r.prod, r.owner, { remote: servers.remote });
    expect(reading.unanswered).toEqual(["figures", "logs"]);
    expect(reading.servers.every((s) => !s.silent && s.lastFigures === undefined)).toBe(true);
  });

  it("refuses with monitoring off, and fails plainly when the server is out of reach", async () => {
    const r = await repository();
    const monitoring = r.owner.observability?.monitoring;
    const plan = { ...r.owner, observability: { monitoring: { ...monitoring, enabled: false } } };
    const off = await failure(monitoringStatus(r.prod, plan as DeployPlan));
    expect(off.message).toBe("Self-hosted monitoring is off for this app.");
    const down = fakeServers("nowhere", "");
    const error = await failure(monitoringStatus(r.prod, r.owner, { remote: down.remote }));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.hint).toContain("keeps its figures for up to 8 hours");
  });
});

describe("addon status and status", () => {
  it("addon status shows the stack, the disk, the retention and each server, the silent one with what to check", async () => {
    const r = await repository();
    const servers = fakeServers(IPS.monitoring, stackAnswer());
    const status = await addonStatus(r.prod, r.owner, {
      services: { deployRemote: servers.remote },
    });
    expect(status.monitoring?.reading?.servers).toHaveLength(5);
    const text = r.prod.reporter.text();
    expect(text).toContain(
      "Self-hosted monitoring: Prometheus 3.15.1, Loki 3.7.9 and Grafana 13.3.0 run on server monitoring",
    );
    expect(text).toContain(
      "opscrew-monitoring-grafana-1: running, healthy, memory 210MiB / 384MiB",
    );
    expect(text).toContain("Kept: figures 15 days (at most 24 GB), logs 7 days.");
    expect(text).toContain("Disk: figures 1.0 GB, logs 2.0 MB.");
    expect(text).toContain(
      "server app of shop (prod): figures 20 seconds ago, last log line 1 minute ago",
    );
    expect(text).toContain(
      "server data of shop (prod): figures 15 seconds ago, no log line in the last hour",
    );
    expect(text).toContain(
      "server app of shop-staging (staging): nothing has arrived for more than 5 minutes. Check its agent, Grafana Alloy (the opscrew-alloy containers on that server), and its link on the private network",
    );
    expect(text).toContain(
      "server monitoring of shop (prod): figures 10 seconds ago, no log line in the last hour",
    );
    expectNoLeak(r.prod, JSON.stringify(status));
  });

  it("addon status says why the stack was not read, and what the agents keep meanwhile", async () => {
    const r = await repository();
    const down = fakeServers("nowhere", "");
    const status = await addonStatus(r.prod, r.owner, { services: { deployRemote: down.remote } });
    expect(status.monitoring?.reading).toBeUndefined();
    expect(status.monitoring?.note).toContain("OpsCrew could not read the monitoring stack.");
    expect(r.prod.reporter.text()).toContain("log lines for about 20 minutes");
    expectNoLeak(r.prod);
  });

  it("status has one line for the environment: its servers sending, or which are silent", async () => {
    const r = await repository();
    const servers = fakeServers(IPS.monitoring, stackAnswer());
    const prod = await monitoringStatusReport(r.prod, r.owner, { remote: servers.remote });
    expect(prod.lines).toEqual([
      "Monitoring: 3 servers sending to the monitoring stack on server monitoring, each within the last 5 minutes.",
    ]);
    const staging = await monitoringStatusReport(r.staging, r.sender, { remote: servers.remote });
    expect(staging.lines).toEqual([
      "Monitoring: server app sent nothing to the monitoring stack on server monitoring of shop (prod) for more than 5 minutes. Check its agent, Grafana Alloy, and its link on the private network; `opscrew addon status` says more.",
    ]);
    expectNoLeak(r.staging);
  });
});

describe("addon open monitoring", () => {
  it("this computer as a device: Grafana's private address and where the password is, no tunnel", async () => {
    const r = await repository({ devices: true });
    await updateServerAddresses(r.prod.paths, (current) => ({ ...current, thisDevice: "laptop" }));
    await addonOpen(r.prod, r.owner, "monitoring");
    const text = r.prod.reporter.text();
    expect(text).toContain(
      `This computer is device laptop on the app's private network: with its WireGuard tunnel on, Grafana is at http://${address(r.owner, "monitoring")}:${MONITORING_GRAFANA_PORT}, with no SSH tunnel.`,
    );
    expect(text).toContain(`monitoring.grafanaAdminPassword in ${generatedValuesFile(r.prod)}`);
    expect(text).toContain("recovery copy");
    expect((r.prod.runner as ScriptedRunner).calls).toEqual([]);
    expect(text).not.toContain(r.password);
    expectNoLeak(r.prod);
  });

  it("otherwise the SSH tunnel to Grafana on the stack's server, the owner's for a sender", async () => {
    const r = await repository();
    await addonOpen(r.staging, r.sender, "monitoring", { port: 3300 });
    const runner = r.staging.runner as ScriptedRunner;
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      [
        "ssh",
        [
          "-i",
          r.prod.paths.files.deployKey,
          "-o",
          `UserKnownHostsFile=${r.prod.paths.files.knownHosts}`,
          "-N",
          "-L",
          `3300:127.0.0.1:${MONITORING_GRAFANA_PORT}`,
          `deploy@${IPS.monitoring}`,
        ],
      ],
    ]);
    const text = r.staging.reporter.text();
    expect(text).toContain("Grafana is at http://localhost:3300 while this runs");
    expect(text).toContain(generatedValuesFile(r.prod));
    expect(text).not.toContain(r.password);
    expectNoLeak(r.staging);
  });

  it("with public SSH closed and no device, refuses with the command that adds this computer", async () => {
    const r = await repository({ publicSsh: false });
    const error = await failure(addonOpen(r.prod, r.owner, "monitoring"));
    expect(error.message).toBe(
      "Public SSH to server monitoring is closed and this computer is not a device on the app's private network, so OpsCrew can't reach Grafana from here. Nothing was changed.",
    );
    expect(error.hint).toContain("`opscrew vpn add <name> --env prod --this-computer`");
    expect((r.prod.runner as ScriptedRunner).calls).toEqual([]);
  });
});

describe("verify", () => {
  it("passes with the stack healthy and every server's figures recent", async () => {
    const r = await repository();
    const servers = fakeServers(IPS.monitoring, stackAnswer());
    const checks = await monitoringChecks(r.prod, r.owner, { remote: servers.remote, flag: "" });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["monitoring-stack", "pass"],
      ["monitoring-data", "pass"],
    ]);
  });

  it("fails a stopped or unhealthy container, and this environment's silent server", async () => {
    const r = await repository();
    const answer = stackAnswer()
      .replace("loki-1|running|Up 2 hours", "loki-1|exited|Exited (1) 3 minutes ago")
      .replace("front-1|running|Up 2 hours (healthy)", "front-1|running|Up 2 hours (unhealthy)");
    const servers = fakeServers(IPS.monitoring, answer);
    const checks = await monitoringChecks(r.staging, r.sender, {
      remote: servers.remote,
      flag: " --env staging",
    });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["monitoring-stack", "fail"],
      ["monitoring-data", "fail"],
    ]);
    expect(checks[0]?.message).toBe(
      "The monitoring stack on server monitoring: loki is not running; opscrew-monitoring-front-1 is unhealthy.",
    );
    expect(checks[1]?.message).toContain(
      "Server app: nothing has arrived for more than 5 minutes.",
    );
    expect(checks[1]?.remediation).toContain("opscrew provision --env staging");
    expect(JSON.stringify(checks)).not.toContain("203.0.113.");
  });
});

describe("secure", () => {
  /** `docker ps`'s ports of the stack, and a fake of the network's filter. */
  function secureWorld(ports: string, rules: { port: number; sources: string[] }[] | undefined) {
    const remote = (host: string): RemoteExec => ({
      host,
      async run(command): Promise<CommandResult> {
        if (command.includes("com.docker.compose.project=opscrew-monitoring")) {
          return { exitCode: 0, stdout: ports, stderr: "" };
        }
        // The privilege probe: deploy reaches root through Docker.
        return { exitCode: 0, stdout: "docker\n", stderr: "" };
      },
    });
    return { remote, readNetworkFilter: async () => rules };
  }

  it("probes the stack's ports from outside on its server only", async () => {
    const r = await repository();
    expect(servicePorts(r.owner, "monitoring")).toMatchObject({
      [MONITORING_GRAFANA_PORT]: "Grafana",
      [MONITORING_PUSH_PORT]: "the monitoring stack's front",
    });
    expect(servicePorts(r.owner, "data")[MONITORING_PUSH_PORT]).toBeUndefined();
    expect(servicePorts(r.sender)[MONITORING_PUSH_PORT]).toBeUndefined();
  });

  it("passes Grafana and the front on private addresses with the filter's rules in place", async () => {
    const r = await repository({ devices: true });
    const own = address(r.owner, "monitoring");
    const laptop = r.owner.network?.devices[0]?.address as string;
    const others = [address(r.owner, "app"), address(r.owner, "data")];
    const world = secureWorld(
      `grafana|127.0.0.1:3000->3000/tcp, ${own}:3000->3000/tcp\nfront|${own}:9091->9091/tcp\n`,
      [
        { port: MONITORING_PUSH_PORT, sources: others },
        { port: MONITORING_GRAFANA_PORT, sources: [laptop] },
      ],
    );
    const checks = await monitoringSecurityChecks(r.prod, r.owner, world);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["monitoring-private", "pass"],
      ["monitoring-filter", "pass"],
    ]);
  });

  it("fails a public binding and a filter that admits a server to Grafana, never naming a public address", async () => {
    const r = await repository({ devices: true });
    const own = address(r.owner, "monitoring");
    const world = secureWorld(
      `grafana|0.0.0.0:3000->3000/tcp\nfront|${IPS.monitoring}:9091->9091/tcp\n`,
      [{ port: MONITORING_GRAFANA_PORT, sources: [address(r.owner, "app")] }],
    );
    const checks = await monitoringSecurityChecks(r.prod, r.owner, world);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["monitoring-private", "fail"],
      ["monitoring-filter", "fail"],
    ]);
    expect(checks[0]?.message).toBe(
      "On server monitoring, Grafana is published on every address (0.0.0.0) (port 3000) and the stack's front (the servers' push paths) is published on a public address (port 9091), so the stack can be reached outside the private network.",
    );
    expect(checks[1]?.message).toContain("it has no rule for the stack's front");
    expect(checks[1]?.message).toContain(
      `it also admits server app (${address(r.owner, "app")}) to Grafana`,
    );
    expect(JSON.stringify(checks)).not.toContain(IPS.monitoring);
    expect(own).toMatch(/^10\./);
  });

  it("fails Prometheus or Loki published anywhere, and a missing filter in one message", async () => {
    const r = await repository({ devices: true });
    const own = address(r.owner, "monitoring");
    const world = secureWorld(
      `grafana|127.0.0.1:3000->3000/tcp\nprometheus|${own}:9090->9090/tcp\nloki|127.0.0.1:3100->3100/tcp\n`,
      undefined,
    );
    const checks = await monitoringSecurityChecks(r.prod, r.owner, world);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["monitoring-private", "fail"],
      ["monitoring-filter", "fail"],
    ]);
    expect(checks[0]?.message).toBe(
      `On server monitoring, Prometheus (its query API) is published on ${own} (port 9090) and Loki (its query API) is published on 127.0.0.1 (port 3100), so the stack can be reached outside the private network.`,
    );
    expect(checks[1]?.message).toBe(
      "On server monitoring, the filter on wg-opscrew0 is missing, so any address on the private network can reach Grafana and the front.",
    );
  });
});

describe("drift", () => {
  /** The facts of a server with Alloy as provision sets it up, and the stack when `input` is given. */
  function facts(
    plan: DeployPlan,
    server: string,
    input?: ReturnType<typeof monitoringStackInput>,
  ): HostFacts {
    const destinations = { monitoring: { address: "front" } };
    const compose = renderAlloyCompose(plan, server, destinations);
    return HostFactsSchema.parse({
      ...freshFacts({ user: "deploy", privilege: "docker" }),
      wireguardInterfaces: ["wg-opscrew0", "wg-opscrew1"],
      addons: {
        beszel: {
          installed: false,
          composeSha256: null,
          running: false,
          secretFile: false,
          dataVolume: false,
          tunnelId: null,
        },
        alloy: {
          installed: true,
          composeSha256: sha256Hex(compose),
          running: true,
          secretFile: true,
          dataVolume: false,
          tunnelId: null,
        },
        monitoring: {
          installed: false,
          composeSha256: null,
          running: false,
          secretFile: false,
          dataVolume: false,
          tunnelId: null,
        },
      },
      alloy: { destinations: ["monitoring"] },
      ...(input === undefined
        ? {}
        : {
            monitoring: {
              containers: ["prometheus", "loki", "grafana", "front"].map((s) => ({
                name: `opscrew-monitoring-${s}-1`,
                running: true,
              })),
              files: Object.fromEntries(
                renderMonitoringStack(input).map((file) => [file.path, sha256Hex(file.content)]),
              ),
            },
          }),
    });
  }

  it("finds nothing on servers as provision sets them up, the stack with the senders on its server", async () => {
    const r = await repository();
    const input = monitoringStackInput(r.owner, [r.sender]);
    expect(input.networks.map((n) => n.address)).toEqual([
      address(r.owner, "monitoring"),
      address(r.sender, "monitoring"),
    ]);
    const byHost: Record<string, HostFacts> = {
      [IPS.app]: facts(r.owner, "app"),
      [IPS.data]: facts(r.owner, "data"),
      [IPS.monitoring]: facts(r.owner, "monitoring", input),
    };
    const notes: string[] = [];
    const differences = await monitoringDrift(r.prod, r.owner, notes, {
      services: {
        remote: (host) => ({ host, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
      },
      inspect: async (remote) => byHost[remote.host] as HostFacts,
    });
    expect(notes).toEqual([]);
    expect(differences).toEqual([]);
  });

  it("names each server's Alloy and the stack's files and containers that differ", async () => {
    const r = await repository();
    const input = monitoringStackInput(r.owner, [r.sender]);
    const stack = facts(r.owner, "monitoring", input);
    const edited: HostFacts = {
      ...stack,
      alloy: { destinations: [] },
      addons: {
        ...stack.addons,
        alloy: { ...stack.addons.alloy, composeSha256: "0".repeat(64), running: false },
      },
      monitoring: {
        containers: (stack.monitoring?.containers ?? []).map((c) => ({
          ...c,
          running: !c.name.includes("loki"),
        })),
        files: Object.fromEntries(
          Object.entries(stack.monitoring?.files ?? {})
            .filter(([path]) => path !== "prometheus.yml")
            .map(([path, hash]) => [path, path === "loki.yaml" ? "1".repeat(64) : hash]),
        ),
      },
    };
    expect(alloyDifferences(r.owner, "monitoring", edited).map((d) => d.detail)).toEqual([
      "It sends to nowhere, and the plan says the monitoring stack.",
      "Its Compose file was edited, or the plan changed since the last provision.",
      "It is not running.",
    ]);
    expect(stackDifferences(input, edited).map((d) => d.detail)).toEqual([
      "prometheus.yml is missing.",
      "loki.yaml differs from the plan: edited on the server, or the plan changed since the last provision.",
      "loki is not running.",
    ]);
    expect(stackDifferences(input, { monitoring: undefined }).map((d) => d.detail)).toEqual([
      "The monitoring stack is not on this server.",
    ]);
    const notes: string[] = [];
    const differences = await monitoringDrift(r.prod, r.owner, notes, {
      services: {
        remote: (host) => ({ host, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
      },
      inspect: async (remote) => {
        if (remote.host === IPS.data) throw new OpsCrewError("COMMAND_FAILED", "ssh failed.");
        return remote.host === IPS.monitoring ? edited : facts(r.owner, "app");
      },
    });
    expect(differences.map((d) => d.title)).toContain(
      "Server monitoring: OpsCrew's monitoring stack",
    );
    expect(differences.map((d) => d.title)).toContain("Server monitoring: Grafana Alloy");
    expect(notes).toEqual(["OpsCrew could not compare the monitoring on server data. ssh failed."]);
    expect(JSON.stringify(differences)).not.toContain("203.0.113.");
  });
});
