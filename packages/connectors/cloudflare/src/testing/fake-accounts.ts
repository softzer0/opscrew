import { createHash } from "node:crypto";
import type { FetchLike } from "@opscrew/contracts";
import type { FakeReply } from "@opscrew/core/testing";
import { CLOUDFLARE_API, type ManagedRulesetPhase } from "../client";
import { accountReply, type FakeCloudflareAccount, newAccount } from "./fake-account-pieces";
import { FakeZone } from "./fake-zone";
import { answer, type FakeFault, ok, only, paged, refuse, takeFault } from "./replies";

/**
 * A fake Cloudflare with several accounts behind one `fetch`, each reached by its own token, for
 * moving an app between accounts (feature 028): a call with a token that does not reach the
 * account is refused as Cloudflare refuses it, and a permission can be withheld per token.
 *
 * - **Zones** are created (`POST /zones`, pending, with a nameserver pair of their own), listed
 *   with the `name`, `account.id` and `status` filters, read, deleted and held. A zone moves from
 *   pending to active ({@link FakeCloudflareAccounts.activate}, which marks an active zone of the
 *   same name in another account `moved`) or to moved ({@link FakeCloudflareAccounts.move}). The
 *   activation check is accepted once an hour, as on the Free plan (every 5 minutes on others).
 * - **Records** keep every field and Cloudflare's `meta` (a Workers custom domain's record is
 *   `read_only`); they are created one by one or in a batch transaction (200 a call on Free),
 *   with Cloudflare's refusals of an identical record and of a CNAME beside another record.
 * - **Rulesets, Origin CA certificates, client certificates with per-hostname AOP and the minimum
 *   TLS setting** are each zone's own {@link FakeZone} (`data`), as features 011 and 014 saw them.
 *   On a pending zone, client certificates and hostname settings stay `pending_deployment` until
 *   the zone is activated (research R10 is to confirm it).
 * - **Certificate packs:** the universal pack appears, active, when the zone is activated.
 * - **DNSSEC:** turned on it is pending, with its DS record, until a test makes it active.
 * - **Account pieces** (tunnels with their connections, Access applications, policies, service
 *   tokens, the organization and login methods, R2 buckets, Workers with their subdomain and
 *   custom domains by zone): see `fake-account-pieces.ts`.
 *
 * Every call is recorded (`calls`, without the token) for leak checks, and state is plain data
 * for seeding and assertions. A call the fake does not answer throws (the client sees a failed
 * request with that error as its cause).
 */

/**
 * A permission a token may lack: every call that needs it is refused (HTTP 403, "Authentication
 * error"). Zone ones: `zone` (adding and deleting zones, holds, the activation check), `dns`
 * (records and DNSSEC), `ssl` (Origin CA, client certificates and AOP, certificate packs),
 * `settings` (the zone's settings), and each rule phase. Account ones: `tunnel`, `access-apps`
 * (applications and policies), `access-service-tokens`, `access-organization` (the organization
 * and login methods), `r2`, `workers`.
 */
export type FakeCloudflarePermission =
  | "zone"
  | "dns"
  | "ssl"
  | "settings"
  | ManagedRulesetPhase
  | "tunnel"
  | "access-apps"
  | "access-service-tokens"
  | "access-organization"
  | "r2"
  | "workers";

/** What a token reaches. */
export interface FakeCloudflareToken {
  /** The ids of the accounts it reaches. */
  readonly accounts: string[];
  readonly denied: Set<FakeCloudflarePermission>;
}

export type FakeZoneStatus = "pending" | "active" | "moved";

/** A DNS record as Cloudflare lists it (without the zone's id and name, added when listed). */
export interface FakeDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  data?: Record<string, unknown>;
  ttl: number;
  proxied: boolean;
  priority?: number;
  comment: string | null;
  tags: string[];
  settings: Record<string, unknown>;
  /** Cloudflare's own facts about the record: a Workers custom domain's is `read_only`. */
  meta: Record<string, unknown>;
  created_on: string;
  modified_on: string;
}

/** A record to add: a relative name or `@` is completed with the zone's name. */
export interface FakeRecordInput {
  type: string;
  name: string;
  content?: string;
  data?: Record<string, unknown>;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  comment?: string | null;
  tags?: string[];
  settings?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** An edge certificate pack of the zone. */
export interface FakeCertificatePack {
  id: string;
  type: string;
  hosts: string[];
  /** `active`, `initializing`, `pending_validation` and the like. */
  status: string;
}

/** A zone of one account. */
export interface FakeCloudflareZone {
  readonly id: string;
  readonly name: string;
  readonly accountId: string;
  status: FakeZoneStatus;
  nameServers: string[];
  readonly createdOn: string;
  activatedOn: string | null;
  hold: { hold: boolean; include_subdomains: boolean; hold_after?: string };
  dnssec: { status: "disabled" | "pending" | "active" };
  readonly records: FakeDnsRecord[];
  readonly certificatePacks: FakeCertificatePack[];
  /** When each accepted activation check was asked for (ISO times). */
  readonly activationChecks: string[];
  /**
   * The zone's rulesets, origin TLS (Origin CA certificates, client certificates, per-hostname
   * settings), minimum TLS setting and plan (`data.plan`), kept and answered by a FakeZone of its
   * own. Its account-level fields (Workers, Access) are not used: the accounts hold those.
   */
  readonly data: FakeZone;
}

/** A request the fake received. */
export interface FakeCloudflareCall {
  method: string;
  /** Path and query, after `/client/v4`. */
  path: string;
  body: unknown;
  /** The account whose zone or pieces the call names (absent for lists across accounts). */
  accountId?: string;
  /** The HTTP status answered (absent: a lost connection or a timeout). */
  status?: number;
}

export interface FakeCloudflareAccountsOptions {
  /** Each account and the token that reaches it (a token given twice reaches both). */
  accounts: {
    name: string;
    /** 32 hex characters (default: made by the fake). */
    id?: string;
    token: string;
    denied?: FakeCloudflarePermission[];
  }[];
  /** Zones at the start, by name and account (name or id); active unless said. */
  zones?: { name: string; account: string; status?: FakeZoneStatus }[];
  /** The fake's clock (default 2026-11-20T10:00:00Z); change `now` to move it. */
  now?: Date;
}

/** Record types Cloudflare can proxy. */
const PROXIABLE = new Set(["A", "AAAA", "CNAME"]);
/** Names for the nameserver pairs the fake hands out. */
const NAMESERVERS = ["ada", "bob", "cruz", "dana", "eli", "faye", "gus", "hana", "ivy", "jay"];
/** Changes one batch call may make: on the Free plan, and on paid ones. */
const BATCH_LIMITS = { free: 200, paid: 3500 };

const DENIED = refuse(403, 10000, "Authentication error");
const UNAUTHORIZED = refuse(403, 9109, "Unauthorized to access requested resource");
const noRoute = (route: string) =>
  refuse(404, 7003, `Could not route to ${route}, perhaps your object identifier is invalid?`);

/** A fake Cloudflare with several accounts; send each account's `CloudflareClient` to `fetch`. */
export function fakeCloudflareAccounts(
  options: FakeCloudflareAccountsOptions,
): FakeCloudflareAccounts {
  return new FakeCloudflareAccounts(options);
}

class FakeCloudflareAccounts {
  readonly accounts: FakeCloudflareAccount[] = [];
  /** Every zone of every account (a deleted zone is gone from the list). */
  readonly zones: FakeCloudflareZone[] = [];
  /** By token value. */
  readonly tokens = new Map<string, FakeCloudflareToken>();
  /** Pairs for the zones created next, in order; once empty, each gets a pair of its own. */
  readonly nameServerPairs: string[][] = [];
  readonly calls: FakeCloudflareCall[] = [];
  readonly faults: FakeFault[] = [];
  now: Date;
  #ids = 0;
  #pairs = 0;

  constructor(options: FakeCloudflareAccountsOptions) {
    this.now = options.now ?? new Date("2026-11-20T10:00:00Z");
    for (const input of options.accounts) {
      const account = newAccount(input.id ?? this.#hex(), input.name);
      this.accounts.push(account);
      const reach = this.tokens.get(input.token) ?? { accounts: [], denied: new Set() };
      reach.accounts.push(account.id);
      for (const permission of input.denied ?? []) reach.denied.add(permission);
      this.tokens.set(input.token, reach);
    }
    for (const zone of options.zones ?? []) {
      this.#addZone(zone.name, this.account(zone.account).id, zone.status ?? "active");
    }
  }

  /** The account with this name or id. */
  account(nameOrId: string): FakeCloudflareAccount {
    const account = this.accounts.find((a) => a.name === nameOrId || a.id === nameOrId);
    if (!account) throw new Error(`fake cloudflare: no account ${nameOrId}`);
    return account;
  }

  /** The zone named `name` in the account (name or id). */
  zone(name: string, account: string): FakeCloudflareZone {
    const accountId = this.account(account).id;
    const zone = this.zones.find((z) => z.name === name && z.accountId === accountId);
    if (!zone) throw new Error(`fake cloudflare: no zone ${name} in ${account}`);
    return zone;
  }

  /** Adds a record to the zone as Cloudflare would list it (no refusal checked). */
  addRecord(zone: FakeCloudflareZone, record: FakeRecordInput): FakeDnsRecord {
    const stored = this.#record(zone, record);
    zone.records.push(stored);
    return stored;
  }

  /**
   * Cloudflare saw the zone's nameservers: it is active, its universal certificate pack active,
   * its client certificates and hostname settings deployed (FakeZone's `pendingReads` 1 and
   * `certificatePendingReads` 0: set them after this for a slower deployment); an active zone of
   * the same name in another account is moved.
   */
  activate(zone: FakeCloudflareZone): void {
    for (const other of this.zones) {
      if (other !== zone && other.name === zone.name && other.status === "active") {
        other.status = "moved";
      }
    }
    zone.status = "active";
    zone.activatedOn = this.now.toISOString();
    zone.data.pendingReads = 1;
    zone.data.certificatePendingReads = 0;
    if (!zone.certificatePacks.some((p) => p.type === "universal")) {
      zone.certificatePacks.push(this.#universal(zone));
    }
  }

  /** The zone is active in another account now: Cloudflare shows it moved. */
  move(zone: FakeCloudflareZone): void {
    zone.status = "moved";
  }

  readonly fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = String(input).slice(CLOUDFLARE_API.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: FakeCloudflareCall = { method, path, body };
    this.calls.push(call);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const token = /^Bearer (.+)$/.exec(authorization)?.[1];
    const fault = takeFault(this.faults, method, path);
    let reply: FakeReply | FakeZone | undefined;
    if (!fault || fault.applied) reply = this.#handle(call, token);
    if (reply instanceof FakeZone) {
      reply.now = this.now;
      const response = await reply.fetch(input, init);
      if (!fault) {
        call.status = response.status;
        return response;
      }
    }
    const sent = fault?.reply ?? (reply as FakeReply);
    if (!sent.error && !sent.hang) call.status = sent.status ?? 200;
    return answer(sent, input, init);
  };

  #hex(): string {
    this.#ids++;
    return this.#ids.toString(16).padStart(32, "0");
  }

  #uuid(): string {
    this.#ids++;
    return `00000000-0000-4000-8000-${this.#ids.toString(16).padStart(12, "0")}`;
  }

  #pair(): string[] {
    const name = (k: number) =>
      `${NAMESERVERS[k % NAMESERVERS.length]}${k < NAMESERVERS.length ? "" : Math.floor(k / NAMESERVERS.length)}.ns.cloudflare.com`;
    const i = this.#pairs++;
    return [name(2 * i), name(2 * i + 1)];
  }

  #universal(zone: FakeCloudflareZone): FakeCertificatePack {
    return {
      id: this.#hex(),
      type: "universal",
      hosts: [zone.name, `*.${zone.name}`],
      status: "active",
    };
  }

  #addZone(name: string, accountId: string, status: FakeZoneStatus): FakeCloudflareZone {
    const id = this.#hex();
    const data = new FakeZone({ zoneId: id, ids: () => this.#hex() });
    if (status === "pending") {
      data.pendingReads = Number.POSITIVE_INFINITY;
      data.certificatePendingReads = Number.POSITIVE_INFINITY;
    }
    const now = this.now.toISOString();
    const zone: FakeCloudflareZone = {
      id,
      name,
      accountId,
      status,
      nameServers: this.nameServerPairs.shift() ?? this.#pair(),
      createdOn: now,
      activatedOn: status === "pending" ? null : now,
      hold: { hold: false, include_subdomains: false },
      dnssec: { status: "disabled" },
      records: [],
      certificatePacks: [],
      activationChecks: [],
      data,
    };
    if (status !== "pending") zone.certificatePacks.push(this.#universal(zone));
    this.zones.push(zone);
    return zone;
  }

  #record(zone: FakeCloudflareZone, input: FakeRecordInput): FakeDnsRecord {
    const raw = input.name.toLowerCase().replace(/\.$/, "");
    const name =
      raw === "@" || raw === zone.name
        ? zone.name
        : raw.endsWith(`.${zone.name}`)
          ? raw
          : `${raw}.${zone.name}`;
    const now = this.now.toISOString();
    return {
      id: this.#hex(),
      type: input.type.toUpperCase(),
      name,
      content: input.content ?? "",
      ...(input.data === undefined ? {} : { data: input.data }),
      ttl: input.ttl ?? 1,
      proxied: input.proxied ?? false,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      comment: input.comment ?? null,
      tags: input.tags ?? [],
      settings: input.settings ?? {},
      meta: input.meta ?? {},
      created_on: now,
      modified_on: now,
    };
  }

  /** The answer, or the zone whose FakeZone answers the request. */
  #handle(call: FakeCloudflareCall, token: string | undefined): FakeReply | FakeZone {
    const { method, body } = call;
    const url = new URL(call.path, "https://fake.invalid");
    const route = url.pathname;
    if (token === undefined) {
      return refuse(400, 9106, "Missing X-Auth-Key, X-Auth-Email or Authorization headers");
    }
    const reach = this.tokens.get(token);
    if (!reach) return refuse(401, 1000, "Invalid API Token");
    const reaches = (accountId: string) => reach.accounts.includes(accountId);
    if (route === "/user/tokens/verify" && method === "GET") {
      const id = createHash("sha256").update(token).digest("hex").slice(0, 32);
      return ok({ id, status: "active" });
    }
    if (route === "/accounts" && method === "GET") {
      only(url, ["page", "per_page"]);
      const listed = this.accounts.filter((a) => reaches(a.id));
      return paged(
        listed.map((a) => ({ id: a.id, name: a.name, type: "standard" })),
        url,
        20,
      );
    }
    if (route === "/zones" && method === "GET") return this.#listZones(reach, url);
    if (route === "/zones" && method === "POST") return this.#createZone(reach, call);
    const zonePath = /^\/zones\/([^/]+)(\/.*)?$/.exec(route);
    if (zonePath) {
      const zone = this.zones.find((z) => z.id === zonePath[1]);
      if (!zone) return noRoute(route);
      call.accountId = zone.accountId;
      if (!reaches(zone.accountId)) return UNAUTHORIZED;
      return this.#zoneReply(zone, reach, method, zonePath[2] ?? "", url, body);
    }
    if (route === "/certificates" || route.startsWith("/certificates/")) {
      return this.#originCa(reach, call, route, url);
    }
    const accountPath = /^\/accounts\/([^/]+)(\/.*)?$/.exec(route);
    if (accountPath?.[1]) {
      call.accountId = accountPath[1];
      const account = this.accounts.find((a) => a.id === accountPath[1]);
      // As feature 016's spike saw a Workers call for another account answered.
      if (!account || !reaches(account.id)) {
        return refuse(
          404,
          7003,
          "Could not route to the path, perhaps your object identifier is invalid?",
        );
      }
      const rest = accountPath[2] ?? "";
      if (rest === "" && method === "GET") {
        return ok({ id: account.id, name: account.name, type: "standard" });
      }
      return accountReply(
        {
          account,
          zones: this.zones.filter((z) => z.accountId === account.id),
          denied: (permission) => reach.denied.has(permission),
          now: this.now,
          hex: () => this.#hex(),
          uuid: () => this.#uuid(),
          addRecord: (zone, record) => this.addRecord(zone, record),
        },
        method,
        rest,
        url,
        body,
      );
    }
    throw new Error(`fake cloudflare: no route for ${method} ${call.path}`);
  }

  /** The zone as Cloudflare answers it. */
  #details(zone: FakeCloudflareZone) {
    const account = this.account(zone.accountId);
    return {
      id: zone.id,
      name: zone.name,
      status: zone.status,
      paused: false,
      type: "full",
      development_mode: 0,
      name_servers: [...zone.nameServers],
      account: { id: account.id, name: account.name },
      ...(zone.data.plan ? { plan: { id: "0".repeat(32), legacy_id: zone.data.plan } } : {}),
      created_on: zone.createdOn,
      modified_on: zone.activatedOn ?? zone.createdOn,
      activated_on: zone.activatedOn,
    };
  }

  #listZones(reach: FakeCloudflareToken, url: URL): FakeReply {
    only(url, ["name", "account.id", "status", "page", "per_page"]);
    const filter = (key: string, value: string) => {
      const wanted = url.searchParams.get(key);
      return wanted === null || wanted === value;
    };
    const listed = this.zones.filter(
      (z) =>
        reach.accounts.includes(z.accountId) &&
        filter("name", z.name) &&
        filter("account.id", z.accountId) &&
        filter("status", z.status),
    );
    return paged(
      listed.map((z) => this.#details(z)),
      url,
      20,
    );
  }

  #createZone(reach: FakeCloudflareToken, call: FakeCloudflareCall): FakeReply {
    const sent = call.body as { name?: unknown; account?: { id?: unknown } };
    const accountId = String(sent.account?.id ?? "");
    const name = String(sent.name ?? "").toLowerCase();
    call.accountId = accountId;
    if (!reach.accounts.includes(accountId)) return UNAUTHORIZED;
    if (reach.denied.has("zone")) return DENIED;
    if (this.zones.some((z) => z.accountId === accountId && z.name === name)) {
      return refuse(400, 1061, `${name} already exists`);
    }
    if (this.zones.some((z) => z.name === name && z.hold.hold)) {
      // The code and words are the fake's own: a zone hold blocks adding the zone elsewhere.
      return refuse(400, 1117, `${name} is on hold in another account and cannot be added.`);
    }
    return ok(this.#details(this.#addZone(name, accountId, "pending")));
  }

  #zoneReply(
    zone: FakeCloudflareZone,
    reach: FakeCloudflareToken,
    method: string,
    rest: string,
    url: URL,
    body: unknown,
  ): FakeReply | FakeZone {
    const lacks = (permission: string) => (reach.denied as ReadonlySet<string>).has(permission);
    if (rest === "" && method === "GET") return ok(this.#details(zone));
    if (rest === "" && method === "DELETE") {
      if (lacks("zone")) return DENIED;
      this.zones.splice(this.zones.indexOf(zone), 1);
      return ok({ id: zone.id });
    }
    if (rest === "/activation_check" && method === "PUT") {
      return lacks("zone") ? DENIED : this.#activationCheck(zone);
    }
    if (rest === "/hold") {
      if (method !== "GET" && lacks("zone")) return DENIED;
      if (method === "POST") {
        zone.hold = {
          hold: true,
          include_subdomains: url.searchParams.get("include_subdomains") === "true",
        };
      } else if (method === "DELETE") {
        zone.hold = { hold: false, include_subdomains: false };
      } else if (method !== "GET") {
        throw new Error(`fake cloudflare: ${method} on a zone hold`);
      }
      return ok({ ...zone.hold });
    }
    if (rest === "/dns_records" || rest.startsWith("/dns_records/")) {
      return lacks("dns") ? DENIED : this.#records(zone, method, rest.slice(12), url, body);
    }
    if (rest === "/dnssec") return lacks("dns") ? DENIED : this.#dnssec(zone, method, body);
    if (rest === "/ssl/certificate_packs" && method === "GET") {
      if (lacks("ssl")) return DENIED;
      only(url, ["status", "page", "per_page"]);
      const all = url.searchParams.get("status") === "all";
      const packs = zone.certificatePacks
        .filter((p) => all || p.status === "active")
        .map((p) => ({
          ...p,
          certificate_authority: "google",
          validation_method: "txt",
          validity_days: 90,
        }));
      return paged(packs, url, 20);
    }
    if (rest.startsWith("/rulesets/")) {
      const rulesetId = /^\/rulesets\/([0-9a-f]+)/.exec(rest)?.[1];
      const phase =
        /^\/rulesets\/phases\/([a-z_]+)\/entrypoint$/.exec(rest)?.[1] ??
        [...zone.data.entrypoints.values()].find((r) => r.id === rulesetId)?.phase;
      return phase !== undefined && lacks(phase) ? DENIED : zone.data;
    }
    if (rest.startsWith("/origin_tls_client_auth/")) return lacks("ssl") ? DENIED : zone.data;
    if (rest.startsWith("/settings/")) return lacks("settings") ? DENIED : zone.data;
    throw new Error(`fake cloudflare: no route for ${method} /zones/${zone.id}${rest}`);
  }

  /** Accepted once an hour on the Free plan (every 5 minutes on others), as Cloudflare limits it. */
  #activationCheck(zone: FakeCloudflareZone): FakeReply {
    const free = (zone.data.plan ?? "free") === "free";
    const last = zone.activationChecks.at(-1);
    if (last && this.now.getTime() - Date.parse(last) < (free ? 3600_000 : 300_000)) {
      return refuse(
        400,
        1224,
        `You may only perform this action once ${free ? "per hour" : "every 5 minutes"}`,
      );
    }
    zone.activationChecks.push(this.now.toISOString());
    return ok({ id: zone.id });
  }

  /** A record as listed: with its zone's id and name, and whether it can be proxied. */
  #listed(zone: FakeCloudflareZone, record: FakeDnsRecord) {
    return {
      ...record,
      zone_id: zone.id,
      zone_name: zone.name,
      proxiable: PROXIABLE.has(record.type),
    };
  }

  /** `input` checked against `records` as Cloudflare checks a new record. */
  #newRecord(
    zone: FakeCloudflareZone,
    records: readonly FakeDnsRecord[],
    input: unknown,
  ): FakeDnsRecord | FakeReply {
    const sent = input as FakeRecordInput;
    if (typeof sent?.type !== "string" || typeof sent.name !== "string") {
      return refuse(400, 1004, "DNS Validation Error");
    }
    const record = this.#record(zone, sent);
    if (record.proxied && !PROXIABLE.has(record.type)) {
      return refuse(400, 9004, "This record type cannot be proxied.");
    }
    const same = (r: FakeDnsRecord) =>
      r.type === record.type &&
      r.name === record.name &&
      r.content === record.content &&
      JSON.stringify(r.data) === JSON.stringify(record.data);
    if (records.some(same)) return refuse(400, 81058, "An identical record already exists.");
    if (
      records.some((r) => r.name === record.name && (r.type === "CNAME" || record.type === "CNAME"))
    ) {
      return refuse(400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
    }
    return record;
  }

  #records(
    zone: FakeCloudflareZone,
    method: string,
    rest: string,
    url: URL,
    body: unknown,
  ): FakeReply {
    if (rest === "" && method === "GET") {
      only(url, ["name", "type", "page", "per_page"]);
      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");
      const listed = zone.records.filter(
        (r) => (name === null || r.name === name) && (type === null || r.type === type),
      );
      return paged(
        listed.map((r) => this.#listed(zone, r)),
        url,
        100,
      );
    }
    if (rest === "" && method === "POST") {
      const made = this.#newRecord(zone, zone.records, body);
      if (!("id" in made)) return made;
      zone.records.push(made);
      return ok(this.#listed(zone, made));
    }
    if (rest === "/batch" && method === "POST") return this.#batch(zone, body);
    const id = /^\/([^/]+)$/.exec(rest)?.[1];
    const at = zone.records.findIndex((r) => r.id === id);
    if (id === undefined || method !== "DELETE") {
      throw new Error(
        `fake cloudflare: no route for ${method} /zones/${zone.id}/dns_records${rest}`,
      );
    }
    if (at === -1) return refuse(404, 81044, "Record does not exist.");
    zone.records.splice(at, 1);
    return ok({ id });
  }

  /** One transaction: the deletes, then the posts; any refusal changes nothing. */
  #batch(zone: FakeCloudflareZone, body: unknown): FakeReply {
    const sent = body as {
      deletes?: { id: string }[];
      patches?: unknown[];
      puts?: unknown[];
      posts?: unknown[];
    };
    if (sent.patches?.length || sent.puts?.length) {
      throw new Error("fake cloudflare: a batch's patches and puts are not answered");
    }
    const deletes = sent.deletes ?? [];
    const posts = sent.posts ?? [];
    const limit = (zone.data.plan ?? "free") === "free" ? BATCH_LIMITS.free : BATCH_LIMITS.paid;
    if (deletes.length + posts.length > limit) {
      // The words are the fake's own.
      return refuse(
        400,
        1004,
        `A batch may make at most ${limit} changes on this zone's plan; this one makes ${deletes.length + posts.length}.`,
      );
    }
    const next = [...zone.records];
    const deleted: FakeDnsRecord[] = [];
    for (const { id } of deletes) {
      const at = next.findIndex((r) => r.id === id);
      if (at === -1) return refuse(404, 81044, "Record does not exist.");
      deleted.push(...next.splice(at, 1));
    }
    const created: FakeDnsRecord[] = [];
    for (const post of posts) {
      const made = this.#newRecord(zone, next, post);
      if (!("id" in made)) return made;
      next.push(made);
      created.push(made);
    }
    zone.records.splice(0, zone.records.length, ...next);
    return ok({
      deletes: deleted.map((r) => this.#listed(zone, r)),
      patches: [],
      puts: [],
      posts: created.map((r) => this.#listed(zone, r)),
    });
  }

  /** On is pending (with its DS record) until a test sets `dnssec.status` to `active`. */
  #dnssec(zone: FakeCloudflareZone, method: string, body: unknown): FakeReply {
    if (method === "PATCH") {
      const wanted = (body as { status?: unknown }).status;
      if (wanted === "active" && zone.dnssec.status === "disabled") zone.dnssec.status = "pending";
      if (wanted === "disabled") zone.dnssec.status = "disabled";
    } else if (method === "DELETE") {
      zone.dnssec.status = "disabled";
    } else if (method !== "GET") {
      throw new Error(`fake cloudflare: ${method} on DNSSEC`);
    }
    if (zone.dnssec.status === "disabled") return ok({ status: "disabled" });
    const digest = createHash("sha256").update(zone.id).digest("hex").toUpperCase();
    const keyTag = Number.parseInt(zone.id.slice(-4), 16);
    return ok({
      status: zone.dnssec.status,
      flags: 257,
      algorithm: "13",
      key_type: "ECDSAP256SHA256",
      digest_type: "2",
      digest_algorithm: "SHA256",
      digest,
      key_tag: keyTag,
      ds: `${zone.name}. 3600 IN DS ${keyTag} 13 2 ${digest}`,
      modified_on: this.now.toISOString(),
    });
  }

  /**
   * `/certificates`: listed by `zone_id`; a new one belongs to the zone of its first hostname
   * among the token's zones (an active one first); revoked by id within the token's zones.
   */
  #originCa(
    reach: FakeCloudflareToken,
    call: FakeCloudflareCall,
    route: string,
    url: URL,
  ): FakeReply | FakeZone {
    if (reach.denied.has("ssl")) return DENIED;
    const mine = this.zones.filter((z) => reach.accounts.includes(z.accountId));
    let zone: FakeCloudflareZone | undefined;
    if (route === "/certificates" && call.method === "GET") {
      zone = this.zones.find((z) => z.id === url.searchParams.get("zone_id"));
      if (zone && !mine.includes(zone)) {
        call.accountId = zone.accountId;
        return UNAUTHORIZED;
      }
    } else if (route === "/certificates" && call.method === "POST") {
      const [first] = (call.body as { hostnames?: string[] }).hostnames ?? [];
      const host = String(first ?? "").replace(/^\*\./, "");
      zone = mine
        .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
        .sort(
          (a, b) =>
            b.name.length - a.name.length ||
            Number(b.status === "active") - Number(a.status === "active"),
        )[0];
      // The words are the fake's own.
      if (!zone) return refuse(400, 1010, "The hostnames are not in a zone of this token.");
    } else {
      const id = route.slice("/certificates/".length);
      zone = mine.find((z) => z.data.originCertificates.some((c) => c.id === id));
      if (!zone) return refuse(404, 1004, "certificate not found");
    }
    if (!zone) return refuse(400, 1001, "zone_id is required");
    call.accountId = zone.accountId;
    return zone.data;
  }
}

export type { FakeCloudflareAccounts };
