import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  describeLocalPlan,
  hostPlanFile,
  type LocalPlan,
  localPlanFile,
  localPlanHash,
  PlanRefusedError,
  type ProvisionServices,
  runProvision,
} from "@opscrew/agents";
import {
  createProject as createGitProject,
  FAKE_SOPS,
  FakeEngine,
  FakeGitHub,
  FakeSops,
  forbiddenFetch,
  projectRunner,
  readyRemote,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import type { FetchLike, RemoteExec, ResourceChange } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { defaultScanners } from "@opscrew/secops";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { auditText } from "./__fixtures__/audit";
import { type DeployToolOptions, registerDeployTools } from "./deploy";
import { approvalMessage } from "./elicitation";

const STRIPE = fakeSecret("stripe-live-key");
const HCLOUD = fakeSecret("hcloud-token");
const PR_URL = "https://github.com/acme/shop/pull/7";

const change = (name: string, type: string, action: ResourceChange["action"]): ResourceChange => ({
  address: `module.server.${type}.${name}`,
  type,
  name,
  provider: "registry.opentofu.org/hetznercloud/hcloud",
  action,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** The shared git project with the user's env file (`production.env`) next to it. */
async function createProject(plan = testPlan()) {
  const project = await createGitProject(plan);
  await writeFile(path.join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  return project;
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
  /** Answers `OPSCREW_SOPS_BIN=fake-sops` for the recovery copy. */
  sops?: FakeSops;
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

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
    runner: options.sops === undefined ? projectRunner() : options.sops.runner(projectRunner()),
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
      expect(Object.keys(apply?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["planHash", "cloudflarePlanHash"]),
      );
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

    it("opscrew_apply writes the recovery copy's first key only to keyOut and never returns it", async () => {
      const h = await connect({
        elicit: approveAll,
        env: { OPSCREW_SOPS_BIN: FAKE_SOPS },
        sops: new FakeSops(),
      });
      const keyOut = path.join(await tempDir("opscrew-mcp-keys-"), "age-key.txt");
      const planHash = dataOf(await h.call("opscrew_plan")).planHash as string;
      const result = await h.call("opscrew_apply", { planHash, keyOut });
      expect(result.isError, textOf(result)).toBeFalsy();
      const identity = (await readFile(keyOut, "utf8"))
        .split("\n")
        .find((line) => line.startsWith("AGE-SECRET-KEY-1"));
      expect(identity).toBeDefined();
      expect(textOf(result)).toContain(`OpsCrew wrote your new age key to ${keyOut}.`);
      const audit = await auditText(h.root, h.deps.env);
      expect(audit).toContain('"action":"pull-request"');
      expect(JSON.stringify([h.outputs, h.elicited, audit])).not.toContain(identity);
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

    it("opscrew_apply says plainly when the deployment files did not change or still need a push", async () => {
      const branch = "opscrew/deploy-setup";
      const outcomes = [
        { applied: false, outputs: {}, branch: "main", base: "main", published: false },
        {
          applied: false,
          outputs: {},
          branch: "main",
          base: "main",
          published: false,
          prUrl: PR_URL,
        },
        { applied: false, outputs: {}, branch, base: "main", published: false },
        { applied: false, outputs: {}, branch, base: "main", published: true, pushed: false },
      ];
      const h = await connect({
        elicit: approveAll,
        env: { OPSCREW_APP_ENV_FILE: "production.env" },
        // opscrew_plan plans for real; each opscrew_apply gets the next outcome.
        tools: {
          runProvision: async (phase, options) =>
            options?.planOnly === true
              ? runProvision(phase, options)
              : (outcomes.shift() ?? { applied: false, outputs: {} }),
        },
      });
      const planHash = dataOf(await h.call("opscrew_plan")).planHash as string;

      const nothing = textOf(await h.call("opscrew_apply", { planHash }));
      expect(nothing).toContain(
        "The deployment files did not change, so nothing was committed and no pull request was opened.",
      );
      expect(nothing).toContain("Next: call opscrew_verify to check the live site.");
      expect(nothing).not.toContain("committed on branch");
      expect(nothing).not.toContain("merge the pull request");

      // A pull request from earlier that is still open is still shown, with its merge.
      const open = textOf(await h.call("opscrew_apply", { planHash }));
      expect(open).toContain(
        `The deployment files did not change, so nothing was committed. The pull request from earlier is still open: ${PR_URL}`,
      );
      expect(open).toContain("Next: merge the pull request to deploy, then call opscrew_verify.");

      // Still on the deploy branch, whose files are on main: how to switch back.
      const merged = textOf(await h.call("opscrew_apply", { planHash }));
      expect(merged).toContain(
        `They are already on main on GitHub, but this clone is still on ${branch}: switch to main and pull (\`git switch main && git pull\`).`,
      );
      expect(merged).toContain("Next: call opscrew_verify to check the live site.");

      // An earlier commit whose push was refused again: the branch still needs pushing.
      const unpushed = textOf(await h.call("opscrew_apply", { planHash }));
      expect(unpushed).toContain(
        `The deployment files are committed on branch ${branch}, which still needs pushing: push it (\`git push -u origin ${branch}\`) and open a pull request into main.`,
      );
      expect(unpushed).toContain(
        "Next: once the branch is pushed, merge its pull request to deploy, then call opscrew_verify.",
      );
      expect(unpushed).not.toContain("nothing was committed");
    });

    it("refuses when the user declines and names the terminal command, never its --approve", async () => {
      const h = await connect({ elicit: () => ({ action: "decline" }) });
      const planHash = dataOf(await h.call("opscrew_plan")).planHash as string;
      const result = await h.call("opscrew_apply", { planHash });
      expect(result.isError).toBe(true);
      expect(dataOf(result).error.code).toBe("APPROVAL_REFUSED");
      expect(textOf(result)).toContain(
        "ask them to run `opscrew provision` in a terminal in the project directory: it shows each plan and asks.",
      );
      expect(JSON.stringify(result)).not.toContain("--approve");
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
        engine: new FakeEngine({ changes: destroy }),
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

      const right = await connect({
        engine: new FakeEngine({ changes: destroy }),
        elicit: approveAll,
      });
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
      expect(data.deep).toBeUndefined();
    });

    it("opscrew_secure with deep returns the deeper checks per tool", async () => {
      const remote: RemoteExec = {
        host: SERVER_IPV4,
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      };
      // No Docker on this computer: ssh-audit and testssl.sh are skipped with how to enable them.
      const docker = { run: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }) };
      const s = await connect({
        plan: testPlan({ deployed: true }),
        tools: { secure: { remote, docker, tcpConnect: async () => false, probeTimeoutMs: 10 } },
      });
      const result = await s.call("opscrew_secure", { offline: true, deep: true });
      expect(result.isError, textOf(result)).toBeFalsy();
      const tools = (dataOf(result).deep as { tool: string }[]).map((run) => run.tool);
      expect(tools).toContain("ssh-audit");
      expect(textOf(result)).toContain("Deeper check: ssh-audit");
      await expect(
        readFile(path.join(s.root, "opscrew", "SECURITY_REPORT.md"), "utf8"),
      ).resolves.toContain("## Deeper checks");
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
      // The site sends no security headers: their fix names prod's flag once staging exists.
      expect(textOf(result)).toContain("re-run `opscrew provision` to regenerate it");
      const prod = testPlan({ deployed: true });
      await writeArtifact(
        "plan",
        path.join(h.root, "opscrew", "environments", "staging", "plan.yaml"),
        DeployPlanSchema.parse({
          ...prod,
          environment: { name: "staging" },
          app: { ...prod.app, name: "shop-staging" },
          infra: { ...prod.infra, dir: "opscrew/infra/staging" },
          cicd: { ...prod.cicd, workflowPath: ".github/workflows/opscrew-deploy-staging.yml" },
        }),
      );
      const named = await h.call("opscrew_verify", { environment: "prod" });
      expect(textOf(named)).toContain("re-run `opscrew provision --env prod` to regenerate it");
    });
  },
  120_000,
);

/** The app on the user's computer: prod's plan with the localhost target. */
function localhostPlan() {
  const base = testPlan({ userSecret: false });
  return DeployPlanSchema.parse({
    ...base,
    target: {
      provider: "localhost",
      mode: "local-compose",
      arch: "amd64",
      ports: { https: 8443, http: 8080 },
      image: "registry",
      edge: "caddy",
    },
    dns: { provider: "none", proxied: false },
    cost: { ...base.cost, monthly: { amount: 0, currency: "EUR" }, breakdown: [] },
  });
}

/** The local plan the fake provision saves and asks for, as `provisionLocalhost` does. */
const LOCAL: LocalPlan = {
  schemaVersion: 1,
  purpose: "setup",
  app: "shop",
  environment: "prod",
  project: "opscrew-shop",
  address: "https://shop.localhost:8443",
  ports: { https: 8443, http: 8080 },
  items: [{ kind: "container", name: "opscrew-shop-web-1", action: "create" }],
};
const LOCAL_HASH = localPlanHash(LOCAL);

/**
 * Provision on the user's computer as the tools see it: `--plan-only` saves and shows the local
 * plan; an apply asks for it as `host-apply` by its hash and refuses as `provisionLocalhost` does.
 */
const localProvision: typeof runProvision = async (phase, options) => {
  const details = describeLocalPlan(LOCAL, LOCAL_HASH);
  if (options?.planOnly === true) {
    await mkdir(path.dirname(localPlanFile(phase.paths, LOCAL_HASH)), { recursive: true });
    await writeFile(localPlanFile(phase.paths, LOCAL_HASH), JSON.stringify(LOCAL));
    phase.reporter.info(details);
    return { applied: false, localPlanHash: LOCAL_HASH, localApplied: false, outputs: {} };
  }
  const approval = await phase.approvals.request({
    kind: "host-apply",
    title: "Run shop on this computer (https://shop.localhost:8443)",
    details,
    planHash: LOCAL_HASH,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "local plan",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: "Nothing on this computer was changed.",
      hint: `To apply it later without prompts, run: opscrew provision --approve ${LOCAL_HASH}`,
    });
  }
  return {
    applied: false,
    localPlanHash: LOCAL_HASH,
    localApplied: true,
    outputs: { url: LOCAL.address },
  };
};

describe.skipIf(!findExecutable("git"))("an environment on the user's computer", () => {
  it("opscrew_plan returns the local plan's hash, and opscrew_apply applies it after the dialog", async () => {
    const h = await connect({
      elicit: approveAll,
      plan: localhostPlan(),
      tools: { runProvision: localProvision },
    });
    const planned = await h.call("opscrew_plan");
    expect(planned.isError, textOf(planned)).toBeFalsy();
    expect(dataOf(planned).localPlanHash).toBe(LOCAL_HASH);
    expect(textOf(planned)).toContain(`Local plan hash: ${LOCAL_HASH}`);
    expect(textOf(planned)).toContain("nothing on the user's computer was changed");
    expect(textOf(planned)).toContain(`call opscrew_apply with planHash ${LOCAL_HASH}`);
    expect(dataOf(planned).applyCommand).toBe(`opscrew provision --approve ${LOCAL_HASH}`);

    const applied = await h.call("opscrew_apply", { planHash: LOCAL_HASH });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    expect(h.elicited.some((e) => e.message.includes(`Local plan hash: ${LOCAL_HASH}`))).toBe(true);
    expect(textOf(applied)).toContain(
      `Ran the app on the user's computer (local plan ${LOCAL_HASH}).`,
    );
    expect(textOf(applied)).toContain(
      "Next: call opscrew_verify to check the app on the user's computer.",
    );
    expect(textOf(applied)).not.toContain("deploy secrets are NOT stored");
    expect(dataOf(applied)).toMatchObject({ localPlanHash: LOCAL_HASH, localApplied: true });
  });

  it("a declined local plan changes nothing, and the reply never offers --approve", async () => {
    const h = await connect({
      elicit: () => ({ action: "decline" }),
      plan: localhostPlan(),
      tools: { runProvision: localProvision },
    });
    await h.call("opscrew_plan");
    const refused = await h.call("opscrew_apply", { planHash: LOCAL_HASH });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("The local plan was not approved");
    expect(textOf(refused)).toContain("Nothing on this computer was changed.");
    expect(textOf(refused)).toContain("`opscrew provision`");
    expect(JSON.stringify(refused)).not.toContain("--approve");
  });

  it("refuses a hash no saved local plan has", async () => {
    const h = await connect({
      elicit: approveAll,
      plan: localhostPlan(),
      tools: { runProvision: localProvision },
    });
    const refused = await h.call("opscrew_apply", { planHash: "ab".repeat(32) });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(`No saved plan has the hash ${"ab".repeat(32)}.`);
    expect(h.elicited).toEqual([]);
  });
});

/** The host plan of a runner machine the fake provision saves (only its steps are read back). */
const RUNNER_HASH = "cd".repeat(32);

describe.skipIf(!findExecutable("git"))("a runner machine's host plan", () => {
  /** Provision whose only change is the environment's runner on a runner machine. */
  function machineProvision(seen: { approveHashes?: readonly string[] }): typeof runProvision {
    return async (phase, options) => {
      if (options?.planOnly === true) {
        const file = hostPlanFile(phase.paths, RUNNER_HASH);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(
          file,
          JSON.stringify({ steps: [{ id: "github-runner", state: "change" }] }),
        );
        phase.reporter.info(
          `Host plan for the runner machine home: 1 to change.\n  ~ github-runner\nHost plan hash: ${RUNNER_HASH}`,
        );
        return { applied: false, runnerHostPlanHashes: [RUNNER_HASH], outputs: {} };
      }
      seen.approveHashes = options?.approveHashes;
      const approval = await phase.approvals.request({
        kind: "host-apply",
        title:
          "Install the GitHub Actions runner of shop on the runner machine home, run as deploy",
        details: `Host plan hash: ${RUNNER_HASH}`,
        planHash: RUNNER_HASH,
      });
      if (!approval.approved) throw new Error("not approved");
      return { applied: false, runnerHostPlanHashes: [RUNNER_HASH], outputs: {}, published: false };
    };
  }

  it("is returned by opscrew_plan with its hash and applied by opscrew_apply after its dialog", async () => {
    const seen: { approveHashes?: readonly string[] } = {};
    const h = await connect({
      elicit: approveAll,
      tools: { runProvision: machineProvision(seen) },
    });
    const planned = await h.call("opscrew_plan");
    expect(planned.isError, textOf(planned)).toBeFalsy();
    expect(dataOf(planned).runnerHostPlanHashes).toEqual([RUNNER_HASH]);
    expect(textOf(planned)).toContain("Host plan for the runner machine home: 1 to change.");
    expect(textOf(planned)).toContain(`runnerHostPlanHashes ["${RUNNER_HASH}"]`);
    expect(dataOf(planned).applyCommand).toBe(`opscrew provision --approve ${RUNNER_HASH}`);

    const unknown = await h.call("opscrew_apply", { runnerHostPlanHashes: ["ef".repeat(32)] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("No saved host plan of a runner machine has the hash");

    const applied = await h.call("opscrew_apply", { runnerHostPlanHashes: [RUNNER_HASH] });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    expect(seen.approveHashes).toEqual([RUNNER_HASH]);
    expect(h.elicited.map((e) => e.message).join("\n")).toContain(
      "Install the GitHub Actions runner of shop on the runner machine home",
    );
    expect(textOf(applied)).toContain(`The runner machines' host plans: ${RUNNER_HASH}.`);
  });
});

/** The host plan of the server's runner on a server OpsCrew created (only its steps are read back). */
const SERVER_RUNNER_HASH = "ab".repeat(32);

describe.skipIf(!findExecutable("git"))("the server runner's host plan on a cloud server", () => {
  /** Provision whose only change is the runner on the server OpsCrew created. */
  const serverRunnerProvision: typeof runProvision = async (phase, options) => {
    if (options?.planOnly === true) {
      const file = hostPlanFile(phase.paths, SERVER_RUNNER_HASH);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ steps: [{ id: "github-runner", state: "change" }] }));
      phase.reporter.info(
        `Host plan for your server: 1 to change.\n  ~ github-runner\nHost plan hash: ${SERVER_RUNNER_HASH}`,
      );
      return { applied: false, hostPlanHash: SERVER_RUNNER_HASH, outputs: {} };
    }
    const approval = await phase.approvals.request({
      kind: "host-apply",
      title: "Install the GitHub Actions runner of shop on the server, run as deploy",
      details: `Host plan hash: ${SERVER_RUNNER_HASH}`,
      planHash: SERVER_RUNNER_HASH,
    });
    if (!approval.approved) throw new Error("not approved");
    return {
      applied: false,
      hostPlanHash: SERVER_RUNNER_HASH,
      hostApplied: true,
      outputs: {},
      published: false,
    };
  };

  it("is applied by opscrew_apply with the hash opscrew_plan returned", async () => {
    const h = await connect({ elicit: approveAll, tools: { runProvision: serverRunnerProvision } });
    const planned = await h.call("opscrew_plan");
    expect(planned.isError, textOf(planned)).toBeFalsy();
    expect(dataOf(planned).hostPlanHash).toBe(SERVER_RUNNER_HASH);
    expect(textOf(planned)).toContain(`call opscrew_apply with planHash ${SERVER_RUNNER_HASH}`);

    const applied = await h.call("opscrew_apply", { planHash: SERVER_RUNNER_HASH });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    expect(textOf(applied)).toContain(
      `Applied the server's host plan ${SERVER_RUNNER_HASH} (its runner).`,
    );
    expect(dataOf(applied)).toMatchObject({ hostPlanHash: SERVER_RUNNER_HASH, hostApplied: true });

    // Beside another plan it is passed as hostPlanHash, on a cloud server as on the user's own.
    const beside = await h.call("opscrew_apply", {
      cloudflarePlanHash: "cd".repeat(32),
      hostPlanHash: SERVER_RUNNER_HASH,
    });
    expect(beside.isError, textOf(beside)).toBeFalsy();
    const unknown = await h.call("opscrew_apply", {
      cloudflarePlanHash: "cd".repeat(32),
      hostPlanHash: "ef".repeat(32),
    });
    expect(textOf(unknown)).toContain(`No saved host plan has the hash ${"ef".repeat(32)}.`);
  });
});

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
