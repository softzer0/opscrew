import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type {
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
} from "@opscrew/contracts";
import type { HetznerServerSummary } from "@opscrew/connector-hetzner";
import { FakeGitHub, SERVER_IPV4 } from "../../provision/__fixtures__/fakes";
import type { DestroyGitHubApi, HetznerSnapshotApi } from "../types";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const HCLOUD = "registry.opentofu.org/hetznercloud/hcloud";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
export const SERVER_ADDRESS = "module.server.hcloud_server.this";

function change(
  address: string,
  type: string,
  action: ResourceChange["action"],
  provider = HCLOUD,
): ResourceChange {
  return { address, type, name: address.split(".").pop() as string, provider, action };
}

/** What the destroy plans delete when the whole deployment still exists (server last). */
export function deployedResources(options: { dns?: boolean; server?: boolean } = {}) {
  const resources = [
    change("module.server.hcloud_ssh_key.deploy", "hcloud_ssh_key", "delete"),
    change("module.server.hcloud_firewall.this", "hcloud_firewall", "delete"),
    ...(options.server === false ? [] : [change(SERVER_ADDRESS, "hcloud_server", "delete")]),
  ];
  if (options.dns) {
    resources.unshift(
      change("module.dns.cloudflare_dns_record.a", "cloudflare_dns_record", "delete", CLOUDFLARE),
      change("module.dns.cloudflare_dns_record.aaaa", "cloudflare_dns_record", "delete", CLOUDFLARE),
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
        kind === "unprotect" && changes.length > 0
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

/** Hetzner snapshot fake: one labelled server; snapshots succeed unless told otherwise. */
export class FakeHetzner implements HetznerSnapshotApi {
  servers: HetznerServerSummary[] = [
    {
      id: 4711,
      name: "shop",
      status: "running",
      labels: { "managed-by": "opscrew", app: "shop" },
      ipv4: SERVER_IPV4,
    },
  ];
  readonly selectors: (string | undefined)[] = [];
  readonly snapshots: {
    serverId: number;
    description: string;
    labels: Record<string, string> | undefined;
  }[] = [];
  readonly waits: { actionId: number; timeoutMs: number | undefined }[] = [];
  createError: Error | undefined;
  waitError: Error | undefined;

  constructor(readonly events: string[] = []) {}

  async listServers(options: { labelSelector?: string } = {}) {
    this.selectors.push(options.labelSelector);
    const wanted = (options.labelSelector ?? "")
      .split(",")
      .filter((term) => term !== "")
      .map((term) => term.split("=") as [string, string]);
    return this.servers.filter((s) => wanted.every(([k, v]) => s.labels[k] === v));
  }

  async createSnapshot(
    serverId: number,
    options: { description: string; labels?: Record<string, string> },
  ) {
    if (this.createError) throw this.createError;
    this.snapshots.push({ serverId, description: options.description, labels: options.labels });
    this.events.push("snapshot:create");
    return { imageId: 9001, actionId: 77 };
  }

  async waitForAction(actionId: number, options: { timeoutMs?: number } = {}) {
    this.waits.push({ actionId, timeoutMs: options.timeoutMs });
    if (this.waitError) throw this.waitError;
    this.events.push("snapshot:ready");
    return { id: actionId, status: "success" };
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
