import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type {
  AppServer,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import type { CloudProvider } from "@opscrew/plan-schema";
import type { DestroyGitHubApi } from "../destroy/types";
import { FakeGitHub, SERVER_IPV4 } from "./deploy";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const HCLOUD = "registry.opentofu.org/hetznercloud/hcloud";
const DIGITALOCEAN = "registry.opentofu.org/digitalocean/digitalocean";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
export const SERVER_ADDRESS = "module.server.hcloud_server.this";
export const DROPLET_ADDRESS = "module.server.digitalocean_droplet.this";

function change(
  address: string,
  type: string,
  action: ResourceChange["action"],
  provider = HCLOUD,
): ResourceChange {
  return { address, type, name: address.split(".").pop() as string, provider, action };
}

/** The server-module resources of a deployment on `provider` (the server last). */
function serverResources(provider: CloudProvider, server: boolean): ResourceChange[] {
  if (provider === "digitalocean") {
    const d = (address: string, type: string) => change(address, type, "delete", DIGITALOCEAN);
    return [
      d("module.server.digitalocean_tag.app", "digitalocean_tag"),
      d("module.server.digitalocean_ssh_key.deploy", "digitalocean_ssh_key"),
      d("module.server.digitalocean_firewall.this", "digitalocean_firewall"),
      ...(server ? [d(DROPLET_ADDRESS, "digitalocean_droplet")] : []),
    ];
  }
  return [
    change("module.server.hcloud_ssh_key.deploy", "hcloud_ssh_key", "delete"),
    change("module.server.hcloud_firewall.this", "hcloud_firewall", "delete"),
    ...(server ? [change(SERVER_ADDRESS, "hcloud_server", "delete")] : []),
  ];
}

/** What the destroy plans delete when the whole deployment still exists (server last). */
export function deployedResources(
  options: { dns?: boolean; server?: boolean; provider?: CloudProvider } = {},
) {
  const resources = serverResources(options.provider ?? "hetzner", options.server !== false);
  if (options.dns) {
    resources.unshift(
      change("module.dns.cloudflare_dns_record.a", "cloudflare_dns_record", "delete", CLOUDFLARE),
      change(
        "module.dns.cloudflare_dns_record.aaaa",
        "cloudflare_dns_record",
        "delete",
        CLOUDFLARE,
      ),
    );
  }
  return resources;
}

/** The server's attributes as the engine reports them in `before`/`after` of a plan. */
export function serverAttributes(overrides: Record<string, unknown> = {}) {
  return {
    id: "4711",
    name: "shop",
    server_type: "cx23",
    location: "nbg1",
    backups: true,
    delete_protection: true,
    rebuild_protection: true,
    labels: { "managed-by": "opscrew", app: "shop" },
    firewall_ids: [42],
    ipv4_address: SERVER_IPV4,
    ...overrides,
  };
}

/** A protection-lifting plan: the server's protection goes off, plus optional other edits. */
export function unprotectPlan(serverAfter: Record<string, unknown> = {}) {
  const before = serverAttributes();
  const after = serverAttributes({
    delete_protection: false,
    rebuild_protection: false,
    ...serverAfter,
  });
  return {
    changes: [change(SERVER_ADDRESS, "hcloud_server", "update")],
    planJson: {
      format_version: "1.2",
      resource_changes: [
        {
          address: SERVER_ADDRESS,
          mode: "managed",
          type: "hcloud_server",
          change: { actions: ["update"], before, after, after_unknown: {} },
        },
      ],
    },
  };
}

export type PlanKind = "unprotect" | "destroy";

export interface DestroyScript {
  /** Resources the destroy plans delete until a destroy plan is applied. */
  resources?: ResourceChange[];
  /** The protection-lifting plan until one is applied (default: {@link unprotectPlan}). */
  unprotect?: { changes: ResourceChange[]; planJson: unknown };
  /** Apply results by plan kind (default: success). */
  applyOk?: Partial<Record<PlanKind, boolean>>;
  /**
   * The server's id in the destroy plan JSON (`change.before.id`), as the state knows it. Default:
   * the id of the provider's fake server; `null` leaves it out (plan JSON without the id).
   */
  serverId?: string | null;
}

/** Server ids in the state by resource type (the fake servers of {@link FakeServers}). */
const STATE_SERVER_IDS: Readonly<Record<string, string>> = {
  hcloud_server: "4711",
  digitalocean_droplet: "3164444",
};

/** `show -json` of a destroy plan: every change a delete, with the state's `before` values. */
function destroyPlanJson(changes: readonly ResourceChange[], serverId: string | null | undefined) {
  const before = (change: ResourceChange): Record<string, unknown> => {
    const stateId = STATE_SERVER_IDS[change.type];
    if (stateId === undefined) return { id: `${change.name}-1` };
    const id = serverId === undefined ? stateId : serverId;
    return { ...(id === null ? {} : { id }), name: "shop" };
  };
  return {
    format_version: "1.2",
    resource_changes: changes.map((change) => ({
      address: change.address,
      mode: "managed",
      type: change.type,
      name: change.name,
      change: { actions: ["delete"], before: before(change), after: null },
    })),
  };
}

/**
 * IaC engine fake for destroy: a normal plan is the protection-lifting plan, a `destroy: true`
 * plan deletes {@link DestroyScript.resources}. Applies enforce the hash binding and the
 * `allowDestroy` flag like the real engines and update the scripted state (protection off,
 * resources gone), so a second run sees empty plans. Every step is appended to `events`.
 */
export class ScriptedDestroyEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly calls: string[] = [];
  readonly planOptions: (IacRunOptions & { destroy?: boolean })[] = [];
  readonly planFiles: string[] = [];
  readonly applied: { kind: PlanKind; planFile: string; approval: IacApproval }[] = [];
  initOptions: IacInitOptions | undefined;
  /** Called first in every apply, for example to check that an approval was recorded. */
  beforeApply: ((planHash: string, kind: PlanKind) => void) | undefined;
  #counter = 0;
  #kinds = new Map<string, PlanKind>();
  #protectionOff = false;
  #destroyed = false;

  constructor(
    readonly script: DestroyScript = {},
    readonly events: string[] = [],
  ) {}

  async init(_dir: string, options?: IacInitOptions): Promise<void> {
    this.calls.push("init");
    this.initOptions = options;
  }

  async validate() {
    this.calls.push("validate");
    return { valid: true, diagnostics: [] };
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    const kind: PlanKind = options.destroy ? "destroy" : "unprotect";
    this.calls.push(`plan:${kind}`);
    this.planOptions.push(options);
    this.planFiles.push(planFile);
    const content = `fake ${kind} plan ${++this.#counter} for ${dir}`;
    await writeFile(planFile, content);
    this.#kinds.set(planFile, kind);
    const unprotect = this.script.unprotect ?? unprotectPlan();
    const changes =
      kind === "destroy"
        ? this.#destroyed
          ? []
          : (this.script.resources ?? deployedResources())
        : this.#protectionOff
          ? []
          : unprotect.changes;
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    const hash = sha256(content);
    this.events.push(`plan:${kind}`);
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: hash,
      createdAt: "2026-10-11T12:00:00.000Z",
      changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: changes.some((c) => c.action === "delete" || c.action === "replace"),
      planJson:
        kind === "destroy"
          ? destroyPlanJson(changes, this.script.serverId)
          : changes.length > 0
            ? unprotect.planJson
            : { format_version: "1.2", resource_changes: [] },
    };
  }

  async apply(_dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    const kind = this.#kinds.get(planFile) as PlanKind;
    this.calls.push(`apply:${kind}`);
    this.beforeApply?.(approval.approvedPlanHash, kind);
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    if (kind === "destroy" && approval.allowDestroy !== true) {
      throw new Error("destroy not allowed");
    }
    this.events.push(`apply:${kind}`);
    this.applied.push({ kind, planFile, approval });
    if (this.script.applyOk?.[kind] === false) {
      return { ok: false, outputs: {}, log: `Error: ${kind} failed\nhcloud: server is locked` };
    }
    if (kind === "unprotect") this.#protectionOff = true;
    if (kind === "destroy") this.#destroyed = true;
    return { ok: true, outputs: {}, log: "Apply complete!" };
  }

  async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return {};
  }
}

/** The app's server as each provider's fake reports it, and the id its snapshot gets. */
const FAKE_SERVERS: Record<CloudProvider, { server: AppServer; snapshotId: string }> = {
  hetzner: { server: { id: "4711", name: "shop", status: "running" }, snapshotId: "9001" },
  digitalocean: {
    server: { id: "3164444", name: "shop", status: "active" },
    snapshotId: "6372321",
  },
};

/**
 * Provider-neutral snapshot fake (`ServerSnapshotApi`): one server for the app; snapshots succeed
 * unless told otherwise. `createError` fails before anything is started; `waitError` fails after
 * the snapshot was started (an errored or timed-out wait), as a connector's `snapshotServer` can.
 */
export class FakeServers implements ServerSnapshotApi {
  servers: AppServer[];
  snapshotId: string;
  /** Apps looked up with `findAppServers`. */
  readonly lookups: string[] = [];
  /** Every snapshot that was started, with its request. */
  readonly snapshots: ({ serverId: string } & SnapshotRequest)[] = [];
  lookupError: Error | undefined;
  createError: Error | undefined;
  waitError: Error | undefined;

  constructor(
    readonly events: string[] = [],
    provider: CloudProvider = "hetzner",
  ) {
    this.servers = [{ ...FAKE_SERVERS[provider].server }];
    this.snapshotId = FAKE_SERVERS[provider].snapshotId;
  }

  async findAppServers(app: string): Promise<AppServer[]> {
    this.lookups.push(app);
    if (this.lookupError) throw this.lookupError;
    return this.servers.map((server) => ({ ...server }));
  }

  async snapshotServer(serverId: string, request: SnapshotRequest) {
    if (this.createError) throw this.createError;
    this.snapshots.push({ serverId, ...request });
    this.events.push("snapshot:create");
    if (this.waitError) throw this.waitError;
    this.events.push("snapshot:ready");
    return { snapshotId: this.snapshotId };
  }
}

/** Provision's GitHub fake plus `deleteActionsSecret`, recording deletions in `events`. */
export class FakeDestroyGitHub extends FakeGitHub implements DestroyGitHubApi {
  readonly deleted: string[] = [];
  deleteError: Error | undefined;
  /** Called before each deletion (for example to inspect the plan file at that moment). */
  onDelete: ((name: string) => Promise<void> | void) | undefined;

  constructor(readonly events: string[] = []) {
    super();
  }

  async deleteActionsSecret(_owner: string, _repo: string, name: string): Promise<void> {
    await this.onDelete?.(name);
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(name);
    this.secrets.delete(name);
    this.events.push(`secret:${name}`);
  }
}
