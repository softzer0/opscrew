import type {
  Money,
  RegisteredDomain,
  Registrar,
  RegistrarCapabilities,
  RegistrationQuote,
} from "@opscrew/contracts";
import { type ErrorCode, isUserFacingError, OpsCrewError } from "@opscrew/core";
import {
  auditDomain,
  cents,
  errorText,
  formatDate,
  formatMoney,
  formatMoneyCode,
  providerText,
  yearsText,
} from "./common";
import { buyCommandOf, registrarDashboard } from "./links";
import { autoRenewApproval, renewalPrice } from "./manage";
import {
  type ProjectChanges,
  type ProjectFiles,
  projectChanges,
  readProjectFiles,
  recordDomain,
  registeredName,
} from "./project";
import {
  approveDomainSwitch,
  checkMaxPrice,
  exactBuyCommand,
  formatTime,
  projectNextStep,
  purchaseRefused,
  registeredDetails,
  sendPurchase,
  setupFailed,
  zoneTokenNote,
} from "./purchase";
import { createPurchaseRecord, type PurchaseRecord, removePurchaseRecord } from "./record";
import {
  capabilitiesOf,
  type OtherRegistrarId,
  REGISTRAR_NAMES,
  registrarLinks,
} from "./registrars";
import {
  dsRecordText,
  hosts,
  type SwitchContext,
  type SwitchResult,
  sameHosts,
  switchToCloudflare,
} from "./switch";
import type { BuyDomainResult, MaxPrice } from "./types";
import { type PurchaseContext, waitForRegistration } from "./wait";

/**
 * Buying at Porkbun, Namecheap or GoDaddy (feature 007). The 006 safety rules apply unchanged: a
 * live quote shown and bounded (`maxPrice`, required without a terminal; the account balance), one
 * typed `domain-purchase` approval that `--yes` never grants, a purchase record (with the
 * registrar and an idempotency key) written before exactly one `register` call, and resumable
 * runs that never buy twice. Afterwards the domain moves to Cloudflare DNS (`switchToCloudflare`:
 * zone → nameservers → DS record → activation check) and the plan records the registrar.
 */

/** The registrar's name in prose. */
function nameOf(ctx: Pick<PurchaseContext, "registrarId">): string {
  return REGISTRAR_NAMES[ctx.registrarId];
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
  if (!capabilitiesOf(registrar).chooseYears && years !== 1) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${name} registers a new domain for the registry minimum term only (usually 1 year), so OpsCrew cannot buy ${domain} for ${yearsText(years)} there.`,
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
  if (!capabilitiesOf(registrar).nameservers || registrar.getNameservers === undefined) {
    return false;
  }
  const zones = ctx.services.zonesFor(registrarId);
  const zone =
    zones.simulated === true
      ? await zones.createZone(ctx.account.id, domain)
      : await zones.findZone(domain);
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
  const name = nameOf(ctx);
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${domain} is already registered in your ${name} account, but OpsCrew did not buy it and its DNS is not on Cloudflare yet. Switching its nameservers now would stop the records ${name} serves (website, email). Nothing was changed.`,
    {
      hint: `Run \`opscrew domain connect ${domain}\`: it copies the records into a Cloudflare zone first and asks before switching.`,
    },
  );
}

/**
 * A domain at another registrar: a registration already in the account is set up (nothing is
 * bought) when OpsCrew set it up before or its DNS is already on Cloudflare, else stopped with
 * `opscrew domain connect`; otherwise a new purchase.
 */
export async function buyElsewhere(
  ctx: PurchaseContext,
  files: ProjectFiles,
  options: { years: number; autoRenew?: boolean; maxPrice?: MaxPrice; account?: string },
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  const name = nameOf(ctx);
  const existing = await ctx.registrar.registrationStatus(domain);
  const owned = existing === undefined ? await ctx.registrar.getDomain(domain) : undefined;
  if (existing !== undefined || owned !== undefined) {
    // Already in the account (bought earlier, elsewhere, or a purchase under way): never buy again,
    // and never move the DNS of a domain OpsCrew did not set up (before any wait or approval).
    if (!(await mayTakeOverOwned(ctx, files))) throw notOursToSwitch(ctx);
    if (existing !== undefined && existing.state !== "succeeded") {
      if (existing.state === "pending" || existing.state === "in_progress") {
        deps.reporter.info(
          `${name} is already registering ${domain} in your account; OpsCrew waits for that and does not buy the domain again.`,
        );
      }
      await waitForRegistration(ctx, existing);
    } else {
      deps.reporter.info(
        `${domain} is already registered in your ${name} account, so OpsCrew does not buy it again.`,
      );
    }
    return setUpOwnedElsewhere(ctx, options.autoRenew);
  }
  return purchaseElsewhere(ctx, files, {
    years: options.years,
    autoRenew: options.autoRenew ?? true,
    ...(options.maxPrice === undefined ? {} : { maxPrice: options.maxPrice }),
    ...(options.account === undefined ? {} : { account: options.account }),
  });
}

/** Stops when the registrar's API cannot sell domains (or give a price for one). */
function cannotBuyHere(ctx: PurchaseContext): OpsCrewError {
  const { deps, domain } = ctx;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew cannot buy domains through ${nameOf(ctx)}'s API, so it cannot buy ${domain} there. Nothing was bought.`,
    {
      hint: `Buy it in ${registrarDashboard(ctx.registrarId, deps.env)}, then run \`opscrew domain connect ${domain}\`.`,
    },
  );
}

/** The registrar's quote, checked; its refusals stop the run saying nothing was bought. */
async function quoteElsewhere(ctx: PurchaseContext, years: number): Promise<RegistrationQuote> {
  const { deps, domain } = ctx;
  const name = nameOf(ctx);
  const quote = ctx.registrar.quote;
  if (quote === undefined) throw cannotBuyHere(ctx);
  let answer: RegistrationQuote;
  try {
    answer = await quote.call(ctx.registrar, domain, years);
  } catch (error) {
    if (isUserFacingError(error)) {
      throw new OpsCrewError(
        error.code as ErrorCode,
        `${providerText(deps, error.message)}. Nothing was bought.`,
        { ...(error.hint ? { hint: `${providerText(deps, error.hint)}.` } : {}), cause: error },
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

/** A new purchase: account check, quote, bounds, approval, record, register once, wait, set up. */
async function purchaseElsewhere(
  ctx: PurchaseContext,
  files: ProjectFiles,
  options: { years: number; autoRenew: boolean; maxPrice?: MaxPrice; account?: string },
): Promise<BuyDomainResult> {
  const { deps, domain, registrar } = ctx;
  const { years, autoRenew, maxPrice } = options;
  const name = nameOf(ctx);
  const links = registrarLinks(ctx.registrarId, deps.env);
  if (!capabilitiesOf(registrar).purchase || registrar.quote === undefined) {
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
              ? `Check the API access of your ${name} account at ${links.api}, then run \`${buyCommandOf(domain, ctx.registrarId)}\` again.`
              : providerText(deps, check.fix).concat("."),
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
  const charge = { charge: quote.price, exact: true };
  if (
    balance !== undefined &&
    balance.currency === quote.price.currency &&
    cents(balance.amount) < cents(quote.price.amount)
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your ${name} account balance (${formatMoneyCode(balance)}) is lower than the price of ${domain} (${formatMoneyCode(quote.price)}). Nothing was bought.`,
      {
        hint: `${name} pays API purchases from the account balance. Add funds in ${registrarDashboard(ctx.registrarId, deps.env)}, then run \`${buyCommandOf(domain, ctx.registrarId)}\` again.`,
      },
    );
  }
  if (maxPrice !== undefined) checkMaxPrice(domain, charge, years, maxPrice, name);
  if (!deps.interactive && maxPrice === undefined) {
    const command = exactBuyCommand(ctx, { ...options, quote: charge });
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Buying ${domain} at ${name} costs ${formatMoneyCode(quote.price)} now (${yearsText(years)}) and cannot be refunded, so a run without a terminal needs the domain typed again and a price limit. Nothing was bought.`,
      {
        hint: `Run \`${command}\` (the most you agree to pay), or run \`${buyCommandOf(domain, ctx.registrarId)}\` in an interactive terminal.`,
      },
    );
  }
  // After the quote: GoDaddy's summary names the contact source of that quote. Already masked by
  // the adapter; made safe again (no email address or phone number) before it is shown.
  const summary =
    registrar.contactSummary === undefined ? undefined : await registrar.contactSummary();
  const contact = summary === undefined ? undefined : providerText(deps, summary);

  const decision = await deps.approvals.request({
    kind: "domain-purchase",
    title: `Buy ${domain} at ${name} for ${formatMoney(quote.price)} (${yearsText(years)})`,
    details: purchaseDetails(ctx, files, { years, autoRenew, quote, contact, balance }),
    // Typed in a terminal, `--confirm <domain>` in scripts; `--yes` never grants it.
    confirmPhrase: domain,
  });
  if (!decision.approved) throw purchaseRefused(ctx, decision.reason);

  // Right before buying: the quote's validity and the account's registrations again (the
  // approval may have taken a while). The registrar binds the price itself (Porkbun sends it as
  // the cost, Namecheap compares it, GoDaddy's quote token locks it).
  if (quote.expiresAt !== undefined && Date.parse(quote.expiresAt) <= deps.clock.now().getTime()) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The ${name} price for ${domain} expired at ${formatTime(quote.expiresAt)} while you were deciding. Nothing was bought.`,
      { hint: `Run \`${buyCommandOf(domain, ctx.registrarId)}\` again to get a new price.` },
    );
  }
  if ((await registrar.registrationStatus(domain)) !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A purchase of ${domain} started in your ${name} account while you were deciding, so OpsCrew did not send another one.`,
      { hint: `Run \`${buyCommandOf(domain, ctx.registrarId)}\` again to continue that purchase.` },
    );
  }

  const record: PurchaseRecord = {
    domain,
    accountId: ctx.account.id,
    requestedAt: deps.clock.now().toISOString(),
    years,
    autoRenew,
    total: quote.price,
    registrar: ctx.registrarId,
    // Created once with the note and reused on every resumed run.
    idempotencyKey: ctx.services.randomUUID(),
  };
  await createPurchaseRecord(ctx.recordFile, record);
  deps.reporter.step(`Buying ${domain} at ${name}…`);
  const first = await sendPurchase(ctx, record, quote);
  await waitForRegistration(ctx, first);
  return finishElsewhere(ctx, { autoRenew, total: quote.price });
}

/** The approval text of a purchase at another registrar. */
function purchaseDetails(
  ctx: PurchaseContext,
  files: ProjectFiles,
  options: {
    years: number;
    autoRenew: boolean;
    quote: RegistrationQuote;
    contact: string | undefined;
    balance: Money | undefined;
  },
): string {
  const { deps, domain, account, registrar } = ctx;
  const { years, autoRenew, quote, contact, balance } = options;
  const name = nameOf(ctx);
  const page = registrarLinks(ctx.registrarId, deps.env).domains;
  const caps = capabilitiesOf(registrar);
  const renewal =
    quote.renewal === undefined
      ? `${name} did not quote the renewal price; check it at ${page} before the domain renews`
      : `${formatMoney(quote.renewal)} per year`;
  const lines = [
    `Domain: ${domain}`,
    `Registrar: ${name}`,
    caps.chooseYears
      ? `Years: ${years}`
      : `Term: the registry minimum (${yearsText(years)}); ${name} registers no other term, and renewals extend it.`,
    `Charged now: ${formatMoney(quote.price)}${years === 1 ? "" : ` for ${yearsText(years)}`}`,
    quote.renewal === undefined ? `Renewal: ${renewal}.` : `Renewal: ${renewal}`,
  ];
  if (quote.expiresAt !== undefined)
    lines.push(`Price valid until: ${formatTime(quote.expiresAt)}`);
  lines.push(
    caps.autoRenew
      ? autoRenew
        ? `Auto-renew: on. ${name} charges the renewal (${renewal}) to your ${name} account before the domain expires. Turn it off any time with \`opscrew domain auto-renew off\`.`
        : `Auto-renew: off. The domain expires after ${yearsText(years)} unless you renew it; turn auto-renew on with \`opscrew domain auto-renew on\`.`
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
 * Approval lines about the move to Cloudflare: zone, nameservers, DNSSEC, per the registrar's
 * capabilities (stand-in zones in a registrar sandbox: says so). `dnssecLater`: the zone is not
 * active, so DNSSEC is left to `opscrew domain connect`.
 */
function switchLines(ctx: PurchaseContext, purchase: boolean, dnssecLater = false): string[] {
  const { deps, domain, registrar } = ctx;
  const name = nameOf(ctx);
  const page = registrarLinks(ctx.registrarId, deps.env).domains;
  const caps: RegistrarCapabilities = capabilitiesOf(registrar);
  if (ctx.services.zonesFor(ctx.registrarId).simulated === true) {
    return [
      `Cloudflare zone: a stand-in (the ${name} sandbox domain does not exist at Cloudflare); OpsCrew sets stand-in Cloudflare nameservers in the sandbox, and DNSSEC stays off.`,
    ];
  }
  return [
    purchase
      ? `Cloudflare zone: right after the purchase OpsCrew creates a Cloudflare zone for ${domain} in this account (an existing zone in this account is reused).`
      : `Cloudflare zone: created for ${domain} in this account if it does not exist there yet (an existing zone in this account is reused).`,
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

function switchContext(ctx: PurchaseContext): SwitchContext {
  return { deps: ctx.deps, account: ctx.account, zones: ctx.services.zonesFor(ctx.registrarId) };
}

function switchTarget(ctx: PurchaseContext) {
  return { domain: ctx.domain, registrarId: ctx.registrarId, registrar: ctx.registrar };
}

/**
 * Applies the auto-renew choice (approved with the purchase or the setup) where the API can;
 * otherwise returns a next step with the dashboard link when the registrar's setting differs.
 */
async function applyAutoRenew(
  ctx: PurchaseContext,
  info: RegisteredDomain,
  wanted: boolean | undefined,
): Promise<{ info: RegisteredDomain; next?: string }> {
  if (wanted === undefined || info.autoRenew === wanted) return { info };
  const name = nameOf(ctx);
  if (!capabilitiesOf(ctx.registrar).autoRenew) {
    const page = registrarLinks(ctx.registrarId, ctx.deps.env).domains;
    return {
      info,
      next: `Turn auto-renew ${wanted ? "on" : "off"} for ${ctx.domain} at ${page}: ${name}'s API cannot change it, and it is ${info.autoRenew ? "on" : "off"} there now.`,
    };
  }
  const updated = await ctx.registrar.setAutoRenew(ctx.domain, wanted);
  await auditDomain(
    ctx.deps,
    "set auto-renew",
    ctx.domain,
    `${name}: auto-renew ${wanted ? "on" : "off"}`,
  );
  return { info: updated };
}

/**
 * After a purchase succeeded (approved with the purchase, here or in an earlier run): the switch
 * to Cloudflare, auto-renew, project files, record removal. A failure keeps the purchase record so
 * the next run finishes the setup without buying again.
 */
export async function finishElsewhere(
  ctx: PurchaseContext,
  options: { autoRenew: boolean; total?: Money },
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  let files: ProjectFiles;
  let changes: ProjectChanges;
  let switched: SwitchResult;
  let info: RegisteredDomain;
  let renewNext: string | undefined;
  let recorded = { plan: false, requirements: false };
  let keptDomain: string | undefined;
  try {
    // The project files as they are now (waiting for the registrar can take minutes).
    files = await readProjectFiles(deps);
    changes = projectChanges(files, domain);
    if (changes.replaces !== undefined && !(await approveDomainSwitch(ctx, files, changes))) {
      keptDomain = changes.replaces;
    }
    switched = await switchToCloudflare(switchContext(ctx), switchTarget(ctx));
    const applied = await applyAutoRenew(ctx, await registeredDetails(ctx), options.autoRenew);
    info = { ...applied.info, registrar: ctx.registrarId };
    renewNext = applied.next;
    if (keptDomain === undefined) {
      recorded = await recordDomain(deps, files, {
        domain,
        hostname: changes.hostname,
        info,
        dnssec: switched.dnssec,
      });
    }
  } catch (error) {
    throw setupFailed(ctx, error);
  }
  await removePurchaseRecord(ctx.recordFile);
  return completedElsewhere(ctx, {
    files,
    hostname: changes.hostname,
    switched,
    info,
    recorded,
    ...(renewNext === undefined ? {} : { renewNext }),
    ...(keptDomain === undefined ? {} : { keptDomain }),
    ...(options.total === undefined ? {} : { total: options.total }),
    alreadyRegistered: false,
  });
}

/**
 * Whether the domain's zone in the chosen Cloudflare account is active already (its nameservers
 * point at Cloudflare). Unknown counts as not active.
 */
async function zoneIsActive(ctx: PurchaseContext): Promise<boolean> {
  const zones = ctx.services.zonesFor(ctx.registrarId);
  if (zones.simulated === true) return false;
  const zone = await zones.findZone(ctx.domain).catch(() => undefined);
  return (
    zone?.status === "active" && (zone.accountId === undefined || zone.accountId === ctx.account.id)
  );
}

/**
 * A domain already in the account at another registrar: nothing is bought, and nothing changes
 * before a `domain-settings` approval listing every change (zone, nameserver switch, DNSSEC,
 * auto-renew when asked for, project files). Refusal changes nothing. The domain may be live, so
 * its DS record is published only when its zone is active already; otherwise DNSSEC is left to
 * `opscrew domain connect`, which adds it once the zone is active.
 */
async function setUpOwnedElsewhere(
  ctx: PurchaseContext,
  autoRenew: boolean | undefined,
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  const name = nameOf(ctx);
  const page = registrarLinks(ctx.registrarId, deps.env).domains;
  const caps = capabilitiesOf(ctx.registrar);
  const files = await readProjectFiles(deps);
  const details = await registeredDetails(ctx).catch((error: unknown) => {
    throw setupFailed(ctx, error);
  });
  const changes = projectChanges(files, domain);
  const autoRenewChange =
    autoRenew !== undefined && autoRenew !== details.autoRenew ? autoRenew : undefined;
  // Stand-in zones (registrar sandbox) skip DNSSEC anyway.
  const simulated = ctx.services.zonesFor(ctx.registrarId).simulated === true;
  const dnssecNow = simulated || (await zoneIsActive(ctx));
  const lines = [
    `${domain} is already registered in your ${name} account, so nothing is bought.`,
    ...switchLines(ctx, false, !dnssecNow),
  ];
  if (autoRenewChange !== undefined) {
    lines.push(
      caps.autoRenew
        ? autoRenewApproval(
            domain,
            details,
            autoRenewChange,
            await renewalPrice(ctx.registrar, domain),
            ctx.registrarId,
          ).details
        : `Auto-renew: ${name}'s API cannot change it, so it stays ${details.autoRenew ? "on" : "off"}; turn it ${autoRenewChange ? "on" : "off"} at ${page}.`,
    );
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
      {
        hint: `Run \`${buyCommandOf(domain, ctx.registrarId)}\` again when you want to set it up.`,
      },
    );
  }

  let switched: SwitchResult;
  let info: RegisteredDomain;
  let renewNext: string | undefined;
  let recorded: { plan: boolean; requirements: boolean };
  try {
    switched = await switchToCloudflare(switchContext(ctx), switchTarget(ctx), {
      publishDs: dnssecNow,
    });
    const applied = await applyAutoRenew(ctx, details, autoRenewChange);
    info = { ...applied.info, registrar: ctx.registrarId };
    renewNext = applied.next;
    recorded = await recordDomain(deps, files, {
      domain,
      hostname: changes.hostname,
      info,
      dnssec: switched.dnssec,
    });
  } catch (error) {
    throw setupFailed(ctx, error);
  }
  return completedElsewhere(ctx, {
    files,
    hostname: changes.hostname,
    switched,
    info,
    recorded,
    ...(renewNext === undefined ? {} : { renewNext }),
    alreadyRegistered: true,
  });
}

/** Audit, success message and next steps after a purchase or a setup at another registrar. */
async function completedElsewhere(
  ctx: PurchaseContext,
  result: {
    files: ProjectFiles;
    hostname: string;
    switched: SwitchResult;
    info: RegisteredDomain;
    recorded: { plan: boolean; requirements: boolean };
    renewNext?: string;
    keptDomain?: string;
    total?: Money;
    alreadyRegistered: boolean;
  },
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  const { files, hostname, info, keptDomain, switched } = result;
  const name = nameOf(ctx);
  const page = registrarLinks(ctx.registrarId, deps.env).domains;
  const simulated = ctx.services.zonesFor(ctx.registrarId).simulated === true;
  const { zone, nameservers, ds } = switched;
  const what = result.alreadyRegistered
    ? "already registered; set up"
    : `bought${result.total === undefined ? "" : ` (approved price ${formatMoney(result.total)})`}`;
  await auditDomain(
    deps,
    "domain purchase",
    domain,
    `${what} at ${name}; expires ${formatDate(info.expiresAt)}; auto-renew ${info.autoRenew ? "on" : "off"}; nameservers ${nameservers.outcome}; DS record ${ds.outcome}; zone ${zone.id}`,
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
    skipped: "no Cloudflare zone or DNSSEC (registrar sandbox)",
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
  if (!simulated) {
    next.push(
      `Cloudflare activates the zone for ${domain} once the registry publishes the new nameservers, usually within an hour and sometimes up to a day.`,
    );
  }
  if (keptDomain !== undefined) {
    deps.reporter.warn(
      `${files.plan === undefined ? "opscrew/requirements.yaml" : "The plan"} still uses ${keptDomain}. ${domain} stays registered at ${name} and set up on Cloudflare.`,
    );
  }
  const step = projectNextStep(files, domain, hostname, keptDomain);
  next.push(simulated ? step : `${step} ${zoneTokenNote(domain)}`);
  return {
    outcome: "set-up",
    domain: info,
    zoneId: zone.id,
    ...(result.total === undefined ? {} : { total: result.total }),
    alreadyRegistered: result.alreadyRegistered,
    recorded: result.recorded,
    next,
    registrar: ctx.registrarId,
    nameservers: nameservers.nameservers,
  };
}
