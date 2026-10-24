/**
 * The zone's shared rules for an app on Cloudflare's hosting (011's adapter, ADR 0014): its
 * hostnames in OpsCrew's probe block and its `www` hostname in the redirect to the domain, planned
 * by `planSharedCloudflare` as for servers and approved by the Cloudflare plan's hash
 * (`cloudflare-apply`).
 */
import type { SharedDesired, SharedRecord } from "@opscrew/connector-cloudflare";
import type { DeployPlan } from "@opscrew/plan-schema";

const REDIRECT = "opscrew-www-redirect";

/**
 * True when the app's record lists hostnames in the `www` redirect (a site on Cloudflare's
 * hosting with `www`): reading or planning the shared rules then needs the redirect's phase, and
 * only then does the token need Zone → Single Redirect → Edit.
 */
export function listsRedirect(record: Pick<SharedRecord, "hostnames"> | undefined): boolean {
  return (record?.hostnames[REDIRECT] ?? []).length > 0;
}

/**
 * What an app on Cloudflare's hosting needs from the zone's shared rules: its hostnames in the
 * probe block with `security.wafCustomRules` (the zone's WAF sees a Worker's custom domains, 016's
 * spike, result 10), and `www.<domain>` in the redirect to the domain when `www` is on (result
 * 12), so a request to it never reaches the Worker. None in the strict-TLS rule: a Worker has no
 * origin.
 */
export function siteRulesDesired(plan: DeployPlan): SharedDesired {
  const domain = plan.dns.domain as string;
  const www = plan.dns.www ? [`www.${domain}`] : [];
  return {
    hostnames: {
      "opscrew-block-probes": plan.security.wafCustomRules ? [domain, ...www] : [],
      "opscrew-strict-tls": [],
      [REDIRECT]: www,
    },
  };
}
