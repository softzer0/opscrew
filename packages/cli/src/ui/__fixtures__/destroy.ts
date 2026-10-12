import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { DestroyServices } from "@opscrew/agents";
import type {
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
} from "@opscrew/contracts";
import { SERVER_IPV4 } from "./deploy";

const HCLOUD = "registry.opentofu.org/hetznercloud/hcloud";
const SERVER = "module.server.hcloud_server.this";
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const change = (address: string, type: string, action: ResourceChange["action"]) => ({
  address,
  type,
  name: address.split(".").pop() as string,
  provider: HCLOUD,
  action,
});

const RESOURCES: ResourceChange[] = [
  change("module.server.hcloud_ssh_key.deploy", "hcloud_ssh_key", "delete"),
  change("module.server.hcloud_firewall.this", "hcloud_firewall", "delete"),
  change(SERVER, "hcloud_server", "delete"),
];

const server = (protection: boolean) => ({
  name: "shop",
  server_type: "cx23",
  location: "nbg1",
  delete_protection: protection,
  rebuild_protection: protection,
});

/**
 * Destroy engine fake: a normal plan lifts the server's protection, a `destroy` plan deletes the
 * deployment. Applies enforce the hash binding and `allowDestroy` like the real engines.
 */
export class DestroyEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly applied: string[] = [];
  #kinds = new Map<string, "unprotect" | "destroy">();
  #counter = 0;
  #protectionOff = false;
  #destroyed = false;

  async init(): Promise<void> {}
  async validate() {
    return { valid: true, diagnostics: [] };
  }
  async output() {
    return {};
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    const kind = options.destroy ? "destroy" : "unprotect";
    const content = `fake ${kind} plan ${++this.#counter}`;
    await writeFile(planFile, content);
    this.#kinds.set(planFile, kind);
    const changes =
      kind === "destroy"
        ? this.#destroyed
          ? []
          : RESOURCES
        : this.#protectionOff
          ? []
          : [change(SERVER, "hcloud_server", "update")];
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256(content),
      createdAt: "2026-10-12T12:00:00.000Z",
      changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: changes.some((c) => c.action === "delete"),
      planJson:
        kind === "unprotect" && changes.length > 0
          ? {
              resource_changes: [
                {
                  address: SERVER,
                  mode: "managed",
                  type: "hcloud_server",
                  change: { actions: ["update"], before: server(true), after: server(false) },
                },
              ],
            }
          : { resource_changes: [] },
    };
  }

  async apply(_dir: string, planFile: string, approval: IacApproval): Promise<IacApplyResult> {
    const kind = this.#kinds.get(planFile);
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    if (kind === "destroy" && approval.allowDestroy !== true) throw new Error("destroy not allowed");
    this.applied.push(kind as string);
    if (kind === "unprotect") this.#protectionOff = true;
    if (kind === "destroy") this.#destroyed = true;
    return { ok: true, outputs: {}, log: "Apply complete!" };
  }
}

/** Fakes for `opscrew destroy`: one labelled server, snapshots succeed, secrets get deleted. */
export function destroyServices(engine: DestroyEngine) {
  const snapshots: number[] = [];
  const deletedSecrets: string[] = [];
  const services: DestroyServices = {
    engine: async () => engine,
    hetzner: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    hetznerClient: {
      listServers: async () => [
        {
          id: 4711,
          name: "shop",
          status: "running",
          labels: { "managed-by": "opscrew", app: "shop" },
          ipv4: SERVER_IPV4,
        },
      ],
      createSnapshot: async (serverId) => {
        snapshots.push(serverId);
        return { imageId: 9001, actionId: 77 };
      },
      waitForAction: async (actionId) => ({ id: actionId, status: "success" }) as never,
    },
    cloudflare: null,
    github: {
      deleteActionsSecret: async (_owner, _repo, name) => {
        deletedSecrets.push(name);
      },
    },
    sleep: async () => undefined,
  };
  return { services, snapshots, deletedSecrets };
}
