import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CallToolResult,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { type DriftReport, type PromoteGitHubApi, recordOwnServer } from "@opscrew/agents";
import { createProject, forbiddenFetch, projectRunner, testPlan } from "@opscrew/agents/testing";
import { exists, resolveProjectPaths, sha256Hex } from "@opscrew/core";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerEnvironmentTools } from "./environments";
import { registerStatusTool } from "./status";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

/** `prod` as the plan of the environment `name`, as design writes it. */
function inEnvironment(prod: DeployPlan, name: string, block: Record<string, unknown> = {}) {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name, ...block },
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
  });
}

const STAGING_IMAGE = `sha256:${sha256Hex("image:staging")}`;
const STAGING_COMMIT = sha256Hex("commit:staging").slice(0, 40);
const PROD_WORKFLOW = "name: OpsCrew deploy\n# prod, promoted from staging\n";

/** GitHub and GHCR as a promotion from staging reads them: staging's image, built on main. */
class FakePromoteGitHub implements PromoteGitHubApi {
  readonly dispatches: string[] = [];
  async getRepo() {
    return { defaultBranch: "main", private: true, canPush: true };
  }
  async fileSha(_owner: string, _repo: string, file: string) {
    if (file !== ".github/workflows/opscrew-deploy.yml") return undefined;
    const bytes = Buffer.from(PROD_WORKFLOW, "utf8");
    return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  }
  async taggedDigest(_owner: string, _image: string, tag: string) {
    return tag === "opscrew-staging" || tag === `${STAGING_COMMIT}-staging`
      ? STAGING_IMAGE
      : undefined;
  }
  async imageProvenance() {
    return {
      builderId: "https://github.com/acme/shop/actions/runs/501/attempts/1",
      runId: 501,
      repository: "acme/shop",
    };
  }
  async workflowRun() {
    return {
      repository: "acme/shop",
      headRepository: "acme/shop",
      event: "push",
      headBranch: "main",
      headSha: STAGING_COMMIT,
      path: ".github/workflows/opscrew-deploy-staging.yml",
    };
  }
  async dispatchWorkflow(_owner: string, _repo: string, workflowFile: string) {
    this.dispatches.push(workflowFile);
    return { runId: 777, url: "https://github.com/acme/shop/actions/runs/777" };
  }
  /** True when the run waits for a required reviewer when the wait ends. */
  pending = false;
  async waitForWorkflowRun() {
    return {
      id: 777,
      status: this.pending ? ("waiting" as const) : ("completed" as const),
      conclusion: this.pending ? null : "success",
      htmlUrl: "https://github.com/acme/shop/actions/runs/777",
    };
  }
  async getWorkflowRun(_owner: string, _repo: string, runId: number) {
    return {
      id: runId,
      status: this.pending ? "waiting" : "completed",
      conclusion: this.pending ? null : "success",
      htmlUrl: "https://github.com/acme/shop/actions/runs/777",
      headSha: STAGING_COMMIT,
      createdAt: "2026-10-22T12:00:00Z",
    };
  }
  async getEnvironment() {
    return undefined;
  }
}

/** Nothing changed outside OpsCrew and nothing waits for provision. */
const cleanDrift = async (): Promise<DriftReport> => ({
  drift: [],
  pending: [],
  files: { changed: [], created: [] },
  foreignDnsRecords: [],
  clean: true,
  checkedAt: "2026-10-22T12:00:00.000Z",
  provider: "hetzner",
});

/**
 * A git project with prod (promoted from staging) and staging, both deployed, and an MCP client;
 * `dialogs` answers every approval dialog (none: the client cannot show one).
 */
async function connect(options: { dialogs?: boolean; typed?: string } = {}) {
  const prod = testPlan({ deployed: true });
  const project = await createProject(
    DeployPlanSchema.parse({
      ...prod,
      environment: { deploySource: { from: "promote", source: "staging" } },
    }),
  );
  cleanups.push(() => rm(project.root, { recursive: true, force: true, maxRetries: 3 }));
  cleanups.push(() => rm(project.bare, { recursive: true, force: true, maxRetries: 3 }));
  await writeArtifact(
    "plan",
    path.join(project.root, "opscrew", "environments", "staging", "plan.yaml"),
    inEnvironment(prod, "staging"),
  );
  const workflow = path.join(project.root, ".github", "workflows", "opscrew-deploy.yml");
  await mkdir(path.dirname(workflow), { recursive: true });
  await writeFile(workflow, PROD_WORKFLOW);
  const home = path.join(project.root, "..", `${path.basename(project.root)}-home`);
  cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: home },
    fetch: forbiddenFetch,
    runner: projectRunner(),
    clock: { now: () => new Date("2026-10-22T12:00:00.000Z") },
    cwd: project.root,
  });
  const github = new FakePromoteGitHub();
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerEnvironmentTools(server, deps, { promote: { github, drift: cleanDrift } });
  registerStatusTool(server, deps);
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
    root: project.root,
    home,
    client,
    github,
    elicited,
    async call(name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
  };
}

describe("the environment tools", () => {
  it("lists env add, set, list, remove and promote; promote asks the user on every call", async () => {
    const h = await connect();
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "opscrew_env_add",
      "opscrew_env_set",
      "opscrew_env_list",
      "opscrew_env_remove",
      "opscrew_promote",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    const promote = byName.get("opscrew_promote");
    expect(promote?.inputSchema.required).toContain("to");
    expect(Object.keys(promote?.inputSchema.properties ?? {}).sort()).toEqual(
      ["digest", "projectDir", "to"].sort(),
    );
    expect(promote?._meta).toMatchObject({ "anthropic/requiresUserInteraction": true });
    expect(byName.get("opscrew_env_list")?.annotations?.readOnlyHint).toBe(true);
  });

  it("lists the environments and changes a deploy source", async () => {
    const h = await connect();
    const listed = await h.call("opscrew_env_list");
    expect(listed.isError, textOf(listed)).toBeFalsy();
    expect(textOf(listed)).toContain("- prod: runs on hetzner, promoted from staging");
    expect(textOf(listed)).toContain("- staging: runs on hetzner, deployed on each push");
    const set = await h.call("opscrew_env_set", { name: "prod", from: "main" });
    expect(set.isError, textOf(set)).toBeFalsy();
    expect(textOf(set)).toContain("`npx opscrew provision --env prod`");
    const plan = await readArtifact("plan", path.join(h.root, "opscrew", "plan.yaml"));
    expect(plan.environment?.deploySource).toEqual({ from: "main" });
  });

  it("names an environment's runner machine, and changes where its deploy job runs", async () => {
    const h = await connect();
    await writeArtifact(
      "plan",
      path.join(h.root, "opscrew", "environments", "qa", "plan.yaml"),
      inEnvironment(testPlan(), "qa", {
        runner: "host",
        runnerHost: { name: "home", arch: "amd64" },
      }),
    );
    expect(textOf(await h.call("opscrew_env_list"))).toContain(
      "- qa: runs on hetzner, deployed on each push, deploy job on the runner machine home, not deployed",
    );

    const set = await h.call("opscrew_env_set", { name: "staging", runner: "server" });
    expect(set.isError, textOf(set)).toBeFalsy();
    expect(textOf(set)).toContain(
      "The staging environment's deploy job runs on a runner on the server; GitHub's machines build its image.",
    );
    expect(dataOf(set)).toMatchObject({ runner: "server", build: "github" });
    const plan = await readArtifact(
      "plan",
      path.join(h.root, "opscrew", "environments", "staging", "plan.yaml"),
    );
    expect(plan.environment?.runner).toBe("server");

    // The server's runner never builds; build goes with runner.
    const builds = await h.call("opscrew_env_set", {
      name: "staging",
      runner: "server",
      build: "runner",
    });
    expect(builds.isError).toBe(true);
    expect(textOf(builds)).toContain("The server's runner never builds");
    const alone = await h.call("opscrew_env_set", { name: "staging", build: "runner" });
    expect(textOf(alone)).toContain("runnerHost and build go with runner.");
  });

  it("refuses to remove a deployed environment", async () => {
    const h = await connect({ dialogs: true, typed: "staging" });
    const result = await h.call("opscrew_env_remove", { name: "staging" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`opscrew destroy --env staging`");
  });

  it("removes an environment only once the user typed its name in the dialog", async () => {
    const qa = (root: string) => path.join(root, "opscrew", "environments", "qa", "plan.yaml");
    const addQa = (root: string) =>
      writeArtifact("plan", qa(root), inEnvironment(testPlan(), "qa"));

    const terminal = await connect();
    await addQa(terminal.root);
    const noDialogs = await terminal.call("opscrew_env_remove", { name: "qa" });
    expect(noDialogs.isError).toBe(true);
    expect(textOf(noDialogs)).toContain("`npx opscrew env remove qa`");
    expect(await exists(qa(terminal.root))).toBe(true);

    const declined = await connect({ dialogs: false });
    await addQa(declined.root);
    const refused = await declined.call("opscrew_env_remove", { name: "qa" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("nothing was removed");
    expect(declined.elicited[0]).toContain("deploy key, state passphrase and generated secrets");
    expect(await exists(qa(declined.root))).toBe(true);

    const typed = await connect({ dialogs: true, typed: "qa" });
    await addQa(typed.root);
    const removed = await typed.call("opscrew_env_remove", { name: "qa" });
    expect(removed.isError, textOf(removed)).toBeFalsy();
    expect(await exists(qa(typed.root))).toBe(false);
  });

  it("the deploy tools name the environment: several and none named is a plain refusal", async () => {
    const h = await connect();
    const refused = await h.call("opscrew_status");
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("several environments");
    expect(textOf(refused)).toContain('"staging"');
    expect(textOf(refused)).toContain("Pass environment, for example staging.");
    expect(textOf(refused)).not.toContain("--env");
    const staging = await h.call("opscrew_status", { environment: "staging" });
    expect(staging.isError, textOf(staging)).toBeFalsy();
    expect(textOf(staging)).toContain("opscrew/environments/staging/plan.yaml: present");
  });
});

describe("opscrew_promote", () => {
  it("refuses without dialogs, with the terminal command, and starts nothing", async () => {
    const h = await connect();
    const result = await h.call("opscrew_promote", { to: "prod" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`npx opscrew promote --to prod`");
    expect(h.github.dispatches).toEqual([]);
  });

  it("is never granted without the user: a declined dialog deploys nothing", async () => {
    const h = await connect({ dialogs: false });
    const result = await h.call("opscrew_promote", { to: "prod" });
    expect(result.isError).toBe(true);
    expect(h.elicited).toHaveLength(1);
    expect(h.elicited[0]).toMatch(/Promotion hash: [0-9a-f]{64}/);
    expect(textOf(result)).toContain("The user declined; nothing was deployed.");
    expect(textOf(result)).toContain("`npx opscrew promote --to prod`");
    expect(JSON.stringify(result)).not.toContain("--approve");
    expect(h.github.dispatches).toEqual([]);
  });

  it("deploys staging's image once the user approves, and returns the promotion's hash", async () => {
    const h = await connect({ dialogs: true });
    const result = await h.call("opscrew_promote", { to: "prod" });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(dataOf(result)).toMatchObject({ digest: STAGING_IMAGE });
    expect(dataOf(result).promotionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(textOf(result)).toContain(`(promotion ${dataOf(result).promotionHash})`);
    expect(h.elicited[0]).toContain(dataOf(result).promotionHash);
    expect(h.github.dispatches).toEqual(["opscrew-deploy.yml"]);
  });

  it("reports a run that waits for a required reviewer as waiting, never as a failure", async () => {
    const h = await connect({ dialogs: true });
    h.github.pending = true;
    const result = await h.call("opscrew_promote", { to: "prod" });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(dataOf(result)).toMatchObject({ status: "waiting", digest: STAGING_IMAGE });
    expect(textOf(result)).toContain(
      "waits in GitHub for a required reviewer: https://github.com/acme/shop/actions/runs/777",
    );
    expect(textOf(result)).toContain("The deploy goes on once the reviewer approves it in GitHub.");
  });
});

describe("the addresses of every environment", () => {
  it("never shows the address of a staging server the user owns", async () => {
    const h = await connect();
    // The project's own folder name stands in for an address a tool's text would carry.
    const host = path.basename(h.root);
    await recordOwnServer(
      resolveProjectPaths(h.root, { env: { OPSCREW_HOME: h.home }, environment: "staging" }),
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
    const result = await h.call("opscrew_status", { environment: "prod" });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(textOf(result)).toContain("your server");
    expect(JSON.stringify(result)).not.toContain(host);
  });
});
