import type {
  Money,
  RegisteredDomain,
  RegistrationQuote,
  RegistrationRequest,
  RegistrationStatus,
} from "@opscrew/contracts";
import {
  type ErrorCode,
  isUserFacingError,
  OpsCrewError,
  PHRASE_MISMATCH,
  plural,
} from "@opscrew/core";
import { shellWord } from "../shared/apply-command";
import {
  auditDomain,
  cents,
  errorText,
  formatMoney,
  formatMoneyCode,
  providerText,
  unfinished,
} from "./common";
import { buyCommandOf, registrarDashboard } from "./links";
import { auditAutoRenew, autoRenewApproval, renewalPrice } from "./manage";
import type { ProjectFiles } from "./project";
import { markPurchase, type PurchaseRecord, removePurchaseRecord } from "./record";
import { REGISTRAR_NAMES, registrarLinks } from "./registrars";
import type { DomainSetUpResult, MaxPrice } from "./types";
import type { PurchaseContext } from "./wait";

/**
 * Error codes from `register` that mean the registrar clearly rejected the request: 401/403
 * (`CREDENTIALS_*`), a refusal with a clear answer (`PHASE_PRECONDITION`), or a request the
 * adapter refused to send (`INVALID_INPUT`). Even then the purchase record is only removed once
 * `registrationStatus` confirms there is no registration. Every other error (`PROVIDER_ERROR`: no
 * clear answer) may mean the purchase started: the record is marked `uncertain` and only the user
 * can clear it. The registrar adapters report their clear rejections with these codes.
 */
export const REJECTED_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "CREDENTIALS_MISSING",
  "CREDENTIALS_INVALID",
  "INVALID_INPUT",
  "PHASE_PRECONDITION",
]);

/** `2026-10-11 11:59 UTC` from an ISO timestamp (the text itself when it is not one). */
export function formatTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time)
    ? iso
    : `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What a purchase charges now; `exact` is false for an upper bound (Cloudflare, several years). */
export interface Charge {
  charge: Money;
  exact: boolean;
}

/** A live price, checked and ready for the `domain-purchase` approval. */
export interface Offer extends Charge {
  /** The approval's lines about the domain, its price, registration, payment and DNS, in order. */
  approvalLines(): Promise<string[]>;
  /** Right before buying: stops when the approved price no longer holds (it rose or expired). */
  recheck(): Promise<void>;
  /** The quote a registrar other than Cloudflare binds the purchase to. */
  quote?: RegistrationQuote;
}

/**
 * The domain's zone after the setup, and whether DNSSEC is in force for it (`skipped` when the zone
 * calls set no DNSSEC up: the stand-in zones of a registrar sandbox).
 */
export interface DnsSetup {
  zoneId: string;
  dnssec: boolean | "skipped";
}

/** A domain set up for the project, for the summary. */
export interface SetUp {
  files: ProjectFiles;
  hostname: string;
  dns: DnsSetup;
  info: RegisteredDomain;
  recorded: { plan: boolean; requirements: boolean };
  /** A next step about auto-renew, which the registrar's API could not change. */
  renewNext?: string;
  /** Another domain the project keeps (the user refused to replace it). */
  keptDomain?: string;
  /** The approved price, when OpsCrew bought the domain. */
  total?: Money;
  /** True when the domain was in the account already, so OpsCrew only set it up. */
  alreadyRegistered: boolean;
}

/**
 * What buying differs in between Cloudflare and the other registrars: everything else (the owned
 * check, the price bound, the typed approval, the record before the one `register` call, the wait
 * and the project files) is the same flow (`buyDomain`).
 */
export interface RegistrarFlow {
  /** Stops before any wait or approval when OpsCrew may not set up the domain already there. */
  takeOver(files: ProjectFiles): Promise<void>;
  /** The checks before the price, then the live price for `years`. */
  quote(years: number, autoRenew: boolean): Promise<Offer>;
  /** For a domain already in the account: the approval's first lines and whether to publish DS. */
  owned(): Promise<{ lines: string[]; publishDs: boolean }>;
  /** The zone and DNSSEC (and, at another registrar, the move of the DNS to Cloudflare). */
  setUp(publishDs: boolean): Promise<DnsSetup>;
  /** Audit, success line and next steps. */
  summary(result: SetUp): Promise<DomainSetUpResult>;
}

/** `on your Cloudflare account`, `in your Porkbun account`: where the registration is. */
export function registeredWhere(ctx: Pick<PurchaseContext, "registrarId">): string {
  return ctx.registrarId === "cloudflare"
    ? "on your Cloudflare account"
    : `in your ${REGISTRAR_NAMES[ctx.registrarId]} account`;
}

/** `10.44 USD`, or `up to 25.00 USD` for an upper bound. */
export function chargeCode(quote: Charge): string {
  return `${quote.exact ? "" : "up to "}${formatMoneyCode(quote.charge)}`;
}

/** The purchase approval's line when auto-renew stays off for a registration of `years`. */
export function autoRenewOffLine(years: number): string {
  return `Auto-renew: off. The domain expires after ${plural(years, "year")} unless you renew it; turn auto-renew on with \`opscrew domain auto-renew on\`.`;
}

/** The setup approval's line about the domain's Cloudflare zone (a domain already registered). */
export function zoneLine(domain: string): string {
  return `Cloudflare zone: created for ${domain} in this account if it does not exist there yet (an existing zone in this account is reused).`;
}

/** What the audit says was done: `already registered; set up`, or `bought` with the approved price. */
export function registeredSummary(result: Pick<SetUp, "alreadyRegistered" | "total">): string {
  return result.alreadyRegistered
    ? "already registered; set up"
    : `bought${result.total === undefined ? "" : ` (approved price ${formatMoney(result.total)})`}`;
}

/**
 * Stops when the limit is in another currency than the quote or below what is charged now.
 * `quotedBy` names the registrar in the refusal.
 */
export function checkMaxPrice(
  domain: string,
  quote: Charge,
  years: number,
  maxPrice: MaxPrice,
  quotedBy: string,
): void {
  const currency = quote.charge.currency;
  if (maxPrice.currency !== undefined && maxPrice.currency !== currency) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `${quotedBy} quotes ${domain} in ${currency}, but your maximum is ${formatMoneyCode({ amount: maxPrice.amount, currency: maxPrice.currency })}. Nothing was bought.`,
      {
        hint: `Give the maximum in ${currency}, for example --max-price ${(cents(quote.charge.amount) / 100).toFixed(2)}${currency}.`,
      },
    );
  }
  if (cents(quote.charge.amount) > cents(maxPrice.amount)) {
    const max = formatMoneyCode({ amount: maxPrice.amount, currency });
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `${domain} costs ${chargeCode(quote)} now (${plural(years, "year")}), more than your maximum of ${max}. Nothing was bought.`,
      {
        hint: `Raise --max-price to at least ${(cents(quote.charge.amount) / 100).toFixed(2)}${currency} if you agree to pay ${chargeCode(quote)}, or pick another name with \`opscrew domain search\`.`,
      },
    );
  }
}

/** The exact non-interactive command, with the price (and its currency) as the suggested bound. */
export function exactBuyCommand(
  ctx: Pick<PurchaseContext, "domain" | "registrarId">,
  options: { years: number; autoRenew: boolean; account?: string; quote: Charge },
): string {
  const { domain } = ctx;
  const parts = [buyCommandOf(domain, ctx.registrarId)];
  if (options.years !== 1) parts.push(`--years ${options.years}`);
  if (!options.autoRenew) parts.push("--no-auto-renew");
  if (options.account?.trim()) parts.push(`--account ${shellWord(options.account.trim())}`);
  const { charge } = options.quote;
  parts.push(
    `--confirm ${domain}`,
    `--max-price ${(cents(charge.amount) / 100).toFixed(2)}${charge.currency}`,
  );
  return parts.join(" ");
}

/** The refusal for a purchase approval that was not granted (typed domain missing or wrong). */
export function purchaseRefused(
  ctx: Pick<PurchaseContext, "domain" | "registrarId">,
  reason: string | undefined,
): OpsCrewError {
  const { domain } = ctx;
  const mismatch = reason === PHRASE_MISMATCH;
  return new OpsCrewError(
    "APPROVAL_REFUSED",
    `Buying ${domain} was not approved, so nothing was bought.`,
    {
      hint: mismatch
        ? `To buy it, run the command again and type ${domain} exactly when asked.`
        : `Run \`${buyCommandOf(domain, ctx.registrarId)}\` again when you want to buy it.`,
    },
  );
}

/** `$10.44`, or `up to $25.00` for several years at Cloudflare (an upper bound there). */
function chargeText(ctx: PurchaseContext, years: number, total: Money): string {
  const bound = ctx.registrarId === "cloudflare" && years !== 1;
  return `${bound ? "up to " : ""}${formatMoney(total)}`;
}

/**
 * Sends the purchase, exactly once. A clear rejection clears the record once the registrar
 * confirms there is no registration; a failure without a clear answer marks it `uncertain`; a
 * first answer of `pending`/`in_progress` marks it `accepted`. The approved quote and the record's
 * idempotency key go with the request when there are any (registrars other than Cloudflare).
 */
export async function sendPurchase(
  ctx: PurchaseContext,
  record: PurchaseRecord,
  quote: RegistrationQuote | undefined,
): Promise<RegistrationStatus> {
  const { deps, domain, registrarId } = ctx;
  const name = REGISTRAR_NAMES[registrarId];
  const dashboard = registrarDashboard(registrarId, deps.env);
  const command = buyCommandOf(domain, registrarId);
  const years = record.years ?? 1;
  const autoRenew = record.autoRenew ?? true;
  const where =
    registrarId === "cloudflare"
      ? `account ${ctx.account.id}`
      : `at ${name}, zone in Cloudflare account ${ctx.account.id}`;
  const summary = `${plural(years, "year")}, ${record.total === undefined ? "price unknown" : chargeText(ctx, years, record.total)}, auto-renew ${autoRenew ? "on" : "off"}, WHOIS privacy on, ${where}`;
  const request: RegistrationRequest = { domain, years, autoRenew, privacy: true };
  if (quote !== undefined) request.quote = quote;
  if (record.idempotencyKey !== undefined) request.idempotencyKey = record.idempotencyKey;
  let first: RegistrationStatus;
  try {
    first = await ctx.registrar.register(request);
  } catch (error) {
    await auditDomain(deps, "register domain", domain, `${summary}; the request failed`);
    const code = (error as { code?: unknown }).code;
    const said = errorText(deps, error);
    if (typeof code === "string" && REJECTED_CODES.has(code)) {
      let status: RegistrationStatus | undefined | null = null;
      try {
        status = await ctx.registrar.registrationStatus(domain);
      } catch {
        status = null;
      }
      if (status === undefined) {
        await removePurchaseRecord(ctx.recordFile);
        const hint = isUserFacingError(error) ? error.hint : undefined;
        throw new OpsCrewError(
          code as ErrorCode,
          `${name} did not accept the purchase of ${domain}: ${said}. Nothing was bought.`,
          {
            hint:
              hint ??
              (registrarId === "cloudflare"
                ? `Check ${dashboard} (a default contact, a payment method and a verified email address are needed), then try again.`
                : `Check ${dashboard}, then run \`${command}\` again.`),
            cause: error,
          },
        );
      }
      if (status === null) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `${name} refused the purchase of ${domain}: ${said}. OpsCrew could not confirm with ${name} that no purchase started, so it keeps its note.`,
          {
            hint: `Run \`${command}\` again later: OpsCrew checks ${name} first and never sends the purchase twice.`,
            cause: error,
          },
        );
      }
    }
    // Without the mark, the note could later be cleared as "never sent": say so loudly instead.
    const marked = await markPurchase(ctx.recordFile, record, "uncertain").then(
      () => true,
      () => false,
    );
    const unmarked = marked
      ? ""
      : ` OpsCrew could not mark its purchase note as uncertain; do not delete it until the ${name} dashboard shows what happened.`;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${name} did not confirm the purchase of ${domain}: ${said}. OpsCrew cannot tell whether the purchase started, so it will not send it again.${unmarked}`,
      {
        hint: `Check ${dashboard}, then run \`${command}\` again: if ${name} shows the purchase, OpsCrew continues it; if not, OpsCrew explains how to clear its note.`,
        cause: error,
      },
    );
  }
  await auditDomain(deps, "register domain", domain, `${summary}; ${name} reported ${first.state}`);
  if (first.state === "pending" || first.state === "in_progress") {
    // Accepted: never cleared on its own, even when the registrar lists it only hours later.
    const marked = await markPurchase(ctx.recordFile, record, "accepted").then(
      () => true,
      () => false,
    );
    if (!marked) {
      deps.reporter.warn(
        `${name} accepted the order for ${domain}, but OpsCrew could not note that in ${ctx.recordFile}. Do not delete that file until ${dashboard} shows ${domain}.`,
      );
    }
  }
  if (registrarId !== "cloudflare" && first.message) {
    const said = providerText(deps, first.message);
    if (first.state === "succeeded") deps.reporter.warn(`${said}.`);
    else deps.reporter.info(`${said}.`);
  }
  return first;
}

/** The registration details; stops when the registrar does not return them yet. */
export async function registeredDetails(ctx: PurchaseContext): Promise<RegisteredDomain> {
  const details = await ctx.registrar.getDomain(ctx.domain);
  if (details === undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${REGISTRAR_NAMES[ctx.registrarId]} does not return the details of ${ctx.domain} yet.`,
      { hint: "Wait a minute." },
    );
  }
  return { ...details, registrar: ctx.registrarId };
}

/** The domain is registered, but the setup after it failed: the next run finishes it. */
export function setupFailed(ctx: PurchaseContext, error: unknown): OpsCrewError {
  return unfinished(
    ctx.deps,
    error,
    `${ctx.domain} is registered, but OpsCrew could not finish setting it up`,
    `\`${buyCommandOf(ctx.domain, ctx.registrarId)}\` again to finish the setup; it does not buy the domain again.`,
  );
}

/** The approval line about changing auto-renew of a domain already in the account. */
export async function autoRenewLine(
  ctx: PurchaseContext,
  details: RegisteredDomain,
  on: boolean,
): Promise<string> {
  const { domain, registrar, registrarId } = ctx;
  if (registrar.capabilities.autoRenew) {
    const price = await renewalPrice(registrar, domain);
    return autoRenewApproval(domain, details, on, price, registrarId).details;
  }
  const name = REGISTRAR_NAMES[registrarId];
  return `Auto-renew: ${name}'s API cannot change it, so it stays ${details.autoRenew ? "on" : "off"}; turn it ${on ? "on" : "off"} at ${registrarLinks(registrarId, ctx.deps.env).domains}.`;
}

/**
 * Applies the auto-renew choice (approved with the purchase or the setup) where the API can;
 * otherwise returns a next step with the dashboard link when the registrar's setting differs.
 */
export async function applyAutoRenew(
  ctx: PurchaseContext,
  info: RegisteredDomain,
  wanted: boolean | undefined,
): Promise<{ info: RegisteredDomain; next?: string }> {
  if (wanted === undefined || info.autoRenew === wanted) return { info };
  const { deps, domain, registrar, registrarId } = ctx;
  if (!registrar.capabilities.autoRenew) {
    const name = REGISTRAR_NAMES[registrarId];
    return {
      info,
      next: `Turn auto-renew ${wanted ? "on" : "off"} for ${domain} at ${registrarLinks(registrarId, deps.env).domains}: ${name}'s API cannot change it, and it is ${info.autoRenew ? "on" : "off"} there now.`,
    };
  }
  const updated = await registrar.setAutoRenew(domain, wanted);
  await auditAutoRenew(deps, registrarId, domain, wanted);
  return { info: { ...updated, registrar: registrarId } };
}
