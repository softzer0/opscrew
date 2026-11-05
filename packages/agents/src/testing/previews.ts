import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { testPlan } from "./deploy";
import { ownPlan } from "./own";

/**
 * The preview zone of {@link previewTestPlan}, a Cloudflare zone of its own: previews are
 * `pr-<n>-<random>.example.net`.
 */
export const PREVIEW_ZONE = "example.net";

/**
 * A preview environment's plan (`shop-preview`, environment `preview`) as design makes it: a
 * Hetzner server, or the user's own (`own`), the preview zone without a hostname of its own,
 * behind Cloudflare's proxy and open to Cloudflare only, no signing, deploy tags or check;
 * recorded as applied.
 */
export function previewTestPlan(options: { own?: boolean } = {}): DeployPlan {
  const base = options.own === true ? ownPlan({ deployed: true }) : testPlan({ deployed: true });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: "shop-preview" },
    environment: {
      name: "preview",
      deploySource: { from: "main" },
      runner: "github",
      previews: { cap: 3, lifetimeDays: 7, domain: PREVIEW_ZONE, seed: null },
    },
    infra: { ...base.infra, dir: "opscrew/infra/preview" },
    dns: { provider: "cloudflare", zone: PREVIEW_ZONE, proxied: true, www: false },
    security: { ...base.security, httpAllowedFrom: "cloudflare" },
    supplyChain: { ...base.supplyChain, sign: false },
    cicd: {
      ...base.cicd,
      workflowPath: ".github/workflows/opscrew-deploy-preview.yml",
      deployTags: { enabled: false, release: false },
    },
  });
}

/** The environment whose server previews share in the tests (spec.md US9). */
export const HOST_ENV = "dev";

/** The admin login of `dev`'s server when it is the user's own, in the tests: never shown. */
export const HOST_ADMIN = "dev-admin-7f3";

/** The address of `dev`'s server in the tests: a documentation address (RFC 5737), public. */
export const HOST_IPV4 = "198.51.100.40";

/**
 * `dev`'s plan (`shop-dev`), provisioned unless `deployed` is false: on a server OpsCrew created
 * at Hetzner, or the user's own (`own`), behind Cloudflare's proxy on `dev.shop.example.com`, with
 * the Caddy edge.
 */
export function hostTestPlan(options: { own?: boolean; deployed?: boolean } = {}): DeployPlan {
  const deployed = options.deployed ?? true;
  const base =
    options.own === true
      ? ownPlan({ deployed, domain: "dev.shop.example.com" })
      : testPlan({ deployed, domain: "dev.shop.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: `shop-${HOST_ENV}` },
    environment: { name: HOST_ENV, deploySource: { from: "main" }, runner: "github" },
    infra: { ...base.infra, dir: `opscrew/infra/${HOST_ENV}` },
    cicd: { ...base.cicd, workflowPath: `.github/workflows/opscrew-deploy-${HOST_ENV}.yml` },
  });
}

/** {@link previewTestPlan} on `dev`'s server: an own target with `previews.server`. */
export function sharedPreviewTestPlan(): DeployPlan {
  const plan = previewTestPlan({ own: true });
  return DeployPlanSchema.parse({
    ...plan,
    environment: {
      ...plan.environment,
      previews: { ...plan.environment?.previews, server: { environment: HOST_ENV } },
    },
  });
}
