import type { FetchLike } from "@opscrew/contracts";
import { errorText, OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_API, CloudflareClient, CloudflareError } from "./client";

const TOKEN = fakeSecret("cloudflare-token");
const OTHER_TOKEN = fakeSecret("cloudflare-token", "account-b");
const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);
const ZONE_A = "1".repeat(32);
const ZONE_B = "2".repeat(32);
const noSleep = async () => {};

const ok = (result: unknown, extra: Record<string, unknown> = {}): FakeReply => ({
  body: { success: true, errors: [], messages: [], result, ...extra },
});
const fail = (status: number, code: number, message: string): FakeReply => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});
const denied = fail(403, 10000, "Authentication error");

function client(routes: Record<string, FakeReply | FakeReply[]>) {
  const { fetch, calls } = coreFakeFetch(routes, { base: CLOUDFLARE_API });
  const sleeps: number[] = [];
  const cf = new CloudflareClient({
    token: TOKEN,
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { cf, calls, sleeps };
}

/** The error a promise rejects with, checked to name no token. */
async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  const text = errorText(error);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(OTHER_TOKEN);
  return error as OpsCrewError;
}

interface Zone {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
  account: { id: string };
}

const zoneOf = (id: string, account: string, status: string, ns: string): Zone => ({
  id,
  name: "example.com",
  status,
  name_servers: [`${ns}.ns.cloudflare.com`],
  account: { id: account },
});

/**
 * `GET /zones` for a token that sees some accounts: filtered by `name` and `account.id`, one zone a
 * page so every match needs every page read. Each request's query is recorded.
 */
function zonesApi(zones: Zone[], seen: Record<string, string[]>) {
  const queries: URLSearchParams[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = String(headers.Authorization).slice("Bearer ".length);
    if (url.pathname !== "/client/v4/zones") throw new Error(`no route for ${url.pathname}`);
    queries.push(url.searchParams);
    const account = url.searchParams.get("account.id");
    const matches = zones.filter(
      (z) =>
        (seen[token] ?? []).includes(z.account.id) &&
        z.name === url.searchParams.get("name") &&
        (account === null || z.account.id === account),
    );
    const page = Number(url.searchParams.get("page") ?? "1");
    const body = {
      success: true,
      errors: [],
      result: matches.slice(page - 1, page),
      result_info: { page, total_pages: Math.max(matches.length, 1) },
    };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return { fetch, queries };
}

describe("CloudflareClient zones for a move", () => {
  const zones = [
    zoneOf(ZONE_B, ACCOUNT_B, "pending", "b"),
    zoneOf("3".repeat(32), ACCOUNT_A, "moved", "old"),
    zoneOf(ZONE_A, ACCOUNT_A, "active", "a"),
  ];
  const seen = { [TOKEN]: [ACCOUNT_A, ACCOUNT_B], [OTHER_TOKEN]: [ACCOUNT_B] };

  it("lets the account filter decide for a token that sees two accounts", async () => {
    const { fetch, queries } = zonesApi(zones, seen);
    const cf = new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep });
    expect(await cf.findZone("app.example.com", { accountId: ACCOUNT_B })).toEqual({
      id: ZONE_B,
      name: "example.com",
      status: "pending",
      nameServers: ["b.ns.cloudflare.com"],
      accountId: ACCOUNT_B,
    });
    expect(queries.map((q) => q.get("account.id"))).toEqual([ACCOUNT_B, ACCOUNT_B]);
    expect(queries.every((q) => q.get("per_page") !== "1")).toBe(true);
  });

  it("reads every match and prefers the active zone over a moved and a pending one", async () => {
    const { fetch, queries } = zonesApi(zones, seen);
    const cf = new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep });
    expect((await cf.findZone("example.com"))?.id).toBe(ZONE_A);
    expect(queries.map((q) => q.get("page"))).toEqual(["1", "2", "3"]);
    expect(queries[0]?.has("account.id")).toBe(false);
    expect((await cf.findZone("example.com", { accountId: ACCOUNT_A }))?.id).toBe(ZONE_A);
  });

  it("answers a moved zone when the account has no active one", async () => {
    const { fetch } = zonesApi([zoneOf("3".repeat(32), ACCOUNT_A, "moved", "old")], seen);
    const cf = new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep });
    expect(await cf.findZone("example.com", { accountId: ACCOUNT_A })).toMatchObject({
      status: "moved",
    });
    expect(await cf.findZone("example.com", { accountId: ACCOUNT_B })).toBeUndefined();
  });

  it("reads a zone's status and nameservers, its hold, and deletes it once", async () => {
    const { cf, calls } = client({
      [`GET /zones/${ZONE_B}/hold`]: ok({ hold: true, include_subdomains: false }),
      [`GET /zones/${ZONE_B}`]: ok(zoneOf(ZONE_B, ACCOUNT_B, "pending", "b")),
      [`DELETE /zones/${ZONE_B}`]: ok({ id: ZONE_B }),
    });
    expect(await cf.getZone(ZONE_B)).toEqual({
      id: ZONE_B,
      name: "example.com",
      status: "pending",
      nameServers: ["b.ns.cloudflare.com"],
      accountId: ACCOUNT_B,
    });
    expect(await cf.zoneHold(ZONE_B)).toEqual({ hold: true });
    await cf.deleteZone(ZONE_B);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /zones/${ZONE_B}`,
      `GET /zones/${ZONE_B}/hold`,
      `DELETE /zones/${ZONE_B}`,
    ]);
  });

  it("never sends a zone delete again after a server error", async () => {
    const { cf, calls } = client({
      [`DELETE /zones/${ZONE_B}`]: [{ status: 502, body: { success: false, errors: [] } }],
    });
    const error = await rejection(cf.deleteZone(ZONE_B));
    expect(error.message).toContain("may still have reached Cloudflare");
    expect(calls).toHaveLength(1);
  });

  it("names Zone → Zone → Edit when the token may not delete the zone", async () => {
    const { cf } = client({ [`DELETE /zones/${ZONE_B}`]: denied });
    const error = await rejection(cf.deleteZone(ZONE_B));
    expect(error).toBeInstanceOf(CloudflareError);
    expect(error.hint).toContain('"Zone → Zone → Edit"');
  });

  it("returns the account's own zone when the name exists in two accounts", async () => {
    const { fetch } = zonesApi(zones, seen);
    const create: FetchLike = async (input, init) =>
      init?.method === "POST"
        ? new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1061, message: "example.com already exists" }],
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          )
        : fetch(input, init);
    const cf = new CloudflareClient({ token: TOKEN, fetch: create, sleep: noSleep });
    expect((await cf.createZone(ACCOUNT_B, "example.com")).id).toBe(ZONE_B);
  });

  it("refuses a 409 for a zone that exists only in another account", async () => {
    const onlyA = [zoneOf(ZONE_A, ACCOUNT_A, "active", "a")];
    const refuse = (token: string) => {
      const { fetch } = zonesApi(onlyA, seen);
      const create: FetchLike = async (input, init) =>
        init?.method === "POST"
          ? new Response(
              JSON.stringify({ success: false, errors: [{ message: "Zone already exists" }] }),
              { status: 409, headers: { "content-type": "application/json" } },
            )
          : fetch(input, init);
      return new CloudflareClient({ token, fetch: create, sleep: noSleep }).createZone(
        ACCOUNT_B,
        "example.com",
      );
    };
    expect((await rejection(refuse(TOKEN))).message).toBe(
      "The zone example.com already exists in another Cloudflare account.",
    );
    expect((await rejection(refuse(OTHER_TOKEN))).message).toContain("cannot see it");
  });
});

describe("CloudflareClient records with every field", () => {
  const RECORDS = `/zones/${ZONE_A}/dns_records`;

  it("lists every record with its data, comment, priority and Cloudflare's meta", async () => {
    const srv = {
      id: "r1",
      type: "SRV",
      name: "_sip._tcp.example.com",
      content: "1 5060 sip.example.com",
      data: { priority: 10, weight: 1, port: 5060, target: "sip.example.com" },
      ttl: 3600,
      proxied: false,
      proxiable: false,
      priority: 10,
      comment: "phones",
      meta: { auto_added: false },
      tags: [],
    };
    const worker = {
      id: "r2",
      type: "AAAA",
      name: "example.com",
      content: "100::",
      ttl: 1,
      proxied: true,
      comment: null,
      meta: { read_only: true, origin_worker_id: "w1" },
    };
    const { cf, calls } = client({
      [`GET ${RECORDS}?page=1`]: ok([srv], { result_info: { total_pages: 2 } }),
      [`GET ${RECORDS}?page=2`]: ok([worker], { result_info: { total_pages: 2 } }),
    });
    expect(await cf.listZoneRecords(ZONE_A)).toEqual([
      {
        id: "r1",
        type: "SRV",
        name: "_sip._tcp.example.com",
        content: "1 5060 sip.example.com",
        data: { priority: 10, weight: 1, port: 5060, target: "sip.example.com" },
        ttl: 3600,
        proxied: false,
        priority: 10,
        comment: "phones",
        meta: { auto_added: false },
      },
      {
        id: "r2",
        type: "AAAA",
        name: "example.com",
        content: "100::",
        ttl: 1,
        proxied: true,
        meta: { read_only: true, origin_worker_id: "w1" },
      },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("creates records in batches of 200, keeping every field", async () => {
    const records = Array.from({ length: 450 }, (_, i) => ({
      type: "CNAME",
      name: `r${i}.example.com`,
      content: "target.example.com",
      ttl: 1,
      proxied: true,
      comment: "copied",
    }));
    const posts = (from: number, to: number) =>
      ok({ posts: records.slice(from, to).map((_, i) => ({ id: `id${from + i}` })) });
    const { cf, calls } = client({
      [`POST ${RECORDS}/batch`]: [posts(0, 200), posts(200, 400), posts(400, 450)],
    });
    const caa = {
      type: "CAA",
      name: "example.com",
      data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
      ttl: 300,
    };
    const ids = await cf.createZoneRecords(ZONE_A, [...records.slice(0, 449), caa]);
    expect(ids).toHaveLength(450);
    const bodies = calls.map((c) => (c.body as { posts: unknown[] }).posts);
    expect(bodies.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(bodies[0]?.[0]).toEqual(records[0]);
    expect(bodies[2]?.[49]).toEqual(caa);
  });

  it("says which records exist when a later batch is refused", async () => {
    const records = Array.from({ length: 201 }, (_, i) => ({
      type: "TXT",
      name: `t${i}.example.com`,
      content: '"v"',
      ttl: 1,
    }));
    const { cf } = client({
      [`POST ${RECORDS}/batch`]: [
        ok({ posts: records.slice(0, 200).map((_, i) => ({ id: `id${i}` })) }),
        fail(400, 81058, "An identical record already exists."),
      ],
    });
    const error = await rejection(cf.createZoneRecords(ZONE_A, records));
    expect(error.hint).toContain("200 were created by earlier calls");
  });

  it("deletes one record, once", async () => {
    const { cf, calls } = client({
      [`DELETE ${RECORDS}/r1`]: [ok({ id: "r1" }), { status: 500, body: { success: false } }],
    });
    await cf.deleteRecord(ZONE_A, "r1");
    expect((await rejection(cf.deleteRecord(ZONE_A, "r1"))).message).toContain(
      "may still have reached Cloudflare",
    );
    expect(calls).toHaveLength(2);
  });
});

describe("CloudflareClient Workers custom domains by zone", () => {
  const DOMAINS = `/accounts/${ACCOUNT_B}/workers/domains`;

  it("lists the zone's custom domains, whichever Worker serves them", async () => {
    const { cf, calls } = client({
      [`GET ${DOMAINS}?zone_id=${ZONE_B}`]: ok([
        {
          id: "d1",
          hostname: "example.com",
          zone_id: ZONE_B,
          zone_name: "example.com",
          service: "example-app",
          environment: "production",
        },
        {
          id: "d2",
          hostname: "docs.example.com",
          zone_id: ZONE_B,
          service: "other-app",
        },
      ]),
    });
    expect(await cf.listZoneWorkerDomains(ACCOUNT_B, ZONE_B)).toEqual([
      { id: "d1", hostname: "example.com", zoneId: ZONE_B, service: "example-app" },
      { id: "d2", hostname: "docs.example.com", zoneId: ZONE_B, service: "other-app" },
    ]);
    expect(calls[0]?.path).toBe(`${DOMAINS}?zone_id=${ZONE_B}`);
  });

  it("answers an empty list for a null result", async () => {
    const { cf } = client({
      [`GET ${DOMAINS}`]: { body: { success: true, errors: null, result: null } },
    });
    expect(await cf.listZoneWorkerDomains(ACCOUNT_B, ZONE_B)).toEqual([]);
  });

  it("attaches a custom domain, answering its id, and detaches one by id", async () => {
    const { cf, calls } = client({
      [`PUT ${DOMAINS}`]: ok({ id: "d9", hostname: "example.com", service: "example-app" }),
      [`DELETE ${DOMAINS}/d1`]: { body: { success: true, errors: [], result: null } },
    });
    const id = await cf.attachWorkerDomain(ACCOUNT_B, {
      hostname: "example.com",
      zoneId: ZONE_B,
      service: "example-app",
    });
    expect(id).toBe("d9");
    expect(calls[0]?.body).toEqual({
      hostname: "example.com",
      zone_id: ZONE_B,
      service: "example-app",
    });
    await cf.detachWorkerDomain(ACCOUNT_B, "d1");
    expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
  });

  it("says Cloudflare's reason when the hostname is held elsewhere, and never retries", async () => {
    const { cf, calls } = client({
      [`PUT ${DOMAINS}`]: fail(409, 100117, "Hostname already has an assigned Worker"),
    });
    const error = await rejection(
      cf.attachWorkerDomain(ACCOUNT_B, {
        hostname: "example.com",
        zoneId: ZONE_B,
        service: "example-app",
      }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Hostname already has an assigned Worker");
    expect(calls).toHaveLength(1);
  });

  it("names the Workers permission when attaching is refused", async () => {
    const { cf } = client({ [`PUT ${DOMAINS}`]: denied });
    const error = await rejection(
      cf.attachWorkerDomain(ACCOUNT_B, {
        hostname: "example.com",
        zoneId: ZONE_B,
        service: "example-app",
      }),
    );
    expect(error).toBeInstanceOf(CloudflareError);
    expect(error.hint).toContain("Account → Workers Scripts → Edit");
  });

  it("gives up on a write Cloudflare keeps rate-limiting", async () => {
    const limited: FakeReply = { status: 429, body: { success: false, errors: [] } };
    const { cf, calls } = client({
      [`DELETE ${DOMAINS}/d1`]: [limited, limited, limited, limited],
    });
    const error = await rejection(cf.detachWorkerDomain(ACCOUNT_B, "d1"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(calls).toHaveLength(4);
  });
});

describe("CloudflareClient permission probes", () => {
  const ACCOUNT = `/accounts/${ACCOUNT_B}`;
  const ZONE = `/zones/${ZONE_B}`;

  it("names each missing account permission as the token builder does", async () => {
    const { cf, calls } = client({
      [`GET ${ACCOUNT}/cfd_tunnel`]: denied,
      [`GET ${ACCOUNT}/access/apps`]: ok([]),
      [`GET ${ACCOUNT}/access/service_tokens`]: denied,
      [`GET ${ACCOUNT}/access/identity_providers`]: ok(null),
      [`GET ${ACCOUNT}/r2/buckets`]: denied,
      [`GET ${ACCOUNT}/workers/scripts`]: ok([]),
    });
    const all = [
      "tunnel",
      "access-apps",
      "access-service-tokens",
      "access-organization",
      "r2",
      "workers",
      "tunnel",
    ] as const;
    expect(await cf.accountPermissions(ACCOUNT_B, all)).toEqual({
      missing: [
        "Account → Cloudflare Tunnel → Edit",
        "Account → Access: Service Tokens → Edit",
        "Account → Workers R2 Storage → Edit",
      ],
    });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls).toHaveLength(6);
  });

  it("probes only what is asked", async () => {
    const { cf, calls } = client({ [`GET ${ACCOUNT}/access/identity_providers`]: denied });
    expect(await cf.accountPermissions(ACCOUNT_B, [])).toEqual({ missing: [] });
    expect(await cf.accountPermissions(ACCOUNT_B, ["access-organization"])).toEqual({
      missing: ["Account → Access: Organizations, Identity Providers, and Groups → Edit"],
    });
    expect(calls).toHaveLength(1);
  });

  it("waits out a rate limit before probing again", async () => {
    const { cf, calls, sleeps } = client({
      [`GET ${ACCOUNT}/workers/scripts`]: [
        { status: 429, body: { success: false, errors: [] }, headers: { "retry-after": "3" } },
        denied,
      ],
    });
    expect(await cf.accountPermissions(ACCOUNT_B, ["workers"])).toEqual({
      missing: ["Account → Workers Scripts → Edit"],
    });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it("says Access is off rather than a permission missing", async () => {
    const { cf } = client({
      [`GET ${ACCOUNT}/access/apps`]: fail(403, 9999, "access.api.error.not_enabled"),
    });
    const error = await rejection(cf.accountPermissions(ACCOUNT_B, ["access-apps"]));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Nothing was changed.");
  });

  it("throws on a failure that is not a refusal", async () => {
    const { cf } = client({ [`GET ${ACCOUNT}/cfd_tunnel`]: fail(400, 1000, "Invalid account") });
    expect((await rejection(cf.accountPermissions(ACCOUNT_B, ["tunnel"]))).message).toContain(
      "Invalid account",
    );
  });

  it("names each missing zone permission, a rule phase without rules counting as granted", async () => {
    const phases = `${ZONE}/rulesets/phases`;
    const { cf, calls } = client({
      [`GET ${ZONE}/dns_records`]: ok([]),
      [`GET ${phases}/http_config_settings/entrypoint`]: fail(404, 10003, "not found"),
      [`GET ${phases}/http_request_firewall_custom/entrypoint`]: denied,
      [`GET ${phases}/http_request_dynamic_redirect/entrypoint`]: ok({ id: "rs1", rules: [] }),
      [`GET ${ZONE}/ssl/certificate_packs`]: denied,
      [`GET ${ZONE}/settings/min_tls_version`]: ok({ value: "1.0", editable: true }),
    });
    const needs = [
      "dns",
      "http_config_settings",
      "http_request_firewall_custom",
      "http_request_dynamic_redirect",
      "ssl",
      "settings",
    ] as const;
    expect(await cf.zonePermissions(ZONE_B, needs)).toEqual({
      missing: ["Zone → Zone WAF → Edit", "Zone → SSL and Certificates → Edit"],
    });
    expect(calls).toHaveLength(6);
  });

  it("names the DNS and settings permissions when those reads are refused", async () => {
    const { cf } = client({
      [`GET ${ZONE}/dns_records`]: denied,
      [`GET ${ZONE}/settings/min_tls_version`]: denied,
    });
    expect(await cf.zonePermissions(ZONE_B, ["dns", "settings"])).toEqual({
      missing: ["Zone → DNS → Edit", "Zone → Zone Settings → Edit"],
    });
  });

  it("asks for a token when the probe's token is rejected outright", async () => {
    const { cf } = client({
      [`GET ${ZONE}/dns_records`]: fail(401, 10001, "Unable to authenticate request"),
    });
    const error = await rejection(cf.zonePermissions(ZONE_B, ["dns"]));
    expect(error.code).toBe("CREDENTIALS_INVALID");
  });
});
