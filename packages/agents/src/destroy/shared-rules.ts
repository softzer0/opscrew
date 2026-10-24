/**
 * The destroy's part in OpsCrew's shared Cloudflare rules (ADR 0014): this app's hostnames leave
 * OpsCrew's rules in the zone of its record (`.opscrew/cloudflare.json`), OpsCrew's rule goes when
 * no hostname is left, and so does a ruleset that then holds no rule, or that this app created and
 * an interrupted destroy left empty. Planned before the typed confirmation, applied as a Cloudflare
 * plan approved by its hash (`cloudflare-apply`, with `allowDestroy` and the typed app name): after
 * the infrastructure's destroy on a server, before it on Cloudflare's hosting (the `www` redirect
 * goes first).
 */
import { type CloudflareClient, SHARED_RULES } from "@opscrew/connector-cloudflare";
import type { ApprovalRecord } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  applyZonePlan,
  listsHostnames,
  readCloudflareRecord,
  sharedCloudflareClient,
  sharedDesired,
  writeCloudflareRecord,
  type ZonePlan,
  zonePlan,
} from "../provision/shared-cloudflare";
import { listsRedirect } from "../serverless/cloudflare/rules";
import { COMMAND } from "./common";
import type { DestroyServices } from "./types";

/** The removal of this app's hostnames from OpsCrew's shared Cloudflare rules, planned. */
export interface SharedRemoval {
  client: CloudflareClient;
  zone: ZonePlan;
}

/**
 * Plans the removal of everything this app's record lists in OpsCrew's shared Cloudflare rules
 * and its origin TLS (read-only): `undefined` without a record or when it lists nothing. On a
 * server the plan is applied only after the app's site is gone, so it is made for an origin that
 * serves nothing: the client certificate is turned off and deleted, and the origin certificate
 * and every one it replaced are revoked. The zone's minimum TLS stays. The `www` redirect rule's
 * phase is read only when the record has (or created) it, as for a site on Cloudflare's hosting.
 * A damaged record, and a finding of the plan (OpsCrew's rule changed by someone, a refused read),
 * stop before anything changes.
 */
export async function planSharedRemoval(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<DestroyServices, "sharedCloudflare">,
): Promise<SharedRemoval | undefined> {
  const record = await readCloudflareRecord(deps.paths);
  if (record === undefined) return undefined;
  const tls = record.tls?.origin !== undefined || record.tls?.client !== undefined;
  if (!listsHostnames(record) && record.createdEntrypoints.length === 0 && !tls) return undefined;
  // The redirect's phase, also when an interrupted destroy left its ruleset empty.
  const { phase } = SHARED_RULES["opscrew-www-redirect"];
  const redirect = listsRedirect(record) || record.createdEntrypoints.includes(phase);
  const client = sharedCloudflareClient(deps, services);
  const zone = await zonePlan(deps, {
    client,
    zoneId: record.zoneId,
    // A removal changes only the zone's rules and the app's certificates: no account is involved.
    accountId: "",
    zone: plan.dns.domain === undefined ? "the app's zone" : `the zone of ${plan.dns.domain}`,
    desired: {
      hostnames: {},
      ...(tls ? { tls: { proxied: [], served: { requiring: [] } } } : {}),
    },
    record,
    command: COMMAND,
    ...(redirect ? { redirect: true } : {}),
  });
  return { client, zone };
}

/**
 * The removal's Cloudflare plan in words, for the deletion preview; `undefined` when it changes
 * nothing in Cloudflare.
 */
export function removalDetails(removal: SharedRemoval | undefined): string | undefined {
  return removal !== undefined && removal.zone.plan.changes.length > 0
    ? removal.zone.details
    : undefined;
}

/**
 * Applies the planned removal (see the module's note for when): approved by its hash with
 * `allowDestroy` and the typed app name, then applied, and the record written (it then lists no
 * hostnames). Without changes only the record is written. Returns the approval, when one was asked.
 */
export async function applySharedRemoval(
  deps: PhaseDeps,
  plan: DeployPlan,
  removal: SharedRemoval | undefined,
): Promise<ApprovalRecord | undefined> {
  if (removal === undefined) return undefined;
  if (removal.zone.plan.changes.length === 0) {
    await writeCloudflareRecord(deps.paths, removal.zone.plan.record);
    return undefined;
  }
  const { approval } = await applyZonePlan(deps, removal.client, removal.zone, {
    app: plan.app.name,
    planOnly: false,
    command: COMMAND,
    phase: "provision",
    allowDestroy: true,
  });
  return approval;
}

/**
 * "What remains" when the app used Cloudflare Access: the account's Zero Trust organization and
 * one-time PIN login, which OpsCrew never deletes.
 */
export function zeroTrustLeft(plan: DeployPlan): string[] {
  if (plan.dns.provider !== "cloudflare") return [];
  const access = sharedDesired(plan, plan.dns.domain ?? "").access;
  if (access === undefined) return [];
  return [
    `The Cloudflare account's Zero Trust organization${access.oneTimePin ? " and its one-time PIN login" : ""}: OpsCrew never deletes ${access.oneTimePin ? "them" : "it"}, because every OpsCrew app in the account uses ${access.oneTimePin ? "them" : "it"} for Cloudflare Access, and ${access.oneTimePin ? "they cost" : "it costs"} nothing.`,
  ];
}
