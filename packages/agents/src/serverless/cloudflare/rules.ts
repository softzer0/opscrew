/**
 * The zone's shared rules for an app on Cloudflare's hosting (011's adapter, ADR 0014): its
 * hostnames in OpsCrew's probe block and its `www` hostname in the redirect to the domain, through
 * a Cloudflare plan approved by its hash (`cloudflare-apply`).
 */
import type { CloudflareClient, SharedDesired, SharedRecord } from "@opscrew/connector-cloudflare";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../../context";
import type { CloudflareSetup } from "../../provision/credentials";
import { readCloudflareRecord, type ZonePlan, zonePlan } from "../../provision/shared-cloudflare";

const REDIRECT = "opscrew-www-redirect";

/**
 * True when the app's record lists hostnames in the `www` redirect (a site on Cloudflare's
 * hosting with `www`): reading or planning the shared rules then needs the redirect's phase.
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

/**
 * Plans the zone's shared rules for the app ({@link siteRulesDesired}) against its record
 * (`.opscrew/cloudflare.json`), read-only (`zonePlan`). The redirect rule's phase is read whenever
 * the app has (or had) a `www` hostname there; only then does the token need Zone → Single
 * Redirect → Edit. Stops on the plan's findings (a refused read names the missing permission)
 * before anything changes.
 */
export async function planSiteRules(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "clock">,
  input: {
    client: CloudflareClient;
    cloudflare: Pick<CloudflareSetup, "zoneId" | "zoneName" | "accountId">;
    plan: DeployPlan;
    command: string;
  },
): Promise<ZonePlan> {
  const { cloudflare } = input;
  const recorded = await readCloudflareRecord(deps.paths);
  const record = recorded?.zoneId === cloudflare.zoneId ? recorded : undefined;
  const desired = siteRulesDesired(input.plan);
  return zonePlan(deps, {
    client: input.client,
    zoneId: cloudflare.zoneId,
    accountId: cloudflare.accountId,
    zone: cloudflare.zoneName,
    desired,
    record,
    command: input.command,
    redirect: listsRedirect(desired) || listsRedirect(record),
  });
}
