/**
 * What the hosting account live passes (feature 027: `cpanel.test.ts`, `sftp-host.test.ts`) need
 * besides the harness: the cPanel pass's gate and variables, the panel's access as OpsCrew reads it
 * (`OPSCREW_HOSTING_*`), the masks that keep the account's user and domains out of every log line,
 * the run's names (`e2e-<tag>-<leg>`), a hosting deploy run's check, the watch of the answers
 * around a switch (SC-2703), the account's inventory and its field-by-field comparison (SC-2702),
 * and the cleanup's reads and removals on the account. The pure helpers are unit-tested in
 * `cpanel-support.test.ts`; the account's calls go through an injected `fetch`, and no value of the
 * token is ever printed.
 */
import { createHash } from "node:crypto";
import { CpanelPanel } from "@opscrew/connector-cpanel";
import type { FetchLike, HostingPanelAccess } from "@opscrew/contracts";
import { z } from "zod";
import type { DeployRun, HttpAnswer } from "./cloud";
import { removeGithubLeftovers } from "./environment-checks";
import type { LiveRun } from "./harness";
import { type DeployJob, jobSucceeded } from "./support";

/** The cPanel pass's gate: it runs only with `OPSCREW_E2E_CPANEL=1`. */
export const CPANEL_GATE = "OPSCREW_E2E_CPANEL";

/** With it, `examples/laravel-app` runs its whole leg; without, its refusal is checked. */
export const CPANEL_LARAVEL_GATE = "OPSCREW_E2E_CPANEL_LARAVEL";

/** Every variable the cPanel pass needs besides its gate. */
export const CPANEL_VARIABLES = [
  "OPSCREW_E2E_CPANEL_URL",
  "OPSCREW_E2E_CPANEL_USER",
  "OPSCREW_E2E_CPANEL_TOKEN",
  "OPSCREW_E2E_CPANEL_DOMAIN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
] as const;

/** How OpsCrew reaches a panel; a pass of the other kind drops them from the CLI's environment. */
export const PANEL_VARIABLES = [
  "OPSCREW_HOSTING_URL",
  "OPSCREW_HOSTING_USER",
  "OPSCREW_HOSTING_TOKEN",
] as const;

/** How OpsCrew reaches an SFTP-only host; the cPanel pass drops them from the CLI's environment. */
export const SFTP_VARIABLES = [
  "OPSCREW_SFTP_HOST",
  "OPSCREW_SFTP_USER",
  "OPSCREW_SFTP_KEY",
] as const;

/** The panel's address as OpsCrew takes it: `https://<host>:<port>`, port 2083 when none given. */
export function panelUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:") throw new Error("OPSCREW_E2E_CPANEL_URL must use https://.");
  return `https://${url.hostname}:${url.port === "" ? "2083" : url.port}`;
}

/** The account's access from the test's variables. */
export function panelAccess(env: Record<string, string | undefined>): HostingPanelAccess {
  return {
    url: panelUrl(env.OPSCREW_E2E_CPANEL_URL ?? ""),
    user: (env.OPSCREW_E2E_CPANEL_USER ?? "").trim(),
    token: (env.OPSCREW_E2E_CPANEL_TOKEN ?? "").trim(),
  };
}

/** The access under the names OpsCrew reads it from (`OPSCREW_HOSTING_*`). */
export function hostingEnv(access: HostingPanelAccess): Record<string, string> {
  return {
    OPSCREW_HOSTING_URL: access.url,
    OPSCREW_HOSTING_USER: access.user,
    OPSCREW_HOSTING_TOKEN: access.token,
  };
}

// ---------------------------------------------------------------------------------------------
// Masks.

/**
 * The scrubber labels of values masked in the log only (the account's user, its domains, the
 * panel's host): they are no secrets, so the leak search skips them (CLI output and commits name
 * the app's hostname on purpose), but no log line may show them.
 */
export const ACCOUNT_LABEL_PREFIX = "account-";

/**
 * The account's user, the panel's host and `domains` as values to mask, each also in the form
 * cPanel's certificate and key ids use (dots and hyphens as underscores), and the prefix cPanel
 * gives database and database user names (`Mysql::get_restrictions`; without one, the user's first
 * 8 characters, as cPanel cuts it), without its underscore, as the user. The token is a secret and
 * is added apart.
 */
export function accountMasks(
  access: Pick<HostingPanelAccess, "url" | "user">,
  domains: readonly string[],
  prefix?: string,
): { value: string; label: string }[] {
  const named = [
    { value: new URL(access.url).hostname, label: `${ACCOUNT_LABEL_PREFIX}panel-host` },
    { value: access.user, label: `${ACCOUNT_LABEL_PREFIX}user` },
    {
      value: (prefix ?? access.user.slice(0, 8)).replace(/_+$/, ""),
      label: `${ACCOUNT_LABEL_PREFIX}user`,
    },
    ...domains.map((value) => ({
      value: value.toLowerCase(),
      label: `${ACCOUNT_LABEL_PREFIX}domain`,
    })),
  ].filter(({ value }) => value.length > 2);
  const masks = new Map<string, string>();
  for (const { value, label } of named) {
    masks.set(value, label);
    if (/[.-]/.test(value)) masks.set(value.replace(/[.-]/g, "_"), label);
  }
  return [...masks].map(([value, label]) => ({ value, label }));
}

// ---------------------------------------------------------------------------------------------
// The run's names.

/** A short tag of the run for every name it makes on the account (`e2e-<tag>-…`). */
export function runTag(runId: string): string {
  const tag = runId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-6);
  if (tag.length < 6) throw new Error(`Cannot take a tag from the run id "${runId}".`);
  return tag;
}

/** One leg's app name and hostname: `e2e-<tag>-<leg>` and `e2e-<tag>-<leg>.<domain>`. */
export function legNames(
  tag: string,
  leg: string,
  domain: string,
): { app: string; hostname: string } {
  const app = `e2e-${tag}-${leg}`;
  return { app, hostname: `${app}.${domain.trim().toLowerCase().replace(/\.$/, "")}` };
}

/**
 * Whether `text` names an object of the run: `e2e-<tag>` or, as cPanel writes database names and
 * certificate ids, `e2e_<tag>`, in any case.
 */
export function namesRun(text: string, tag: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(`e2e-${tag}`) || lower.includes(`e2e_${tag}`);
}

/**
 * The interview's answers for an app on a hosting account at `hostname` (DNS outside Cloudflare,
 * kept by the account or the test), with the hosting follow-ups `follow` (`hosting.port`, …).
 */
export function hostingAnswers(
  hostname: string,
  follow: Readonly<Record<string, string | number>> = {},
): Record<string, unknown> {
  return {
    provider: "hosting",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: 20,
    uptime: "best-effort",
    dataCriticality: "important",
    dnsProvider: "other",
    domain: hostname,
    keepExternalServices: { s3: false },
    "hosting.hostname": hostname,
    ...follow,
  };
}

// ---------------------------------------------------------------------------------------------
// Deploy runs.

/** The job of a panel account's deploy workflow that waits for the account to serve the release. */
export const PANEL_DEPLOY_JOB = /^Wait for \S+ to serve the release$/;
/** The job of an SFTP host's deploy workflow that uploads and switches the release. */
export const SFTP_DEPLOY_JOB = /^Upload the release over SFTP and switch \S+ to it$/;

/**
 * Why a finished hosting deploy run did not deploy, `undefined` when it did: the run did not
 * succeed, it has no job matching `job`, or that job did not succeed. Names jobs and conclusions
 * only.
 */
export function hostingRunProblem(run: Pick<DeployRun, "conclusion" | "jobs">, job: RegExp) {
  const jobs = run.jobs.map((item) => `${item.name}=${item.conclusion}`).join(", ");
  const deploy: DeployJob | undefined = run.jobs.find((item) => job.test(item.name));
  if (deploy === undefined) return `it has no job matching ${job}; jobs: ${jobs}`;
  if (run.conclusion !== "success" || !jobSucceeded(deploy, run.conclusion)) {
    return `it ended ${run.conclusion}; jobs: ${jobs}`;
  }
  return undefined;
}

/**
 * What a hosting pass left at GitHub in `app`'s repository: the agent's deploy keys whose title
 * starts with `keyPrefix` (`opscrew-e2e-<tag>-`), then, for prod when `live` (its folder is still
 * there; a destroy took the rest), the environments' leftovers ({@link removeGithubLeftovers}).
 * Returns what GitHub kept.
 */
export async function hostingGithubLeftovers(
  app: LiveRun,
  input: { before: readonly string[] | undefined; live: boolean; keyPrefix?: string },
): Promise<string[]> {
  const { github } = app;
  const problems: string[] = [];
  if (input.keyPrefix !== undefined) {
    const keys = await github.call("GET", `/repos/${github.name}/keys?per_page=100`);
    for (const key of (keys.json as { id: number; title: string }[] | undefined) ?? []) {
      if (!key.title.startsWith(input.keyPrefix)) continue;
      const deleted = await github.call("DELETE", `/repos/${github.name}/keys/${key.id}`);
      if (![204, 404].includes(deleted.status)) {
        problems.push(`GitHub kept the deploy key ${key.title} (HTTP ${deleted.status})`);
      }
    }
  }
  return [
    ...problems,
    ...(await removeGithubLeftovers(app, {
      environments: input.live ? ["prod"] : [],
      paths: (environment) => app.paths(environment),
      readPlan: (environment) => app.readPlan(environment),
      before: input.before,
    })),
  ];
}

// ---------------------------------------------------------------------------------------------
// The answers around a switch (SC-2703).

/** A page whose answer tells an app's first release from its second one. */
export interface Marker {
  /** Its path on the hostname. */
  path: string;
  /** The file in the repository the second release changes. */
  file: string;
  /** That file's content in the first release, when the example has none. */
  first?: string;
  /** Its content in the second release. */
  second: () => Promise<string>;
  /** The first release's page and the second's. */
  isFirst: (status: number, body: string) => boolean;
  isSecond: (status: number, body: string) => boolean;
}

const phpPage = (which: string) =>
  `<?php\nheader('Content-Type: text/plain');\necho 'opscrew-e2e release ${which}';\n`;

/** A plain PHP app's page, in its `public/` in both releases, which tells them apart. */
export const PHP_MARKER: Marker = {
  path: "/opscrew-e2e-release.php",
  file: "public/opscrew-e2e-release.php",
  first: phpPage("one"),
  second: async () => phpPage("two"),
  isFirst: (status, body) => status === 200 && body.trim() === "opscrew-e2e release one",
  isSecond: (status, body) => status === 200 && body.trim() === "opscrew-e2e release two",
};

const SITE_TEXT = "opscrew-e2e release two";

/** A static site's file only its second release has (Vite copies `public/` into the build). */
export const SITE_MARKER: Marker = {
  path: "/opscrew-e2e-release.txt",
  file: "public/opscrew-e2e-release.txt",
  second: async () => `${SITE_TEXT}\n`,
  isSecond: (status, body) => status === 200 && body.trim() === SITE_TEXT,
  isFirst: (status, body) => status < 500 && !(status === 200 && body.trim() === SITE_TEXT),
};

/** One answer while a switch was watched; the body is never kept, only what kind of page it is. */
export interface SwitchSample {
  /** Milliseconds since the watch started. */
  at: number;
  /** The `X-OpsCrew-Release` header. */
  release?: string;
  /** The release's page, the one before, or neither (an error, a 5xx, a page of neither). */
  page: "new" | "old" | "other";
}

/** How to tell the page of the release switched to from the page of the one before. */
export interface SwitchPages {
  isNew: (status: number, body: string) => boolean;
  isOld: (status: number, body: string) => boolean;
}

/** What the answers around a switch showed. */
export interface SwitchVerdict {
  /** When the first answer of another release than `oldRelease` came, if one did. */
  switchedAt?: number;
  /** That answer's release. */
  release?: string;
  /** Answers from that one on, counted. */
  after: number;
  /** Answers from that one on that were neither page (errors, 5xx). */
  others: number;
  /** An answer from that one on with the old release or the old page. */
  problems: string[];
}

/**
 * Reads the samples of a watched switch from release `oldRelease`: from the first answer that
 * names another release on, every answer must name that release and show its page, never the old
 * release or the old page (the first request after a switch answers with the new release). With
 * `from`, only answers at or after it count (an Apache host, whose PHP may keep the old release for
 * a while, checked after the deploy's own wait).
 */
export function switchVerdict(
  samples: readonly SwitchSample[],
  oldRelease: string | undefined,
  from = 0,
): SwitchVerdict {
  const counted = samples.filter((sample) => sample.at >= from);
  const first = counted.findIndex(
    (sample) => sample.release !== undefined && sample.release !== oldRelease,
  );
  if (first < 0) return { after: 0, others: 0, problems: [] };
  const switched = counted[first] as SwitchSample;
  const problems: string[] = [];
  let others = 0;
  for (const sample of counted.slice(first)) {
    const when = `${Math.round((sample.at - switched.at) / 100) / 10} s after the first answer of ${switched.release}`;
    if (sample.release === oldRelease) {
      problems.push(`an answer ${when} named the old release ${oldRelease}`);
    } else if (sample.release !== undefined && sample.release !== switched.release) {
      problems.push(`an answer ${when} named the release ${sample.release}`);
    }
    if (sample.page === "old") problems.push(`an answer ${when} showed the old release's page`);
    else if (sample.page === "other") others++;
  }
  return {
    switchedAt: switched.at,
    ...(switched.release === undefined ? {} : { release: switched.release }),
    after: counted.length - first,
    others,
    problems,
  };
}

/** The release an answer names in its `X-OpsCrew-Release` header. */
export function releaseOf(answer: Pick<HttpAnswer, "headers">): string | undefined {
  const value = answer.headers["x-opscrew-release"];
  const text = Array.isArray(value) ? value[0] : value;
  return text === undefined || text.trim() === "" ? undefined : text.trim();
}

/**
 * Asks `url` about every `intervalMs` while `during` runs and for `settleMs` after it ended,
 * and at least `settleMs` after the first answer of another release than `oldRelease`: the
 * samples.
 */
export async function watchSwitch(input: {
  url: string;
  oldRelease: string | undefined;
  pages: SwitchPages;
  during: () => Promise<unknown>;
  request: (url: string) => Promise<HttpAnswer>;
  settleMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SwitchSample[]> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const settleMs = input.settleMs ?? 20_000;
  const intervalMs = input.intervalMs ?? 1_000;
  const start = now();
  const samples: SwitchSample[] = [];
  let ended: number | undefined;
  let switched: number | undefined;
  let failed = false;
  const watching = (async () => {
    for (;;) {
      const at = now() - start;
      const done =
        failed ||
        (ended !== undefined &&
          at >= ended + settleMs &&
          (switched === undefined || at >= switched + settleMs));
      if (done) return;
      const sample: SwitchSample = await input.request(input.url).then(
        (answer) => {
          const release = releaseOf(answer);
          const page = input.pages.isNew(answer.status, answer.body)
            ? "new"
            : input.pages.isOld(answer.status, answer.body)
              ? "old"
              : "other";
          return { at, ...(release ? { release } : {}), page };
        },
        () => ({ at, page: "other" as const }),
      );
      samples.push(sample);
      if (
        switched === undefined &&
        sample.release !== undefined &&
        sample.release !== input.oldRelease
      ) {
        switched = at;
      }
      await sleep(intervalMs);
    }
  })();
  try {
    await input.during();
  } catch (error) {
    failed = true;
    await watching;
    throw error;
  }
  ended = now() - start;
  await watching;
  return samples;
}

// ---------------------------------------------------------------------------------------------
// The account's inventory (SC-2702).

/** The account's inventory: each field a sorted list of one-line entries. */
export type Inventory = Record<string, string[]>;

/** An inventory and the content of `~/.cl.selector`'s files, which are never printed. */
export interface AccountInventory {
  fields: Inventory;
  selector: Record<string, string>;
  /** Each certificate's id, names and public key, for the cleanup's choice. */
  certificates: AccountCertificate[];
  keys: { id: string; publicKey: string }[];
  installed: { servername: string; certificate: string }[];
}

export interface AccountCertificate {
  id: string;
  domains: string[];
  publicKey: string;
}

/**
 * Names the agent or the panel leave in the home folder that are no objects of the run: LiteSpeed's
 * restart file, which the agent touches on every PHP switch (any of the account's users may too),
 * `~/.cache`, which cPanel's API makes (research R10), and `~/.npm`, npm's cache, which installing a
 * Node.js app's packages may make. Seen new after a run, each is an observation, and the cleanup
 * removes it.
 */
export const ACCOUNT_TRACES = [".lsphp_restart.txt|file", ".cache|dir", ".npm|dir"] as const;

/** One field that differs: the entries only before, and only after. */
export interface InventoryDifference {
  field: string;
  removed: string[];
  added: string[];
}

/** The fields of `after` that differ from `before`, with what each lost and gained. */
export function inventoryDifferences(before: Inventory, after: Inventory): InventoryDifference[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const differences: InventoryDifference[] = [];
  for (const field of fields) {
    const was = before[field] ?? [];
    const now = after[field] ?? [];
    const removed = was.filter((entry) => !now.includes(entry));
    const added = now.filter((entry) => !was.includes(entry));
    if (removed.length > 0 || added.length > 0) differences.push({ field, removed, added });
  }
  return differences;
}

/**
 * Whether the zone entry `<name>|<type>` is a TXT record AutoSSL adds to prove one of the run's
 * hostnames, `_acme-challenge.e2e-<tag>-<leg>` or `_acme-challenge.www.e2e-<tag>-<leg>` (R13), in
 * the relative form `DNS::parse_zone` gives, or with the zone's domain after it.
 */
function runChallengeRecord(entry: string, tag: string): boolean {
  const [name = "", type = ""] = entry.split("|");
  return (
    type.toUpperCase() === "TXT" &&
    new RegExp(`^_acme-challenge\\.(?:www\\.)?e2e-${tag}-[a-z0-9]+(?:\\.[a-z0-9.-]+)?$`).test(
      name.toLowerCase(),
    )
  );
}

/**
 * The inventory after the run against the one before (SC-2702): each entry of the run left
 * (`namesRun`) and each other difference is a problem; a trace of {@link ACCOUNT_TRACES} new after
 * the run is an observation, and so is a challenge record AutoSSL added to the zone for one of the
 * run's hostnames, which the pass leaves (it never edits the zone) and names for removal by hand
 * (R13). Lines name fields and entries (the caller masks them).
 */
export function inventoryProblems(
  before: Inventory,
  after: Inventory,
  tag: string,
  /**
   * The run's AutoSSL certificates and their keys ({@link runCertificates}): destroy rightly leaves
   * what OpsCrew didn't make, and the cleanup removes them, so they are observations here.
   */
  autossl: { certificates: readonly string[]; keys: readonly string[] } = {
    certificates: [],
    keys: [],
  },
): { problems: string[]; observed: string[] } {
  const problems: string[] = [];
  const observed: string[] = [];
  for (const { field, removed, added } of inventoryDifferences(before, after)) {
    for (const entry of added) {
      if (field === "home" && (ACCOUNT_TRACES as readonly string[]).includes(entry)) {
        observed.push(`the home folder has ${entry.split("|")[0]} now, which it had not before`);
      } else if (
        (field === "certificates" && autossl.certificates.includes(entry.split("|")[0] ?? "")) ||
        (field === "keys" && autossl.keys.includes(entry))
      ) {
        observed.push(
          `${field}: AutoSSL's ${entry.split("|")[0]} for the run's hostname, which destroy leaves (OpsCrew didn't make it); the cleanup removes it`,
        );
      } else if (field === "zone" && runChallengeRecord(entry, tag)) {
        observed.push(
          `zone: AutoSSL's challenge record ${entry.split("|")[0]} (TXT) of the run's hostname is left; remove it by hand in cPanel's Zone Editor`,
        );
      } else if (namesRun(entry, tag)) {
        problems.push(`${field}: the run's ${entry} is left`);
      } else if (namesOtherRun(entry, tag)) {
        observed.push(`${field}: an earlier run's ${entry} is listed again (R10)`);
      } else {
        problems.push(`${field}: ${entry} appeared`);
      }
    }
    for (const entry of removed) {
      if (namesOtherRun(entry, tag)) {
        observed.push(`${field}: an earlier run's ${entry} is no longer listed (R10)`);
      } else {
        problems.push(`${field}: ${entry} is gone`);
      }
    }
  }
  return { problems, observed };
}

/**
 * The certificates the cleanup removes (R10, R11): those new since `before`, whose id is named
 * after one of the run's hostnames (`e2e_<tag>_…`, or `www_e2e_<tag>_…`), that name such a
 * hostname, installed nowhere; those new since `before`, installed nowhere, whose every name is a
 * run hostname (`e2e-<tag>-<leg>.<domain>`, or `www.` of one) or `*.<domain>`, one at least a run
 * hostname, as AutoSSL issues `_wildcard__<domain>_…` (R13); and the keys new since `before` that
 * only those use. `installed` lists such certificates still installed, which the cleanup leaves.
 */
export function runCertificates(input: {
  now: Pick<AccountInventory, "certificates" | "keys" | "installed">;
  before: Pick<AccountInventory, "certificates" | "keys">;
  tag: string;
  /** The account domain the run's hostnames are under. */
  domain: string;
}): { certificates: string[]; keys: string[]; installed: string[] } {
  const { now, before, tag } = input;
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  const runHost = (name: string) => {
    const label = name.replace(/^www\./, "");
    if (!label.endsWith(`.${domain}`)) return false;
    const leg = label.slice(0, -domain.length - 1);
    return leg.startsWith(`e2e-${tag}-`) && !leg.includes(".");
  };
  const wildcardOfRun = (domains: readonly string[]) =>
    domains.some(runHost) && domains.every((name) => runHost(name) || name === `*.${domain}`);
  const old = new Set(before.certificates.map((certificate) => certificate.id));
  const oldKeys = new Set(before.keys.map((key) => key.id));
  const idOfRun = new RegExp(`^(www_)?e2e_${tag}_`, "i");
  const ofRun = now.certificates.filter(
    (certificate) =>
      !old.has(certificate.id) &&
      ((idOfRun.test(certificate.id) && certificate.domains.some((name) => namesRun(name, tag))) ||
        wildcardOfRun(certificate.domains)),
  );
  const installed = ofRun.filter((certificate) =>
    now.installed.some((host) => host.certificate === certificate.id),
  );
  const free = ofRun.filter((certificate) => !installed.includes(certificate));
  const keys = now.keys.filter(
    (key) =>
      !oldKeys.has(key.id) &&
      key.publicKey !== "" &&
      free.some((certificate) => certificate.publicKey === key.publicKey) &&
      !now.certificates.some(
        (certificate) => certificate.publicKey === key.publicKey && !free.includes(certificate),
      ),
  );
  return {
    certificates: free.map((certificate) => certificate.id),
    keys: keys.map((key) => key.id),
    installed: installed.map((certificate) => certificate.id),
  };
}

/**
 * The bytes to put back into a file of `~/.cl.selector` that changed during the run, or
 * `undefined` when the cleanup must leave it for a fix by hand: the file now must be the file before
 * with one block of lines added in one place, and that block must name the run.
 */
export function selectorRestore(
  before: string | undefined,
  now: string,
  tag: string,
): string | undefined {
  if (before === undefined || before === now) return undefined;
  const was = before.split("\n");
  const lines = now.split("\n");
  let head = 0;
  while (head < was.length && head < lines.length && was[head] === lines[head]) head++;
  let tail = 0;
  while (
    tail < was.length - head &&
    tail < lines.length - head &&
    was[was.length - 1 - tail] === lines[lines.length - 1 - tail]
  ) {
    tail++;
  }
  if (head + tail !== was.length) return jsonRestore(before, now, tag);
  const added = lines.slice(head, lines.length - tail);
  return added.some((line) => namesRun(line, tag)) ? before : undefined;
}

/**
 * A selector registry (`node-selector.json`, `python-selector.json`) the selector rewrote whole:
 * the bytes before when it now holds every entry it held, unchanged, and besides them only entries
 * whose key names the run (run 11 left `{}` as one app keyed by its folder).
 */
function jsonRestore(before: string, now: string, tag: string): string | undefined {
  let was: unknown;
  let is: unknown;
  try {
    was = JSON.parse(before);
    is = JSON.parse(now);
  } catch {
    return undefined;
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(was) || !isObject(is)) return undefined;
  const kept = Object.keys(was).every(
    (key) => key in is && JSON.stringify(was[key]) === JSON.stringify(is[key]),
  );
  const added = Object.keys(is).filter((key) => !(key in was));
  return kept && added.length > 0 && added.every((key) => namesRun(key, tag)) ? before : undefined;
}

/**
 * Where the files of `~/.cl.selector` place the app at `folder` (`opscrew/<app>-<env>`): each
 * distinct path after the folder they name (`/current`, `/releases/123-1`, or "" for the folder
 * itself), so a printed finding shows whether the selector kept the `current` link.
 */
export function appRootSuffixes(text: string, folder: string): string[] {
  const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(`${escaped}((?:/[A-Za-z0-9._-]+)*)`, "g"))) {
    found.add(match[1] ?? "");
  }
  return [...found].sort();
}

/**
 * The names an `.htaccess` gives the app as environment variables (`SetEnv`, `PassengerEnvVar`,
 * `SetEnvIf`'s variable), never their values.
 */
export function envNames(htaccess: string): string[] {
  const names = new Set<string>();
  for (const line of htaccess.split(/\r?\n/)) {
    const set = /^\s*(?:SetEnv|PassengerEnvVar)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(line);
    if (set?.[1] !== undefined) names.add(set[1]);
  }
  return [...names].sort();
}

/**
 * The names of the `env_vars` of the run's app in a JSON file of CloudLinux's selector, never their
 * values: only an entry whose key or `app_root` names the run counts, never another app's.
 */
export function selectorEnvNames(text: string, tag: string): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    const vars = entry.env_vars;
    const root = typeof entry.app_root === "string" ? entry.app_root : "";
    if (vars !== null && typeof vars === "object" && (namesRun(key, tag) || namesRun(root, tag))) {
      for (const name of Object.keys(vars)) names.add(name);
    }
    for (const [child, item] of Object.entries(entry)) {
      if (child !== "env_vars") visit(item, child);
    }
  };
  try {
    visit(JSON.parse(text), "");
  } catch {
    return [];
  }
  return [...names].sort();
}

/**
 * The objects of other runs (`e2e-<tag>` or `e2e_<tag>` with another tag) an inventory lists, for
 * a warning: the cleanup never touches them.
 */
export function otherRunsObjects(inventory: Inventory, tag: string): string[] {
  return Object.entries(inventory).flatMap(([field, entries]) =>
    entries.filter((entry) => namesOtherRun(entry, tag)).map((entry) => `${field}: ${entry}`),
  );
}

/**
 * Whether `entry` is named after another run than `tag`'s. cPanel lists a deleted database again
 * for a while, then stops (R10, seen again on the live pass), so such an entry may come and go.
 */
function namesOtherRun(entry: string, tag: string): boolean {
  return /e2e[-_][a-z0-9]{6}(?![a-z0-9])/i.test(entry) && !namesRun(entry, tag);
}

// ---------------------------------------------------------------------------------------------
// The account, through its API (reads, and the cleanup's removals).

const flag = z.union([z.number(), z.string()]).transform(Number);
const UapiSchema = z.union([
  z
    .object({ result: z.object({ status: flag, data: z.unknown(), errors: z.unknown() }) })
    .transform((a) => a.result),
  z.object({ status: flag, data: z.unknown(), errors: z.unknown() }),
]);
const Api2Schema = z.object({
  cpanelresult: z.object({ data: z.unknown(), error: z.string().nullish() }),
});
const list = <S extends z.ZodType>(item: S) => z.array(item).catch([]);
const text = z.union([z.string(), z.number()]).transform(String);

const DomainSchema = z.looseObject({
  domain: z.string(),
  type: z.string(),
  documentroot: z.string().nullish(),
});
/** `domains_data` without `format`, the one form that names parked domains (R13). */
const DomainsSchema = z.object({
  main_domain: DomainSchema,
  addon_domains: list(DomainSchema),
  sub_domains: list(DomainSchema),
  parked_domains: list(z.string()),
});
const DatabasesSchema = list(
  z.looseObject({ database: z.string(), users: z.array(z.string()).nullish() }),
);
const UsersSchema = list(
  z.looseObject({ user: z.string(), databases: z.array(z.string()).nullish() }),
);
const CronSchema = list(
  z.looseObject({
    minute: text.optional(),
    hour: text.optional(),
    day: text.optional(),
    month: text.optional(),
    weekday: text.optional(),
    command: z.string().optional(),
  }),
);
const SshKeysSchema = list(z.looseObject({ name: z.string(), authstatus: text.nullish() }));
const TokensSchema = list(z.looseObject({ name: z.string() }));
const FilesSchema = list(
  z.looseObject({ file: z.string(), type: z.string(), nicemode: text.nullish() }),
);
const RestrictionsSchema = z.looseObject({ prefix: z.string().nullish() });
const ZoneSchema = list(
  z.looseObject({
    type: z.string(),
    record_type: z.string().nullish(),
    dname_b64: z.string().nullish(),
  }),
);
const KeyFields = {
  id: z.string(),
  modulus: z.string().nullish(),
  ecdsa_public: z.string().nullish(),
};
const CertificatesSchema = list(
  z.looseObject({ ...KeyFields, domains: z.array(z.string()).nullish() }),
);
const KeysSchema = list(z.looseObject(KeyFields));
const InstalledSchema = list(
  z.looseObject({
    servername: z.string(),
    certificate: z.looseObject({ id: z.string() }).nullish(),
  }),
);

const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const publicKeyOf = (item: { modulus?: string | null; ecdsa_public?: string | null }) =>
  item.modulus ?? item.ecdsa_public ?? "";

/** The folders the agent and CloudLinux's selector put an app's files in, in the home folder. */
const APP_FOLDERS = ["opscrew", "nodevenv/opscrew"] as const;

/**
 * The test's own reads of the cPanel account (UAPI and API2 with the account's token), its
 * inventory, and the cleanup's removals of what the run left, through OpsCrew's connector where it
 * has the call. Errors name the call and cPanel's reason, never the token.
 */
export class CpanelAccount {
  readonly panel: CpanelPanel;
  private readonly fetch: FetchLike;

  /** `zone`: the domain whose DNS zone the inventory lists (the test domain). */
  constructor(
    private readonly access: HostingPanelAccess,
    private readonly zone: string,
    fetchImpl?: FetchLike,
  ) {
    this.fetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.panel = new CpanelPanel(access, { fetch: this.fetch });
  }

  private async send(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `cpanel ${this.access.user}:${this.access.token}`,
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`cPanel answered HTTP ${response.status}.`);
    return JSON.parse(await response.text());
  }

  /** A UAPI call's `data`; throws with cPanel's reason when it answers status 0. */
  async uapi(module: string, func: string, params: Record<string, string> = {}): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    const answer = UapiSchema.parse(
      await this.send(
        `${this.access.url}/execute/${module}/${func}${query === "" ? "" : `?${query}`}`,
      ),
    );
    if (answer.status !== 1) {
      throw new Error(`cPanel refused ${module}::${func}: ${JSON.stringify(answer.errors)}`);
    }
    return answer.data;
  }

  /** An API2 call's `data`; throws with cPanel's reason when it names an error. */
  async api2(module: string, func: string, params: Record<string, string> = {}): Promise<unknown> {
    const body = new URLSearchParams({
      cpanel_jsonapi_user: this.access.user,
      cpanel_jsonapi_apiversion: "2",
      cpanel_jsonapi_module: module,
      cpanel_jsonapi_func: func,
      ...params,
    });
    const answer = Api2Schema.parse(
      await this.send(`${this.access.url}/json-api/cpanel`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    ).cpanelresult;
    if ((answer.error ?? "") !== "")
      throw new Error(`cPanel refused ${module}::${func}: ${answer.error}`);
    return answer.data;
  }

  /** The prefix cPanel gives database and database user names (`<user>_`, cut), if it says. */
  async databasePrefix(): Promise<string | undefined> {
    const restrictions = RestrictionsSchema.parse(await this.uapi("Mysql", "get_restrictions"));
    return restrictions.prefix ?? undefined;
  }

  /** The zone's records by name and type (no values), or one line saying it can't be read. */
  private async zoneRecords(): Promise<string[]> {
    try {
      const records = ZoneSchema.parse(await this.uapi("DNS", "parse_zone", { zone: this.zone }));
      return records.flatMap((record) =>
        record.type === "record" && record.record_type !== "SOA"
          ? [
              `${Buffer.from(record.dname_b64 ?? "", "base64")
                .toString("utf8")
                .toLowerCase()}|${record.record_type}`,
            ]
          : [],
      );
    } catch {
      return ["(the zone can't be read)"];
    }
  }

  private async files(
    dir: string,
  ): Promise<{ file: string; type: string; nicemode?: string | null }[] | undefined> {
    try {
      return FilesSchema.parse(
        await this.uapi("Fileman", "list_files", {
          dir,
          types: "dir|file|link",
          include_mime: "0",
          show_hidden: "1",
        }),
      );
    } catch (error) {
      if (error instanceof Error && /no such file|does not exist/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
  }

  /** The account's domains, the parked ones (names only) too. */
  async domains(): Promise<{ domain: string; type: string; documentroot?: string | null }[]> {
    const data = DomainsSchema.parse(await this.uapi("DomainInfo", "domains_data"));
    return [
      data.main_domain,
      ...data.addon_domains,
      ...data.sub_domains,
      ...data.parked_domains.map((domain) => ({ domain, type: "parked_domain" })),
    ];
  }

  /**
   * The account's processes and entry processes against CloudLinux's limits
   * (`ResourceUsage::get_usages`), as `nproc 3/100, ep 1/20`: a Node.js app whose processes outlive
   * it uses the account's processes up (R14), so the pass logs them before and after.
   */
  async processes(): Promise<string> {
    const usages = z
      .array(
        z.object({
          id: z.string(),
          usage: z.coerce.number(),
          maximum: z.coerce.number().nullish(),
        }),
      )
      .parse(await this.uapi("ResourceUsage", "get_usages"));
    return ["lvenproc", "lveep"]
      .map((id) => {
        const usage = usages.find((entry) => entry.id === id);
        return `${id === "lvenproc" ? "nproc" : "ep"} ${usage?.usage ?? "?"}/${usage?.maximum ?? "?"}`;
      })
      .join(", ");
  }

  /**
   * The account's inventory: its domains (with their document roots), databases and their users,
   * cron lines, SSH keys (also the public ones), API token names, the home folder's top level, the
   * SHA-256 of each file in `~/.cl.selector`, what `~/opscrew` and `~/nodevenv/opscrew` hold, the
   * zone's records by name and type, and its SSL certificates, keys and installed hosts.
   */
  async inventory(): Promise<AccountInventory> {
    const domains = await this.domains();
    const databases = DatabasesSchema.parse(await this.uapi("Mysql", "list_databases"));
    const users = UsersSchema.parse(await this.uapi("Mysql", "list_users"));
    const cron = CronSchema.parse(await this.api2("Cron", "listcron"));
    const sshKeys = SshKeysSchema.parse(await this.api2("SSH", "listkeys"));
    const sshPublic = SshKeysSchema.parse(await this.api2("SSH", "listkeys", { pub: "1" }));
    const tokens = TokensSchema.parse(await this.uapi("Tokens", "list"));
    const home = (await this.files(".")) ?? [];
    const selector: Record<string, string> = {};
    for (const entry of (await this.files(".cl.selector")) ?? []) {
      if (entry.type !== "file") continue;
      const content = await this.panel.readFile(`.cl.selector/${entry.file}`);
      if (content !== undefined) selector[entry.file] = content;
    }
    const folders = await Promise.all(
      APP_FOLDERS.map(async (folder) => (await this.files(folder)) ?? []),
    );
    const zone = await this.zoneRecords();
    const certificates = CertificatesSchema.parse(await this.uapi("SSL", "list_certs"));
    const keys = KeysSchema.parse(await this.uapi("SSL", "list_keys"));
    const installed = InstalledSchema.parse(await this.uapi("SSL", "installed_hosts"));
    const sorted = (entries: string[]) => [...new Set(entries)].sort();
    return {
      fields: {
        domains: sorted(domains.map((d) => `${d.type}|${d.domain}|${d.documentroot ?? ""}`)),
        databases: sorted(databases.map((d) => `${d.database}|${sorted(d.users ?? []).join(",")}`)),
        databaseUsers: sorted(users.map((u) => `${u.user}|${sorted(u.databases ?? []).join(",")}`)),
        cron: sorted(
          cron.flatMap((line) =>
            line.command === undefined
              ? []
              : [
                  `${line.minute} ${line.hour} ${line.day} ${line.month} ${line.weekday} ${line.command}`,
                ],
          ),
        ),
        sshKeys: sorted(sshKeys.map((key) => `${key.name}|${key.authstatus ?? ""}`)),
        sshPublicKeys: sorted(sshPublic.map((key) => `${key.name}|${key.authstatus ?? ""}`)),
        tokens: sorted(tokens.map((token) => token.name)),
        home: sorted(home.map((entry) => `${entry.file}|${entry.type}`)),
        opscrewFolder: sorted((folders[0] ?? []).map((entry) => `${entry.file}|${entry.type}`)),
        nodevenvFolder: sorted((folders[1] ?? []).map((entry) => `${entry.file}|${entry.type}`)),
        zone: sorted(zone),
        selector: sorted(
          Object.entries(selector).map(([file, content]) => `${file}|${sha(content)}`),
        ),
        certificates: sorted(
          certificates.map(
            (c) => `${c.id}|${sorted((c.domains ?? []).map((d) => d.toLowerCase())).join(",")}`,
          ),
        ),
        keys: sorted(keys.map((key) => key.id)),
        installedHosts: sorted(installed.map((h) => `${h.servername}|${h.certificate?.id ?? ""}`)),
      },
      selector,
      certificates: certificates.map((c) => ({
        id: c.id,
        domains: (c.domains ?? []).map((d) => d.toLowerCase()),
        publicKey: publicKeyOf(c),
      })),
      keys: keys.map((key) => ({ id: key.id, publicKey: publicKeyOf(key) })),
      installed: installed.map((h) => ({
        servername: h.servername,
        certificate: h.certificate?.id ?? "",
      })),
    };
  }

  /**
   * Removes what the run (`tag`) left on the account, and nothing else, each removal logged (the
   * caller masks the log): its cron lines, hostnames, databases and their users, its folders in
   * `~/opscrew` and `~/nodevenv/opscrew` (then those folders when empty and new since `before`),
   * the section it added to a file of `~/.cl.selector` ({@link selectorRestore}; the file keeps its
   * mode), the traces of
   * {@link ACCOUNT_TRACES} new since `before`, and the certificates AutoSSL issued for its
   * hostnames with their keys ({@link runCertificates}). Returns what it removed and what it could
   * not.
   */
  async cleanUp(
    input: { tag: string; before: AccountInventory },
    log: (message: string) => void,
  ): Promise<{ removed: string[]; problems: string[] }> {
    const { tag, before } = input;
    const removed: string[] = [];
    const problems: string[] = [];
    const attempt = async (what: string, body: () => Promise<void>) => {
      try {
        await body();
        removed.push(what);
        log(`cleanup: removed ${what}`);
      } catch (error) {
        problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const job of (await this.panel.listCron()).filter((line) => namesRun(line.command, tag))) {
      await attempt(`the cron line ${job.schedule} ${job.command}`, () =>
        this.panel.removeCron(job.key),
      );
    }
    const domains = await this.domains();
    for (const domain of domains.filter(
      (d) => namesRun(d.domain, tag) && d.type !== "main_domain",
    )) {
      await attempt(`the hostname ${domain.domain}`, () =>
        this.panel.removeHostname(domain.domain),
      );
    }
    const databases = DatabasesSchema.parse(await this.uapi("Mysql", "list_databases"));
    for (const { database } of databases.filter((d) => namesRun(d.database, tag))) {
      await attempt(`the database ${database} and its user`, () =>
        this.panel.removeDatabase({ name: database, user: database }),
      );
    }
    const users = UsersSchema.parse(await this.uapi("Mysql", "list_users"));
    for (const { user } of users.filter((u) => namesRun(u.user, tag))) {
      await attempt(`the database user ${user}`, async () => {
        await this.uapi("Mysql", "delete_user", { name: user });
      });
    }
    const beforeHome = new Set(before.fields.home ?? []);
    for (const folder of APP_FOLDERS) {
      for (const entry of ((await this.files(folder)) ?? []).filter((e) => namesRun(e.file, tag))) {
        await attempt(`~/${folder}/${entry.file}`, () =>
          this.panel.remove(`${folder}/${entry.file}`),
        );
      }
    }
    // `nodevenv/opscrew` holds only OpsCrew's apps; the others go only when the run made them.
    for (const [folder, removable] of [
      ["nodevenv/opscrew", true],
      ["nodevenv", !beforeHome.has("nodevenv|dir")],
      ["opscrew", !beforeHome.has("opscrew|dir")],
    ] as const) {
      if (removable && (await this.files(folder))?.length === 0) {
        await attempt(`the empty ~/${folder}`, () => this.panel.remove(folder));
      }
    }
    for (const entry of (await this.files(".cl.selector")) ?? []) {
      if (entry.type !== "file") continue;
      const now = await this.panel.readFile(`.cl.selector/${entry.file}`);
      if (now === undefined || now === before.selector[entry.file]) continue;
      const restored = selectorRestore(before.selector[entry.file], now, tag);
      const mode = /^0?[0-7]{3}$/.test(entry.nicemode ?? "")
        ? Number.parseInt(entry.nicemode as string, 8)
        : undefined;
      if (restored === undefined || mode === undefined) {
        if (namesRun(now, tag)) {
          problems.push(
            `~/.cl.selector/${entry.file} changed beyond one added section of the run's, so it was left: remove the run's lines in cPanel's File Manager`,
          );
        }
        continue;
      }
      await attempt(`the run's lines in ~/.cl.selector/${entry.file}`, () =>
        this.panel.writeFile(
          `.cl.selector/${entry.file}`,
          new TextEncoder().encode(restored),
          mode,
        ),
      );
    }
    const home = (await this.files(".")) ?? [];
    for (const trace of ACCOUNT_TRACES) {
      const [name, type] = trace.split("|") as [string, string];
      if (!beforeHome.has(trace) && home.some((e) => e.file === name && e.type === type)) {
        await attempt(`~/${name}, new since the run started`, () => this.panel.remove(name));
      }
    }
    const now = await this.inventory();
    const chosen = runCertificates({ now, before, tag, domain: this.zone });
    for (const id of chosen.installed) {
      problems.push(
        `the certificate ${id} AutoSSL issued for the run is still installed; it was left`,
      );
    }
    for (const id of chosen.certificates) {
      await attempt(`the certificate ${id}`, async () => {
        await this.uapi("SSL", "delete_cert", { id });
      });
    }
    for (const id of chosen.keys) {
      await attempt(`the key ${id}`, async () => {
        await this.uapi("SSL", "delete_key", { id });
      });
    }
    return { removed, problems };
  }
}
