/**
 * `opscrew secure` for the server-less targets (feature 016, FR-1608): the site has no server of
 * its own to harden or probe. On Cloudflare's hosting OpsCrew's security headers are checked on its
 * answers; GitHub Pages cannot set them, which is reported with what that means.
 */
import type { CheckResult } from "@opscrew/contracts";
import type { DeployPlan, ServerlessProvider } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { checkResult } from "../shared";
import { siteHeaderChecks, siteHost } from "../verify/serverless";

/** What `opscrew secure` says of a site with no server of its own. */
export function siteSecureNotes(provider: ServerlessProvider): string[] {
  const host = siteHost(provider);
  return [
    `OpsCrew runs no server for this site: ${host} serves it and keeps its machines patched, so a server's checks (its SSH settings, firewall, fail2ban, automatic security updates and kernel settings) do not apply.`,
  ];
}

/** Why `opscrew secure` probes no port for such a site. */
export function siteProbesSkipped(provider: ServerlessProvider): string {
  return `OpsCrew probes no port: the site has no server of its own, and ${siteHost(provider)} decides which ports answer.`;
}

/** The finding for a site on GitHub Pages, which sets no security headers. */
const PAGES_HEADERS = checkResult(
  "security-headers",
  "Security headers are set on the site's answers",
  "low",
  "warn",
  "GitHub Pages cannot set security headers: the site's answers carry no Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options or Referrer-Policy, so browsers apply none of these protections. For one, another site can show its pages in a frame, and a browser may guess a file's type from its content.",
  {
    remediation:
      "Cloudflare's hosting can: it sets OpsCrew's security headers on every answer, free for a static site too (Cloudflare (no server) in `opscrew design`). `opscrew retarget` does not move a server-less site yet: run `opscrew destroy` for this one first.",
  },
);

/**
 * The site's own checks in place of a server's: OpsCrew's security headers on Cloudflare's
 * hosting (on the front page and, with server rendering, on the Worker's own answers), read over
 * HTTPS; on GitHub Pages, the finding that it cannot set them.
 */
export async function siteSecurityChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
): Promise<CheckResult[]> {
  if (plan.target.provider !== "cloudflare-workers") return [PAGES_HEADERS];
  deps.reporter.step("Checking the site's security headers over HTTPS (read-only)");
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  return siteHeaderChecks(plan, { fetch: deps.fetch, flag });
}
