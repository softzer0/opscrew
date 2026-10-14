/**
 * Fakes for the deploy commands (`provision`, `dns`, `secure`, `verify`): a git project with a
 * GitHub `origin` whose pushes land in a local bare repository, a deploy plan, an IaC engine that
 * writes real plan files and enforces the hash binding, GitHub and Cloudflare APIs, a server and
 * the outside network. Adapted from `@opscrew/agents` provision and verify fixtures. Tests only.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacEngine,
  PlanSummary,
  RemoteExec,
  ResourceChange,
} from "@opscrew/contracts";
import {
  type CloudflareApi,
  cloudTarget,
  type GitHubApi,
  hasDeployment,
  type ProvisionServices,
  recordServerAddress,
} from "@opscrew/agents";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { git, type TempProject, tempProject } from "./harness";

export const SERVER_IPV4 = "203.0.113.10";
export const SERVER_IPV6 = "2001:db8::1";
/** A public host key (not a secret). */
export const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTestsOnlyHostKeyForTestsOnly";
export const CF_V4 = ["173.245.48.0/20", "104.16.0.0/13"];
export const CF_V6 = ["2400:cb00::/32", "2606:4700::/32"];
/** Inside Cloudflare's 104.16.0.0/13 and 2606:4700::/32. */
export const CLOUDFLARE_IPV4 = "104.21.32.1";
export const CLOUDFLARE_IPV6 = "2606:4700:3030::6815:2001";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface TestPlanOptions {
  domain?: string;
  deployed?: boolean;
  /** Add a user-supplied secret (`STRIPE_SECRET_KEY`) to the app environment. */
  userSecret?: boolean;
  httpAllowedFrom?: "any" | "cloudflare";
}

/** A valid deploy plan for the `shop` app (Postgres, Hetzner cx23 in nbg1). */
export function testPlan(options: TestPlanOptions = {}): DeployPlan {
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
        ...(options.userSecret ? [{ name: "STRIPE_SECRET_KEY", secret: true, source: "user" }] : []),
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
      breakdown: [{ item: "server", monthly: { amount: 8.41, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: options.domain
      ? { provider: "cloudflare", domain: options.domain, zone: "example.com", proxied: true }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: options.httpAllowedFrom ? { httpAllowedFrom: options.httpAllowedFrom } : {},
    // A deployed plan records the apply; the server's address is in the local state only
    // (`deployProject` writes it there, as provision does).
    ...(options.deployed ? { deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" } } : {}),
  });
}

/** A deployed plan (see {@link testPlan}). */
export function deployedPlan(options: Omit<TestPlanOptions, "deployed"> = {}): DeployPlan {
  return testPlan({ ...options, deployed: true });
}

/** `show -json` shaped like the rendered root module; passes every policy unless told otherwise. */
export function planJsonFor(options: { proxied?: boolean; openDatabasePort?: boolean } = {}) {
  const web = options.proxied ? [...CF_V4, ...CF_V6] : ["0.0.0.0/0", "::/0"];
  const rules: Record<string, unknown>[] = [
    { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"] },
    { direction: "in", protocol: "tcp", port: "80", source_ips: web },
    { direction: "in", protocol: "tcp", port: "443", source_ips: web },
  ];
  if (options.openDatabasePort) {
    rules.push({ direction: "in", protocol: "tcp", port: "5432", source_ips: ["0.0.0.0/0"] });
  }
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
                values: { name: "shop-firewall", rule: rules },
              },
            ],
          },
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

const CREATE: ResourceChange[] = ["hcloud_ssh_key.deploy", "hcloud_firewall.this", "hcloud_server.this"].map(
  (address) => {
    const [type = "", name = ""] = address.split(".");
    return {
      address: `module.server.${address}`,
      type,
      name,
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "create" as const,
    };
  },
);

/**
 * `show -json` shaped like the rendered DigitalOcean root module for `plan` (module `server`):
 * Droplet, firewall attached to it, deploy SSH key and app tag; passes every DigitalOcean policy.
 */
export function digitalOceanPlanJsonFor(plan: DeployPlan) {
  const world = ["0.0.0.0/0", "::/0"];
  const proxied = plan.dns.proxied && plan.security.httpAllowedFrom === "cloudflare";
  const web = proxied ? [...CF_V4, ...CF_V6] : world;
  const name = plan.app.name;
  const target = cloudTarget(plan.target);
  const resource = (type: string, local: string, values: Record<string, unknown>) => ({
    address: `module.server.${type}.${local}`,
    mode: "managed",
    type,
    name: local,
    values,
  });
  const dns = proxied
    ? [
        {
          address: "module.dns",
          resources: [
            {
              address: "module.dns.cloudflare_dns_record.a",
              mode: "managed",
              type: "cloudflare_dns_record",
              name: "a",
              values: { name: plan.dns.domain, type: "A", proxied: true, ttl: 1 },
            },
          ],
        },
      ]
    : [];
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.server",
            resources: [
              resource("digitalocean_droplet", "this", {
                name,
                region: target.location,
                size: target.serverType,
                image: target.image,
                backups: target.backups,
                ipv6: true,
                monitoring: true,
              }),
              resource("digitalocean_firewall", "this", {
                name: `${name}-firewall`,
                inbound_rule: [
                  { protocol: "tcp", port_range: "22", source_addresses: world },
                  { protocol: "tcp", port_range: "80", source_addresses: web },
                  { protocol: "tcp", port_range: "443", source_addresses: web },
                  { protocol: "udp", port_range: "443", source_addresses: web },
                  { protocol: "icmp", port_range: "", source_addresses: world },
                ],
                outbound_rule: [
                  { protocol: "tcp", port_range: "1-65535", destination_addresses: world },
                  { protocol: "udp", port_range: "1-65535", destination_addresses: world },
                ],
              }),
              resource("digitalocean_ssh_key", "deploy", { name: `${name}-deploy` }),
              resource("digitalocean_tag", "app", { name: `opscrew-app:${name}` }),
            ],
          },
          ...dns,
        ],
      },
    },
    resource_changes: [
      {
        address: "module.server.digitalocean_droplet.this",
        change: { actions: ["create"], after_unknown: { id: true, ssh_keys: [true] } },
      },
      {
        address: "module.server.digitalocean_firewall.this",
        change: { actions: ["create"], after_unknown: { id: true, droplet_ids: true } },
      },
    ],
    configuration: {
      root_module: {
        module_calls: {
          server: {
            source: "../modules/digitalocean-droplet",
            module: {
              resources: [
                {
                  address: "digitalocean_droplet.this",
                  mode: "managed",
                  type: "digitalocean_droplet",
                  name: "this",
                  expressions: {
                    ssh_keys: { references: ["digitalocean_ssh_key.deploy.fingerprint"] },
                  },
                },
                {
                  address: "digitalocean_firewall.this",
                  mode: "managed",
                  type: "digitalocean_firewall",
                  name: "this",
                  expressions: {
                    droplet_ids: {
                      references: ["digitalocean_droplet.this.id", "digitalocean_droplet.this"],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

/** What the first apply of a DigitalOcean plan creates. */
export const DIGITALOCEAN_CREATE: ResourceChange[] = [
  ["digitalocean_tag", "app"],
  ["digitalocean_ssh_key", "deploy"],
  ["digitalocean_droplet", "this"],
  ["digitalocean_firewall", "this"],
].map(([type = "", name = ""]) => ({
  address: `module.server.${type}.${name}`,
  type,
  name,
  provider: "registry.opentofu.org/digitalocean/digitalocean",
  action: "create" as const,
}));

/** IaC engine fake: writes real plan files and refuses an apply whose hash does not match. */
export class FakeEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly calls: string[] = [];
  readonly applied: { planFile: string; approval: IacApproval }[] = [];
  #counter = 0;

  constructor(
    readonly scenario: { planJson?: unknown; changes?: ResourceChange[] } = {},
  ) {}

  readonly outputs = {
    server_ipv4: SERVER_IPV4,
    server_ipv6: SERVER_IPV6,
    server_id: "4711",
    server_name: "shop",
    url: `http://${SERVER_IPV4}`,
  };

  async init(): Promise<void> {
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
    return { ok: true, outputs: this.outputs, log: "Apply complete!" };
  }

  async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return this.applied.length > 0 ? this.outputs : {};
  }
}

/** GitHub REST fake recording secret names (values kept in memory, tests only) and pull requests. */
export class FakeGitHub implements GitHubApi {
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
    this.pulls.push({ head: input.head, base: input.base, title: input.title });
    return { number: 7, url: "https://github.com/acme/shop/pull/7" };
  }
}

/** Cloudflare fake: the token works, `example.com` is visible and has no rules of its own. */
export function fakeCloudflare(): CloudflareApi {
  return {
    verifyToken: async () => ({ ok: true, message: "The Cloudflare token is active." }),
    findZone: async () => ({
      id: "zone-123",
      name: "example.com",
      status: "active",
      nameServers: [],
    }),
    listDnsRecords: async () => [],
    inspectEntrypointRuleset: async () => ({ exists: false, ownedByOpsCrew: false, ruleCount: 0 }),
    getIpRanges: async () => ({ ipv4: CF_V4, ipv6: CF_V6 }),
  };
}

/** The fakes `provision` and `dns` need: engine, cloud provider, GitHub, Cloudflare, SSH and waits. */
export function provisionServices(
  engine: FakeEngine,
  github: FakeGitHub,
  extra: ProvisionServices = {},
): ProvisionServices {
  return {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote: (host) => ({ host, run: async () => ({ exitCode: 0, stdout: "ready\n", stderr: "" }) }),
    sleep: async () => undefined,
    ...extra,
  };
}

/**
 * Real git; `ssh-keyscan` answers with {@link HOST_KEY}; the outside SSH password probe is refused
 * with "publickey" only. Everything else (scanners, `gh`) reports "not found".
 */
export class DeployRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });
  readonly calls: string[][] = [];

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const name = path.basename(command).replace(/\.exe$/i, "");
    this.calls.push([name, ...args]);
    if (name === "git") return this.#node.run(command, args, options);
    if (name === "ssh-keyscan") {
      return { exitCode: 0, stdout: `${args[args.length - 1]} ${HOST_KEY}\n`, stderr: "" };
    }
    if (name === "ssh" && args.includes("PubkeyAuthentication=no")) {
      return {
        exitCode: 255,
        stdout: "",
        stderr: `deploy@${SERVER_IPV4}: Permission denied (publickey).`,
      };
    }
    return { exitCode: 127, stdout: "", stderr: "not found" };
  }
}

/** A temp git project with a committed Dockerfile, `opscrew/plan.yaml` and a bare push target. */
export interface DeployProject extends TempProject {
  /** Bare repository that receives pushes to `origin`. */
  bare: string;
}

/** Creates a {@link DeployProject} for `plan` (see {@link writeProjectPlan}). */
export async function deployProject(plan: DeployPlan = testPlan()): Promise<DeployProject> {
  const project = await tempProject();
  const bare = path.join(project.dir, "remote.git");
  await git(project.env, project.dir, "init", "-q", "--bare", "-b", "main", bare);
  await git(project.env, project.root, "init", "-q", "-b", "main");
  await git(project.env, project.root, "remote", "add", "origin", "https://github.com/acme/shop.git");
  await git(project.env, project.root, "remote", "set-url", "--push", "origin", bare);
  await writeFile(path.join(project.root, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
  await writeFile(path.join(project.root, ".gitignore"), ".opscrew/\n.env\n");
  await git(project.env, project.root, "add", "Dockerfile", ".gitignore");
  await git(project.env, project.root, "commit", "-q", "-m", "init");
  await writeProjectPlan(project, plan);
  return { ...project, bare };
}

/**
 * Writes `opscrew/plan.yaml` into `project` and, for a deployed plan, the server's address
 * ({@link SERVER_IPV4}, {@link SERVER_IPV6}) into its local state, as provision leaves them.
 * Returns the plan file's path.
 */
export async function writeProjectPlan(project: TempProject, plan: DeployPlan): Promise<string> {
  const planFile = path.join(project.root, "opscrew", "plan.yaml");
  await writeArtifact("plan", planFile, plan);
  if (hasDeployment(plan)) {
    await recordServerAddress(resolveProjectPaths(project.root, { env: project.env }), {
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
    });
  }
  return planFile;
}

/** A hardened Ubuntu server answering the `secure` checks; `passwordAuth` leaves password login on. */
export function fakeServer(options: { passwordAuth?: boolean } = {}): RemoteExec {
  const sshd = [
    `PasswordAuthentication ${options.passwordAuth ? "yes" : "no"}`,
    "KbdInteractiveAuthentication no",
    "PermitRootLogin no",
    "MaxAuthTries 3",
    "X11Forwarding no",
    "AllowUsers deploy",
  ].join("\n");
  const answers: Record<string, string> = {
    "cat /etc/ssh/sshd_config.d/10-opscrew.conf": sshd,
    "systemctl is-active fail2ban": "active",
    "grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf": "",
    "systemctl is-enabled unattended-upgrades": "enabled",
    "ss -H -tln": [
      "LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*",
      "LISTEN 0      4096   0.0.0.0:80        0.0.0.0:*",
      "LISTEN 0      4096   0.0.0.0:443       0.0.0.0:*",
      "LISTEN 0      4096   [::]:22           [::]:*",
    ].join("\n"),
    "df -P /":
      "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/sda1         39000000 4200000  33000000      12% /",
    "test -f /var/lib/opscrew-ready && echo yes || echo no": "yes",
    "test -f /var/run/reboot-required && echo yes || echo no": "no",
    "apt list --upgradable 2>/dev/null | grep -ci security || true": "0",
  };
  return {
    host: SERVER_IPV4,
    run: async (command) => {
      const answer = answers[command];
      return answer === undefined
        ? { exitCode: 127, stdout: "", stderr: `unexpected command: ${command}` }
        : { exitCode: 0, stdout: `${answer}\n`, stderr: "" };
    },
  };
}

/** A healthy site behind Cloudflare at https://shop.example.com (redirect, health, headers). */
export function fakeSite(options: { healthStatus?: number } = {}): FetchLike {
  const headers = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  return async (input) => {
    const url = String(input);
    const parsed = new URL(url);
    if (url.startsWith("http://shop.example.com")) {
      return new Response(null, {
        status: 308,
        headers: { location: `https://shop.example.com${parsed.pathname}` },
      });
    }
    if (url === "https://shop.example.com/") {
      return new Response("<!doctype html><p>shop</p>", { headers });
    }
    if (url === "https://shop.example.com/api/health") {
      return new Response("ok", { status: options.healthStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  };
}
