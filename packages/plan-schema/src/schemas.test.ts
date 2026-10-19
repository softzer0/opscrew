import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Currency, Money, PhaseName } from "@opscrew/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  ArchitectureSchema,
  type ArtifactError,
  type ArtifactKind,
  type CloudDeployTarget,
  CloudProviderSchema,
  CostEstimateSchema,
  type CurrencySchema,
  cloudflareEdgeCoverage,
  DEFAULT_IMAGES,
  type DeployPlan,
  DeployPlanSchema,
  DeployProviderSchema,
  type DeployTarget,
  type DesignOption,
  DesignOptionListSchema,
  DesignOptionSchema,
  likelyCloudflareZone,
  type Money as MoneyExport,
  type MoneySchema,
  type OwnDeployTarget,
  type PhaseNameSchema,
  PORTAINER_TARGET_NO_MOVE,
  type PortainerDeployTarget,
  type ProjectFacts,
  ProjectFactsSchema,
  parseArtifact,
  QuestionSchema,
  RepoPathSchema,
  RequirementsSchema,
  ServiceKindSchema,
  serializeArtifact,
  VpsProviderSchema,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

function issuesOf(kind: ArtifactKind, text: string) {
  try {
    parseArtifact(kind, text, "fixture");
  } catch (error) {
    return (error as ArtifactError).issues;
  }
  throw new Error("expected the fixture to be rejected");
}

/** The target as a Hetzner/DigitalOcean target; fails the test for an own server or Portainer. */
function cloud(target: DeployTarget): CloudDeployTarget {
  if (target.provider === "own" || target.provider === "portainer") {
    throw new Error("expected a Hetzner or DigitalOcean target");
  }
  return target;
}

function pathsOf(result: { success: boolean; error?: z.ZodError }) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => i.path.join(".")) ?? [];
}

describe("types", () => {
  it("re-uses the contract types where identical", () => {
    expectTypeOf<z.infer<typeof MoneySchema>>().toEqualTypeOf<Money>();
    expectTypeOf<MoneyExport>().toEqualTypeOf<Money>();
    expectTypeOf<z.infer<typeof CurrencySchema>>().toEqualTypeOf<Currency>();
    expectTypeOf<z.infer<typeof PhaseNameSchema>>().toEqualTypeOf<PhaseName>();
  });

  it("keeps the exact enum values of data-model.md", () => {
    expect(ServiceKindSchema.options).toEqual([
      "postgres",
      "mysql",
      "mongodb",
      "redis",
      "sqlite",
      "supabase",
      "firebase",
      "s3",
      "stripe",
      "email",
      "queue",
      "websocket",
      "cron",
    ]);
  });
});

describe("cross-field rules reject violating fixtures with a dotted path", () => {
  it.each([
    ["plan", "plan-cloudflare-without-domain.yaml", "dns.domain"],
    ["plan", "plan-postgres-with-supabase.yaml", "externalServices.1"],
    ["plan", "plan-cost-mismatch.yaml", "cost.monthly.amount"],
    ["plan", "plan-cost-currency-mismatch.yaml", "cost.breakdown.2.monthly.currency"],
    ["requirements", "requirements-dns-without-domain.yaml", "domain"],
  ] as const)("%s %s → %s", async (kind, name, path) => {
    const issues = issuesOf(kind, await fixture(`invalid/${name}`));
    expect(issues.map((i) => i.path)).toEqual([path]);
    expect(issues[0]?.message).not.toBe("");
  });

  it("accepts a breakdown that differs from the total only by rounding", () => {
    const cost = {
      monthly: { amount: 10, currency: "EUR" },
      breakdown: [
        { item: "a", monthly: { amount: 3.333, currency: "EUR" } },
        { item: "b", monthly: { amount: 6.66, currency: "EUR" } },
      ],
      pricesIncludeVat: true,
      source: "static",
      asOf: "2026-10-01T00:00:00Z",
    };
    expect(CostEstimateSchema.safeParse(cost).success).toBe(true);
    expect(
      pathsOf(
        CostEstimateSchema.safeParse({
          ...cost,
          monthly: { amount: 10.02, currency: "EUR" },
        }),
      ),
    ).toEqual(["monthly.amount"]);
  });

  it("allows dnsProvider other/none rules on requirements", async () => {
    const base = parseArtifact("requirements", await fixture("requirements.yaml"), "r.yaml");
    const { domain: _domain, ...withoutDomain } = base;
    expect(RequirementsSchema.safeParse({ ...withoutDomain, dnsProvider: "none" }).success).toBe(
      true,
    );
    expect(
      pathsOf(RequirementsSchema.safeParse({ ...withoutDomain, dnsProvider: "other" })),
    ).toEqual(["domain"]);
    expect(
      pathsOf(
        RequirementsSchema.safeParse({ ...base, budgetMonthly: { amount: 0, currency: "EUR" } }),
      ),
    ).toEqual(["budgetMonthly.amount"]);
    expect(pathsOf(RequirementsSchema.safeParse({ ...base, domain: "App.Example.com" }))).toEqual([
      "domain",
    ]);
  });
});

describe("ProjectFacts", () => {
  async function facts(): Promise<ProjectFacts> {
    return ArchitectureSchema.parse(JSON.parse(await fixture("architecture.json"))).facts;
  }

  it("requires sorted unique languages, env vars and services", async () => {
    const f = await facts();
    expect(
      pathsOf(ProjectFactsSchema.safeParse({ ...f, languages: ["typescript", "javascript"] })),
    ).toEqual(["languages.1"]);
    expect(pathsOf(ProjectFactsSchema.safeParse({ ...f, languages: ["go", "go"] }))).toEqual([
      "languages.1",
    ]);
    expect(
      pathsOf(ProjectFactsSchema.safeParse({ ...f, envVars: [...f.envVars].reverse() })),
    ).toEqual(["envVars.1"]);
    const dup = f.services[0];
    expect(pathsOf(ProjectFactsSchema.safeParse({ ...f, services: [...f.services, dup] }))).toEqual(
      ["services.2.kind"],
    );
  });

  it("records whether an env var has a default in the code (absent means it has none)", async () => {
    const f = await facts();
    const [first, ...rest] = f.envVars;
    if (!first) throw new Error("fixture has no env vars");
    const withDefault = { ...f, envVars: [{ ...first, hasDefault: true }, ...rest] };
    expect(ProjectFactsSchema.parse(withDefault).envVars[0]?.hasDefault).toBe(true);
    expect(ProjectFactsSchema.parse(f).envVars[0]?.hasDefault).toBeUndefined();
    const wrong = { ...f, envVars: [{ ...first, hasDefault: "yes" }, ...rest] };
    expect(pathsOf(ProjectFactsSchema.safeParse(wrong))).toEqual(["envVars.0.hasDefault"]);
  });

  it("records only the kind of URL scheme an example env file gives a variable", async () => {
    const f = await facts();
    const [first, ...rest] = f.envVars;
    if (!first) throw new Error("fixture has no env vars");
    const withScheme = { ...f, envVars: [{ ...first, urlScheme: "redis" }, ...rest] };
    expect(ProjectFactsSchema.parse(withScheme).envVars[0]?.urlScheme).toBe("redis");
    expect(ProjectFactsSchema.parse(f).envVars[0]?.urlScheme).toBeUndefined();
    const value = { ...f, envVars: [{ ...first, urlScheme: "redis://cache:6379" }, ...rest] };
    expect(pathsOf(ProjectFactsSchema.safeParse(value))).toEqual(["envVars.0.urlScheme"]);
  });

  it("needs the app directory: an architecture.json without facts.appDir is refused", async () => {
    const architecture = JSON.parse(await fixture("architecture.json"));
    const { appDir: _appDir, ...noAppDir } = architecture.facts;
    expect(pathsOf(ArchitectureSchema.safeParse({ ...architecture, facts: noAppDir }))).toEqual([
      "facts.appDir",
    ]);
  });

  it("records an optional one-line release command", async () => {
    const f = await facts();
    expect(ProjectFactsSchema.parse(f).build.releaseCommand).toBeUndefined();
    const command = "cd backend && python manage.py migrate --noinput";
    const withRelease = { ...f, build: { ...f.build, releaseCommand: command } };
    expect(ProjectFactsSchema.parse(withRelease).build.releaseCommand).toBe(command);
    for (const bad of ["", "   ", "a\nb"]) {
      const wrong = { ...f, build: { ...f.build, releaseCommand: bad } };
      expect(pathsOf(ProjectFactsSchema.safeParse(wrong)), bad).toEqual(["build.releaseCommand"]);
    }
  });

  it("records an optional note on migrations without a release command", async () => {
    const f = await facts();
    expect(ProjectFactsSchema.parse(f).build.releaseNote).toBeUndefined();
    const releaseNote = { text: "Strapi runs them when it starts.", atStartup: true };
    const withNote = { ...f, build: { ...f.build, releaseNote } };
    expect(ProjectFactsSchema.parse(withNote).build.releaseNote).toEqual(releaseNote);
    for (const bad of [
      { text: "", atStartup: true },
      { text: "x" },
      { ...releaseNote, extra: 1 },
    ]) {
      const wrong = { ...f, build: { ...f.build, releaseNote: bad } };
      expect(pathsOf(ProjectFactsSchema.safeParse(wrong))[0], JSON.stringify(bad)).toMatch(
        /^build\.releaseNote/,
      );
    }
  });

  it("records optional notes on what OpsCrew deploys", async () => {
    const f = await facts();
    expect(ProjectFactsSchema.parse(f).notes).toBeUndefined();
    const notes = ["Only the api side is deployed."];
    expect(ProjectFactsSchema.parse({ ...f, notes }).notes).toEqual(notes);
    for (const bad of [[], [""]]) {
      expect(pathsOf(ProjectFactsSchema.safeParse({ ...f, notes: bad }))[0]).toMatch(/^notes/);
    }
  });

  it("rejects credentials in the git remote URL and env var values as names", async () => {
    const f = await facts();
    const withToken = {
      ...f,
      git: { ...f.git, remoteUrl: "https://x-access-token:ghp_FAKEFAKEFAKE@github.com/a/b.git" },
    };
    expect(pathsOf(ProjectFactsSchema.safeParse(withToken))).toEqual(["git.remoteUrl"]);
    expect(
      ProjectFactsSchema.safeParse({ ...f, git: { ...f.git, remoteUrl: "git@github.com:a/b.git" } })
        .success,
    ).toBe(true);
    const leaked = f.envVars.map((v, i) =>
      i === 0 ? { ...v, name: "DATABASE_URL=postgres://x" } : v,
    );
    expect(pathsOf(ProjectFactsSchema.safeParse({ ...f, envVars: leaked }))).toContain(
      "envVars.0.name",
    );
  });

  it("accepts only repo-relative POSIX paths", () => {
    for (const ok of [".", "Dockerfile", "apps/web/Dockerfile", ".github/workflows/x.yml"]) {
      expect(RepoPathSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "/etc/passwd", "C:/x", "D:\\x\\y", "apps\\web", "../up", "a/../../b"]) {
      expect(RepoPathSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("DesignOption", () => {
  const option = (id: string, recommended: boolean): DesignOption => ({
    id,
    title: "Single server",
    summary: "One Hetzner server running the app with Docker Compose.",
    target: {
      provider: "hetzner",
      location: "nbg1",
      serverType: "cpx22",
      vcpus: 2,
      memoryGb: 4,
      diskGb: 80,
      cpuType: "shared",
      architecture: "x86",
    },
    services: { postgres: true, redis: false },
    externalServices: [],
    backups: true,
    cost: {
      monthly: { amount: 9.59, currency: "EUR" },
      breakdown: [
        { item: "Server", monthly: { amount: 7.99, currency: "EUR" } },
        { item: "Backups", monthly: { amount: 1.6, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-10-11T14:00:00.000Z",
    },
    fitsBudget: true,
    recommended,
    tradeoffs: ["No high availability."],
  });

  it("validates one option and requires exactly one recommended per list", () => {
    expect(DesignOptionSchema.safeParse(option("a", true)).success).toBe(true);
    expect(DesignOptionListSchema.safeParse([option("a", true), option("b", false)]).success).toBe(
      true,
    );
    expect(
      pathsOf(DesignOptionListSchema.safeParse([option("a", false), option("b", false)])),
    ).toEqual([""]);
    expect(
      pathsOf(DesignOptionListSchema.safeParse([option("a", true), option("b", true)])),
    ).toEqual([""]);
    expect(
      pathsOf(DesignOptionListSchema.safeParse([option("a", true), option("a", false)])),
    ).toEqual(["1.id"]);
  });
});

describe("Question", () => {
  const base = { id: "region", prompt: "Where are most of your users?", required: true } as const;

  it("accepts well-formed questions of every kind", () => {
    const options = [
      { value: "eu-central", label: "Central Europe" },
      { value: "us-east", label: "US East", hint: "Virginia" },
    ];
    for (const q of [
      { ...base, kind: "single-select", options, default: "eu-central" },
      { ...base, id: "keepExternalServices", kind: "multi-select", options, default: ["us-east"] },
      { ...base, id: "notes", kind: "text", default: "" },
      { ...base, id: "budgetMonthly", kind: "money", default: { amount: 20, currency: "EUR" } },
      { ...base, id: "domain", kind: "confirm", default: true, help: "You can add one later." },
    ]) {
      expect(QuestionSchema.safeParse(q).error?.issues ?? []).toEqual([]);
    }
  });

  it("rejects mismatched options and defaults", () => {
    expect(pathsOf(QuestionSchema.safeParse({ ...base, kind: "single-select" }))).toEqual([
      "options",
    ]);
    expect(
      pathsOf(
        QuestionSchema.safeParse({ ...base, kind: "text", options: [{ value: "a", label: "A" }] }),
      ),
    ).toEqual(["options"]);
    expect(pathsOf(QuestionSchema.safeParse({ ...base, kind: "confirm", default: "yes" }))).toEqual(
      ["default"],
    );
    expect(
      pathsOf(
        QuestionSchema.safeParse({
          ...base,
          kind: "single-select",
          options: [{ value: "a", label: "A" }],
          default: "b",
        }),
      ),
    ).toEqual(["default"]);
    expect(
      pathsOf(QuestionSchema.safeParse({ ...base, id: "schemaVersion", kind: "text" })),
    ).toEqual(["id"]);
  });
});

describe("DeployPlan target provider", () => {
  async function validPlan() {
    return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  }

  it("accepts Hetzner Cloud and DigitalOcean and nothing else", async () => {
    const plan = await validPlan();
    for (const provider of ["hetzner", "digitalocean"]) {
      const target = { ...plan.target, provider };
      expect(DeployPlanSchema.safeParse({ ...plan, target }).success, provider).toBe(true);
    }
    const aws = { ...plan, target: { ...plan.target, provider: "aws" } };
    expect(pathsOf(DeployPlanSchema.safeParse(aws))).toEqual(["target.provider"]);
  });

  it("keeps the exact shape of Hetzner and DigitalOcean targets", async () => {
    const plan = await validPlan();
    expect(plan.target).toEqual({
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cpx22",
      image: "ubuntu-24.04",
      backups: true,
    });
    for (const extra of [{ arch: "amd64" }, { access: "public" }]) {
      const target = { ...plan.target, ...extra };
      expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, target }))).toEqual(["target"]);
    }
    const { backups: _backups, ...noBackups } = cloud(plan.target);
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, target: noBackups }))).toEqual([
      "target.backups",
    ]);
  });

  it("marks app variables the code has a default for as optional", async () => {
    const plan = await validPlan();
    const env = [
      { name: "ALLOWED_HOSTS", secret: false, source: "derived" },
      { name: "DEBUG", secret: false, source: "user", optional: true },
      { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
    ];
    const parsed = DeployPlanSchema.parse({ ...plan, app: { ...plan.app, env } });
    expect(parsed.app.env).toEqual(env);
    const wrong = { ...plan, app: { ...plan.app, env: [{ ...env[1], optional: "yes" }] } };
    expect(pathsOf(DeployPlanSchema.safeParse(wrong))).toEqual(["app.env.0.optional"]);
  });

  it("carries an optional release command that the user may change or remove", async () => {
    const plan = await validPlan();
    expect(plan.app.releaseCommand).toBeUndefined();
    const app = { ...plan.app, releaseCommand: "python manage.py migrate --noinput" };
    expect(DeployPlanSchema.parse({ ...plan, app }).app.releaseCommand).toBe(
      "python manage.py migrate --noinput",
    );
    const multiLine = { ...plan, app: { ...plan.app, releaseCommand: "migrate\nrm -rf /" } };
    expect(pathsOf(DeployPlanSchema.safeParse(multiLine))).toEqual(["app.releaseCommand"]);
    const blank = { ...plan, app: { ...plan.app, releaseCommand: " " } };
    expect(pathsOf(DeployPlanSchema.safeParse(blank))).toEqual(["app.releaseCommand"]);
  });

  it("fills the provider's own Ubuntu image when the image is omitted", async () => {
    const { image: _image, ...target } = cloud((await validPlan()).target);
    const plan = await validPlan();
    const hetzner = DeployPlanSchema.parse({ ...plan, target: { ...target, provider: "hetzner" } });
    expect(cloud(hetzner.target).image).toBe(DEFAULT_IMAGES.hetzner);
    const digitalocean = DeployPlanSchema.parse({
      ...plan,
      target: { ...target, provider: "digitalocean" },
    });
    expect(cloud(digitalocean.target).image).toBe("ubuntu-24-04-x64");
    const explicit = DeployPlanSchema.parse({
      ...plan,
      target: { ...target, provider: "digitalocean", image: "ubuntu-22-04-x64" },
    });
    expect(cloud(explicit.target).image).toBe("ubuntu-22-04-x64");
  });
});

describe("DeployPlan target on a server the user owns", () => {
  async function validPlan() {
    return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  }
  const own = { provider: "own", mode: "vps-compose", arch: "arm64", access: "tunnel" } as const;

  it("records the architecture and access mode, and nothing about the server itself", async () => {
    const plan = await validPlan();
    const parsed = DeployPlanSchema.parse({ ...plan, target: own });
    expect(parsed.target).toEqual(own);
    expect(parsed.target.provider === "own" && parsed.target.access).toBe("tunnel");
    expectTypeOf<OwnDeployTarget>().toEqualTypeOf<{
      provider: "own";
      mode: "vps-compose";
      arch: "amd64" | "arm64";
      access: "public" | "tunnel";
    }>();
    expectTypeOf<CloudDeployTarget["image"]>().toEqualTypeOf<string>();
    expect(
      DeployPlanSchema.parse({ ...plan, target: { ...own, arch: "amd64", access: "public" } })
        .target,
    ).toEqual({ ...own, arch: "amd64", access: "public" });
  });

  it("rejects cloud-only fields, a missing or unknown architecture or access mode", async () => {
    const plan = await validPlan();
    for (const extra of [
      { location: "nbg1" },
      { serverType: "cpx22" },
      { image: "ubuntu-24.04" },
      { backups: true },
      { host: "203.0.113.10" },
    ]) {
      const target = { ...own, ...extra };
      expect(
        pathsOf(DeployPlanSchema.safeParse({ ...plan, target })),
        Object.keys(extra)[0],
      ).toEqual(["target"]);
    }
    const { arch: _arch, access: _access, ...bare } = own;
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, target: bare }))).toEqual([
      "target.arch",
      "target.access",
    ]);
    const x86 = { ...plan, target: { ...own, arch: "x86", access: "private" } };
    expect(pathsOf(DeployPlanSchema.safeParse(x86))).toEqual(["target.arch", "target.access"]);
  });

  it("serves a tunnel only on a domain on Cloudflare", async () => {
    const plan = await validPlan();
    expect(DeployPlanSchema.safeParse({ ...plan, target: own }).success).toBe(true);
    const { domain: _domain, ...noDomain } = plan.dns;
    const { zone: _zone, ...noZone } = plan.dns;
    const result = DeployPlanSchema.safeParse({
      ...plan,
      target: own,
      dns: { provider: "none", proxied: false },
    });
    expect(pathsOf(result)).toEqual(["target.access"]);
    expect(result.error?.issues[0]?.message).toContain("only with a domain on Cloudflare");
    // Design does not know the zone yet: provision learns it from Cloudflare before rendering.
    expect(DeployPlanSchema.safeParse({ ...plan, target: own, dns: noZone }).success).toBe(true);
    // A missing domain already has its own issue; the tunnel adds the plain reason.
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, target: own, dns: noDomain }))).toEqual([
      "dns.domain",
      "target.access",
    ]);
    const publicOwn = { ...own, access: "public" };
    const noDns = { provider: "none", proxied: false };
    expect(DeployPlanSchema.safeParse({ ...plan, target: publicOwn, dns: noDns }).success).toBe(
      true,
    );
    expect(DeployPlanSchema.safeParse({ ...plan, dns: noDns }).success).toBe(true);
  });

  it("serves directly behind Cloudflare's proxy only with the filter for Cloudflare's addresses", async () => {
    const plan = await validPlan();
    const publicOwn = { ...own, access: "public" } as const;
    const cloudflare = { provider: "cloudflare", domain: "shop.example.com", proxied: true };
    const security = (httpAllowedFrom?: "any" | "cloudflare") => ({
      ...(httpAllowedFrom !== undefined ? { httpAllowedFrom } : {}),
    });
    // Proxied: the filter (httpAllowedFrom cloudflare, the default when proxied).
    const filtered = DeployPlanSchema.parse({
      ...plan,
      target: publicOwn,
      dns: cloudflare,
      security: security(),
    });
    expect(filtered.security.httpAllowedFrom).toBe("cloudflare");
    // Proxied but open to every address: refused in plain words.
    const open = DeployPlanSchema.safeParse({
      ...plan,
      target: publicOwn,
      dns: cloudflare,
      security: security("any"),
    });
    expect(pathsOf(open)).toEqual(["security.httpAllowedFrom"]);
    expect(open.error?.issues[0]?.message).toContain("dns.proxied to false (DNS only)");
    // DNS only, the tunnel, and servers OpsCrew creates are not affected.
    for (const variant of [
      { target: publicOwn, dns: { ...cloudflare, proxied: false }, security: security("any") },
      { target: own, dns: cloudflare, security: security("any") },
      { dns: cloudflare, security: security("any") },
    ]) {
      expect(DeployPlanSchema.safeParse({ ...plan, ...variant }).success).toBe(true);
    }
  });

  it("refuses a move to or from a server the user owns", async () => {
    const plan = await validPlan();
    const move = { from: { target: plan.target }, step: "started", startedAt: plan.createdAt };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, target: own, retarget: move }))).toEqual([
      "retarget",
    ]);
    const fromOwn = { ...move, from: { target: own } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, retarget: fromOwn }))).toContain(
      "retarget.from.target.provider",
    );
  });

  it("accepts provider own in the requirements and design options", async () => {
    const requirements = parseArtifact(
      "requirements",
      await fixture("requirements.yaml"),
      "fixture",
    );
    expect(RequirementsSchema.parse({ ...requirements, provider: "own" }).provider).toBe("own");
    expect(VpsProviderSchema.options).toEqual(["hetzner", "digitalocean", "own"]);
    expect(CloudProviderSchema.options).toEqual(["hetzner", "digitalocean"]);
    expect(Object.keys(DEFAULT_IMAGES)).toEqual(["hetzner", "digitalocean"]);
  });

  it("needs a region for Hetzner and DigitalOcean only, and allows one for an own server", async () => {
    const requirements = parseArtifact(
      "requirements",
      await fixture("requirements.yaml"),
      "fixture",
    );
    const { region: _region, ...noRegion } = requirements;
    expect(RequirementsSchema.parse({ ...noRegion, provider: "own" }).region).toBeUndefined();
    expect(RequirementsSchema.parse({ ...requirements, provider: "own" }).region).toBe(
      "eu-central",
    );
    for (const provider of ["hetzner", "digitalocean"]) {
      const result = RequirementsSchema.safeParse({ ...noRegion, provider });
      expect(pathsOf(result), provider).toEqual(["region"]);
      expect(result.error?.issues[0]?.message).toContain(`"${provider}"`);
    }
    const bad = { ...requirements, provider: "own", region: "mars" };
    expect(pathsOf(RequirementsSchema.safeParse(bad))).toEqual(["region"]);
  });

  it("needs the provider: requirements without one are not read as Hetzner", async () => {
    const requirements = parseArtifact(
      "requirements",
      await fixture("requirements.yaml"),
      "fixture",
    );
    const { provider: _provider, ...noProvider } = requirements;
    expect(pathsOf(RequirementsSchema.safeParse(noProvider))).toContain("provider");
  });
});

describe("DeployPlan portainer", () => {
  async function validPlan() {
    return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  }

  it("is absent (off) unless the plan sets it, and fills its defaults", async () => {
    const plan = await validPlan();
    expect(plan.portainer).toBeUndefined();
    const parsed = DeployPlanSchema.parse({ ...plan, portainer: { version: "2.33.1" } });
    expect(parsed.portainer).toEqual({ enabled: false, version: "2.33.1", access: "local" });
  });

  it("needs a hostname and at least one email for a subdomain", async () => {
    const plan = await validPlan();
    const subdomain = { enabled: true, version: "2.33.1", access: "subdomain" };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, portainer: subdomain }))).toEqual([
      "portainer.hostname",
      "portainer.allowedEmails",
    ]);
    const noEmails = { ...subdomain, hostname: "portainer.example.com", allowedEmails: [] };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, portainer: noEmails }))).toEqual([
      "portainer.allowedEmails",
    ]);
    const ok = { ...noEmails, allowedEmails: ["ops@example.com"] };
    expect(DeployPlanSchema.parse({ ...plan, portainer: ok }).portainer).toEqual(ok);
  });

  it("needs a pinned version, never a floating tag", async () => {
    const plan = await validPlan();
    for (const version of ["2.33.1", "2.21.0-alpine", "10.0.12-rc.1"]) {
      const parsed = DeployPlanSchema.parse({ ...plan, portainer: { version } });
      expect(parsed.portainer?.version, version).toBe(version);
    }
    for (const version of [
      "latest",
      "lts",
      "sts",
      "2.33",
      "v2.33.1",
      "2.33.1-",
      "latest; rm -rf /",
    ]) {
      const result = DeployPlanSchema.safeParse({ ...plan, portainer: { version } });
      expect(pathsOf(result), version).toEqual(["portainer.version"]);
      expect(result.error?.issues[0]?.message).toContain("pinned version");
    }
  });

  it("allows a hostname and emails only for a subdomain", async () => {
    const plan = await validPlan();
    const local = { enabled: true, version: "2.33.1" };
    const withBoth = {
      ...local,
      hostname: "portainer.example.com",
      allowedEmails: ["ops@example.com"],
    };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, portainer: withBoth }))).toEqual([
      "portainer.hostname",
      "portainer.allowedEmails",
    ]);
    const explicitLocal = { ...withBoth, access: "local", allowedEmails: undefined };
    const result = DeployPlanSchema.safeParse({ ...plan, portainer: explicitLocal });
    expect(pathsOf(result)).toEqual(["portainer.hostname"]);
    expect(result.error?.issues[0]?.message).toContain('only allowed when access is "subdomain"');
  });

  it("puts a subdomain inside the app's Cloudflare zone, apart from the app's own names", async () => {
    const plan = await validPlan();
    expect(plan.dns).toMatchObject({ domain: "app.example.com", zone: "example.com" });
    const subdomain = (hostname: string) => ({
      enabled: true,
      version: "2.33.1",
      access: "subdomain",
      hostname,
      allowedEmails: ["ops@example.com"],
    });
    for (const ok of ["portainer.example.com", "admin-app.example.com"]) {
      expect(DeployPlanSchema.safeParse({ ...plan, portainer: subdomain(ok) }).success, ok).toBe(
        true,
      );
    }
    for (const outside of ["portainer.other.com", "example.com", "portainer.notexample.com"]) {
      const result = DeployPlanSchema.safeParse({ ...plan, portainer: subdomain(outside) });
      expect(pathsOf(result), outside).toEqual(["portainer.hostname"]);
      expect(result.error?.issues[0]?.message).toContain("subdomain of example.com");
    }
    for (const appName of ["app.example.com", "www.app.example.com"]) {
      const result = DeployPlanSchema.safeParse({ ...plan, portainer: subdomain(appName) });
      expect(pathsOf(result), appName).toEqual(["portainer.hostname"]);
      expect(result.error?.issues[0]?.message).toContain("must differ from the app's domain");
    }
  });

  it("needs the app's DNS on Cloudflare, with its zone, for a subdomain", async () => {
    const plan = await validPlan();
    const portainer = {
      version: "2.33.1",
      access: "subdomain",
      hostname: "portainer.example.com",
      allowedEmails: ["ops@example.com"],
    };
    const noDns = { ...plan, dns: { provider: "none", proxied: false, www: false }, portainer };
    expect(pathsOf(DeployPlanSchema.safeParse(noDns))).toEqual(["portainer.access"]);
    const { zone: _zone, ...dnsWithoutZone } = plan.dns;
    const noZone = { ...plan, dns: dnsWithoutZone, portainer };
    expect(pathsOf(DeployPlanSchema.safeParse(noZone))).toEqual(["dns.zone"]);
  });

  it("rejects a bad hostname or email, an unknown access mode and unknown fields", async () => {
    const plan = await validPlan();
    const base = { enabled: true, version: "2.33.1" };
    const subdomain = {
      ...base,
      access: "subdomain",
      hostname: "portainer.example.com",
      allowedEmails: ["ops@example.com"],
    };
    const cases: [object, string][] = [
      [{ enabled: true }, "portainer.version"],
      [{ ...base, access: "public" }, "portainer.access"],
      [{ ...subdomain, hostname: "Not A Host" }, "portainer.hostname"],
      [{ ...subdomain, allowedEmails: ["not-an-email"] }, "portainer.allowedEmails.0"],
      [{ ...base, password: "x" }, "portainer"],
    ];
    for (const [portainer, path] of cases) {
      expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, portainer })), path).toEqual([path]);
    }
  });
});

describe("DeployPlan names behind Cloudflare's proxy", () => {
  async function validPlan() {
    return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  }
  const own = (access: "public" | "tunnel") =>
    ({ provider: "own", mode: "vps-compose", arch: "amd64", access }) as const;
  const portainer = (hostname: string) => ({
    enabled: true,
    version: "2.33.1",
    access: "subdomain",
    hostname,
    allowedEmails: ["ops@example.com"],
  });

  it("explains the edge certificate and suggests a one-level name", () => {
    expect(cloudflareEdgeCoverage("portainer.shop.example.com", "example.com")).toEqual({
      reason:
        "Cloudflare's free certificate covers only example.com and *.example.com, so portainer.shop.example.com would fail HTTPS at Cloudflare's edge",
      suggestion: "portainer-shop.example.com",
    });
    expect(cloudflareEdgeCoverage("a.b.c.example.com", "example.com")?.suggestion).toBe(
      "a-b-c.example.com",
    );
    for (const name of [
      "example.com",
      "shop.example.com",
      "ssh-acme-web.example.com",
      "x.other.com",
    ]) {
      expect(cloudflareEdgeCoverage(name, "example.com"), name).toBeUndefined();
    }
  });

  it("guesses the zone as the registrable domain", () => {
    const cases: [string, string][] = [
      ["example.com", "example.com"],
      ["api.shop.example.com", "example.com"],
      ["shop.example.co.uk", "example.co.uk"],
      ["example.co.uk", "example.co.uk"],
      ["shop.example.com.au", "example.com.au"],
      ["shop.example.de", "example.de"],
      ["shop.co.com", "co.com"],
    ];
    for (const [domain, zone] of cases) expect(likelyCloudflareZone(domain), domain).toBe(zone);
  });

  it("refuses a proxied app domain two levels below the zone", async () => {
    const plan = await validPlan();
    const deep = { ...plan, dns: { ...plan.dns, domain: "api.shop.example.com" } };
    const result = DeployPlanSchema.safeParse(deep);
    expect(pathsOf(result)).toEqual(["dns.domain"]);
    expect(result.error?.issues[0]?.message).toBe(
      "must be example.com or one level below it: Cloudflare's free certificate covers only example.com and *.example.com, so api.shop.example.com would fail HTTPS at Cloudflare's edge; use a name one level below example.com, such as api-shop.example.com, or serve it without Cloudflare's proxy (dns.proxied false)",
    );
  });

  it("refuses a deep domain behind the tunnel even without the proxy flag", async () => {
    const plan = await validPlan();
    for (const proxied of [true, false]) {
      const result = DeployPlanSchema.safeParse({
        ...plan,
        target: own("tunnel"),
        dns: { ...plan.dns, domain: "api.shop.example.com", proxied },
      });
      expect(pathsOf(result), String(proxied)).toEqual(["dns.domain"]);
      expect(result.error?.issues[0]?.message).toContain("instead of the tunnel");
    }
  });

  it("leaves DNS-only names, unproxied cloud plans and one-level names alone", async () => {
    const plan = await validPlan();
    const deep = { ...plan.dns, domain: "api.shop.example.com", www: true };
    // Hetzner, DNS only.
    expect(DeployPlanSchema.safeParse({ ...plan, dns: { ...deep, proxied: false } }).success).toBe(
      true,
    );
    // Own server served directly with DNS only.
    expect(
      DeployPlanSchema.safeParse({
        ...plan,
        target: own("public"),
        dns: { ...deep, proxied: false },
        security: { ...plan.security, httpAllowedFrom: "any" },
      }).success,
    ).toBe(true);
    // No Cloudflare DNS at all.
    expect(
      DeployPlanSchema.safeParse({
        ...plan,
        dns: { provider: "none", domain: "api.shop.example.com", proxied: false, www: false },
      }).success,
    ).toBe(true);
    for (const domain of ["example.com", "shop.example.com"]) {
      const dns = { ...plan.dns, domain };
      expect(DeployPlanSchema.safeParse({ ...plan, dns }).success, domain).toBe(true);
      expect(
        DeployPlanSchema.safeParse({ ...plan, target: own("tunnel"), dns }).success,
        domain,
      ).toBe(true);
    }
    // Before provision learns the zone nothing can be checked.
    const { zone: _zone, ...noZone } = plan.dns;
    expect(
      DeployPlanSchema.safeParse({ ...plan, dns: { ...noZone, domain: "api.shop.example.com" } })
        .success,
    ).toBe(true);
  });

  it("allows www. only on the zone itself while Cloudflare serves the domain", async () => {
    const plan = await validPlan();
    expect(
      DeployPlanSchema.safeParse({
        ...plan,
        dns: { ...plan.dns, domain: "example.com", www: true },
      }).success,
    ).toBe(true);
    const result = DeployPlanSchema.safeParse({
      ...plan,
      dns: { ...plan.dns, domain: "shop.example.com", www: true },
    });
    expect(pathsOf(result)).toEqual(["dns.www"]);
    expect(result.error?.issues[0]?.message).toBe(
      "can be true only when the domain is example.com itself while Cloudflare serves it: Cloudflare's free certificate covers only example.com and *.example.com, so www.shop.example.com would fail HTTPS at Cloudflare's edge; turn off the www. alias (dns.www false), or serve the domain without Cloudflare's proxy (dns.proxied false)",
    );
    const tunnel = DeployPlanSchema.safeParse({
      ...plan,
      target: own("tunnel"),
      dns: { ...plan.dns, domain: "shop.example.com", www: true },
    });
    expect(pathsOf(tunnel)).toEqual(["dns.www"]);
    expect(
      DeployPlanSchema.safeParse({
        ...plan,
        dns: { ...plan.dns, domain: "shop.example.com", www: true, proxied: false },
      }).success,
    ).toBe(true);
  });

  it("refuses a Portainer subdomain two levels below the zone, even with the app DNS only", async () => {
    const plan = await validPlan();
    for (const proxied of [true, false]) {
      const result = DeployPlanSchema.safeParse({
        ...plan,
        dns: { ...plan.dns, proxied },
        portainer: portainer("portainer.shop.example.com"),
      });
      expect(pathsOf(result), String(proxied)).toEqual(["portainer.hostname"]);
      expect(result.error?.issues[0]?.message).toBe(
        "must be one level below example.com: Cloudflare's free certificate covers only example.com and *.example.com, so portainer.shop.example.com would fail HTTPS at Cloudflare's edge; use a name one level below example.com, such as portainer-shop.example.com",
      );
    }
    expect(
      DeployPlanSchema.safeParse({ ...plan, portainer: portainer("portainer-shop.example.com") })
        .success,
    ).toBe(true);
  });
});

describe("DeployPlan target on an existing Portainer", () => {
  async function validPlan() {
    return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  }
  const target = (overrides: Record<string, unknown> = {}) => ({
    provider: "portainer",
    mode: "portainer-stack",
    environmentId: 3,
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "tunnel" },
    ...overrides,
  });
  const noDns = { provider: "none", proxied: false } as const;

  it("records the environment, architecture, redeploy and web modes, nothing about Portainer itself", async () => {
    const plan = await validPlan();
    const parsed = DeployPlanSchema.parse({ ...plan, target: target() });
    expect(parsed.target).toEqual(target());
    expectTypeOf<PortainerDeployTarget>().toEqualTypeOf<{
      provider: "portainer";
      mode: "portainer-stack";
      environmentId: number;
      arch: "amd64" | "arm64";
      redeploy: "updater" | "cloudflare";
      web: { mode: "tunnel" } | { mode: "proxy"; port: number } | { mode: "caddy" };
    }>();
    for (const variant of [
      target({ arch: "arm64", redeploy: "cloudflare" }),
      target({ web: { mode: "proxy", port: 8080 } }),
      target({ web: { mode: "caddy" } }),
    ]) {
      expect(DeployPlanSchema.parse({ ...plan, target: variant }).target).toEqual(variant);
    }
  });

  it("rejects server fields, Portainer's address, unknown modes and bad values", async () => {
    const plan = await validPlan();
    for (const extra of [
      { location: "nbg1" },
      { serverType: "cpx22" },
      { image: "ubuntu-24.04" },
      { backups: true },
      { access: "tunnel" },
      { url: "https://portainer.example.com:9443" },
      { token: "never" },
    ]) {
      const result = DeployPlanSchema.safeParse({ ...plan, target: target(extra) });
      expect(pathsOf(result), Object.keys(extra)[0]).toEqual(["target"]);
    }
    const cases: [Record<string, unknown>, string][] = [
      [{ mode: "vps-compose" }, "target.mode"],
      [{ environmentId: 0 }, "target.environmentId"],
      [{ environmentId: 1.5 }, "target.environmentId"],
      [{ environmentId: "3" }, "target.environmentId"],
      [{ arch: "x86" }, "target.arch"],
      [{ redeploy: "polling" }, "target.redeploy"],
      [{ web: { mode: "public" } }, "target.web.mode"],
      [{ web: { mode: "proxy" } }, "target.web.port"],
      [{ web: { mode: "proxy", port: 0 } }, "target.web.port"],
      [{ web: { mode: "proxy", port: 65536 } }, "target.web.port"],
      [{ web: { mode: "proxy", port: 80.5 } }, "target.web.port"],
      [{ web: { mode: "tunnel", port: 8080 } }, "target.web"],
      [{ web: { mode: "caddy", port: 443 } }, "target.web"],
    ];
    for (const [overrides, path] of cases) {
      const result = DeployPlanSchema.safeParse({ ...plan, target: target(overrides) });
      expect(pathsOf(result), JSON.stringify(overrides)).toEqual([path]);
    }
    for (const port of [1, 65535]) {
      const web = { mode: "proxy", port };
      const result = DeployPlanSchema.safeParse({ ...plan, target: target({ web }), dns: noDns });
      expect(result.success, String(port)).toBe(true);
    }
    const { web: _web, redeploy: _redeploy, environmentId: _id, ...bare } = target();
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, target: bare }))).toEqual([
      "target.environmentId",
      "target.redeploy",
      "target.web",
    ]);
  });

  it("serves through the tunnel only on a domain on Cloudflare", async () => {
    const plan = await validPlan();
    const result = DeployPlanSchema.safeParse({ ...plan, target: target(), dns: noDns });
    expect(pathsOf(result)).toEqual(["target.web.mode"]);
    expect(result.error?.issues[0]?.message).toContain("only with a domain on Cloudflare");
    const { domain: _domain, ...noDomain } = plan.dns;
    expect(
      pathsOf(DeployPlanSchema.safeParse({ ...plan, target: target(), dns: noDomain })),
    ).toEqual(["dns.domain", "target.web.mode"]);
    // A domain whose DNS is elsewhere is not enough either.
    const elsewhere = { provider: "none", domain: "shop.example.com", proxied: false };
    expect(
      pathsOf(DeployPlanSchema.safeParse({ ...plan, target: target(), dns: elsewhere })),
    ).toEqual(["target.web.mode"]);
    // Design does not know the zone yet: provision learns it from Cloudflare before rendering.
    const { zone: _zone, ...noZone } = plan.dns;
    expect(DeployPlanSchema.safeParse({ ...plan, target: target(), dns: noZone }).success).toBe(
      true,
    );
  });

  it("redeploys through Cloudflare only on a domain on Cloudflare", async () => {
    const plan = await validPlan();
    const proxy = { mode: "proxy", port: 8080 };
    const cloudflare = target({ redeploy: "cloudflare", web: proxy });
    expect(DeployPlanSchema.safeParse({ ...plan, target: cloudflare }).success).toBe(true);
    const result = DeployPlanSchema.safeParse({ ...plan, target: cloudflare, dns: noDns });
    expect(pathsOf(result)).toEqual(["target.redeploy"]);
    expect(result.error?.issues[0]?.message).toContain("only with a domain on Cloudflare");
    expect(
      DeployPlanSchema.safeParse({ ...plan, target: target({ web: proxy }), dns: noDns }).success,
    ).toBe(true);
  });

  it("serves with Caddy only on a domain, wherever its DNS is", async () => {
    const plan = await validPlan();
    const caddy = target({ web: { mode: "caddy" } });
    const result = DeployPlanSchema.safeParse({ ...plan, target: caddy, dns: noDns });
    expect(pathsOf(result)).toEqual(["target.web.mode"]);
    expect(result.error?.issues[0]?.message).toContain("only with a domain");
    const elsewhere = { provider: "none", domain: "shop.example.com", proxied: false };
    expect(DeployPlanSchema.safeParse({ ...plan, target: caddy, dns: elsewhere }).success).toBe(
      true,
    );
    expect(DeployPlanSchema.safeParse({ ...plan, target: caddy }).success).toBe(true);
  });

  it("keeps names Cloudflare serves one level below the zone, the tunnel even without the proxy flag", async () => {
    const plan = await validPlan();
    for (const proxied of [true, false]) {
      const result = DeployPlanSchema.safeParse({
        ...plan,
        target: target(),
        dns: { ...plan.dns, domain: "api.shop.example.com", proxied },
      });
      expect(pathsOf(result), String(proxied)).toEqual(["dns.domain"]);
      expect(result.error?.issues[0]?.message).toContain('target.web.mode "caddy"');
    }
    const www = DeployPlanSchema.safeParse({
      ...plan,
      target: target(),
      dns: { ...plan.dns, domain: "shop.example.com", www: true, proxied: false },
    });
    expect(pathsOf(www)).toEqual(["dns.www"]);
    // Caddy or a routed port with DNS only: Cloudflare's edge does not serve the name.
    for (const web of [{ mode: "caddy" }, { mode: "proxy", port: 8080 }]) {
      const dns = { ...plan.dns, domain: "api.shop.example.com", proxied: false };
      expect(DeployPlanSchema.safeParse({ ...plan, target: target({ web }), dns }).success).toBe(
        true,
      );
      const proxiedDns = { ...dns, proxied: true };
      expect(
        pathsOf(DeployPlanSchema.safeParse({ ...plan, target: target({ web }), dns: proxiedDns })),
      ).toEqual(["dns.domain"]);
    }
    for (const domain of ["example.com", "shop.example.com"]) {
      const dns = { ...plan.dns, domain };
      expect(DeployPlanSchema.safeParse({ ...plan, target: target(), dns }).success, domain).toBe(
        true,
      );
    }
  });

  it("refuses a move of a Portainer target in plain words", () => {
    expect(PORTAINER_TARGET_NO_MOVE.message).toBe(
      "Moving an app to or from a Portainer target is not supported; destroy it and provision again.",
    );
  });

  it("refuses a move to or from Portainer, and installing another Portainer", async () => {
    const plan = await validPlan();
    const move = { from: { target: plan.target }, step: "started", startedAt: plan.createdAt };
    const to = DeployPlanSchema.safeParse({ ...plan, target: target(), retarget: move });
    expect(pathsOf(to)).toEqual(["retarget"]);
    expect(to.error?.issues[0]?.message).toContain("existing Portainer");
    const fromPortainer = { ...move, from: { target: target() } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, retarget: fromPortainer }))).toContain(
      "retarget.from.target.provider",
    );
    const ce = { enabled: true, version: "2.33.1" };
    expect(
      pathsOf(DeployPlanSchema.safeParse({ ...plan, target: target(), portainer: ce })),
    ).toEqual(["portainer"]);
  });

  it("accepts provider portainer in the requirements without a region, and in design options", async () => {
    const requirements = parseArtifact(
      "requirements",
      await fixture("requirements.yaml"),
      "fixture",
    );
    const { region: _region, ...noRegion } = requirements;
    expect(RequirementsSchema.parse({ ...noRegion, provider: "portainer" }).provider).toBe(
      "portainer",
    );
    expect(DeployProviderSchema.options).toEqual(["hetzner", "digitalocean", "own", "portainer"]);
    expect(DesignOptionSchema.shape.target.shape.provider.options).toEqual(
      DeployProviderSchema.options,
    );
    // A Portainer target has no server to create or price.
    expect(VpsProviderSchema.options).not.toContain("portainer");
    expect(CloudProviderSchema.options).toEqual(["hetzner", "digitalocean"]);
    expect(Object.keys(DEFAULT_IMAGES)).toEqual(["hetzner", "digitalocean"]);
  });
});

describe("DeployPlan serialisation of existing targets", () => {
  // SHA-256 of `serializeArtifact("plan", …)` before feature 010: adding the Portainer target must
  // not change one byte of a Hetzner, DigitalOcean or own-server plan. Updated in 012, which adds
  // `deploy`, `supplyChain`, `cicd.deployTags` and `cicd.imageRetention` (with their defaults) to
  // every plan.
  const BEFORE_010 = {
    hetzner: "a93c5747a0506f2bdacf997c9abab62ff11b42fea0947634f9ee9c6cb5ab6ea5",
    digitalocean: "807128853570e94a3badf1b9ebad4488634283e669f45513d1c177ab880da0a8",
    own: "0c91ae1ed8f5a65031e6121ea279a15cda261a36f8983c8ea6bd2b385542d5f0",
  };

  it("keeps Hetzner, DigitalOcean and own-server plans byte-identical", async () => {
    const plan = parseArtifact("plan", await fixture("plan.yaml"), "fixture");
    const own = { provider: "own", mode: "vps-compose", arch: "arm64", access: "tunnel" } as const;
    const plans = {
      hetzner: plan,
      digitalocean: DeployPlanSchema.parse({
        ...plan,
        target: { ...cloud(plan.target), provider: "digitalocean", image: undefined },
      }),
      own: DeployPlanSchema.parse({ ...plan, target: own }),
    };
    for (const [name, value] of Object.entries(plans)) {
      const digest = createHash("sha256").update(serializeArtifact("plan", value)).digest("hex");
      expect(digest, name).toBe(BEFORE_010[name as keyof typeof BEFORE_010]);
    }
  });
});

describe("DeployPlan retarget", () => {
  it("records a move in progress and fills the previous target's image", async () => {
    const plan = parseArtifact("plan", await fixture("plan.yaml"), "fixture");
    const { image: _image, ...previous } = cloud(plan.target);
    const moving = DeployPlanSchema.parse({
      ...plan,
      target: { ...plan.target, provider: "digitalocean", image: undefined },
      retarget: {
        from: { target: { ...previous, provider: "hetzner" } },
        step: "renamed",
        startedAt: "2026-10-13T09:00:00.000Z",
      },
    });
    expect(cloud(moving.target).image).toBe("ubuntu-24-04-x64");
    expect(moving.retarget?.from.target.image).toBe("ubuntu-24.04");
    // The deploy settings an abort restores: the defaults when the move did not record them.
    expect(moving.retarget?.from.deploy).toEqual({ strategy: "rolling", drainSeconds: 30 });
    expect(moving.retarget?.step).toBe("renamed");
    const bad = { ...moving, retarget: { ...moving.retarget, step: "halfway" } };
    expect(pathsOf(DeployPlanSchema.safeParse(bad))).toEqual(["retarget.step"]);
  });
});

describe("DeployPlan keeps the server's address out of the repository", () => {
  const IPV4 = "203.0.113.10";
  const IPV6 = "2001:db8::10";

  it("has no field for the server's addresses, in the deployment or a move", async () => {
    const plan = parseArtifact("plan", await fixture("plan.yaml"), "fixture");
    expect(JSON.stringify(plan)).not.toContain(IPV4);
    const withIp = { ...plan, deployment: { ...plan.deployment, serverIpv4: IPV4 } };
    expect(pathsOf(DeployPlanSchema.safeParse(withIp))).toEqual(["deployment"]);
    const withIpv6 = { ...plan, deployment: { ...plan.deployment, serverIpv6: IPV6 } };
    expect(pathsOf(DeployPlanSchema.safeParse(withIpv6))).toEqual(["deployment"]);

    const move = { from: { target: plan.target }, step: "created", startedAt: plan.createdAt };
    expect(DeployPlanSchema.safeParse({ ...plan, retarget: move }).success).toBe(true);
    const fromIp = { ...move, from: { ...move.from, serverIpv4: IPV4 } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, retarget: fromIp }))).toEqual([
      "retarget.from",
    ]);
    const fromUrl = { ...move, from: { ...move.from, url: "https://app.example.com" } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, retarget: fromUrl }))).toEqual([
      "retarget.from",
    ]);
    const next = { ...move, next: { serverIpv4: IPV4 } };
    expect(pathsOf(DeployPlanSchema.safeParse({ ...plan, retarget: next }))).toEqual(["retarget"]);
  });

  it("records the app's URL only when it names a domain, never the server's IP", async () => {
    const plan = parseArtifact("plan", await fixture("plan.yaml"), "fixture");
    const at = (url: string) => ({ ...plan, deployment: { ...plan.deployment, url } });
    expect(DeployPlanSchema.safeParse(at("https://app.example.com")).success).toBe(true);
    expect(DeployPlanSchema.safeParse(at("http://app.example.com:8080/")).success).toBe(true);
    for (const url of [`http://${IPV4}`, `https://${IPV4}/health`, `http://[${IPV6}]/`]) {
      const result = DeployPlanSchema.safeParse(at(url));
      expect(pathsOf(result), url).toEqual(["deployment.url"]);
      expect(result.error?.issues[0]?.message).toContain("domain");
    }
  });
});

describe("DeployPlan image build, deploy strategy, supply chain and deploy tags", () => {
  async function validPlan() {
    return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  }
  const build = {
    builder: "generated-dockerfile",
    chosen: "auto",
    reason: "Next.js with pnpm: OpsCrew's Dockerfile builds it; Buildpacks has no pnpm.",
    runtime: { language: "node", version: "24" },
    probe: "node",
  } as const;
  const withBuild = (plan: DeployPlan, value: object) => ({
    ...plan,
    app: { ...plan.app, build: value },
  });

  it("keeps the builder, how it was chosen, its reason and the runtime handed to it", async () => {
    const plan = await validPlan();
    expect(DeployPlanSchema.parse(withBuild(plan, build)).app.build).toEqual(build);
    for (const builder of ["own-dockerfile", "buildpacks", "railpack"]) {
      const parsed = DeployPlanSchema.parse(withBuild(plan, { ...build, builder, chosen: "user" }));
      expect(parsed.app.build?.builder, builder).toBe(builder);
    }
    for (const language of ["python", "ruby", "go", "java", "dotnet", "php", "rust", "other"]) {
      const runtime = { language, version: "3.13" };
      const result = DeployPlanSchema.safeParse(withBuild(plan, { ...build, runtime }));
      expect(result.success, language).toBe(true);
    }
    expectTypeOf<NonNullable<DeployPlan["app"]["build"]>>().toEqualTypeOf<{
      builder: "generated-dockerfile" | "own-dockerfile" | "buildpacks" | "railpack";
      chosen: "auto" | "user";
      reason: string;
      runtime: {
        language: "node" | "python" | "ruby" | "go" | "java" | "dotnet" | "php" | "rust" | "other";
        version?: string;
      };
      probe: "node" | "python" | "ruby" | "php" | "wget" | "bash" | "none";
      automatic?: "generated-dockerfile" | "own-dockerfile" | "buildpacks" | "railpack";
    }>();
    for (const probe of ["node", "python", "ruby", "php", "wget", "bash", "none"]) {
      expect(DeployPlanSchema.parse(withBuild(plan, { ...build, probe })).app.build?.probe).toBe(
        probe,
      );
    }
    expect(DeployPlanSchema.safeParse(withBuild(plan, { ...build, probe: "curl" })).success).toBe(
      false,
    );
    // Design always records the probe with the builder.
    const { probe: _probe, ...noProbe } = build;
    expect(pathsOf(DeployPlanSchema.safeParse(withBuild(plan, noProbe)))).toEqual([
      "app.build.probe",
    ]);
  });

  it("keeps the version as the app declares it: major, major.minor or major.minor.patch", async () => {
    const plan = await validPlan();
    for (const version of ["24", "3.13", "4.0.7"]) {
      const runtime = { language: "ruby", version };
      const parsed = DeployPlanSchema.parse(withBuild(plan, { ...build, runtime }));
      expect(parsed.app.build?.runtime, version).toEqual(runtime);
    }
  });

  it("needs a version for every language except other", async () => {
    const plan = await validPlan();
    const other = { ...build, builder: "railpack", runtime: { language: "other" } };
    expect(DeployPlanSchema.parse(withBuild(plan, other)).app.build?.runtime).toEqual({
      language: "other",
    });
    for (const language of ["node", "python", "ruby", "go", "java", "dotnet", "php", "rust"]) {
      const result = DeployPlanSchema.safeParse(
        withBuild(plan, { ...build, runtime: { language } }),
      );
      expect(pathsOf(result), language).toEqual(["app.build.runtime.version"]);
      expect(result.error?.issues[0]?.message).toContain("other");
    }
  });

  it("rejects an unknown builder or language, no reason, and a malformed version", async () => {
    const plan = await validPlan();
    const paths = (value: object) => pathsOf(DeployPlanSchema.safeParse(withBuild(plan, value)));
    expect(paths({ ...build, builder: "nixpacks" })).toEqual(["app.build.builder"]);
    expect(paths({ ...build, chosen: "agent" })).toEqual(["app.build.chosen"]);
    expect(paths({ ...build, reason: "" })).toEqual(["app.build.reason"]);
    const { reason: _reason, ...noReason } = build;
    expect(paths(noReason)).toEqual(["app.build.reason"]);
    expect(paths({ ...build, runtime: { language: "elixir", version: "1.18" } })).toEqual([
      "app.build.runtime.language",
    ]);
    for (const version of ["24", "3.13", "10.0"]) {
      const runtime = { language: "node", version };
      const result = DeployPlanSchema.safeParse(withBuild(plan, { ...build, runtime }));
      expect(result.success, version).toBe(true);
    }
    for (const version of ["", "lts", "v24", "1.2.3.4", ">=20", "3.x", "ruby-4.0.7"]) {
      expect(paths({ ...build, runtime: { language: "node", version } }), version).toEqual([
        "app.build.runtime.version",
      ]);
    }
    expect(paths({ ...build, extra: true })).toEqual(["app.build"]);
  });

  it("keeps a recreate strategy with its reason and refuses drain times outside 5–300 s", async () => {
    const plan = await validPlan();
    const recreate = { strategy: "recreate", drainSeconds: 10, reason: "the server has 512 MB" };
    expect(DeployPlanSchema.parse({ ...plan, deploy: recreate }).deploy).toEqual(recreate);
    expect(DeployPlanSchema.parse({ ...plan, deploy: { drainSeconds: 300 } }).deploy).toEqual({
      strategy: "rolling",
      drainSeconds: 300,
    });
    for (const drainSeconds of [4, 301, 12.5]) {
      const result = DeployPlanSchema.safeParse({ ...plan, deploy: { drainSeconds } });
      expect(pathsOf(result), String(drainSeconds)).toEqual(["deploy.drainSeconds"]);
    }
    for (const deploy of [{ strategy: "blue-green" }, { reason: "" }, { extra: 1 }]) {
      const result = DeployPlanSchema.safeParse({ ...plan, deploy });
      expect(result.success, JSON.stringify(deploy)).toBe(false);
    }
  });

  it("turns on signing and deploy tags only when the plan says so", async () => {
    const plan = await validPlan();
    const parsed = DeployPlanSchema.parse({
      ...plan,
      supplyChain: { sign: true },
      cicd: { ...plan.cicd, deployTags: { enabled: true, release: true } },
    });
    expect(parsed.supplyChain).toEqual({ sign: true });
    expect(parsed.cicd.deployTags).toEqual({ enabled: true, release: true });
    const tagsOnly = { ...plan, cicd: { ...plan.cicd, deployTags: { enabled: true } } };
    expect(DeployPlanSchema.parse(tagsOnly).cicd.deployTags).toEqual({
      enabled: true,
      release: false,
    });
    const signYes = { ...plan, supplyChain: { sign: "yes" } };
    expect(pathsOf(DeployPlanSchema.safeParse(signYes))).toEqual(["supplyChain.sign"]);
    const unknown = { ...plan, cicd: { ...plan.cicd, deployTags: { tag: "v1" } } };
    expect(pathsOf(DeployPlanSchema.safeParse(unknown))).toEqual(["cicd.deployTags"]);
  });

  it("prunes old deployed images by default, keeping 10, and never fewer than 2", async () => {
    const plan = await validPlan();
    const { imageRetention: _retention, ...cicd } = plan.cicd;
    expect(DeployPlanSchema.parse({ ...plan, cicd }).cicd.imageRetention).toEqual({
      enabled: true,
      keep: 10,
    });
    const retention = (value: object) => ({ ...plan, cicd: { ...cicd, imageRetention: value } });
    expect(DeployPlanSchema.parse(retention({ enabled: false })).cicd.imageRetention).toEqual({
      enabled: false,
      keep: 10,
    });
    expect(DeployPlanSchema.parse(retention({ keep: 2 })).cicd.imageRetention.keep).toBe(2);
    expect(DeployPlanSchema.parse(retention({ keep: 100 })).cicd.imageRetention.keep).toBe(100);
    for (const keep of [1, 101, 3.5]) {
      const result = DeployPlanSchema.safeParse(retention({ keep }));
      expect(pathsOf(result), String(keep)).toEqual(["cicd.imageRetention.keep"]);
    }
  });
});

describe("ProjectFacts runtime versions", () => {
  it("records the declared version of every language, as declared", async () => {
    const architecture = parseArtifact("architecture", await fixture("architecture.json"), "f");
    const runtimeVersions = {
      node: ">=22",
      python: "3.13",
      ruby: "ruby-4.0.7",
      go: "1.26.9",
      java: "21",
      dotnet: "10.0",
      php: "^8.4",
      rust: "1.85.1",
    };
    const facts = { ...architecture.facts, runtimeVersions };
    expect(ProjectFactsSchema.parse(facts).runtimeVersions).toEqual(runtimeVersions);
    const empty = { ...architecture.facts, runtimeVersions: { go: "" } };
    expect(pathsOf(ProjectFactsSchema.safeParse(empty))).toEqual(["runtimeVersions.go"]);
  });

  it("records runtime version evidence with its source, and refuses empty lists", async () => {
    const architecture = parseArtifact("architecture", await fixture("architecture.json"), "f");
    const runtimeEvidence = {
      node: [
        { value: "20", source: ".github/workflows/ci.yml" },
        { value: "22", source: ".github/workflows/ci.yml" },
      ],
      python: [{ value: ">=3.10,<3.15", source: "Django 5.2" }],
    };
    const facts = { ...architecture.facts, runtimeEvidence };
    expect(ProjectFactsSchema.parse(facts).runtimeEvidence).toEqual(runtimeEvidence);
    const empty = { ...architecture.facts, runtimeEvidence: { node: [] } };
    expect(pathsOf(ProjectFactsSchema.safeParse(empty))).toEqual(["runtimeEvidence.node"]);
    const blank = {
      ...architecture.facts,
      runtimeEvidence: { python: [{ value: "", source: "x" }] },
    };
    expect(pathsOf(ProjectFactsSchema.safeParse(blank))).toEqual([
      "runtimeEvidence.python.0.value",
    ]);
  });
});
