import { randomUUID } from "node:crypto";
import type { DsRecord, FetchLike } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  type ErrorCode,
  maybeStarted,
  normalizeHostName,
  OpsCrewError,
  parseAnswer,
  realSleep,
} from "@opscrew/core";
import type { z } from "zod";
import {
  AutoRenewSchema,
  type AvailabilitySchema,
  BalanceSchema,
  BulkCheckSchema,
  CreatedSchema,
  DnssecSchema,
  type DomainSchema,
  type Envelope,
  EnvelopeSchema,
  GetDomainSchema,
  NsSchema,
  normalizeDomain,
  PingSchema,
  PreviewSchema,
  RecordsSchema,
  RequirementsSchema,
  toCents,
  toDsRecords,
  toFlag,
  toIsoDate,
  toNumber,
} from "./parse";
import {
  KEYS_HINT,
  PORKBUN_DASHBOARD_URL,
  type Problem,
  PURCHASE_REJECTION_CODES,
  porkbunProblem,
  purchaseRejection,
} from "./problems";

/** Porkbun API v3 base URL (production and sandbox keys use the same one). */
export const PORKBUN_API = "https://api.porkbun.com/api/json/v3";

/** At most this many names per bulk availability check (Porkbun's limit). */
export const PORKBUN_BULK_CHECK_LIMIT = 25;

/** Retries of one read (or idempotent write) after a rate limit or a transient failure. */
const MAX_RETRIES = 2;
/** Longest wait between retries, whatever `Retry-After` says. */
const MAX_WAIT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 120_000;

/** True for Porkbun sandbox API keys (`pk1_sb_…`): nothing real is bought or changed. */
export function isPorkbunSandboxKey(apiKey: string): boolean {
  return apiKey.trim().startsWith("pk1_sb_");
}

export interface PorkbunClientOptions {
  apiKey: string;
  secretApiKey: string;
  fetch?: FetchLike;
  /** Waits between retries (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Idempotency keys for settings changes (injected in tests). */
  randomUUID?: () => string;
  baseUrl?: string;
}

/** The API key's account and permission scopes (`["full"]` for full access). */
export interface PorkbunPing {
  account?: string;
  /** Empty when Porkbun did not report them (see `scopesReported`). */
  scopes: string[];
  /** False when `/ping` carried no `scopes`, so the key's permissions are unknown. */
  scopesReported: boolean;
  yourIp?: string;
}

/** Availability and prices of one domain (prices per year, in USD cents). */
export interface PorkbunAvailability {
  domain: string;
  available: boolean;
  premium: boolean;
  inYourAccount: boolean;
  /** The registry needs a language for this internationalized name (not supported by OpsCrew). */
  idnLanguageRequired: boolean;
  priceCents?: number;
  renewalCents?: number;
  /** Registry minimum term; Porkbun always registers exactly this. */
  minYears: number;
}

export interface PorkbunBulkCheck {
  results: PorkbunAvailability[];
  /** Names Porkbun cannot check at all (not a domain, unsupported extension). */
  invalid: { domain: string; reason: string }[];
  /** The registry did not answer for these: neither available nor taken. */
  unresolved: string[];
}

export interface PorkbunTldRequirements {
  tld: string;
  apiRegisterable: boolean;
  /** The fixed term the API registers for this extension. */
  termYears?: number;
  /** Why the extension cannot be registered through the API. */
  reason?: string;
}

/**
 * A registration. `costCents` must equal Porkbun's current price for the minimum term, and the
 * `idempotencyKey` is stable for one purchase.
 */
export interface PorkbunCreateOptions {
  costCents: number;
  idempotencyKey: string;
  whoisPrivacy?: boolean;
}

export interface PorkbunCreated {
  domain: string;
  costCents?: number;
  orderId: string;
  balanceCents?: number;
}

export interface PorkbunCreatePreview {
  domain: string;
  /** The exact charge in cents. */
  costCents: number;
  years?: number;
  wouldSucceed: boolean;
  balanceCents?: number;
  sufficientFunds?: boolean;
  shortfallCents?: number;
  withinMonthlySpendLimit?: boolean;
  message?: string;
}

export interface PorkbunDomain {
  domain: string;
  status?: string;
  createdAt?: string;
  expiresAt?: string;
  autoRenew: boolean;
  locked?: boolean;
  whoisPrivacy?: boolean;
  apiAccess?: boolean;
}

/** A record of Porkbun's DNS hosting (name as Porkbun sends it, usually fully qualified). */
export interface PorkbunDnsRecord {
  id?: string;
  name: string;
  type: string;
  content: string;
  ttl?: number;
  prio?: number;
}

interface Answer {
  status: number;
  headers: Headers;
  /** Undefined when the body is not JSON. */
  json: unknown;
  envelope?: Envelope;
}

interface CallOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  /** Settings change: sent with an idempotency key, so retrying it is safe. */
  write?: boolean;
  domain?: string;
  /** A 404 `DOMAIN_NOT_FOUND` (the domain is not in the account) answers `undefined`. */
  absentOnNotFound?: boolean;
}

class NetworkFailure extends Error {}

/**
 * Typed client for the Porkbun API v3. Authenticates with the `X-API-Key` and `X-Secret-API-Key`
 * headers (the keys never go into a body, a URL or an error). Reads and settings changes are
 * retried at most twice after a rate limit or a transient failure; `createDomain` is never retried.
 */
export class PorkbunClient {
  /** True for sandbox keys (`pk1_sb_`): purchases and changes are simulated. */
  readonly sandbox: boolean;
  readonly #apiKey: string;
  readonly #secretApiKey: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #randomUUID: () => string;
  readonly #baseUrl: string;

  constructor(options: PorkbunClientOptions) {
    this.#apiKey = options.apiKey.trim();
    this.#secretApiKey = options.secretApiKey.trim();
    this.sandbox = isPorkbunSandboxKey(this.#apiKey);
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = options.sleep ?? realSleep;
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#baseUrl = (options.baseUrl ?? PORKBUN_API).replace(/\/$/, "");
  }

  /** Removes the keys from any text before it can reach an error. */
  #scrub(text: string): string {
    let out = text;
    for (const secret of [this.#apiKey, this.#secretApiKey]) {
      if (secret.length >= 6) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  #error(code: ErrorCode, message: string, hint?: string): OpsCrewError {
    return new OpsCrewError(
      code,
      this.#scrub(message),
      hint === undefined ? undefined : { hint: this.#scrub(hint) },
    );
  }

  #problem(problem: Problem): OpsCrewError {
    return this.#error(problem.code, problem.message, problem.hint);
  }

  /** One HTTP attempt. Throws {@link NetworkFailure} when no answer arrived. */
  async #send(
    path: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | undefined,
    extraHeaders: Record<string, string>,
    timeoutMs: number,
  ): Promise<Answer> {
    if (!this.#apiKey || !this.#secretApiKey) {
      throw new OpsCrewError("CREDENTIALS_MISSING", "The Porkbun API keys are not set.", {
        hint: `Set PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY. ${KEYS_HINT}`,
      });
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-API-Key": this.#apiKey,
      "X-Secret-API-Key": this.#secretApiKey,
      ...extraHeaders,
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new NetworkFailure(
        name === "TimeoutError" || name === "AbortError"
          ? "the request timed out"
          : "the connection failed",
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    const parsed = json === undefined ? undefined : EnvelopeSchema.safeParse(json);
    return {
      status: response.status,
      headers: response.headers,
      json,
      ...(parsed?.success ? { envelope: parsed.data } : {}),
    };
  }

  /** How long to wait before retry number `attempt` (1-based). */
  #waitMs(answer: Answer | undefined, attempt: number): number {
    const header = toNumber(answer?.headers.get("retry-after") ?? undefined);
    const body = toNumber(answer?.envelope?.retryAfter) ?? toNumber(answer?.envelope?.ttlRemaining);
    const seconds = header ?? body;
    const ms = seconds !== undefined && seconds > 0 ? seconds * 1000 : 1000 * 2 ** (attempt - 1);
    return Math.min(ms, MAX_WAIT_MS);
  }

  /**
   * A read or a settings change: retried after a rate limit, a 5xx answer, a network failure or an
   * error Porkbun marks `retryable` (settings changes carry one idempotency key across retries).
   * Returns the JSON of a `SUCCESS` answer (`undefined` for an absent domain when
   * `absentOnNotFound` is set); anything else becomes a plain {@link OpsCrewError}.
   */
  async #call(what: string, path: string, options: CallOptions = {}): Promise<unknown> {
    const method = options.method ?? "POST";
    // Allowed exception to "never retry a write": one Idempotency-Key on every retry makes it safe.
    const headers: Record<string, string> = options.write
      ? { "Idempotency-Key": this.#randomUUID() }
      : {};
    const ctx = { what, ...(options.domain ? { domain: options.domain } : {}) };
    for (let attempt = 0; ; attempt++) {
      let answer: Answer | undefined;
      let failure: string | undefined;
      try {
        answer = await this.#send(path, method, options.body, headers, READ_TIMEOUT_MS);
      } catch (error) {
        if (!(error instanceof NetworkFailure)) throw error;
        failure = error.message;
      }
      if (answer && answer.status >= 200 && answer.status < 300) {
        if (answer.envelope?.status?.toUpperCase() === "SUCCESS") return answer.json;
      }
      const retryable =
        failure !== undefined ||
        (answer !== undefined &&
          (answer.status === 429 ||
            answer.status >= 500 ||
            answer.envelope?.next_action?.retryable === true));
      if (retryable && attempt < MAX_RETRIES) {
        await this.#sleep(this.#waitMs(answer, attempt + 1));
        continue;
      }
      if (!answer) {
        throw this.#error(
          "PROVIDER_ERROR",
          `Could not reach the Porkbun API to ${what} (${failure}).`,
          CONNECTION_HINT,
        );
      }
      if (!answer.envelope) {
        throw this.#error(
          "PROVIDER_ERROR",
          `Porkbun returned an unreadable answer (HTTP ${answer.status}) when trying to ${what}.`,
          "Try again in a few minutes.",
        );
      }
      if (
        options.absentOnNotFound &&
        answer.status === 404 &&
        answer.envelope.code === "DOMAIN_NOT_FOUND"
      ) {
        return undefined;
      }
      throw this.#problem(porkbunProblem(answer.status, answer.envelope, ctx));
    }
  }

  #parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    try {
      return parseAnswer(
        schema,
        value,
        "Porkbun",
        what,
        "Try again in a few minutes; if it keeps happening, OpsCrew may need an update.",
      );
    } catch (error) {
      const { code, message, hint } = error as OpsCrewError;
      throw this.#error(code, message, hint);
    }
  }

  async #get<T>(what: string, path: string, schema: z.ZodType<T>, options?: CallOptions) {
    return this.#parse(schema, await this.#call(what, path, options), what);
  }

  /** Checks the keys; returns the account and the key's permission scopes. */
  async ping(): Promise<PorkbunPing> {
    const what = "check the API keys";
    const raw = await this.#get(what, "/ping", PingSchema);
    if (raw.credentialsValid !== true) {
      throw this.#error("CREDENTIALS_INVALID", "Porkbun did not confirm the API keys.", KEYS_HINT);
    }
    return {
      ...(raw.account ? { account: raw.account } : {}),
      scopes: raw.scopes ?? [],
      scopesReported: raw.scopes !== undefined,
      ...(raw.yourIp ? { yourIp: raw.yourIp } : {}),
    };
  }

  /** Prepaid account credit in cents. */
  async balance(): Promise<number> {
    const raw = await this.#get("read the account balance", "/account/balance", BalanceSchema, {
      method: "GET",
    });
    const cents = toNumber(raw.balance);
    if (cents === undefined) {
      throw this.#error("PROVIDER_ERROR", "Porkbun returned an unreadable account balance.");
    }
    return cents;
  }

  /** Live availability of many domains, in batches of at most 25 (duplicates removed). */
  async checkDomains(domains: readonly string[]): Promise<PorkbunBulkCheck> {
    const names = [...new Set(domains.map(normalizeDomain))];
    const out: PorkbunBulkCheck = { results: [], invalid: [], unresolved: [] };
    for (let i = 0; i < names.length; i += PORKBUN_BULK_CHECK_LIMIT) {
      const chunk = names.slice(i, i + PORKBUN_BULK_CHECK_LIMIT);
      const what = "check domain availability";
      const raw = await this.#get(what, "/domain/checkDomain", BulkCheckSchema, {
        body: { domains: chunk },
      });
      const answered = new Map(
        Object.entries(raw.domains ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      for (const [name, item] of answered) out.results.push(toAvailability(name, item));
      for (const entry of raw.invalid ?? []) {
        if (typeof entry === "string") {
          out.invalid.push({ domain: entry.toLowerCase(), reason: "Porkbun cannot check it" });
        } else {
          const name = (entry.domain ?? entry.name ?? "").toLowerCase();
          if (name) {
            const reason = entry.reason ?? entry.message ?? "Porkbun cannot check it";
            out.invalid.push({ domain: name, reason });
          }
        }
      }
      for (const name of raw.unresolved ?? []) out.unresolved.push(name.toLowerCase());
    }
    return out;
  }

  /** Whether (and for how long) an extension can be registered through the API. */
  async registrationRequirements(tld: string): Promise<PorkbunTldRequirements> {
    const ext = normalizeHostName(tld).replace(/^\./, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(ext)) {
      throw new OpsCrewError("INVALID_INPUT", `".${tld.slice(0, 40)}" is not a domain extension.`);
    }
    const raw = await this.#get(
      `read the registration rules for .${ext}`,
      `/domain/getRegistrationRequirements/${encodeURIComponent(ext)}`,
      RequirementsSchema,
      { method: "GET" },
    );
    const termYears = toNumber(raw.registrationDurationYears);
    return {
      tld: ext,
      apiRegisterable: raw.apiRegisterable,
      ...(termYears !== undefined ? { termYears } : {}),
      ...(raw.notApiRegisterableReason ? { reason: raw.notApiRegisterableReason } : {}),
    };
  }

  /**
   * Previews registering `domain` for the registry-minimum term with a dry run that charges
   * nothing: the exact cost, the term and whether the account's credit and spend limit cover it.
   * Sends no idempotency key, so it never claims a purchase's key with a different body.
   */
  async previewDomain(domain: string): Promise<PorkbunCreatePreview> {
    const name = normalizeDomain(domain);
    const raw = await this.#get(
      `preview the registration of ${name}`,
      `/domain/create/${encodeURIComponent(name)}`,
      PreviewSchema,
      { body: { cost: 0, agreeToTerms: "yes", dryRun: true }, domain: name },
    );
    return toPreview(name, raw);
  }

  /**
   * Registers `domain` for the registry-minimum term (billable, non-refundable). Sends
   * `agreeToTerms: "yes"`, `cost` in cents and the purchase's `Idempotency-Key`, and is never
   * retried. Only a clear refusal (a Porkbun error answer with a 4xx status and a code from
   * {@link PURCHASE_REJECTION_CODES}) is reported as such: `CREDENTIALS_INVALID` or
   * `PHASE_PRECONDITION`, saying nothing was bought. Every other unusable answer — no connection,
   * a timeout, a 5xx, an unreadable body, an idempotency conflict, an unknown code — is
   * `PROVIDER_ERROR` saying the purchase may still have started.
   */
  async createDomain(domain: string, options: PorkbunCreateOptions): Promise<PorkbunCreated> {
    const name = normalizeDomain(domain);
    if (!Number.isInteger(options.costCents) || options.costCents < 1) {
      throw new OpsCrewError("INVALID_INPUT", "The cost must be a whole number of cents.", {
        hint: "Take the price from a fresh Porkbun quote.",
      });
    }
    if (!options.idempotencyKey.trim()) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "A Porkbun purchase needs an idempotency key, so it can never be bought twice.",
      );
    }
    const body: Record<string, unknown> = { cost: options.costCents, agreeToTerms: "yes" };
    if (options.whoisPrivacy !== undefined) body.whoisPrivacy = options.whoisPrivacy;
    return this.#purchase(name, body, options.idempotencyKey.trim());
  }

  async #purchase(
    domain: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<PorkbunCreated> {
    const uncertain = (detail: string) =>
      maybeStarted({
        registrar: "Porkbun",
        domain,
        detail: this.#scrub(detail),
        dashboard: PORKBUN_DASHBOARD_URL,
      });
    let answer: Answer;
    try {
      answer = await this.#send(
        `/domain/create/${encodeURIComponent(domain)}`,
        "POST",
        body,
        { "Idempotency-Key": idempotencyKey },
        CREATE_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof NetworkFailure) throw uncertain(error.message);
      throw error;
    }
    const { status, envelope } = answer;
    const ctx = { what: `register ${domain}`, domain };
    const isError = envelope?.status?.toUpperCase() === "ERROR";
    if (status >= 400 && status < 500 && envelope && isError) {
      const code = envelope.code ?? "";
      if (code === "IDEMPOTENCY_KEY_IN_USE") {
        throw uncertain("an earlier request for this purchase is still running");
      }
      if (code === "IDEMPOTENCY_KEY_MISMATCH") {
        throw uncertain("an earlier request used this purchase's key with different details");
      }
      if (PURCHASE_REJECTION_CODES.has(code)) {
        throw this.#problem(purchaseRejection(status, envelope, ctx));
      }
      throw uncertain(`HTTP ${status}, Porkbun code ${code || "missing"}`);
    }
    if (status < 200 || status >= 300) throw uncertain(`HTTP ${status}`);
    if (!envelope) throw uncertain(`HTTP ${status} without a readable answer`);
    if (envelope.status?.toUpperCase() !== "SUCCESS") {
      throw uncertain(`HTTP ${status} reporting ${envelope.code ?? "an error"}`);
    }
    const raw = CreatedSchema.safeParse(answer.json);
    if (!raw.success) throw uncertain(`HTTP ${status} without an order number`);
    const costCents = toNumber(raw.data.cost);
    const balanceCents = toNumber(raw.data.balance);
    return {
      domain: raw.data.domain?.toLowerCase() ?? domain,
      ...(costCents !== undefined ? { costCents } : {}),
      orderId: String(raw.data.orderId),
      ...(balanceCents !== undefined ? { balanceCents } : {}),
    };
  }

  /** The account's domain; undefined only when Porkbun says it is not in the account. */
  async getDomain(domain: string): Promise<PorkbunDomain | undefined> {
    const name = normalizeDomain(domain);
    const what = `read ${name}`;
    const json = await this.#call(what, `/domain/get/${encodeURIComponent(name)}`, {
      method: "GET",
      domain: name,
      absentOnNotFound: true,
    });
    return json === undefined
      ? undefined
      : toDomain(this.#parse(GetDomainSchema, json, what).domain);
  }

  /** Turns auto-renew on or off for one domain. */
  async updateAutoRenew(domain: string, on: boolean): Promise<void> {
    const name = normalizeDomain(domain);
    const what = `turn auto-renew ${on ? "on" : "off"} for ${name}`;
    const raw = await this.#get(
      what,
      `/domain/updateAutoRenew/${encodeURIComponent(name)}`,
      AutoRenewSchema,
      { body: { status: on ? "on" : "off" }, write: true, domain: name },
    );
    const result = Object.entries(raw.results ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
    if (result?.status && result.status.toUpperCase() !== "SUCCESS") {
      const detail = (result.message ?? result.status).replace(/\.$/, "");
      throw this.#error(
        "PROVIDER_ERROR",
        `Porkbun could not ${what}: ${detail}.`,
        `Change it at ${PORKBUN_DASHBOARD_URL}.`,
      );
    }
  }

  /** The domain's nameservers at the registry (lower case, no trailing dot; an unordered set). */
  async getNs(domain: string): Promise<string[]> {
    const name = normalizeDomain(domain);
    const raw = await this.#get(
      `read the nameservers of ${name}`,
      `/domain/getNs/${encodeURIComponent(name)}`,
      NsSchema,
      { domain: name },
    );
    return (raw.ns ?? []).map(normalizeHostName);
  }

  /** Sets the domain's nameservers at the registry. */
  async updateNs(domain: string, nameservers: readonly string[]): Promise<void> {
    const name = normalizeDomain(domain);
    const ns = [...new Set(nameservers.map(normalizeHostName))].filter(Boolean);
    if (ns.length === 0) {
      throw new OpsCrewError("INVALID_INPUT", `No nameservers were given for ${name}.`, {
        hint: "Pass the nameservers of the DNS provider, for example the two Cloudflare names.",
      });
    }
    await this.#call(
      `set the nameservers of ${name}`,
      `/domain/updateNs/${encodeURIComponent(name)}`,
      {
        body: { ns },
        write: true,
        domain: name,
      },
    );
  }

  /** The records of Porkbun's DNS hosting for the domain (SOA and Porkbun's NS excluded). */
  async retrieveRecords(domain: string): Promise<PorkbunDnsRecord[]> {
    const name = normalizeDomain(domain);
    const raw = await this.#get(
      `read the DNS records of ${name}`,
      `/dns/retrieve/${encodeURIComponent(name)}`,
      RecordsSchema,
      { domain: name },
    );
    return raw.records.map((r) => {
      const ttl = toNumber(r.ttl);
      const prio = toNumber(r.prio);
      return {
        ...(r.id !== undefined ? { id: String(r.id) } : {}),
        name: r.name,
        type: r.type.toUpperCase(),
        content: r.content,
        ...(ttl !== undefined ? { ttl } : {}),
        ...(prio !== undefined ? { prio } : {}),
      };
    });
  }

  /** DS records published at the registry. */
  async getDnssecRecords(domain: string): Promise<DsRecord[]> {
    const name = normalizeDomain(domain);
    const raw = await this.#get(
      `read the DNSSEC records of ${name}`,
      `/dns/getDnssecRecords/${encodeURIComponent(name)}`,
      DnssecSchema,
      { domain: name },
    );
    return toDsRecords(raw);
  }

  /** Publishes a DS record at the registry. */
  async createDnssecRecord(domain: string, ds: DsRecord): Promise<void> {
    const name = normalizeDomain(domain);
    await this.#call(
      `add a DNSSEC record to ${name}`,
      `/dns/createDnssecRecord/${encodeURIComponent(name)}`,
      {
        body: {
          keyTag: String(ds.keyTag),
          alg: String(ds.algorithm),
          digestType: String(ds.digestType),
          digest: ds.digest,
        },
        write: true,
        domain: name,
      },
    );
  }

  /** Removes the DS record(s) with `keyTag` from the registry. */
  async deleteDnssecRecord(domain: string, keyTag: number): Promise<void> {
    const name = normalizeDomain(domain);
    if (!Number.isInteger(keyTag) || keyTag < 0 || keyTag > 65535) {
      throw new OpsCrewError("INVALID_INPUT", `${keyTag} is not a DNSSEC key tag.`);
    }
    await this.#call(
      `remove the DNSSEC record ${keyTag} from ${name}`,
      `/dns/deleteDnssecRecord/${encodeURIComponent(name)}/${keyTag}`,
      { write: true, domain: name },
    );
  }
}

function toAvailability(
  domain: string,
  item: z.infer<typeof AvailabilitySchema>,
): PorkbunAvailability {
  const priceCents = toCents(item.price);
  const renewalCents = toCents(item.additional?.renewal?.price);
  const minYears = toNumber(item.minDuration);
  return {
    domain,
    available: item.avail.trim().toLowerCase() === "yes",
    premium: toFlag(item.premium) === true,
    inYourAccount: item.inYourAccount === true,
    idnLanguageRequired: (item.idnLanguages?.length ?? 0) > 0,
    ...(priceCents !== undefined ? { priceCents } : {}),
    ...(renewalCents !== undefined ? { renewalCents } : {}),
    minYears: minYears !== undefined && minYears >= 1 ? minYears : 1,
  };
}

function toPreview(domain: string, raw: z.infer<typeof PreviewSchema>): PorkbunCreatePreview {
  const costCents = toNumber(raw.cost) ?? 0;
  const years = toNumber(raw.duration);
  const balanceCents = toNumber(raw.balance);
  const shortfallCents = toNumber(raw.shortfall);
  return {
    domain: raw.domain?.toLowerCase() ?? domain,
    costCents,
    ...(years !== undefined ? { years } : {}),
    wouldSucceed: raw.wouldSucceed,
    ...(balanceCents !== undefined ? { balanceCents } : {}),
    ...(raw.sufficientFunds !== undefined ? { sufficientFunds: raw.sufficientFunds } : {}),
    ...(shortfallCents !== undefined ? { shortfallCents } : {}),
    ...(raw.withinMonthlySpendLimit !== undefined
      ? { withinMonthlySpendLimit: raw.withinMonthlySpendLimit }
      : {}),
    ...(raw.message ? { message: raw.message } : {}),
  };
}

function toDomain(raw: z.infer<typeof DomainSchema>): PorkbunDomain {
  const createdAt = toIsoDate(raw.createDate);
  const expiresAt = toIsoDate(raw.expireDate);
  const locked = toFlag(raw.securityLock);
  const whoisPrivacy = toFlag(raw.whoisPrivacy);
  const apiAccess = toFlag(raw.apiAccess);
  return {
    domain: normalizeHostName(raw.domain),
    ...(raw.status ? { status: raw.status } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    autoRenew: toFlag(raw.autoRenew) === true,
    ...(locked !== undefined ? { locked } : {}),
    ...(whoisPrivacy !== undefined ? { whoisPrivacy } : {}),
    ...(apiAccess !== undefined ? { apiAccess } : {}),
  };
}
