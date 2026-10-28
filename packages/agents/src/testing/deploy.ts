import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudflareClient,
  type CloudflareDnsRecord,
  OPSCREW_MANAGED_COMMENT,
} from "@opscrew/connector-cloudflare";
import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type {
  CheckWorkflowState,
  EnvironmentSettings,
  EnvironmentView,
  OpenIssue,
} from "@opscrew/connector-github";
import type {
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  RemoteExec,
  ResourceChange,
  ResourceMove,
} from "@opscrew/contracts";
import {
  NodeCommandRunner,
  OpsCrewError,
  type ProjectPaths,
  resolveProjectPaths,
  tfstateFile,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { cloudTarget } from "@opscrew/iac-templates";
import {
  type CloudProvider,
  type DeployPlan,
  DeployPlanSchema,
  type Retarget,
  writeArtifact,
} from "@opscrew/plan-schema";
import { selfHostedServices } from "../design/sizing";
import type { CloudflareApi, GitHubApi } from "../provision/types";
import { hasDeployment, updateServerAddresses } from "../shared";
import { ScriptedRunner } from "./deps";
import { noProviderSchemas, plainStateResources } from "./state";

export const CF_V4 = ["173.245.48.0/20", "103.21.244.0/22"];
export const CF_V6 = ["2400:cb00::/32"];
/** An address of Cloudflare's edge, inside {@link CLOUDFLARE_RANGES}' 104.16.0.0/13. */
export const CLOUDFLARE_IPV4 = "104.21.32.1";
export const CLOUDFLARE_IPV6 = "2606:4700:3030::6815:2001";
/** Cloudflare's published ranges as verify reads them. */
export const CLOUDFLARE_RANGES = {
  ipv4: ["104.16.0.0/13", "172.64.0.0/13"],
  ipv6: ["2606:4700::/32"],
};
export const SERVER_IPV4 = "203.0.113.10";
export const SERVER_IPV6 = "2001:db8::1";
/** A public host key (not a secret). */
export const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTestsOnlyHostKeyForTestsOnly";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface PlanInputOptions {
  domain?: string;
  postgres?: boolean;
  deployed?: boolean;
  /** Also serve `www.<domain>` (with `domain`). */
  www?: boolean;
  /** Cloud provider of the plan (default Hetzner). */
  provider?: CloudProvider;
  /** The user supplies `STRIPE_SECRET_KEY` (default true); false leaves it out of the app's env. */
  userSecret?: boolean;
  httpAllowedFrom?: "any" | "cloudflare";
}

/** Plan targets per provider: location, size and image as design would choose them. */
const TARGETS = {
  hetzner: { location: "nbg1", serverType: "cx23" },
  digitalocean: { location: "fra1", serverType: "s-1vcpu-2gb", image: "ubuntu-24-04-x64" },
} as const;

/** A valid `opscrew/plan.yaml` input (parsed with the schema so defaults are filled). */
export function testPlan(options: PlanInputOptions = {}) {
  const provider = options.provider ?? "hetzner";
  const currency = provider === "digitalocean" ? "USD" : "EUR";
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
        ...(options.userSecret === false
          ? []
          : [{ name: "STRIPE_SECRET_KEY", secret: true, source: "user" }]),
      ],
    },
    target: {
      provider,
      mode: "vps-compose",
      ...TARGETS[provider],
      backups: true,
    },
    services: selfHostedServices({ postgres: options.postgres ?? true, redis: false }),
    externalServices: [],
    cost: {
      monthly: { amount: 8.41, currency },
      breakdown: [
        { item: "server", monthly: { amount: 6.59, currency } },
        { item: "backups", monthly: { amount: 1.32, currency } },
        { item: "ipv4", monthly: { amount: 0.5, currency } },
      ],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: options.domain
      ? { provider: "cloudflare", domain: options.domain, proxied: true, www: !!options.www }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: options.httpAllowedFrom ? { httpAllowedFrom: options.httpAllowedFrom } : {},
    // A deployed plan records the apply; the server's address is in the local state only
    // (`createProject` writes it there, as provision does).
    ...(options.deployed ? { deployment: { lastApplyAt: DEPLOYED_AT } } : {}),
  });
}

/** When the deployed test plans were applied. */
export const DEPLOYED_AT = "2026-10-11T11:00:00.000Z";

/**
 * A deployed Hetzner plan in the middle of `opscrew retarget` to DigitalOcean: `target` is already
 * the new provider, `retarget.from` the live Hetzner server.
 */
export function movingPlan(step: Retarget["step"] = "renamed") {
  const from = testPlan({ deployed: true });
  return DeployPlanSchema.parse({
    ...from,
    target: testPlan({ provider: "digitalocean" }).target,
    retarget: {
      from: { target: from.target },
      step,
      startedAt: "2026-10-12T09:00:00.000Z",
    },
  });
}

/**
 * Writes the server's address to the project's local state (`.opscrew/server.json`) the way
 * `opscrew provision` does: {@link SERVER_IPV4} and {@link SERVER_IPV6} for the deployment and,
 * during a move, as the server being replaced.
 */
export async function recordTestServer(root: string, plan: DeployPlan): Promise<void> {
  if (!hasDeployment(plan)) return;
  const address = { ipv4: SERVER_IPV4, ipv6: SERVER_IPV6 };
  await updateServerAddresses(resolveProjectPaths(root), (current) => ({
    ...current,
    deployment: address,
    ...(plan.retarget === undefined ? {} : { retarget: { from: address } }),
  }));
}

export interface PlanJsonOptions {
  proxied?: boolean;
  openDatabasePort?: boolean;
  provider?: CloudProvider;
  /**
   * DigitalOcean: the app's name, the Droplet and the record's name come from this plan (default
   * `testPlan({ provider: "digitalocean" })`).
   */
  plan?: DeployPlan;
}

/** `show -json` shaped like the rendered root module, passing every policy unless told otherwise. */
export function planJsonFor(options: PlanJsonOptions = {}) {
  if (options.provider === "digitalocean") return digitalOceanPlanJson(options);
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

/** The DNS module's planned record for `domain` when the site is behind Cloudflare's proxy. */
function dnsModule(proxied: boolean | undefined, domain: string) {
  return proxied
    ? [
        {
          address: "module.dns",
          resources: [
            {
              address: "module.dns.cloudflare_dns_record.a",
              mode: "managed",
              type: "cloudflare_dns_record",
              name: "a",
              values: { name: domain, type: "A", proxied: true, ttl: 1 },
            },
          ],
        },
      ]
    : [];
}

/** `show -json` shaped like the rendered DigitalOcean root module (module `server`). */
function digitalOceanPlanJson(options: PlanJsonOptions) {
  const plan = options.plan ?? testPlan({ provider: "digitalocean" });
  const name = plan.app.name;
  const target = cloudTarget(plan.target);
  const world = ["0.0.0.0/0", "::/0"];
  const web = options.proxied ? [...CF_V4, ...CF_V6] : world;
  const inbound: Record<string, unknown>[] = [
    { protocol: "tcp", port_range: "22", source_addresses: world },
    { protocol: "tcp", port_range: "80", source_addresses: web },
    { protocol: "tcp", port_range: "443", source_addresses: web },
    { protocol: "udp", port_range: "443", source_addresses: web },
    { protocol: "icmp", port_range: "", source_addresses: world },
  ];
  if (options.openDatabasePort) {
    inbound.push({ protocol: "tcp", port_range: "5432", source_addresses: ["0.0.0.0/0"] });
  }
  const resources: Record<string, unknown>[] = [
    {
      address: "module.server.digitalocean_droplet.this",
      mode: "managed",
      type: "digitalocean_droplet",
      name: "this",
      values: {
        name,
        region: target.location,
        size: target.serverType,
        image: target.image,
        backups: target.backups,
        ipv6: true,
        monitoring: true,
      },
    },
    {
      address: "module.server.digitalocean_firewall.this",
      mode: "managed",
      type: "digitalocean_firewall",
      name: "this",
      values: {
        name: `${name}-firewall`,
        inbound_rule: inbound,
        outbound_rule: [
          { protocol: "tcp", port_range: "1-65535", destination_addresses: world },
          { protocol: "udp", port_range: "1-65535", destination_addresses: world },
        ],
      },
    },
    {
      address: "module.server.digitalocean_ssh_key.deploy",
      mode: "managed",
      type: "digitalocean_ssh_key",
      name: "deploy",
      values: { name: `${name}-deploy` },
    },
    {
      address: "module.server.digitalocean_tag.app",
      mode: "managed",
      type: "digitalocean_tag",
      name: "app",
      values: { name: `opscrew-app:${name}` },
    },
  ];
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          { address: "module.server", resources },
          ...dnsModule(options.proxied, plan.dns.domain ?? "shop.example.com"),
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

const DIGITALOCEAN_PROVIDER = "registry.opentofu.org/digitalocean/digitalocean";

/** What the first apply of a DigitalOcean plan creates. */
export const DIGITALOCEAN_CREATE: ResourceChange[] = [
  ["digitalocean_tag", "app"],
  ["digitalocean_ssh_key", "deploy"],
  ["digitalocean_droplet", "this"],
  ["digitalocean_firewall", "this"],
].map(([type, name]) => ({
  address: `module.server.${type}.${name}`,
  type: type as string,
  name: name as string,
  provider: DIGITALOCEAN_PROVIDER,
  action: "create" as const,
}));

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
  /** State renames (`moved` blocks) the plan reports. */
  moves?: ResourceMove[];
  outputs?: Record<string, unknown>;
  applyOk?: boolean;
  /** Engine log of a failed apply (default: Hetzner's unavailable server type). */
  applyLog?: string;
  /** The engine's words for each failed import, in turn (`ENGINE_FAILED`); later imports work. */
  importErrors?: string[];
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
      ...(this.scenario.moves !== undefined ? { moves: this.scenario.moves } : {}),
    };
  }

  async apply(_dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    this.calls.push("apply");
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    this.applied.push({ planFile, approval });
    return this.scenario.applyOk === false
      ? {
          ok: false,
          outputs: {},
          log: this.scenario.applyLog ?? "Error: server type unavailable in nbg1",
        }
      : { ok: true, outputs: this.outputs, log: "Apply complete!" };
  }

  async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return this.applied.length > 0 ? this.outputs : {};
  }

  /** The addresses `untaint` was called with, in order. */
  readonly untainted: string[] = [];

  async untaint(_dir: string, address: string): Promise<void> {
    this.calls.push("untaint");
    this.untainted.push(address);
  }

  /** Every import tried, in order, with its environment; `scenario.importErrors` fail first. */
  readonly imports: { address: string; id: string; env?: Record<string, string | undefined> }[] =
    [];

  async importResource(
    _dir: string,
    address: string,
    id: string,
    options?: IacRunOptions,
  ): Promise<void> {
    this.calls.push("import");
    this.imports.push({ address, id, ...(options?.env ? { env: options.env } : {}) });
    const error = this.scenario.importErrors?.shift();
    if (error !== undefined) {
      throw new OpsCrewError("ENGINE_FAILED", `OpenTofu import failed (exit code 1).\n${error}`);
    }
  }

  readonly providerSchemas = noProviderSchemas;
  readonly stateResources = plainStateResources;
}

/** A GitHub environment with no protection rules, as GitHub shows it. */
function environmentView(name: string): EnvironmentView {
  return {
    name,
    waitTimer: 0,
    preventSelfReview: false,
    reviewers: [],
    branchPolicy: null,
    canAdminsBypass: true,
  };
}

/** GitHub REST fake recording secrets (plaintext, test only) and pull requests. */
export class FakeGitHub implements GitHubApi {
  readonly secrets = new Map<string, string>();
  readonly pulls: { head: string; base: string; title: string; body: string }[] = [];
  canPush = true;
  /** Whether the repository's issues are on. */
  hasIssues = true;
  /** Open pull request returned for every head (see `openPulls` for one per head). */
  openPull: { number: number; url: string } | undefined;
  /** Open pull requests by head branch. */
  readonly openPulls = new Map<string, { number: number; url: string }>();
  /** Heads looked up with `findOpenPullRequest`. */
  readonly lookups: string[] = [];

  async getRepo(): ReturnType<GitHubApi["getRepo"]> {
    return {
      defaultBranch: "main",
      private: true,
      canPush: this.canPush,
      hasIssues: this.hasIssues,
    };
  }
  async getActionsPublicKey() {
    return { keyId: "key-1", key: "dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==" };
  }
  async setActionsSecret(_owner: string, _repo: string, name: string, value: string) {
    this.secrets.set(name, value);
  }
  async deleteActionsSecret(_owner: string, _repo: string, name: string) {
    this.secrets.delete(name);
  }
  async actionsSecretExists(_owner: string, _repo: string, name: string) {
    return this.secrets.has(name);
  }
  /** GitHub environments with their secrets (plaintext, test only). */
  readonly environments = new Map<string, Map<string, string>>();
  /** False: the repository has no GitHub environments (a private one on GitHub Free). */
  environmentsWork = true;
  /** False: GitHub enforces no branch rule there (a private repository on GitHub Free). */
  branchPoliciesWork = true;
  /** True: GitHub enforces required reviewers there (a public repository). */
  reviewersWork = false;
  /** The environments `environmentCapability` probed. */
  readonly probes: string[] = [];
  async environmentCapability(_owner: string, _repo: string, probe: string) {
    this.probes.push(probe);
    return {
      environments: this.environmentsWork,
      branchPolicies: this.environmentsWork && this.branchPoliciesWork,
      reviewers: this.environmentsWork && this.reviewersWork,
    };
  }
  /** The rules of each GitHub environment, as GitHub shows them. */
  readonly rules = new Map<string, EnvironmentView>();
  /** Every `putEnvironment`: the environment and the rules sent. */
  readonly environmentPuts: { name: string; settings: EnvironmentSettings }[] = [];
  async getEnvironment(_owner: string, _repo: string, name: string) {
    return this.environments.has(name)
      ? (this.rules.get(name) ?? environmentView(name))
      : undefined;
  }
  async putEnvironment(_owner: string, _repo: string, name: string, settings: EnvironmentSettings) {
    this.environmentPuts.push({ name, settings });
    if (!this.environments.has(name)) this.environments.set(name, new Map());
    const view = { ...(this.rules.get(name) ?? environmentView(name)) };
    if (settings.reviewers !== undefined) view.reviewers = settings.reviewers;
    if (settings.branchPolicy !== undefined) view.branchPolicy = settings.branchPolicy;
    this.rules.set(name, view);
    return view;
  }
  /** The repository owner's account type (`User` or `Organization`). */
  ownerType = "User";
  async account() {
    return { id: 1001, type: this.ownerType };
  }
  /** The branches allowed to deploy to each environment (its custom branch policies). */
  readonly deploymentBranches = new Map<string, string[]>();
  /** Thrown by `addDeploymentBranch`. */
  deploymentBranchError: Error | undefined;
  async addDeploymentBranch(_owner: string, _repo: string, env: string, branch: string) {
    if (this.deploymentBranchError !== undefined) throw this.deploymentBranchError;
    this.deploymentBranches.set(env, [...(this.deploymentBranches.get(env) ?? []), branch]);
  }
  async listDeploymentBranches(_owner: string, _repo: string, env: string) {
    return this.deploymentBranches.get(env) ?? [];
  }
  async environmentPublicKey() {
    return { keyId: "env-key-1", key: "dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==" };
  }
  async setEnvironmentSecret(
    _owner: string,
    _repo: string,
    env: string,
    name: string,
    value: string,
  ) {
    const secrets = this.environments.get(env);
    if (secrets === undefined) throw new Error(`The GitHub environment ${env} does not exist.`);
    secrets.set(name, value);
  }
  async deleteEnvironmentSecret(_owner: string, _repo: string, env: string, name: string) {
    this.environments.get(env)?.delete(name);
  }
  async deleteEnvironment(_owner: string, _repo: string, name: string) {
    this.environments.delete(name);
    this.rules.delete(name);
    this.deploymentBranches.delete(name);
  }
  async findOpenPullRequest(_owner: string, _repo: string, head: string) {
    this.lookups.push(head);
    return this.openPulls.get(head) ?? this.openPull;
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
  /** Workflow runs started with `dispatchWorkflow`: the workflow file and the branch. */
  readonly dispatches: { workflowFile: string; ref: string }[] = [];
  async dispatchWorkflow(
    _owner: string,
    _repo: string,
    workflowFile: string,
    ref: string,
    _inputs?: Record<string, string>,
    onAccepted?: () => Promise<void>,
  ) {
    this.dispatches.push({ workflowFile, ref });
    await onAccepted?.();
    return { runId: 42, url: "https://github.com/acme/shop/actions/runs/42" };
  }
  /** What OpsCrew wrote as a branch's only file (the branch holds nothing else then). */
  readonly holds = new Map<string, { path: string; content: string }>();
  async createOrphanBranch(input: { branch: string; path: string; content: string }) {
    this.holds.set(input.branch, { path: input.path, content: input.content });
    return { commit: "c".repeat(40) };
  }
  async replaceOrphanBranch(input: { branch: string; path: string; content: string }) {
    this.holds.set(input.branch, { path: input.path, content: input.content });
    return { commit: "d".repeat(40), previous: "e".repeat(40) };
  }
  async branchHoldsOnly(
    _owner: string,
    _repo: string,
    branch: string,
    file: { path: string; content: string },
  ) {
    const only = this.holds.get(branch);
    return only?.path === file.path && only.content === file.content;
  }
  /** Each workflow file's state (by file name); a file not here is `missing`. */
  readonly workflowStates = new Map<string, CheckWorkflowState>();
  async checkWorkflowState(_owner: string, _repo: string, file: string) {
    return this.workflowStates.get(file.split("/").pop() ?? file) ?? "missing";
  }
  /** Open issues by label. */
  readonly issues = new Map<string, OpenIssue[]>();
  async openIssues(_owner: string, _repo: string, label: string) {
    return this.issues.get(label) ?? [];
  }
  /** Repository variables. */
  readonly variables = new Map<string, string>();
  async getRepoVariable(_owner: string, _repo: string, name: string) {
    return this.variables.get(name);
  }
  async setRepoVariable(_owner: string, _repo: string, name: string, value: string) {
    this.variables.set(name, value);
  }
  async deleteRepoVariable(_owner: string, _repo: string, name: string) {
    this.variables.delete(name);
  }
  /** The Actions minutes the owner's plan includes; `undefined`: the plan is hidden. */
  minutes: number | undefined = 2_000;
  async includedMinutes() {
    return this.minutes;
  }
}

export interface FakeCloudflareOptions {
  zone?: boolean;
  /** DNS records in the zone. */
  records?: CloudflareDnsRecord[];
  /** Thrown by `listDnsRecords` (for example a refused permission). */
  listError?: Error;
}

/** Cloudflare fake whose zone contents tests may change between runs. */
export interface FakeCloudflareApi extends CloudflareApi {
  readonly state: { records: CloudflareDnsRecord[] };
  /** Names passed to `listDnsRecords`, in call order. */
  readonly listed: string[];
}

/** A DNS record as OpsCrew's module creates it (with its comment). */
export function opscrewRecord(
  name: string,
  type: string,
  content: string,
  extra: Partial<CloudflareDnsRecord> = {},
): CloudflareDnsRecord {
  return {
    id: `${type}-${name}`,
    type,
    name,
    content,
    ttl: 1,
    proxied: true,
    comment: OPSCREW_MANAGED_COMMENT,
    ...extra,
  };
}

/**
 * The zone `example.com` (id {@link FAKE_ZONE_ID}, in the account {@link FAKE_ACCOUNT_ID}) as the
 * Cloudflare checks see it; OpsCrew's shared rules are in {@link fakeSharedCloudflare}'s zone.
 */
export function fakeCloudflare(options: FakeCloudflareOptions = {}): FakeCloudflareApi {
  const state = { records: [...(options.records ?? [])] };
  const listed: string[] = [];
  return {
    state,
    listed,
    verifyToken: async () => ({ ok: true, message: "The Cloudflare token is active." }),
    findZone: async () =>
      options.zone === false
        ? undefined
        : {
            id: FAKE_ZONE_ID,
            name: "example.com",
            status: "active",
            nameServers: [],
            accountId: FAKE_ACCOUNT_ID,
          },
    listDnsRecords: async (_zone, filter = {}) => {
      listed.push(filter.name ?? "*");
      if (options.listError) throw options.listError;
      return state.records.filter(
        (r) =>
          (filter.name === undefined || r.name === filter.name) &&
          (filter.type === undefined || r.type === filter.type),
      );
    },
    getIpRanges: async () => ({ ipv4: CF_V4, ipv6: CF_V6 }),
    listAccounts: async () => [],
  };
}

/**
 * The client OpsCrew's shared Cloudflare step uses (`ProvisionServices.sharedCloudflare`) on a
 * fake zone and account that behave like Cloudflare's (a new, empty one by default).
 */
export function fakeSharedCloudflare(zone: FakeZone = new FakeZone()): CloudflareClient {
  return new CloudflareClient({
    token: fakeSecret("cloudflare-token", "shared"),
    fetch: zone.fetch,
    sleep: async () => undefined,
  });
}

/** Writes a non-empty (fake) infrastructure state file, as an apply leaves one. */
export async function writeFakeState(paths: ProjectPaths): Promise<void> {
  await mkdir(paths.files.tfstateDir, { recursive: true });
  await writeFile(tfstateFile(paths), JSON.stringify({ fake: true }));
}

/**
 * What deploy's read of the runners finds on a fresh server OpsCrew created (`inspectRunners`,
 * in the host adapter's section format): no runner, and the first boot's parts in place.
 */
const NO_RUNNERS = [
  ["dpkg-arch", "amd64"],
  ["runners", ""],
  ["runners-prepared", ""],
]
  .map(([name, text]) => `\n@@opscrew-section ${name}\n${text}\n@@opscrew-exit 0`)
  .join("\n");

/** Remote shell fake: cloud-init is finished, and the server has no runner. */
export function readyRemote(host: string): RemoteExec {
  return {
    host,
    run: async (command) => ({
      exitCode: 0,
      stdout: command.includes("# opscrew-host: runners.inspect") ? NO_RUNNERS : "ready\n",
      stderr: "",
    }),
  };
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
  await recordTestServer(root, plan);
  return { root, bare, git };
}
