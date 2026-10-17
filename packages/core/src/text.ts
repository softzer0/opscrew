import type { Currency, Money } from "@opscrew/contracts";

/** Joins items as plain English: `a`, `a and b`, `a, b and c` (`""` for none). */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** `1 server`, `2 servers`, `0 servers`: the count and the word, with an `s` unless it is 1. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A host or domain name for comparison: trimmed, lower case, without a trailing dot. */
export function normalizeHostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
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

/** A provider's date as ISO 8601 in UTC, or the text as it is when it is not a date. */
export function isoDateOr(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
