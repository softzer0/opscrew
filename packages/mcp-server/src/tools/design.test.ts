import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function connect() {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-design-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shop", dependencies: { express: "^5.0.0" } }),
  );
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
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

const ANSWERS = {
  expectedMonthlyUsers: "<1k",
  region: "eu-central",
  uptime: "best-effort",
  dataCriticality: "none",
};

async function optionsText(answers: Record<string, unknown>): Promise<string> {
  const call = await connect();
  const saved = await call("opscrew_save_requirements", { answers });
  expect(saved.isError).toBeFalsy();
  const result = await call("opscrew_design_options");
  expect(result.isError).toBeFalsy();
  return textOf(result).split("\n")[0] ?? "";
}

describe("opscrew_design_options tax wording", () => {
  it("says tax, not VAT, for DigitalOcean's USD prices", async () => {
    const heading = await optionsText({
      ...ANSWERS,
      budgetMonthly: "20 USD",
      provider: "digitalocean",
    });
    expect(heading).toContain("DigitalOcean");
    expect(heading).toContain("excl. tax");
    expect(heading).not.toContain("VAT");
  });

  it("keeps VAT for Hetzner's EUR prices", async () => {
    const heading = await optionsText({ ...ANSWERS, budgetMonthly: "10 EUR", provider: "hetzner" });
    expect(heading).toContain("Hetzner Cloud");
    expect(heading).toContain("excl. VAT");
  });
});
