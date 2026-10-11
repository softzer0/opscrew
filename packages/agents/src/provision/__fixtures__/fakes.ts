import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  PlanSummary,
  RemoteExec,
  ResourceChange,
} from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { ScriptedRunner } from "../../testing";
import type { CloudflareApi, GitHubApi } from "../types";

export const CF_V4 = ["173.245.48.0/20", "103.21.244.0/22"];
export const CF_V6 = ["2400:cb00::/32"];
export const SERVER_IPV4 = "203.0.113.10";
export const SERVER_IPV6 = "2001:db8::1";
/** A public host key (not a secret). */
export const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTestsOnlyHostKeyForTestsOnly";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface PlanInputOptions {
  domain?: string;
  postgres?: boolean;
  deployed?: boolean;
}

/** A valid `opscrew/plan.yaml` input (parsed with the schema so defaults are filled). */
export function testPlan(options: PlanInputOptions = {}) {
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
    services: { postgres: options.postgres ?? true, redis: false },
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
    dns: options.domain
      ? { provider: "cloudflare", domain: options.domain, proxied: true }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    ...(options.deployed
      ? { deployment: { serverIpv4: SERVER_IPV4, serverIpv6: SERVER_IPV6 } }
      : {}),
  });
}

/** `show -json` shaped like the rendered root module, passing every policy unless told otherwise. */
export function planJsonFor(options: { proxied?: boolean; openDatabasePort?: boolean } = {}) {
  const web = options.proxied ? [...CF_V4, ...CF_V6] : ["0.0.0.0/0", "::/0"];
  const rules: Record<string, unknown>[] = [
    { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"] },
    { direction: "in", protocol: "tcp", port: "80", source_ips: web },
    { direction: "in", protocol: "tcp", port: "443", source_ips: web },
    { direction: "in", protocol: "udp", port: "443", source_ips: web },
  ];
  if (options.openDatabasePort) {
    rules.push({ direction: "in", protocol: "tcp", port: "5432", source_ips: ["0.0.0.0/0"] });
  }
  const resources: Record<string, unknown>[] = [
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
      values: { name: "shop-firewall", rule: rules },
    },
  ];
  const dns = options.proxied
    ? [
        {
          address: "module.dns.cloudflare_dns_record.a",
          mode: "managed",
          type: "cloudflare_dns_record",
          name: "a",
          values: { name: "shop.example.com", type: "A", proxied: true, ttl: 1 },
        },
      ]
    : [];
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          { address: "module.server", resources },
          ...(dns.length > 0 ? [{ address: "module.dns", resources: dns }] : []),
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

const CREATE: ResourceChange[] = [
  {
    address: "module.server.hcloud_ssh_key.deploy",
    type: "hcloud_ssh_key",
    name: "deploy",
    provider: "registry.opentofu.org/hetznercloud/hcloud",
    action: "create",
  },
  {
    address: "module.server.hcloud_firewall.this",
    type: "hcloud_firewall",
    name: "this",
    provider: "registry.opentofu.org/hetznercloud/hcloud",
    action: "create",
  },
  {
    address: "module.server.hcloud_server.this",
    type: "hcloud_server",
    name: "this",
    provider: "registry.opentofu.org/hetznercloud/hcloud",
    action: "create",
  },
];

export interface FakeEngineScenario {
  planJson?: unknown;
  changes?: ResourceChange[];
  outputs?: Record<string, unknown>;
  applyOk?: boolean;
}

/** IaC engine fake: writes real plan files, enforces the hash binding like the real engines. */
export class FakeEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly calls: string[] = [];
  readonly applied: { planFile: string; approval: IacApproval }[] = [];
  initOptions: IacInitOptions | undefined;
  #counter = 0;

  constructor(readonly scenario: FakeEngineScenario = {}) {}

  get outputs(): Record<string, unknown> {
    return (
      this.scenario.outputs ?? {
        server_ipv4: SERVER_IPV4,
        server_ipv6: SERVER_IPV6,
        server_id: "4711",
        server_name: "shop",
        url: `http://${SERVER_IPV4}`,
      }
    );
  }

  async init(_dir: string, options?: IacInitOptions): Promise<void> {
    this.calls.push("init");
    this.initOptions = options;
  }

  async validate() {
    this.calls.push("validate");
    return { valid: true, diagnostics: [] };
  }

  async plan(dir: string, planFile: string): Promise<PlanSummary> {
    this.calls.push("plan");
    const content = `fake plan ${++this.#counter} for ${dir}`;
    await writeFile(planFile, content);
    const changes = this.scenario.changes ?? CREATE;
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256(content),
      createdAt: "2026-10-11T12:00:00.000Z",
      changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: changes.some((c) => c.action === "delete" || c.action === "replace"),
      planJson: this.scenario.planJson ?? planJsonFor(),
    };
  }

  async apply(_dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    this.calls.push("apply");
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    this.applied.push({ planFile, approval });
    return this.scenario.applyOk === false
      ? { ok: false, outputs: {}, log: "Error: server type unavailable in nbg1" }
      : { ok: true, outputs: this.outputs, log: "Apply complete!" };
  }

  async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return this.applied.length > 0 ? this.outputs : {};
  }
}

/** GitHub REST fake recording secrets (plaintext, test only) and pull requests. */
export class FakeGitHub implements GitHubApi {
  readonly secrets = new Map<string, string>();
  readonly pulls: { head: string; base: string; title: string; body: string }[] = [];
  canPush = true;
  openPull: { number: number; url: string } | undefined;

  async getRepo() {
    return { defaultBranch: "main", private: true, canPush: this.canPush };
  }
  async getActionsPublicKey() {
    return { keyId: "key-1", key: "dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==" };
  }
  async setActionsSecret(_owner: string, _repo: string, name: string, value: string) {
    this.secrets.set(name, value);
  }
  async findOpenPullRequest() {
    return this.openPull;
  }
  async createPullRequest(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) {
    this.pulls.push(input);
    return { number: 7, url: "https://github.com/acme/shop/pull/7" };
  }
}

export function fakeCloudflare(
  options: { configRules?: boolean; wafRules?: boolean; zone?: boolean } = {},
): CloudflareApi {
  return {
    verifyToken: async () => ({ ok: true, message: "The Cloudflare token is active." }),
    findZone: async () =>
      options.zone === false
        ? undefined
        : { id: "zone-123", name: "example.com", status: "active", nameServers: [] },
    hasEntrypointRuleset: async (_zone, phase) =>
      phase === "http_config_settings" ? !!options.configRules : !!options.wafRules,
    getIpRanges: async () => ({ ipv4: CF_V4, ipv6: CF_V6 }),
  };
}

/** Remote shell fake: cloud-init is finished. */
export function readyRemote(host: string): RemoteExec {
  return { host, run: async () => ({ exitCode: 0, stdout: "ready\n", stderr: "" }) };
}

/** Real git for the project; `ssh-keyscan` answers with {@link HOST_KEY}. */
export function projectRunner(hostKey = HOST_KEY): ScriptedRunner {
  const real = new NodeCommandRunner();
  return new ScriptedRunner(async (command, args, options) => {
    if (command === "ssh-keyscan") {
      return { exitCode: 0, stdout: `${args[args.length - 1]} ${hostKey}\n`, stderr: "" };
    }
    if (command === "ssh") return { exitCode: 0, stdout: "ready\n", stderr: "" };
    return real.run(command, args, options);
  });
}

/** Temp git project with a committed Dockerfile, a GitHub `origin` (pushes go to a bare repo). */
export async function createProject(plan = testPlan()) {
  const runner = new NodeCommandRunner();
  const root = await mkdtemp(join(tmpdir(), "opscrew-provision-"));
  const bare = await mkdtemp(join(tmpdir(), "opscrew-provision-remote-"));
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
  await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
  await writeFile(join(root, ".gitignore"), ".opscrew/\n.env\n");
  await git(root, "add", "Dockerfile", ".gitignore");
  await git(root, "commit", "-m", "init");
  await writeArtifact("plan", join(root, "opscrew", "plan.yaml"), plan);
  return { root, bare, git };
}
