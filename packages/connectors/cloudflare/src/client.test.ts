import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CloudflareClient, cloudflareConnector, zoneCandidates } from "./index";

const TOKEN = fakeSecret("cloudflare-token");

type Route = { status?: number; body: unknown; headers?: Record<string, string> };

/** Fake fetch: routes by "path?query" prefix; records calls; each route may be a queue. */
function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization });
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    const key = Object.keys(routes)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unrouted ${path}`);
    const entry = routes[key];
    const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!route) throw new Error(`empty route ${key}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
  body: { success: true, errors: [], messages: [], result, ...extra },
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
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
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
        { id: "z1", name: "example.com", status: "active", name_servers: ["a.ns.cloudflare.com"] },
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

  it("detects existing entrypoint rulesets", async () => {
    const { fetch } = fakeFetch({
      "/zones/z1/rulesets/phases/http_config_settings/entrypoint": {
        status: 404,
        body: { success: false, errors: [{ code: 10003, message: "not found" }] },
      },
      "/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint": ok({
        id: "rs",
        rules: [{ id: "x" }],
      }),
      "/zones/z2/rulesets/phases/http_request_firewall_custom/entrypoint": ok({
        id: "rs",
        rules: [],
      }),
    });
    const client = new CloudflareClient({ token: TOKEN, fetch, sleep: noSleep });
    expect(await client.hasEntrypointRuleset("z1", "http_config_settings")).toBe(false);
    expect(await client.hasEntrypointRuleset("z1", "http_request_firewall_custom")).toBe(true);
    expect(await client.hasEntrypointRuleset("z2", "http_request_firewall_custom")).toBe(false);
  });

  it("reads IP ranges without a token", async () => {
    const { fetch, calls } = fakeFetch({
      "/ips": ok({ ipv4_cidrs: ["173.245.48.0/20"], ipv6_cidrs: ["2400:cb00::/32"] }),
    });
    const ranges = await new CloudflareClient({ fetch, sleep: noSleep }).getIpRanges();
    expect(ranges).toEqual({ ipv4: ["173.245.48.0/20"], ipv6: ["2400:cb00::/32"] });
    expect(calls[0]?.auth).toBeUndefined();
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
});

describe("cloudflareConnector", () => {
  it("exposes credentials and read-only tools with redacted output", async () => {
    const { fetch } = fakeFetch({
      "/zones?name=": ok([{ id: "z1", name: "example.com", status: "active", name_servers: [] }]),
    });
    const connector = cloudflareConnector({
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetch,
      sleep: noSleep,
    });
    expect(connector.credentials.envVars).toEqual(["CLOUDFLARE_API_TOKEN"]);
    const tools = connector.tools();
    expect(tools.map((t) => t.name)).toEqual([
      "cloudflare_find_zone",
      "cloudflare_list_dns_records",
    ]);
    expect(tools.every((t) => !t.mutates)).toBe(true);
    const result = await tools[0]?.handler(
      { domain: "example.com" },
      { phase: "provision", projectRoot: "/p" },
    );
    expect(result?.text).toContain('"id": "z1"');
  });

  it("reports a missing token without throwing", async () => {
    const connector = cloudflareConnector({ env: {}, fetch: fakeFetch({}).fetch });
    expect(await connector.verifyCredentials()).toMatchObject({ ok: false });
    const result = await connector
      .tools()[0]
      ?.handler({ domain: "example.com" }, { phase: "provision", projectRoot: "/p" });
    expect(result?.isError).toBe(true);
  });
});
