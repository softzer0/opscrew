import type {
  Currency,
  DomainCheck,
  Money,
  RegisteredDomain,
  RegistrarDnsRecord,
} from "@opscrew/contracts";
import {
  connectAfterBuyingHint,
  DOMAIN_TAKEN_REASON,
  isoDateOr,
  normalizeHostName,
} from "@opscrew/core";
import { z } from "zod";

/** GoDaddy pages users are sent to for what the API cannot do. */
export const GODADDY_DASHBOARD_URLS = {
  /** Domain Portfolio: buy, renew, auto-renew, privacy, DNSSEC and contacts per domain. */
  portfolio: "https://dcc.godaddy.com/control/portfolio",
  /** Developer portal: API access and Personal Access Tokens. */
  apiAccess: "https://developer.godaddy.com/keys",
  /** Where saved domain contact profiles are managed (Domain Portfolio settings). */
  contactProfiles: "https://dcc.godaddy.com/control/portfolio/settings",
} as const;

// Schemas use z.object (not looseObject) on purpose: unknown fields are dropped, so contact data
// GoDaddy may add to an answer (registrant summaries, consent actors) never leaves the adapter.

/** GoDaddy money: an ISO currency code and a value in the currency's minor units. */
export const MoneySchema = z.object({ currencyCode: z.string(), value: z.number() });

const FeeSchema = z.object({ type: z.string(), fee: MoneySchema });

/** Price of one registration term (`price` is the total for `period` years). */
export const TermPriceSchema = z.object({
  period: z.number().int(),
  price: MoneySchema,
  renewalPrice: MoneySchema.optional(),
  firstTermPrice: MoneySchema.optional(),
  fees: z.array(FeeSchema).optional(),
});

/** A GoDaddy error body (only the code-like fields and GoDaddy's message). */
export const ErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  details: z
    .array(z.object({ issue: z.string().optional(), field: z.string().optional() }))
    .optional(),
});
export type GoDaddyError = z.infer<typeof ErrorSchema>;

/** One availability result (`error` instead of `available` when it could not be checked). */
export const AvailabilitySchema = z.object({
  domain: z.string(),
  available: z.boolean().optional(),
  definitive: z.boolean().optional(),
  inventory: z.string().optional(),
  prices: z.array(TermPriceSchema).optional(),
  error: ErrorSchema.optional(),
});
export type GoDaddyAvailability = z.infer<typeof AvailabilitySchema>;

export const AvailabilityListSchema = z.object({ items: z.array(AvailabilitySchema) });

/** One suggestion (available by definition, prices indicative). */
export const SuggestionSchema = z.object({
  domain: z.string(),
  inventory: z.string().optional(),
  prices: z.array(TermPriceSchema).optional(),
});
export type GoDaddySuggestion = z.infer<typeof SuggestionSchema>;

export const SuggestionListSchema = z.object({ items: z.array(SuggestionSchema) });

/** Effective settings a quote will apply (contact source only; never the registrant summary). */
export const ResolvedSchema = z.object({
  profileId: z.string().optional(),
  contactSource: z.string().optional(),
  autoRenew: z.boolean().optional(),
  privacy: z.boolean().optional(),
  nameServers: z.array(z.string()).optional(),
});

export const AgreementSchema = z.object({
  agreementType: z.string(),
  title: z.string(),
  url: z.string().optional(),
});

/** A registration quote. */
export const QuoteSchema = z.object({
  domain: z.string(),
  available: z.boolean(),
  quoteToken: z.string().optional(),
  expiresAt: z.string().optional(),
  price: MoneySchema.optional(),
  renewalPrice: MoneySchema.optional(),
  period: z.number().int().optional(),
  inventory: z.string().optional(),
  fees: z.array(FeeSchema).optional(),
  requiredAgreements: z.array(AgreementSchema).optional(),
  resolved: ResolvedSchema.optional(),
});
export type GoDaddyQuote = z.infer<typeof QuoteSchema>;

/** A registration entity (contacts and consent actor dropped). */
export const RegistrationSchema = z.object({
  registrationId: z.string().optional(),
  operationId: z.string().optional(),
  domain: z.string().optional(),
  period: z.number().optional(),
  status: z.string(),
  expiresAt: z.string().optional(),
});
export type GoDaddyRegistration = z.infer<typeof RegistrationSchema>;

/** An asynchronous operation (registration, nameserver change …). */
export const OperationSchema = z.object({
  operationId: z.string(),
  type: z.string().optional(),
  domain: z.string().optional(),
  status: z.string(),
  error: ErrorSchema.optional(),
});
export type GoDaddyOperation = z.infer<typeof OperationSchema>;

/** A domain held by the account. */
export const DomainSchema = z.object({
  domain: z.string(),
  status: z.string(),
  expiresAt: z.string().optional(),
  createdAt: z.string().optional(),
  autoRenew: z.boolean().optional(),
  privacy: z.boolean().optional(),
  transferLock: z.boolean().optional(),
  nameServers: z.array(z.string()).optional(),
});
export type GoDaddyDomain = z.infer<typeof DomainSchema>;

const LinkSchema = z.object({ rel: z.string().optional(), href: z.string().optional() });

export const DomainListSchema = z.object({
  items: z.array(DomainSchema),
  links: z.array(LinkSchema).optional(),
});

/** A DNS record in a GoDaddy-hosted zone (`name` relative to the apex, `@` for the apex). */
export const DnsRecordSchema = z.object({
  name: z.string(),
  type: z.string(),
  data: z.string(),
  ttl: z.number().optional(),
  priority: z.number().optional(),
  service: z.string().optional(),
  protocol: z.string().optional(),
  port: z.number().optional(),
  weight: z.number().optional(),
  flag: z.number().optional(),
  tag: z.string().optional(),
});
export type GoDaddyDnsRecord = z.infer<typeof DnsRecordSchema>;

export const DnsRecordListSchema = z.object({
  items: z.array(DnsRecordSchema),
  totalPages: z.number().optional(),
  links: z.array(LinkSchema).optional(),
});

/** The `href` of the `next` link, if any. */
export function nextLink(links: z.infer<typeof LinkSchema>[] | undefined): string | undefined {
  return links?.find((l) => l.rel === "next")?.href;
}

const SUPPORTED_CURRENCIES: readonly Currency[] = ["USD", "EUR"];

/** The currency if OpsCrew can show it, else undefined. */
export function supportedCurrency(code: string): Currency | undefined {
  const upper = code.trim().toUpperCase();
  return SUPPORTED_CURRENCIES.find((c) => c === upper);
}

/** GoDaddy minor units (cents for USD and EUR) to {@link Money}, optionally divided. */
export function toMoney(raw: z.infer<typeof MoneySchema>, divideBy = 1): Money | undefined {
  const currency = supportedCurrency(raw.currencyCode);
  if (!currency || !Number.isFinite(raw.value) || raw.value < 0) return undefined;
  return { amount: Math.round(raw.value / divideBy) / 100, currency };
}

/** True for premium inventory (registry premium or aftermarket). */
export function isPremium(inventory: string | undefined): boolean {
  return inventory === "PREMIUM" || inventory === "REGISTRY_PREMIUM";
}

const premiumReason = (domain: string) =>
  `This is a premium domain; OpsCrew does not buy premium names through GoDaddy's API. ${connectAfterBuyingHint(`at ${GODADDY_DASHBOARD_URLS.portfolio}`, domain)}`;

const ERROR_TEXT: Record<string, string> = {
  UNSUPPORTED_TLD:
    "GoDaddy's API does not sell this extension yet (extensions with eligibility rules such as .us, .ca or .eu need the dashboard)",
  MISMATCH_FORMAT: "this is not a valid domain name",
  INVALID_DOMAIN: "this is not a valid domain name",
  QUOTE_EXPIRED: "the quote expired",
  QUOTE_CONSUMED: "the quote was already used",
  QUOTE_MISMATCH: "the request no longer matches the quote",
  DOMAIN_ALREADY_EXISTS: "the domain is already registered",
  CONSENT_PRINCIPAL_MISMATCH: "the consent does not match the account of the token",
};

/** The error codes in a GoDaddy error (its name and the issues of its details), de-duplicated. */
export function errorCodes(error: GoDaddyError | undefined): string[] {
  if (!error) return [];
  const codes = [error.name, ...(error.details ?? []).map((d) => d.issue)];
  return [...new Set(codes.filter((c): c is string => typeof c === "string" && c.trim() !== ""))];
}

/** True when any code of the error is `code` (case-insensitive). */
export function hasCode(error: GoDaddyError | undefined, code: string): boolean {
  return errorCodes(error).some((c) => c.toUpperCase() === code.toUpperCase());
}

/**
 * Plain English for a GoDaddy error. Built from its codes only (never `value` fields), and from
 * GoDaddy's message only when `withMessage` is set: answers about quotes and registrations can
 * echo contact data, which must never reach errors.
 */
export function describeError(
  error: GoDaddyError | undefined,
  status: number,
  withMessage = false,
): string {
  const codes = errorCodes(error);
  const known = codes
    .map((c) => ERROR_TEXT[c.toUpperCase()])
    .filter((t): t is string => t !== undefined);
  const parts = known.length > 0 ? [...new Set(known)] : [];
  const unknown = codes.filter((c) => ERROR_TEXT[c.toUpperCase()] === undefined);
  if (unknown.length > 0) parts.push(`GoDaddy error ${unknown.join(", ")}`);
  const message = error?.message?.trim().replace(/\.$/, "");
  if (withMessage && message && !codes.includes(message)) parts.push(message);
  return parts.length > 0 ? parts.join("; ") : `HTTP ${status}`;
}

/** The yearly first and renewal price from a term list (the 1-year term, else the shortest). */
function yearlyPrices(prices: z.infer<typeof TermPriceSchema>[]): {
  firstYear?: Money;
  renewal?: Money;
  currency?: string;
  fees: boolean;
} {
  const sorted = [...prices].filter((p) => p.period >= 1).sort((a, b) => a.period - b.period);
  const term = sorted[0];
  if (!term) return { fees: false };
  const fees = (term.fees ?? []).length > 0;
  const first =
    term.period === 1
      ? toMoney(term.price)
      : term.firstTermPrice
        ? toMoney(term.firstTermPrice)
        : toMoney(term.price, term.period);
  const renewal = term.renewalPrice ? toMoney(term.renewalPrice, term.period) : undefined;
  return {
    ...(first ? { firstYear: first } : {}),
    ...(renewal ? { renewal } : {}),
    currency: term.price.currencyCode,
    fees,
  };
}

/** Maps one availability result or suggestion to a {@link DomainCheck}. Conservative. */
export function toDomainCheck(raw: {
  domain: string;
  available?: boolean;
  inventory?: string;
  prices?: z.infer<typeof TermPriceSchema>[];
  error?: GoDaddyError;
}): DomainCheck {
  const domain = normalizeHostName(raw.domain);
  if (raw.error) {
    return {
      domain,
      registrable: false,
      reason: `GoDaddy could not check this domain: ${describeError(raw.error, 200)}.`,
    };
  }
  if (raw.available === false) {
    return {
      domain,
      registrable: false,
      reason: DOMAIN_TAKEN_REASON,
    };
  }
  const prices = yearlyPrices(raw.prices ?? []);
  if (isPremium(raw.inventory) || prices.fees) {
    return { domain, registrable: false, tier: "premium", reason: premiumReason(domain) };
  }
  const base: DomainCheck = { domain, registrable: false, tier: "standard" };
  if (prices.currency && !supportedCurrency(prices.currency)) {
    return {
      ...base,
      reason: `GoDaddy quoted this domain in ${prices.currency.toUpperCase()}, which OpsCrew cannot show yet; buy it at ${GODADDY_DASHBOARD_URLS.portfolio}.`,
    };
  }
  if (!prices.firstYear) {
    return {
      ...base,
      reason: "GoDaddy did not return a price for this domain; try again in a minute.",
    };
  }
  return {
    ...base,
    registrable: true,
    firstYear: prices.firstYear,
    ...(prices.renewal ? { renewal: prices.renewal } : {}),
  };
}

/**
 * Statuses of a domain the account holds: the `REGISTERED` lifecycle group (ACTIVE, PARKED,
 * LOCKED) and the `PENDING_TERMINAL` group (EXPIRED, PENDING_TRANSFER) of the v3 OpenAPI.
 */
const HELD = new Set(["ACTIVE", "LOCKED", "PARKED", "EXPIRED", "PENDING_TRANSFER"]);
/** Prefixes of the `TERMINAL` group: the account no longer holds the domain. */
const GONE = /^(CANCELLED|DELETED|TRANSFERRED|REPOSSESSED)/;

/**
 * How a domain's status reads for the account: `held` (registered here), `pending` (setup in
 * progress, e.g. PENDING_REGISTRATION), `gone` (cancelled, deleted, transferred out, repossessed)
 * or `unknown` (a status this adapter does not know; never treated as registered).
 */
export type DomainHolding = "held" | "pending" | "gone" | "unknown";

export function holding(raw: GoDaddyDomain): DomainHolding {
  const status = raw.status.trim().toUpperCase();
  if (HELD.has(status)) return "held";
  if (GONE.test(status)) return "gone";
  if (status.startsWith("PENDING_")) return "pending";
  return "unknown";
}

/** True only when the account holds the domain (see {@link holding}). */
export function isHeld(raw: GoDaddyDomain): boolean {
  return holding(raw) === "held";
}

/** Maps a GoDaddy domain to a {@link RegisteredDomain}. */
export function toRegisteredDomain(raw: GoDaddyDomain): RegisteredDomain {
  return {
    domain: normalizeHostName(raw.domain),
    registrar: "godaddy",
    ...(raw.createdAt ? { createdAt: isoDateOr(raw.createdAt) } : {}),
    ...(raw.expiresAt ? { expiresAt: isoDateOr(raw.expiresAt) } : {}),
    autoRenew: raw.autoRenew ?? false,
    ...(raw.transferLock !== undefined ? { locked: raw.transferLock } : {}),
    ...(raw.privacy !== undefined ? { privacy: raw.privacy } : {}),
  };
}

/** True when every nameserver is one of GoDaddy's (`*.domaincontrol.com`). */
export function usesGoDaddyDns(nameServers: readonly string[] | undefined): boolean {
  if (!nameServers || nameServers.length === 0) return false;
  return nameServers.every((ns) => /(^|\.)domaincontrol\.com$/.test(normalizeHostName(ns)));
}

const HOSTNAME_TYPES = new Set(["CNAME", "MX", "NS", "SRV"]);

/** A record name relative to the apex (`@`, `www`, or already absolute with a dot) as an FQDN. */
function absoluteName(name: string, zone: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "" || trimmed === "@") return zone;
  if (trimmed.endsWith(".")) return trimmed.slice(0, -1);
  if (trimmed === zone || trimmed.endsWith(`.${zone}`)) return trimmed;
  return `${trimmed}.${zone}`;
}

function label(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("_") ? trimmed : `_${trimmed}`;
}

/** Maps a GoDaddy DNS record to a {@link RegistrarDnsRecord} (FQDN names, SRV/CAA content). */
export function toRegistrarRecord(raw: GoDaddyDnsRecord, zone: string): RegistrarDnsRecord {
  const type = raw.type.toUpperCase();
  let name = absoluteName(raw.name, zone);
  let content = raw.data;
  if (HOSTNAME_TYPES.has(type)) {
    content = raw.data.trim() === "@" ? zone : raw.data.trim().replace(/\.$/, "");
  }
  if (type === "SRV") {
    if (raw.service && raw.protocol) {
      const prefix = `${label(raw.service)}.${label(raw.protocol)}`;
      if (!name.startsWith(`${prefix}.`)) name = `${prefix}.${name}`;
    }
    if (raw.weight !== undefined && raw.port !== undefined) {
      content = `${raw.weight} ${raw.port} ${content}`;
    }
  }
  if (type === "CAA" && raw.tag) {
    content = `${raw.flag ?? 0} ${raw.tag} "${raw.data.replace(/^"|"$/g, "")}"`;
  }
  const withPriority = (type === "MX" || type === "SRV") && raw.priority !== undefined;
  return {
    type,
    name,
    content,
    ...(raw.ttl !== undefined ? { ttl: raw.ttl } : {}),
    ...(withPriority ? { priority: raw.priority } : {}),
  };
}

/** Shows one required agreement as `TYPE: Title (url)`. */
export function formatAgreement(agreement: z.infer<typeof AgreementSchema>): string {
  const url = agreement.url ? ` (${agreement.url})` : "";
  return `${agreement.agreementType}: ${agreement.title}${url}`;
}
