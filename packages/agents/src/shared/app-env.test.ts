import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { assembleAppEnv, type EnvQuestion, hostListKind, parseDotenv } from "./app-env";

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
