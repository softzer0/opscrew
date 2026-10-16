import type {
  CredentialCheck,
  DomainCheck,
  DsRecord,
  FetchLike,
  RegisteredDomain,
  RegistrarDnsRecord,
  RegistrationStatus,
} from "@opscrew/contracts";
import { maybeStarted, normalizeHostName, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { CloudflareRecordInput } from "./records";
import {
  CLOUDFLARE_REGISTRAR_DASHBOARD,
  DomainListSchema,
  ExtensionSchema,
  knownReasonText,
  needsContactExtensions,
  RegistrationSchema,
  toDomainCheck,
  toRegisteredDomain,
  toRegistrationStatus,
  WorkflowSchema,
} from "./registrar-parse";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Permissions OpsCrew asks for, named as in the Cloudflare dashboard token builder. */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  "Zone → Zone → Read",
  "Zone → DNS → Edit",
  "Zone → Config Rules → Edit",
  "Zone → Zone WAF → Edit",
] as const;

/** Where users create and edit Cloudflare API tokens. */
const CLOUDFLARE_TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Optional permissions for buying domains, named as in the token builder: the account-level
 * Registrar permission, zone creation, and the zone permissions for every zone of the account (a
 * token limited to the zones that exist today does not cover the zone of a domain bought later).
 * The exact name of the Registrar permission is not confirmed yet.
 */
export const CLOUDFLARE_REGISTRAR_PERMISSIONS = [
  "Account → Registrar (edit)",
  "Zone → Zone → Edit for all zones of the account (to create the zone of a bought domain)",
  `${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")} for all zones of the account, not only the zone you use today: a token limited to existing zones does not cover the zone of a domain you buy, so otherwise add that zone to the token right after buying`,
] as const;

/** Rule phases OpsCrew may manage; it never takes over a phase the user already uses. */
export type ManagedRulesetPhase = "http_config_settings" | "http_request_firewall_custom";

/**
 * Comment on the DNS records and description of the rulesets that OpsCrew's `cloudflare-dns`
 * module creates; it is how OpsCrew recognises its own resources in a zone.
 */
export const OPSCREW_MANAGED_COMMENT = "Managed by OpsCrew";

/** Names the `cloudflare-dns` module gives its entrypoint rulesets. */
const OPSCREW_RULESET_NAMES = new Set(["OpsCrew configuration rules", "OpsCrew custom rules"]);

/** What a zone's entrypoint ruleset for one phase looks like (Cloudflare allows one per phase). */
export interface EntrypointRulesetStatus {
  /** The zone has an entrypoint ruleset in this phase (possibly with no rules). */
  exists: boolean;
  /** The ruleset carries the name or description OpsCrew's module renders. */
  ownedByOpsCrew: boolean;
  ruleCount: number;
  /** Ruleset id, when it exists. */
  id?: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  /** The account that holds the zone, when Cloudflare says. */
  accountId?: string;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
  /** MX (and URI) priority; SRV keeps it in its data. */
  priority?: number;
  /** Free-text record comment; OpsCrew's records carry {@link OPSCREW_MANAGED_COMMENT}. */
  comment?: string;
}

export interface CloudflareIpRanges {
  ipv4: string[];
  ipv6: string[];
}

export interface CloudflareClientOptions {
  token?: string;
  fetch: FetchLike;
  baseUrl?: string;
  /** Sleep used between retries (injected in tests). */
  sleep?: (ms: number) => Promise<void>;
  version?: string;
  /** Send registrar calls to Cloudflare's sandbox (`/registrar-sandbox/`, .com and .net only). */
  registrarSandbox?: boolean;
  /** How long one request may take (default 30 seconds). */
  timeoutMs?: number;
}

/** A Cloudflare account the token can see. */
export interface CloudflareAccount {
  id: string;
  name: string;
}

/** Registrar settings of one extension (TLD). */
export interface CloudflareRegistrarExtension {
  /** The extension without a leading dot, for example `us`. */
  tld: string;
  /** Registrant contact extensions are required, so the domain must be bought in the dashboard. */
  contactExtensionsRequired: boolean;
}

/** Body of a registration request, named as in the Cloudflare API. */
export interface CloudflareRegistrationRequest {
  domain_name: string;
  /** 1–10. */
  years: number;
  auto_renew: boolean;
  privacy_mode: "redaction" | "off";
}

/** DNSSEC state of a zone. */
export interface CloudflareDnssec extends Partial<DsRecord> {
  /** For example `pending` until the registrar publishes the DS record, then `active`. */
  status: string;
  /** DS record, when Cloudflare returns one. */
  ds?: string;
}

/**
 * Answer to an activation check. Cloudflare limits how often a zone may be re-checked (every 5
 * minutes on paid plans, hourly on free ones); a "too soon" answer is not an error.
 */
export type ActivationCheckResult =
  | { requested: true }
  | { requested: false; reason: string; retryAfterSeconds?: number };

/** A Cloudflare Access login method (identity provider) of an account. */
export interface CloudflareIdentityProvider {
  id: string;
  /** For example `onetimepin`, `github` or `google`. */
  type: string;
}

/**
 * Whether a Cloudflare Tunnel still has connections: `active` while a connector is connected,
 * `closed` once it has none, `gone` when the tunnel is deleted.
 */
export type TunnelConnectionState = "active" | "closed" | "gone";

const Envelope = z.looseObject({
  success: z.boolean(),
  errors: z
    .array(
      z.looseObject({
        code: z.union([z.number(), z.string()]).optional(),
        message: z.string().default(""),
      }),
    )
    .default([]),
  result: z.unknown().optional(),
  result_info: z.looseObject({ total_pages: z.number().optional() }).optional(),
});
type EnvelopeBody = z.infer<typeof Envelope>;

interface RawAnswer {
  status: number;
  body: EnvelopeBody;
  /** The answer was a JSON Cloudflare envelope (not synthesized from a bare HTTP status). */
  envelope: boolean;
}

const ZoneSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  name_servers: z.array(z.string()).default([]),
  account: z.looseObject({ id: z.string() }).nullable().optional(),
});

const RecordSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().default(""),
  proxied: z.boolean().optional(),
  ttl: z.number(),
  priority: z.number().nullable().optional(),
  comment: z.string().nullable().optional(),
});

const RulesetSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  rules: z.array(z.unknown()).nullable().optional(),
});

const IpsSchema = z.looseObject({
  ipv4_cidrs: z.array(z.string()),
  ipv6_cidrs: z.array(z.string()),
});

const AccountSchema = z.looseObject({ id: z.string(), name: z.string().default("") });

const DsNumber = z.union([z.number(), z.string()]).nullable().optional();
const DnssecSchema = z.looseObject({
  status: z.string(),
  ds: z.string().nullable().optional(),
  key_tag: DsNumber,
  algorithm: DsNumber,
  digest_type: DsNumber,
  digest: z.string().nullable().optional(),
});

/** One record of the scan review list (other fields are ignored). */
const ScannedRecordSchema = z.looseObject({
  type: z.string(),
  name: z.string(),
  content: z.string().nullable().optional(),
  ttl: z.number().optional(),
  priority: z.number().nullable().optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

const BatchResultSchema = z.looseObject({
  posts: z
    .array(z.looseObject({ id: z.string() }))
    .nullable()
    .optional(),
});

const AccessOrganizationSchema = z.looseObject({ auth_domain: z.string().min(1) });

const IdentityProvidersSchema = z
  .array(z.looseObject({ id: z.string().min(1), type: z.string() }))
  .nullable();

/** The fields of a tunnel that say whether it has connections (their details are not kept). */
const TunnelSchema = z.looseObject({
  status: z.string().nullish(),
  connections: z.array(z.unknown()).nullish(),
  conns_active_at: z.string().nullish(),
  conns_inactive_at: z.string().nullish(),
  deleted_at: z.string().nullish(),
});

/**
 * Most records one batch call creates. Cloudflare's limit depends on the plan (200 on Free, 3,500
 * on paid plans); larger lists are split into several calls of 200, each its own transaction.
 */
const BATCH_LIMIT = 200;

/** Reads of the scan review list while it is still empty after the trigger. */
const SCAN_REVIEW_ATTEMPTS = 5;
const SCAN_REVIEW_WAIT_MS = 2000;

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_SERVER_RETRIES = 2;
/** Default time one request may take before it counts as failed (and a read is retried). */
const REQUEST_TIMEOUT_MS = 30_000;

/** Most domains one domain-check call accepts. */
const DOMAIN_CHECK_BATCH = 20;

/** Cloudflare's error code for "zone already exists". */
const ZONE_EXISTS_CODE = 1061;

/**
 * Cloudflare's answer (HTTP 403, error 9999) when the account never turned on Zero Trust; checked
 * before the permission errors so the user is not sent to fix a token that is fine.
 */
const ACCESS_NOT_ENABLED = /access\.api\.error\.not_enabled|access is not enabled/i;

/** Cloudflare's answer when an account has no Zero Trust organization yet. */
const NO_ORGANIZATION = /not (?:been )?found|does not exist|no (?:zero trust )?organi[sz]ation/i;

/**
 * Lists the domain and each parent that could be the Cloudflare zone, most specific first:
 * `app.example.co.uk` → `app.example.co.uk`, `example.co.uk`, `co.uk`. Single labels are skipped.
 */
export function zoneCandidates(domain: string): string[] {
  const labels = normalizeHostName(domain).split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return out;
}

function permissionHint(): string {
  return `Create a token at ${CLOUDFLARE_TOKEN_PAGE} with: ${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")}; then set CLOUDFLARE_API_TOKEN.`;
}

/** Hint for a 4xx answer to a call that is not a registrar call: the token is the likely cause. */
function tokenHint(): string {
  return `The token in CLOUDFLARE_API_TOKEN may be mistyped, expired or revoked, or lack a permission. ${permissionHint()}`;
}

interface FailHints {
  /** Hint for 401/403. */
  auth?: string;
  /** Hint for other 4xx answers. */
  other?: string;
}

const REGISTRAR_HINTS: FailHints = {
  auth: `Buying domains is optional and needs extra permissions on the token: ${CLOUDFLARE_REGISTRAR_PERMISSIONS.join("; ")}. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
  other: `Check the registrar settings at ${CLOUDFLARE_REGISTRAR_DASHBOARD}: buying needs a default payment method, a verified email and a default registrant contact on the account.`,
};

const ACCOUNT_HINT = `The token in CLOUDFLARE_API_TOKEN may be mistyped, expired or revoked, or cannot see any account. Check it at ${CLOUDFLARE_TOKEN_PAGE}; buying domains needs ${CLOUDFLARE_REGISTRAR_PERMISSIONS.join("; ")}.`;

/**
 * Hints for listing accounts: a refusal there (Cloudflare answers a malformed token with 400) means
 * the token itself does not work or cannot see an account, never a registrar billing setting.
 */
const ACCOUNT_HINTS: FailHints = { auth: ACCOUNT_HINT, other: ACCOUNT_HINT };

/** Hints for zone calls on a zone the token's zone permissions may not cover (a bought domain). */
const ZONE_COVERAGE_HINTS: FailHints = {
  auth: `The token's zone permissions do not cover this zone. If the token is limited to specific zones, add this zone (or all zones of the account) to it at ${CLOUDFLARE_TOKEN_PAGE} with ${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")}; then set CLOUDFLARE_API_TOKEN.`,
};

/** Hints for the account's Cloudflare Access settings. */
const ACCESS_HINTS: FailHints = {
  auth: `Reading Cloudflare Access needs the account permission "Access: Organizations, Identity Providers, and Groups" on the token. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
};

/** Hints for the account's Cloudflare Tunnels. */
const TUNNEL_HINTS: FailHints = {
  auth: `Reading a Cloudflare Tunnel needs the account permission "Cloudflare Tunnel" on the token. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
};

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
  /**
   * Retry network failures, timeouts and 5xx answers. On for `GET` only (a write may already have
   * been carried out); a read sent as `POST` opts in.
   */
  retryServerErrors?: boolean;
  /** Wait and retry 429 answers (default true). */
  retryRateLimit?: boolean;
}

function dsNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** DNSSEC state, with the DS fields when the zone has DNSSEC active or pending. */
function toDnssec(result: z.infer<typeof DnssecSchema>): CloudflareDnssec {
  const out: CloudflareDnssec = { status: result.status, ...(result.ds ? { ds: result.ds } : {}) };
  if (result.status !== "active" && result.status !== "pending") return out;
  const keyTag = dsNumber(result.key_tag);
  const algorithm = dsNumber(result.algorithm);
  const digestType = dsNumber(result.digest_type);
  if (keyTag === undefined || algorithm === undefined || digestType === undefined) return out;
  if (!result.digest) return out;
  return { ...out, keyTag, algorithm, digestType, digest: result.digest };
}

/** A record of the scan review list as a registrar-style record (content in zone-file form). */
function toScannedRecord(raw: z.infer<typeof ScannedRecordSchema>): RegistrarDnsRecord {
  const type = raw.type.toUpperCase();
  const data = raw.data ?? {};
  const field = (key: string) => (data[key] == null ? "" : String(data[key]));
  let content = raw.content ?? "";
  if (type === "SRV" && data.target != null) {
    content = [field("priority"), field("weight"), field("port"), field("target")].join(" ");
  } else if (type === "CAA" && data.tag != null) {
    content = `${field("flags") || "0"} ${field("tag")} "${field("value")}"`;
  }
  const priority = raw.priority ?? (type === "SRV" ? dsNumber(data.priority) : undefined);
  return {
    type,
    name: normalizeHostName(raw.name),
    content,
    ...(raw.ttl === undefined ? {} : { ttl: raw.ttl }),
    ...(priority == null ? {} : { priority }),
  };
}

function toZone(zone: z.infer<typeof ZoneSchema>): CloudflareZone {
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    nameServers: zone.name_servers,
    ...(zone.account?.id ? { accountId: zone.account.id } : {}),
  };
}

/**
 * The connection state of a tunnel: active while Cloudflare lists a connection or the status is
 * `healthy` or `degraded`; closed once the status is `down` or `inactive` (or, without a status,
 * once the tunnel has no connection since it was last active); gone once it is deleted.
 */
function tunnelState(tunnel: z.infer<typeof TunnelSchema>): TunnelConnectionState {
  if (tunnel.deleted_at != null) return "gone";
  const status = tunnel.status ?? undefined;
  if (status === "healthy" || status === "degraded" || (tunnel.connections ?? []).length > 0) {
    return "active";
  }
  if (status === "down" || status === "inactive") return "closed";
  if (tunnel.conns_active_at == null || tunnel.conns_inactive_at != null) return "closed";
  return "active";
}

/**
 * Registrant sent only to the registrar sandbox, which has no Express Mode and ignores the
 * account's default contact. Made up (reserved example domain, fictional 555-01xx number); real
 * purchases send no contact, so the registrar uses the account's own.
 */
const SANDBOX_REGISTRANT = {
  email: "registrant@example.com",
  phone: "+1.2025550100",
  postal_info: {
    name: "OpsCrew Sandbox",
    address: {
      street: "100 Example Street",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
      country_code: "US",
    },
  },
} as const;

/**
 * Cloudflare API client. DNS changes are made through HCL and the approval gate; the registrar,
 * zone-create and DNSSEC calls are made by the domain purchase flow after its approval.
 */
export class CloudflareClient {
  readonly #token: string | undefined;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string;
  readonly #registrar: string;
  readonly #timeoutMs: number;

  constructor(options: CloudflareClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#baseUrl = (options.baseUrl ?? CLOUDFLARE_API).replace(/\/$/, "");
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#userAgent = `opscrew/${options.version ?? "0.1.0"}`;
    this.#registrar = options.registrarSandbox ? "registrar-sandbox" : "registrar";
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Raw request returning the parsed envelope and HTTP status. Every attempt has its own timeout;
   * 429 answers are retried (Cloudflare did not accept the request), and for reads also 5xx
   * answers, timeouts and lost connections (see {@link RequestOptions.retryServerErrors}).
   */
  async #request(path: string, options: RequestOptions = {}): Promise<RawAnswer> {
    const method = options.method ?? "GET";
    const retryServerErrors = options.retryServerErrors ?? method === "GET";
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.#userAgent,
      ...options.headers,
    };
    const init: RequestInit = { headers };
    if (method !== "GET") init.method = method;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (options.auth ?? true) {
      if (!this.#token) {
        throw new OpsCrewError("CREDENTIALS_MISSING", "No Cloudflare API token is set.", {
          hint: permissionHint(),
        });
      }
      headers.Authorization = `Bearer ${this.#token}`;
    }
    let rateLimited = 0;
    let serverErrors = 0;
    for (;;) {
      const signal = AbortSignal.timeout(this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, signal });
      } catch (error) {
        if (retryServerErrors && serverErrors < MAX_SERVER_RETRIES) {
          serverErrors++;
          await this.#sleep(1000 * 2 ** serverErrors);
          continue;
        }
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          signal.aborted
            ? `The Cloudflare API did not answer within ${Math.round(this.#timeoutMs / 1000)} seconds.`
            : "Could not reach the Cloudflare API.",
          {
            hint: retryServerErrors
              ? "Check your internet connection and try again."
              : "The request may still have reached Cloudflare; check the current state before trying again.",
            cause: error,
          },
        );
      }
      if (
        response.status === 429 &&
        (options.retryRateLimit ?? true) &&
        rateLimited < MAX_RATE_LIMIT_RETRIES
      ) {
        rateLimited++;
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.#sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 60) * 1000
            : 1000 * 2 ** rateLimited,
        );
        continue;
      }
      if (response.status >= 500 && retryServerErrors && serverErrors < MAX_SERVER_RETRIES) {
        serverErrors++;
        await this.#sleep(1000 * 2 ** serverErrors);
        continue;
      }
      let json: unknown;
      let jsonOk = true;
      try {
        json = await response.json();
      } catch {
        jsonOk = false;
        json = { success: false, errors: [{ message: `HTTP ${response.status}` }] };
      }
      const parsed = Envelope.safeParse(json);
      const body: EnvelopeBody = parsed.success
        ? parsed.data
        : {
            success: false,
            errors: [{ message: `Unexpected response (HTTP ${response.status})` }],
          };
      return { status: response.status, body, envelope: jsonOk && parsed.success };
    }
  }

  /** Cloudflare's explanation of a failed answer, in plain English where the code is known. */
  #detail(status: number, body: EnvelopeBody): string {
    return (
      body.errors
        .map((e) =>
          (
            (typeof e.code === "string" ? knownReasonText(e.code) : undefined) ??
            (e.message || (e.code === undefined ? "" : String(e.code)))
          ).replace(/\.$/, ""),
        )
        .filter(Boolean)
        .join("; ") || `HTTP ${status}`
    );
  }

  #fail(status: number, body: EnvelopeBody, what: string, hints: FailHints = {}): never {
    const detail = this.#detail(status, body);
    if (status === 401 || status === 403) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `Cloudflare refused the request to ${what}: ${detail}.`,
        { hint: hints.auth ?? permissionHint() },
      );
    }
    const clientError = status >= 400 && status < 500 && status !== 429;
    throw new OpsCrewError("PROVIDER_ERROR", `Cloudflare could not ${what}: ${detail}.`, {
      hint: clientError
        ? (hints.other ?? tokenHint())
        : "Try again in a minute; if it keeps failing, check https://www.cloudflarestatus.com.",
    });
  }

  #parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Cloudflare returned an unexpected answer when trying to ${what}.`,
      );
    }
    return result.data;
  }

  /** The `result` of a successful answer, parsed with `schema`; any other answer throws. */
  #result<T>(answer: RawAnswer, schema: z.ZodType<T>, what: string, hints?: FailHints): T {
    if (!answer.body.success || answer.status >= 400) {
      this.#fail(answer.status, answer.body, what, hints);
    }
    return this.#parse(schema, answer.body.result, what);
  }

  /** Sends the request and returns the answer's `result` parsed with `schema`. */
  async #call<T>(
    path: string,
    schema: z.ZodType<T>,
    what: string,
    options: RequestOptions & { hints?: FailHints } = {},
  ): Promise<T> {
    return this.#result(await this.#request(path, options), schema, what, options.hints);
  }

  /** Every page of a list: `?page=<n>&per_page=<perPage>`, then `filter`. */
  async #all<T>(
    path: string,
    item: z.ZodType<T>,
    what: string,
    options: { perPage: number; filter?: Record<string, string>; hints?: FailHints },
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({
        page: String(page),
        per_page: String(options.perPage),
        ...options.filter,
      });
      const answer = await this.#request(`${path}?${query}`);
      out.push(...this.#result(answer, z.array(item), what, options.hints));
      if (page >= (answer.body.result_info?.total_pages ?? 1)) return out;
    }
  }

  /** `/accounts/{id}/registrar{rest}` (or `registrar-sandbox`). */
  #registrarPath(accountId: string, rest: string): string {
    return `/accounts/${encodeURIComponent(accountId)}/${this.#registrar}${rest}`;
  }

  /** Checks the token works. Falls back to listing zones for account-owned tokens. */
  async verifyToken(): Promise<CredentialCheck> {
    if (!this.#token) {
      return { ok: false, message: "CLOUDFLARE_API_TOKEN is not set." };
    }
    const { status, body } = await this.#request("/user/tokens/verify");
    const result = z.looseObject({ status: z.string() }).safeParse(body.result);
    if (body.success && result.success && result.data.status === "active") {
      return { ok: true, identity: "user API token", message: "The Cloudflare token is active." };
    }
    const zones = await this.#request("/zones?per_page=1");
    if (zones.body.success && zones.status < 400) {
      return {
        ok: true,
        identity: "account API token",
        message: "The Cloudflare token can read zones.",
      };
    }
    if (status === 401 || status === 403 || zones.status === 401 || zones.status === 403) {
      return { ok: false, message: `The Cloudflare token was rejected. ${permissionHint()}` };
    }
    return {
      ok: false,
      message: `Cloudflare could not verify the token: ${body.errors.map((e) => e.message).join("; ") || `HTTP ${status}`}.`,
    };
  }

  /** The zone named exactly `name`, with its account id when Cloudflare returns it. */
  async #zoneByName(name: string): Promise<z.infer<typeof ZoneSchema> | undefined> {
    const zones = await this.#call(
      `/zones?name=${encodeURIComponent(name)}&per_page=1`,
      z.array(ZoneSchema),
      `look up the zone ${name}`,
    );
    return zones[0];
  }

  /** The zone that contains `domain` (tries the domain itself, then each parent), if any. */
  async findZone(domain: string): Promise<CloudflareZone | undefined> {
    for (const candidate of zoneCandidates(domain)) {
      const zone = await this.#zoneByName(candidate);
      if (zone) return toZone(zone);
    }
    return undefined;
  }

  /** DNS records of a zone, optionally filtered by exact name and type. Follows pagination. */
  async listDnsRecords(
    zoneId: string,
    filter: { name?: string; type?: string } = {},
  ): Promise<CloudflareDnsRecord[]> {
    const records = await this.#all(
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      RecordSchema,
      "list DNS records",
      {
        perPage: 100,
        filter: {
          ...(filter.name ? { name: filter.name } : {}),
          ...(filter.type ? { type: filter.type } : {}),
        },
      },
    );
    return records.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      ...(r.proxied === undefined ? {} : { proxied: r.proxied }),
      ...(r.priority == null ? {} : { priority: r.priority }),
      ...(r.comment ? { comment: r.comment } : {}),
    }));
  }

  /**
   * The zone's entrypoint ruleset for `phase`: whether it exists, whether OpsCrew created it (by
   * the name or description its module renders) and how many rules it holds. OpsCrew manages a
   * phase only when the entrypoint is missing or its own.
   */
  async inspectEntrypointRuleset(
    zoneId: string,
    phase: ManagedRulesetPhase,
  ): Promise<EntrypointRulesetStatus> {
    const answer = await this.#request(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/${phase}/entrypoint`,
    );
    if (answer.status === 404) return { exists: false, ownedByOpsCrew: false, ruleCount: 0 };
    const ruleset = this.#result(answer, RulesetSchema, `read the ${phase} rules`);
    const ownedByOpsCrew =
      ruleset.description?.trim() === OPSCREW_MANAGED_COMMENT ||
      OPSCREW_RULESET_NAMES.has(ruleset.name?.trim() ?? "");
    return {
      exists: true,
      ownedByOpsCrew,
      ruleCount: ruleset.rules?.length ?? 0,
      ...(ruleset.id ? { id: ruleset.id } : {}),
    };
  }

  /** Cloudflare's published edge IP ranges (public endpoint, no token needed). */
  async getIpRanges(): Promise<CloudflareIpRanges> {
    const ips = await this.#call("/ips", IpsSchema, "read its IP ranges", { auth: false });
    return { ipv4: ips.ipv4_cidrs, ipv6: ips.ipv6_cidrs };
  }

  /** Accounts the token can see. Follows pagination. */
  async listAccounts(): Promise<CloudflareAccount[]> {
    const accounts = await this.#all("/accounts", AccountSchema, "list your accounts", {
      perPage: 50,
      hints: ACCOUNT_HINTS,
    });
    return accounts.map((a) => ({ id: a.id, name: a.name }));
  }

  /**
   * The account's Zero Trust organization (its team domain), or `undefined` when the account has
   * none yet. Throws `PHASE_PRECONDITION` when Cloudflare Access was never turned on, and an
   * error for an organization without a team domain (OpsCrew cannot tell whose it is). Read-only.
   */
  async accessOrganization(accountId: string): Promise<{ authDomain: string } | undefined> {
    const what = "read the account's Zero Trust organization";
    const answer = await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/access/organizations`,
    );
    const { status, body } = answer;
    if (body.errors.some((e) => ACCESS_NOT_ENABLED.test(e.message))) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "Cloudflare Access is not turned on for this Cloudflare account yet. Nothing was changed.",
        {
          hint: "Open the Zero Trust dashboard at https://one.dash.cloudflare.com/, choose a team name and the Free plan, then run the command again.",
        },
      );
    }
    if (status === 404) return undefined;
    if (body.success && status < 400) {
      // Only an absent or null result means "no organization"; anything else must name its team
      // domain, or OpsCrew cannot tell whose organization it is (fail closed).
      if (body.result === undefined || body.result === null) return undefined;
      return { authDomain: this.#parse(AccessOrganizationSchema, body.result, what).auth_domain };
    }
    if (status !== 401 && status !== 403 && NO_ORGANIZATION.test(this.#detail(status, body))) {
      return undefined;
    }
    this.#fail(status, body, what, ACCESS_HINTS);
  }

  /** The account's Cloudflare Access login methods (identity providers). Read-only. */
  async accessIdentityProviders(accountId: string): Promise<CloudflareIdentityProvider[]> {
    const providers = await this.#call(
      `/accounts/${encodeURIComponent(accountId)}/access/identity_providers`,
      IdentityProvidersSchema,
      "list the account's Access login methods",
      { hints: ACCESS_HINTS },
    );
    return (providers ?? []).map((p) => ({ id: p.id, type: p.type }));
  }

  /**
   * Whether a Cloudflare Tunnel still has connections (`GET /accounts/{id}/cfd_tunnel/{id}`):
   * `gone` when Cloudflare has no such tunnel. Only the state is kept: the answer also holds the
   * server's address. Read-only.
   */
  async tunnelConnections(accountId: string, tunnelId: string): Promise<TunnelConnectionState> {
    const answer = await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
    );
    if (answer.status === 404) return "gone";
    return tunnelState(this.#result(answer, TunnelSchema, "read the tunnel", TUNNEL_HINTS));
  }

  /**
   * Live availability and prices (authoritative). Lists longer than 20 domains are split into
   * several calls; duplicates are checked once. Results keep the order of the input.
   */
  async domainCheck(accountId: string, domains: readonly string[]): Promise<DomainCheck[]> {
    const unique = [...new Set(domains.map(normalizeHostName).filter(Boolean))];
    const out: DomainCheck[] = [];
    for (let i = 0; i < unique.length; i += DOMAIN_CHECK_BATCH) {
      const batch = unique.slice(i, i + DOMAIN_CHECK_BATCH);
      const items = await this.#call(
        this.#registrarPath(accountId, "/domain-check"),
        DomainListSchema,
        "check whether the domains can be registered",
        // A read sent as POST: safe to repeat.
        {
          method: "POST",
          body: { domains: batch },
          retryServerErrors: true,
          hints: REGISTRAR_HINTS,
        },
      );
      const checks = items.map((item) => toDomainCheck(item, false));
      const position = (check: DomainCheck) => {
        const at = batch.indexOf(check.domain);
        return at === -1 ? batch.length : at;
      };
      out.push(...checks.sort((a, b) => position(a) - position(b)));
    }
    return out;
  }

  /** Cached name suggestions for a query; confirm them with {@link domainCheck} before buying. */
  async domainSearch(accountId: string, query: string): Promise<DomainCheck[]> {
    const items = await this.#call(
      this.#registrarPath(accountId, `/domain-search?${new URLSearchParams({ q: query })}`),
      DomainListSchema,
      "search for domain names",
      { hints: REGISTRAR_HINTS },
    );
    return items.map((item) => toDomainCheck(item, true));
  }

  /** Registrar settings of an extension (`us` or `.us`); undefined when Cloudflare does not know it. */
  async getExtension(
    accountId: string,
    tld: string,
  ): Promise<CloudflareRegistrarExtension | undefined> {
    const ext = normalizeHostName(tld).replace(/^\./, "");
    const answer = await this.#request(
      this.#registrarPath(accountId, `/extensions/${encodeURIComponent(ext)}`),
    );
    if (answer.status === 404) return undefined;
    const raw = this.#result(
      answer,
      ExtensionSchema.nullish(),
      `read the registrar settings of .${ext}`,
      REGISTRAR_HINTS,
    );
    return { tld: ext, contactExtensionsRequired: needsContactExtensions(raw ?? {}) };
  }

  /**
   * Starts a registration (billable, non-refundable once it succeeds) and returns the first
   * workflow status. Sends `Prefer: respond-async`; accepts 201 and 202 (both polled until
   * `succeeded`). Never retried on network or server errors, so it cannot buy twice. Only a clear
   * rejection is reported as such: 401/403 as `CREDENTIALS_INVALID`, and a Cloudflare error
   * envelope with another 4xx except 429 (no default contact or payment method, domain taken …)
   * as `PHASE_PRECONDITION` with Cloudflare's reason. Every other unusable answer is
   * `PROVIDER_ERROR`: the registration may have started.
   */
  async createRegistration(
    accountId: string,
    request: CloudflareRegistrationRequest,
  ): Promise<RegistrationStatus> {
    const domain = normalizeHostName(request.domain_name);
    const what = `register ${domain}`;
    const uncertain = (detail: string, cause?: unknown) =>
      maybeStarted({
        registrar: "Cloudflare",
        domain,
        detail,
        dashboard: CLOUDFLARE_REGISTRAR_DASHBOARD,
        ...(cause === undefined ? {} : { cause }),
      });
    const sandbox = this.#registrar === "registrar-sandbox";
    let answer: RawAnswer;
    try {
      answer = await this.#request(this.#registrarPath(accountId, "/registrations"), {
        method: "POST",
        headers: { Prefer: "respond-async" },
        body: {
          ...request,
          domain_name: domain,
          ...(sandbox ? { contacts: { registrant: SANDBOX_REGISTRANT } } : {}),
        },
      });
    } catch (error) {
      if (error instanceof OpsCrewError && error.code === "PROVIDER_ERROR") {
        throw uncertain("the connection failed", error);
      }
      throw error;
    }
    const { status, body, envelope } = answer;
    if (status === 401 || status === 403) this.#fail(status, body, what, REGISTRAR_HINTS);
    const clientError = status >= 400 && status < 500 && status !== 429;
    if (clientError && envelope && !body.success) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Cloudflare refused to register ${domain}: ${this.#detail(status, body)}.`,
        {
          hint: `Fix it at ${CLOUDFLARE_REGISTRAR_DASHBOARD} (buying needs a default payment method, a verified email address and a default registrant contact on the account), or pick another name.`,
        },
      );
    }
    if (clientError) throw uncertain(`HTTP ${status} without a clear Cloudflare answer`);
    if (status < 200 || status >= 300) throw uncertain(`HTTP ${status}`);
    if (!envelope) throw uncertain(`HTTP ${status} without a readable answer`);
    if (!body.success) throw uncertain(`HTTP ${status} reporting an error`);
    const raw = WorkflowSchema.safeParse(body.result ?? {});
    if (!raw.success) throw uncertain(`HTTP ${status} with an unexpected answer`);
    return toRegistrationStatus(raw.data, domain);
  }

  /**
   * True only for the live Registrar API's exact "no registration" answer, checked against the
   * real and sandbox APIs on 2026-10-14: a 404 envelope whose every error has code 10000 and the
   * message `expected` ("No workflow found for <domain>" from the registration status, "Domain
   * not found" from the registration). Code 10000 is also Cloudflare's authentication error, so
   * the code alone never counts; every other answer fails closed.
   */
  #noRegistration(answer: RawAnswer, expected: string): boolean {
    const { status, body, envelope } = answer;
    if (status !== 404 || !envelope || body.success || body.errors.length === 0) return false;
    return body.errors.every(
      (e) => e.code === 10000 && e.message.trim().replace(/\.$/, "").toLowerCase() === expected,
    );
  }

  /** Status of the account's registration of `domain`; undefined when there is none. */
  async registrationStatus(
    accountId: string,
    domain: string,
  ): Promise<RegistrationStatus | undefined> {
    const name = normalizeHostName(domain);
    const answer = await this.#request(
      this.#registrarPath(
        accountId,
        `/registrations/${encodeURIComponent(name)}/registration-status`,
      ),
    );
    if (this.#noRegistration(answer, `no workflow found for ${name}`)) return undefined;
    const what = `read the registration status of ${name}`;
    if (!answer.body.success || answer.status >= 400) {
      this.#fail(answer.status, answer.body, what, REGISTRAR_HINTS);
    }
    return toRegistrationStatus(this.#parse(WorkflowSchema, answer.body.result ?? {}, what), name);
  }

  /** The account's registration of `domain`; undefined when the account does not hold it. */
  async getRegistration(accountId: string, domain: string): Promise<RegisteredDomain | undefined> {
    const name = normalizeHostName(domain);
    const answer = await this.#request(
      this.#registrarPath(accountId, `/registrations/${encodeURIComponent(name)}`),
    );
    if (this.#noRegistration(answer, "domain not found")) return undefined;
    const what = `read the registration of ${name}`;
    return toRegisteredDomain(
      this.#result(answer, RegistrationSchema, what, REGISTRAR_HINTS),
      name,
    );
  }

  /** Turns auto-renew on or off and returns the updated registration. */
  async setAutoRenew(accountId: string, domain: string, on: boolean): Promise<RegisteredDomain> {
    const name = normalizeHostName(domain);
    const what = `turn auto-renew ${on ? "on" : "off"} for ${name}`;
    const { status, body } = await this.#request(
      this.#registrarPath(accountId, `/registrations/${encodeURIComponent(name)}`),
      { method: "PATCH", body: { auto_renew: on } },
    );
    if (!body.success || status >= 400) this.#fail(status, body, what, REGISTRAR_HINTS);
    const parsed = RegistrationSchema.safeParse(body.result);
    if (parsed.success && parsed.data.auto_renew != null) {
      return toRegisteredDomain(parsed.data, name);
    }
    const current = await this.getRegistration(accountId, name);
    if (!current) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Cloudflare no longer lists ${name} on the account.`,
      );
    }
    return current;
  }

  /**
   * Creates a full zone for `name` on the account. When Cloudflare says it already exists, returns
   * the existing zone, provided it belongs to the same account.
   */
  async createZone(accountId: string, name: string): Promise<CloudflareZone> {
    const zoneName = normalizeHostName(name);
    const what = `create the zone ${zoneName}`;
    const hints: FailHints = {
      auth: `Creating a zone needs the token permission "${CLOUDFLARE_REGISTRAR_PERMISSIONS[1]}". Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
    };
    const { status, body } = await this.#request("/zones", {
      method: "POST",
      body: { name: zoneName, account: { id: accountId }, type: "full" },
    });
    if (body.success && status < 400) return toZone(this.#parse(ZoneSchema, body.result, what));
    const exists =
      status === 409 ||
      body.errors.some((e) => e.code === ZONE_EXISTS_CODE || /already exists/i.test(e.message));
    if (!exists) this.#fail(status, body, what, hints);
    const zone = await this.#zoneByName(zoneName);
    if (!zone) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Cloudflare says the zone ${zoneName} already exists, but this token cannot see it.`,
        {
          hint: "It may be in another Cloudflare account; move or delete it there, or use a token for that account.",
        },
      );
    }
    if (zone.account?.id && zone.account.id !== accountId) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The zone ${zoneName} already exists in another Cloudflare account.`,
        { hint: "Delete it there, or buy and manage the domain from that account." },
      );
    }
    return toZone(zone);
  }

  /**
   * DNSSEC state of a zone (`active`, `pending`, `disabled` …). When DNSSEC is active or pending,
   * also the DS fields to publish at another registrar (`keyTag`, `algorithm`, `digestType`,
   * `digest`) and the full DS string (`ds`).
   */
  async getDnssec(zoneId: string): Promise<CloudflareDnssec> {
    return toDnssec(
      await this.#call(
        `/zones/${encodeURIComponent(zoneId)}/dnssec`,
        DnssecSchema,
        "read the DNSSEC state",
        { hints: ZONE_COVERAGE_HINTS },
      ),
    );
  }

  /** Turns on DNSSEC for a zone (Cloudflare Registrar publishes the DS record itself). */
  async enableDnssec(zoneId: string): Promise<CloudflareDnssec> {
    return toDnssec(
      await this.#call(
        `/zones/${encodeURIComponent(zoneId)}/dnssec`,
        DnssecSchema,
        "turn on DNSSEC",
        {
          method: "PATCH",
          body: { status: "active" },
          hints: ZONE_COVERAGE_HINTS,
        },
      ),
    );
  }

  /**
   * Asks Cloudflare to re-check the zone's nameservers now (`PUT /zones/{id}/activation_check`).
   * A rate-limited or "too soon" answer resolves with `requested: false` and the reason instead of
   * throwing: Cloudflare keeps checking pending zones on its own schedule anyway.
   */
  async activationCheck(zoneId: string): Promise<ActivationCheckResult> {
    const { status, body } = await this.#request(
      `/zones/${encodeURIComponent(zoneId)}/activation_check`,
      { method: "PUT", retryRateLimit: false },
    );
    if (body.success && status < 400) return { requested: true };
    const detail = this.#detail(status, body);
    const tooSoon =
      status === 429 ||
      (status >= 400 &&
        status < 500 &&
        status !== 401 &&
        status !== 403 &&
        /too (soon|many|often)|rate|once (per|every|an)|wait|recently|limit/i.test(detail));
    if (tooSoon) {
      return {
        requested: false,
        reason: `Cloudflare allows a nameserver re-check only every few minutes (hourly on free plans) and keeps checking on its own (${detail}).`,
        retryAfterSeconds: status === 429 ? 300 : 3600,
      };
    }
    this.#fail(status, body, "re-check the zone's nameservers", ZONE_COVERAGE_HINTS);
  }

  /**
   * Creates DNS records with `POST /zones/{id}/dns_records/batch` (`posts[]`): each call is one
   * transaction, so either all its records are created or none. Cloudflare limits a batch to 200
   * records on the Free plan, so longer lists are sent in several calls of 200. Never retried on
   * network or server errors. Returns the ids of the created records.
   */
  async batchCreateRecords(
    zoneId: string,
    records: readonly CloudflareRecordInput[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < records.length; i += BATCH_LIMIT) {
      const posts = records.slice(i, i + BATCH_LIMIT);
      const result = await this.#call(
        `/zones/${encodeURIComponent(zoneId)}/dns_records/batch`,
        BatchResultSchema.nullish(),
        `create ${posts.length} DNS record${posts.length === 1 ? "" : "s"}`,
        {
          method: "POST",
          body: { posts },
          hints: {
            ...ZONE_COVERAGE_HINTS,
            other: `None of the records in this call were created${ids.length > 0 ? ` (${ids.length} were created by earlier calls)` : ""}. Fix or leave out the record Cloudflare names, then run the command again.`,
          },
        },
      );
      ids.push(...(result?.posts ?? []).map((r) => r.id));
    }
    return ids;
  }

  /**
   * Asks Cloudflare to scan the domain's current public DNS (`/dns_records/scan/trigger`) and
   * returns the records it found (`/dns_records/scan/review`). The review list is only read, never
   * accepted or rejected: the connect flow shows the records and creates the approved ones itself.
   * An empty list is read again up to 5 times, 2 seconds apart (the scan runs in the background).
   */
  async scanDnsRecords(zoneId: string): Promise<RegistrarDnsRecord[]> {
    const base = `/zones/${encodeURIComponent(zoneId)}/dns_records/scan`;
    await this.#call(`${base}/trigger`, z.unknown(), "scan the domain's DNS records", {
      method: "POST",
      hints: ZONE_COVERAGE_HINTS,
    });
    for (let attempt = 1; ; attempt++) {
      const found =
        (await this.#call(
          `${base}/review`,
          z.array(ScannedRecordSchema).nullable().optional(),
          "read the scanned DNS records",
          { hints: ZONE_COVERAGE_HINTS },
        )) ?? [];
      if (found.length > 0 || attempt >= SCAN_REVIEW_ATTEMPTS) return found.map(toScannedRecord);
      await this.#sleep(SCAN_REVIEW_WAIT_MS);
    }
  }
}
