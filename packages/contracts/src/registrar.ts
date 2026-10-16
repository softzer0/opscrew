import type { IsoDateTime, Money } from "./common";

/** Registrars OpsCrew can buy and manage domains with (Cloudflare first; the rest in feature 007). */
export type RegistrarId = "cloudflare" | "namecheap" | "porkbun" | "godaddy";

/** Whether a domain can be bought through a registrar's API, and for how much. */
export interface DomainCheck {
  domain: string;
  registrable: boolean;
  tier?: "standard" | "premium";
  /** Price of the first year. */
  firstYear?: Money;
  /** Price of each renewal year. */
  renewal?: Money;
  /** Plain English when it cannot be bought here (premium, taken, needs the dashboard …). */
  reason?: string;
}

export interface RegistrationRequest {
  domain: string;
  years: number;
  autoRenew: boolean;
  /** WHOIS privacy (redaction) where the registrar offers it. */
  privacy: boolean;
  /**
   * The quote the user approved. Registrars that bind the purchase to a price or a quote use it
   * (Porkbun sends its price as `cost` and fails when it changed; GoDaddy sends the quote token).
   */
  quote?: RegistrationQuote;
  /**
   * Stable for one purchase (from the purchase record), so a replayed request never buys twice.
   * Registrars with idempotency keys (Porkbun, GoDaddy) send it.
   */
  idempotencyKey?: string;
}

/** What a registrar can do through its API. */
export interface RegistrarCapabilities {
  purchase: boolean;
  /** Years can be chosen at purchase (Porkbun registers the registry minimum only). */
  chooseYears: boolean;
  /** The domain's nameservers can be read and set. */
  nameservers: boolean;
  /** The domain's current DNS records can be read (when the registrar hosts its DNS). */
  records: boolean;
  /** DS records can be read and changed at the registry. */
  dnssec: boolean;
  /** Auto-renew can be changed through the API. */
  autoRenew: boolean;
}

/** A price (and, for some registrars, a token) to show and approve before buying. */
export interface RegistrationQuote {
  /** What this purchase costs now, for all years. */
  price: Money;
  renewal?: Money;
  /** GoDaddy's quote token. */
  token?: string;
  /** Agreements the registrar requires the user to accept (shown in the approval). */
  agreements?: string[];
  /** The registrar's ids of those agreements, sent back with the purchase (GoDaddy). */
  agreementTypes?: string[];
  expiresAt?: IsoDateTime;
}

/** A DNS record as a registrar's own DNS hosting reports it. */
export interface RegistrarDnsRecord {
  /** `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV`, `CAA`, `ALIAS`, `URL`, … */
  type: string;
  /** Fully qualified name, lower case, without a trailing dot. */
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

/** A DS record published at the registry for DNSSEC. */
export interface DsRecord {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

/** Whether the registrar account can be used through the API, in plain English. */
export interface RegistrarAccountCheck {
  ok: boolean;
  message: string;
  /** What to do when not ok (settings page, IP to whitelist, missing key scope …). */
  fix?: string;
  /** Prepaid account balance, when the registrar has one. */
  balance?: Money;
}

export type RegistrationState =
  | "pending"
  | "in_progress"
  | "action_required"
  | "blocked"
  | "succeeded"
  | "failed";

export interface RegistrationStatus {
  domain: string;
  state: RegistrationState;
  /** The registrar's explanation for `action_required`, `blocked` or `failed`. */
  message?: string;
}

export interface RegisteredDomain {
  domain: string;
  registrar: RegistrarId;
  createdAt?: IsoDateTime;
  expiresAt?: IsoDateTime;
  autoRenew: boolean;
  locked?: boolean;
  privacy?: boolean;
}

/** Buying and managing domains with one registrar account (a typed adapter, constitution VIII). */
export interface Registrar {
  readonly id: RegistrarId;
  /** Live availability and prices, authoritative. */
  check(domains: readonly string[]): Promise<DomainCheck[]>;
  /** Suggestions for a name; may be cached, so confirm with `check` before buying. */
  suggest(query: string): Promise<DomainCheck[]>;
  /** The account's registration (or pending purchase) of the domain; undefined when there is none. */
  registrationStatus(domain: string): Promise<RegistrationStatus | undefined>;
  /** Starts the purchase and returns the first status. Costs money; never call twice for one domain. */
  register(request: RegistrationRequest): Promise<RegistrationStatus>;
  getDomain(domain: string): Promise<RegisteredDomain | undefined>;
  setAutoRenew(domain: string, on: boolean): Promise<RegisteredDomain>;
  /** What this registrar supports through its API. */
  readonly capabilities: RegistrarCapabilities;
  /** A price (or quote) for buying the domain for `years`, to show before the approval. */
  quote?(domain: string, years: number): Promise<RegistrationQuote>;
  /** Masked registrant summary for the approval, e.g. "J*** D***, DE" — never the full data. */
  contactSummary?(): Promise<string | undefined>;
  /** True when the domain is registered in this account. */
  ownsDomain?(domain: string): Promise<boolean>;
  getNameservers?(domain: string): Promise<string[]>;
  setNameservers?(domain: string, nameservers: readonly string[]): Promise<void>;
  /** The registrar-hosted DNS records; undefined when the registrar does not host the DNS. */
  listRecords?(domain: string): Promise<RegistrarDnsRecord[] | undefined>;
  listDsRecords?(domain: string): Promise<DsRecord[]>;
  addDsRecord?(domain: string, ds: DsRecord): Promise<void>;
  removeDsRecord?(domain: string, keyTag: number): Promise<void>;
  /** API access, permissions, whitelisting and balance, in plain English. */
  accountCheck?(): Promise<RegistrarAccountCheck>;
}
