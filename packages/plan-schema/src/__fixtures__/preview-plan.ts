import type { DeployPlan } from "../index";

/**
 * The preview environment `name` beside `prod` as data-model.md shows it: the app `<app>-<name>`,
 * previews at `pr-<number>-<random>.example-previews.com`, a Cloudflare zone of its own without a
 * hostname, behind the proxy, open to Cloudflare only, nothing deployed.
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
      previews: { cap: 3, lifetimeDays: 7, domain: "example-previews.com" },
    },
    dns: { provider: "cloudflare", zone: "example-previews.com", proxied: true, www: false },
    security: { ...prod.security, httpAllowedFrom: "cloudflare" },
    deployment: {},
  };
}
