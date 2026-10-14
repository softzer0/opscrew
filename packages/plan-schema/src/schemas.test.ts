import { readFile } from "node:fs/promises";
import type { Currency, Money, PhaseName } from "@opscrew/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  ArchitectureSchema,
  type ArtifactError,
  type ArtifactKind,
  CostEstimateSchema,
  type CurrencySchema,
  DEFAULT_IMAGES,
  DeployPlanSchema,
  type DesignOption,
  DesignOptionListSchema,
  DesignOptionSchema,
  type Money as MoneyExport,
  type MoneySchema,
  type PhaseNameSchema,
  type ProjectFacts,
  ProjectFactsSchema,
  parseArtifact,
  QuestionSchema,
  RepoPathSchema,
  RequirementsSchema,
  ServiceKindSchema,
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
    const { image: _image, ...target } = (await validPlan()).target;
    const plan = await validPlan();
    const hetzner = DeployPlanSchema.parse({ ...plan, target: { ...target, provider: "hetzner" } });
    expect(hetzner.target.image).toBe(DEFAULT_IMAGES.hetzner);
    const digitalocean = DeployPlanSchema.parse({
      ...plan,
      target: { ...target, provider: "digitalocean" },
    });
    expect(digitalocean.target.image).toBe("ubuntu-24-04-x64");
    const explicit = DeployPlanSchema.parse({
      ...plan,
      target: { ...target, provider: "digitalocean", image: "ubuntu-22-04-x64" },
    });
    expect(explicit.target.image).toBe("ubuntu-22-04-x64");
  });
});

describe("DeployPlan retarget", () => {
  it("records a move in progress and fills the previous target's image", async () => {
    const plan = parseArtifact("plan", await fixture("plan.yaml"), "fixture");
    const { image: _image, ...previous } = plan.target;
    const moving = DeployPlanSchema.parse({
      ...plan,
      target: { ...plan.target, provider: "digitalocean", image: undefined },
      retarget: {
        from: { target: { ...previous, provider: "hetzner" } },
        step: "renamed",
        startedAt: "2026-10-13T09:00:00.000Z",
      },
    });
    expect(moving.target.image).toBe("ubuntu-24-04-x64");
    expect(moving.retarget?.from.target.image).toBe("ubuntu-24.04");
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
