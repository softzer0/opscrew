/**
 * `opscrew_preview_list` (US7): read-only, the previews as text and structured content, never the
 * server's address or a token. The preview server's deploy shell and the clock are fakes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { recordServerAddress } from "@opscrew/agents";
import {
  forbiddenFetch,
  previewTestPlan,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import type { RemoteExec } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerDeployTools } from "./deploy";
import { registerPreviewTools } from "./previews";

const HCLOUD_TOKEN = fakeSecret("hcloud-token", "previews");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"ab".repeat(32)}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * The tool on prod and a preview environment (previews in the zone example.net), its server's
 * deploy shell answering every command with `stdout` and `exitCode` (the commands are kept).
 */
async function connect(stdout: string, exitCode = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-previews-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const env = { OPSCREW_HOME: path.join(dir, "home"), HCLOUD_TOKEN };
  const base = testPlan({ deployed: true });
  await writeArtifact("plan", resolveProjectPaths(dir, { env }).files.plan, base);
  const paths = resolveProjectPaths(dir, { env, environment: "preview" });
  await writeArtifact("plan", paths.files.plan, previewTestPlan());
  await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  await mkdir(path.dirname(paths.files.deployKey), { recursive: true });
  await writeFile(paths.files.deployKey, "placeholder\n");
  const commands: string[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command) => {
      commands.push(command);
      return { exitCode, stdout, stderr: `ssh to ${SERVER_IPV4} with ${HCLOUD_TOKEN}` };
    },
  });
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerPreviewTools(server, deps, { services: { remote } });
  registerDeployTools(server, deps, { verify: { remote } });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return { client, commands, paths };
}

/** Calls the tool with `args`. */
async function list(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({
    name: "opscrew_preview_list",
    arguments: args,
  })) as CallToolResult;
  return { result, text: (result.content[0] as { text: string }).text };
}

describe("opscrew_preview_list", () => {
  it("is read-only and takes projectDir, app and environment", async () => {
    const { client } = await connect("opscrew-preview: listed 0/3\n");
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_preview_list");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "app",
      "environment",
      "projectDir",
    ]);
  });

  it("returns the previews as text and structured content, changing nothing", async () => {
    const { client, commands, paths } = await connect(
      [
        `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST} pr-42-a1b2c3d4e5.example.net`,
        "9 failed - - - - -",
        "opscrew-preview: listed 2/3",
      ].join("\n"),
    );
    const before = await readFile(paths.files.plan, "utf8");
    const { result, text } = await list(client, { environment: "preview" });
    expect(result.isError, text).toBeFalsy();
    expect(commands).toEqual(["/srv/apps/shop-preview/bin/opscrew-preview list"]);
    expect(text).toContain("Previews: 2 of at most 3.");
    expect(text).toContain("pr-42: https://pr-42-a1b2c3d4e5.example.net, running, commit 0123456");
    expect(text).toContain("pr-9: no address yet, failed");
    expect(result.structuredContent).toMatchObject({
      count: 2,
      cap: 3,
      previews: [
        {
          number: 42,
          state: "running",
          commit: COMMIT,
          address: "https://pr-42-a1b2c3d4e5.example.net",
        },
        { number: 9, state: "failed" },
      ],
    });
    expect(await readFile(paths.files.plan, "utf8")).toBe(before);
    const all = JSON.stringify(result);
    expect(all).not.toContain(SERVER_IPV4);
    expect(all).not.toContain(HCLOUD_TOKEN);
  });

  it("refuses an environment without previews, and says when the server does not answer", async () => {
    const prod = await connect("opscrew-preview: listed 0/3\n");
    const refused = await list(prod.client, { environment: "prod" });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toContain("The prod environment has no previews");
    expect(prod.commands).toEqual([]);
    const down = await connect("", 255);
    const failed = await list(down.client, { environment: "preview" });
    expect(failed.result.isError).toBe(true);
    expect(failed.text).toContain("did not answer over SSH");
    const all = JSON.stringify(failed.result);
    expect(all).not.toContain(SERVER_IPV4);
    expect(all).not.toContain(HCLOUD_TOKEN);
  });
});

describe("opscrew_verify of a preview environment", () => {
  it("checks the server and its previews, and names no runbook", async () => {
    const { client } = await connect("opscrew-preview: listed 0/3\n");
    const result = (await client.callTool({
      name: "opscrew_verify",
      arguments: { environment: "preview" },
    })) as CallToolResult;
    const text = (result.content[0] as { text: string }).text;
    expect(result.isError, text).toBeFalsy();
    expect(text).toContain("0 previews of at most 3 on the server.");
    expect(text).not.toContain("Runbook");
    expect(result.structuredContent).not.toHaveProperty("runbookPath");
  });
});
