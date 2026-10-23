import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { selfHostedServices } from "../design/sizing";
import {
  assembleAppEnv,
  dotenvLine,
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
    services: selfHostedServices({ postgres: true, redis: false }),
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
    // prod's, by default.
    const own = { environment: "prod", localFile: ".env", localValueAvailable: false };
    expect(asked).toEqual([
      { name: "DJANGO_DEBUG", secret: false, ...own, optional: true },
      { name: "STRIPE_SECRET_KEY", secret: true, ...own, optional: false },
    ]);
    expect(result.defaulted).toEqual(["DJANGO_DEBUG"]);
    expect(parseDotenv(result.appEnv).get("STRIPE_SECRET_KEY")).toBe(stripe);
    expect(parseDotenv(result.appEnv).get("DJANGO_ALLOWED_HOSTS")).toBe(ADDRESS);
  });
});

describe("assembleAppEnv: production defaults for Rails and Laravel", () => {
  /** The variables `design` adds for Rails and Laravel. */
  const RAILS: Env = [
    { name: "RAILS_ENV", secret: false, source: "derived" },
    { name: "SECRET_KEY_BASE", secret: true, source: "generated" },
  ];
  const LARAVEL: Env = [
    { name: "APP_DEBUG", secret: false, source: "derived" },
    { name: "APP_ENV", secret: false, source: "derived" },
    { name: "APP_KEY", secret: true, source: "generated" },
    { name: "LOG_CHANNEL", secret: false, source: "derived" },
  ];

  it("sets the production settings and generates the keys in the frameworks' formats", async () => {
    const rails = await assembleAppEnv({ plan: plan(RAILS), dotenvText: "" });
    expect(rails.values.app.RAILS_ENV).toBe("production");
    expect(rails.values.app.SECRET_KEY_BASE).toMatch(/^[0-9a-f]{128}$/);
    expect(rails.generated.env).toEqual({ SECRET_KEY_BASE: rails.values.app.SECRET_KEY_BASE });

    const laravel = await assembleAppEnv({ plan: plan(LARAVEL), dotenvText: "" });
    const { APP_KEY, ...settings } = laravel.values.app;
    expect(settings).toMatchObject({ APP_ENV: "production", APP_DEBUG: "false" });
    expect(settings.LOG_CHANNEL).toBe("stderr");
    expect(APP_KEY).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(APP_KEY?.slice("base64:".length) ?? "", "base64")).toHaveLength(32);
    expect(laravel.generated.env).toEqual({ APP_KEY });
    expect(parseDotenv(laravel.appEnv).get("APP_KEY")).toBe(APP_KEY);
  });

  it("keeps the generated keys between runs", async () => {
    const first = await assembleAppEnv({ plan: plan(LARAVEL), dotenvText: "" });
    const again = await assembleAppEnv({
      plan: plan(LARAVEL),
      dotenvText: "",
      previous: first.generated,
    });
    expect(again.values.app.APP_KEY).toBe(first.values.app.APP_KEY);
  });

  it("lets a value the user set in the production env file win", async () => {
    const key = `base64:${Buffer.from(fakeSecret("generic-password")).toString("base64")}`;
    const result = await assembleAppEnv({
      plan: plan(LARAVEL),
      dotenvText: `APP_ENV=staging\nAPP_KEY=${key}\n`,
      previous: { env: { APP_KEY: "base64:from-an-earlier-run" } },
    });
    expect(result.values.app).toMatchObject({ APP_ENV: "staging", APP_KEY: key });
    expect(result.values.app.APP_DEBUG).toBe("false");
    // The user's value is theirs: it is not stored with the generated ones.
    expect(result.generated.env).toEqual({});
  });

  it("ignores the local .env of an interactive run, which holds development values", async () => {
    const result = await assembleAppEnv({
      plan: plan(LARAVEL),
      dotenvText: "APP_ENV=local\nAPP_DEBUG=true\nAPP_KEY=base64:local-development-key\n",
      ask: async () => {
        throw new Error("OpsCrew never asks for a derived or generated value");
      },
    });
    expect(result.values.app).toMatchObject({ APP_ENV: "production", APP_DEBUG: "false" });
    expect(result.values.app.APP_KEY).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
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
    return { ...base, services: selfHostedServices({ postgres: true, redis: true }) };
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
    expect(values.get("REDIS_URL")).toBe("redis://:db-password-0123456789@cache:6379");
    expect(values.get("CELERY_BROKER_URI")).toBe("redis://:db-password-0123456789@cache:6379");
    expect(values.get("FLASK_REDIS_URL")).toBe("redis://:db-password-0123456789@cache:6379");
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

  it("splits the build values: the ones the plan marks secret go only to the build secrets", async () => {
    const key = fakeSecret("openai-key", "build");
    const env: Env = [
      { name: "NEXT_PUBLIC_SITE", secret: false, source: "user" },
      { name: "NEXT_PUBLIC_OPENAI_KEY", secret: true, source: "user" },
      { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
    ];
    const result = await assembleAppEnv({
      plan: plan(env),
      dotenvText: `NEXT_PUBLIC_SITE=https://shop.example.com\nNEXT_PUBLIC_OPENAI_KEY=${key}\nSTRIPE_SECRET_KEY=x\n`,
      password: () => "db-password-0123456789",
    });
    expect(result.buildEnv).toBe("NEXT_PUBLIC_SITE=https://shop.example.com\n");
    expect(result.buildSecrets).toBe(`NEXT_PUBLIC_OPENAI_KEY=${key}\n`);
    expect(result.appEnv).not.toContain("NEXT_PUBLIC_");
    expect(result.names).toEqual([
      "DATABASE_URL",
      "NEXT_PUBLIC_OPENAI_KEY",
      "NEXT_PUBLIC_SITE",
      "STRIPE_SECRET_KEY",
    ]);
    // Without a secret build value the build secrets are empty, like the build values.
    const plain = await assembleAppEnv({
      plan: plan([]),
      password: () => "db-password-0123456789",
    });
    expect([plain.buildEnv, plain.buildSecrets]).toEqual(["\n", "\n"]);
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

describe("assembleAppEnv: exact values", () => {
  it("returns every value exactly as set, next to the unchanged env-file texts", async () => {
    const tricky = `it's "quoted" $HOME \n and\na newline`;
    const secret = fakeSecret("stripe-live-key");
    const env: Env = [
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "TRICKY", secret: true, source: "user" },
      { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
      { name: "NEXT_PUBLIC_SITE", secret: false, source: "user" },
      { name: "SESSION_SECRET", secret: true, source: "generated" },
      { name: "DJANGO_DEBUG", secret: false, source: "user", optional: true },
    ];
    const answers: Record<string, string> = {
      TRICKY: tricky,
      STRIPE_SECRET_KEY: secret,
      NEXT_PUBLIC_SITE: "https://shop.example.com",
    };
    const result = await assembleAppEnv({
      plan: plan(env),
      ask: async (question) =>
        question.name in answers ? { value: answers[question.name] as string } : { skip: true },
      password: () => "generated-value-0123456789",
    });
    expect(result.values).toEqual({
      app: {
        DATABASE_URL: "postgresql://app:generated-value-0123456789@db:5432/app",
        SESSION_SECRET: "generated-value-0123456789",
        STRIPE_SECRET_KEY: secret,
        TRICKY: tricky,
      },
      build: { NEXT_PUBLIC_SITE: "https://shop.example.com" },
      db: { user: "app", name: "app", password: "generated-value-0123456789" },
      services: { db: { password: "generated-value-0123456789" } },
    });
    // The env-file texts are what they always were (the value with a quote is escaped for Compose).
    expect(result.appEnv).toBe(
      [
        "DATABASE_URL=postgresql://app:generated-value-0123456789@db:5432/app",
        "SESSION_SECRET=generated-value-0123456789",
        `STRIPE_SECRET_KEY=${secret}`,
        dotenvLine("TRICKY", tricky),
        "",
      ].join("\n"),
    );
    expect(result.buildEnv).toBe("NEXT_PUBLIC_SITE=https://shop.example.com\n");
    expect(result.defaulted).toEqual(["DJANGO_DEBUG"]);
  });
});

describe("assembleAppEnv: the services' variables from the catalog (FR-1314)", () => {
  const VERSIONS: Record<string, string> = {
    garage: "2.4",
    kafka: "4.3",
    mysql: "8.4",
    postgres: "17",
    rabbitmq: "4.3",
    valkey: "8",
  };
  const entry = (kind: string, extra: Record<string, unknown> = {}) => ({
    kind,
    version: VERSIONS[kind],
    memoryMb: 512,
    reason: "The app uses it.",
    licence: "test",
    ...extra,
  });
  const derived = (name: string, secret = false) => ({ name, secret, source: "derived" as const });
  const withComponents = (env: Env, components: Record<string, unknown>): DeployPlan =>
    DeployPlanSchema.parse({ ...plan(env), ...components });
  const HEX = /^[0-9a-f]{64}$/;

  it("fills each running service's variables, with secrets generated once and kept", async () => {
    const components = {
      services: [
        entry("mysql"),
        entry("rabbitmq", { variable: "CELERY_BROKER_URL" }),
        entry("valkey", { options: { mode: "queue" } }),
        entry("kafka"),
      ],
    };
    const env: Env = [derived("CELERY_BROKER_URL", true), derived("DATABASE_URL", true)];
    const first = await assembleAppEnv({ plan: withComponents(env, components), dotenvText: "" });
    const mysql = first.generated.services?.mysql;
    const rabbitmq = first.generated.services?.rabbitmq;
    expect(mysql?.password).toMatch(HEX);
    expect(mysql?.["root-password"]).toMatch(HEX);
    expect(rabbitmq?.password).toMatch(HEX);
    const queue = first.generated.services?.queue;
    expect(queue?.password).toMatch(HEX);
    const amqp = `amqp://app:${rabbitmq?.password}@rabbitmq:5672/%2F`;
    expect(first.values.app).toEqual({
      AMQP_URL: amqp,
      CELERY_BROKER_URL: amqp,
      DATABASE_URL: `mysql://app:${mysql?.password}@mysql:3306/app`,
      KAFKA_BOOTSTRAP_SERVERS: "kafka:9092",
      KAFKA_BROKERS: "kafka:9092",
      RABBITMQ_URL: amqp,
      REDIS_URL: `redis://:${queue?.password}@queue:6379`,
    });
    // For the services' own environment.
    expect(first.values.services).toEqual({ mysql, rabbitmq, queue });
    const again = await assembleAppEnv({
      plan: withComponents(env, components),
      dotenvText: "",
      previous: first.generated,
    });
    expect(again.values.app).toEqual(first.values.app);
    expect(again.generated).toEqual(first.generated);
  });

  it("gives DATABASE_URL to the database whose variable it is, and the other its own name", async () => {
    const components = {
      services: [
        entry("postgres", { variable: "POSTGRES_URL" }),
        entry("mysql", { variable: "DATABASE_URL" }),
      ],
    };
    const env: Env = [
      derived("DATABASE_URI", true),
      derived("DATABASE_URL", true),
      derived("POSTGRES_URL", true),
    ];
    const result = await assembleAppEnv({
      plan: withComponents(env, components),
      dotenvText: "",
      password: () => "pw",
    });
    expect(result.values.app).toEqual({
      // An alias of Postgres's address keeps Postgres's.
      DATABASE_URI: "postgresql://app:pw@db:5432/app",
      DATABASE_URL: "mysql://app:pw@mysql:3306/app",
      POSTGRES_URL: "postgresql://app:pw@db:5432/app",
    });
    expect(result.values.db?.password).toBe("pw");
  });

  it("generates CRON_SECRET once for the cron jobs that call the app's routes", async () => {
    const env: Env = [{ name: "CRON_SECRET", secret: true, source: "generated" }];
    const first = await assembleAppEnv({ plan: plan(env), dotenvText: "" });
    const secret = first.values.app.CRON_SECRET;
    expect(secret).toMatch(/^\S{32}$/);
    expect(first.generated.env).toMatchObject({ CRON_SECRET: secret });
    const again = await assembleAppEnv({ plan: plan(env), previous: first.generated });
    expect(again.values.app.CRON_SECRET).toBe(secret);
  });

  const storage = (provider: string, region: string) => ({
    provider,
    bucket: "mysite-uploads",
    region,
    expected: { storageGb: 10, egressGbPerMonth: 50 },
    price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
  });

  it("gives Garage's keys, endpoint, region and bucket to the app", async () => {
    const env: Env = [
      derived("AWS_ACCESS_KEY_ID", true),
      derived("AWS_ENDPOINT_URL_S3"),
      derived("AWS_REGION"),
      derived("AWS_S3_ENDPOINT_URL"),
      derived("AWS_SECRET_ACCESS_KEY", true),
      derived("S3_BUCKET"),
    ];
    const result = await assembleAppEnv({
      plan: withComponents(env, {
        services: [entry("garage", { memoryMb: 64, variable: "AWS_S3_ENDPOINT_URL" })],
        storage: { objectStorage: storage("garage", "garage") },
      }),
      dotenvText: "",
    });
    const garage = result.generated.services?.garage;
    expect(garage?.["key-id"]).toMatch(/^GK[0-9a-f]{24}$/);
    expect(garage?.["rpc-secret"]).toMatch(HEX);
    expect(result.values.app).toEqual({
      AWS_ACCESS_KEY_ID: garage?.["key-id"],
      AWS_ENDPOINT_URL_S3: "http://garage:3900",
      AWS_REGION: "garage",
      AWS_S3_ENDPOINT_URL: "http://garage:3900",
      AWS_SECRET_ACCESS_KEY: garage?.["secret-key"],
      S3_BUCKET: "mysite-uploads",
    });
  });

  it("gives a provider's bucket its endpoint, region and name, and the user's stored key", async () => {
    const key = fakeSecret("aws-access-key-id");
    const secret = fakeSecret("aws-secret-access-key");
    const env: Env = [
      derived("AWS_ACCESS_KEY_ID", true),
      derived("AWS_BUCKET"),
      derived("AWS_DEFAULT_REGION"),
      derived("AWS_ENDPOINT_URL_S3"),
      derived("AWS_SECRET_ACCESS_KEY", true),
      derived("AWS_USE_PATH_STYLE_ENDPOINT"),
    ];
    const result = await assembleAppEnv({
      plan: withComponents(env, { storage: { objectStorage: storage("hetzner", "fsn1") } }),
      dotenvText: "",
      storage: { accessKeyId: key, secretAccessKey: secret },
    });
    expect(result.values.app).toMatchObject({
      AWS_ACCESS_KEY_ID: key,
      AWS_BUCKET: "mysite-uploads",
      AWS_DEFAULT_REGION: "fsn1",
      AWS_ENDPOINT_URL_S3: "https://fsn1.your-objectstorage.com",
      AWS_SECRET_ACCESS_KEY: secret,
      AWS_USE_PATH_STYLE_ENDPOINT: "true",
    });
  });

  it("gives R2's endpoint from the stored login, and asks for nothing without it", async () => {
    const env: Env = [
      derived("AWS_ACCESS_KEY_ID", true),
      derived("AWS_ENDPOINT_URL_S3"),
      derived("AWS_SECRET_ACCESS_KEY", true),
    ];
    const plan = withComponents(env, { storage: { objectStorage: storage("r2", "auto") } });
    const login = {
      accessKeyId: fakeSecret("aws-access-key-id"),
      secretAccessKey: fakeSecret("aws-secret-access-key"),
      endpoint: "https://0123abcd.r2.cloudflarestorage.com",
    };
    const result = await assembleAppEnv({ plan, dotenvText: "", storage: login });
    expect(result.values.app).toMatchObject({
      AWS_ACCESS_KEY_ID: login.accessKeyId,
      AWS_ENDPOINT_URL_S3: login.endpoint,
      AWS_SECRET_ACCESS_KEY: login.secretAccessKey,
    });
    // Without the login, the values are missing like any other.
    await expect(assembleAppEnv({ plan, dotenvText: "" })).rejects.toThrow(
      "Production values are missing for: AWS_ACCESS_KEY_ID, AWS_ENDPOINT_URL_S3, AWS_SECRET_ACCESS_KEY.",
    );
  });
});
