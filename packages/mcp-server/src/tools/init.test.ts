import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner, testPlan } from "@opscrew/agents/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOKEN = fakeSecret("hcloud-token");

async function connect(
  options: { env?: Record<string, string>; setup?: (dir: string) => Promise<void> } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-init-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await options.setup?.(dir);
  const fetchCalls: string[] = [];
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home"), ...(options.env ?? { HCLOUD_TOKEN: TOKEN }) },
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
    expect(data.checks.map((c) => c.id)).toContain("provider");
    // no git, engine or ssh on this fake PATH, so required checks fail
    expect(data.passed).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toContain("only checked that it is set");
    expect(text).not.toContain(TOKEN);
    expect(fetchCalls).toEqual([]);
  });

  it("checks DIGITALOCEAN_TOKEN for a DigitalOcean plan and never prints its value", async () => {
    const doToken = fakeSecret("digitalocean-token");
    const { client, fetchCalls } = await connect({
      env: { DIGITALOCEAN_TOKEN: doToken },
      setup: (dir) =>
        writeArtifact(
          "plan",
          path.join(dir, "opscrew", "plan.yaml"),
          testPlan({ provider: "digitalocean" }),
        ),
    });
    const result = (await client.callTool({
      name: "opscrew_init_check",
      arguments: { offline: true },
    })) as CallToolResult;
    const data = result.structuredContent as {
      checks: { id: string; title: string; status: string; message: string }[];
    };
    const provider = data.checks.find((c) => c.id === "provider");
    expect(provider?.title).toContain("DigitalOcean");
    expect(provider?.status).toBe("pass");
    expect(JSON.stringify(provider)).toContain("DIGITALOCEAN_TOKEN");
    const text = JSON.stringify(result);
    expect(text).not.toContain(doToken);
    expect(fetchCalls).toEqual([]);
  });

  it("asks for DIGITALOCEAN_TOKEN when a DigitalOcean plan has no token set", async () => {
    const { client } = await connect({
      env: {},
      setup: (dir) =>
        writeArtifact(
          "plan",
          path.join(dir, "opscrew", "plan.yaml"),
          testPlan({ provider: "digitalocean" }),
        ),
    });
    const result = (await client.callTool({
      name: "opscrew_init_check",
      arguments: { offline: true },
    })) as CallToolResult;
    const data = result.structuredContent as { checks: { id: string; status: string }[] };
    const provider = data.checks.find((c) => c.id === "provider");
    expect(provider?.status).toBe("fail");
    expect(JSON.stringify(provider)).toContain("DIGITALOCEAN_TOKEN");
  });
});
