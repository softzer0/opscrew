import { userInfo } from "node:os";
import { confirm, isCancel, text } from "@clack/prompts";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  Clock,
  CommandRunner,
  Money,
} from "@opscrew/contracts";
import { isPlanHash, NodeCommandRunner } from "@opscrew/core";
import type { CliContext } from "./context";

const systemClock: Clock = { now: () => new Date() };

/** The terminal prompts the interactive handler uses; replaced by fakes in tests. */
export interface ApprovalPrompts {
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
  text(options: { message: string; placeholder?: string }): Promise<string | symbol>;
  isCancel(value: unknown): value is symbol;
}

const clackPrompts: ApprovalPrompts = { confirm, text, isCancel };

export interface InteractiveApprovalHandlerOptions {
  /** Where the request summary is printed (already redacted by the context). */
  stdout(text: string): void;
  /** Runs `git config user.name` to name the approver. Defaults to `NodeCommandRunner`. */
  runner?: CommandRunner;
  cwd?: string;
  prompts?: ApprovalPrompts;
  clock?: Clock;
  /** Fallback approver name when git has none. Defaults to the OS user name. */
  osUserName?: () => string;
}

/**
 * Asks a human in the terminal. Prints the title, details, failed policy checks and cost change,
 * then asks yes/no, or asks the user to type `confirmPhrase` exactly when one is set.
 */
export class InteractiveApprovalHandler implements ApprovalHandler {
  private readonly prompts: ApprovalPrompts;
  private readonly runner: CommandRunner;
  private readonly clock: Clock;
  private approver: string | undefined;

  constructor(private readonly options: InteractiveApprovalHandlerOptions) {
    this.prompts = options.prompts ?? clackPrompts;
    this.runner = options.runner ?? new NodeCommandRunner({ defaultTimeoutMs: 10_000 });
    this.clock = options.clock ?? systemClock;
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.options.stdout(formatRequest(request));
    const approver = await this.approverName();
    const decide = (approved: boolean, extra: Partial<ApprovalDecision> = {}) => ({
      approved,
      approver,
      decidedAt: this.clock.now().toISOString(),
      ...extra,
    });

    if (request.confirmPhrase !== undefined) {
      const answer = await this.prompts.text({
        message: `Type "${request.confirmPhrase}" to approve, or anything else to cancel`,
        placeholder: request.confirmPhrase,
      });
      if (this.prompts.isCancel(answer)) return decide(false, { reason: "cancelled by the user" });
      const typed = answer.trim();
      if (typed !== request.confirmPhrase) {
        return decide(false, {
          confirmation: typed,
          reason: "confirmation phrase did not match",
        });
      }
      return decide(true, { confirmation: typed });
    }

    const answer = await this.prompts.confirm({
      message: "Approve this change?",
      initialValue: false,
    });
    if (this.prompts.isCancel(answer)) return decide(false, { reason: "cancelled by the user" });
    return answer === true ? decide(true) : decide(false, { reason: "declined by the user" });
  }

  /** `git config user.name`, falling back to the OS user name; cached after the first call. */
  private async approverName(): Promise<string> {
    if (this.approver !== undefined) return this.approver;
    let name = "";
    try {
      const result = await this.runner.run("git", ["config", "user.name"], {
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      });
      if (result.exitCode === 0) name = result.stdout.trim();
    } catch {
      // git is not installed; fall back to the OS user.
    }
    if (name === "") name = (this.options.osUserName ?? osUserName)();
    this.approver = name;
    return name;
  }
}

function osUserName(): string {
  try {
    return userInfo().username || "unknown user";
  } catch {
    return "unknown user";
  }
}

/** The text shown before asking: title, details, failed policy checks and monthly cost change. */
export function formatRequest(request: ApprovalRequest): string {
  const lines = ["", request.title, ""];
  if (request.details.trim() !== "") lines.push(request.details.trimEnd(), "");
  const failures = (request.policy ?? []).filter((result) => !result.passed);
  if (failures.length > 0) {
    lines.push("Policy checks that did not pass:");
    for (const f of failures) {
      const where = f.resource === undefined ? "" : ` (${f.resource})`;
      lines.push(`  ✗ [${f.severity}] ${f.title}${where}: ${f.message}`);
    }
    lines.push("");
  }
  if (request.costDelta !== undefined) {
    lines.push(`Monthly cost change: ${formatMoneyDelta(request.costDelta)}`, "");
  }
  if (request.allowDestroy === true) {
    lines.push("This change deletes or replaces resources.", "");
  }
  return `${lines.join("\n")}\n`;
}

/** Signed amount with currency, for example `+€4.51` or `-$2.00`. */
export function formatMoneyDelta(money: Money): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
    signDisplay: "always",
  }).format(money.amount);
}

export interface NonInteractiveApprovalHandlerOptions {
  /** Plan hash passed with `--approve <hash>`. */
  approvePlanHash?: string;
  /**
   * `--yes`: also approve the non-infrastructure steps of a run (writing generated files, storing
   * GitHub secrets, pushing, opening a pull request). Never infrastructure applies (those need
   * `--approve <hash>`), destroys, changed host keys or agent tool calls.
   */
  assumeYes?: boolean;
  /** Recorded as the approver, for example `--approve flag`. */
  approver: string;
  clock?: Clock;
}

/** Request kinds `--yes` may approve without a human. */
export const ASSUME_YES_KINDS: readonly ApprovalRequest["kind"][] = [
  "repo-write",
  "github-secrets",
  "git-push",
  "pull-request",
];

const RUN_INTERACTIVELY =
  "Run the command in an interactive terminal to review and approve it, or pass --approve <hash> with the hash of the plan you reviewed.";

/**
 * Approves without a human only when the user named the exact plan: an `iac-apply` whose
 * `planHash` equals `--approve <hash>` (case-insensitive) and that destroys nothing. Everything
 * else is refused with a reason that says how to approve it.
 */
export class NonInteractiveApprovalHandler implements ApprovalHandler {
  private readonly clock: Clock;

  constructor(private readonly options: NonInteractiveApprovalHandlerOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const reason = this.refusalReason(request);
    const decision: ApprovalDecision = {
      approved: reason === undefined,
      approver: this.options.approver,
      decidedAt: this.clock.now().toISOString(),
    };
    if (reason !== undefined) decision.reason = reason;
    return decision;
  }

  private refusalReason(request: ApprovalRequest): string | undefined {
    if (
      this.options.assumeYes === true &&
      ASSUME_YES_KINDS.includes(request.kind) &&
      request.allowDestroy !== true &&
      request.confirmPhrase === undefined
    ) {
      return undefined;
    }
    if (request.kind !== "iac-apply") {
      return `"${request.title}" needs a human approval and this run is not interactive. ${RUN_INTERACTIVELY}`;
    }
    if (request.allowDestroy === true) {
      return "This plan deletes or replaces resources, which needs a typed confirmation. Run the command in an interactive terminal to approve it.";
    }
    const approve = this.options.approvePlanHash;
    if (approve === undefined || approve === "") {
      return `No plan hash was approved for this non-interactive run. ${RUN_INTERACTIVELY}`;
    }
    if (!isPlanHash(approve)) {
      return `--approve expects the 64-character SHA-256 hash of the plan. ${RUN_INTERACTIVELY}`;
    }
    if (!isPlanHash(request.planHash) || request.planHash.toLowerCase() !== approve.toLowerCase()) {
      return `The plan hash does not match --approve ${approve}; the plan changed since you reviewed it. ${RUN_INTERACTIVELY}`;
    }
    return undefined;
  }
}

/** Picks the interactive handler on a TTY, otherwise the `--approve <hash>` handler. */
export function createApprovalHandler(
  ctx: CliContext,
  options: { approvePlanHash?: string; assumeYes?: boolean } = {},
): ApprovalHandler {
  if (ctx.isInteractive) {
    return new InteractiveApprovalHandler({ stdout: ctx.stdout, cwd: ctx.cwd });
  }
  return new NonInteractiveApprovalHandler({
    ...(options.approvePlanHash === undefined ? {} : { approvePlanHash: options.approvePlanHash }),
    ...(options.assumeYes === true ? { assumeYes: true } : {}),
    approver: options.assumeYes === true ? "--yes flag" : "--approve flag",
  });
}
