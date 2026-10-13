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
    const url = String(input).replace(API, "");
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
});
