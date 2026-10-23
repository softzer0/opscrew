import type {
  CredentialCheck,
  DomainCheck,
  DsRecord,
  FetchLike,
  RegisteredDomain,
  RegistrarDnsRecord,
  RegistrationStatus,
} from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  durationText,
  listText,
  lowerFirst,
  maybeDoneHint,
  maybeStarted,
  normalizeHostName,
  OpsCrewError,
  parseAnswer,
  plural,
  Redactor,
  realSleep,
  statusPageHint,
  zodIssues,
} from "@opscrew/core";
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
  "Zone → SSL and Certificates → Edit",
  "Zone → Zone Settings → Edit",
] as const;

/** Where users create and edit Cloudflare API tokens. */
export const CLOUDFLARE_TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

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

/** The account permission Workers need, named as in the token builder (spike T1602, result 3). */
const WORKERS_PERMISSION = "Account → Workers Scripts → Edit";

/**
 * Permissions only Cloudflare hosting (no server) adds to the token, each marked with when it is
 * needed: the Worker, its custom domains and their DNS records; and, for a site that also answers
 * on `www`, the shared `www` redirect rule.
 */
export const CLOUDFLARE_HOSTING_PERMISSIONS = [
  `${WORKERS_PERMISSION} (only for Cloudflare hosting)`,
  "Zone → Single Redirect → Edit (only for Cloudflare hosting with www)",
] as const;

/**
 * The only permission the deploy token in GitHub Actions needs: Wrangler uploads and activates
 * versions with it. Cloudflare offers nothing narrower, so it can also attach custom domains in
 * the account's zones.
 */
export const CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS = [WORKERS_PERMISSION] as const;

/** The zone rule phases OpsCrew adds its own rule to, next to the user's rules. */
export type ManagedRulesetPhase =
  | "http_config_settings"
  | "http_request_firewall_custom"
  | "http_request_dynamic_redirect";

/**
 * Comment on the DNS records that OpsCrew's `cloudflare-dns` and `cloudflare-tunnel` modules
 * create; it is how OpsCrew recognises its own records in a zone.
 */
export const OPSCREW_MANAGED_COMMENT = "Managed by OpsCrew";

/** A rule of a zone ruleset: the fields OpsCrew compares (others are not kept). */
export interface RulesetRule {
  id: string;
  ref?: string;
  enabled: boolean;
  action: string;
  expression: string;
  actionParameters?: unknown;
}

/** A zone's entrypoint ruleset for one phase, with its rules in order. */
export interface EntrypointRuleset {
  id: string;
  rules: RulesetRule[];
}

/** A rule OpsCrew writes into a zone ruleset, named as in the Cloudflare API. */
export interface CloudflareRuleInput {
  ref: string;
  description: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  enabled: boolean;
}

/** A version of a Worker, latest first. */
export interface WorkerVersion {
  id: string;
  /** ISO time. */
  createdOn: string;
  /** Its `workers/message` annotation: OpsCrew's deploys write `opscrew <run id> <sha256>`. */
  message?: string;
  /** What uploaded it, as Cloudflare names it (`wrangler`, `terraform`, `api` …). */
  source?: string;
}

/** A deployment of a Worker: the versions serving traffic and their shares, latest first. */
export interface WorkerDeployment {
  id: string;
  /** ISO time. */
  createdOn: string;
  versions: { id: string; percentage: number }[];
}

/** A custom domain of a Worker. */
export interface WorkerCustomDomain {
  hostname: string;
  zoneId: string;
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
  /**
   * Masks secrets in Cloudflare's error texts; a client key sent to Cloudflare is registered with
   * it first. Pass the session's redactor so that key is masked everywhere.
   */
  redactor?: Redactor;
}

/** One of the zone's Cloudflare Origin CA certificates. */
export interface OriginCertificate {
  id: string;
  hostnames: string[];
  /** ISO time in UTC. */
  expiresOn: string;
}

/** A client certificate uploaded for per-hostname Authenticated Origin Pulls. */
export interface HostnameClientCertificate {
  id: string;
  /** ISO time in UTC. */
  expiresOn: string;
  /** `pending_deployment` right after the upload, then `active`. */
  status: string;
}

/** One hostname's per-hostname Authenticated Origin Pulls setting. */
export interface HostnameAop {
  hostname: string;
  /** The client certificate Cloudflare presents to the origin for the hostname. */
  certId?: string;
  /** `true` while on; `null` (or `false`) once turned off. */
  enabled: boolean | null;
  /** `pending_deployment` after a change, then `active` (spike T1402); `""` when absent. */
  status: string;
}

/**
 * A request Cloudflare refused with HTTP 403 because the token lacks a permission (`reason`
 * `permission`). It is shown as CREDENTIALS_INVALID, with the permission to add in its hint.
 */
export class CloudflareError extends OpsCrewError {
  readonly reason = "permission";

  constructor(message: string, options: { hint?: string }) {
    super("CREDENTIALS_INVALID", message, options);
    this.name = "CloudflareError";
  }
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
  // Some lists (the Workers custom domains) answer `"errors": null` on success.
  errors: z
    .array(
      z.looseObject({
        code: z.union([z.number(), z.string()]).optional(),
        message: z.string().default(""),
      }),
    )
    .nullish()
    .transform((errors) => errors ?? []),
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

const ZonePlanSchema = z.looseObject({
  plan: z.looseObject({ legacy_id: z.string().nullish() }).nullish(),
});

const EntrypointSchema = z.looseObject({
  id: z.string().min(1),
  rules: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        ref: z.string().nullish(),
        enabled: z.boolean().default(true),
        action: z.string(),
        expression: z.string(),
        action_parameters: z.unknown().optional(),
      }),
    )
    .nullish(),
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

const OneTimePinSchema = z.looseObject({ id: z.string().min(1), type: z.literal("onetimepin") });

/** The fields of a tunnel that say whether it has connections (their details are not kept). */
const TunnelSchema = z.looseObject({
  status: z.string().nullish(),
  connections: z.array(z.unknown()).nullish(),
  conns_active_at: z.string().nullish(),
  conns_inactive_at: z.string().nullish(),
  deleted_at: z.string().nullish(),
});

/**
 * An expiry time as an ISO time in UTC. Origin CA writes `2041-10-16 23:53:00 +0000 UTC`, and
 * Authenticated Origin Pulls `2041-10-16T23:58:23Z` (spike T1402); any other form is refused.
 */
const ExpiryTime = z.string().transform((raw, ctx) => {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z| \+0000 UTC)$/.exec(raw);
  const time = match ? Date.parse(`${match[1]}T${match[2]}Z`) : Number.NaN;
  if (Number.isNaN(time)) {
    ctx.addIssue({ code: "custom", message: "not an expiry time Cloudflare is known to write" });
    return z.NEVER;
  }
  return new Date(time).toISOString();
});

const OriginCertificateSchema = z.looseObject({
  id: z.string().min(1),
  hostnames: z.array(z.string()),
  expires_on: ExpiryTime,
  revoked_at: z.string().nullish(),
});

const CreatedOriginCertificateSchema = z.looseObject({
  id: z.string().min(1),
  certificate: z.string().min(1),
  expires_on: ExpiryTime,
});

const ClientCertificateSchema = z.looseObject({
  id: z.string().min(1),
  expires_on: ExpiryTime,
  status: z.string(),
});

const HostnameAopSchema = z.looseObject({
  hostname: z.string().min(1),
  cert_id: z.string().nullish(),
  enabled: z.boolean().nullish(),
  status: z.string().nullish(),
});

/** The answer to a delete or a revoke: the id it was carried out for. */
const IdResultSchema = z.looseObject({ id: z.string().min(1) });

const ZoneSettingSchema = z.looseObject({ value: z.string(), editable: z.boolean() });

/** `GET …/workers/scripts/{name}/versions`: the message is the `workers/message` annotation. */
const WorkerVersionsSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        metadata: z.looseObject({ created_on: z.string(), source: z.string().nullish() }),
        annotations: z.looseObject({ "workers/message": z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
});

const WorkerDeploymentSchema = z.looseObject({
  id: z.string().min(1),
  created_on: z.string(),
  versions: z.array(z.looseObject({ version_id: z.string().min(1), percentage: z.number() })),
});

const WorkerDomainsSchema = z
  .array(z.looseObject({ hostname: z.string().min(1), zone_id: z.string().min(1) }))
  .nullable();

/** Most versions one read lists: Cloudflare keeps the last 100 for a rollback. */
const WORKER_VERSIONS_PAGE = 100;

/** Client certificates Cloudflare is deleting: listed for a while, but gone for OpsCrew. */
const DELETED_STATUS = new Set(["pending_deletion", "deleted"]);

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

/** Cloudflare's error code (with HTTP 404) for a phase that has no entrypoint ruleset yet. */
const NO_ENTRYPOINT_CODE = 10003;

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

/** Hints for creating the account's Zero Trust organization and login methods. */
const ACCESS_EDIT_HINTS: FailHints = {
  auth: `Setting up Cloudflare Access needs the account permission "Access: Organizations, Identity Providers, and Groups → Edit" on the token. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
};

/**
 * The error for a write Cloudflare gave no clear answer to (a 5xx, a timeout, a lost connection
 * or an unreadable answer): it is not sent again, and it may have been carried out.
 */
function mayHaveReached(what: string, detail: string, cause?: unknown): OpsCrewError {
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `OpsCrew got no clear answer from Cloudflare when it tried to ${what} (${detail}). The change may still have reached Cloudflare.`,
    {
      hint: "Run the command again: OpsCrew reads the current state first and shows what is left to do.",
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/** Hints for the account's Cloudflare Tunnels. */
const TUNNEL_HINTS: FailHints = {
  auth: `Reading a Cloudflare Tunnel needs the account permission "Cloudflare Tunnel" on the token. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
};

/** Hints for origin certificates and per-hostname Authenticated Origin Pulls. */
const CERTIFICATE_HINTS: FailHints = {
  auth: `Origin certificates and Authenticated Origin Pulls need the token permission "Zone → SSL and Certificates → Edit" for this zone. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
};

/** Hints for the zone's settings. */
const SETTINGS_HINTS: FailHints = {
  auth: `The zone's minimum TLS version needs the token permission "Zone → Zone Settings → Edit" for this zone. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
};

/** Hints for the account's Workers. */
const WORKERS_HINTS: FailHints = {
  auth: `Cloudflare hosting needs the account permission "${WORKERS_PERMISSION}" on the token. Edit the token at ${CLOUDFLARE_TOKEN_PAGE}; then set CLOUDFLARE_API_TOKEN.`,
};

/** Cloudflare's error code (with HTTP 404) for "This Worker does not exist on your account". */
const NO_WORKER_CODE = 10007;

/** True only for Cloudflare's "no such Worker" answer; any other 404 (a wrong account) is not. */
function noWorker(answer: RawAnswer): boolean {
  return answer.status === 404 && answer.body.errors.some((e) => e.code === NO_WORKER_CODE);
}

/** `/accounts/{id}/workers/scripts/{name}`. */
function workerPath(accountId: string, worker: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}`;
}

function toClientCertificate(
  raw: z.infer<typeof ClientCertificateSchema>,
): HostnameClientCertificate {
  return { id: raw.id, expiresOn: raw.expires_on, status: raw.status };
}

function toHostnameAop(raw: z.infer<typeof HostnameAopSchema>): HostnameAop {
  return {
    hostname: raw.hostname,
    ...(raw.cert_id ? { certId: raw.cert_id } : {}),
    enabled: raw.enabled ?? null,
    status: raw.status ?? "",
  };
}

/** `/zones/{id}/origin_tls_client_auth/hostnames`: per-hostname Authenticated Origin Pulls. */
function aopPath(zoneId: string): string {
  return `/zones/${encodeURIComponent(zoneId)}/origin_tls_client_auth/hostnames`;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
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

function toEntrypoint(ruleset: z.infer<typeof EntrypointSchema>): EntrypointRuleset {
  return {
    id: ruleset.id,
    rules: (ruleset.rules ?? []).map((rule) => ({
      id: rule.id,
      ...(rule.ref ? { ref: rule.ref } : {}),
      enabled: rule.enabled,
      action: rule.action,
      expression: rule.expression,
      ...(rule.action_parameters == null ? {} : { actionParameters: rule.action_parameters }),
    })),
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
 * zone-create and DNSSEC calls are made by the domain purchase flow after its approval; the ruleset
 * and Zero Trust writes are made by `applyShared` after its `cloudflare-apply` approval; a Worker
 * version is activated by a promotion or rollback after its `promote` approval.
 */
export class CloudflareClient {
  readonly #token: string | undefined;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string;
  readonly #registrar: string;
  readonly #timeoutMs: number;
  readonly #redactor: Redactor;

  constructor(options: CloudflareClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#baseUrl = (options.baseUrl ?? CLOUDFLARE_API).replace(/\/$/, "");
    this.#sleep = options.sleep ?? realSleep;
    this.#userAgent = `opscrew/${options.version ?? "0.1.0"}`;
    this.#registrar = options.registrarSandbox ? "registrar-sandbox" : "registrar";
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#redactor = options.redactor ?? new Redactor();
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
            ? `The Cloudflare API did not answer within ${durationText(this.#timeoutMs)}.`
            : "Could not reach the Cloudflare API.",
          {
            hint: retryServerErrors ? CONNECTION_HINT : maybeDoneHint("Cloudflare"),
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

  /**
   * Cloudflare's explanation of a failed answer, in plain English where the code is known, with
   * any secret in it masked (a client key it quotes back, for one).
   */
  #detail(status: number, body: EnvelopeBody): string {
    return this.#redactor.redactSecrets(
      body.errors
        .map((e) =>
          (
            (typeof e.code === "string" ? knownReasonText(e.code) : undefined) ??
            (e.message || (e.code === undefined ? "" : String(e.code)))
          ).replace(/\.$/, ""),
        )
        .filter(Boolean)
        .join("; ") || `HTTP ${status}`,
    );
  }

  #fail(status: number, body: EnvelopeBody, what: string, hints: FailHints = {}): never {
    const detail = this.#detail(status, body);
    if (status === 403) {
      throw new CloudflareError(`Cloudflare refused the request to ${what}: ${detail}.`, {
        hint: hints.auth ?? permissionHint(),
      });
    }
    if (status === 401) {
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
        : statusPageHint("https://www.cloudflarestatus.com"),
    });
  }

  #parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    return parseAnswer(schema, value, "Cloudflare", what);
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

  /**
   * Sends a write once and returns the answer of a success (`204` included). It is never sent
   * again after a 5xx, a timeout or a lost connection: those, and an answer without a clear
   * result, throw PROVIDER_ERROR saying the change may have reached Cloudflare. A clear refusal
   * (a 4xx with Cloudflare's errors, or 429) throws as every other call does.
   */
  async #send(
    path: string,
    what: string,
    options: { method: "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; hints?: FailHints },
  ): Promise<RawAnswer> {
    let answer: RawAnswer;
    try {
      answer = await this.#request(path, { ...options, retryServerErrors: false });
    } catch (error) {
      if (error instanceof OpsCrewError && error.code === "PROVIDER_ERROR") {
        throw mayHaveReached(what, lowerFirst(error.message.replace(/\.$/, "")), error);
      }
      throw error;
    }
    const { status, body, envelope } = answer;
    if (status === 204) return answer;
    if (status === 429 || (status >= 400 && status < 500 && envelope)) {
      this.#fail(status, body, what, options.hints);
    }
    if (status >= 300 || !envelope || !body.success) {
      throw mayHaveReached(what, `HTTP ${status}${envelope ? "" : " without a readable answer"}`);
    }
    return answer;
  }

  /** The `result` of a write's success parsed with `schema`; an unexpected one may hide a change. */
  #parseWrite<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw mayHaveReached(what, `an unexpected answer: ${zodIssues(parsed.error)}`);
    }
    return parsed.data;
  }

  /** A ruleset write: sent once, and the whole ruleset Cloudflare returns. */
  async #writeRuleset(
    path: string,
    what: string,
    options: { method: "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<EntrypointRuleset> {
    const answer = await this.#send(path, what, options);
    return toEntrypoint(this.#parseWrite(EntrypointSchema, answer.body.result, what));
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

  /**
   * The zone's plan as the zone details name it (`plan.legacy_id`: `free`, `pro`, `business`,
   * `enterprise`), or undefined when Cloudflare does not say. Read-only.
   */
  async zonePlan(zoneId: string): Promise<string | undefined> {
    const zone = await this.#call(
      `/zones/${encodeURIComponent(zoneId)}`,
      ZonePlanSchema,
      "read the zone's plan",
    );
    return zone.plan?.legacy_id ?? undefined;
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
   * The zone's entrypoint ruleset for `phase` with its rules: `undefined` when the zone has none
   * (HTTP 404 with code 10003), `"forbidden"` when the token may not read it (HTTP 403). Any other
   * failure throws. Read-only.
   */
  async entrypointRuleset(
    zoneId: string,
    phase: ManagedRulesetPhase,
  ): Promise<EntrypointRuleset | undefined | "forbidden"> {
    const answer = await this.#request(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/${phase}/entrypoint`,
    );
    if (answer.status === 404 && answer.body.errors.some((e) => e.code === NO_ENTRYPOINT_CODE)) {
      return undefined;
    }
    if (answer.status === 403) return "forbidden";
    return toEntrypoint(this.#result(answer, EntrypointSchema, `read the ${phase} rules`));
  }

  /**
   * Creates the zone's entrypoint ruleset for `phase` holding only `rule` (`PUT`). Send it only to a
   * phase {@link entrypointRuleset} found without one: on an existing entrypoint, `PUT` replaces
   * every rule. Returns the ruleset.
   */
  async createEntrypointRuleset(
    zoneId: string,
    phase: ManagedRulesetPhase,
    rule: CloudflareRuleInput,
  ): Promise<EntrypointRuleset> {
    return this.#writeRuleset(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/${phase}/entrypoint`,
      `create the zone's ${phase} rules`,
      { method: "PUT", body: { rules: [rule] } },
    );
  }

  /** Appends `rule` to a zone ruleset (`POST …/rules`) and returns the ruleset. */
  async addRulesetRule(
    zoneId: string,
    rulesetId: string,
    rule: CloudflareRuleInput,
  ): Promise<EntrypointRuleset> {
    return this.#writeRuleset(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}/rules`,
      `add the rule "${rule.description}"`,
      { method: "POST", body: rule },
    );
  }

  /** Replaces the definition of one rule, keeping its id (`PATCH …/rules/{id}`); returns the ruleset. */
  async updateRulesetRule(
    zoneId: string,
    rulesetId: string,
    ruleId: string,
    rule: CloudflareRuleInput,
  ): Promise<EntrypointRuleset> {
    return this.#writeRuleset(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(ruleId)}`,
      `change the rule "${rule.description}"`,
      { method: "PATCH", body: rule },
    );
  }

  /** Deletes one rule of a zone ruleset (`DELETE …/rules/{id}`) and returns the ruleset. */
  async deleteRulesetRule(
    zoneId: string,
    rulesetId: string,
    ruleId: string,
  ): Promise<EntrypointRuleset> {
    return this.#writeRuleset(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(ruleId)}`,
      `delete the rule ${ruleId}`,
      { method: "DELETE" },
    );
  }

  /** Deletes a whole zone ruleset (`DELETE /zones/{id}/rulesets/{id}`, HTTP 204). */
  async deleteRuleset(zoneId: string, rulesetId: string): Promise<void> {
    await this.#send(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}`,
      `delete the ruleset ${rulesetId}`,
      { method: "DELETE" },
    );
  }

  /**
   * Asks Cloudflare's Origin CA for an ECDSA certificate for exactly `hostnames`, valid for `days`
   * (5475: 15 years), from `csr` (`POST /certificates`). Only the CSR is sent: the key stays with
   * the caller. Sent once.
   */
  async createOriginCertificate(input: {
    csr: string;
    hostnames: string[];
    days: 5475;
  }): Promise<{ id: string; certificate: string; expiresOn: string }> {
    const what = `create an origin certificate for ${listText(input.hostnames)}`;
    const answer = await this.#send("/certificates", what, {
      method: "POST",
      body: {
        csr: input.csr,
        hostnames: input.hostnames,
        request_type: "origin-ecc",
        requested_validity: input.days,
      },
      hints: CERTIFICATE_HINTS,
    });
    const created = this.#parseWrite(CreatedOriginCertificateSchema, answer.body.result, what);
    return { id: created.id, certificate: created.certificate, expiresOn: created.expires_on };
  }

  /** The zone's Origin CA certificates (`GET /certificates?zone_id=`), revoked ones left out. */
  async listOriginCertificates(zoneId: string): Promise<OriginCertificate[]> {
    const certificates = await this.#all(
      "/certificates",
      OriginCertificateSchema,
      "list the zone's origin certificates",
      { perPage: 50, filter: { zone_id: zoneId }, hints: CERTIFICATE_HINTS },
    );
    return certificates
      .filter((c) => c.revoked_at == null)
      .map((c) => ({ id: c.id, hostnames: c.hostnames, expiresOn: c.expires_on }));
  }

  /** Revokes an Origin CA certificate (`DELETE /certificates/{id}`). Sent once. */
  async revokeOriginCertificate(id: string): Promise<void> {
    const what = `revoke the origin certificate ${id}`;
    const answer = await this.#send(`/certificates/${encodeURIComponent(id)}`, what, {
      method: "DELETE",
      hints: CERTIFICATE_HINTS,
    });
    this.#parseWrite(IdResultSchema, answer.body.result, what);
  }

  /**
   * Uploads a client certificate and its key for per-hostname Authenticated Origin Pulls
   * (`POST …/origin_tls_client_auth/hostnames/certificates`). The key is registered with the
   * redactor before the request, so no error or log can show it. Sent once.
   */
  async uploadHostnameClientCertificate(
    zoneId: string,
    pem: { certificate: string; privateKey: string },
  ): Promise<HostnameClientCertificate> {
    this.#redactor.addLiteral(pem.privateKey, "ORIGIN_PULL_KEY");
    const what = "upload the app's client certificate for Authenticated Origin Pulls";
    const answer = await this.#send(`${aopPath(zoneId)}/certificates`, what, {
      method: "POST",
      body: {
        certificate: pem.certificate,
        private_key: pem.privateKey,
        bundle_method: "ubiquitous",
      },
      hints: CERTIFICATE_HINTS,
    });
    return toClientCertificate(this.#parseWrite(ClientCertificateSchema, answer.body.result, what));
  }

  /** The zone's client certificates for per-hostname origin pulls, those being deleted left out. */
  async listHostnameClientCertificates(zoneId: string): Promise<HostnameClientCertificate[]> {
    const certificates = await this.#all(
      `${aopPath(zoneId)}/certificates`,
      ClientCertificateSchema,
      "list the zone's client certificates for Authenticated Origin Pulls",
      { perPage: 50, hints: CERTIFICATE_HINTS },
    );
    return certificates.filter((c) => !DELETED_STATUS.has(c.status)).map(toClientCertificate);
  }

  /** Deletes a client certificate for per-hostname origin pulls. Sent once. */
  async deleteHostnameClientCertificate(zoneId: string, id: string): Promise<void> {
    const what = "delete the app's client certificate for Authenticated Origin Pulls";
    const answer = await this.#send(
      `${aopPath(zoneId)}/certificates/${encodeURIComponent(id)}`,
      what,
      { method: "DELETE", hints: CERTIFICATE_HINTS },
    );
    this.#parseWrite(IdResultSchema, answer.body.result, what);
  }

  /**
   * Sets per-hostname Authenticated Origin Pulls (`PUT …/origin_tls_client_auth/hostnames`):
   * `enabled: true` turns it on with `certId`, `null` turns it off. Cloudflare answers with each
   * setting `pending_deployment`. Sent once.
   */
  async putHostnameAopSettings(
    zoneId: string,
    config: { hostname: string; certId: string; enabled: boolean | null }[],
  ): Promise<HostnameAop[]> {
    const what = `set Authenticated Origin Pulls for ${listText(config.map((c) => c.hostname))}`;
    const answer = await this.#send(aopPath(zoneId), what, {
      method: "PUT",
      body: {
        config: config.map((c) => ({
          hostname: c.hostname,
          cert_id: c.certId,
          enabled: c.enabled,
        })),
      },
      hints: CERTIFICATE_HINTS,
    });
    const settings = this.#parseWrite(
      z.array(HostnameAopSchema).nullish(),
      answer.body.result,
      what,
    );
    return (settings ?? []).map(toHostnameAop);
  }

  /** Each hostname's per-hostname origin pull setting; a hostname without one (404) is left out. */
  async listHostnameAopSettings(
    zoneId: string,
    hostnames: readonly string[],
  ): Promise<HostnameAop[]> {
    const out: HostnameAop[] = [];
    for (const hostname of hostnames) {
      const answer = await this.#request(`${aopPath(zoneId)}/${encodeURIComponent(hostname)}`);
      if (answer.status === 404) continue;
      const setting = this.#result(
        answer,
        HostnameAopSchema.nullish(),
        `read Authenticated Origin Pulls for ${hostname}`,
        CERTIFICATE_HINTS,
      );
      if (setting) out.push(toHostnameAop(setting));
    }
    return out;
  }

  /** The zone's minimum TLS version and whether the zone's plan lets it be changed. */
  async getZoneSetting(
    zoneId: string,
    id: "min_tls_version",
  ): Promise<{ value: string; editable: boolean }> {
    const setting = await this.#call(
      `/zones/${encodeURIComponent(zoneId)}/settings/${id}`,
      ZoneSettingSchema,
      "read the zone's minimum TLS version",
      { hints: SETTINGS_HINTS },
    );
    return { value: setting.value, editable: setting.editable };
  }

  /** Raises the zone's minimum TLS version (`PATCH /zones/{id}/settings/min_tls_version`). */
  async patchZoneSetting(zoneId: string, id: "min_tls_version", value: "1.2"): Promise<void> {
    const what = `raise the zone's minimum TLS version to ${value}`;
    const answer = await this.#send(`/zones/${encodeURIComponent(zoneId)}/settings/${id}`, what, {
      method: "PATCH",
      body: { value },
      hints: SETTINGS_HINTS,
    });
    this.#parseWrite(ZoneSettingSchema, answer.body.result, what);
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

  /** Creates the account's Zero Trust organization with `authDomain` as its team domain and name. */
  async createAccessOrganization(
    accountId: string,
    authDomain: string,
  ): Promise<{ authDomain: string }> {
    const what = "create the account's Zero Trust organization";
    const answer = await this.#send(
      `/accounts/${encodeURIComponent(accountId)}/access/organizations`,
      what,
      {
        method: "POST",
        body: { name: authDomain, auth_domain: authDomain },
        hints: ACCESS_EDIT_HINTS,
      },
    );
    return {
      authDomain: this.#parseWrite(AccessOrganizationSchema, answer.body.result, what).auth_domain,
    };
  }

  /** Adds the one-time PIN login method to the account's Cloudflare Access; returns its id. */
  async createOneTimePinProvider(accountId: string): Promise<string> {
    const what = "add the one-time PIN login method to Cloudflare Access";
    const answer = await this.#send(
      `/accounts/${encodeURIComponent(accountId)}/access/identity_providers`,
      what,
      {
        method: "POST",
        body: { name: "One-time PIN", type: "onetimepin", config: {} },
        hints: ACCESS_EDIT_HINTS,
      },
    );
    return this.#parseWrite(OneTimePinSchema, answer.body.result, what).id;
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
   * Which of the Workers permissions the token lacks, named as in the token builder. Cloudflare
   * does not list a token's permissions, so this reads the account's Workers: a refusal (HTTP 403)
   * means the permission is missing. A token with only the read permission passes, and the first
   * write then names the permission. Read-only.
   */
  async workersPermissions(accountId: string): Promise<{ missing: string[] }> {
    const answer = await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    );
    if (answer.status === 403) return { missing: [WORKERS_PERMISSION] };
    this.#result(answer, z.unknown(), "list the account's Workers", WORKERS_HINTS);
    return { missing: [] };
  }

  /**
   * The Worker's versions, latest first, each with its `workers/message` annotation
   * (`GET …/versions`, the last 100); `undefined` when the account has no such Worker. Read-only.
   */
  async listWorkerVersions(
    accountId: string,
    worker: string,
  ): Promise<WorkerVersion[] | undefined> {
    const answer = await this.#request(
      `${workerPath(accountId, worker)}/versions?per_page=${WORKER_VERSIONS_PAGE}`,
    );
    if (noWorker(answer)) return undefined;
    const versions = this.#result(
      answer,
      WorkerVersionsSchema,
      `list the versions of the Worker ${worker}`,
      WORKERS_HINTS,
    );
    return (versions.items ?? []).map((v) => {
      const message = v.annotations?.["workers/message"];
      return {
        id: v.id,
        createdOn: v.metadata.created_on,
        ...(message ? { message } : {}),
        ...(v.metadata.source ? { source: v.metadata.source } : {}),
      };
    });
  }

  /**
   * The Worker's deployments, latest (the one serving traffic) first (`GET …/deployments`);
   * `undefined` when the account has no such Worker. Read-only.
   */
  async listWorkerDeployments(
    accountId: string,
    worker: string,
  ): Promise<WorkerDeployment[] | undefined> {
    const answer = await this.#request(`${workerPath(accountId, worker)}/deployments`);
    if (noWorker(answer)) return undefined;
    const { deployments } = this.#result(
      answer,
      z.looseObject({ deployments: z.array(WorkerDeploymentSchema) }),
      `list the deployments of the Worker ${worker}`,
      WORKERS_HINTS,
    );
    return deployments.map((d) => ({
      id: d.id,
      createdOn: d.created_on,
      versions: d.versions.map((v) => ({ id: v.version_id, percentage: v.percentage })),
    }));
  }

  /**
   * Activates one version of the Worker for all its traffic (`POST …/deployments`, strategy
   * `percentage`, the version at 100), with `message` as its `workers/message` annotation: a
   * promotion or a rollback. Sent once.
   */
  async deployWorkerVersion(
    accountId: string,
    worker: string,
    versionId: string,
    message: string,
  ): Promise<void> {
    const what = `activate version ${versionId} of the Worker ${worker}`;
    const answer = await this.#send(`${workerPath(accountId, worker)}/deployments`, what, {
      method: "POST",
      body: {
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": message },
      },
      hints: WORKERS_HINTS,
    });
    this.#parseWrite(WorkerDeploymentSchema, answer.body.result, what);
  }

  /** The Worker's custom domains (`GET /accounts/{id}/workers/domains?service=`). Read-only. */
  async listWorkerCustomDomains(accountId: string, worker: string): Promise<WorkerCustomDomain[]> {
    const domains = await this.#call(
      `/accounts/${encodeURIComponent(accountId)}/workers/domains?${new URLSearchParams({ service: worker })}`,
      WorkerDomainsSchema,
      `list the custom domains of the Worker ${worker}`,
      { hints: WORKERS_HINTS },
    );
    return (domains ?? []).map((d) => ({ hostname: d.hostname, zoneId: d.zone_id }));
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
        `create ${plural(posts.length, "DNS record")}`,
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
