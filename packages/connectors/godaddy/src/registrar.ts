import type {
  DomainCheck,
  RegisteredDomain,
  Registrar,
  RegistrarAccountCheck,
  RegistrarCapabilities,
  RegistrarDnsRecord,
  RegistrationQuote,
  RegistrationRequest,
  RegistrationStatus,
} from "@opscrew/contracts";
import { normalizeHostName, OpsCrewError } from "@opscrew/core";
import type { z } from "zod";
import { GODADDY_MAX_BATCH, type GoDaddyClient } from "./client";
import {
  describeError,
  formatAgreement,
  GODADDY_DASHBOARD_URLS,
  type GoDaddyOperation,
  type GoDaddyRegistration,
  holding,
  isHeld,
  isoDate,
  isPremium,
  type ResolvedSchema,
  toDomainCheck,
  toMoney,
  toRegisteredDomain,
  toRegistrarRecord,
  usesGoDaddyDns,
} from "./parse";

/** The client calls {@link GoDaddyRegistrar} needs (a `GoDaddyClient` or a test fake). */
export type GoDaddyRegistrarApi = Pick<
  GoDaddyClient,
  | "checkAvailability"
  | "checkOne"
  | "suggestDomains"
  | "quoteRegistration"
  | "registerDomain"
  | "getRegistration"
  | "getOperation"
  | "getDomain"
  | "listDomains"
  | "updateNameservers"
  | "listDnsRecords"
>;

export interface GoDaddyRegistrarOptions {
  /** Saved contact profile for purchases (GODADDY_PROFILE_ID); omitted → the account default. */
  profileId?: string;
  now?: () => Date;
  randomUUID?: () => string;
  /** Wait between status polls (default 3 s). */
  pollIntervalMs?: number;
  /** How long to poll a registration or nameserver change (default 60 s). */
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Resolved = z.infer<typeof ResolvedSchema>;

/** Suggestions requested per `suggest` call. */
const SUGGESTIONS = 20;
/** Any domain name works for the access probe; GoDaddy only answers whether it is available. */
const ACCESS_PROBE_DOMAIN = "opscrew-access-check.com";
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,64}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

const onOff = (value: boolean) => (value ? "on" : "off");

function notInAccount(domain: string): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", `${domain} is not in this GoDaddy account.`, {
    hint: `Check the domain at ${GODADDY_DASHBOARD_URLS.portfolio}, or connect it with the registrar that holds it.`,
  });
}

/**
 * The {@link Registrar} contract for one GoDaddy account (Domains API v3). Purchases use a saved
 * contact profile (or the account's default); contact data is never sent, kept or returned.
 */
export class GoDaddyRegistrar implements Registrar {
  readonly id = "godaddy" as const;
  /** v3 has no auto-renew or DNSSEC endpoints yet; both stay in the dashboard. */
  readonly capabilities: RegistrarCapabilities = {
    purchase: true,
    chooseYears: true,
    nameservers: true,
    records: true,
    dnssec: false,
    autoRenew: false,
  };
  readonly #client: GoDaddyRegistrarApi;
  readonly #profileId: string | undefined;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #pollIntervalMs: number;
  readonly #pollTimeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Per quote token: the settings GoDaddy will apply. */
  readonly #resolved = new Map<string, Resolved>();
  /** Registrations this instance started that had not finished when `register` returned. */
  readonly #pending = new Map<string, { operationId?: string; registrationId?: string }>();
  #lastResolved: Resolved | undefined;

  constructor(client: GoDaddyRegistrarApi, options: GoDaddyRegistrarOptions = {}) {
    this.#client = client;
    this.#profileId = options.profileId?.trim() || undefined;
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
    this.#pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 3_000);
    this.#pollTimeoutMs = Math.max(0, options.pollTimeoutMs ?? 60_000);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Indicative availability and prices, 25 domains per call, matched to the names by name. */
  async check(domains: readonly string[]): Promise<DomainCheck[]> {
    const names = domains.map(normalizeHostName);
    const results: DomainCheck[] = [];
    for (let i = 0; i < names.length; i += GODADDY_MAX_BATCH) {
      const chunk = names.slice(i, i + GODADDY_MAX_BATCH);
      const items = await this.#client.checkAvailability(chunk);
      for (const name of chunk) {
        const item = items.find((it) => normalizeHostName(it.domain) === name);
        results.push(
          item
            ? toDomainCheck(item)
            : {
                domain: name,
                registrable: false,
                reason: "GoDaddy did not return a result for this domain; try again in a minute.",
              },
        );
      }
    }
    return results;
  }

  /** GoDaddy's suggestions for `query` (available names, indicative prices). */
  async suggest(query: string): Promise<DomainCheck[]> {
    const suggestions = await this.#client.suggestDomains(query, SUGGESTIONS);
    return suggestions.map((s) => toDomainCheck({ ...s, available: true }));
  }

  /** A locked price and quote token (valid 10 minutes) for buying `domain` for `years`. */
  async quote(domain: string, years: number): Promise<RegistrationQuote> {
    const name = normalizeHostName(domain);
    checkYears(years);
    const raw = await this.#client.quoteRegistration({
      domain: name,
      period: years,
      ...(this.#profileId ? { profileId: this.#profileId } : {}),
    });
    if (!raw.available) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `GoDaddy cannot register ${name}: it is not available.`,
        {
          hint: `Pick another name; if ${name} is already yours, run \`opscrew domain connect ${name}\`.`,
        },
      );
    }
    if (isPremium(raw.inventory) || (raw.fees ?? []).length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${name} is a premium domain at GoDaddy; OpsCrew does not buy premium names through the API.`,
        {
          hint: `Buy it at ${GODADDY_DASHBOARD_URLS.portfolio}, then run \`opscrew domain connect ${name}\`.`,
        },
      );
    }
    if (!raw.quoteToken || !raw.price || (raw.period !== undefined && raw.period !== years)) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `GoDaddy returned an incomplete quote for ${name}.`,
        { hint: "Try again in a minute." },
      );
    }
    const price = toMoney(raw.price);
    if (!price) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `GoDaddy quoted ${name} in ${raw.price.currencyCode}, which OpsCrew cannot show yet.`,
        {
          hint: `Buy it at ${GODADDY_DASHBOARD_URLS.portfolio}, then run \`opscrew domain connect ${name}\`.`,
        },
      );
    }
    // Renewal prices are per term (like check-availability); shown per year.
    const renewal = raw.renewalPrice ? toMoney(raw.renewalPrice, raw.period ?? years) : undefined;
    const agreements = raw.requiredAgreements ?? [];
    const expiresAt = isoDate(raw.expiresAt);
    if (raw.resolved) this.#resolved.set(raw.quoteToken, raw.resolved);
    this.#lastResolved = raw.resolved;
    return {
      price,
      ...(renewal ? { renewal } : {}),
      token: raw.quoteToken,
      agreements: agreements.map(formatAgreement),
      agreementTypes: agreements.map((a) => a.agreementType),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  /** Where the registrant contact comes from (a profile id or the account), never contact data. */
  async contactSummary(): Promise<string | undefined> {
    const source = this.#lastResolved?.contactSource?.toUpperCase();
    if (source === "ACCOUNT") return "the GoDaddy account's own contact details";
    const profile = this.#lastResolved?.profileId ?? this.#profileId;
    if (profile) return `GoDaddy contact profile ${profile}`;
    return "the GoDaddy account's default contact profile";
  }

  /**
   * Buys the domain with the approved quote (costs money; never retried). Sends the quote token,
   * consent to the quote's agreements and an idempotency key, then polls until GoDaddy reports
   * `COMPLETED` or `FAILED` (bounded; still running → `in_progress`).
   */
  async register(request: RegistrationRequest): Promise<RegistrationStatus> {
    const domain = normalizeHostName(request.domain);
    checkYears(request.years);
    const quote = request.quote;
    if (!quote?.token) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `Buying ${domain} at GoDaddy needs the approved quote with GoDaddy's quote token.`,
        { hint: "Get a GoDaddy quote first, approve it, and buy with that quote." },
      );
    }
    const expires = quote.expiresAt ? Date.parse(quote.expiresAt) : Number.NaN;
    if (Number.isFinite(expires) && this.#now().getTime() >= expires) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The GoDaddy quote for ${domain} expired at ${quote.expiresAt}. Nothing was bought.`,
        { hint: "Get a new quote and approve it again (GoDaddy quotes are valid for 10 minutes)." },
      );
    }
    const key = request.idempotencyKey ?? this.#randomUUID();
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "GoDaddy needs an idempotency key of 16 to 64 printable characters for a purchase.",
      );
    }
    const registration = await this.#client.registerDomain({
      domain,
      period: request.years,
      quoteToken: quote.token,
      ...(this.#profileId ? { profileId: this.#profileId } : {}),
      agreementTypes: quote.agreementTypes ?? [],
      agreedAt: this.#now().toISOString(),
      idempotencyKey: key,
    });
    const ids = {
      ...(registration.operationId ? { operationId: registration.operationId } : {}),
      ...(registration.registrationId ? { registrationId: registration.registrationId } : {}),
    };
    this.#pending.set(domain, ids);
    const status = await this.#pollRegistration(domain, registration, ids);
    if (status.state !== "in_progress") this.#pending.delete(domain);
    if (status.state === "failed") return status;
    const note = settingsNote(request, this.#resolved.get(quote.token));
    if (!note) return status;
    return { ...status, message: status.message ? `${status.message} ${note}` : note };
  }

  async #pollRegistration(
    domain: string,
    first: GoDaddyRegistration,
    ids: { operationId?: string; registrationId?: string },
  ): Promise<RegistrationStatus> {
    let status = toStatus(domain, first);
    if (status.state !== "in_progress") return status;
    const rounds = this.#rounds();
    for (let i = 0; i < rounds && (ids.operationId || ids.registrationId); i++) {
      await this.#sleep(this.#pollIntervalMs);
      const next = await this.#readRegistration(domain, ids);
      if (next) status = next;
      if (status.state !== "in_progress") return status;
    }
    return {
      domain,
      state: "in_progress",
      message: `GoDaddy accepted the registration of ${domain} and is still working on it. Run \`opscrew domain status\` in a few minutes.`,
    };
  }

  /** One status read; undefined when it fails (the purchase was accepted, so never a throw). */
  async #readRegistration(
    domain: string,
    ids: { operationId?: string; registrationId?: string },
  ): Promise<RegistrationStatus | undefined> {
    try {
      if (ids.operationId)
        return toStatus(domain, await this.#client.getOperation(ids.operationId));
      if (ids.registrationId) {
        return toStatus(domain, await this.#client.getRegistration(ids.registrationId));
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  #rounds(): number {
    if (this.#pollIntervalMs === 0) return this.#pollTimeoutMs > 0 ? 20 : 0;
    return Math.ceil(this.#pollTimeoutMs / this.#pollIntervalMs);
  }

  /**
   * `succeeded` when the account holds the domain; a registration this instance started is
   * reported from its operation; a pending or unknown domain status is `in_progress`; otherwise
   * GoDaddy's pending domains are searched, and undefined means there is no registration.
   */
  async registrationStatus(domain: string): Promise<RegistrationStatus | undefined> {
    const name = normalizeHostName(domain);
    const raw = await this.#client.getDomain(name);
    const state = raw ? holding(raw) : "gone";
    if (state === "held") {
      this.#pending.delete(name);
      return { domain: name, state: "succeeded" };
    }
    const started = this.#pending.get(name);
    if (started) {
      const status = (await this.#readRegistration(name, started)) ?? {
        domain: name,
        state: "in_progress" as const,
      };
      if (status.state !== "in_progress") this.#pending.delete(name);
      return status;
    }
    if (state === "pending") {
      return {
        domain: name,
        state: "in_progress",
        message: `GoDaddy is still setting up the registration of ${name}.`,
      };
    }
    if (state === "unknown") {
      return {
        domain: name,
        state: "in_progress",
        message: `GoDaddy reports ${name} with the status "${raw?.status}"; check it at ${GODADDY_DASHBOARD_URLS.portfolio}.`,
      };
    }
    let pageToken: string | undefined;
    do {
      const list = await this.#client.listDomains({
        pageSize: 200,
        ...(pageToken ? { pageToken } : {}),
        lifecycleGroups: ["PENDING"],
      });
      if (list.items.some((d) => normalizeHostName(d.domain) === name)) {
        return {
          domain: name,
          state: "in_progress",
          message: `GoDaddy is still setting up the registration of ${name}.`,
        };
      }
      pageToken = list.nextPageToken;
    } while (pageToken);
    return undefined;
  }

  async getDomain(domain: string): Promise<RegisteredDomain | undefined> {
    const raw = await this.#client.getDomain(normalizeHostName(domain));
    return raw && isHeld(raw) ? toRegisteredDomain(raw) : undefined;
  }

  /** GoDaddy's v3 API cannot change auto-renew; always a plain error with the dashboard link. */
  setAutoRenew(domain: string, on: boolean): Promise<RegisteredDomain> {
    const name = normalizeHostName(domain);
    return Promise.reject(
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `GoDaddy's API cannot change auto-renew for ${name}.`,
        {
          hint: `Turn auto-renew ${onOff(on)} for ${name} at ${GODADDY_DASHBOARD_URLS.portfolio}.`,
        },
      ),
    );
  }

  async ownsDomain(domain: string): Promise<boolean> {
    return (await this.getDomain(domain)) !== undefined;
  }

  async getNameservers(domain: string): Promise<string[]> {
    const name = normalizeHostName(domain);
    const raw = await this.#client.getDomain(name);
    if (!raw || !isHeld(raw)) throw notInAccount(name);
    return (raw.nameServers ?? []).map(normalizeHostName);
  }

  /** Replaces the nameservers (2–13) and waits (bounded) for GoDaddy's operation to finish. */
  async setNameservers(domain: string, nameservers: readonly string[]): Promise<void> {
    const name = normalizeHostName(domain);
    const list = nameservers.map(normalizeHostName);
    if (list.length < 2 || list.length > 13) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `A domain needs 2 to 13 nameservers, not ${list.length}.`,
      );
    }
    const invalid = list.find((ns) => !HOSTNAME.test(ns));
    if (invalid !== undefined) {
      throw new OpsCrewError("INVALID_INPUT", `"${invalid}" is not a valid nameserver hostname.`);
    }
    let operation: GoDaddyOperation = await this.#client.updateNameservers(
      name,
      list,
      this.#randomUUID(),
    );
    const rounds = this.#rounds();
    for (let i = 0; ; i++) {
      const state = operation.status.toUpperCase();
      if (state === "COMPLETED") return;
      if (state === "FAILED") {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `GoDaddy could not change the nameservers of ${name}: ${describeError(operation.error, 200, true)}.`,
          { hint: `Check the nameservers at ${GODADDY_DASHBOARD_URLS.portfolio}.` },
        );
      }
      // Still running when the wait ends: GoDaddy accepted it and finishes on its own.
      if (i >= rounds) return;
      await this.#sleep(this.#pollIntervalMs);
      try {
        operation = await this.#client.getOperation(operation.operationId);
      } catch {
        // A failed status read does not undo the accepted change; keep waiting.
      }
    }
  }

  /** Records of the GoDaddy-hosted zone; undefined when the domain uses other nameservers. */
  async listRecords(domain: string): Promise<RegistrarDnsRecord[] | undefined> {
    const name = normalizeHostName(domain);
    const raw = await this.#client.getDomain(name);
    if (!raw || !isHeld(raw)) throw notInAccount(name);
    if (!usesGoDaddyDns(raw.nameServers)) return undefined;
    const records: RegistrarDnsRecord[] = [];
    for (let page = 1; ; page++) {
      const answer = await this.#client.listDnsRecords(name, page);
      if (!answer) return page === 1 ? undefined : records;
      records.push(...answer.items.map((r) => toRegistrarRecord(r, name)));
      if (!answer.hasNext) return records;
    }
  }

  /**
   * Whether the token works (a domain listing) and whether GoDaddy lets the account check and buy
   * domains through the API (an availability probe), in plain English.
   */
  async accountCheck(): Promise<RegistrarAccountCheck> {
    try {
      await this.#client.listDomains({ pageSize: 1 });
    } catch (error) {
      if (error instanceof OpsCrewError && error.code === "CREDENTIALS_INVALID") {
        return { ok: false, message: error.message, ...(error.hint ? { fix: error.hint } : {}) };
      }
      throw error;
    }
    try {
      await this.#client.checkOne(ACCESS_PROBE_DOMAIN);
    } catch (error) {
      if (error instanceof OpsCrewError && error.code === "CREDENTIALS_INVALID") {
        return {
          ok: false,
          message: `The GoDaddy token works for domains you already own, but buying is blocked. ${error.message}`,
          ...(error.hint ? { fix: error.hint } : {}),
        };
      }
      throw error;
    }
    const contact = this.#profileId
      ? `the saved contact profile ${this.#profileId} (GODADDY_PROFILE_ID)`
      : "the account's default contact profile, or the account's own contact details when there is none (OpsCrew shows which with each quote)";
    return {
      ok: true,
      message: `The GoDaddy token works and the account can check and buy domains through the API. Purchases use ${contact}.`,
    };
  }
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

/** Maps a registration or operation to a {@link RegistrationStatus}. */
function toStatus(
  domain: string,
  raw: { status: string; error?: GoDaddyOperation["error"] },
): RegistrationStatus {
  const state = raw.status.trim().toUpperCase();
  if (state === "COMPLETED") return { domain, state: "succeeded" };
  if (state === "FAILED") {
    const why = raw.error ? `: ${describeError(raw.error, 200)}` : "";
    return {
      domain,
      state: "failed",
      message: `The registration of ${domain} failed${why}. Check ${GODADDY_DASHBOARD_URLS.portfolio} before trying again.`,
    };
  }
  if (state === "CONFIRMED" || state === "EXECUTING") return { domain, state: "in_progress" };
  return { domain, state: "in_progress", message: `GoDaddy reported the state "${raw.status}".` };
}

/**
 * GoDaddy applies the contact profile's auto-renew and privacy settings (v3 has no way to set them
 * without an inline profile). Says so when they differ from the request or are unknown.
 */
function settingsNote(request: RegistrationRequest, resolved: Resolved | undefined): string {
  const where = GODADDY_DASHBOARD_URLS.portfolio;
  if (resolved?.autoRenew === undefined || resolved.privacy === undefined) {
    return `GoDaddy applies the contact profile's auto-renew and WHOIS privacy settings; check them at ${where} (you asked for auto-renew ${onOff(request.autoRenew)} and privacy ${onOff(request.privacy)}).`;
  }
  const diffs: string[] = [];
  if (resolved.autoRenew !== request.autoRenew) {
    diffs.push(
      `auto-renew is ${onOff(resolved.autoRenew)} (you asked for ${onOff(request.autoRenew)})`,
    );
  }
  if (resolved.privacy !== request.privacy) {
    diffs.push(
      `WHOIS privacy is ${onOff(resolved.privacy)} (you asked for ${onOff(request.privacy)})`,
    );
  }
  if (diffs.length === 0) return "";
  return `GoDaddy applied the contact profile's settings: ${diffs.join(" and ")}. Change them at ${where}.`;
}

// Compile-time check that the adapter implements the contract.
const _contract = GoDaddyRegistrar satisfies new (
  client: GoDaddyRegistrarApi,
  options?: GoDaddyRegistrarOptions,
) => Registrar;
void _contract;
