import { createHash } from "node:crypto";
import type { FakeReply } from "@opscrew/core/testing";
import type {
  FakeCloudflarePermission,
  FakeCloudflareZone,
  FakeDnsRecord,
  FakeRecordInput,
} from "./fake-accounts";
import type { FakeWorkerDomain } from "./fake-zone";
import { ok, only, paged, refuse } from "./replies";

/**
 * The account-scoped pieces of {@link fakeCloudflareAccounts}' accounts: tunnels, Zero Trust
 * Access, R2 buckets and Workers. OpsCrew makes most of them through the IaC engine, so a test
 * seeds them as plain data; the fake answers the reads OpsCrew's client and its permission probes
 * make, and the client's own writes (the Zero Trust organization and login method, a tunnel's
 * secret, custom domains). Any other request throws.
 */

/** A connection of a tunnel's connector, as Cloudflare lists it (it names the server's address). */
export interface FakeTunnelConnection {
  id: string;
  colo_name: string;
  opened_at: string;
  origin_ip: string;
  client_id?: string;
}

/** A Cloudflare Tunnel of the account. */
export interface FakeTunnel {
  id: string;
  name: string;
  /** Set once deleted: the tunnel is still read, with this time. */
  deleted_at?: string;
  /** Base64; part of the tunnel's token, so a secret (made from the id when not set). */
  secret?: string;
  /** Its connectors' connections: a test connects and disconnects them by changing this list. */
  connections: FakeTunnelConnection[];
}

/** An Access application or reusable policy, as a test seeds it. */
export type FakeAccessItem = Record<string, unknown> & { id: string; name: string };

/** An Access service token; its `client_secret` is never listed. */
export interface FakeServiceToken {
  id: string;
  name: string;
  client_id: string;
  client_secret: string;
  duration: string;
  created_at: string;
  expires_at: string;
}

/** An R2 bucket, as Cloudflare lists it. */
export interface FakeBucket {
  name: string;
  creation_date?: string;
  location?: string;
}

/** A Worker script of the account (uploaded by Wrangler or the IaC engine, so seeded here). */
export interface FakeScript {
  created_on?: string;
  /** Its `workers.dev` route (default off). */
  subdomain?: { enabled: boolean; previews_enabled: boolean };
}

/** A fake Cloudflare account and its account-scoped pieces, as plain data. */
export interface FakeCloudflareAccount {
  readonly id: string;
  readonly name: string;
  /** The Zero Trust organization (`undefined`: none yet). */
  organization: { name: string; auth_domain: string } | undefined;
  readonly identityProviders: { id: string; name: string; type: string }[];
  readonly accessApps: FakeAccessItem[];
  /** Reusable Access policies. */
  readonly accessPolicies: FakeAccessItem[];
  readonly serviceTokens: FakeServiceToken[];
  readonly tunnels: FakeTunnel[];
  readonly buckets: FakeBucket[];
  /** Worker scripts by name. */
  readonly workers: Map<string, FakeScript>;
  /** Workers custom domains: attaching one adds its record to the zone, detaching removes it. */
  readonly workerDomains: FakeWorkerDomain[];
}

/** An account with nothing in it. */
export function newAccount(id: string, name: string): FakeCloudflareAccount {
  return {
    id,
    name,
    organization: undefined,
    identityProviders: [],
    accessApps: [],
    accessPolicies: [],
    serviceTokens: [],
    tunnels: [],
    buckets: [],
    workers: new Map(),
    workerDomains: [],
  };
}

/** What the account's routes need from the fake. */
export interface PieceContext {
  account: FakeCloudflareAccount;
  /** The account's zones. */
  zones: FakeCloudflareZone[];
  /** Whether the call's token lacks `permission`. */
  denied: (permission: FakeCloudflarePermission) => boolean;
  hex: () => string;
  uuid: () => string;
  addRecord: (zone: FakeCloudflareZone, record: FakeRecordInput) => FakeDnsRecord;
}

const DENIED = refuse(403, 10000, "Authentication error");
const NO_WORKER = refuse(404, 10007, "This Worker does not exist on your account.");

/** The request the fake does not answer: a test's mistake, not Cloudflare's answer. */
function unanswered(ctx: PieceContext, method: string, path: string): never {
  throw new Error(`fake cloudflare: no route for ${method} /accounts/${ctx.account.id}${path}`);
}

type Route = (method: string, rest: string, url: URL, body: unknown) => FakeReply;

/** Answers `/accounts/{id}` + `rest` for the account. */
export function accountReply(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const routes: [string, FakeCloudflarePermission, Route][] = [
    ["/cfd_tunnel", "tunnel", (...a) => tunnels(ctx, ...a)],
    ["/access/apps", "access-apps", (m, r, u) => accessItems(ctx, ctx.account.accessApps, m, r, u)],
    [
      "/access/policies",
      "access-apps",
      (m, r, u) => accessItems(ctx, ctx.account.accessPolicies, m, r, u),
    ],
    ["/access/service_tokens", "access-service-tokens", (m, r, u) => serviceTokens(ctx, m, r, u)],
    ["/access/organizations", "access-organization", (...a) => organization(ctx, ...a)],
    ["/access/identity_providers", "access-organization", (...a) => identityProviders(ctx, ...a)],
    ["/r2/buckets", "r2", (m, r, u) => buckets(ctx, m, r, u)],
    ["/workers/scripts", "workers", (m, r, u) => scripts(ctx, m, r, u)],
    ["/workers/domains", "workers", (...a) => workerDomains(ctx, ...a)],
  ];
  for (const [prefix, permission, route] of routes) {
    if (rest !== prefix && !rest.startsWith(`${prefix}/`)) continue;
    if (ctx.denied(permission)) return DENIED;
    return route(method, rest.slice(prefix.length), url, body);
  }
  return unanswered(ctx, method, rest);
}

// --- Tunnels -------------------------------------------------------------------------------------

/** The tunnel as Cloudflare answers it: healthy while it has a connection, else inactive. */
function tunnelView(account: FakeCloudflareAccount, tunnel: FakeTunnel) {
  const live = tunnel.connections.length > 0;
  return {
    id: tunnel.id,
    account_tag: account.id,
    name: tunnel.name,
    deleted_at: tunnel.deleted_at ?? null,
    connections: tunnel.connections.map((c) => ({ is_pending_reconnect: false, ...c })),
    conns_active_at: live ? tunnel.connections[0]?.opened_at : null,
    conns_inactive_at: null,
    status: live ? "healthy" : "inactive",
    tun_type: "cfd_tunnel",
  };
}

/** The connector's token: the account, the tunnel and its secret, base64-encoded JSON. */
function tunnelToken(account: FakeCloudflareAccount, tunnel: FakeTunnel): string {
  const secret =
    tunnel.secret ?? createHash("sha256").update(`tunnel secret ${tunnel.id}`).digest("base64");
  return Buffer.from(JSON.stringify({ a: account.id, t: tunnel.id, s: secret })).toString("base64");
}

/** The list, a tunnel, its token, and the change of its secret (`rotateTunnelSecret`). */
function tunnels(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const { account } = ctx;
  if (rest === "" && method === "GET") {
    only(url, ["page", "per_page"]);
    return paged(
      account.tunnels.map((t) => tunnelView(account, t)),
      url,
      20,
    );
  }
  const match = /^\/([^/]+)(\/token)?$/.exec(rest);
  const answered = match && (match[2] ? method === "GET" : method === "GET" || method === "PATCH");
  if (!match || !answered) return unanswered(ctx, method, `/cfd_tunnel${rest}`);
  const tunnel = account.tunnels.find((t) => t.id === match[1]);
  // The words of this refusal are the fake's own.
  if (!tunnel) return refuse(404, 1003, "Tunnel not found");
  if (match[2]) return ok(tunnelToken(account, tunnel));
  if (method === "PATCH") {
    const sent = body as { tunnel_secret?: unknown };
    if (typeof sent.tunnel_secret === "string") tunnel.secret = sent.tunnel_secret;
  }
  return ok(tunnelView(account, tunnel));
}

// --- Zero Trust Access ---------------------------------------------------------------------------

/** Access applications or reusable policies: the list. */
function accessItems(
  ctx: PieceContext,
  items: FakeAccessItem[],
  method: string,
  rest: string,
  url: URL,
): FakeReply {
  if (rest !== "" || method !== "GET") return unanswered(ctx, method, `/access${rest}`);
  only(url, ["page", "per_page"]);
  return paged(items, url, 25);
}

/** The service tokens, listed without their secrets. */
function serviceTokens(ctx: PieceContext, method: string, rest: string, url: URL): FakeReply {
  if (rest !== "" || method !== "GET") {
    return unanswered(ctx, method, `/access/service_tokens${rest}`);
  }
  only(url, ["page", "per_page"]);
  return paged(
    ctx.account.serviceTokens.map(({ client_secret: _secret, ...token }) => token),
    url,
    25,
  );
}

/** The Zero Trust organization: read, and created when missing (as FakeZone answers it). */
function organization(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const { account } = ctx;
  if (rest === "" && method === "GET") {
    only(url, []);
    return account.organization
      ? ok(account.organization)
      : refuse(404, 12130, "access.api.error.not_found: organization not found");
  }
  if (rest !== "" || method !== "POST") {
    return unanswered(ctx, method, `/access/organizations${rest}`);
  }
  // The words of this refusal are the fake's own.
  if (account.organization) return refuse(400, 12000, "organization already exists");
  const sent = body as { name: string; auth_domain: string };
  account.organization = { name: sent.name, auth_domain: sent.auth_domain };
  return ok(account.organization);
}

/** The login methods: listed, and one added. */
function identityProviders(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const providers = ctx.account.identityProviders;
  if (rest === "" && method === "GET") {
    only(url, []);
    return ok(providers);
  }
  if (rest !== "" || method !== "POST") {
    return unanswered(ctx, method, `/access/identity_providers${rest}`);
  }
  const sent = body as { name: string; type: string };
  const provider = { id: ctx.uuid(), name: sent.name, type: sent.type };
  providers.push(provider);
  return ok({ ...provider, config: {} });
}

// --- R2 ------------------------------------------------------------------------------------------

/** The buckets, `per_page` at a time from `cursor`. */
function buckets(ctx: PieceContext, method: string, rest: string, url: URL): FakeReply {
  if (rest !== "" || method !== "GET") return unanswered(ctx, method, `/r2/buckets${rest}`);
  only(url, ["per_page", "cursor"]);
  const list = ctx.account.buckets;
  const from = Number(url.searchParams.get("cursor") || 0);
  const size = Number(url.searchParams.get("per_page") ?? 20);
  return {
    body: {
      success: true,
      errors: [],
      messages: [],
      result: { buckets: list.slice(from, from + size) },
      result_info: { cursor: from + size < list.length ? String(from + size) : "", per_page: size },
    },
  };
}

// --- Workers -------------------------------------------------------------------------------------

/** The scripts, and a script's `workers.dev` subdomain. */
function scripts(ctx: PieceContext, method: string, rest: string, url: URL): FakeReply {
  const { workers } = ctx.account;
  if (rest === "" && method === "GET") {
    only(url, []);
    return ok(
      [...workers].map(([id, s]) => ({ id, created_on: s.created_on, modified_on: s.created_on })),
    );
  }
  const match = /^\/([^/]+)\/subdomain$/.exec(rest);
  if (!match?.[1] || method !== "GET") {
    return unanswered(ctx, method, `/workers/scripts${rest}`);
  }
  const script = workers.get(decodeURIComponent(match[1]));
  if (!script) return NO_WORKER;
  return ok(script.subdomain ?? { enabled: false, previews_enabled: false });
}

const inZone = (hostname: string, zone: string) =>
  hostname === zone || hostname.endsWith(`.${zone}`);

/** A custom domain as Cloudflare lists it. */
const domainView = (d: FakeWorkerDomain) => ({
  ...d,
  environment: "production",
  cert_id: `cert-${d.id}`,
  previews_enabled: false,
  enabled: true,
});

/** The read-only record a custom domain keeps in its zone (`meta` as research R10.5 is to confirm). */
const workerRecord = (zone: FakeCloudflareZone, hostname: string) =>
  zone.records.find((r) => r.name === hostname && r.meta.read_only === true);

/** The custom domains: listed, attached, detached. */
function workerDomains(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const domains = ctx.account.workerDomains;
  if (rest === "" && method === "GET") {
    only(url, ["zone_id", "zone_name", "service", "hostname"]);
    const keep = (d: FakeWorkerDomain) =>
      (["zone_id", "zone_name", "service", "hostname"] as const).every(
        (key) => (url.searchParams.get(key) ?? d[key]) === d[key],
      );
    const listed = domains.filter(keep).map(domainView);
    // As Cloudflare answers this list: `errors` and `messages` are null, not empty arrays.
    return {
      body: {
        result: listed,
        success: true,
        errors: null,
        messages: null,
        result_info: {
          page: 1,
          per_page: listed.length,
          count: listed.length,
          total_count: listed.length,
        },
      },
    };
  }
  if (rest === "" && method === "PUT") return attachDomain(ctx, body);
  if (!/^\/[^/]+$/.test(rest) || method !== "DELETE") {
    return unanswered(ctx, method, `/workers/domains${rest}`);
  }
  const at = domains.findIndex((d) => `/${d.id}` === rest);
  const domain = domains[at];
  // The words of this refusal are the fake's own.
  if (!domain) return refuse(404, 100114, "No custom domain with this id.");
  domains.splice(at, 1);
  const zone = ctx.zones.find((z) => z.id === domain.zone_id);
  const record = zone && workerRecord(zone, domain.hostname);
  if (zone && record) zone.records.splice(zone.records.indexOf(record), 1);
  return ok(null);
}

/**
 * `PUT …/workers/domains`: the zone must be the account's and active (research R8), the Worker
 * the account's, and no other record may hold the hostname; the domain keeps a read-only record
 * in its zone. The same hostname attached again moves to the Worker named.
 */
function attachDomain(ctx: PieceContext, body: unknown): FakeReply {
  const sent = body as { hostname?: unknown; service?: unknown; zone_id?: unknown };
  const hostname = String(sent.hostname ?? "").toLowerCase();
  const service = String(sent.service ?? "");
  const zone =
    sent.zone_id === undefined
      ? ctx.zones
          .filter((z) => inZone(hostname, z.name))
          .sort((a, b) => b.name.length - a.name.length)[0]
      : ctx.zones.find((z) => z.id === sent.zone_id);
  // The codes and words of these two refusals are the fake's own.
  if (!zone || !inZone(hostname, zone.name)) {
    return refuse(400, 100119, `${hostname} is not in a zone of this account.`);
  }
  if (zone.status !== "active") {
    return refuse(
      400,
      100116,
      `${zone.name} is not active yet: a custom domain needs an active zone.`,
    );
  }
  if (!ctx.account.workers.has(service)) return NO_WORKER;
  if (zone.records.some((r) => r.name === hostname && r.meta.read_only !== true)) {
    return refuse(
      409,
      100117,
      `Hostname '${hostname}' already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option 'override_existing_dns_record' to override.`,
    );
  }
  const existing = ctx.account.workerDomains.find((d) => d.hostname === hostname);
  if (existing) {
    existing.service = service;
    const record = workerRecord(zone, hostname);
    if (record) record.meta = { ...record.meta, origin_worker_id: service };
    return ok(domainView(existing));
  }
  const domain: FakeWorkerDomain = {
    id: ctx.hex(),
    hostname,
    service,
    zone_id: zone.id,
    zone_name: zone.name,
  };
  ctx.account.workerDomains.push(domain);
  ctx.addRecord(zone, {
    type: "AAAA",
    name: hostname,
    content: "100::",
    proxied: true,
    meta: { read_only: true, origin_worker_id: service },
  });
  return ok(domainView(domain));
}
