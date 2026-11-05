import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { testPlan } from "../../__fixtures__/plans";

/**
 * A preview environment's plan, as design writes it (ADR 0026): the environment `preview` of
 * `shop` (`shop-preview`, or a further app's `<key>-preview`) on Hetzner (or `provider`), previews
 * at `pr-<n>.shop.example.com` in the zone example.com, DNS only, with no domain of its own.
 */
export function previewPlan(
  o: { provider?: "hetzner" | "digitalocean" | "own"; key?: string; secrets?: "environment" } = {},
): DeployPlan {
  const plan = testPlan({ provider: o.provider ?? "hetzner" });
  const app = o.key ?? "shop";
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, ...(o.key === undefined ? {} : { key: o.key }), name: `${app}-preview` },
    environment: {
      name: "preview",
      ...(o.secrets === undefined ? {} : { secrets: o.secrets }),
      previews: { cap: 3, lifetimeDays: 7, domain: "shop.example.com", seed: null },
    },
    dns: { provider: "cloudflare", zone: "example.com", proxied: false, www: false },
    // The environment's own folder and workflow file (infraDirFor, workflowPathFor).
    infra: {},
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
  });
}
