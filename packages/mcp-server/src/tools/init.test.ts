import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOKEN = fakeSecret("hcloud-token");

async function connect() {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-init-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const fetchCalls: string[] = [];
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home"), HCLOUD_TOKEN: TOKEN },
    fetch: async (input, init) => {
      fetchCalls.push(String(input));
      return forbiddenFetch(input, init);
    },
    runner: new ScriptedRunner(() => ({ exitCode: 127, stdout: "", stderr: "not found" })),
    cwd: dir,
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, fetchCalls };
}

describe("opscrew_init_check", () => {
  it("is listed as a read-only tool next to the other tools, with no destroy tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_init_check");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tools.map((t) => t.name).some((name) => /destroy/.test(name))).toBe(false);
  });

  it("returns the checklist offline without touching the network or printing tokens", async () => {
    const { client, fetchCalls } = await connect();
    const result = (await client.callTool({
      name: "opscrew_init_check",
      arguments: { offline: true },
    })) as CallToolResult;
    const data = result.structuredContent as { passed: boolean; checks: { id: string }[] };
    expect(data.checks.map((c) => c.id)).toContain("node");
    expect(data.checks.map((c) => c.id)).toContain("hetzner");
    // no git, engine or ssh on this fake PATH, so required checks fail
    expect(data.passed).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toContain("only checked that it is set");
    expect(text).not.toContain(TOKEN);
    expect(fetchCalls).toEqual([]);
  });
});
