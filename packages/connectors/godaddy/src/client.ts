import type { FetchLike } from "@opscrew/contracts";
import { maybeStarted, normalizeHostName, OpsCrewError } from "@opscrew/core";
import type { z } from "zod";
import {
  AvailabilityListSchema,
  AvailabilitySchema,
  DnsRecordListSchema,
  DomainListSchema,
  DomainSchema,
  describeError,
  ErrorSchema,
  errorCodes,
  GODADDY_DASHBOARD_URLS,
  type GoDaddyAvailability,
  type GoDaddyDnsRecord,
  type GoDaddyDomain,
  type GoDaddyError,
  type GoDaddyOperation,
  type GoDaddyQuote,
  type GoDaddyRegistration,
  type GoDaddySuggestion,
  hasCode,
  nextLink,
  OperationSchema,
  QuoteSchema,
  RegistrationSchema,
  SuggestionListSchema,
} from "./parse";

/** GoDaddy's production API host (the OpenAPI also lists `https://api.ote-godaddy.com`). */
export const GODADDY_API = "https://api.godaddy.com";

/** Most domains GoDaddy checks in one batch call. */
export const GODADDY_MAX_BATCH = 25;

/** Longest wait honoured from a `Retry-After` header on a rate-limited read. */
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_MS = 2_000;
/** Default time one request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface GoDaddyClientOptions {
  /** A GoDaddy Personal Access Token (sent as `Authorization: Bearer`; never shown). */
  token: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to {@link GODADDY_API}. */
  baseUrl?: string;
  /** How long one request may take (default 30 seconds). */
  timeoutMs?: number;
}

/** Input for {@link GoDaddyClient.quoteRegistration}. */
export interface GoDaddyQuoteInput {
  domain: string;
  period: number;
  /** A saved contact profile; omitted → GoDaddy uses the account's default profile or identity. */
  profileId?: string;
}

/** Input for {@link GoDaddyClient.registerDomain}. Contacts are never sent inline. */
export interface GoDaddyRegisterInput {
  domain: string;
  period: number;
  quoteToken: string;
  profileId?: string;
  agreementTypes: readonly string[];
  /** When the user approved the purchase (RFC 3339). */
  agreedAt: string;
  /** 16–64 characters, stable for one purchase. */
  idempotencyKey: string;
}

interface Answer {
  status: number;
  /** Parsed JSON, or undefined when the body was not JSON. */
  json: unknown;
  headers: Headers;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  headers?: Record<string, string>;
  /** Wait and retry once on 429 (reads only). */
  retryRateLimit?: boolean;
}

function tokenHint(): string {
  return `Create a Personal Access Token at ${GODADDY_DASHBOARD_URLS.apiAccess} and set it as GODADDY_API_TOKEN.`;
}

const ACCESS_RULES =
  "GoDaddy restricts production API access for availability checks and purchases (for example to accounts with enough domains or monthly spend, and a payment method on file)";

function accessHint(): string {
  return `Check your account's API access at ${GODADDY_DASHBOARD_URLS.apiAccess}, or buy the domain at ${GODADDY_DASHBOARD_URLS.portfolio} and run \`opscrew domain connect <domain>\`; connecting a domain you already own may still work.`;
}

function profileHint(): string {
  return `Create a domain contact profile at ${GODADDY_DASHBOARD_URLS.contactProfiles} (or complete your account's contact details), and if it is not the account's default profile set GODADDY_PROFILE_ID to its id.`;
}

const STATUS_PAGE = "https://status.godaddy.com";

/**
 * Typed client for GoDaddy's Domains API v3. Reads retry a rate limit once; mutations
 * (registrations, nameserver changes) are never retried. Errors are `OpsCrewError`s in plain
 * English that never contain the token or contact data.
 */
export class GoDaddyClient {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: GoDaddyClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#baseUrl = (options.baseUrl ?? GODADDY_API).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * One HTTP exchange with a timeout; throws `PROVIDER_ERROR` (no cause attached) when GoDaddy is
   * unreachable or does not answer in time.
   */
  async #request(path: string, options: RequestOptions = {}): Promise<Answer> {
    if (!this.#token) {
      throw new OpsCrewError("CREDENTIALS_MISSING", "No GoDaddy API token is set.", {
        hint: tokenHint(),
      });
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.#token}`,
      ...options.headers,
    };
    const init: RequestInit = { headers };
    if (options.method && options.method !== "GET") init.method = options.method;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, signal });
      } catch {
        // The cause is dropped on purpose: a transport error may echo request headers.
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          signal.aborted
            ? `The GoDaddy API did not answer within ${Math.round(this.#timeoutMs / 1000)} seconds.`
            : "Could not reach the GoDaddy API.",
          { hint: "Check your internet connection and try again." },
        );
      }
      if (response.status === 429 && options.retryRateLimit && attempt === 0) {
        const seconds = Number(response.headers.get("retry-after"));
        await this.#sleep(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
            : DEFAULT_RETRY_MS,
        );
        continue;
      }
      let json: unknown;
      try {
        const text = await response.text();
        json = text.trim() === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, json, headers: response.headers };
    }
  }

  #error(json: unknown): GoDaddyError | undefined {
    const parsed = ErrorSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  }

  /** Throws the plain-English error for a failed read. */
  #fail(answer: Answer, what: string, withMessage = true): never {
    const { status } = answer;
    const detail = describeError(this.#error(answer.json), status, withMessage);
    if (status === 401) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `GoDaddy did not accept the API token while trying to ${what}; it is invalid or expired.`,
        { hint: tokenHint() },
      );
    }
    if (status === 403) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `GoDaddy refused to ${what}. ${ACCESS_RULES}.`,
        {
          hint: accessHint(),
        },
      );
    }
    if (status === 429) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `GoDaddy answered with too many requests while trying to ${what}.`,
        { hint: "Wait a minute and try again." },
      );
    }
    if (status >= 400 && status < 500) {
      throw new OpsCrewError("PROVIDER_ERROR", `GoDaddy could not ${what}: ${detail}.`, {
        hint: `Check the domain at ${GODADDY_DASHBOARD_URLS.portfolio}.`,
      });
    }
    throw new OpsCrewError("PROVIDER_ERROR", `GoDaddy could not ${what} (HTTP ${status}).`, {
      hint: `Try again in a minute; if it keeps failing, check ${STATUS_PAGE}.`,
    });
  }

  #parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `GoDaddy returned an unexpected answer when trying to ${what}.`,
        { hint: `Try again in a minute; if it keeps failing, check ${STATUS_PAGE}.` },
      );
    }
    return parsed.data;
  }

  async #read<T>(
    path: string,
    schema: z.ZodType<T>,
    what: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const answer = await this.#request(path, { ...options, retryRateLimit: true });
    if (answer.status < 200 || answer.status >= 300) this.#fail(answer, what, false);
    return this.#parse(schema, answer.json, what);
  }

  /** Indicative availability and prices for 1–25 domains (one batch call). */
  async checkAvailability(domains: readonly string[]): Promise<GoDaddyAvailability[]> {
    if (domains.length > GODADDY_MAX_BATCH) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `GoDaddy checks at most ${GODADDY_MAX_BATCH} domains at a time, not ${domains.length}.`,
      );
    }
    const names = domains.map(normalizeHostName);
    if (names.length === 0) return [];
    const list = await this.#read(
      "/v3/domains/check-availability",
      AvailabilityListSchema,
      "check domain availability",
      { method: "POST", body: { domains: names } },
    );
    return list.items;
  }

  /** Availability of one domain (a cheap read, also used to probe API access). */
  async checkOne(domain: string): Promise<GoDaddyAvailability> {
    const name = normalizeHostName(domain);
    const query = new URLSearchParams({ domain: name });
    return this.#read(
      `/v3/domains/check-availability?${query}`,
      AvailabilitySchema,
      `check whether ${name} is available`,
    );
  }

  /** Suggested available names for a query (indicative prices). */
  async suggestDomains(query: string, pageSize = 20): Promise<GoDaddySuggestion[]> {
    const params = new URLSearchParams({ query: query.slice(0, 100), pageSize: String(pageSize) });
    const list = await this.#read(
      `/v3/domains/suggestions?${params}`,
      SuggestionListSchema,
      "suggest domain names",
    );
    return list.items;
  }

  /**
   * A registration quote (free, read-only): locked price, required agreements and a single-use
   * token valid for 10 minutes. Never sends inline contacts. A 422 about contacts becomes a plain
   * stop about the contact profile.
   */
  async quoteRegistration(input: GoDaddyQuoteInput): Promise<GoDaddyQuote> {
    const domain = normalizeHostName(input.domain);
    const what = `quote the registration of ${domain}`;
    const body = {
      domain,
      period: input.period,
      ...(input.profileId ? { profileId: input.profileId } : {}),
    };
    const answer = await this.#request("/v3/domains/registration-quotes", {
      method: "POST",
      body,
      retryRateLimit: true,
    });
    if (answer.status === 422 || answer.status === 400) {
      const error = this.#error(answer.json);
      if (isContactError(error)) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `GoDaddy has no usable contact details for registering ${domain}.`,
          { hint: profileHint() },
        );
      }
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `GoDaddy cannot quote ${domain}: ${describeError(error, answer.status)}.`,
        {
          hint: `Pick another name, or buy it at ${GODADDY_DASHBOARD_URLS.portfolio} and run \`opscrew domain connect ${domain}\`.`,
        },
      );
    }
    if (answer.status < 200 || answer.status >= 300) this.#fail(answer, what, false);
    return this.#parse(QuoteSchema, answer.json, what);
  }

  /**
   * Starts a registration (billable, irreversible once accepted). Never retried. Only clear
   * rejections are reported as such (nothing was bought): 401/403 as `CREDENTIALS_INVALID`, and a
   * readable GoDaddy error with 400, 422 or 409 `quote_expired` as `PHASE_PRECONDITION` (unless a
   * code says the quote was consumed, the domain exists or an idempotency key clashed). Every
   * other unusable answer (network error, 5xx, 429, other 409s such as idempotency conflicts or a
   * consumed quote, unreadable bodies) is `PROVIDER_ERROR` saying it may still have started.
   */
  async registerDomain(input: GoDaddyRegisterInput): Promise<GoDaddyRegistration> {
    const domain = normalizeHostName(input.domain);
    const uncertain = (detail: string) =>
      maybeStarted({
        registrar: "GoDaddy",
        domain,
        detail,
        dashboard: GODADDY_DASHBOARD_URLS.portfolio,
      });
    const refused = (
      code: "PHASE_PRECONDITION" | "CREDENTIALS_INVALID",
      why: string,
      hint: string,
    ) =>
      new OpsCrewError(code, `GoDaddy refused to register ${domain}: ${why}. Nothing was bought.`, {
        hint,
      });
    const body = {
      domain,
      period: input.period,
      quoteToken: input.quoteToken,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      consent: { agreementTypes: [...input.agreementTypes], agreedAt: input.agreedAt },
    };
    let answer: Answer;
    try {
      answer = await this.#request("/v3/domains/registrations", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": input.idempotencyKey },
      });
    } catch (error) {
      if (error instanceof OpsCrewError && error.code === "PROVIDER_ERROR") {
        throw uncertain("the connection failed");
      }
      throw error;
    }
    const { status, json } = answer;
    if (status === 401) {
      throw refused("CREDENTIALS_INVALID", "the API token is invalid or expired", tokenHint());
    }
    if (status === 403) throw refused("CREDENTIALS_INVALID", ACCESS_RULES, accessHint());
    const error = this.#error(json);
    const readable = error !== undefined && (error.name ?? "") !== "";
    // Codes that may mean an earlier attempt went through: never a clear rejection.
    const mayHaveBought =
      hasCode(error, "quote_consumed") ||
      hasCode(error, "domain_already_exists") ||
      errorCodes(error).some((c) => /idempot/i.test(c));
    if (mayHaveBought) {
      throw uncertain(`HTTP ${status}, ${describeError(error, status)}`);
    }
    if (status === 409 && readable && hasCode(error, "quote_expired")) {
      throw refused(
        "PHASE_PRECONDITION",
        describeError(error, status),
        "Get a new quote and approve it again.",
      );
    }
    if ((status === 400 || status === 422) && readable) {
      throw refused(
        "PHASE_PRECONDITION",
        describeError(error, status),
        isContactError(error)
          ? profileHint()
          : `Get a new quote and try again, or buy it at ${GODADDY_DASHBOARD_URLS.portfolio}.`,
      );
    }
    if (status >= 400 && status < 500) {
      throw uncertain(
        readable ? `HTTP ${status}, ${describeError(error, status)}` : `HTTP ${status}`,
      );
    }
    if (status < 200 || status >= 300) throw uncertain(`HTTP ${status}`);
    if (json === undefined) throw uncertain(`HTTP ${status} without a readable answer`);
    const parsed = RegistrationSchema.safeParse(json);
    if (!parsed.success) throw uncertain(`HTTP ${status} with an unexpected answer`);
    return parsed.data;
  }

  /** A registration by id (poll until `COMPLETED` or `FAILED`). */
  getRegistration(registrationId: string): Promise<GoDaddyRegistration> {
    return this.#read(
      `/v3/domains/registrations/${encodeURIComponent(registrationId)}`,
      RegistrationSchema,
      "read the registration status",
    );
  }

  /** An asynchronous operation by id (poll until `COMPLETED` or `FAILED`). */
  getOperation(operationId: string): Promise<GoDaddyOperation> {
    return this.#read(
      `/v3/domains/operations/${encodeURIComponent(operationId)}`,
      OperationSchema,
      "read the operation status",
    );
  }

  /** The account's domain; undefined on 404 (the account does not hold it). */
  async getDomain(domain: string): Promise<GoDaddyDomain | undefined> {
    const name = normalizeHostName(domain);
    const what = `read ${name}`;
    const answer = await this.#request(`/v3/domains/domain-names/${encodeURIComponent(name)}`, {
      retryRateLimit: true,
    });
    if (answer.status === 404) return undefined;
    if (answer.status < 200 || answer.status >= 300) this.#fail(answer, what);
    return this.#parse(DomainSchema, answer.json, what);
  }

  /** One page of the account's domains. */
  async listDomains(
    options: { pageSize?: number; pageToken?: string; lifecycleGroups?: readonly string[] } = {},
  ): Promise<{ items: GoDaddyDomain[]; nextPageToken?: string }> {
    const params = new URLSearchParams();
    if (options.pageSize !== undefined) params.set("pageSize", String(options.pageSize));
    if (options.pageToken) params.set("pageToken", options.pageToken);
    for (const group of options.lifecycleGroups ?? []) params.append("lifecycleGroups", group);
    const query = params.toString();
    const list = await this.#read(
      `/v3/domains/domain-names${query ? `?${query}` : ""}`,
      DomainListSchema,
      "list the account's domains",
    );
    const next = nextLink(list.links);
    const token = next ? new URL(next, this.#baseUrl).searchParams.get("pageToken") : null;
    return { items: list.items, ...(token ? { nextPageToken: token } : {}) };
  }

  /**
   * Replaces the domain's nameservers (2–13) and returns the asynchronous operation. Never
   * retried; an unclear answer says the change may still have been applied.
   */
  async updateNameservers(
    domain: string,
    nameservers: readonly string[],
    idempotencyKey: string,
  ): Promise<GoDaddyOperation> {
    const name = normalizeHostName(domain);
    const what = `change the nameservers of ${name}`;
    const uncertain = (detail: string) =>
      new OpsCrewError(
        "PROVIDER_ERROR",
        `GoDaddy gave no clear answer while changing the nameservers of ${name} (${detail}). The change may still have been applied.`,
        {
          hint: `Check the nameservers at ${GODADDY_DASHBOARD_URLS.portfolio} before trying again.`,
        },
      );
    let answer: Answer;
    try {
      answer = await this.#request(
        `/v3/domains/domain-names/${encodeURIComponent(name)}/nameservers`,
        { method: "PUT", body: [...nameservers], headers: { "Idempotency-Key": idempotencyKey } },
      );
    } catch (error) {
      if (error instanceof OpsCrewError && error.code === "PROVIDER_ERROR") {
        throw uncertain("the connection failed");
      }
      throw error;
    }
    const { status, json } = answer;
    if (status === 404) {
      throw new OpsCrewError("PHASE_PRECONDITION", `${name} is not in this GoDaddy account.`, {
        hint: `Check the domain at ${GODADDY_DASHBOARD_URLS.portfolio}.`,
      });
    }
    if (status === 401 || status === 403) this.#fail(answer, what);
    const error = this.#error(json);
    if ((status === 400 || status === 422) && error?.name) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `GoDaddy refused to change the nameservers of ${name}: ${describeError(error, status, true)}. Nothing was changed.`,
        { hint: `Check the nameservers and the domain at ${GODADDY_DASHBOARD_URLS.portfolio}.` },
      );
    }
    if (status < 200 || status >= 300) throw uncertain(`HTTP ${status}`);
    const parsed = OperationSchema.safeParse(json);
    if (!parsed.success) throw uncertain(`HTTP ${status} with an unexpected answer`);
    return parsed.data;
  }

  /**
   * One page of DNS records of a GoDaddy-hosted zone; undefined on 404 (GoDaddy has no zone).
   */
  async listDnsRecords(
    zone: string,
    page: number,
    pageSize = 100,
  ): Promise<{ items: GoDaddyDnsRecord[]; totalPages?: number; hasNext: boolean } | undefined> {
    const name = normalizeHostName(zone);
    const what = `list the DNS records of ${name}`;
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const answer = await this.#request(
      `/v3/domains/zones/${encodeURIComponent(name)}/dns-records?${params}`,
      { retryRateLimit: true },
    );
    if (answer.status === 404) return undefined;
    if (answer.status < 200 || answer.status >= 300) this.#fail(answer, what);
    const list = this.#parse(DnsRecordListSchema, answer.json, what);
    const hasNext =
      nextLink(list.links) !== undefined ||
      (list.totalPages !== undefined && page < list.totalPages);
    return {
      items: list.items,
      ...(list.totalPages !== undefined ? { totalPages: list.totalPages } : {}),
      hasNext,
    };
  }
}

/** True when a GoDaddy error is about missing or invalid registrant contacts or the profile. */
function isContactError(error: GoDaddyError | undefined): boolean {
  if (!error) return false;
  const text = [error.name, ...(error.details ?? []).flatMap((d) => [d.issue, d.field])]
    .filter((t): t is string => typeof t === "string")
    .join(" ");
  return /contact|profile|registrant/i.test(text);
}
