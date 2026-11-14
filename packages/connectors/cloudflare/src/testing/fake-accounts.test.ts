import {
  buildCsr,
  fingerprintSha256,
  generateP256,
  OpsCrewError,
  selfSignedClientCertificate,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_API, CloudflareClient, CloudflareError } from "../client";
import { applyShared, inspectShared, planShared } from "../shared";
import {
  type FakeCloudflareAccounts,
  type FakeCloudflarePermission,
  fakeCloudflareAccounts,
} from "./index";

const TOKEN_A = fakeSecret("cloudflare-token", "account-a");
const TOKEN_B = fakeSecret("cloudflare-token", "account-b");
const ZONE = "example.com";

/** Account A holds example.com, active; account B is empty. */
function setup(denied: FakeCloudflarePermission[] = []) {
  const fake = fakeCloudflareAccounts({
    accounts: [
      { name: "Old", token: TOKEN_A },
      { name: "New", token: TOKEN_B, denied },
    ],
    zones: [{ name: ZONE, account: "Old" }],
  });
  const client = (token: string) =>
    new CloudflareClient({ token, fetch: fake.fetch, sleep: async () => {} });
  return {
    fake,
    a: fake.account("Old"),
    b: fake.account("New"),
    zoneA: fake.zone(ZONE, "Old"),
    clientA: client(TOKEN_A),
    clientB: client(TOKEN_B),
  };
}

interface Answer {
  status: number;
  success: boolean;
  errors: { code: number; message: string }[];
  result: unknown;
  result_info?: Record<string, unknown>;
}

/** A request with `token` as Cloudflare's API gets it; the answer's JSON (null for none). */
async function call(
  fake: FakeCloudflareAccounts,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fake.fetch(`${CLOUDFLARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as Omit<Answer, "status">;
  return { status: response.status, ...json };
}

/** The answer's result as `T` (for reading fields in assertions). */
const result = <T = Record<string, unknown>>(answer: Answer) => answer.result as T;
const codes = (answer: Answer) => answer.errors.map((e) => e.code);

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("fakeCloudflareAccounts: tokens and accounts", () => {
  it("reaches each account with its own token and refuses another account's, as Cloudflare does", async () => {
    const { fake, a, b, zoneA, clientA, clientB } = setup();
    expect(await clientA.listAccounts()).toEqual([{ id: a.id, name: "Old" }]);
    expect(await clientB.listAccounts()).toEqual([{ id: b.id, name: "New" }]);
    expect(await clientA.findZone(`shop.${ZONE}`)).toEqual({
      id: zoneA.id,
      name: ZONE,
      status: "active",
      nameServers: zoneA.nameServers,
      accountId: a.id,
    });
    expect(await clientB.findZone(`shop.${ZONE}`)).toBeUndefined();

    const zoneB = await clientB.createZone(b.id, ZONE);
    expect(zoneB).toMatchObject({ name: ZONE, status: "pending", accountId: b.id });
    expect(zoneB.nameServers).toHaveLength(2);
    expect(zoneB.nameServers).not.toEqual(zoneA.nameServers);

    // A's token on B's zone, on B's account, and adding a zone to B.
    expect(await rejection(clientA.listDnsRecords(zoneB.id))).toBeInstanceOf(CloudflareError);
    const zoneCall = await call(fake, TOKEN_A, "GET", `/zones/${zoneB.id}/dns_records`);
    expect([zoneCall.status, ...codes(zoneCall)]).toEqual([403, 9109]);
    const accountCall = await call(fake, TOKEN_A, "GET", `/accounts/${b.id}/workers/scripts`);
    expect([accountCall.status, ...codes(accountCall)]).toEqual([404, 7003]);
    expect((await rejection(clientA.createZone(b.id, "example.org"))).code).toBe(
      "CREDENTIALS_INVALID",
    );
    expect(fake.zones.map((z) => z.name)).toEqual([ZONE, ZONE]);

    // A token Cloudflare does not know.
    const unknown = fakeSecret("cloudflare-token", "unknown");
    const refused = await call(fake, unknown, "GET", "/zones");
    expect([refused.status, ...codes(refused)]).toEqual([401, 1000]);
    expect(
      await new CloudflareClient({ token: unknown, fetch: fake.fetch }).verifyToken(),
    ).toMatchObject({ ok: false });
    expect(await clientB.verifyToken()).toMatchObject({ ok: true, status: "active" });

    // Every call recorded, with the account it named and its status, never with a token.
    expect(fake.calls.find((c) => c.path === `/zones/${zoneB.id}/dns_records`)).toEqual({
      method: "GET",
      path: `/zones/${zoneB.id}/dns_records`,
      body: undefined,
      accountId: b.id,
      status: 403,
    });
    const recorded = JSON.stringify(fake.calls);
    for (const token of [TOKEN_A, TOKEN_B, unknown]) expect(recorded).not.toContain(token);
  });

  it("lists the zones a token sees by name, account and status, page by page", async () => {
    const { fake, a, b, clientB } = setup();
    const both = fakeSecret("cloudflare-token", "both");
    fake.tokens.set(both, { accounts: [a.id, b.id], denied: new Set() });
    const zoneB = await clientB.createZone(b.id, ZONE);
    const ids = (answer: Answer) => result<{ id: string }[]>(answer).map((z) => z.id);
    const zoneA = fake.zone(ZONE, a.id);

    expect(ids(await call(fake, both, "GET", `/zones?name=${ZONE}`))).toEqual([zoneA.id, zoneB.id]);
    expect(ids(await call(fake, both, "GET", `/zones?name=${ZONE}&account.id=${b.id}`))).toEqual([
      zoneB.id,
    ]);
    expect(ids(await call(fake, both, "GET", `/zones?status=pending`))).toEqual([zoneB.id]);
    const second = await call(fake, both, "GET", `/zones?name=${ZONE}&page=2&per_page=1`);
    expect(ids(second)).toEqual([zoneB.id]);
    expect(second.result_info).toEqual({
      page: 2,
      per_page: 1,
      count: 1,
      total_count: 2,
      total_pages: 2,
    });
    expect(ids(await call(fake, TOKEN_B, "GET", `/zones?account.id=${a.id}`))).toEqual([]);
    const zone = result(await call(fake, both, "GET", `/zones/${zoneB.id}`));
    expect(zone).toMatchObject({
      id: zoneB.id,
      name: ZONE,
      status: "pending",
      name_servers: zoneB.nameServers,
      account: { id: b.id, name: "New" },
      plan: { legacy_id: "free" },
      activated_on: null,
    });
    await expect(
      fake.fetch(`${CLOUDFLARE_API}/zones?name=${ZONE}&match=all`, {
        headers: { Authorization: `Bearer ${both}` },
      }),
    ).rejects.toThrow("/zones does not take the query parameter match");
  });
});

describe("fakeCloudflareAccounts: zones", () => {
  it("adds a zone with the pair a test gives, refuses one the account has or one on hold elsewhere, and deletes it", async () => {
    const { fake, b, zoneA, clientA, clientB } = setup();
    fake.nameServerPairs.push(zoneA.nameServers);
    const zoneB = await clientB.createZone(b.id, ZONE);
    expect(zoneB.nameServers).toEqual(zoneA.nameServers);
    // Cloudflare's "already exists" (1061): the client answers the account's own zone.
    const again = await call(fake, TOKEN_B, "POST", "/zones", {
      name: ZONE,
      account: { id: b.id },
      type: "full",
    });
    expect([again.status, ...codes(again)]).toEqual([400, 1061]);
    expect(await clientB.createZone(b.id, ZONE)).toEqual(zoneB);

    const deleted = await call(fake, TOKEN_B, "DELETE", `/zones/${zoneB.id}`);
    expect(result(deleted)).toEqual({ id: zoneB.id });
    expect(fake.zones).toEqual([zoneA]);
    const gone = await call(fake, TOKEN_B, "GET", `/zones/${zoneB.id}`);
    expect([gone.status, ...codes(gone)]).toEqual([404, 7003]);

    // A's hold keeps the zone out of B until A releases it.
    const held = await call(
      fake,
      TOKEN_A,
      "POST",
      `/zones/${zoneA.id}/hold?include_subdomains=true`,
    );
    expect(result(held)).toEqual({ hold: true, include_subdomains: true });
    expect(result(await call(fake, TOKEN_A, "GET", `/zones/${zoneA.id}/hold`))).toEqual({
      hold: true,
      include_subdomains: true,
    });
    expect((await rejection(clientB.createZone(b.id, ZONE))).message).toContain(
      "is on hold in another account",
    );
    await call(fake, TOKEN_A, "DELETE", `/zones/${zoneA.id}/hold`);
    expect(zoneA.hold.hold).toBe(false);
    expect(await clientB.createZone(b.id, ZONE)).toMatchObject({ status: "pending" });
    expect(await clientA.findZone(ZONE)).toMatchObject({ id: zoneA.id, status: "active" });
  });

  it("moves zones pending → active → moved, issues the universal certificate on activation, and limits the activation check as on a free zone", async () => {
    const { fake, b, zoneA, clientA, clientB } = setup();
    const created = await clientB.createZone(b.id, ZONE);
    const zoneB = fake.zone(ZONE, "New");
    expect(await clientB.listCertificatePacks(created.id)).toEqual([]);

    expect(await clientB.activationCheck(created.id)).toEqual({ requested: true });
    expect(await clientB.activationCheck(created.id)).toMatchObject({
      requested: false,
      retryAfterSeconds: 3600,
    });
    fake.now = new Date(fake.now.getTime() + 3600_000);
    expect(await clientB.activationCheck(created.id)).toEqual({ requested: true });
    expect(zoneB.activationChecks).toEqual([
      "2026-11-20T10:00:00.000Z",
      "2026-11-20T11:00:00.000Z",
    ]);
    expect(zoneB.status).toBe("pending");

    fake.activate(zoneB);
    expect(zoneB).toMatchObject({ status: "active", activatedOn: "2026-11-20T11:00:00.000Z" });
    expect(zoneA.status).toBe("moved");
    expect(await clientA.findZone(ZONE)).toMatchObject({ id: zoneA.id, status: "moved" });
    expect(await clientB.listCertificatePacks(created.id)).toEqual([
      {
        id: zoneB.certificatePacks[0]?.id,
        type: "universal",
        hosts: [ZONE, `*.${ZONE}`],
        status: "active",
      },
    ]);
    // A slower certificate: listed only with `status=all` until active.
    const [universal] = zoneB.certificatePacks;
    if (universal) universal.status = "pending_validation";
    const probe = await call(
      fake,
      TOKEN_B,
      "GET",
      `/zones/${zoneB.id}/ssl/certificate_packs?per_page=1`,
    );
    expect(probe.result).toEqual([]);
    expect(await clientB.listCertificatePacks(zoneB.id)).toMatchObject([
      { status: "pending_validation" },
    ]);

    fake.move(zoneB);
    expect(result(await call(fake, TOKEN_B, "GET", `/zones/${zoneB.id}`))).toMatchObject({
      status: "moved",
    });
  });

  it("turns DNSSEC on as pending with its DS record, until a test makes it active", async () => {
    const { fake, zoneA, clientA } = setup();
    expect(await clientA.getDnssec(zoneA.id)).toEqual({ status: "disabled" });
    const on = await clientA.enableDnssec(zoneA.id);
    expect(on).toMatchObject({ status: "pending", algorithm: 13, digestType: 2 });
    expect(on.keyTag).toEqual(expect.any(Number));
    expect(on.ds).toBe(`${ZONE}. 3600 IN DS ${on.keyTag} 13 2 ${on.digest}`);
    zoneA.dnssec.status = "active";
    expect(await clientA.getDnssec(zoneA.id)).toMatchObject({
      status: "active",
      digest: on.digest,
    });
    const off = await call(fake, TOKEN_A, "PATCH", `/zones/${zoneA.id}/dnssec`, {
      status: "disabled",
    });
    expect(result(off)).toEqual({ status: "disabled" });
  });
});

describe("fakeCloudflareAccounts: records", () => {
  it("keeps every field of a record and Cloudflare's meta, and lists them page by page with filters", async () => {
    const { fake, zoneA, clientA } = setup();
    fake.addRecord(zoneA, { type: "MX", name: "@", content: "mail.example.net", priority: 10 });
    fake.addRecord(zoneA, {
      type: "SRV",
      name: "_sip._tcp",
      data: { priority: 10, weight: 5, port: 5060, target: "sip.example.net" },
      comment: "phones",
      ttl: 3600,
    });
    fake.addRecord(zoneA, {
      type: "AAAA",
      name: "docs",
      content: "100::",
      proxied: true,
      meta: { read_only: true, origin_worker_id: "docs" },
    });
    const listed = result<Record<string, unknown>[]>(
      await call(fake, TOKEN_A, "GET", `/zones/${zoneA.id}/dns_records`),
    );
    expect(listed).toEqual([
      expect.objectContaining({
        type: "MX",
        name: ZONE,
        content: "mail.example.net",
        priority: 10,
        proxied: false,
        proxiable: false,
        ttl: 1,
        comment: null,
        meta: {},
        zone_id: zoneA.id,
        zone_name: ZONE,
      }),
      expect.objectContaining({
        type: "SRV",
        name: `_sip._tcp.${ZONE}`,
        data: { priority: 10, weight: 5, port: 5060, target: "sip.example.net" },
        comment: "phones",
        ttl: 3600,
      }),
      expect.objectContaining({
        name: `docs.${ZONE}`,
        proxiable: true,
        meta: { read_only: true, origin_worker_id: "docs" },
      }),
    ]);
    const mx = await call(
      fake,
      TOKEN_A,
      "GET",
      `/zones/${zoneA.id}/dns_records?type=MX&name=${ZONE}`,
    );
    expect(result<{ type: string }[]>(mx).map((r) => r.type)).toEqual(["MX"]);

    for (let i = 0; i < 120; i++) {
      fake.addRecord(zoneA, { type: "TXT", name: `t${i}`, content: `"v${i}"` });
    }
    expect(await clientA.listDnsRecords(zoneA.id)).toHaveLength(123);
    expect(fake.calls.filter((c) => c.path.includes("dns_records?page=2"))).toHaveLength(1);
  });

  it("creates records one by one or in one batch transaction, refusing what Cloudflare refuses, and deletes them", async () => {
    const { fake, b, clientB } = setup();
    const created = await clientB.createZone(b.id, ZONE);
    const zoneB = fake.zone(ZONE, "New");
    const post = {
      type: "CNAME",
      name: `www.${ZONE}`,
      content: ZONE,
      ttl: 1,
      proxied: true,
      comment: "the user's own",
    };
    const batch = await call(fake, TOKEN_B, "POST", `/zones/${created.id}/dns_records/batch`, {
      posts: [post, { type: "TXT", name: ZONE, content: '"v=spf1 -all"', ttl: 300 }],
    });
    expect(result<{ posts: unknown[] }>(batch).posts).toEqual([
      expect.objectContaining({ ...post, id: zoneB.records[0]?.id }),
      expect.objectContaining({ type: "TXT", ttl: 300 }),
    ]);
    expect(
      await clientB.batchCreateRecords(created.id, [
        {
          type: "MX",
          name: ZONE,
          content: "mail.example.net",
          priority: 10,
          ttl: 1,
          proxied: false,
        },
      ]),
    ).toEqual([zoneB.records[2]?.id]);

    const refusals: [unknown, number][] = [
      [post, 81058],
      [{ type: "A", name: `www.${ZONE}`, content: "203.0.113.10", ttl: 1 }, 81053],
      [{ type: "TXT", name: `t.${ZONE}`, content: '"x"', ttl: 1, proxied: true }, 9004],
    ];
    for (const [record, code] of refusals) {
      const refused = await call(fake, TOKEN_B, "POST", `/zones/${created.id}/dns_records`, record);
      expect([refused.status, ...codes(refused)]).toEqual([400, code]);
    }
    // One refused post leaves the whole batch undone.
    const undone = await call(fake, TOKEN_B, "POST", `/zones/${created.id}/dns_records/batch`, {
      deletes: [{ id: zoneB.records[0]?.id }],
      posts: [{ type: "TXT", name: `new.${ZONE}`, content: '"x"', ttl: 1 }, post, post],
    });
    expect(codes(undone)).toEqual([81058]);
    expect(zoneB.records).toHaveLength(3);
    // 200 changes a call on the Free plan.
    const many = Array.from({ length: 201 }, (_, i) => ({
      type: "TXT",
      name: `m${i}.${ZONE}`,
      content: '"x"',
      ttl: 1,
    }));
    const tooMany = await call(fake, TOKEN_B, "POST", `/zones/${created.id}/dns_records/batch`, {
      posts: many,
    });
    expect(tooMany.status).toBe(400);
    zoneB.data.plan = "pro";
    expect(
      (await call(fake, TOKEN_B, "POST", `/zones/${created.id}/dns_records/batch`, { posts: many }))
        .success,
    ).toBe(true);

    const id = zoneB.records[0]?.id;
    expect(
      result(await call(fake, TOKEN_B, "DELETE", `/zones/${created.id}/dns_records/${id}`)),
    ).toEqual({ id });
    const missing = await call(fake, TOKEN_B, "DELETE", `/zones/${created.id}/dns_records/${id}`);
    expect([missing.status, ...codes(missing)]).toEqual([404, 81044]);
  });
});

describe("fakeCloudflareAccounts: rules and origin TLS", () => {
  it("plans and applies B's shared rules and origin TLS on its pending zone without waiting, deployed once it is active, and keeps each zone's certificates to its token", async () => {
    const { fake, b, zoneA, clientA, clientB } = setup();
    const created = await clientB.createZone(b.id, ZONE);
    const zoneB = fake.zone(ZONE, "New");
    const hosts = [`shop.${ZONE}`, `www.shop.${ZONE}`];
    const client = generateP256();
    const clientCertificate = selfSignedClientCertificate({
      key: client.privateKey,
      commonName: "opscrew-shop",
      days: 5475,
      now: fake.now,
    });
    const csr = buildCsr({ key: generateP256().privateKey, hostnames: hosts });
    const desired = {
      hostnames: { "opscrew-block-probes": hosts, "opscrew-strict-tls": hosts },
      tls: {
        proxied: hosts,
        origin: { csr },
        client: { sha256: fingerprintSha256(clientCertificate) },
      },
    };
    const facts = await inspectShared(clientB, {
      zoneId: created.id,
      accountId: b.id,
      access: false,
      tls: { proxied: hosts, record: undefined },
    });
    const plan = planShared(facts, desired, undefined);
    const sleeps: number[] = [];
    const applied = await applyShared(clientB, plan, {
      approvedHash: plan.hash,
      keys: { clientCertificate, clientKey: client.privateKey },
      csr,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      waitForActive: false,
    });
    expect(sleeps).toEqual([]);
    expect(applied.applied).toContain("enable-client-certificate");
    expect([...zoneB.data.entrypoints.keys()]).toEqual([
      "http_request_firewall_custom",
      "http_config_settings",
    ]);
    expect(zoneA.data.entrypoints.size).toBe(0);

    // Pending until B's zone is active, then deployed.
    const status = async () => [
      ...(await clientB.listHostnameClientCertificates(created.id)).map((c) => c.status),
      ...(await clientB.listHostnameAopSettings(created.id, hosts)).map((s) => s.status),
    ];
    expect(await status()).toEqual(Array(3).fill("pending_deployment"));
    fake.activate(zoneB);
    expect(await status()).toEqual(Array(3).fill("active"));

    // The origin certificate is B's zone's: A's token neither lists nor revokes it.
    const [origin] = await clientB.listOriginCertificates(created.id);
    expect(origin).toMatchObject({ hostnames: hosts });
    expect(await clientA.listOriginCertificates(zoneA.id)).toEqual([]);
    expect(await rejection(clientA.listOriginCertificates(created.id))).toBeInstanceOf(
      CloudflareError,
    );
    expect((await rejection(clientA.revokeOriginCertificate(origin?.id ?? ""))).message).toContain(
      "certificate not found",
    );
    // Ids are unique across both zones.
    const ids = fake.zones.flatMap((z) => [
      z.id,
      ...[...z.data.entrypoints.values()].map((r) => r.id),
      ...z.data.originCertificates.map((c) => c.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fakeCloudflareAccounts: account pieces", () => {
  it("answers tunnels with their connections, token and configuration", async () => {
    const { fake, b, clientB } = setup();
    const created = await call(fake, TOKEN_B, "POST", `/accounts/${b.id}/cfd_tunnel`, {
      name: "example-app",
      config_src: "cloudflare",
    });
    const id = result<{ id: string }>(created).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const twice = await call(fake, TOKEN_B, "POST", `/accounts/${b.id}/cfd_tunnel`, {
      name: "example-app",
    });
    expect([twice.status, ...codes(twice)]).toEqual([409, 1013]);
    expect(await clientB.tunnelConnections(b.id, id)).toBe("closed");

    const [tunnel] = b.tunnels;
    tunnel?.connections.push({
      id: "conn-1",
      colo_name: "fra08",
      opened_at: fake.now.toISOString(),
      origin_ip: "203.0.113.10",
    });
    expect(await clientB.tunnelConnections(b.id, id)).toBe("active");
    const listed = await call(
      fake,
      TOKEN_B,
      "GET",
      `/accounts/${b.id}/cfd_tunnel?name=example-app&is_deleted=false`,
    );
    expect(result(listed)).toEqual([
      expect.objectContaining({
        id,
        status: "healthy",
        connections: [expect.objectContaining({ origin_ip: "203.0.113.10" })],
      }),
    ]);

    const secret = Buffer.alloc(32, 7).toString("base64");
    const token = await clientB.rotateTunnelSecret(b.id, id, secret);
    expect(JSON.parse(Buffer.from(token, "base64").toString())).toEqual({
      a: b.id,
      t: id,
      s: secret,
    });
    const config = { ingress: [{ hostname: `shop.${ZONE}`, service: "http://app:3000" }] };
    await call(fake, TOKEN_B, "PUT", `/accounts/${b.id}/cfd_tunnel/${id}/configurations`, {
      config,
    });
    expect(
      result(await call(fake, TOKEN_B, "GET", `/accounts/${b.id}/cfd_tunnel/${id}/configurations`)),
    ).toMatchObject({ tunnel_id: id, config });

    const busy = await call(fake, TOKEN_B, "DELETE", `/accounts/${b.id}/cfd_tunnel/${id}`);
    expect([busy.status, ...codes(busy)]).toEqual([400, 1022]);
    await call(fake, TOKEN_B, "DELETE", `/accounts/${b.id}/cfd_tunnel/${id}?cascade=true`);
    expect(await clientB.tunnelConnections(b.id, id)).toBe("gone");
  });

  it("answers Access: the organization, login methods, applications, policies and service tokens", async () => {
    const { fake, b, clientB } = setup();
    const access = `/accounts/${b.id}/access`;
    expect(await clientB.accessOrganization(b.id)).toBeUndefined();
    const auth = "example-team.cloudflareaccess.com";
    expect(await clientB.createAccessOrganization(b.id, auth)).toEqual({ authDomain: auth });
    expect(await clientB.accessOrganization(b.id)).toEqual({ authDomain: auth });
    await rejection(clientB.createAccessOrganization(b.id, auth));
    const pin = await clientB.createOneTimePinProvider(b.id);
    expect(await clientB.accessIdentityProviders(b.id)).toEqual([{ id: pin, type: "onetimepin" }]);

    const app = result(
      await call(fake, TOKEN_B, "POST", `${access}/apps`, {
        name: "example-app ssh",
        domain: `ssh-shop.${ZONE}`,
        type: "self_hosted",
      }),
    );
    expect(app).toMatchObject({ name: "example-app ssh", domain: `ssh-shop.${ZONE}` });
    expect(app.aud).toMatch(/^[0-9a-f]{64}$/);
    const renamed = await call(fake, TOKEN_B, "PUT", `${access}/apps/${app.id}`, {
      name: "renamed",
      domain: `ssh-shop.${ZONE}`,
      type: "self_hosted",
    });
    expect(result(renamed)).toMatchObject({ id: app.id, aud: app.aud, name: "renamed" });
    const policy = result(
      await call(fake, TOKEN_B, "POST", `${access}/policies`, {
        name: "deploy",
        decision: "non_identity",
      }),
    );
    expect(policy).toMatchObject({ reusable: true });
    expect(result(await call(fake, TOKEN_B, "GET", `${access}/policies`))).toEqual([policy]);
    await call(fake, TOKEN_B, "DELETE", `${access}/apps/${app.id}`);
    const gone = await call(fake, TOKEN_B, "GET", `${access}/apps/${app.id}`);
    expect([gone.status, ...codes(gone)]).toEqual([404, 12130]);

    const token = result<{ id: string; client_id: string; client_secret: string }>(
      await call(fake, TOKEN_B, "POST", `${access}/service_tokens`, { name: "example-app deploy" }),
    );
    expect(token.client_id).toMatch(/^[0-9a-f]{32}\.access$/);
    expect(token.client_secret).toMatch(/^[0-9a-f]{64}$/);
    const tokens = await call(fake, TOKEN_B, "GET", `${access}/service_tokens`);
    expect(JSON.stringify(tokens)).not.toContain(token.client_secret);
    await call(fake, TOKEN_B, "DELETE", `${access}/service_tokens/${token.id}`);
    expect(b.serviceTokens).toEqual([]);
  });

  it("answers R2 buckets per account", async () => {
    const { fake, a, b } = setup();
    const buckets = (account: string) => `/accounts/${account}/r2/buckets`;
    for (const [token, account] of [
      [TOKEN_A, a.id],
      [TOKEN_B, b.id],
    ] as const) {
      const made = await call(fake, token, "POST", buckets(account), { name: "example-app-files" });
      expect(result(made)).toMatchObject({ name: "example-app-files", storage_class: "Standard" });
    }
    const twice = await call(fake, TOKEN_B, "POST", buckets(b.id), { name: "example-app-files" });
    expect([twice.status, ...codes(twice)]).toEqual([409, 10004]);
    const invalid = await call(fake, TOKEN_B, "POST", buckets(b.id), { name: "Not_Valid" });
    expect([invalid.status, ...codes(invalid)]).toEqual([400, 10005]);
    await call(fake, TOKEN_B, "POST", buckets(b.id), { name: "example-app-backups" });
    const page = await call(fake, TOKEN_B, "GET", `${buckets(b.id)}?per_page=1`);
    expect(result<{ buckets: { name: string }[] }>(page).buckets.map((x) => x.name)).toEqual([
      "example-app-files",
    ]);
    expect(page.result_info).toEqual({ cursor: "1", per_page: 1 });
    await call(fake, TOKEN_B, "DELETE", `${buckets(b.id)}/example-app-files`);
    const gone = await call(fake, TOKEN_B, "GET", `${buckets(b.id)}/example-app-files`);
    expect([gone.status, ...codes(gone)]).toEqual([404, 10006]);
    expect(a.buckets.map((x) => x.name)).toEqual(["example-app-files"]);
  });

  it("answers Workers scripts, their subdomain, and custom domains attached by zone once it is active", async () => {
    const { fake, a, b, clientB } = setup();
    const created = await clientB.createZone(b.id, ZONE);
    const zoneB = fake.zone(ZONE, "New");
    b.workers.set("docs", {});
    expect(await clientB.workersPermissions(b.id)).toEqual({ missing: [] });
    const subdomain = `/accounts/${b.id}/workers/scripts/docs/subdomain`;
    expect(result(await call(fake, TOKEN_B, "GET", subdomain))).toEqual({
      enabled: false,
      previews_enabled: false,
    });
    await call(fake, TOKEN_B, "POST", subdomain, { enabled: true });
    expect(b.workers.get("docs")?.subdomain).toEqual({ enabled: true, previews_enabled: false });

    const domains = `/accounts/${b.id}/workers/domains`;
    const attach = (hostname: string, service = "docs") =>
      call(fake, TOKEN_B, "PUT", domains, { hostname, service, zone_id: created.id });
    expect((await attach(`docs.${ZONE}`)).status).toBe(400);
    fake.activate(zoneB);
    fake.addRecord(zoneB, {
      type: "CNAME",
      name: "www.docs",
      content: `docs.${ZONE}`,
      proxied: true,
    });
    const taken = await attach(`www.docs.${ZONE}`);
    expect([taken.status, ...codes(taken)]).toEqual([409, 100117]);
    const noWorker = await attach(`api.${ZONE}`, "api");
    expect([noWorker.status, ...codes(noWorker)]).toEqual([404, 10007]);

    const attached = result<{ id: string }>(await attach(`docs.${ZONE}`));
    expect(attached).toMatchObject({
      hostname: `docs.${ZONE}`,
      service: "docs",
      zone_id: created.id,
    });
    expect(zoneB.records.find((r) => r.name === `docs.${ZONE}`)).toMatchObject({
      type: "AAAA",
      content: "100::",
      proxied: true,
      meta: { read_only: true, origin_worker_id: "docs" },
    });
    expect(await clientB.listWorkerCustomDomains(b.id, "docs")).toEqual([
      { hostname: `docs.${ZONE}`, zoneId: created.id },
    ]);
    const byZone = await call(fake, TOKEN_B, "GET", `${domains}?zone_id=${created.id}`);
    expect(result<unknown[]>(byZone)).toHaveLength(1);
    expect(
      result<unknown[]>(await call(fake, TOKEN_B, "GET", `${domains}?zone_id=${a.id}`)),
    ).toEqual([]);

    expect(result(await call(fake, TOKEN_B, "DELETE", `${domains}/${attached.id}`))).toBeNull();
    expect(b.workerDomains).toEqual([]);
    expect(zoneB.records.map((r) => r.name)).toEqual([`www.docs.${ZONE}`]);
  });
});

describe("fakeCloudflareAccounts: permissions and faults", () => {
  const probes: [FakeCloudflarePermission, string, string][] = [
    ["zone", "PUT", "/zones/{zone}/activation_check"],
    ["dns", "GET", "/zones/{zone}/dns_records?per_page=1"],
    ["ssl", "GET", "/zones/{zone}/ssl/certificate_packs?per_page=1"],
    ["settings", "GET", "/zones/{zone}/settings/min_tls_version"],
    [
      "http_request_firewall_custom",
      "GET",
      "/zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint",
    ],
    ["tunnel", "GET", "/accounts/{account}/cfd_tunnel?per_page=1"],
    ["access-apps", "GET", "/accounts/{account}/access/apps"],
    ["access-service-tokens", "GET", "/accounts/{account}/access/service_tokens"],
    ["access-organization", "GET", "/accounts/{account}/access/identity_providers"],
    ["r2", "GET", "/accounts/{account}/r2/buckets?per_page=1"],
    ["workers", "GET", "/accounts/{account}/workers/scripts"],
  ];

  it.each(probes)("withholds %s from one token only: %s %s", async (permission, method, path) => {
    const fake = fakeCloudflareAccounts({
      accounts: [{ name: "New", token: TOKEN_B, denied: [permission] }],
      zones: [{ name: ZONE, account: "New", status: "pending" }],
    });
    const b = fake.account("New");
    const full = fakeSecret("cloudflare-token", "account-b-full");
    fake.tokens.set(full, { accounts: [b.id], denied: new Set() });
    const at = path.replace("{zone}", fake.zone(ZONE, b.id).id).replace("{account}", b.id);
    const refused = await call(fake, TOKEN_B, method, at);
    expect([refused.status, ...codes(refused)]).toEqual([403, 10000]);
    const granted = await call(fake, full, method, at);
    expect(granted.status).not.toBe(403);
  });

  it("fails one request with a fault, after carrying it out when asked", async () => {
    const { fake, b, clientB } = setup();
    fake.faults.push({ match: "POST /zones", reply: { status: 500 }, applied: true });
    expect((await rejection(clientB.createZone(b.id, ZONE))).message).toBe(
      `Cloudflare could not create the zone ${ZONE}: HTTP 500.`,
    );
    expect(fake.zone(ZONE, "New").status).toBe("pending");
    expect(fake.calls.at(-1)).toMatchObject({ method: "POST", path: "/zones", status: 500 });
    expect(await clientB.findZone(ZONE)).toMatchObject({ status: "pending" });
  });
});
