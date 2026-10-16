import type { Money } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, plural } from "@opscrew/core";
import {
  auditDomain,
  cents,
  contactExtensionReason,
  contactExtensionsNeeded,
  DASHBOARD,
  formatDate,
  formatMoney,
  formatMoneyCode,
  normaliseCheck,
  REGISTRAR_PERMISSIONS,
  TOKEN_PAGE,
  tldOf,
} from "./common";
import { nextProjectStep } from "./project";
import { chargeCode, type DnsSetup, type Offer, type RegistrarFlow, type SetUp } from "./purchase";
import type { DomainSetUpResult } from "./types";
import type { PurchaseContext } from "./wait";

/**
 * Buying at Cloudflare Registrar (feature 006): the registrant is the account's default contact,
 * the price is the live check's (an upper bound for several years), and the setup is the zone in
 * the purchase account with DNSSEC on, which Cloudflare Registrar publishes itself.
 */
export function cloudflareFlow(ctx: PurchaseContext): RegistrarFlow<DnsSetup> {
  const { domain, account } = ctx;
  return {
    takeOver: async () => {},
    quote: (years, autoRenew) => cloudflareOffer(ctx, years, autoRenew),
    owned: async () => ({
      lines: [
        `${domain} is already registered on your Cloudflare account ${account.name} (${account.id}), so nothing is bought.`,
        ...zoneLines(ctx, false),
      ],
      publishDs: true,
    }),
    setUp: () => ensureZoneAndDnssec(ctx),
    summary: (result) => completed(ctx, result),
  };
}

/**
 * A registrar read made before anything is bought. Cloudflare refusing it (401/403) after the
 * token could list the accounts means the token has DNS access but no Registrar access: that is
 * said plainly, with the optional permissions to add. Other registrars' errors pass through.
 */
export async function registrarRead<T>(ctx: PurchaseContext, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (ctx.registrarId !== "cloudflare") throw error;
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
 * Extensions that need registrant data OpsCrew does not collect stop first; then the live price.
 * Right before buying, the price is checked again in whole cents: higher stops the purchase.
 */
async function cloudflareOffer(
  ctx: PurchaseContext,
  years: number,
  autoRenew: boolean,
): Promise<Offer> {
  const { deps, domain, account } = ctx;
  const tld = tldOf(domain);
  const contact = await contactExtensionsNeeded(ctx.services, account.id, [tld]);
  if (contact.get(tld) === true) throw notBuyable(domain, contactExtensionReason(tld));

  deps.reporter.step(`Checking ${domain} with Cloudflare…`);
  const quote = await quoteDomain(ctx, years);
  return {
    charge: quote.charge,
    exact: quote.exact,
    approvalLines: async () => purchaseLines(ctx, { years, autoRenew, quote }),
    recheck: async () => {
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
    },
  };
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

/** The approval's lines about the domain, the price, the registration and the zone. */
function purchaseLines(
  ctx: PurchaseContext,
  options: { years: number; autoRenew: boolean; quote: Quote },
): string[] {
  const { domain, account } = ctx;
  const { years, autoRenew, quote } = options;
  const renewal = formatMoney(quote.renewal);
  const perYear =
    cents(quote.firstYear.amount) >= cents(quote.renewal.amount) ? quote.firstYear : quote.renewal;
  return [
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
      : `Auto-renew: off. The domain expires after ${plural(years, "year")} unless you renew it; turn auto-renew on with \`opscrew domain auto-renew on\`.`,
    "WHOIS privacy: on (your contact details are redacted from public WHOIS where the extension allows it).",
    ...zoneLines(ctx, true),
    "Registrant contact: your Cloudflare account's default contact is used; OpsCrew never reads or stores it.",
    "Payment: your Cloudflare account's default payment method is charged.",
  ];
}

/**
 * The domain's zone in the purchase account (`createZone` reuses an existing zone only in that
 * account), with DNSSEC turned on unless it already is. Cloudflare Registrar publishes the DS
 * record itself.
 */
async function ensureZoneAndDnssec(ctx: PurchaseContext): Promise<DnsSetup> {
  const { deps, domain, account, zones } = ctx;
  const zone = await zones.createZone(account.id, domain);
  await auditDomain(deps, "ensure zone", domain, `zone ${zone.id} in account ${account.id}`);
  if (!(await zones.dnssecEnabled(zone.id))) {
    await zones.enableDnssec(zone.id);
    await auditDomain(deps, "enable DNSSEC", domain, `zone ${zone.id}`);
  }
  return { zoneId: zone.id, dnssec: true };
}

/** Approval lines about the zone and DNSSEC. */
function zoneLines(ctx: PurchaseContext, purchase: boolean): string[] {
  const { domain } = ctx;
  return [
    purchase
      ? `Cloudflare zone: created for ${domain} in this account right after the purchase (an existing zone in this account is reused).`
      : `Cloudflare zone: created for ${domain} in this account if it does not exist there yet (an existing zone in this account is reused).`,
    purchase
      ? "DNSSEC: on (OpsCrew turns it on for the zone unless it is already on)."
      : "DNSSEC: turned on for the zone unless it is already on.",
  ];
}

/** Audit, success message and next steps after a purchase or a setup. */
async function completed(
  ctx: PurchaseContext,
  result: SetUp<DnsSetup>,
): Promise<DomainSetUpResult> {
  const { deps, domain } = ctx;
  const { files, hostname, info, keptDomain, dns } = result;
  const what = result.alreadyRegistered
    ? "already registered; set up"
    : `bought${result.total === undefined ? "" : ` (approved price ${formatMoney(result.total)})`}`;
  await auditDomain(
    deps,
    "domain purchase",
    domain,
    `${what}; expires ${formatDate(info.expiresAt)}; auto-renew ${info.autoRenew ? "on" : "off"}; DNSSEC ${dns.dnssec ? "on" : "off"}; zone ${dns.zoneId}`,
  );
  deps.reporter.success(
    `${domain} is ${result.alreadyRegistered ? "set up" : "yours"}: registered with Cloudflare until ${formatDate(info.expiresAt)}, auto-renew ${info.autoRenew ? "on" : "off"}, WHOIS privacy ${info.privacy === false ? "off" : "on"}, DNSSEC ${dns.dnssec ? "on" : "off"}.`,
  );
  return {
    outcome: "set-up",
    domain: info,
    zoneId: dns.zoneId,
    total: result.total,
    alreadyRegistered: result.alreadyRegistered,
    recorded: result.recorded,
    next: [
      nextProjectStep(deps, files, {
        domain,
        hostname,
        keptDomain,
        stays: "stays bought and set up on your Cloudflare account",
      }),
    ],
  };
}
