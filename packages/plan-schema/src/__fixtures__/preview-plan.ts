import type { DeployPlan } from "../index";

/**
 * The preview environment `name` beside `prod` as data-model.md shows it: the app `<app>-<name>`,
 * previews at `pr-<number>.app.example.com`, the Cloudflare zone without a hostname of its own, DNS
 * only, open to everyone, nothing deployed.
 */
export function previewPlanOf(prod: DeployPlan, name = "preview"): DeployPlan {
  const { deployment: _deployment, ...plan } = prod;
  return {
    ...plan,
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    environment: {
      name,
      deploySource: { from: "main" },
      runner: "github",
      previews: { cap: 3, lifetimeDays: 7, domain: "app.example.com" },
    },
    dns: { provider: "cloudflare", zone: "example.com", proxied: false, www: false },
    security: { ...prod.security, httpAllowedFrom: "any" },
    deployment: {},
  };
}
