import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";

export const SERVER_IPV4 = "203.0.113.10";
export const SERVER_IPV6 = "2a01:4f8:c17:1234::1";
/** Inside Cloudflare's published 104.16.0.0/13 range. */
export const CLOUDFLARE_IPV4 = "104.21.32.1";
export const CLOUDFLARE_IPV6 = "2606:4700:3030::6815:2001";
export const CLOUDFLARE_RANGES = {
  ipv4: ["104.16.0.0/13", "172.64.0.0/13"],
  ipv6: ["2606:4700::/32"],
};

export interface TestPlanOptions {
  domain?: string;
  proxied?: boolean;
  www?: boolean;
  ip?: boolean;
  httpAllowedFrom?: "any" | "cloudflare";
  sshAllowedCidrs?: string[];
}

/** A deploy plan for the `shop` app, with a domain by default and the server provisioned. */
export function testPlan(o: TestPlanOptions = {}): DeployPlan {
  const domain = "domain" in o ? o.domain : "shop.example.com";
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: true,
    },
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
    deployment: o.ip === false ? {} : { serverIpv4: SERVER_IPV4, serverIpv6: SERVER_IPV6 },
  });
}
