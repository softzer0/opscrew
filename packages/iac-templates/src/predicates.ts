import type { DeployPlan } from "@opscrew/plan-schema";

/** True when the plan's DNS is a domain on Cloudflare. */
export function usesCloudflare(plan: DeployPlan): boolean {
  return plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
}

/**
 * True when web traffic may reach the server only through Cloudflare: a proxied Cloudflare domain
 * with `security.httpAllowedFrom: cloudflare`.
 */
export function webOnlyFromCloudflare(plan: DeployPlan): boolean {
  return usesCloudflare(plan) && plan.dns.proxied && plan.security.httpAllowedFrom === "cloudflare";
}
