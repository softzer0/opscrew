import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_API,
  CloudflareClient,
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

  it("tells OpsCrew's own entrypoint rulesets from the user's", async () => {
    const config = "/rulesets/phases/http_config_settings/entrypoint";
    const waf = "/rulesets/phases/http_request_firewall_custom/entrypoint";
    const { fetch } = fakeFetch({
      [`/zones/z1${config}`]: {
        status: 404,
        body: { success: false, errors: [{ code: 10003, message: "not found" }] },
      },
      [`/zones/z1${waf}`]: ok({
        id: "rs-user",
        name: "default",
        description: "",
        rules: [{ id: "x", description: "Block bad bots" }],
      }),
      [`/zones/z2${config}`]: ok({
        id: "rs-ops",
        name: "OpsCrew configuration rules",
        description: "Managed by OpsCrew",
        rules: [{ id: "r1", description: "OpsCrew: verify the origin certificate" }],
      }),
      [`/zones/z2${waf}`]: ok({ id: "rs-empty", name: "default", rules: [] }),
      [`/zones/z3${waf}`]: ok({ id: "rs-named", name: "OpsCrew custom rules", rules: [] }),
    });
    const client = new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep });
    expect(await client.inspectEntrypointRuleset("z1", "http_config_settings")).toEqual({
      exists: false,
      ownedByOpsCrew: false,
      ruleCount: 0,
    });
    expect(await client.inspectEntrypointRuleset("z1", "http_request_firewall_custom")).toEqual({
      exists: true,
      ownedByOpsCrew: false,
      ruleCount: 1,
      id: "rs-user",
    });
    expect(await client.inspectEntrypointRuleset("z2", "http_config_settings")).toEqual({
      exists: true,
      ownedByOpsCrew: true,
      ruleCount: 1,
      id: "rs-ops",
    });
    expect(await client.inspectEntrypointRuleset("z2", "http_request_firewall_custom")).toEqual({
      exists: true,
      ownedByOpsCrew: false,
      ruleCount: 0,
      id: "rs-empty",
    });
    expect(
      await client.inspectEntrypointRuleset("z3", "http_request_firewall_custom"),
    ).toMatchObject({ exists: true, ownedByOpsCrew: true, ruleCount: 0 });
  });

  it("maps a refused ruleset read to the permissions hint", async () => {
    const { fetch } = fakeFetch({
      "/zones/z1/rulesets": {
        status: 403,
        body: { success: false, errors: [{ message: "Authentication error" }] },
      },
    });
    await expect(
      new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep }).inspectEntrypointRuleset(
        "z1",
        "http_config_settings",
      ),
    ).rejects.toMatchObject({ code: "CREDENTIALS_INVALID", hint: expect.stringContaining("WAF") });
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
});
