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
}
