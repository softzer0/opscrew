import {
  inspectShared,
  planShared,
  SHARED_RULES,
  type SharedChange,
  type SharedFacts,
  type SharedRecord,
  type SharedRuleRef,
} from "@opscrew/connector-cloudflare";
import { listText } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import {
  listsHostnames,
  REFS,
  RULES,
  readCloudflareRecord,
  sharedCloudflareClient,
} from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import type { CloudflareRuleDifference } from "./types";

/** The rule a change of one phase is about. */
function refOf(change: Extract<SharedChange, { phase: string }>): SharedRuleRef {
  return REFS.find((ref) => SHARED_RULES[ref].phase === change.phase) as SharedRuleRef;
}

const RUN_PROVISION =
  "`opscrew provision` puts it back (it shows the Cloudflare plan first, and the deploy brings the server what it needs).";

/**
 * How the app's origin TLS at Cloudflare differs from its record (FR-1408): its origin
 * certificate or client certificate is gone, or a hostname's Authenticated Origin Pulls setting
 * is off or uses another client certificate. Names hostnames only, never an id.
 */
function originTlsDifferences(
  facts: SharedFacts,
  tls: NonNullable<SharedRecord["tls"]>,
): CloudflareRuleDifference[] {
  const read = facts.tls;
  if (read === undefined) {
    return [
      {
        title: "OpsCrew could not read the app's origin TLS at Cloudflare",
        detail: `The Cloudflare token lacks ${listText(facts.deniedTls ?? [])} for this zone. Give it that permission, then run \`opscrew drift\` again.`,
      },
    ];
  }
  const out: CloudflareRuleDifference[] = [];
  const { origin, client } = tls;
  if (origin !== undefined && !read.origin.some((c) => c.id === origin.id)) {
    out.push({
      title: `The app's Cloudflare origin certificate for ${listText(origin.hostnames)} was revoked or deleted outside OpsCrew`,
      detail: `Cloudflare no longer trusts the certificate the server presents, so visitors get errors. ${RUN_PROVISION}`,
    });
  }
  if (client === undefined) return out;
  if (!read.client.some((c) => c.id === client.id)) {
    out.push({
      title:
        "The app's client certificate for Cloudflare's origin pulls was deleted outside OpsCrew",
      detail: `Cloudflare cannot present it, so the server refuses Cloudflare's requests and visitors get errors. ${RUN_PROVISION}`,
    });
  }
  for (const hostname of client.enabled) {
    const setting = read.aop.find((s) => s.hostname === hostname);
    if (setting?.enabled !== true) {
      out.push({
        title: `Authenticated Origin Pulls was turned off for ${hostname} outside OpsCrew`,
        detail: `Cloudflare no longer presents the app's client certificate for ${hostname}, so the server refuses its requests and visitors get errors. ${RUN_PROVISION}`,
      });
    } else if (setting.certId !== client.id) {
      out.push({
        title: `Authenticated Origin Pulls for ${hostname} uses another client certificate than the app's`,
        detail: `The server trusts only the app's own, so it refuses Cloudflare's requests for ${hostname}. Run \`opscrew provision\`: OpsCrew never takes a hostname from another certificate, so it stops and says how to free the hostname.`,
      });
    }
  }
  return out;
}

/**
 * How OpsCrew's shared Cloudflare rules and the app's origin TLS differ from this app's record
 * (`.opscrew/cloudflare.json`), read-only: OpsCrew's rule is missing, one of this app's hostnames
 * is missing from it, or it was changed beyond its hostnames (its action, paths or setting, or
 * turned off); the app's origin or client certificate is gone, or a hostname's origin pull setting
 * is off or uses another certificate. Each says how to put it back. `undefined` when the record
 * lists no hostnames and no origin TLS; a damaged record stops the check.
 */
export async function cloudflareRulesDrift(
  deps: PhaseDeps,
  services: Pick<ProvisionServices, "sharedCloudflare">,
): Promise<CloudflareRuleDifference[] | undefined> {
  const record = await readCloudflareRecord(deps.paths);
  const tls = record?.tls?.origin !== undefined || record?.tls?.client !== undefined;
  if (record === undefined || (!listsHostnames(record) && !tls)) return undefined;
  deps.reporter.step("Reading OpsCrew's shared rules in the Cloudflare zone (nothing is changed)");
  const facts = await inspectShared(sharedCloudflareClient(deps, services), {
    zoneId: record.zoneId,
    accountId: "",
    access: false,
    ...(tls ? { tls: { proxied: [], record } } : {}),
    clock: deps.clock,
  });
  // What the next provision would plan for the hostnames the record lists.
  const plan = planShared(facts, { hostnames: record.hostnames }, record);
  const differences: CloudflareRuleDifference[] = plan.findings.map((finding) => ({
    title: finding.message,
    detail: finding.hint,
  }));
  for (const change of plan.changes) {
    if (!("phase" in change)) continue;
    const { name, kind } = RULES[refOf(change)];
    if (change.kind === "create-entrypoint" || change.kind === "add-rule") {
      differences.push({
        title: `OpsCrew's rule "${name}" is missing from the zone's ${kind}`,
        detail:
          "`opscrew provision` creates it again with this app's hostnames (it shows the Cloudflare plan first); other OpsCrew apps in the zone add theirs on their next provision.",
      });
    } else if (change.kind === "update-hostnames" && change.add.length > 0) {
      const one = change.add.length === 1;
      differences.push({
        title: `${listText(change.add)} ${one ? "is" : "are"} missing from OpsCrew's rule "${name}" in the zone's ${kind}`,
        detail: `This app added ${one ? "it" : "them"} there (its record says so). \`opscrew provision\` adds ${one ? "it" : "them"} back (it shows the Cloudflare plan first).`,
      });
    }
  }
  if (tls && record.tls !== undefined) {
    differences.push(...originTlsDifferences(facts, record.tls));
  }
  return differences;
}
