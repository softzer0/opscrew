import { type DeployPlan, DeployPlanSchema, type PortainerWeb } from "@opscrew/plan-schema";
import { testPlan, testServices } from "../../__fixtures__/plans";

export interface PortainerTestPlanOptions {
  /** How visitors reach the app (default `tunnel`). */
  web?: PortainerWeb;
  /** How a new image reaches Portainer (default `updater`). */
  redeploy?: "updater" | "cloudflare";
  /** Default amd64. */
  arch?: "amd64" | "arm64";
  /** `false` for no domain; default `shop.example.com` on Cloudflare (zone `example.com`). */
  domain?: string | false;
  /** DNS provider of the domain (default `cloudflare`). */
  dnsProvider?: "cloudflare" | "none";
  proxied?: boolean;
  www?: boolean;
  postgres?: boolean;
  redis?: boolean;
  releaseCommand?: string;
  env?: DeployPlan["app"]["env"];
}

/** A valid plan for `shop` on a Portainer target. */
export function portainerTestPlan(o: PortainerTestPlanOptions = {}): DeployPlan {
  const base = testPlan({ postgres: o.postgres ?? false });
  const domain = o.domain === false ? undefined : (o.domain ?? "shop.example.com");
  const dnsProvider = domain === undefined ? "none" : (o.dnsProvider ?? "cloudflare");
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      env: o.env ?? [],
      ...(o.releaseCommand === undefined ? {} : { releaseCommand: o.releaseCommand }),
    },
    target: {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 3,
      arch: o.arch ?? "amd64",
      redeploy: o.redeploy ?? "updater",
      web: o.web ?? { mode: "tunnel" },
    },
    services: testServices({ postgres: o.postgres ?? false, redis: o.redis ?? false }),
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-15T00:00:00.000Z",
    },
    dns:
      domain === undefined
        ? { provider: "none", proxied: false }
        : {
            provider: dnsProvider,
            domain,
            ...(dnsProvider === "cloudflare" ? { zone: "example.com" } : {}),
            proxied: o.proxied ?? dnsProvider === "cloudflare",
            www: o.www ?? false,
          },
    security: {},
  });
}

/** The app's environment variables used by the stack tests (names only). */
export const TEST_ENV: DeployPlan["app"]["env"] = [
  { name: "SESSION_SECRET", secret: true, source: "generated" },
  { name: "STRIPE_KEY", secret: true, source: "user" },
  { name: "PORT", secret: false, source: "derived" },
  { name: "DATABASE_URL", secret: true, source: "derived" },
  { name: "NEXT_PUBLIC_SITE_NAME", secret: false, source: "user" },
  { name: "LOG_LEVEL", secret: false, source: "user", optional: true },
];
