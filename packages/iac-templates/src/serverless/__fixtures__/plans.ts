import { type DeployPlan, DeployPlanSchema, type Site } from "@opscrew/plan-schema";
import type { RenderContext } from "../../types";

/**
 * The render context of an environment promoted from staging, which follows `main` and builds the
 * sites: what agents resolve for a promoted environment.
 */
export const FROM_STAGING = {
  builderBranch: "main",
  builderWorkflowPath: ".github/workflows/opscrew-deploy-staging.yml",
} as const satisfies Pick<RenderContext, "builderBranch" | "builderWorkflowPath">;

/** A Vite single-page app built with npm. */
export const NPM_SITE = {
  tool: "node",
  packageManager: "npm",
  nodeVersion: "24",
  command: "npm run build",
  outputDir: "dist",
} as const satisfies Site;

/** The same app built with pnpm. */
export const PNPM_SITE = {
  ...NPM_SITE,
  packageManager: "pnpm",
  command: "pnpm run build",
} as const satisfies Site;

/** A Hugo site. */
export const HUGO_SITE = {
  tool: "hugo",
  command: "hugo --minify",
  outputDir: "public",
} as const satisfies Site;

/** Astro with `@astrojs/cloudflare` (spike result 6). */
export const ASTRO_SSR = {
  ...NPM_SITE,
  outputDir: "dist/client",
  entry: "dist/server/entry.mjs",
} as const satisfies Site;

/** Nuxt with Nitro's `cloudflare_module` preset, built with pnpm (spike result 6). */
export const NUXT_SSR = {
  ...PNPM_SITE,
  outputDir: ".output/public",
  entry: ".output/server/index.mjs",
  compatibilityFlags: ["nodejs_compat"],
} as const satisfies Site;

export interface ServerlessPlanOptions {
  site?: Site;
  render?: "static" | "ssr";
  notFound?: "single-page-application" | "404-page" | "none";
  /** The app's variables, by name (all secret, from the user). */
  env?: readonly string[];
  /** A named environment (`<app>-<env>`, `<env>-docs.example.com`, its own workflow). */
  environment?: string;
  /** Deployed by `opscrew promote` from this environment. */
  promotedFrom?: string;
  buildContext?: string;
  workersDev?: boolean;
  previewUrls?: boolean;
}

/** The plan fields both targets share: `example-app` on `docs.example.com`, with no server parts. */
function base(o: ServerlessPlanOptions, dns: { proxied: boolean }, target: unknown): DeployPlan {
  const name = o.environment === undefined ? "example-app" : `example-app-${o.environment}`;
  const domain =
    o.environment === undefined ? "docs.example.com" : `${o.environment}-docs.example.com`;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    ...(o.environment === undefined && o.promotedFrom === undefined
      ? {}
      : {
          environment: {
            ...(o.environment === undefined ? {} : { name: o.environment }),
            ...(o.promotedFrom === undefined
              ? {}
              : { deploySource: { from: "promote", source: o.promotedFrom } }),
          },
        }),
    app: {
      name,
      port: 3000,
      buildContext: o.buildContext ?? ".",
      env: (o.env ?? []).map((variable) => ({ name: variable, secret: true, source: "user" })),
    },
    target,
    processes: { workers: [], cron: [] },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "USD" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-23T00:00:00.000Z",
    },
    codeChanges: [],
    dns: { provider: "cloudflare", domain, zone: "example.com", www: false, ...dns },
    cicd: {
      provider: "github-actions",
      registry: "ghcr",
      branch: "main",
      ...(o.environment === undefined
        ? {}
        : { workflowPath: `.github/workflows/opscrew-deploy-${o.environment}.yml` }),
    },
    security: { wafCustomRules: dns.proxied },
  });
}

/** A plan on Cloudflare's hosting (a static npm site unless `o` says otherwise). */
export function cloudflarePlan(o: ServerlessPlanOptions = {}): DeployPlan {
  const name = o.environment === undefined ? "example-app" : `example-app-${o.environment}`;
  return base(o, { proxied: true }, {
    provider: "cloudflare-workers",
    mode: "workers-assets",
    worker: name,
    render: o.render ?? "static",
    notFound: o.notFound ?? (o.render === "ssr" ? "none" : "single-page-application"),
    ...(o.workersDev === undefined ? {} : { workersDev: o.workersDev }),
    ...(o.previewUrls === undefined ? {} : { previewUrls: o.previewUrls }),
    site: o.site ?? NPM_SITE,
  });
}

/** A server-rendered Astro app on Cloudflare's hosting. */
export function ssrPlan(o: ServerlessPlanOptions = {}): DeployPlan {
  return cloudflarePlan({ render: "ssr", site: ASTRO_SSR, ...o });
}

/** A plan on GitHub Pages (a static npm site unless `o` says otherwise). */
export function pagesPlan(o: ServerlessPlanOptions = {}): DeployPlan {
  return base(o, { proxied: false }, {
    provider: "github-pages",
    mode: "pages-workflow",
    site: o.site ?? NPM_SITE,
  });
}
