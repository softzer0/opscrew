/**
 * Fakes for `opscrew retarget`: a provisioned Hetzner project (plan, state, keys, known_hosts),
 * an IaC engine that keeps a state of server modules and reads the rendered root module, the two
 * servers' shells, GitHub with the deploy workflow, Cloudflare and the outside network. Adapted
 * from the `@opscrew/agents` move fixtures. Tests only.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureDeployKey,
  ensureStatePassphrase,
  type RetargetGitHubApi,
  type RetargetServices,
} from "@opscrew/agents";
import { StaticDigitalOceanCatalog } from "@opscrew/connector-digitalocean";
import { StaticHetznerCatalog } from "@opscrew/connector-hetzner";
import type {
  AppServer,
  CommandOptions,
  CommandResult,
  CommandRunner,
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  RemoteExec,
  ResourceChange,
  ResourceMove,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type CloudProvider,
  type DeployPlan,
  DeployPlanSchema,
  writeArtifact,
} from "@opscrew/plan-schema";
import { type CliServices, withServices } from "../../deps";
import {
  type DeployProject,
  deployProject,
  FakeGitHub,
  fakeCloudflare,
  HOST_KEY,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
} from "./deploy";
import { projectContext } from "./harness";

export const DOMAIN = "shop.example.com";
export const APP = "shop";
export { SERVER_IPV4 as OLD_IPV4 };

/** What the fake engine creates for a new server, per provider. */
export const NEW_SERVERS: Record<CloudProvider, { id: string; ipv4: string; ipv6: string }> = {
  hetzner: { id: "4712", ipv4: "198.51.100.20", ipv6: "2001:db8:20::1" },
  digitalocean: { id: "3164445", ipv4: "198.51.100.30", ipv6: "2001:db8:30::1" },
};

/** Everything the fakes saw, in order. */
export type MoveEvent =
  | { type: "init"; modules: string }
  | { type: "plan"; hash: string }
  | {
      type: "apply";
      hash: string;
      deletes: string[];
      creates: string[];
      updates: string[];
      moves: number;
    }
  | { type: "remote"; host: string; op: string }
  | { type: "scp"; from: string; to: string }
  | { type: "secret"; name: string }
  | { type: "dispatch"; ref: string }
  | { type: "snapshot"; serverId: string }
  | { type: "fetch"; url: string };

type ModuleName = "server" | "server_previous";

interface FakeServer {
  id: string;
  provider: CloudProvider;
  ipv4: string;
  ipv6: string;
  protected: boolean;
}

const MODULE_PROVIDER: Record<string, CloudProvider> = {
  "hetzner-vps": "hetzner",
  "digitalocean-droplet": "digitalocean",
};

const RESOURCES: Record<CloudProvider, readonly (readonly [string, string])[]> = {
  hetzner: [
    ["hcloud_ssh_key", "deploy"],
    ["hcloud_firewall", "this"],
    ["hcloud_server", "this"],
  ],
  digitalocean: [
    ["digitalocean_tag", "app"],
    ["digitalocean_ssh_key", "deploy"],
    ["digitalocean_firewall", "this"],
    ["digitalocean_droplet", "this"],
  ],
};
const SERVER_TYPE: Record<CloudProvider, string> = {
  hetzner: "hcloud_server",
  digitalocean: "digitalocean_droplet",
};
const REGISTRY: Record<CloudProvider, string> = {
  hetzner: "registry.opentofu.org/hetznercloud/hcloud",
  digitalocean: "registry.opentofu.org/digitalocean/digitalocean",
};

interface FakeConfig {
  modules: Map<ModuleName, CloudProvider>;
  moved?: [ModuleName, ModuleName];
  dns?: ModuleName;
  live?: ModuleName;
  variables: Set<string>;
}

/** Reads the rendered root module the way an engine would see it (modules, moved, DNS, outputs). */
async function readConfig(dir: string): Promise<FakeConfig> {
  const main = await readFile(path.join(dir, "main.tf"), "utf8");
  const outputs = await readFile(path.join(dir, "outputs.tf"), "utf8");
  const variables = await readFile(path.join(dir, "variables.tf"), "utf8");
  const modules = new Map<ModuleName, CloudProvider>();
  for (const m of main.matchAll(
    /module "(server|server_previous)" \{\s*source\s*=\s*"\.\.\/modules\/([a-z-]+)"/g,
  )) {
    const provider = MODULE_PROVIDER[m[2] as string];
    if (provider === undefined) throw new Error(`unknown module source ${m[2]}`);
    modules.set(m[1] as ModuleName, provider);
  }
  const moved = /moved \{\s*from\s*=\s*module\.(\w+)\s*to\s*=\s*module\.(\w+)/.exec(main);
  const dns = /module "dns" \{[\s\S]*?ipv4\s*=\s*module\.(\w+)\.ipv4_address/.exec(main);
  const live = /output "server_ipv4" \{\s*value\s*=\s*module\.(\w+)\./.exec(outputs);
  return {
    modules,
    ...(moved ? { moved: [moved[1] as ModuleName, moved[2] as ModuleName] } : {}),
    ...(dns ? { dns: dns[1] as ModuleName } : {}),
    ...(live ? { live: live[1] as ModuleName } : {}),
    variables: new Set([...variables.matchAll(/variable "(\w+)"/g)].map((v) => v[1] as string)),
  };
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** What applying a plan does to the fake state. */
interface Effect {
  serial: number;
  moves: [ModuleName, ModuleName][];
  creates: [ModuleName, CloudProvider][];
  destroys: ModuleName[];
  unprotects: ModuleName[];
  dnsTo?: string;
  changes: ResourceChange[];
  moved: ResourceMove[];
  planJson: unknown;
}

function change(
  module: ModuleName,
  provider: CloudProvider,
  [type, name]: readonly [string, string],
  action: ResourceChange["action"],
): ResourceChange {
  return {
    address: `module.${module}.${type}.${name}`,
    type,
    name,
    provider: REGISTRY[provider],
    action,
  };
}

/**
 * IaC engine fake that keeps a state of server modules and reads the rendered root module: a
 * `moved` block renames a module, a module missing from the state is created, a module missing
 * from the configuration is deleted, `*delete_protection=false` turns a Hetzner server's
 * protection off, and the DNS module follows the configured server. Applies enforce the hash,
 * `allowDestroy`, delete protection and stale plans like the real engines.
 */
export class FakeMoveEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly state: { servers: Partial<Record<ModuleName, FakeServer>>; dns?: string; serial: number };
  /** Hashes of the applied plans, in order. */
  readonly applied: string[] = [];
  #installed = new Set<string>();
  #effects = new Map<string, Effect>();
  #counter = 0;

  constructor(
    readonly events: MoveEvent[],
    options: { from: CloudProvider; dns: boolean },
  ) {
    const old: FakeServer = {
      id: options.from === "hetzner" ? "4711" : "3164444",
      provider: options.from,
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
      protected: options.from === "hetzner",
    };
    this.state = { servers: { server: old }, ...(options.dns ? { dns: old.id } : {}), serial: 0 };
  }

  /** The server whose id DNS points at. */
  dnsServer(): FakeServer | undefined {
    return Object.values(this.state.servers).find((s) => s?.id === this.state.dns);
  }

  async init(dir: string, _options?: IacInitOptions): Promise<void> {
    const config = await readConfig(dir);
    this.#installed = new Set([...config.modules].map(([m, p]) => `${m}:${p}`));
    this.events.push({ type: "init", modules: [...this.#installed].sort().join(",") });
  }

  async validate() {
    return { valid: true, diagnostics: [] };
  }

  #compute(config: FakeConfig, vars: Record<string, string>): Effect {
    for (const [m, p] of config.modules) {
      if (!this.#installed.has(`${m}:${p}`)) {
        throw new Error(`Module not installed: module.${m} (run init)`);
      }
    }
    for (const name of Object.keys(vars)) {
      if (!config.variables.has(name)) throw new Error(`Value for undeclared variable ${name}`);
    }
    const servers: Partial<Record<ModuleName, FakeServer>> = { ...this.state.servers };
    const effect: Effect = {
      serial: this.state.serial,
      moves: [],
      creates: [],
      destroys: [],
      unprotects: [],
      changes: [],
      moved: [],
      planJson: undefined,
    };
    const details: Record<string, unknown>[] = [];
    if (config.moved) {
      const [from, to] = config.moved;
      const server = servers[from];
      if (server && !servers[to] && config.modules.has(to)) {
        servers[to] = server;
        delete servers[from];
        effect.moves.push([from, to]);
        for (const [type, name] of RESOURCES[server.provider]) {
          effect.moved.push({
            from: `module.${from}.${type}.${name}`,
            to: `module.${to}.${type}.${name}`,
            type,
          });
        }
      }
    }
    for (const [m, provider] of config.modules) {
      const server = servers[m];
      if (!server) {
        effect.creates.push([m, provider]);
        for (const resource of RESOURCES[provider]) {
          const c = change(m, provider, resource, "create");
          effect.changes.push(c);
          details.push({
            address: c.address,
            type: c.type,
            change: { actions: ["create"], before: null, after: {}, after_unknown: { id: true } },
          });
        }
        continue;
      }
      const variable = m === "server" ? "delete_protection" : "previous_delete_protection";
      if (provider === "hetzner" && vars[variable] === "false" && server.protected) {
        effect.unprotects.push(m);
        const c = change(m, provider, ["hcloud_server", "this"], "update");
        effect.changes.push(c);
        const before = {
          id: server.id,
          name: APP,
          backups: true,
          delete_protection: true,
          rebuild_protection: true,
        };
        details.push({
          address: c.address,
          type: c.type,
          change: {
            actions: ["update"],
            before,
            after: { ...before, delete_protection: false, rebuild_protection: false },
            after_unknown: {},
          },
        });
      }
    }
    for (const [m, server] of Object.entries(servers) as [ModuleName, FakeServer][]) {
      if (config.modules.has(m)) continue;
      effect.destroys.push(m);
      for (const resource of RESOURCES[server.provider]) {
        const c = change(m, server.provider, resource, "delete");
        effect.changes.push(c);
        const id =
          resource[0] === SERVER_TYPE[server.provider] ? server.id : `${resource[1]}-${server.id}`;
        details.push({
          address: c.address,
          type: c.type,
          change: { actions: ["delete"], before: { id, name: APP }, after: null },
        });
      }
    }
    if (config.dns !== undefined && this.state.dns !== undefined) {
      const target = servers[config.dns]?.id;
      if (target !== undefined && target !== this.state.dns) {
        effect.dnsTo = target;
        for (const name of ["a", "aaaa"]) {
          const c: ResourceChange = {
            address: `module.dns.cloudflare_dns_record.${name}`,
            type: "cloudflare_dns_record",
            name,
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            action: "update",
          };
          effect.changes.push(c);
          details.push({
            address: c.address,
            type: c.type,
            change: { actions: ["update"], before: { name: DOMAIN }, after: { name: DOMAIN } },
          });
        }
      }
    }
    effect.planJson = { format_version: "1.2", resource_changes: details };
    return effect;
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    if (options.destroy) throw new Error("a move never plans a whole-root destroy");
    const config = await readConfig(dir);
    const effect = this.#compute(config, options.vars ?? {});
    const content = `fake plan ${++this.#counter} for ${dir}`;
    await writeFile(planFile, content);
    const planHash = sha256(content);
    this.#effects.set(planHash, effect);
    this.events.push({ type: "plan", hash: planHash });
    const count = (action: string) => effect.changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash,
      createdAt: "2026-10-13T12:00:00.000Z",
      changes: effect.changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: effect.destroys.length > 0,
      planJson: effect.planJson,
      ...(effect.moved.length > 0 ? { moves: effect.moved } : {}),
    };
  }

  async apply(dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    const hash = sha256(await readFile(planFile));
    if (hash !== approval.approvedPlanHash) throw new Error("plan hash mismatch");
    const effect = this.#effects.get(hash);
    if (!effect) throw new Error("unknown plan");
    if (effect.destroys.length > 0 && approval.allowDestroy !== true) {
      throw new Error("the plan deletes resources but the approval does not allow it");
    }
    this.applied.push(hash);
    this.events.push({
      type: "apply",
      hash,
      deletes: effect.changes.filter((c) => c.action === "delete").map((c) => c.address),
      creates: effect.changes.filter((c) => c.action === "create").map((c) => c.address),
      updates: effect.changes.filter((c) => c.action === "update").map((c) => c.address),
      moves: effect.moved.length,
    });
    if (effect.serial !== this.state.serial) {
      return { ok: false, outputs: {}, log: "Error: Saved plan is stale" };
    }
    for (const m of effect.destroys) {
      if (this.state.servers[m]?.protected) {
        return { ok: false, outputs: {}, log: `Error: server deletion is protected (module.${m})` };
      }
    }
    for (const [from, to] of effect.moves) {
      this.state.servers[to] = this.state.servers[from];
      delete this.state.servers[from];
    }
    for (const m of effect.unprotects) {
      const server = this.state.servers[m];
      if (server) server.protected = false;
    }
    for (const m of effect.destroys) delete this.state.servers[m];
    for (const [m, provider] of effect.creates) {
      const created = NEW_SERVERS[provider];
      this.state.servers[m] = { ...created, provider, protected: provider === "hetzner" };
    }
    if (effect.dnsTo !== undefined) this.state.dns = effect.dnsTo;
    this.state.serial++;
    return { ok: true, outputs: await this.output(dir), log: "Apply complete!" };
  }

  async output(dir: string): Promise<Record<string, unknown>> {
    const config = await readConfig(dir);
    const live = config.live ? this.state.servers[config.live] : undefined;
    // `servers`: every server module's server, keyed by its provider.
    const servers: Record<string, { ipv4: string; ipv6: string; id: string }> = {};
    for (const [m, provider] of config.modules) {
      const server = this.state.servers[m];
      if (server) servers[provider] = { ipv4: server.ipv4, ipv6: server.ipv6, id: server.id };
    }
    return {
      ...(live
        ? {
            server_ipv4: live.ipv4,
            server_ipv6: live.ipv6,
            server_id: live.id,
            server_name: APP,
            url: config.dns ? `https://${DOMAIN}` : `http://${live.ipv4}`,
          }
        : {}),
      servers,
    };
  }
}

export interface FakeHost {
  app: boolean;
  caddy: boolean;
  /** What the database holds (a marker, never real data). */
  db: string;
  dump?: string;
}

/** The plain operation a server command performs, for the event trail. */
function opOf(command: string): string {
  if (command.includes("opscrew-ready")) return "ready?";
  if (command.endsWith("docker compose stop app")) return "stop app";
  if (command.endsWith("docker compose up -d app")) return "start app";
  if (command.endsWith("docker compose stop caddy")) return "stop caddy";
  if (command.endsWith("docker compose up -d caddy")) return "start caddy";
  if (command.includes("--entrypoint wget caddy")) return "health";
  if (command.includes("pg_database_size")) return "db size";
  if (command.includes("pg_dump")) return "dump";
  if (command.includes("pg_restore --list")) return "verify dump";
  if (command.includes("pg_restore")) return "restore";
  if (command.includes("DROP DATABASE")) return "empty db";
  if (command.endsWith("config --services")) return "services?";
  if (command.startsWith("rm -f /srv/app/opscrew-move.dump")) return "rm dump";
  return command;
}

/** The two servers' shells: Compose services, the database marker and the dump file. */
export class FakeHosts {
  readonly hosts = new Map<string, FakeHost>();
  dbSize = 52_428_800;

  constructor(readonly events: MoveEvent[]) {}

  host(ip: string): FakeHost {
    let host = this.hosts.get(ip);
    if (!host) {
      host = { app: false, caddy: false, db: "empty" };
      this.hosts.set(ip, host);
    }
    return host;
  }

  readonly remote = (ip: string): RemoteExec => ({
    host: ip,
    run: (command) => this.run(ip, command),
  });

  async run(ip: string, command: string): Promise<CommandResult> {
    const op = opOf(command);
    this.events.push({ type: "remote", host: ip, op });
    const h = this.host(ip);
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    switch (op) {
      case "ready?":
        return ok("ready\n");
      case "stop app":
        h.app = false;
        return ok();
      case "start app":
        h.app = true;
        return ok();
      case "stop caddy":
        h.caddy = false;
        return ok();
      case "start caddy":
        h.caddy = true;
        return ok();
      case "health":
        return h.app ? ok() : { exitCode: 1, stdout: "", stderr: "wget: can't connect" };
      case "db size":
        return ok(`${this.dbSize}\n`);
      case "dump":
        h.dump = h.db;
        return ok();
      case "restore":
        if (h.app) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: 'pg_restore: error: database "app" is being accessed by other users',
          };
        }
        if (h.dump === undefined) return { exitCode: 1, stdout: "", stderr: "No such file" };
        h.db = h.dump;
        return ok();
      case "verify dump":
        if (h.dump === undefined) return { exitCode: 1, stdout: "", stderr: "No such file" };
        return ok(
          `${createHash("sha256").update(h.dump).digest("hex")}  /srv/app/opscrew-move.dump\n`,
        );
      case "empty db":
        h.db = "empty";
        return ok();
      case "services?":
        return ok("app\ndb\ncaddy\n");
      case "rm dump":
        h.dump = undefined;
        return ok();
      default:
        return ok();
    }
  }

  /** `scp -3 … deploy@A:/path deploy@B:/path`: copies the dump marker. */
  scp(args: readonly string[]): CommandResult {
    const at = (arg: string) => /^deploy@\[?([^\]]+?)\]?:/.exec(arg)?.[1] ?? "";
    const from = at(args[args.length - 2] ?? "");
    const to = at(args[args.length - 1] ?? "");
    this.events.push({ type: "scp", from, to });
    const source = this.host(from);
    if (source.dump === undefined) return { exitCode: 1, stdout: "", stderr: "scp: No such file" };
    this.host(to).dump = source.dump;
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  /** What the deploy workflow does on `ip`: the app and Caddy run, with an empty database. */
  deploy(ip: string): void {
    const h = this.host(ip);
    h.app = true;
    h.caddy = true;
  }
}

/** GitHub fake with the deploy workflow: a successful run deploys to `OPSCREW_HOST`. */
export class FakeMoveGitHub extends FakeGitHub implements RetargetGitHubApi {
  conclusion: string | null = "success";

  constructor(
    readonly events: MoveEvent[],
    readonly hostsFake: FakeHosts,
  ) {
    super();
  }

  override async setActionsSecret(owner: string, repo: string, name: string, value: string) {
    await super.setActionsSecret(owner, repo, name, value);
    this.events.push({ type: "secret", name });
  }

  async dispatchWorkflow(_owner: string, _repo: string, _workflowFile: string, ref: string) {
    this.events.push({ type: "dispatch", ref });
    return { runId: 99 };
  }

  async waitForWorkflowRun(_owner: string, _repo: string, options: { runId?: number }) {
    const host = this.secrets.get("OPSCREW_HOST");
    if (this.conclusion === "success" && host !== undefined) this.hostsFake.deploy(host);
    return {
      id: options.runId ?? 99,
      conclusion: this.conclusion,
      htmlUrl: "https://github.com/acme/shop/actions/runs/99",
    };
  }
}

/** Real git; `ssh-keyscan` answers with {@link HOST_KEY}; `scp` copies between the fake hosts. */
export class MoveRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });

  constructor(private readonly hosts: FakeHosts) {}

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const name = path.basename(command).replace(/\.exe$/i, "");
    if (name === "git") return this.#node.run(command, args, options);
    if (name === "ssh-keyscan") {
      return { exitCode: 0, stdout: `${args[args.length - 1]} ${HOST_KEY}\n`, stderr: "" };
    }
    if (name === "scp") return this.hosts.scp(args);
    return { exitCode: 127, stdout: "", stderr: "not found" };
  }
}

/** Provider tokens of a move (synthetic, generated at runtime). */
export const MOVE_TOKENS = {
  hetzner: fakeSecret("hcloud-token", "move"),
  digitalocean: fakeSecret("digitalocean-token", "move"),
  cloudflare: fakeSecret("cloudflare-token", "move"),
};

/** A live Hetzner deployment of `shop` (Cloudflare DNS, self-hosted Postgres) and its fakes. */
export async function moveProject() {
  const base = testPlan({ domain: DOMAIN, deployed: true });
  const plan: DeployPlan = DeployPlanSchema.parse({
    ...base,
    deployment: { ...base.deployment, url: `https://${DOMAIN}`, lastCompletedPhase: "provision" },
  });
  const project: DeployProject = await deployProject(plan);
  const env: Record<string, string | undefined> = {
    ...project.env,
    HCLOUD_TOKEN: MOVE_TOKENS.hetzner,
    DIGITALOCEAN_TOKEN: MOVE_TOKENS.digitalocean,
    CLOUDFLARE_API_TOKEN: MOVE_TOKENS.cloudflare,
  };
  const paths = resolveProjectPaths(project.root, { env });
  await writeArtifact("architecture", paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-11T09:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: {
      name: APP,
      languages: ["typescript"],
      packageManager: "npm",
      frameworks: [],
      appKind: "api",
      port: 3000,
      platformExport: { platform: "none", evidence: [] },
      build: {},
      runtimeVersions: {},
      envVars: [],
      services: [],
      docker: {},
      monorepo: false,
      git: {},
    },
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact("requirements", paths.files.requirements, {
    schemaVersion: 1,
    answeredAt: "2026-10-11T11:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 40, currency: "EUR" },
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "important",
    dnsProvider: "cloudflare",
    domain: DOMAIN,
    provider: "digitalocean",
    keepExternalServices: [],
  });
  // What `opscrew provision` left on this computer.
  await ensureDeployKey(paths);
  await ensureStatePassphrase(paths);
  await mkdir(paths.files.tfstateDir, { recursive: true });
  await writeFile(path.join(paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await writeFile(paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  await writeFile(
    path.join(paths.projectHomeDir, "deploy_secrets.json"),
    `${JSON.stringify({ host: SERVER_IPV4, repo: "acme/shop", names: [] })}\n`,
  );

  const events: MoveEvent[] = [];
  const hosts = new FakeHosts(events);
  Object.assign(hosts.host(SERVER_IPV4), { app: true, caddy: true, db: "orders before the move" });
  const engine = new FakeMoveEngine(events, { from: "hetzner", dns: true });
  const github = new FakeMoveGitHub(events, hosts);
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    events.push({ type: "fetch", url: url.href });
    const ip =
      url.hostname === DOMAIN ? engine.dnsServer()?.ipv4 : url.hostname.replace(/^\[|\]$/g, "");
    const h = ip !== undefined ? hosts.hosts.get(ip) : undefined;
    const ok = h?.app === true && h.caddy;
    return new Response(ok ? "ok" : "bad gateway", { status: ok ? 200 : 502 });
  };
  const fakeServers = (provider: CloudProvider): ServerSnapshotApi => ({
    findAppServers: async (): Promise<AppServer[]> =>
      Object.values(engine.state.servers)
        .filter((s): s is FakeServer => s?.provider === provider)
        .map((s) => ({ id: s.id, name: APP, status: "running" })),
    snapshotServer: async (serverId) => {
      events.push({ type: "snapshot", serverId });
      return { snapshotId: `snap-${serverId}` };
    },
  });
  let monotonic = 0;
  const ok = { configured: true, verify: async () => ({ ok: true, message: "ok" }) };
  const services: RetargetServices = {
    engine: async () => engine,
    providers: { hetzner: ok, digitalocean: ok },
    cloudflare: fakeCloudflare(),
    github,
    tcpConnect: async () => true,
    remote: hosts.remote,
    servers: { hetzner: fakeServers("hetzner"), digitalocean: fakeServers("digitalocean") },
    catalogs: { hetzner: new StaticHetznerCatalog(), digitalocean: new StaticDigitalOceanCatalog() },
    sleep: async (ms) => {
      monotonic += ms;
    },
    now: () => monotonic,
  };
  const runner = new MoveRunner(hosts);
  let seconds = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, seconds++)) };

  /** A test context for one `opscrew` run in the project, with every fake attached. */
  const context = (options: { interactive?: boolean; services?: CliServices } = {}) => {
    const ctx = projectContext(
      { ...project, env },
      {
        ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
        services: { runner, fetch, clock, ...options.services },
      },
    );
    withServices(ctx, { retarget: services });
    return ctx;
  };

  return { project, paths, env, plan, events, hosts, engine, github, services, context };
}

export type MoveProject = Awaited<ReturnType<typeof moveProject>>;
