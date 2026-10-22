/**
 * `applyHostPlan`: runs an approved host plan step by step (check, record, apply, verify), with
 * SSH and firewall changes under a dead-man switch on the server. Refuses any plan whose hash is
 * not the approved one. Idempotent and resumable: steps already in place are skipped.
 */
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { canonicalJson, isPlanHash, OpsCrewError, Redactor } from "@opscrew/core";
import { z } from "zod";
import { DEFAULT_DEAD_MAN_SECONDS } from "./constants";
import {
  assumedApps,
  HOST_ADAPTER_VERSION,
  type HostRecord,
  HostRecordSchema,
  otherActiveApps,
} from "./facts";
import { claimFindings, type HostFindings, hostFindings } from "./findings";
import { hostPlanHash } from "./hash";
import { probePrivilege, readAppsScript } from "./inspect";
import { linesOf, parseAppRecords } from "./parse";
import { asDeployUser, asLogin, asRoot, type Privilege } from "./shell";
import {
  armScript,
  cancelScript,
  readRecordScript,
  runAsOf,
  type StepScripts,
  stepScripts,
  triggerScript,
  writeRecordScript,
} from "./steps";
import {
  AccessModeSchema,
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
/** GitHub's runner registration and remove tokens (29 upper-case letters and digits today). */
const RUNNER_TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;

interface Context {
  remote: RemoteExec;
  plan: HostPlan;
  privilege: Privilege | null;
  redactor: Redactor;
  secrets: { tunnelToken?: string; portainerPassword?: string };
  runnerToken: ApplyOptions["runnerToken"];
  verifyLogin: () => Promise<boolean>;
  deadManSeconds: number;
  recorder: Recorder | null;
  /** The apps whose runner was removed without GitHub unregistering it. */
  stillRegistered: string[];
  /** Written to the host record as `opscrewVersion`. */
  version: string;
  /** Clock for the host record's timestamps. */
  now: () => Date;
  /** What the user runs again once a problem is fixed, for example `opscrew provision`. */
  command: string;
  /** The findings that name `command`. */
  findings: HostFindings;
}

function nextStep(command: string): string {
  return `fix the problem on the server, then run ${command} again; steps that are already done are skipped`;
}

/** Plain detail from a failed script: its `opscrew: ` lines, else the last stderr lines. */
function detail(result: CommandResult, redactor: Redactor): string {
  if (result.timedOut) return "it took too long";
  const lines = linesOf(result.stderr);
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
        hint: `Check that the server is reachable over SSH, then ${nextStep(ctx.command)}.`,
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
      { hint: `Nothing after this step was changed. Then ${nextStep(ctx.command)}.` },
    );
  }
  return result;
}

/** The command for one of `step`'s scripts; `asDeploy`: as the deploy user (`StepScripts.asDeploy`). */
function wrap(ctx: Context, step: HostStep, script: string, asDeploy = false): string {
  if (runAsOf(step) === "login" || ctx.privilege === null) return asLogin(script);
  return asRoot(ctx.privilege, asDeploy ? asDeployUser(script) : script);
}

function wrapRoot(ctx: Context, script: string): string {
  return asRoot(ctx.privilege ?? "root", script);
}

/** `prev.<key>=<value>` lines from a check script. */
function previousValues(stdout: string): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const line of linesOf(stdout)) {
    const match = /^prev\.([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
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

  /** The apps the host record lists. */
  get apps(): readonly string[] {
    return this.record.apps;
  }

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
        const finding = ctx.findings.recordDamaged();
        throw new OpsCrewError("PHASE_PRECONDITION", finding.message, { hint: finding.hint });
      }
    }
    // The host record is shared by the apps on the server: no app owns it.
    if (record === undefined) {
      record = { schemaVersion: 1, apps: [], opscrewVersion: ctx.version, changes: [] };
    } else if (ctx.plan.purpose === "setup") {
      record = { ...record, opscrewVersion: ctx.version };
    }
    return new Recorder(ctx, record);
  }

  /** Lists `app` among the apps set up on the server, or no longer; written only on a change. */
  async list(app: string, listed: boolean): Promise<void> {
    const apps = new Set(this.record.apps);
    if (listed) apps.add(app);
    else apps.delete(app);
    const next = [...apps].sort();
    if (next.join(" ") === this.record.apps.join(" ")) return;
    this.record = { ...this.record, apps: next };
    await this.write();
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
    if (step === "app-record") return; // the record itself is gone
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

/**
 * Runs a step's apply under the dead-man switch: the undo is scheduled first, and cancelled only
 * once new logins work (`verifyLogin`); otherwise it runs now, or on the server on its own.
 */
async function guardedApply(
  ctx: Context,
  step: HostStep,
  scripts: StepScripts,
  deadMan: NonNullable<StepScripts["deadMan"]>,
  options: RunOptions,
): Promise<void> {
  const seconds = ctx.deadManSeconds;
  const what = deadMan.step === "sshd" ? "SSH settings" : "firewall settings";
  await runOk(
    ctx,
    wrap(ctx, step, armScript(deadMan, seconds)),
    { timeoutMs: 120_000 },
    `scheduling the automatic undo for the ${what}`,
  );
  try {
    await runOk(ctx, wrap(ctx, step, scripts.apply), options, scripts.doing);
  } catch (error) {
    const restored = await trigger(ctx, step, deadMan.step);
    if (error instanceof OpsCrewError) {
      throw new OpsCrewError(
        error.code,
        restored
          ? `${error.message} The previous ${what} are back.`
          : `${error.message} The server puts the previous ${what} back on its own within ${seconds} seconds.`,
        { hint: error.hint ?? nextStep(ctx.command) },
      );
    }
    throw error;
  }

  let loginsWork: boolean;
  try {
    loginsWork = await ctx.verifyLogin();
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
        hint: `Wait ${restored ? "a moment" : `${seconds} seconds`}, check that you can still log in, then ${nextStep(ctx.command)}.`,
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
      { hint: `Wait ${seconds} seconds, then ${nextStep(ctx.command)}.` },
    );
  }
  if (!cancel.stdout.includes("cancelled")) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Checking the new logins took longer than ${seconds} seconds, so the server already put the previous ${what} back.`,
      {
        hint: `Try again (a slow connection may need a longer automatic-undo delay), then ${nextStep(ctx.command)}.`,
      },
    );
  }
}

/**
 * Fetches the runner token a step needs, now that it runs. It is known to the redactor before it
 * goes anywhere, so no error or output line can carry it.
 */
async function fetchRunnerToken(ctx: Context, kind: "registration" | "remove"): Promise<string> {
  if (ctx.runnerToken === undefined) throw new Error("runnerToken is checked before any change");
  const token = await ctx.runnerToken(kind);
  ctx.redactor.addLiteral(token, "runner-token");
  if (!RUNNER_TOKEN_RE.test(token)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The runner ${kind} token from GitHub does not look like one, so OpsCrew did not send it to the server.`,
      { hint: `Run ${ctx.command} again for a fresh token.` },
    );
  }
  return token;
}

/** Runs one change step; false when the server shows it is already in place. */
async function runStep(ctx: Context, step: HostStep, scripts: StepScripts): Promise<boolean> {
  const own = (script: string) => wrap(ctx, step, script, scripts.asDeploy === true);
  const check = await runOk(
    ctx,
    own(scripts.check),
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
  const secret =
    scripts.runnerToken !== undefined
      ? await fetchRunnerToken(ctx, scripts.runnerToken)
      : scripts.secret
        ? ctx.secrets[scripts.secret.name]
        : undefined;
  const options: RunOptions =
    secret === undefined
      ? { timeoutMs: scripts.timeoutMs }
      : { timeoutMs: scripts.timeoutMs, input: `${secret}\n` };
  if (scripts.deadMan !== undefined) {
    await guardedApply(ctx, step, scripts, scripts.deadMan, options);
  } else {
    const result = await runOk(ctx, own(scripts.apply), options, scripts.doing);
    // A runner's removal says whether GitHub unregistered it.
    if (scripts.runnerToken === "remove" && /^runner\.unregistered=false$/m.test(result.stdout)) {
      ctx.stillRegistered.push(String(step.params.app));
    }
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
    own(scripts.verify),
    { timeoutMs: 120_000 },
    `checking the result of ${scripts.doing}`,
  );
  if (ctx.plan.purpose === "undo") await ctx.recorder?.undone(step.id);
  return true;
}

/**
 * Read-only, before the first change: another OpsCrew run may have changed the apps on the server
 * since the plan was made. A setup plan that records its app needs its name, hostnames and access
 * mode to still fit them (`listed`: the apps the host record lists), and every plan made for the
 * other apps as they were (`HostPlan.otherApps`) needs them unchanged, deploy keys included.
 */
async function appsCheck(ctx: Context, listed: readonly string[]): Promise<void> {
  const { plan } = ctx;
  const step = plan.steps.find((item) => item.id === "app-record" && item.state === "change");
  const claiming = plan.purpose === "setup" && step !== undefined;
  if (!claiming && plan.otherApps === undefined) return;
  const result = await runOk(
    ctx,
    wrapRoot(ctx, readAppsScript()),
    { timeoutMs: 60_000 },
    "checking the other OpsCrew apps on the server",
  );
  const apps = parseAppRecords(result.stdout);
  const found = claiming
    ? claimFindings(
        apps,
        listed,
        ClaimSchema.parse({ ...step?.params, app: plan.app }),
        ctx.findings,
      )
    : [];
  const now = assumedApps(otherActiveApps(apps, plan.app));
  if (plan.otherApps !== undefined && canonicalJson(now) !== canonicalJson(plan.otherApps)) {
    found.push(ctx.findings.appsChanged(now.map((other) => other.app)));
  }
  const [finding] = found;
  if (finding !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", finding.message, { hint: finding.hint });
  }
}

/** What an `app-record` step claims on the server (its scripts check the rest). */
const ClaimSchema = z.object({
  app: z.string(),
  projectId: z.string(),
  access: AccessModeSchema,
  hostnames: z.string().transform((text) => text.split(" ").filter((name) => name !== "")),
});

/**
 * A host apply that stopped at a failed step: `applied` lists the steps of the plan that changed
 * the server before it, in order, so callers can audit them (step ids only, never a secret).
 */
export class HostApplyError extends OpsCrewError {
  readonly applied: HostStepId[];

  constructor(
    code: OpsCrewError["code"],
    message: string,
    applied: HostStepId[],
    options?: { hint?: string; cause?: unknown },
  ) {
    super(code, message, options);
    this.name = "HostApplyError";
    this.applied = applied;
  }
}

/**
 * The error of a failed step as a {@link HostApplyError} with the steps applied before it. Its
 * cause is the failed command's (never set for a command that carried a secret on stdin).
 */
function failure(error: unknown, applied: readonly HostStepId[]): HostApplyError {
  if (error instanceof OpsCrewError) {
    return new HostApplyError(error.code, error.message, [...applied], {
      ...(error.hint !== undefined && { hint: error.hint }),
      cause: error.cause,
    });
  }
  return new HostApplyError(
    "INTERNAL",
    "OpsCrew stopped on an error it did not expect while changing the server.",
    [...applied],
    {
      hint: "Run the command again: steps that are already done are skipped. If it keeps failing, please report it to OpsCrew.",
      cause: error,
    },
  );
}

function refuse(message: string, hint: string): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", message, { hint });
}

/**
 * Applies an approved host plan. Refuses with PLAN_HASH_MISMATCH when the plan's hash is not
 * `approvedHash`, and with PHASE_PRECONDITION when it has findings or blocked steps or a secret
 * it needs is missing. When a step fails, it throws a {@link HostApplyError} whose `applied` lists
 * the steps that changed the server before it.
 * Secrets go to the server only on stdin, into root-only files or (a runner token) straight to
 * the runner's `config.sh`; they never appear in commands, records or errors. `opts.runnerToken`
 * is called only when a `github-runner` step runs. Every change is recorded in `/etc/opscrew/host.json` before it is made.
 */
export async function applyHostPlan(
  remote: RemoteExec,
  plan: HostPlan,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const parsed = HostPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new OpsCrewError("INVALID_INPUT", "The host plan is not valid.", {
      hint: `Make a fresh host plan with ${opts.command} and approve it.`,
    });
  }
  const valid = parsed.data;
  const hash = hostPlanHash(valid);
  if (!isPlanHash(opts.approvedHash) || opts.approvedHash.toLowerCase() !== hash) {
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
    if (scripts.runnerToken !== undefined && opts.runnerToken === undefined) {
      throw refuse(
        "Applying this plan needs a GitHub runner token, and no way to fetch one was supplied.",
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
    runnerToken: opts.runnerToken,
    verifyLogin: opts.verifyLogin,
    deadManSeconds,
    recorder: null,
    stillRegistered: [],
    version: opts.version ?? HOST_ADAPTER_VERSION,
    now: opts.now ?? (() => new Date()),
    command: opts.command,
    findings: hostFindings(opts.command),
  };
  const needsRoot = changes.some(({ step }) => runAsOf(step) === "root");
  if (needsRoot) {
    const privilege = await probePrivilege(remote);
    if (privilege === "sudo-password" || privilege === "none") {
      const finding =
        privilege === "sudo-password"
          ? ctx.findings.sudoNeedsPassword("this login")
          : ctx.findings.noRoot("");
      throw refuse(finding.message, finding.hint);
    }
    ctx.privilege = privilege;
    ctx.recorder = await Recorder.load(ctx);
    await appsCheck(ctx, ctx.recorder.apps);
  }

  const applied: HostStepId[] = [];
  const skipped: HostStepId[] = [];
  for (const step of valid.steps) {
    const work = changes.find((item) => item.step === step);
    if (work === undefined) {
      skipped.push(step.id);
      continue;
    }
    try {
      if (await runStep(ctx, step, work.scripts)) applied.push(step.id);
      else skipped.push(step.id);
      // The host record lists the apps set up on the server.
      if (step.id === "app-record" && valid.purpose !== "undo") {
        await ctx.recorder?.list(valid.app, valid.purpose === "setup");
      }
    } catch (error) {
      throw failure(error, applied);
    }
  }
  const { stillRegistered } = ctx;
  return stillRegistered.length > 0 ? { applied, skipped, stillRegistered } : { applied, skipped };
}
