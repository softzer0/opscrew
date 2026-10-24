/**
 * Pure helpers of feature 016's live tests on the server-less targets (`cloudflare-hosting.test.ts`,
 * `github-pages.test.ts`, `several-apps.test.ts`): their variables and limits, OpsCrew's security
 * headers on an answer, what `opscrew status` names of a site's versions, the run and build a
 * Worker version's message names, the pages the SSR example renders, the `www` redirect, and the
 * takeover check of a GitHub Pages destroy. No network, no processes; unit-tested in
 * `serverless-support.test.ts`.
 */
import type { ZoneRecord } from "./tls-support";

/** What the Cloudflare hosting pass needs besides its gate (the SSR app is on repository B). */
export const CLOUDFLARE_HOSTING_VARIABLES = [
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_REPO_B",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** What the GitHub Pages pass needs besides its gate: the public throwaway repository C. */
export const GITHUB_PAGES_VARIABLES = [
  "OPSCREW_E2E_GITHUB_REPO_C",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** What the two-apps pass needs besides its gate. */
export const SEVERAL_APPS_VARIABLES = [
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** SC-1601: a static example live on Cloudflare within 10 minutes of the start of `provision`. */
export const SC_1601_MS = 10 * 60_000;

/** SC-1604: a rollback on Cloudflare answers with the previous version within a minute. */
export const SC_1604_MS = 60_000;

/** OpsCrew's security headers every answer of a site on Cloudflare carries (spec US1 scenario 4). */
export const OPSCREW_HEADERS = [
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
] as const;

/** The OpsCrew headers an answer lacks (by lower-case name); `nosniff` is the only valid value. */
export function missingHeaders(headers: Record<string, string | string[] | undefined>): string[] {
  return OPSCREW_HEADERS.filter((name) => {
    const value = headers[name];
    if (value === undefined || String(value).trim() === "") return true;
    return name === "x-content-type-options" && String(value).trim().toLowerCase() !== "nosniff";
  });
}

/**
 * What `opscrew status` shows of a site's versions: the id after `Running: version`, and the id
 * its rollback command (`Roll back to it: opscrew promote … --version <id>`) names.
 */
export function statusVersions(output: string): { running?: string; rollback?: string } {
  const running = /^\s*Running: version (\S+?),/m.exec(output)?.[1];
  const rollback = /^\s*Roll back to it: opscrew promote .*--version (\S+)\s*$/m.exec(output)?.[1];
  return {
    ...(running === undefined ? {} : { running }),
    ...(rollback === undefined ? {} : { rollback }),
  };
}

/** The run id and build SHA-256 of a version message `opscrew <run id> <sha256>` (the deploy job's). */
export function versionBuild(message: string): { runId: number; sha256: string } | undefined {
  const match = /^opscrew (\d+) ([0-9a-f]{64})$/.exec(message.trim());
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { runId: Number(match[1]), sha256: match[2] };
}

/** The version the latest deployment serves (the largest share); `undefined` with none. */
export function servingVersion(
  deployments: readonly { versions: readonly { id: string; percentage: number }[] }[],
): string | undefined {
  const [latest] = deployments;
  return latest === undefined
    ? undefined
    : [...latest.versions].sort((a, b) => b.percentage - a.percentage)[0]?.id;
}

/** When `examples/astro-ssr`'s home page says it was rendered ("Rendered on the server at …"). */
export function renderedAt(body: string): string | undefined {
  return /Rendered on the server at ([^<\s]+)\./.exec(body)?.[1];
}

/** The SHA-256 the SSR pass's secret page shows of the app's secret, "not set" without one. */
export function secretDigest(body: string): string | undefined {
  return /The secret's SHA-256: ([0-9a-f]{64}|not set)/.exec(body)?.[1];
}

/**
 * What is wrong with an answer that should be a 301 to `to`: another status, or another
 * `Location`; `undefined` when it is right.
 */
export function redirectProblem(
  answer: { status: number; headers: Record<string, string | string[] | undefined> },
  to: string,
): string | undefined {
  const location = String(answer.headers.location ?? "");
  if (answer.status !== 301) return `it answered ${answer.status}, not 301`;
  return location === to ? undefined : `it redirects to ${location || "nowhere"}, not to ${to}`;
}

/** GitHub Pages' addresses for an apex (docs.github.com, "Managing a custom domain"). */
const PAGES_ADDRESSES = [
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
  "2606:50c0:8000::153",
  "2606:50c0:8001::153",
  "2606:50c0:8002::153",
  "2606:50c0:8003::153",
];

/** Whether a DNS record sends its name to GitHub Pages: a CNAME to `*.github.io`, or its addresses. */
export function pointsAtGitHub(record: Pick<ZoneRecord, "type" | "content">): boolean {
  const content = (record.content ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (record.type === "CNAME") return content.endsWith(".github.io");
  return (record.type === "A" || record.type === "AAAA") && PAGES_ADDRESSES.includes(content);
}

/**
 * The takeover window SC-1605 rules out, in one sample of a GitHub Pages destroy: a record on
 * `hostname` that points at GitHub while the repository's Pages site does not claim `hostname`
 * (`cname`, `undefined` when Pages is off). Read the site first and the records after it, so a
 * destroy in the safe order (records first, then the custom domain) never shows one. Returns what
 * was seen, `undefined` when nothing.
 */
export function takeoverWindow(
  hostname: string,
  site: { cname: string | null } | undefined,
  records: readonly Pick<ZoneRecord, "type" | "name" | "content">[],
): string | undefined {
  if (site?.cname?.toLowerCase() === hostname.toLowerCase()) return undefined;
  const pointing = records.filter((record) => record.name === hostname && pointsAtGitHub(record));
  if (pointing.length === 0) return undefined;
  return `${pointing.map((record) => `a ${record.type} record`).join(" and ")} of ${hostname} pointed at GitHub while ${site === undefined ? "GitHub Pages was off" : "the Pages site did not claim it"}`;
}

/**
 * Why the cleanup must keep a GitHub Pages site: a record on one of the run's `hostnames` still
 * points at GitHub, so turning Pages off would open the takeover window. `undefined` when no
 * record does and the site may go.
 */
export function pagesRemovalBlocker(
  hostnames: readonly string[],
  records: readonly Pick<ZoneRecord, "type" | "name" | "content">[],
): string | undefined {
  const pointing = [
    ...new Set(
      records
        .filter((record) => hostnames.includes(record.name) && pointsAtGitHub(record))
        .map((record) => record.name),
    ),
  ];
  return pointing.length === 0
    ? undefined
    : `kept the GitHub Pages site: a record on ${pointing.join(", ")} still points at GitHub; delete it, then turn Pages off in the repository's Settings → Pages`;
}

/**
 * The verification value the GitHub Pages pass gives `provision --pages-verification`: letters
 * and digits, as GitHub's values are, but a stand-in. The real value exists only on the GitHub
 * account's settings page, for a domain added there by hand, and the site is published and gets
 * its certificate without it, so the pass checks the record and the printed Verify step only.
 */
export function pagesStandIn(runId: string): string {
  return `opscrewe2e${runId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}
