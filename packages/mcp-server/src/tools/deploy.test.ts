import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CallToolResult,
  type ElicitRequestFormParams,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { hasDeployment, type ProvisionServices, recordServerAddress } from "@opscrew/agents";
import { ScriptedRunner } from "@opscrew/agents/testing";
import type {
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacEngine,
  PlanSummary,
  RemoteExec,
  ResourceChange,
} from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { defaultScanners } from "@opscrew/secops";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { type DeployToolOptions, registerDeployTools } from "./deploy";
import { approvalMessage } from "./elicitation";

// ---------------------------------------------------------------------------------------------
// Fakes (adapted from packages/agents/src/provision/__fixtures__/fakes.ts, which is not exported)
// ---------------------------------------------------------------------------------------------

const SERVER_IPV4 = "203.0.113.10";
const SERVER_IPV6 = "2001:db8::1";
/** A public host key (not a secret). */
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTestsOnlyHostKeyForTestsOnly";
const STRIPE = fakeSecret("stripe-live-key");
const HCLOUD = fakeSecret("hcloud-token");
const PR_URL = "https://github.com/acme/shop/pull/7";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function testPlan(options: { deployed?: boolean } = {}) {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
    app: {
      name: "shop",
      port: 3000,
      healthPath: "/api/health",
      env: [
        { name: "DATABASE_URL", secret: true, source: "derived" },
        { name: "SESSION_SECRET", secret: true, source: "generated" },
        { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
      ],
    },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: true,
    },
    services: { postgres: true, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 8.41, currency: "EUR" },
      breakdown: [
        { item: "server", monthly: { amount: 6.59, currency: "EUR" } },
        { item: "backups", monthly: { amount: 1.32, currency: "EUR" } },
        { item: "ipv4", monthly: { amount: 0.5, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    ...(options.deployed ? { deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" } } : {}),
  });
}

/** `show -json` shaped like the rendered root module; passes every policy. */
function planJson() {
  const web = ["0.0.0.0/0", "::/0"];
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.server",
            resources: [
              {
                address: "module.server.hcloud_server.this",
                mode: "managed",
                type: "hcloud_server",
                name: "this",
                values: {
                  name: "shop",
                  backups: true,
                  delete_protection: true,
                  rebuild_protection: true,
                },
              },
              {
                address: "module.server.hcloud_firewall.this",
                mode: "managed",
                type: "hcloud_firewall",
                name: "this",
                values: {
                  name: "shop-firewall",
                  rule: [
                    { direction: "in", protocol: "tcp", port: "22", source_ips: web },
                    { direction: "in", protocol: "tcp", port: "80", source_ips: web },
                    { direction: "in", protocol: "tcp", port: "443", source_ips: web },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
    resource_changes: [
      {
        address: "module.server.hcloud_server.this",
        change: {
          actions: ["create"],
          after_unknown: { id: true, firewall_ids: true, ssh_keys: [true] },
        },
      },
    ],
  };
}

const change = (name: string, type: string, action: ResourceChange["action"]): ResourceChange => ({
  address: `module.server.${type}.${name}`,
  type,
  name,
  provider: "registry.opentofu.org/hetznercloud/hcloud",
  action,
});

const CREATE: ResourceChange[] = [
  change("deploy", "hcloud_ssh_key", "create"),
  change("this", "hcloud_firewall", "create"),
  change("this", "hcloud_server", "create"),
];

/** IaC engine fake: writes real plan files and enforces the hash binding like the real engines. */
class FakeEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly calls: string[] = [];
  readonly applied: { planFile: string; approval: IacApproval }[] = [];
  #counter = 0;
  constructor(private readonly changes: ResourceChange[] = CREATE) {}

  async init() {
    this.calls.push("init");
  }
  async validate() {
    this.calls.push("validate");
    return { valid: true, diagnostics: [] };
  }
  async plan(dir: string, planFile: string): Promise<PlanSummary> {
    this.calls.push("plan");
    const content = `fake plan ${++this.#counter} for ${dir}`;
    await writeFile(planFile, content);
    const count = (action: string) => this.changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256(content),
      createdAt: "2026-10-11T12:00:00.000Z",
      changes: this.changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: this.changes.some((c) => c.action === "delete" || c.action === "replace"),
      planJson: planJson(),
    };
  }
  async apply(_dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    this.calls.push("apply");
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    this.applied.push({ planFile, approval });
    return {
      ok: true,
      outputs: {
        server_ipv4: SERVER_IPV4,
        server_ipv6: SERVER_IPV6,
        server_id: "4711",
        server_name: "shop",
        url: `http://${SERVER_IPV4}`,
      },
      log: "Apply complete!",
    };
  }
  async output() {
    this.calls.push("output");
    return {};
  }
}

/** GitHub REST fake recording secrets (plaintext, test only) and pull requests. */
class FakeGitHub {
  readonly secrets = new Map<string, string>();
  readonly pulls: { head: string; base: string; title: string }[] = [];
  async getRepo() {
    return { defaultBranch: "main", private: true, canPush: true };
  }
  async getActionsPublicKey() {
    return { keyId: "key-1", key: "dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==" };
  }
  async setActionsSecret(_owner: string, _repo: string, name: string, value: string) {
    this.secrets.set(name, value);
  }
  async findOpenPullRequest() {
    return undefined;
  }
  async createPullRequest(input: { head: string; base: string; title: string }) {
    this.pulls.push(input);
    return { number: 7, url: PR_URL };
  }
  async createOrphanBranch() {
    return { commit: "c".repeat(40) };
  }
  async replaceOrphanBranch() {
    return { commit: "d".repeat(40), previous: "e".repeat(40) };
  }
  async branchHoldsOnly() {
    return false;
  }
}

const readyRemote = (host: string): RemoteExec => ({
  host,
  run: async () => ({ exitCode: 0, stdout: "ready\n", stderr: "" }),
});

/** Real git; `ssh-keyscan` answers with {@link HOST_KEY}; every other command fails. */
function projectRunner(): ScriptedRunner {
  const real = new NodeCommandRunner();
  return new ScriptedRunner(async (command, args, options) => {
    if (command === "git") return real.run(command, args, options);
    if (command === "ssh-keyscan") {
      return { exitCode: 0, stdout: `${args[args.length - 1]} ${HOST_KEY}\n`, stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: `${command}: not available in tests` };
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** Temp git project with a committed Dockerfile and a GitHub `origin` that pushes to a bare repo. */
async function createProject(plan = testPlan()) {
  const runner = new NodeCommandRunner();
  const root = await tempDir("opscrew-mcp-deploy-");
  const bare = await tempDir("opscrew-mcp-deploy-remote-");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runner.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpsCrew Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "remote", "add", "origin", "https://github.com/acme/shop.git");
  await git(root, "remote", "set-url", "--push", "origin", bare);
  await writeFile(path.join(root, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
  await writeFile(path.join(root, ".gitignore"), ".opscrew/\n.env\nproduction.env\n");
  await git(root, "add", "Dockerfile", ".gitignore");
  await git(root, "commit", "-m", "init");
  await writeArtifact("plan", path.join(root, "opscrew", "plan.yaml"), plan);
  // A deployed project: the server's address is in the local state, as provision leaves it.
  if (hasDeployment(plan)) {
    await recordServerAddress(resolveProjectPaths(root), { ipv4: SERVER_IPV4, ipv6: SERVER_IPV6 });
  }
  await writeFile(path.join(root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  return { root, bare, git };
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

type Answer = (params: ElicitRequestFormParams) => ElicitResult;

interface HarnessOptions {
  /** Answers elicitation requests; omit for a client without elicitation support. */
  elicit?: Answer;
  /** Extra env (for example `OPSCREW_APP_ENV_FILE`). */
  env?: Record<string, string | undefined>;
  plan?: ReturnType<typeof testPlan>;
  engine?: FakeEngine;
  tools?: Omit<DeployToolOptions, "provisionServices">;
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

const forbiddenFetch: FetchLike = async (input) => {
  throw new Error(`Unexpected network call in a test: ${String(input)}`);
};

async function connect(options: HarnessOptions = {}) {
  const project = await createProject(options.plan);
  const home = await tempDir("opscrew-mcp-deploy-home-");
  const engine = options.engine ?? new FakeEngine();
  const github = new FakeGitHub();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
  };
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    CLOUDFLARE_API_TOKEN: undefined,
    OPSCREW_APP_ENV_FILE: undefined,
    OPSCREW_HOME: home,
    HCLOUD_TOKEN: HCLOUD,
    ...options.env,
  };
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: projectRunner(),
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
    cwd: project.root,
    scanners: () => defaultScanners({ includeExternal: false }),
  });
  deps.redactor.addLiteral(STRIPE, "STRIPE_SECRET_KEY");
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerDeployTools(server, deps, { provisionServices: services, ...options.tools });

  const client = new Client(
    { name: "opscrew-test-client", version: "0.0.0" },
    options.elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const elicited: ElicitRequestFormParams[] = [];
  const answer = options.elicit;
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as ElicitRequestFormParams;
      elicited.push(params);
      return answer(params);
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
    engine,
    github,
    elicited,
    outputs,
    deps,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      outputs.push(result);
      return result;
    },
  };
}

/** Approves every yes/no request and types the requested phrase. */
const approveAll: Answer = (params) => {
  const props = params.requestedSchema.properties;
  if ("confirmation" in props) {
    const phrase = /Type "([^"]+)"/.exec(String(props.confirmation?.title))?.[1] ?? "";
    const typed: ElicitResult = { action: "accept", content: { confirmation: phrase } };
    return typed;
  }
  const approved: ElicitResult = { action: "accept", content: { approve: true } };
  return approved;
};

function expectNoSecrets(h: Awaited<ReturnType<typeof connect>>) {
  const all = JSON.stringify([h.outputs, h.elicited]);
  expect(all).not.toContain(STRIPE);
  expect(all).not.toContain(HCLOUD);
  expect(all).not.toContain("PRIVATE KEY");
  for (const value of h.github.secrets.values()) {
    for (const line of value.split("\n")) {
      if (line.length >= 20 && !line.startsWith("-----")) expect(all).not.toContain(line);
    }
  }
}

const DEPLOY_TOOLS = [
  "opscrew_render",
  "opscrew_plan",
  "opscrew_apply",
  "opscrew_secure",
  "opscrew_verify",
];

// ---------------------------------------------------------------------------------------------

describe.skipIf(!findExecutable("git"))(
  "deploy tools",
  () => {
    it("lists the five deploy tools with schemas, annotations and the user-interaction flag", async () => {
      const h = await connect();
      const { tools } = await h.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of DEPLOY_TOOLS) {
        const tool = byName.get(name);
        expect(tool, name).toBeDefined();
        expect(tool?.title).toBeTruthy();
        expect(tool?.description?.length).toBeGreaterThan(80);
        expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("projectDir");
        expect(tool?.annotations, name).toBeDefined();
      }
      expect(byName.get("opscrew_render")?.annotations?.readOnlyHint).toBe(true);
      const apply = byName.get("opscrew_apply");
      expect(apply?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(apply?.inputSchema.required).toContain("planHash");
      expect(apply?._meta).toMatchObject({ "anthropic/requiresUserInteraction": true });
      expect(byName.get("opscrew_plan")?._meta).toMatchObject({
        "anthropic/requiresUserInteraction": true,
      });
      expect(byName.get("opscrew_plan")?.annotations?.destructiveHint).toBe(false);
    });

    it("opscrew_render previews the generated files without writing them", async () => {
      const h = await connect();
      const result = await h.call("opscrew_render");
      expect(result.isError, textOf(result)).toBeFalsy();
      const data = dataOf(result);
      expect(data.created).toEqual(
        expect.arrayContaining([
          "opscrew/infra/prod/main.tf",
          "opscrew/runtime/compose.yaml",
          ".github/workflows/opscrew-deploy.yml",
        ]),
      );
      expect(data.files.length).toBe(data.created.length);
      expect(textOf(result)).toContain("Nothing was written");
      expect(existsSync(path.join(h.root, "opscrew", "infra"))).toBe(false);
      expect(h.engine.calls).toEqual([]);
      expect(await h.git(h.root, "status", "--porcelain")).not.toContain("opscrew/infra");
    });

    it("opscrew_plan writes the files and returns hash, changes, cost and policies without applying", async () => {
      const h = await connect({ elicit: approveAll });
      const result = await h.call("opscrew_plan");
      expect(result.isError, textOf(result)).toBeFalsy();
      const data = dataOf(result);
      expect(data.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.changes).toHaveLength(3);
      expect(data.counts).toEqual({ create: 3, update: 0, delete: 0, replace: 0 });
      expect(data.cost.monthly).toEqual({ amount: 8.41, currency: "EUR" });
      expect(data.policy.length).toBeGreaterThan(0);
      expect(data.policy.every((p: { passed: boolean }) => p.passed)).toBe(true);
      expect(data.applyCommand).toBe(`opscrew provision --approve ${data.planHash}`);
      expect(textOf(result)).toContain(`Plan hash: ${data.planHash}`);
      expect(textOf(result)).toContain("Nothing was created");
      expect(h.engine.calls).toEqual(["init", "validate", "plan"]);
      expect(h.elicited).toEqual([]); // planning never asks the user for anything
      await expect(
        readFile(path.join(h.root, "opscrew/infra/prod/main.tf"), "utf8"),
      ).resolves.toContain("OpsCrew");

      // the preview now reports the written files as unchanged
      const render = await h.call("opscrew_render");
      expect(dataOf(render).created).toEqual([]);
      expect(dataOf(render).changed).toEqual([]);
    });

    it("opscrew_apply asks the user with the plan summary, applies, stores secrets and opens a pull request", async () => {
      const h = await connect({
        elicit: approveAll,
        env: { OPSCREW_APP_ENV_FILE: "production.env" },
      });
      const planHash = dataOf(await h.call("opscrew_plan")).planHash as string;
      const result = await h.call("opscrew_apply", { planHash });
      expect(result.isError, textOf(result)).toBeFalsy();

      const first = h.elicited[0];
      expect(first?.message).toContain(`Plan hash: ${planHash}`);
      expect(first?.message).toContain("3 to create");
      expect(first?.message).toContain("Estimated cost");
      expect(first?.requestedSchema.properties).toHaveProperty("approve");
      expect(dataOf(result).approvals.map((a: { kind: string }) => a.kind)).toEqual([
        "iac-apply",
        "github-secrets",
        "git-push",
        "pull-request",
      ]);
      for (const params of h.elicited) {
        for (const property of Object.values(params.requestedSchema.properties)) {
          expect(["boolean", "string"]).toContain(property.type);
        }
      }

      expect(h.engine.applied).toHaveLength(1);
      expect(h.engine.applied[0]?.approval.approvedPlanHash).toBe(planHash);
      expect(dataOf(result)).toMatchObject({
        applied: true,
        planHash,
        prUrl: PR_URL,
        secretsStored: true,
      });
      expect(textOf(result)).toContain(SERVER_IPV4);
      expect(textOf(result)).toContain(PR_URL);
      expect(h.github.secrets.get("OPSCREW_APP_ENV")).toContain(`STRIPE_SECRET_KEY=${STRIPE}`);
      expect(h.github.secrets.get("OPSCREW_HOST")).toBe(SERVER_IPV4);

      const plan = await readArtifact("plan", path.join(h.root, "opscrew", "plan.yaml"));
      expect(plan.deployment.lastPlanHash).toBe(planHash);
      expect(plan.approvals[0]?.approver).toContain("opscrew-test-client");
      expectNoSecrets(h);
    });

    it("without OPSCREW_APP_ENV_FILE it applies but leaves the secrets to `opscrew provision`", async () => {
      const h = await connect({ elicit: approveAll });
      const planHash = dataOf(await h.call("opscrew_plan")).planHash as string;
      const result = await h.call("opscrew_apply", { planHash });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(dataOf(result).approvals.map((a: { kind: string }) => a.kind)).toEqual([
        "iac-apply",
        "git-push",
        "pull-request",
      ]);
      expect(h.github.secrets.size).toBe(0);
      expect(dataOf(result)).toMatchObject({ secretsStored: false, nextStep: "opscrew provision" });
      expect(textOf(result)).toContain("run `opscrew provision` in a terminal");
      expectNoSecrets(h);
    });

    it("refuses when the user declines and names the terminal command", async () => {
      const h = await connect({ elicit: () => ({ action: "decline" }) });
      const planHash = dataOf(await h.call("opscrew_plan")).planHash as string;
      const result = await h.call("opscrew_apply", { planHash });
      expect(result.isError).toBe(true);
      expect(dataOf(result).error.code).toBe("APPROVAL_REFUSED");
      expect(textOf(result)).toContain(`opscrew provision --approve ${planHash}`);
      expect(h.elicited).toHaveLength(1);
      expect(h.engine.calls).not.toContain("apply");

      // accepting the form but leaving "approve" unticked is a refusal too
      const unticked = await connect({
        elicit: () => ({ action: "accept", content: { approve: false } }),
      });
      const hash = dataOf(await unticked.call("opscrew_plan")).planHash as string;
      expect((await unticked.call("opscrew_apply", { planHash: hash })).isError).toBe(true);
      expect(unticked.engine.applied).toEqual([]);
    });

    it("a destroying plan needs the typed resource name; a wrong phrase refuses", async () => {
      const destroy = [change("this", "hcloud_server", "replace")];
      const wrong = await connect({
        engine: new FakeEngine(destroy),
        elicit: () => ({ action: "accept", content: { confirmation: "yes" } }),
      });
      const planned = await wrong.call("opscrew_plan");
      expect(dataOf(planned).hasDestroy).toBe(true);
      expect(textOf(planned)).toContain('type "shop"');
      const planHash = dataOf(planned).planHash as string;
      const refused = await wrong.call("opscrew_apply", { planHash });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("confirmation phrase did not match");
      expect(wrong.elicited[0]?.requestedSchema.properties).toHaveProperty("confirmation");
      expect(wrong.elicited[0]?.message).toContain("deletes or replaces");
      expect(wrong.engine.applied).toEqual([]);

      const right = await connect({ engine: new FakeEngine(destroy), elicit: approveAll });
      const hash = dataOf(await right.call("opscrew_plan")).planHash as string;
      const applied = await right.call("opscrew_apply", { planHash: hash });
      expect(applied.isError, textOf(applied)).toBeFalsy();
      expect(right.engine.applied[0]?.approval).toMatchObject({
        approvedPlanHash: hash,
        allowDestroy: true,
      });
    });

    it("refuses without elicitation support and never applies on the model's say-so", async () => {
      const h = await connect();
      const planHash = dataOf(await h.call("opscrew_plan")).planHash as string;
      const result = await h.call("opscrew_apply", { planHash });
      expect(result.isError).toBe(true);
      expect(dataOf(result).error.code).toBe("APPROVAL_REFUSED");
      expect(textOf(result)).toContain(
        "cannot show OpsCrew's approval dialog (MCP elicitation), so OpsCrew changes nothing. Nothing was changed.",
      );
      expect(textOf(result)).toContain(
        `Ask the user to run \`opscrew provision --approve ${planHash}\` in a terminal in the project directory; it shows each plan before it asks.`,
      );
      expect(h.engine.calls).not.toContain("apply");
    });

    it("opscrew_plan's terminal command repeats the engine the call asked for", async () => {
      const h = await connect({ elicit: approveAll });
      const chosen = dataOf(await h.call("opscrew_plan", { engine: "terraform" }));
      expect(chosen.applyCommand).toBe(
        `opscrew provision --approve ${chosen.planHash} --engine terraform`,
      );
      const auto = dataOf(await h.call("opscrew_plan", { engine: "auto" }));
      expect(auto.applyCommand).toBe(`opscrew provision --approve ${auto.planHash}`);
    });

    it("rejects malformed and unknown plan hashes before asking anything", async () => {
      const h = await connect({ elicit: approveAll });
      const bad = await h.call("opscrew_apply", { planHash: "abc" });
      expect(dataOf(bad).error.code).toBe("INVALID_INPUT");
      const unknown = await h.call("opscrew_apply", { planHash: "0".repeat(64) });
      expect(dataOf(unknown).error.code).toBe("PLAN_HASH_MISMATCH");
      expect(textOf(unknown)).toContain("opscrew_plan");
      expect(h.elicited).toEqual([]);
      expect(h.engine.calls).toEqual([]);
    });

    it("opscrew_secure returns the checks, problems and report path", async () => {
      const remote: RemoteExec = {
        host: SERVER_IPV4,
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      };
      const s = await connect({
        plan: testPlan({ deployed: true }),
        tools: { secure: { remote, tcpConnect: async () => false, probeTimeoutMs: 10 } },
      });
      const result = await s.call("opscrew_secure", { offline: true });
      expect(result.isError, textOf(result)).toBeFalsy();
      const data = dataOf(result);
      expect(data.reportPath).toBe("opscrew/SECURITY_REPORT.md");
      expect(data.hostChecks.length).toBeGreaterThan(0);
      expect(data.probes.length).toBeGreaterThan(0);
      expect(typeof data.passed).toBe("boolean");
      expect(data.scan.counts).toBeDefined();
      expect(textOf(result)).toContain("Report: opscrew/SECURITY_REPORT.md");
      await expect(
        readFile(path.join(s.root, "opscrew", "SECURITY_REPORT.md"), "utf8"),
      ).resolves.toContain("shop");
      expect(s.engine.calls).toEqual([]);
    });

    it("opscrew_verify returns the check results, or says to provision first", async () => {
      const fresh = await connect();
      const missing = await fresh.call("opscrew_verify");
      expect(missing.isError).toBe(true);
      expect(dataOf(missing).error.code).toBe("PHASE_PRECONDITION");
      expect(textOf(missing)).toContain("opscrew provision");

      const site: FetchLike = async (input) => {
        const url = String(input);
        if (url.endsWith("/api/health")) return new Response("ok");
        if (url.endsWith("/.env") || url.endsWith("/.git/config")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("<!doctype html><p>shop</p>");
      };
      const h = await connect({
        plan: testPlan({ deployed: true }),
        tools: {
          verify: {
            fetch: site,
            resolver: { resolve4: async () => [SERVER_IPV4], resolve6: async () => [] },
            tcpConnect: async () => true,
            timeoutMs: 100,
          },
        },
      });
      const result = await h.call("opscrew_verify");
      expect(result.isError, textOf(result)).toBeFalsy();
      const data = dataOf(result);
      expect(data.checks.length).toBeGreaterThan(0);
      expect(data.summary).toMatch(/\d+ passed, \d+ failed/);
      expect(data.runbookPath).toBe("opscrew/RUNBOOK.md");
      expect(data.checks.some((c: { id: string; status: string }) => c.status === "pass")).toBe(
        true,
      );
      await expect(readFile(path.join(h.root, "opscrew", "RUNBOOK.md"), "utf8")).resolves.toContain(
        SERVER_IPV4,
      );
    });
  },
  120_000,
);

describe("the approval dialog's text", () => {
  const request = {
    kind: "iac-apply",
    title: "Create 3 resources on Hetzner Cloud",
    details: "+ hcloud_server.app",
    planHash: "ab".repeat(32),
  } as const;

  it("labels the cost as the change in the monthly cost, with its sign", () => {
    const more = approvalMessage({ ...request, costDelta: { amount: 4.51, currency: "EUR" } });
    expect(more).toContain("Monthly cost change: +€4.51");
    expect(more).not.toContain("Monthly cost:");
    const less = approvalMessage({ ...request, costDelta: { amount: -4.51, currency: "EUR" } });
    expect(less).toContain("Monthly cost change: -€4.51");
  });
});
