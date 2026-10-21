import {
  type AppBuild,
  type DeployPlan,
  DeployPlanSchema,
  type PlanService,
} from "@opscrew/plan-schema";
import type { RenderContext } from "../types";

/**
 * The `app.build.probe` design records for `builder` and `language` (agents' `probeFor`, for a
 * stack other than a static site, whose generated image gets `wget`).
 */
export function designProbe(
  builder: AppBuild["builder"],
  language: AppBuild["runtime"]["language"],
): NonNullable<AppBuild["probe"]> {
  switch (builder) {
    case "own-dockerfile":
      return "none";
    case "generated-dockerfile":
      return language === "python" ? "python" : "node";
    case "buildpacks":
      return language === "ruby" ? "ruby" : "bash";
    case "railpack":
      return language === "ruby" ? "ruby" : language === "php" ? "php" : "bash";
  }
}

/** Cloudflare edge ranges used by the tests (a short, fixed subset, IPv4 then IPv6). */
export const CF_RANGES = ["173.245.48.0/20", "103.21.244.0/22", "2400:cb00::/32"];

export const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE opscrew-deploy";

export interface TestPlanOptions {
  provider?: "hetzner" | "digitalocean" | "own";
  /** Own servers only: how the internet reaches the server (default public). */
  access?: "public" | "tunnel";
  /** Own servers only (default amd64). */
  arch?: "amd64" | "arm64";
  /** `plan.portainer`; absent means none. */
  portainer?: {
    access?: "local" | "subdomain";
    hostname?: string;
    allowedEmails?: readonly string[];
  };
  domain?: string;
  www?: boolean;
  backups?: boolean;
  postgres?: boolean;
}

const TARGETS = {
  hetzner: { location: "nbg1", serverType: "cx23", image: "ubuntu-24.04", currency: "EUR" },
  digitalocean: {
    location: "fra1",
    serverType: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    currency: "USD",
  },
} as const;

/** The services design writes for an app on PostgreSQL (`db`) and one on Redis (`cache`). */
export function testServices(o: { postgres?: boolean; redis?: boolean }): PlanService[] {
  return [
    ...(o.postgres
      ? [
          {
            name: "db",
            kind: "postgres",
            version: "17",
            memoryMb: 512,
            enabled: true,
            options: {},
            reason: "The app uses PostgreSQL.",
            licence: "PostgreSQL",
          } as const,
        ]
      : []),
    ...(o.redis
      ? [
          {
            name: "cache",
            kind: "valkey",
            version: "8",
            memoryMb: 128,
            enabled: true,
            options: { mode: "cache" },
            reason: "The app uses Redis.",
            licence: "BSD-3-Clause",
          } as const,
        ]
      : []),
  ];
}

/** A valid deploy plan for `shop` on the given provider (Hetzner by default). */
export function testPlan(o: TestPlanOptions = {}): DeployPlan {
  const provider = o.provider ?? "hetzner";
  const t = TARGETS[provider === "own" ? "hetzner" : provider];
  const amount = provider === "digitalocean" ? 15.6 : 7.09;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
    target:
      provider === "own"
        ? { provider, mode: "vps-compose", arch: o.arch ?? "amd64", access: o.access ?? "public" }
        : {
            provider,
            mode: "vps-compose",
            location: t.location,
            serverType: t.serverType,
            image: t.image,
            backups: o.backups ?? true,
          },
    services: testServices({ postgres: o.postgres ?? true }),
    externalServices: o.postgres === false ? ["supabase"] : [],
    cost: {
      monthly: { amount, currency: t.currency },
      breakdown: [{ item: "server", monthly: { amount, currency: t.currency } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-12T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: o.domain
      ? {
          provider: "cloudflare",
          domain: o.domain,
          zone: "example.com",
          proxied: true,
          www: o.www ?? false,
        }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    ...(o.portainer === undefined
      ? {}
      : { portainer: { enabled: true, version: "2.33.1", ...o.portainer } }),
  });
}

/** Render context with the fixed test deploy key. */
export function testContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    opscrewVersion: "0.1.0",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: `${PUBLIC_KEY}\n`,
    ...overrides,
  };
}

/** Cloudflare render context for a zone. */
export function testCloudflare(): NonNullable<RenderContext["cloudflare"]> {
  return { zoneId: "0123456789abcdef0123456789abcdef" };
}

/** Cloudflare account id used by the tunnel and Access tests. */
export const ACCOUNT_ID = "fedcba9876543210fedcba9876543210";

/** Id of the account's one-time PIN login method used by the Portainer Access tests. */
export const ONE_TIME_PIN_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

/**
 * {@link testCloudflare} with the account id the tunnel and Access need, and the one-time PIN
 * login method Portainer's Access needs.
 */
export function testCloudflareAccount(
  overrides: Partial<NonNullable<RenderContext["cloudflare"]>> = {},
): NonNullable<RenderContext["cloudflare"]> {
  return {
    ...testCloudflare(),
    accountId: ACCOUNT_ID,
    oneTimePinIdentityProviderId: ONE_TIME_PIN_ID,
    ...overrides,
  };
}
