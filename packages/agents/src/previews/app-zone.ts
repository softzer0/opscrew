/**
 * Previews under the app's own zone (spec.md US10, FR-2231, FR-2232, research R7.3 (2)): the
 * opt-in's words, the checks before any change (Advanced Certificate Manager on, Total TLS off, no
 * record at or below the preview domain, a domain that is no hostname of the app's environments
 * nor a parent of one), the wait for the previews' advanced certificate pack, and the checks
 * `verify` and `drift` make of the pack and Total TLS. Every Cloudflare call here is read-only.
 */
import { type CloudflareClient, OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import type { CheckResult } from "@opscrew/contracts";
import {
  errorText,
  isUserFacingError,
  listText,
  OpsCrewError,
  type ProjectPaths,
  realSleep,
} from "@opscrew/core";
import { siteHosts } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { environmentText, repositoryEnvironments } from "../apps/names";
import type { PhaseDeps } from "../context";
import { checkResult } from "../shared/check-results";

/** How long provision waits for Cloudflare to issue the previews' pack (FR-2232). */
export const PACK_WAIT_MS = 10 * 60_000;

/** How often it reads the pack meanwhile. */
const PACK_POLL_MS = 15_000;

/** The previews' domain when it is a name below the plan's zone (`previews.domain` ≠ `dns.zone`). */
export function appZoneDomain(plan: DeployPlan): string | undefined {
  const domain = plan.environment?.previews?.domain;
  return domain !== undefined && domain !== plan.dns.zone ? domain : undefined;
}

/**
 * What previews at `domain` below the app's zone `zone` cost and share, said before the user opts
 * in (spec.md US10 #1): ACM, a paid add-on with its price in Cloudflare's dashboard, and the
 * cookies set for the whole domain.
 */
export function appZoneWarning(domain: string, zone: string): string {
  return `Previews at pr-<number>-<random>.${domain} need Cloudflare's Advanced Certificate Manager on ${zone}, a paid add-on you turn on in Cloudflare's dashboard, which shows its price; OpsCrew then orders a certificate for *.${domain} with it. And they share your app's domain: a cookie your app sets for the whole domain (Domain=${zone}) reaches every preview, where a pull request's code can read it, and a preview can set such cookies for your app too.`;
}

/** The dashboard's page of the zone's edge certificates, where ACM and Total TLS are. */
const edgeCertificates = (zone: string) =>
  `the Cloudflare dashboard (${zone} → SSL/TLS → Edge Certificates)`;

/** A refusal before any change, ending as every one does. */
function refusal(
  code: "INVALID_INPUT" | "PHASE_PRECONDITION",
  message: string,
  hint: string,
): OpsCrewError {
  return new OpsCrewError(code, `${message} Nothing was changed.`, { hint });
}

/** True for a name at `domain` or below it. */
const atOrBelow = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);

/** What {@link requireAppZonePreviews} checks. */
export interface AppZoneInput {
  zoneId: string;
  /** The app's zone. */
  zone: string;
  /** The preview domain, a name below it. */
  domain: string;
  /** The command a refusal says to run again. */
  again: string;
}

/**
 * Refuses previews below the app's zone before any change (FR-2231), each with the dashboard steps:
 * a domain that is the hostname of one of the repository's environments (but the one `paths`
 * belong to) or a parent of one; the zone without ACM (`advanced.allocated` 0, the only read-only
 * sign); Total TLS on (a certificate per name would publish each preview's name); records at or
 * below the domain other than OpsCrew's own and the ACME validation's (named by name and type,
 * never their content).
 * @throws OpsCrewError `INVALID_INPUT` for the domain, `PHASE_PRECONDITION` for the zone.
 */
export async function requireAppZonePreviews(
  paths: ProjectPaths,
  client: Pick<CloudflareClient, "certificatePackQuota" | "totalTls" | "listDnsRecords">,
  input: AppZoneInput,
): Promise<void> {
  const { zone, domain, zoneId } = input;
  const rerun = `then run \`${input.again}\` again`;
  const others = await repositoryEnvironments(paths, {
    ...(paths.app === undefined ? {} : { app: paths.app }),
    environment: paths.environment,
  });
  for (const entry of others) {
    if (entry.plan === undefined) continue;
    // Another preview environment's names: two can't share any.
    const theirs = entry.plan.environment?.previews?.domain;
    if (theirs !== undefined && (atOrBelow(theirs, domain) || atOrBelow(domain, theirs))) {
      const how =
        theirs === domain ? "is" : atOrBelow(theirs, domain) ? "is a parent of" : "is below";
      throw refusal(
        "INVALID_INPUT",
        `${domain} ${how} ${theirs}, the previews' domain of ${environmentText(entry)}, and two preview environments can't share names.`,
        `Choose another name below ${zone} for the previews, ${rerun}.`,
      );
    }
    const host = siteHosts(entry.plan).find((name) => atOrBelow(name, domain));
    if (host === undefined) continue;
    throw refusal(
      "INVALID_INPUT",
      `${domain} ${host === domain ? "is" : "is a parent of"} ${host}, ${environmentText(entry)}'s hostname, and previews take every name below ${domain}.`,
      `Choose another name below ${zone} for the previews, ${rerun}.`,
    );
  }
  if ((await client.certificatePackQuota(zoneId)).allocated === 0) {
    throw refusal(
      "PHASE_PRECONDITION",
      `Previews below ${zone} need Cloudflare's Advanced Certificate Manager on ${zone} for the certificate of *.${domain}, and it is off there.`,
      `Turn on Advanced Certificate Manager, a paid add-on, in ${edgeCertificates(zone)}, ${rerun}.`,
    );
  }
  if ((await client.totalTls(zoneId)).enabled) {
    throw refusal(
      "PHASE_PRECONDITION",
      `Total TLS is on for ${zone}: it gives each proxied name a certificate of its own, and every public certificate is published, so each preview's name would be too.`,
      `Turn Total TLS off in ${edgeCertificates(zone)}, ${rerun}.`,
    );
  }
  const taken = (await client.listDnsRecords(zoneId)).filter(
    (record) =>
      atOrBelow(record.name, domain) &&
      record.comment?.trim() !== OPSCREW_MANAGED_COMMENT &&
      // The pack's own validation records. An assumption: the live pass (T2234) must confirm
      // which records Cloudflare lists in the zone for an advanced pack's TXT validation.
      !(record.type === "TXT" && record.name.startsWith("_acme-challenge.")),
  );
  if (taken.length > 0) {
    const one = taken.length === 1;
    throw refusal(
      "PHASE_PRECONDITION",
      `${zone} already has ${listText(taken.map((r) => `${r.name} (${r.type})`))} at or below ${domain}, and previews take every name there: the proxied wildcard *.${domain} and the previews' certificate cover them.`,
      `Delete ${one ? "it" : "them"} in the Cloudflare dashboard (${zone} → DNS → Records) if nothing uses ${one ? "it" : "them"}, or choose another name below ${zone} for the previews, ${rerun}.`,
    );
  }
}

/** A pack Cloudflare is still validating, issuing or deploying. */
function inProgress(status: string): boolean {
  return (
    status === "initializing" ||
    status === "holding_deployment" ||
    status.startsWith("pending_") ||
    status.startsWith("staging_")
  );
}

/** How far a pack of `status` is from serving: active first, then in progress, then the rest. */
function rank(status: string): number {
  return status === "active" ? 0 : inProgress(status) ? 1 : 2;
}

/**
 * The status of the previews' advanced pack among `packs` (its hosts hold `*.<domain>`), the best
 * of them by {@link rank} (a new pack ordered beside an old one that ended); `undefined` without
 * one.
 */
function packStatus(
  packs: readonly { type: string; hosts: readonly string[]; status: string }[],
  domain: string,
): string | undefined {
  const ours = packs.filter((p) => p.type === "advanced" && p.hosts.includes(`*.${domain}`));
  return ours.map((p) => p.status).sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * After provision's apply, reads the zone's packs (read-only) until the previews' one is `active`,
 * for up to {@link PACK_WAIT_MS} on `timing`'s clock; otherwise says previews answer once
 * Cloudflare issues it, and that `verifyCommand` shows when. True once it is active.
 */
export async function waitForPreviewsPack(
  deps: Pick<PhaseDeps, "reporter">,
  client: Pick<CloudflareClient, "listCertificatePacks">,
  input: { zoneId: string; domain: string; verifyCommand: string },
  timing: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const now = timing.now ?? (() => performance.now());
  const sleep = timing.sleep ?? realSleep;
  const { zoneId, domain } = input;
  const answer = `previews answer once Cloudflare issues it, and \`${input.verifyCommand}\` shows when.`;
  /** The pack's status, or why it could not be read (a user-facing error's text). */
  const read = async (): Promise<string | undefined | { unread: string }> => {
    try {
      return packStatus(await client.listCertificatePacks(zoneId), domain);
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      return { unread: errorText(error) };
    }
  };
  const started = now();
  let status = await read();
  if (typeof status !== "object" && status !== "active") {
    deps.reporter.step(
      `Waiting for Cloudflare to issue the previews' certificate for *.${domain} (up to 10 minutes)`,
    );
  }
  while (status !== "active") {
    // The apply succeeded: a read that fails only says so.
    if (typeof status === "object") {
      deps.reporter.warn(
        `OpsCrew could not read the previews' certificate for *.${domain} at Cloudflare (${status.unread}): ${answer}`,
      );
      return false;
    }
    const elapsed = now() - started;
    if (elapsed >= PACK_WAIT_MS) {
      deps.reporter.warn(
        `Cloudflare has not issued the previews' certificate for *.${domain} yet (${status ?? "not listed"}): ${answer}`,
      );
      return false;
    }
    await sleep(Math.min(PACK_POLL_MS, PACK_WAIT_MS - elapsed));
    status = await read();
  }
  deps.reporter.success(`Cloudflare's certificate for *.${domain} is active.`);
  return true;
}

/**
 * The checks of previews below the app's zone in the preview environment's `plan` (FR-2232): the
 * previews' pack active, and Total TLS off, each with a plain fix (`provision` is the command that
 * orders the pack). Read-only.
 */
export async function appZoneChecks(
  client: Pick<CloudflareClient, "findZone" | "listCertificatePacks" | "totalTls">,
  plan: DeployPlan,
  provision: string,
): Promise<CheckResult[]> {
  const domain = appZoneDomain(plan) as string;
  const zone = plan.dns.zone as string;
  const found = await client.findZone(zone);
  if (found === undefined) {
    return [
      checkResult(
        "previews-certificate",
        `The previews' certificate for *.${domain} is active`,
        "high",
        "fail",
        `No Cloudflare zone your token sees is ${zone}.`,
        { remediation: `Give the Cloudflare token access to ${zone}, then check again.` },
      ),
    ];
  }
  const status = packStatus(await client.listCertificatePacks(found.id), domain);
  const pending = status !== undefined && inProgress(status);
  const pack = checkResult(
    "previews-certificate",
    `The previews' certificate for *.${domain} is active`,
    "high",
    status === "active" ? "pass" : pending ? "warn" : "fail",
    status === "active"
      ? `Cloudflare serves previews with the advanced certificate for *.${domain}.`
      : status === undefined
        ? `${zone} has no advanced certificate for *.${domain}, so Cloudflare can't serve previews.`
        : pending
          ? `Cloudflare has not issued the certificate for *.${domain} yet (${status}): previews answer once it does.`
          : `The certificate for *.${domain} is ${status}, so Cloudflare can't serve previews.`,
    status === "active"
      ? {}
      : {
          remediation: pending
            ? "Check again in a few minutes."
            : status === undefined
              ? // tofu's refresh finds it gone, and the plan orders it again.
                `Run \`${provision}\`: it orders the certificate again (it shows the plan first).`
              : `Delete it in ${edgeCertificates(zone)}, then run \`${provision}\`: it orders a new one (it shows the plan first).`,
        },
  );
  const totalTls = (await client.totalTls(found.id)).enabled;
  const tls = checkResult(
    "previews-total-tls",
    `Total TLS is off for ${zone}`,
    "high",
    totalTls ? "fail" : "pass",
    totalTls
      ? `Total TLS is on for ${zone}: it gives each proxied name a certificate of its own, and every public certificate is published, so each preview's name would be too.`
      : `Total TLS is off, so no preview's name gets a published certificate of its own.`,
    totalTls ? { remediation: `Turn Total TLS off in ${edgeCertificates(zone)}.` } : {},
  );
  return [pack, tls];
}

/**
 * What `destroy` of the preview environment says when its previews were below the app's zone
 * `zone` (spec.md US10 #4): the pack goes, ACM stays on until the user turns it off.
 */
export function acmStaysOn(zone: string): string {
  return `Advanced Certificate Manager stays on for ${zone}, and Cloudflare bills it until you turn it off in ${edgeCertificates(zone)}, once nothing else of yours uses it.`;
}
