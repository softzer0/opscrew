import type { Money, Registrar, RegistrarId } from "@opscrew/contracts";
import { OpsCrewError, plural } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { requireNoMoveInProgress } from "../provision/guard";
import { localhostNotSupported } from "../shared/vps-target";
import { cloudflareFlow, registrarRead } from "./cloudflare";
import {
  auditDomain,
  formatDate,
  formatMoney,
  parseDomainName,
  parseMaxPrice,
  parseYears,
  requireCloudflareToken,
  resolveAccount,
} from "./common";
import { elsewhereFlow, requireRegistrarYears } from "./elsewhere";
import { buyCommandOf, registrarDashboard } from "./links";
import {
  approveDomainSwitch,
  type ProjectFiles,
  projectChanges,
  projectLines,
  readProjectFiles,
  recordDomain,
} from "./project";
import {
  applyAutoRenew,
  autoRenewLine,
  chargeCode,
  checkMaxPrice,
  type DnsSetup,
  exactBuyCommand,
  formatTime,
  purchaseRefused,
  type RegistrarFlow,
  registeredDetails,
  registeredWhere,
  sendPurchase,
  setupFailed,
} from "./purchase";
import {
  createPurchaseRecord,
  otherPurchaseInProgress,
  type PurchaseRecord,
  purchaseRecordPath,
  readPurchaseRecord,
  removePurchaseRecord,
  UNSENT_PURCHASE_AGE_MS,
} from "./record";
import { parseRegistrarId, REGISTRAR_NAMES } from "./registrars";
import { type ResolvedDomainServices, resolveDomainServices } from "./services";
import type { BuyDomainOptions, BuyDomainResult, DomainAccount, MaxPrice } from "./types";
import { type PurchaseContext, waitForRegistration } from "./wait";

/**
 * `opscrew domain buy`: buys a domain and sets it up, through the user's Cloudflare account
 * (default) or their Porkbun, Namecheap or GoDaddy account (`registrar`), whose domain then points
 * at a Cloudflare zone. One flow for every registrar (`RegistrarFlow` holds what differs: the
 * quote, the DNS setup and its approval lines, the summary).
 *
 * Safety (constitution I): a live price check, an optional price bound (`maxPrice`, required in
 * non-interactive runs), a `domain-purchase` approval with the price and the typed domain name,
 * a check right before buying (stops when the price rose, the quote expired or a purchase started
 * meanwhile), then exactly one `register` call. A purchase record written before `register` (with
 * the registrar and, for other registrars, an idempotency key), plus the registration status
 * checked before any purchase, make reruns continue an interrupted purchase instead of buying
 * again; the record is never cleared on a guess (see `continueRecorded`). Afterwards: the zone
 * (created in the account, or reused), DNSSEC, the auto-renew choice, and the domain recorded in
 * `opscrew/requirements.yaml` and `opscrew/plan.yaml` (another domain there is only replaced
 * after a `repo-write` approval).
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
  const registrarId =
    options.registrar === undefined ? "cloudflare" : parseRegistrarId(options.registrar);
  // Every registrar needs the token: the domain's zone lives in Cloudflare.
  requireCloudflareToken(
    deps,
    registrarId === "cloudflare"
      ? undefined
      : `After buying at ${REGISTRAR_NAMES[registrarId]}, OpsCrew sets the domain up in a Cloudflare zone`,
  );
  const services = resolveDomainServices(deps, options.services);
  // Read (and validate) the project files before anything costs money.
  const files = await readProjectFiles(deps);
  if (files.plan?.target.provider === "localhost") {
    throw localhostNotSupported("`opscrew domain buy`");
  }
  if (files.plan !== undefined) requireNoMoveInProgress(files.plan);

  const recordFile = purchaseRecordPath(deps.paths);
  const record = await readPurchaseRecord(recordFile);
  const command = buyCommandOf(domain, registrarId);
  if (options.forgetPendingPurchase === true && record === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has no unfinished domain purchase to forget.",
      { hint: `Run \`${command}\` without --forget-pending-purchase.` },
    );
  }
  // A new purchase elsewhere: the registrar is set up and can register these years, before any call.
  if (record === undefined && registrarId !== "cloudflare") {
    requireRegistrarYears(registrarId, services.otherRegistrar(registrarId), domain, years);
  }
  const accounts = await services.accounts();
  if (record !== undefined && options.forgetPendingPurchase === true) {
    // Forgetting ends the run: buying is a separate run with its own checks and approval.
    await forgetPurchase(deps, services, accounts, record, recordFile);
    return {
      outcome: "forgotten",
      forgotten: record.domain,
      next: [
        `Run \`${command}\` (without --forget-pending-purchase) to buy ${domain}; OpsCrew checks ${REGISTRAR_NAMES[registrarId]}, shows the price and asks before buying.`,
      ],
    };
  }
  if (record !== undefined && record.domain !== domain) {
    throw otherPurchaseInProgress(record, domain, { requested: registrarId, env: deps.env });
  }
  if (record !== undefined && record.registrar !== registrarId) {
    throw otherRegistrarInProgress(deps, record, registrarId);
  }

  const account =
    record === undefined
      ? resolveAccount(accounts, options.account)
      : recordedAccount(accounts, record, options.account);
  const ctx: PurchaseContext = {
    deps,
    services,
    registrar: registrarOf(services, registrarId, account),
    registrarId,
    account,
    zones: services.zonesFor(registrarId),
    domain,
    recordFile,
  };
  if (record !== undefined) return continueRecorded(ctx, record, options.autoRenew);
  return buyOrSetUp(ctx, files, {
    years,
    maxPrice,
    autoRenew: options.autoRenew,
    account: options.account,
  });
}

/** The flow of the registrar a purchase is made with. */
function flowOf(ctx: PurchaseContext): RegistrarFlow {
  return ctx.registrarId === "cloudflare" ? cloudflareFlow(ctx) : elsewhereFlow(ctx);
}

/** The adapter a purchase is made with. */
function registrarOf(
  services: ResolvedDomainServices,
  registrarId: RegistrarId,
  account: DomainAccount,
): Registrar {
  return registrarId === "cloudflare"
    ? services.registrar(account.id)
    : services.otherRegistrar(registrarId);
}

/** Stops because the unfinished purchase of this domain was sent to another registrar. */
function otherRegistrarInProgress(
  deps: PhaseDeps,
  record: PurchaseRecord,
  requested: RegistrarId,
): OpsCrewError {
  const at = record.registrar;
  const { domain } = record;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew started buying ${domain} at ${REGISTRAR_NAMES[at]} on ${formatDate(record.requestedAt, record.requestedAt)}, not at ${REGISTRAR_NAMES[requested]}, and that purchase has not finished.`,
    {
      hint: `Run \`${buyCommandOf(domain, at)}\` to finish it. If ${registrarDashboard(at, deps.env)} does not list ${domain} and you were not charged for it, run \`opscrew domain buy ${domain} --forget-pending-purchase\` to clear OpsCrew's note (that run buys nothing), then run \`${buyCommandOf(domain, requested)}\`.`,
    },
  );
}

/** The account a recorded purchase was made on; a different `--account` stops the run. */
function recordedAccount(
  accounts: readonly DomainAccount[],
  record: PurchaseRecord,
  requested: string | undefined,
): DomainAccount {
  const account = accounts.find((a) => a.id === record.accountId);
  const wanted = requested?.trim();
  const command = buyCommandOf(record.domain, record.registrar);
  if (
    wanted &&
    wanted !== record.accountId &&
    account?.name.toLowerCase() !== wanted.toLowerCase()
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew started buying ${record.domain} on the Cloudflare account ${record.accountId}, not "${wanted}".`,
      {
        hint: `Run \`${command} --account ${record.accountId}\` (or without --account) to finish that purchase.`,
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

/**
 * An earlier run recorded this purchase: continue it when the registrar shows it, never send it
 * again. When the registrar shows nothing, the record stays unless it has no outcome (the run
 * stopped before or while sending) and is at least 30 minutes old by the wall clock, with both
 * reads in this run answering "none". An `uncertain` or `accepted` record is only cleared by the
 * user (`forgetPendingPurchase`).
 */
async function continueRecorded(
  ctx: PurchaseContext,
  record: PurchaseRecord,
  autoRenew: boolean | undefined,
): Promise<BuyDomainResult> {
  const { deps, domain, registrarId } = ctx;
  const name = REGISTRAR_NAMES[registrarId];
  const dashboard = registrarDashboard(registrarId, deps.env);
  const command = buyCommandOf(domain, registrarId);
  const status = await ctx.registrar.registrationStatus(domain);
  const owned = status === undefined ? await ctx.registrar.getDomain(domain) : undefined;
  if (status !== undefined || owned !== undefined) {
    deps.reporter.step(
      `Continuing the purchase of ${domain} that OpsCrew started on ${formatTime(record.requestedAt)}.`,
    );
    if (status !== undefined) await waitForRegistration(ctx, status);
    return finish(ctx, flowOf(ctx), {
      autoRenew: record.autoRenew ?? autoRenew ?? true,
      total: record.total,
    });
  }

  const when = formatTime(record.requestedAt);
  if (record.outcome === "uncertain") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} shows no purchase of ${domain}, but OpsCrew's purchase request of ${when} got no clear answer, so the purchase may still appear.`,
      {
        hint: `Check ${dashboard} and your ${name} billing. If ${domain} is listed, run \`${command}\` again to finish the setup. If it is not listed and you were not charged, run \`${command} --forget-pending-purchase\` to clear OpsCrew's note (that run buys nothing), then run \`${command}\` again to buy it.`,
      },
    );
  }
  if (record.outcome === "accepted") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} accepted the order for ${domain} at ${when} but does not list it in your account yet; an order the registry does not confirm at once can take a few hours.`,
      {
        hint: `Run \`${command}\` again later: OpsCrew continues the same purchase and never sends a second one. If ${dashboard} still shows no order for ${domain} after a day and you were not charged, run \`${command} --forget-pending-purchase\` to clear OpsCrew's note (that run buys nothing).`,
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
      `cleared OpsCrew's purchase note: ${name} shows no purchase 30 minutes after it started`,
    );
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} shows no purchase of ${domain}, ${Math.floor(age / 60_000)} minutes after OpsCrew started one (${when}), so OpsCrew cleared its note about it.`,
      {
        hint: `Run \`${command}\` again to buy it; OpsCrew shows the price and asks again first.`,
      },
    );
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${name} shows no purchase of ${domain} yet. OpsCrew started one at ${when} and stopped before it finished.`,
    {
      hint: `Wait a few minutes and run \`${command}\` again, or check ${dashboard}. OpsCrew never sends the purchase twice; it clears its note once ${name} still shows no purchase 30 minutes after it started.`,
    },
  );
}

/**
 * Clears the note about an unfinished purchase (any domain, at the registrar it was sent to), only
 * while that registrar shows no purchase of it and after a typed `domain-settings` approval that
 * tells the user to check the registrar's dashboard and billing first.
 */
async function forgetPurchase(
  deps: PhaseDeps,
  services: ResolvedDomainServices,
  accounts: readonly DomainAccount[],
  record: PurchaseRecord,
  recordFile: string,
): Promise<void> {
  const account = recordedAccount(accounts, record, undefined);
  const at = record.registrar;
  const name = REGISTRAR_NAMES[at];
  const dashboard = registrarDashboard(at, deps.env);
  const command = buyCommandOf(record.domain, at);
  const registrar = registrarOf(services, at, account);
  const status = await registrar.registrationStatus(record.domain);
  const owned = status === undefined ? await registrar.getDomain(record.domain) : undefined;
  if (status !== undefined || owned !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${name} shows a purchase of ${record.domain}, so OpsCrew keeps its note about it.`,
      {
        hint: `Run \`${command}\` (without --forget-pending-purchase) to continue it.`,
      },
    );
  }
  const when = formatTime(record.requestedAt);
  const check = `Check ${dashboard} and your ${name} billing for ${record.domain} first.`;
  deps.reporter.warn(
    `${name} shows no purchase of ${record.domain}, but OpsCrew started one at ${when}. ${check}`,
  );
  const outcome =
    record.outcome === "uncertain"
      ? ` and got no clear answer from ${name}`
      : record.outcome === "accepted"
        ? `, and ${name} accepted the order`
        : "";
  const where =
    at === "cloudflare"
      ? `on the account ${account.name} (${account.id})`
      : `in your ${name} account`;
  const decision = await deps.approvals.request({
    kind: "domain-settings",
    title: `Forget the unfinished purchase of ${record.domain}`,
    details: [
      `OpsCrew started buying ${record.domain} at ${when}${outcome}.`,
      `${name} shows no purchase of ${record.domain} ${where} now.`,
      `${check} If it is listed there or you were charged for it, do not continue; run \`${command}\` later instead.`,
      `Forgetting removes OpsCrew's note, so ${record.domain} can be bought again (OpsCrew still checks ${name} and asks before buying).`,
    ].join("\n"),
    confirmPhrase: record.domain,
  });
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `OpsCrew keeps its note about the purchase of ${record.domain}; nothing was changed.`,
      {
        hint: `Run \`${command}\` to continue it once ${name} shows it.`,
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

interface PurchaseOptions {
  years: number;
  autoRenew?: boolean;
  maxPrice?: MaxPrice;
  account?: string;
}

/**
 * A domain already in the account (bought earlier, elsewhere, or a purchase under way) is never
 * bought again: OpsCrew waits for a purchase under way and sets the domain up. Otherwise a new
 * purchase.
 */
async function buyOrSetUp(
  ctx: PurchaseContext,
  files: ProjectFiles,
  options: PurchaseOptions,
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  const flow = flowOf(ctx);
  const existing = await registrarRead(ctx, () => ctx.registrar.registrationStatus(domain));
  const owned =
    existing === undefined
      ? await registrarRead(ctx, () => ctx.registrar.getDomain(domain))
      : undefined;
  if (existing === undefined && owned === undefined) return purchase(ctx, flow, files, options);
  // Before any wait or approval: never move the DNS of a domain OpsCrew may not set up.
  await flow.takeOver(files);
  const where = registeredWhere(ctx);
  if (existing !== undefined && existing.state !== "succeeded") {
    if (existing.state === "pending" || existing.state === "in_progress") {
      deps.reporter.info(
        `${REGISTRAR_NAMES[ctx.registrarId]} is already registering ${domain} ${where}; OpsCrew waits for that and does not buy the domain again.`,
      );
    }
    await waitForRegistration(ctx, existing);
  } else {
    deps.reporter.info(
      `${domain} is already registered ${where}, so OpsCrew does not buy it again.`,
    );
  }
  return setUpOwned(ctx, flow, options.autoRenew);
}

/** A new purchase: quote, bound, approve, re-check, record, register once, wait, set up. */
async function purchase(
  ctx: PurchaseContext,
  flow: RegistrarFlow,
  files: ProjectFiles,
  options: PurchaseOptions,
): Promise<BuyDomainResult> {
  const { deps, domain, account, registrarId } = ctx;
  const { years, maxPrice } = options;
  const autoRenew = options.autoRenew ?? true;
  const name = REGISTRAR_NAMES[registrarId];
  const at = registrarId === "cloudflare" ? "" : ` at ${name}`;
  const command = buyCommandOf(domain, registrarId);
  const offer = await flow.quote(years, autoRenew);
  if (maxPrice !== undefined) checkMaxPrice(domain, offer, years, maxPrice, name);
  if (!deps.interactive && maxPrice === undefined) {
    const exact = exactBuyCommand(ctx, {
      years,
      autoRenew,
      account: options.account,
      quote: offer,
    });
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Buying ${domain}${at} costs ${chargeCode(offer)} now (${plural(years, "year")}) and cannot be refunded, so a run without a terminal needs the domain typed again and a price limit. Nothing was bought.`,
      {
        hint: `Run \`${exact}\` (the most you agree to pay), or run \`${command}\` in an interactive terminal.`,
      },
    );
  }

  const decision = await deps.approvals.request({
    kind: "domain-purchase",
    title: `Buy ${domain}${at} for ${offer.exact ? "" : "at most "}${formatMoney(offer.charge)} (${plural(years, "year")})`,
    details: [
      ...(await offer.approvalLines()),
      ...projectLines(files, domain, "purchase"),
      "Domain purchases cannot be refunded.",
    ].join("\n"),
    // Typed in a terminal, `--confirm <domain>` in scripts; `--yes` never grants it.
    confirmPhrase: domain,
  });
  if (!decision.approved) throw purchaseRefused(ctx, decision.reason);

  // Right before buying: the price and the account's registrations again (the approval may have
  // taken a while).
  await offer.recheck();
  if ((await ctx.registrar.registrationStatus(domain)) !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A purchase of ${domain} started ${registeredWhere(ctx)} while you were deciding, so OpsCrew did not send another one.`,
      { hint: `Run \`${command}\` again to continue that purchase.` },
    );
  }

  const record: PurchaseRecord = {
    domain,
    accountId: account.id,
    requestedAt: deps.clock.now().toISOString(),
    years,
    autoRenew,
    // The approved bound: never more than what the user saw.
    total: offer.charge,
    registrar: registrarId,
    // Created once with the note and reused on every resumed run (Cloudflare takes none).
    idempotencyKey: registrarId === "cloudflare" ? undefined : ctx.services.randomUUID(),
  };
  await createPurchaseRecord(ctx.recordFile, record);
  deps.reporter.step(`Buying ${domain}${at}…`);
  const first = await sendPurchase(ctx, record, offer.quote);
  await waitForRegistration(ctx, first);
  return finish(ctx, flow, { autoRenew, total: offer.charge });
}

/**
 * After a purchase succeeded (approved with the purchase, here or in an earlier run): the DNS
 * setup, auto-renew, project files, record removal. A failure keeps the purchase record so the
 * next run finishes the setup without buying again.
 */
async function finish(
  ctx: PurchaseContext,
  flow: RegistrarFlow,
  options: { autoRenew: boolean; total: Money | undefined },
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  let files: ProjectFiles;
  let hostname: string;
  let dns: DnsSetup;
  let applied: Awaited<ReturnType<typeof applyAutoRenew>>;
  let recorded = { plan: false, requirements: false };
  let keptDomain: string | undefined;
  try {
    // The project files as they are now (waiting for the registrar can take minutes).
    files = await readProjectFiles(deps);
    const changes = projectChanges(files, domain);
    hostname = changes.hostname;
    if (
      changes.replaces !== undefined &&
      !(await approveDomainSwitch(deps, files, domain, changes, {
        done: `OpsCrew bought ${domain}`,
        stays: "stays bought",
      }))
    ) {
      keptDomain = changes.replaces;
    }
    dns = await flow.setUp(true);
    applied = await applyAutoRenew(ctx, await registeredDetails(ctx), options.autoRenew);
    if (keptDomain === undefined) {
      recorded = await recordDomain(deps, files, {
        domain,
        hostname,
        info: applied.info,
        dnssec: dns.dnssec === true,
      });
    }
  } catch (error) {
    throw setupFailed(ctx, error);
  }
  await removePurchaseRecord(ctx.recordFile);
  return flow.summary({
    files,
    hostname,
    dns,
    info: applied.info,
    recorded,
    renewNext: applied.next,
    keptDomain,
    total: options.total,
    alreadyRegistered: false,
  });
}

/**
 * A domain already in the account: nothing is bought, and nothing changes before a
 * `domain-settings` approval listing every change (the DNS setup, auto-renew when asked for,
 * project files). Refusal changes nothing.
 */
async function setUpOwned(
  ctx: PurchaseContext,
  flow: RegistrarFlow,
  autoRenew: boolean | undefined,
): Promise<BuyDomainResult> {
  const { deps, domain } = ctx;
  const files = await readProjectFiles(deps);
  const details = await registeredDetails(ctx).catch((error: unknown) => {
    throw setupFailed(ctx, error);
  });
  const changes = projectChanges(files, domain);
  const autoRenewChange =
    autoRenew !== undefined && autoRenew !== details.autoRenew ? autoRenew : undefined;
  const owned = await flow.owned();
  const lines = [...owned.lines];
  if (autoRenewChange !== undefined) {
    lines.push(await autoRenewLine(ctx, details, autoRenewChange));
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

  let dns: DnsSetup;
  let applied: Awaited<ReturnType<typeof applyAutoRenew>>;
  let recorded: { plan: boolean; requirements: boolean };
  try {
    dns = await flow.setUp(owned.publishDs);
    applied = await applyAutoRenew(ctx, details, autoRenewChange);
    recorded = await recordDomain(deps, files, {
      domain,
      hostname: changes.hostname,
      info: applied.info,
      dnssec: dns.dnssec === true,
    });
  } catch (error) {
    throw setupFailed(ctx, error);
  }
  return flow.summary({
    files,
    hostname: changes.hostname,
    dns,
    info: applied.info,
    recorded,
    renewNext: applied.next,
    alreadyRegistered: true,
  });
}
