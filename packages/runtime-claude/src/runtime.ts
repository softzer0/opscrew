// Types only: the SDK itself is loaded on the first phase (`loadClaudeAgentSdk`).
import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionResult,
  SDKMessage,
  SDKResultError,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentRuntime,
  type ApprovalRequest,
  type AuditLog,
  BUILTIN_TOOLS,
  type PhaseName,
  type PhaseRequest,
  type PhaseResult,
  type PhaseStopReason,
  type RuntimeAvailability,
  type RuntimeEvent,
  type ToolPolicy,
} from "@opscrew/contracts";
import {
  errorMessage,
  errorText,
  isRecord,
  modelOutputMismatch,
  PROFILE_TOOLS,
  redactDeep,
  STRUCTURED_OUTPUT_TOOL,
  sanitizeAgentEnv,
} from "@opscrew/core";
import { z } from "zod";
import { type ClaudeAgentSdkOptions, loadClaudeAgentSdk } from "./sdk";

/** The subset of the SDK's `query()` the runtime uses; `typeof query` satisfies it. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

interface RuntimeOptions {
  /** Decides every tool call (normally `DefaultToolPolicy`). */
  policy: ToolPolicy;
  audit: AuditLog;
  /** Applied to prompts, streamed events, tool results and final text (normally `Redactor.redact`). */
  redact: (text: string) => string;
  /** Asked when the policy returns `ask`. Without it, such calls are denied. */
  approvals?: { request(request: ApprovalRequest): Promise<{ approved: boolean }> };
  costLedger?: {
    append(entry: { phase: PhaseName; model?: string; costUsd: number }): Promise<void>;
  };
  /** Model used when the request names none. Defaults to `claude-opus-5-5`. */
  defaultModel?: string;
  /** Parent environment. Defaults to `process.env`; sanitised before it reaches the agent. */
  env?: Record<string, string | undefined>;
}

/**
 * The runtime's options, with how it reaches the SDK: `sdk` finds (or installs) it on the first
 * phase, `queryFn` replaces it in tests.
 */
export type ClaudeAgentRuntimeOptions = RuntimeOptions &
  ({ sdk: ClaudeAgentSdkOptions } | { queryFn: QueryFn });

/** SDK tools OpsCrew agents never get, disallowed explicitly as defence in depth. */
const ALWAYS_DISALLOWED = [
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "KillShell",
  "Skill",
  "SlashCommand",
  "ExitPlanMode",
  "AskUserQuestion",
] as const;

const CREDENTIAL_HINT =
  "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or route through a cloud provider by setting " +
  "CLAUDE_CODE_USE_BEDROCK=1, CLAUDE_CODE_USE_VERTEX=1 or CLAUDE_CODE_USE_FOUNDRY=1 with that " +
  "provider's credentials.";

/**
 * Seconds the SDK waits for the PreToolUse gate. An `ask` decision waits for a person to answer
 * the approval prompt, and approvals have no deadline of their own, so the gate allows 30
 * minutes. When the SDK cancels the hook (its timeout fired), the gate settles as a denial, the
 * permission callback repeats it, and a call that runs anyway is caught as ungated: a timeout
 * always fails closed.
 */
export const PRE_TOOL_USE_TIMEOUT_SECONDS = 30 * 60;

/** Seconds for the post-tool hooks: redacting one tool result and one audit append. */
export const POST_TOOL_USE_TIMEOUT_SECONDS = 60;

const UNGATED_ERROR =
  "OpsCrew stopped because a tool ran without passing its safety gate. This usually means " +
  "managed Claude Code settings on this machine disable or restrict hooks (for example " +
  "`disableAllHooks` or `allowManagedHooksOnly` in managed-settings.json, found under " +
  "/etc/claude-code on Linux, /Library/Application Support/ClaudeCode on macOS or " +
  "C:\\Program Files\\ClaudeCode on Windows). Check those settings with your administrator, " +
  "then run OpsCrew again.";

type Gate =
  | { allowed: true; decision: "allow" | "approved" }
  | { allowed: false; decision: "deny" | "refused"; reason: string };

/**
 * `AgentRuntime` backed by the Claude Agent SDK (FR-010). Every tool call passes through the tool
 * policy once, in a pre-tool-use hook that nothing auto-approves around (the permission callback
 * only repeats the hook's decision), no user or project Claude settings are loaded, the agent
 * environment is sanitised and every text that leaves the runtime is redacted.
 */
export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id = "claude-agent-sdk";
  readonly #options: ClaudeAgentRuntimeOptions;
  readonly #defaultModel: string;
  #query: Promise<QueryFn> | undefined;

  constructor(options: ClaudeAgentRuntimeOptions) {
    this.#options = options;
    this.#defaultModel = options.defaultModel ?? "claude-opus-5-5";
  }

  async isConfigured(): Promise<RuntimeAvailability> {
    const env = this.#env();
    const set = (name: string) => (env[name] ?? "").trim() !== "";
    const flag = (name: string) => env[name] === "1";
    if (
      set("ANTHROPIC_API_KEY") ||
      set("ANTHROPIC_AUTH_TOKEN") ||
      flag("CLAUDE_CODE_USE_BEDROCK") ||
      flag("CLAUDE_CODE_USE_VERTEX") ||
      flag("CLAUDE_CODE_USE_FOUNDRY")
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "No Claude credentials were found, so OpsCrew cannot run its AI agents.",
      hint: CREDENTIAL_HINT,
    };
  }

  async runPhase<T>(request: PhaseRequest<T>): Promise<PhaseResult<T>> {
    return new PhaseRun(
      this.#options,
      () => this.#loadQuery(),
      this.#defaultModel,
      this.#env(),
      request,
    ).run();
  }

  #env(): Record<string, string | undefined> {
    return this.#options.env ?? process.env;
  }

  /** The SDK's `query`, loaded once per runtime (an install the user refused is not asked again). */
  #loadQuery(): Promise<QueryFn> {
    const options = this.#options;
    this.#query ??=
      "queryFn" in options
        ? Promise.resolve(options.queryFn)
        : loadClaudeAgentSdk(options.sdk, this.#env());
    return this.#query;
  }
}

/** State and behaviour for one `runPhase` call. */
class PhaseRun<T> {
  readonly #gates = new Map<string, Promise<Gate>>();
  #sessionId: string | undefined;
  #model: string | undefined;
  #lastText = "";
  #refused = false;
  /** Set when a tool ran without an allowing gate decision; the phase is stopped. */
  #ungated = false;
  #controller: AbortController | undefined;

  constructor(
    private readonly options: ClaudeAgentRuntimeOptions,
    private readonly loadQuery: () => Promise<QueryFn>,
    private readonly defaultModel: string,
    private readonly env: Record<string, string | undefined>,
    private readonly request: PhaseRequest<T>,
  ) {}

  async run(): Promise<PhaseResult<T>> {
    const { request } = this;
    const controller = new AbortController();
    this.#controller = controller;
    const onAbort = () => controller.abort();
    if (this.#isAborted()) return this.#finish(this.#aborted());
    request.signal?.addEventListener("abort", onAbort, { once: true });

    let query: QueryFn;
    try {
      query = await this.loadQuery();
    } catch (error) {
      request.signal?.removeEventListener("abort", onAbort);
      return this.#finish(
        this.#failed(
          errorText(error, `OpsCrew could not load the Claude Agent SDK: ${errorMessage(error)}`),
        ),
      );
    }

    let result: SDKResultMessage | undefined;
    let failure: PhaseResult<T> | undefined;
    try {
      const stream = query({
        prompt: this.#redact(request.prompt),
        options: this.buildOptions(controller),
      });
      for await (const message of stream) {
        if (message.type === "result") result = message;
        else this.#observe(message);
        if (this.#ungated) break;
      }
    } catch (error) {
      failure =
        this.#ungated || this.#isAborted() || isAbortError(error)
          ? this.#aborted()
          : this.#failed(`The Claude agent failed: ${errorMessage(error)}`);
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }

    if (this.#ungated) {
      return this.#finish({ ...this.#empty(), stopReason: "error", error: UNGATED_ERROR });
    }
    if (failure !== undefined) return this.#finish(failure);
    if (result === undefined) {
      return this.#finish(
        this.#isAborted()
          ? this.#aborted()
          : this.#failed("The Claude agent stopped without reporting a result."),
      );
    }
    const mapped = this.#mapResult(result);
    await this.options.costLedger?.append({
      phase: request.phase,
      ...(mapped.model === undefined ? {} : { model: mapped.model }),
      costUsd: mapped.costUsd,
    });
    return this.#finish(mapped);
  }

  /** The SDK options for this request. Exposed for tests through the injected `queryFn`. */
  buildOptions(controller: AbortController): Options {
    const { request } = this;
    const profileTools = PROFILE_TOOLS[request.profile] ?? [];
    const builtins = profileTools.filter(
      (name) => request.builtinTools === undefined || request.builtinTools.includes(name),
    );
    const systemPrompt = this.#redact(request.systemPrompt);

    // One gate (constitution I): the PreToolUse hook (no matcher) decides every call, built-in
    // or the SDK's StructuredOutput, and its allow or deny is final. No `allowedTools`: a
    // bare entry would auto-approve the whole tool, so the SDK would skip `canUseTool`
    // (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). `canUseTool` stays only as the prompt surface for a
    // call the SDK still wants a decision on; it returns the hook's cached decision, so nothing
    // prompts or blocks an allowed call in a non-interactive run, and nothing is decided twice.
    const options: Options = {
      abortController: controller,
      cwd: request.projectRoot,
      model: request.model ?? this.defaultModel,
      systemPrompt:
        request.profile === "edit-repo"
          ? { type: "preset", preset: "claude_code", append: systemPrompt }
          : systemPrompt,
      tools: [...builtins],
      disallowedTools: [
        ...BUILTIN_TOOLS.filter((name) => !builtins.includes(name)),
        ...ALWAYS_DISALLOWED,
      ],
      permissionMode: "default",
      canUseTool: this.#canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.#preToolUse], timeout: PRE_TOOL_USE_TIMEOUT_SECONDS }],
        PostToolUse: [{ hooks: [this.#postToolUse], timeout: POST_TOOL_USE_TIMEOUT_SECONDS }],
        PostToolUseFailure: [
          { hooks: [this.#postToolUse], timeout: POST_TOOL_USE_TIMEOUT_SECONDS },
        ],
      },
      settingSources: [],
      strictMcpConfig: true,
      env: sanitizeAgentEnv(this.env),
    };
    if (request.maxTurns !== undefined) options.maxTurns = request.maxTurns;
    if (request.maxBudgetUsd !== undefined) options.maxBudgetUsd = request.maxBudgetUsd;
    if (request.effort !== undefined) options.effort = request.effort;
    if (request.output !== undefined) {
      options.outputFormat = {
        type: "json_schema",
        schema: z.toJSONSchema(request.output.schema, { target: "draft-07" }) as Record<
          string,
          unknown
        >,
      };
    }
    return options;
  }

  // -------------------------------------------------------------------------------------------
  // Tool gating
  // -------------------------------------------------------------------------------------------

  readonly #preToolUse: HookCallback = async (
    input,
    toolUseId,
    { signal },
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    this.#sessionId ??= input.session_id;
    const gate = await this.#gate(
      input.tool_name,
      input.tool_input,
      input.tool_use_id ?? toolUseId,
      signal,
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: gate.allowed ? "allow" : "deny",
        permissionDecisionReason: gate.allowed
          ? "Allowed by the OpsCrew tool policy."
          : gate.reason,
      },
    };
  };

  readonly #canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
    const gate = await this.#gate(toolName, input, toolUseID);
    const decision: PermissionResult = gate.allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: gate.reason };
    return decision;
  };

  readonly #postToolUse: HookCallback = async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") {
      return {};
    }
    this.#sessionId ??= input.session_id;
    const gate = await this.#gates.get(input.tool_use_id);
    const failed = input.hook_event_name === "PostToolUseFailure";
    const target = describeInput(input.tool_name, input.tool_input);
    if (gate?.allowed !== true) return this.#stopUngated(input.tool_name, target, gate);
    try {
      await this.options.audit.append({
        kind: "tool-call",
        actor: "agent",
        ...this.#toolFields(input.tool_name, target),
        decision: gate.decision,
        ...(failed ? { detail: this.#redact(`failed: ${input.error}`) } : {}),
      });
    } catch {
      // The call already ran; a failed audit write must not break the agent loop.
    }
    this.#emit({
      kind: "tool-result",
      tool: input.tool_name,
      message: failed ? `${input.tool_name} failed` : `${input.tool_name} finished`,
    });
    if (input.hook_event_name !== "PostToolUse") return {};
    // Constitution IV: whatever a tool returned (a file read, a grep hit, command output) reaches
    // the model only after redaction, so a hard-coded key in the repository is never sent on.
    const redacted = redactDeep(input.tool_response, (text) => this.#redact(text));
    if (redacted === input.tool_response) return {};
    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: redacted } };
  };

  /**
   * A tool ran although no gate decision allowed it (the SDK skipped the PreToolUse hook, or ran
   * the call after the gate denied it or timed out). Audits it, stops the agent and makes the
   * phase fail with `UNGATED_ERROR`.
   */
  async #stopUngated(
    tool: string,
    target: string | undefined,
    gate: Gate | undefined,
  ): Promise<HookJSONOutput> {
    this.#ungated = true;
    try {
      await this.options.audit.append({
        kind: "tool-call",
        actor: "agent",
        ...this.#toolFields(tool, target),
        detail:
          gate === undefined
            ? "ungated: the tool ran without passing the OpsCrew safety gate"
            : `ungated: the tool ran although the OpsCrew safety gate answered ${gate.decision}`,
      });
    } catch {
      // Stopping the phase matters more than the audit line.
    }
    this.#emit({
      kind: "tool-denied",
      tool,
      message: `${tool} ran without passing the safety gate; stopping.`,
    });
    this.#controller?.abort();
    return { continue: false, stopReason: UNGATED_ERROR };
  }

  /** Policy decision for one tool call, computed once per tool-use id (hook and callback share it). */
  #gate(
    tool: string,
    input: unknown,
    toolUseId: string | undefined,
    signal?: AbortSignal,
  ): Promise<Gate> {
    if (toolUseId !== undefined) {
      const known = this.#gates.get(toolUseId);
      if (known !== undefined) return known;
    }
    const decided = this.#decide(tool, input).catch(
      (): Gate => ({
        allowed: false,
        decision: "deny",
        reason: "OpsCrew could not check this tool call, so it was denied.",
      }),
    );
    // A cancelled hook (the SDK's timeout fired) settles the gate as a denial: fail closed.
    let settled = false;
    void decided.then(() => {
      settled = true;
    });
    const pending =
      signal === undefined
        ? decided
        : Promise.race([
            decided,
            this.#onCancel(signal, () => settled, tool, describeInput(tool, input)),
          ]);
    if (toolUseId !== undefined) this.#gates.set(toolUseId, pending);
    return pending;
  }

  /**
   * Resolves to a denial once `signal` aborts before the decision settled; never settles
   * otherwise (a late abort changes nothing and writes no audit line).
   */
  #onCancel(
    signal: AbortSignal,
    decided: () => boolean,
    tool: string,
    target: string | undefined,
  ): Promise<Gate> {
    const reason = "The safety check for this tool call took too long, so it was denied.";
    return new Promise<void>((resolve) => {
      const fire = () => {
        if (!decided()) resolve();
      };
      if (signal.aborted) fire();
      else signal.addEventListener("abort", fire, { once: true });
    }).then(() =>
      this.#deny(tool, target, "deny", reason).catch(
        (): Gate => ({ allowed: false, decision: "deny", reason }),
      ),
    );
  }

  async #decide(tool: string, input: unknown): Promise<Gate> {
    const { request } = this;
    // The policy allows StructuredOutput in every profile (it has no side effects); only this
    // runtime knows whether the phase asked for a structured result at all.
    if (tool === STRUCTURED_OUTPUT_TOOL && request.output === undefined) {
      return this.#deny(
        tool,
        undefined,
        "deny",
        "This phase did not ask for a structured result, so StructuredOutput is not available.",
      );
    }
    const decision = this.options.policy.evaluate({
      tool,
      input: isRecord(input) ? input : {},
      phase: request.phase,
      profile: request.profile,
      projectRoot: request.projectRoot,
    });
    const target = describeInput(tool, input);

    if (decision.decision === "allow") {
      this.#emit({ kind: "tool-call", tool, message: target ? `${tool}: ${target}` : tool });
      return { allowed: true, decision: "allow" };
    }
    if (decision.decision === "deny") {
      return this.#deny(tool, target, "deny", decision.reason);
    }

    const approvals = this.options.approvals;
    if (approvals === undefined) {
      return this.#deny(
        tool,
        target,
        "deny",
        `${decision.reason} No one is available to approve it in this run, so it was denied.`,
      );
    }
    let approved = false;
    try {
      const answer = await approvals.request({
        kind: "tool-call",
        title: `Allow the ${request.phase} agent to use ${tool}?`,
        details: this.#redact([target ? `${tool}: ${target}` : tool, decision.reason].join("\n")),
      });
      approved = answer.approved === true;
    } catch {
      approved = false;
    }
    if (!approved) {
      return this.#deny(
        tool,
        target,
        "refused",
        `${decision.reason} The request was not approved.`,
      );
    }
    this.#emit({ kind: "tool-call", tool, message: target ? `${tool}: ${target}` : tool });
    return { allowed: true, decision: "approved" };
  }

  async #deny(
    tool: string,
    target: string | undefined,
    decision: "deny" | "refused",
    rawReason: string,
  ): Promise<Gate> {
    const reason = this.#redact(rawReason);
    await this.options.audit.append({
      kind: "tool-denied",
      actor: "opscrew",
      ...this.#toolFields(tool, target),
      decision,
      detail: reason,
    });
    this.#emit({ kind: "tool-denied", tool, message: `${tool} denied: ${reason}` });
    return { allowed: false, decision, reason };
  }

  /** The audit fields of a tool call: the tool, the phase, the session and what it touches. */
  #toolFields(tool: string, target: string | undefined) {
    return {
      action: tool,
      phase: this.request.phase,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(target === undefined ? {} : { target: shorten(this.#redact(target)) }),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Messages and results
  // -------------------------------------------------------------------------------------------

  #observe(message: SDKMessage): void {
    if ("session_id" in message && typeof message.session_id === "string") {
      this.#sessionId ??= message.session_id;
    }
    if (message.type === "assistant") {
      const texts: string[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim() !== "") texts.push(block.text);
      }
      if (texts.length > 0) {
        const text = texts.join("\n");
        if (message.parent_tool_use_id === null) this.#lastText = text;
        this.#emit({ kind: "assistant-text", message: text });
      }
      return;
    }
    if (message.type === "system") {
      if (message.subtype === "init") {
        this.#model = message.model;
        this.#emit({ kind: "status", message: `Agent session started (${message.model}).` });
      } else if (message.subtype === "model_refusal_no_fallback") {
        this.#refused = true;
      }
    }
  }

  #mapResult(message: SDKResultMessage): PhaseResult<T> {
    const { request } = this;
    const costUsd = Number.isFinite(message.total_cost_usd)
      ? Math.max(0, message.total_cost_usd)
      : 0;
    const modelIds = Object.keys(message.modelUsage ?? {});
    const model = this.#model ?? modelIds[0] ?? request.model ?? this.defaultModel;
    const base: PhaseResult<T> = {
      ok: false,
      stopReason: "error",
      text: this.#redact(this.#lastText),
      costUsd,
      turns: message.num_turns ?? 0,
      model,
    };
    const sessionId = message.session_id ?? this.#sessionId;
    if (sessionId !== undefined) base.sessionId = sessionId;

    if (message.subtype !== "success") {
      const stopReason = errorStopReason(message, this.#isAborted());
      return { ...base, stopReason, error: this.#errorText(stopReason, message.errors) };
    }

    base.text = this.#redact(message.result ?? "");
    if (message.is_error) {
      return {
        ...base,
        error: this.#redact(message.result || "The Claude agent reported an error."),
      };
    }
    if (this.#refused || message.stop_reason === "refusal") {
      return { ...base, stopReason: "refused", error: this.#errorText("refused", []) };
    }
    if (request.output === undefined) return { ...base, ok: true, stopReason: "completed" };

    const candidate = message.structured_output ?? parseJson(message.result);
    const parsed = request.output.schema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ...base,
        stopReason: "invalid_output",
        error: this.#redact(modelOutputMismatch(request.output.name, parsed.error)),
      };
    }
    return { ...base, ok: true, stopReason: "completed", output: parsed.data };
  }

  #errorText(stopReason: PhaseStopReason, errors: readonly string[] | undefined): string {
    const { request } = this;
    switch (stopReason) {
      case "max_turns":
        return `The ${request.phase} phase stopped after reaching its limit of ${request.maxTurns ?? "allowed"} turns. Try again with a higher limit or a narrower request.`;
      case "budget_exceeded":
        return `The ${request.phase} phase stopped because it reached its spending limit${request.maxBudgetUsd === undefined ? "" : ` of $${request.maxBudgetUsd}`}. Raise the budget to continue.`;
      case "invalid_output":
        return `The model could not produce output in the expected ${request.output?.name ?? "structured"} format.`;
      case "refused":
        return `The model declined to complete the ${request.phase} phase.`;
      case "aborted":
        return `The ${request.phase} phase was cancelled.`;
      default: {
        const detail = (errors ?? []).filter((e) => e.trim() !== "").join("; ");
        return this.#redact(
          detail === ""
            ? "The Claude agent stopped because of an error."
            : `The Claude agent stopped: ${detail}`,
        );
      }
    }
  }

  #aborted(): PhaseResult<T> {
    return { ...this.#empty(), stopReason: "aborted", error: this.#errorText("aborted", []) };
  }

  #failed(message: string): PhaseResult<T> {
    return { ...this.#empty(), stopReason: "error", error: this.#redact(message) };
  }

  #empty(): PhaseResult<T> {
    const result: PhaseResult<T> = {
      ok: false,
      stopReason: "error",
      text: this.#redact(this.#lastText),
      costUsd: 0,
      turns: 0,
      model: this.#model ?? this.request.model ?? this.defaultModel,
    };
    if (this.#sessionId !== undefined) result.sessionId = this.#sessionId;
    return result;
  }

  async #finish(result: PhaseResult<T>): Promise<PhaseResult<T>> {
    try {
      await this.options.audit.append({
        kind: "phase",
        actor: "agent",
        action: this.request.phase,
        phase: this.request.phase,
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        detail: `${result.stopReason}; ${result.turns} turns; $${result.costUsd.toFixed(4)}`,
      });
    } catch {
      // The phase result matters more than its summary line in the audit log.
    }
    this.#emit({ kind: "status", message: `Phase ${this.request.phase}: ${result.stopReason}.` });
    return result;
  }

  #emit(event: RuntimeEvent): void {
    const handler = this.request.onEvent;
    if (handler === undefined) return;
    try {
      handler({ ...event, message: shorten(this.#redact(event.message), 500) });
    } catch {
      // A failing progress listener must not break the agent loop.
    }
  }

  #redact(text: string): string {
    return this.options.redact(text);
  }

  #isAborted(): boolean {
    return this.request.signal?.aborted === true;
  }
}

function errorStopReason(message: SDKResultError, aborted: boolean): PhaseStopReason {
  switch (message.subtype) {
    case "error_max_turns":
      return "max_turns";
    case "error_max_budget_usd":
      return "budget_exceeded";
    case "error_max_structured_output_retries":
      return "invalid_output";
    default:
      if (aborted || message.terminal_reason?.startsWith("aborted") === true) return "aborted";
      return "error";
  }
}

/** A short, human-readable description of what a tool call touches (path, command, pattern). */
function describeInput(tool: string, input: unknown): string | undefined {
  // StructuredOutput's input is the phase's answer, not something the call touches.
  if (tool === STRUCTURED_OUTPUT_TOOL || !isRecord(input)) return undefined;
  const pick = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  const value =
    tool === "Bash"
      ? pick("command")
      : (pick("file_path") ?? pick("notebook_path") ?? pick("pattern") ?? pick("path"));
  return value;
}

/** Shortens text for audit targets. Callers redact first, so a cut can never split a secret. */
function shorten(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
