import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function questions(env: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-interview-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shop", dependencies: { express: "^5.0.0" } }),
  );
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home"), ...env },
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: root,
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const result = (await client.callTool({
    name: "opscrew_interview_questions",
    arguments: {},
  })) as CallToolResult;
  const data = result.structuredContent as {
    questions: { id: string; default?: unknown }[];
    inferred: Record<string, unknown>;
  };
  return { result, data };
}

describe("opscrew_interview_questions provider default", () => {
  it("defaults to DigitalOcean when only DIGITALOCEAN_TOKEN is set", async () => {
    const token = fakeSecret("digitalocean-token");
    const { result, data } = await questions({ DIGITALOCEAN_TOKEN: token });
    expect(data.questions.find((q) => q.id === "provider")?.default).toBe("digitalocean");
    expect(data.inferred.provider).toBe("digitalocean");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("defaults to Hetzner when no provider token is set", async () => {
    const { data } = await questions({});
    expect(data.questions.find((q) => q.id === "provider")?.default).toBe("hetzner");
    expect(data.inferred.provider).toBe("hetzner");
  });
});
