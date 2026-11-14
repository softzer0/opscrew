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
 * usually seeds them as plain data; the fake answers the calls OpsCrew's client and its
 * permission probes make, and the API's own create and delete calls.
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
  created_at?: string;
  /** Set once deleted: the tunnel is still listed and read, with this time. */
  deleted_at?: string;
  config_src?: "cloudflare" | "local";
  /** Base64; part of the tunnel's token, so a secret (made from the id when not set). */
  secret?: string;
  /** The configuration last sent (a remotely managed tunnel's ingress). */
  config?: unknown;
  /** Its connectors' connections: a test connects and disconnects them by changing this list. */
  connections: FakeTunnelConnection[];
}

/** An Access application or policy: what was sent, with the fields Cloudflare adds. */
export type FakeAccessItem = Record<string, unknown> & { id: string; name: string };

/** An Access service token; its `client_secret` is answered only when it is created. */
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
  creation_date: string;
  location: string;
  storage_class: string;
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
  now: Date;
  hex: () => string;
  uuid: () => string;
  addRecord: (zone: FakeCloudflareZone, record: FakeRecordInput) => FakeDnsRecord;
}

const DENIED = refuse(403, 10000, "Authentication error");
const NO_WORKER = refuse(404, 10007, "This Worker does not exist on your account.");
const R2_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const sha256 = (text: string, encoding: "hex" | "base64") =>
  createHash("sha256").update(text).digest(encoding);

/** Answers `/accounts/{id}` + `rest` for the account (`rest` not empty). */
export function accountReply(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const area = (prefix: string, permission: FakeCloudflarePermission) =>
    rest === prefix || rest.startsWith(`${prefix}/`)
      ? { permission, rest: rest.slice(prefix.length) }
      : undefined;
  const routes: [
    ReturnType<typeof area>,
    (method: string, rest: string, url: URL, body: unknown) => FakeReply,
  ][] = [
    [area("/cfd_tunnel", "tunnel"), (...a) => tunnels(ctx, ...a)],
    [area("/access/apps", "access-apps"), (...a) => accessItems(ctx, ctx.account.accessApps, ...a)],
    [
      area("/access/policies", "access-apps"),
      (...a) => accessItems(ctx, ctx.account.accessPolicies, ...a),
    ],
    [area("/access/service_tokens", "access-service-tokens"), (...a) => serviceTokens(ctx, ...a)],
    [area("/access/organizations", "access-organization"), (...a) => organization(ctx, ...a)],
    [
      area("/access/identity_providers", "access-organization"),
      (...a) => identityProviders(ctx, ...a),
    ],
    [area("/r2/buckets", "r2"), (...a) => buckets(ctx, ...a)],
    [area("/workers/scripts", "workers"), (...a) => scripts(ctx, ...a)],
    [area("/workers/domains", "workers"), (...a) => workerDomains(ctx, ...a)],
  ];
  for (const [match, handle] of routes) {
    if (!match) continue;
    if (ctx.denied(match.permission)) return DENIED;
    return handle(method, match.rest, url, body);
  }
  throw new Error(`fake cloudflare: no route for ${method} /accounts/${ctx.account.id}${rest}`);
}

// --- Tunnels -------------------------------------------------------------------------------------

/** The tunnel as Cloudflare answers it: healthy while it has a connection, else inactive. */
function tunnelView(account: FakeCloudflareAccount, tunnel: FakeTunnel) {
  const live = tunnel.connections.length > 0;
  return {
    id: tunnel.id,
    account_tag: account.id,
    name: tunnel.name,
    created_at: tunnel.created_at ?? null,
    deleted_at: tunnel.deleted_at ?? null,
    connections: tunnel.connections.map((c) => ({ is_pending_reconnect: false, ...c })),
    conns_active_at: live ? tunnel.connections[0]?.opened_at : null,
    conns_inactive_at: null,
    status: live ? "healthy" : "inactive",
    tun_type: "cfd_tunnel",
    config_src: tunnel.config_src ?? "cloudflare",
    remote_config: (tunnel.config_src ?? "cloudflare") === "cloudflare",
    metadata: {},
  };
}

/** The connector's token: the account, the tunnel and its secret, base64-encoded JSON. */
function tunnelToken(account: FakeCloudflareAccount, tunnel: FakeTunnel): string {
  const secret = tunnel.secret ?? sha256(`tunnel secret ${tunnel.id}`, "base64");
  return Buffer.from(JSON.stringify({ a: account.id, t: tunnel.id, s: secret })).toString("base64");
}

function tunnels(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const { account } = ctx;
  if (rest === "" && method === "GET") {
    only(url, ["name", "is_deleted", "page", "per_page"]);
    const name = url.searchParams.get("name");
    const deleted = url.searchParams.get("is_deleted");
    const listed = account.tunnels.filter(
      (t) =>
        (name === null || t.name === name) &&
        (deleted === null || (deleted === "true") === (t.deleted_at !== undefined)),
    );
    return paged(
      listed.map((t) => tunnelView(account, t)),
      url,
      20,
    );
  }
  if (rest === "" && method === "POST") {
    const sent = body as { name?: unknown; config_src?: unknown; tunnel_secret?: unknown };
    if (typeof sent.name !== "string" || sent.name === "") {
      return refuse(400, 1003, "a tunnel needs a name");
    }
    if (account.tunnels.some((t) => t.name === sent.name && t.deleted_at === undefined)) {
      return refuse(409, 1013, "You already have a tunnel with this name.");
    }
    const tunnel: FakeTunnel = {
      id: ctx.uuid(),
      name: sent.name,
      created_at: ctx.now.toISOString(),
      config_src: sent.config_src === "local" ? "local" : "cloudflare",
      ...(typeof sent.tunnel_secret === "string" ? { secret: sent.tunnel_secret } : {}),
      connections: [],
    };
    account.tunnels.push(tunnel);
    return ok(tunnelView(account, tunnel));
  }
  const match = /^\/([^/]+)(\/token|\/configurations|\/connections)?$/.exec(rest);
  const tunnel = account.tunnels.find((t) => t.id === match?.[1]);
  if (!match || !tunnel) return refuse(404, 1003, "Tunnel not found");
  const view = () => ok(tunnelView(account, tunnel));
  switch (`${method} ${match[2] ?? ""}`) {
    case "GET ":
      return view();
    case "PATCH ": {
      const sent = body as { name?: unknown; tunnel_secret?: unknown };
      if (typeof sent.name === "string") tunnel.name = sent.name;
      if (typeof sent.tunnel_secret === "string") tunnel.secret = sent.tunnel_secret;
      return view();
    }
    case "DELETE ":
      if (tunnel.connections.length > 0 && url.searchParams.get("cascade") !== "true") {
        return refuse(
          400,
          1022,
          "Cannot delete tunnel because it has active connections. Use cascade to delete connections first.",
        );
      }
      tunnel.connections = [];
      tunnel.deleted_at = ctx.now.toISOString();
      return view();
    case "GET /token":
      return ok(tunnelToken(account, tunnel));
    case "GET /configurations":
    case "PUT /configurations": {
      if (method === "PUT") tunnel.config = (body as { config?: unknown }).config;
      return ok({
        tunnel_id: tunnel.id,
        account_id: account.id,
        config: tunnel.config ?? null,
        source: "cloudflare",
      });
    }
    case "GET /connections":
      return ok(
        tunnel.connections.map((c) => ({
          id: c.client_id ?? c.id,
          conns: [{ is_pending_reconnect: false, ...c }],
          run_at: c.opened_at,
        })),
      );
    default:
      throw new Error(`fake cloudflare: ${method} on the tunnel ${tunnel.id}${match[2] ?? ""}`);
  }
}

// --- Zero Trust Access ---------------------------------------------------------------------------

const ACCESS_NOT_FOUND = refuse(404, 12130, "access.api.error.not_found");

/** Access applications or reusable policies: list, create, read, replace, delete. */
function accessItems(
  ctx: PieceContext,
  items: FakeAccessItem[],
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const now = ctx.now.toISOString();
  const apps = items === ctx.account.accessApps;
  if (rest === "" && method === "GET") return paged(items, url, 25);
  if (rest === "" && method === "POST") {
    const item: FakeAccessItem = {
      ...(body as FakeAccessItem),
      id: ctx.uuid(),
      ...(apps ? { aud: `${ctx.hex()}${ctx.hex()}` } : { reusable: true }),
      created_at: now,
      updated_at: now,
    };
    items.push(item);
    return ok(item);
  }
  const at = items.findIndex((i) => `/${i.id}` === rest);
  const item = items[at];
  if (!item) return ACCESS_NOT_FOUND;
  if (method === "GET") return ok(item);
  if (method === "PUT") {
    const { id, created_at, aud, reusable } = item;
    items[at] = {
      ...(body as FakeAccessItem),
      id,
      ...(aud === undefined ? {} : { aud }),
      ...(reusable === undefined ? {} : { reusable }),
      created_at,
      updated_at: now,
    };
    return ok(items[at]);
  }
  if (method === "DELETE") {
    items.splice(at, 1);
    return ok({ id: item.id });
  }
  throw new Error(`fake cloudflare: ${method} on the Access item ${item.id}`);
}

function serviceTokens(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const tokens = ctx.account.serviceTokens;
  const listed = ({ client_secret: _secret, ...token }: FakeServiceToken) => token;
  if (rest === "" && method === "GET") return paged(tokens.map(listed), url, 25);
  if (rest === "" && method === "POST") {
    const sent = body as { name?: unknown; duration?: unknown };
    const id = ctx.uuid();
    const expires = new Date(ctx.now);
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
    const token: FakeServiceToken = {
      id,
      name: String(sent.name ?? ""),
      client_id: `${ctx.hex()}.access`,
      client_secret: sha256(`service token secret ${id}`, "hex"),
      duration: typeof sent.duration === "string" ? sent.duration : "8760h",
      created_at: ctx.now.toISOString(),
      expires_at: expires.toISOString(),
    };
    tokens.push(token);
    return ok(token);
  }
  const at = tokens.findIndex((t) => `/${t.id}` === rest);
  const token = tokens[at];
  if (!token) return ACCESS_NOT_FOUND;
  if (method === "GET") return ok(listed(token));
  if (method === "DELETE") {
    tokens.splice(at, 1);
    return ok(listed(token));
  }
  throw new Error(`fake cloudflare: ${method} on the service token ${token.id}`);
}

function organization(ctx: PieceContext, method: string, rest: string, _url: URL, body: unknown) {
  const { account } = ctx;
  if (rest !== "") throw new Error(`fake cloudflare: ${method} on the organization ${rest}`);
  if (method === "GET") {
    return account.organization
      ? ok(account.organization)
      : refuse(404, 12130, "access.api.error.not_found: organization not found");
  }
  if (method !== "POST") throw new Error(`fake cloudflare: ${method} on the organization`);
  if (account.organization) return refuse(400, 12000, "organization already exists");
  const sent = body as { name: string; auth_domain: string };
  account.organization = { name: sent.name, auth_domain: sent.auth_domain };
  return ok(account.organization);
}

function identityProviders(
  ctx: PieceContext,
  method: string,
  rest: string,
  _url: URL,
  body: unknown,
) {
  const providers = ctx.account.identityProviders;
  if (rest !== "") throw new Error(`fake cloudflare: ${method} on the login method ${rest}`);
  if (method === "GET") return ok(providers);
  if (method !== "POST") throw new Error(`fake cloudflare: ${method} on the login methods`);
  const sent = body as { name: string; type: string };
  const provider = { id: ctx.uuid(), name: sent.name, type: sent.type };
  providers.push(provider);
  return ok({ ...provider, config: {} });
}

// --- R2 ------------------------------------------------------------------------------------------

const NO_BUCKET = refuse(404, 10006, "The specified bucket does not exist.");

function buckets(
  ctx: PieceContext,
  method: string,
  rest: string,
  url: URL,
  body: unknown,
): FakeReply {
  const list = ctx.account.buckets;
  if (rest === "" && method === "GET") {
    only(url, ["name_contains", "per_page", "cursor"]);
    const part = url.searchParams.get("name_contains") ?? "";
    const matching = list.filter((b) => b.name.includes(part));
    const from = Number(url.searchParams.get("cursor") || 0);
    const size = Number(url.searchParams.get("per_page") ?? 20);
    const next = from + size < matching.length ? String(from + size) : "";
    return {
      body: {
        success: true,
        errors: [],
        messages: [],
        result: { buckets: matching.slice(from, from + size) },
        result_info: { cursor: next, per_page: size },
      },
    };
  }
  if (rest === "" && method === "POST") {
    const sent = body as { name?: unknown; locationHint?: unknown; storageClass?: unknown };
    const name = String(sent.name ?? "");
    if (!R2_NAME.test(name)) return refuse(400, 10005, "The specified bucket name is not valid.");
    if (list.some((b) => b.name === name)) {
      return refuse(409, 10004, "The bucket you tried to create already exists, and you own it.");
    }
    const bucket: FakeBucket = {
      name,
      creation_date: ctx.now.toISOString(),
      location: typeof sent.locationHint === "string" ? sent.locationHint.toUpperCase() : "WEUR",
      storage_class: typeof sent.storageClass === "string" ? sent.storageClass : "Standard",
    };
    list.push(bucket);
    return ok(bucket);
  }
  const at = list.findIndex((b) => `/${b.name}` === rest);
  const bucket = list[at];
  if (!bucket) return NO_BUCKET;
  if (method === "GET") return ok(bucket);
  if (method === "DELETE") {
    list.splice(at, 1);
    return ok({});
  }
  throw new Error(`fake cloudflare: ${method} on the bucket ${bucket.name}`);
}

// --- Workers -------------------------------------------------------------------------------------

function scripts(
  ctx: PieceContext,
  method: string,
  rest: string,
  _url: URL,
  body: unknown,
): FakeReply {
  const { workers } = ctx.account;
  if (rest === "" && method === "GET") {
    return ok(
      [...workers].map(([id, s]) => ({ id, created_on: s.created_on, modified_on: s.created_on })),
    );
  }
  const match = /^\/([^/]+)(\/subdomain)?$/.exec(rest);
  const name = decodeURIComponent(match?.[1] ?? "");
  const script = workers.get(name);
  if (!match || !script) return NO_WORKER;
  if (!match[2] && method === "DELETE") {
    workers.delete(name);
    return ok(null);
  }
  if (match[2] && method === "GET") {
    return ok(script.subdomain ?? { enabled: false, previews_enabled: false });
  }
  if (match[2] && method === "POST") {
    const sent = body as { enabled?: unknown; previews_enabled?: unknown };
    script.subdomain = {
      enabled: sent.enabled === true,
      previews_enabled: sent.previews_enabled === true,
    };
    return ok(script.subdomain);
  }
  throw new Error(`fake cloudflare: ${method} on the Worker ${name}${match[2] ?? ""}`);
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
  const at = domains.findIndex((d) => `/${d.id}` === rest);
  const domain = domains[at];
  // The words of this refusal are the fake's own.
  if (!domain) return refuse(404, 100114, "No custom domain with this id.");
  if (method === "GET") return ok(domainView(domain));
  if (method !== "DELETE") throw new Error(`fake cloudflare: ${method} on a custom domain`);
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
