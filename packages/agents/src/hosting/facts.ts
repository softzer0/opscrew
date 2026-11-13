/**
 * What design reads about a hosting account (feature 027, FR-2704, FR-2708): the panel's facts,
 * read-only, and the web server from the `Server` header of the first of its domains that names one.
 * Nothing on the account changes here.
 */
import type { FetchLike, HostingFacts, HostingPanel } from "@opscrew/contracts";
import { listText } from "@opscrew/core";
import { PANEL_NAMES } from "./panels";

/** The account as design sees it. */
export interface HostingAccount {
  facts: HostingFacts;
  /** The account's main domain. */
  mainDomain?: string;
  /** The web server a domain's `Server` header names (`LiteSpeed`, `Apache`, `nginx`). */
  webServer?: string;
  /** The domain whose `Server` header named `webServer`. */
  webServerDomain?: string;
}

/** The web servers a hosting account runs, as their `Server` header names them. */
const WEB_SERVERS: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /litespeed/i, name: "LiteSpeed" },
  { pattern: /apache/i, name: "Apache" },
  { pattern: /nginx/i, name: "nginx" },
];

/** How long a domain may take to answer. */
const ANSWER_TIMEOUT_MS = 10_000;

/**
 * The web server `domain` answers with, from its `Server` header over HTTPS, else HTTP; `undefined`
 * when it doesn't answer or its header names no web server (hidden, or a CDN's in front).
 */
export async function webServerOf(domain: string, fetch: FetchLike): Promise<string | undefined> {
  for (const scheme of ["https", "http"]) {
    let server: string | null;
    try {
      const response = await fetch(`${scheme}://${domain}/`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
      });
      await response.body?.cancel();
      server = response.headers.get("server");
    } catch {
      continue;
    }
    return server === null
      ? undefined
      : WEB_SERVERS.find((entry) => entry.pattern.test(server))?.name;
  }
  return undefined;
}

/** The order domains are asked in (R13: a main domain may not resolve), and how many at most. */
const ASK_ORDER = ["main", "addon", "parked", "subdomain"] as const;
const MAX_ASKED = 5;

/**
 * The account's facts (`inspect()`) and the web server the first of its domains answers with: the
 * main domain, then its addon, parked and subdomains, at most five in all.
 */
export async function readHostingAccount(
  panel: HostingPanel,
  fetch: FetchLike,
): Promise<HostingAccount> {
  const facts = await panel.inspect();
  const mainDomain = facts.domains.find((domain) => domain.kind === "main")?.name;
  const asked = ASK_ORDER.flatMap((kind) =>
    facts.domains.filter((domain) => domain.kind === kind).map((domain) => domain.name),
  ).slice(0, MAX_ASKED);
  for (const domain of asked) {
    const webServer = await webServerOf(domain, fetch);
    if (webServer !== undefined) {
      return {
        facts,
        ...(mainDomain === undefined ? {} : { mainDomain }),
        webServer,
        webServerDomain: domain,
      };
    }
  }
  return { facts, ...(mainDomain === undefined ? {} : { mainDomain }) };
}

/** The disk the account has left in MB, or `undefined` when the panel gives no limit. */
export function quotaLeftMb(facts: Pick<HostingFacts, "quota">): number | undefined {
  const { quota } = facts;
  if (quota?.limitMb === undefined) return undefined;
  return Math.max(0, quota.limitMb - quota.usedMb);
}

const ENGINE_NAMES = { mariadb: "MariaDB", mysql: "MySQL", postgres: "PostgreSQL" } as const;
const SELECTOR_NAMES = { nodejs: "Node.js", python: "Python" } as const;

const mb = (value: number) => `${value.toLocaleString("en-US")} MB`;

/**
 * What design says of the account: the panel, the web server and where it was read, the database
 * engines and their name prefix, the disk left and the app slots left.
 */
export function hostingAccountLines(account: HostingAccount): string[] {
  const { facts, webServer, webServerDomain } = account;
  const panel = `${PANEL_NAMES[facts.panel]}${facts.panelVersion === undefined ? "" : ` ${facts.panelVersion}`}`;
  const server =
    webServer === undefined
      ? "the account's domains don't name it"
      : `${webServer}, from ${webServerDomain}'s Server header`;
  const { engines, prefix } = facts.databases;
  const databases =
    engines.length === 0
      ? "none"
      : `${listText(engines.map((engine) => ENGINE_NAMES[engine]))}${prefix === undefined ? "" : `, every name starting with ${prefix}`}`;
  const left = quotaLeftMb(facts);
  const disk =
    facts.quota === undefined
      ? "the panel doesn't say how much is left"
      : left === undefined || facts.quota.limitMb === undefined
        ? `no limit (${mb(facts.quota.usedMb)} used)`
        : `${mb(left)} left of ${mb(facts.quota.limitMb)}`;
  const { selectors, slotsLeft } = facts.apps;
  const apps =
    selectors.length === 0
      ? "the panel runs no Node.js or Python apps"
      : `${listText(selectors.map((selector) => SELECTOR_NAMES[selector]))} through the panel, ${slotsLeft === undefined ? "with no limit given" : `${slotsLeft} ${slotsLeft === 1 ? "slot" : "slots"} left`}`;
  return [
    `The account: ${panel}. Web server: ${server}.`,
    `Databases: ${databases}. Disk: ${disk}. Apps: ${apps}.`,
  ];
}
