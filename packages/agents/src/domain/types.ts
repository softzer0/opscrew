import type { DomainCheck, RegisteredDomain, Registrar } from "@opscrew/contracts";

/** A Cloudflare account the token can use. */
export interface DomainAccount {
  id: string;
  name: string;
}

/** Zone calls the setup after a purchase needs (a Cloudflare client or a test fake). */
export interface DomainZoneApi {
  findZone(name: string): Promise<{ id: string; name: string } | undefined>;
  /** Creates the zone on the account; returns the existing one when it already exists. */
  createZone(accountId: string, name: string): Promise<{ id: string; name: string }>;
  enableDnssec(zoneId: string): Promise<void>;
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
  /** Checked live, cheapest registrable first. */
  results: DomainCheck[];
}

export interface BuyDomainOptions {
  domain: string;
  /** Registration years (default 1). */
  years?: number;
  /** Renew automatically before expiry (default true). */
  autoRenew?: boolean;
  account?: string;
  /** Upper bound for the first-year total in the price's currency (required by scripts). */
  maxPrice?: number;
  services?: DomainServices;
}

export interface BuyDomainResult {
  domain: RegisteredDomain;
  zoneId: string;
  /** Plain-English next steps for the CLI to print. */
  next: string[];
}

export interface DomainStatusResult {
  /** Undefined when the plan has no domain bought through OpsCrew. */
  domain?: RegisteredDomain;
  dnssec?: boolean;
  next: string[];
}

export interface SetAutoRenewOptions {
  on: boolean;
  account?: string;
  services?: DomainServices;
}
