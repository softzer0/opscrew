import {
  inspectShared,
  planShared,
  SHARED_RULES,
  type SharedChange,
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

/**
 * How OpsCrew's shared Cloudflare rules differ from this app's record (`.opscrew/cloudflare.json`),
 * read-only: OpsCrew's rule is missing, one of this app's hostnames is missing from it, or it was
 * changed beyond its hostnames (its action, paths or setting, or turned off), each with how to put
 * it back. `undefined` when the record lists no hostnames; a damaged record stops the check.
 */
export async function cloudflareRulesDrift(
  deps: PhaseDeps,
  services: Pick<ProvisionServices, "sharedCloudflare">,
): Promise<CloudflareRuleDifference[] | undefined> {
  const record = await readCloudflareRecord(deps.paths);
  if (record === undefined || !listsHostnames(record)) return undefined;
  deps.reporter.step("Reading OpsCrew's shared rules in the Cloudflare zone (nothing is changed)");
  const facts = await inspectShared(sharedCloudflareClient(deps, services), {
    zoneId: record.zoneId,
    accountId: "",
    access: false,
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
  return differences;
}
