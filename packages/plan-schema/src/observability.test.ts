// Feature 017: `plan.observability`, the scheduled check and the Beszel and Grafana Cloud add-ons
// (T1701a, ADR 0021).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type BeszelSettings,
  DeployPlanSchema,
  type GrafanaCloudSettings,
  type Observability,
  parseArtifact,
  serializeArtifact,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

/** The fixture's plan: on Hetzner, with the domain app.example.com in the zone example.com. */
async function serverPlan(overrides: Record<string, unknown> = {}) {
  const text = await readFile(new URL("plan.yaml", FIXTURES), "utf8");
  return { ...parseArtifact("plan", text, "fixture"), ...overrides };
}

/** A hub public key as Beszel shows it, made up at runtime. */
function hubKey(): string {
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const blob = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(randomBytes(32))]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

const endpoint = (path: string) => ({ url: `https://stack.grafana.net${path}`, user: "123456" });
const grafana = {
  enabled: true,
  version: "1.21.0",
  metrics: endpoint("/api/prom/push"),
  logs: endpoint("/loki/api/v1/push"),
};

const portainerTarget = {
  provider: "portainer",
  mode: "portainer-stack",
  environmentId: 2,
  arch: "amd64",
  redeploy: "updater",
  web: { mode: "caddy" },
} as const;
const localhostTarget = {
  provider: "localhost",
  mode: "local-compose",
  arch: "arm64",
  ports: { https: 443, http: 80 },
  image: "local-build",
} as const;

/** The fixture's plan moved to the localhost target, with no DNS and no URL. */
async function localPlan(observability: unknown) {
  const plan = await serverPlan();
  const { url: _url, ...deployment } = plan.deployment;
  return {
    ...plan,
    target: localhostTarget,
    dns: { provider: "none", proxied: false, www: false },
    deployment,
    observability,
  };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

function paths(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  return issues(result)?.map((issue) => issue.path);
}

describe("plan.observability", () => {
  it("is absent (everything off) unless the plan sets it, and adds nothing to a plan's file", async () => {
    const parsed = DeployPlanSchema.parse(await serverPlan());
    expect(parsed.observability).toBeUndefined();
    expect(serializeArtifact("plan", parsed)).not.toContain("observability");
    expect(DeployPlanSchema.parse(await serverPlan({ observability: {} })).observability).toEqual(
      {},
    );
    expectTypeOf<Observability["check"]>().toEqualTypeOf<
      | {
          enabled?: boolean | undefined;
          intervalMinutes?: 5 | 10 | 15 | 20 | 30 | 60 | undefined;
          webhook?: "slack" | "discord" | "ntfy" | undefined;
        }
      | undefined
    >();
  });

  it("fills Beszel's and Grafana Cloud's defaults", async () => {
    const parsed = DeployPlanSchema.parse(
      await serverPlan({
        observability: { beszel: { version: "0.21.0" }, grafanaCloud: { version: "1.21.0" } },
      }),
    );
    expect(parsed.observability).toEqual({
      beszel: {
        enabled: false,
        version: "0.21.0",
        mode: "hub",
        access: "local",
        memoryMb: { hub: 128, agent: 64, proxy: 32 },
      },
      grafanaCloud: {
        enabled: false,
        version: "1.21.0",
        logSampling: 100,
        memoryMb: { alloy: 192, proxy: 32 },
      },
    });
    expectTypeOf<BeszelSettings["memoryMb"]>().toEqualTypeOf<{
      hub: number;
      agent: number;
      proxy: number;
    }>();
    expectTypeOf<GrafanaCloudSettings["memoryMb"]>().toEqualTypeOf<{
      alloy: number;
      proxy: number;
    }>();
  });

  it("round-trips a plan with all three blocks through plan.yaml unchanged", async () => {
    const observability = {
      check: { enabled: true, intervalMinutes: 30, webhook: "ntfy" },
      beszel: {
        enabled: true,
        version: "0.21.0",
        mode: "hub",
        access: "subdomain",
        hostname: "beszel.example.com",
        allowedEmails: ["ops@example.com"],
        memoryMb: { hub: 160, agent: 64, proxy: 32 },
      },
      grafanaCloud: { ...grafana, logSampling: 25, memoryMb: { alloy: 256, proxy: 32 } },
    };
    const plan = DeployPlanSchema.parse(await serverPlan({ observability }));
    expect(plan.observability).toEqual(observability);
    const text = serializeArtifact("plan", plan);
    expect(text).toContain("observability:\n  check:\n    enabled: true");
    expect(parseArtifact("plan", text, "plan.yaml")).toEqual(plan);
    expect(serializeArtifact("plan", parseArtifact("plan", text, "plan.yaml"))).toBe(text);
  });

  it("accepts Beszel in agent mode with the hub's address and key", async () => {
    const beszel = {
      enabled: true,
      version: "0.21.0",
      mode: "agent",
      hubUrl: "https://beszel.example.org",
      hubKey: hubKey(),
    };
    const parsed = DeployPlanSchema.parse(await serverPlan({ observability: { beszel } }));
    expect(parsed.observability?.beszel).toMatchObject(beszel);
  });
});

describe("the scheduled check's fields", () => {
  it("accepts each interval and webhook kind, in any plan", async () => {
    for (const intervalMinutes of [5, 10, 15, 20, 30, 60]) {
      for (const webhook of ["slack", "discord", "ntfy"]) {
        const check = { enabled: false, intervalMinutes, webhook };
        const plan = await serverPlan({
          environment: { name: "staging" },
          app: { ...(await serverPlan()).app, name: "acme-web-staging" },
          observability: { check },
        });
        expect(DeployPlanSchema.parse(plan).observability?.check).toEqual(check);
      }
    }
  });

  it("refuses another interval or webhook kind with the allowed values", async () => {
    const result = DeployPlanSchema.safeParse(
      await serverPlan({ observability: { check: { intervalMinutes: 45, webhook: "teams" } } }),
    );
    expect(issues(result)).toEqual([
      {
        path: "observability.check.intervalMinutes",
        message: "must be 5, 10, 15, 20, 30 or 60 (minutes)",
      },
      { path: "observability.check.webhook", message: 'must be "slack", "discord" or "ntfy"' },
    ]);
  });
});

describe("Beszel's settings", () => {
  const beszel = (fields: Record<string, unknown>) =>
    serverPlan({ observability: { beszel: { enabled: true, version: "0.21.0", ...fields } } });

  it("needs a hostname and at least one email for a subdomain, as Portainer's", async () => {
    expect(issues(DeployPlanSchema.safeParse(await beszel({ access: "subdomain" })))).toEqual([
      {
        path: "observability.beszel.hostname",
        message: 'is required when access is "subdomain"',
      },
      {
        path: "observability.beszel.allowedEmails",
        message: 'must list at least one email address when access is "subdomain"',
      },
    ]);
    const noEmails = { access: "subdomain", hostname: "beszel.example.com", allowedEmails: [] };
    expect(paths(DeployPlanSchema.safeParse(await beszel(noEmails)))).toEqual([
      "observability.beszel.allowedEmails",
    ]);
  });

  it("refuses a hostname or emails without a subdomain", async () => {
    const result = DeployPlanSchema.safeParse(
      await beszel({ hostname: "beszel.example.com", allowedEmails: ["ops@example.com"] }),
    );
    expect(issues(result)).toEqual([
      {
        path: "observability.beszel.hostname",
        message: 'is only allowed when access is "subdomain"',
      },
      {
        path: "observability.beszel.allowedEmails",
        message: 'is only allowed when access is "subdomain"',
      },
    ]);
  });

  it("checks the subdomain against the app's Cloudflare zone and its edge certificate", async () => {
    const subdomain = (hostname: string) => ({
      access: "subdomain",
      hostname,
      allowedEmails: ["ops@example.com"],
    });
    expect(issues(DeployPlanSchema.safeParse(await beszel(subdomain("beszel.other.com"))))).toEqual(
      [
        {
          path: "observability.beszel.hostname",
          message: "must be a subdomain of example.com, the app's Cloudflare zone",
        },
      ],
    );
    expect(paths(DeployPlanSchema.safeParse(await beszel(subdomain("app.example.com"))))).toEqual([
      "observability.beszel.hostname",
    ]);
    expect(
      paths(DeployPlanSchema.safeParse(await beszel(subdomain("beszel.ops.example.com")))),
    ).toEqual(["observability.beszel.hostname"]);
    const noCloudflare = {
      ...(await beszel(subdomain("beszel.example.com"))),
      dns: { provider: "none", proxied: false, www: false },
      deployment: {},
      security: { ...(await serverPlan()).security, httpAllowedFrom: "any" },
    };
    expect(issues(DeployPlanSchema.safeParse(noCloudflare))).toEqual([
      {
        path: "observability.beszel.access",
        message:
          'can be "subdomain" only when dns.provider is "cloudflare": the subdomain is served through Cloudflare',
      },
    ]);
  });

  it("needs the hub's address and key in agent mode, and refuses them in hub mode", async () => {
    expect(issues(DeployPlanSchema.safeParse(await beszel({ mode: "agent" })))).toEqual([
      {
        path: "observability.beszel.hubUrl",
        message: 'is required in "agent" mode: the agent connects out to your hub',
      },
      {
        path: "observability.beszel.hubKey",
        message: 'is required in "agent" mode: the agent connects out to your hub',
      },
    ]);
    const hub = { hubUrl: "https://beszel.example.org", hubKey: hubKey() };
    expect(issues(DeployPlanSchema.safeParse(await beszel(hub)))).toEqual([
      {
        path: "observability.beszel.hubUrl",
        message: 'is "agent" mode only: in "hub" mode the hub runs on this server',
      },
      {
        path: "observability.beszel.hubKey",
        message: 'is "agent" mode only: in "hub" mode the hub runs on this server',
      },
    ]);
  });

  it("refuses a subdomain in agent mode", async () => {
    const result = DeployPlanSchema.safeParse(
      await beszel({
        mode: "agent",
        hubUrl: "https://beszel.example.org",
        hubKey: hubKey(),
        access: "subdomain",
        hostname: "beszel.example.com",
        allowedEmails: ["ops@example.com"],
      }),
    );
    expect(issues(result)).toEqual([
      {
        path: "observability.beszel.access",
        message:
          'is for "hub" mode only: in "agent" mode the dashboard is your own hub; leave access out, or use mode "hub"',
      },
    ]);
  });

  it("refuses a hub address that is not https and a key that is not the hub's", async () => {
    const result = DeployPlanSchema.safeParse(
      await beszel({
        mode: "agent",
        hubUrl: "http://beszel.example.org",
        hubKey: "ssh-rsa AAAAB3NzaC1yc2E",
      }),
    );
    expect(issues(result)).toEqual([
      { path: "observability.beszel.hubUrl", message: "must be an https:// URL" },
      {
        path: "observability.beszel.hubKey",
        message: "must be the hub's public key as Beszel shows it: ssh-ed25519 AAAA…",
      },
    ]);
  });

  it("needs a pinned version and positive memory limits", async () => {
    const result = DeployPlanSchema.safeParse(
      await serverPlan({
        observability: { beszel: { version: "latest", memoryMb: { hub: 0, agent: 1.5 } } },
      }),
    );
    expect(paths(result)).toEqual([
      "observability.beszel.version",
      "observability.beszel.memoryMb.hub",
      "observability.beszel.memoryMb.agent",
    ]);
  });
});

describe("Grafana Cloud's settings", () => {
  const withGrafana = (fields: Record<string, unknown>) =>
    serverPlan({ observability: { grafanaCloud: fields } });

  it("needs the stack's metrics and logs endpoints when enabled", async () => {
    const result = DeployPlanSchema.safeParse(
      await withGrafana({ enabled: true, version: "1.21.0" }),
    );
    expect(issues(result)).toEqual([
      {
        path: "observability.grafanaCloud.metrics",
        message: "is required when enabled: the stack's Prometheus URL and user id",
      },
      {
        path: "observability.grafanaCloud.logs",
        message: "is required when enabled: the stack's Loki URL and user id",
      },
    ]);
    expect(
      DeployPlanSchema.safeParse(await withGrafana({ enabled: false, version: "1.21.0" })).success,
    ).toBe(true);
  });

  it("refuses an endpoint that is not https or a user id that is not a number", async () => {
    const result = DeployPlanSchema.safeParse(
      await withGrafana({
        ...grafana,
        metrics: { url: "http://stack.grafana.net/api/prom/push", user: "123456" },
        logs: { url: "https://stack.grafana.net/loki/api/v1/push", user: "admin" },
      }),
    );
    expect(issues(result)).toEqual([
      { path: "observability.grafanaCloud.metrics.url", message: "must be an https:// URL" },
      {
        path: "observability.grafanaCloud.logs.user",
        message: "must be the stack's numeric user id",
      },
    ]);
  });

  it("keeps the log sampling between 1 and 100 percent", async () => {
    for (const logSampling of [1, 50, 100]) {
      const plan = DeployPlanSchema.parse(await withGrafana({ ...grafana, logSampling }));
      expect(plan.observability?.grafanaCloud?.logSampling).toBe(logSampling);
    }
    for (const logSampling of [0, 101, 12.5]) {
      const result = DeployPlanSchema.safeParse(await withGrafana({ ...grafana, logSampling }));
      expect(paths(result), String(logSampling)).toEqual([
        "observability.grafanaCloud.logSampling",
      ]);
    }
  });
});

describe("where the add-ons and the check run", () => {
  const beszel = { enabled: true, version: "0.21.0" };
  const why =
    "Beszel and Grafana Cloud run on a server OpsCrew deploys to (a cloud server or your own)";

  it("accepts the add-ons on a cloud server and on your own server", async () => {
    const own = { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" };
    for (const target of [undefined, own]) {
      const plan = await serverPlan({
        ...(target ? { target } : {}),
        observability: { beszel, grafanaCloud: grafana },
      });
      expect(DeployPlanSchema.safeParse(plan).success, target?.provider ?? "hetzner").toBe(true);
    }
  });

  it("refuses an add-on turned on in a Portainer, on localhost or without a server", async () => {
    const portainer = DeployPlanSchema.safeParse(
      await serverPlan({
        target: portainerTarget,
        observability: { beszel, grafanaCloud: grafana },
      }),
    );
    expect(issues(portainer)).toEqual([
      {
        path: "observability.beszel.enabled",
        message: `can be true only on a server: ${why}; set observability.beszel.enabled to false, or choose a server target for Beszel`,
      },
      {
        path: "observability.grafanaCloud.enabled",
        message: `can be true only on a server: ${why}; set observability.grafanaCloud.enabled to false, or choose a server target for Grafana Cloud`,
      },
    ]);
    const local = DeployPlanSchema.safeParse(await localPlan({ grafanaCloud: grafana }));
    expect(issues(local)?.[0]?.message).toContain(why);
    expect(paths(local)).toEqual(["observability.grafanaCloud.enabled"]);
  });

  it("accepts an add-on that is off on any target", async () => {
    const off = { beszel: { ...beszel, enabled: false } };
    expect(DeployPlanSchema.safeParse(await localPlan(off)).success).toBe(true);
  });

  it("refuses the check on localhost, since GitHub can't reach your computer", async () => {
    expect(
      issues(DeployPlanSchema.safeParse(await localPlan({ check: { enabled: true } }))),
    ).toEqual([
      {
        path: "observability.check.enabled",
        message:
          "must be false with the localhost target: GitHub can't reach your computer, so the scheduled check could never see the app; set observability.check.enabled to false",
      },
    ]);
    expect(DeployPlanSchema.safeParse(await localPlan({ check: { enabled: false } })).success).toBe(
      true,
    );
    const portainer = await serverPlan({
      target: portainerTarget,
      observability: { check: { enabled: true } },
    });
    expect(DeployPlanSchema.safeParse(portainer).success).toBe(true);
  });
});
