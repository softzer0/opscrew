import { randomUUID } from "node:crypto";
import type {
  DomainCheck,
  DsRecord,
  Money,
  RegisteredDomain,
  Registrar,
  RegistrarAccountCheck,
  RegistrarCapabilities,
  RegistrarDnsRecord,
  RegistrationQuote,
  RegistrationRequest,
  RegistrationStatus,
} from "@opscrew/contracts";
import { isUserFacingError, listText, normalizeHostName, OpsCrewError } from "@opscrew/core";
import type {
  PorkbunAvailability,
  PorkbunClient,
  PorkbunDomain,
  PorkbunTldRequirements,
} from "./client";
import { dollars, isDomainName, normalizeDomain, tldOf } from "./parse";
import {
  KEYS_HINT,
  PORKBUN_API_SETTINGS_URL,
  PORKBUN_CREDIT_URL,
  PORKBUN_DASHBOARD_URL,
  PORKBUN_WEBSITE,
} from "./problems";

/** The client calls {@link PorkbunRegistrar} needs (a `PorkbunClient` or a test fake). */
export type PorkbunRegistrarApi = Pick<
  PorkbunClient,
  | "sandbox"
  | "ping"
  | "balance"
  | "checkDomains"
  | "registrationRequirements"
  | "previewDomain"
  | "createDomain"
  | "getDomain"
  | "updateAutoRenew"
  | "getNs"
  | "updateNs"
  | "retrieveRecords"
  | "getDnssecRecords"
  | "createDnssecRecord"
  | "deleteDnssecRecord"
>;

export interface PorkbunRegistrarOptions {
  /** Idempotency keys for purchases without one (injected in tests). */
  randomUUID?: () => string;
  /** Clock in milliseconds (injected in tests). */
  now?: () => number;
  /** Waits before a purchase to respect Porkbun's create rate limit (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Porkbun allows one `/domain/create` attempt (dry run or real) per second per account. */
const CREATE_INTERVAL_MS = 1000;

/** Extensions `suggest` tries for a bare name (checked live in one request). */
const SUGGESTED_TLDS = ["com", "net", "org", "dev", "app", "io", "co", "xyz"] as const;

/**
 * What each Porkbun key permission (`x-porkbun-scope`) lets OpsCrew do beyond `read` (checking,
 * prices, reading DNS records and DNSSEC). OpsCrew never writes Porkbun DNS records, so it does
 * not need `dns`.
 */
const SCOPE_FEATURES = [
  { scope: "purchase", feature: "buying domains" },
  { scope: "domains", feature: "changing nameservers, auto-renew and DNSSEC" },
] as const;

const usd = (cents: number): Money => ({ amount: cents / 100, currency: "USD" });

function websiteThenConnect(domain: string): string {
  return `Buy ${domain} on ${PORKBUN_WEBSITE}, then run \`opscrew domain connect ${domain}\`.`;
}

function isPorkbunNameserver(host: string): boolean {
  return host === "porkbun.com" || host.endsWith(".porkbun.com");
}

/**
 * Why a checked domain cannot be bought through Porkbun's API, or undefined when it can. Uses the
 * extension's requirements when known.
 */
function unavailableReason(
  item: PorkbunAvailability,
  requirements: PorkbunTldRequirements | undefined,
): string | undefined {
  const d = item.domain;
  if (!item.available) {
    return item.inYourAccount
      ? "This domain is already in your Porkbun account."
      : "This domain is already registered by someone else.";
  }
  if (item.premium) {
    return `This is a premium domain; Porkbun sells premium names only on its website. ${websiteThenConnect(d)}`;
  }
  if (requirements && !requirements.apiRegisterable) {
    const why = requirements.reason?.trim().replace(/\.$/, "");
    return `Porkbun does not register .${requirements.tld} domains through its API${why ? ` (${why})` : ""}. ${websiteThenConnect(d)}`;
  }
  if (item.idnLanguageRequired) {
    return `The registry needs a language for this internationalized name, which OpsCrew does not send. ${websiteThenConnect(d)}`;
  }
  if (item.priceCents === undefined) {
    return "Porkbun did not return a price for this domain; try again in a minute.";
  }
  return undefined;
}

function toDomainCheck(
  item: PorkbunAvailability,
  requirements: PorkbunTldRequirements | undefined,
): DomainCheck {
  const tier = item.premium ? "premium" : "standard";
  const reason = unavailableReason(item, requirements);
  if (reason !== undefined || item.priceCents === undefined) {
    return { domain: item.domain, registrable: false, ...(item.available ? { tier } : {}), reason };
  }
  return {
    domain: item.domain,
    registrable: true,
    tier,
    firstYear: usd(item.priceCents),
    ...(item.renewalCents !== undefined ? { renewal: usd(item.renewalCents) } : {}),
  };
}

function toRegisteredDomain(domain: PorkbunDomain): RegisteredDomain {
  return {
    domain: domain.domain,
    registrar: "porkbun",
    ...(domain.createdAt ? { createdAt: domain.createdAt } : {}),
    ...(domain.expiresAt ? { expiresAt: domain.expiresAt } : {}),
    autoRenew: domain.autoRenew,
    ...(domain.locked !== undefined ? { locked: domain.locked } : {}),
    ...(domain.whoisPrivacy !== undefined ? { privacy: domain.whoisPrivacy } : {}),
  };
}

/** Porkbun registers exactly the registry-minimum term: any other number of years is refused. */
function requireTerm(domain: string, years: number, term: number): void {
  if (years === term) return;
  const unit = term === 1 ? "year" : "years";
  throw new OpsCrewError(
    "INVALID_INPUT",
    `Porkbun registers ${domain} for the registry minimum of ${term} ${unit} only, not ${years}.`,
    {
      hint: `Buy it for ${term} ${unit} (auto-renew extends it later), or pick a registrar that lets you choose the years.`,
    },
  );
}

/** A record name as a lower-case FQDN without the trailing dot. */
function fqdn(name: string, domain: string): string {
  const n = normalizeHostName(name);
  if (n === "" || n === "@") return domain;
  return n === domain || n.endsWith(`.${domain}`) ? n : `${n}.${domain}`;
}

/**
 * The {@link Registrar} contract for one Porkbun account. Porkbun registers the registry-minimum
 * term only (`chooseYears: false`) with the account's own contact, from prepaid credit.
 */
export class PorkbunRegistrar implements Registrar {
  readonly id = "porkbun" as const;
  readonly capabilities: RegistrarCapabilities = {
    purchase: true,
    chooseYears: false,
    nameservers: true,
    records: true,
    dnssec: true,
    autoRenew: true,
  };
  readonly #client: PorkbunRegistrarApi;
  readonly #randomUUID: () => string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #requirements = new Map<string, Promise<PorkbunTldRequirements>>();
  /** When this registrar last called `/domain/create` (dry run or real). */
  #lastCreateAt: number | undefined;

  constructor(client: PorkbunRegistrarApi, options: PorkbunRegistrarOptions = {}) {
    this.#client = client;
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Waits out the rest of Porkbun's one-create-per-second window, then records this attempt. */
  async #paceCreate(): Promise<void> {
    if (this.#lastCreateAt !== undefined) {
      const wait = this.#lastCreateAt + CREATE_INTERVAL_MS - this.#now();
      if (wait > 0) await this.#sleep(Math.min(wait, CREATE_INTERVAL_MS));
    }
    this.#lastCreateAt = this.#now();
  }

  /** An extension's requirements, fetched once per registrar. */
  #requirementsFor(tld: string): Promise<PorkbunTldRequirements> {
    let pending = this.#requirements.get(tld);
    if (!pending) {
      pending = this.#client.registrationRequirements(tld);
      this.#requirements.set(tld, pending);
      pending.catch(() => this.#requirements.delete(tld));
    }
    return pending;
  }

  /** Live availability and prices, in one bulk check per 25 names. */
  async check(domains: readonly string[]): Promise<DomainCheck[]> {
    return (await this.#check(domains)).map((c) => c.check);
  }

  /** {@link check}, with Porkbun's availability item for each name it answered. */
  async #check(
    domains: readonly string[],
  ): Promise<{ check: DomainCheck; item?: PorkbunAvailability }[]> {
    const names: string[] = [];
    const invalidNames: { check: DomainCheck }[] = [];
    for (const raw of domains) {
      const name = normalizeHostName(raw);
      if (isDomainName(name)) names.push(name);
      else {
        invalidNames.push({
          check: { domain: name, registrable: false, reason: "This is not a domain name." },
        });
      }
    }
    const unique = [...new Set(names)];
    if (unique.length === 0) return invalidNames;
    const answer = await this.#client.checkDomains(unique);
    const results = new Map(answer.results.map((r) => [r.domain, r]));
    const reasons = new Map(answer.invalid.map((i) => [i.domain, i.reason]));
    const out: { check: DomainCheck; item?: PorkbunAvailability }[] = [];
    for (const name of unique) {
      const item = results.get(name);
      const reason = reasons.get(name);
      if (item) {
        let requirements: PorkbunTldRequirements | undefined;
        if (item.available && !item.premium) {
          requirements = await this.#requirementsFor(tldOf(name)).catch(() => undefined);
        }
        out.push({ check: toDomainCheck(item, requirements), item });
      } else if (reason !== undefined) {
        const why = reason.trim().replace(/\.$/, "");
        out.push({
          check: {
            domain: name,
            registrable: false,
            reason: `Porkbun cannot check this name: ${why}.`,
          },
        });
      } else {
        out.push({
          check: {
            domain: name,
            registrable: false,
            reason: "The registry did not answer in time; try again in a minute.",
          },
        });
      }
    }
    return [...out, ...invalidNames];
  }

  /**
   * Porkbun has no suggestions API: a domain is checked as is; a bare name is checked live under
   * a few common extensions.
   */
  async suggest(query: string): Promise<DomainCheck[]> {
    const text = normalizeHostName(query);
    if (isDomainName(text)) return this.check([text]);
    const label = text
      .replace(/[^a-z0-9-]+/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63);
    if (!label) return [];
    return this.check(SUGGESTED_TLDS.map((tld) => `${label}.${tld}`));
  }

  /**
   * The exact price of registering `domain` now, for the registry-minimum term (Porkbun cannot
   * register more years at once), from a live {@link check} and a dry run that charges nothing. A
   * domain the check cannot sell (premium, taken, website-only …) stops with its reason, and so
   * does a purchase the account's credit or monthly API spend limit would refuse.
   */
  async quote(domain: string, years: number): Promise<RegistrationQuote> {
    const name = normalizeDomain(domain);
    if (!Number.isInteger(years) || years < 1) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `A domain is registered for whole years, not ${years}.`,
        {
          hint: "Porkbun registers the registry minimum, usually 1 year.",
        },
      );
    }
    const cannotSell = (reason: string | undefined) =>
      new OpsCrewError("PHASE_PRECONDITION", `Porkbun cannot sell ${name} through its API.`, {
        hint: reason ?? "Porkbun did not check the domain.",
      });
    const [checked] = await this.#check([name]);
    if (!checked?.check.registrable || !checked.item) throw cannotSell(checked?.check.reason);
    // The check goes on without the extension's rules when reading them fails; the quote does not.
    const requirements = await this.#requirementsFor(tldOf(name));
    const reason = unavailableReason(checked.item, requirements);
    if (reason !== undefined) throw cannotSell(reason);
    requireTerm(name, years, Math.max(checked.item.minYears, requirements.termYears ?? 1));
    await this.#paceCreate();
    const preview = await this.#client.previewDomain(name);
    if (preview.years !== undefined) requireTerm(name, years, preview.years);
    if (!(preview.costCents > 0)) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Porkbun did not return a price for ${name}; try again in a minute.`,
      );
    }
    if (!preview.wouldSucceed) {
      const price = dollars(preview.costCents);
      if (preview.sufficientFunds === false) {
        const balance =
          preview.balanceCents === undefined ? "" : ` (${dollars(preview.balanceCents)})`;
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `${name} costs ${price} at Porkbun, and your account credit${balance} does not cover it.`,
          {
            hint: `Add credit at ${PORKBUN_CREDIT_URL} (Porkbun does not charge a saved card by itself), then run the command again.`,
          },
        );
      }
      if (preview.withinMonthlySpendLimit === false) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `Buying ${name} for ${price} would take this month's Porkbun API spending past the account's monthly limit.`,
          {
            hint: `The account holder can raise the limit at ${PORKBUN_API_SETTINGS_URL}. ${websiteThenConnect(name)}`,
          },
        );
      }
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Porkbun says the registration of ${name} would not succeed${preview.message ? `: ${preview.message.replace(/\.$/, "")}` : ""}.`,
        { hint: `Look at the account at ${PORKBUN_DASHBOARD_URL}.` },
      );
    }
    const { renewal } = checked.check;
    return { price: usd(preview.costCents), ...(renewal ? { renewal } : {}) };
  }

  /** Registration is synchronous: a domain in the account is registered. */
  async registrationStatus(domain: string): Promise<RegistrationStatus | undefined> {
    const found = await this.#client.getDomain(domain);
    return found ? { domain: found.domain, state: "succeeded" } : undefined;
  }

  /**
   * Buys the domain (costs money; never call twice). Needs the approved quote: its price is sent
   * as `cost`, so Porkbun refuses when the price changed. Then applies the auto-renew choice; a
   * failure there keeps the purchase successful and says where to change it.
   */
  async register(request: RegistrationRequest): Promise<RegistrationStatus> {
    const name = normalizeDomain(request.domain);
    const quote = request.quote;
    if (!quote) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Porkbun needs an approved quote (price) to buy ${name}.`,
        {
          hint: "Get a quote first and approve it, then buy with that quote.",
        },
      );
    }
    if (quote.price.currency !== "USD" || !(quote.price.amount > 0)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Porkbun prices are in US dollars; the quote for ${name} is not a US dollar amount.`,
        { hint: "Get a new Porkbun quote and approve it." },
      );
    }
    if (!Number.isInteger(request.years) || request.years < 1) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `A domain is registered for whole years, not ${request.years}.`,
        { hint: "Porkbun registers the registry minimum, usually 1 year." },
      );
    }
    requireTerm(name, request.years, (await this.#requirementsFor(tldOf(name))).termYears ?? 1);
    const costCents = Math.round(quote.price.amount * 100);
    const idempotencyKey = request.idempotencyKey?.trim() || this.#randomUUID();
    await this.#paceCreate();
    const created = await this.#client.createDomain(name, {
      costCents,
      idempotencyKey,
      whoisPrivacy: request.privacy,
    });
    const bought = created.domain || name;
    try {
      await this.#client.updateAutoRenew(bought, request.autoRenew);
    } catch (error) {
      const why = isUserFacingError(error) ? ` (${error.message.replace(/\.$/, "")})` : "";
      return {
        domain: bought,
        state: "succeeded",
        message: `Bought ${bought}, but OpsCrew could not turn auto-renew ${request.autoRenew ? "on" : "off"}${why}. Change auto-renew for ${bought} at ${PORKBUN_DASHBOARD_URL}.`,
      };
    }
    return { domain: bought, state: "succeeded" };
  }

  async getDomain(domain: string): Promise<RegisteredDomain | undefined> {
    const found = await this.#client.getDomain(domain);
    return found ? toRegisteredDomain(found) : undefined;
  }

  async setAutoRenew(domain: string, on: boolean): Promise<RegisteredDomain> {
    const name = normalizeDomain(domain);
    await this.#client.updateAutoRenew(name, on);
    const found = await this.#client.getDomain(name);
    if (!found) {
      throw new OpsCrewError("PHASE_PRECONDITION", `${name} is not in the Porkbun account.`, {
        hint: "Check the spelling, or use the API keys of the Porkbun account that holds it.",
      });
    }
    return toRegisteredDomain(found);
  }

  async ownsDomain(domain: string): Promise<boolean> {
    return (await this.#client.getDomain(domain)) !== undefined;
  }

  getNameservers(domain: string): Promise<string[]> {
    return this.#client.getNs(domain);
  }

  setNameservers(domain: string, nameservers: readonly string[]): Promise<void> {
    return this.#client.updateNs(domain, nameservers);
  }

  /** Porkbun's DNS records; undefined when the domain does not use Porkbun's nameservers. */
  async listRecords(domain: string): Promise<RegistrarDnsRecord[] | undefined> {
    const name = normalizeDomain(domain);
    const ns = await this.#client.getNs(name);
    if (ns.length === 0 || !ns.every(isPorkbunNameserver)) return undefined;
    const records = await this.#client.retrieveRecords(name);
    return records.map((r) => {
      const type = r.type.toUpperCase();
      const withPriority = (type === "MX" || type === "SRV") && r.prio !== undefined;
      return {
        type,
        name: fqdn(r.name, name),
        content: r.content,
        ...(r.ttl !== undefined ? { ttl: r.ttl } : {}),
        ...(withPriority ? { priority: r.prio } : {}),
      };
    });
  }

  listDsRecords(domain: string): Promise<DsRecord[]> {
    return this.#client.getDnssecRecords(domain);
  }

  addDsRecord(domain: string, ds: DsRecord): Promise<void> {
    return this.#client.createDnssecRecord(domain, ds);
  }

  removeDsRecord(domain: string, keyTag: number): Promise<void> {
    return this.#client.deleteDnssecRecord(domain, keyTag);
  }

  /** The keys, their permissions (what OpsCrew can do with them) and the prepaid credit. */
  async accountCheck(): Promise<RegistrarAccountCheck> {
    let ping: Awaited<ReturnType<PorkbunRegistrarApi["ping"]>>;
    try {
      ping = await this.#client.ping();
    } catch (error) {
      if (
        error instanceof OpsCrewError &&
        (error.code === "CREDENTIALS_INVALID" || error.code === "CREDENTIALS_MISSING")
      ) {
        return { ok: false, message: error.message, fix: error.hint ?? KEYS_HINT };
      }
      throw error;
    }
    const scopes = new Set(ping.scopes.map((s) => s.toLowerCase()));
    const full = scopes.has("full");
    const allowed = SCOPE_FEATURES.filter((f) => full || scopes.has(f.scope));
    const missing = SCOPE_FEATURES.filter((f) => !(full || scopes.has(f.scope)));
    const who = ping.account ? ` (account ${ping.account})` : "";
    const sandbox = this.#client.sandbox
      ? " These are sandbox keys: nothing is really bought."
      : "";
    const can = listText([
      "checking domains and prices, and reading DNS records and DNSSEC",
      ...allowed.map((f) => f.feature),
    ]);
    let message = `The Porkbun API keys work${who}. They allow ${can}.${sandbox}`;
    let fix: string | undefined;
    if (!ping.scopesReported) {
      message = `The Porkbun API keys work${who}, but Porkbun did not say which permissions they have, so buying domains (the purchase permission) and changing nameservers, auto-renew and DNSSEC (the domains permission) may be refused.${sandbox}`;
      fix = `Check the key's permissions at ${PORKBUN_API_SETTINGS_URL} (the gear icon next to the key): OpsCrew needs purchase and domains.`;
    } else if (missing.length > 0) {
      const names = listText(missing.map((f) => f.scope));
      message += ` They do not allow ${listText(missing.map((f) => `${f.feature} (the ${f.scope} permission)`))}.`;
      fix = `Give the key the ${names} ${missing.length === 1 ? "permission" : "permissions"} at ${PORKBUN_API_SETTINGS_URL} (the gear icon next to the key), or create a key that has ${missing.length === 1 ? "it" : "them"}.`;
    }
    // Without `domains` the key cannot switch nameservers, set auto-renew or change DNSSEC, which
    // every purchase and connect needs; a key missing only `purchase` still connects domains.
    const ok = !missing.some((f) => f.scope === "domains");
    if (!ok) message += " OpsCrew needs the domains permission to point a domain at Cloudflare.";
    let balance: Money | undefined;
    try {
      balance = usd(await this.#client.balance());
    } catch {
      balance = undefined;
    }
    return { ok, message, ...(fix ? { fix } : {}), ...(balance ? { balance } : {}) };
  }
}
