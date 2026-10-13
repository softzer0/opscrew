import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScriptedRunner } from "@opscrew/agents/testing";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

const API = "https://api.cloudflare.com/client/v4";
const REG = "/accounts/acc-1/registrar";
const TOKEN = fakeSecret("cloudflare-token");
const GODADDY = "https://api.godaddy.com";
const GODADDY_TOKEN = fakeSecret("godaddy-token");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type Answer = { status?: number; body: unknown };
const ok = (result: unknown): Answer => ({
  body: { success: true, errors: [], messages: [], result },
});
const refused = (status: number, message: string): Answer => ({
  status,
  body: { success: false, errors: [{ code: 10000, message }], messages: [], result: null },
});

/** Fake Cloudflare API routed by "METHOD path" (path without query for registrar search). */
function fakeCloudflare(routes: Record<string, Answer>) {
  const calls: { method: string; path: string; auth?: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input).replace(API, "").replace(GODADDY, "godaddy:");
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      path: url,
      ...(headers.Authorization ? { auth: headers.Authorization } : {}),
    });
    const answer = routes[`${method} ${url}`] ?? routes[`${method} ${url.split("?")[0]}`];
    if (answer === undefined) throw new Error(`unrouted ${method} ${url}`);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

const available = (name: string, cost: string) => ({
  name,
  registrable: true,
  tier: "standard",
  pricing: { currency: "USD", registration_cost: cost, renewal_cost: cost },
});

const HAPPY: Record<string, Answer> = {
  "GET /accounts?page=1&per_page=50": ok([{ id: "acc-1", name: "Shop" }]),
  [`GET ${REG}/domain-search`]: ok({
    domains: [available("shopapp.net", "11.86"), { name: "shop.app", registrable: false }],
  }),
  [`POST ${REG}/domain-check`]: ok({
    domains: [
      available("shopapp.com", "10.44"),
      available("shopapp.net", "11.86"),
      {
        name: "shop.app",
        registrable: true,
        tier: "premium",
        pricing: { currency: "USD", registration_cost: "1200.00", renewal_cost: "1200.00" },
      },
    ],
  }),
  [`GET ${REG}/extensions/com`]: ok({ contact_extensions: [] }),
  [`GET ${REG}/extensions/net`]: ok({ contact_extensions: [] }),
};

async function connect(env: Record<string, string | undefined>, routes: Record<string, Answer>) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-domain-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const api = fakeCloudflare(routes);
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home"), ...env },
    fetch: api.fetch,
    runner: new ScriptedRunner(),
    cwd: dir,
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: "opscrew_domain_check", arguments: args }) as Promise<CallToolResult>;
  return { client, call, api };
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("opscrew_domain_check", () => {
  it("is listed as a read-only, idempotent tool, and no tool buys anything", async () => {
    const { client } = await connect({}, {});
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_domain_check");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.idempotentHint).toBe(true);
    expect(tool?.inputSchema.required).toContain("query");
    for (const t of tools) expect(t.name).not.toMatch(/buy|purchase|register/i);
  });

  it("tells the agent that buying is terminal-only", async () => {
    const { client } = await connect({}, {});
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("opscrew_domain_check");
    expect(instructions).toContain("npx opscrew domain buy <domain>");
    expect(instructions).toContain("--max-price");
  });

  it("returns availability, prices and plain reasons, without the token", async () => {
    const { call, api } = await connect({ CLOUDFLARE_API_TOKEN: TOKEN }, HAPPY);
    const result = await call({ query: "shopapp.com" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("shopapp.com: available, first year 10.44 USD, renewal 10.44 USD");
    expect(text).toContain("shop.app: cannot be bought through OpsCrew. This is a premium domain");
    expect(text).toContain("npx opscrew domain buy <domain>");
    const data = result.structuredContent as {
      account: { id: string };
      results: { domain: string; registrable: boolean; reason?: string }[];
    };
    expect(data.account.id).toBe("acc-1");
    expect(data.results.map((r) => r.domain)).toEqual(["shopapp.com", "shopapp.net", "shop.app"]);
    expect(data.results[2]?.registrable).toBe(false);
    expect(api.calls.some((c) => c.auth?.includes(TOKEN))).toBe(true);
    expect(api.calls.every((c) => c.method === "GET" || c.path.endsWith("/domain-check"))).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("explains a missing token with the token page", async () => {
    const { call, api } = await connect({}, HAPPY);
    const result = await call({ query: "shopapp" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("No Cloudflare API token found");
    expect(text).toContain("https://dash.cloudflare.com/profile/api-tokens");
    expect(text).not.toMatch(/CLOUDFLARE_API_TOKEN:/);
    expect(api.calls).toEqual([]);
  });

  it("names the optional Registrar permission when the token lacks it", async () => {
    const { call } = await connect(
      { CLOUDFLARE_API_TOKEN: TOKEN },
      {
        ...HAPPY,
        [`GET ${REG}/domain-search`]: refused(403, "Authentication error"),
      },
    );
    const result = await call({ query: "shopapp" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Registrar");
    expect(text).toContain("optional");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("asks for the account through its own input, not a CLI flag, when the token sees several", async () => {
    const { call } = await connect(
      { CLOUDFLARE_API_TOKEN: TOKEN },
      {
        ...HAPPY,
        "GET /accounts?page=1&per_page=50": ok([
          { id: "acc-1", name: "Shop" },
          { id: "acc-2", name: "Team" },
        ]),
      },
    );
    const result = await call({ query: "shopapp" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("the `account` input of opscrew_domain_check");
    expect(text).not.toContain("--account");
  });
});

const GODADDY_CHECK = "POST godaddy:/v3/domains/check-availability";
const godaddyOffer = (domain: string, first: number, renewal: number) => ({
  domain,
  available: true,
  definitive: true,
  prices: [
    {
      period: 1,
      price: { currencyCode: "USD", value: first },
      renewalPrice: { currencyCode: "USD", value: renewal },
    },
  ],
});

describe("opscrew_domain_check at other registrars", () => {
  it("offers registrar and compare inputs, and no tool buys or connects a domain", async () => {
    const { client } = await connect({}, {});
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_domain_check");
    const props = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.registrar?.enum).toEqual(["cloudflare", "porkbun", "namecheap", "godaddy"]);
    expect(props.compare).toBeDefined();
    for (const t of tools) {
      expect(t.name).not.toMatch(/buy|purchase|register|connect|nameserver|renew/i);
    }
  });

  it("describes the registrars, connect and the contact rule in the instructions", async () => {
    const { client } = await connect({}, {});
    const instructions = client.getInstructions() ?? "";
    for (const name of ["Porkbun", "Namecheap", "GoDaddy", "compare"]) {
      expect(instructions).toContain(name);
    }
    expect(instructions).toContain("npx opscrew domain buy <domain> [--registrar <id>]");
    expect(instructions).toContain("npx opscrew domain connect <domain>");
    expect(instructions).toMatch(/never asks? for contact details/i);
  });

  it("passes the registrar through and returns its live answers", async () => {
    const { call, api } = await connect(
      { GODADDY_API_TOKEN: GODADDY_TOKEN },
      {
        [GODADDY_CHECK]: {
          body: {
            items: [
              godaddyOffer("shopapp.com", 1299, 2299),
              { domain: "shopapp.net", available: false },
            ],
          },
        },
      },
    );
    const result = await call({ query: "shopapp.com", registrar: "godaddy" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Checked live with GoDaddy.");
    expect(text).toContain("shopapp.com: available, first year 12.99 USD, renewal 22.99 USD");
    expect(text).toContain("npx opscrew domain buy <domain> --registrar godaddy");
    const data = result.structuredContent as {
      registrar: string;
      results: { domain: string; registrable: boolean }[];
    };
    expect(data.registrar).toBe("godaddy");
    expect(data.results[0]).toMatchObject({ domain: "shopapp.com", registrable: true });
    expect(api.calls.every((c) => c.path.startsWith("godaddy:"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(GODADDY_TOKEN);
  });

  it("compares offers side by side, cheapest renewal first", async () => {
    const { call } = await connect(
      { CLOUDFLARE_API_TOKEN: TOKEN, GODADDY_API_TOKEN: GODADDY_TOKEN },
      {
        ...HAPPY,
        [GODADDY_CHECK]: { body: { items: [godaddyOffer("shopapp.com", 99, 2299)] } },
      },
    );
    const result = await call({ query: "shopapp.com", compare: true });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      comparison: {
        domain: string;
        offers: { registrar: string; firstYear?: { amount: number }; renewal?: unknown }[];
      }[];
    };
    expect(data.comparison).toHaveLength(1);
    expect(data.comparison[0]?.domain).toBe("shopapp.com");
    expect(data.comparison[0]?.offers.map((o) => o.registrar)).toEqual(["cloudflare", "godaddy"]);
    expect(data.comparison[0]?.offers[1]?.firstYear?.amount).toBe(0.99);
    const text = textOf(result);
    const cloudflare = text.indexOf("Cloudflare: first year 10.44 USD, renewal 10.44 USD");
    const godaddy = text.indexOf("GoDaddy: first year 0.99 USD, renewal 22.99 USD");
    expect(cloudflare).toBeGreaterThan(-1);
    expect(godaddy).toBeGreaterThan(cloudflare);
    expect(text).not.toMatch(/recommend|best|affiliate|referral/i);
    expect(JSON.stringify(result)).not.toContain(GODADDY_TOKEN);
  });

  it("refuses registrar and compare together", async () => {
    const { call, api } = await connect({ CLOUDFLARE_API_TOKEN: TOKEN }, HAPPY);
    const result = await call({ query: "shopapp", registrar: "porkbun", compare: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("either `registrar` or `compare`");
    expect(api.calls).toEqual([]);
  });

  it("names the variables to set for a registrar that is not set up", async () => {
    const { call, api } = await connect({ NAMECHEAP_API_USER: "shopowner" }, {});
    const result = await call({ query: "shopapp", registrar: "namecheap" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Namecheap is not set up");
    expect(text).toContain("NAMECHEAP_API_KEY");
    expect(text).not.toMatch(/NAMECHEAP_API_(USER|KEY):/);
    expect(api.calls).toEqual([]);
  });
});
