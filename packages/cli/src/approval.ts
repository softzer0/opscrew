import { userInfo } from "node:os";
import { confirm, isCancel, text } from "@clack/prompts";
import { approvalRequestLines } from "@opscrew/agents";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalKind,
  ApprovalRequest,
  Clock,
  CommandRunner,
} from "@opscrew/contracts";
import { isPlanHash, NodeCommandRunner, OpsCrewError } from "@opscrew/core";
import type { CliContext } from "./context";

/** The real time, for every CLI run without an injected clock. */
export const systemClock: Clock = { now: () => new Date() };

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

/** The text shown before asking: the title, then what `approvalRequestLines` shows. */
export function formatRequest(request: ApprovalRequest): string {
  return `${["", request.title, "", ...approvalRequestLines(request)].join("\n")}\n`;
}

export interface NonInteractiveApprovalHandlerOptions {
  /** Plan hash passed with `--approve <hash>`. */
  approvePlanHash?: string;
  /**
   * Every hash passed with a repeated `--approve <hash>` (each names one plan): on a server the
   * user owns, the infrastructure plan and the host plan. Only these exact hashes are granted.
   */
  approvePlanHashes?: readonly string[];
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
const ASSUME_YES_KINDS: readonly ApprovalRequest["kind"][] = [
  "repo-write",
  "github-secrets",
  "git-push",
  "pull-request",
];

/**
 * Request kinds `--approve <hash>` may grant, each only for its exact plan hash: infrastructure,
 * the host plan of the user's own server and the stack plan of the user's Portainer.
 */
export const APPROVE_BY_HASH_KINDS: readonly ApprovalRequest["kind"][] = [
  "iac-apply",
  "host-apply",
  "stack-apply",
];

const RUN_INTERACTIVELY =
  "Run the command in an interactive terminal to review and approve it, or pass --approve <hash> with the hash of the plan you reviewed.";

/**
 * Approves without a human only when the user named the exact plan: an `iac-apply`
 * (infrastructure), `host-apply` (the host plan of the user's own server) or `stack-apply` (the
 * stack plan of the user's Portainer) whose `planHash` equals one of the `--approve <hash>` values
 * (case-insensitive) and that destroys nothing and needs no typed confirmation. `--yes` never
 * grants any of these kinds. Everything else is refused with a reason that says how to approve it.
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
    if (!APPROVE_BY_HASH_KINDS.includes(request.kind)) {
      return `"${request.title}" needs a human approval and this run is not interactive. ${RUN_INTERACTIVELY}`;
    }
    if (request.allowDestroy === true || request.confirmPhrase !== undefined) {
      return "This plan deletes or replaces resources, which needs a typed confirmation. Run the command in an interactive terminal to approve it.";
    }
    const hashes = this.hashes();
    if (hashes.length === 0) {
      return `No plan hash was approved for this non-interactive run. ${RUN_INTERACTIVELY}`;
    }
    if (!hashes.every((hash) => isPlanHash(hash))) {
      return `--approve expects the 64-character SHA-256 hash of the plan. ${RUN_INTERACTIVELY}`;
    }
    const wanted = request.planHash?.toLowerCase();
    if (!isPlanHash(request.planHash) || !hashes.some((hash) => hash.toLowerCase() === wanted)) {
      const what =
        request.kind === "host-apply"
          ? "The host plan's hash"
          : request.kind === "stack-apply"
            ? "The stack plan's hash"
            : "The plan hash";
      return `${what} does not match --approve ${hashes.join(" / ")}; the plan changed since you reviewed it, or it was not approved. ${RUN_INTERACTIVELY}`;
    }
    return undefined;
  }

  /** Every non-empty `--approve` value, trimmed. */
  private hashes(): string[] {
    return [this.options.approvePlanHash, ...(this.options.approvePlanHashes ?? [])]
      .map((hash) => (hash ?? "").trim())
      .filter((hash) => hash !== "");
  }
}

/**
 * Picks the interactive handler on a TTY (it shows each plan with its hash and asks; a plan that
 * deletes something needs the name typed), otherwise the `--approve <hash>` handler, which grants
 * exactly the plans `approveHashes` names.
 */
export function createApprovalHandler(
  ctx: CliContext,
  options: { approveHashes: readonly string[]; assumeYes?: boolean },
  clock: Clock,
): ApprovalHandler {
  if (ctx.isInteractive) {
    return new InteractiveApprovalHandler({ stdout: ctx.stdout, cwd: ctx.cwd, clock });
  }
  return new NonInteractiveApprovalHandler({
    ...(options.approveHashes.length === 0 ? {} : { approvePlanHashes: options.approveHashes }),
    ...(options.assumeYes === true ? { assumeYes: true } : {}),
    approver: options.assumeYes === true ? "--yes flag" : "--approve flag",
    clock,
  });
}

/** True when `planHash` is a plan hash and one of the `--approve` values names it (any case). */
export function hashListed(hashes: readonly string[], planHash: string | undefined): boolean {
  if (!isPlanHash(planHash)) return false;
  const wanted = planHash.toLowerCase();
  return hashes.some((hash) => hash.toLowerCase() === wanted);
}

/**
 * Stops before anything runs when `--confirm <name>` (`given`) is not `expected` (`what`: `the
 * app's name`); `hint` says how to run it. Nothing to check without `--confirm`.
 */
export function checkConfirmName(
  given: string | undefined,
  expected: string,
  what: string,
  hint: string,
): void {
  if (given === undefined || given.trim() === expected) return;
  throw new OpsCrewError(
    "APPROVAL_REFUSED",
    `--confirm ${given} does not match ${what}, so nothing was changed.`,
    { hint },
  );
}

/** Which requests a {@link FlagConfirmation} answers, and what it knows of the run. */
export interface FlagConfirmationOptions {
  /** The kinds of the deleting requests it answers. */
  kinds: readonly ApprovalKind[];
  /** What those requests do, for its refusals: `a plan that deletes or replaces resources`. */
  what: string;
  /** The app's name, which the deleting requests ask to have typed. */
  app: string;
  /** `--confirm <app>` was given (and matched {@link FlagConfirmationOptions.app}). */
  confirmed: boolean;
  /** Every `--approve` value. */
  hashes: readonly string[];
  /** A person can answer the prompt that asks for the name (a terminal). */
  interactive: boolean;
  /** Where approved requests are shown (`ctx.stdout`, which redacts). */
  print: (text: string) => void;
  clock: Clock;
}

/**
 * The typed app name for a request of `kinds` that deletes something (`allowDestroy` and the
 * app's name as `confirmPhrase`): in a script `--confirm <app>` approves it only when one of the
 * `--approve` values is its plan's hash; without `--confirm`, a run nobody can answer is refused
 * with the flag to add, and in a terminal `base` asks for the name. `--yes` never approves it;
 * every other request goes to `base`.
 */
export class FlagConfirmation implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly options: FlagConfirmationOptions,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const { kinds, what, app, confirmed, hashes, interactive, print, clock } = this.options;
    const deletion =
      kinds.includes(request.kind) &&
      request.allowDestroy === true &&
      request.confirmPhrase !== undefined;
    if (!deletion) return this.base.request(request);
    const decide = (approved: boolean, extra: Partial<ApprovalDecision>): ApprovalDecision => ({
      approved,
      approver: "--approve and --confirm flags",
      decidedAt: clock.now().toISOString(),
      ...extra,
    });
    if (confirmed) {
      if (request.confirmPhrase === app && hashListed(hashes, request.planHash)) {
        print(`  ✓ ${request.title} (confirmed with --confirm ${app})\n`);
        return decide(true, { confirmation: app });
      }
      return decide(false, {
        reason: `--confirm ${app} approves ${what} only together with --approve and that plan's hash ${request.planHash ?? ""}`,
      });
    }
    if (!interactive) {
      return decide(false, {
        reason: `${what} needs the app's name: add --confirm ${request.confirmPhrase} (with --approve and the plan's hash), or run the command in a terminal`,
      });
    }
    return this.base.request(request);
  }
}
