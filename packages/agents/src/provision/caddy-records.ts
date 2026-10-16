import { normalizeHostName, OpsCrewError } from "@opscrew/core";
import { siteHosts } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { DNS_OVER_HTTPS_URL, lookupPublicAddresses } from "../shared";
import type { SavedPlan } from "./types";

const DeletedRecordJson = z.looseObject({
  type: z.literal("cloudflare_dns_record"),
  change: z.looseObject({
    actions: z.array(z.string()),
    before: z.looseObject({ name: z.string().optional() }).nullish(),
  }),
});

/**
 * The site's host names whose DNS records the Cloudflare plan deletes (the Cloudflare Tunnel's
 * routes): by the host name their addresses are keyed with (`…route["shop.example.com"]`), or by
 * the record's name in the plan JSON. Right after such a deletion a public resolver may still
 * answer from its cache, so these names count as without a record.
 */
export function deletedRecordHosts(
  saved: Pick<SavedPlan, "changes" | "planJson"> | undefined,
  hosts: readonly string[],
  zone: string | undefined,
): string[] {
  if (saved === undefined) return [];
  const names = new Set<string>();
  const apex = zone === undefined ? undefined : normalizeHostName(zone);
  // A record's name is its full host name, or one relative to the zone (`@` for the apex).
  const add = (name: string) => {
    const host = normalizeHostName(name);
    if (host === "@") {
      if (apex !== undefined) names.add(apex);
      return;
    }
    names.add(host);
    if (apex !== undefined && host !== apex && !host.endsWith(`.${apex}`)) {
      names.add(`${host}.${apex}`);
    }
  };
  for (const change of saved.changes) {
    if (change.type !== "cloudflare_dns_record" || change.action !== "delete") continue;
    const key = /\["([^"]+)"\]$/.exec(change.address)?.[1];
    if (key !== undefined) add(key);
  }
  const list = (saved.planJson as { resource_changes?: unknown } | null | undefined)
    ?.resource_changes;
  for (const entry of Array.isArray(list) ? list : []) {
    const parsed = DeletedRecordJson.safeParse(entry);
    if (!parsed.success) continue;
    const { actions, before } = parsed.data.change;
    if (!actions.includes("delete") || actions.includes("create")) continue;
    if (before?.name !== undefined) add(before.name);
  }
  return hosts.filter((host) => names.has(normalizeHostName(host)));
}

const RECORD_TO_CREATE =
  "an A record (and AAAA for IPv6) for {hosts} to your Portainer host's public address, or a CNAME to its dynamic-DNS name";

/**
 * Said by `--plan-only` in web mode `caddy`: the record must exist before Caddy starts, and when
 * the plan deletes the Cloudflare Tunnel's records there, the user creates it once it is applied.
 */
export function caddyRecordNote(
  plan: DeployPlan,
  command: string,
  deleted: readonly string[],
): string | undefined {
  const hosts = siteHosts(plan);
  if (hosts.length === 0) return undefined;
  const one = hosts.length === 1;
  const note = [
    `Before Caddy starts, ${hosts.join(" and ")} must have a DNS record that points at your Portainer host (an A record, and AAAA for IPv6, to its public address, or a CNAME to its dynamic-DNS name): applying checks ${one ? "it" : "them"} through a public resolver and stops before ${deleted.length > 0 ? "Caddy can start" : "the app's stack changes"} until ${one ? "it resolves" : "they resolve"}, so Caddy gets ${one ? "its certificate" : "their certificates"} at once.`,
  ];
  if (deleted.length > 0) {
    note.push(
      `This plan deletes the Cloudflare Tunnel's record${deleted.length === 1 ? "" : "s"} for ${deleted.join(" and ")}, so create yours once it is applied; the next \`${command}\` then continues.`,
    );
  }
  return note.join(" ");
}

/**
 * Web mode `caddy`: stops unless every host of the site has an A, AAAA or CNAME record that a
 * public resolver sees (`deleted` hosts lost theirs in this run and count as without one), before
 * anything starts Caddy. `done` says what this run already applied.
 */
export async function requireCaddyRecords(
  deps: Pick<PhaseDeps, "fetch" | "reporter" | "redactor">,
  input: { plan: DeployPlan; command: string; deleted: readonly string[]; done: string },
): Promise<void> {
  const hosts = siteHosts(input.plan);
  if (hosts.length === 0) return;
  const { command, deleted, done } = input;
  deps.reporter.step(
    `Checking that ${hosts.join(" and ")} ${hosts.length === 1 ? "has a DNS record" : "have DNS records"} before Caddy starts (a public resolver, read-only)`,
  );
  const missing: string[] = [];
  for (const host of hosts) {
    if (deleted.includes(host)) {
      missing.push(host);
      continue;
    }
    const lookup = await lookupPublicAddresses(deps.fetch, host);
    if (lookup.state === "found") continue;
    if (lookup.state === "missing") {
      missing.push(host);
      continue;
    }
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      deps.redactor.redact(
        `OpsCrew could not check through a public resolver whether ${host} has a DNS record (${lookup.problem}), so it stopped here, before Caddy can start. ${done}`,
      ),
      {
        hint: `Check that this computer can reach ${DNS_OVER_HTTPS_URL}, then run \`${command}\` again: it continues from there.`,
      },
    );
  }
  if (missing.length === 0) {
    deps.reporter.success(
      `${hosts.join(" and ")} ${hosts.length === 1 ? "has a DNS record" : "have DNS records"}; Caddy can get ${hosts.length === 1 ? "its certificate" : "their certificates"}.`,
    );
    return;
  }
  const one = missing.length === 1;
  const names = missing.join(" and ");
  const why = missing.some((host) => deleted.includes(host))
    ? ` (the Cloudflare changes above deleted the Cloudflare Tunnel's record${one ? "" : "s"} there)`
    : " (a public resolver finds no A, AAAA or CNAME record)";
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${names} ${one ? "has" : "have"} no DNS record that points at your Portainer host yet${why}. Caddy asks Let's Encrypt for ${one ? "its certificate" : "their certificates"} as soon as it starts; without the record that request fails, and the failure can stay cached for up to 30 minutes. So OpsCrew stopped here, before Caddy can start. ${done}`,
    {
      hint: `Create ${RECORD_TO_CREATE.replace("{hosts}", names)}, then run \`${command}\` again: it continues from there. A new record can take a few minutes to show in public resolvers.`,
    },
  );
}
