/**
 * `applyHostPlan`: runs an approved host plan step by step (check, record, apply, verify), with
 * SSH and firewall changes under a dead-man switch on the server. Refuses any plan whose hash is
 * not the approved one. Idempotent and resumable: steps already in place are skipped.
 */
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { isPlanHash, OpsCrewError, Redactor } from "@opscrew/core";
import { DEFAULT_DEAD_MAN_SECONDS } from "./constants";
import { AppMarkerSchema, HOST_ADAPTER_VERSION, type HostRecord, HostRecordSchema } from "./facts";
import { findings } from "./findings";
import { hostPlanHash } from "./hash";
import { probePrivilege } from "./inspect";
import { asLogin, asRoot, type Privilege } from "./shell";
import {
  armScript,
  cancelScript,
  readMarkerScript,
  readRecordScript,
  runAsOf,
  type StepScripts,
  stepScripts,
  triggerScript,
  writeRecordScript,
} from "./steps";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostPlan,
  HostPlanSchema,
  type HostStep,
  type HostStepId,
} from "./types";

/**
 * Options the adapter passes to `RemoteExec.run`. `input` is written to the command's stdin and
 * is the only way secrets reach the server. A transport that dropped it would make the secret
 * steps fail with a plain message (their scripts refuse an empty stdin), never write an empty
 * secret.
 */
interface RunOptions {
  timeoutMs?: number;
  input?: string;
}

const TOKEN_RE = /^[A-Za-z0-9+/=_.-]{16,8192}$/;
const PASSWORD_RE = /^[\x20-\x7e]{12,128}$/;

interface Context {
  remote: RemoteExec;
  plan: HostPlan;
  privilege: Privilege | null;
  redactor: Redactor;
  secrets: { tunnelToken?: string; portainerPassword?: string };
  verifyLogin: () => Promise<boolean>;
  deadManSeconds: number;
  recorder: Recorder | null;
  /** Written to the host record as `opscrewVersion`. */
  version: string;
  /** Clock for the host record's timestamps. */
  now: () => Date;
}

function nextStep(plan: HostPlan): string {
  return plan.purpose === "setup"
    ? "fix the problem on the server, then run opscrew provision again; steps that are already done are skipped"
    : "fix the problem on the server, then run the command again; steps that are already done are skipped";
}

/** Plain detail from a failed script: its `opscrew: ` lines, else the last stderr lines. */
function detail(result: CommandResult, redactor: Redactor): string {
  if (result.timedOut) return "it took too long";
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const own = lines.filter((line) => line.startsWith("opscrew: ")).map((line) => line.slice(9));
  const text = own.length > 0 ? own.join(" ") : lines.slice(-3).join(" / ");
  const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  return redactor.redact(clipped || `the command exited with code ${result.exitCode}`);
}

async function run(
  ctx: Context,
  command: string,
  options: RunOptions,
  doing: string,
): Promise<CommandResult> {
  try {
    return await ctx.remote.run(command, options);
  } catch (error) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew lost the connection to the server while ${doing}.`,
      {
        hint: `Check that the server is reachable over SSH, then ${nextStep(ctx.plan)}.`,
        // Never attach the error of a command that carried a secret on stdin.
        ...(options.input === undefined ? { cause: error } : {}),
      },
    );
  }
}

async function runOk(
  ctx: Context,
  command: string,
  options: RunOptions,
  doing: string,
): Promise<CommandResult> {
  const result = await run(ctx, command, options, doing);
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew stopped while ${doing}: ${detail(result, ctx.redactor)}.`,
      { hint: `Nothing after this step was changed. Then ${nextStep(ctx.plan)}.` },
    );
  }
  return result;
}

function wrap(ctx: Context, step: HostStep, script: string): string {
  if (runAsOf(step) === "login" || ctx.privilege === null) return asLogin(script);
  return asRoot(ctx.privilege, script);
}

function wrapRoot(ctx: Context, script: string): string {
  return asRoot(ctx.privilege ?? "root", script);
}

/** `prev.<key>=<value>` lines from a check script. */
function previousValues(stdout: string): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const line of stdout.split("\n")) {
    const match = /^prev\.([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line.trim());
    if (!match?.[1]) continue;
    const value = match[2] ?? "";
    values[match[1]] = value === "true" ? true : value === "false" ? false : value;
  }
  return values;
}

/** Keeps `/etc/opscrew/host.json` up to date: each change is recorded before it is made. */
class Recorder {
  private record: HostRecord;
  private readonly ctx: Context;

  constructor(ctx: Context, record: HostRecord) {
    this.ctx = ctx;
    this.record = record;
  }

  static async load(ctx: Context): Promise<Recorder> {
    const result = await runOk(
      ctx,
      wrapRoot(ctx, readRecordScript()),
      { timeoutMs: 60_000 },
      "reading OpsCrew's record of its changes",
    );
    const text = result.stdout.trim();
    let record: HostRecord | undefined;
    if (text !== "") {
      try {
        record = HostRecordSchema.parse(JSON.parse(text));
      } catch {
        const finding = findings.recordDamaged();
        throw new OpsCrewError("PHASE_PRECONDITION", finding.message, { hint: finding.hint });
      }
    }
    const plan = ctx.plan;
    // A plan without an app-marker step (planPortainer run as root) never blanks the project id.
    const projectId =
      plan.purpose === "setup"
        ? planProjectId(plan) || (record?.projectId ?? "")
        : (record?.projectId ?? "");
    // Never take over the record of another app: its host changes are its to undo.
    if (
      record !== undefined &&
      record.app !== "" &&
      plan.app !== "" &&
      (record.app !== plan.app ||
        (projectId !== "" && record.projectId !== "" && record.projectId !== projectId))
    ) {
      const finding = findings.hostRecordOtherApp(record.app);
      throw new OpsCrewError("PHASE_PRECONDITION", finding.message, { hint: finding.hint });
    }
    if (record === undefined) {
      record = {
        schemaVersion: 1,
        app: plan.app,
        projectId,
        opscrewVersion: ctx.version,
        changes: [],
      };
    } else if (plan.purpose === "setup") {
      record = { ...record, app: plan.app, projectId, opscrewVersion: ctx.version };
    }
    return new Recorder(ctx, record);
  }

  /** Records the value a step is about to replace (the first setup change of a step only). */
  async before(step: HostStepId, previous: Record<string, string | boolean>): Promise<void> {
    const purpose = this.ctx.plan.purpose;
    if (purpose === "setup") {
      const known = this.record.changes.some(
        (entry) => entry.step === step && entry.purpose === "setup",
      );
      if (known) return;
    }
    this.record = {
      ...this.record,
      changes: [
        ...this.record.changes,
        { step, purpose, at: this.ctx.now().toISOString(), previous },
      ],
    };
    await this.write();
  }

  /** After an undo step: OpsCrew no longer owns that change. */
  async undone(step: HostStepId): Promise<void> {
    if (step === "app-marker") return; // the record itself is gone
    this.record = {
      ...this.record,
      changes: this.record.changes.filter(
        (entry) => !(entry.step === step && entry.purpose === "setup"),
      ),
    };
    await this.write();
  }

  private async write(): Promise<void> {
    await runOk(
      this.ctx,
      wrapRoot(this.ctx, writeRecordScript(JSON.stringify(this.record))),
      { timeoutMs: 60_000 },
      "recording the change in /etc/opscrew/host.json",
    );
  }
}

/** Runs the scheduled undo now; true when the server confirmed it. */
async function trigger(ctx: Context, step: HostStep, guarded: "sshd" | "ufw"): Promise<boolean> {
  try {
    const result = await ctx.remote.run(wrap(ctx, step, triggerScript(guarded)), {
      timeoutMs: 120_000,
    });
    return result.exitCode === 0 && result.stdout.includes("restored");
  } catch {
    return false;
  }
}

async function guardedApply(
  ctx: Context,
  step: HostStep,
  scripts: StepScripts,
  input: string | undefined,
): Promise<void> {
  const deadMan = scripts.deadMan;
  if (deadMan === undefined) throw new Error("guardedApply needs a dead-man step");
  const seconds = ctx.deadManSeconds;
  const what = deadMan.step === "sshd" ? "SSH settings" : "firewall settings";
  await runOk(
    ctx,
    wrap(ctx, step, armScript(deadMan, seconds)),
    { timeoutMs: 120_000 },
    `scheduling the automatic undo for the ${what}`,
  );
  try {
    await runOk(
      ctx,
      wrap(ctx, step, scripts.apply),
      input === undefined
        ? { timeoutMs: scripts.timeoutMs }
        : { timeoutMs: scripts.timeoutMs, input },
      scripts.doing,
    );
  } catch (error) {
    const restored = await trigger(ctx, step, deadMan.step);
    if (error instanceof OpsCrewError) {
      throw new OpsCrewError(
        error.code,
        restored
          ? `${error.message} The previous ${what} are back.`
          : `${error.message} The server puts the previous ${what} back on its own within ${seconds} seconds.`,
        { hint: error.hint ?? nextStep(ctx.plan) },
      );
    }
    throw error;
  }

  let loginsWork = false;
  try {
    loginsWork = (await ctx.verifyLogin()) === true;
  } catch {
    loginsWork = false;
  }
  if (!loginsWork) {
    const restored = await trigger(ctx, step, deadMan.step);
    throw new OpsCrewError(
      "COMMAND_FAILED",
      restored
        ? `New SSH logins (as deploy and as your own login) did not work after ${scripts.doing}, so OpsCrew put the previous ${what} back.`
        : `New SSH logins (as deploy and as your own login) did not work after ${scripts.doing}, and OpsCrew could not reach the server to undo it right away. The server puts the previous ${what} back on its own within ${seconds} seconds.`,
      {
        hint: `Wait ${restored ? "a moment" : `${seconds} seconds`}, check that you can still log in, then ${nextStep(ctx.plan)}.`,
      },
    );
  }

  let cancel: CommandResult | undefined;
  try {
    // Longer than the cancel's own wait for a running undo (flock -w 80).
    cancel = await ctx.remote.run(wrap(ctx, step, cancelScript(deadMan.step)), {
      timeoutMs: 90_000,
    });
  } catch {
    cancel = undefined;
  }
  if (cancel === undefined || cancel.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not cancel the automatic undo after ${scripts.doing}, so the server puts the previous ${what} back on its own within ${seconds} seconds.`,
      { hint: `Wait ${seconds} seconds, then ${nextStep(ctx.plan)}.` },
    );
  }
  if (!cancel.stdout.includes("cancelled")) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Checking the new logins took longer than ${seconds} seconds, so the server already put the previous ${what} back.`,
      {
        hint: `Try again (a slow connection may need a longer automatic-undo delay), then ${nextStep(ctx.plan)}.`,
      },
    );
  }
}

/** Runs one change step; false when the server shows it is already in place. */
async function runStep(ctx: Context, step: HostStep, scripts: StepScripts): Promise<boolean> {
  const check = await runOk(
    ctx,
    wrap(ctx, step, scripts.check),
    { timeoutMs: 120_000 },
    `checking "${step.title}"`,
  );
  if (/^state=in-place$/m.test(check.stdout)) return false;

  await ctx.recorder?.before(step.id, previousValues(check.stdout));

  if (scripts.preApply !== undefined) {
    await runOk(
      ctx,
      wrap(ctx, step, scripts.preApply),
      { timeoutMs: scripts.timeoutMs },
      scripts.doing,
    );
  }
  const secret = scripts.secret ? ctx.secrets[scripts.secret.name] : undefined;
  const input = secret === undefined ? undefined : `${secret}\n`;
  if (scripts.deadMan !== undefined) {
    await guardedApply(ctx, step, scripts, input);
  } else {
    await runOk(
      ctx,
      wrap(ctx, step, scripts.apply),
      input === undefined
        ? { timeoutMs: scripts.timeoutMs }
        : { timeoutMs: scripts.timeoutMs, input },
      scripts.doing,
    );
  }
  if (scripts.postApply !== undefined) {
    await runOk(
      ctx,
      wrap(ctx, step, scripts.postApply),
      { timeoutMs: scripts.timeoutMs },
      scripts.doing,
    );
  }
  await runOk(
    ctx,
    wrap(ctx, step, scripts.verify),
    { timeoutMs: 120_000 },
    `checking the result of ${scripts.doing}`,
  );
  if (ctx.plan.purpose === "undo") await ctx.recorder?.undone(step.id);
  return true;
}

/** The project id a setup plan binds the server to (from its app-marker step). */
function planProjectId(plan: HostPlan): string {
  const marker = plan.steps.find((step) => step.id === "app-marker");
  return typeof marker?.params.projectId === "string" ? marker.params.projectId : "";
}

/**
 * Read-only, before the first change of a setup plan: the server must not belong to another app
 * (another OpsCrew run may have claimed it since the plan was made).
 */
async function claimCheck(ctx: Context): Promise<void> {
  const result = await runOk(
    ctx,
    wrapRoot(ctx, readMarkerScript()),
    { timeoutMs: 60_000 },
    "checking which app the server belongs to",
  );
  const text = result.stdout.trim();
  if (text === "") return;
  let marker: { app: string; projectId: string } | undefined;
  try {
    marker = AppMarkerSchema.parse(JSON.parse(text));
  } catch {
    const finding = findings.markerDamaged();
    throw new OpsCrewError("PHASE_PRECONDITION", finding.message, { hint: finding.hint });
  }
  const projectId = planProjectId(ctx.plan);
  if (marker.app === ctx.plan.app && (projectId === "" || marker.projectId === projectId)) return;
  const finding =
    marker.app === ctx.plan.app
      ? findings.sameAppOtherProject(marker.app, marker.projectId)
      : findings.anotherApp(marker.app);
  throw new OpsCrewError("PHASE_PRECONDITION", finding.message, { hint: finding.hint });
}

function refuse(message: string, hint: string): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", message, { hint });
}

/**
 * Applies an approved host plan. Refuses with PLAN_HASH_MISMATCH when the plan's hash is not
 * `approvedHash`, and with PHASE_PRECONDITION when it has findings or blocked steps or a secret
 * it needs is missing.
 * Secrets go to the server only on stdin, into root-only files; they never appear in commands,
 * records or errors. Every change is recorded in `/etc/opscrew/host.json` before it is made.
 */
export async function applyHostPlan(
  remote: RemoteExec,
  plan: HostPlan,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const parsed = HostPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new OpsCrewError("INVALID_INPUT", "The host plan is not valid.", {
      hint: "Make a fresh host plan with opscrew provision and approve it.",
    });
  }
  const valid = parsed.data;
  const hash = hostPlanHash(valid);
  if (!isPlanHash(opts?.approvedHash) || opts.approvedHash.toLowerCase() !== hash) {
    // Same code as the IaC engine's hash-bound apply.
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This host plan is not the one that was approved, so OpsCrew changes nothing.",
      { hint: "Look at the current host plan and approve it by its hash." },
    );
  }
  if (opts.version !== undefined && !/^[0-9A-Za-z.+-]{1,64}$/.test(opts.version)) {
    throw new OpsCrewError("INVALID_INPUT", "The OpsCrew version must be a version string.");
  }
  if (valid.findings.length > 0) {
    throw refuse(
      `OpsCrew cannot change this server yet: ${valid.findings.map((finding) => finding.message).join(" ")}`,
      valid.findings.map((finding) => finding.hint).join(" "),
    );
  }
  const blocked = valid.steps.filter((step) => step.state === "blocked");
  if (blocked.length > 0) {
    throw refuse(
      `The host plan has blocked steps (${blocked.map((step) => step.id).join(", ")}), so OpsCrew changes nothing.`,
      "Resolve what blocks them, then make and approve a fresh host plan.",
    );
  }
  if (typeof opts.verifyLogin !== "function") {
    throw new OpsCrewError("INVALID_INPUT", "verifyLogin is required to apply a host plan.");
  }
  const deadManSeconds = opts.deadManSeconds ?? DEFAULT_DEAD_MAN_SECONDS;
  if (!Number.isInteger(deadManSeconds) || deadManSeconds < 30 || deadManSeconds > 3600) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "deadManSeconds must be a whole number from 30 to 3600.",
    );
  }

  const redactor = new Redactor();
  const secrets = opts.secrets ?? {};
  if (secrets.tunnelToken !== undefined) {
    redactor.addLiteral(secrets.tunnelToken, "tunnel-token");
    if (!TOKEN_RE.test(secrets.tunnelToken)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "The tunnel token does not look like a Cloudflare Tunnel token.",
        {
          hint: "Read the token again from the tunnel's IaC output.",
        },
      );
    }
  }
  if (secrets.portainerPassword !== undefined) {
    redactor.addLiteral(secrets.portainerPassword, "portainer-password");
    if (!PASSWORD_RE.test(secrets.portainerPassword)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "The Portainer password must be 12 to 128 printable characters on one line.",
      );
    }
  }

  // Build every script first: bad parameters fail before anything changes.
  const changes = valid.steps
    .filter((step) => step.state === "change")
    .map((step) => ({ step, scripts: stepScripts(valid, step) }));
  for (const { scripts } of changes) {
    if (scripts.secret?.required && secrets[scripts.secret.name] === undefined) {
      throw refuse(
        scripts.secret.name === "tunnelToken"
          ? "Applying this plan needs the tunnel token, and none was supplied."
          : "Applying this plan needs the Portainer admin password, and none was supplied.",
        "Supply it at apply time; it is never part of the plan.",
      );
    }
  }

  const ctx: Context = {
    remote,
    plan: valid,
    privilege: null,
    redactor,
    secrets,
    verifyLogin: opts.verifyLogin,
    deadManSeconds,
    recorder: null,
    version: opts.version ?? HOST_ADAPTER_VERSION,
    now: opts.now ?? (() => new Date()),
  };
  const needsRoot = changes.some(({ step }) => runAsOf(step) === "root");
  if (needsRoot) {
    const privilege = await probePrivilege(remote);
    if (privilege === "sudo-password" || privilege === "none") {
      const finding =
        privilege === "sudo-password"
          ? findings.sudoNeedsPassword("this login")
          : findings.noRoot("");
      throw refuse(finding.message, finding.hint);
    }
    ctx.privilege = privilege;
    if (valid.purpose === "setup") await claimCheck(ctx);
    ctx.recorder = await Recorder.load(ctx);
  }

  const applied: HostStepId[] = [];
  const skipped: HostStepId[] = [];
  for (const step of valid.steps) {
    const work = changes.find((item) => item.step === step);
    if (work === undefined) {
      skipped.push(step.id);
      continue;
    }
    if (await runStep(ctx, step, work.scripts)) applied.push(step.id);
    else skipped.push(step.id);
  }
  return { applied, skipped };
}
