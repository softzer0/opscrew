import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
  webFilterFileHashes,
} from "@opscrew/connector-ssh-host";
import type {
  CommandResult,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  RemoteExec,
  ResourceChange,
} from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import type { ZeroTrustApi } from "../zero-trust";
import { ScriptedRunner } from "../../testing";
import type { HostAdapterApi } from "../../shared";
import { fakeCloudflare } from "./fakes";

/** The user's own server: a documentation address (RFC 5737), public. */
export const OWN_IPV4 = "203.0.113.20";
/** A home server's LAN address (not public). */
export const LAN_IPV4 = "192.168.1.20";
export const TUNNEL_ID = "6f1f3a2e-7b1c-4d2e-9f00-112233445566";
export const ACCOUNT_ID = "acct-0001";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** An SSH public key blob (wire format) of `type`, deterministic from `seed`. Not a secret. */
export function hostKeyBlob(type = "ssh-ed25519", seed = "own-server"): string {
  const name = Buffer.from(type);
  const key = createHash("sha256").update(seed).digest();
  const length = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n);
    return out;
  };
  return Buffer.concat([length(name.length), name, length(key.length), key]).toString("base64");
}

/** The fingerprint OpenSSH prints for a key blob. */
export function fingerprintOf(blob: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

export const ED25519 = hostKeyBlob("ssh-ed25519", "own-server");
export const RSA = hostKeyBlob("ssh-rsa", "own-server-rsa");
export const ED25519_FINGERPRINT = fingerprintOf(ED25519);

export interface OwnPlanOptions {
  access?: "public" | "tunnel";
  arch?: "amd64" | "arm64";
  /** Default `shop.example.com` on Cloudflare (proxied); `null` for no domain. */
  domain?: string | null;
  postgres?: boolean;
  /** Portainer on `portainer.example.com` behind Cloudflare Access (a tunnel in either mode). */
  portainerSubdomain?: boolean;
}

/** A valid own-server `opscrew/plan.yaml` for the `shop` app. */
export function ownPlan(o: OwnPlanOptions = {}): DeployPlan {
  const domain = o.domain === undefined ? "shop.example.com" : o.domain;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z",
    app: {
      name: "shop",
      port: 3000,
      healthPath: "/api/health",
      env: [
        { name: "DATABASE_URL", secret: true, source: "derived" },
        { name: "SESSION_SECRET", secret: true, source: "generated" },
      ],
    },
    target: {
      provider: "own",
      mode: "vps-compose",
      arch: o.arch ?? "amd64",
      access: o.access ?? "public",
    },
    services: { postgres: o.postgres ?? true, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [
        { item: "Your own server (you already pay for it)", monthly: { amount: 0, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-10-14T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: domain
      ? {
          provider: "cloudflare",
          domain,
          proxied: true,
          www: false,
          ...(o.portainerSubdomain ? { zone: "example.com" } : {}),
        }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    ...(o.portainerSubdomain
      ? {
          portainer: {
            enabled: true,
            version: "2.33.1",
            access: "subdomain",
            hostname: "portainer.example.com",
            allowedEmails: ["owner@example.com"],
          },
        }
      : {}),
  });
}

const ADDON = {
  installed: false,
  composeSha256: null,
  running: false,
  secretFile: false,
  dataVolume: false,
  tunnelId: null,
};

export interface FactsOptions {
  user?: string;
  privilege?: HostFacts["privilege"];
  arch?: string;
  sshPorts?: number[];
  addresses?: HostFacts["addresses"];
  /** Extra listeners (for example a web server on port 80). */
  listeners?: HostFacts["listeners"];
  loginUsers?: HostFacts["loginUsers"];
}

/** A fresh Ubuntu 24.04 server as `inspectHost` reports it: nothing of OpsCrew's is there yet. */
export function freshFacts(o: FactsOptions = {}): HostFacts {
  const sshPorts = o.sshPorts ?? [22];
  const user = o.user ?? "root";
  return HostFactsSchema.parse({
    user,
    privilege: o.privilege ?? (user === "root" ? "root" : "sudo"),
    os: {
      id: "ubuntu",
      idLike: "debian",
      versionId: "24.04",
      codename: "noble",
      prettyName: "Ubuntu 24.04.3 LTS",
    },
    arch: o.arch ?? "amd64",
    machine: o.arch === "arm64" ? "aarch64" : "x86_64",
    cpus: 2,
    memoryBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 3 * 1024 ** 3,
    diskFreeBytes: 40 * 1024 ** 3,
    diskTotalBytes: 80 * 1024 ** 3,
    systemd: true,
    flock: true,
    addresses: o.addresses ?? [
      { interface: "eth0", family: "ipv4", address: OWN_IPV4, public: true },
    ],
    sshd: {
      ports: sshPorts,
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
    listeners: [
      ...sshPorts.map((port) => ({ proto: "tcp", address: "0.0.0.0", port, process: "sshd" })),
      ...(o.listeners ?? []),
    ],
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
    loginUsers: o.loginUsers ?? [{ name: user, uid: user === "root" ? 0 : 1000, password: false, keys: true }],
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
  });
}

type Params = Readonly<Record<string, string | number | boolean>>;

function paramsOf(plan: HostPlan, id: string): Params | undefined {
  return plan.steps.find((step) => step.id === id)?.params;
}

/**
 * The facts of the server after `plan` was applied to it, so the next inspection plans no
 * changes (what OpsCrew's host adapter leaves behind, as far as planning can tell).
 */
/** What inspection reports for a server with OpsCrew's web filter for these (sorted) ranges. */
export function filteredFacts(ipv4: string[]): HostFacts["webFilter"] {
  const hashes = webFilterFileHashes({ ipv4 });
  return {
    backend: "iptables",
    commands: ["iptables", "iptables-restore"],
    files: { script: hashes.script, unit: hashes.unit, dropIn: hashes.dropIn },
    enabled: true,
    active: true,
    rules4: {
      chain: { sources: ipv4, dropsRest: true, other: 0 },
      dockerUser: { exists: true, leading: ["tcp/80", "tcp/443", "udp/443"], jumps: 3 },
    },
  };
}

export function preparedFacts(before: HostFacts, plan: HostPlan): HostFacts {
  const marker = paramsOf(plan, "app-marker") as Params;
  const app = String(marker.app);
  const projectId = String(marker.projectId);
  const deploy = paramsOf(plan, "deploy-user") as Params;
  const sshd = paramsOf(plan, "sshd") as Params;
  const ufw = paramsOf(plan, "ufw") as Params;
  const tunnel = paramsOf(plan, "tunnel-connector");
  const ports = String(ufw.sshPorts).split(" ").map(Number);
  const web = ufw.web === true;
  const dropIn = [
    "# Managed by OpsCrew. `opscrew destroy --undo-host` puts the previous setting back.",
    `PermitRootLogin ${String(sshd.permitRootLogin)}`,
    ...(sshd.disablePasswords === true ? ["PasswordAuthentication no"] : []),
    ...(sshd.kbdInteractiveOff === true ? ["KbdInteractiveAuthentication no"] : []),
    "",
  ].join("\n");
  const jail = [
    "# Managed by OpsCrew: brute-force protection for SSH.",
    "[sshd]",
    "enabled = true",
    `port = ${ports.join(",")}`,
    "backend = systemd",
    "maxretry = 5",
    "bantime = 1h",
    "",
  ].join("\n");
  const entry = (step: string, previous: Record<string, string | boolean>) => ({
    step,
    purpose: "setup",
    at: "2026-10-14T12:00:00.000Z",
    previous,
  });
  const tunnelOn = tunnel !== undefined && tunnel.remove !== true;
  // The web filter as the real adapter leaves it (or none when the plan removes it).
  const filter = paramsOf(plan, "web-filter");
  const webFilter =
    filter === undefined
      ? before.webFilter
      : filter.remove === true
        ? undefined
        : filteredFacts(String(filter.ipv4).split(" "));
  return HostFactsSchema.parse({
    ...before,
    webFilter,
    sshd: {
      ...before.sshd,
      permitRootLogin: sshd.permitRootLogin,
      passwordAuthentication: sshd.disablePasswords === true ? false : before.sshd?.passwordAuthentication,
      kbdInteractiveAuthentication: false,
      dropIn,
    },
    firewall: {
      ...before.firewall,
      ufw: "active",
      ufwRules: [
        ...ports.map((port) => ({ rule: `allow ${port}/tcp`, comment: "opscrew-ssh" })),
        ...(web
          ? ["80/tcp", "443/tcp", "443/udp"].map((rule) => ({
              rule: `allow ${rule}`,
              comment: "opscrew-web",
            }))
          : []),
      ],
    },
    docker: {
      ...before.docker,
      kind: "docker-repo",
      version: "28.5.1",
      running: true,
      composePlugin: true,
      buildxPlugin: true,
    },
    deployUser: { groups: ["deploy", "docker"], keys: [String(deploy.publicKey)] },
    packages: { ...before.packages, fail2ban: true },
    autoUpgrades: true,
    autoUpgradesService: true,
    dockerDaemonJson: "opscrew",
    fail2ban: { active: true, jail, sshdJail: true },
    ready: true,
    dirs: ["/srv/app", "/srv/data"].map((path) => ({
      path,
      kind: "dir",
      owner: "deploy",
      group: "deploy",
      mode: "750",
      entries: 0,
    })),
    marker: { app, projectId },
    record: {
      schemaVersion: 1,
      app,
      projectId,
      opscrewVersion: "0.0.0-test",
      changes: [
        entry("deploy-user", { existed: false }),
        entry("runtime-dirs", { app: "absent", data: "absent" }),
      ],
    },
    tunnel: tunnelOn
      ? {
          installed: true,
          composeSha256: sha256(String(tunnel.compose)),
          running: true,
          secretFile: true,
          dataVolume: false,
          tunnelId: String(tunnel.tunnelId),
        }
      : ADDON,
  });
}

/** One host apply the fake adapter received. */
export interface FakeApply {
  plan: HostPlan;
  options: ApplyOptions;
  /** What `verifyLogin` answered when the SSH or firewall step ran. */
  verified?: boolean;
}

/**
 * The host adapter over a fake server: `inspect` reports its facts; `apply` refuses a plan whose
 * hash is not the approved one (as the real adapter does), calls `verifyLogin` around the SSH and
 * firewall steps, and leaves the server prepared.
 */
export class FakeHostServer implements HostAdapterApi {
  readonly applies: FakeApply[] = [];
  inspections = 0;
  /** Thrown by the next `apply` (after its hash check), as a failing step would. */
  fail: Error | undefined;
  constructor(public facts: HostFacts = freshFacts()) {}

  async inspect(_remote: RemoteExec): Promise<HostFacts> {
    this.inspections++;
    return this.facts;
  }

  async apply(_remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    const record: FakeApply = { plan, options };
    this.applies.push(record);
    if (this.fail !== undefined) {
      const error = this.fail;
      this.fail = undefined;
      throw error;
    }
    const changes = plan.steps.filter((step) => step.state === "change");
    if (changes.some((step) => step.id === "sshd" || step.id === "ufw")) {
      record.verified = await options.verifyLogin();
    }
    this.facts = preparedFacts(this.facts, plan);
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
    };
  }
}

/** A remote shell that must never be used directly (the fake adapter does the work). */
export function unusedRemote(host: string): RemoteExec {
  return {
    host,
    run: async () => {
      throw new Error("the fake host adapter should have handled this");
    },
  };
}

/** One `plan` call of the {@link OwnEngine}. */
export interface OwnEnginePlan {
  planFile: string;
  destroy: boolean;
  env: Record<string, string | undefined>;
}

/**
 * IaC engine fake for own-server plans: the state's outputs change on apply (to `nextOutputs`, or
 * nothing after a removal plan), plans report `changes` (or, for a removal, one delete per
 * resource), and it writes a non-empty state file once something was applied, like a real engine.
 */
export class OwnEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly calls: string[] = [];
  readonly plans: OwnEnginePlan[] = [];
  readonly applies: { planFile: string; approval: IacApproval; destroy: boolean }[] = [];
  /** Env of every init, plan, apply and output call. */
  readonly envs: Record<string, string | undefined>[] = [];
  statePath: string | undefined;
  #counter = 0;
  readonly #destroyFiles = new Set<string>();

  constructor(
    public changes: ResourceChange[],
    public nextOutputs: Record<string, unknown>,
    public state: Record<string, unknown> = {},
  ) {}

  async init(_dir: string, options?: IacInitOptions): Promise<void> {
    this.calls.push("init");
    if (options?.env) this.envs.push(options.env);
    if (options?.backendConfig?.path) this.statePath = String(options.backendConfig.path);
  }

  async validate() {
    this.calls.push("validate");
    return { valid: true, diagnostics: [] };
  }

  async plan(
    dir: string,
    planFile: string,
    options?: IacRunOptions & { destroy?: boolean },
  ): Promise<PlanSummary> {
    const destroy = options?.destroy === true;
    this.calls.push(destroy ? "plan-destroy" : "plan");
    this.plans.push({ planFile, destroy, env: { ...(options?.env ?? {}) } });
    const content = `fake own plan ${++this.#counter} ${destroy ? "destroy" : "apply"} for ${dir}`;
    await writeFile(planFile, content);
    if (destroy) this.#destroyFiles.add(planFile);
    const changes = destroy
      ? Object.keys(this.state).length > 0
        ? [
            {
              address: "module.dns.cloudflare_dns_record.a",
              type: "cloudflare_dns_record",
              name: "a",
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              action: "delete" as const,
            },
          ]
        : []
      : this.changes;
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256(content),
      createdAt: "2026-10-14T12:00:00.000Z",
      changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: changes.some((c) => c.action === "delete" || c.action === "replace"),
      planJson: { format_version: "1.2", planned_values: { root_module: {} } },
    };
  }

  async apply(
    _dir: string,
    planFile: string,
    approval: IacApproval,
    options?: IacRunOptions,
  ): Promise<IacApplyResult> {
    this.calls.push("apply");
    if (options?.env) this.envs.push(options.env);
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    const destroy = this.#destroyFiles.has(planFile);
    this.applies.push({ planFile, approval, destroy });
    this.state = destroy ? {} : { ...this.nextOutputs };
    if (this.statePath !== undefined) {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify({ fake: true }));
    }
    return { ok: true, outputs: this.state, log: "Apply complete!" };
  }

  async output(_dir: string, options?: IacRunOptions): Promise<Record<string, unknown>> {
    this.calls.push("output");
    if (options?.env) this.envs.push(options.env);
    return this.state;
  }
}

/** The DNS records an own public-mode plan creates. */
export const PUBLIC_CHANGES: ResourceChange[] = [
  {
    address: "module.dns.cloudflare_dns_record.a",
    type: "cloudflare_dns_record",
    name: "a",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "create",
  },
];

/** The tunnel, its record and Access an own tunnel-mode plan creates. */
export const TUNNEL_CHANGES: ResourceChange[] = [
  ["module.tunnel", "cloudflare_zero_trust_tunnel_cloudflared", "this"],
  ["module.tunnel", "cloudflare_zero_trust_tunnel_cloudflared_config", "this"],
  ["module.access", "cloudflare_zero_trust_access_application", "ssh"],
].map(([module, type, name]) => ({
  address: `${module}.${type}.${name}`,
  type: type as string,
  name: name as string,
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action: "create" as const,
}));

/** Outputs of an applied public-mode configuration. */
export function publicOutputs(): Record<string, unknown> {
  return {
    server_ipv4: OWN_IPV4,
    server_ipv6: null,
    url: "https://shop.example.com",
    servers: { own: { ipv4: OWN_IPV4, ipv6: null } },
  };
}

/** Outputs of an applied tunnel-mode configuration, with its (synthetic) secrets. */
export function tunnelOutputs(secrets: {
  token: string;
  clientId: string;
  clientSecret: string;
}): Record<string, unknown> {
  return {
    url: "https://shop.example.com",
    tunnel_id: TUNNEL_ID,
    tunnel_token: secrets.token,
    ssh_hostname: "ssh-shop.example.com",
    deploy_service_token_client_id: secrets.clientId,
    deploy_service_token_client_secret: secrets.clientSecret,
  };
}

/** A Cloudflare fake whose zone names its account (tunnels and Access belong to it). */
export function ownCloudflare() {
  const base = fakeCloudflare();
  return {
    ...base,
    findZone: async () => ({
      id: "zone-123",
      name: "example.com",
      status: "active",
      nameServers: [],
      accountId: ACCOUNT_ID,
    }),
  };
}

/**
 * Zero Trust fake: the account's organization (none by default), its one-time PIN login method
 * (none by default) and the accounts whose organization was asked for.
 */
export function fakeZeroTrust(
  authDomain?: string,
  pin?: string,
): ZeroTrustApi & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    accessOrganization: async (accountId) => {
      asked.push(accountId);
      return authDomain === undefined ? undefined : { authDomain };
    },
    accessIdentityProviders: async () => (pin === undefined ? [] : [{ id: pin, type: "onetimepin" }]),
  };
}

/**
 * Real git for the project; `ssh-keyscan` answers with the given host keys (named like the real
 * tool: `[host]:port` on other ports than 22); `ssh` succeeds unless `ssh` answers otherwise.
 */
export function ownRunner(
  keys: readonly { type: string; key: string }[] = [{ type: "ssh-ed25519", key: ED25519 }],
  ssh: (args: readonly string[]) => CommandResult | undefined = () => undefined,
): ScriptedRunner {
  const real = new NodeCommandRunner();
  return new ScriptedRunner(async (command, args, options) => {
    if (command === "ssh-keyscan") {
      const host = args[args.length - 1] as string;
      const port = Number(args[args.indexOf("-p") + 1] ?? 22);
      const name = port === 22 ? host : `[${host}]:${port}`;
      return {
        exitCode: 0,
        stdout: `# ${host}:${port} SSH-2.0-OpenSSH_9.6\n${keys.map((k) => `${name} ${k.type} ${k.key}`).join("\n")}\n`,
        stderr: "",
      };
    }
    if (command === "ssh") return ssh(args) ?? { exitCode: 0, stdout: "", stderr: "" };
    return real.run(command, args, options);
  });
}

/** Writes a placeholder private key file (never a real key) at `~/.ssh/<name>` under `home`. */
export async function placeholderKey(home: string, name = "id_ed25519"): Promise<string> {
  const file = join(home, ".ssh", name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "placeholder for a key file path; OpsCrew never reads it\n", { mode: 0o600 });
  return file;
}
