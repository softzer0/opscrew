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
