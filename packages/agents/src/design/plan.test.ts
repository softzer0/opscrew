import { fileURLToPath } from "node:url";
import { detectProject } from "@opscrew/detect";
import { DeployPlanSchema, parseArtifact, serializeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { assembleAppEnv, parseDotenv } from "../shared";
import {
  euCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
} from "./__fixtures__/catalog";
import {
  appNameFor,
  appPortFor,
  buildDesignOptions,
  deriveCodeChanges,
  optionToPlan,
} from "./index";

const NOW = new Date("2026-10-11T12:00:00.000Z");

describe("optionToPlan", () => {
  it("writes a valid plan for a Next.js + Postgres app behind Cloudflare", async () => {
    const facts = nextPostgresFacts();
    const requirements = makeRequirements({
      expectedMonthlyUsers: "1k-10k",
      dataCriticality: "critical",
      dnsProvider: "cloudflare",
      domain: "shop.example.com",
      keepExternalServices: [],
    });
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const codeChanges = deriveCodeChanges(facts);
    const plan = optionToPlan(option, { facts, requirements, now: NOW, codeChanges });

    expect(DeployPlanSchema.safeParse(plan).success).toBe(true);
    // Round-trips through the YAML artefact unchanged.
    expect(parseArtifact("plan", serializeArtifact("plan", plan), "plan.yaml")).toEqual(plan);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      createdAt: "2026-10-11T12:00:00.000Z",
      updatedAt: "2026-10-11T12:00:00.000Z",
      app: {
        name: "acme-shop",
        port: 3000,
        healthPath: "/api/health",
        buildContext: ".",
        dockerfile: "Dockerfile",
      },
      target: {
        provider: "hetzner",
        mode: "vps-compose",
        location: "nbg1",
        serverType: "cx33",
        image: "ubuntu-24.04",
        backups: true,
      },
      services: { postgres: true, redis: false },
      externalServices: [],
      dns: { provider: "cloudflare", domain: "shop.example.com", proxied: true, www: false },
      cicd: {
        provider: "github-actions",
        registry: "ghcr",
        branch: "trunk",
        workflowPath: ".github/workflows/opscrew-deploy.yml",
      },
      security: { httpAllowedFrom: "cloudflare" },
      infra: { engine: "auto", dir: "opscrew/infra/prod", stateEncryption: true },
    });
    expect(plan.cost).toEqual(option.cost);
    expect(plan.codeChanges).toEqual(codeChanges);
    expect(plan.app.env).toEqual([
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "NEXTAUTH_SECRET", secret: true, source: "generated" },
      { name: "NEXT_PUBLIC_SITE_URL", secret: false, source: "user" },
    ]);
  });

  it("serves a static site on 8080 with / as the health path and no DNS", async () => {
    const facts = staticSpaFacts();
    const requirements = makeRequirements();
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const plan = optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(plan.app).toMatchObject({ name: "landing", port: 8080, healthPath: "/", env: [] });
    expect(plan.dns).toEqual({ provider: "none", proxied: false, www: false });
    expect(plan.security.httpAllowedFrom).toBe("any");
    expect(plan.createdAt).toBe("2026-10-01T00:00:00.000Z");
    expect(plan.updatedAt).toBe(NOW.toISOString());
    expect(plan.cicd.branch).toBe("main");
  });

  it("keeps Supabase external without a Postgres container", async () => {
    const facts = nextPostgresFacts({
      services: [
        { kind: "postgres", evidence: ["env:DATABASE_URL"] },
        { kind: "supabase", evidence: ["dependency:@supabase/supabase-js"] },
      ],
    });
    const requirements = makeRequirements({
      keepExternalServices: ["supabase"],
      dnsProvider: "other",
      domain: "app.example.org",
    });
    const options = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    for (const option of options) {
      const plan = optionToPlan(option, { facts, requirements, now: NOW, codeChanges: [] });
      expect(plan.services.postgres).toBe(false);
      expect(plan.externalServices).toEqual(["postgres", "supabase"]);
      expect(plan.app.env.find((v) => v.name === "DATABASE_URL")?.source).toBe("user");
      expect(plan.dns).toMatchObject({ provider: "none", domain: "app.example.org" });
    }
  });

  it("marks variables with a default as optional and derives host lists (Django)", async () => {
    const variable = (name: string, extra: { secretLikely?: boolean; hasDefault?: boolean }) => ({
      name,
      files: ["mysite/settings.py"],
      clientExposed: false,
      secretLikely: extra.secretLikely ?? false,
      ...(extra.hasDefault !== undefined ? { hasDefault: extra.hasDefault } : {}),
    });
    const facts = makeFacts({
      languages: ["python"],
      frameworks: [{ name: "django", path: "." }],
      envVars: [
        variable("API_TOKEN", { secretLikely: true }),
        variable("CSRF_TRUSTED_ORIGINS", {}),
        variable("DATABASE_URL", { secretLikely: true }),
        variable("DJANGO_ALLOWED_HOSTS", { hasDefault: true }),
        variable("DJANGO_DEBUG", { hasDefault: true }),
        variable("DJANGO_SECRET_KEY", { secretLikely: true }),
        variable("LOG_LEVEL", { hasDefault: false }),
        // `os.environ.get("SIGNING_KEY", "dev-insecure")`: a secret's default is a placeholder.
        variable("SIGNING_KEY", { secretLikely: true, hasDefault: true }),
      ],
      services: [{ kind: "postgres", evidence: ["dependency:psycopg"] }],
    });
    const requirements = makeRequirements({ domain: "shop.example.com", dnsProvider: "other" });
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const plan = optionToPlan(option, { facts, requirements, now: NOW, codeChanges: [] });
    expect(plan.app.env).toEqual([
      { name: "API_TOKEN", secret: true, source: "user" },
      { name: "CSRF_TRUSTED_ORIGINS", secret: false, source: "derived" },
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "DJANGO_ALLOWED_HOSTS", secret: false, source: "derived", optional: true },
      { name: "DJANGO_DEBUG", secret: false, source: "user", optional: true },
      { name: "DJANGO_SECRET_KEY", secret: true, source: "generated" },
      { name: "LOG_LEVEL", secret: false, source: "user" },
      { name: "SIGNING_KEY", secret: true, source: "user" },
    ]);
    // The plan never holds the domain or the server's address as a value, only names.
    expect(parseArtifact("plan", serializeArtifact("plan", plan), "plan.yaml")).toEqual(plan);
  });

  it("adds REDIS_URL as a derived variable when Redis runs on the server", async () => {
    const facts = makeFacts({
      languages: ["python"],
      frameworks: [{ name: "fastapi", path: "." }],
      services: [{ kind: "redis", evidence: ["dependency:redis"] }],
    });
    const requirements = makeRequirements();
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const plan = optionToPlan(option, { facts, requirements, now: NOW, codeChanges: [] });
    expect(plan.services.redis).toBe(true);
    expect(plan.app.env).toEqual([{ name: "REDIS_URL", secret: false, source: "derived" }]);
    expect(plan.app.port).toBe(8000);
    expect(plan.app.healthPath).toBe("/health");
  });
});

describe("app name and port", () => {
  it("makes DNS-label-safe names", () => {
    expect(appNameFor(makeFacts({ name: "@Acme/My_Web App!" }))).toBe("acme-my-web-app");
    expect(appNameFor(makeFacts({ name: "---" }))).toBe("app");
    const long = appNameFor(makeFacts({ name: `${"a".repeat(40)}-b-c` }));
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
    expect(long.endsWith("-")).toBe(false);
  });

  it("uses the detected port, a language default, or 8080 for static sites", () => {
    expect(appPortFor(makeFacts({ port: 4321 }))).toBe(4321);
    expect(appPortFor(makeFacts())).toBe(3000);
    expect(appPortFor(makeFacts({ languages: ["python"] }))).toBe(8000);
    expect(appPortFor(staticSpaFacts())).toBe(8080);
    expect(appPortFor(makeFacts({ languages: ["go"] }))).toBe(3000);
  });
});

describe("examples/django-postgres: facts → plan → production environment", () => {
  const EXAMPLE = fileURLToPath(new URL("../../../../examples/django-postgres/", import.meta.url));
  const ADDRESS = "203.0.113.7";

  async function djangoPlan(domain?: string) {
    const facts = await detectProject(EXAMPLE);
    const requirements = makeRequirements(
      domain === undefined ? {} : { dnsProvider: "other", domain },
    );
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    return optionToPlan(option, { facts, requirements, now: NOW, codeChanges: [] });
  }

  it("plans the debug flag as optional, the host list as derived and the secret key as generated", async () => {
    const plan = await djangoPlan("shop.example.com");
    const byName = Object.fromEntries(plan.app.env.map((v) => [v.name, v]));
    expect(byName.DJANGO_DEBUG).toEqual({
      name: "DJANGO_DEBUG",
      secret: false,
      source: "user",
      optional: true,
    });
    expect(byName.DJANGO_ALLOWED_HOSTS).toMatchObject({ source: "derived", optional: true });
    expect(byName.DJANGO_SECRET_KEY).toMatchObject({ source: "generated", secret: true });
    expect(byName.DATABASE_URL).toMatchObject({ source: "derived" });
    expect(plan.services.postgres).toBe(true);
  });

  it("provisions from an empty env file with a domain, or with only the server's address", async () => {
    const withDomain = await djangoPlan("shop.example.com");
    const onDomain = await assembleAppEnv({ plan: withDomain, dotenvText: "" });
    const domainValues = parseDotenv(onDomain.appEnv);
    expect(domainValues.get("DJANGO_ALLOWED_HOSTS")).toBe("shop.example.com");
    expect(domainValues.has("DJANGO_DEBUG")).toBe(false);
    expect(domainValues.get("DJANGO_SECRET_KEY")).toHaveLength(32);
    expect(onDomain.defaulted).toEqual(["DJANGO_DEBUG"]);

    const bare = await djangoPlan();
    const onAddress = await assembleAppEnv({ plan: bare, dotenvText: "", serverHost: ADDRESS });
    expect(parseDotenv(onAddress.appEnv).get("DJANGO_ALLOWED_HOSTS")).toBe(ADDRESS);
    // Only names leave the function, and the plan holds no values at all.
    expect(onAddress.names.join(" ")).not.toContain(ADDRESS);
    expect(serializeArtifact("plan", bare)).not.toContain(ADDRESS);
    expect(serializeArtifact("plan", withDomain)).not.toContain(
      domainValues.get("DJANGO_SECRET_KEY") as string,
    );
  });
});
