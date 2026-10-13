import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { z } from "zod";
import { ContactCard } from "./contacts";
import {
  errorKind,
  NAMECHEAP_DASHBOARD_URLS,
  NAMECHEAP_SANDBOX_DASHBOARD_URLS,
  type NamecheapDashboardUrls,
  namecheapError,
  TEXT_KINDS,
} from "./errors";
import {
  AddressInfoResponse,
  AddressListResponse,
  BalancesResponse,
  CheckResponse,
  CreateResponse,
  DnsListResponse,
  DomainInfoResponse,
  DomainListResponse,
  type Envelope,
  HostsResponse,
  type NamecheapApiError,
  PricingResponse,
  parseXml,
  RegistrarLockResponse,
  SetCustomResponse,
  toEnvelope,
} from "./xml";

/** Production endpoint of Namecheap's XML API. */
export const NAMECHEAP_API = "https://api.namecheap.com/xml.response";
/** Sandbox endpoint (a separate account at sandbox.namecheap.com). */
export const NAMECHEAP_SANDBOX_API = "https://api.sandbox.namecheap.com/xml.response";

/** `domains.check` accepts at most 50 domains per call (error 2011169). */
export const NAMECHEAP_CHECK_BATCH = 50;

export interface NamecheapClientOptions {
  apiUser: string;
  /** Secret: sent only in the POST body to Namecheap, never in errors. */
  apiKey: string;
  /** The account the commands act on; defaults to `apiUser`. */
  userName?: string;
  /** Public IPv4 of this computer (`NAMECHEAP_CLIENT_IP`); must be on the API whitelist. */
  clientIp?: string;
  /** Finds this computer's public IPv4 when `clientIp` is not set; called once per client. */
  detectClientIp?: () => Promise<string>;
  /** Use Namecheap's sandbox (`NAMECHEAP_SANDBOX=1`). */
  sandbox?: boolean;
  fetch?: FetchLike;
  /** Sleep between retries of read-only calls (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** One `domains.check` result. */
export interface NamecheapCheckResult {
  domain: string;
  available: boolean;
  premium: boolean;
  /** Namecheap's per-domain error text, when it could not check the domain. */
  error?: string;
}

/** One `users.getPricing` price row. */
export interface NamecheapPrice {
  years: number;
  /** `Price`: Namecheap's final price (per year unless `perYear` is false). */
  price: number;
  /** `PricingType` is `MULTIPLE` (per year) unless Namecheap says `ABSOLUTE`. */
  perYear: boolean;
  /** `AdditionalCost`: fees on top of the price, such as the ICANN fee. */
  additionalCost: number;
  additionalCostPerYear: boolean;
  currency: string;
}

export interface NamecheapBalance {
  available: number;
  currency: string;
  fundsRequiredForAutoRenew?: number;
}

export interface NamecheapCreateRequest {
  domain: string;
  years: number;
  /** Free WHOIS privacy (`AddFreeWhoisguard` and `WGEnabled`). */
  privacy: boolean;
}

/** The answer to `domains.create` (no contact data). */
export interface NamecheapCreateResult {
  domain: string;
  registered: boolean;
  /** Namecheap is still registering the domain (`NonRealTimeDomain`). */
  nonRealTime: boolean;
  chargedAmount?: number;
  orderId?: string;
  privacy?: boolean;
}

/** A domain of the account as `domains.getList` reports it. */
export interface NamecheapDomain {
  domain: string;
  /** ISO dates (Namecheap sends MM/DD/YYYY). */
  createdAt?: string;
  expiresAt?: string;
  expired?: boolean;
  locked?: boolean;
  autoRenew?: boolean;
  /** `WhoisGuard` is `ENABLED`. */
  privacy?: boolean;
  /** Namecheap's DNS hosts the domain. */
  usesNamecheapDns?: boolean;
}

export interface NamecheapDomainInfo {
  domain: string;
  status?: string;
  owner?: boolean;
  createdAt?: string;
  expiresAt?: string;
  privacy?: boolean;
  usesNamecheapDns?: boolean;
}

export interface NamecheapDnsList {
  usesNamecheapDns: boolean;
  nameservers: string[];
}

/** The answer to `domains.dns.getHosts`. */
export interface NamecheapHostList {
  hosts: NamecheapHost[];
  /** How Namecheap routes mail (`MX`, `MXE`, `FWD` forwarding, `OX` Private Email …). */
  emailType?: string;
}

/** A host record from `domains.dns.getHosts`, as Namecheap reports it. */
export interface NamecheapHost {
  /** `@` for the apex, else the label(s) below the domain. */
  name: string;
  type: string;
  address: string;
  mxPref?: number;
  ttl?: number;
}

/** Retries of read-only calls on network errors, 5xx and HTTP 429. */
const MAX_RETRIES = 2;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lower case, trimmed, without a trailing dot. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Splits a registrable domain into Namecheap's `SLD` (the first label) and `TLD` (the rest):
 * `example.co.uk` → `example` + `co.uk`.
 */
export function splitDomain(domain: string): { sld: string; tld: string } {
  const name = normalizeDomain(domain);
  const labels = name.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw new OpsCrewError("INVALID_INPUT", `"${domain}" is not a valid domain name.`, {
      hint: "Pass a domain such as example.com.",
    });
  }
  return { sld: labels[0] as string, tld: labels.slice(1).join(".") };
}

/** Namecheap's MM/DD/YYYY date → ISO (UTC midnight); undefined when it is not such a date. */
export function namecheapDate(value: string | undefined): string | undefined {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

class Unreachable extends Error {}
/** Thrown internally for error 2030288 (the domain does not use Namecheap's DNS). */
class NotOurDns extends Error {}

interface Answer {
  status: number;
  envelope: Envelope | undefined;
}

/**
 * Namecheap XML API client. Every call is a form POST with the global parameters (`ApiUser`,
 * `ApiKey`, `UserName`, `ClientIp`, `Command`). Read-only calls retry network errors, 5xx and 429;
 * `domains.create` is sent exactly once.
 */
export class NamecheapClient {
  readonly sandbox: boolean;
  readonly #apiUser: string;
  readonly #apiKey: string;
  readonly #userName: string;
  readonly #fixedIp: string | undefined;
  readonly #detect: (() => Promise<string>) | undefined;
  readonly #endpoint: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  #detected: string | undefined;

  constructor(options: NamecheapClientOptions) {
    this.#apiUser = options.apiUser.trim();
    this.#apiKey = options.apiKey.trim();
    this.#userName = options.userName?.trim() || this.#apiUser;
    this.#fixedIp = options.clientIp?.trim() || undefined;
    this.#detect = options.detectClientIp;
    this.sandbox = options.sandbox ?? false;
    this.#endpoint = this.sandbox ? NAMECHEAP_SANDBOX_API : NAMECHEAP_API;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Dashboard pages of the production or sandbox account. */
  get dashboard(): NamecheapDashboardUrls {
    return this.sandbox ? NAMECHEAP_SANDBOX_DASHBOARD_URLS : NAMECHEAP_DASHBOARD_URLS;
  }

  /**
   * The `ClientIp` sent with every call: the configured address, else the detected one (detected
   * once per client). Namecheap accepts IPv4 only.
   */
  async clientIp(): Promise<string> {
    const setIt = `Set NAMECHEAP_CLIENT_IP to this computer's public IPv4 address and add that address to the API whitelist at ${this.dashboard.apiAccess}.`;
    if (this.#fixedIp) {
      if (!IPV4.test(this.#fixedIp)) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `NAMECHEAP_CLIENT_IP is "${this.#fixedIp}", which is not an IPv4 address. Namecheap accepts IPv4 addresses only.`,
          { hint: setIt },
        );
      }
      return this.#fixedIp;
    }
    if (this.#detected) return this.#detected;
    if (!this.#detect) {
      throw new OpsCrewError(
        "CREDENTIALS_MISSING",
        "Namecheap needs this computer's public IPv4 address with every API call, and it is not set.",
        { hint: setIt },
      );
    }
    let ip: string;
    try {
      ip = (await this.#detect()).trim();
    } catch (error) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        "OpsCrew could not find this computer's public IPv4 address, which Namecheap needs with every API call.",
        { hint: setIt, cause: error },
      );
    }
    if (!IPV4.test(ip)) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `This computer's public address was detected as "${ip}", which is not an IPv4 address; Namecheap accepts IPv4 addresses only.`,
        { hint: setIt },
      );
    }
    this.#detected = ip;
    return ip;
  }

  /** Replaces the API key in any text (Namecheap's texts are shown to users). */
  #scrub = (text: string): string =>
    this.#apiKey.length >= 4 ? text.split(this.#apiKey).join("***") : text;

  async #body(command: string, params: Record<string, string>): Promise<URLSearchParams> {
    if (!this.#apiUser || !this.#apiKey) {
      throw new OpsCrewError(
        "CREDENTIALS_MISSING",
        "The Namecheap API user or API key is not set.",
        {
          hint: `Set NAMECHEAP_API_USER and NAMECHEAP_API_KEY (Profile → Tools → API Access at ${this.dashboard.apiAccess}).`,
        },
      );
    }
    const clientIp = await this.clientIp();
    return new URLSearchParams({
      ApiUser: this.#apiUser,
      ApiKey: this.#apiKey,
      UserName: this.#userName,
      ClientIp: clientIp,
      Command: `namecheap.${command}`,
      ...params,
    });
  }

  /** One POST. Network failures become {@link Unreachable} (without the request in it). */
  async #post(body: URLSearchParams): Promise<Answer> {
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/xml",
        },
        body: body.toString(),
      });
      text = await response.text();
    } catch {
      throw new Unreachable();
    }
    return { status: response.status, envelope: toEnvelope(parseXml(text)) };
  }

  #error(errors: NamecheapApiError[], what: string, suffix?: string): OpsCrewError {
    return namecheapError(errors, {
      what,
      ...(this.#currentIp() ? { clientIp: this.#currentIp() as string } : {}),
      urls: this.dashboard,
      scrub: this.#scrub,
      ...(suffix ? { suffix } : {}),
    });
  }

  #currentIp(): string | undefined {
    return this.#fixedIp ?? this.#detected;
  }

  /** A read-only (or idempotent) command; returns its `CommandResponse` validated by `schema`. */
  async #call<T>(
    command: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
    what: string,
    special?: (errors: NamecheapApiError[]) => Error | undefined,
  ): Promise<T> {
    const body = await this.#body(command, params);
    for (let attempt = 0; ; attempt++) {
      let answer: Answer;
      try {
        answer = await this.#post(body);
      } catch (error) {
        if (!(error instanceof Unreachable)) throw error;
        if (attempt < MAX_RETRIES) {
          await this.#sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new OpsCrewError("PROVIDER_ERROR", `Could not reach the Namecheap API to ${what}.`, {
          hint: "Check your internet connection and try again.",
        });
      }
      const { status, envelope } = answer;
      const retryable = status === 429 || status >= 500;
      if (retryable && !envelope?.errors.length && attempt < MAX_RETRIES) {
        await this.#sleep((status === 429 ? 10_000 : 1000) * 2 ** attempt);
        continue;
      }
      if (envelope && !envelope.ok) {
        throw special?.(envelope.errors) ?? this.#error(envelope.errors, what);
      }
      if (!envelope || status < 200 || status >= 300) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Namecheap returned an unreadable answer (HTTP ${status}) when trying to ${what}.`,
          {
            hint: "Try again in a minute; if it keeps failing, check https://www.namecheap.com/status-updates/.",
          },
        );
      }
      const parsed = schema.safeParse(envelope.commandResponse);
      if (!parsed.success) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Namecheap returned an unexpected answer when trying to ${what}.`,
        );
      }
      return parsed.data;
    }
  }

  /** `domains.check`: live availability, in batches of 50. */
  async checkDomains(domains: readonly string[]): Promise<NamecheapCheckResult[]> {
    const names = [...new Set(domains.map(normalizeDomain))];
    for (const name of names) splitDomain(name);
    const results: NamecheapCheckResult[] = [];
    for (let i = 0; i < names.length; i += NAMECHEAP_CHECK_BATCH) {
      const batch = names.slice(i, i + NAMECHEAP_CHECK_BATCH);
      const answer = await this.#call(
        "domains.check",
        { DomainList: batch.join(",") },
        CheckResponse,
        `check ${batch.length === 1 ? batch[0] : `${batch.length} domains`}`,
      );
      for (const r of answer.DomainCheckResult) {
        const errorNo = r["@_ErrorNo"]?.trim();
        const description = r["@_Description"]?.trim();
        results.push({
          domain: normalizeDomain(r["@_Domain"]),
          available: r["@_Available"],
          premium: r["@_IsPremiumName"] ?? false,
          ...(errorNo && errorNo !== "0"
            ? { error: this.#scrub(description || `error ${errorNo}`) }
            : {}),
        });
      }
    }
    return results;
  }

  /**
   * `users.getPricing` for one TLD and action. Confirmed in Namecheap's docs (2026-10-13): `Price`
   * is the final price ("regular, user, special, promo or tier price"); the documented example
   * lists a 2-year .biz registration at 8.87 against 6.00 for 1 year, so prices are per year.
   * Live answers also carry `PricingType`/`AdditionalCostType` (`MULTIPLE` = per year,
   * `ABSOLUTE` = total) and `AdditionalCost` (the ICANN fee); a missing type counts as per year,
   * which can only overstate a total.
   */
  async getPricing(action: "REGISTER" | "RENEW", tld: string): Promise<NamecheapPrice[]> {
    const product = tld.trim().toLowerCase().replace(/^\./, "");
    const answer = await this.#call(
      "users.getPricing",
      {
        ProductType: "DOMAIN",
        ProductCategory: "DOMAINS",
        ActionName: action,
        ProductName: product.toUpperCase(),
      },
      PricingResponse,
      `read the ${action === "REGISTER" ? "registration" : "renewal"} price of .${product}`,
    );
    const prices: NamecheapPrice[] = [];
    for (const type of answer.UserGetPricingResult?.ProductType ?? []) {
      for (const category of type.ProductCategory ?? []) {
        if (category["@_Name"].trim().toUpperCase() !== action) continue;
        for (const p of category.Product ?? []) {
          if (p["@_Name"].trim().toLowerCase() !== product) continue;
          for (const row of p.Price ?? []) {
            const unit = row["@_DurationType"]?.trim().toUpperCase();
            if (unit && unit !== "YEAR") continue;
            prices.push({
              years: row["@_Duration"],
              price: row["@_Price"],
              perYear: row["@_PricingType"]?.trim().toUpperCase() !== "ABSOLUTE",
              additionalCost: row["@_AdditionalCost"] ?? 0,
              additionalCostPerYear:
                row["@_AdditionalCostType"]?.trim().toUpperCase() !== "ABSOLUTE",
              currency: row["@_Currency"].trim().toUpperCase(),
            });
          }
        }
      }
    }
    return prices;
  }

  /** `users.getBalances`: the prepaid balance API purchases are charged to. */
  async getBalances(): Promise<NamecheapBalance> {
    const answer = await this.#call(
      "users.getBalances",
      {},
      BalancesResponse,
      "read the account balance",
    );
    const r = answer.UserGetBalancesResult;
    return {
      available: r["@_AvailableBalance"],
      currency: r["@_Currency"].trim().toUpperCase(),
      ...(r["@_FundsRequiredForAutoRenew"] !== undefined
        ? { fundsRequiredForAutoRenew: r["@_FundsRequiredForAutoRenew"] }
        : {}),
    };
  }

  /**
   * The default address-book entry (`users.address.getList` + `getInfo`), held in memory only.
   * No default address, or an incomplete one, is a plain stop naming the address-book page.
   */
  async #defaultContact(): Promise<ContactCard> {
    const book = this.dashboard.addressBook;
    const noDefault = () =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        "Your Namecheap address book has no default address. Namecheap needs one to use as the registrant contact of a new domain. Nothing was bought.",
        { hint: `Add an address and make it the default at ${book}, then run the command again.` },
      );
    const list = await this.#call(
      "users.address.getList",
      {},
      AddressListResponse,
      "read the address book",
    );
    const entries = list.AddressGetListResult?.List ?? [];
    if (entries.length === 0) throw noDefault();
    const flagged = entries.find((e) => e["@_IsDefault"] === true);
    const candidates = flagged ? [flagged] : entries.slice(0, 20);
    for (const entry of candidates) {
      const info = await this.#call(
        "users.address.getInfo",
        { AddressId: entry["@_AddressId"].trim() },
        AddressInfoResponse,
        "read the default address",
      );
      const raw = info.GetAddressInfoResult;
      if (flagged || raw.Default_YN?.trim().toLowerCase() === "true") {
        return ContactCard.fromAddress(raw, book);
      }
    }
    throw noDefault();
  }

  /** Masked summary of the default address (`T*** P***, US`); never the data itself. */
  async contactSummary(): Promise<string> {
    return (await this.#defaultContact()).summary();
  }

  /**
   * `domains.create`: buys the domain (charged to the balance, non-refundable) with the default
   * address as the four contacts and Namecheap's default nameservers. Sent exactly once, never
   * retried. A clear rejection (an `ERROR` answer whose error numbers say the order was refused)
   * is a plain error saying nothing was bought. Anything else unusable — a network error, a 5xx,
   * unreadable XML, or a provider-side error number (3xxxxxx/4xxxxxx/5xxxxxx such as "unknown
   * response from provider") — is a `PROVIDER_ERROR` saying the purchase may still have started.
   */
  async createDomain(request: NamecheapCreateRequest): Promise<NamecheapCreateResult> {
    const domain = normalizeDomain(request.domain);
    splitDomain(domain);
    if (!Number.isInteger(request.years) || request.years < 1 || request.years > 10) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `A domain can be registered for 1 to 10 years, not ${request.years}.`,
        { hint: "Pass a whole number of years between 1 and 10." },
      );
    }
    const contact = await this.#defaultContact();
    const privacy = request.privacy ? "yes" : "no";
    const body = await this.#body("domains.create", {
      DomainName: domain,
      Years: String(request.years),
      ...contact.params(),
      AddFreeWhoisguard: privacy,
      WGEnabled: privacy,
    });
    const scrub = (text: string) => contact.scrub(this.#scrub(text));
    const uncertain = (detail: string) =>
      new OpsCrewError(
        "PROVIDER_ERROR",
        `Namecheap gave no clear answer while registering ${domain} (${detail}). The purchase may still have started; check your Namecheap domain list before trying again.`,
        {
          hint: `Run \`opscrew domain status\` or look at ${this.dashboard.domainList} before buying ${domain} again.`,
        },
      );
    let answer: Answer;
    try {
      answer = await this.#post(body);
    } catch (error) {
      if (error instanceof Unreachable) throw uncertain("the connection failed");
      throw error;
    }
    const { status, envelope } = answer;
    if (envelope && !envelope.ok) {
      if (isClearRejection(envelope.errors)) {
        const error = namecheapError(envelope.errors, {
          what: `register ${domain}`,
          ...(this.#currentIp() ? { clientIp: this.#currentIp() as string } : {}),
          urls: this.dashboard,
          scrub,
          suffix: "Nothing was bought.",
        });
        // The purchase flow treats only user-side codes as "nothing was bought"; same text and hint.
        if (error.code !== "PROVIDER_ERROR") throw error;
        throw new OpsCrewError("PHASE_PRECONDITION", error.message, {
          ...(error.hint ? { hint: error.hint } : {}),
        });
      }
      // Only the numbers: Namecheap's free text could echo parts of the contact.
      const numbers = envelope.errors.map((e) => e.number).filter(Boolean);
      throw uncertain(
        numbers.length > 0 ? `Namecheap error ${numbers.join(", ")}` : "an error without a number",
      );
    }
    if (status < 200 || status >= 300) throw uncertain(`HTTP ${status}`);
    if (!envelope) throw uncertain(`HTTP ${status} without a readable answer`);
    const parsed = CreateResponse.safeParse(envelope.commandResponse);
    if (!parsed.success) throw uncertain("an unexpected answer");
    const r = parsed.data.DomainCreateResult;
    return {
      domain: normalizeDomain(r["@_Domain"]) || domain,
      registered: r["@_Registered"],
      nonRealTime: r["@_NonRealTimeDomain"] ?? false,
      ...(r["@_ChargedAmount"] !== undefined ? { chargedAmount: r["@_ChargedAmount"] } : {}),
      ...(r["@_OrderID"] ? { orderId: r["@_OrderID"] } : {}),
      ...(r["@_WhoisguardEnable"] !== undefined ? { privacy: r["@_WhoisguardEnable"] } : {}),
    };
  }

  /** `domains.getList` (all pages), optionally filtered by Namecheap's `SearchTerm`. */
  async listDomains(searchTerm?: string): Promise<NamecheapDomain[]> {
    const domains: NamecheapDomain[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page++) {
      const answer = await this.#call(
        "domains.getList",
        {
          ListType: "ALL",
          Page: String(page),
          PageSize: String(pageSize),
          ...(searchTerm ? { SearchTerm: normalizeDomain(searchTerm) } : {}),
        },
        DomainListResponse,
        "list the domains of the account",
      );
      const rows = answer.DomainGetListResult?.Domain ?? [];
      for (const d of rows) {
        const createdAt = namecheapDate(d["@_Created"]);
        const expiresAt = namecheapDate(d["@_Expires"]);
        const guard = d["@_WhoisGuard"]?.trim().toUpperCase();
        domains.push({
          domain: normalizeDomain(d["@_Name"]),
          ...(createdAt ? { createdAt } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          ...(d["@_IsExpired"] !== undefined ? { expired: d["@_IsExpired"] } : {}),
          ...(d["@_IsLocked"] !== undefined ? { locked: d["@_IsLocked"] } : {}),
          ...(d["@_AutoRenew"] !== undefined ? { autoRenew: d["@_AutoRenew"] } : {}),
          ...(guard ? { privacy: guard === "ENABLED" } : {}),
          ...(d["@_IsOurDNS"] !== undefined ? { usesNamecheapDns: d["@_IsOurDNS"] } : {}),
        });
      }
      const total = answer.Paging?.TotalItems;
      if (rows.length < pageSize || (total !== undefined && domains.length >= total)) break;
    }
    return domains;
  }

  /** `domains.getInfo` for a domain of the account. */
  async getDomainInfo(domain: string): Promise<NamecheapDomainInfo> {
    const name = normalizeDomain(domain);
    const answer = await this.#call(
      "domains.getInfo",
      { DomainName: name },
      DomainInfoResponse,
      `read the details of ${name}`,
    );
    const r = answer.DomainGetInfoResult;
    const createdAt = namecheapDate(r.DomainDetails?.CreatedDate);
    const expiresAt = namecheapDate(r.DomainDetails?.ExpiredDate);
    const privacy = r.Whoisguard?.["@_Enabled"];
    const ourDns = r.DnsDetails?.["@_IsUsingOurDNS"];
    return {
      domain: normalizeDomain(r["@_DomainName"]),
      ...(r["@_Status"] ? { status: r["@_Status"] } : {}),
      ...(r["@_IsOwner"] !== undefined ? { owner: r["@_IsOwner"] } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(privacy !== undefined ? { privacy } : {}),
      ...(ourDns !== undefined ? { usesNamecheapDns: ourDns } : {}),
    };
  }

  /** `domains.dns.getList`: the domain's nameservers and whether Namecheap's DNS is used. */
  async getDnsList(domain: string): Promise<NamecheapDnsList> {
    const name = normalizeDomain(domain);
    const { sld, tld } = splitDomain(name);
    const answer = await this.#call(
      "domains.dns.getList",
      { SLD: sld, TLD: tld },
      DnsListResponse,
      `read the nameservers of ${name}`,
    );
    const r = answer.DomainDNSGetListResult;
    return {
      usesNamecheapDns: r["@_IsUsingOurDNS"],
      nameservers: (r.Nameserver ?? []).map(normalizeDomain).filter(Boolean),
    };
  }

  /** `domains.dns.setCustom`: points the domain at other nameservers (Cloudflare's). */
  async setCustomNameservers(domain: string, nameservers: readonly string[]): Promise<void> {
    const name = normalizeDomain(domain);
    const { sld, tld } = splitDomain(name);
    const list = [...new Set(nameservers.map(normalizeDomain).filter(Boolean))];
    if (list.length < 2) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Namecheap needs at least two nameservers for ${name}, got ${list.length}.`,
      );
    }
    const what = `set the nameservers of ${name}`;
    const answer = await this.#call(
      "domains.dns.setCustom",
      { SLD: sld, TLD: tld, Nameservers: list.join(",") },
      SetCustomResponse,
      what,
    );
    if (!answer.DomainDNSSetCustomResult["@_Updated"]) {
      throw new OpsCrewError("PROVIDER_ERROR", `Namecheap did not ${what}.`, {
        hint: `Check the domain at ${this.dashboard.domainList} and try again.`,
      });
    }
  }

  /**
   * `domains.dns.getHosts`: the records Namecheap's DNS serves; undefined when the domain does not
   * use Namecheap's DNS (`IsUsingOurDNS` false or error 2030288).
   */
  async getHosts(domain: string): Promise<NamecheapHostList | undefined> {
    const name = normalizeDomain(domain);
    const { sld, tld } = splitDomain(name);
    let answer: z.infer<typeof HostsResponse>;
    try {
      answer = await this.#call(
        "domains.dns.getHosts",
        { SLD: sld, TLD: tld },
        HostsResponse,
        `read the DNS records of ${name}`,
        (errors) =>
          errors.some((e) => errorKind(e) === "notOurDns") ? new NotOurDns() : undefined,
      );
    } catch (error) {
      if (error instanceof NotOurDns) return undefined;
      throw error;
    }
    const r = answer.DomainDNSGetHostsResult;
    if (r?.["@_IsUsingOurDNS"] === false) return undefined;
    const hosts = [...(r?.Host ?? []), ...(r?.host ?? [])].map((h) => ({
      name: h["@_Name"].trim(),
      type: h["@_Type"].trim().toUpperCase(),
      address: h["@_Address"],
      ...(h["@_MXPref"] !== undefined ? { mxPref: h["@_MXPref"] } : {}),
      ...(h["@_TTL"] !== undefined ? { ttl: h["@_TTL"] } : {}),
    }));
    const emailType = r?.["@_EmailType"]?.trim().toUpperCase();
    return { hosts, ...(emailType ? { emailType } : {}) };
  }

  /** `domains.setRegistrarLock`: locks or unlocks the domain against transfers. */
  async setRegistrarLock(domain: string, locked: boolean): Promise<void> {
    const name = normalizeDomain(domain);
    const what = `${locked ? "lock" : "unlock"} ${name}`;
    const answer = await this.#call(
      "domains.setRegistrarLock",
      { DomainName: name, LockAction: locked ? "LOCK" : "UNLOCK" },
      RegistrarLockResponse,
      what,
    );
    if (!answer.DomainSetRegistrarLockResult["@_IsSuccess"]) {
      throw new OpsCrewError("PROVIDER_ERROR", `Namecheap did not ${what}.`);
    }
  }
}

const USER_SIDE_NUMBER = /^[12]\d{6}$/;

/**
 * True when every error says Namecheap refused the order before charging. Numbers decide:
 * authentication and validation errors (1xxxxxx, 2xxxxxx) are clear, and of the provider-side
 * numbers only "domain not available" (3019166, 4019166). 2528166 ("order creation failed") is
 * clear only when its text says the balance was too low. Kinds recognised by text (rate limit,
 * IP, access, balance) count only without a number or with a 1xxxxxx/2xxxxxx one. Everything
 * else (3xxxxxx, 4xxxxxx, 5xxxxxx, unknown) is not clear: the purchase may have started.
 */
export function isClearRejection(errors: readonly NamecheapApiError[]): boolean {
  if (errors.length === 0) return false;
  return errors.every((e) => {
    const kind = errorKind(e);
    const n = e.number;
    if (n === "3019166" || n === "4019166") return true;
    if (n === "2528166") return kind === "balance";
    if (TEXT_KINDS.has(kind)) return n === undefined || USER_SIDE_NUMBER.test(n);
    return n !== undefined && USER_SIDE_NUMBER.test(n);
  });
}
