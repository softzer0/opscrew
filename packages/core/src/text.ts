import type { Currency, Money } from "@opscrew/contracts";
import { OpsCrewError } from "./errors";

/** Joins items as plain English: `a`, `a and b`, `a, b and c` (`""` for none). */
export function listText(items: readonly string[]): string {
  return joinText(items, "and");
}

/** Joins alternatives as plain English: `a`, `a or b`, `a, b or c` (`""` for none). */
export function orText(items: readonly string[]): string {
  return joinText(items, "or");
}

function joinText(items: readonly string[], word: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`;
}

/** `1 server`, `2 servers`, `0 servers`: the count and the word, with an `s` unless it is 1. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A host or domain name for comparison: trimmed, lower case, without a trailing dot. */
export function normalizeHostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * `name` normalized ({@link normalizeHostName}) when it is a hostname of two labels or more
 * (`app.example.com`).
 * @throws OpsCrewError `INVALID_INPUT` when it isn't one.
 */
export function checkHostName(name: string): string {
  const host = normalizeHostName(name);
  if (!HOST_NAME.test(host)) {
    throw new OpsCrewError("INVALID_INPUT", `"${name}" isn't a hostname.`, {
      hint: "Use a name such as app.example.com.",
    });
  }
  return host;
}

/** The longest of `domains` that `name` sits under (compared normalized), as `domains` has it. */
export function parentDomain(name: string, domains: readonly string[]): string | undefined {
  const host = normalizeHostName(name);
  return domains
    .filter((domain) => host.endsWith(`.${normalizeHostName(domain)}`))
    .sort((a, b) => b.length - a.length)[0];
}

/** Whether a certificate for `names` covers `host`: one of them, or a wildcard of one label. */
export function certificateCoversHost(host: string, names: readonly string[]): boolean {
  const wanted = normalizeHostName(host);
  return names.some((raw) => {
    const name = normalizeHostName(raw);
    if (name === wanted) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1);
    return wanted.endsWith(suffix) && !wanted.slice(0, -suffix.length).includes(".");
  });
}

/**
 * A file mode as four octal digits, `0600`.
 * @throws OpsCrewError `INVALID_INPUT` for anything but a whole number from 0 to 0o777.
 */
export function octalMode(mode: number): string {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new OpsCrewError("INVALID_INPUT", `${mode} isn't a file mode.`, {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  return mode.toString(8).padStart(4, "0");
}

/**
 * A wait or timeout in words: `6 hours` for a whole number of hours from two hours on, `15
 * minutes` for a whole number of minutes, otherwise whole seconds (`90 seconds`).
 */
export function durationText(ms: number): string {
  if (ms >= 2 * 3_600_000 && ms % 3_600_000 === 0) return plural(ms / 3_600_000, "hour");
  if (ms >= 60_000 && ms % 60_000 === 0) return plural(ms / 60_000, "minute");
  return plural(Math.round(ms / 1000), "second");
}

/**
 * `incl. VAT` or `excl. VAT` for euro prices; `incl. tax` or `excl. tax` for dollar prices
 * (DigitalOcean's USD prices exclude sales tax, which is not VAT).
 */
export function taxLabel(currency: Currency, includesVat: boolean): string {
  return `${includesVat ? "incl." : "excl."} ${currency === "EUR" ? "VAT" : "tax"}`;
}

/** `€6.09` or `$6.70`: the currency's symbol and the amount with two decimals. */
export function formatMoney(money: Money): string {
  return `${money.currency === "EUR" ? "€" : "$"}${money.amount.toFixed(2)}`;
}

/** `text` with its first character in lower case, to continue a sentence with it. */
export function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** `text` with its first character in upper case, to start a sentence with it. */
export function upperFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** `text` with every regular expression metacharacter escaped, so a pattern matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A provider's date as ISO 8601 in UTC, or the text as it is when it is not a date. */
export function isoDateOr(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
