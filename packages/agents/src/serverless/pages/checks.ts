/**
 * What `opscrew provision` checks for GitHub Pages before any change (T1609): that GitHub allows
 * Pages for the repository, that the site's hostnames hold no record GitHub Pages cannot work
 * with, and that no CAA record keeps GitHub from getting the site's certificate.
 */
import type { CloudflareDnsRecord } from "@opscrew/connector-cloudflare";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../../context";
import { PAGES_NOT_ALLOWED } from "../../design/serverless";
import type { CloudflareApi } from "../../provision/types";
import { planStop } from "../../shared";
import type { PagesApi } from "./plan";

/** GitHub Pages' addresses for an apex domain, as the `cloudflare-dns/github-pages` module sets them. */
const PAGES_ADDRESSES = [
  ...["108", "109", "110", "111"].map((part) => `A 185.199.${part}.153`),
  ...["8000", "8001", "8002", "8003"].map((part) => `AAAA 2606:50c0:${part}::153`),
];

/** The certificate authority GitHub Pages gets its certificates from. */
const LETS_ENCRYPT = "letsencrypt.org";

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) when the repository's plan has no GitHub Pages
 * (a private repository on GitHub's free plan). When GitHub does not show the plan to the token,
 * says so: GitHub then refuses the Pages plan's first step, with nothing changed.
 */
export async function requirePagesAllowed(
  deps: Pick<PhaseDeps, "reporter">,
  pages: Pick<PagesApi, "pagesAllowed">,
  repository: { owner: string; repo: string },
): Promise<void> {
  const { owner, repo } = repository;
  const allowed = await pages.pagesAllowed(owner, repo);
  if (allowed === "no") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Pages is not available for ${owner}/${repo}: ${PAGES_NOT_ALLOWED.reason}. Nothing was changed.`,
      { hint: PAGES_NOT_ALLOWED.fix },
    );
  }
  if (allowed === "unknown") {
    deps.reporter.info(
      `OpsCrew cannot tell whether the GitHub plan of ${owner} allows GitHub Pages for this private repository (the token cannot read the plan without Plan: Read). If it does not, GitHub refuses the Pages plan's first step, and nothing changes.`,
    );
  }
}

/** A record as `TYPE content`, its content in lower case without a final dot. */
function recordKey(record: CloudflareDnsRecord): string {
  return `${record.type.toUpperCase()} ${record.content.toLowerCase().replace(/\.$/, "")}`;
}

/** The site's hostnames: the domain, and `www.` with it when on. */
export function pagesHostnames(dns: { domain: string; www: boolean }): string[] {
  return dns.www ? [dns.domain, `www.${dns.domain}`] : [dns.domain];
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) when a record at the site's hostnames is proxied
 * by Cloudflare (its proxy stops GitHub from issuing and renewing the certificate), or is one the
 * site does not get: at the apex an A or AAAA record other than GitHub Pages' addresses, or a
 * CNAME; at a subdomain any record but the CNAME to `<owner>.github.io` (a CNAME shares its name
 * with no other record). Records OpsCrew did not create stopped earlier (`setupCloudflare`).
 */
export async function requirePagesHostnames(
  deps: Pick<PhaseDeps, "redactor">,
  input: {
    api: Pick<CloudflareApi, "listDnsRecords">;
    zoneId: string;
    zone: string;
    hostnames: readonly string[];
    owner: string;
    command: string;
  },
): Promise<void> {
  const problems: string[] = [];
  for (const host of input.hostnames) {
    const apex = host === input.zone;
    const wanted = new Set(
      apex ? PAGES_ADDRESSES : [`CNAME ${input.owner.toLowerCase()}.github.io`],
    );
    for (const record of await input.api.listDnsRecords(input.zoneId, { name: host })) {
      const type = record.type.toUpperCase();
      const line = `${type} ${record.name} ${record.content}`;
      if (record.proxied === true) {
        problems.push(`${line} (proxied by Cloudflare)`);
        continue;
      }
      const addressing = type === "A" || type === "AAAA" || type === "CNAME";
      if (addressing ? !wanted.has(recordKey(record)) : !apex) problems.push(line);
    }
  }
  if (problems.length === 0) return;
  throw planStop(
    deps.redactor.redact(
      "Cloudflare has DNS records at the site's hostnames that GitHub Pages cannot work with, so OpsCrew changed nothing:",
    ),
    problems.map((problem) => deps.redactor.redact(problem)),
    `Cloudflare's proxy stops GitHub from issuing and renewing the site's certificate, and the site's own records point the hostnames at GitHub Pages. In the Cloudflare dashboard (DNS → Records), turn the proxy off (DNS only) for a record of the site, delete the others if they belong to a host you no longer use, or pick another hostname with \`opscrew interview\` and \`opscrew design\`; then run \`${input.command}\` again.`,
  );
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) when the Pages plan replaces the site's custom
 * domain `replaced` while Cloudflare still has records that point it (or `www.` under it) at GitHub
 * Pages: setting the new domain first would leave them pointing at GitHub with no site claiming
 * the name, so another GitHub Pages site could take it over. A name in no zone the token sees has
 * no records to check.
 */
export async function requireReplacedDomainReleased(
  deps: Pick<PhaseDeps, "redactor">,
  input: {
    api: Pick<CloudflareApi, "findZone" | "listDnsRecords">;
    replaced: string;
    owner: string;
    command: string;
  },
): Promise<void> {
  const { replaced } = input;
  const zone = await input.api.findZone(replaced);
  if (zone === undefined) return;
  const github = new Set([...PAGES_ADDRESSES, `CNAME ${input.owner.toLowerCase()}.github.io`]);
  const pointing: string[] = [];
  for (const host of [replaced, `www.${replaced}`]) {
    for (const record of await input.api.listDnsRecords(zone.id, { name: host })) {
      if (github.has(recordKey(record))) {
        pointing.push(deps.redactor.redact(`${record.type} ${record.name} ${record.content}`));
      }
    }
  }
  if (pointing.length === 0) return;
  throw planStop(
    `The GitHub Pages site's custom domain is ${replaced} now, and Cloudflare still has records that point it at GitHub Pages. Setting the new domain first would leave them pointing at GitHub with no site claiming ${replaced}, so another GitHub Pages site could take it over; OpsCrew changed nothing:`,
    pointing,
    `Remove these records first: \`opscrew destroy\` for the deployment that created them, or delete them in the Cloudflare dashboard (DNS → Records). Then run \`${input.command}\` again.`,
  );
}

/** A CAA record's tag and value (`0 issue "letsencrypt.org"`), or `undefined` when unreadable. */
function parseCaa(content: string): { tag: string; value: string } | undefined {
  const match = /^\s*\d+\s+([A-Za-z0-9]+)\s+"?(.*?)"?\s*$/.exec(content);
  if (match === null) return undefined;
  return { tag: (match[1] ?? "").toLowerCase(), value: match[2] ?? "" };
}

/** `name` and every name above it, up to the zone's apex. */
function namesUpTo(name: string, zone: string): string[] {
  const names = [name];
  let current = name;
  while (current !== zone && current.includes(".")) {
    current = current.slice(current.indexOf(".") + 1);
    names.push(current);
  }
  return names;
}

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) when the CAA records that decide for a hostname of
 * the site (those at the closest name above it, the hostname included, that has any) let only
 * other certificate authorities than Let's Encrypt issue, so GitHub cannot get its certificate.
 * The records are named.
 */
export async function requireCaaAllowsLetsEncrypt(
  deps: Pick<PhaseDeps, "redactor">,
  input: {
    api: Pick<CloudflareApi, "listDnsRecords">;
    zoneId: string;
    zone: string;
    hostnames: readonly string[];
    command: string;
  },
): Promise<void> {
  const read = new Map<string, CloudflareDnsRecord[]>();
  const refusing = new Map<string, CloudflareDnsRecord>();
  for (const host of input.hostnames) {
    for (const name of namesUpTo(host, input.zone)) {
      let records = read.get(name);
      if (records === undefined) {
        records = await input.api.listDnsRecords(input.zoneId, { name, type: "CAA" });
        read.set(name, records);
      }
      if (records.length === 0) continue;
      const issuing = records.filter((record) => parseCaa(record.content)?.tag === "issue");
      const allows = issuing.some(
        (record) =>
          (parseCaa(record.content)?.value ?? "").split(";")[0]?.trim().toLowerCase() ===
          LETS_ENCRYPT,
      );
      if (issuing.length > 0 && !allows) {
        for (const record of issuing) refusing.set(`${record.name} ${record.content}`, record);
      }
      break;
    }
  }
  if (refusing.size === 0) return;
  throw planStop(
    "CAA records on the domain let only other certificate authorities issue its certificates, so GitHub could not get the site's certificate from Let's Encrypt, and OpsCrew changed nothing:",
    [...refusing.values()].map((record) =>
      deps.redactor.redact(`CAA ${record.name} ${record.content}`),
    ),
    `In the Cloudflare dashboard (DNS → Records), add a CAA record \`0 issue "${LETS_ENCRYPT}"\` next to them, or delete them if nothing needs them, then run \`${input.command}\` again.`,
  );
}
