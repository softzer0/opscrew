import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_API,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  CloudflareClient,
  CloudflareError,
  OPSCREW_MANAGED_COMMENT,
  zoneCandidates,
} from "./client";
import { cloudflareConnector } from "./connector";

const TOKEN = fakeSecret("cloudflare-token");

/** Fake Cloudflare API routed by "path?query" prefix; each route may be a queue. */
const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: CLOUDFLARE_API });

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
  body: { success: true, errors: [], messages: [], result, ...extra },
});
const fail = (status: number, errors: { code?: number; message: string }[]) => ({
  status,
  body: { success: false, errors, messages: [], result: null },
});
const noSleep = async () => {};

describe("zoneCandidates", () => {
  it("lists the domain and its parents, most specific first", () => {
    expect(zoneCandidates("App.Example.co.uk.")).toEqual([
      "app.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
    expect(zoneCandidates("localhost")).toEqual([]);
  });
});

describe("CloudflareClient", () => {
  it("verifies an active user token", async () => {
    const { fetch, calls } = fakeFetch({ "/user/tokens/verify": ok({ status: "active" }) });
    const check = await new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep }).verifyToken();
    expect(check).toMatchObject({ ok: true, identity: "user API token" });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("accepts account tokens that can list zones", async () => {
    const { fetch } = fakeFetch({
      "/user/tokens/verify": {
        status: 401,
        body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] },
      },
      "/zones?per_page=1": ok([]),
    });
    const check = await new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep }).verifyToken();
    expect(check).toMatchObject({ ok: true, identity: "account API token" });
  });

  it("rejects bad tokens with the permissions to create", async () => {
    const denied = {
      status: 403,
      body: { success: false, errors: [{ code: 9109, message: "Unauthorized" }] },
    };
    const { fetch } = fakeFetch({ "/user/tokens/verify": denied, "/zones": denied });
    const check = await new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep }).verifyToken();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("DNS → Edit");
    expect(check.message).not.toContain(TOKEN);
  });

  it("finds the zone by walking up the domain", async () => {
    const { fetch, calls } = fakeFetch({
      "/zones?name=app.example.com": ok([]),
      "/zones?name=example.com": ok([
        {
          id: "z1",
          name: "example.com",
          status: "active",
          name_servers: ["a.ns.cloudflare.com"],
          account: { id: "acc-1", name: "Main" },
        },
      ]),
    });
    const zone = await new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep }).findZone(
      "app.example.com",
    );
    expect(zone).toEqual({
      id: "z1",
      name: "example.com",
      status: "active",
      nameServers: ["a.ns.cloudflare.com"],
      accountId: "acc-1",
    });
    expect(calls).toHaveLength(2);
  });

  it("returns undefined when no zone matches", async () => {
    const { fetch } = fakeFetch({ "/zones?name=": ok([]) });
    expect(
      await new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep }).findZone(
        "a.b.example.org",
      ),
    ).toBeUndefined();
  });

  it("lists DNS records across pages with filters", async () => {
    const record = (id: string) => ({
      id,
      type: "A",
      name: "app.example.com",
      content: "203.0.113.10",
      proxied: true,
      ttl: 1,
    });
    const { fetch, calls } = fakeFetch({
      "/zones/z1/dns_records?page=1": ok([record("r1")], {
        result_info: { page: 1, total_pages: 2 },
      }),
      "/zones/z1/dns_records?page=2": ok([record("r2")], {
        result_info: { page: 2, total_pages: 2 },
      }),
    });
    const records = await new CloudflareClient({
      token: TOKEN,
      fetch,
      sleep: noSleep,
    }).listDnsRecords("z1", { name: "app.example.com", type: "A" });
    expect(records.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(calls[0]?.url).toContain("name=app.example.com");
    expect(calls[0]?.url).toContain("type=A");
  });

  it("keeps record comments and maps a refused DNS read to the permissions hint", async () => {
    const record = { type: "A", name: "a.example.com", ttl: 1 };
    const { fetch } = fakeFetch({
      "/zones/z1/dns_records": ok([
        { ...record, id: "r1", content: "203.0.113.10", comment: "Managed by OpsCrew" },
        { ...record, id: "r2", content: "198.51.100.7", comment: null },
      ]),
      "/zones/z2/dns_records": {
        status: 403,
        body: { success: false, errors: [{ message: "Authentication error" }] },
      },
    });
    const client = new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep });
    const records = await client.listDnsRecords("z1", { name: "a.example.com" });
    expect(records[0]?.comment).toBe(OPSCREW_MANAGED_COMMENT);
    expect(records[1]).not.toHaveProperty("comment");
    await expect(client.listDnsRecords("z2")).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("DNS → Edit"),
    });
  });

  it("reads IP ranges without a token", async () => {
    const { fetch, calls } = fakeFetch({
      "/ips": ok({ ipv4_cidrs: ["173.245.48.0/20"], ipv6_cidrs: ["2400:cb00::/32"] }),
    });
    const ranges = await new CloudflareClient({ fetch, sleep: noSleep }).getIpRanges();
    expect(ranges).toEqual({ ipv4: ["173.245.48.0/20"], ipv6: ["2400:cb00::/32"] });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("retries rate limits and server errors", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch({
      "/ips": [
        { status: 429, body: { success: false, errors: [] }, headers: { "retry-after": "2" } },
        { status: 502, body: { success: false, errors: [] } },
        ok({ ipv4_cidrs: [], ipv6_cidrs: [] }),
      ],
    });
    await new CloudflareClient({ fetch, sleep: async (ms) => void waits.push(ms) }).getIpRanges();
    expect(calls).toHaveLength(3);
    expect(waits[0]).toBe(2000);
  });

  it("maps permission errors to CREDENTIALS_INVALID with a hint", async () => {
    const { fetch } = fakeFetch({
      "/zones?name=": {
        status: 403,
        body: { success: false, errors: [{ message: "Authentication error" }] },
      },
    });
    await expect(
      new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep }).findZone("example.com"),
    ).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("api-tokens"),
    });
  });

  it("requires a token for authenticated calls", async () => {
    const { fetch } = fakeFetch({});
    await expect(
      new CloudflareClient({ fetch, sleep: noSleep }).findZone("example.com"),
    ).rejects.toMatchObject({ code: "CREDENTIALS_MISSING" });
  });

  it("gives every attempt a timeout and retries a read that never answers", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch({ "/zones?name=": { hang: true } });
    const client = new CloudflareClient({
      token: TOKEN,
      fetch,
      sleep: async (ms) => void waits.push(ms),
      timeoutMs: 5,
    });
    const error = (await client.findZone("example.com").catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not answer within");
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2000, 4000]);
  });
});

describe("CloudflareClient ruleset and Zero Trust writes", () => {
  const ENTRYPOINT = "/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint";
  const RULE = "/zones/z1/rulesets/rs1/rules/r1";
  const rule = {
    ref: "opscrew-strict-tls",
    description: "OpsCrew: verify the origin certificate (Full (strict) TLS)",
    expression: '(http.host in {"example.com"})',
    action: "set_config",
    action_parameters: { ssl: "strict" },
    enabled: true,
  };
  const client = (routes: Record<string, FakeReply | FakeReply[]>, timeoutMs?: number) => {
    const fake = fakeFetch(routes);
    return {
      calls: fake.calls,
      api: new CloudflareClient({
        token: TOKEN,
        fetch: fake.fetch,
        sleep: noSleep,
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
    };
  };

  it("reads an entrypoint with its rules, a missing one, and a refused read", async () => {
    const { api } = client({
      [ENTRYPOINT]: [
        ok({
          id: "rs1",
          name: "default",
          rules: [
            { id: "u1", ref: "u1", action: "block", expression: "(cf.client.bot)", enabled: false },
            { ...rule, id: "r1", version: "2", last_updated: "2026-10-17T00:00:00Z" },
          ],
        }),
        fail(404, [{ code: 10003, message: "could not find entrypoint ruleset" }]),
        fail(404, [{ code: 7003, message: "Could not route" }]),
        fail(403, [{ code: 10000, message: "Authentication error" }]),
      ],
    });
    expect(await api.entrypointRuleset("z1", "http_request_firewall_custom")).toEqual({
      id: "rs1",
      rules: [
        { id: "u1", ref: "u1", action: "block", expression: "(cf.client.bot)", enabled: false },
        {
          id: "r1",
          ref: "opscrew-strict-tls",
          action: "set_config",
          expression: '(http.host in {"example.com"})',
          actionParameters: { ssl: "strict" },
          enabled: true,
        },
      ],
    });
    expect(await api.entrypointRuleset("z1", "http_request_firewall_custom")).toBeUndefined();
    await expect(api.entrypointRuleset("z1", "http_request_firewall_custom")).rejects.toMatchObject(
      { code: "PROVIDER_ERROR" },
    );
    expect(await api.entrypointRuleset("z1", "http_request_firewall_custom")).toBe("forbidden");
  });

  it("sends each kind of ruleset write once to its endpoint", async () => {
    const ruleset = ok({ id: "rs1", rules: [{ ...rule, id: "r1" }] });
    const { api, calls } = client({
      [`PUT ${ENTRYPOINT}`]: ruleset,
      "POST /zones/z1/rulesets/rs1/rules": ruleset,
      [`PATCH ${RULE}`]: ruleset,
      [`DELETE ${RULE}`]: ok({ id: "rs1", rules: [] }),
      "DELETE /zones/z1/rulesets/rs1": { status: 204 },
    });
    await api.createEntrypointRuleset("z1", "http_request_firewall_custom", rule);
    await api.addRulesetRule("z1", "rs1", rule);
    await api.updateRulesetRule("z1", "rs1", "r1", rule);
    expect(await api.deleteRulesetRule("z1", "rs1", "r1")).toEqual({ id: "rs1", rules: [] });
    await api.deleteRuleset("z1", "rs1");
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", ENTRYPOINT, { rules: [rule] }],
      ["POST", "/zones/z1/rulesets/rs1/rules", rule],
      ["PATCH", RULE, rule],
      ["DELETE", RULE, undefined],
      ["DELETE", "/zones/z1/rulesets/rs1", undefined],
    ]);
  });

  it("never sends a write again after a 5xx, a timeout or a lost connection", async () => {
    for (const reply of [
      { status: 503, body: { success: false, errors: [] } },
      { hang: true },
      { error: new TypeError("fetch failed") },
      { status: 200, body: { success: true, errors: [], result: { rules: "?" } } },
    ] satisfies FakeReply[]) {
      const { api, calls } = client({ [`PATCH ${RULE}`]: reply }, 5);
      const error = await api.updateRulesetRule("z1", "rs1", "r1", rule).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "PROVIDER_ERROR",
        message: expect.stringContaining("The change may still have reached Cloudflare."),
        hint: expect.stringContaining("Run the command again"),
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("reports a clear refusal of a write as one", async () => {
    const { api, calls } = client({
      "POST /zones/z1/rulesets/rs1/rules": fail(400, [{ code: 20023, message: "duplicate ref" }]),
    });
    const error = (await api.addRulesetRule("z1", "rs1", rule).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      'Cloudflare could not add the rule "OpsCrew: verify the origin certificate (Full (strict) TLS)": duplicate ref.',
    );
    expect(calls).toHaveLength(1);
  });

  it("creates the Zero Trust organization and the one-time PIN login method", async () => {
    const { api, calls } = client({
      "POST /accounts/acc-1/access/organizations": ok({
        name: "team.cloudflareaccess.com",
        auth_domain: "team.cloudflareaccess.com",
      }),
      "POST /accounts/acc-1/access/identity_providers": ok({
        id: "idp-1",
        name: "One-time PIN",
        type: "onetimepin",
        config: {},
      }),
    });
    expect(await api.createAccessOrganization("acc-1", "team.cloudflareaccess.com")).toEqual({
      authDomain: "team.cloudflareaccess.com",
    });
    expect(await api.createOneTimePinProvider("acc-1")).toBe("idp-1");
    expect(calls.map((c) => c.body)).toEqual([
      { name: "team.cloudflareaccess.com", auth_domain: "team.cloudflareaccess.com" },
      { name: "One-time PIN", type: "onetimepin", config: {} },
    ]);
  });
});

describe("CloudflareClient Zero Trust reads", () => {
  const ORG = "/accounts/acc-1/access/organizations";
  const IDPS = "/accounts/acc-1/access/identity_providers";
  const TUNNEL = "/accounts/acc-1/cfd_tunnel/t-1";
  const client = (routes: Record<string, FakeReply | FakeReply[]>) => {
    const fake = fakeFetch(routes);
    return {
      ...fake,
      cf: new CloudflareClient({ token: TOKEN, fetch: fake.fetch, sleep: noSleep }),
    };
  };

  it("reads the account's Zero Trust organization, or none", async () => {
    const { cf } = client({
      [ORG]: [
        ok({ auth_domain: "shop.cloudflareaccess.com", name: "shop" }),
        ok(null),
        fail(404, [{ code: 7003, message: "Not Found" }]),
        fail(400, [{ code: 12130, message: "access.api.error.not_found: organization not found" }]),
      ],
    });
    expect(await cf.accessOrganization("acc-1")).toEqual({
      authDomain: "shop.cloudflareaccess.com",
    });
    expect(await cf.accessOrganization("acc-1")).toBeUndefined();
    expect(await cf.accessOrganization("acc-1")).toBeUndefined();
    expect(await cf.accessOrganization("acc-1")).toBeUndefined();
  });

  it("stops plainly when Access is off, the token is refused or the organization has no team domain", async () => {
    const { cf } = client({
      [ORG]: [
        fail(403, [{ code: 9999, message: "access.api.error.not_enabled" }]),
        fail(403, [{ code: 10000, message: "Authentication error" }]),
        ok({ name: "shop" }),
      ],
    });
    const off = (await cf.accessOrganization("acc-1").catch((e: unknown) => e)) as OpsCrewError;
    expect(off.code).toBe("PHASE_PRECONDITION");
    expect(off.message).toContain("Cloudflare Access is not turned on");
    expect(off.hint).toContain("https://one.dash.cloudflare.com/");
    const refused = (await cf.accessOrganization("acc-1").catch((e: unknown) => e)) as OpsCrewError;
    expect(refused.code).toBe("CREDENTIALS_INVALID");
    expect(refused.hint).toContain("Access: Organizations, Identity Providers, and Groups");
    const unreadable = (await cf
      .accessOrganization("acc-1")
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(unreadable.code).toBe("PROVIDER_ERROR");
    expect(`${refused.message} ${refused.hint}`).not.toContain(TOKEN);
  });

  it("lists the account's Access login methods", async () => {
    const { cf, calls } = client({
      [IDPS]: [
        ok([
          { id: "idp-1", type: "onetimepin", name: "PIN", config: {} },
          { id: "idp-2", type: "github", name: "GitHub" },
        ]),
        ok(null),
        fail(403, [{ code: 10000, message: "Authentication error" }]),
      ],
    });
    expect(await cf.accessIdentityProviders("acc-1")).toEqual([
      { id: "idp-1", type: "onetimepin" },
      { id: "idp-2", type: "github" },
    ]);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(await cf.accessIdentityProviders("acc-1")).toEqual([]);
    await expect(cf.accessIdentityProviders("acc-1")).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
    });
  });

  it("reads whether a tunnel still has connections, keeping only the state", async () => {
    const tunnel = (fields: Record<string, unknown>) => ok({ id: "t-1", name: "shop", ...fields });
    const { cf } = client({
      [TUNNEL]: [
        tunnel({ status: "healthy", connections: [{ origin_ip: "203.0.113.10" }] }),
        tunnel({ status: "inactive", connections: [] }),
        tunnel({ conns_active_at: "2026-10-16T10:00:00Z", conns_inactive_at: null }),
        tunnel({ conns_active_at: null }),
        tunnel({ deleted_at: "2026-10-16T10:05:00Z" }),
        fail(404, [{ code: 1003, message: "Tunnel not found" }]),
        fail(403, [{ code: 10000, message: "Authentication error" }]),
      ],
    });
    expect(await cf.tunnelConnections("acc-1", "t-1")).toBe("active");
    expect(await cf.tunnelConnections("acc-1", "t-1")).toBe("closed");
    expect(await cf.tunnelConnections("acc-1", "t-1")).toBe("active");
    expect(await cf.tunnelConnections("acc-1", "t-1")).toBe("closed");
    expect(await cf.tunnelConnections("acc-1", "t-1")).toBe("gone");
    expect(await cf.tunnelConnections("acc-1", "t-1")).toBe("gone");
    await expect(cf.tunnelConnections("acc-1", "t-1")).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("Cloudflare Tunnel"),
    });
  });
});

describe("cloudflareConnector", () => {
  it("exposes the credentials and a client when a token is set", async () => {
    const { fetch } = fakeFetch({ "/user/tokens/verify": ok({ status: "active" }) });
    const connector = cloudflareConnector({
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetch,
      sleep: noSleep,
    });
    expect(connector.credentials.envVars).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(connector.client).toBeInstanceOf(CloudflareClient);
    expect(await connector.verifyCredentials()).toMatchObject({ ok: true });
  });

  it("reports a missing token without throwing", async () => {
    const connector = cloudflareConnector({ env: {}, fetch: fakeFetch({}).fetch });
    expect(connector.client).toBeUndefined();
    expect(await connector.verifyCredentials()).toMatchObject({ ok: false });
  });

  it("gives its client the connector's redactor", async () => {
    // No pattern rules: only registered values are masked.
    const redactor = new Redactor({ rules: [] });
    const privateKey = fakeSecret("private-key-pem");
    const connector = cloudflareConnector({
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetch: fakeFetch({ "/": fail(400, [{ message: "refused" }]) }).fetch,
      sleep: noSleep,
      redactor,
    });
    await connector.client
      ?.uploadHostnameClientCertificate("z1", { certificate: "certificate", privateKey })
      .catch(() => undefined);
    expect(redactor.redact(`key: ${privateKey}`)).not.toContain(privateKey);
    expect(redactor.redact(`token ${TOKEN}`)).not.toContain(TOKEN);
  });
});

describe("CloudflareClient origin TLS calls", () => {
  const AOP = "/zones/z1/origin_tls_client_auth/hostnames";
  const client = (routes: Record<string, FakeReply | FakeReply[]>) => {
    const fake = fakeFetch(routes);
    return {
      ...fake,
      cf: new CloudflareClient({ token: TOKEN, fetch: fake.fetch, sleep: noSleep }),
    };
  };
  const denied = fail(403, [{ code: 10000, message: "Authentication error" }]);
  const accepted = (result: unknown) => ({
    status: 202,
    body: { success: true, errors: [], messages: [], result },
  });
  /** A PEM block around `text` (not a real certificate or key). */
  const pem = (label: string, text: string) =>
    `-----BEGIN ${label}-----\n${Buffer.from(text).toString("base64")}\n-----END ${label}-----\n`;

  it("creates an origin certificate for exact hostnames, for 15 years, with its expiry as an ISO time", async () => {
    const csr = pem("CERTIFICATE REQUEST", "a request");
    const certificate = pem("CERTIFICATE", "a certificate");
    const { cf, calls } = client({
      "POST /certificates": ok({
        id: "1234567890",
        certificate,
        csr,
        expires_on: "2041-10-16 23:53:00 +0000 UTC",
        hostnames: ["app.example.com"],
        request_type: "origin-ecc",
        requested_validity: 5475,
      }),
    });
    expect(
      await cf.createOriginCertificate({ csr, hostnames: ["app.example.com"], days: 5475 }),
    ).toEqual({ id: "1234567890", certificate, expiresOn: "2041-10-16T23:53:00.000Z" });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      [
        "POST",
        "/certificates",
        {
          csr,
          hostnames: ["app.example.com"],
          request_type: "origin-ecc",
          requested_validity: 5475,
        },
      ],
    ]);
  });

  it("lists the zone's origin certificates across pages, leaving out revoked ones, and revokes one", async () => {
    const item = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      hostnames: ["app.example.com"],
      expires_on: "2041-10-16 23:53:00 +0000 UTC",
      request_type: "origin-ecc",
      ...extra,
    });
    const { cf, calls } = client({
      "/certificates?page=1": ok([item("c1"), item("c2", { revoked_at: "2026-10-21T00:00:00Z" })], {
        result_info: { page: 1, total_pages: 2 },
      }),
      "/certificates?page=2": ok([item("c3")], { result_info: { page: 2, total_pages: 2 } }),
      "DELETE /certificates/c1": ok({ id: "c1", revoked_at: "2026-10-21T00:00:00Z" }),
    });
    expect(await cf.listOriginCertificates("z1")).toEqual([
      { id: "c1", hostnames: ["app.example.com"], expiresOn: "2041-10-16T23:53:00.000Z" },
      { id: "c3", hostnames: ["app.example.com"], expiresOn: "2041-10-16T23:53:00.000Z" },
    ]);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("zone_id")).toBe("z1");
    await cf.revokeOriginCertificate("c1");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/certificates/c1" });
  });

  it("uploads a client certificate with its key registered with the redactor first, then lists and deletes it", async () => {
    const certificate = pem("CERTIFICATE", "a client certificate");
    const privateKey = fakeSecret("private-key-pem");
    const redactor = new Redactor({ rules: [] });
    let maskedFirst = false;
    const fake = fakeFetch({
      [`POST ${AOP}/certificates`]: {
        status: 201,
        body: {
          success: true,
          errors: [],
          result: {
            id: "cc1",
            certificate,
            expires_on: "2041-10-16T23:58:23Z",
            issuer: "CN=opscrew-shop",
            status: "pending_deployment",
          },
        },
      },
      [`GET ${AOP}/certificates`]: ok([
        { id: "cc1", certificate, expires_on: "2041-10-16T23:58:23Z", status: "active" },
        { id: "cc0", certificate, expires_on: "2041-10-16T23:58:23Z", status: "pending_deletion" },
      ]),
      [`DELETE ${AOP}/certificates/cc1`]: ok({ id: "cc1", status: "pending_deletion" }),
    });
    const cf = new CloudflareClient({
      token: TOKEN,
      fetch: async (input, init) => {
        maskedFirst ||= !redactor.redact(privateKey).includes(privateKey);
        return fake.fetch(input, init);
      },
      sleep: noSleep,
      redactor,
    });
    expect(await cf.uploadHostnameClientCertificate("z1", { certificate, privateKey })).toEqual({
      id: "cc1",
      expiresOn: "2041-10-16T23:58:23.000Z",
      status: "pending_deployment",
    });
    expect(maskedFirst).toBe(true);
    expect(fake.calls[0]?.body).toEqual({
      certificate,
      private_key: privateKey,
      bundle_method: "ubiquitous",
    });
    expect(await cf.listHostnameClientCertificates("z1")).toEqual([
      { id: "cc1", expiresOn: "2041-10-16T23:58:23.000Z", status: "active" },
    ]);
    await cf.deleteHostnameClientCertificate("z1", "cc1");
    expect(fake.calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: `${AOP}/certificates/cc1`,
    });
  });

  it("keeps the client key out of every error, even one that quotes it", async () => {
    const certificate = pem("CERTIFICATE", "a client certificate");
    const privateKey = fakeSecret("private-key-pem");
    const body = privateKey.split("\n")[1] as string;
    for (const reply of [
      fail(400, [{ code: 1406, message: `The private key ${privateKey} does not match` }]),
      denied,
      { status: 502, body: { success: false, errors: [{ message: privateKey }] } },
      { error: new TypeError("fetch failed") },
    ] satisfies FakeReply[]) {
      const { cf } = client({ [`POST ${AOP}/certificates`]: reply });
      const error = (await cf
        .uploadHostnameClientCertificate("z1", { certificate, privateKey })
        .catch((e: unknown) => e)) as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      const text = `${error.message} ${error.hint} ${JSON.stringify(error)}`;
      expect(text).not.toContain(body);
    }
  });

  it("turns per-hostname origin pulls on and off, and reads each hostname's setting", async () => {
    const setting = (hostname: string, enabled: boolean | null, status: string) => ({
      hostname,
      cert_id: "cc1",
      cert_status: "active",
      enabled,
      status,
      expires_on: "2041-10-16T23:58:23Z",
    });
    const { cf, calls } = client({
      [`PUT ${AOP}`]: [
        accepted([setting("a.example.com", true, "pending_deployment")]),
        accepted([setting("a.example.com", null, "pending_deployment")]),
      ],
      [`GET ${AOP}/a.example.com`]: ok(setting("a.example.com", true, "active")),
      [`GET ${AOP}/b.example.com`]: fail(404, [{ code: 1404, message: "Not found" }]),
      [`GET ${AOP}/c.example.com`]: ok({ hostname: "c.example.com", enabled: null, status: null }),
    });
    expect(
      await cf.putHostnameAopSettings("z1", [
        { hostname: "a.example.com", certId: "cc1", enabled: true },
      ]),
    ).toEqual([
      { hostname: "a.example.com", certId: "cc1", enabled: true, status: "pending_deployment" },
    ]);
    await cf.putHostnameAopSettings("z1", [
      { hostname: "a.example.com", certId: "cc1", enabled: null },
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      { config: [{ hostname: "a.example.com", cert_id: "cc1", enabled: true }] },
      { config: [{ hostname: "a.example.com", cert_id: "cc1", enabled: null }] },
    ]);
    expect(
      await cf.listHostnameAopSettings("z1", ["a.example.com", "b.example.com", "c.example.com"]),
    ).toEqual([
      { hostname: "a.example.com", certId: "cc1", enabled: true, status: "active" },
      { hostname: "c.example.com", enabled: null, status: "" },
    ]);
  });

  it("reads the zone's minimum TLS version and raises it", async () => {
    const { cf, calls } = client({
      "GET /zones/z1/settings/min_tls_version": ok({
        id: "min_tls_version",
        value: "1.0",
        editable: true,
        modified_on: null,
      }),
      "PATCH /zones/z1/settings/min_tls_version": ok({
        id: "min_tls_version",
        value: "1.2",
        editable: true,
      }),
    });
    expect(await cf.getZoneSetting("z1", "min_tls_version")).toEqual({
      value: "1.0",
      editable: true,
    });
    await cf.patchZoneSetting("z1", "min_tls_version", "1.2");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { value: "1.2" } });
  });

  it.each<[string, (cf: CloudflareClient) => Promise<unknown>, string, string]>([
    [
      "listOriginCertificates",
      (cf) => cf.listOriginCertificates("z1"),
      "/certificates",
      "SSL and Certificates",
    ],
    [
      "listHostnameClientCertificates",
      (cf) => cf.listHostnameClientCertificates("z1"),
      `${AOP}/certificates`,
      "SSL and Certificates",
    ],
    [
      "listHostnameAopSettings",
      (cf) => cf.listHostnameAopSettings("z1", ["a.example.com"]),
      `${AOP}/a.example.com`,
      "SSL and Certificates",
    ],
    [
      "createOriginCertificate",
      (cf) => cf.createOriginCertificate({ csr: "csr", hostnames: ["a.example.com"], days: 5475 }),
      "POST /certificates",
      "SSL and Certificates",
    ],
    [
      "putHostnameAopSettings",
      (cf) =>
        cf.putHostnameAopSettings("z1", [
          { hostname: "a.example.com", certId: "cc1", enabled: true },
        ]),
      `PUT ${AOP}`,
      "SSL and Certificates",
    ],
    [
      "getZoneSetting",
      (cf) => cf.getZoneSetting("z1", "min_tls_version"),
      "/zones/z1/settings/min_tls_version",
      "Zone Settings",
    ],
    [
      "patchZoneSetting",
      (cf) => cf.patchZoneSetting("z1", "min_tls_version", "1.2"),
      "PATCH /zones/z1/settings/min_tls_version",
      "Zone Settings",
    ],
  ])(
    "gives a refused %s (HTTP 403) the permission code and the permission to add",
    async (_, call, route, permission) => {
      const { cf } = client({ [route]: denied });
      const error = (await call(cf).catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.reason).toBe("permission");
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain(`Zone → ${permission} → Edit`);
    },
  );

  it("refuses an answer of an unexpected shape, naming the call", async () => {
    const { cf } = client({
      "/certificates?page=1": ok([
        { id: "c1", hostnames: ["a.example.com"], expires_on: "in 15 years" },
      ]),
      [`GET ${AOP}/certificates`]: ok([{ id: "cc1", status: "active" }]),
      [`GET ${AOP}/a.example.com`]: ok({ hostname: "a.example.com", enabled: "yes" }),
      "GET /zones/z1/settings/min_tls_version": ok({ value: "1.0" }),
      "POST /certificates": ok({ id: "c2", expires_on: "2041-10-16 23:53:00 +0000 UTC" }),
    });
    await expect(cf.listOriginCertificates("z1")).rejects.toMatchObject({
      message: expect.stringContaining("origin certificates"),
    });
    await expect(cf.listHostnameClientCertificates("z1")).rejects.toMatchObject({
      message: expect.stringContaining("client certificates"),
    });
    await expect(cf.listHostnameAopSettings("z1", ["a.example.com"])).rejects.toMatchObject({
      message: expect.stringContaining("a.example.com"),
    });
    await expect(cf.getZoneSetting("z1", "min_tls_version")).rejects.toMatchObject({
      message: expect.stringContaining("minimum TLS version"),
    });
    await expect(
      cf.createOriginCertificate({ csr: "csr", hostnames: ["a.example.com"], days: 5475 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("may still have reached Cloudflare"),
    });
  });

  it("asks for the certificate and zone settings permissions", () => {
    expect(CLOUDFLARE_TOKEN_PERMISSIONS).toEqual([
      "Zone → Zone → Read",
      "Zone → DNS → Edit",
      "Zone → Config Rules → Edit",
      "Zone → Zone WAF → Edit",
      "Zone → SSL and Certificates → Edit",
      "Zone → Zone Settings → Edit",
    ]);
  });
});
