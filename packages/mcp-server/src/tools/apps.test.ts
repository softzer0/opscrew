import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CallToolResult,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { pagesVerificationStateFile, recordOwnServer } from "@opscrew/agents";
import { forbiddenFetch, projectRunner, testPlan } from "@opscrew/agents/testing";
import { exists, resolveProjectPaths } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { createOpscrewMcpServer } from "../server";
import { registerAppTools } from "./apps";
import { registerEnvironmentTools } from "./environments";
import { registerInterviewTools } from "./interview";
import { registerStatusTool } from "./status";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const MONOREPO = fileURLToPath(
  new URL("../../../detect/test/fixtures/monorepo-two-apps/", import.meta.url),
);

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

/**
 * A repository with two deployable folders (apps/api, apps/web) and an MCP client for the app,
 * status, environment and interview tools; `dialogs` answers every dialog (none: the client
 * cannot show one), typing `typed`.
 */
async function connect(options: { dialogs?: boolean; typed?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-apps-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(dir, "repo");
  const home = path.join(dir, "home");
  await materializeFixture(MONOREPO, root);
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: home },
    fetch: forbiddenFetch,
    runner: projectRunner(),
    clock: { now: () => new Date("2026-10-23T12:00:00.000Z") },
    cwd: root,
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerAppTools(server, deps);
  registerStatusTool(server, deps);
  registerEnvironmentTools(server, deps);
  registerInterviewTools(server, deps);
  const client = new Client(
    { name: "opscrew-test-client", version: "0.0.0" },
    options.dialogs === undefined ? {} : { capabilities: { elicitation: { form: {} } } },
  );
  const elicited: string[] = [];
  if (options.dialogs !== undefined) {
    const approve = options.dialogs;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicited.push(String(request.params.message));
      const answer: ElicitResult = approve
        ? {
            action: "accept",
            content: { approve: true, ...(options.typed ? { confirmation: options.typed } : {}) },
          }
        : { action: "decline" };
      return answer;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    root,
    home,
    client,
    elicited,
    async call(name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
  };
}

/** {@link connect} with the further app `web` (apps/web) added. */
async function withWeb(options: { dialogs?: boolean; typed?: string } = {}) {
  const h = await connect(options);
  const added = await h.call("opscrew_app_add", { key: "web", dir: "apps/web" });
  expect(added.isError, textOf(added)).toBeFalsy();
  return h;
}

const webDir = (root: string) => path.join(root, "opscrew", "apps", "web");

describe("the app tools", () => {
  it("are listed, and every tool that takes environment takes app too", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-apps-list-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
    const server = createOpscrewMcpServer({
      version: "0.0.0-test",
      env: { OPSCREW_HOME: path.join(dir, "home") },
      fetch: forbiddenFetch,
      runner: projectRunner(),
      cwd: dir,
    });
    const client = new Client({ name: "opscrew-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["opscrew_app_add", "opscrew_app_list", "opscrew_app_remove"]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.get("opscrew_app_list")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("opscrew_app_add")?.inputSchema.required).toEqual(
      expect.arrayContaining(["key", "dir"]),
    );
    expect(byName.get("opscrew_app_remove")?._meta).toMatchObject({
      "anthropic/requiresUserInteraction": true,
    });
    const withEnvironment = tools.filter(
      (tool) => "environment" in (tool.inputSchema.properties ?? {}),
    );
    expect(withEnvironment.length).toBeGreaterThan(10);
    for (const tool of withEnvironment) {
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toContain("app");
    }
    for (const name of [
      "opscrew_interview_questions",
      "opscrew_save_requirements",
      "opscrew_env_add",
      "opscrew_env_set",
      "opscrew_env_list",
      "opscrew_env_remove",
      "opscrew_promote",
    ]) {
      expect(Object.keys(byName.get(name)?.inputSchema.properties ?? {}), name).toContain("app");
    }
  });

  it("opscrew_app_add writes the app's record; opscrew_app_list lists both apps", async () => {
    const h = await withWeb();
    expect(await exists(path.join(webDir(h.root), "app.yaml"))).toBe(true);
    const list = await h.call("opscrew_app_list");
    expect(list.isError, textOf(list)).toBeFalsy();
    expect(textOf(list)).toContain("- the first app (app .): in .");
    expect(textOf(list)).toContain("- web: in apps/web, not deployed");
    expect(dataOf(list).apps).toEqual([
      { dir: ".", deployed: false },
      { key: "web", dir: "apps/web", deployed: false },
    ]);
  });

  it("opscrew_app_add refuses a folder with no app, writing nothing", async () => {
    const h = await connect();
    const result = await h.call("opscrew_app_add", { key: "docs", dir: "nowhere" });
    expect(result.isError).toBe(true);
    expect(await exists(path.join(h.root, "opscrew", "apps", "docs"))).toBe(false);
  });
});

describe("app on the other tools", () => {
  it("with several apps and none named, is a plain refusal naming app", async () => {
    const h = await withWeb();
    const refused = await h.call("opscrew_status");
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("several apps");
    expect(textOf(refused)).toContain("Pass app, for example web, or . for the first app.");
    expect(textOf(refused)).not.toContain("--app");
  });

  it("acts on the app it names, and names it in the terminal commands it suggests", async () => {
    const h = await withWeb();
    const web = await h.call("opscrew_status", { app: "web" });
    expect(web.isError, textOf(web)).toBeFalsy();
    expect(textOf(web)).toContain("opscrew/apps/web/requirements.yaml");
    const first = await h.call("opscrew_status", { app: "." });
    expect(first.isError, textOf(first)).toBeFalsy();
    expect(textOf(first)).not.toContain("opscrew/apps/web");
    const envs = await h.call("opscrew_env_list", { app: "web" });
    expect(envs.isError, textOf(envs)).toBeFalsy();
    const questions = await h.call("opscrew_interview_questions", { app: "web" });
    expect(questions.isError, textOf(questions)).toBeFalsy();
    // A further app's folder is its record's: no question asks which app to deploy.
    expect(textOf(questions)).not.toContain("answer id: appDir");
    // Its next step names the app.
    const report = resolveProjectPaths(h.root, { env: { OPSCREW_HOME: h.home }, app: "web" }).files
      .scanReportMd;
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, "# Scan\n");
    const next = await h.call("opscrew_status", { app: "web" });
    expect(textOf(next)).toContain("opscrew_save_requirements with app web.");
    // Once it has a plan, the next step names the app's own plan file.
    const paths = resolveProjectPaths(h.root, { env: { OPSCREW_HOME: h.home }, app: "web" });
    await writeFile(paths.files.requirements, "provider: hetzner\n");
    const plan = testPlan();
    const { dir: _dir, ...infra } = plan.infra;
    const { workflowPath: _workflow, ...cicd } = plan.cicd;
    await writeArtifact(
      "plan",
      paths.files.plan,
      DeployPlanSchema.parse({
        ...plan,
        app: { ...plan.app, key: "web", name: "web" },
        infra,
        cicd,
      }),
    );
    const planned = await h.call("opscrew_status", { app: "web" });
    expect(textOf(planned)).toContain(
      "Apply the pending code changes from opscrew/apps/web/plan.yaml",
    );
    expect(textOf(planned)).toContain("`npx opscrew provision --app web`");
    const unknown = await h.call("opscrew_status", { app: "docs" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('no app "docs"');
  });

  it("never shows the address of a further app's server the user owns", async () => {
    const h = await withWeb();
    const host = path.basename(path.dirname(h.root));
    await recordOwnServer(
      resolveProjectPaths(h.root, { env: { OPSCREW_HOME: h.home }, app: "web" }),
      {
        host,
        port: 22,
        user: "root",
        agent: true,
        reachable: true,
        serve: "dns-only",
        hostKey: `SHA256:${"A".repeat(43)}`,
      },
    );
    const result = await h.call("opscrew_status", { app: "." });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(textOf(result)).toContain("your server");
    expect(JSON.stringify(result)).not.toContain(host);

    // A damaged app record still hides the address of every app with a folder.
    await writeFile(path.join(webDir(h.root), "app.yaml"), "dir: [\n");
    const damaged = await h.call("opscrew_status", { app: "." });
    expect(JSON.stringify(damaged)).toContain("your server");
    expect(JSON.stringify(damaged)).not.toContain(host);
  });
});

describe("opscrew_app_remove", () => {
  it("refuses without dialogs, with the terminal command, and removes nothing", async () => {
    const h = await withWeb();
    const result = await h.call("opscrew_app_remove", { key: "web" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`npx opscrew app remove web`");
    expect(await exists(webDir(h.root))).toBe(true);
  });

  it("removes the app only once the user types its key", async () => {
    const declined = await withWeb({ dialogs: false });
    const refused = await declined.call("opscrew_app_remove", { key: "web" });
    expect(refused.isError).toBe(true);
    expect(declined.elicited[0]).toContain("deploy keys, state passphrases and generated secrets");
    expect(await exists(webDir(declined.root))).toBe(true);

    const typed = await withWeb({ dialogs: true, typed: "web" });
    const removed = await typed.call("opscrew_app_remove", { key: "web" });
    expect(removed.isError, textOf(removed)).toBeFalsy();
    expect(textOf(removed)).toContain("opscrew/apps/web");
    expect(await exists(webDir(typed.root))).toBe(false);
  });

  it("refuses a deployed further app without opening its dialog", async () => {
    const h = await withWeb({ dialogs: true, typed: "web" });
    const paths = resolveProjectPaths(h.root, { env: { OPSCREW_HOME: h.home }, app: "web" });
    const plan = testPlan({ deployed: true });
    const { dir: _dir, ...infra } = plan.infra;
    const { workflowPath: _workflow, ...cicd } = plan.cicd;
    await writeArtifact(
      "plan",
      paths.files.plan,
      DeployPlanSchema.parse({
        ...plan,
        app: { ...plan.app, key: "web", name: "web" },
        infra,
        cicd,
      }),
    );
    const result = await h.call("opscrew_app_remove", { key: "web" });
    expect(result.isError).toBe(true);
    expect(h.elicited).toEqual([]);
    expect(textOf(result)).toContain("`opscrew destroy --app web`");
    expect(await exists(webDir(h.root))).toBe(true);
  });

  it("refuses without a dialog while GitHub Pages' verification record may be in DNS", async () => {
    const h = await withWeb({ dialogs: true, typed: "web" });
    const paths = resolveProjectPaths(h.root, { env: { OPSCREW_HOME: h.home }, app: "web" });
    const state = pagesVerificationStateFile(paths);
    await mkdir(path.dirname(state), { recursive: true });
    await writeFile(state, "a state OpsCrew cannot read");
    const result = await h.call("opscrew_app_remove", { key: "web" });
    expect(result.isError).toBe(true);
    expect(h.elicited).toEqual([]);
    expect(textOf(result)).toContain("--delete-verification");
    expect(await exists(webDir(h.root))).toBe(true);
  });

  it("refuses the first app without asking", async () => {
    const h = await withWeb({ dialogs: true, typed: "web" });
    const result = await h.call("opscrew_app_remove", { key: "." });
    expect(result.isError).toBe(true);
    expect(h.elicited).toEqual([]);
    expect(textOf(result)).toContain("removes a further app");
  });
});
