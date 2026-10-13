import { CLOUDFLARE_TOKEN_PERMISSIONS } from "@opscrew/connector-cloudflare";
import type { Money, RegisteredDomain, RegistrationStatus } from "@opscrew/contracts";
import { type ErrorCode, isUserFacingError, OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { requireNoMoveInProgress } from "../provision/guard";
import {
  auditDomain,
  cents,
  contactExtensionReason,
  contactExtensionsNeeded,
  DASHBOARD,
  errorText,
  formatDate,
  formatMoney,
  formatMoneyCode,
  normaliseCheck,
  parseDomainName,
  parseMaxPrice,
  parseYears,
  providerText,
  REGISTRAR_PERMISSIONS,
  requireCloudflareToken,
  resolveAccount,
  TOKEN_PAGE,
  tldOf,
  yearsText,
} from "./common";
import { autoRenewApproval, renewalPrice } from "./manage";
import {
  isDeployed,
  type ProjectChanges,
  type ProjectFiles,
  projectChanges,
  readProjectFiles,
  recordDomain,
} from "./project";
import {
  createPurchaseRecord,
  markPurchaseUncertain,
  otherPurchaseInProgress,
  type PurchaseRecord,
  purchaseRecordPath,
  readPurchaseRecord,
  removePurchaseRecord,
  UNSENT_PURCHASE_AGE_MS,
} from "./record";
import { type ResolvedDomainServices, resolveDomainServices } from "./services";
import type { BuyDomainOptions, BuyDomainResult, DomainAccount, MaxPrice } from "./types";
import { type PurchaseContext, waitForRegistration } from "./wait";

/**
 * The live price of a purchase. `charge` is what is charged now: the first-year price for one
 * year; for several years the upper bound years × max(first year, renewal), until Cloudflare's
 * multi-year pricing is confirmed live (`exact` is then false).
 */
interface Quote {
  firstYear: Money;
  renewal: Money;
  charge: Money;
  exact: boolean;
}

/**
 * Error codes from `register` that mean the registrar clearly rejected the request: 401/403
 * (`CREDENTIALS_*`), a Cloudflare error envelope with another 4xx (`PHASE_PRECONDITION`), or a
 * request the adapter refused to send (`INVALID_INPUT`). Even then the purchase record is only
 * removed once `registrationStatus` confirms there is no registration. Every other error
 * (`PROVIDER_ERROR`: no clear answer) may mean the purchase started: the record is marked
 * `uncertain` and only the user can clear it.
 */
const REJECTED_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "CREDENTIALS_MISSING",
  "CREDENTIALS_INVALID",
  "INVALID_INPUT",
  "PHASE_PRECONDITION",
]);

/**
 * `opscrew domain buy`: buys a domain through the user's Cloudflare account and sets it up.
 *
 * Safety (constitution I): a live price check, an optional price bound (`maxPrice`, required in
 * non-interactive runs), a `domain-purchase` approval with the price and the typed domain name,
 * a second live check right before buying (stops when the price rose), then exactly one
 * `register` call. A purchase record written before `register`, plus the registration status
 * checked before any purchase, make reruns continue an interrupted purchase instead of buying
 * again; the record is never cleared on a guess (see `continueRecorded`). Afterwards: the zone
 * (created in the account, or reused), DNSSEC (unless already on), the auto-renew choice, and the
 * domain recorded in `opscrew/requirements.yaml` and `opscrew/plan.yaml` (another domain there is
 * only replaced after a `repo-write` approval).
 *
 * A domain the account already has is never bought; setting it up changes nothing before a
 * `domain-settings` approval that lists every change.
 */
export async function buyDomain(
  deps: PhaseDeps,
  options: BuyDomainOptions,
): Promise<BuyDomainResult> {
  const domain = parseDomainName(options.domain);
  const years = parseYears(options.years);
  const maxPrice = parseMaxPrice(options.maxPrice);
  requireCloudflareToken(deps);
  const services = resolveDomainServices(deps, options.services);
  // Read (and validate) the project files before anything costs money.
  const files = await readProjectFiles(deps);
  if (files.plan !== undefined) requireNoMoveInProgress(files.plan);

  const recordFile = purchaseRecordPath(deps.paths);
  const record = await readPurchaseRecord(recordFile);
  if (options.forgetPendingPurchase === true && record === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has no unfinished domain purchase to forget.",
      { hint: `Run \`opscrew domain buy ${domain}\` without --forget-pending-purchase.` },
    );
  }
  const accounts = await services.accounts();
  if (record !== undefined && options.forgetPendingPurchase === true) {
    // Forgetting ends the run: buying is a separate run with its own checks and approval.
    await forgetPurchase(deps, services, accounts, record, recordFile);
    return {
      outcome: "forgotten",
      forgotten: record.domain,
      next: [
        `Run \`opscrew domain buy ${domain}\` (without --forget-pending-purchase) to buy ${domain}; OpsCrew checks Cloudflare, shows the price and asks before buying.`,
      ],
    };
  }
  if (record !== undefined && record.domain !== domain) {
    throw otherPurchaseInProgress(record, domain);
  }

  const account =
    record === undefined
      ? resolveAccount(accounts, options.account)
      : recordedAccount(accounts, record, options.account);
  const ctx: PurchaseContext = {
    deps,
    services,
    registrar: services.registrar(account.id),
    account,
    domain,
    recordFile,
  };
  if (record !== undefined) return continueRecorded(ctx, record, options.autoRenew);

  const existing = await registrarRead(ctx, () => ctx.registrar.registrationStatus(domain));
  const owned =
    existing === undefined
      ? await registrarRead(ctx, () => ctx.registrar.getDomain(domain))
      : undefined;
  if (existing !== undefined || owned !== undefined) {
    // Already on the account (bought earlier, elsewhere, or a purchase under way): never buy again.
    if (existing !== undefined && existing.state !== "succeeded") {
      if (existing.state === "pending" || existing.state === "in_progress") {
        deps.reporter.info(
          `Cloudflare is already buying ${domain} on this account; OpsCrew waits for that purchase and does not buy the domain again.`,
        );
      }
      await waitForRegistration(ctx, existing);
    } else {
      deps.reporter.info(
        `${domain} is already registered on your Cloudflare account, so OpsCrew does not buy it again.`,
      );
    }
    return setUpOwnedDomain(ctx, options.autoRenew);
  }

  return purchase(ctx, files, {
    years,
    autoRenew: options.autoRenew ?? true,
    ...(maxPrice === undefined ? {} : { maxPrice }),
    ...(options.account === undefined ? {} : { account: options.account }),
  });
}

/**
 * A registrar read made before anything is bought. Cloudflare refusing it (401/403) after the
 * token could list the accounts means the token has DNS access but no Registrar access: that is
 * said plainly, with the optional permissions to add.
 */
async function registrarRead<T>(ctx: PurchaseContext, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isUserFacingError(error) || error.code !== "CREDENTIALS_INVALID") throw error;
    const { domain, account } = ctx;
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `This Cloudflare token cannot use Cloudflare Registrar on the account ${account.name} (${account.id}), so OpsCrew cannot buy ${domain} with it. Nothing was bought.`,
      {
        hint: `Buying domains is optional and needs these extra token permissions: ${REGISTRAR_PERMISSIONS}. Edit the token at ${TOKEN_PAGE}, then run \`opscrew domain buy ${domain}\` again. DNS and deployments keep working without them.`,
        cause: error,
      },
    );
  }
}

/** The account a recorded purchase was made on; a different `--account` stops the run. */
function recordedAccount(
  accounts: readonly DomainAccount[],
  record: PurchaseRecord,
  requested: string | undefined,
): DomainAccount {
  const account = accounts.find((a) => a.id === record.accountId);
  const wanted = requested?.trim();
  if (
    wanted &&
    wanted !== record.accountId &&
    account?.name.toLowerCase() !== wanted.toLowerCase()
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew started buying ${record.domain} on the Cloudflare account ${record.accountId}, not "${wanted}".`,
      {
        hint: `Run \`opscrew domain buy ${record.domain} --account ${record.accountId}\` (or without --account) to finish that purchase.`,
      },
    );
  }
  if (account === undefined) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `OpsCrew started buying ${record.domain} on the Cloudflare account ${record.accountId}, which this token cannot use.`,
      { hint: "Set CLOUDFLARE_API_TOKEN to a token for that account, then run the command again." },
    );
  }
  return account;
}

/** `2026-10-11 11:59 UTC` from an ISO timestamp (the text itself when it is not one). */
function formatTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time)
    ? iso
    : `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * An earlier run recorded this purchase: continue it when Cloudflare shows it, never send it
 * again. When Cloudflare shows nothing, the record stays unless it has no outcome (the run
 * stopped before or while sending) and is at least 30 minutes old by the wall clock, with both
 * reads in this run answering "none".
 */
async function continueRecorded(
  ctx: PurchaseContext,
  record: PurchaseRecord,
  autoRenew: boolean | undefined,
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  const status = await ctx.registrar.registrationStatus(domain);
  const owned = status === undefined ? await ctx.registrar.getDomain(domain) : undefined;
  if (status !== undefined || owned !== undefined) {
    deps.reporter.step(
      `Continuing the purchase of ${domain} that OpsCrew started on ${formatTime(record.requestedAt)}.`,
    );
    if (status !== undefined) await waitForRegistration(ctx, status);
    return finishPurchase(ctx, {
      autoRenew: record.autoRenew ?? autoRenew ?? true,
      ...(record.total === undefined ? {} : { total: record.total }),
    });
  }

  const when = formatTime(record.requestedAt);
  if (record.outcome === "uncertain") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Cloudflare shows no purchase of ${domain}, but OpsCrew's purchase request of ${when} got no clear answer, so the purchase may still appear.`,
      {
        hint: `Check ${DASHBOARD} and your Cloudflare billing. If ${domain} is listed, run \`opscrew domain buy ${domain}\` again to finish the setup. If it is not listed and you were not charged, run \`opscrew domain buy ${domain} --forget-pending-purchase\` to clear OpsCrew's note (that run buys nothing), then run \`opscrew domain buy ${domain}\` again to buy it.`,
      },
    );
  }
  const age = deps.clock.now().getTime() - Date.parse(record.requestedAt);
  if (Number.isFinite(age) && age >= UNSENT_PURCHASE_AGE_MS) {
    await removePurchaseRecord(ctx.recordFile);
    await auditDomain(
      deps,
      "domain purchase",
      domain,
      "cleared OpsCrew's purchase note: Cloudflare shows no purchase 30 minutes after it started",
    );
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Cloudflare shows no purchase of ${domain}, ${Math.floor(age / 60_000)} minutes after OpsCrew started one (${when}), so OpsCrew cleared its note about it.`,
      {
        hint: `Run \`opscrew domain buy ${domain}\` again to buy it; OpsCrew shows the price and asks again first.`,
      },
    );
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Cloudflare shows no purchase of ${domain} yet. OpsCrew started one at ${when} and stopped before it finished.`,
    {
      hint: `Wait a few minutes and run \`opscrew domain buy ${domain}\` again, or check ${DASHBOARD}. OpsCrew never sends the purchase twice; it clears its note once Cloudflare still shows no purchase 30 minutes after it started.`,
    },
  );
}

/**
 * Clears the note about an unfinished purchase (any domain), only while Cloudflare shows no
 * purchase of it and after a typed `domain-settings` approval that tells the user to check the
 * Cloudflare dashboard and billing first.
 */
async function forgetPurchase(
  deps: PhaseDeps,
  services: ResolvedDomainServices,
  accounts: readonly DomainAccount[],
  record: PurchaseRecord,
  recordFile: string,
): Promise<void> {
  const account = recordedAccount(accounts, record, undefined);
  const registrar = services.registrar(account.id);
  const status = await registrar.registrationStatus(record.domain);
  const owned = status === undefined ? await registrar.getDomain(record.domain) : undefined;
  if (status !== undefined || owned !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Cloudflare shows a purchase of ${record.domain}, so OpsCrew keeps its note about it.`,
      {
        hint: `Run \`opscrew domain buy ${record.domain}\` (without --forget-pending-purchase) to continue it.`,
      },
    );
  }
  const when = formatTime(record.requestedAt);
  const check = `Check ${DASHBOARD} and your Cloudflare billing for ${record.domain} first.`;
  deps.reporter.warn(
    `Cloudflare shows no purchase of ${record.domain}, but OpsCrew started one at ${when}. ${check}`,
  );
  const decision = await deps.approvals.request({
    kind: "domain-settings",
    title: `Forget the unfinished purchase of ${record.domain}`,
    details: [
      `OpsCrew started buying ${record.domain} at ${when}${record.outcome === "uncertain" ? " and got no clear answer from Cloudflare" : ""}.`,
      `Cloudflare shows no purchase of ${record.domain} on the account ${account.name} (${account.id}) now.`,
      `${check} If it is listed there or you were charged for it, do not continue; run \`opscrew domain buy ${record.domain}\` later instead.`,
      `Forgetting removes OpsCrew's note, so ${record.domain} can be bought again (OpsCrew still checks Cloudflare and asks before buying).`,
    ].join("\n"),
    confirmPhrase: record.domain,
  });
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `OpsCrew keeps its note about the purchase of ${record.domain}; nothing was changed.`,
      {
        hint: `Run \`opscrew domain buy ${record.domain}\` to continue it once Cloudflare shows it.`,
      },
    );
  }
  await removePurchaseRecord(recordFile);
  await auditDomain(
    deps,
    "domain purchase",
    record.domain,
    "the user cleared OpsCrew's note about an unfinished purchase",
  );
  deps.reporter.info(`OpsCrew forgot the unfinished purchase of ${record.domain}.`);
}

/** A new purchase: check, bound, approve, re-check, record, register once, wait, set up. */
async function purchase(
  ctx: PurchaseContext,
  files: ProjectFiles,
  options: { years: number; autoRenew: boolean; maxPrice?: MaxPrice; account?: string },
): Promise<BuyDomainResult> {
  const { deps, domain, account } = ctx;
  const { years, autoRenew, maxPrice } = options;
  const tld = tldOf(domain);
  const contact = await contactExtensionsNeeded(ctx.services, account.id, [tld]);
  if (contact.get(tld) === true) throw notBuyable(domain, contactExtensionReason(tld));

  deps.reporter.step(`Checking ${domain} with Cloudflare…`);
  const quote = await quoteDomain(ctx, years);
  if (maxPrice !== undefined) checkMaxPrice(domain, quote, years, maxPrice);
  if (!deps.interactive && maxPrice === undefined) {
    const command = buyCommand(domain, { ...options, quote });
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Buying ${domain} costs ${chargeCode(quote)} now (${yearsText(years)}) and cannot be refunded, so a run without a terminal needs the domain typed again and a price limit. Nothing was bought.`,
      {
        hint: `Run \`${command}\` (the most you agree to pay), or run \`opscrew domain buy ${domain}\` in an interactive terminal.`,
      },
    );
  }

  const decision = await deps.approvals.request({
    kind: "domain-purchase",
    title: `Buy ${domain} for ${quote.exact ? "" : "at most "}${formatMoney(quote.charge)} (${yearsText(years)})`,
    details: purchaseDetails(ctx, files, { years, autoRenew, quote }),
    confirmPhrase: domain,
  });
  if (!decision.approved) {
    const mismatch = decision.reason === "confirmation phrase did not match";
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Buying ${domain} was not approved, so nothing was bought.`,
      {
        hint: mismatch
          ? `To buy it, run the command again and type ${domain} exactly when asked.`
          : `Run \`opscrew domain buy ${domain}\` again when you want to buy it.`,
      },
    );
  }

  // Right before buying: the price and the account's registrations again (the approval may have
  // taken a while).
  const fresh = await quoteDomain(ctx, years);
  if (
    fresh.charge.currency !== quote.charge.currency ||
    cents(fresh.charge.amount) > cents(quote.charge.amount) ||
    cents(fresh.renewal.amount) > cents(quote.renewal.amount)
  ) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The price of ${domain} changed after you approved it: ${chargeCode(fresh)} now (renewal ${formatMoneyCode(fresh.renewal)} per year) instead of ${chargeCode(quote)} (renewal ${formatMoneyCode(quote.renewal)}). Nothing was bought.`,
      { hint: `Run \`opscrew domain buy ${domain}\` again to see the new price.` },
    );
  }
  if ((await ctx.registrar.registrationStatus(domain)) !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A purchase of ${domain} started on your Cloudflare account while you were deciding, so OpsCrew did not send another one.`,
      { hint: `Run \`opscrew domain buy ${domain}\` again to continue that purchase.` },
    );
  }

  // The approved bound: never more than what the user saw.
  const total = quote.charge;
  const record: PurchaseRecord = {
    domain,
    accountId: account.id,
    requestedAt: deps.clock.now().toISOString(),
    years,
    autoRenew,
    total,
  };
  await createPurchaseRecord(ctx.recordFile, record);
  deps.reporter.step(`Buying ${domain}…`);
  const first = await register(ctx, record);
  await waitForRegistration(ctx, first);
  return finishPurchase(ctx, { autoRenew, total });
}

/** Live availability and price; stops unless the domain can be bought through the API. */
async function quoteDomain(ctx: PurchaseContext, years: number): Promise<Quote> {
  const { domain } = ctx;
  const checks = await registrarRead(ctx, () => ctx.registrar.check([domain]));
  const raw = checks.find((c) => c.domain.trim().toLowerCase() === domain);
  if (raw === undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare did not say whether ${domain} is available. Nothing was bought.`,
      { hint: "Try again in a minute." },
    );
  }
  const check = normaliseCheck(raw);
  if (!check.registrable) throw notBuyable(domain, check.reason ?? "it is not available");
  const { firstYear, renewal } = check;
  if (firstYear === undefined || renewal === undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare did not return the ${firstYear === undefined ? "price" : "renewal price"} of ${domain}, so OpsCrew cannot show what it costs. Nothing was bought.`,
      { hint: "Try again in a minute, or buy it in the Cloudflare dashboard." },
    );
  }
  if (renewal.currency !== firstYear.currency) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare quoted ${domain} in two currencies (${firstYear.currency} and ${renewal.currency}). Nothing was bought.`,
      { hint: "Buy it in the Cloudflare dashboard, where the price is shown before you pay." },
    );
  }
  if (years === 1) return { firstYear, renewal, charge: firstYear, exact: true };
  const perYear = Math.max(cents(firstYear.amount), cents(renewal.amount));
  const charge = { amount: (years * perYear) / 100, currency: firstYear.currency };
  return { firstYear, renewal, charge, exact: false };
}

/** `10.44 USD`, or `up to 25.00 USD` for several years. */
function chargeCode(quote: Quote): string {
  return `${quote.exact ? "" : "up to "}${formatMoneyCode(quote.charge)}`;
}

function notBuyable(domain: string, reason: string): OpsCrewError {
  const label = domain.split(".")[0] ?? domain;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew cannot buy ${domain}: ${reason.trim().replace(/\.+$/, "")}. Nothing was bought.`,
    {
      hint: `Pick another name (\`opscrew domain search ${label}\`), or buy it in ${DASHBOARD}.`,
    },
  );
}

/** Stops when the limit is in another currency than the quote or below what is charged now. */
function checkMaxPrice(domain: string, quote: Quote, years: number, maxPrice: MaxPrice): void {
  const currency = quote.charge.currency;
  if (maxPrice.currency !== undefined && maxPrice.currency !== currency) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Cloudflare quotes ${domain} in ${currency}, but your maximum is ${formatMoneyCode({ amount: maxPrice.amount, currency: maxPrice.currency })}. Nothing was bought.`,
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
function buyCommand(
  domain: string,
  options: { years: number; autoRenew: boolean; account?: string; quote: Quote },
): string {
  const parts = [`opscrew domain buy ${domain}`];
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

function purchaseDetails(
  ctx: PurchaseContext,
  files: ProjectFiles,
  options: { years: number; autoRenew: boolean; quote: Quote },
): string {
  const { domain, account } = ctx;
  const { years, autoRenew, quote } = options;
  const renewal = formatMoney(quote.renewal);
  const perYear =
    cents(quote.firstYear.amount) >= cents(quote.renewal.amount) ? quote.firstYear : quote.renewal;
  const lines = [
    `Domain: ${domain}`,
    `Cloudflare account: ${account.name} (${account.id})`,
    `Years: ${years}`,
    `First year: ${formatMoney(quote.firstYear)}`,
    `Renewal: ${renewal} per year`,
    quote.exact
      ? `Charged now: ${formatMoney(quote.charge)}`
      : `Charged now: at most ${formatMoney(quote.charge)} (${years} × ${formatMoney(perYear)}, the higher of the first-year and renewal prices; OpsCrew bounds purchases of several years this way until Cloudflare's multi-year pricing is confirmed)`,
    autoRenew
      ? `Auto-renew: on. Cloudflare charges the renewal (${renewal} per year) to your account's default payment method up to 30 days before the domain expires. Turn it off any time with \`opscrew domain auto-renew off\`.`
      : `Auto-renew: off. The domain expires after ${yearsText(years)} unless you renew it; turn auto-renew on with \`opscrew domain auto-renew on\`.`,
    "WHOIS privacy: on (your contact details are redacted from public WHOIS where the extension allows it).",
    ...zoneLines(ctx, true),
    "Registrant contact: your Cloudflare account's default contact is used; OpsCrew never reads or stores it.",
    "Payment: your Cloudflare account's default payment method is charged.",
  ];
  const changes = projectChanges(files, domain);
  if (changes.replaces !== undefined) {
    lines.push(
      `The project uses ${changes.replaces} today; after the purchase OpsCrew asks before it records ${domain} instead:`,
    );
  } else if (changes.lines.length > 0) {
    lines.push("After the purchase, OpsCrew records the domain in the project files:");
  }
  lines.push(...changes.lines.map((line) => `  ${line}`));
  lines.push("Domain purchases cannot be refunded.");
  return lines.join("\n");
}

/**
 * Sends the purchase, exactly once. A clear rejection clears the record once Cloudflare confirms
 * there is no registration; a failure without a clear answer marks it `uncertain`.
 */
async function register(ctx: PurchaseContext, record: PurchaseRecord): Promise<RegistrationStatus> {
  const { deps, domain } = ctx;
  const years = record.years ?? 1;
  const autoRenew = record.autoRenew ?? true;
  const summary = `${yearsText(years)}, ${record.total === undefined ? "price unknown" : chargeText(years, record.total)}, auto-renew ${autoRenew ? "on" : "off"}, WHOIS privacy on, account ${ctx.account.id}`;
  let first: RegistrationStatus;
  try {
    first = await ctx.registrar.register({ domain, years, autoRenew, privacy: true });
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
          `Cloudflare did not accept the purchase of ${domain}: ${said}. Nothing was bought.`,
          {
            hint:
              hint ??
              `Check ${DASHBOARD} (a default contact, a payment method and a verified email address are needed), then try again.`,
            cause: error,
          },
        );
      }
      if (status === null) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Cloudflare refused the purchase of ${domain}: ${said}. OpsCrew could not confirm with Cloudflare that no purchase started, so it keeps its note.`,
          {
            hint: `Run \`opscrew domain buy ${domain}\` again later: OpsCrew checks Cloudflare first and never sends the purchase twice.`,
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
      : " OpsCrew could not mark its purchase note as uncertain; do not delete it until the Cloudflare dashboard shows what happened.";
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare did not confirm the purchase of ${domain}: ${said}. OpsCrew cannot tell whether the purchase started, so it will not send it again.${unmarked}`,
      {
        hint: `Check ${DASHBOARD}, then run \`opscrew domain buy ${domain}\` again: if Cloudflare shows the purchase, OpsCrew continues it; if not, OpsCrew explains how to clear its note.`,
        cause: error,
      },
    );
  }
  await auditDomain(
    deps,
    "register domain",
    domain,
    `${summary}; Cloudflare reported ${first.state}`,
  );
  return first;
}

/** `$10.44`, or `up to $25.00` for several years. */
function chargeText(years: number, total: Money): string {
  return `${years === 1 ? "" : "up to "}${formatMoney(total)}`;
}

/**
 * After a purchase succeeded (approved with the purchase, here or in an earlier run): zone,
 * DNSSEC, auto-renew, project files, record removal. A failure keeps the purchase record so the
 * next run finishes the setup without buying again.
 */
async function finishPurchase(
  ctx: PurchaseContext,
  options: { autoRenew: boolean; total?: Money },
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  let files: ProjectFiles;
  let changes: ProjectChanges;
  let zone: ZoneSetup;
  let info: RegisteredDomain;
  let recorded = { plan: false, requirements: false };
  let keptDomain: string | undefined;
  try {
    // The project files as they are now (waiting for Cloudflare can take minutes).
    files = await readProjectFiles(deps);
    changes = projectChanges(files, domain);
    if (changes.replaces !== undefined && !(await approveDomainSwitch(ctx, files, changes))) {
      keptDomain = changes.replaces;
    }
    zone = await ensureZoneAndDnssec(ctx);
    info = await registeredDetails(ctx);
    if (info.autoRenew !== options.autoRenew) {
      info = await ctx.registrar.setAutoRenew(domain, options.autoRenew);
      await auditDomain(
        deps,
        "set auto-renew",
        domain,
        `auto-renew ${options.autoRenew ? "on" : "off"}`,
      );
    }
    if (keptDomain === undefined) {
      recorded = await recordDomain(deps, files, {
        domain,
        hostname: changes.hostname,
        info,
        dnssec: zone.dnssec,
      });
    }
  } catch (error) {
    throw setupFailed(deps, domain, error);
  }
  await removePurchaseRecord(ctx.recordFile);
  return completed(ctx, {
    files,
    hostname: changes.hostname,
    zone,
    info,
    recorded,
    ...(keptDomain === undefined ? {} : { keptDomain }),
    ...(options.total === undefined ? {} : { total: options.total }),
    alreadyRegistered: false,
  });
}

/**
 * A domain already on the account: nothing is bought, and nothing changes before a
 * `domain-settings` approval listing every change (zone, DNSSEC, auto-renew when asked for,
 * project files). Refusal changes nothing.
 */
async function setUpOwnedDomain(
  ctx: PurchaseContext,
  autoRenew: boolean | undefined,
): Promise<BuyDomainResult> {
  const { deps, domain, account } = ctx;
  const files = await readProjectFiles(deps);
  const details = await registeredDetails(ctx).catch((error: unknown) => {
    throw setupFailed(deps, domain, error);
  });
  const changes = projectChanges(files, domain);
  const autoRenewChange =
    autoRenew !== undefined && autoRenew !== details.autoRenew ? autoRenew : undefined;
  const lines = [
    `${domain} is already registered on your Cloudflare account ${account.name} (${account.id}), so nothing is bought.`,
    ...zoneLines(ctx, false),
  ];
  if (autoRenewChange !== undefined) {
    const price = await renewalPrice(ctx.registrar, domain);
    lines.push(autoRenewApproval(domain, details, autoRenewChange, price).details);
  }
  lines.push(...changes.lines);
  if (changes.replaces !== undefined) {
    lines.push(
      `This replaces ${changes.replaces} in the project files; its DNS records stay until \`opscrew dns\` or \`opscrew provision\` updates them.`,
    );
  }
  const decision = await deps.approvals.request({
    kind: "domain-settings",
    title: `Set up ${domain} for this project`,
    details: lines.join("\n"),
    // Typed in a terminal, `--confirm <domain>` in scripts; `--yes` never grants it.
    confirmPhrase: domain,
  });
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `${domain} was not set up; OpsCrew changed nothing.`,
      { hint: `Run \`opscrew domain buy ${domain}\` again when you want to set it up.` },
    );
  }

  let zone: ZoneSetup;
  let info = details;
  let recorded: { plan: boolean; requirements: boolean };
  try {
    zone = await ensureZoneAndDnssec(ctx);
    if (autoRenewChange !== undefined) {
      info = await ctx.registrar.setAutoRenew(domain, autoRenewChange);
      await auditDomain(
        deps,
        "set auto-renew",
        domain,
        `auto-renew ${autoRenewChange ? "on" : "off"}`,
      );
    }
    recorded = await recordDomain(deps, files, {
      domain,
      hostname: changes.hostname,
      info,
      dnssec: zone.dnssec,
    });
  } catch (error) {
    throw setupFailed(deps, domain, error);
  }
  return completed(ctx, {
    files,
    hostname: changes.hostname,
    zone,
    info,
    recorded,
    alreadyRegistered: true,
  });
}

/** The registration details; stops when Cloudflare does not return them yet. */
async function registeredDetails(ctx: PurchaseContext): Promise<RegisteredDomain> {
  const details = await ctx.registrar.getDomain(ctx.domain);
  if (details === undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare does not return the details of ${ctx.domain} yet.`,
      { hint: "Wait a minute." },
    );
  }
  return details;
}

/** The zone set up for the domain and whether DNSSEC is on for it. */
interface ZoneSetup {
  zoneId: string;
  dnssec: boolean;
}

/**
 * The domain's zone in the purchase account (`createZone` reuses an existing zone only in that
 * account), with DNSSEC turned on unless it already is. With stand-in zones (registrar sandbox)
 * nothing is set up or audited and DNSSEC stays off.
 */
async function ensureZoneAndDnssec(ctx: PurchaseContext): Promise<ZoneSetup> {
  const { deps, domain, account, services } = ctx;
  const zone = await services.zones.createZone(account.id, domain);
  if (services.zones.simulated === true) return { zoneId: zone.id, dnssec: false };
  await auditDomain(deps, "ensure zone", domain, `zone ${zone.id} in account ${account.id}`);
  const on =
    services.zones.dnssecEnabled === undefined
      ? false
      : await services.zones.dnssecEnabled(zone.id);
  if (!on) {
    await services.zones.enableDnssec(zone.id);
    await auditDomain(deps, "enable DNSSEC", domain, `zone ${zone.id}`);
  }
  return { zoneId: zone.id, dnssec: true };
}

/** Approval lines about the zone and DNSSEC (stand-in zones: says they are skipped). */
function zoneLines(ctx: PurchaseContext, purchase: boolean): string[] {
  const { domain } = ctx;
  if (ctx.services.zones.simulated === true) {
    return [
      "Cloudflare zone and DNSSEC: skipped (Cloudflare's registrar sandbox has no zones); DNSSEC is recorded as off.",
    ];
  }
  return [
    purchase
      ? `Cloudflare zone: created for ${domain} in this account right after the purchase (an existing zone in this account is reused).`
      : `Cloudflare zone: created for ${domain} in this account if it does not exist there yet (an existing zone in this account is reused).`,
    purchase
      ? "DNSSEC: on (OpsCrew turns it on for the zone unless it is already on)."
      : "DNSSEC: turned on for the zone unless it is already on.",
  ];
}

/** Asks before the bought domain replaces another one in the project files. */
async function approveDomainSwitch(
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

/** Audit, success message and next steps after a purchase or a setup. */
async function completed(
  ctx: PurchaseContext,
  result: {
    files: ProjectFiles;
    hostname: string;
    zone: ZoneSetup;
    info: RegisteredDomain;
    recorded: { plan: boolean; requirements: boolean };
    keptDomain?: string;
    total?: Money;
    alreadyRegistered: boolean;
  },
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  const { files, hostname, info, keptDomain, zone } = result;
  const simulated = ctx.services.zones.simulated === true;
  const what = result.alreadyRegistered
    ? "already registered; set up"
    : `bought${result.total === undefined ? "" : ` (approved price ${formatMoney(result.total)})`}`;
  const zoneState = simulated
    ? "zone and DNSSEC skipped (registrar sandbox)"
    : `DNSSEC ${zone.dnssec ? "on" : "off"}; zone ${zone.zoneId}`;
  await auditDomain(
    deps,
    "domain purchase",
    domain,
    `${what}; expires ${formatDate(info.expiresAt)}; auto-renew ${info.autoRenew ? "on" : "off"}; ${zoneState}`,
  );
  const dnssecText = simulated
    ? "no zone or DNSSEC (registrar sandbox)"
    : `DNSSEC ${zone.dnssec ? "on" : "off"}`;
  deps.reporter.success(
    `${domain} is ${result.alreadyRegistered ? "set up" : "yours"}: registered with Cloudflare until ${formatDate(info.expiresAt)}, auto-renew ${info.autoRenew ? "on" : "off"}, WHOIS privacy ${info.privacy === false ? "off" : "on"}, ${dnssecText}.`,
  );

  const next: string[] = [];
  if (keptDomain !== undefined) {
    deps.reporter.warn(
      `${files.plan === undefined ? "opscrew/requirements.yaml" : "The plan"} still uses ${keptDomain}. ${domain} stays bought and set up on your Cloudflare account.`,
    );
    next.push(
      `To serve the app at ${domain} later, run \`opscrew dns --domain ${domain}\`. It shows the change and asks before applying it.`,
    );
  } else if (isDeployed(files.plan)) {
    next.push(
      `Run \`opscrew dns\` to point ${hostname} at your server. It shows the change and asks before applying it.`,
    );
  } else if (files.plan !== undefined) {
    next.push(`Run \`opscrew provision\` to deploy the app at https://${hostname}.`);
  } else if (files.requirements !== undefined) {
    next.push(`Run \`opscrew design\` to plan the deployment for ${hostname}.`);
  } else {
    next.push(
      `Run \`opscrew interview\` and give ${domain} as the domain, then \`opscrew design\`.`,
    );
  }
  const [step] = next;
  if (!simulated && step !== undefined) {
    // A token limited to the zones that existed before does not cover this (possibly new) zone;
    // said within the one next step, before the user runs it.
    next[0] = `${step} If your Cloudflare token is limited to specific zones, first add the zone ${domain} to it at ${TOKEN_PAGE} (or set it to all zones of the account): \`opscrew dns\` and \`opscrew provision\` need the token's zone permissions (${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")}) on ${domain} too.`;
  }
  return {
    outcome: "set-up",
    domain: info,
    zoneId: zone.zoneId,
    ...(result.total === undefined ? {} : { total: result.total }),
    alreadyRegistered: result.alreadyRegistered,
    recorded: result.recorded,
    next,
  };
}

function setupFailed(deps: PhaseDeps, domain: string, error: unknown): OpsCrewError {
  const code: ErrorCode = isUserFacingError(error) ? (error.code as ErrorCode) : "INTERNAL";
  const hint = isUserFacingError(error) && error.hint ? `${error.hint.trim()} Then run` : "Run";
  return new OpsCrewError(
    code,
    `${domain} is registered, but OpsCrew could not finish setting it up: ${providerText(deps, errorText(deps, error))}.`,
    {
      hint: `${hint} \`opscrew domain buy ${domain}\` again to finish the setup; it does not buy the domain again.`,
      cause: error,
    },
  );
}
