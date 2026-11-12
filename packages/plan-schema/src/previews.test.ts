import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { previewPlanOf } from "./__fixtures__/preview-plan";
import {
  DeployPlanSchema,
  PreviewsSchema,
  ProjectFactsSchema,
  parseArtifact,
  serializeArtifact,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

// biome-ignore lint/suspicious/noExplicitAny: a test plan is edited as loose JSON before parsing.
type Loose = Record<string, any>;

/** {@link previewPlanOf} the fixture's prod plan, with `changes` applied. */
async function previewPlan(changes: (plan: Loose) => void = () => {}) {
  const value: Loose = previewPlanOf(parseArtifact("plan", await fixture("plan.yaml"), "fixture"));
  changes(value);
  return value;
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message })) ?? [];
}

/** The one issue of a refused plan: its path, and its message's words that matter. */
async function refused(changes: (plan: Loose) => void) {
  const found = issues(DeployPlanSchema.safeParse(await previewPlan(changes)));
  expect(found).toHaveLength(1);
  return found[0] as { path: string; message: string };
}

describe("environment.previews", () => {
  it("fills its defaults and keeps an explicit seed or none", () => {
    expect(PreviewsSchema.parse({ domain: "app.example.com" })).toEqual({
      cap: 3,
      lifetimeDays: 7,
      domain: "app.example.com",
    });
    const set = { cap: 20, lifetimeDays: 30, domain: "example.com", seed: "npx prisma db seed" };
    expect(PreviewsSchema.parse(set)).toEqual(set);
    expect(PreviewsSchema.parse({ domain: "example.com", seed: null }).seed).toBeNull();
  });

  it("refuses a cap, a lifetime, a domain or a seed outside its rules, naming the field", () => {
    const bad = [
      [{ cap: 0 }, "cap"],
      [{ cap: 21 }, "cap"],
      [{ cap: 2.5 }, "cap"],
      [{ lifetimeDays: 0 }, "lifetimeDays"],
      [{ lifetimeDays: 31 }, "lifetimeDays"],
      [{ domain: "Shop.Example.com" }, "domain"],
      [{ domain: undefined }, "domain"],
      [{ seed: "seed\nrm -rf /" }, "seed"],
      [{ seed: " " }, "seed"],
    ] as const;
    for (const [change, field] of bad) {
      const result = PreviewsSchema.safeParse({ domain: "example.com", ...change });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues.map((i) => i.path.join("."))).toEqual([field]);
    }
    const cap = PreviewsSchema.safeParse({ domain: "example.com", cap: 21 });
    expect(cap.error?.issues[0]?.message).toBe(
      "must be a whole number from 1 to 20: how many previews run at once",
    );
    const lifetime = PreviewsSchema.safeParse({ domain: "example.com", lifetimeDays: 31 });
    expect(lifetime.error?.issues[0]?.message).toBe(
      "must be a whole number of days from 1 to 30: a preview not updated this long is removed",
    );
  });

  it("parses a preview environment's plan with dns.zone and no dns.domain, and round-trips", async () => {
    const plan = DeployPlanSchema.parse(await previewPlan());
    expect(plan.environment?.previews).toEqual({
      cap: 3,
      lifetimeDays: 7,
      domain: "example-previews.com",
    });
    expect(plan.dns.domain).toBeUndefined();
    expect(plan.dns.zone).toBe("example-previews.com");
    expect(plan.dns.proxied).toBe(true);
    expect(plan.security.httpAllowedFrom).toBe("cloudflare");
    expect(parseArtifact("plan", serializeArtifact("plan", plan), "plan.yaml")).toEqual(plan);
    const seeded = DeployPlanSchema.parse(
      await previewPlan((p) => {
        p.environment.previews = {
          cap: 5,
          lifetimeDays: 14,
          domain: "example-previews.com",
          seed: null,
        };
      }),
    );
    expect(seeded.environment?.previews?.seed).toBeNull();
    expect(parseArtifact("plan", serializeArtifact("plan", seeded), "plan.yaml")).toEqual(seeded);
  });

  it("allows previews on a server you own, open to Cloudflare by default", async () => {
    const own = await previewPlan((p) => {
      p.target = { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" };
    });
    expect(DeployPlanSchema.safeParse(own).success).toBe(true);
    const byDefault = await previewPlan((p) => {
      delete p.security.httpAllowedFrom;
    });
    expect(DeployPlanSchema.parse(byDefault).security.httpAllowedFrom).toBe("cloudflare");
  });

  it("parses every plan without previews as before: a Cloudflare plan still needs a domain", async () => {
    const text = await fixture("plan.yaml");
    const plan = parseArtifact("plan", text, "fixture");
    expect(plan.environment).toBeUndefined();
    expect(serializeArtifact("plan", plan)).toBe(
      serializeArtifact("plan", DeployPlanSchema.parse(plan)),
    );
    const { domain: _domain, ...dns } = plan.dns;
    expect(issues(DeployPlanSchema.safeParse({ ...plan, dns }))).toEqual([
      { path: "dns.domain", message: 'is required when dns.provider is "cloudflare"' },
    ]);
    const staging = await previewPlan((p) => {
      p.app.name = "acme-web-staging";
      p.environment = { name: "staging" };
    });
    expect(issues(DeployPlanSchema.safeParse(staging))).toEqual([
      { path: "dns.domain", message: 'is required when dns.provider is "cloudflare"' },
    ]);
  });

  it("refuses a target that is not a server OpsCrew deploys to over SSH", async () => {
    const issue = await refused((p) => {
      p.target = {
        provider: "portainer",
        mode: "portainer-stack",
        environmentId: 3,
        arch: "amd64",
        redeploy: "updater",
        web: { mode: "proxy", port: 8080 },
      };
    });
    expect(issue.path).toBe("target.provider");
    expect(issue.message).toContain(
      'can be "hetzner", "digitalocean", "contabo" or "own" with previews',
    );
  });

  it("refuses a runner or a build other than GitHub's", async () => {
    for (const runner of ["server", "host"] as const) {
      const found = issues(
        DeployPlanSchema.safeParse(
          await previewPlan((p) => {
            p.environment.runner = runner;
            if (runner === "host") p.environment.runnerHost = { name: "box", arch: "amd64" };
          }),
        ),
      );
      expect(found).toContainEqual({
        path: "environment.runner",
        message:
          'must be "github" with previews: each pull request is built and deployed from GitHub\'s machines; set environment.runner to "github"',
      });
    }
    const build = issues(
      DeployPlanSchema.safeParse(
        await previewPlan((p) => {
          p.environment.build = "runner";
        }),
      ),
    );
    expect(build).toContainEqual({
      path: "environment.build",
      message:
        "must be \"github\" or absent with previews: pull requests' code is built only on GitHub's machines, never on a machine of yours; remove environment.build",
    });
    const github = await previewPlan((p) => {
      p.environment.build = "github";
    });
    expect(DeployPlanSchema.safeParse(github).success).toBe(true);
  });

  it("refuses a preview environment promoted from another", async () => {
    const issue = await refused((p) => {
      p.environment.deploySource = { from: "promote", source: "staging" };
    });
    expect(issue).toEqual({
      path: "environment.deploySource.from",
      message:
        'must be "main" with previews: a preview environment deploys pull requests, never an image promoted from another environment; set environment.deploySource.from to "main"',
    });
  });

  it("refuses extra servers", async () => {
    // A server without services also has placement's own issues.
    const found = issues(
      DeployPlanSchema.safeParse(
        await previewPlan((p) => {
          p.servers = [
            {
              name: "data",
              target: {
                provider: "hetzner",
                mode: "vps-compose",
                location: "nbg1",
                serverType: "cpx22",
                backups: false,
              },
            },
          ];
        }),
      ),
    );
    const issue = found.find((i) => i.path === "servers");
    expect(issue?.message).toContain("must be absent with previews");
  });

  it("refuses the add-ons, the check, monitoring, signing and deploy tags", async () => {
    const beszel = await refused((p) => {
      p.observability = { beszel: { enabled: true, version: "0.21.1" } };
    });
    expect(beszel.path).toBe("observability.beszel.enabled");
    expect(beszel.message).toContain("must be false with previews");
    const grafana = await refused((p) => {
      p.observability = {
        grafanaCloud: {
          enabled: true,
          version: "1.10.0",
          metrics: { url: "https://prom.example.com/api/prom/push", user: "1" },
          logs: { url: "https://logs.example.com/loki/api/v1/push", user: "2" },
        },
      };
    });
    expect(grafana.path).toBe("observability.grafanaCloud.enabled");
    const check = await refused((p) => {
      p.observability = { check: { enabled: true } };
    });
    expect(check.path).toBe("observability.check.enabled");
    const monitoring = await refused((p) => {
      p.observability = {
        monitoring: {
          enabled: true,
          where: { kind: "app" },
          versions: { prometheus: "3.5.0", loki: "3.5.0", grafana: "12.1.0", alloy: "1.10.0" },
          retention: { metricsMaxGb: 5 },
        },
      };
    });
    expect(monitoring.path).toBe("observability.monitoring.enabled");
    const sign = await refused((p) => {
      p.supplyChain = { sign: true };
    });
    expect(sign.path).toBe("supplyChain.sign");
    expect(sign.message).toContain("must be false with previews");
    const tags = await refused((p) => {
      p.cicd = { ...p.cicd, deployTags: { enabled: true, release: false } };
    });
    expect(tags.path).toBe("cicd.deployTags.enabled");
    expect(tags.message).toContain("must be false with previews");
    const off = await previewPlan((p) => {
      p.observability = {
        check: { enabled: false },
        beszel: { enabled: false, version: "0.21.1" },
      };
    });
    expect(DeployPlanSchema.safeParse(off).success).toBe(true);
  });

  it("refuses DNS other than a proxied Cloudflare zone without a domain, open to Cloudflare only", async () => {
    const none = await refused((p) => {
      p.dns = { provider: "none", proxied: true, www: false };
    });
    expect(none.path).toBe("dns.provider");
    expect(none.message).toContain('must be "cloudflare" with previews');
    const noZone = await refused((p) => {
      delete p.dns.zone;
    });
    expect(noZone).toEqual({
      path: "dns.zone",
      message:
        "is required with previews: the Cloudflare zone the wildcard record *.example-previews.com goes in; set dns.zone to it",
    });
    const domain = await refused((p) => {
      p.dns.domain = "app.example-previews.com";
    });
    expect(domain).toEqual({
      path: "dns.domain",
      message:
        "must be absent with previews: a preview environment serves no hostname of its own, only pr-<number>-<random>.example-previews.com; remove dns.domain",
    });
    const dnsOnly = await refused((p) => {
      p.dns.proxied = false;
    });
    expect(dnsOnly).toEqual({
      path: "dns.proxied",
      message:
        "must be true with previews: behind Cloudflare's proxy a preview's name is in no public certificate, so nobody finds it without the link; set dns.proxied to true",
    });
    for (const target of [
      undefined,
      { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" },
    ]) {
      const open = await refused((p) => {
        if (target !== undefined) p.target = target;
        p.security.httpAllowedFrom = "any";
      });
      expect(open).toEqual({
        path: "security.httpAllowedFrom",
        message: `must be "cloudflare" with previews: the preview server's web ports accept only Cloudflare, so nobody reaches a preview around the proxy; set security.httpAllowedFrom to "cloudflare"`,
      });
    }
    const www = await refused((p) => {
      p.dns.www = true;
    });
    expect(www.path).toBe("dns.www");
    expect(www.message).toContain("set dns.www to false");
  });

  it("allows a base below the zone, and refuses one outside it, naming both", async () => {
    for (const domain of ["pr.example-previews.com", "a.b.example-previews.com"]) {
      const plan = await previewPlan((p) => {
        p.environment.previews.domain = domain;
      });
      expect(DeployPlanSchema.parse(plan).environment?.previews?.domain).toBe(domain);
    }
    for (const domain of ["app.example.org", "notexample-previews.com"]) {
      const issue = await refused((p) => {
        p.environment.previews.domain = domain;
      });
      expect(issue).toEqual({
        path: "environment.previews.domain",
        message:
          "must be the zone (example-previews.com) or a name below it, such as previews.example-previews.com: the wildcard record goes in that Cloudflare zone; set environment.previews.domain to one of them, or dns.zone to the zone it is in",
      });
    }
  });

  it("allows previews on another environment's server you own, never prod's", async () => {
    const plan = DeployPlanSchema.parse(
      await previewPlan((p) => {
        p.target = { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" };
        p.environment.previews.server = { environment: "dev" };
      }),
    );
    expect(plan.environment?.previews?.server).toEqual({ environment: "dev" });
    expect(parseArtifact("plan", serializeArtifact("plan", plan), "plan.yaml")).toEqual(plan);
    const prod = PreviewsSchema.safeParse({
      domain: "example.com",
      server: { environment: "prod" },
    });
    expect(prod.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message }))).toEqual(
      [
        {
          path: "server.environment",
          message:
            "must not be \"prod\": previews never run on prod's server, as anyone who can push a branch would run code beside prod's data; name another environment, such as dev",
        },
      ],
    );
    for (const server of [{ environment: "Dev" }, { environment: "dev", extra: true }, {}]) {
      expect(PreviewsSchema.safeParse({ domain: "example.com", server }).success).toBe(false);
    }
  });

  it("refuses another environment's server unless the target is a server you own, public", async () => {
    const message =
      'must be "own" with environment.previews.server: previews run on the app server of dev and OpsCrew creates no server for them; set target.provider to "own" with access "public", or remove environment.previews.server to give previews a server of their own';
    const cloud = await refused((p) => {
      p.environment.previews.server = { environment: "dev" };
    });
    expect(cloud).toEqual({ path: "target.provider", message });
    const portainer = await refused((p) => {
      p.environment.previews.server = { environment: "dev" };
      p.target = {
        provider: "portainer",
        mode: "portainer-stack",
        environmentId: 3,
        arch: "amd64",
        redeploy: "updater",
        web: { mode: "proxy", port: 8080 },
      };
    });
    expect(portainer).toEqual({ path: "target.provider", message });
    const tunnel = await refused((p) => {
      p.environment.previews.server = { environment: "dev" };
      p.target = { provider: "own", mode: "vps-compose", arch: "amd64", access: "tunnel" };
    });
    expect(tunnel.path).toBe("target.access");
    expect(tunnel.message).toContain('must be "public" with previews');
  });

  it("refuses an app name longer than 31 characters", async () => {
    const ok = await previewPlan((p) => {
      p.app.name = `${"a".repeat(23)}-preview`;
    });
    expect(DeployPlanSchema.safeParse(ok).success).toBe(true);
    const issue = await refused((p) => {
      p.app.name = `${"a".repeat(24)}-preview`;
    });
    expect(issue).toEqual({
      path: "app.name",
      message:
        "must be at most 31 characters with previews: each preview's app is named <app.name>-pr-<number>, which must fit in 41; shorten the app's or the environment's name",
    });
  });

  it("refuses a server you own behind a tunnel, with its own message", async () => {
    const issue = await refused((p) => {
      p.target = { provider: "own", mode: "vps-compose", arch: "amd64", access: "tunnel" };
    });
    expect(issue.path).toBe("target.access");
    expect(issue.message).toContain(
      'must be "public" with previews: previews need a server with a public address',
    );
  });

  it("refuses an OpenLiteSpeed edge too", async () => {
    const issue = await refused((p) => {
      (p.target as { edge?: string }).edge = "openlitespeed";
    });
    expect(issue.path).toBe("target.edge");
    expect(issue.message).toContain('must be "caddy" with previews');
  });

  it("refuses an nginx edge: each preview's site is a Caddy site", async () => {
    const issue = await refused((p) => {
      (p.target as { edge?: string }).edge = "nginx";
    });
    expect(issue.path).toBe("target.edge");
    expect(issue.message).toContain('must be "caddy" with previews');
  });

  it("refuses previews in prod's plan", async () => {
    const plan = await previewPlan((p) => {
      p.app.name = "acme-web";
      p.environment = { previews: { domain: "example-previews.com" } };
    });
    expect(issues(DeployPlanSchema.safeParse(plan))).toEqual([
      {
        path: "environment.previews",
        message:
          "is only for a named environment: prod's plan can't hold previews; add a preview environment with opscrew env add preview --previews",
      },
    ]);
  });
});

describe("facts.build seed command and note", () => {
  it("are optional: a one-line command, and a note in words", async () => {
    const { facts } = JSON.parse(await fixture("architecture.json"));
    const parsed = ProjectFactsSchema.parse(facts);
    expect(parsed.build.seedCommand).toBeUndefined();
    expect(parsed.build.seedNote).toBeUndefined();
    const build = { ...facts.build, seedCommand: "php artisan db:seed --force" };
    expect(ProjectFactsSchema.parse({ ...facts, build }).build.seedCommand).toBe(
      "php artisan db:seed --force",
    );
    const seedNote = "Django has no seed command: set one with --seed.";
    const noted = ProjectFactsSchema.parse({ ...facts, build: { ...facts.build, seedNote } });
    expect(noted.build.seedNote).toBe(seedNote);
    for (const bad of ["", "   ", "seed\nrm -rf /"]) {
      const wrong = { ...facts, build: { ...facts.build, seedCommand: bad } };
      const result = ProjectFactsSchema.safeParse(wrong);
      expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["build.seedCommand"]);
    }
    const empty = ProjectFactsSchema.safeParse({
      ...facts,
      build: { ...facts.build, seedNote: "" },
    });
    expect(empty.error?.issues.map((i) => i.path.join("."))).toEqual(["build.seedNote"]);
  });
});
