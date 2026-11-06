import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import type {
  CommandResult,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  RemoteExec,
  RemoteRunOptions,
  ResourceChange,
  ResourceMove,
} from "@opscrew/contracts";
import { IMAGES } from "@opscrew/iac-templates";
import type { MoveEvent } from "./move";
import { noProviderSchemas } from "./state";

type Slot = "this" | "previous";

/** A bucket in the fake `storage` state: its name and its region. */
interface FakeBucket {
  bucket: string;
  region: string;
}

/** What applying a plan of the `storage` root does to the fake state. */
interface Effect {
  serial: number;
  state: Partial<Record<Slot, FakeBucket>>;
  changes: ResourceChange[];
  moves: ResourceMove[];
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const bucketChange = (slot: Slot, action: ResourceChange["action"]): ResourceChange => ({
  address: `aws_s3_bucket.${slot}`,
  type: "aws_s3_bucket",
  name: slot,
  provider: "registry.opentofu.org/hashicorp/aws",
  action,
});

/**
 * The `storage` root's engine: a state of `aws_s3_bucket.this` and `.previous`, read against the
 * rendered `main.tf` as an engine would (a `moved` block renames a bucket, a declared bucket
 * missing from the state is created, a bucket the configuration no longer declares is deleted).
 * Applies enforce the hash and `allowDestroy`. While it runs it reads the credentials file of
 * `AWS_SHARED_CREDENTIALS_FILE` (the key of the bucket being left), as the `aws.previous` provider
 * would, and records it.
 */
export class FakeBucketEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  state: Partial<Record<Slot, FakeBucket>>;
  serial = 0;
  /** Each credentials file's content the engine read, and each `AWS_ACCESS_KEY_ID` it was given. */
  readonly credentials: string[] = [];
  readonly accessKeys: string[] = [];
  /** Extra changes a plan shows on request (drift), from its own changes and state renames. */
  extra: ((changes: ResourceChange[], moves: ResourceMove[]) => ResourceChange[]) | undefined;
  /** The plan files the engine saved, in order. */
  readonly planFiles: string[] = [];
  readonly #effects = new Map<string, Effect>();
  #counter = 0;

  constructor(
    readonly events: MoveEvent[],
    initial: FakeBucket,
  ) {
    this.state = { this: initial };
  }

  async #read(env: Record<string, string | undefined> | undefined): Promise<void> {
    const file = env?.AWS_SHARED_CREDENTIALS_FILE;
    if (file !== undefined && file !== devNull) this.credentials.push(await readFile(file, "utf8"));
    if (env?.AWS_ACCESS_KEY_ID !== undefined) this.accessKeys.push(env.AWS_ACCESS_KEY_ID);
  }

  async init(_dir: string, options?: IacInitOptions): Promise<void> {
    await this.#read(options?.env);
  }

  async validate() {
    return { valid: true, diagnostics: [] };
  }

  async plan(dir: string, planFile: string, options: IacRunOptions = {}): Promise<PlanSummary> {
    await this.#read(options.env);
    const main = await readFile(join(dir, "main.tf"), "utf8");
    const values = JSON.parse(await readFile(join(dir, "terraform.tfvars.json"), "utf8")) as Record<
      string,
      string
    >;
    const declared = new Map<Slot, FakeBucket>();
    for (const m of main.matchAll(
      /resource "aws_s3_bucket" "(this|previous)" \{\n( {2}provider = aws\.previous\n)?/g,
    )) {
      const slot = m[1] as Slot;
      const name = slot === "this" ? values.bucket : values.previous_bucket;
      const region = m[2] !== undefined ? values.previous_region : values.region;
      declared.set(slot, { bucket: name ?? "", region: region ?? "" });
    }
    const state: Partial<Record<Slot, FakeBucket>> = { ...this.state };
    const changes: ResourceChange[] = [];
    const moves: ResourceMove[] = [];
    const moved =
      /moved \{\n {2}from = aws_s3_bucket\.(\w+)\n {2}to {3}= aws_s3_bucket\.(\w+)/.exec(main);
    if (moved) {
      const [from, to] = [moved[1] as Slot, moved[2] as Slot];
      const bucket = state[from];
      if (bucket && !state[to] && declared.has(to)) {
        state[to] = bucket;
        delete state[from];
        moves.push({
          from: `aws_s3_bucket.${from}`,
          to: `aws_s3_bucket.${to}`,
          type: "aws_s3_bucket",
        });
      }
    }
    for (const [slot, bucket] of declared) {
      if (state[slot] === undefined) {
        changes.push(bucketChange(slot, "create"));
        state[slot] = bucket;
      }
    }
    for (const slot of Object.keys(state) as Slot[]) {
      if (declared.has(slot)) continue;
      changes.push(bucketChange(slot, "delete"));
      delete state[slot];
    }
    changes.push(...(this.extra?.(changes, moves) ?? []));
    this.planFiles.push(planFile);
    const content = `fake storage plan ${++this.#counter}`;
    await writeFile(planFile, content);
    const planHash = sha256(content);
    this.#effects.set(planHash, { serial: this.serial, state, changes, moves });
    this.events.push({ type: "plan", hash: planHash, vars: "{}" });
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash,
      createdAt: "2026-11-06T12:00:00.000Z",
      changes,
      counts: { create: count("create"), update: 0, delete: count("delete"), replace: 0 },
      hasDestroy: count("delete") > 0,
      planJson: { format_version: "1.2", resource_changes: [] },
      ...(moves.length > 0 ? { moves } : {}),
    };
  }

  async apply(
    _dir: string,
    planFile: string,
    approval: IacApproval,
    options: IacRunOptions = {},
  ): Promise<IacApplyResult> {
    await this.#read(options.env);
    const hash = sha256(await readFile(planFile));
    if (hash !== approval.approvedPlanHash) throw new Error("plan hash mismatch");
    const effect = this.#effects.get(hash);
    if (!effect) throw new Error("unknown plan");
    const deletes = effect.changes.filter((c) => c.action === "delete").map((c) => c.address);
    if (deletes.length > 0 && approval.allowDestroy !== true) {
      throw new Error("the plan deletes resources but the approval does not allow it");
    }
    this.events.push({
      type: "apply",
      hash,
      deletes,
      creates: effect.changes.filter((c) => c.action === "create").map((c) => c.address),
      updates: [],
      moves: effect.moves.length,
    });
    if (effect.serial !== this.serial) return { ok: false, outputs: {}, log: "Error: stale plan" };
    this.state = effect.state;
    this.serial++;
    return { ok: true, outputs: {}, log: "Apply complete!" };
  }

  async output(): Promise<Record<string, unknown>> {
    return {};
  }

  readonly providerSchemas = noProviderSchemas;

  async stateResources(): Promise<string[]> {
    return (Object.keys(this.state) as Slot[]).map((slot) => `aws_s3_bucket.${slot}`);
  }

  async untaint(): Promise<void> {}
  async importResource(): Promise<void> {}
}

/** One run of the rclone one-off container: where, its command line and its standard input. */
export interface RcloneRun {
  host: string;
  verb: string;
  command: string;
  input: string;
  timeoutMs: number | undefined;
}

/**
 * The servers' answers to the rclone one-off containers (`docker run -i --rm … rclone …`): the
 * buckets' objects (`old`, `next`), `size --json` of the old one, `copy` and `sync` into the new
 * one. Every other command goes to the servers' own fake.
 */
export class FakeRclone {
  readonly old = new Map<string, string>();
  readonly next = new Map<string, string>();
  readonly runs: RcloneRun[] = [];
  /** Makes a verb fail with this result (once it returns undefined, it succeeds). */
  fail: ((verb: string) => CommandResult | undefined) | undefined;

  constructor(readonly events: MoveEvent[]) {}

  wrap(remote: (host: string) => RemoteExec): (host: string) => RemoteExec {
    return (host) => {
      const inner = remote(host);
      return {
        host,
        run: async (command: string, options?: RemoteRunOptions): Promise<CommandResult> => {
          if (!command.includes(IMAGES.rclone.ref)) return inner.run(command, options);
          const verb = /exec rclone --config \/tmp\/r\.conf (\w+) /.exec(command)?.[1] ?? "?";
          this.runs.push({
            host,
            verb,
            command,
            input: options?.input ?? "",
            timeoutMs: options?.timeoutMs,
          });
          this.events.push({ type: "remote", host, op: `rclone ${verb}` });
          const failed = this.fail?.(verb);
          if (failed !== undefined) return failed;
          const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
          switch (verb) {
            case "size": {
              const bytes = [...this.old.values()].reduce((sum, data) => sum + data.length, 0);
              return ok(JSON.stringify({ count: this.old.size, bytes, sizeless: 0 }));
            }
            case "sync":
              for (const name of this.next.keys()) if (!this.old.has(name)) this.next.delete(name);
              for (const [name, data] of this.old) this.next.set(name, data);
              return ok();
            case "copy":
              for (const [name, data] of this.old) this.next.set(name, data);
              return ok();
            default:
              return { exitCode: 1, stdout: "", stderr: `unknown command ${verb}` };
          }
        },
      };
    };
  }
}
