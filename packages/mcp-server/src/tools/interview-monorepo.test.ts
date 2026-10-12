import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { materializeFixture } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

const TWO_APPS = fileURLToPath(
  new URL("../../../detect/test/fixtures/monorepo-two-apps/", import.meta.url),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("opscrew_interview_questions in a repository with several apps", () => {
  it("asks first which app to deploy, offering every candidate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-two-apps-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, "repo");
    await materializeFixture(TWO_APPS, root);
    const server = createOpscrewMcpServer({
      version: "0.0.0-test",
      env: { OPSCREW_HOME: path.join(dir, "home") },
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
      questions: { id: string; options?: { value: unknown }[] }[];
    };
    expect(data.questions[0]?.id).toBe("appDir");
    expect(data.questions[0]?.options?.map((o) => o.value)).toEqual(["apps/api", "apps/web"]);
  });
});
