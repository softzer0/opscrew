import type { Readable, Writable } from "node:stream";
import {
  type AdaptGitHub,
  buildPhaseDeps,
  type DestroyServices,
  type DomainServices,
  type InitServices,
  type PhaseDeps,
  type PortainerAccess,
  type PortainerServices,
  type ProvisionServices,
  type RetargetServices,
  type RunSecureOptions,
  type RunVerifyOptions,
} from "@opscrew/agents";
import type {
  AgentRuntime,
  ApprovalHandler,
  Clock,
  CommandRunner,
  FetchLike,
  Reporter,
} from "@opscrew/contracts";
import {
  DefaultToolPolicy,
  NodeCommandRunner,
  nodeRealpath,
  registerEnvSecrets,
  systemClock,
} from "@opscrew/core";
import { ClaudeAgentRuntime } from "@opscrew/runtime-claude";
import { createApprovalHandler } from "./approval";
import type { CliContext } from "./context";
import { clackPrompts, type UiPrompts } from "./ui/prompts";

/**
 * Side effects a command uses, replaceable per context. The real CLI uses none of these (each
 * phase builds its defaults from the environment); tests attach fakes with {@link withServices}
 * so commands never touch the network, a cloud, a server, a model or a human.
 */
export interface CliServices {
  /** Agent runtime used instead of the Claude Agent SDK (still dropped with `--no-ai`). */
  runtime?: AgentRuntime;
  fetch?: FetchLike;
  runner?: CommandRunner;
  clock?: Clock;
  /** Approval handler used instead of the interactive / `--approve <hash>` handler. */
  approvalHandler?: ApprovalHandler;
  /** Terminal prompts (questions, choices, typed names and masked secret values). */
  prompts?: UiPrompts;
  /** GitHub client for `adapt` (pull requests). */
  github?: AdaptGitHub;
  /** Home directory used to resolve `~/.opscrew` when `OPSCREW_HOME` is not set. */
  homedir?: string;
  /**
   * Engine, cloud provider, Cloudflare, GitHub, SSH and wait fakes for `provision` and `dns`; its
   * `own` also for `design` (an own server's inspection) and `drift`.
   */
  provision?: ProvisionServices;
  /** Remote shell, port probe and scanners for `secure`. */
  secure?: Omit<RunSecureOptions, "planJson">;
  /** DNS, TLS, TCP and Cloudflare-range fakes for `verify` (HTTP comes from `fetch`). */
  verify?: Omit<RunVerifyOptions, "fetch">;
  /** Streams for `mcp` instead of the process's stdin and stdout. */
  mcp?: { stdin?: Readable; stdout?: Writable };
  /** PATH lookup, Node version and time budget for `init`. */
  init?: InitServices;
  /** Engine, cloud provider, Cloudflare and GitHub fakes for `destroy`. */
  destroy?: DestroyServices;
  /** Engine, both providers, Cloudflare, GitHub, SSH, catalogue and wait fakes for `retarget`. */
  retarget?: RetargetServices;
  /** Cloudflare accounts, registrar, extension and zone fakes for `domain`. */
  domain?: DomainServices;
  /** Engine, Cloudflare, own-server and deploy-user shell fakes for `portainer`. */
  portainer?: PortainerServices;
  /** How `interview` reads the certificate of the user's Portainer and lists its environments. */
  portainerAccess?: PortainerAccess;
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
interface PhaseDepsOptions {
  /** Allow a model for this run (`--no-ai` sets false). Default true. */
  ai?: boolean;
  /** Default model of the Claude runtime (phases usually name their own). */
  model?: string;
  /** Every `--approve <hash>`: the non-interactive handler grants exactly these plans. */
  approveHashes?: readonly string[];
  /** `--yes`: approve the repository and GitHub steps of a non-interactive run (never applies). */
  assumeYes?: boolean;
  /**
   * Wraps the run's approval handler (for example `destroy`'s typed-confirmation handler); the
   * wrapper decides on the run's clock.
   */
  wrapApprovals?: (handler: ApprovalHandler, clock: Clock) => ApprovalHandler;
  /** Reporter override, for example a quiet one for `--json` output. Default `ctx.reporter`. */
  reporter?: Reporter;
}

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
 * Builds the {@link PhaseDeps} for one command run from `ctx` (see `buildPhaseDeps`): project
 * paths (honouring `OPSCREW_HOME`), the file-backed stores, an approval gate with the interactive
 * handler on a TTY or the `--approve <hash>` handler otherwise, a `NodeCommandRunner`, the global
 * `fetch`, and `ctx.redactor` with the environment's secrets registered. The Claude runtime is
 * added only when `ai` is not false and Claude credentials are configured.
 */
export function createPhaseDeps(ctx: CliContext, options: PhaseDepsOptions = {}): PhaseDeps {
  const extra = servicesOf(ctx);
  registerEnvSecrets(ctx.redactor, ctx.env);
  const clock = extra.clock ?? systemClock;
  const base =
    extra.approvalHandler ??
    createApprovalHandler(
      ctx,
      {
        approveHashes: options.approveHashes ?? [],
        ...(options.assumeYes === true ? { assumeYes: true } : {}),
      },
      clock,
    );
  const deps = buildPhaseDeps({
    root: ctx.cwd,
    env: ctx.env,
    ...(extra.homedir === undefined ? {} : { homedir: extra.homedir }),
    reporter: options.reporter ?? ctx.reporter,
    redactor: ctx.redactor,
    approvalHandler: options.wrapApprovals ? options.wrapApprovals(base, clock) : base,
    runner: extra.runner ?? new NodeCommandRunner(),
    fetch: extra.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    clock,
    interactive: ctx.isInteractive,
    version: ctx.version,
  });
  if (options.ai === false) return deps;
  if (extra.runtime !== undefined) return { ...deps, runtime: extra.runtime };
  if (!claudeConfigured(ctx.env)) return deps;
  // Phases record their own spend in the cost ledger, so the runtime gets none (no doubles).
  const runtime = new ClaudeAgentRuntime({
    policy: new DefaultToolPolicy({ realpath: nodeRealpath }),
    audit: deps.audit,
    redact: ctx.redactor.redact,
    approvals: deps.approvals,
    env: ctx.env,
    ...(options.model === undefined ? {} : { defaultModel: options.model }),
  });
  return { ...deps, runtime };
}

/** `--model <id>`, else `OPSCREW_MODEL`, else undefined (the phase's default model). */
export function modelOption(ctx: CliContext, flag: string | undefined): string | undefined {
  const value = flag?.trim() || ctx.env.OPSCREW_MODEL?.trim();
  return value === "" ? undefined : value;
}
