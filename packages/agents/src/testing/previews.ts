import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { testPlan } from "./deploy";
import { ownPlan } from "./own";

/** The previews' base name of {@link previewTestPlan}: previews are `pr-<n>.shop.example.com`. */
export const PREVIEW_BASE = "shop.example.com";

/**
 * A preview environment's plan (`shop-preview`, environment `preview`) as design makes it: a
 * Hetzner server, or the user's own (`own`), the Cloudflare zone without a hostname of its own,
 * DNS only, open to everyone, no signing, deploy tags or check; recorded as applied.
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
      previews: { cap: 3, lifetimeDays: 7, domain: PREVIEW_BASE, seed: null },
    },
    infra: { ...base.infra, dir: "opscrew/infra/preview" },
    dns: { provider: "cloudflare", zone: "example.com", proxied: false, www: false },
    security: { ...base.security, httpAllowedFrom: "any" },
    supplyChain: { ...base.supplyChain, sign: false },
    cicd: {
      ...base.cicd,
      workflowPath: ".github/workflows/opscrew-deploy-preview.yml",
      deployTags: { enabled: false, release: false },
    },
  });
}
