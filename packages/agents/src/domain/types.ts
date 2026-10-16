import type { CloudflareRecordInput } from "@opscrew/connector-cloudflare";
import type {
  Currency,
  DomainCheck,
  DsRecord,
  Money,
  RegisteredDomain,
  Registrar,
  RegistrarDnsRecord,
  RegistrarId,
} from "@opscrew/contracts";

/** A Cloudflare account the token can use. */
export interface DomainAccount {
  id: string;
  name: string;
}

/** A Cloudflare zone as the domain commands see it. */
export interface DomainZone {
  id: string;
  name: string;
  /** `pending` until the domain's nameservers point at Cloudflare, then `active`. */
  status?: string;
  /** The Cloudflare nameservers assigned to the zone (to set at another registrar). */
  nameServers?: string[];
  /** The Cloudflare account that holds the zone, when known. */
  accountId?: string;
}

/** The DS record Cloudflare publishes for a zone's DNSSEC, to add at another registrar. */
export interface ZoneDsRecord extends DsRecord {
  /** The full DS record text, for registrars whose dashboard takes one line. */
  ds?: string;
}

/** A DNS record already in a Cloudflare zone (to skip records copied by an earlier run). */
export interface ZoneRecord {
  type: string;
  name: string;
  content: string;
  /** True when Cloudflare proxies the record (only HTTP and HTTPS reach the origin). */
  proxied?: boolean;
  /** MX priority. */
  priority?: number;
}

/**
 * Zone calls the domain commands need: a Cloudflare client, the stand-ins of a registrar sandbox
 * (`SANDBOX_ZONES`) or a test fake.
 */
export interface DomainZoneApi {
  /**
   * The zone named exactly `name` that the token can see. Read-only and not scoped to an account,
   * so only status reads and resumed runs use it; setting up uses `createZone`.
   */
  findZone(name: string): Promise<DomainZone | undefined>;
  /** Creates the zone on the account; returns the existing one only when it is in that account. */
  createZone(accountId: string, name: string): Promise<DomainZone>;
  enableDnssec(zoneId: string): Promise<void>;
  /**
   * Whether DNSSEC is on for the zone (Cloudflare `GET /zones/{id}/dnssec`: `active` or
   * `pending`), or `skipped` when these zone calls set no DNSSEC up at all (the stand-ins of a
   * registrar sandbox), so every DNSSEC step is skipped.
   */
  dnssecEnabled(zoneId: string): Promise<boolean | "skipped">;
  /** The zone's DS record once DNSSEC is on (active or pending); undefined before. */
  dsRecord(zoneId: string): Promise<ZoneDsRecord | undefined>;
  /**
   * Asks Cloudflare to re-check the zone's nameservers now. `requested: false` (with the reason)
   * when Cloudflare says it is too soon; it keeps checking on its own. `skipped` when the zone is
   * never activated (the stand-ins of a registrar sandbox), so nothing waits for it.
   */
  activationCheck(
    zoneId: string,
  ): Promise<{ requested: boolean; reason?: string; skipped?: boolean }>;
  /** The records in the zone. */
  listRecords(zoneId: string): Promise<ZoneRecord[]>;
  /** Creates records in one batch per call (all or none of a call); returns how many. */
  createRecords(zoneId: string, records: readonly CloudflareRecordInput[]): Promise<number>;
  /** Cloudflare's scan of the domain's current public DNS (shown for review, never accepted). */
  scanRecords(zoneId: string): Promise<RegistrarDnsRecord[]>;
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
  /**
   * The other registrars (feature 007), each for the single account its credentials belong to
   * (default: built from their environment variables by `registrarFor`). When given, these are the
   * only other registrars OpsCrew uses (tests); `configuredRegistrars` then lists Cloudflare plus
   * these.
   */
  registrars?: Partial<Record<Exclude<RegistrarId, "cloudflare">, Registrar>>;
  /** An extension's registrar settings; undefined when Cloudflare does not know it. */
  extension?: (accountId: string, tld: string) => Promise<DomainExtension | undefined>;
  zones?: DomainZoneApi;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for the registration wait. */
  now?: () => number;
  /** Idempotency keys for purchases (default `crypto.randomUUID`). */
  randomUUID?: () => string;
}

export interface SearchDomainsOptions {
  /** A name or keyword, for example `shopapp` or `shopapp.com`. */
  query: string;
  /** Search at this registrar (default `cloudflare`). */
  registrar?: RegistrarId;
  /** Check the name at every configured registrar and list the prices side by side. */
  compare?: boolean;
  /** Cloudflare account id when the token sees several. */
  account?: string;
  /**
   * How the caller passes `account`, named in hints when the token sees several accounts (default
   * `--account`; the MCP tool says "the `account` input").
   */
  accountOption?: string;
  services?: DomainServices;
}

export interface SearchDomainsResult {
  /** The Cloudflare account searched (absent for a search at another registrar). */
  account?: DomainAccount;
  /** The registrar searched, for a search at another registrar than Cloudflare. */
  registrar?: RegistrarId;
  /**
   * Checked live, registrable names first (cheapest first year first). Names OpsCrew cannot buy
   * (premium, taken, extension sold only in the dashboard …) have `registrable: false` and a
   * plain-English `reason`. Empty for `compare` (see `comparison`).
   */
  results: DomainCheck[];
  /** `compare`: each name with every configured registrar's offer. */
  comparison?: DomainComparison[];
}

/** One registrar's live answer for a name. */
export interface DomainOffer extends DomainCheck {
  registrar: RegistrarId;
  /** Plain English about the price, e.g. `priced in EUR; not compared with USD prices`. */
  note?: string;
}

/**
 * A name checked at every configured registrar. Offers are sorted by renewal price, then by
 * first-year price, and by nothing else (no ranking, no referral data). Prices are compared in
 * one currency only (the first priced offer's): offers in another currency follow with a `note`;
 * offers that cannot be bought (or failed, with a plain `reason`) come last.
 */
export interface DomainComparison {
  domain: string;
  offers: DomainOffer[];
}

export interface BuyDomainOptions {
  domain: string;
  /** Where to buy (default `cloudflare`); other registrars then point the domain at Cloudflare. */
  registrar?: RegistrarId;
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
  /** Where the domain is registered, when not at Cloudflare. */
  registrar?: RegistrarId;
  /** The Cloudflare zone's nameservers the domain points at (domains registered elsewhere). */
  nameservers?: string[];
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
  /** The registrar holding the domain (default: the plan's `dns.registration.registrar`, else Cloudflare). */
  registrar?: RegistrarId;
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
  /** The registrar holding the domain (default: the plan's `dns.registration.registrar`, else Cloudflare). */
  registrar?: RegistrarId;
  services?: DomainServices;
}
