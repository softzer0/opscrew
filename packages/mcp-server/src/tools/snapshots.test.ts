/**
 * `opscrew_snapshots` (024 US8): read-only, the snapshots as text and structured content, never a
 * server's address, a token or what the server printed on stderr. The server's deploy shell and
 * the provider's snapshot API are fakes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { recordServerAddress, type SnapshotServices } from "@opscrew/agents";
import { forbiddenFetch, ScriptedRunner, SERVER_IPV4, testPlan } from "@opscrew/agents/testing";
import type { RemoteExec, ServerSnapshotApi } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerSnapshotsTool } from "./snapshots";

const HCLOUD_TOKEN = fakeSecret("hcloud-token", "snapshots");
const DUMPED = fakeSecret("generic-password", "a dumped value");
const ID = "20261107T030000Z";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The scheduled snapshot `about.json` lists, then its off-server copy's marker. */
const LISTING = [
  JSON.stringify({
    id: ID,
    kind: "scheduled",
    taken: "2026-11-07T03:00:05Z",
    version: `sha256:${"a".repeat(64)}`,
    services: [{ name: "db", kind: "postgres", file: "db.dump", size: 2048 }],
  }),
  `offsite ${ID}`,
].join("\n");

/** No whole-server snapshot at the provider. */
const NO_SERVER_SNAPSHOTS = {
  findAppServers: async () => [],
  listSnapshots: async () => [],
} as unknown as ServerSnapshotApi;

/** The tool on prod, its server's deploy shell answering every command with `stdout`. */
async function connect(stdout: string, exitCode = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-snapshots-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const env = { OPSCREW_HOME: path.join(dir, "home"), HCLOUD_TOKEN };
  const paths = resolveProjectPaths(dir, { env });
  await writeArtifact("plan", paths.files.plan, testPlan({ deployed: true }));
  await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  await mkdir(path.dirname(paths.files.deployKey), { recursive: true });
  await writeFile(paths.files.deployKey, "placeholder\n");
  const commands: string[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command) => {
      commands.push(command);
      return { exitCode, stdout, stderr: `${DUMPED} at ${SERVER_IPV4} with ${HCLOUD_TOKEN}` };
    },
  });
  const services: SnapshotServices = { remote, serverSnapshots: () => NO_SERVER_SNAPSHOTS };
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
    clock: { now: () => new Date("2026-11-07T12:00:00.000Z") },
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerSnapshotsTool(server, deps, { services });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return { client, commands, paths };
}

async function call(client: Client) {
  const result = (await client.callTool({
    name: "opscrew_snapshots",
    arguments: {},
  })) as CallToolResult;
  return { result, text: (result.content[0] as { text: string }).text };
}

describe("opscrew_snapshots", () => {
  it("is read-only, takes projectDir, app and environment, and names the terminal commands", async () => {
    const { client } = await connect(LISTING);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_snapshots");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool?.annotations?.destructiveHint).not.toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "app",
      "environment",
      "projectDir",
    ]);
    expect(tool?.description).toContain("`npx opscrew restore <id>`");
  });

  it("lists the snapshots as text and structured content, changing nothing", async () => {
    const { client, commands, paths } = await connect(LISTING);
    const before = await readFile(paths.files.plan, "utf8");
    const { result, text } = await call(client);
    expect(result.isError, text).toBeFalsy();
    expect(text).toBe(
      `${ID}: scheduled, 2026-11-07 03:00 UTC, version sha256:aaaaaaaaaaaa, 2.0 KB, db, on the app's server, copied off the server`,
    );
    expect(result.structuredContent).toMatchObject({
      snapshots: [
        {
          id: ID,
          kind: "scheduled",
          services: [{ name: "db", kind: "postgres", state: "copied", size: 2048 }],
          where: "on the app's server",
          offsite: true,
        },
      ],
    });
    // Only the listing ran on the server.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("sh snapshot.sh");
    expect(commands[0]).not.toMatch(/take|restore|delete/);
    expect(await readFile(paths.files.plan, "utf8")).toBe(before);
    const all = JSON.stringify(result);
    for (const secret of [SERVER_IPV4, HCLOUD_TOKEN, DUMPED]) expect(all).not.toContain(secret);
  });

  it("says when the server does not answer, without its address or what it printed", async () => {
    const { client } = await connect("", 255);
    const { result, text } = await call(client);
    expect(result.isError).toBe(true);
    expect(text).toContain("did not answer over SSH");
    const all = JSON.stringify(result);
    for (const secret of [SERVER_IPV4, HCLOUD_TOKEN, DUMPED]) expect(all).not.toContain(secret);
  });

  it("says none yet without snapshots", async () => {
    const { client } = await connect("");
    expect((await call(client)).text).toBe("No snapshots yet: `opscrew snapshot` takes one.");
  });
});
