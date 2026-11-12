/**
 * The MCP tools for an app on a hosting account (feature 027, T2715): the interview offers the
 * target and takes its `hosting.*` answers, opscrew_plan returns the hosting plan's hash with the
 * terminal command, opscrew_apply leaves the account to the terminal, and the tools that need a
 * server refuse it plainly.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner, testPlan } from "@opscrew/agents/testing";
import { resolveProjectPaths } from "@opscrew/core";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { createOpscrewMcpServer } from "../server";
import { registerAddonTools } from "./addons";
import { registerDeployTools } from "./deploy";
import { registerEnvironmentTools } from "./environments";
import { registerLogsTool } from "./logs";
import { registerPortainerTools } from "./portainer";
import { registerPreviewTools } from "./previews";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const HOSTNAME = "notes.example.com";
const AGENT_PLAN = "a1".repeat(32);
const DNS_PLAN = "d4".repeat(32);

/** The engine's saved plan of the hostname's A record on Cloudflare, in `dir`. */
async function saveDnsPlan(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "20261112T120000-dns.tfplan.json"),
    JSON.stringify({
      planHash: DNS_PLAN,
      planFile: path.join(dir, "20261112T120000-dns.tfplan"),
      dir: "opscrew/infra",
      engine: { name: "tofu", version: "1.10.6", binary: "tofu" },
      createdAt: "2026-11-12T12:00:00.000Z",
      changes: [
        {
          address: "module.dns.cloudflare_dns_record.a",
          type: "cloudflare_dns_record",
          name: "a",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          action: "create",
        },
      ],
      counts: { create: 1, update: 0, delete: 0, replace: 0 },
      hasDestroy: false,
      policy: [],
      planJson: {},
    }),
  );
}

/** A deployed static site of `example-app` at {@link HOSTNAME} on a cPanel account. */
function hostingPlan() {
  return DeployPlanSchema.parse({
    ...testPlan({ deployed: true }),
    app: { ...testPlan().app, name: "example-app", env: [] },
    target: {
      provider: "hosting",
      panel: "cpanel",
      app: "static",
      webRoot: ".",
      site: { tool: "none", outputDir: "site" },
      cron: [],
    },
    services: [],
    dns: { provider: "none", domain: HOSTNAME, proxied: false },
    security: { wafCustomRules: false },
  });
}

async function project(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-hosting-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return { dir, env: { OPSCREW_HOME: path.join(dir, "home") } };
}

async function connect(server: McpServer) {
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

/**
 * The tools that touch a deployed app, on a project whose plan deploys to a hosting account;
 * with `dns`, provision also plans the hostname's record on Cloudflare.
 */
async function deployed(o: { dns?: boolean } = {}) {
  const { dir, env } = await project();
  await writeArtifact("plan", resolveProjectPaths(dir, { env }).files.plan, hostingPlan());
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerDeployTools(server, deps, {
    runProvision: async (phase) => {
      phase.reporter.info(
        `Hosting plan A (the agent) for ${HOSTNAME} on the cPanel account acct at panel.example.com\n  + Make ~/opscrew/example-app-prod/\nHosting plan hash: ${AGENT_PLAN}`,
      );
      phase.reporter.info(
        "Plan B, the app's part, is built from the agent's first report, so it comes once plan A is applied: run the command without --plan-only.",
      );
      if (o.dns !== true) return { applied: false, outputs: {}, hostingPlanHashes: [AGENT_PLAN] };
      await saveDnsPlan(phase.paths.files.plansDir);
      return { applied: false, outputs: {}, planHash: DNS_PLAN };
    },
  });
  registerPortainerTools(server, deps);
  registerEnvironmentTools(server, deps);
  registerLogsTool(server, deps);
  registerPreviewTools(server, deps);
  registerAddonTools(server, deps);
  return connect(server);
}

describe("the MCP interview and a hosting account", () => {
  async function interview(env: Record<string, string>) {
    const { dir, env: home } = await project();
    const root = path.join(dir, "repo");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "index.html"), "<h1>Notes</h1>\n");
    const server = createOpscrewMcpServer({
      version: "0.0.0-test",
      env: { ...home, ...env },
      fetch: forbiddenFetch,
      runner: new ScriptedRunner(),
      cwd: root,
    });
    const client = new Client({ name: "opscrew-test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it("offers the hosting account and its follow-ups only when the environment reaches one", async () => {
    const sftp = await interview({
      OPSCREW_SFTP_HOST: "sftp.example.com",
      OPSCREW_SFTP_USER: "acct",
      OPSCREW_SFTP_KEY: "/home/user/.ssh/id_ed25519",
    });
    const offered = text(
      (await sftp.callTool({
        name: "opscrew_interview_questions",
        arguments: {},
      })) as CallToolResult,
    );
    expect(offered).toContain("hosting = A hosting account");
    expect(offered).toContain('Only when the user chooses "hosting"');
    expect(offered).toContain("hosting.phpPath");
    expect(offered).toContain("never one you read yourself");

    const none = await interview({});
    const plain = text(
      (await none.callTool({
        name: "opscrew_interview_questions",
        arguments: {},
      })) as CallToolResult,
    );
    expect(plain).not.toContain("hosting = A hosting account");
    expect(plain).not.toContain("hosting.hostname");
  });

  it("saves an SFTP host's hosting.* answers with opscrew_save_requirements", async () => {
    const key = Buffer.from("an SFTP host's ed25519 key, for tests only").toString("base64");
    const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`;
    const runner = new ScriptedRunner((command, args) => {
      if (command !== "ssh-keyscan") return { exitCode: 0, stdout: "", stderr: "" };
      const host = args.at(-1) ?? "";
      return { exitCode: 0, stdout: `[${host}]:2222 ssh-ed25519 ${key}\n`, stderr: "" };
    });
    const { dir, env: home } = await project();
    const root = path.join(dir, "repo");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "index.html"), "<h1>Notes</h1>\n");
    const call = await connect(
      createOpscrewMcpServer({
        version: "0.0.0-test",
        env: {
          ...home,
          OPSCREW_SFTP_HOST: "sftp.example.net",
          OPSCREW_SFTP_USER: "deploy",
          OPSCREW_SFTP_KEY: "/home/me/.ssh/id_ed25519",
        },
        fetch: forbiddenFetch,
        runner,
        cwd: root,
      }),
    );
    const result = await call("opscrew_save_requirements", {
      answers: {
        provider: "hosting",
        expectedMonthlyUsers: "<1k",
        budgetMonthly: "5 EUR",
        uptime: "standard",
        dataCriticality: "important",
        domain: HOSTNAME,
        dnsProvider: "other",
        "hosting.port": "2222",
        "hosting.folder": "opscrew",
        "hosting.phpPath": "/home/deploy/opscrew",
        "hosting.hostKey": fingerprint,
      },
    });
    expect(result.isError, text(result)).not.toBe(true);
    expect(text(result)).toContain("Where it runs: the user's hosting account");
    expect(result.structuredContent).toMatchObject({
      requirements: { provider: "hosting", domain: HOSTNAME },
    });
  });

  it("takes the hosting.* answers in opscrew_save_requirements", async () => {
    const client = await interview({});
    const { tools } = await client.listTools();
    const save = tools.find((tool) => tool.name === "opscrew_save_requirements");
    const answers = (save?.inputSchema.properties?.answers ?? {}) as {
      properties?: Record<string, { description?: string }>;
    };
    for (const field of ["hostname", "port", "hostKey", "folder", "phpPath"]) {
      expect(answers.properties?.[`hosting.${field}`]?.description).toBeTruthy();
    }
    expect(answers.properties?.provider?.description).toContain('"hosting"');
  });
});

describe("the MCP deploy tools and a hosting account", () => {
  it("opscrew_plan returns the hosting plan's hash and the terminal command, never --yes alone", async () => {
    const call = await deployed();
    const result = await call("opscrew_plan");
    expect(result.isError).not.toBe(true);
    const said = text(result);
    expect(said).toContain(`Hosting plan hash: ${AGENT_PLAN}`);
    expect(said).toContain(`npx opscrew provision --approve ${AGENT_PLAN} --yes`);
    expect(said).toContain("it never approves a plan");
    expect(result.structuredContent).toMatchObject({ hostingPlanHashes: [AGENT_PLAN] });
  });

  it("opscrew_plan names the hostname's DNS plan on Cloudflare with its hash", async () => {
    const call = await deployed({ dns: true });
    const result = await call("opscrew_plan");
    expect(result.isError).not.toBe(true);
    const said = text(result);
    expect(said).toContain("cloudflare_dns_record.a");
    expect(said).toContain(`npx opscrew provision --approve ${DNS_PLAN} --yes`);
    expect(said).not.toContain("already match");
    expect(result.structuredContent).toMatchObject({ planHash: DNS_PLAN });
    expect(result.structuredContent).not.toHaveProperty("hostingPlanHashes");
  });

  it("opscrew_apply leaves a hosting account to the terminal before any dialog", async () => {
    const call = await deployed();
    const result = await call("opscrew_apply", { planHash: AGENT_PLAN });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("opscrew_apply doesn't set up a hosting account");
    expect(text(result)).toContain("npx opscrew provision");
  });

  it.each([
    ["opscrew_logs", { service: "app" }, "the agent's last lines"],
    ["opscrew_logs", { failed: true }, "the agent's last lines"],
    ["opscrew_preview_list", {}, "opscrew env add preview --previews"],
    ["opscrew_addon_status", {}, "cPanel's Metrics"],
    ["opscrew_portainer_status", {}, "The user's panel shows"],
    ["opscrew_portainer_enable", {}, "The user's panel shows"],
    ["opscrew_portainer_disable", {}, "The user's panel shows"],
    ["opscrew_env_set", { name: "prod", runner: "server" }, "GitHub's own runners"],
    ["opscrew_env_set", { name: "prod", runner: "host" }, "GitHub's own runners"],
  ])("%s %j refuses plainly and says what to use instead", async (tool, args, instead) => {
    const call = await deployed();
    const result = await call(tool, args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't apply to a hosting account");
    expect(text(result)).toContain(instead);
  });
});
