import type {
  DomainCheck,
  RegisteredDomain,
  Registrar,
  RegistrarCapabilities,
  RegistrationRequest,
  RegistrationStatus,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { CloudflareClient } from "./client";

/** The client calls {@link CloudflareRegistrar} needs (a `CloudflareClient` or a test fake). */
export type CloudflareRegistrarApi = Pick<
  CloudflareClient,
  | "domainCheck"
  | "domainSearch"
  | "createRegistration"
  | "registrationStatus"
  | "getRegistration"
  | "setAutoRenew"
>;

/** Suggestions checked live per `suggest` call (one domain-check request). */
const MAX_SUGGESTIONS_CHECKED = 20;

/** The {@link Registrar} contract for one Cloudflare account. */
export class CloudflareRegistrar implements Registrar {
  readonly id = "cloudflare" as const;
  /** Cloudflare registrations always use Cloudflare's nameservers; DNSSEC is set on the zone. */
  readonly capabilities: RegistrarCapabilities = {
    purchase: true,
    chooseYears: true,
    nameservers: false,
    records: false,
    dnssec: false,
    autoRenew: true,
  };
  readonly #client: CloudflareRegistrarApi;
  readonly #accountId: string;

  constructor(client: CloudflareRegistrarApi, accountId: string) {
    this.#client = client;
    this.#accountId = accountId;
  }

  /** Live availability and prices. */
  check(domains: readonly string[]): Promise<DomainCheck[]> {
    return this.#client.domainCheck(this.#accountId, domains);
  }

  /** Cached suggestions for `query`, confirmed with a live check (at most 20). */
  async suggest(query: string): Promise<DomainCheck[]> {
    const suggestions = await this.#client.domainSearch(this.#accountId, query);
    const names = [...new Set(suggestions.map((s) => s.domain))].slice(0, MAX_SUGGESTIONS_CHECKED);
    if (names.length === 0) return [];
    return this.#client.domainCheck(this.#accountId, names);
  }

  registrationStatus(domain: string): Promise<RegistrationStatus | undefined> {
    return this.#client.registrationStatus(this.#accountId, domain);
  }

  /** Starts the purchase (costs money). Uses the account's default contact and payment method. */
  register(request: RegistrationRequest): Promise<RegistrationStatus> {
    if (!Number.isInteger(request.years) || request.years < 1 || request.years > 10) {
      return Promise.reject(
        new OpsCrewError(
          "INVALID_INPUT",
          `A domain can be registered for 1 to 10 years, not ${request.years}.`,
          { hint: "Pass a whole number of years between 1 and 10." },
        ),
      );
    }
    return this.#client.createRegistration(this.#accountId, {
      domain_name: request.domain,
      years: request.years,
      auto_renew: request.autoRenew,
      privacy_mode: request.privacy ? "redaction" : "off",
    });
  }

  getDomain(domain: string): Promise<RegisteredDomain | undefined> {
    return this.#client.getRegistration(this.#accountId, domain);
  }

  setAutoRenew(domain: string, on: boolean): Promise<RegisteredDomain> {
    return this.#client.setAutoRenew(this.#accountId, domain, on);
  }
}
