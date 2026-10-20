import type { IsoDateTime } from "./common";

export type IacEngineName = "tofu" | "terraform";

export interface IacEngineInfo {
  name: IacEngineName;
  /** Version reported by the binary, for example `1.13.1`. */
  version: string;
  /** Absolute path of the binary that was detected or configured. */
  binary: string;
}

export type ResourceAction = "create" | "update" | "delete" | "replace" | "read" | "no-op";

export interface ResourceChange {
  /** Full resource address, for example `module.server.hcloud_server.app`. */
  address: string;
  type: string;
  name: string;
  /** Provider name, for example `registry.opentofu.org/hetznercloud/hcloud`. */
  provider: string;
  action: ResourceAction;
}

export interface PlanSummary {
  engine: IacEngineInfo;
  /** Absolute path of the root module directory. */
  dir: string;
  /** Absolute path of the saved plan file. */
  planFile: string;
  /** SHA-256 hex digest of the plan file's bytes. Approvals bind to this value. */
  planHash: string;
  createdAt: IsoDateTime;
  /** Every change except `no-op` and `read`. */
  changes: ResourceChange[];
  counts: { create: number; update: number; delete: number; replace: number };
  /** True when any change is a `delete` or `replace`. */
  hasDestroy: boolean;
  /** The engine's machine-readable plan (`show -json`), used by policy checks. */
  planJson: unknown;
  /**
   * Changes made outside the engine since the last apply (`resource_drift`), found while
   * refreshing. Present when the engine reports any; refresh-only plans carry only this.
   */
  drift?: ResourceDrift[];
  /**
   * Resources the plan only renames in the state (`moved` blocks, `previous_address`). A pure
   * move is not a change; a plan with moves and no changes still has to be applied.
   */
  moves?: ResourceMove[];
}

/** A resource whose state address changes (a `moved` block); nothing changes in the cloud. */
export interface ResourceMove {
  /** Address before the plan, for example `module.server.hcloud_server.this`. */
  from: string;
  /** Address after the plan, for example `module.server_previous.hcloud_server.this`. */
  to: string;
  type: string;
}

/** One resource whose real state no longer matches the engine's state. */
export interface ResourceDrift {
  address: string;
  type: string;
  name: string;
  provider: string;
  /** `delete`: the resource no longer exists; `update`: some attributes changed. */
  action: "update" | "delete";
  /** Sorted top-level attribute names whose values differ. Values are never copied. */
  attributes: string[];
}

export interface IacRunOptions {
  /** Extra environment for the engine (provider tokens, `TF_ENCRYPTION`, …). Never logged. */
  env?: Record<string, string | undefined>;
  /** Input variables passed as `-var name=value`. Never put secrets here; use env instead. */
  vars?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (line: string) => void;
}

export interface IacInitOptions extends IacRunOptions {
  /** Values for a partial backend configuration (`-backend-config=key=value`). */
  backendConfig?: Record<string, string>;
}

export interface IacDiagnostic {
  severity: "error" | "warning";
  summary: string;
  detail?: string;
  file?: string;
  line?: number;
}

export interface IacValidation {
  valid: boolean;
  diagnostics: IacDiagnostic[];
}

export interface IacApplyResult {
  ok: boolean;
  outputs: Record<string, unknown>;
  /** Engine output, redacted. */
  log: string;
}

export interface IacApproval {
  /** Hash the user approved. Must equal the plan file's current SHA-256. */
  approvedPlanHash: string;
  /** Required when the plan deletes or replaces anything. */
  allowDestroy?: boolean;
}

/**
 * The only way OpsCrew talks to `tofu` or `terraform`. Implementations live in
 * `@opscrew/iac-engine`. There is deliberately no `destroy` method: destroys are plans created
 * with `destroy: true` and applied through the same approval-bound `apply`.
 */
export interface IacEngine {
  readonly info: IacEngineInfo;
  init(dir: string, options?: IacInitOptions): Promise<void>;
  validate(dir: string, options?: IacRunOptions): Promise<IacValidation>;
  /** Writes a saved plan to `planFile` and summarises it. */
  plan(
    dir: string,
    planFile: string,
    options?: IacRunOptions & {
      destroy?: boolean;
      /** Only refresh the state and report drift (`-refresh-only`); never plans changes. */
      refreshOnly?: boolean;
    },
  ): Promise<PlanSummary>;
  /**
   * Applies exactly the saved plan. MUST refuse when the plan file's SHA-256 differs from
   * `approval.approvedPlanHash`, or when the plan deletes or replaces anything and
   * `approval.allowDestroy` is not true.
   */
  apply(
    dir: string,
    planFile: string,
    approval: IacApproval,
    options?: IacRunOptions,
  ): Promise<IacApplyResult>;
  output(dir: string, options?: IacRunOptions): Promise<Record<string, unknown>>;
  /**
   * Runs `providers schema -json` in `dir` after `init` (reads the installed providers, no
   * network) and returns the parsed, not yet validated document. Cached per directory for the
   * engine's lifetime; a failure throws `ENGINE_FAILED` and is not cached.
   */
  providerSchemas(dir: string, options?: IacRunOptions): Promise<unknown>;
  /**
   * Runs `state list -state=<stateFile>` in an empty scratch folder: no root module, `init`,
   * provider or credential is needed, and nothing is written. An OpenTofu-encrypted state opens
   * with the same `TF_ENCRYPTION` in `options.env` as every other command. Returns the managed
   * resource addresses, sorted, without data sources; `[]` for a state a destroy emptied. A missing
   * file, or one the engine cannot read (encrypted without the right encryption settings, or
   * damaged), throws `ENGINE_FAILED`.
   */
  stateResources(stateFile: string, options?: IacRunOptions): Promise<string[]>;
  /**
   * Runs `untaint -allow-missing <address>` in `dir` after `init`, against the root's configured
   * state, with the same `options.env` as every other command. A state-only change: nothing in the
   * cloud changes, and an address the state lacks is no error. A failure
   * throws `ENGINE_FAILED`.
   */
  untaint(dir: string, address: string, options?: IacRunOptions): Promise<void>;
}
