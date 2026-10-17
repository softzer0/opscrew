import {
  connectAfterBuyingHint,
  NEW_PRICE_HINT,
  OpsCrewError,
  statusPageHint,
} from "@opscrew/core";
import type { NamecheapApiError } from "./xml";

/** The next step after Namecheap failed on its side. */
export const STATUS_PAGE_HINT = statusPageHint("https://www.namecheap.com/status-updates/");

/** Namecheap dashboard pages OpsCrew points users at. */
export interface NamecheapDashboardUrls {
  /** Profile → Tools → API Access: enable access and whitelist IPv4 addresses. */
  apiAccess: string;
  /** Profile → Address Book: the default address used as the registrant contact. */
  addressBook: string;
  /** Domain List: auto-renew, DNSSEC and premium purchases are managed here. */
  domainList: string;
}

/** Production dashboard pages (the address-book path is not confirmed by Namecheap's API docs). */
export const NAMECHEAP_DASHBOARD_URLS: NamecheapDashboardUrls = {
  apiAccess: "https://ap.www.namecheap.com/settings/tools/apiaccess/",
  addressBook: "https://ap.www.namecheap.com/profile/addresses",
  domainList: "https://ap.www.namecheap.com/domains/list/",
};

/** The same pages of Namecheap's sandbox (a separate account at sandbox.namecheap.com). */
export const NAMECHEAP_SANDBOX_DASHBOARD_URLS: NamecheapDashboardUrls = {
  apiAccess: "https://ap.www.sandbox.namecheap.com/settings/tools/apiaccess/",
  addressBook: "https://ap.www.sandbox.namecheap.com/profile/addresses",
  domainList: "https://ap.www.sandbox.namecheap.com/domains/list/",
};

/** Namecheap's API eligibility rule, quoted in access errors. */
export const NAMECHEAP_API_ELIGIBILITY =
  "Namecheap enables API access only for accounts with at least 20 domains, a balance of at least $50, or at least $50 spent in the last 2 years";

/**
 * Kinds of Namecheap errors OpsCrew explains. Numbers are from Namecheap's error code list
 * (https://www.namecheap.com/support/api/error-codes/, checked 2026-10-13); the balance and rate
 * limit errors have no documented number and are recognised by their text.
 */
export type NamecheapErrorKind =
  | "ip"
  | "access"
  | "balance"
  | "price"
  | "unavailable"
  | "phone"
  | "contacts"
  | "extended"
  | "tld"
  | "premium"
  | "rateLimit"
  | "notFound"
  | "notOurDns"
  | "other";

const IP_NUMBERS = new Set(["1011150", "1017150", "1017105", "1010105", "1011105"]);
const ACCESS_NUMBERS = new Set([
  "1010101",
  "1010102",
  "1011102",
  "1017101",
  "1050900",
  "1019103",
  "1016103",
  "1017103",
  "1030408",
]);

/** Kinds recognised by Namecheap's text rather than a documented number. */
export const TEXT_KINDS: ReadonlySet<NamecheapErrorKind> = new Set<NamecheapErrorKind>([
  "rateLimit",
  "ip",
  "access",
  "balance",
]);

/** Classifies one Namecheap error by its number first; undocumented cases by their text. */
export function errorKind(error: NamecheapApiError): NamecheapErrorKind {
  const n = error.number ?? "";
  const text = error.text.toLowerCase();
  if (IP_NUMBERS.has(n)) return "ip";
  if (ACCESS_NUMBERS.has(n)) return "access";
  if (n === "2515610") return "price";
  if (n === "2515623") return "premium";
  if (n === "3019166" || n === "4019166") return "unavailable";
  if (n === "2015182") return "phone";
  if (n === "2010323" || /^20103(24|25|26|27)$/.test(n)) return "contacts";
  if (n === "2011322") return "extended";
  if (n === "2030280" || n === "2011280") return "tld";
  if (n === "2030288") return "notOurDns";
  if (n === "2019166" || n === "2016166" || n === "4011103") return "notFound";
  if (/too many requests|rate limit|request limit/.test(text)) return "rateLimit";
  if (/\b(request|client) ?ip\b|whitelist/.test(text)) return "ip";
  if (/api ?key is invalid|api access/.test(text)) return "access";
  if (/insufficient (funds|balance)|not enough (funds|balance|money)|low balance/.test(text)) {
    return "balance";
  }
  return "other";
}

/** What the mapper needs to know about the call that failed. */
export interface ErrorContext {
  /** Lower-case verb phrase, for example `check shopapp.com`. */
  what: string;
  /** The ClientIp the request used, named in whitelist errors (an IP address is not a secret). */
  clientIp?: string;
  urls: NamecheapDashboardUrls;
  /** Removes secrets and contact data from Namecheap's texts before they are shown. */
  scrub: (text: string) => string;
  /** Appended to clear purchase rejections. */
  suffix?: string;
}

/** Namecheap's own explanation, scrubbed, with error numbers. */
export function describe(errors: readonly NamecheapApiError[], scrub: (t: string) => string) {
  const parts = errors.map((e) => {
    const text = scrub(e.text).replace(/\.$/, "");
    return e.number ? `${text || "error"} (error ${e.number})` : text || "an unnamed error";
  });
  return parts.join("; ") || "an error without details";
}

/**
 * The one domain a call's verb phrase names (`register shopapp.com` → `shopapp.com`), for the
 * commands a hint suggests; `<domain>` when it names none or several.
 */
function domainOf(what: string): string {
  const names = what.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi) ?? [];
  return names.length === 1 && names[0] !== undefined ? names[0].toLowerCase() : "<domain>";
}

/** Maps Namecheap's `Errors` to one plain-English {@link OpsCrewError} with a next step. */
export function namecheapError(
  errors: readonly NamecheapApiError[],
  ctx: ErrorContext,
): OpsCrewError {
  const kinds = errors.map(errorKind);
  const kind = kinds.find((k) => k !== "other") ?? "other";
  const suffix = ctx.suffix ? ` ${ctx.suffix}` : "";
  const detail = describe(errors, ctx.scrub);
  const ip = ctx.clientIp ?? "this computer's public IPv4 address";
  switch (kind) {
    case "ip":
      return new OpsCrewError(
        "CREDENTIALS_INVALID",
        `Namecheap does not accept API calls from ${ip}: the address is not on the account's API whitelist.${suffix}`,
        {
          hint: `Add ${ip} to the API whitelist at ${ctx.urls.apiAccess} (Whitelisted IPs), wait a minute and try again. If this computer reaches the internet through another IPv4 address, set NAMECHEAP_CLIENT_IP to that address.`,
        },
      );
    case "access":
      return new OpsCrewError(
        "CREDENTIALS_INVALID",
        `Namecheap refused the API credentials: the API key or user name is wrong, or API access is not enabled for this account.${suffix}`,
        {
          hint: `Turn on API access at ${ctx.urls.apiAccess} and check NAMECHEAP_API_USER, NAMECHEAP_API_KEY and NAMECHEAP_USERNAME. ${NAMECHEAP_API_ELIGIBILITY}.`,
        },
      );
    case "rateLimit":
      return new OpsCrewError(
        "PROVIDER_ERROR",
        `Namecheap's API rate limit was reached (50 calls a minute, 700 an hour, 8000 a day) while trying to ${ctx.what}.${suffix}`,
        { hint: "Wait a few minutes and try again." },
      );
    case "balance":
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `Your Namecheap account balance is too low to ${ctx.what}.${suffix}`,
        {
          hint: "Namecheap charges API purchases to the account balance. Add funds in the Namecheap dashboard (Profile → Billing → Add Funds), then run the command again.",
        },
      );
    case "price":
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap's price changed, so it did not ${ctx.what}.${suffix}`,
        { hint: NEW_PRICE_HINT },
      );
    case "premium":
    case "extended":
    case "tld":
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap cannot ${ctx.what} through its API (${detail}).${suffix}`,
        {
          hint: connectAfterBuyingHint(
            `in the Namecheap dashboard at ${ctx.urls.domainList}`,
            domainOf(ctx.what),
          ),
        },
      );
    case "unavailable":
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap could not ${ctx.what}: the domain is not available.${suffix}`,
        { hint: "Pick another name; `opscrew domain search` lists available ones." },
      );
    case "phone":
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap rejected the phone number of the default address in your address book, so it did not ${ctx.what}.${suffix}`,
        {
          hint: `Fix the phone number of the default address at ${ctx.urls.addressBook} (format +CCC.NNNNNNNNNN: country code, a dot, then the number) and run the command again.`,
        },
      );
    case "contacts":
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap says the default address in your address book is incomplete, so it did not ${ctx.what}.${suffix}`,
        {
          hint: `Complete the default address at ${ctx.urls.addressBook} and run the command again.`,
        },
      );
    case "notFound":
      return new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap could not ${ctx.what}: the domain is not in this Namecheap account.${suffix}`,
        {
          hint: `Check the domain at ${ctx.urls.domainList}, or pass the registrar that holds it with --registrar.`,
        },
      );
    default:
      return new OpsCrewError(
        "PROVIDER_ERROR",
        `Namecheap could not ${ctx.what}: ${detail}.${suffix}`,
        { hint: STATUS_PAGE_HINT },
      );
  }
}
