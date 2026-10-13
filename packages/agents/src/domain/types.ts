import type { Currency, DomainCheck, Money, RegisteredDomain, Registrar } from "@opscrew/contracts";

/** A Cloudflare account the token can use. */
export interface DomainAccount {
  id: string;
  name: string;
}

/** Zone calls the setup after a purchase needs (a Cloudflare client or a test fake). */
export interface DomainZoneApi {
  /**
   * The zone named exactly `name` that the token can see. Read-only and not scoped to an account,
   * so only `opscrew domain status` uses it (to read DNSSEC); setting up uses `createZone`.
   */
  findZone(name: string): Promise<{ id: string; name: string } | undefined>;
  /** Creates the zone on the account; returns the existing one only when it is in that account. */
  createZone(accountId: string, name: string): Promise<{ id: string; name: string }>;
  enableDnssec(zoneId: string): Promise<void>;
  /**
   * Whether DNSSEC is on for the zone (Cloudflare `GET /zones/{id}/dnssec`: `active` or
   * `pending`). Without it, the setup always turns DNSSEC on and status reads the plan.
   */
  dnssecEnabled?(zoneId: string): Promise<boolean>;
}

/** Registrar settings of an extension that matter to OpsCrew. */
export interface DomainExtension {
  /** Registrant contact extensions are required, so the domain is bought in the dashboard. */
  contactExtensionsRequired: boolean;
}

/**
 * Collaborators that talk to the outside world; each defaults to the real Cloudflare
 * implementation built from `CLOUDFLARE_API_TOKEN`, tests replace them with fakes.
 */
export interface DomainServices {
  /** Accounts the token can use (default: Cloudflare `GET /accounts`). */
  accounts?: () => Promise<DomainAccount[]>;
  /** Registrar for one account (default: `CloudflareRegistrar`). */
  registrar?: (accountId: string) => Registrar;
  /** An extension's registrar settings; undefined when Cloudflare does not know it. */
  extension?: (accountId: string, tld: string) => Promise<DomainExtension | undefined>;
  zones?: DomainZoneApi;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for the registration wait. */
  now?: () => number;
}

export interface SearchDomainsOptions {
  /** A name or keyword, for example `shopapp` or `shopapp.com`. */
  query: string;
  /** Cloudflare account id when the token sees several. */
  account?: string;
  services?: DomainServices;
}

export interface SearchDomainsResult {
  account: DomainAccount;
  /**
   * Checked live, registrable names first (cheapest first year first). Names OpsCrew cannot buy
   * (premium, taken, extension sold only in the dashboard …) have `registrable: false` and a
   * plain-English `reason`.
   */
  results: DomainCheck[];
}

export interface BuyDomainOptions {
  domain: string;
  /** Registration years, 1–10 (default 1). */
  years?: number;
  /**
   * Renew automatically before expiry (default true for a new purchase). For a domain that is
   * already on the account, auto-renew only changes when this is set, after an approval.
   */
  autoRenew?: boolean;
  account?: string;
  /**
   * Upper bound for what is charged now (all chosen years). A plain number is in the currency
   * Cloudflare quotes; a given currency must match the quote. Required in non-interactive runs.
   */
  maxPrice?: number | MaxPrice;
  /**
   * Clears OpsCrew's note about an earlier purchase of this domain that Cloudflare does not show
   * (after the user checked the Cloudflare dashboard), with a typed `domain-settings` approval,
   * then buys as usual. Refused while Cloudflare shows the purchase.
   */
  forgetPendingPurchase?: boolean;
  services?: DomainServices;
}

/** A price limit, for example `{ amount: 12.5, currency: "USD" }` (`--max-price 12.50USD`). */
export interface MaxPrice {
  amount: number;
  currency?: Currency;
}

/** What `buyDomain` did: set a domain up (bought or already owned), or forgot a purchase note. */
export type BuyDomainResult = DomainSetUpResult | PurchaseForgottenResult;

/** The domain is registered on the account and set up for the project. */
export interface DomainSetUpResult {
  outcome: "set-up";
  domain: RegisteredDomain;
  zoneId: string;
  /**
   * The approved price charged now, when OpsCrew bought the domain: exact for one year, the upper
   * bound (years × the higher of the first-year and renewal prices) for several years.
   */
  total?: Money;
  /** True when the domain was already on the account, so OpsCrew only set it up. */
  alreadyRegistered: boolean;
  /** Which project files now record the domain (false when absent or the user kept the old one). */
  recorded: { plan: boolean; requirements: boolean };
  /** Plain-English next steps for the CLI to print. */
  next: string[];
}

/**
 * `forgetPendingPurchase`: OpsCrew's note about an unfinished purchase was cleared and the run
 * ended; nothing was checked, approved or bought. Buying is a separate, later run.
 */
export interface PurchaseForgottenResult {
  outcome: "forgotten";
  /** The domain whose purchase note was cleared. */
  forgotten: string;
  /** Plain-English next steps for the CLI to print. */
  next: string[];
}

export interface DomainStatusOptions {
  account?: string;
  services?: DomainServices;
}

export interface DomainStatusResult {
  /** Undefined when the plan has no domain bought through OpsCrew. */
  domain?: RegisteredDomain;
  dnssec?: boolean;
  /** A purchase an earlier run started and did not finish. */
  pendingPurchase?: { domain: string; requestedAt: string };
  next: string[];
}

export interface SetAutoRenewOptions {
  on: boolean;
  account?: string;
  services?: DomainServices;
}
