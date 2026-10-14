import { createHash } from "node:crypto";
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
  type OwnServerConnectionInput,
  type OwnServerServices,
  type ProvisionServices,
  portainerPasswordFile,
  readOwnServer,
  recordOwnServer,
} from "@opscrew/agents";
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
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerDeployTools } from "./deploy";
import { registerDesignTools } from "./design";
import { registerInterviewTools } from "./interview";
import { registerPortainerTools } from "./portainer";

// ---------------------------------------------------------------------------------------------
// Fakes for a server the user owns (adapted from @opscrew/agents' own-server fixtures)
// ---------------------------------------------------------------------------------------------

/** The user's own server: a documentation address (RFC 5737). */
const OWN_IPV4 = "203.0.113.20";
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function hostKeyBlob(): string {
  const name = Buffer.from("ssh-ed25519");
  const key = createHash("sha256").update("own-server").digest();
  const length = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n);
    return out;
  };
  return Buffer.concat([length(name.length), name, length(key.length), key]).toString("base64");
}
const HOST_KEY = hostKeyBlob();
const FINGERPRINT = `SHA256:${createHash("sha256").update(Buffer.from(HOST_KEY, "base64")).digest("base64").replace(/=+$/, "")}`;

type HostAdapter = Required<NonNullable<OwnServerServices["host"]>>;
type HostFacts = Awaited<ReturnType<HostAdapter["inspect"]>>;
type HostPlan = Parameters<HostAdapter["apply"]>[1];
type ApplyOptions = Parameters<HostAdapter["apply"]>[2];

const ADDON = {
  installed: false,
  composeSha256: null,
  running: false,
  secretFile: false,
  dataVolume: false,
  tunnelId: null,
};

function freshFacts(): HostFacts {
  return {
    user: "root",
    privilege: "root",
    os: {
      id: "ubuntu",
      idLike: "debian",
      versionId: "24.04",
      codename: "noble",
      prettyName: "Ubuntu 24.04.3 LTS",
    },
    arch: "amd64",
    machine: "x86_64",
    cpus: 2,
    memoryBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 3 * 1024 ** 3,
    diskFreeBytes: 40 * 1024 ** 3,
    diskTotalBytes: 80 * 1024 ** 3,
    systemd: true,
    flock: true,
    addresses: [{ interface: "eth0", family: "ipv4", address: OWN_IPV4, public: true }],
    sshd: {
      ports: [22],
      passwordAuthentication: true,
      kbdInteractiveAuthentication: false,
      permitRootLogin: "yes",
      authenticationMethods: "any",
      allowUsers: [],
      allowGroups: [],
      denyUsers: [],
      denyGroups: [],
      authorizedKeysCommand: false,
      allowTcpForwarding: "yes",
      dropInIncluded: true,
      dropIn: null,
    },
    listeners: [{ proto: "tcp", address: "0.0.0.0", port: 22, process: "sshd" }],
    webServers: [],
    firewall: {
      ufw: "inactive",
      ufwRules: [],
      ufwDefaults: { incoming: "deny", outgoing: "allow", routed: "disabled" },
      foreign: [],
    },
    docker: {
      kind: "absent",
      version: null,
      running: false,
      composePlugin: false,
      buildxPlugin: false,
      conflicting: [],
      sources: [],
      daemonFlags: [],
      swarm: false,
    },
    containers: [],
    volumeProjects: [],
    directoryLogins: [],
    dpkgInterrupted: false,
    loginUsers: [{ name: "root", uid: 0, password: false, keys: true }],
    deployUser: null,
    packages: { ufw: true, unattendedUpgrades: true, curl: true, fail2ban: false },
    autoUpgrades: false,
    autoUpgradesService: false,
    dockerDaemonJson: "absent",
    fail2ban: { active: false, jail: null, sshdJail: false },
    ready: false,
    dirs: [
      { path: "/srv/app", kind: "absent" },
      { path: "/srv/data", kind: "absent" },
    ],
    marker: null,
    markerDamaged: false,
    record: null,
    recordDamaged: false,
    pendingUndo: { sshd: false, ufw: false },
    tunnel: ADDON,
    portainer: ADDON,
  } as HostFacts;
}

/** A server prepared for the app `shop` of `projectId`. */
function preparedFacts(projectId: string): HostFacts {
  const fresh = freshFacts();
  return {
    ...fresh,
    docker: { ...fresh.docker, kind: "docker-repo", version: "28.5.1", running: true },
    deployUser: { groups: ["deploy", "docker"], keys: [] },
    ready: true,
    marker: { app: "shop", projectId },
    record: {
      schemaVersion: 1,
      app: "shop",
      projectId,
      opscrewVersion: "0.0.0-test",
      changes: [
        {
          step: "deploy-user",
          purpose: "setup",
          at: "2026-10-14T12:00:00.000Z",
          previous: { existed: false },
        },
      ],
    },
  } as HostFacts;
}

class FakeHost implements HostAdapter {
  readonly applies: { plan: HostPlan; options: ApplyOptions }[] = [];
  inspections = 0;
  constructor(public facts: HostFacts = freshFacts()) {}
  async inspect(): Promise<HostFacts> {
    this.inspections++;
    return this.facts;
  }
  async apply(_remote: RemoteExec, plan: HostPlan, options: ApplyOptions) {
    this.applies.push({ plan, options });
    const changes = plan.steps.filter((step) => step.state === "change");
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
    };
  }
}

/** IaC engine fake: plans `changes`, refuses an apply whose hash does not match. */
class FakeEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly applied: IacApproval[] = [];
  #counter = 0;
  constructor(readonly changes: ResourceChange[] = []) {}
  async init(): Promise<void> {}
  async validate() {
    return { valid: true, diagnostics: [] };
  }
  async plan(dir: string, planFile: string): Promise<PlanSummary> {
    const content = `fake own plan ${++this.#counter} for ${dir}`;
    await writeFile(planFile, content);
    const count = (action: string) => this.changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256(content),
      createdAt: "2026-10-14T12:00:00.000Z",
      changes: this.changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: false,
      planJson: { format_version: "1.2", planned_values: { root_module: {} } },
    };
  }
  async apply(_dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    this.applied.push(approval);
    return { ok: true, outputs: {}, log: "Apply complete!" };
  }
  async output(): Promise<Record<string, unknown>> {
    return {};
  }
}

class FakeGitHub {
  readonly secrets = new Map<string, string>();
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
  async createPullRequest() {
    return { number: 7, url: "https://github.com/acme/shop/pull/7" };
  }
}

/** Real git; `ssh-keyscan` answers with the host key; `ssh` succeeds. */
function ownRunner(): ScriptedRunner {
  const real = new NodeCommandRunner();
  return new ScriptedRunner(async (command, args, options) => {
    if (command === "git") return real.run(command, args, options);
    if (command === "ssh-keyscan") {
      const host = args[args.length - 1] as string;
      return { exitCode: 0, stdout: `${host} ssh-ed25519 ${HOST_KEY}\n`, stderr: "" };
    }
    if (command === "ssh") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 127, stdout: "", stderr: `${command}: not available in tests` };
  });
}

const adminShell: RemoteExec = {
  host: OWN_IPV4,
  run: async (command) => ({ exitCode: command === "true" ? 0 : 1, stdout: "", stderr: "" }),
};

function ownPlan(o: { deployed?: boolean; portainer?: boolean } = {}) {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z",
    app: {
      name: "shop",
      port: 3000,
      healthPath: "/api/health",
      env: [{ name: "SESSION_SECRET", secret: true, source: "generated" }],
    },
    target: { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" },
    services: { postgres: false, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [{ item: "Your own server", monthly: { amount: 0, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-10-14T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    ...(o.portainer ? { portainer: { enabled: true, version: "2.45.2", access: "local" } } : {}),
    ...(o.deployed ? { deployment: { lastApplyAt: "2026-10-14T11:00:00.000Z" } } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

type Answer = (params: ElicitRequestFormParams) => ElicitResult;

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

interface Options {
  elicit?: Answer;
  plan?: ReturnType<typeof ownPlan>;
  /** Record the login (with this pinned key, or none). */
  login?: Partial<OwnServerConnectionInput> | false;
  facts?: (projectId: string) => HostFacts;
}

async function connect(options: Options = {}) {
  const root = await tempDir("opscrew-mcp-own-");
  const bare = await tempDir("opscrew-mcp-own-remote-");
  const home = await tempDir("opscrew-mcp-own-home-");
  const runner = new NodeCommandRunner();
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runner.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpsCrew Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "remote", "add", "origin", "https://github.com/acme/shop.git");
  await git(root, "remote", "set-url", "--push", "origin", bare);
  await writeFile(path.join(root, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shop", dependencies: { express: "^5.0.0" } }),
  );
  await writeFile(path.join(root, ".gitignore"), ".opscrew/\n.env\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "init");
  if (options.plan !== undefined) {
    await writeArtifact("plan", path.join(root, "opscrew", "plan.yaml"), options.plan);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    CLOUDFLARE_API_TOKEN: undefined,
    OPSCREW_APP_ENV_FILE: undefined,
    HCLOUD_TOKEN: undefined,
    DIGITALOCEAN_TOKEN: undefined,
    OPSCREW_HOME: home,
  };
  const paths = resolveProjectPaths(root, { env });
  if (options.login !== false) {
    await recordOwnServer(paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      ...options.login,
    } as OwnServerConnectionInput);
  }
  const host = new FakeHost(options.facts?.(paths.projectId) ?? freshFacts());
  const keyHome = path.join(home, "user");
  await mkdir(keyHome, { recursive: true });
  const own: OwnServerServices = {
    host,
    remote: () => adminShell,
    verifyLogin: async () => true,
    homeDir: keyHome,
  };
  const engine = new FakeEngine();
  const github = new FakeGitHub();
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own,
  };
  const forbiddenFetch: FetchLike = async (input) => {
    throw new Error(`Unexpected network call in a test: ${String(input)}`);
  };
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: ownRunner(),
    clock: { now: () => new Date("2026-10-14T12:00:00.000Z") },
    cwd: root,
    tmpDir: home,
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerInterviewTools(server, deps);
  registerDesignTools(server, deps, { own });
  registerDeployTools(server, deps, { provisionServices: services });
  registerPortainerTools(server, deps, { services });

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
    root,
    paths,
    host,
    engine,
    elicited,
    outputs,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      outputs.push(result);
      return result;
    },
  };
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

/** No tool result (what the model sees) names the server's address. */
function expectNoAddress(h: { outputs: CallToolResult[] }) {
  expect(JSON.stringify(h.outputs)).not.toContain(OWN_IPV4);
}

const ANSWERS = {
  provider: "own",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "10 EUR",
  uptime: "standard",
  dataCriticality: "important",
  "server.host": OWN_IPV4,
  "server.port": 22,
  "server.user": "root",
  "server.key": "agent",
  "server.reachable": true,
};

describe.skipIf(!findExecutable("git"))("MCP tools on a server the user owns", () => {
  it("the interview offers the server questions and keeps the address out of every result", async () => {
    const h = await connect({ login: false });
    const questions = await h.call("opscrew_interview_questions");
    expect(textOf(questions)).toContain("What is your server's address?");
    expect(dataOf(questions).serverQuestions.map((q: { id: string }) => q.id)).toEqual([
      "server.host",
      "server.port",
      "server.user",
      "server.key",
      "server.reachable",
    ]);
    const saved = await h.call("opscrew_save_requirements", { answers: ANSWERS });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    expect(textOf(saved)).toContain("a server the user already has");
    expect((await readOwnServer(h.paths))?.host).toBe(OWN_IPV4);
    // Asked again, the saved address is a default, shown as "your server".
    const again = await h.call("opscrew_interview_questions");
    expect(textOf(again)).toContain("leave server.host out");
    expectNoAddress(h);
  });

  it("design asks the user to confirm the host key in a dialog, then offers the server without a price", async () => {
    const h = await connect({ elicit: approveAll, login: false });
    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const result = await h.call("opscrew_design_options");
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(h.elicited).toHaveLength(1);
    expect(h.elicited[0]?.message).toContain(FINGERPRINT);
    expect((await readOwnServer(h.paths))?.hostKey).toBe(FINGERPRINT);
    const text = textOf(result);
    expect(text).toContain("no server price");
    expect(text).not.toMatch(/€|EUR\/month|prices live from|dated price list/);
    expect(dataOf(result).options[0]).not.toHaveProperty("cost");
    expect(dataOf(result).options[0].price).toContain("already pays");

    const selected = await h.call("opscrew_select_design", { optionId: "own-server" });
    expect(selected.isError, textOf(selected)).toBeFalsy();
    expect(textOf(selected)).toContain("no server price");
    expect(h.host.inspections).toBe(2);
    expectNoAddress(h);
  });

  it("design refuses to trust a new host key when the client cannot show a dialog", async () => {
    const h = await connect({ login: false });
    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const result = await h.call("opscrew_design_options");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("npx opscrew design");
    expect(h.host.inspections).toBe(0);
    expect((await readOwnServer(h.paths))?.hostKey).toBeUndefined();
    // A user who declines in the dialog pins nothing either.
    const declined = await connect({ elicit: () => ({ action: "decline" }), login: false });
    await declined.call("opscrew_save_requirements", { answers: ANSWERS });
    const refused = await declined.call("opscrew_design_options");
    expect(refused.isError).toBe(true);
    expect((await readOwnServer(declined.paths))?.hostKey).toBeUndefined();
  });

  it("opscrew_plan returns the host plan's hash; opscrew_apply applies it only after the user's dialog", async () => {
    const h = await connect({
      elicit: approveAll,
      plan: ownPlan(),
      login: { hostKey: FINGERPRINT },
    });
    const planned = await h.call("opscrew_plan");
    expect(planned.isError, textOf(planned)).toBeFalsy();
    const hostHash = dataOf(planned).hostPlanHash as string;
    expect(hostHash).toMatch(/^[0-9a-f]{64}$/);
    expect(textOf(planned)).toContain("Host plan for your server");
    expect(textOf(planned)).toContain(`opscrew provision --approve ${hostHash}`);
    expect(h.host.applies).toEqual([]);

    const applied = await h.call("opscrew_apply", { planHash: hostHash });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    expect(h.host.applies).toHaveLength(1);
    expect(h.host.applies[0]?.options.approvedHash).toBe(hostHash);
    const kinds = h.elicited.map((e) => e.message);
    expect(kinds.some((m) => m.includes("Apply the host plan to your server"))).toBe(true);
    expect(textOf(applied)).toContain("backups are the user's responsibility");
    expectNoAddress(h);
  });

  it("a declined host plan changes nothing on the server", async () => {
    const decline: Answer = (params) =>
      params.message.includes("host plan") ? { action: "decline" } : approveAll(params);
    const h = await connect({ elicit: decline, plan: ownPlan(), login: { hostKey: FINGERPRINT } });
    const planned = await h.call("opscrew_plan");
    const hostHash = dataOf(planned).hostPlanHash as string;
    const applied = await h.call("opscrew_apply", { planHash: hostHash });
    expect(applied.isError).toBe(true);
    expect(h.host.applies).toEqual([]);
  });

  it("Portainer: status shows no password and no address; enable needs the user's dialog", async () => {
    const h = await connect({
      plan: ownPlan({ deployed: true }),
      login: { hostKey: FINGERPRINT },
      facts: preparedFacts,
    });
    const refused = await h.call("opscrew_portainer_enable");
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("npx opscrew portainer enable");
    expect(h.host.applies).toEqual([]);

    const ok = await connect({
      elicit: approveAll,
      plan: ownPlan({ deployed: true }),
      login: { hostKey: FINGERPRINT },
      facts: preparedFacts,
    });
    const enabled = await ok.call("opscrew_portainer_enable");
    expect(enabled.isError, textOf(enabled)).toBeFalsy();
    expect(ok.host.applies).toHaveLength(1);
    const password = (await readFile(portainerPasswordFile(ok.paths), "utf8")).trim();
    expect(ok.host.applies[0]?.options.secrets?.portainerPassword).toBe(password);
    const status = await ok.call("opscrew_portainer_status");
    expect(textOf(status)).toContain("npx opscrew portainer status");
    expect(textOf(status)).toContain("https://localhost:9443");
    expect(JSON.stringify(ok.outputs)).not.toContain(password);
    expectNoAddress(ok);
  });
});
