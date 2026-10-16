import { type CloudProvider, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";

export const SERVER_IPV4 = "203.0.113.10";
export const SERVER_IPV6 = "2001:db8::10";
/** The server as OpsCrew's local state records it (`.opscrew/server.json`). */
export const SERVER = { ipv4: SERVER_IPV4, ipv6: SERVER_IPV6 };

export interface TestPlanOptions {
  domain?: string;
  proxied?: boolean;
  www?: boolean;
  /** The server is provisioned (default true): the plan records the apply. */
  ip?: boolean;
  httpAllowedFrom?: "any" | "cloudflare";
  sshAllowedCidrs?: string[];
  /** Cloud provider (default Hetzner). */
  provider?: CloudProvider;
}

const TARGETS = {
  hetzner: { provider: "hetzner", location: "nbg1", serverType: "cx23" },
  digitalocean: {
    provider: "digitalocean",
    location: "fra1",
    serverType: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
  },
} as const;

/** A deploy plan for the `shop` app, with a domain by default and the server provisioned. */
export function testPlan(o: TestPlanOptions = {}): DeployPlan {
  const domain = "domain" in o ? o.domain : "shop.example.com";
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
    target: { mode: "vps-compose", ...TARGETS[o.provider ?? "hetzner"], backups: true },
    services: { postgres: true, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 7.09, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount: 7.09, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: domain
      ? {
          provider: "cloudflare",
          domain,
          zone: "example.com",
          proxied: o.proxied ?? true,
          www: o.www ?? false,
        }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {
      ...(o.httpAllowedFrom ? { httpAllowedFrom: o.httpAllowedFrom } : {}),
      ...(o.sshAllowedCidrs ? { sshAllowedCidrs: o.sshAllowedCidrs } : {}),
    },
    // The server's address is never in the plan: tests record it in the local state.
    deployment: o.ip === false ? {} : { lastApplyAt: "2026-10-01T12:30:00.000Z" },
  });
}
