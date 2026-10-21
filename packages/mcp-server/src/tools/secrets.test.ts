import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CallToolResult,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { refreshRecoveryCopy } from "@opscrew/agents";
import {
  createProject,
  createTestPhaseDeps,
  FAKE_SOPS,
  FakeGitHub,
  FakeSops,
  forbiddenFetch,
  projectRunner,
  ScriptedRunner,
} from "@opscrew/agents/testing";
import { findExecutable, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { auditText } from "./__fixtures__/audit";
import { registerSecretsTools } from "./secrets";

const DB_PASSWORD = fakeSecret("generic-password", "mcp-recovery-db");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

/** The key line of a key file OpsCrew wrote. */
async function identityIn(file: string): Promise<string> {
  const line = (await readFile(file, "utf8"))
    .split("\n")
    .find((text) => text.startsWith("AGE-SECRET-KEY-1"));
  if (line === undefined) throw new Error(`no age key in ${file}`);
  return line;
}

/**
 * A git project with OpsCrew's files for it and its first recovery copy (key in `keyFile`), and
 * an MCP client connected to the secrets tools; `dialogs` answers every approval with yes.
 */
async function connect(options: { dialogs?: boolean } = {}) {
  const project = await createProject();
  cleanups.push(() => rm(project.root, { recursive: true, force: true, maxRetries: 3 }));
  cleanups.push(() => rm(project.bare, { recursive: true, force: true, maxRetries: 3 }));
  const keys = await tempDir("opscrew-mcp-keys-");
  const env = {
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    OPSCREW_HOME: await tempDir("opscrew-mcp-secrets-home-"),
    OPSCREW_SOPS_BIN: FAKE_SOPS,
  };
  const sops = new FakeSops();
  const home = resolveProjectPaths(project.root, { env }).projectHomeDir;
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "generated_values.json"),
    `${JSON.stringify({ dbPassword: DB_PASSWORD })}\n`,
  );
  const keyFile = path.join(keys, "age-key.txt");
  const first = await refreshRecoveryCopy(
    await createTestPhaseDeps({
      root: project.root,
      env,
      runner: sops.runner(new ScriptedRunner()),
    }),
    { app: { name: "shop" } },
    { repositoryPrivate: async () => true, keyOut: async () => keyFile },
  );
  if (!first.changed) throw new Error("expected the first copy");
  for (const file of first.repositoryFiles) {
    await writeFile(path.join(project.root, file.path), file.content);
  }
  await project.git(project.root, "add", "opscrew");
  await project.git(project.root, "commit", "-m", "copy");

  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: sops.runner(projectRunner()),
    clock: { now: () => new Date("2026-10-21T12:00:00.000Z") },
    cwd: project.root,
  });
  const github = new FakeGitHub();
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerSecretsTools(server, deps, { provisionServices: { github } });
  const client = new Client(
    { name: "opscrew-test-client", version: "0.0.0" },
    options.dialogs === true ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const elicited: unknown[] = [];
  if (options.dialogs === true) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicited.push(request.params);
      const approved: ElicitResult = { action: "accept", content: { approve: true } };
      return approved;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const outputs: CallToolResult[] = [];
  return {
    ...project,
    client,
    github,
    home,
    keys,
    keyFile,
    identity: await identityIn(keyFile),
    outputs,
    elicited,
    audit: () => auditText(project.root, env),
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      outputs.push(result);
      return result;
    },
  };
}

describe.skipIf(!findExecutable("git"))("the recovery copy's tools", () => {
  it("lists the four tools: restore takes only keyFile, rotate requires keyOut", async () => {
    const h = await connect();
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("opscrew_secrets_status")?.annotations?.readOnlyHint).toBe(true);
    const restore = byName.get("opscrew_secrets_restore");
    expect(restore?.inputSchema.required).toContain("keyFile");
    expect(Object.keys(restore?.inputSchema.properties ?? {}).sort()).toEqual(
      ["from", "keyFile", "onConflict", "projectDir"].sort(),
    );
    expect(byName.get("opscrew_secrets_rotate")?.inputSchema.required).toContain("keyOut");
    expect(byName.get("opscrew_secrets_folder")?.inputSchema.required).toContain("folder");
    for (const name of ["opscrew_secrets_restore", "opscrew_secrets_rotate"]) {
      expect(byName.get(name)?._meta, name).toMatchObject({
        "anthropic/requiresUserInteraction": true,
      });
    }
  });

  it("status shows the copy's update, its keys and the folder", async () => {
    const h = await connect();
    const result = await h.call("opscrew_secrets_status");
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(textOf(result)).toContain("1 key can open it");
    expect(dataOf(result)).toMatchObject({ exists: true, recipients: 1, behind: false });

    const folder = path.join(h.keys, "copies");
    expect((await h.call("opscrew_secrets_folder", { folder })).isError).toBeFalsy();
    expect(dataOf(await h.call("opscrew_secrets_status")).folder).toBe(folder);
    expect((await h.call("opscrew_secrets_folder", { folder: null })).isError).toBeFalsy();
    expect(dataOf(await h.call("opscrew_secrets_status")).folder).toBeUndefined();
  });

  it("restore reads the key only from keyFile and never returns it or a value", async () => {
    const h = await connect();
    await rm(h.home, { recursive: true, force: true });
    const result = await h.call("opscrew_secrets_restore", { keyFile: h.keyFile });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(dataOf(result).restored).toEqual(["home/generated_values.json"]);
    expect(await readFile(path.join(h.home, "generated_values.json"), "utf8")).toContain(
      DB_PASSWORD,
    );

    // A differing file stops the restore, by name only, until the user chooses.
    const local = fakeSecret("generic-password", "mcp-local");
    await writeFile(path.join(h.home, "generated_values.json"), `{"dbPassword":"${local}"}\n`);
    const stopped = await h.call("opscrew_secrets_restore", { keyFile: h.keyFile });
    expect(textOf(stopped)).toContain("The generated values that differ: dbPassword.");
    expect(dataOf(stopped).conflicts.paths).toEqual(["home/generated_values.json"]);

    const relative = await h.call("opscrew_secrets_restore", { keyFile: "age-key.txt" });
    expect(relative.isError).toBe(true);
    expect(textOf(relative)).toContain("must be a full path");
    const all = JSON.stringify(h.outputs);
    for (const secret of [h.identity, DB_PASSWORD, local]) expect(all).not.toContain(secret);
  });

  it("rotate writes the new key only to keyOut and proposes the copy in a pull request", async () => {
    const h = await connect({ dialogs: true });
    const keyOut = path.join(h.keys, "new-key.txt");
    const result = await h.call("opscrew_secrets_rotate", { keyOut, backup: null });
    expect(result.isError, textOf(result)).toBeFalsy();
    const fresh = await identityIn(keyOut);
    expect(fresh).not.toBe(h.identity);
    expect(dataOf(result)).toMatchObject({ keyFile: keyOut, branch: "opscrew/deploy-setup" });
    expect(textOf(result)).toContain(`OpsCrew wrote your new age key to ${keyOut}.`);
    expect(textOf(result)).toContain("Older commits");
    expect(h.github.pulls).toHaveLength(1);
    expect(h.elicited.length).toBeGreaterThan(0);
    const audit = await h.audit();
    expect(audit).toContain('"action":"pull-request"');
    expect(JSON.stringify([h.outputs, h.elicited, audit])).not.toContain(fresh);
  });

  it("rotate refuses without dialogs, before any key is made", async () => {
    const h = await connect();
    const keyOut = path.join(h.keys, "never.txt");
    const result = await h.call("opscrew_secrets_rotate", { keyOut });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`npx opscrew secrets rotate --key-out ${keyOut}`);
    await expect(readFile(keyOut, "utf8")).rejects.toThrow();
  });
});
