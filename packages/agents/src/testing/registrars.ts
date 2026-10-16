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
  RegistrationState,
  RegistrationStatus,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { OtherRegistrarId } from "../domain/registrars";

/** The capabilities the real adapters declare (see each connector's `capabilities`). */
export const CAPABILITIES: Readonly<Record<OtherRegistrarId, RegistrarCapabilities>> = {
  porkbun: {
    purchase: true,
    chooseYears: false,
    nameservers: true,
    records: true,
    dnssec: true,
    autoRenew: true,
  },
  namecheap: {
    purchase: true,
    chooseYears: true,
    nameservers: true,
    records: true,
    dnssec: false,
    autoRenew: false,
  },
  godaddy: {
    purchase: true,
    chooseYears: true,
    nameservers: true,
    records: true,
    dnssec: false,
    autoRenew: false,
  },
};

const NAMES: Readonly<Record<OtherRegistrarId, string>> = {
  porkbun: "Porkbun",
  namecheap: "Namecheap",
  godaddy: "GoDaddy",
};

/**
 * Obviously fake registrant data the fake adapters hold in memory, as Namecheap's adapter holds
 * the account's default address (ADR 0009). None of it may ever reach the reporter, the audit log,
 * an approval or an error (SC-702).
 */
export const SEEDED_CONTACT = {
  firstName: "Testa",
  lastName: "Personne",
  organization: "Fixture Holdings",
  email: "testa.personne@example.invalid",
  phone: "+1.5550104477",
  street: "77 Fixture Lane",
  city: "Mockville",
  postalCode: "98765",
} as const;

/** The masked summary the fakes return from `contactSummary` (what the approval shows). */
export const MASKED_CONTACT = "T*** P***, US";

/** Nameservers each registrar sets on a new registration (before OpsCrew points it at Cloudflare). */
export const DEFAULT_NAMESERVERS: Readonly<Record<OtherRegistrarId, readonly string[]>> = {
  porkbun: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"],
  namecheap: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"],
  godaddy: ["ns01.domaincontrol.com", "ns02.domaincontrol.com"],
};

const usd = (amount: number): Money => ({ amount, currency: "USD" });

type Operation =
  | "check"
  | "suggest"
  | "quote"
  | "accountCheck"
  | "contactSummary"
  | "status"
  | "register"
  | "getDomain"
  | "setAutoRenew"
  | "getNameservers"
  | "setNameservers"
  | "listRecords"
  | "listDsRecords"
  | "addDsRecord";

/**
 * A Porkbun, Namecheap or GoDaddy account as the domain commands see it. State lives here, so
 * every run against the same fake sees what earlier runs bought. Calls are appended to the shared
 * `events` list (the Cloudflare fake's), prefixed with the registrar id, so tests can assert the
 * order across the registrar and Cloudflare.
 */
export class FakeRegistrar {
  readonly capabilities: RegistrarCapabilities;
  /** Live check answers by domain; names without an answer are left out. */
  readonly checks = new Map<string, DomainCheck>();
  /** Replaces the quote of the n-th (1-based) quote call. */
  quoteOverride?: (domain: string, years: number, call: number) => RegistrationQuote | undefined;
  /** Added to every quote (GoDaddy's token, agreements and expiry). */
  quoteExtras: Partial<RegistrationQuote> = {};
  /** What `accountCheck` answers. */
  account: RegistrarAccountCheck = { ok: true, message: "The API access works." };
  /** Registrations in the account, by domain. */
  readonly registrations = new Map<string, RegistrationStatus>();
  /** Registrations the registrar does not list yet (Namecheap's non-real-time orders). */
  readonly unlisted = new Set<string>();
  readonly domains = new Map<string, RegisteredDomain>();
  readonly nameservers = new Map<string, string[]>();
  readonly dsRecords = new Map<string, DsRecord[]>();
  /** Records the registrar's DNS hosting serves, by domain. */
  readonly records = new Map<string, RegistrarDnsRecord[]>();
  /** First status `register` answers with (Porkbun and Namecheap buy synchronously). */
  firstState: RegistrationState = "succeeded";
  /** States a pending registration moves to on each status call, in order. */
  progress: RegistrationState[] = [];
  /** Registrar messages per state. */
  messages: Partial<Record<RegistrationState, string>> = {};
  /** Auto-renew of a new registration when the API cannot set it (the account's default). */
  accountAutoRenew = false;
  readonly registerCalls: RegistrationRequest[] = [];
  readonly autoRenewCalls: { domain: string; on: boolean }[] = [];
  /** Throws instead of performing the operation (n = 1-based call count of that operation). */
  failures: Partial<Record<Operation, (call: number) => Error | undefined>> = {};
  /** `register` creates the registration, then throws (the answer was lost). */
  loseRegisterResponse = false;
  /** Contacts relayed to the registrar with purchases (kept here, never returned). */
  readonly relayed: (typeof SEEDED_CONTACT)[] = [];
  private readonly requests = new Map<string, RegistrationRequest>();
  private readonly calls = new Map<Operation, number>();

  constructor(
    readonly id: OtherRegistrarId,
    readonly events: string[],
    capabilities: Partial<RegistrarCapabilities> = {},
  ) {
    this.capabilities = { ...CAPABILITIES[id], ...capabilities };
  }

  get name(): string {
    return NAMES[this.id];
  }

  private enter(operation: Operation, event: string): void {
    const call = (this.calls.get(operation) ?? 0) + 1;
    this.calls.set(operation, call);
    this.events.push(`${this.id} ${event}`);
    const error = this.failures[operation]?.(call);
    if (error !== undefined) throw error;
  }

  count(operation: Operation): number {
    return this.calls.get(operation) ?? 0;
  }

  /** Marks the domain as registered in the account (bought earlier, outside this run). */
  own(domain: string, details: Partial<RegisteredDomain> = {}): void {
    this.registrations.set(domain, { domain, state: "succeeded" });
    this.domains.set(domain, {
      domain,
      registrar: this.id,
      createdAt: "2026-01-02T03:04:05Z",
      expiresAt: "2027-01-02T03:04:05Z",
      autoRenew: true,
      locked: true,
      privacy: true,
      ...details,
    });
    if (!this.nameservers.has(domain)) {
      this.nameservers.set(domain, [...DEFAULT_NAMESERVERS[this.id]]);
    }
  }

  private advance(domain: string): RegistrationStatus | undefined {
    if (this.unlisted.has(domain)) return undefined;
    const current = this.registrations.get(domain);
    if (current === undefined) return undefined;
    const terminal = current.state === "succeeded" || current.state === "failed";
    const next = terminal ? undefined : this.progress.shift();
    if (next !== undefined) this.setState(domain, next);
    const status = this.registrations.get(domain);
    return status === undefined ? undefined : { ...status };
  }

  private setState(domain: string, state: RegistrationState): void {
    const message = this.messages[state];
    this.registrations.set(domain, { domain, state, ...(message ? { message } : {}) });
    const request = this.requests.get(domain);
    if (state === "succeeded" && request !== undefined && !this.domains.has(domain)) {
      this.domains.set(domain, {
        domain,
        registrar: this.id,
        createdAt: "2026-10-11T12:00:05Z",
        expiresAt: `${2026 + request.years}-10-11T12:00:05Z`,
        autoRenew: this.capabilities.autoRenew ? request.autoRenew : this.accountAutoRenew,
        locked: true,
        privacy: request.privacy,
      });
      this.nameservers.set(domain, [...DEFAULT_NAMESERVERS[this.id]]);
    }
  }

  private defaultQuote(domain: string, years: number): RegistrationQuote {
    const check = this.checks.get(domain);
    if (check === undefined || !check.registrable || check.firstYear === undefined) {
      throw new OpsCrewError("PHASE_PRECONDITION", `${domain} is not available at ${this.name}.`, {
        hint: "Pick another name with `opscrew domain search`.",
      });
    }
    const price = usd(Math.round(check.firstYear.amount * years * 100) / 100);
    return { price, ...(check.renewal ? { renewal: check.renewal } : {}), ...this.quoteExtras };
  }

  /** The adapter as the domain commands use it; optional methods as the real adapter has them. */
  api(): Registrar {
    const id = this.id;
    const registrar: Registrar = {
      id,
      capabilities: this.capabilities,
      check: async (domains) => {
        this.enter("check", `check ${domains.join(",")}`);
        return domains.flatMap((d) => {
          const answer = this.checks.get(d);
          return answer === undefined ? [] : [{ ...answer }];
        });
      },
      suggest: async (query) => {
        this.enter("suggest", `suggest ${query}`);
        return [];
      },
      quote: async (domain, years) => {
        this.enter("quote", `quote ${domain} ${years}`);
        const call = this.count("quote");
        return this.quoteOverride?.(domain, years, call) ?? this.defaultQuote(domain, years);
      },
      registrationStatus: async (domain) => {
        this.enter("status", `status ${domain}`);
        return this.advance(domain);
      },
      register: async (request) => {
        this.enter("register", `register ${request.domain}`);
        this.registerCalls.push({ ...request });
        this.relayed.push({ ...SEEDED_CONTACT });
        this.requests.set(request.domain, { ...request });
        this.setState(request.domain, this.firstState);
        if (this.loseRegisterResponse) throw new Error("socket hang up");
        return { ...(this.registrations.get(request.domain) as RegistrationStatus) };
      },
      getDomain: async (domain) => {
        this.enter("getDomain", `getDomain ${domain}`);
        if (this.unlisted.has(domain)) return undefined;
        const found = this.domains.get(domain);
        return found === undefined ? undefined : { ...found };
      },
      setAutoRenew: async (domain, on) => {
        this.enter("setAutoRenew", `setAutoRenew ${domain} ${on ? "on" : "off"}`);
        if (!this.capabilities.autoRenew) {
          throw new OpsCrewError(
            "PHASE_PRECONDITION",
            `${this.name}'s API cannot change auto-renew for ${domain}.`,
          );
        }
        this.autoRenewCalls.push({ domain, on });
        const found = this.domains.get(domain);
        if (found === undefined) throw new Error(`no registration of ${domain}`);
        const updated = { ...found, autoRenew: on };
        this.domains.set(domain, updated);
        return { ...updated };
      },
      ownsDomain: async (domain) => this.domains.has(domain) && !this.unlisted.has(domain),
      getNameservers: async (domain) => {
        this.enter("getNameservers", `getNameservers ${domain}`);
        const found = this.nameservers.get(domain);
        if (found === undefined) {
          throw new OpsCrewError("PHASE_PRECONDITION", `${domain} is not in this account.`);
        }
        return [...found];
      },
      setNameservers: async (domain, nameservers) => {
        this.enter("setNameservers", `setNameservers ${domain} ${nameservers.join(",")}`);
        this.nameservers.set(domain, [...nameservers]);
      },
      listRecords: async (domain) => {
        this.enter("listRecords", `listRecords ${domain}`);
        return this.records.get(domain)?.map((r) => ({ ...r }));
      },
      accountCheck: async () => {
        this.enter("accountCheck", "accountCheck");
        return { ...this.account };
      },
    };
    if (id === "porkbun") {
      registrar.listDsRecords = async (domain) => {
        this.enter("listDsRecords", `listDsRecords ${domain}`);
        return (this.dsRecords.get(domain) ?? []).map((r) => ({ ...r }));
      };
      registrar.addDsRecord = async (domain, ds) => {
        this.enter("addDsRecord", `addDsRecord ${domain} ${ds.keyTag}`);
        this.dsRecords.set(domain, [...(this.dsRecords.get(domain) ?? []), { ...ds }]);
      };
    } else {
      registrar.contactSummary = async () => {
        this.enter("contactSummary", "contactSummary");
        return id === "namecheap"
          ? MASKED_CONTACT
          : "the GoDaddy account's default contact profile";
      };
    }
    return registrar;
  }
}
