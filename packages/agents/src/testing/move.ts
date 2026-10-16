import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  AppServer,
  Clock,
  CommandResult,
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
import {
  ApprovalGate,
  CostLedger,
  MemoryApprovalStore,
  MemoryAuditLog,
  ProjectStateStore,
  Redactor,
  resolveProjectPaths,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type CloudProvider,
  type DeployPlan,
  DeployPlanSchema,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { isMaintenanceWindowRequest } from "../retarget/texts";
import type { RetargetGitHubApi, RetargetServices } from "../retarget/types";
import { ensureDeployKey, ensureStatePassphrase } from "../shared";
import { doEuCatalog, euCatalog, makeFacts, makeRequirements } from "./catalog";
import {
  createProject,
  FakeGitHub,
  fakeCloudflare,
  HOST_KEY,
  opscrewRecord,
  projectRunner,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
} from "./deploy";
import { MemoryReporter, ScriptedRunner } from "./deps";
import { noProviderSchemas, plainStateResources } from "./state";

export { HOST_KEY, SERVER_IPV4 as OLD_IPV4, SERVER_IPV6 as OLD_IPV6 };

export const DOMAIN = "shop.example.com";
export const APP = "shop";
/** The Stripe key the user supplies through OPSCREW_APP_ENV_FILE (synthetic). */
export const STRIPE = fakeSecret("stripe-live-key");
export const TOKENS = {
  hetzner: fakeSecret("hcloud-token"),
  digitalocean: fakeSecret("digitalocean-token"),
  cloudflare: fakeSecret("cloudflare-token"),
};

/** What the fake engine creates for a new server, per provider. */
export const NEW_SERVERS: Record<CloudProvider, { id: string; ipv4: string; ipv6: string }> = {
  hetzner: { id: "4712", ipv4: "198.51.100.20", ipv6: "2001:db8:20::1" },
  digitalocean: { id: "3164445", ipv4: "198.51.100.30", ipv6: "2001:db8:30::1" },
};
export const OLD_IDS: Record<CloudProvider, string> = { hetzner: "4711", digitalocean: "3164444" };

/** Everything the fakes saw, in order: the trail SC-502 is checked on. */
export type MoveEvent =
  | {
      type: "approval";
      kind: ApprovalRequest["kind"];
      title: string;
      planHash?: string;
      allowDestroy?: boolean;
      confirmation?: string;
      approved: boolean;
    }
  | { type: "confirm"; name: string; resources: number }
  | { type: "init"; modules: string }
  | { type: "plan"; hash: string; vars: string }
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
  | { type: "fetch"; url: string }
  | { type: "resolve"; host: string };

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
  const main = await readFile(join(dir, "main.tf"), "utf8");
  const outputs = await readFile(join(dir, "outputs.tf"), "utf8");
  const variables = await readFile(join(dir, "variables.tf"), "utf8");
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
 * `allowDestroy`, delete protection and stale plans like the real engines; planning a module
 * that was not initialised, or a variable the root does not declare, fails as they would.
 */
export class FakeMoveEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly state: {
    servers: Partial<Record<ModuleName, FakeServer>>;
    dns?: string;
    serial: number;
    /** Root outputs as the last successful apply recorded them (what `output` reads, like tofu). */
    outputs: Record<string, unknown>;
  };
  /** Returns a failure log for an apply, e.g. to make the DNS switch fail. */
  failApply: ((effect: Effect) => string | undefined) | undefined;
  /** Throws from `plan` (e.g. a simulated interruption). */
  failPlan: ((effect: Effect) => Error | undefined) | undefined;
  /** Replaces the plan JSON (e.g. to fail a security policy). */
  planJsonFor: ((effect: Effect) => unknown) | undefined;
  /** Edits a computed plan (e.g. a delete that appears after the preview). */
  tamper: ((effect: Effect) => void) | undefined;
  readonly plans: { hash: string; effect: Effect }[] = [];
  /** Hashes of the plans applied, in order. */
  readonly applied: string[] = [];
  #installed = new Set<string>();
  #effects = new Map<string, Effect>();
  #counter = 0;

  constructor(
    readonly events: MoveEvent[],
    options: { from: CloudProvider; dns: boolean },
  ) {
    const old: FakeServer = {
      id: OLD_IDS[options.from],
      provider: options.from,
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
      protected: options.from === "hetzner",
    };
    this.state = {
      servers: { server: old },
      ...(options.dns ? { dns: old.id } : {}),
      serial: 0,
      // What `opscrew provision` applied: the root module without a move layout.
      outputs: outputsOf(
        {
          modules: new Map<ModuleName, CloudProvider>([["server", options.from]]),
          live: "server",
          variables: new Set(),
        },
        { server: old },
        options.dns,
      ),
    };
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
    this.tamper?.(effect);
    const failure = this.failPlan?.(effect);
    if (failure) throw failure;
    if (this.planJsonFor) effect.planJson = this.planJsonFor(effect);
    const content = `fake plan ${++this.#counter} for ${dir}`;
    await writeFile(planFile, content);
    const planHash = sha256(content);
    this.#effects.set(planHash, effect);
    this.plans.push({ hash: planHash, effect });
    this.events.push({ type: "plan", hash: planHash, vars: JSON.stringify(options.vars ?? {}) });
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
    const failure = this.failApply?.(effect);
    if (failure) return { ok: false, outputs: {}, log: failure };
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
    const config = await readConfig(dir);
    this.state.outputs = outputsOf(config, this.state.servers, config.dns !== undefined);
    return { ok: true, outputs: structuredClone(this.state.outputs), log: "Apply complete!" };
  }

  /** The outputs the last successful apply recorded (a plan without changes does not update them). */
  async output(_dir: string): Promise<Record<string, unknown>> {
    return structuredClone(this.state.outputs);
  }

  readonly providerSchemas = noProviderSchemas;
  readonly stateResources = plainStateResources;
}

/**
 * The root outputs of the rendered configuration over the servers in the state: `server_*` and
 * `url` follow the live module, `servers` lists every server module's server by provider.
 */
function outputsOf(
  config: FakeConfig,
  servers: Partial<Record<ModuleName, FakeServer>>,
  dns: boolean,
): Record<string, unknown> {
  const live = config.live ? servers[config.live] : undefined;
  const byProvider: Record<string, { ipv4: string; ipv6: string; id: string }> = {};
  for (const [m, provider] of config.modules) {
    const server = servers[m];
    if (server) byProvider[provider] = { ipv4: server.ipv4, ipv6: server.ipv6, id: server.id };
  }
  return {
    ...(live
      ? {
          server_ipv4: live.ipv4,
          server_ipv6: live.ipv6,
          server_id: live.id,
          server_name: APP,
          url: dns ? `https://${DOMAIN}` : `http://${live.ipv4}`,
        }
      : {}),
    servers: byProvider,
  };
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
  if (command.endsWith("docker compose run --rm --no-deps -T release")) return "release";
  if (command.startsWith("rm -f /srv/app/opscrew-move.dump")) return "rm dump";
  return command;
}

/** The two servers' shells: Compose services, the database marker and the dump file. */
export class FakeHosts {
  readonly hosts = new Map<string, FakeHost>();
  /** Makes an operation fail (a result) or the connection break (an error). */
  fail: ((host: string, op: string) => CommandResult | Error | undefined) | undefined;
  dbSize = 52_428_800;
  /**
   * The deployed compose file has a `release` service (the plan has `app.releaseCommand`): the
   * deploy migrates the new server's empty database to HEAD, and `release` marks the database
   * as migrated.
   */
  release = false;

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
    const failure = this.fail?.(ip, op);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
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
        // Without `--clean`, a restore onto a database that holds tables fails.
        if (h.db !== "empty") {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              'pg_restore: error: could not execute query: ERROR:  relation "orders" already exists',
          };
        }
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
        return ok(this.release ? "app\nrelease\ndb\ncaddy\n" : "app\ndb\ncaddy\n");
      case "release":
        if (!this.release) {
          return { exitCode: 1, stdout: "", stderr: "no such service: release" };
        }
        h.db = `${h.db} (migrated)`;
        return ok();
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
    const failure = this.fail?.(from, "scp");
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    const source = this.host(from);
    if (source.dump === undefined) return { exitCode: 1, stdout: "", stderr: "scp: No such file" };
    this.host(to).dump = source.dump;
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  /**
   * What the deploy workflow does on `ip`: the app and Caddy run, with an empty database (that
   * the release command, when there is one, migrated to the schema of HEAD).
   */
  deploy(ip: string): void {
    const h = this.host(ip);
    if (this.release) h.db = "schema of HEAD";
    h.app = true;
    h.caddy = true;
  }
}

/** GitHub fake with the deploy workflow: a successful run deploys to `OPSCREW_HOST`. */
export class FakeMoveGitHub extends FakeGitHub implements RetargetGitHubApi {
  conclusion: string | null = "success";
  readonly runs: { workflowFile: string; ref: string }[] = [];

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

  async dispatchWorkflow(_owner: string, _repo: string, workflowFile: string, ref: string) {
    this.runs.push({ workflowFile, ref });
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

/** Approval handler that records every decision in the event trail. */
export class RecordingHandler implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  answer: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string } =
    () => true;

  constructor(readonly events: MoveEvent[]) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    const raw = this.answer(request);
    const decision = typeof raw === "boolean" ? { approved: raw } : raw;
    const confirmation =
      decision.confirmation ?? (decision.approved ? request.confirmPhrase : undefined);
    this.events.push({
      type: "approval",
      kind: request.kind,
      title: request.title,
      ...(request.planHash !== undefined ? { planHash: request.planHash } : {}),
      ...(request.allowDestroy !== undefined ? { allowDestroy: request.allowDestroy } : {}),
      ...(confirmation !== undefined ? { confirmation } : {}),
      approved: decision.approved,
    });
    return {
      approved: decision.approved,
      approver: "test-user",
      decidedAt: "2026-10-13T12:00:00.000Z",
      ...(confirmation !== undefined ? { confirmation } : {}),
    };
  }
}

/**
 * What a non-interactive CLI run would approve: an infrastructure plan only when `--approve` names
 * its hash (and, for deletions, `--confirm` the app name); the maintenance window only with
 * `--allow-downtime`; secrets, pushes and pull requests (as `--yes` does).
 */
export interface CliFlags {
  approve?: string;
  allowDowntime?: boolean;
  confirm?: string;
}

export function cliAnswer(flags: () => CliFlags) {
  return (request: ApprovalRequest): boolean | { approved: boolean; confirmation?: string } => {
    const cli = flags();
    if (request.kind === "iac-apply") {
      const named = cli.approve !== undefined && cli.approve.toLowerCase() === request.planHash;
      if (!named) return false;
      if (request.allowDestroy) {
        return cli.confirm === request.confirmPhrase
          ? { approved: true, confirmation: cli.confirm }
          : false;
      }
      return true;
    }
    if (isMaintenanceWindowRequest(request)) return cli.allowDowntime === true;
    return ["github-secrets", "git-push", "pull-request"].includes(request.kind);
  };
}

export interface MoveHarnessOptions {
  from?: CloudProvider;
  /** `cloudflare` (default), `other` (a domain without managed DNS) or `none` (no domain). */
  dns?: "cloudflare" | "other" | "none";
  postgres?: boolean;
  interactive?: boolean;
  /** The plan has `app.releaseCommand`, so the deployed compose file has a `release` service. */
  release?: boolean;
}

/** The live deployment a move starts from (`opscrew/plan.yaml` after provision). */
export function movePlan(options: MoveHarnessOptions = {}): DeployPlan {
  const dns = options.dns ?? "cloudflare";
  const postgres = options.postgres ?? true;
  const base = testPlan({
    provider: options.from ?? "hetzner",
    deployed: true,
    postgres,
    ...(dns === "cloudflare" ? { domain: DOMAIN } : {}),
  });
  return DeployPlanSchema.parse({
    ...base,
    // Without the Postgres container nothing derives DATABASE_URL (design leaves it out).
    app: {
      ...base.app,
      env: base.app.env.filter((v) => postgres || v.name !== "DATABASE_URL"),
      ...(options.release === true ? { releaseCommand: "python manage.py migrate --noinput" } : {}),
    },
    ...(dns === "other" ? { dns: { provider: "none", domain: DOMAIN, proxied: false } } : {}),
    deployment: {
      ...base.deployment,
      ...(dns === "cloudflare" ? { url: `https://${DOMAIN}` } : {}),
      lastCompletedPhase: "provision",
    },
  });
}

/**
 * Leaves in the project at `root` (a git repository holding {@link movePlan}'s plan) what
 * `opscrew provision` left on this computer, and builds every fake a move talks to: the engine,
 * the two servers, GitHub with the deploy workflow, Cloudflare, the outside network and the
 * retarget services. `runEnv` is the run's environment; the returned `env` adds the provider
 * tokens and the user's env file.
 */
export async function moveFakes(
  root: string,
  runEnv: Record<string, string | undefined>,
  options: MoveHarnessOptions = {},
) {
  const from = options.from ?? "hetzner";
  const to: CloudProvider = from === "hetzner" ? "digitalocean" : "hetzner";
  const dns = options.dns ?? "cloudflare";
  const env: Record<string, string | undefined> = {
    ...runEnv,
    HCLOUD_TOKEN: TOKENS.hetzner,
    DIGITALOCEAN_TOKEN: TOKENS.digitalocean,
    CLOUDFLARE_API_TOKEN: TOKENS.cloudflare,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  const paths = resolveProjectPaths(root, { env });
  await writeArtifact("architecture", paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-11T09:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: makeFacts({ name: APP }),
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    paths.files.requirements,
    makeRequirements({
      provider: to,
      dataCriticality: "important",
      budgetMonthly: { amount: 40, currency: "EUR" },
      ...(dns === "none" ? {} : { dnsProvider: dns, domain: DOMAIN }),
    }),
  );
  // What `opscrew provision` left on this computer.
  await ensureDeployKey(paths);
  await ensureStatePassphrase(paths);
  await mkdir(paths.files.tfstateDir, { recursive: true });
  await writeFile(join(paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await writeFile(paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  await writeFile(
    paths.files.deploySecrets,
    `${JSON.stringify({ host: SERVER_IPV4, repo: "acme/shop", names: [] })}\n`,
  );
  await writeFile(join(root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);

  const events: MoveEvent[] = [];
  const hosts = new FakeHosts(events);
  hosts.release = options.release === true;
  Object.assign(hosts.host(SERVER_IPV4), { app: true, caddy: true, db: "orders before the move" });
  const engine = new FakeMoveEngine(events, { from, dns: dns === "cloudflare" });
  const github = new FakeMoveGitHub(events, hosts);
  /** Where the domain resolves when DNS is not managed (the user changes it). */
  const manual = { ip: SERVER_IPV4 };
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    events.push({ type: "fetch", url: url.href });
    const ip =
      url.hostname === DOMAIN
        ? dns === "cloudflare"
          ? engine.dnsServer()?.ipv4
          : manual.ip
        : url.hostname.replace(/^\[|\]$/g, "");
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
    cloudflare: fakeCloudflare(
      dns === "cloudflare"
        ? {
            records: [
              opscrewRecord(DOMAIN, "A", SERVER_IPV4),
              opscrewRecord(DOMAIN, "AAAA", SERVER_IPV6),
            ],
          }
        : {},
    ),
    github,
    tcpConnect: async () => true,
    remote: hosts.remote,
    servers: { hetzner: fakeServers("hetzner"), digitalocean: fakeServers("digitalocean") },
    catalogs: { hetzner: euCatalog(), digitalocean: doEuCatalog() },
    // A proxied Cloudflare domain resolves to the edge; otherwise to where the user points it.
    resolve: async (host) => {
      events.push({ type: "resolve", host });
      if (host !== DOMAIN) return [];
      return dns === "cloudflare" ? ["104.16.0.1"] : [manual.ip];
    },
    sleep: async (ms) => {
      monotonic += ms;
    },
    now: () => monotonic,
  };
  return { env, paths, from, to, events, hosts, engine, github, fetch, services, manual };
}

/** A provisioned project (git repo, plan, state, keys) with every fake a move talks to. */
export async function moveHarness(options: MoveHarnessOptions = {}) {
  const plan = movePlan(options);
  const project = await createProject(plan);
  const fakes = await moveFakes(
    project.root,
    { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    options,
  );
  const { paths, events, hosts } = fakes;
  const reporter = new MemoryReporter();
  let seconds = 0;
  const clock: Clock = { now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, seconds++)) };
  const audit = new MemoryAuditLog({ clock });
  const handler = new RecordingHandler(events);
  const approvals = new ApprovalGate({ handler, store: new MemoryApprovalStore(), audit, clock });
  const real = projectRunner();
  const runner = new ScriptedRunner(async (command, args, opts) =>
    command === "scp" ? hosts.scp(args) : real.run(command, args, opts),
  );
  const redactor = new Redactor();
  for (const [name, value] of Object.entries(TOKENS)) redactor.addLiteral(value, name);
  const deps: PhaseDeps = {
    paths,
    reporter,
    approvals,
    audit,
    state: new ProjectStateStore(paths.files.state, clock),
    costs: new CostLedger(paths.files.costs, clock),
    runner,
    fetch: fakes.fetch,
    env: fakes.env,
    clock,
    redactor,
    interactive: options.interactive ?? true,
    version: "0.0.0-test",
  };
  const confirm = async (preview: { name: string; resources: unknown[] }) => {
    events.push({ type: "confirm", name: preview.name, resources: preview.resources.length });
    return true;
  };
  /** Mutable flags of the simulated non-interactive CLI run. */
  const cli: CliFlags = {};
  if (deps.interactive === false) handler.answer = cliAnswer(() => cli);
  return {
    ...project,
    ...fakes,
    deps,
    plan,
    reporter,
    audit,
    handler,
    confirm,
    cli,
    newServer: NEW_SERVERS[fakes.to],
  };
}

export type MoveHarness = Awaited<ReturnType<typeof moveHarness>>;
