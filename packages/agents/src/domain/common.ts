import {
  CLOUDFLARE_REGISTRAR_PERMISSIONS,
  CLOUDFLARE_TOKEN_PAGE,
} from "@opscrew/connector-cloudflare";
import type { DomainCheck, Money } from "@opscrew/contracts";
import {
  type ErrorCode,
  errorMessage,
  isUserFacingError,
  normalizeHostName,
  OpsCrewError,
} from "@opscrew/core";
import { FqdnSchema } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ResolvedDomainServices } from "./services";
import type { DomainAccount, MaxPrice } from "./types";

/** Where users manage registrations by hand. */
export const DASHBOARD =
  "the Cloudflare dashboard (https://dash.cloudflare.com, Domain Registration)";
/** Permissions a token needs to buy and set up domains (the connector's list, in one sentence). */
export const REGISTRAR_PERMISSIONS = CLOUDFLARE_REGISTRAR_PERMISSIONS.join("; ");
/** Permissions for the zone of a domain registered elsewhere (no Registrar access). */
const ZONE_PERMISSIONS = CLOUDFLARE_REGISTRAR_PERMISSIONS.filter(
  (p) => !p.startsWith("Account → Registrar"),
).join("; ");

/**
 * Fallback when Cloudflare's extension lookup fails or does not know the extension: extensions
 * known to need registrant data beyond the account's default contact (contact extensions), which
 * OpsCrew does not collect, so they are bought in the dashboard (research.md).
 */
const FALLBACK_CONTACT_EXTENSION_TLDS = new Set(["us", "uk", "ca"]);

/**
 * How to create a Cloudflare token with `permissions`, then `rerun`: what to do next (`Then try
 * again.`).
 */
export function cloudflareTokenHint(permissions: string, rerun: string): string {
  return `Create a token at ${CLOUDFLARE_TOKEN_PAGE} with these permissions: ${permissions}. ${rerun}`;
}

/**
 * The stop when `CLOUDFLARE_API_TOKEN` is not set for a domain command. `zoneFor` says why a
 * domain registered elsewhere needs a zone ("OpsCrew moves the DNS of x.com into a Cloudflare
 * zone"), so it asks for the zone permissions only; without it, for a token that can buy domains.
 */
export function domainTokenMissing(zoneFor?: string): OpsCrewError {
  return new OpsCrewError(
    "CREDENTIALS_MISSING",
    zoneFor === undefined
      ? "No Cloudflare API token found. Set CLOUDFLARE_API_TOKEN to a token that can buy domains."
      : `No Cloudflare API token found. ${zoneFor}. Set CLOUDFLARE_API_TOKEN to a token that can create zones and edit their DNS.`,
    {
      hint: cloudflareTokenHint(
        zoneFor === undefined ? REGISTRAR_PERMISSIONS : ZONE_PERMISSIONS,
        "Then try again; nothing was changed.",
      ),
    },
  );
}

/**
 * `CLOUDFLARE_API_TOKEN`, registered with the redactor; stops when it is not set (see
 * {@link domainTokenMissing} for `zoneFor`).
 */
export function requireCloudflareToken(deps: PhaseDeps, zoneFor?: string): string {
  const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw domainTokenMissing(zoneFor);
  deps.redactor.addLiteral(token, "cloudflare-token");
  return token;
}

const IDN_REASON =
  "internationalized names (letters outside a to z) cannot be bought through the API; buy it in the Cloudflare dashboard";

/** Plain reason when the name is internationalized (non-ASCII or punycode `xn--` labels). */
function idnReason(name: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is "anything not ASCII"
  if (/[^\x00-\x7f]/.test(name)) return IDN_REASON;
  return name.split(".").some((label) => label.startsWith("xn--")) ? IDN_REASON : undefined;
}

/** The extension of a domain without the dot (`com` for `shopapp.com`, `uk` for `a.co.uk`). */
export function tldOf(domain: string): string {
  return domain.split(".").at(-1) ?? "";
}

/** Plain reason for an extension that needs registrant data OpsCrew does not collect. */
export function contactExtensionReason(tld: string): string {
  return `.${tld} needs extra registrant details that OpsCrew does not collect, so buy it in the Cloudflare dashboard`;
}

/**
 * Whether each extension needs registrant contact extensions, from Cloudflare's extension lookup.
 * When a lookup fails or Cloudflare does not know the extension, the small fallback list decides.
 */
export async function contactExtensionsNeeded(
  services: Pick<ResolvedDomainServices, "extension">,
  accountId: string,
  tlds: readonly string[],
): Promise<Map<string, boolean>> {
  const unique = [...new Set(tlds)];
  const answers = await Promise.all(
    unique.map(async (tld) => {
      try {
        const extension = await services.extension(accountId, tld);
        if (extension !== undefined) return extension.contactExtensionsRequired;
      } catch {
        // fall back to the known list below
      }
      return FALLBACK_CONTACT_EXTENSION_TLDS.has(tld);
    }),
  );
  return new Map(unique.map((tld, i) => [tld, answers[i] ?? true]));
}

/**
 * A host or domain name, lower case and without a trailing dot; stops when it is not one.
 * `example` is the name the hint suggests.
 */
export function parseHostName(input: string, example = "shopapp.com"): string {
  const name = normalizeHostName(input);
  if (!FqdnSchema.safeParse(name).success) {
    throw new OpsCrewError("INVALID_INPUT", `"${input.trim()}" is not a valid domain name.`, {
      hint: `Give the full name with its extension, for example ${example} (no https:// and no path).`,
    });
  }
  return name;
}

/** Lower-case, validated domain name to buy; rejects internationalized names. */
export function parseDomainName(input: string): string {
  const idn = idnReason(normalizeHostName(input));
  if (idn !== undefined) {
    throw new OpsCrewError("INVALID_INPUT", `OpsCrew cannot buy "${input.trim()}": ${idn}.`, {
      hint: "Pick a name with letters a to z, digits and hyphens, for example shopapp.com.",
    });
  }
  return parseHostName(input);
}

/** Lower-case search text: a keyword or a domain name. */
export function parseQuery(input: string): string {
  const query = input.trim().toLowerCase();
  if (idnReason(query) !== undefined) {
    throw new OpsCrewError("INVALID_INPUT", `OpsCrew cannot search for "${input.trim()}".`, {
      hint: `Use letters a to z, digits and hyphens; ${IDN_REASON}.`,
    });
  }
  if (!/^[a-z0-9][a-z0-9 .-]{0,99}$/.test(query)) {
    throw new OpsCrewError("INVALID_INPUT", `"${input.trim()}" is not a name OpsCrew can search.`, {
      hint: "Search for a word or a domain, for example `opscrew domain search shopapp`.",
    });
  }
  return query;
}

/** True when `query` is a full domain name (search checks it first). */
export function isDomainName(query: string): boolean {
  return idnReason(query) === undefined && FqdnSchema.safeParse(query).success;
}

/** Registration years: a whole number from 1 to 10. */
export function parseYears(years: number | undefined): number {
  const value = years ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The number of years must be a whole number from 1 to 10.",
      {
        hint: "For example `--years 1`.",
      },
    );
  }
  return value;
}

/** A positive price bound with an optional currency, or undefined. */
export function parseMaxPrice(maxPrice: number | MaxPrice | undefined): MaxPrice | undefined {
  if (maxPrice === undefined) return undefined;
  const bound = typeof maxPrice === "number" ? { amount: maxPrice } : maxPrice;
  const hint =
    "For example `--max-price 12.50` or `--max-price 12.50USD` (in the currency Cloudflare quotes, usually USD).";
  if (!Number.isFinite(bound.amount) || bound.amount <= 0) {
    throw new OpsCrewError("INVALID_INPUT", "The maximum price must be a positive amount.", {
      hint,
    });
  }
  if (bound.currency === undefined) return { amount: bound.amount };
  const currency = String(bound.currency).trim().toUpperCase();
  if (currency !== "USD" && currency !== "EUR") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew cannot compare prices in "${String(bound.currency)}"; use USD or EUR.`,
      { hint },
    );
  }
  return { amount: bound.amount, currency };
}

/**
 * The account to use: the one the token sees, or the one named by id (or exact name).
 * `accountOption` names how the caller passes an account in the hints (default `--account`; the
 * MCP tool passes its own input name).
 */
export function resolveAccount(
  accounts: readonly DomainAccount[],
  requested: string | undefined,
  accountOption = "--account",
): DomainAccount {
  const wanted = requested?.trim();
  if (accounts.length === 0) {
    throw new OpsCrewError("CREDENTIALS_INVALID", "This Cloudflare token cannot see any account.", {
      hint: cloudflareTokenHint(REGISTRAR_PERMISSIONS, "Then try again."),
    });
  }
  if (wanted) {
    const byName = accounts.filter((a) => a.name.toLowerCase() === wanted.toLowerCase());
    const match =
      accounts.find((a) => a.id === wanted) ?? (byName.length === 1 ? byName[0] : undefined);
    if (match === undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `This Cloudflare token cannot use the account "${wanted}". It can use ${listAccounts(accounts)}.`,
        { hint: `Pass one of these account ids with ${accountOption}.` },
      );
    }
    return match;
  }
  const [only] = accounts;
  if (accounts.length === 1 && only !== undefined) return only;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `This Cloudflare token can use ${accounts.length} accounts: ${listAccounts(accounts)}. OpsCrew needs to know which one the domain belongs to.`,
    { hint: `Pass the account id with ${accountOption}, for example ${only?.id ?? "<id>"}.` },
  );
}

function listAccounts(accounts: readonly DomainAccount[]): string {
  return accounts.map((a) => `${a.name} (${a.id})`).join(", ");
}

/** Amount in whole cents, so prices compare without floating-point surprises. */
export function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** `$10.44`, `€9.00`. */
export function formatMoney(money: Money): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency }).format(
    money.amount,
  );
}

/** `10.44 USD`: the amount with its currency code, for refusals and price limits. */
export function formatMoneyCode(money: Money): string {
  return `${money.amount.toFixed(2)} ${money.currency}`;
}

/** `2027-10-13` from an ISO timestamp, or the fallback. */
export function formatDate(iso: string | undefined, fallback = "an unknown date"): string {
  const date = toIsoDateTime(iso);
  return date === undefined ? fallback : date.slice(0, 10);
}

/** A canonical ISO timestamp (`…Z`) the plan schema accepts, or undefined. */
export function toIsoDateTime(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\+\d[\d .()-]{6,}\d/g;

/**
 * Registrar text made safe to show: redacted (token) and without contact data (email addresses
 * and phone numbers), trimmed and without a trailing period.
 */
export function providerText(deps: PhaseDeps, text: string): string {
  return deps.redactor
    .redact(text)
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .trim()
    .replace(/\.+$/, "");
}

/**
 * Audits a registrar or zone call: what, on which domain, and a short detail (prices, states,
 * dates). Never contact data or registrar messages.
 */
export async function auditDomain(
  deps: PhaseDeps,
  action: string,
  domain: string,
  detail: string,
): Promise<void> {
  await deps.audit.append({
    at: deps.clock.now().toISOString(),
    kind: "provider-call",
    actor: "opscrew",
    action,
    target: domain,
    detail,
  });
}

/** The message of any thrown value, made safe to show. */
export function errorText(deps: PhaseDeps, error: unknown): string {
  return providerText(deps, errorMessage(error));
}

/**
 * The stop when a step after an approval failed: `what` could not be finished (with the cause's
 * message, made safe to show), and running the command again continues (`rerun`, after "Run").
 * Keeps the cause's code and puts its hint first.
 */
export function unfinished(
  deps: PhaseDeps,
  error: unknown,
  what: string,
  rerun: string,
): OpsCrewError {
  const code: ErrorCode = isUserFacingError(error) ? (error.code as ErrorCode) : "INTERNAL";
  const hint = isUserFacingError(error) && error.hint ? `${error.hint.trim()} Then run` : "Run";
  return new OpsCrewError(code, `${what}: ${errorText(deps, error)}.`, {
    hint: `${hint} ${rerun}`,
    cause: error,
  });
}

/**
 * A registrar's check made consistent for display and buying: premium names, missing prices and
 * internationalized names are not registrable here, each with a plain reason naming `registrar`.
 * Contact extensions are decided separately (`contactExtensionsNeeded`), because that needs a
 * lookup.
 */
export function normaliseCheck(check: DomainCheck, registrar = "Cloudflare"): DomainCheck {
  const domain = normalizeHostName(check.domain);
  const blocked =
    idnReason(domain) ??
    (check.registrable && check.tier === "premium"
      ? `premium name; ${registrar} sells premium names only in its dashboard`
      : undefined) ??
    (check.registrable && check.firstYear === undefined
      ? `${registrar} did not return a price for it`
      : undefined);
  if (blocked !== undefined) return { ...check, domain, registrable: false, reason: blocked };
  if (!check.registrable) {
    return { ...check, domain, reason: check.reason ?? "not available to buy through the API" };
  }
  return { ...check, domain };
}
