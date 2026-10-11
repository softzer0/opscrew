import {
  AbortError,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKResultError,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntime,
  ApprovalRequest,
  AuditLog,
  BuiltinTool,
  PhaseName,
  PhaseRequest,
  PhaseResult,
  PhaseStopReason,
  PhaseUsage,
  RuntimeAvailability,
  RuntimeEvent,
  ToolPolicy,
} from "@opscrew/contracts";
import { PROFILE_TOOLS, sanitizeAgentEnv } from "@opscrew/core";
import { z } from "zod";
import { createToolServer, MCP_SERVER_NAME, mcpToolName } from "./tools";

/** The subset of the SDK's `query()` the runtime uses; `typeof query` satisfies it. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeAgentRuntimeOptions {
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
  /** Injectable SDK entry point for tests. Defaults to the SDK's `query`. */
  queryFn?: QueryFn;
}

/** Every built-in tool name OpsCrew knows; anything not enabled for a phase is disallowed. */
const ALL_BUILTINS: readonly BuiltinTool[] = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];

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

type Gate =
  | { allowed: true; decision: "allow" | "approved" }
  | { allowed: false; decision: "deny" | "refused"; reason: string };

/**
 * `AgentRuntime` backed by the Claude Agent SDK (FR-010). Every tool call passes through the tool
 * policy in a pre-tool-use hook and in the permission callback (whatever the permission mode),
 * no user or project Claude settings are loaded, the agent environment is sanitised and every
 * text that leaves the runtime is redacted.
 */
export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id = "claude-agent-sdk";
  readonly #options: ClaudeAgentRuntimeOptions;
  readonly #queryFn: QueryFn;
  readonly #defaultModel: string;

  constructor(options: ClaudeAgentRuntimeOptions) {
    this.#options = options;
    this.#queryFn = options.queryFn ?? query;
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
      this.#queryFn,
      this.#defaultModel,
      this.#env(),
      request,
    ).run();
  }

  #env(): Record<string, string | undefined> {
    return this.#options.env ?? process.env;
  }
}

/** State and behaviour for one `runPhase` call. */
class PhaseRun<T> {
  readonly #gates = new Map<string, Promise<Gate>>();
  #sessionId: string | undefined;
  #model: string | undefined;
  #lastText = "";
  #refused = false;

  constructor(
    private readonly options: ClaudeAgentRuntimeOptions,
    private readonly queryFn: QueryFn,
    private readonly defaultModel: string,
    private readonly env: Record<string, string | undefined>,
    private readonly request: PhaseRequest<T>,
  ) {}

  async run(): Promise<PhaseResult<T>> {
    const { request } = this;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (this.#isAborted()) return this.#finish(this.#aborted());
    request.signal?.addEventListener("abort", onAbort, { once: true });

    let result: SDKResultMessage | undefined;
    let failure: PhaseResult<T> | undefined;
    try {
      const stream = this.queryFn({
        prompt: this.#redact(request.prompt),
        options: this.buildOptions(controller),
      });
      for await (const message of stream) {
        if (message.type === "result") result = message;
        else this.#observe(message);
      }
    } catch (error) {
      failure =
        this.#isAborted() || isAbortError(error)
          ? this.#aborted()
          : this.#failed(`The Claude agent failed: ${errorMessage(error)}`);
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
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
    const tools = request.tools ?? [];
    const mcpNames = tools.map((definition) => mcpToolName(definition.name));
    const systemPrompt = this.#redact(request.systemPrompt);

    const options: Options = {
      abortController: controller,
      cwd: request.projectRoot,
      model: request.model ?? this.defaultModel,
      systemPrompt:
        request.profile === "edit-repo"
          ? { type: "preset", preset: "claude_code", append: systemPrompt }
          : systemPrompt,
      tools: [...builtins],
      allowedTools: [...builtins, ...mcpNames],
      disallowedTools: [
        ...ALL_BUILTINS.filter((name) => !builtins.includes(name)),
        ...ALWAYS_DISALLOWED,
      ],
      permissionMode: "default",
      canUseTool: this.#canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.#preToolUse] }],
        PostToolUse: [{ hooks: [this.#postToolUse] }],
        PostToolUseFailure: [{ hooks: [this.#postToolUse] }],
      },
      settingSources: [],
      strictMcpConfig: true,
      env: sanitizeAgentEnv(this.env),
    };
    if (tools.length > 0) {
      const ctx = {
        phase: request.phase,
        projectRoot: request.projectRoot,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      options.mcpServers = {
        [MCP_SERVER_NAME]: createToolServer(tools, ctx, this.options.redact),
      };
    }
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

  readonly #preToolUse: HookCallback = async (input, toolUseId): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    this.#sessionId ??= input.session_id;
    const gate = await this.#gate(
      input.tool_name,
      input.tool_input,
      input.tool_use_id ?? toolUseId,
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
    try {
      await this.options.audit.append({
        kind: "tool-call",
        actor: "agent",
        action: input.tool_name,
        phase: this.request.phase,
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
        ...(target === undefined ? {} : { target: shorten(this.#redact(target)) }),
        decision: gate?.allowed === true ? gate.decision : "allow",
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
    if (redacted.changed) {
      return {
        hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: redacted.value },
      };
    }
    return {};
  };

  /** Policy decision for one tool call, computed once per tool-use id (hook and callback share it). */
  #gate(tool: string, input: unknown, toolUseId: string | undefined): Promise<Gate> {
    if (toolUseId !== undefined) {
      const known = this.#gates.get(toolUseId);
      if (known !== undefined) return known;
    }
    const pending = this.#decide(tool, input).catch(
      (): Gate => ({
        allowed: false,
        decision: "deny",
        reason: "OpsCrew could not check this tool call, so it was denied.",
      }),
    );
    if (toolUseId !== undefined) this.#gates.set(toolUseId, pending);
    return pending;
  }

  async #decide(tool: string, input: unknown): Promise<Gate> {
    const { request } = this;
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
      action: tool,
      phase: this.request.phase,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(target === undefined ? {} : { target: shorten(this.#redact(target)) }),
      decision,
      detail: reason,
    });
    this.#emit({ kind: "tool-denied", tool, message: `${tool} denied: ${reason}` });
    return { allowed: false, decision, reason };
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
      usage: toUsage(message),
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
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return {
        ...base,
        stopReason: "invalid_output",
        error: this.#redact(
          `The model's output did not match the expected ${request.output.name} format (${issues}).`,
        ),
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

function toUsage(message: SDKResultMessage): PhaseUsage {
  const perModel = Object.values(message.modelUsage ?? {});
  if (perModel.length > 0) {
    return perModel.reduce<Required<PhaseUsage>>(
      (sum, usage) => ({
        inputTokens: sum.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (usage.outputTokens ?? 0),
        cacheReadTokens: sum.cacheReadTokens + (usage.cacheReadInputTokens ?? 0),
        cacheCreationTokens: sum.cacheCreationTokens + (usage.cacheCreationInputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    );
  }
  const usage = message.usage;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/** A short, human-readable description of what a tool call touches (path, command, pattern). */
function describeInput(tool: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
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

/** Redacts every string inside a JSON-like value; `changed` tells whether anything was masked. */
export function redactDeep(
  value: unknown,
  redact: (text: string) => string,
): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      const masked = redact(node);
      if (masked !== node) changed = true;
      return masked;
    }
    if (depth > 50 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, item]) => [
        key,
        walk(item, depth + 1),
      ]),
    );
  };
  const result = walk(value, 0);
  return { value: changed ? result : value, changed };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
