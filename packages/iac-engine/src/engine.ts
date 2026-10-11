import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CommandResult,
  CommandRunner,
  IacApplyResult,
  IacApproval,
  IacDiagnostic,
  IacEngine,
  IacEngineInfo,
  IacEngineName,
  IacInitOptions,
  IacRunOptions,
  IacValidation,
  PlanSummary,
} from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, Redactor, registerEnvSecrets } from "@opscrew/core";
import { encryptionSecrets } from "./encryption";
import { hashBytes } from "./hash";
import { parsePlanJson } from "./plan-json";

/** Default timeout for `apply`: 30 minutes. */
export const APPLY_TIMEOUT_MS = 30 * 60_000;
/** Default timeout for every other command: 10 minutes. */
export const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Number of trailing output lines included in error messages. */
const ERROR_TAIL_LINES = 20;
const ERROR_TAIL_CHARS = 4_000;

/** Environment that makes both engines non-interactive and quiet. Always wins over caller env. */
export const AUTOMATION_ENV: Readonly<Record<string, string>> = Object.freeze({
  TF_IN_AUTOMATION: "1",
  TF_INPUT: "0",
  CHECKPOINT_DISABLE: "1",
});

export interface EngineOptions {
  runner: CommandRunner;
  /** Base environment for the engine process. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Redactor for logs, progress lines and error messages. Default: a new `Redactor`. */
  redactor?: Redactor;
  /** Clock for `PlanSummary.createdAt`. Default `() => new Date()`. */
  now?: () => Date;
}

/** Display name for an engine (`OpenTofu`, `Terraform`). */
export function engineLabel(name: IacEngineName): string {
  return name === "tofu" ? "OpenTofu" : "Terraform";
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

function tail(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const kept = lines.slice(-ERROR_TAIL_LINES).join("\n").trim();
  return kept.length > ERROR_TAIL_CHARS ? `…${kept.slice(-ERROR_TAIL_CHARS)}` : kept;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 1 ? `${m} minute${m === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`;
}

const HINTS: Record<string, string> = {
  init: "Check the module sources and backend settings in the infrastructure folder, and your network connection for provider downloads, then try again.",
  validate: "Fix the reported problem in the infrastructure files, then try again.",
  plan: "Read the error above; it usually names the file and setting to fix. Then create the plan again.",
  show: "Create the plan again; the saved plan file may be damaged or from another engine version.",
  apply: "Read the error above, fix the cause, then create a new plan and approve it again.",
  output: "Run the apply first; outputs exist only after a successful apply.",
};

class Engine implements IacEngine {
  readonly info: IacEngineInfo;
  private readonly runner: CommandRunner;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly redactor: Redactor;
  private readonly now: () => Date;
  private readonly label: string;

  constructor(info: IacEngineInfo, options: EngineOptions) {
    this.info = { ...info };
    this.runner = options.runner;
    this.baseEnv = options.env ?? process.env;
    this.redactor = options.redactor ?? new Redactor();
    this.now = options.now ?? (() => new Date());
    this.label = engineLabel(info.name);
  }

  async init(dir: string, options: IacInitOptions = {}): Promise<void> {
    const args = ["init", "-input=false", "-no-color"];
    if (options.upgrade) args.push("-upgrade");
    for (const [key, value] of Object.entries(options.backendConfig ?? {})) {
      args.push(`-backend-config=${key}=${value}`);
    }
    const result = await this.exec("init", path.resolve(dir), args, options);
    this.assertOk("init", result);
  }

  async validate(dir: string, options: IacRunOptions = {}): Promise<IacValidation> {
    const result = await this.exec(
      "validate",
      path.resolve(dir),
      ["validate", "-json", "-no-color"],
      options,
    );
    if (result.timedOut) throw this.failure("validate", result, options.timeoutMs);
    let parsed: unknown;
    try {
      // validate prints JSON (exit code 1) even when the configuration is invalid.
      parsed = JSON.parse(result.stdout);
    } catch {
      throw this.failure("validate", result, options.timeoutMs);
    }
    const record = (parsed ?? {}) as { valid?: unknown; diagnostics?: unknown };
    const diagnostics: IacDiagnostic[] = [];
    for (const raw of Array.isArray(record.diagnostics) ? record.diagnostics : []) {
      const d = (raw ?? {}) as {
        severity?: unknown;
        summary?: unknown;
        detail?: unknown;
        range?: { filename?: unknown; start?: { line?: unknown } };
      };
      const diagnostic: IacDiagnostic = {
        severity: d.severity === "warning" ? "warning" : "error",
        summary: this.redactor.redact(
          typeof d.summary === "string" ? d.summary : "Unknown problem",
        ),
      };
      if (typeof d.detail === "string" && d.detail !== "")
        diagnostic.detail = this.redactor.redact(d.detail);
      if (typeof d.range?.filename === "string") diagnostic.file = d.range.filename;
      if (typeof d.range?.start?.line === "number") diagnostic.line = d.range.start.line;
      diagnostics.push(diagnostic);
    }
    const valid = record.valid === true && !diagnostics.some((d) => d.severity === "error");
    return { valid, diagnostics };
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean } = {},
  ): Promise<PlanSummary> {
    const cwd = path.resolve(dir);
    const file = path.resolve(cwd, planFile);
    await mkdir(path.dirname(file), { recursive: true });
    // A failed plan must never leave an older plan file behind under the same name.
    await rm(file, { force: true });

    const args = ["plan", "-input=false", "-no-color", `-out=${file}`, "-detailed-exitcode"];
    if (options.destroy) args.push("-destroy");
    args.push(...this.varArgs(options.vars));
    const result = await this.exec("plan", cwd, args, options);
    // -detailed-exitcode: 0 = no changes, 2 = changes, anything else is an error.
    if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 2)) {
      throw this.failure("plan", result, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    }

    const bytes = await readFile(file);
    const planHash = hashBytes(bytes);
    const planJson = await this.show(cwd, file, options);
    const parsed = parsePlanJson(planJson);
    return {
      engine: { ...this.info },
      dir: cwd,
      planFile: file,
      planHash,
      createdAt: this.now().toISOString(),
      changes: parsed.changes,
      counts: parsed.counts,
      hasDestroy: parsed.hasDestroy,
      planJson,
    };
  }

  async apply(
    dir: string,
    planFile: string,
    approval: IacApproval,
    options: IacRunOptions = {},
  ): Promise<IacApplyResult> {
    const cwd = path.resolve(dir);
    const file = path.resolve(cwd, planFile);
    const approved = approval.approvedPlanHash?.trim() ?? "";
    if (!SHA256_HEX.test(approved)) {
      throw new OpsCrewError(
        "PLAN_NOT_APPROVED",
        "This plan has no valid approval, so nothing was applied.",
        {
          hint: "Review the plan and approve it; the approval records the plan's SHA-256 hash.",
        },
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (error) {
      throw new OpsCrewError(
        "ARTIFACT_MISSING",
        `The saved plan file ${file} could not be read, so nothing was applied.`,
        {
          hint: "Create the plan again and approve the new plan.",
          cause: error,
        },
      );
    }
    const actual = hashBytes(bytes);
    if (actual !== approved.toLowerCase()) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The plan changed since it was approved (approved ${approved.toLowerCase().slice(0, 12)}…, now ${actual.slice(0, 12)}…). Nothing was applied.`,
        { hint: "Create the plan again, review it and approve the new plan." },
      );
    }

    // Apply a private copy of the verified bytes so the file cannot change between the hash
    // check, the destroy check and the apply.
    const scratch = await mkdtemp(path.join(tmpdir(), "opscrew-plan-"));
    const copy = path.join(scratch, path.basename(file));
    try {
      await writeFile(copy, bytes, { mode: 0o600 });
      const parsed = parsePlanJson(await this.show(cwd, copy, options));
      if (parsed.hasDestroy && approval.allowDestroy !== true) {
        const affected = parsed.changes
          .filter((c) => c.action === "delete" || c.action === "replace")
          .map((c) => `${c.address} (${c.action})`);
        throw new OpsCrewError(
          "DESTROY_NOT_APPROVED",
          `This plan deletes or replaces resources, which was not approved: ${affected.join(", ")}. Nothing was applied.`,
          {
            hint: "Review the plan. If the deletion is intended, approve it again with destroy allowed and type the resource name to confirm.",
          },
        );
      }

      const timeoutMs = options.timeoutMs ?? APPLY_TIMEOUT_MS;
      const result = await this.exec("apply", cwd, ["apply", "-input=false", "-no-color", copy], {
        ...options,
        timeoutMs,
      });
      const log = this.redactor.redact(
        [result.stdout, result.stderr].filter((s) => s !== "").join("\n"),
      );
      if (result.timedOut || result.exitCode !== 0) {
        const reason = result.timedOut
          ? `timed out after ${minutes(timeoutMs)}`
          : `failed (exit code ${result.exitCode})`;
        return { ok: false, outputs: {}, log: `${log}\n${this.label} apply ${reason}.`.trim() };
      }
      return { ok: true, outputs: await this.output(cwd, options), log };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async output(dir: string, options: IacRunOptions = {}): Promise<Record<string, unknown>> {
    const result = await this.exec(
      "output",
      path.resolve(dir),
      ["output", "-json", "-no-color"],
      options,
    );
    this.assertOk("output", result, options.timeoutMs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim() === "" ? "{}" : result.stdout);
    } catch {
      throw new OpsCrewError(
        "ENGINE_FAILED",
        `${this.label} printed outputs that could not be read.`,
        {
          hint: HINTS.output,
        },
      );
    }
    const outputs: Record<string, unknown> = {};
    if (typeof parsed === "object" && parsed !== null) {
      for (const [name, entry] of Object.entries(parsed)) {
        outputs[name] = (entry as { value?: unknown } | null)?.value;
      }
    }
    return outputs;
  }

  /** Runs `show -json <planFile>` and returns the parsed plan. */
  private async show(cwd: string, file: string, options: IacRunOptions): Promise<unknown> {
    const result = await this.exec("show", cwd, ["show", "-json", "-no-color", file], options);
    this.assertOk("show", result, options.timeoutMs);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new OpsCrewError(
        "ENGINE_FAILED",
        `${this.label} printed a plan that could not be read.`,
        {
          hint: HINTS.show,
        },
      );
    }
  }

  private varArgs(vars: Record<string, string> | undefined): string[] {
    const args: string[] = [];
    for (const [name, value] of Object.entries(vars ?? {})) {
      if (!VAR_NAME.test(name)) {
        throw new OpsCrewError("INVALID_INPUT", `"${name}" is not a valid input variable name.`, {
          hint: "Use letters, digits, underscores and dashes, starting with a letter or underscore.",
        });
      }
      args.push("-var", `${name}=${value}`);
    }
    return args;
  }

  private environment(
    extra: Record<string, string | undefined> | undefined,
  ): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...this.baseEnv,
      ...extra,
      ...AUTOMATION_ENV,
    };
    // OpenTofu-only setting; Terraform never needs to see the passphrase.
    if (this.info.name === "terraform") {
      for (const key of Object.keys(env))
        if (key.toUpperCase() === "TF_ENCRYPTION") delete env[key];
    }
    registerEnvSecrets(this.redactor, env);
    for (const [key, value] of Object.entries(env)) {
      if (key.toUpperCase() === "TF_ENCRYPTION" && value) {
        for (const secret of encryptionSecrets(value))
          this.redactor.addLiteral(secret, "TF_ENCRYPTION");
      }
    }
    return env;
  }

  private async exec(
    step: string,
    cwd: string,
    args: string[],
    options: IacRunOptions,
  ): Promise<CommandResult> {
    const { onOutput } = options;
    try {
      return await this.runner.run(this.info.binary, args, {
        cwd,
        env: this.environment(options.env),
        timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(onOutput
          ? {
              onLine: (line: string) => {
                onOutput(this.redactor.redact(line));
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (isUserFacingError(error)) {
        throw new OpsCrewError(
          "ENGINE_NOT_FOUND",
          `Could not run ${this.label} at ${this.info.binary} for ${step}: ${this.redactor.redact(error.message)}`,
          {
            hint: `Check that ${this.label} is installed and runnable, then try again.`,
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  private assertOk(
    step: string,
    result: CommandResult,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): void {
    if (result.timedOut || result.exitCode !== 0) throw this.failure(step, result, timeoutMs);
  }

  private failure(
    step: string,
    result: CommandResult,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): OpsCrewError {
    const output = this.redactor.redact(
      tail(result.stderr.trim() !== "" ? result.stderr : result.stdout),
    );
    const what = result.timedOut
      ? `timed out after ${minutes(timeoutMs)}`
      : `failed (exit code ${result.exitCode})`;
    const message = `${this.label} ${step} ${what}.${output ? `\n${output}` : ""}`;
    return new OpsCrewError("ENGINE_FAILED", message, {
      hint: HINTS[step] ?? "Fix the problem above, then try again.",
    });
  }
}

/** Creates the `IacEngine` for a detected binary. All engine commands run through `runner`. */
export function createEngine(info: IacEngineInfo, options: EngineOptions): IacEngine {
  return new Engine(info, options);
}
