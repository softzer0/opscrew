import { cloudflareEdgeCoverage, likelyCloudflareZone } from "@opscrew/plan-schema";

/**
 * Why Cloudflare's proxy (or tunnel) cannot serve `domain` over HTTPS: it is more than one level
 * below its likely zone, beyond Cloudflare's free certificate. Returns the reason and the next
 * step ("use a name one level below <zone>, such as <suggestion>, or <otherwise>"), or
 * `undefined` when the name fits.
 */
export function deepDomainProblem(
  domain: string,
  otherwise: string,
): { reason: string; next: string } | undefined {
  const zone = likelyCloudflareZone(domain);
  const deep = cloudflareEdgeCoverage(domain, zone);
  if (deep === undefined) return undefined;
  return {
    reason: deep.reason,
    next: `use a name one level below ${zone}, such as ${deep.suggestion}, or ${otherwise}`,
  };
}
