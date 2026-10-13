import { CLOUDFLARE_TOKEN_PERMISSIONS } from "@opscrew/connector-cloudflare";
import type {
  Money,
  RegisteredDomain,
  RegistrationQuote,
  RegistrationRequest,
  RegistrationStatus,
} from "@opscrew/contracts";
import { type ErrorCode, isUserFacingError, OpsCrewError } from "@opscrew/core";
import {
  auditDomain,
  cents,
  errorText,
  formatMoney,
  formatMoneyCode,
  providerText,
  TOKEN_PAGE,
  yearsText,
} from "./common";
import { buyCommandOf, registrarDashboard } from "./links";
import { isDeployed, type ProjectChanges, type ProjectFiles } from "./project";
import {
  markPurchaseAccepted,
  markPurchaseUncertain,
  type PurchaseRecord,
  removePurchaseRecord,
} from "./record";
import { REGISTRAR_NAMES } from "./registrars";
import type { MaxPrice } from "./types";
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

/** `10.44 USD`, or `up to 25.00 USD` for an upper bound. */
export function chargeCode(quote: Charge): string {
  return `${quote.exact ? "" : "up to "}${formatMoneyCode(quote.charge)}`;
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
  quotedBy = "Cloudflare",
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
      `${domain} costs ${chargeCode(quote)} now (${yearsText(years)}), more than your maximum of ${max}. Nothing was bought.`,
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
  if (options.account?.trim()) parts.push(`--account ${options.account.trim()}`);
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
  const mismatch = reason === "confirmation phrase did not match";
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
 * first answer of `pending`/`in_progress` marks it `accepted`. Other registrars than Cloudflare get
 * the approved quote and the record's idempotency key.
 */
export async function sendPurchase(
  ctx: PurchaseContext,
  record: PurchaseRecord,
  quote?: RegistrationQuote,
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
  const summary = `${yearsText(years)}, ${record.total === undefined ? "price unknown" : chargeText(ctx, years, record.total)}, auto-renew ${autoRenew ? "on" : "off"}, WHOIS privacy on, ${where}`;
  const request: RegistrationRequest = { domain, years, autoRenew, privacy: true };
  if (registrarId !== "cloudflare") {
    if (quote !== undefined) request.quote = quote;
    if (record.idempotencyKey !== undefined) request.idempotencyKey = record.idempotencyKey;
  }
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
    const marked = await markPurchaseUncertain(ctx.recordFile, record).then(
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
    const marked = await markPurchaseAccepted(ctx.recordFile, record).then(
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
  return details;
}

/** The domain is registered, but the setup after it failed: the next run finishes it. */
export function setupFailed(ctx: PurchaseContext, error: unknown): OpsCrewError {
  const { deps, domain } = ctx;
  const code: ErrorCode = isUserFacingError(error) ? (error.code as ErrorCode) : "INTERNAL";
  const hint = isUserFacingError(error) && error.hint ? `${error.hint.trim()} Then run` : "Run";
  return new OpsCrewError(
    code,
    `${domain} is registered, but OpsCrew could not finish setting it up: ${providerText(deps, errorText(deps, error))}.`,
    {
      hint: `${hint} \`${buyCommandOf(domain, ctx.registrarId)}\` again to finish the setup; it does not buy the domain again.`,
      cause: error,
    },
  );
}

/** Asks before the bought domain replaces another one in the project files. */
export async function approveDomainSwitch(
  ctx: PurchaseContext,
  files: ProjectFiles,
  changes: ProjectChanges,
): Promise<boolean> {
  const { deps, domain } = ctx;
  const current = changes.replaces ?? "";
  const file = files.plan !== undefined ? "opscrew/plan.yaml" : "opscrew/requirements.yaml";
  const decision = await deps.approvals.request({
    kind: "repo-write",
    title: `Use ${domain} instead of ${current} in ${file}`,
    details: [
      `OpsCrew bought ${domain}, but the project serves the app at ${current}.`,
      ...changes.lines,
      `The DNS records of ${current} stay until \`opscrew dns\` or \`opscrew provision\` updates them.`,
      `Refuse to keep ${current}; ${domain} stays bought and you can switch later with \`opscrew dns --domain ${domain}\`.`,
    ].join("\n"),
  });
  return decision.approved;
}

/** The project's next step after the domain is set up (from the project files). */
export function projectNextStep(
  files: ProjectFiles,
  domain: string,
  hostname: string,
  keptDomain: string | undefined,
): string {
  if (keptDomain !== undefined) {
    return `To serve the app at ${domain} later, run \`opscrew dns --domain ${domain}\`. It shows the change and asks before applying it.`;
  }
  if (isDeployed(files.plan)) {
    return `Run \`opscrew dns\` to point ${hostname} at your server. It shows the change and asks before applying it.`;
  }
  if (files.plan !== undefined) {
    return `Run \`opscrew provision\` to deploy the app at https://${hostname}.`;
  }
  if (files.requirements !== undefined) {
    return `Run \`opscrew design\` to plan the deployment for ${hostname}.`;
  }
  return `Run \`opscrew interview\` and give ${domain} as the domain, then \`opscrew design\`.`;
}

/**
 * A token limited to the zones that existed before does not cover this (possibly new) zone; said
 * within the project's next step, before the user runs it.
 */
export function zoneTokenNote(domain: string): string {
  return `If your Cloudflare token is limited to specific zones, first add the zone ${domain} to it at ${TOKEN_PAGE} (or set it to all zones of the account): \`opscrew dns\` and \`opscrew provision\` need the token's zone permissions (${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")}) on ${domain} too.`;
}
