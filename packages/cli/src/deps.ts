import type { AdaptGitHub, PhaseDeps } from "@opscrew/agents";
import type {
  AgentRuntime,
  ApprovalHandler,
  Clock,
  CommandRunner,
  ComputeCatalog,
  FetchLike,
  Reporter,
} from "@opscrew/contracts";
import {
  ApprovalGate,
  CostLedger,
  DefaultToolPolicy,
  JsonlApprovalStore,
  JsonlAuditLog,
  NodeCommandRunner,
  nodeRealpath,
  ProjectStateStore,
  registerEnvSecrets,
  resolveProjectPaths,
} from "@opscrew/core";
import { ClaudeAgentRuntime, MCP_SERVER_NAME } from "@opscrew/runtime-claude";
import { createApprovalHandler } from "./approval";
import type { CliContext } from "./context";
import { clackPrompts, type UiPrompts } from "./ui/prompts";

/**
 * Side effects a command uses, replaceable per context. The real CLI uses none of these; tests
 * attach fakes with {@link withServices} so commands never touch the network, a model or a human.
 */
export interface CliServices {
  /** Agent runtime used instead of the Claude Agent SDK (still dropped with `--no-ai`). */
  runtime?: AgentRuntime;
  fetch?: FetchLike;
  runner?: CommandRunner;
  clock?: Clock;
  /** Approval handler used instead of the interactive / `--approve <hash>` handler. */
  approvalHandler?: ApprovalHandler;
  /** Terminal prompts used by `askQuestions` and `chooseOption`. */
  prompts?: UiPrompts;
  /** GitHub client for `adapt` (pull requests). */
  github?: AdaptGitHub;
  /** Server catalogue for `design`. */
  catalog?: ComputeCatalog;
  /** Home directory used to resolve `~/.opscrew` when `OPSCREW_HOME` is not set. */
  homedir?: string;
}

const services = new WeakMap<CliContext, CliServices>();

/** Attaches service overrides to `ctx` (merged with earlier ones) and returns `ctx`. */
export function withServices<T extends CliContext>(ctx: T, overrides: CliServices): T {
  services.set(ctx, { ...services.get(ctx), ...overrides });
  return ctx;
}

/** The service overrides attached to `ctx` (empty for the real CLI). */
export function servicesOf(ctx: CliContext): CliServices {
  return services.get(ctx) ?? {};
}

/** The terminal prompts for `ctx`: the attached fake, or clack. */
export function promptsOf(ctx: CliContext): UiPrompts {
  return servicesOf(ctx).prompts ?? clackPrompts;
}

/** Per-command options for {@link createPhaseDeps}. */
export interface PhaseDepsOptions {
  /** Allow a model for this run (`--no-ai` sets false). Default true. */
  ai?: boolean;
  /** Default model of the Claude runtime (phases usually name their own). */
  model?: string;
  /** Plan hash from `--approve <hash>`, used by the non-interactive approval handler. */
  approvePlanHash?: string;
  /**
   * Every hash from a repeated `--approve <hash>` (an own server's infrastructure and host plans);
   * the non-interactive handler grants exactly these.
   */
  approvePlanHashes?: readonly string[];
  /** `--yes`: approve the repository and GitHub steps of a non-interactive run (never applies). */
  assumeYes?: boolean;
  /** Wraps the run's approval handler (for example `destroy`'s typed-confirmation handler). */
  wrapApprovals?: (handler: ApprovalHandler) => ApprovalHandler;
  /** Reporter override, for example a quiet one for `--json` output. Default `ctx.reporter`. */
  reporter?: Reporter;
}

const systemClock: Clock = { now: () => new Date() };

/** Credentials or flags that make the Claude Agent SDK usable. */
function claudeConfigured(env: Record<string, string | undefined>): boolean {
  const set = (name: string) => (env[name] ?? "").trim() !== "";
  return (
    set("ANTHROPIC_API_KEY") ||
    set("ANTHROPIC_AUTH_TOKEN") ||
    ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
      (name) => env[name] === "1",
    )
  );
}

/** Plain-English hint shown when a command could use a model but none is configured. */
export const MODEL_SETUP_HINT =
  "To use the AI agents, set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or set CLAUDE_CODE_USE_BEDROCK=1, CLAUDE_CODE_USE_VERTEX=1 or CLAUDE_CODE_USE_FOUNDRY=1 with that provider's credentials.";

/**
 * Builds the {@link PhaseDeps} for one command run from `ctx`: project paths (honouring
 * `OPSCREW_HOME`), the state, cost, approval and audit stores, an approval gate with the
 * interactive handler on a TTY or the `--approve <hash>` handler otherwise, a `NodeCommandRunner`,
 * the global `fetch`, and `ctx.redactor` with the environment's secrets registered. The Claude
 * runtime is added only when `ai` is not false and Claude credentials are configured.
 */
export function createPhaseDeps(ctx: CliContext, options: PhaseDepsOptions = {}): PhaseDeps {
  const extra = servicesOf(ctx);
  const redactor = ctx.redactor;
  registerEnvSecrets(redactor, ctx.env);
  const clock = extra.clock ?? systemClock;
  const paths = resolveProjectPaths(ctx.cwd, {
    env: ctx.env,
    ...(extra.homedir === undefined ? {} : { homedir: extra.homedir }),
  });
  const audit = new JsonlAuditLog({ dir: paths.auditDir, redact: redactor.redact, clock });
  const baseHandler =
    extra.approvalHandler ??
    createApprovalHandler(ctx, {
      ...(options.approvePlanHash === undefined
        ? {}
        : { approvePlanHash: options.approvePlanHash }),
      ...(options.approvePlanHashes === undefined
        ? {}
        : { approvePlanHashes: options.approvePlanHashes }),
      ...(options.assumeYes === true ? { assumeYes: true } : {}),
    });
  const handler = options.wrapApprovals ? options.wrapApprovals(baseHandler) : baseHandler;
  const approvals = new ApprovalGate({
    handler,
    store: new JsonlApprovalStore(paths.files.approvals),
    audit,
    clock,
  });

  let runtime: AgentRuntime | undefined;
  if (options.ai !== false) {
    if (extra.runtime !== undefined) {
      runtime = extra.runtime;
    } else if (claudeConfigured(ctx.env)) {
      // Phases record their own spend in the cost ledger, so the runtime gets none (no doubles).
      runtime = new ClaudeAgentRuntime({
        policy: new DefaultToolPolicy({ mcpServerName: MCP_SERVER_NAME, realpath: nodeRealpath }),
        audit,
        redact: redactor.redact,
        approvals,
        env: ctx.env,
        ...(options.model === undefined ? {} : { defaultModel: options.model }),
      });
    }
  }

  return {
    paths,
    reporter: options.reporter ?? ctx.reporter,
    ...(runtime === undefined ? {} : { runtime }),
    approvals,
    audit,
    state: new ProjectStateStore(paths.files.state, clock),
    costs: new CostLedger(paths.files.costs, clock),
    runner: extra.runner ?? new NodeCommandRunner(),
    fetch: extra.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    env: ctx.env,
    clock,
    redactor,
    interactive: ctx.isInteractive,
    version: ctx.version,
  };
}

/** `--model <id>`, else `OPSCREW_MODEL`, else undefined (the phase's default model). */
export function modelOption(ctx: CliContext, flag: string | undefined): string | undefined {
  const value = flag?.trim() || ctx.env.OPSCREW_MODEL?.trim();
  return value === "" ? undefined : value;
}
