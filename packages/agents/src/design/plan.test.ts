import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSecret } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import {
  DeployPlanSchema,
  type ProjectFacts,
  parseArtifact,
  serializeArtifact,
  serviceOf,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { assembleAppEnv, parseDotenv } from "../shared";
import {
  autoBuild,
  euCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
} from "../testing";
import { deriveCodeChanges } from "./code-changes";
import { appNameFor, designComponents } from "./components";
import { buildDesignOptions } from "./options";
import { appPortFor, optionToPlan } from "./plan";
import { selfHostedServices } from "./sizing";

const NOW = new Date("2026-10-11T12:00:00.000Z");

describe("optionToPlan names behind Cloudflare's proxy", () => {
  it("refuses a proxied domain two levels below its zone, and allows it off Cloudflare", async () => {
    const facts = staticSpaFacts();
    const deep = makeRequirements({ dnsProvider: "cloudflare", domain: "api.shop.example.com" });
    const [option] = await buildDesignOptions({ facts, requirements: deep, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    expect(() =>
      optionToPlan(option, {
        facts,
        requirements: deep,
        now: NOW,
        codeChanges: [],
        build: autoBuild(facts),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message:
          "Cloudflare's free certificate covers only example.com and *.example.com, so api.shop.example.com would fail HTTPS at Cloudflare's edge. plan.yaml was not changed.",
        hint: "In `opscrew interview`, use a name one level below example.com, such as api-shop.example.com, or answer other for dnsProvider to manage its DNS yourself, without Cloudflare's proxy.",
      }),
    );
    const other = { ...deep, dnsProvider: "other" as const };
    const plan = optionToPlan(option, {
      facts,
      requirements: other,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
    expect(plan.dns).toMatchObject({ provider: "none", domain: "api.shop.example.com" });
  });
});

describe("optionToPlan", () => {
  it("writes a valid plan for a Next.js + Postgres app behind Cloudflare", async () => {
    const facts = nextPostgresFacts();
    const requirements = makeRequirements({
      expectedMonthlyUsers: "1k-10k",
      dataCriticality: "critical",
      dnsProvider: "cloudflare",
      domain: "shop.example.com",
      keepExternalServices: {},
    });
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const codeChanges = deriveCodeChanges(facts, "generated-dockerfile");
    const plan = optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges,
      build: autoBuild(facts),
    });

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
      services: [
        {
          ...selfHostedServices({ postgres: true, redis: false })[0],
          reason: "The app uses PostgreSQL through pg.",
        },
      ],
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

  it("builds the user's own Dockerfile from where detection found it", async () => {
    const facts = nextPostgresFacts({ docker: { dockerfile: "docker/Dockerfile.prod" } });
    const requirements = makeRequirements();
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const build = autoBuild(facts);
    expect(build.builder).toBe("own-dockerfile");
    const plan = optionToPlan(option, { facts, requirements, now: NOW, codeChanges: [], build });
    expect(plan.app).toMatchObject({ dockerfile: "docker/Dockerfile.prod", buildContext: "." });
  });

  describe("an app in a subfolder", () => {
    const planOf = async (facts: ProjectFacts) => {
      const requirements = makeRequirements();
      const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
      if (!option) throw new Error("no option");
      const build = autoBuild(facts);
      return optionToPlan(option, { facts, requirements, now: NOW, codeChanges: [], build });
    };

    it("is built from its folder with Buildpacks or Railpack", async () => {
      const go = makeFacts({
        languages: ["go"],
        runtimeVersions: { go: "1.26" },
        appDir: "services/api",
      });
      expect((await planOf(go)).app).toMatchObject({
        build: { builder: "buildpacks" },
        buildContext: "services/api",
      });
      const rust = makeFacts({ languages: ["rust"], appDir: "services/api" });
      expect((await planOf(rust)).app).toMatchObject({
        build: { builder: "railpack" },
        buildContext: "services/api",
      });
    });

    it("records the workspace packages its build uses, whose changes deploy it", async () => {
      const member = nextPostgresFacts({
        monorepo: true,
        appDir: "apps/web",
        workspacePackages: ["packages/tokens", "packages/ui"],
      });
      const plan = await planOf(member);
      expect(plan.app.sharedPaths).toEqual(["packages/tokens", "packages/ui"]);
      expect(parseArtifact("plan", serializeArtifact("plan", plan), "plan.yaml")).toEqual(plan);
      // None: the field stays out of plan.yaml.
      const alone = await planOf(nextPostgresFacts({ monorepo: true, appDir: "apps/web" }));
      expect(alone.app.sharedPaths).toBeUndefined();
      expect(serializeArtifact("plan", alone)).not.toContain("sharedPaths");
    });

    it("is built from the repository root as a JavaScript workspace member or with a Dockerfile", async () => {
      const member = makeFacts({ packageManager: "bun", monorepo: true, appDir: "apps/api" });
      expect((await planOf(member)).app).toMatchObject({
        build: { builder: "railpack" },
        buildContext: ".",
      });
      // OpsCrew's Dockerfile copies the app's folder from the repository root.
      const node = await planOf(nextPostgresFacts({ monorepo: true, appDir: "apps/web" }));
      expect(node.app).toMatchObject({
        build: { builder: "generated-dockerfile" },
        buildContext: ".",
        dockerfile: "apps/web/Dockerfile",
      });
    });
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
      build: autoBuild(facts),
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
      keepExternalServices: { supabase: true },
      dnsProvider: "other",
      domain: "app.example.org",
    });
    const options = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    for (const option of options) {
      const plan = optionToPlan(option, {
        facts,
        requirements,
        now: NOW,
        codeChanges: [],
        build: autoBuild(facts),
      });
      expect(serviceOf(plan, "postgres")).toBeUndefined();
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
    const plan = optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
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
    const plan = optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
    expect(serviceOf(plan, "valkey")).toBeDefined();
    expect(plan.app.env).toEqual([{ name: "REDIS_URL", secret: true, source: "derived" }]);
    expect(plan.app.port).toBe(8000);
    expect(plan.app.healthPath).toBe("/health");
  });
});

describe("connection settings under the app's own names (FR-814)", () => {
  type EnvVar = ProjectFacts["envVars"][number];
  const variable = (name: string, extra: Partial<EnvVar> = {}): EnvVar => ({
    name,
    files: ["app/project/config.py"],
    clientExposed: false,
    secretLikely: false,
    ...extra,
  });
  const envVars = [
    variable("BROKER_URL"),
    variable("CELERY_BROKER_URI"),
    variable("CELERY_RESULT_BACKEND"),
    // `getenv("DATABASE_URI", "sqlite://")`: the default is for development only.
    variable("DATABASE_URI", { secretLikely: true, hasDefault: true }),
    variable("FLASK_ENV", { hasDefault: true }),
    variable("FLASK_JWT_SECRET_KEY", { secretLikely: true }),
    variable("FLASK_MAIL_PASSWORD", { secretLikely: true }),
    variable("FLASK_REDIS_URL"),
    variable("FLASK_SECRET_KEY", { secretLikely: true }),
    variable("MAPBOX_API_KEY", { secretLikely: true }),
    variable("SQLALCHEMY_DATABASE_URI", { secretLikely: true }),
    variable("STRIPE_SECRET_KEY", { secretLikely: true }),
  ];

  const BOTH: ProjectFacts["services"] = [
    { kind: "postgres", evidence: ["dependency:psycopg2-binary"] },
    { kind: "queue", evidence: ["dependency:celery"] },
    { kind: "redis", evidence: ["dependency:flask-redis"] },
  ];

  async function planFor(services: ProjectFacts["services"], vars: EnvVar[] = envVars) {
    const facts = makeFacts({
      languages: ["python"],
      frameworks: [{ name: "flask", path: "." }],
      envVars: vars,
      services,
    });
    const requirements = makeRequirements();
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    return optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
  }

  it("derives aliases of the planned Postgres and Redis, and generates Flask secret keys", async () => {
    const plan = await planFor(BOTH);
    expect(plan.services).toEqual([
      expect.objectContaining({ name: "db", kind: "postgres", version: "17", memoryMb: 512 }),
      expect.objectContaining({
        name: "cache",
        kind: "valkey",
        version: "8",
        memoryMb: 128,
        options: { mode: "cache" },
      }),
    ]);
    expect(plan.services.every((s) => s.enabled && s.reason !== "" && s.licence !== "")).toBe(true);
    expect(plan.app.env).toEqual([
      { name: "BROKER_URL", secret: true, source: "derived" },
      { name: "CELERY_BROKER_URI", secret: true, source: "derived" },
      { name: "CELERY_RESULT_BACKEND", secret: true, source: "derived" },
      { name: "DATABASE_URI", secret: true, source: "derived" },
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "FLASK_ENV", secret: false, source: "user", optional: true },
      { name: "FLASK_JWT_SECRET_KEY", secret: true, source: "generated" },
      { name: "FLASK_MAIL_PASSWORD", secret: true, source: "user" },
      { name: "FLASK_REDIS_URL", secret: true, source: "derived" },
      { name: "FLASK_SECRET_KEY", secret: true, source: "generated" },
      { name: "MAPBOX_API_KEY", secret: true, source: "user" },
      { name: "REDIS_URL", secret: true, source: "derived" },
      { name: "SQLALCHEMY_DATABASE_URI", secret: true, source: "derived" },
      // Another provider's secret key is a credential the user supplies.
      { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
    ]);
  });

  it("generates only keys the app signs with itself, never another provider's key", async () => {
    const plan = await planFor(BOTH, [
      variable("FLASK_AWS_SECRET_KEY", { secretLikely: true }),
      variable("FLASK_RECAPTCHA_SECRET_KEY", { secretLikely: true }),
      variable("FLASK_STRIPE_SECRET_KEY", { secretLikely: true }),
      variable("FLASK_WTF_CSRF_SECRET_KEY", { secretLikely: true }),
    ]);
    const sources = Object.fromEntries(plan.app.env.map((v) => [v.name, v.source]));
    expect(sources).toMatchObject({
      FLASK_AWS_SECRET_KEY: "user",
      FLASK_RECAPTCHA_SECRET_KEY: "user",
      FLASK_STRIPE_SECRET_KEY: "user",
      FLASK_WTF_CSRF_SECRET_KEY: "generated",
    });
  });

  it("never derives client-exposed names, other engines or non-production databases", async () => {
    const plan = await planFor(BOTH, [
      variable("MONGO_DATABASE_URL", { secretLikely: true }),
      variable("NEXT_PUBLIC_DATABASE_URL", { clientExposed: true }),
      variable("TEST_DATABASE_URL", { secretLikely: true }),
      variable("VITE_DATABASE_URL", { clientExposed: true }),
    ]);
    const sources = Object.fromEntries(plan.app.env.map((v) => [v.name, v.source]));
    expect(sources).toEqual({
      DATABASE_URL: "derived",
      MONGO_DATABASE_URL: "user",
      NEXT_PUBLIC_DATABASE_URL: "user",
      REDIS_URL: "derived",
      TEST_DATABASE_URL: "user",
      VITE_DATABASE_URL: "user",
    });
  });

  it("keeps a variable whose committed example gives another kind of URL user-supplied", async () => {
    const plan = await planFor(BOTH, [
      variable("CELERY_BROKER_URL", { urlScheme: "amqp" }),
      variable("CELERY_RESULT_BACKEND", { urlScheme: "other" }),
      variable("DB_URL", { secretLikely: false, urlScheme: "mysql" }),
      variable("FLASK_REDIS_URL", { urlScheme: "redis" }),
      variable("SQLALCHEMY_DATABASE_URI", { secretLikely: true, urlScheme: "postgres" }),
    ]);
    expect(plan.app.env).toEqual([
      { name: "CELERY_BROKER_URL", secret: false, source: "user" },
      { name: "CELERY_RESULT_BACKEND", secret: false, source: "user" },
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "DB_URL", secret: false, source: "user" },
      { name: "FLASK_REDIS_URL", secret: true, source: "derived" },
      { name: "REDIS_URL", secret: true, source: "derived" },
      { name: "SQLALCHEMY_DATABASE_URI", secret: true, source: "derived" },
    ]);
  });

  it("leaves the aliases to the user when OpsCrew runs neither service", async () => {
    const plan = await planFor([{ kind: "queue", evidence: ["dependency:celery"] }]);
    expect(plan.services).toEqual([]);
    const byName = Object.fromEntries(plan.app.env.map((v) => [v.name, v]));
    expect(byName.DATABASE_URI).toEqual({ name: "DATABASE_URI", secret: true, source: "user" });
    expect(byName.CELERY_BROKER_URI).toEqual({
      name: "CELERY_BROKER_URI",
      secret: false,
      source: "user",
    });
    expect(byName.FLASK_REDIS_URL).toMatchObject({ source: "user" });
    expect(byName.DATABASE_URL).toBeUndefined();
    expect(byName.REDIS_URL).toBeUndefined();
  });

  it("plans a Flask + SQLAlchemy + Celery app end to end from its files", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscrew-plan-flask-"));
    try {
      const files: Record<string, string> = {
        "requirements.txt":
          "Flask==2.2.3\nFlask-SQLAlchemy==3.0.3\npsycopg2-binary==2.9.5\ncelery==5.2.7\nflask-redis==0.4.0\n",
        "app/__init__.py": [
          "from os import environ",
          "from flask import Flask",
          "from celery import Celery",
          "celery = Celery(__name__, broker=environ.get('CELERY_BROKER_URI'))",
          "def create_app():",
          "    app = Flask(__name__)",
          "    app.config['SQLALCHEMY_DATABASE_URI'] = environ.get('DATABASE_URI', 'sqlite://')",
          "    app.config.from_prefixed_env()",
          "    return app",
        ].join("\n"),
        "docker/dev/.env": [
          "POSTGRES_PASSWORD=",
          "CELERY_BROKER_URI=redis://redis:6379/0",
          "FLASK_SECRET_KEY=",
          "FLASK_MAIL_SERVER=",
          "FLASK_REDIS_URL=redis://redis:6379/0",
        ].join("\n"),
      };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const facts = await detectProject(root);
      const requirements = makeRequirements();
      const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
      if (!option) throw new Error("no option");
      const plan = optionToPlan(option, {
        facts,
        requirements,
        now: NOW,
        codeChanges: [],
        build: autoBuild(facts),
      });
      expect(plan.services.map((s) => s.kind)).toEqual(["postgres", "valkey"]);
      expect(plan.app.env).toEqual([
        { name: "CELERY_BROKER_URI", secret: true, source: "derived" },
        { name: "DATABASE_URI", secret: true, source: "derived" },
        { name: "DATABASE_URL", secret: true, source: "derived" },
        { name: "FLASK_MAIL_SERVER", secret: false, source: "user" },
        { name: "FLASK_REDIS_URL", secret: true, source: "derived" },
        { name: "FLASK_SECRET_KEY", secret: true, source: "generated" },
        { name: "REDIS_URL", secret: true, source: "derived" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans a Django + Celery + MySQL + S3 app on Hetzner, and provisions its variables", async () => {
    const variable = (name: string, extra: Partial<ProjectFacts["envVars"][number]> = {}) => ({
      name,
      files: [".env.example"],
      clientExposed: false,
      secretLikely: false,
      ...extra,
    });
    const facts = makeFacts({
      name: "shop",
      languages: ["python"],
      frameworks: [{ name: "django", path: "." }],
      appKind: "ssr",
      port: 8000,
      envVars: [
        variable("AWS_STORAGE_BUCKET_NAME"),
        variable("CELERY_BROKER_URL", { urlScheme: "redis" }),
        variable("DATABASE_URL", { secretLikely: true, urlScheme: "mysql" }),
        variable("DJANGO_SECRET_KEY", { secretLikely: true }),
      ],
      services: [
        { kind: "mysql", evidence: ["dependency:mysqlclient"], variable: "DATABASE_URL" },
        { kind: "queue", evidence: ["dependency:celery"] },
        {
          kind: "redis",
          evidence: ["config:redis-broker", "dependency:celery[redis]"],
          variable: "CELERY_BROKER_URL",
        },
        { kind: "s3", evidence: ["dependency:boto3", "dependency:django-storages"] },
      ],
      workers: [
        {
          name: "celery-beat",
          command: "celery -A shop beat --loglevel=info",
          source: "library",
          single: true,
          evidence: ["code:celery-beat", "dependency:celery"],
        },
        {
          name: "celery-worker",
          command: "celery -A shop worker --loglevel=info",
          source: "library",
          single: false,
          evidence: ["dependency:celery"],
        },
      ],
      objectStorage: {
        client: "django-storages",
        presignedUploads: false,
        variables: ["AWS_STORAGE_BUCKET_NAME"],
      },
    });
    const requirements = makeRequirements({
      dnsProvider: "cloudflare",
      domain: "shop.example.com",
      keepExternalServices: { s3: false },
    });
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const plan = optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
    expect(plan.app.memoryMb).toBe(512);
    expect(plan.processes.workers.map((w) => [w.name, w.single, w.memoryMb])).toEqual([
      ["celery-beat", true, 256],
      ["celery-worker", false, 256],
    ]);
    expect(plan.services).toEqual([
      expect.objectContaining({
        name: "mysql",
        kind: "mysql",
        version: "8.4",
        variable: "DATABASE_URL",
      }),
      expect.objectContaining({
        name: "queue",
        kind: "valkey",
        options: { mode: "queue" },
        variable: "CELERY_BROKER_URL",
      }),
    ]);
    expect(plan.storage?.objectStorage).toMatchObject({ provider: "r2", bucket: "shop-uploads" });
    expect(plan.externalServices).toEqual([]);
    expect(plan.app.env).toEqual([
      // Provision fills in the key the user creates, and R2's endpoint from the Cloudflare account.
      { name: "AWS_ACCESS_KEY_ID", secret: true, source: "derived" },
      { name: "AWS_ENDPOINT_URL_S3", secret: false, source: "derived" },
      { name: "AWS_REGION", secret: false, source: "derived" },
      { name: "AWS_SECRET_ACCESS_KEY", secret: true, source: "derived" },
      { name: "AWS_STORAGE_BUCKET_NAME", secret: false, source: "derived" },
      { name: "CELERY_BROKER_URL", secret: true, source: "derived" },
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "DJANGO_SECRET_KEY", secret: true, source: "generated" },
      { name: "REDIS_URL", secret: true, source: "derived" },
    ]);
    expect(plan.app.env.map((v) => v.name)).not.toContain("CRON_SECRET");

    const key = fakeSecret("aws-access-key-id");
    const endpoint = "https://0123abcd.r2.cloudflarestorage.com";
    const env = await assembleAppEnv({
      plan,
      dotenvText: "",
      storage: { accessKeyId: key, secretAccessKey: fakeSecret("aws-secret-access-key"), endpoint },
    });
    const password = env.generated.services?.mysql?.password;
    const queue = `redis://:${env.generated.services?.queue?.password}@queue:6379`;
    expect(env.values.app).toMatchObject({
      AWS_ACCESS_KEY_ID: key,
      AWS_ENDPOINT_URL_S3: endpoint,
      AWS_REGION: "auto",
      AWS_STORAGE_BUCKET_NAME: "shop-uploads",
      CELERY_BROKER_URL: queue,
      DATABASE_URL: `mysql://app:${password}@mysql:3306/app`,
      REDIS_URL: queue,
    });
  });

  it.each([
    ["Redis 8", "redis", "compose-image:redis"],
    ["Dragonfly", "dragonfly", "compose-image:dragonfly"],
  ] as const)(
    "fills Celery's broker and result backend from %s's queue",
    async (_, kind, compose) => {
      const variable = (name: string) => ({
        name,
        files: ["proj/settings.py"],
        clientExposed: false,
        secretLikely: false,
      });
      const facts = makeFacts({
        languages: ["python"],
        envVars: [variable("CELERY_BROKER_URL"), variable("CELERY_RESULT_BACKEND")],
        services: [
          { kind: "queue", evidence: ["dependency:celery"] },
          { kind: "redis", evidence: [compose, "dependency:celery[redis]"] },
        ],
      });
      const requirements = makeRequirements();
      const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
      if (!option) throw new Error("no option");
      const plan = optionToPlan(option, {
        facts,
        requirements,
        now: NOW,
        codeChanges: [],
        build: autoBuild(facts),
      });
      expect(plan.services).toEqual([
        expect.objectContaining({
          name: "queue",
          kind,
          options: expect.objectContaining({ mode: "queue" }),
        }),
      ]);
      // Dragonfly's threads are capped at the chosen server's vCPUs.
      expect(plan.services[0]?.options).toEqual(
        kind === "dragonfly"
          ? { mode: "queue", lockOnHashtags: false, threads: option.target.vcpus }
          : { mode: "queue" },
      );
      // Each address carries the password, so each is a secret.
      expect(plan.app.env).toEqual([
        { name: "CELERY_BROKER_URL", secret: true, source: "derived" },
        { name: "CELERY_RESULT_BACKEND", secret: true, source: "derived" },
        { name: "REDIS_URL", secret: true, source: "derived" },
      ]);
      const env = await assembleAppEnv({ plan, dotenvText: "" });
      const url = `redis://:${env.generated.services?.queue?.password}@queue:6379`;
      expect(env.values.app).toMatchObject({
        CELERY_BROKER_URL: url,
        CELERY_RESULT_BACKEND: url,
        REDIS_URL: url,
      });
    },
  );

  it("keeps Dragonfly's threads from plan.yaml, and sets none in a Portainer", async () => {
    const facts = makeFacts({
      services: [{ kind: "redis", evidence: ["compose-image:dragonfly", "dependency:ioredis"] }],
    });
    const requirements = makeRequirements();
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const { components } = designComponents({ facts, requirements });
    const edited = {
      ...components,
      services: components.services.map((s) =>
        s.kind === "dragonfly" ? { ...s, options: { ...s.options, threads: 1 } } : s,
      ),
    };
    const input = { facts, requirements, now: NOW, codeChanges: [], build: autoBuild(facts) };
    const kept = optionToPlan(option, { ...input, components: edited });
    expect(kept.services[0]?.options).toMatchObject({ threads: 1 });
    const portainer = { ...option, target: { ...option.target, provider: "portainer" as const } };
    const stack = {
      ...input,
      components,
      portainer: {
        environmentId: 3,
        arch: "amd64",
        redeploy: "updater",
        web: { mode: "proxy", port: 8080 },
      } as const,
    };
    expect(optionToPlan(portainer, stack).services[0]?.options).not.toHaveProperty("threads");
  });

  it("generates CRON_SECRET for the cron jobs that call the app's routes (FR-1309)", async () => {
    const facts = makeFacts({
      envVars: [
        {
          name: "CRON_SECRET",
          files: ["app/api/cron/route.ts"],
          clientExposed: false,
          secretLikely: true,
        },
      ],
      cronJobs: [{ schedule: "0 5 * * *", route: "/api/cron/cleanup", source: "vercel.json" }],
    });
    const requirements = makeRequirements();
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    const plan = optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
    expect(plan.processes.cron).toEqual([
      { name: "cleanup", schedule: "0 5 * * *", route: "/api/cron/cleanup", enabled: true },
    ]);
    expect(plan.app.env).toEqual([{ name: "CRON_SECRET", secret: true, source: "generated" }]);
  });

  it("never builds a dev container's Dockerfile as the app's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscrew-plan-devcontainer-"));
    try {
      const files: Record<string, string> = {
        "package.json": JSON.stringify({
          name: "api",
          scripts: { start: "node server.js" },
          dependencies: { express: "^5" },
        }),
        "server.js": "app.listen(process.env.PORT);\n",
        ".devcontainer/Dockerfile": "FROM mcr.microsoft.com/devcontainers/javascript-node:22\n",
      };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const facts = await detectProject(root);
      const requirements = makeRequirements();
      const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
      if (!option) throw new Error("no option");
      const build = autoBuild(facts);
      expect(build.builder).toBe("generated-dockerfile");
      const codeChanges = deriveCodeChanges(facts, build.builder);
      const plan = optionToPlan(option, { facts, requirements, now: NOW, codeChanges, build });
      expect(plan.app.dockerfile).toBe("Dockerfile");
      expect(plan.codeChanges.find((c) => c.kind === "dockerfile")?.path).toBe("Dockerfile");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    return optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
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
    expect(serviceOf(plan, "postgres")).toBeDefined();
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

describe("examples/rails-api and examples/laravel-app: production defaults", () => {
  async function examplePlan(name: string) {
    const root = fileURLToPath(new URL(`../../../../examples/${name}/`, import.meta.url));
    const facts = await detectProject(root);
    const requirements = makeRequirements();
    const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
    if (!option) throw new Error("no option");
    return optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
    });
  }
  const byName = (plan: Awaited<ReturnType<typeof examplePlan>>) =>
    Object.fromEntries(plan.app.env.map((v) => [v.name, v]));

  it("plans RAILS_ENV as derived and SECRET_KEY_BASE as generated for Rails", async () => {
    const env = byName(await examplePlan("rails-api"));
    expect(env.RAILS_ENV).toEqual({ name: "RAILS_ENV", secret: false, source: "derived" });
    expect(env.SECRET_KEY_BASE).toEqual({
      name: "SECRET_KEY_BASE",
      secret: true,
      source: "generated",
    });
  });

  it("plans Laravel's production settings as derived and APP_KEY as generated", async () => {
    const plan = await examplePlan("laravel-app");
    const env = byName(plan);
    for (const name of ["APP_DEBUG", "APP_ENV", "LOG_CHANNEL"]) {
      expect(env[name]).toEqual({ name, secret: false, source: "derived" });
    }
    expect(env.APP_KEY).toEqual({ name: "APP_KEY", secret: true, source: "generated" });
    // A run without a value for any of them still has them all.
    const assembled = await assembleAppEnv({ plan, ask: async () => ({ skip: true }) });
    expect(assembled.values.app).toMatchObject({ APP_ENV: "production", APP_DEBUG: "false" });
    expect(serializeArtifact("plan", plan)).not.toContain(assembled.values.app.APP_KEY as string);
  });
});
