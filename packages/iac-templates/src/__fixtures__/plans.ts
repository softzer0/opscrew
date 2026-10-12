import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import type { RenderContext } from "../types";

/** Cloudflare edge ranges used by the tests (a short, fixed subset). */
export const CF_RANGES = {
  ipv4: ["173.245.48.0/20", "103.21.244.0/22"],
  ipv6: ["2400:cb00::/32"],
};

export const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE opscrew-deploy";

export interface TestPlanOptions {
  provider?: "hetzner" | "digitalocean";
  domain?: string;
  www?: boolean;
  waf?: boolean;
  backups?: boolean;
  postgres?: boolean;
  ip?: string;
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

/** A valid deploy plan for `shop` on the given provider (Hetzner by default). */
export function testPlan(o: TestPlanOptions = {}): DeployPlan {
  const provider = o.provider ?? "hetzner";
  const t = TARGETS[provider];
  const amount = provider === "hetzner" ? 7.09 : 15.6;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
    target: {
      provider,
      mode: "vps-compose",
      location: t.location,
      serverType: t.serverType,
      image: t.image,
      backups: o.backups ?? true,
    },
    services: { postgres: o.postgres ?? true, redis: false },
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
    security: o.waf === false ? { wafCustomRules: false } : {},
    deployment: o.ip ? { serverIpv4: o.ip, serverIpv6: "2a03:b0c0:3:d0::1" } : {},
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

/** Cloudflare render context for a zone (rulesets managed unless `manage` is false). */
export function testCloudflare(manage = true): NonNullable<RenderContext["cloudflare"]> {
  return {
    zoneId: "0123456789abcdef0123456789abcdef",
    manageConfigRule: manage,
    manageWafRules: manage,
    ipRanges: CF_RANGES,
  };
}
