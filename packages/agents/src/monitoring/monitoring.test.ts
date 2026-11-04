import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import {
  ADDON_MEMORY_DEFAULTS,
  type DeployPlan,
  DeployPlanSchema,
  monitoringOf,
  type PlanService,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { addonDisable, addonEnable } from "../addons/run";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { readValidJson } from "../shared/files";
import { type ServerAddresses, updateServerAddresses } from "../shared/server-record";
import {
  createTestPhaseDeps,
  freshFacts,
  ownPlan,
  portainerPlan,
  type ScriptedRunner,
  type TestPhaseDeps,
  testKeyMaker,
  testPlan,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import { catalog, deployed } from "./__fixtures__/world";
import { monitoringDisable } from "./disable";
import { type MonitoringServices, monitoringEnable } from "./enable";
import { figuresCommand } from "./estimate";
import { MONITORING_VERSIONS, requireMonitoringTarget } from "./settings";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const APP_IPV4 = "203.0.113.10";
const DATA_IPV4 = "203.0.113.30";
const GIB = 1024 ** 3;

/** What a server's read answers: its CPUs, memory, the app's log bytes of a day, containers, free disk. */
interface Figures {
  cpus: number;
  memoryKb: number;
  logBytes: number;
  containers: number;
  freeGb: number;
}

const FIGURES: Figures = {
  cpus: 2,
  memoryKb: 3_900_000,
  logBytes: 40_000_000,
  containers: 5,
  freeGb: 30,
};

/**
 * The servers as fakes: each read answered from `figures` (by `<app>/<server>`), each inspection
 * from `facts`, and any apply refused and recorded. Every command is recorded.
 */
class FakeServers {
  readonly commands: string[] = [];
  readonly reads: string[] = [];
  readonly inspected: string[] = [];
  readonly applied: unknown[] = [];
  readonly figures: Record<string, Partial<Figures>> = {};
  readonly facts: Record<string, HostFacts> = {};
  readonly keys = testKeyMaker("monitoring");

  services(): MonitoringServices {
    return {
      remote: async (server, plan) => ({
        host: `${plan.app.name}/${server}`,
        run: async (command) => {
          this.commands.push(command);
          if (command !== figuresCommand(plan.app.name)) {
            throw new Error(`the fake server does not answer: ${command}`);
          }
          this.reads.push(`${plan.app.name}/${server}`);
          const f = { ...FIGURES, ...this.figures[`${plan.app.name}/${server}`] };
          const lines = [f.cpus, f.memoryKb, f.logBytes, f.containers, f.freeGb * GIB];
          return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        },
      }),
      host: {
        inspect: async (remote) => {
          this.inspected.push(remote.host);
          return this.facts[remote.host] ?? HostFactsSchema.parse(freshFacts());
        },
        apply: async (...call) => {
          this.applied.push(call);
          throw new Error("nothing is applied");
        },
      },
      keys: this.keys,
      catalogFor: async () => catalog(),
    };
  }
}

/** A deployed project with `plan` (and the servers' addresses on this computer), for `environment`. */
async function world(
  plan: DeployPlan,
  o: { root?: string; environment?: string; record?: Partial<ServerAddresses> } = {},
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({
    clock: { now: () => NOW },
    ...(o.root === undefined ? {} : { root: o.root }),
    ...(o.environment === undefined ? {} : { environment: o.environment }),
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: APP_IPV4 },
    ...o.record,
  }));
  return deps;
}

/** The repository's files outside OpsCrew's local state, with their contents. */
async function repositoryFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".opscrew" || entry.name === ".home-opscrew") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(root, path), await readFile(path, "utf8"));
    }
  };
  await walk(root);
  return files;
}

/** The split plan (`db` on server `data`, a cx23) on its network, deployed. */
function splitWorld(dataType = "cx23") {
  const split = splitPlan();
  const base = deployed({
    ...split,
    servers: (split.servers ?? []).map((s) =>
      s.target.provider === "own" ? s : { ...s, target: { ...s.target, serverType: dataType } },
    ),
  } as DeployPlan);
  const { network } = allocateNetwork(base, {}, testKeyMaker("server"));
  return withNetwork(base, network);
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("monitoringEnable on a server of its own", () => {
  it("adds the smallest Hetzner type that fits, priced, creates the network, and writes only the plan", async () => {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const servers = new FakeServers();
    const before = await repositoryFiles(deps.paths.root);

    const { plan: after, summary } = await monitoringEnable(deps, plan, {
      services: servers.services(),
    });

    // The 1 GB type can't hold the stack; the 2 GB one is the smallest that does.
    expect(after.servers).toEqual([
      {
        name: "monitoring",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType: "cx21",
          image: "ubuntu-24.04",
          backups: false,
        },
      },
    ]);
    const monitoring = monitoringOf(after);
    expect(monitoring).toEqual({
      enabled: true,
      where: { kind: "server", server: "monitoring" },
      versions: MONITORING_VERSIONS,
      retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 23 },
      memoryMb: ADDON_MEMORY_DEFAULTS.monitoring,
    });
    expect(MONITORING_VERSIONS).toEqual({
      prometheus: "3.15.1",
      loki: "3.7.9",
      grafana: "13.3.0",
      alloy: "1.21.3",
    });
    // The network is created with the app's server and the monitoring server, their keys kept.
    expect(after.network?.members.map((m) => m.name)).toEqual(["app", "monitoring"]);
    const values = await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema);
    expect(Object.keys(values?.network ?? {})).toEqual(["app", "monitoring"]);
    const key = servers.keys.made[1]?.privateKey as string;
    expect(deps.redactor.redact(`key ${key}`)).not.toContain(key);
    expect(await readFile(deps.paths.files.plan, "utf8")).not.toContain(key);
    // The monitoring server's price joins the plan's cost.
    expect(after.cost.breakdown).toContainEqual({
      item: "Server monitoring (cx21 in nbg1), with its IPv4 address",
      monthly: { amount: 3.79, currency: "EUR" },
    });
    expect(after.cost.monthly.amount).toBeCloseTo(plan.cost.monthly.amount + 3.79, 2);

    // Only plan.yaml changed in the repository, and nothing was applied anywhere.
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual({
      ...after,
      updatedAt: NOW.toISOString(),
    });
    const now = await repositoryFiles(deps.paths.root);
    const changed = [...now.keys()].filter((file) => now.get(file) !== before.get(file));
    expect(changed).toEqual([join("opscrew", "plan.yaml")]);
    expect(servers.applied).toEqual([]);
    expect(servers.commands).toEqual([figuresCommand("shop")]);
    expect((deps.runner as ScriptedRunner).calls).toEqual([]);
    expect(deps.audit.entries.map((e) => e.kind)).toEqual(["remote-exec"]);

    // FR-2001: the server and its price, what runs, Alloy's memory and price share on each server,
    // the retention and the disk, where the data stays, the licences, and the next step.
    expect(summary).toContain(
      "Server monitoring: Hetzner cx21 in Nuremberg (nbg1), 1 vCPU and 2 GB memory, €3.79/month",
    );
    expect(summary).toContain("Prometheus");
    expect(summary).toContain("Loki");
    expect(summary).toContain(
      "The stack's memory limits on server monitoring: Prometheus 192 MB (€0.36/month of its price), Loki 384 MB (€0.71/month of its price), Grafana 416 MB (€0.77/month of its price), the monitoring front 96 MB (€0.18/month of its price).",
    );
    expect(summary).toContain(
      "Grafana Alloy collects them, with its Docker proxy, in 288 MB of memory on each of this environment's servers: the app's server (€",
    );
    expect(summary).toContain("server monitoring (€0.53/month of its price)");
    expect(summary).toContain(
      "Figures are kept 15 days (at most 23 GB) and logs 7 days: about 0.1 GB of the 30.0 GB disk on server monitoring (218 series and less than 0.1 GB of logs a day from 2 servers).",
    );
    expect(summary).toContain("stay on your own servers");
    expect(summary).toContain(
      "Grafana and Loki are licensed AGPL-3.0; OpsCrew runs them unmodified, as containers.",
    );
    expect(summary).toContain("The private network ");
    expect(summary).toContain("run `opscrew provision` to set it up");
    expect(summary).not.toMatch(/\b0\d\d\b|feature/i);
    // No address anywhere.
    for (const text of [summary, deps.reporter.text(), JSON.stringify(deps.audit.entries)]) {
      expect(text).not.toContain(APP_IPV4);
    }
  });

  it("joins an existing network and checks every server's room for Alloy", async () => {
    const plan = splitWorld();
    const deps = await world(plan, { record: { servers: { data: { ipv4: DATA_IPV4 } } } });
    const servers = new FakeServers();
    const { plan: after, summary } = await monitoringEnable(deps, plan, {
      services: servers.services(),
    });
    expect(after.servers?.map((s) => s.name)).toEqual(["data", "monitoring"]);
    expect(after.network?.members.map((m) => m.name)).toEqual(["app", "data", "monitoring"]);
    // The kept members are as they were; only the new one got a key.
    expect(after.network?.members.slice(0, 2)).toEqual(plan.network?.members);
    expect(servers.keys.made).toHaveLength(1);
    expect(servers.reads).toEqual(["shop/app", "shop/data"]);
    expect(summary).toContain("server data (€");
    expect(summary).toContain("Server monitoring joins this environment's private network.");
    for (const text of [summary, JSON.stringify(deps.audit.entries)]) {
      expect(text).not.toContain(DATA_IPV4);
    }
  });

  it("counts Postgres's 40 series on each server that runs one, a second Postgres's server too", async () => {
    const seriesOf = async (plan: DeployPlan) => {
      const deps = await world(plan, { record: { servers: { data: { ipv4: DATA_IPV4 } } } });
      const { summary } = await monitoringEnable(deps, plan, {
        services: new FakeServers().services(),
      });
      return Number(/\((\d+) series/.exec(summary)?.[1]);
    };
    const plan = splitWorld();
    const { server: _data, ...db } = plan.services.find((s) => s.name === "db") as PlanService;
    const second = DeployPlanSchema.parse({
      ...plan,
      services: [...plan.services, { ...db, name: "reports" }],
    });
    expect((await seriesOf(second)) - (await seriesOf(plan))).toBe(40);
  });

  it("keeps the type and retention the plan sets when it runs again, re-estimating the cap", async () => {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const servers = new FakeServers();
    const first = await monitoringEnable(deps, plan, { services: servers.services() });
    const edited = DeployPlanSchema.parse({
      ...first.plan,
      servers: (first.plan.servers ?? []).map((s) => ({
        ...s,
        target: { ...s.target, serverType: "cx33" },
      })),
      observability: {
        monitoring: {
          ...monitoringOf(first.plan),
          retention: { metricsDays: 30, logsDays: 3, metricsMaxGb: 23 },
        },
      },
    });
    servers.figures["shop/app"] = { logBytes: 4 * GIB };
    const again = await monitoringEnable(deps, edited, { services: servers.services() });
    expect(again.plan.servers?.[0]?.target).toMatchObject({ serverType: "cx33" });
    // 4 GiB a day for 3 days at a quarter is 3 GiB: 80% of the 77 GB left of cx33's 80.
    expect(monitoringOf(again.plan)?.retention).toEqual({
      metricsDays: 30,
      logsDays: 3,
      metricsMaxGb: 61,
    });
    expect(again.plan.cost.breakdown.filter((l) => l.item.startsWith("Server monitoring"))).toEqual(
      [
        {
          item: "Server monitoring (cx33 in nbg1), with its IPv4 address",
          monthly: { amount: 8.99, currency: "EUR" },
        },
      ],
    );
    // No new key: the network's members are kept.
    expect(servers.keys.made).toHaveLength(2);
  });
});

describe("monitoringEnable refuses before any change", () => {
  /** The refusal, with the plan file and the generated values as they were. */
  async function refused(
    plan: DeployPlan,
    options: Parameters<typeof monitoringEnable>[2] = {},
    setup: (deps: TestPhaseDeps, servers: FakeServers) => void = () => {},
    record: Partial<ServerAddresses> = {},
  ): Promise<OpsCrewError> {
    const deps = await world(plan, { record });
    const servers = new FakeServers();
    setup(deps, servers);
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await failure(
      monitoringEnable(deps, plan, { ...options, services: servers.services() }),
    );
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    expect(await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema)).toBeUndefined();
    expect(servers.applied).toEqual([]);
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.message).not.toMatch(/\b0\d\d\b|feature/i);
    return error;
  }

  it("refuses Portainer, this computer, Cloudflare and GitHub Pages, with the reason", async () => {
    const portainer = await refused(deployed(portainerPlan()));
    expect(portainer.message).toContain("in your Portainer");
    for (const site of [sitePlan(), sitePlan({ provider: "github-pages" })]) {
      expect((await refused(site)).message).toContain("on a host without a server of its own");
    }
    const localhost = { ...testPlan(), target: { provider: "localhost" } } as unknown as DeployPlan;
    expect(() => requireMonitoringTarget(localhost, "opscrew addon enable monitoring")).toThrow(
      /on this computer.*Nothing was changed\.$/,
    );
  });

  it("refuses an app that is not deployed yet, and --on app with --new-server", async () => {
    expect((await refused(testPlan())).message).toContain("no deployment to monitor yet");
    const both = await refused(deployed(testPlan()), { on: "app", newServer: true });
    expect(both.code).toBe("INVALID_INPUT");
  });

  it("refuses to move monitoring that is on", async () => {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const { plan: on } = await monitoringEnable(deps, plan, {
      services: new FakeServers().services(),
    });
    const error = await refused(on, { on: "app" });
    expect(error.message).toContain("already on, on server monitoring");
    expect(error.hint).toContain("opscrew addon disable monitoring");
  });

  it("refuses a server without room for Alloy, naming a type that has it", async () => {
    // A 1 GB server for db's 512 MB: with Alloy's 288 MB and the system's 384 MB it is full.
    const error = await refused(splitWorld("cx11"), {}, () => {}, {
      servers: { data: { ipv4: DATA_IPV4 } },
    });
    expect(error.message).toContain(
      "Server data (cx11, 1.0 GB of memory) has no room for Grafana Alloy (288 MB)",
    );
    expect(error.hint).toContain("such as cx21");
  });

  it("refuses an app on the user's own server without --on app: there is no provider to put a server at", async () => {
    const plan = deployed(ownPlan());
    const error = await refused(plan, {}, () => {}, {
      own: { host: "203.0.113.20", port: 22, user: "root", agent: true },
    });
    expect(error.message).toContain("this app runs on your own server");
    expect(error.hint).toContain("--on app");
  });

  it("refuses a second app's monitoring on one of the user's own servers", async () => {
    const plan = deployed(ownPlan());
    const error = await refused(
      plan,
      { on: "app" },
      (_deps, servers) => {
        servers.facts["shop/app"] = HostFactsSchema.parse({
          ...freshFacts(),
          record: {
            schemaVersion: 1,
            apps: ["blog", "shop"],
            opscrewVersion: "0.0.0-test",
            changes: [],
            addons: { alloy: "blog" },
          },
        });
      },
      { own: { host: "203.0.113.20", port: 22, user: "root", agent: true } },
    );
    expect(error.message).toContain('already belongs to the app "blog"');
  });

  it("refuses a first retention past 80% of the disk, naming the flags with what fits and a larger server", async () => {
    const error = await refused(deployed(testPlan()), {}, (_deps, servers) => {
      // 20 GiB of logs a day: 35 GiB in 7 days, past 80% of cx21's 30 GB.
      servers.figures["shop/app"] = { logBytes: 20 * GIB };
    });
    expect(error.message).toContain(
      "Keeping figures 15 days and logs 7 days would take about 35.0 GB of the 30.0 GB disk on server monitoring",
    );
    // Monitoring isn't in the plan yet: the command's flags, not a plan field.
    expect(error.hint).toBe(
      "Keep them for less time: run `opscrew addon enable monitoring --logs-days 4`. Once monitoring is in the plan, you can also give server monitoring a type with more disk, such as cx33 (servers[].target.serverType in opscrew/plan.yaml).",
    );
    // The figures' days given stay in the command.
    const kept = await refused(deployed(testPlan()), { metricsDays: 30 }, (_deps, servers) => {
      servers.figures["shop/app"] = { logBytes: 20 * GIB };
    });
    expect(kept.hint).toContain(
      "`opscrew addon enable monitoring --metrics-days 30 --logs-days 4`",
    );
  });

  it("refuses a retention outside the plan's bounds", async () => {
    const logs = await refused(deployed(testPlan()), { logsDays: 31 });
    expect(logs.message).toBe(
      "--logs-days must be a whole number of days from 1 to 30. Nothing was changed.",
    );
    const figures = await refused(deployed(testPlan()), { metricsDays: 0 });
    expect(figures.code).toBe("INVALID_INPUT");
    expect((await refused(deployed(testPlan()), { metricsDays: 1.5 })).code).toBe("INVALID_INPUT");
  });
});

describe("monitoringEnable's retention", () => {
  it("takes the days asked for instead of the defaults, the cap from what they leave", async () => {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const servers = new FakeServers();
    servers.figures["shop/app"] = { logBytes: 20 * GIB };
    const { plan: after, summary } = await monitoringEnable(deps, plan, {
      logsDays: 4,
      services: servers.services(),
    });
    // 20 GiB a day for 4 days at a quarter: 20 GiB, which leaves 80% of 10 GB for figures.
    expect(monitoringOf(after)?.retention).toEqual({
      metricsDays: 15,
      logsDays: 4,
      metricsMaxGb: 8,
    });
    expect(summary).toContain("Figures are kept 15 days (at most 8 GB) and logs 4 days");
  });

  it("refuses a later retention that doesn't fit, naming the plan's fields", async () => {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const servers = new FakeServers();
    const { plan: on } = await monitoringEnable(deps, plan, { services: servers.services() });
    servers.figures["shop/app"] = { logBytes: 20 * GIB };
    const error = await failure(monitoringEnable(deps, on, { services: servers.services() }));
    expect(error.hint).toBe(
      "Keep logs 4 days (retention.logsDays) in observability.monitoring of opscrew/plan.yaml, or give server monitoring a type with more disk, such as cx33 (servers[].target.serverType in opscrew/plan.yaml), then run this command again.",
    );
  });
});

describe("monitoringEnable --on app", () => {
  it("runs the stack on a 4 GB app server it fits on: no server, no network, the cap from its free disk", async () => {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const servers = new FakeServers();
    const { plan: after, summary } = await monitoringEnable(deps, plan, {
      on: "app",
      services: servers.services(),
    });
    expect(monitoringOf(after)?.where).toEqual({ kind: "app" });
    expect(after.servers).toBeUndefined();
    expect(after.network).toBeUndefined();
    expect(after.cost).toEqual(plan.cost);
    expect(monitoringOf(after)?.retention.metricsMaxGb).toBe(23);
    expect(summary).toContain("The monitoring stack runs on the app's server; no new server.");
    expect(summary).toContain(
      "The stack's memory limits on the app's server: Prometheus 192 MB (€",
    );
  });

  it("refuses an app server below 4 GB, naming the type that fits and the monitoring server's price", async () => {
    const plan = deployed(
      DeployPlanSchema.parse({
        ...testPlan(),
        target: { ...testPlan().target, serverType: "cx21" },
      }),
    );
    const deps = await world(plan);
    const error = await failure(
      monitoringEnable(deps, plan, { on: "app", services: new FakeServers().services() }),
    );
    expect(error.message).toContain(
      "The app's server (cx21, 2.0 GB of memory): it has less than 4 GB",
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toContain("a monitoring server of its own (a cx21 at €3.79/month)");
    expect(error.hint).toContain("such as cx23,");
  });

  it("refuses a 4 GB server the stack doesn't fit on beside the app", async () => {
    const base = testPlan();
    const plan = deployed(
      DeployPlanSchema.parse({ ...base, app: { ...base.app, memoryMb: 2048 } }),
    );
    const deps = await world(plan);
    const error = await failure(
      monitoringEnable(deps, plan, { on: "app", services: new FakeServers().services() }),
    );
    expect(error.message).toContain("would come to 4064 MB");
    expect(error.hint).toContain("such as cx33,");
  });
});

describe("one of the user's own servers as the monitoring server", () => {
  /** The plan with monitoring on a server `monitoring` the user owns, and its login recorded. */
  async function ownMonitoring(memoryGb: number) {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const servers = new FakeServers();
    const first = await monitoringEnable(deps, plan, { services: servers.services() });
    const own = DeployPlanSchema.parse({
      ...first.plan,
      servers: [
        { name: "monitoring", target: { provider: "own", mode: "vps-compose", arch: "amd64" } },
      ],
    });
    await writeArtifact("plan", deps.paths.files.plan, own);
    await updateServerAddresses(deps.paths, (current) => ({
      ...current,
      ownServers: { monitoring: { host: "203.0.113.50", port: 22, user: "root", agent: true } },
    }));
    servers.facts["shop/monitoring"] = HostFactsSchema.parse(freshFacts({ memoryGb }));
    return { deps, servers, own };
  }

  it("is checked against its facts' memory instead of sized, with no cost", async () => {
    const { deps, servers, own } = await ownMonitoring(4);
    const { plan: after, summary } = await monitoringEnable(deps, own, {
      services: servers.services(),
    });
    expect(servers.inspected).toContain("shop/monitoring");
    expect(after.servers).toEqual(own.servers);
    expect(after.cost.breakdown.some((l) => l.item.startsWith("Server monitoring"))).toBe(false);
    // Its free disk (40 GB) bounds the figures.
    expect(monitoringOf(after)?.retention.metricsMaxGb).toBe(31);
    expect(summary).toContain("Server monitoring: your own server (2 vCPU, 4 GB memory");
  });

  it("refuses one whose memory can't hold the stack", async () => {
    const { deps, servers, own } = await ownMonitoring(1);
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await failure(monitoringEnable(deps, own, { services: servers.services() }));
    expect(error.message).toContain(
      "Server monitoring (your own, 1.0 GB of memory) has no room for",
    );
    expect(error.hint).toContain("Add memory to the server");
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });
});

describe("monitoringDisable", () => {
  it("removes the settings, the server, its member and its cost, and writes only the plan", async () => {
    const plan = splitWorld();
    const deps = await world(plan, { record: { servers: { data: { ipv4: DATA_IPV4 } } } });
    const { plan: on } = await monitoringEnable(deps, plan, {
      services: new FakeServers().services(),
    });
    const { plan: off, summary } = await monitoringDisable(deps, on);
    expect({ ...off, updatedAt: plan.updatedAt }).toEqual(plan);
    expect(off.observability).toBeUndefined();
    expect(off.servers).toEqual(plan.servers);
    expect(off.network).toEqual(plan.network);
    expect(off.cost).toEqual(plan.cost);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual({
      ...off,
      updatedAt: NOW.toISOString(),
    });
    expect(summary).toContain(
      "deletes server monitoring with the figures and logs it keeps, after you type its name",
    );
    // Off already: nothing to do.
    expect((await monitoringDisable(deps, off)).summary).toContain("already off");
  });
});

describe("the add-on commands", () => {
  it("dispatch monitoring: the summary said, nothing applied, then off again", async () => {
    const plan = deployed(testPlan());
    const deps = await world(plan);
    const servers = new FakeServers();
    const on = await addonEnable(deps, plan, "monitoring", {
      on: "server",
      logsDays: 5,
      services: { monitoring: servers.services() },
    });
    expect(on).toMatchObject({
      applied: false,
      hostApplied: false,
      hostPlanHashes: [],
      files: [],
      approveCommand: "opscrew addon enable monitoring --on server --logs-days 5",
    });
    expect(deps.reporter.text()).toContain(
      "info: The monitoring stack runs on a server of its own.",
    );
    const written = await readArtifact("plan", deps.paths.files.plan);
    expect(monitoringOf(written)?.where).toEqual({ kind: "server", server: "monitoring" });
    expect(monitoringOf(written)?.retention.logsDays).toBe(5);
    const off = await addonDisable(deps, written, "monitoring");
    expect(off.approveCommand).toBe("opscrew addon disable monitoring");
    expect(monitoringOf(await readArtifact("plan", deps.paths.files.plan))).toBeUndefined();
    expect(servers.applied).toEqual([]);
  });
});
