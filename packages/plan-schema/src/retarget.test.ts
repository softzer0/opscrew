// Feature 023: the move's record, `plan.retarget`, between any two server targets or two site
// targets, with the bucket's move, the old app server's network member and the services started
// empty (T2302, ADR 0027).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import { DeployPlanSchema, parseArtifact, type Retarget, serializeArtifact } from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

/** A WireGuard public key, made up at runtime. */
const key = () => randomBytes(32).toString("base64");

/** The fixture's plan: on Hetzner, with Postgres (`db`) on the app's server. */
async function serverPlan() {
  const text = await readFile(new URL("plan.yaml", FIXTURES), "utf8");
  return parseArtifact("plan", text, "fixture");
}

const own = { provider: "own", mode: "vps-compose", arch: "arm64", access: "public" } as const;
const portainer = (web: Record<string, unknown> = { mode: "caddy" }) => ({
  provider: "portainer",
  mode: "portainer-stack",
  environmentId: 3,
  arch: "amd64",
  redeploy: "updater",
  web,
});
const site = { tool: "none", outputDir: "public" } as const;
const workers = {
  provider: "cloudflare-workers",
  mode: "workers-assets",
  worker: "example-app",
  render: "static",
  notFound: "404-page",
  site,
} as const;
const pages = { provider: "github-pages", mode: "pages-workflow", site } as const;
const localhost = {
  provider: "localhost",
  mode: "local-compose",
  arch: "arm64",
  ports: { https: 443, http: 80 },
  image: "local-build",
};
const bucket = {
  provider: "hetzner",
  bucket: "acme-web-files",
  region: "fsn1",
  expected: { storageGb: 10, egressGbPerMonth: 5 },
  price: { monthly: 4.99, currency: "EUR", source: "hetzner.com", checkedOn: "2026-11-01" },
} as const;
const versions = { prometheus: "3.15.1", loki: "3.7.9", grafana: "13.3.0", alloy: "1.21.3" };
const retention = { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 };

/** The fixture's plan moving from `from` (its target by default), with `extra` in the record. */
async function moving(
  from: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const plan = await serverPlan();
  return {
    ...plan,
    retarget: {
      from: { target: from ?? plan.target },
      step: "started",
      startedAt: plan.createdAt,
      ...extra,
    },
    ...overrides,
  };
}

/** The same site plan as serverless.test.ts: no services, the domain on Cloudflare. */
async function sitePlan(target: Record<string, unknown>, retarget: Record<string, unknown>) {
  const plan = await serverPlan();
  const github = target.provider === "github-pages";
  return {
    ...plan,
    app: { ...plan.app, name: "example-app", env: [] },
    target,
    services: [],
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-21T00:00:00.000Z",
    },
    dns: { ...plan.dns, proxied: !github },
    security: { ...plan.security, wafCustomRules: !github },
    deployment: { url: "https://app.example.com" },
    retarget: { step: "started", startedAt: plan.createdAt, ...retarget },
  };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("the move's old and new targets", () => {
  it("moves between any two server targets: cloud, own and Portainer", async () => {
    const plan = await serverPlan();
    const servers = [plan.target, own, portainer(), portainer({ mode: "tunnel" })];
    for (const from of servers) {
      for (const to of servers) {
        const parsed = DeployPlanSchema.safeParse(await moving(from, {}, { target: to }));
        expect(parsed.error?.issues, `${from.provider} to ${to.provider}`).toBeUndefined();
      }
    }
    const fromOwn = DeployPlanSchema.parse(await moving(own));
    expect(fromOwn.retarget?.from.target).toEqual({ ...own, edge: "caddy" });
    const fromPortainer = DeployPlanSchema.parse(await moving(portainer()));
    expect(fromPortainer.retarget?.from.target).toEqual(portainer());
  });

  it("moves a site between Cloudflare's hosting and GitHub Pages", async () => {
    for (const [from, to] of [
      [workers, pages],
      [pages, workers],
    ] as const) {
      const parsed = DeployPlanSchema.parse(await sitePlan(to, { from: { target: from } }));
      expect(parsed.retarget?.from.target).toEqual(
        from === workers ? { ...workers, workersDev: false, previewUrls: false } : pages,
      );
    }
  });

  it("fills a cloud target's image, and keeps a cloud-to-cloud move as it was", async () => {
    const plan = await serverPlan();
    const { image: _image, ...previous } = plan.target as typeof plan.target & { image: string };
    const parsed = DeployPlanSchema.parse(
      await moving(previous, {}, { target: { ...previous, provider: "digitalocean" } }),
    );
    expect(parsed.retarget).toEqual({
      from: {
        target: { ...previous, image: "ubuntu-24.04" },
        deploy: { strategy: "rolling", drainSeconds: 30 },
      },
      step: "started",
      empty: [],
      startedAt: plan.createdAt,
    });
  });

  it("still refuses this computer, on either side", async () => {
    const to = DeployPlanSchema.safeParse(
      await moving(undefined, {}, { target: localhost, dns: { provider: "none", proxied: false } }),
    );
    expect(issues(to)).toContainEqual({
      path: "retarget",
      message: "moving an app to or from the localhost target is not available",
    });
    const from = issues(DeployPlanSchema.safeParse(await moving(localhost)));
    expect(from?.map((i) => i.path)).toEqual(["retarget.from.target.provider"]);
  });
});

describe("the bucket's move", () => {
  it("records the bucket being left, in the shape of storage.objectStorage", async () => {
    const plan = await serverPlan();
    const storage = { objectStorage: { ...bucket, provider: "digitalocean", region: "fra1" } };
    const kept = DeployPlanSchema.parse(await moving(undefined, {}, { storage }));
    expect(kept.retarget?.from.objectStorage).toBeUndefined();
    const left = (objectStorage: Record<string, unknown>) =>
      moving(undefined, { from: { target: plan.target, objectStorage } }, { storage });
    expect(DeployPlanSchema.parse(await left(bucket)).retarget?.from.objectStorage).toEqual({
      ...bucket,
      cors: false,
    });
    const withKey = DeployPlanSchema.safeParse(await left({ ...bucket, accessKey: "x" }));
    expect(issues(withKey)?.map((i) => i.path)).toEqual(["retarget.from.objectStorage"]);
  });
});

describe("the old app server's network member", () => {
  it("records the old member in the shape of the network's members", async () => {
    const plan = await serverPlan();
    const member = { name: "app", address: "10.200.4.2", port: 51820, publicKey: key() };
    const left = (value: Record<string, unknown>) =>
      moving(undefined, { from: { target: plan.target, member: value } });
    expect(DeployPlanSchema.parse(await left(member)).retarget?.from.member).toEqual(member);
    const bad = DeployPlanSchema.safeParse(await left({ ...member, address: "not-an-address" }));
    expect(issues(bad)?.map((i) => i.path)).toEqual(["retarget.from.member.address"]);
  });

  it("moves an app with extra servers: only its app server moves", async () => {
    const plan = await serverPlan();
    const split = {
      ...plan,
      services: plan.services.map((s) => ({ ...s, server: "data" })),
      servers: [
        {
          name: "data",
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
        range: "10.200.4.0/24",
        members: [
          { name: "app", address: "10.200.4.4", port: 51820, publicKey: key() },
          { name: "data", address: "10.200.4.3", port: 51820, publicKey: key() },
        ],
      },
    };
    const member = { name: "app", address: "10.200.4.2", port: 51820, publicKey: key() };
    const record = {
      ...split,
      retarget: {
        from: { target: plan.target, member },
        step: "created",
        startedAt: plan.createdAt,
      },
    };
    expect(DeployPlanSchema.safeParse(record).error?.issues).toBeUndefined();
  });
});

describe("the services started empty", () => {
  it("is empty unless the move names some", async () => {
    const parsed = DeployPlanSchema.parse(await moving(undefined));
    expect(parsed.retarget?.empty).toEqual([]);
    expectTypeOf<Retarget["empty"]>().toEqualTypeOf<string[]>();
  });

  it("names enabled services on the app's server, and app for the app's own volumes", async () => {
    const parsed = DeployPlanSchema.parse(await moving(undefined, { empty: ["db", "app"] }));
    expect(parsed.retarget?.empty).toEqual(["db", "app"]);
  });

  it("refuses a name that is no enabled service on the app's server", async () => {
    const plan = await serverPlan();
    const off = plan.services.map((s) => ({ ...s, enabled: false }));
    const cases = [
      [{}, "cache", 'names no service of the plan: "cache"'],
      [{ services: off }, "db", 'names the service "db", which is turned off'],
    ] as const;
    for (const [overrides, name, start] of cases) {
      const result = DeployPlanSchema.safeParse(
        await moving(undefined, { empty: [name] }, overrides),
      );
      const found = issues(result);
      expect(
        found?.map((i) => i.path),
        name,
      ).toEqual(["retarget.empty.0"]);
      expect(found?.[0]?.message.startsWith(start), found?.[0]?.message).toBe(true);
    }
  });

  it("refuses a service on an extra server, which stays where it is", async () => {
    const plan = await serverPlan();
    const split = {
      services: plan.services.map((s) => ({ ...s, server: "data" })),
      servers: [
        {
          name: "data",
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
        range: "10.200.4.0/24",
        members: [
          { name: "app", address: "10.200.4.2", port: 51820, publicKey: key() },
          { name: "data", address: "10.200.4.3", port: 51820, publicKey: key() },
        ],
      },
    };
    const result = DeployPlanSchema.safeParse(await moving(undefined, { empty: ["db"] }, split));
    expect(issues(result)).toEqual([
      {
        path: "retarget.empty.0",
        message:
          'names the service "db", which runs on the extra server data and stays there: only the app\'s server moves; remove "db" from retarget.empty',
      },
    ]);
  });

  it("names monitoring only when its stack runs on the app's server", async () => {
    const onApp = {
      observability: {
        monitoring: { enabled: true, where: { kind: "app" }, versions, retention },
      },
    };
    const parsed = DeployPlanSchema.parse(
      await moving(undefined, { empty: ["monitoring"] }, onApp),
    );
    expect(parsed.retarget?.empty).toEqual(["monitoring"]);
    const result = DeployPlanSchema.safeParse(await moving(undefined, { empty: ["monitoring"] }));
    expect(issues(result)).toEqual([
      {
        path: "retarget.empty.0",
        message:
          'can be "monitoring" only while self-hosted monitoring runs on the app\'s server (observability.monitoring.where.kind "app"): on its own server it stays where it is; remove "monitoring" from retarget.empty',
      },
    ]);
  });
});

describe("a Portainer target's DNS records", () => {
  it("records that OpsCrew manages the records of Caddy mode", async () => {
    const plan = await serverPlan();
    for (const records of [true, false]) {
      const web = { mode: "caddy", records };
      const parsed = DeployPlanSchema.parse({ ...plan, target: portainer(web) });
      expect(parsed.target).toEqual(portainer(web));
    }
    const absent = DeployPlanSchema.parse({ ...plan, target: portainer() });
    expect(absent.target).toEqual(portainer());
    for (const web of [
      { mode: "tunnel", records: true },
      { mode: "proxy", port: 8080, records: true },
      { mode: "caddy", records: "yes" },
    ]) {
      const result = DeployPlanSchema.safeParse({ ...plan, target: portainer(web) });
      expect(result.success, JSON.stringify(web)).toBe(false);
    }
  });
});

describe("existing plans", () => {
  it("keep their bytes: a plan without a move gains no field", async () => {
    const text = await readFile(new URL("plan.yaml", FIXTURES), "utf8");
    expect(serializeArtifact("plan", parseArtifact("plan", text, "fixture"))).toBe(text);
  });
});
