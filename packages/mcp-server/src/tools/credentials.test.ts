/**
 * `opscrew_credentials` (025 US9): read-only, what `opscrew rotate` lists, as text and structured
 * content; never a value, and nothing recorded (not even a token's first-seen date).
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { credentialsRecordFile } from "@opscrew/agents";
import { forbiddenFetch, ScriptedRunner, testPlan } from "@opscrew/agents/testing";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerCredentialsTool } from "./credentials";

const DB_PASSWORD = fakeSecret("generic-password", "mcp-credentials-db");
const SESSION_SECRET = fakeSecret("generic-password", "mcp-credentials-session");
const HCLOUD_TOKEN = fakeSecret("hcloud-token", "mcp-credentials");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

/**
 * A deployed Hetzner app with its database's password and a generated session secret on this
 * computer, the deploy key, and `db` rotated on 2026-11-01 in the record; the Hetzner token set.
 */
async function connect() {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-credentials-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const env = { OPSCREW_HOME: path.join(dir, "home"), HCLOUD_TOKEN };
  const paths = resolveProjectPaths(dir, { env });
  await writeArtifact("plan", paths.files.plan, testPlan({ deployed: true, userSecret: false }));
  await mkdir(paths.projectHomeDir, { recursive: true });
  await writeFile(
    path.join(paths.projectHomeDir, "generated_values.json"),
    `${JSON.stringify({ dbPassword: DB_PASSWORD, env: { SESSION_SECRET } })}\n`,
  );
  await mkdir(path.dirname(paths.files.deployKey), { recursive: true });
  await writeFile(paths.files.deployKey, "placeholder for the deploy key file\n");
  await writeArtifact("credentials", credentialsRecordFile(paths), {
    schemaVersion: 1,
    environments: { prod: { db: { rotatedAt: "2026-11-01T09:00:00.000Z", generation: 2 } } },
  });
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
    clock: { now: () => new Date("2026-11-09T12:00:00.000Z") },
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerCredentialsTool(server, deps);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return { client, paths };
}

describe("opscrew_credentials", () => {
  it("is read only and takes projectDir, app and environment", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_credentials");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["projectDir", "app", "environment"]),
    );
    expect(tool?.description).toContain("Rotating stays in the user's terminal");
  });

  it("lists each credential by its name with how it rotates and its date, never a value", async () => {
    const { client, paths } = await connect();
    const result = (await client.callTool({
      name: "opscrew_credentials",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // The listing `opscrew rotate` prints, with Claude Code's commands.
    expect(text).toContain("(`npx opscrew rotate <name>` rotates one):");
    expect(text).toContain(
      "- db: a short swap: new connections fail for up to 30 seconds; rotated 2026-11-01, 8 days ago.",
    );
    expect(text).toContain("- app:SESSION_SECRET: the app's users are logged out");
    expect(text).toContain("- deploy-key: seamless:");
    expect(text).toContain("- hetzner (HCLOUD_TOKEN): date unknown.");
    const data = result.structuredContent as { credentials: { name: string; kind: string }[] };
    expect(data.credentials.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "db",
        "app",
        "app:SESSION_SECRET",
        "deploy-key",
        "hetzner",
        "github",
      ]),
    );
    const said = JSON.stringify(result);
    for (const secret of [DB_PASSWORD, SESSION_SECRET, HCLOUD_TOKEN])
      expect(said).not.toContain(secret);
    // A listing records no token's first-seen date.
    expect(await readdir(paths.homeDir).catch(() => [])).not.toContain("token-dates.json");
  });
});
