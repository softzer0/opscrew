import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, movingPlan, ScriptedRunner } from "@opscrew/agents/testing";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function connect(setup?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-drift-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await setup?.(dir);
  const runner = new ScriptedRunner();
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home") },
    fetch: forbiddenFetch,
    runner,
    cwd: dir,
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, dir, runner };
}

describe("opscrew_drift", () => {
  it("is a read-only tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "opscrew_drift")?.annotations?.readOnlyHint).toBe(true);
  });

  it("explains what is missing in a project that was never deployed", async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: "opscrew_drift",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/plan\.yaml|opscrew design|provision/);
  });

  it("stops with the move guard's message and next step while a move is in progress", async () => {
    const { client, dir, runner } = await connect(async (root) => {
      await mkdir(path.join(root, "opscrew"), { recursive: true });
      await writeArtifact("plan", path.join(root, "opscrew", "plan.yaml"), movingPlan("deployed"));
    });
    const planFile = path.join(dir, "opscrew", "plan.yaml");
    const before = await readFile(planFile, "utf8");
    const filesBefore = await readdir(dir, { recursive: true });

    const result = (await client.callTool({
      name: "opscrew_drift",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("A move to DigitalOcean is in progress.");
    expect(text).toContain("Next step: Run `opscrew retarget` to continue it");
    expect(text).toContain("`opscrew retarget --finish`");
    expect(text).toContain("`opscrew retarget --abort`");
    expect(result.structuredContent).toMatchObject({
      error: { code: "PHASE_PRECONDITION", message: "A move to DigitalOcean is in progress." },
    });
    expect(await readFile(planFile, "utf8")).toBe(before);
    expect((await readdir(dir, { recursive: true })).sort()).toEqual(filesBefore.sort());
    expect(runner.calls).toEqual([]);
  });
});

describe("moving between providers", () => {
  it("has no MCP tool: moves are terminal-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) expect(tool.name).not.toMatch(/retarget|move|migrat/i);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("npx opscrew retarget");
  });

  it("opscrew_status shows a move in progress and the terminal command to continue it", async () => {
    const { client } = await connect(async (root) => {
      await mkdir(path.join(root, "opscrew"), { recursive: true });
      await writeArtifact("plan", path.join(root, "opscrew", "plan.yaml"), movingPlan("deployed"));
    });
    const result = (await client.callTool({
      name: "opscrew_status",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain(
      "Move: from Hetzner Cloud to DigitalOcean, last completed step: deployed.",
    );
    expect(text).toContain("Next: A move to DigitalOcean is in progress.");
    expect(text).toContain("in a terminal");
    expect(result.structuredContent).toMatchObject({
      move: { from: "hetzner", to: "digitalocean", step: "deployed" },
    });
  });
});
