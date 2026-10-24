/**
 * Cloudflare resources several OpsCrew apps share (feature 011, ADR 0014): one OpsCrew rule per
 * phase in a zone, found by its fixed `ref` and listing the hostnames of every OpsCrew app there,
 * and the account's Zero Trust organization and one-time PIN login; and (feature 014, ADR 0017)
 * each app's origin TLS, per hostname (an Origin CA certificate and a client certificate for
 * Authenticated Origin Pulls), and the zone's minimum TLS version; and (feature 016) the rule that
 * sends the `www` hostnames of sites hosted on Cloudflare to their domain. `inspectShared` reads them,
 * `planShared` plans one app's change, `applyShared` applies a plan approved by its hash
 * (`cloudflare-apply`). A rule OpsCrew did not create is never written. See
 * `specs/011-shared-cloudflare-zone/contracts/cloudflare-shared.md` and
 * `specs/014-secops-tls/contracts/cloudflare-tls.md`.
 */
import type { Clock } from "@opscrew/contracts";
import {
  canonicalJson,
  durationText,
  fingerprintSha256,
  isPlanHash,
  listText,
  normalizeHostName,
  OpsCrewError,
  plural,
  pollAction,
  realSleep,
  sha256Hex,
  systemClock,
} from "@opscrew/core";
import { z } from "zod";
import {
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareClient,
  CloudflareError,
  type CloudflareRuleInput,
  type EntrypointRuleset,
  type HostnameAop,
  type HostnameClientCertificate,
  OPSCREW_MANAGED_COMMENT,
  type OriginCertificate,
  type RulesetRule,
} from "./client";

/** The phases OpsCrew keeps one shared rule in, and the rule's fixed `ref`. */
export const SHARED_RULES = {
  "opscrew-block-probes": { phase: "http_request_firewall_custom" },
  "opscrew-strict-tls": { phase: "http_config_settings" },
  "opscrew-www-redirect": { phase: "http_request_dynamic_redirect" },
} as const;
export type SharedRuleRef = keyof typeof SHARED_RULES;
type SharedPhase = (typeof SHARED_RULES)[SharedRuleRef]["phase"];

const REFS = Object.keys(SHARED_RULES) as SharedRuleRef[];

/** Cloudflare refuses longer rule expressions (research R3). */
const MAX_EXPRESSION_LENGTH = 4096;

/** The paths the block rule matches, as today's `cloudflare-waf` module wrote them. */
const PROBE_PATHS = [
  'http.request.uri.path contains "/.env"',
  'starts_with(http.request.uri.path, "/.git")',
  'http.request.uri.path contains "/wp-admin"',
  'http.request.uri.path contains "/wp-login.php"',
  'http.request.uri.path contains "/xmlrpc.php"',
  'http.request.uri.path contains "/phpmyadmin"',
].join(" or ");

/** Where the redirect rule sends a `www` hostname: the same URL without `www.` (spike T1602, 12). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: `${1}` is Cloudflare's wildcard capture.
const WWW_TARGET = 'wildcard_replace(http.request.full_uri, "https://www.*", "https://${1}")';

interface RuleTemplate {
  description: string;
  action: string;
  parameters?: Record<string, unknown>;
  /** How a rule whose parameters are not `parameters` differs, in words (with `parameters`). */
  changedParameters?: string;
  /** What follows the hostname set in the expression. */
  suffix: string;
  /** The phase's rules as the dashboard names them. */
  label: string;
  /** The token permission that reads and edits them. */
  permission: string;
  /** How a user puts a changed rule back. */
  restore: string;
}

const TEMPLATES: Record<SharedRuleRef, RuleTemplate> = {
  "opscrew-block-probes": {
    description: "OpsCrew: block probes for secrets and admin panels",
    action: "block",
    suffix: ` and (${PROBE_PATHS})`,
    label: "WAF custom rules",
    permission: "Zone → Zone WAF → Edit",
    restore: `set it back to the action Block, turned on, with the expression (http.host in {…its quoted hostnames…}) and (${PROBE_PATHS})`,
  },
  "opscrew-strict-tls": {
    description: "OpsCrew: verify the origin certificate (Full (strict) TLS)",
    action: "set_config",
    parameters: { ssl: "strict" },
    changedParameters: "its settings are not just the SSL setting Strict",
    suffix: "",
    label: "configuration rules",
    permission: "Zone → Config Rules → Edit",
    restore:
      "set it back to turned on, with only the SSL setting Strict and the expression (http.host in {…its quoted hostnames…})",
  },
  "opscrew-www-redirect": {
    description: "OpsCrew: redirect www to the domain",
    action: "redirect",
    parameters: {
      from_value: {
        status_code: 301,
        target_url: { expression: WWW_TARGET },
        preserve_query_string: true,
      },
    },
    changedParameters: "its redirect is not OpsCrew's 301 to the domain without www",
    suffix: "",
    label: "single redirect rules",
    permission: "Zone → Single Redirect → Edit",
    restore: `set it back to turned on, with a dynamic redirect to ${WWW_TARGET}, the status code 301 and the query string kept, and the expression (http.host in {…its quoted www hostnames…})`,
  },
};

/** A Cloudflare plan's name and how many rules a zone on it may hold in each OpsCrew phase. */
interface PlanLimits {
  name: string;
  limits: Record<SharedRuleRef, number>;
}

/**
 * The rule limits by the zone's plan (`plan.legacy_id`); single redirects have the configuration
 * rules' limits. For a plan not listed, OpsCrew does not count, and Cloudflare's own refusal stops
 * the apply.
 */
const RULE_LIMITS = new Map<string, PlanLimits>([
  [
    "free",
    {
      name: "Free",
      limits: { "opscrew-block-probes": 5, "opscrew-strict-tls": 10, "opscrew-www-redirect": 10 },
    },
  ],
  [
    "pro",
    {
      name: "Pro",
      limits: { "opscrew-block-probes": 20, "opscrew-strict-tls": 25, "opscrew-www-redirect": 25 },
    },
  ],
  [
    "business",
    {
      name: "Business",
      limits: { "opscrew-block-probes": 100, "opscrew-strict-tls": 50, "opscrew-www-redirect": 50 },
    },
  ],
  [
    "enterprise",
    {
      name: "Enterprise",
      limits: {
        "opscrew-block-probes": 1000,
        "opscrew-strict-tls": 300,
        "opscrew-www-redirect": 300,
      },
    },
  ],
]);

/** The token permissions origin TLS and the zone's minimum TLS need, named as in the token builder. */
const SSL_PERMISSION = "Zone → SSL and Certificates → Edit";
const SETTINGS_PERMISSION = "Zone → Zone Settings → Edit";
const DNS_PERMISSION = "Zone → DNS → Edit";

/** Cloudflare's longest Origin CA validity, 15 years (research R3, constitution II). */
const ORIGIN_CERTIFICATE_DAYS = 5475;
/** A certificate with fewer days left than this is replaced. */
const RENEW_DAYS = 30;
const DAY_MS = 86_400_000;
/** How long the apply waits for every hostname's origin pull setting to be active, and how often it reads. */
const ACTIVE_WAIT_MS = 5 * 60_000;
const ACTIVE_POLL_MS = 2000;
/** The DNS records whose proxied hostnames count for the zone's minimum TLS decision. */
const PROXIED_TYPES = new Set(["A", "AAAA", "CNAME"]);
/** Proxied hostnames that are not OpsCrew's, named in the advice before the rest are counted. */
const NAMED_OTHERS = 3;

/** A hostname OpsCrew writes into an expression: lower-case labels joined by dots. */
const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** The hostname set at the start of an OpsCrew expression: quoted names, separated by spaces. */
const HOST_SET = /^\(http\.host in \{("[a-z0-9.-]+"(?: "[a-z0-9.-]+")*)\}\)/;

/** What `inspectShared` read. */
export interface SharedFacts {
  zoneId: string;
  accountId: string;
  /** The zone's plan (`free`, `pro`, `business`, `enterprise`), when Cloudflare says. */
  zonePlan?: string;
  /**
   * Per phase read: the entrypoint ruleset (`undefined` when Cloudflare answered 404). A phase not
   * read has no key.
   */
  entrypoints: Record<string, EntrypointRuleset | undefined>;
  /** Phases whose entrypoint the token may not read (HTTP 403). */
  deniedPhases?: string[];
  /** Present only when Access is wanted. */
  organization?: { authDomain: string } | undefined;
  oneTimePinId?: string | undefined;
  /** The zone's origin TLS, when asked for (`tls`) and the token may read it. */
  tls?: {
    /** When it was read (ISO time): what certificates have left is counted from it. */
    readAt: string;
    /** The zone's Origin CA certificates that are not revoked. */
    origin: OriginCertificate[];
    /** The zone's client certificates for per-hostname origin pulls. */
    client: HostnameClientCertificate[];
    /**
     * The origin pull settings of the app's proxied hostnames and of those its record's client
     * certificate is on or leaving; a hostname without one is absent.
     */
    aop: HostnameAop[];
  };
  /** The zone's minimum TLS version and its proxied A, AAAA and CNAME records, when asked for. */
  minTls?: {
    value: string;
    editable: boolean;
    proxied: { name: string; comment?: string }[];
  };
  /** The token permissions a TLS read was refused for (HTTP 403), as the token builder names them. */
  deniedTls?: string[];
}

export interface SharedDesired {
  /** This app's hostnames in each OpsCrew rule; a rule absent or empty gets none (none on destroy). */
  hostnames: Partial<Record<SharedRuleRef, string[]>>;
  /** Access wanted: ensure the organization (with this auth domain) and the one-time PIN. */
  access?: { authDomain: string; oneTimePin: boolean };
  /** Origin TLS for the app's proxied hostnames (feature 014); absent: none is planned. */
  tls?: {
    /**
     * The app's proxied hostnames (empty on destroy). The plan turns off every hostname this app's
     * record turned on that is not in `proxied` and whose setting is still on with the app's
     * client certificate, and no other, once `served` shows the server no longer requires it.
     */
    proxied: string[];
    /** What the origin uses now, read from the server; absent when it could not be read. */
    served?: { originSha256?: string; requiring: string[] };
    /** Present only when a new origin certificate is wanted: its CSR (PEM). */
    origin?: { csr: string };
    /** The client certificate to upload, by its SHA-256 fingerprint, if not yet at Cloudflare. */
    client?: { sha256: string };
  };
  /** Provision asks for the decision on raising the zone's minimum TLS version to 1.2. */
  minTls?: boolean;
}

/** `.opscrew/cloudflare.json` (data-model.md), or undefined when the app has none yet. */
export interface SharedRecord {
  zoneId: string;
  hostnames: Partial<Record<SharedRuleRef, string[]>>;
  createdEntrypoints: string[];
  /** The app's origin TLS; absent until it has some. */
  tls?: {
    /** The origin certificate: `superseded` lists replaced ones, revoked once the server moved on. */
    origin?: {
      id: string;
      hostnames: string[];
      expiresAt: string;
      sha256: string;
      superseded: string[];
    };
    /** The client certificate: the hostnames it is enabled for, and those leaving the proxy. */
    client?: {
      id: string;
      expiresAt: string;
      sha256: string;
      enabled: string[];
      retiring: string[];
    };
    /** Set while the token lacks the certificate permissions, so `secure` reports the gap. */
    gap?: "permission";
  };
  /** What OpsCrew set in the zone's settings, and when. */
  zoneSettings?: { minTlsVersion?: { setAt: string; previous: "1.0" } };
}

const HostnameList = z.array(z.string().regex(HOSTNAME));
const Hostnames = HostnameList.optional();
const Id = z.string().min(1);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * `.opscrew/cloudflare.json` as read from disk: a 32-hex zone id, OpsCrew's rule refs with
 * lower-case hostnames, phases, and the app's origin certificates and zone setting when it has
 * them. Unknown keys are refused, so a damaged file stops the command.
 */
export const SharedRecordSchema: z.ZodType<SharedRecord> = z.strictObject({
  zoneId: z.string().regex(/^[0-9a-f]{32}$/),
  hostnames: z.strictObject({
    "opscrew-block-probes": Hostnames,
    "opscrew-strict-tls": Hostnames,
    "opscrew-www-redirect": Hostnames,
  }),
  createdEntrypoints: z.array(
    z.enum([
      "http_request_firewall_custom",
      "http_config_settings",
      "http_request_dynamic_redirect",
    ]),
  ),
  tls: z
    .strictObject({
      origin: z
        .strictObject({
          id: Id,
          hostnames: HostnameList,
          expiresAt: z.iso.datetime(),
          sha256: Sha256,
          superseded: z.array(Id),
        })
        .optional(),
      client: z
        .strictObject({
          id: Id,
          expiresAt: z.iso.datetime(),
          sha256: Sha256,
          enabled: HostnameList,
          retiring: HostnameList,
        })
        .optional(),
      gap: z.literal("permission").optional(),
    })
    .optional(),
  zoneSettings: z
    .strictObject({
      minTlsVersion: z
        .strictObject({ setAt: z.iso.datetime(), previous: z.literal("1.0") })
        .optional(),
    })
    .optional(),
});

/**
 * One change of a shared plan; rule bodies and ids are exactly what is sent. The last seven are
 * the app's origin TLS (certificates and per-hostname origin pulls) and the zone's minimum TLS.
 */
export type SharedChange =
  | { kind: "create-entrypoint"; phase: SharedPhase; rule: CloudflareRuleInput }
  | { kind: "add-rule"; phase: SharedPhase; rulesetId: string; rule: CloudflareRuleInput }
  | {
      kind: "update-hostnames";
      phase: SharedPhase;
      rulesetId: string;
      ruleId: string;
      add: string[];
      remove: string[];
    }
  | { kind: "delete-rule"; phase: SharedPhase; rulesetId: string; ruleId: string }
  | { kind: "delete-entrypoint"; phase: SharedPhase; rulesetId: string }
  | { kind: "create-organization"; authDomain: string }
  | { kind: "create-identity-provider"; type: "onetimepin" }
  | { kind: "create-origin-certificate"; hostnames: string[]; csrSha256: string }
  | { kind: "revoke-origin-certificate"; id: string }
  | { kind: "upload-client-certificate"; sha256: string }
  | { kind: "enable-client-certificate"; hostnames: string[]; sha256: string }
  | { kind: "disable-client-certificate"; hostnames: string[] }
  | { kind: "delete-client-certificate"; id: string }
  | { kind: "set-min-tls"; from: "1.0"; to: "1.2" };

type RuleChange = Extract<SharedChange, { phase: SharedPhase }>;

type TlsRecord = NonNullable<SharedRecord["tls"]>;
type ClientRecord = NonNullable<TlsRecord["client"]>;
type DesiredTls = NonNullable<SharedDesired["tls"]>;
type Advice = SharedPlan["advice"][number];
type TlsChange = Exclude<
  SharedChange,
  RuleChange | { kind: "create-organization" | "create-identity-provider" }
>;

/** The origin TLS part of a plan: its changes and finding, the record's `tls` before them, the CSR. */
interface TlsPlan {
  changes: SharedChange[];
  findings: SharedFinding[];
  tls: TlsRecord | undefined;
  csr?: string;
}

/** A blocking finding: what OpsCrew found and the next step, in plain English. */
export interface SharedFinding {
  code:
    | "hostname-claimed"
    | "hostname-tls-claimed"
    | "no-rule-slot"
    | "expression-too-long"
    | "rule-changed"
    | "permission-missing";
  message: string;
  hint: string;
}

/** One app's change to the shared resources. */
export interface SharedPlan {
  zoneId: string;
  accountId: string;
  changes: SharedChange[];
  /** Per phase the plan changes: OpsCrew's rule as it was read (`null` when absent). */
  expect: Partial<Record<SharedPhase, { id: string; hostnames: string[] } | null>>;
  /** Any finding means the plan cannot be applied. */
  findings: SharedFinding[];
  /**
   * The app's record before the plan, and once it is applied (also write `record` after a plan
   * with no changes and no findings). Its `tls` and `zoneSettings` are carried over from
   * `previous`, following what Cloudflare lists: a client certificate it no longer lists is
   * dropped, as are hostnames whose setting is no longer on with it; an origin certificate it no
   * longer lists is dropped unless superseded ones it lists remain, and superseded ids it no
   * longer lists are dropped; `gap` is set or cleared. `applyShared` updates them change by
   * change, so after an apply write the record it returns. Local only, never sent to Cloudflare,
   * so not in the hash.
   */
  previous: SharedRecord | undefined;
  record: SharedRecord;
  /**
   * The CSR (PEM) `create-origin-certificate` sends. Local, next to `record`: the change holds its
   * SHA-256, which the hash covers.
   */
  csr?: string;
  /** What OpsCrew advises without blocking the plan, in plain English. Local, not in the hash. */
  advice: { code: "tls-permission-missing" | "min-tls-advised"; message: string; hint: string }[];
  /** The Zero Trust pieces that already exist (returned by the apply). */
  organization?: { authDomain: string };
  oneTimePinId?: string;
  /** SHA-256 of the canonical JSON of `zoneId`, `accountId`, `changes` and `expect`. */
  hash: string;
}

export interface SharedApplyResult {
  /** The changes made, in order: `<kind> <phase>` for rules, `<kind>` for the others. */
  applied: string[];
  record: SharedRecord;
  organization?: { authDomain: string };
  oneTimePinId?: string;
  /** The origin certificate (PEM, public) this apply created; keep it with its key. */
  originCertificate?: string;
}

/**
 * An apply that stopped part-way: `applied` lists the changes made before the failure and
 * `record` is the app's record after them (save it), with `originCertificate` when one was
 * created before the failure. The write that failed may have reached Cloudflare, so its phase is
 * read again and the record keeps the app's hostnames OpsCrew's rule holds; when that read fails
 * too, it keeps the hostnames of both the old and the new record.
 */
export class SharedApplyError extends OpsCrewError {
  readonly applied: string[];
  readonly record: SharedRecord;
  readonly originCertificate?: string;

  constructor(
    code: OpsCrewError["code"],
    message: string,
    options: { hint?: string; cause?: unknown },
    applied: string[],
    record: SharedRecord,
    originCertificate?: string,
  ) {
    super(code, message, options);
    this.name = "SharedApplyError";
    this.applied = applied;
    this.record = record;
    if (originCertificate !== undefined) this.originCertificate = originCertificate;
  }
}

// --- Inspect -------------------------------------------------------------------------------------

/**
 * Reads the zone's plan and the entrypoint rulesets of OpsCrew's phases (the redirect phase only
 * with `redirect`); with `tls`, the zone's origin and client
 * certificates and the origin pull settings of the proxied hostnames and of those the record's
 * client certificate is on or leaving; with `minTls`, the zone's minimum
 * TLS version and its proxied A, AAAA and CNAME records; and, when `access` is set, the account's
 * Zero Trust organization and its one-time PIN login method. A TLS read the token may not make
 * (HTTP 403) leaves its facts out and names the permission in `deniedTls`. Read-only.
 */
export async function inspectShared(
  client: CloudflareClient,
  opts: {
    zoneId: string;
    accountId: string;
    access: boolean;
    /**
     * Read the phase of the `www` redirect rule too: for a site hosted on Cloudflare, which has (or
     * had) www hostnames there. A server never needs it, nor the token permission for it.
     */
    redirect?: boolean;
    /**
     * Read the zone's origin TLS for the app's proxied hostnames (`desired.tls.proxied`) and for
     * those its record's client certificate is on or leaving (the record to be planned against).
     */
    tls?: { proxied: readonly string[]; record: SharedRecord | undefined };
    /** Read what the decision on the zone's minimum TLS needs (`desired.minTls`). */
    minTls?: boolean;
    /** Default: this computer's clock. */
    clock?: Clock;
  },
): Promise<SharedFacts> {
  const zonePlan = await client.zonePlan(opts.zoneId);
  const entrypoints: Record<string, EntrypointRuleset | undefined> = {};
  const deniedPhases: string[] = [];
  for (const ref of REFS) {
    if (ref === "opscrew-www-redirect" && !opts.redirect) continue;
    const { phase } = SHARED_RULES[ref];
    const read = await client.entrypointRuleset(opts.zoneId, phase);
    if (read === "forbidden") deniedPhases.push(phase);
    else entrypoints[phase] = read;
  }
  const facts: SharedFacts = {
    zoneId: opts.zoneId,
    accountId: opts.accountId,
    ...(zonePlan ? { zonePlan } : {}),
    entrypoints,
  };
  if (deniedPhases.length > 0) facts.deniedPhases = deniedPhases;
  const denied: string[] = [];
  /** `read()`, or undefined (with `permission` noted) when Cloudflare refuses it with HTTP 403. */
  const allowed = async <T>(permission: string, read: () => Promise<T>) => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw error;
      denied.push(permission);
      return undefined;
    }
  };
  if (opts.tls) {
    const mine = opts.tls.record?.tls?.client;
    const hostnames = sortedUnique([
      ...appHostnames(opts.tls.proxied),
      ...(mine?.enabled ?? []),
      ...(mine?.retiring ?? []),
    ]);
    const readAt = (opts.clock ?? systemClock).now().toISOString();
    const tls = await allowed(SSL_PERMISSION, async () => ({
      readAt,
      origin: await client.listOriginCertificates(opts.zoneId),
      client: await client.listHostnameClientCertificates(opts.zoneId),
      aop: await client.listHostnameAopSettings(opts.zoneId, hostnames),
    }));
    if (tls) facts.tls = tls;
  }
  if (opts.minTls) {
    const setting = await allowed(SETTINGS_PERMISSION, () =>
      client.getZoneSetting(opts.zoneId, "min_tls_version"),
    );
    const records =
      setting && (await allowed(DNS_PERMISSION, () => client.listDnsRecords(opts.zoneId)));
    if (setting && records) {
      const proxied = records.filter((r) => r.proxied === true && PROXIED_TYPES.has(r.type));
      facts.minTls = {
        ...setting,
        proxied: proxied.map((r) => ({
          name: r.name,
          ...(r.comment ? { comment: r.comment } : {}),
        })),
      };
    }
  }
  if (denied.length > 0) facts.deniedTls = denied;
  if (!opts.access) return facts;
  const organization = await client.accessOrganization(opts.accountId);
  if (!organization) return facts;
  const providers = await client.accessIdentityProviders(opts.accountId);
  const oneTimePinId = providers.find((provider) => provider.type === "onetimepin")?.id;
  return { ...facts, organization, ...(oneTimePinId ? { oneTimePinId } : {}) };
}

// --- Plan ----------------------------------------------------------------------------------------

/** Pure: the changes, blocking findings and the plan's SHA-256 (`plan.hash`). */
export function planShared(
  facts: SharedFacts,
  desired: SharedDesired,
  record: SharedRecord | undefined,
): SharedPlan {
  if (record && record.zoneId !== facts.zoneId) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `This app's Cloudflare record is for the zone ${record.zoneId}, not ${facts.zoneId}.`,
      {
        hint: "Plan the removal of this app's hostnames in the zone of its record first, then plan again.",
      },
    );
  }
  const hostnames = Object.fromEntries(
    REFS.map((ref) => [ref, appHostnames(desired.hostnames[ref] ?? [])]),
  ) as Record<SharedRuleRef, string[]>;
  // Origin TLS and the zone's minimum TLS go first: the apply's order (contract "Order of the apply").
  const tls: TlsPlan = desired.tls
    ? planTls(facts, desired.tls, record?.tls)
    : { changes: [], findings: [], tls: record?.tls };
  const minTls = planMinTls(facts, desired);
  const changes: SharedChange[] = [...tls.changes, ...minTls.changes];
  const findings: SharedFinding[] = [...tls.findings];
  const expect: SharedPlan["expect"] = {};
  for (const ref of REFS) {
    const { phase } = SHARED_RULES[ref];
    if (facts.deniedPhases?.includes(phase)) {
      findings.push(permissionMissing(ref));
      continue;
    }
    if (!(phase in facts.entrypoints)) {
      // Not read (`inspectShared` without `redirect`): fine while the app has no hostnames there.
      if (hostnames[ref].length > 0 || (record?.hostnames[ref] ?? []).length > 0) {
        throw phaseNotRead(ref);
      }
      continue;
    }
    const entrypoint = facts.entrypoints[phase];
    const planned = planRule(
      ref,
      entrypoint,
      hostnames[ref],
      record?.hostnames[ref] ?? [],
      facts.zonePlan,
      record?.createdEntrypoints.includes(phase) ?? false,
    );
    if ("finding" in planned) {
      findings.push(planned.finding);
      continue;
    }
    if (planned.changes.length === 0) continue;
    changes.push(...planned.changes);
    const rule = ownRule(ref, entrypoint);
    expect[phase] = rule ? { id: rule.id, hostnames: hostnamesOf(ref, rule) ?? [] } : null;
  }
  if (desired.access) {
    if (!facts.organization) {
      changes.push({ kind: "create-organization", authDomain: desired.access.authDomain });
    }
    if (desired.access.oneTimePin && !facts.oneTimePinId) {
      changes.push({ kind: "create-identity-provider", type: "onetimepin" });
    }
  }
  const plan: Omit<SharedPlan, "hash"> = {
    zoneId: facts.zoneId,
    accountId: facts.accountId,
    changes,
    expect,
    findings,
    previous: record,
    record: withTls(
      {
        zoneId: facts.zoneId,
        hostnames: Object.fromEntries(
          REFS.flatMap((ref) => (hostnames[ref].length > 0 ? [[ref, hostnames[ref]]] : [])),
        ),
        createdEntrypoints: createdAfter(record, changes),
      },
      { tls: tls.tls, zoneSettings: record?.zoneSettings },
    ),
    ...(tls.csr !== undefined ? { csr: tls.csr } : {}),
    advice: [
      ...(facts.deniedTls?.length ? [tlsPermissionMissing(facts.deniedTls)] : []),
      ...minTls.advice,
    ],
    ...(facts.organization ? { organization: facts.organization } : {}),
    ...(facts.oneTimePinId ? { oneTimePinId: facts.oneTimePinId } : {}),
  };
  return { ...plan, hash: sharedPlanHash(plan) };
}

/**
 * The app's origin TLS changes (contract "Plan rules"), in the apply's order: the client
 * certificate uploaded and turned on for every proxied hostname, a new origin certificate for
 * exactly the proxied hostnames when there is none or it has fewer than 30 days left, then, once
 * the server shows it has moved on (`served`), the hostnames that left the proxy turned off, a
 * client certificate no hostname uses deleted, and the origin certificates it no longer serves
 * revoked. Also the finding that stops them, the record's `tls` before them, and the CSR the new
 * origin certificate is created from. A token without the certificate permission plans none of
 * them and records the gap.
 */
function planTls(facts: SharedFacts, want: DesiredTls, previous: TlsRecord | undefined): TlsPlan {
  const { gap: _gap, ...kept } = previous ?? {};
  if (facts.deniedTls?.includes(SSL_PERMISSION)) {
    return { changes: [], findings: [], tls: { ...kept, gap: "permission" } };
  }
  const read = facts.tls;
  if (read === undefined) {
    throw new OpsCrewError(
      "INTERNAL",
      "OpsCrew planned the app's origin TLS without reading the zone's first.",
      { hint: "Report this to OpsCrew: inspectShared needs `tls` whenever the plan has it." },
    );
  }
  const proxied = appHostnames(want.proxied);
  const listed = (id: string) => read.origin.some((c) => c.id === id);
  // The record follows what Cloudflare lists.
  const recorded = kept.client;
  const client = recorded && read.client.some((c) => c.id === recorded.id) ? recorded : undefined;
  const superseded = (kept.origin?.superseded ?? []).filter(listed);
  const origin =
    kept.origin && (listed(kept.origin.id) || superseded.length > 0)
      ? { ...kept.origin, superseded }
      : undefined;
  // A hostname is this app's while its setting is on with the app's client certificate: only
  // those are turned off, and the others leave the record.
  const holds = (hostname: string) =>
    client !== undefined && heldBy(read.aop, hostname) === client.id;
  const enabled = client ? sortedUnique([...client.enabled, ...client.retiring]).filter(holds) : [];
  const retiring = enabled.filter((h) => !proxied.includes(h));
  const tls: TlsRecord = {
    ...(origin ? { origin } : {}),
    ...(client ? { client: { ...client, enabled, retiring } } : {}),
  };
  const claimed = proxied.filter((hostname) => {
    const holder = heldBy(read.aop, hostname);
    return holder !== undefined && holder !== client?.id;
  });
  if (claimed.length > 0) return { changes: [], findings: [hostnameTlsClaimed(claimed)], tls };

  const changes: SharedChange[] = [];
  let sha256 = client?.sha256;
  if (want.client && proxied.length > 0 && want.client.sha256 !== sha256) {
    if (sha256 !== undefined) throw clientCertificateDiffers();
    sha256 = want.client.sha256;
    changes.push({ kind: "upload-client-certificate", sha256 });
  }
  const uploading = changes.length > 0;
  if (sha256 !== undefined) {
    const enable = proxied.filter((h) => uploading || !isOn(read.aop, h, client?.id));
    if (enable.length > 0) {
      changes.push({ kind: "enable-client-certificate", hostnames: enable, sha256 });
    }
  }
  const valid =
    origin !== undefined &&
    listed(origin.id) &&
    sameList(origin.hostnames, proxied) &&
    Date.parse(origin.expiresAt) - Date.parse(read.readAt) >= RENEW_DAYS * DAY_MS;
  let csr: string | undefined;
  if (proxied.length > 0 && !valid) {
    if (want.origin === undefined) throw originCsrMissing(proxied);
    csr = want.origin.csr;
    changes.push({
      kind: "create-origin-certificate",
      hostnames: proxied,
      csrSha256: sha256Hex(csr),
    });
  }
  // Clean-up waits for what the server uses now (`served`).
  const { served } = want;
  const disable = served ? retiring.filter((h) => !served.requiring.includes(h)) : [];
  if (disable.length > 0) changes.push({ kind: "disable-client-certificate", hostnames: disable });
  if (client !== undefined && proxied.length === 0 && disable.length === retiring.length) {
    changes.push({ kind: "delete-client-certificate", id: client.id });
  }
  if (served && origin) {
    // A superseded certificate goes once the server serves the newer one; with nothing proxied,
    // the current one goes too once the server no longer serves it.
    const revoke =
      served.originSha256 === origin.sha256
        ? superseded
        : proxied.length === 0
          ? [...superseded, ...(listed(origin.id) ? [origin.id] : [])]
          : [];
    for (const id of revoke) changes.push({ kind: "revoke-origin-certificate", id });
  }
  return { changes, findings: [], tls, ...(csr !== undefined ? { csr } : {}) };
}

/**
 * The decision on the zone's minimum TLS version (research R4), when provision asks for it: raised
 * from 1.0 to 1.2 only when Cloudflare lets it be changed and every proxied A, AAAA and CNAME
 * record in the zone is OpsCrew's; otherwise advised while it is below 1.2. A record is OpsCrew's
 * when it carries OpsCrew's comment, or when its hostname is this app's or listed in one of
 * OpsCrew's shared rules (another OpsCrew app's): a Worker's custom domain makes its own record,
 * without the comment.
 */
function planMinTls(
  facts: SharedFacts,
  desired: SharedDesired,
): { changes: SharedChange[]; advice: Advice[] } {
  const setting = facts.minTls;
  if (!desired.minTls || !setting || (setting.value !== "1.0" && setting.value !== "1.1")) {
    return { changes: [], advice: [] };
  }
  const opscrew = new Set(
    REFS.flatMap((ref) => {
      const rule = ownRule(ref, facts.entrypoints[SHARED_RULES[ref].phase]);
      return [...(desired.hostnames[ref] ?? []), ...((rule && hostnamesOf(ref, rule)) ?? [])];
    }),
  );
  const others = sortedUnique(
    setting.proxied
      .filter((r) => r.comment !== OPSCREW_MANAGED_COMMENT && !opscrew.has(r.name))
      .map((r) => r.name),
  );
  if (setting.value === "1.0" && setting.editable && others.length === 0) {
    return { changes: [{ kind: "set-min-tls", from: "1.0", to: "1.2" }], advice: [] };
  }
  return { changes: [], advice: [minTlsAdvised(setting.value, setting.editable, others)] };
}

/** The client certificate the hostname's origin pull setting is on with (undefined: it is off). */
function heldBy(settings: readonly HostnameAop[], hostname: string): string | undefined {
  const setting = settings.find((s) => s.hostname === hostname);
  return setting?.enabled === true ? setting.certId : undefined;
}

/** True when the hostname's origin pull setting is on and active with the certificate `certId`. */
function isOn(settings: readonly HostnameAop[], hostname: string, certId: string | undefined) {
  const setting = settings.find((s) => s.hostname === hostname);
  return (
    certId !== undefined && heldBy(settings, hostname) === certId && setting?.status === "active"
  );
}

function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}

/**
 * The changes to one shared rule, or the finding that stops them. `created`: the app's record says
 * it created the phase's entrypoint, which then goes when it holds no rule and the app wants none
 * there (a destroy whose delete of the entrypoint was not answered left it empty).
 */
function planRule(
  ref: SharedRuleRef,
  entrypoint: EntrypointRuleset | undefined,
  hostnames: readonly string[],
  mine: readonly string[],
  zonePlan: string | undefined,
  created: boolean,
): { changes: RuleChange[] } | { finding: SharedFinding } {
  const { phase } = SHARED_RULES[ref];
  const rule = ownRule(ref, entrypoint);
  let current: string[] = [];
  if (rule) {
    const differences = ruleDifferences(ref, rule);
    if (differences.length > 0) return { finding: ruleChanged(ref, differences) };
    current = hostnamesOf(ref, rule) ?? [];
  }
  const claimed = hostnames.filter((h) => current.includes(h) && !mine.includes(h));
  if (claimed.length > 0) return { finding: hostnameClaimed(ref, claimed) };
  const add = hostnames.filter((h) => !current.includes(h));
  const remove = mine.filter((h) => !hostnames.includes(h) && current.includes(h)).sort();
  if (add.length === 0 && remove.length === 0) {
    if (created && entrypoint && entrypoint.rules.length === 0) {
      return { changes: [{ kind: "delete-entrypoint", phase, rulesetId: entrypoint.id }] };
    }
    return { changes: [] };
  }
  const next = [...current, ...add].filter((h) => !remove.includes(h)).sort();
  const body = ruleBody(ref, next);
  if (next.length > 0 && body.expression.length > MAX_EXPRESSION_LENGTH) {
    return { finding: expressionTooLong(ref, body.expression.length, current.length) };
  }
  if (!entrypoint) return { changes: [{ kind: "create-entrypoint", phase, rule: body }] };
  const rulesetId = entrypoint.id;
  if (!rule) {
    const plan = zonePlan === undefined ? undefined : RULE_LIMITS.get(zonePlan);
    if (plan && entrypoint.rules.length >= plan.limits[ref]) {
      return { finding: noRuleSlot(ref, entrypoint.rules.length, plan) };
    }
    return { changes: [{ kind: "add-rule", phase, rulesetId, rule: body }] };
  }
  if (next.length > 0) {
    return {
      changes: [{ kind: "update-hostnames", phase, rulesetId, ruleId: rule.id, add, remove }],
    };
  }
  const changes: RuleChange[] = [{ kind: "delete-rule", phase, rulesetId, ruleId: rule.id }];
  if (entrypoint.rules.length === 1) changes.push({ kind: "delete-entrypoint", phase, rulesetId });
  return { changes };
}

/** The plan's hash: SHA-256 of the canonical JSON of what the apply sends and expects. */
function sharedPlanHash(plan: Pick<SharedPlan, "zoneId" | "accountId" | "changes" | "expect">) {
  const { zoneId, accountId, changes, expect } = plan;
  return sha256Hex(canonicalJson({ zoneId, accountId, changes, expect }));
}

/** The app's hostnames: lower case, unique, sorted; anything that is not a hostname is refused. */
function appHostnames(hostnames: readonly string[]): string[] {
  const names = [...new Set(hostnames.map(normalizeHostName))].sort();
  const invalid = names.filter((name) => !HOSTNAME.test(name));
  if (invalid.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(invalid.map((name) => JSON.stringify(name)))} cannot go into a Cloudflare rule: a hostname has only letters, digits, hyphens and dots.`,
      { hint: "Check the app's domain and hostnames, then run the command again." },
    );
  }
  return names;
}

// --- Rules ---------------------------------------------------------------------------------------

/** The rule OpsCrew writes for `hostnames` (sorted, lower case). */
function ruleBody(ref: SharedRuleRef, hostnames: readonly string[]): CloudflareRuleInput {
  const template = TEMPLATES[ref];
  return {
    ref,
    description: template.description,
    expression: `(http.host in {${hostnames.map((h) => `"${h}"`).join(" ")}})${template.suffix}`,
    action: template.action,
    ...(template.parameters ? { action_parameters: structuredClone(template.parameters) } : {}),
    enabled: true,
  };
}

function ownRule(ref: SharedRuleRef, entrypoint: EntrypointRuleset | undefined) {
  return entrypoint?.rules.find((rule) => rule.ref === ref);
}

/** The hostname set of an OpsCrew expression, or undefined when the rest is not the template's. */
function hostnamesOf(ref: SharedRuleRef, rule: RulesetRule): string[] | undefined {
  const match = HOST_SET.exec(rule.expression);
  if (!match?.[1] || rule.expression.slice(match[0].length) !== TEMPLATES[ref].suffix) {
    return undefined;
  }
  return [...new Set(match[1].slice(1, -1).split('" "'))].sort();
}

/** How OpsCrew's rule differs from its template, apart from its hostnames (none: as written). */
function ruleDifferences(ref: SharedRuleRef, rule: RulesetRule): string[] {
  const template = TEMPLATES[ref];
  const out: string[] = [];
  if (rule.action !== template.action) {
    out.push(`its action is "${rule.action}" instead of "${template.action}"`);
  }
  if (canonicalJson(rule.actionParameters ?? null) !== canonicalJson(template.parameters ?? null)) {
    out.push(template.changedParameters ?? "it has settings OpsCrew does not set");
  }
  if (!rule.enabled) out.push("it is turned off");
  if (!hostnamesOf(ref, rule)) out.push("its expression is not the one OpsCrew writes");
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// --- Findings ------------------------------------------------------------------------------------

function permissionMissing(ref: SharedRuleRef): SharedFinding {
  const { label, permission } = TEMPLATES[ref];
  return {
    code: "permission-missing",
    message: `The Cloudflare token may not read the zone's ${label} (HTTP 403).`,
    hint: `Edit the token at ${CLOUDFLARE_TOKEN_PAGE} and give it ${permission} for this zone, then run the command again.`,
  };
}

function hostnameClaimed(ref: SharedRuleRef, hostnames: readonly string[]): SharedFinding {
  const { description, label } = TEMPLATES[ref];
  const one = hostnames.length === 1;
  return {
    code: "hostname-claimed",
    message: `${listText([...hostnames])} ${one ? "is" : "are"} already in OpsCrew's shared rule "${description}" in this zone, but this app did not add ${one ? "it" : "them"}: another OpsCrew app uses ${one ? "it" : "them"}, or one whose project folder is gone.`,
    hint: `OpsCrew never takes a hostname from another app. Use another hostname; or, if the app that added ${one ? "it" : "them"} is gone, remove ${one ? "it" : "them"} from that rule's hostname list in the zone's ${label} in the Cloudflare dashboard, then run the command again.`,
  };
}

function noRuleSlot(ref: SharedRuleRef, count: number, plan: PlanLimits): SharedFinding {
  const { description, label } = TEMPLATES[ref];
  const upgrade = plan.name === "Enterprise" ? "" : ", or move the zone to a higher plan";
  return {
    code: "no-rule-slot",
    message: `The zone's ${label} already hold ${plural(count, "rule")}, the most Cloudflare's ${plan.name} plan allows (${plan.limits[ref].toLocaleString("en-US")}), so OpsCrew cannot add its rule "${description}".`,
    hint: `Delete or merge one of the zone's ${label} in the Cloudflare dashboard${upgrade}, then run the command again. OpsCrew needs one rule there for all its apps in the zone.`,
  };
}

function expressionTooLong(ref: SharedRuleRef, length: number, listed: number): SharedFinding {
  const { description } = TEMPLATES[ref];
  return {
    code: "expression-too-long",
    message: `With this app's hostnames, OpsCrew's shared rule "${description}" would be ${length.toLocaleString("en-US")} characters long, over Cloudflare's limit of 4,096. It already lists ${plural(listed, "hostname")}.`,
    hint: "Give this app fewer hostnames, or destroy OpsCrew apps in this zone you no longer need (opscrew destroy), then run the command again.",
  };
}

function ruleChanged(ref: SharedRuleRef, differences: readonly string[]): SharedFinding {
  const { description, label, restore } = TEMPLATES[ref];
  return {
    code: "rule-changed",
    message: `OpsCrew's shared rule "${description}" in the zone's ${label} was changed outside OpsCrew: ${listText([...differences])}. OpsCrew does not overwrite it.`,
    hint: `In the Cloudflare dashboard, ${restore}; or delete the rule so OpsCrew creates it again (other OpsCrew apps in the zone add their hostnames back on their next provision). Then run the command again.`,
  };
}

function hostnameTlsClaimed(hostnames: readonly string[]): SharedFinding {
  const one = hostnames.length === 1;
  return {
    code: "hostname-tls-claimed",
    message: `${listText(hostnames)} already ${one ? "requires" : "require"} a client certificate at Cloudflare that this app did not upload: another OpsCrew app uses ${one ? "it" : "them"}, or one whose project folder is gone.`,
    hint: `OpsCrew never takes a hostname from another app. Use another hostname, or run \`opscrew destroy\` for the app that uses ${one ? "it" : "them"}. If that app's folder is gone, turn the setting off with Cloudflare's API (PUT /zones/<zone id>/origin_tls_client_auth/hostnames with "enabled": null for ${one ? "the hostname" : "each hostname"}), then run the command again.`,
  };
}

function phaseNotRead(ref: SharedRuleRef): OpsCrewError {
  return new OpsCrewError(
    "INTERNAL",
    `OpsCrew planned its shared rule "${TEMPLATES[ref].description}" without reading the zone's ${TEMPLATES[ref].label} first.`,
    {
      hint: "Report this to OpsCrew: inspectShared needs `redirect` whenever the app has www hostnames there.",
    },
  );
}

function originCsrMissing(hostnames: readonly string[]): OpsCrewError {
  return new OpsCrewError(
    "INVALID_INPUT",
    `A new origin certificate is needed for ${listText(hostnames)} (there is none, it expires within 30 days, Cloudflare no longer lists it, or the hostnames changed), but this plan was given no certificate request.`,
    {
      hint: "Plan again with a CSR for the app's proxied hostnames (`desired.tls.origin.csr`).",
    },
  );
}

function clientCertificateDiffers(): OpsCrewError {
  return new OpsCrewError(
    "INVALID_INPUT",
    "This app's client certificate at Cloudflare is not the one asked for, and OpsCrew does not replace a client certificate: it lasts 15 years, and a safe switch needs the server to trust both certificates first.",
    {
      hint: "Use the app's client certificate and its key as they are, or restore them from the app's secrets copy, then run the command again. To replace it by hand: add the new certificate after the old one in opscrew/runtime/edge/tls/pull.pem and deploy; upload the new certificate and turn it on for each hostname with Cloudflare's API (POST /zones/<zone id>/origin_tls_client_auth/hostnames/certificates, then PUT /zones/<zone id>/origin_tls_client_auth/hostnames); remove the old certificate from pull.pem and deploy; delete the old one at Cloudflare; then put the new certificate's id, expiry and SHA-256 in the client entry of .opscrew/cloudflare.json.",
    },
  );
}

/** Advice for TLS reads the token was refused: which permissions to add, and what is left out. */
function tlsPermissionMissing(denied: readonly string[]): Advice {
  const certificates = denied.includes(SSL_PERMISSION);
  const left = [
    ...(certificates ? ["the app's origin certificate and Authenticated Origin Pulls"] : []),
    ...(denied.some((p) => p !== SSL_PERMISSION) ? ["the zone's minimum TLS version"] : []),
  ];
  const keeps = certificates
    ? " The app keeps today's protection: only Cloudflare's addresses reach the server."
    : "";
  return {
    code: "tls-permission-missing",
    message: `The Cloudflare token lacks ${listText(denied)} for this zone (HTTP 403), so this plan leaves out ${listText(left)}.${keeps}`,
    hint: `Edit the token at ${CLOUDFLARE_TOKEN_PAGE} and give it ${listText(denied)} for this zone, then run the command again.`,
  };
}

/** Advice to raise the zone's minimum TLS version, with why OpsCrew does not. */
function minTlsAdvised(value: string, editable: boolean, others: readonly string[]): Advice {
  const named =
    others.length > NAMED_OTHERS
      ? `${others.slice(0, NAMED_OTHERS).join(", ")} and ${others.length - NAMED_OTHERS} more`
      : listText(others);
  const reasons = [
    ...(value === "1.0" ? [] : [`it was set to ${value} outside OpsCrew`]),
    ...(editable ? [] : ["Cloudflare does not let it be changed for this zone"]),
    ...(others.length > 0
      ? [`the zone has proxied hostnames that are not OpsCrew's: ${named}`]
      : []),
  ];
  return {
    code: "min-tls-advised",
    message: `The zone's minimum TLS version is ${value}, so visitors can still connect with TLS ${value === "1.0" ? "1.0 and 1.1" : value}. OpsCrew leaves it as it is because ${listText(reasons)}.`,
    hint: "Once every site in the zone works with TLS 1.2, raise it in the Cloudflare dashboard: SSL/TLS → Edge Certificates → Minimum TLS Version.",
  };
}

// --- Apply ---------------------------------------------------------------------------------------

/**
 * Applies an approved plan, in its order (origin TLS and the zone's minimum TLS first, then 011's
 * rules, then Zero Trust): throws OpsCrewError PLAN_HASH_MISMATCH when `approvedHash` differs or
 * the CSR or client certificate given is not the plan's, PHASE_PRECONDITION when the plan has
 * findings or OpsCrew's rule changed since the plan (nothing written), and SharedApplyError
 * {applied, record} when a change fails part-way. Every phase the plan changes is read again
 * before the first write and before each write; every write is sent once and checked against the
 * ruleset Cloudflare returns. Before a client certificate is turned on, the certificate is waited
 * for until Cloudflare reports it active, and then each hostname's setting (each wait at most 5
 * minutes); the record is updated after each change.
 */
export async function applyShared(
  client: CloudflareClient,
  plan: SharedPlan,
  opts: {
    approvedHash: string;
    /** The client certificate and its key `upload-client-certificate` sends; never in the plan. */
    keys?: { clientCertificate: string; clientKey: string };
    /** The CSR (PEM) `create-origin-certificate` sends: the plan's `csr`. */
    csr?: string;
    /** Times the wait for active and `setAt`. Default: this computer's clock. */
    clock?: Clock;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<SharedApplyResult> {
  if (!isPlanHash(opts.approvedHash) || opts.approvedHash.toLowerCase() !== sharedPlanHash(plan)) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This Cloudflare plan is not the one that was approved, so OpsCrew changes nothing in Cloudflare.",
      { hint: "Look at the current Cloudflare plan and approve it by its hash." },
    );
  }
  if (plan.findings.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew cannot change the shared Cloudflare rules yet: ${plan.findings.map((f) => f.message).join(" ")}`,
      { hint: plan.findings.map((f) => f.hint).join(" ") },
    );
  }
  checkGiven(plan, opts);
  const ruleChanges = plan.changes.filter((c): c is RuleChange => "phase" in c);
  for (const phase of new Set(ruleChanges.map((c) => c.phase))) {
    const first = ruleChanges.find((c) => c.phase === phase) as RuleChange;
    const reason = staleReason(plan, first, await readPhase(client, plan.zoneId, phase));
    if (reason) throw staleError(phase, reason, "OpsCrew changed nothing.");
  }

  const given = { ...opts, clock: opts.clock ?? systemClock, sleep: opts.sleep ?? realSleep };
  const state: TlsState = {
    tls: structuredClone(plan.record.tls ?? {}),
    zoneSettings: structuredClone(plan.record.zoneSettings),
  };
  const done: SharedChange[] = [];
  let sent: SharedChange | undefined;
  let organization = plan.organization;
  let oneTimePinId = plan.oneTimePinId;
  for (const change of plan.changes) {
    try {
      if (change.kind === "create-organization") {
        sent = change;
        organization = await client.createAccessOrganization(plan.accountId, change.authDomain);
      } else if (change.kind === "create-identity-provider") {
        sent = change;
        oneTimePinId = await client.createOneTimePinProvider(plan.accountId);
      } else if ("phase" in change) {
        const reason = staleReason(
          plan,
          change,
          await readPhase(client, plan.zoneId, change.phase),
        );
        if (reason) throw staleError(change.phase, reason, "OpsCrew stopped before changing them.");
        sent = change;
        await writeRule(client, plan, change);
      } else {
        await applyTlsChange(client, plan.zoneId, change, state, given);
      }
      done.push(change);
      sent = undefined;
    } catch (error) {
      const unclear =
        sent && "phase" in sent && sent.kind !== "delete-entrypoint" ? sent : undefined;
      const held = unclear ? await heldHostnames(client, plan.zoneId, unclear.phase) : undefined;
      const record = withTls(recordAfter(plan, done, unclear, held), state);
      const applied = done.map(changeId);
      if (error instanceof OpsCrewError) {
        throw new SharedApplyError(
          error.code,
          error.message,
          { ...(error.hint === undefined ? {} : { hint: error.hint }), cause: error },
          applied,
          record,
          state.originCertificate,
        );
      }
      throw new SharedApplyError(
        "INTERNAL",
        "OpsCrew stopped on an error it did not expect while changing the shared Cloudflare rules.",
        { hint: "Run the command again to see the current state.", cause: error },
        applied,
        record,
        state.originCertificate,
      );
    }
  }
  return {
    applied: done.map(changeId),
    record: withTls(plan.record, state),
    ...(organization ? { organization } : {}),
    ...(oneTimePinId ? { oneTimePinId } : {}),
    ...(state.originCertificate ? { originCertificate: state.originCertificate } : {}),
  };
}

/** The app's origin TLS and zone settings as the apply changes them. */
interface TlsState {
  tls: TlsRecord;
  zoneSettings: SharedRecord["zoneSettings"];
  /** The origin certificate (PEM) this apply created. */
  originCertificate?: string;
}

/** `record` with `state`'s origin TLS (left out when empty) and zone settings. */
function withTls(
  record: SharedRecord,
  state: { tls: TlsRecord | undefined; zoneSettings: SharedRecord["zoneSettings"] },
): SharedRecord {
  const { tls: _tls, zoneSettings: _zoneSettings, ...rest } = record;
  const { tls, zoneSettings } = state;
  return {
    ...rest,
    ...(tls && (tls.origin || tls.client || tls.gap) ? { tls } : {}),
    ...(zoneSettings ? { zoneSettings } : {}),
  };
}

/** Throws unless the apply was given the CSR and the client certificate the approved plan sends. */
function checkGiven(
  plan: SharedPlan,
  given: { keys?: { clientCertificate: string }; csr?: string },
): void {
  const refuse = (what: string) =>
    new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `The ${what} given to the apply is not the one in the approved Cloudflare plan, so OpsCrew changes nothing in Cloudflare.`,
      { hint: "Look at the current Cloudflare plan and approve it by its hash." },
    );
  for (const change of plan.changes) {
    if (
      change.kind === "create-origin-certificate" &&
      (given.csr === undefined || sha256Hex(given.csr) !== change.csrSha256)
    ) {
      throw refuse("certificate request");
    }
    if (
      change.kind === "upload-client-certificate" &&
      (given.keys === undefined ||
        fingerprintSha256(given.keys.clientCertificate) !== change.sha256)
    ) {
      throw refuse("client certificate");
    }
  }
}

/**
 * Makes one origin TLS or zone setting change and records it in `state`. A setting is turned on
 * once its client certificate is active, recorded before it is sent (it may reach Cloudflare even
 * when the answer does not), then waited for until active; the others are recorded once
 * Cloudflare carried them out.
 */
async function applyTlsChange(
  client: CloudflareClient,
  zoneId: string,
  change: TlsChange,
  state: TlsState,
  given: {
    keys?: { clientCertificate: string; clientKey: string };
    csr?: string;
    clock: Clock;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const { tls } = state;
  switch (change.kind) {
    case "upload-client-certificate": {
      const keys = given.keys as NonNullable<typeof given.keys>;
      const uploaded = await client.uploadHostnameClientCertificate(zoneId, {
        certificate: keys.clientCertificate,
        privateKey: keys.clientKey,
      });
      tls.client = {
        id: uploaded.id,
        expiresAt: uploaded.expiresOn,
        sha256: change.sha256,
        enabled: [],
        retiring: [],
      };
      return;
    }
    case "enable-client-certificate": {
      const current = clientOf(tls);
      // The certificate the hash covers, not just any the record names.
      if (current.sha256 !== change.sha256) {
        throw new OpsCrewError(
          "PLAN_HASH_MISMATCH",
          "The client certificate this app's record names is not the one the approved Cloudflare plan turns on, so OpsCrew stopped before turning it on.",
          { hint: "Run the command again to make a new plan, and approve that one." },
        );
      }
      // The certificate itself first: an upload answers `pending_deployment` (spike T1402).
      await untilActive(
        given,
        () => client.listHostnameClientCertificates(zoneId),
        (certificates) => certificates.some((c) => c.id === current.id && c.status === "active"),
        () => "deploying the app's client certificate",
      );
      await checkNotTaken(client, zoneId, change.hostnames, current.id);
      current.enabled = sortedUnique([...current.enabled, ...change.hostnames]);
      current.retiring = current.retiring.filter((h) => !change.hostnames.includes(h));
      await client.putHostnameAopSettings(
        zoneId,
        change.hostnames.map((hostname) => ({ hostname, certId: current.id, enabled: true })),
      );
      await untilActive(
        given,
        () => client.listHostnameAopSettings(zoneId, change.hostnames),
        (settings) => change.hostnames.every((h) => isOn(settings, h, current.id)),
        (settings) =>
          `turning on the client certificate for ${listText(change.hostnames.filter((h) => !isOn(settings, h, current.id)))}`,
      );
      return;
    }
    case "create-origin-certificate": {
      const created = await client.createOriginCertificate({
        csr: given.csr as string,
        hostnames: change.hostnames,
        days: ORIGIN_CERTIFICATE_DAYS,
      });
      state.originCertificate = created.certificate;
      tls.origin = {
        id: created.id,
        hostnames: change.hostnames,
        expiresAt: created.expiresOn,
        sha256: fingerprintSha256(created.certificate),
        superseded: tls.origin ? [...tls.origin.superseded, tls.origin.id] : [],
      };
      return;
    }
    case "disable-client-certificate": {
      const current = clientOf(tls);
      await checkNotTaken(client, zoneId, change.hostnames, current.id);
      await client.putHostnameAopSettings(
        zoneId,
        change.hostnames.map((hostname) => ({ hostname, certId: current.id, enabled: null })),
      );
      current.enabled = current.enabled.filter((h) => !change.hostnames.includes(h));
      current.retiring = current.retiring.filter((h) => !change.hostnames.includes(h));
      return;
    }
    case "delete-client-certificate": {
      await client.deleteHostnameClientCertificate(zoneId, change.id);
      const { client: _deleted, ...rest } = tls;
      state.tls = rest;
      return;
    }
    case "revoke-origin-certificate": {
      await client.revokeOriginCertificate(change.id);
      const { origin, ...rest } = tls;
      if (origin?.id === change.id) state.tls = rest;
      else if (origin) origin.superseded = origin.superseded.filter((id) => id !== change.id);
      return;
    }
    case "set-min-tls": {
      const { value } = await client.getZoneSetting(zoneId, "min_tls_version");
      if (value !== change.from) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `The zone's minimum TLS version is ${value} now, not the ${change.from} this Cloudflare plan raises, so OpsCrew leaves it as it is.`,
          { hint: "Run the command again to make a new plan from the zone's current settings." },
        );
      }
      await client.patchZoneSetting(zoneId, "min_tls_version", change.to);
      state.zoneSettings = {
        ...state.zoneSettings,
        minTlsVersion: { setAt: given.clock.now().toISOString(), previous: change.from },
      };
      return;
    }
  }
}

/**
 * Reads the hostnames' origin pull settings again right before a write to them, and stops
 * (PHASE_PRECONDITION, nothing written) when another client certificate holds one of them now.
 */
async function checkNotTaken(
  client: CloudflareClient,
  zoneId: string,
  hostnames: readonly string[],
  certId: string,
): Promise<void> {
  const settings = await client.listHostnameAopSettings(zoneId, hostnames);
  const taken = hostnames.filter((h) => {
    const holder = heldBy(settings, h);
    return holder !== undefined && holder !== certId;
  });
  if (taken.length === 0) return;
  const one = taken.length === 1;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${listText(taken)} ${one ? "is" : "are"} held by another client certificate at Cloudflare now: another OpsCrew app turned on Authenticated Origin Pulls for ${one ? "it" : "them"} after this Cloudflare plan was made. OpsCrew stopped before changing ${one ? "it" : "them"}.`,
    {
      hint: "Run the command again to make a new plan from the current settings, and approve that one.",
    },
  );
}

/** The client certificate `tls` records; the plan only turns it on or off when there is one. */
function clientOf(tls: TlsRecord): ClientRecord {
  if (tls.client) return tls.client;
  throw new OpsCrewError(
    "INTERNAL",
    "OpsCrew lost track of the app's client certificate while changing Cloudflare.",
    {
      hint: "Run the command again to see the current state; if this repeats, report it to OpsCrew.",
    },
  );
}

/**
 * Reads until `finished` says Cloudflare is done; after 5 minutes, stops with the plain
 * still-deploying error for what `pending` names ("Cloudflare is still …").
 */
function untilActive<T>(
  given: { clock: Clock; sleep: (ms: number) => Promise<void> },
  read: () => Promise<T>,
  finished: (state: T) => boolean,
  pending: (state: T) => string,
): Promise<T> {
  return pollAction({
    read,
    finished,
    timedOut: (state) =>
      new OpsCrewError(
        "PROVIDER_ERROR",
        `Cloudflare is still ${pending(state)}: it was not active after ${durationText(ACTIVE_WAIT_MS)}. The server does not require it yet, so no request fails.`,
        {
          hint: "Run `opscrew provision` again in a few minutes: OpsCrew continues from where it stopped.",
        },
      ),
    timeoutMs: ACTIVE_WAIT_MS,
    intervalMs: ACTIVE_POLL_MS,
    sleep: given.sleep,
    now: () => given.clock.now().getTime(),
  });
}

function changeId(change: SharedChange): string {
  return "phase" in change ? `${change.kind} ${change.phase}` : change.kind;
}

function refOf(phase: SharedPhase): SharedRuleRef {
  return REFS.find((ref) => SHARED_RULES[ref].phase === phase) as SharedRuleRef;
}

/** The phase's entrypoint, read again; a refused read stops with the permission to add. */
async function readPhase(
  client: CloudflareClient,
  zoneId: string,
  phase: SharedPhase,
): Promise<EntrypointRuleset | undefined> {
  const read = await client.entrypointRuleset(zoneId, phase);
  if (read !== "forbidden") return read;
  const finding = permissionMissing(refOf(phase));
  throw new OpsCrewError("CREDENTIALS_INVALID", finding.message, { hint: finding.hint });
}

/** Why the phase no longer is what the plan expected before `change` (undefined: it is). */
function staleReason(
  plan: SharedPlan,
  change: RuleChange,
  current: EntrypointRuleset | undefined,
): string | undefined {
  if (change.kind === "create-entrypoint") {
    return current ? "the zone has a ruleset for them now" : undefined;
  }
  if (!current || current.id !== change.rulesetId) return "their ruleset was deleted or replaced";
  if (change.kind === "delete-entrypoint") {
    return current.rules.length > 0 ? "their ruleset holds a rule again" : undefined;
  }
  const ref = refOf(change.phase);
  const rule = ownRule(ref, current);
  if (change.kind === "add-rule") return rule ? "OpsCrew's rule was added since" : undefined;
  const expected = plan.expect[change.phase];
  if (!rule || !expected || rule.id !== expected.id) {
    return "OpsCrew's rule was deleted or replaced";
  }
  if (ruleDifferences(ref, rule).length > 0) {
    return "OpsCrew's rule was changed beyond its hostnames";
  }
  if (!sameList(hostnamesOf(ref, rule) ?? [], expected.hostnames)) {
    return "another OpsCrew app added or removed hostnames in OpsCrew's rule";
  }
  const deletesRuleset = plan.changes.some(
    (c) => c.kind === "delete-entrypoint" && c.phase === change.phase,
  );
  if (deletesRuleset && current.rules.length > 1) return "their ruleset holds another rule now";
  return undefined;
}

function staleError(phase: SharedPhase, reason: string, outcome: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The zone's ${TEMPLATES[refOf(phase)].label} changed after this Cloudflare plan was made: ${reason}. ${outcome}`,
    {
      hint: "Run the command again to make a new plan from the current rules, and approve that one.",
    },
  );
}

/** Sends one rule change and checks the ruleset Cloudflare returns. */
async function writeRule(
  client: CloudflareClient,
  plan: SharedPlan,
  change: RuleChange,
): Promise<void> {
  const ref = refOf(change.phase);
  switch (change.kind) {
    case "delete-entrypoint":
      await client.deleteRuleset(plan.zoneId, change.rulesetId);
      return;
    case "delete-rule": {
      const after = await client.deleteRulesetRule(plan.zoneId, change.rulesetId, change.ruleId);
      if (after.id !== change.rulesetId || ownRule(ref, after)) {
        throw notShown(ref, "still lists OpsCrew's rule");
      }
      return;
    }
    case "create-entrypoint":
      return checkWritten(
        ref,
        change.rule,
        await client.createEntrypointRuleset(plan.zoneId, change.phase, change.rule),
      );
    case "add-rule":
      return checkWritten(
        ref,
        change.rule,
        await client.addRulesetRule(plan.zoneId, change.rulesetId, change.rule),
        change.rulesetId,
      );
    case "update-hostnames": {
      const before = plan.expect[change.phase]?.hostnames ?? [];
      const next = [...before, ...change.add].filter((h) => !change.remove.includes(h)).sort();
      const body = ruleBody(ref, next);
      return checkWritten(
        ref,
        body,
        await client.updateRulesetRule(plan.zoneId, change.rulesetId, change.ruleId, body),
        change.rulesetId,
      );
    }
  }
}

/** Throws unless `after` holds OpsCrew's rule exactly as `body` wrote it. */
function checkWritten(
  ref: SharedRuleRef,
  body: CloudflareRuleInput,
  after: EntrypointRuleset,
  rulesetId?: string,
): void {
  const rule = ownRule(ref, after);
  if (rulesetId !== undefined && after.id !== rulesetId) throw notShown(ref, "is another ruleset");
  if (!rule || rule.expression !== body.expression || ruleDifferences(ref, rule).length > 0) {
    throw notShown(ref, "does not hold OpsCrew's rule as it was sent");
  }
}

function notShown(ref: SharedRuleRef, what: string): OpsCrewError {
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `Cloudflare accepted the change to OpsCrew's rule "${TEMPLATES[ref].description}", but the ruleset it returned ${what}.`,
    {
      hint: "Run the command again to see the current state; if this repeats, report it to OpsCrew.",
    },
  );
}

/**
 * The hostnames OpsCrew's rule in `phase` holds now (none when the phase has no OpsCrew rule), read
 * after a write that failed and may have reached Cloudflare; undefined when that cannot be told.
 */
async function heldHostnames(
  client: CloudflareClient,
  zoneId: string,
  phase: SharedPhase,
): Promise<string[] | undefined> {
  try {
    const current = await client.entrypointRuleset(zoneId, phase);
    if (current === "forbidden") return undefined;
    const ref = refOf(phase);
    const rule = ownRule(ref, current);
    return rule ? hostnamesOf(ref, rule) : [];
  } catch {
    // The apply already stops on the write's error; without this read the record keeps both lists.
    return undefined;
  }
}

/**
 * The app's record after the changes in `done`: a phase whose change was made, or that had none,
 * has the plan's hostnames; the phase of the failed write `unclear` has those of both records
 * that OpsCrew's rule holds (`held`, read again), or all of them when it could not be read; any
 * other phase keeps the previous record's.
 */
function recordAfter(
  plan: SharedPlan,
  done: readonly SharedChange[],
  unclear: SharedChange | undefined,
  held: readonly string[] | undefined,
): SharedRecord {
  const hostnames: SharedRecord["hostnames"] = {};
  for (const ref of REFS) {
    const before = plan.previous?.hostnames[ref] ?? [];
    const after = plan.record.hostnames[ref] ?? [];
    const change = plan.changes.find(
      (c) => "phase" in c && c.phase === SHARED_RULES[ref].phase && c.kind !== "delete-entrypoint",
    );
    const either = [...new Set([...before, ...after])].sort();
    const list =
      !change || done.includes(change)
        ? after
        : change === unclear
          ? either.filter((h) => !held || held.includes(h))
          : before;
    if (list.length > 0) hostnames[ref] = list;
  }
  return { zoneId: plan.zoneId, hostnames, createdEntrypoints: createdAfter(plan.previous, done) };
}

/** The record's `createdEntrypoints` after `changes`: a deleted entrypoint leaves, a created one joins. */
function createdAfter(previous: SharedRecord | undefined, changes: readonly SharedChange[]) {
  const phases = (kind: SharedChange["kind"]) =>
    changes.flatMap((c): string[] => (c.kind === kind && "phase" in c ? [c.phase] : []));
  const deleted = phases("delete-entrypoint");
  return [
    ...(previous?.createdEntrypoints ?? []).filter((p) => !deleted.includes(p)),
    ...phases("create-entrypoint"),
  ];
}
