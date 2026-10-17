import type { Money, Registrar, RegistrationQuote } from "@opscrew/contracts";
import { type ErrorCode, isUserFacingError, OpsCrewError, plural } from "@opscrew/core";
import {
  auditDomain,
  cents,
  errorText,
  formatDate,
  formatMoney,
  formatMoneyCode,
  providerText,
} from "./common";
import { buyCommandOf, registrarDashboard } from "./links";
import { nextProjectStep, type ProjectFiles, registeredName } from "./project";
import {
  autoRenewOffLine,
  formatTime,
  type Offer,
  type RegistrarFlow,
  registeredSummary,
  type SetUp,
  zoneLine,
} from "./purchase";
import { type OtherRegistrarId, REGISTRAR_NAMES, registrarLinks } from "./registrars";
import { dsRecordText, hosts, type SwitchResult, sameHosts, switchToCloudflare } from "./switch";
import type { DomainSetUpResult } from "./types";
import type { PurchaseContext } from "./wait";

/**
 * Buying at Porkbun, Namecheap or GoDaddy (feature 007): the registrar's own quote, bounded by the
 * account balance where it has one, and afterwards the move of the domain's DNS to Cloudflare
 * (`switchToCloudflare`: zone → nameservers → DS record → activation check); the plan records the
 * registrar. A domain already in the account is only set up when OpsCrew may move its DNS.
 */
export function elsewhereFlow(ctx: PurchaseContext): RegistrarFlow {
  const name = REGISTRAR_NAMES[ctx.registrarId];
  // What the switch did, for the summary (`setUp` always runs before it).
  let switched: SwitchResult | undefined;
  return {
    takeOver: async (files) => {
      if (!(await mayTakeOverOwned(ctx, files))) throw notOursToSwitch(ctx);
    },
    quote: (years, autoRenew) => elsewhereOffer(ctx, years, autoRenew),
    owned: async () => {
      // The domain may be live, so its DS record is published only when its zone is active
      // already; otherwise DNSSEC is left to `opscrew domain connect`.
      const publishDs = await zoneIsActive(ctx);
      return {
        lines: [
          `${ctx.domain} is already registered in your ${name} account, so nothing is bought.`,
          ...switchLines(ctx, false, !publishDs),
        ],
        publishDs,
      };
    },
    setUp: async (publishDs) => {
      switched = await switchToCloudflare(ctx, { publishDs });
      const dnssec = switched.ds.outcome === "skipped" ? "skipped" : switched.dnssec;
      return { zoneId: switched.zone.id, dnssec };
    },
    summary: (result) => completedElsewhere(ctx, result, switched as SwitchResult),
  };
}

/**
 * Stops before any call when the registrar cannot register the chosen number of years (Porkbun
 * registers the registry minimum only, usually 1 year).
 */
export function requireRegistrarYears(
  registrarId: OtherRegistrarId,
  registrar: Registrar,
  domain: string,
  years: number,
): void {
  const name = REGISTRAR_NAMES[registrarId];
  if (!registrar.capabilities.chooseYears && years !== 1) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${name} registers a new domain for the registry minimum term only (usually 1 year), so OpsCrew cannot buy ${domain} for ${plural(years, "year")} there.`,
      {
        hint: `Run \`${buyCommandOf(domain, registrarId)}\` without --years (auto-renew extends the registration later), or buy at a registrar that lets you choose the years.`,
      },
    );
  }
}

/**
 * Whether `buy` may set up a domain already in the account: only when OpsCrew set it up before
 * (the plan records this domain at this registrar) or its nameservers already point at its
 * Cloudflare zone. Any other domain may be in use (website, email, old DS records), so moving its
 * DNS is `opscrew domain connect`'s job, which copies the records first.
 */
async function mayTakeOverOwned(ctx: PurchaseContext, files: ProjectFiles): Promise<boolean> {
  const { domain, registrar, registrarId } = ctx;
  if (files.plan?.dns.registration?.registrar === registrarId && registeredName(files) === domain) {
    return true;
  }
  if (!registrar.capabilities.nameservers || registrar.getNameservers === undefined) {
    return false;
  }
  const zone = await ctx.zones.findZone(domain);
  // A zone in another account the token can see does not count: setting up creates the zone in
  // the chosen account, which would get other nameservers.
  if (zone?.accountId !== undefined && zone.accountId !== ctx.account.id) return false;
  const zoneNameservers = hosts(zone?.nameServers ?? []);
  if (zoneNameservers.length === 0) return false;
  try {
    return sameHosts(hosts(await registrar.getNameservers(domain)), zoneNameservers);
  } catch {
    // Unknown is not "already on Cloudflare": nothing is changed and `connect` is suggested.
    return false;
  }
}

/** Stops before any change: the domain is in the account, but OpsCrew did not buy it. */
function notOursToSwitch(ctx: PurchaseContext): OpsCrewError {
  const { domain } = ctx;
  const name = REGISTRAR_NAMES[ctx.registrarId];
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${domain} is already registered in your ${name} account, but OpsCrew did not buy it and its DNS is not on Cloudflare yet. Switching its nameservers now would stop the records ${name} serves (website, email). Nothing was changed.`,
    {
      hint: `Run \`opscrew domain connect ${domain}\`: it copies the records into a Cloudflare zone first and asks before switching.`,
    },
  );
}

/** Stops when the registrar's API cannot sell domains (or give a price for one). */
function cannotBuyHere(ctx: PurchaseContext): OpsCrewError {
  const { deps, domain } = ctx;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew cannot buy domains through ${REGISTRAR_NAMES[ctx.registrarId]}'s API, so it cannot buy ${domain} there. Nothing was bought.`,
    {
      hint: `Buy it in ${registrarDashboard(ctx.registrarId, deps.env)}, then run \`opscrew domain connect ${domain}\`.`,
    },
  );
}

/**
 * The account check (API access and the balance, where the registrar has them), then the
 * registrar's quote, bounded by the balance. The registrar binds the price itself (Porkbun sends
 * it as the cost, Namecheap compares it, GoDaddy's quote token locks it); right before buying,
 * only the quote's expiry is checked again.
 */
async function elsewhereOffer(
  ctx: PurchaseContext,
  years: number,
  autoRenew: boolean,
): Promise<Offer> {
  const { deps, domain, registrar, registrarId } = ctx;
  const name = REGISTRAR_NAMES[registrarId];
  const command = buyCommandOf(domain, registrarId);
  if (!registrar.capabilities.purchase || registrar.quote === undefined) {
    throw cannotBuyHere(ctx);
  }

  let balance: Money | undefined;
  if (registrar.accountCheck !== undefined) {
    deps.reporter.step(`Checking your ${name} account…`);
    const check = await registrar.accountCheck();
    if (!check.ok) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${providerText(deps, check.message)}. Nothing was bought.`,
        {
          hint:
            check.fix === undefined
              ? `Check the API access of your ${name} account at ${registrarLinks(registrarId, deps.env).api}, then run \`${command}\` again.`
              : `${providerText(deps, check.fix)}.`,
        },
      );
    }
    if (check.fix !== undefined) {
      // Usable, with a caveat (for example a key without a permission OpsCrew may need).
      deps.reporter.warn(`${providerText(deps, check.message)}. ${providerText(deps, check.fix)}.`);
    }
    balance = check.balance;
  }

  deps.reporter.step(`Checking ${domain} with ${name}…`);
  const quote = await quoteElsewhere(ctx, years);
  if (
    balance !== undefined &&
    balance.currency === quote.price.currency &&
    cents(balance.amount) < cents(quote.price.amount)
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your ${name} account balance (${formatMoneyCode(balance)}) is lower than the price of ${domain} (${formatMoneyCode(quote.price)}). Nothing was bought.`,
      {
        hint: `${name} pays API purchases from the account balance. Add funds in ${registrarDashboard(registrarId, deps.env)}, then run \`${command}\` again.`,
      },
    );
  }
  return {
    charge: quote.price,
    exact: true,
    quote,
    approvalLines: async () => {
      // GoDaddy's summary names the contact source of that quote. Already masked by the adapter;
      // made safe again (no email address or phone number) before it is shown.
      const summary =
        registrar.contactSummary === undefined ? undefined : await registrar.contactSummary();
      const contact = summary === undefined ? undefined : providerText(deps, summary);
      return purchaseLines(ctx, { years, autoRenew, quote, contact, balance });
    },
    recheck: async () => {
      if (
        quote.expiresAt !== undefined &&
        Date.parse(quote.expiresAt) <= deps.clock.now().getTime()
      ) {
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          `The ${name} price for ${domain} expired at ${formatTime(quote.expiresAt)} while you were deciding. Nothing was bought.`,
          { hint: `Run \`${command}\` again to get a new price.` },
        );
      }
    },
  };
}

/** The registrar's quote, checked; its refusals stop the run saying nothing was bought. */
async function quoteElsewhere(ctx: PurchaseContext, years: number): Promise<RegistrationQuote> {
  const { deps, domain, registrar } = ctx;
  const name = REGISTRAR_NAMES[ctx.registrarId];
  const quote = registrar.quote;
  if (quote === undefined) throw cannotBuyHere(ctx);
  let answer: RegistrationQuote;
  try {
    answer = await quote.call(registrar, domain, years);
  } catch (error) {
    if (isUserFacingError(error)) {
      throw new OpsCrewError(
        error.code as ErrorCode,
        `${providerText(deps, error.message)}. Nothing was bought.`,
        { hint: error.hint ? `${providerText(deps, error.hint)}.` : undefined, cause: error },
      );
    }
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${name} did not give a price for ${domain}: ${errorText(deps, error)}. Nothing was bought.`,
      { hint: "Try again in a minute.", cause: error },
    );
  }
  const { price, renewal } = answer;
  if (!(price.amount > 0) || (renewal !== undefined && renewal.currency !== price.currency)) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${name} returned a price for ${domain} that OpsCrew cannot show safely. Nothing was bought.`,
      {
        hint: `Try again in a minute, or buy it in ${registrarDashboard(ctx.registrarId, deps.env)}.`,
      },
    );
  }
  return answer;
}

/** The approval's lines about the domain, the price, the registration, payment and the switch. */
function purchaseLines(
  ctx: PurchaseContext,
  options: {
    years: number;
    autoRenew: boolean;
    quote: RegistrationQuote;
    contact: string | undefined;
    balance: Money | undefined;
  },
): string[] {
  const { deps, domain, account, registrar } = ctx;
  const { years, autoRenew, quote, contact, balance } = options;
  const name = REGISTRAR_NAMES[ctx.registrarId];
  const page = registrarLinks(ctx.registrarId, deps.env).domains;
  const caps = registrar.capabilities;
  const renewal =
    quote.renewal === undefined
      ? `${name} did not quote the renewal price; check it at ${page} before the domain renews`
      : `${formatMoney(quote.renewal)} per year`;
  const lines = [
    `Domain: ${domain}`,
    `Registrar: ${name}`,
    caps.chooseYears
      ? `Years: ${years}`
      : `Term: the registry minimum (${plural(years, "year")}); ${name} registers no other term, and renewals extend it.`,
    `Charged now: ${formatMoney(quote.price)}${years === 1 ? "" : ` for ${plural(years, "year")}`}`,
    quote.renewal === undefined ? `Renewal: ${renewal}.` : `Renewal: ${renewal}`,
  ];
  if (quote.expiresAt !== undefined)
    lines.push(`Price valid until: ${formatTime(quote.expiresAt)}`);
  lines.push(
    caps.autoRenew
      ? autoRenew
        ? `Auto-renew: on. ${name} charges the renewal (${renewal}) to your ${name} account before the domain expires. Turn it off any time with \`opscrew domain auto-renew off\`.`
        : autoRenewOffLine(years)
      : `Auto-renew: ${name}'s API cannot set it, so your ${name} account's own setting applies (you asked for ${autoRenew ? "on" : "off"}); OpsCrew says after the purchase if it differs, and you change it at ${page}.`,
    ctx.registrarId === "godaddy"
      ? "WHOIS privacy: GoDaddy applies your contact profile's privacy setting; OpsCrew asks for privacy on and says after the purchase if the profile differs."
      : `WHOIS privacy: on (${name} hides your contact details from public WHOIS where the extension allows it).`,
    contact === undefined
      ? `Registrant contact: your ${name} account's own contact is used; OpsCrew never reads or stores it.`
      : `Registrant contact: ${contact} (from your ${name} account; OpsCrew never stores or logs contact details).`,
  );
  const agreements = quote.agreements ?? [];
  if (agreements.length > 0) {
    lines.push(`Agreements: by typing the domain you accept ${name}'s ${agreements.join("; ")}.`);
  }
  lines.push(
    balance === undefined
      ? `Payment: charged to your ${name} account.`
      : `Payment: charged to your ${name} account. ${name} account balance: ${formatMoney(balance)}.`,
    `Cloudflare account: ${account.name} (${account.id})`,
    ...switchLines(ctx, true),
  );
  return lines;
}

/**
 * Approval lines about the move to Cloudflare: zone, nameservers, DNSSEC, per the registrar's
 * capabilities. `dnssecLater`: the zone is not active, so DNSSEC is left to `opscrew domain
 * connect`.
 */
function switchLines(ctx: PurchaseContext, purchase: boolean, dnssecLater = false): string[] {
  const { deps, domain, registrar } = ctx;
  const name = REGISTRAR_NAMES[ctx.registrarId];
  const page = registrarLinks(ctx.registrarId, deps.env).domains;
  const caps = registrar.capabilities;
  return [
    purchase
      ? `Cloudflare zone: right after the purchase OpsCrew creates a Cloudflare zone for ${domain} in this account (an existing zone in this account is reused).`
      : zoneLine(domain),
    caps.nameservers && registrar.setNameservers !== undefined
      ? `Nameservers: OpsCrew then points the nameservers of ${domain} at ${name} to the zone's Cloudflare nameservers (skipped when they already are).`
      : `Nameservers: ${name}'s API cannot change nameservers, so OpsCrew shows the zone's nameservers to set at ${page}.`,
    dnssecLater
      ? `DNSSEC: not changed now. The Cloudflare zone of ${domain} is not active yet, and a DS record published before it is would stop resolvers that check DNSSEC from resolving ${domain}; \`opscrew domain connect ${domain}\` adds it once the zone is active, and asks first.`
      : caps.dnssec && registrar.addDsRecord !== undefined
        ? `DNSSEC: OpsCrew turns it on for the zone and adds the zone's DS record at ${name} (skipped when it is already there).`
        : `DNSSEC: OpsCrew turns it on for the zone; ${name}'s API cannot publish DNSSEC records, so OpsCrew shows the zone's DS record to add at ${page}.`,
    "Then OpsCrew asks Cloudflare to check the new nameservers; DNS for the domain is served by Cloudflare from then on.",
  ];
}

/**
 * Whether the domain's zone in the chosen Cloudflare account is active already (its nameservers
 * point at Cloudflare). Unknown counts as not active.
 */
async function zoneIsActive(ctx: PurchaseContext): Promise<boolean> {
  const zone = await ctx.zones.findZone(ctx.domain).catch(() => undefined);
  return (
    zone?.status === "active" && (zone.accountId === undefined || zone.accountId === ctx.account.id)
  );
}

/** Audit, success message and next steps after a purchase or a setup at another registrar. */
async function completedElsewhere(
  ctx: PurchaseContext,
  result: SetUp,
  switched: SwitchResult,
): Promise<DomainSetUpResult> {
  const { deps, domain } = ctx;
  const { files, hostname, info, keptDomain } = result;
  const name = REGISTRAR_NAMES[ctx.registrarId];
  const page = registrarLinks(ctx.registrarId, deps.env).domains;
  const { zone, nameservers, ds, activation } = switched;
  await auditDomain(
    deps,
    "domain purchase",
    domain,
    `${registeredSummary(result)} at ${name}; expires ${formatDate(info.expiresAt)}; auto-renew ${info.autoRenew ? "on" : "off"}; nameservers ${nameservers.outcome}; DS record ${ds.outcome}; zone ${zone.id}`,
  );

  const nsText =
    nameservers.outcome === "manual"
      ? "its nameservers still need to be set (see below)"
      : "its nameservers point at Cloudflare";
  const dnssecText = {
    added: "DNSSEC on",
    already: "DNSSEC on",
    manual: "DNSSEC still needs the DS record added (see below)",
    pending: "DNSSEC not published yet",
    later: "DNSSEC added once the zone is active (see below)",
    skipped: "DNSSEC skipped",
  }[ds.outcome];
  deps.reporter.success(
    `${domain} is ${result.alreadyRegistered ? "set up" : "yours"}: registered with ${name} until ${formatDate(info.expiresAt)}, auto-renew ${info.autoRenew ? "on" : "off"}, WHOIS privacy ${info.privacy === false ? "off" : "on"}; ${nsText}, ${dnssecText}.`,
  );

  const next: string[] = [];
  if (nameservers.outcome === "manual") {
    next.push(
      `Set the nameservers of ${domain} at ${page} to ${nameservers.nameservers.join(" and ")}; Cloudflare serves ${domain} only after that.`,
    );
  }
  if (ds.outcome === "manual" && ds.ds !== undefined) {
    next.push(
      `Add this DS record for ${domain} at ${page} to turn DNSSEC on: ${dsRecordText(ds.ds)}.`,
    );
  } else if (ds.outcome === "pending") {
    next.push(
      `Run \`${buyCommandOf(domain, ctx.registrarId)}\` again in a few minutes to publish the DS record; it does not buy the domain again.`,
    );
  } else if (ds.outcome === "later") {
    next.push(
      `DNSSEC is not on for ${domain} yet: once Cloudflare shows its zone as active, run \`opscrew domain connect ${domain}\` to add it. It lists the change and asks first.`,
    );
  }
  if (result.renewNext !== undefined) next.push(result.renewNext);
  if (!activation.skipped) {
    next.push(
      `Cloudflare activates the zone for ${domain} once the registry publishes the new nameservers, usually within an hour and sometimes up to a day.`,
    );
  }
  next.push(
    nextProjectStep(deps, files, {
      domain,
      hostname,
      keptDomain,
      stays: `stays registered at ${name} and set up on Cloudflare`,
    }),
  );
  return {
    outcome: "set-up",
    domain: info,
    zoneId: zone.id,
    total: result.total,
    alreadyRegistered: result.alreadyRegistered,
    recorded: result.recorded,
    next,
    registrar: ctx.registrarId,
    nameservers: nameservers.nameservers,
  };
}
