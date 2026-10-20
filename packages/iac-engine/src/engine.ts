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
import {
  durationText,
  isUserFacingError,
  OpsCrewError,
  Redactor,
  registerEnvSecrets,
  sha256Hex,
  zodIssues,
} from "@opscrew/core";
import { z } from "zod";
import { encryptionSecrets } from "./encryption";
import { parsePlanJson } from "./plan-json";
import { managedAddresses } from "./state-resources";

/** Default timeout for `apply`: 30 minutes. */
export const APPLY_TIMEOUT_MS = 30 * 60_000;
/** Default timeout for every other command: 10 minutes. */
export const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Output limit for `providers schema -json`: the `aws` provider's schema alone is 19.6 MB. */
const SCHEMA_OUTPUT_BYTES = 128 * 1024 * 1024;
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

/** The parts of `validate -json` read here; every other field passes through unread. */
const ValidateJsonSchema = z.looseObject({
  valid: z.boolean(),
  diagnostics: z.array(
    z.looseObject({
      severity: z.string(),
      summary: z.string(),
      detail: z.string().optional(),
      range: z
        .looseObject({ filename: z.string(), start: z.looseObject({ line: z.number() }) })
        .optional(),
    }),
  ),
});

/** The part of `output -json` read here: each output's value. */
const OutputJsonSchema = z.record(z.string(), z.looseObject({ value: z.unknown().optional() }));

const HINTS: Record<string, string> = {
  init: "Check the module sources and backend settings in the infrastructure folder, and your network connection for provider downloads, then try again.",
  validate: "Fix the reported problem in the infrastructure files, then try again.",
  plan: "Read the error above; it usually names the file and setting to fix. Then create the plan again.",
  show: "Create the plan again; the saved plan file may be damaged or from another engine version.",
  apply: "Read the error above, fix the cause, then create a new plan and approve it again.",
  output: "Run the apply first; outputs exist only after a successful apply.",
  "providers schema":
    "Run init again in the infrastructure folder so the providers are installed, then try again.",
  "state list":
    "Check that the state file exists and, for OpenTofu state encryption, that the state passphrase on this computer is the one that encrypted it.",
  untaint:
    "Run init again in the infrastructure folder and check, for OpenTofu state encryption, that the state passphrase on this computer is the one that encrypted it, then try again.",
};

class Engine implements IacEngine {
  readonly info: IacEngineInfo;
  private readonly runner: CommandRunner;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly redactor: Redactor;
  private readonly now: () => Date;
  private readonly label: string;
  /** Parsed `providers schema -json` per resolved directory. */
  private readonly schemas = new Map<string, unknown>();

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
    let json: unknown;
    try {
      // validate prints JSON (exit code 1) even when the configuration is invalid.
      json = JSON.parse(result.stdout);
    } catch {
      throw this.failure("validate", result, options.timeoutMs);
    }
    const parsed = ValidateJsonSchema.safeParse(json);
    if (!parsed.success) throw this.unreadable("validation results", parsed.error);
    const diagnostics = parsed.data.diagnostics.map((d) => {
      const diagnostic: IacDiagnostic = {
        severity: d.severity === "warning" ? "warning" : "error",
        summary: this.redactor.redact(d.summary),
      };
      if (d.detail) diagnostic.detail = this.redactor.redact(d.detail);
      if (d.range) {
        diagnostic.file = d.range.filename;
        diagnostic.line = d.range.start.line;
      }
      return diagnostic;
    });
    const valid = parsed.data.valid && !diagnostics.some((d) => d.severity === "error");
    return { valid, diagnostics };
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean; refreshOnly?: boolean } = {},
  ): Promise<PlanSummary> {
    if (options.refreshOnly && options.destroy) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "A plan cannot both check for drift (refresh only) and destroy resources.",
        { hint: "Create the drift check and the destroy plan separately." },
      );
    }
    const cwd = path.resolve(dir);
    const file = path.resolve(cwd, planFile);
    await mkdir(path.dirname(file), { recursive: true });
    // A failed plan must never leave an older plan file behind under the same name.
    await rm(file, { force: true });

    const args = ["plan", "-input=false", "-no-color", `-out=${file}`, "-detailed-exitcode"];
    if (options.destroy) args.push("-destroy");
    if (options.refreshOnly) args.push("-refresh-only");
    args.push(...this.varArgs(options.vars));
    const result = await this.exec("plan", cwd, args, options);
    // -detailed-exitcode: 0 = no changes, 2 = changes, anything else is an error.
    if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 2)) {
      throw this.failure("plan", result, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    }

    const bytes = await readFile(file);
    const planHash = sha256Hex(bytes);
    const planJson = await this.show(cwd, file, options);
    const parsed = parsePlanJson(planJson);
    // A refresh-only plan only updates the state, so it never carries resource changes.
    const refreshOnly = options.refreshOnly === true;
    return {
      engine: { ...this.info },
      dir: cwd,
      planFile: file,
      planHash,
      createdAt: this.now().toISOString(),
      changes: refreshOnly ? [] : parsed.changes,
      counts: refreshOnly ? { create: 0, update: 0, delete: 0, replace: 0 } : parsed.counts,
      hasDestroy: refreshOnly ? false : parsed.hasDestroy,
      planJson,
      ...(parsed.drift ? { drift: parsed.drift } : {}),
      ...(parsed.moves && !refreshOnly ? { moves: parsed.moves } : {}),
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
    const actual = sha256Hex(bytes);
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
          ? `timed out after ${durationText(timeoutMs)}`
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
    const json = this.#parseJson(
      result.stdout.trim() === "" ? "{}" : result.stdout,
      "outputs",
      HINTS.output,
    );
    const parsed = OutputJsonSchema.safeParse(json);
    if (!parsed.success) throw this.unreadable("outputs", parsed.error);
    return Object.fromEntries(
      Object.entries(parsed.data).map(([name, entry]) => [name, entry.value]),
    );
  }

  async providerSchemas(dir: string, options: IacRunOptions = {}): Promise<unknown> {
    const cwd = path.resolve(dir);
    if (this.schemas.has(cwd)) return this.schemas.get(cwd);
    const step = "providers schema";
    const result = await this.exec(
      step,
      cwd,
      ["providers", "schema", "-json"],
      options,
      SCHEMA_OUTPUT_BYTES,
    );
    this.assertOk(step, result, options.timeoutMs);
    const parsed = this.#parseJson(result.stdout, "provider schemas", HINTS[step]);
    this.schemas.set(cwd, parsed);
    return parsed;
  }

  async stateResources(stateFile: string, options: IacRunOptions = {}): Promise<string[]> {
    const file = path.resolve(stateFile);
    // An empty folder: no configuration, `.terraform` or lock file of a project can interfere.
    const scratch = await mkdtemp(path.join(tmpdir(), "opscrew-state-"));
    try {
      const step = "state list";
      const result = await this.exec(
        step,
        scratch,
        ["state", "list", "-no-color", `-state=${file}`],
        options,
      );
      this.assertOk(step, result, options.timeoutMs);
      return managedAddresses(result.stdout);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async untaint(dir: string, address: string, options: IacRunOptions = {}): Promise<void> {
    const result = await this.exec(
      "untaint",
      path.resolve(dir),
      ["untaint", "-allow-missing", "-no-color", address],
      options,
    );
    this.assertOk("untaint", result, options.timeoutMs);
  }

  /** Runs `show -json <planFile>` and returns the parsed plan. */
  private async show(cwd: string, file: string, options: IacRunOptions): Promise<unknown> {
    const result = await this.exec("show", cwd, ["show", "-json", "-no-color", file], options);
    this.assertOk("show", result, options.timeoutMs);
    return this.#parseJson(result.stdout, "a plan", HINTS.show);
  }

  /** Parses JSON the engine printed; text that is not JSON throws `ENGINE_FAILED` naming `what`. */
  #parseJson(text: string, what: string, hint: string | undefined): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new OpsCrewError(
        "ENGINE_FAILED",
        `${this.label} printed ${what} that could not be read.`,
        {
          hint,
        },
      );
    }
  }

  /** The error for JSON from the engine that does not have the expected shape. */
  private unreadable(what: string, error: z.ZodError): OpsCrewError {
    return new OpsCrewError(
      "ENGINE_FAILED",
      `${this.label} printed ${what} that could not be read (${zodIssues(error)}).`,
      { hint: `Check that ${this.label} is version 1.6 or newer, then try again.` },
    );
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
    maxOutputBytes?: number,
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
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
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
      ? `timed out after ${durationText(timeoutMs)}`
      : `failed (exit code ${result.exitCode})`;
    const message = `${this.label} ${step} ${what}.${output ? `\n${output}` : ""}`;
    return new OpsCrewError("ENGINE_FAILED", message, {
      hint: HINTS[step] ?? "Fix the problem above, then try again.",
    });
  }
}

/**
 * Creates the `IacEngine` for a detected binary. All engine commands run through `runner`.
 */
export function createEngine(info: IacEngineInfo, options: EngineOptions): IacEngine {
  return new Engine(info, options);
}
