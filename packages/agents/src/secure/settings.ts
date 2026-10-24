/**
 * What `opscrew secure` checks beyond the server (feature 014): the app's Cloudflare origin and
 * client certificates (expiry, the permission gap), CAA records that are not OpsCrew's at the
 * app's names and advice for a DNS-only app on the zone apex, the zone's minimum TLS version, and
 * a public repository holding the secrets copy. Read-only.
 */
import { join } from "node:path";
import {
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareClient,
  inspectShared,
  OPSCREW_MANAGED_COMMENT,
  planShared,
  type SharedRecord,
} from "@opscrew/connector-cloudflare";
import type { CheckResult } from "@opscrew/contracts";
import { errorText, exists, isUserFacingError, listText } from "@opscrew/core";
import { CAA_ISSUERS, edgeProxy } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { readCloudflareRecord, sharedCloudflareClient } from "../provision/shared-cloudflare";
import { copyPath } from "../secrets";
import { readRecord } from "../secrets/store";
import { listsRedirect } from "../serverless/cloudflare/rules";
import { checkResult, repositoryPrivate } from "../shared";
import { proxyCertificateHosts, recordCertificateCheck } from "../status/certificates";

/** The token permission the app's origin TLS needs, as Cloudflare's token page names it. */
const SSL_PERMISSION = "Zone → SSL and Certificates → Edit";

/** The permission gap the record keeps while the token lacks the certificate permissions (FR-1405). */
function permissionGap(record: SharedRecord | undefined): CheckResult[] {
  if (record?.tls?.gap !== "permission") return [];
  return [
    checkResult(
      "origin-tls-permission",
      "The Cloudflare token may manage the app's origin certificates",
      "medium",
      "warn",
      "The Cloudflare token lacks the certificate permissions, so the app has no Cloudflare origin certificate and its server does not require Cloudflare's client certificate: it accepts any connection from Cloudflare's addresses.",
      {
        remediation: `Edit the token at ${CLOUDFLARE_TOKEN_PAGE} and give it ${SSL_PERMISSION} for this zone, then run \`opscrew provision\`.`,
      },
    ),
  ];
}

/**
 * CAA records that are not OpsCrew's at the app's names (FR-1431: reported, never changed), and
 * advice for a DNS-only app on the zone apex, where OpsCrew writes none (FR-1430); only where the
 * server's proxy gets the certificates.
 */
async function caaChecks(
  client: CloudflareClient,
  plan: DeployPlan,
  zoneId: string,
): Promise<CheckResult[]> {
  const names = proxyCertificateHosts(plan);
  if (names.length === 0) return [];
  const id = "caa-records";
  const title = "CAA records at the app's names allow the authorities its proxy uses";
  const caa = (await client.listDnsRecords(zoneId, { type: "CAA" })).filter(
    (r) => r.type.toUpperCase() === "CAA" && names.includes(r.name),
  );
  const foreign = caa.filter((r) => r.comment?.trim() !== OPSCREW_MANAGED_COMMENT);
  const authorities = listText(CAA_ISSUERS[edgeProxy(plan)]);
  const out: CheckResult[] = [];
  if (foreign.length > 0) {
    out.push(
      checkResult(
        id,
        title,
        "low",
        "warn",
        `Cloudflare has CAA records at ${listText([...new Set(foreign.map((r) => r.name))])} that OpsCrew did not create (${foreign.map((r) => r.content).join("; ")}). OpsCrew leaves them as they are.`,
        {
          remediation: `Together with OpsCrew's own they decide which authorities may issue certificates there: check that they allow ${authorities}, which the server's proxy uses.`,
        },
      ),
    );
  }
  const { domain, zone } = plan.dns;
  if (domain !== undefined && domain === zone && !caa.some((r) => r.name === domain)) {
    out.push(
      checkResult(
        "caa-apex",
        "The zone's apex has CAA records",
        "low",
        "warn",
        `OpsCrew writes no CAA record at ${domain}, the zone's apex, because one there applies to every name in the zone.`,
        {
          remediation: `If every site in the zone gets its certificates from the same authorities, add CAA records at ${domain} in the Cloudflare dashboard (DNS → Records) naming them, including ${authorities}, which the server's proxy uses.`,
        },
      ),
    );
  }
  return out.length > 0
    ? out
    : [checkResult(id, title, "low", "pass", "No one else's CAA records are at the app's names.")];
}

/**
 * The zone's minimum TLS version for an app behind Cloudflare's proxy (FR-1432): the shared
 * plan's advice to raise it, or that the token may not read it. The `www` redirect's phase is read
 * too when the record lists hostnames there (a site on Cloudflare's hosting), as the plan needs.
 */
async function minTlsChecks(
  client: CloudflareClient,
  deps: Pick<PhaseDeps, "clock">,
  record: SharedRecord,
): Promise<CheckResult[]> {
  const facts = await inspectShared(client, {
    zoneId: record.zoneId,
    accountId: "",
    access: false,
    redirect: listsRedirect(record),
    minTls: true,
    clock: deps.clock,
  });
  const { advice } = planShared(facts, { hostnames: record.hostnames, minTls: true }, record);
  const id = "min-tls";
  const title = "The zone accepts TLS 1.2 and newer only";
  const results = advice.map((item) =>
    checkResult(
      id,
      title,
      item.code === "min-tls-advised" ? "low" : "medium",
      "warn",
      item.message,
      { remediation: item.hint },
    ),
  );
  if (results.length > 0 || facts.minTls === undefined) return results;
  return [
    checkResult(
      id,
      title,
      "low",
      "pass",
      `The zone's minimum TLS version is ${facts.minTls.value}.`,
    ),
  ];
}

/** True when visitors reach the app at Cloudflare's edge: proxied DNS or a Cloudflare Tunnel. */
export function behindCloudflare(plan: DeployPlan): boolean {
  const { dns, target } = plan;
  return (
    (dns.provider === "cloudflare" && dns.proxied) ||
    (target.provider === "own" && target.access === "tunnel") ||
    (target.provider === "portainer" && target.web.mode === "tunnel")
  );
}

/**
 * A public repository holding the secrets copy (FR-1415): fine when the user agreed to commit it
 * there, a warning when it was committed while the repository was private. Nothing without a copy
 * in the repository.
 */
async function copyCheck(deps: PhaseDeps): Promise<CheckResult[]> {
  const copy = copyPath(deps.paths);
  if (!(await exists(join(deps.paths.root, copy)))) return [];
  const id = "secrets-copy-repository";
  const title = "The secrets copy is in a repository you chose for it";
  const isPrivate = await repositoryPrivate(deps);
  if (isPrivate === undefined) {
    return [
      checkResult(
        id,
        title,
        "high",
        "skip",
        "OpsCrew could not tell whether the GitHub repository is public (no GitHub token, or GitHub did not answer).",
        {
          remediation:
            "Set GITHUB_TOKEN (or log in with `gh auth login`), then run `opscrew secure` again.",
        },
      ),
    ];
  }
  if (isPrivate) {
    return [
      checkResult(id, title, "high", "pass", "The repository holding the secrets copy is private."),
    ];
  }
  if ((await readRecord(deps.paths)).publicConfirmed === true) {
    return [
      checkResult(
        id,
        title,
        "high",
        "pass",
        "The repository is public, and you agreed to commit the encrypted secrets copy there.",
      ),
    ];
  }
  return [
    checkResult(
      id,
      title,
      "high",
      "warn",
      `The repository became public with the encrypted secrets copy in it (${copy}): anyone can keep a copy of the encrypted file and try to open it later, and the names of the files it holds are readable.`,
      {
        remediation:
          "Make the repository private again if it should not be public. If it stays public, keep your age key safe (only it opens the copy); to be sure, run `opscrew secrets rotate` and then change the secrets themselves, since older commits keep the old copy.",
      },
    ),
  ];
}

/**
 * Every check of this module, most local first: the record's certificates and permission gap,
 * then, with the app's Cloudflare record and token, CAA and the zone's minimum TLS (one `skip`
 * without the token), then the secrets copy. Values never appear; only names, dates and the
 * records' public content.
 */
export async function settingsChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: { cloudflare?: CloudflareClient },
): Promise<CheckResult[]> {
  const record = await readCloudflareRecord(deps.paths);
  const results = [...recordCertificateCheck(plan, record, deps.clock), ...permissionGap(record)];
  if (record !== undefined && plan.dns.provider === "cloudflare") {
    try {
      const client = sharedCloudflareClient(
        deps,
        services.cloudflare !== undefined ? { sharedCloudflare: services.cloudflare } : {},
      );
      deps.reporter.step(
        "Reading the zone's CAA records and minimum TLS at Cloudflare (read-only)",
      );
      results.push(...(await caaChecks(client, plan, record.zoneId)));
      if (behindCloudflare(plan)) results.push(...(await minTlsChecks(client, deps, record)));
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      results.push(
        checkResult(
          "cloudflare-settings",
          "CAA records and the zone's minimum TLS are checked",
          "low",
          "skip",
          `Skipped: ${errorText(error)}`,
        ),
      );
    }
  }
  return [...results, ...(await copyCheck(deps))];
}
