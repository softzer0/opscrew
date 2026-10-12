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

async function connect(env: Record<string, string>) {
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
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function questions(env: Record<string, string>) {
  const call = await connect(env);
  const result = await call("opscrew_interview_questions");
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

const ANSWERS = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "10 EUR",
  region: "eu-central",
  uptime: "best-effort",
  dataCriticality: "none",
};

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

describe("opscrew_save_requirements provider summary", () => {
  it("reports DigitalOcean when no provider is given and only DIGITALOCEAN_TOKEN is set", async () => {
    const token = fakeSecret("digitalocean-token");
    const call = await connect({ DIGITALOCEAN_TOKEN: token });
    const saved = await call("opscrew_save_requirements", { answers: ANSWERS });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain("- Cloud provider: DigitalOcean");
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  it("reports Hetzner Cloud when the provider answer is hetzner", async () => {
    const call = await connect({ DIGITALOCEAN_TOKEN: fakeSecret("digitalocean-token") });
    const saved = await call("opscrew_save_requirements", {
      answers: { ...ANSWERS, provider: "hetzner" },
    });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain("- Cloud provider: Hetzner Cloud");
  });
});
