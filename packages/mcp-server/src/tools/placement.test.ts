import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { updateServerAddresses } from "@opscrew/agents";
import {
  euCatalog,
  forbiddenFetch,
  OWN_IPV4,
  ScriptedRunner,
  testPlan,
} from "@opscrew/agents/testing";
import type { FetchLike } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerPlacementTool } from "./placement";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** `opscrew_placement_estimate` on the shared test plan (the app on a Hetzner cx23 in nbg1). */
/**
 * `catalog: false` leaves the prices to design's catalogue, with `env` (a provider token) and
 * `fetch` (its API).
 */
async function connect(
  options: { catalog?: boolean; env?: Record<string, string>; fetch?: FetchLike } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-placement-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const env = { OPSCREW_HOME: path.join(dir, "home"), ...options.env };
  await writeArtifact("plan", path.join(dir, "opscrew", "plan.yaml"), testPlan());
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: options.fetch ?? forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerPlacementTool(server, deps, options.catalog === false ? {} : { catalog: euCatalog() });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = (await client.callTool({
      name: "opscrew_placement_estimate",
      arguments: args,
    })) as CallToolResult;
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    return { result, text, data: result.structuredContent as Record<string, unknown> };
  };
  return { client, call, paths: resolveProjectPaths(dir, { env }) };
}

describe("opscrew_placement_estimate", () => {
  it("is read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_placement_estimate");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.required).toEqual(["service", "provider"]);
  });

  it("prices a new cloud server for one service and estimates each query's delay", async () => {
    const { call } = await connect();
    const { result, text, data } = await call({
      service: "db",
      provider: "hetzner",
      location: "nbg1",
    });
    expect(result.isError, text).toBeFalsy();
    // The test catalogue is a dated price list, which the line says.
    expect(text).toMatch(
      /^db on a new cx23 \(2 vCPU, 4 GB memory\): €\d+\.\d\d per month \(from the provider's published price list, an estimate\)\.$/m,
    );
    expect(text).toContain("so a page that makes 20 queries in a row takes about");
    expect(text).toMatch(/^The app's monthly total with it: €\d+\.\d\d\.$/m);
    expect(data).toMatchObject({
      service: "db",
      provider: "hetzner",
      server: { serverType: "cx23", vcpus: 2, memoryGb: 4 },
      total: { currency: "EUR" },
      delay: { text: expect.any(String) },
    });
  });

  it("falls back to the dated price list when the provider's token does not verify", async () => {
    // Hetzner refuses the token.
    const fetch: FetchLike = async () =>
      new Response('{"error":{"code":"unauthorized"}}', { status: 401 });
    const { call } = await connect({
      catalog: false,
      env: { HCLOUD_TOKEN: fakeSecret("hcloud-token") },
      fetch,
    });
    const { result, text } = await call({ service: "db", provider: "hetzner", location: "nbg1" });
    expect(result.isError, text).toBeFalsy();
    expect(text).toContain("(from the provider's published price list, an estimate)");
    expect(text).toContain("The Hetzner token could not be used");
  });

  it("has no price for a server of the user's, whose delay status measures", async () => {
    const { call } = await connect();
    const { text, data } = await call({ service: "db", provider: "own" });
    expect(text).toContain("db on a server of yours: no server price");
    expect(text).toContain("`opscrew status` measures it");
    expect(data.server).toBeUndefined();
  });

  it("needs a new cloud server's location", async () => {
    const { call } = await connect();
    const { result, text } = await call({ service: "db", provider: "digitalocean" });
    expect(result.isError).toBe(true);
    expect(text).toContain("A new DigitalOcean server needs its location");
  });

  it("never names the address of an extra server of the user's", async () => {
    const { call, paths } = await connect();
    await updateServerAddresses(paths, (current) => ({
      ...current,
      ownServers: { home: { host: OWN_IPV4, port: 22, user: "root", agent: true } },
    }));
    // The unknown service's name is repeated in the error: the address reads "your server".
    const { result, text } = await call({ service: OWN_IPV4, provider: "own" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(OWN_IPV4);
    expect(text).toContain('no enabled service named "your server"');
  });
});
