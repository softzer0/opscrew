import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  assembleAppEnv,
  type EnvQuestion,
  hostListKind,
  parseDotenv,
  serviceUrlKind,
} from "./app-env";

type Env = DeployPlan["app"]["env"];

function plan(env: Env, dns: Record<string, unknown> = { provider: "none" }): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    app: { name: "mysite", port: 8000, healthPath: "/health", env },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: false,
    },
    services: { postgres: true, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 5.99, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount: 5.99, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    dns: { proxied: false, ...dns },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
  });
}

/** The `examples/django-postgres` variables as `design` plans them. */
const DJANGO: Env = [
  { name: "CSRF_TRUSTED_ORIGINS", secret: false, source: "derived" },
  { name: "DATABASE_URL", secret: true, source: "derived" },
  { name: "DJANGO_ALLOWED_HOSTS", secret: false, source: "derived", optional: true },
  { name: "DJANGO_DEBUG", secret: false, source: "user", optional: true },
  { name: "DJANGO_SECRET_KEY", secret: true, source: "generated" },
];

const ADDRESS = "203.0.113.7";

describe("host-list variables", () => {
  it.each([
    ["ALLOWED_HOSTS", "hosts"],
    ["DJANGO_ALLOWED_HOSTS", "hosts"],
    ["CSRF_TRUSTED_ORIGINS", "origins"],
    ["DJANGO_CSRF_TRUSTED_ORIGINS", "origins"],
    ["ALLOWED_HOSTS_EXTRA", undefined],
    ["DISALLOWED_HOSTS", undefined],
    ["TRUSTED_ORIGINS", undefined],
  ])("%s → %s", (name, kind) => {
    expect(hostListKind(name)).toBe(kind);
  });
});

describe("assembleAppEnv: defaults and host lists", () => {
  it("provisions the Django example from an empty env file with the domain as host list", async () => {
    const result = await assembleAppEnv({
      plan: plan(DJANGO, { provider: "none", domain: "shop.example.com", www: true }),
      dotenvText: "",
      serverHost: ADDRESS,
      password: () => "generated-value-0123456789",
    });
    const values = parseDotenv(result.appEnv);
    expect(values.get("DJANGO_ALLOWED_HOSTS")).toBe("shop.example.com,www.shop.example.com");
    expect(values.get("CSRF_TRUSTED_ORIGINS")).toBe(
      "https://shop.example.com,https://www.shop.example.com",
    );
    expect(values.has("DJANGO_DEBUG")).toBe(false);
    expect(values.get("DJANGO_SECRET_KEY")).toBe("generated-value-0123456789");
    expect(result.appEnv).not.toContain(ADDRESS);
    expect(result.defaulted).toEqual(["DJANGO_DEBUG"]);
    expect(result.unresolved).toEqual([]);
    expect(result.names).toEqual([
      "CSRF_TRUSTED_ORIGINS",
      "DATABASE_URL",
      "DJANGO_ALLOWED_HOSTS",
      "DJANGO_SECRET_KEY",
    ]);
  });

  it("uses the server's address without a domain, only in the assembled environment", async () => {
    const result = await assembleAppEnv({
      plan: plan(DJANGO),
      dotenvText: "DJANGO_ALLOWED_HOSTS=localhost\n",
      serverHost: ADDRESS,
    });
    const values = parseDotenv(result.appEnv);
    expect(values.get("DJANGO_ALLOWED_HOSTS")).toBe(ADDRESS);
    expect(values.get("CSRF_TRUSTED_ORIGINS")).toBe(`http://${ADDRESS}`);
    expect(JSON.stringify(result.generated)).not.toContain(ADDRESS);
    expect(result.names.join(" ")).not.toContain(ADDRESS);
  });

  it("leaves host lists for later when neither a domain nor the address is known", async () => {
    const result = await assembleAppEnv({ plan: plan(DJANGO), dotenvText: "" });
    const values = parseDotenv(result.appEnv);
    expect(values.has("DJANGO_ALLOWED_HOSTS")).toBe(false);
    expect(values.has("CSRF_TRUSTED_ORIGINS")).toBe(false);
    expect(result.unresolved).toEqual(["CSRF_TRUSTED_ORIGINS", "DJANGO_ALLOWED_HOSTS"]);
  });

  it("keeps a value from the env file for an optional variable", async () => {
    const result = await assembleAppEnv({ plan: plan(DJANGO), dotenvText: "DJANGO_DEBUG=0\n" });
    expect(parseDotenv(result.appEnv).get("DJANGO_DEBUG")).toBe("0");
    expect(result.defaulted).toEqual([]);
  });

  it("still stops on a missing required variable, naming only the required ones", async () => {
    const env: Env = [...DJANGO, { name: "STRIPE_SECRET_KEY", secret: true, source: "user" }];
    const failure = assembleAppEnv({ plan: plan(env), dotenvText: "", serverHost: ADDRESS });
    await expect(failure).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Production values are missing for: STRIPE_SECRET_KEY.",
    });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining(ADDRESS) });
  });

  it("asks for optional variables, says they are optional and keeps the default on skip", async () => {
    const stripe = fakeSecret("stripe-live-key");
    const env: Env = [...DJANGO, { name: "STRIPE_SECRET_KEY", secret: true, source: "user" }];
    const asked: EnvQuestion[] = [];
    const result = await assembleAppEnv({
      plan: plan(env),
      dotenvText: "",
      serverHost: ADDRESS,
      ask: async (question) => {
        asked.push(question);
        return question.name === "STRIPE_SECRET_KEY" ? { value: stripe } : { skip: true };
      },
    });
    expect(asked).toEqual([
      { name: "DJANGO_DEBUG", secret: false, localValueAvailable: false, optional: true },
      { name: "STRIPE_SECRET_KEY", secret: true, localValueAvailable: false, optional: false },
    ]);
    expect(result.defaulted).toEqual(["DJANGO_DEBUG"]);
    expect(parseDotenv(result.appEnv).get("STRIPE_SECRET_KEY")).toBe(stripe);
    expect(parseDotenv(result.appEnv).get("DJANGO_ALLOWED_HOSTS")).toBe(ADDRESS);
  });
});

describe("connection settings under the app's own names (FR-814)", () => {
  it.each([
    ["DATABASE_URL", "postgres"],
    ["DATABASE_URI", "postgres"],
    ["SQLALCHEMY_DATABASE_URI", "postgres"],
    ["POSTGRES_URL", "postgres"],
    ["POSTGRES_URI", "postgres"],
    ["DB_URL", "postgres"],
    ["DB_URI", "postgres"],
    ["APP_DATABASE_URL", "postgres"],
    ["FLASK_SQLALCHEMY_DATABASE_URI", "postgres"],
    ["REDIS_URL", "redis"],
    ["REDIS_URI", "redis"],
    ["FLASK_REDIS_URL", "redis"],
    ["CACHE_REDIS_URI", "redis"],
    ["CELERY_BROKER_URL", "redis"],
    ["CELERY_BROKER_URI", "redis"],
    ["BROKER_URL", "redis"],
    ["CELERY_RESULT_BACKEND", "redis"],
    ["DATABASE_NAME", undefined],
    ["POSTGRES_PASSWORD", undefined],
    ["MONGO_DB_URL", undefined],
    ["REDIS_HOST", undefined],
    ["REDIS_URL_EXTRA", undefined],
    // Another engine or a database that is not production's.
    ["MONGO_DATABASE_URL", undefined],
    ["MYSQL_DATABASE_URI", undefined],
    ["TEST_DATABASE_URL", undefined],
    ["APP_TEST_DATABASE_URL", undefined],
    ["SHADOW_DATABASE_URL", undefined],
    ["CLICKHOUSE_DATABASE_URL", undefined],
    ["TEST_REDIS_URL", undefined],
    // Bundlers ship these to browsers: never fill them with a connection URL.
    ["NEXT_PUBLIC_DATABASE_URL", undefined],
    ["VITE_DATABASE_URL", undefined],
    ["VITE_REDIS_URL", undefined],
  ])("%s → %s", (name, kind) => {
    expect(serviceUrlKind(name)).toBe(kind);
  });

  const SLOG: Env = [
    { name: "CELERY_BROKER_URI", secret: false, source: "derived" },
    { name: "DATABASE_URI", secret: true, source: "derived" },
    { name: "DATABASE_URL", secret: true, source: "derived" },
    { name: "FLASK_REDIS_URL", secret: false, source: "derived" },
    { name: "FLASK_SECRET_KEY", secret: true, source: "generated" },
    { name: "MAPBOX_API_KEY", secret: true, source: "user" },
    { name: "REDIS_URL", secret: false, source: "derived" },
  ];
  const withRedis = (env: Env): DeployPlan => {
    const base = plan(env);
    return { ...base, services: { ...base.services, postgres: true, redis: true } };
  };

  it("fills database and Redis aliases from the services OpsCrew runs", async () => {
    const mapbox = fakeSecret("google-api-key");
    const result = await assembleAppEnv({
      plan: withRedis(SLOG),
      // A local development value never replaces a derived one.
      dotenvText: `MAPBOX_API_KEY=${mapbox}\nDATABASE_URI=postgresql://local/dev\n`,
      password: () => "db-password-0123456789",
    });
    const values = parseDotenv(result.appEnv);
    expect(values.get("DATABASE_URL")).toBe("postgresql://app:db-password-0123456789@db:5432/app");
    // SQLAlchemy accepts only `postgresql://`; psycopg2 and node-postgres take both schemes.
    expect(values.get("DATABASE_URI")).toBe("postgresql://app:db-password-0123456789@db:5432/app");
    expect(values.get("REDIS_URL")).toBe("redis://cache:6379");
    expect(values.get("CELERY_BROKER_URI")).toBe("redis://cache:6379");
    expect(values.get("FLASK_REDIS_URL")).toBe("redis://cache:6379");
    expect(values.get("FLASK_SECRET_KEY")).toBe("db-password-0123456789");
    expect(values.get("MAPBOX_API_KEY")).toBe(mapbox);
    expect(result.defaulted).toEqual([]);
  });

  it("never asks for a derived connection setting", async () => {
    const asked: string[] = [];
    await assembleAppEnv({
      plan: withRedis(SLOG),
      dotenvText: "",
      ask: async (question) => {
        asked.push(question.name);
        return { value: "x" };
      },
    });
    expect(asked).toEqual(["MAPBOX_API_KEY"]);
  });

  it("never puts the database password into a client-exposed variable", async () => {
    const env: Env = [
      { name: "DATABASE_URL", secret: true, source: "derived" },
      // Even when a hand-edited plan marks it derived.
      { name: "NEXT_PUBLIC_DATABASE_URL", secret: false, source: "derived" },
      { name: "VITE_DATABASE_URL", secret: false, source: "user" },
    ];
    const result = await assembleAppEnv({
      plan: plan(env),
      dotenvText: "NEXT_PUBLIC_DATABASE_URL=public\nVITE_DATABASE_URL=public\n",
      password: () => "db-password-0123456789",
    });
    expect(result.buildEnv).not.toContain("db-password-0123456789");
    expect(parseDotenv(result.buildEnv).get("NEXT_PUBLIC_DATABASE_URL")).toBe("public");
    expect(parseDotenv(result.appEnv).get("DATABASE_URL")).toContain("db-password-0123456789");
  });

  it("takes the user's value for an alias whose service OpsCrew does not run", async () => {
    const env: Env = [{ name: "CELERY_BROKER_URL", secret: false, source: "derived" }];
    const result = await assembleAppEnv({
      plan: plan(env),
      dotenvText: "CELERY_BROKER_URL=amqp://rabbit\n",
    });
    expect(parseDotenv(result.appEnv).get("CELERY_BROKER_URL")).toBe("amqp://rabbit");
  });
});
