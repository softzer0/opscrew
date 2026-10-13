import type {
  DomainCheck,
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
import { OpsCrewError } from "@opscrew/core";
import {
  type NamecheapClient,
  type NamecheapDomain,
  type NamecheapPrice,
  normalizeDomain,
  splitDomain,
} from "./client";

/** The client calls {@link NamecheapRegistrar} needs (a `NamecheapClient` or a test fake). */
export type NamecheapRegistrarApi = Pick<
  NamecheapClient,
  | "dashboard"
  | "clientIp"
  | "checkDomains"
  | "getPricing"
  | "getBalances"
  | "contactSummary"
  | "createDomain"
  | "listDomains"
  | "getDnsList"
  | "setCustomNameservers"
  | "getHosts"
>;

/**
 * TLDs whose registration needs `ExtendedAttributes` (registrant extensions), per Namecheap's
 * `domains.create` docs. OpsCrew never collects that data: these are bought in the dashboard.
 */
export const NAMECHEAP_EXTENDED_ATTRIBUTE_TLDS: readonly string[] = [
  "us",
  "eu",
  "ca",
  "uk",
  "co.uk",
  "org.uk",
  "me.uk",
  "nu",
  "com.au",
  "net.au",
  "org.au",
  "es",
  "nom.es",
  "com.es",
  "org.es",
  "de",
  "fr",
];

/** TLDs tried by `suggest` when the query is a bare name. */
const SUGGEST_TLDS = ["com", "net", "org", "io", "dev", "app", "co"] as const;

const round = (amount: number) => Math.round(amount * 100) / 100;
const usd = (amount: number): Money => ({ amount: round(amount), currency: "USD" });
const dollars = (amount: number) => `$${amount.toFixed(2)}`;

/** Total for `years` from Namecheap's price rows (per year unless `ABSOLUTE`), fees included. */
export function priceFor(prices: readonly NamecheapPrice[], years: number): Money | undefined {
  const row = prices.find((p) => p.years === years && p.currency === "USD");
  if (!row) return undefined;
  const base = row.perYear ? row.price * years : row.price;
  const extra = row.additionalCostPerYear ? row.additionalCost * years : row.additionalCost;
  return usd(base + extra);
}

/** The {@link Registrar} contract for one Namecheap account (XML API). */
export class NamecheapRegistrar implements Registrar {
  readonly id = "namecheap" as const;
  /** Namecheap's API has no DNSSEC or auto-renew commands; both are changed in the dashboard. */
  readonly capabilities: RegistrarCapabilities = {
    purchase: true,
    chooseYears: true,
    nameservers: true,
    records: true,
    dnssec: false,
    autoRenew: false,
  };
  readonly #client: NamecheapRegistrarApi;

  constructor(client: NamecheapRegistrarApi) {
    this.#client = client;
  }

  #extensionReason(tld: string): string {
    return `Registering .${tld} at Namecheap needs registrant details (extended attributes) that OpsCrew does not collect; buy it in the Namecheap dashboard at ${this.#client.dashboard.domainList}, then run \`opscrew domain connect\`.`;
  }

  #premiumReason(): string {
    return `This is a premium domain; buy it in the Namecheap dashboard at ${this.#client.dashboard.domainList}, then run \`opscrew domain connect\`.`;
  }

  /** Live availability with first-year and renewal prices (fees included). */
  async check(domains: readonly string[]): Promise<DomainCheck[]> {
    const names = [...new Set(domains.map(normalizeDomain))];
    if (names.length === 0) return [];
    const results = await this.#client.checkDomains(names);
    const byName = new Map(results.map((r) => [r.domain, r]));
    const pricing = new Map<string, Promise<[NamecheapPrice[], NamecheapPrice[]]>>();
    const pricesOf = (tld: string) => {
      let p = pricing.get(tld);
      if (!p) {
        p = Promise.all([
          this.#client.getPricing("REGISTER", tld),
          this.#client.getPricing("RENEW", tld),
        ]);
        pricing.set(tld, p);
      }
      return p;
    };
    const checks: DomainCheck[] = [];
    for (const domain of names) {
      const { tld } = splitDomain(domain);
      const r = byName.get(domain);
      if (!r) {
        checks.push({
          domain,
          registrable: false,
          reason: "Namecheap did not return a result for this domain; try again in a minute.",
        });
      } else if (r.error) {
        checks.push({
          domain,
          registrable: false,
          reason: `Namecheap could not check this domain: ${r.error.replace(/\.$/, "")}.`,
        });
      } else if (!r.available) {
        checks.push({
          domain,
          registrable: false,
          ...(r.premium ? { tier: "premium" as const } : {}),
          reason: "This domain is already registered by someone else.",
        });
      } else if (r.premium) {
        checks.push({ domain, registrable: false, tier: "premium", reason: this.#premiumReason() });
      } else if (NAMECHEAP_EXTENDED_ATTRIBUTE_TLDS.includes(tld)) {
        checks.push({
          domain,
          registrable: false,
          tier: "standard",
          reason: this.#extensionReason(tld),
        });
      } else {
        const [register, renew] = await pricesOf(tld);
        const firstYear = priceFor(register, 1);
        const renewal = priceFor(renew, 1);
        checks.push(
          firstYear
            ? {
                domain,
                registrable: true,
                tier: "standard",
                firstYear,
                ...(renewal ? { renewal } : {}),
              }
            : {
                domain,
                registrable: false,
                tier: "standard",
                reason: `Namecheap did not return a USD price for .${tld}; it may not sell this extension through its API.`,
              },
        );
      }
    }
    return checks;
  }

  /**
   * Namecheap has no suggestion API: a query that is a domain is checked as-is; a bare name is
   * checked with a few common extensions.
   */
  async suggest(query: string): Promise<DomainCheck[]> {
    const q = normalizeDomain(query);
    if (q.includes(".")) return this.check([q]);
    const name = q.replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
    if (!name) return [];
    return this.check(SUGGEST_TLDS.map((tld) => `${name}.${tld}`));
  }

  async #find(domain: string): Promise<NamecheapDomain | undefined> {
    const name = normalizeDomain(domain);
    const domains = await this.#client.listDomains(name);
    return domains.find((d) => d.domain === name);
  }

  /** `succeeded` when the domain is in the account, else undefined. */
  async registrationStatus(domain: string): Promise<RegistrationStatus | undefined> {
    const found = await this.#find(domain);
    return found ? { domain: found.domain, state: "succeeded" } : undefined;
  }

  /** The live price for `years` (fees included) and the yearly renewal price, in USD. */
  async quote(domain: string, years: number): Promise<RegistrationQuote> {
    const name = normalizeDomain(domain);
    checkYears(years);
    const { tld } = splitDomain(name);
    const stop = (reason: string) =>
      new OpsCrewError("PHASE_PRECONDITION", `Namecheap cannot sell ${name} through its API.`, {
        hint: reason,
      });
    if (NAMECHEAP_EXTENDED_ATTRIBUTE_TLDS.includes(tld)) throw stop(this.#extensionReason(tld));
    const result = (await this.#client.checkDomains([name])).find((r) => r.domain === name);
    if (!result || result.error) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Namecheap could not check ${name}${result?.error ? `: ${result.error.replace(/\.$/, "")}` : ""}.`,
        { hint: "Try again in a minute." },
      );
    }
    if (!result.available) {
      throw new OpsCrewError("PHASE_PRECONDITION", `${name} is already registered.`, {
        hint: "Pick another name; `opscrew domain search` lists available ones.",
      });
    }
    if (result.premium) throw stop(this.#premiumReason());
    const [register, renew] = await Promise.all([
      this.#client.getPricing("REGISTER", tld),
      this.#client.getPricing("RENEW", tld),
    ]);
    const price = priceFor(register, years);
    if (!price) {
      throw stop(
        `Namecheap lists no USD price for ${years} year${years === 1 ? "" : "s"} of .${tld}; try another number of years or buy it in the dashboard at ${this.#client.dashboard.domainList}.`,
      );
    }
    const renewal = priceFor(renew, 1);
    return { price, ...(renewal ? { renewal } : {}) };
  }

  /** Masked default-address summary (`T*** P***, US`) for the approval. */
  contactSummary(): Promise<string | undefined> {
    return this.#client.contactSummary();
  }

  /**
   * Buys the domain (charged to the Namecheap balance, never retried). Needs the approved quote:
   * a higher live price or a balance below it stops before anything is bought. Namecheap's
   * default nameservers are kept until the Cloudflare zone exists.
   */
  async register(request: RegistrationRequest): Promise<RegistrationStatus> {
    const domain = normalizeDomain(request.domain);
    if (!request.quote) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Buying ${domain} at Namecheap needs the approved price, and none was given.`,
        { hint: "Get a quote first and pass it with the registration request." },
      );
    }
    if (request.quote.price.currency !== "USD") {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Namecheap prices are in USD, but the approved price is in ${request.quote.price.currency}.`,
        { hint: "Get a new quote from Namecheap and approve it." },
      );
    }
    checkYears(request.years);
    const { tld } = splitDomain(domain);
    if (NAMECHEAP_EXTENDED_ATTRIBUTE_TLDS.includes(tld)) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap cannot sell ${domain} through its API.`,
        {
          hint: this.#extensionReason(tld),
        },
      );
    }
    const approved = request.quote.price.amount;
    const current = priceFor(await this.#client.getPricing("REGISTER", tld), request.years);
    if (!current) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap no longer lists a price for ${request.years} year${request.years === 1 ? "" : "s"} of .${tld}. Nothing was bought.`,
        { hint: "Run the command again to get a new quote." },
      );
    }
    if (current.amount > approved + 0.005) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The Namecheap price of ${domain} changed from ${dollars(approved)} to ${dollars(current.amount)} since you approved it. Nothing was bought.`,
        { hint: "Run the command again to see and approve the new price." },
      );
    }
    const balance = await this.#client.getBalances();
    if (balance.currency === "USD" && balance.available < current.amount) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Your Namecheap balance (${dollars(balance.available)}) is lower than the price of ${domain} (${dollars(current.amount)}). Nothing was bought.`,
        {
          hint: "Namecheap charges API purchases to the account balance. Add funds in the Namecheap dashboard (Profile → Billing → Add Funds), then run the command again.",
        },
      );
    }
    const result = await this.#client.createDomain({
      domain,
      years: request.years,
      privacy: request.privacy,
    });
    if (result.nonRealTime) {
      return {
        domain: result.domain,
        state: "pending",
        message: `Namecheap accepted the order for ${result.domain} and is still registering it (the registry does not confirm instantly). Check it with \`opscrew domain status\`.`,
      };
    }
    if (!result.registered) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Namecheap answered that ${result.domain} was not registered, without saying why. The purchase may still have started; check your Namecheap domain list before trying again.`,
        {
          hint: `Run \`opscrew domain status\` or look at ${this.#client.dashboard.domainList} before buying ${result.domain} again.`,
        },
      );
    }
    const note = await this.#autoRenewNote(result.domain, request.autoRenew);
    return { domain: result.domain, state: "succeeded", ...(note ? { message: note } : {}) };
  }

  /**
   * Auto-renew cannot be set through the API: compares Namecheap's setting with the request and
   * says where to change it. Never fails the purchase (the domain is already bought).
   */
  async #autoRenewNote(domain: string, wanted: boolean): Promise<string | undefined> {
    const page = this.#client.dashboard.domainList;
    let actual: boolean | undefined;
    try {
      actual = (await this.#find(domain))?.autoRenew;
    } catch {
      actual = undefined;
    }
    if (actual === wanted) return undefined;
    if (actual === undefined) {
      return `Namecheap does not let OpsCrew set auto-renew; check that it is ${wanted ? "on" : "off"} for ${domain} at ${page}.`;
    }
    return `Auto-renew for ${domain} is ${actual ? "on" : "off"} at Namecheap, and OpsCrew cannot change it through the API; turn it ${wanted ? "on" : "off"} at ${page}.`;
  }

  async getDomain(domain: string): Promise<RegisteredDomain | undefined> {
    const found = await this.#find(domain);
    if (!found) return undefined;
    return {
      domain: found.domain,
      registrar: "namecheap",
      ...(found.createdAt ? { createdAt: found.createdAt } : {}),
      ...(found.expiresAt ? { expiresAt: found.expiresAt } : {}),
      autoRenew: found.autoRenew ?? false,
      ...(found.locked !== undefined ? { locked: found.locked } : {}),
      ...(found.privacy !== undefined ? { privacy: found.privacy } : {}),
    };
  }

  /** Not available through Namecheap's API: a plain error pointing at the dashboard. */
  setAutoRenew(domain: string, on: boolean): Promise<RegisteredDomain> {
    const name = normalizeDomain(domain);
    return Promise.reject(
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `Namecheap does not let OpsCrew change auto-renew through its API, so auto-renew for ${name} was not turned ${on ? "on" : "off"}.`,
        {
          hint: `Turn it ${on ? "on" : "off"} in the Namecheap domain list at ${this.#client.dashboard.domainList}.`,
        },
      ),
    );
  }

  async ownsDomain(domain: string): Promise<boolean> {
    return (await this.#find(domain)) !== undefined;
  }

  async getNameservers(domain: string): Promise<string[]> {
    return (await this.#client.getDnsList(domain)).nameservers;
  }

  setNameservers(domain: string, nameservers: readonly string[]): Promise<void> {
    return this.#client.setCustomNameservers(domain, nameservers);
  }

  /**
   * Records served by Namecheap's DNS; undefined when the domain uses other nameservers. Types
   * Cloudflare has no equivalent for (URL, URL301, FRAME, ALIAS, MXE …) are kept as-is for the
   * connect flow to flag. When Namecheap itself routes the domain's mail (email forwarding,
   * Private Email, or a mail type without MX records in the host list), one `EMAIL-FORWARDING`
   * pseudo-record says so: that mail stops working once the nameservers move.
   */
  async listRecords(domain: string): Promise<RegistrarDnsRecord[] | undefined> {
    const name = normalizeDomain(domain);
    const list = await this.#client.getHosts(name);
    if (!list) return undefined;
    const records: RegistrarDnsRecord[] = list.hosts.map((h) => {
      const label = h.name.trim().toLowerCase().replace(/\.$/, "");
      const fqdn = label === "" || label === "@" ? name : `${label}.${name}`;
      const hostTarget = ["CNAME", "MX", "ALIAS", "NS"].includes(h.type);
      const content = hostTarget ? h.address.trim().replace(/\.$/, "") : h.address;
      return {
        type: h.type,
        name: fqdn,
        content,
        ...(h.ttl !== undefined ? { ttl: h.ttl } : {}),
        ...(h.type === "MX" && h.mxPref !== undefined ? { priority: h.mxPref } : {}),
      };
    });
    const mail = namecheapMailService(list.emailType, records);
    if (mail) {
      records.push({
        type: "EMAIL-FORWARDING",
        name,
        content: `Namecheap ${mail} (not a DNS record; set mail up again at your mail provider or with Cloudflare Email Routing)`,
      });
    }
    return records;
  }

  /** API access (credentials, whitelisted IP) and the balance, in plain English. */
  async accountCheck(): Promise<RegistrarAccountCheck> {
    try {
      const balance = await this.#client.getBalances();
      const ip = await this.#client.clientIp();
      const money: Money | undefined =
        balance.currency === "USD" || balance.currency === "EUR"
          ? { amount: round(balance.available), currency: balance.currency }
          : undefined;
      return {
        ok: true,
        message: `Namecheap API access works from ${ip}; the account balance is ${balance.available.toFixed(2)} ${balance.currency} (API purchases are paid from it).`,
        ...(money ? { balance: money } : {}),
      };
    } catch (error) {
      if (error instanceof OpsCrewError) {
        return { ok: false, message: error.message, ...(error.hint ? { fix: error.hint } : {}) };
      }
      throw error;
    }
  }
}

/**
 * The mail service Namecheap provides outside the host list, from `EmailType`: `FWD` (email
 * forwarding), `OX` (Private Email), or any other type when no MX record is listed. `MX`, `MXE`
 * (whose records are listed) and `NONE` need nothing extra.
 */
function namecheapMailService(
  emailType: string | undefined,
  records: readonly RegistrarDnsRecord[],
): string | undefined {
  if (!emailType || ["NONE", "MX", "MXE"].includes(emailType)) return undefined;
  if (emailType === "FWD") return "email forwarding";
  if (emailType === "OX") return "Private Email";
  if (records.some((r) => r.type === "MX")) return undefined;
  return `mail service (${emailType})`;
}

function checkYears(years: number): void {
  if (!Number.isInteger(years) || years < 1 || years > 10) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `A domain can be registered for 1 to 10 years, not ${years}.`,
      { hint: "Pass a whole number of years between 1 and 10." },
    );
  }
}
