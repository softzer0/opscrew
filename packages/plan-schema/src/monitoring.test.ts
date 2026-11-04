// Feature 020: self-hosted monitoring, `plan.observability.monitoring`, the network's outside member
// and the helpers (T2002, ADR 0024).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ADDON_MEMORY_DEFAULTS,
  DeployPlanSchema,
  isOutsideMember,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  MONITORING_SERVER,
  MonitoringSchema,
  MonitoringWhereSchema,
  monitoringOf,
  monitoringServerName,
  parseArtifact,
  serializeArtifact,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

/** A WireGuard public key, made up at runtime. */
const key = () => randomBytes(32).toString("base64");

const versions = { prometheus: "3.15.1", loki: "3.7.9", grafana: "13.3.0", alloy: "1.21.3" };
const retention = { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 };

/** The fixture's plan: on Hetzner, with Postgres (`db`) on the app's server. */
async function serverPlan() {
  const text = await readFile(new URL("plan.yaml", FIXTURES), "utf8");
  return parseArtifact("plan", text, "fixture");
}

/** The owner: the stack on its extra server `monitoring`, a member of the app's network. */
async function ownerPlan(monitoring: Record<string, unknown> = {}) {
  return {
    ...(await serverPlan()),
    servers: [
      {
        name: "monitoring",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "fsn1",
          serverType: "cx23",
          backups: false,
        },
      },
    ],
    network: {
      range: "10.203.17.0/24",
      members: [
        { name: "app", address: "10.203.17.2", port: 51820, publicKey: key() },
        { name: "monitoring", address: "10.203.17.3", port: 51820, publicKey: key() },
      ],
    },
    observability: {
      monitoring: {
        enabled: true,
        where: { kind: "server", server: "monitoring" },
        versions,
        retention,
        ...monitoring,
      },
    },
  };
}

/** A sender: this environment's servers push to the owner's monitoring server, its outside member. */
async function senderPlan(memberName = "monitoring") {
  return {
    ...(await serverPlan()),
    network: {
      range: "10.205.40.0/24",
      members: [
        { name: "app", address: "10.205.40.2", port: 51820, publicKey: key() },
        { name: memberName, address: "10.205.40.3", port: 51821, publicKey: key() },
      ],
    },
    observability: {
      monitoring: {
        enabled: true,
        where: { kind: "shared", owner: { plan: "opscrew/plan.yaml", server: "monitoring" } },
        versions,
        retention,
      },
    },
  };
}

/** The fixture's plan with the stack on the app's server. */
async function appPlan(monitoring: Record<string, unknown> = {}) {
  return {
    ...(await serverPlan()),
    observability: {
      monitoring: { enabled: true, where: { kind: "app" }, versions, retention, ...monitoring },
    },
  };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("plan.observability.monitoring", () => {
  it("parses the owner, the sender and the app's server, with the defaults filled in", async () => {
    const owner = DeployPlanSchema.parse(await ownerPlan());
    expect(owner.observability?.monitoring).toEqual({
      enabled: true,
      where: { kind: "server", server: "monitoring" },
      versions,
      retention,
      memoryMb: ADDON_MEMORY_DEFAULTS.monitoring,
    });
    expect(DeployPlanSchema.safeParse(await senderPlan()).success).toBe(true);
    const app = DeployPlanSchema.parse(await appPlan({ retention: { metricsMaxGb: 10 } }));
    expect(app.observability?.monitoring?.retention).toEqual({
      metricsDays: 15,
      logsDays: 7,
      metricsMaxGb: 10,
    });
    expect(parseArtifact("plan", serializeArtifact("plan", owner), "round trip")).toEqual(owner);
  });

  it("keeps the memory defaults the spike measured", () => {
    expect(ADDON_MEMORY_DEFAULTS.monitoring).toEqual({
      prometheus: 512,
      loki: 384,
      grafana: 384,
      front: 64,
      alloy: 384,
      proxy: 48,
    });
    expect(ADDON_MEMORY_DEFAULTS.grafanaCloud).toEqual({ alloy: 256, proxy: 32 });
  });

  it("exports the ports and the default server's name", () => {
    expect([MONITORING_PUSH_PORT, MONITORING_GRAFANA_PORT, MONITORING_SERVER]).toEqual([
      9091,
      3000,
      "monitoring",
    ]);
  });

  it("refuses retention outside its bounds, a floating version and an unknown where", () => {
    const base = { where: { kind: "app" }, versions, retention };
    const fails = (value: unknown) => MonitoringSchema.safeParse(value).success;
    expect(fails({ ...base, retention: { ...retention, metricsDays: 91 } })).toBe(false);
    expect(fails({ ...base, retention: { ...retention, logsDays: 31 } })).toBe(false);
    expect(fails({ ...base, retention: { metricsDays: 15 } })).toBe(false);
    expect(fails({ ...base, versions: { ...versions, grafana: "latest" } })).toBe(false);
    expect(MonitoringWhereSchema.safeParse({ kind: "cloud" }).success).toBe(false);
    expect(MonitoringWhereSchema.safeParse({ kind: "server", server: "app" }).success).toBe(false);
  });
});

describe("monitoring's rules", () => {
  it("refuses it on a target that is not a server", async () => {
    const plan = await serverPlan();
    const { url: _url, ...deployment } = plan.deployment;
    const local = {
      ...(await appPlan()),
      target: {
        provider: "localhost",
        mode: "local-compose",
        arch: "arm64",
        ports: { https: 443, http: 80 },
        image: "local-build",
      },
      dns: { provider: "none", proxied: false, www: false },
      deployment,
    };
    expect(issues(DeployPlanSchema.safeParse(local))).toEqual([
      {
        path: "observability.monitoring.enabled",
        message:
          "can be true only on a server: Prometheus, Loki and Grafana run on a server OpsCrew deploys to (a cloud server or your own), which a Portainer, localhost, Cloudflare or GitHub Pages target is not; set observability.monitoring.enabled to false, or choose a server target",
      },
    ]);
    const off = {
      ...local,
      observability: { monitoring: { ...local.observability.monitoring, enabled: false } },
    };
    expect(DeployPlanSchema.safeParse(off).success).toBe(true);
  });

  it('refuses kind "server" naming no server of the plan', async () => {
    const plan = await ownerPlan({ where: { kind: "server", server: "watch" } });
    expect(issues(DeployPlanSchema.safeParse(plan))).toContainEqual({
      path: "observability.monitoring.where.server",
      message:
        'names no server of the plan: "watch"; add it to servers (opscrew addon enable monitoring does), or name one of servers',
    });
  });

  it('refuses kind "server" naming a server that runs services', async () => {
    const plan = await ownerPlan();
    const [db, ...rest] = plan.services;
    const withService = { ...plan, services: [{ ...db, server: "monitoring" }, ...rest] };
    expect(issues(DeployPlanSchema.safeParse(withService))).toEqual([
      {
        path: "observability.monitoring.where.server",
        message:
          'is "monitoring", which runs services: the monitoring server holds only the monitoring stack; move those services (services[].server) to another server, or name a server of its own',
      },
    ]);
  });

  it('refuses kind "server" naming a server that is not on the network', async () => {
    const plan = await ownerPlan();
    const network = { ...plan.network, members: plan.network.members.slice(0, 1) };
    expect(issues(DeployPlanSchema.safeParse({ ...plan, network }))).toContainEqual({
      path: "observability.monitoring.where.server",
      message:
        'is "monitoring", which is not on the private network: the servers send to it there; add it to network.members (run opscrew design)',
    });
  });

  it("lets the monitoring server run no service, and only while monitoring is on", async () => {
    expect(DeployPlanSchema.safeParse(await ownerPlan()).success).toBe(true);
    expect(issues(DeployPlanSchema.safeParse(await ownerPlan({ enabled: false })))).toEqual([
      {
        path: "servers.0",
        message:
          "runs no enabled service: place a service on monitoring (services[].server), or remove the server (it is deleted at the next provision, after your approval)",
      },
    ]);
  });

  it('refuses kind "shared" without its outside member', async () => {
    const message =
      'is "monitoring", which is not on this plan\'s network as the monitoring server of opscrew/plan.yaml: add it to network.members under that name, which must not be app or one of servers (opscrew addon enable monitoring does)';
    const { network: _n, ...alone } = await senderPlan();
    expect(issues(DeployPlanSchema.safeParse(alone))).toEqual([
      { path: "observability.monitoring.where.owner.server", message },
    ]);
    expect(issues(DeployPlanSchema.safeParse(await senderPlan("watch")))).toContainEqual({
      path: "observability.monitoring.where.owner.server",
      message,
    });
  });

  it("never names a device like the outside member", async () => {
    const sender = await senderPlan();
    const plan = {
      ...sender,
      network: {
        ...sender.network,
        devices: [
          {
            name: "monitoring",
            address: "10.205.40.101",
            publicKey: key(),
            addedAt: "2026-11-04T10:00:00Z",
          },
        ],
      },
    };
    expect(issues(DeployPlanSchema.safeParse(plan))).toEqual([
      {
        path: "network.devices.0.name",
        message:
          '"monitoring" is the name of a server of the app; give the device another name, such as "laptop"',
      },
    ]);
  });

  it('refuses an outside member unless monitoring is on with kind "shared"', async () => {
    const message =
      'names no server of the plan: "monitoring"; a member is "app": the plan has no extra servers';
    const sender = await senderPlan();
    const kinds = [
      { ...sender, observability: undefined },
      {
        ...sender,
        observability: { monitoring: { ...sender.observability.monitoring, enabled: false } },
      },
      {
        ...sender,
        observability: {
          monitoring: { ...sender.observability.monitoring, where: { kind: "app" } },
        },
      },
    ];
    for (const plan of kinds) {
      expect(issues(DeployPlanSchema.safeParse(plan))).toEqual([
        { path: "network.members.1.name", message },
      ]);
    }
  });

  it("refuses an Alloy version other than Grafana Cloud's", async () => {
    const endpoint = (path: string) => ({
      url: `https://stack.grafana.net${path}`,
      user: "123456",
    });
    const grafanaCloud = {
      enabled: true,
      version: "1.21.0",
      metrics: endpoint("/api/prom/push"),
      logs: endpoint("/loki/api/v1/push"),
    };
    const plan = await appPlan();
    const both = (version: string) => ({
      ...plan,
      observability: { ...plan.observability, grafanaCloud: { ...grafanaCloud, version } },
    });
    expect(issues(DeployPlanSchema.safeParse(both("1.21.0")))).toEqual([
      {
        path: "observability.monitoring.versions.alloy",
        message:
          "must equal observability.grafanaCloud.version (1.21.0): one Alloy on each server sends to both; set both to the same version",
      },
    ]);
    expect(DeployPlanSchema.safeParse(both("1.21.3")).success).toBe(true);
  });
});

describe("monitoring's helpers", () => {
  it("monitoringOf returns the settings only while monitoring is on", async () => {
    const owner = DeployPlanSchema.parse(await ownerPlan());
    expect(monitoringOf(owner)?.where).toEqual({ kind: "server", server: "monitoring" });
    const off = DeployPlanSchema.parse(await appPlan({ enabled: false }));
    expect(off.observability?.monitoring?.enabled).toBe(false);
    expect(monitoringOf(off)).toBeUndefined();
    expect(monitoringOf(await serverPlan())).toBeUndefined();
  });

  it("monitoringServerName names the stack's server for each kind", async () => {
    expect(monitoringServerName(DeployPlanSchema.parse(await ownerPlan()))).toBe("monitoring");
    expect(monitoringServerName(DeployPlanSchema.parse(await appPlan()))).toBe("app");
    expect(monitoringServerName(DeployPlanSchema.parse(await senderPlan()))).toBe("monitoring");
    expect(monitoringServerName(await serverPlan())).toBeUndefined();
  });

  it("isOutsideMember is true only for a shared plan's owner server", async () => {
    const sender = DeployPlanSchema.parse(await senderPlan());
    const [app, outside] = sender.network?.members ?? [];
    expect(outside && isOutsideMember(sender, outside)).toBe(true);
    expect(app && isOutsideMember(sender, app)).toBe(false);
    const owner = DeployPlanSchema.parse(await ownerPlan());
    for (const member of owner.network?.members ?? []) {
      expect(isOutsideMember(owner, member)).toBe(false);
    }
    // A shared plan whose owner's server is also one of its own servers has no outside member.
    const mixed = { ...owner, observability: sender.observability };
    expect(owner.network?.members.some((m) => isOutsideMember(mixed, m))).toBe(false);
  });
});
