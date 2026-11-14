import {
  buildCsr,
  fingerprintSha256,
  generateP256,
  OpsCrewError,
  selfSignedClientCertificate,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  type AccountPermissionNeed,
  CLOUDFLARE_API,
  CloudflareClient,
  CloudflareError,
  type ZonePermissionNeed,
} from "../client";
import { applyShared, inspectShared, planShared, type SharedRecord } from "../shared";
import {
  type FakeCloudflareAccounts,
  type FakeCloudflarePermission,
  fakeCloudflareAccounts,
} from "./index";

const TOKEN_A = fakeSecret("cloudflare-token", "account-a");
const TOKEN_B = fakeSecret("cloudflare-token", "account-b");
const ZONE = "example.com";
const TUNNEL = "00000000-0000-4000-8000-0000000000aa";

/** Account A holds example.com, active; account B is empty. */
function setup(denied: FakeCloudflarePermission[] = []) {
  const fake = fakeCloudflareAccounts({
    accounts: [
      { name: "Old", token: TOKEN_A },
      { name: "New", token: TOKEN_B, denied },
    ],
    zones: [{ name: ZONE, account: "Old" }],
  });
  return {
    fake,
    a: fake.account("Old"),
    b: fake.account("New"),
    zoneA: fake.zone(ZONE, "Old"),
    clientA: clientOf(fake, TOKEN_A),
    clientB: clientOf(fake, TOKEN_B),
  };
}

const clientOf = (fake: FakeCloudflareAccounts, token: string) =>
  new CloudflareClient({ token, fetch: fake.fetch, sleep: async () => {} });

interface Answer {
  status: number;
  success: boolean;
  errors: { code: number; message: string }[];
  result: unknown;
  result_info?: Record<string, unknown>;
}

/** A request with `token` as Cloudflare's API gets it, and the answer's JSON. */
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

/** A request the fake does not answer: it throws rather than answer "not found". */
const unanswered = (fake: FakeCloudflareAccounts, token: string, method: string, path: string) =>
  expect(
    fake.fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    }),
  ).rejects.toThrow("fake cloudflare");

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
    expect(await clientB.getZone(zoneB.id)).toEqual(zoneB);

    // A's token on B's zone, on B's account pieces, and adding a zone to B: refused, never absent.
    b.tunnels.push({ id: TUNNEL, name: "example-app", connections: [] });
    expect(await rejection(clientA.getZone(zoneB.id))).toBeInstanceOf(CloudflareError);
    expect(await rejection(clientA.listZoneRecords(zoneB.id))).toBeInstanceOf(CloudflareError);
    expect(await rejection(clientA.tunnelConnections(b.id, TUNNEL))).toBeInstanceOf(
      CloudflareError,
    );
    expect(await rejection(clientA.accessOrganization(b.id))).toBeInstanceOf(CloudflareError);
    expect((await rejection(clientA.createZone(b.id, "example.org"))).code).toBe(
      "CREDENTIALS_INVALID",
    );
    for (const path of [`/zones/${zoneB.id}/dns_records`, `/accounts/${b.id}/cfd_tunnel`]) {
      const refused = await call(fake, TOKEN_A, "GET", path);
      expect([refused.status, ...codes(refused)]).toEqual([403, 9109]);
    }
    // Workers paths as feature 016's spike saw them for another account.
    const workers = await call(fake, TOKEN_A, "GET", `/accounts/${b.id}/workers/scripts`);
    expect([workers.status, ...codes(workers)]).toEqual([404, 7003]);
    expect(fake.zones.map((z) => z.name)).toEqual([ZONE, ZONE]);

    // A token Cloudflare does not know.
    const unknown = fakeSecret("cloudflare-token", "unknown");
    const refused = await call(fake, unknown, "GET", "/zones");
    expect([refused.status, ...codes(refused)]).toEqual([401, 1000]);
    expect(await clientOf(fake, unknown).verifyToken()).toMatchObject({ ok: false });
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

  it("lists the zones a token sees by name and account, page by page", async () => {
    const { fake, a, b, clientB } = setup();
    const both = fakeSecret("cloudflare-token", "both");
    fake.tokens.set(both, { accounts: [a.id, b.id], denied: new Set() });
    const clientBoth = clientOf(fake, both);
    const zoneB = await clientB.createZone(b.id, ZONE);
    const zoneA = fake.zone(ZONE, a.id);

    expect(await clientBoth.findZone(`shop.${ZONE}`)).toMatchObject({ id: zoneA.id });
    expect(await clientBoth.findZone(`shop.${ZONE}`, { accountId: b.id })).toMatchObject({
      id: zoneB.id,
      status: "pending",
    });
    const ids = (answer: Answer) => result<{ id: string }[]>(answer).map((z) => z.id);
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
    expect(result(await call(fake, both, "GET", `/zones/${zoneB.id}`))).toMatchObject({
      account: { id: b.id, name: "New" },
      plan: { legacy_id: "free" },
      activated_on: null,
    });
    await expect(
      fake.fetch(`${CLOUDFLARE_API}/zones?name=${ZONE}&status=active`, {
        headers: { Authorization: `Bearer ${both}` },
      }),
    ).rejects.toThrow("/zones does not take the query parameter status");
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

    await clientB.deleteZone(zoneB.id);
    expect(fake.zones).toEqual([zoneA]);
    const gone = await call(fake, TOKEN_B, "GET", `/zones/${zoneB.id}`);
    expect([gone.status, ...codes(gone)]).toEqual([404, 7003]);

    // A's hold keeps the zone out of B until A releases it.
    expect(await clientA.zoneHold(zoneA.id)).toEqual({ hold: false });
    zoneA.hold = { hold: true, include_subdomains: false };
    expect(await clientA.zoneHold(zoneA.id)).toEqual({ hold: true });
    expect((await rejection(clientB.createZone(b.id, ZONE))).message).toContain(
      "is on hold in another account",
    );
    zoneA.hold = { hold: false, include_subdomains: false };
    expect(await clientB.createZone(b.id, ZONE)).toMatchObject({ status: "pending" });
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
    expect(await clientA.getZone(zoneA.id)).toMatchObject({ status: "moved" });
    expect(await clientB.getZone(zoneB.id)).toMatchObject({ status: "active" });
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
    expect(await clientB.getZone(zoneB.id)).toMatchObject({ status: "moved" });
  });

  it("turns DNSSEC on as pending with its DS record, until a test makes it active", async () => {
    const { zoneA, clientA } = setup();
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
    const [mx, srv, docs] = zoneA.records;
    expect(await clientA.listZoneRecords(zoneA.id)).toEqual([
      {
        id: mx?.id,
        type: "MX",
        name: ZONE,
        content: "mail.example.net",
        ttl: 1,
        proxied: false,
        priority: 10,
        meta: {},
      },
      {
        id: srv?.id,
        type: "SRV",
        name: `_sip._tcp.${ZONE}`,
        content: "",
        data: { priority: 10, weight: 5, port: 5060, target: "sip.example.net" },
        ttl: 3600,
        proxied: false,
        comment: "phones",
        meta: {},
      },
      {
        id: docs?.id,
        type: "AAAA",
        name: `docs.${ZONE}`,
        content: "100::",
        ttl: 1,
        proxied: true,
        meta: { read_only: true, origin_worker_id: "docs" },
      },
    ]);
    const listed = result<Record<string, unknown>[]>(
      await call(fake, TOKEN_A, "GET", `/zones/${zoneA.id}/dns_records?per_page=1`),
    );
    expect(listed).toEqual([
      expect.objectContaining({ zone_id: zoneA.id, zone_name: ZONE, proxiable: false, tags: [] }),
    ]);
    expect(
      (await clientA.listDnsRecords(zoneA.id, { type: "MX", name: ZONE })).map((r) => r.type),
    ).toEqual(["MX"]);

    for (let i = 0; i < 120; i++) {
      fake.addRecord(zoneA, { type: "TXT", name: `t${i}`, content: `"v${i}"` });
    }
    expect(await clientA.listZoneRecords(zoneA.id)).toHaveLength(123);
    expect(fake.calls.filter((c) => c.path.includes("dns_records?page=2"))).toHaveLength(1);
  });

  it("creates records in one batch transaction, refusing what Cloudflare refuses, and deletes them", async () => {
    const { fake, b, zoneA, clientA, clientB } = setup();
    const created = await clientB.createZone(b.id, ZONE);
    const zoneB = fake.zone(ZONE, "New");
    fake.addRecord(zoneA, {
      type: "CNAME",
      name: "www",
      content: ZONE,
      proxied: true,
      comment: "the user's own",
    });
    fake.addRecord(zoneA, {
      type: "CAA",
      name: "@",
      data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
      ttl: 300,
    });
    // A's records copied into B with every field.
    const fromA = await clientA.listZoneRecords(zoneA.id);
    const ids = await clientB.createZoneRecords(
      created.id,
      fromA.map(({ id: _id, meta: _meta, ...record }) => record),
    );
    expect(ids).toEqual(zoneB.records.map((r) => r.id));
    expect((await clientB.listZoneRecords(created.id)).map(({ id: _id, ...r }) => r)).toEqual(
      fromA.map(({ id: _id, ...r }) => r),
    );

    const post = { type: "TXT", name: `t.${ZONE}`, content: '"x"', ttl: 1 };
    const refusals: [unknown, number][] = [
      [
        {
          type: "CNAME",
          name: `www.${ZONE}`,
          content: ZONE,
          ttl: 1,
          proxied: true,
          comment: "the user's own",
        },
        81058,
      ],
      [{ type: "A", name: `www.${ZONE}`, content: "203.0.113.10", ttl: 1 }, 81053],
      [{ ...post, proxied: true }, 9004],
    ];
    const batch = (posts: unknown[]) =>
      call(fake, TOKEN_B, "POST", `/zones/${created.id}/dns_records/batch`, { posts });
    for (const [record, code] of refusals) {
      // One refused post leaves the whole batch undone.
      const refused = await batch([post, record]);
      expect([refused.status, ...codes(refused)]).toEqual([400, code]);
      expect(zoneB.records).toHaveLength(2);
    }
    // 200 changes a call on the Free plan.
    const many = Array.from({ length: 201 }, (_, i) => ({ ...post, name: `m${i}.${ZONE}` }));
    expect((await batch(many)).status).toBe(400);
    expect((await batch(many.slice(0, 200))).success).toBe(true);
    await expect(
      fake.fetch(`${CLOUDFLARE_API}/zones/${created.id}/dns_records/batch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN_B}` },
        body: JSON.stringify({ deletes: [{ id: ids[0] }] }),
      }),
    ).rejects.toThrow("only its posts are answered");

    await clientB.deleteRecord(created.id, ids[0] ?? "");
    expect(zoneB.records.some((r) => r.id === ids[0])).toBe(false);
    const missing = await call(
      fake,
      TOKEN_B,
      "DELETE",
      `/zones/${created.id}/dns_records/${ids[0]}`,
    );
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
    const inspect = (record: SharedRecord | undefined, pendingZone: boolean) =>
      inspectShared(clientB, {
        zoneId: created.id,
        accountId: b.id,
        access: false,
        tls: { proxied: hosts, record },
        pendingZone,
      });
    const plan = planShared(await inspect(undefined, true), desired, undefined);
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
    // The pending zone's plan settles: its deploying settings count as on.
    const again = planShared(await inspect(applied.record, true), desired, applied.record);
    expect(again).toMatchObject({ changes: [], findings: [], record: applied.record });
    // Not on an active zone: a setting still deploying there is turned on again and waited for.
    const active = planShared(await inspect(applied.record, false), desired, applied.record);
    expect(active.changes).toEqual([
      {
        kind: "enable-client-certificate",
        hostnames: hosts,
        sha256: fingerprintSha256(clientCertificate),
      },
    ]);
    fake.activate(zoneB);
    expect(await status()).toEqual(Array(3).fill("active"));
    const deployed = planShared(await inspect(applied.record, false), desired, applied.record);
    expect(deployed).toMatchObject({ changes: [], findings: [], record: applied.record });

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
  it("answers tunnels with their connections, and their secret's change", async () => {
    const { fake, b, clientB } = setup();
    b.tunnels.push({ id: TUNNEL, name: "example-app", connections: [] });
    expect(await clientB.tunnelConnections(b.id, TUNNEL)).toBe("closed");
    b.tunnels[0]?.connections.push({
      id: "conn-1",
      colo_name: "fra08",
      opened_at: fake.now.toISOString(),
      origin_ip: "203.0.113.10",
    });
    expect(await clientB.tunnelConnections(b.id, TUNNEL)).toBe("active");
    const listed = await call(fake, TOKEN_B, "GET", `/accounts/${b.id}/cfd_tunnel?per_page=1`);
    expect(result(listed)).toEqual([
      expect.objectContaining({
        id: TUNNEL,
        status: "healthy",
        connections: [expect.objectContaining({ origin_ip: "203.0.113.10" })],
      }),
    ]);

    const secret = Buffer.alloc(32, 7).toString("base64");
    const token = await clientB.rotateTunnelSecret(b.id, TUNNEL, secret);
    expect(JSON.parse(Buffer.from(token, "base64").toString())).toEqual({
      a: b.id,
      t: TUNNEL,
      s: secret,
    });

    const unknownTunnel = "00000000-0000-4000-8000-0000000000bb";
    expect(await clientB.tunnelConnections(b.id, unknownTunnel)).toBe("gone");
    if (b.tunnels[0]) b.tunnels[0].deleted_at = fake.now.toISOString();
    expect(await clientB.tunnelConnections(b.id, TUNNEL)).toBe("gone");
    await unanswered(fake, TOKEN_B, "GET", `/accounts/${b.id}/cfd_tunnel/${TUNNEL}/configurations`);
    await unanswered(fake, TOKEN_B, "GET", `/accounts/${b.id}/cfd_tunnel?name=example-app`);
    await unanswered(fake, TOKEN_B, "POST", `/accounts/${b.id}/cfd_tunnel`);
  });

  it("answers Access: the organization and login methods it creates, and the applications, policies and service tokens a test seeds", async () => {
    const { fake, b, clientB } = setup();
    const access = `/accounts/${b.id}/access`;
    expect(await clientB.accessOrganization(b.id)).toBeUndefined();
    const auth = "example-team.cloudflareaccess.com";
    expect(await clientB.createAccessOrganization(b.id, auth)).toEqual({ authDomain: auth });
    expect(await clientB.accessOrganization(b.id)).toEqual({ authDomain: auth });
    await rejection(clientB.createAccessOrganization(b.id, auth));
    const pin = await clientB.createOneTimePinProvider(b.id);
    expect(await clientB.accessIdentityProviders(b.id)).toEqual([{ id: pin, type: "onetimepin" }]);

    const app = { id: "app-1", name: "example-app ssh", domain: `ssh-shop.${ZONE}` };
    const policy = { id: "policy-1", name: "deploy", decision: "non_identity" };
    const secret = fakeSecret("generic-password", "service token");
    b.accessApps.push(app);
    b.accessPolicies.push(policy);
    b.serviceTokens.push({
      id: "token-1",
      name: "example-app deploy",
      client_id: "0123456789abcdef0123456789abcdef.access",
      client_secret: secret,
      duration: "8760h",
      created_at: fake.now.toISOString(),
      expires_at: fake.now.toISOString(),
    });
    expect(
      await clientB.accountPermissions(b.id, [
        "access-apps",
        "access-service-tokens",
        "access-organization",
      ]),
    ).toEqual({ missing: [] });
    expect(result(await call(fake, TOKEN_B, "GET", `${access}/apps`))).toEqual([app]);
    expect(result(await call(fake, TOKEN_B, "GET", `${access}/policies`))).toEqual([policy]);
    const tokens = await call(fake, TOKEN_B, "GET", `${access}/service_tokens`);
    expect(result(tokens)).toEqual([expect.objectContaining({ id: "token-1" })]);
    expect(JSON.stringify(tokens)).not.toContain(secret);
    for (const list of ["apps", "policies", "service_tokens", "identity_providers"]) {
      await unanswered(fake, TOKEN_B, "GET", `${access}/${list}?name=x`);
    }
    await unanswered(fake, TOKEN_B, "GET", `${access}/apps/app-1`);
    await unanswered(fake, TOKEN_B, "DELETE", `${access}/service_tokens/token-1`);
  });

  it("answers R2 buckets per account, page by page", async () => {
    const { fake, a, b, clientB } = setup();
    a.buckets.push({ name: "example-app-files" });
    b.buckets.push({ name: "example-app-files" }, { name: "example-app-backups" });
    expect(await clientB.accountPermissions(b.id, ["r2"])).toEqual({ missing: [] });
    const page = (query: string) =>
      call(fake, TOKEN_B, "GET", `/accounts/${b.id}/r2/buckets${query}`);
    const first = await page("?per_page=1");
    expect(result(first)).toEqual({ buckets: [{ name: "example-app-files" }] });
    expect(first.result_info).toEqual({ cursor: "1", per_page: 1 });
    const second = await page("?per_page=1&cursor=1");
    expect(result(second)).toEqual({ buckets: [{ name: "example-app-backups" }] });
    expect(second.result_info).toEqual({ cursor: "", per_page: 1 });
    await unanswered(fake, TOKEN_B, "POST", `/accounts/${b.id}/r2/buckets`);
    await unanswered(fake, TOKEN_B, "GET", `/accounts/${b.id}/r2/buckets/example-app-files`);
  });

  it("answers Workers scripts, their subdomain, and custom domains attached by zone once it is active", async () => {
    const { fake, a, b, clientB } = setup();
    const created = await clientB.createZone(b.id, ZONE);
    const zoneB = fake.zone(ZONE, "New");
    b.workers.set("docs", {});
    expect(await clientB.workersPermissions(b.id)).toEqual({ missing: [] });
    const scripts = `/accounts/${b.id}/workers/scripts`;
    expect(result(await call(fake, TOKEN_B, "GET", scripts))).toEqual([{ id: "docs" }]);
    const subdomain = `${scripts}/docs/subdomain`;
    expect(result(await call(fake, TOKEN_B, "GET", subdomain))).toEqual({
      enabled: false,
      previews_enabled: false,
    });
    await call(fake, TOKEN_B, "POST", subdomain, { enabled: true });
    expect(b.workers.get("docs")?.subdomain).toEqual({ enabled: true, previews_enabled: false });
    const missing = await call(fake, TOKEN_B, "GET", `${scripts}/api/subdomain`);
    expect([missing.status, ...codes(missing)]).toEqual([404, 10007]);
    await unanswered(fake, TOKEN_B, "GET", `${scripts}?per_page=1`);
    await unanswered(fake, TOKEN_B, "GET", `${scripts}/docs/settings`);
    await unanswered(fake, TOKEN_B, "DELETE", `${scripts}/docs`);

    const attach = (hostname: string, service = "docs") =>
      clientB.attachWorkerDomain(b.id, { hostname, zoneId: created.id, service });
    expect((await rejection(attach(`docs.${ZONE}`))).message).toContain("is not active yet");
    fake.activate(zoneB);
    fake.addRecord(zoneB, {
      type: "CNAME",
      name: "www.docs",
      content: `docs.${ZONE}`,
      proxied: true,
    });
    expect((await rejection(attach(`www.docs.${ZONE}`))).message).toContain(
      "already has externally managed DNS records",
    );
    expect((await rejection(attach(`api.${ZONE}`, "api"))).message).toContain(
      "This Worker does not exist on your account",
    );

    const id = await attach(`docs.${ZONE}`);
    expect(zoneB.records.find((r) => r.name === `docs.${ZONE}`)).toMatchObject({
      type: "AAAA",
      content: "100::",
      proxied: true,
      meta: { read_only: true, origin_worker_id: "docs" },
    });
    expect(await clientB.listZoneWorkerDomains(b.id, created.id)).toEqual([
      { id, hostname: `docs.${ZONE}`, zoneId: created.id, service: "docs" },
    ]);
    expect(await clientB.listWorkerCustomDomains(b.id, "docs")).toEqual([
      { hostname: `docs.${ZONE}`, zoneId: created.id },
    ]);
    expect(await clientB.listZoneWorkerDomains(b.id, a.id)).toEqual([]);

    await clientB.detachWorkerDomain(b.id, id);
    expect(b.workerDomains).toEqual([]);
    expect(zoneB.records.map((r) => r.name)).toEqual([`www.docs.${ZONE}`]);
    await unanswered(fake, TOKEN_B, "GET", `/accounts/${b.id}/workers/domains/${id}`);
  });
});

describe("fakeCloudflareAccounts: permissions and faults", () => {
  const accountNeeds: AccountPermissionNeed[] = [
    "tunnel",
    "access-apps",
    "access-service-tokens",
    "access-organization",
    "r2",
    "workers",
  ];
  const zoneNeeds: ZonePermissionNeed[] = [
    "dns",
    "ssl",
    "settings",
    "http_config_settings",
    "http_request_firewall_custom",
    "http_request_dynamic_redirect",
  ];

  /** B with its pending zone, its token without `permission`, and a token with every permission. */
  function denying(permission: FakeCloudflarePermission) {
    const fake = fakeCloudflareAccounts({
      accounts: [{ name: "New", token: TOKEN_B, denied: [permission] }],
      zones: [{ name: ZONE, account: "New", status: "pending" }],
    });
    const b = fake.account("New");
    const full = fakeSecret("cloudflare-token", "account-b-full");
    fake.tokens.set(full, { accounts: [b.id], denied: new Set() });
    return {
      fake,
      b,
      zone: fake.zone(ZONE, b.id),
      denied: clientOf(fake, TOKEN_B),
      full: clientOf(fake, full),
    };
  }

  it.each(accountNeeds)("withholds %s from one token only, as its probe finds", async (need) => {
    const { b, denied, full } = denying(need);
    expect((await denied.accountPermissions(b.id, [need])).missing).toHaveLength(1);
    expect(
      await denied.accountPermissions(
        b.id,
        accountNeeds.filter((n) => n !== need),
      ),
    ).toEqual({
      missing: [],
    });
    expect(await full.accountPermissions(b.id, accountNeeds)).toEqual({ missing: [] });
  });

  it.each(zoneNeeds)("withholds %s from one token only, as its probe finds", async (need) => {
    const { zone, denied, full } = denying(need);
    expect((await denied.zonePermissions(zone.id, [need])).missing).toHaveLength(1);
    expect(
      await denied.zonePermissions(
        zone.id,
        zoneNeeds.filter((n) => n !== need),
      ),
    ).toEqual({
      missing: [],
    });
    expect(await full.zonePermissions(zone.id, zoneNeeds)).toEqual({ missing: [] });
  });

  it("withholds the zone permission: adding, deleting and re-checking zones", async () => {
    const { fake, b, zone, denied } = denying("zone");
    expect((await rejection(denied.createZone(b.id, "example.org"))).code).toBe(
      "CREDENTIALS_INVALID",
    );
    expect((await rejection(denied.activationCheck(zone.id))).code).toBe("CREDENTIALS_INVALID");
    expect((await rejection(denied.deleteZone(zone.id))).code).toBe("CREDENTIALS_INVALID");
    expect(await denied.getZone(zone.id)).toMatchObject({ status: "pending" });
    expect(fake.zones).toHaveLength(1);
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
