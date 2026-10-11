import type { z } from "zod";

/** OpsCrew phases in pipeline order. */
export const PHASES = [
  "scan",
  "analyze",
  "interview",
  "design",
  "adapt",
  "provision",
  "dns",
  "secure",
  "verify",
] as const;
export type PhaseName = (typeof PHASES)[number];

/** Reasoning effort requested from the model. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What an LLM phase is allowed to do. Enforced by the tool policy (`ToolPolicy`), never by
 * prompts alone.
 * - `none`: no built-in tools; only the in-process tools passed with the request.
 * - `read-only`: read, list and search files inside the project root.
 * - `edit-repo`: additionally edit and create files inside the project root and run allow-listed
 *   build/test/git commands.
 */
export type ToolProfile = "none" | "read-only" | "edit-repo";

/** Built-in agent tools that a profile may enable. */
export type BuiltinTool = "Read" | "Glob" | "Grep" | "Edit" | "Write" | "Bash";

export interface ToolContext {
  phase: PhaseName;
  projectRoot: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Text returned to the model. MUST already be redacted. */
  text: string;
  isError?: boolean;
}

/**
 * An in-process tool exposed to the model (through the agent runtime) or to an MCP client.
 * Mutating tools MUST route their side effect through the approval gate.
 */
export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  /** snake_case, unique within one phase, for example `hetzner_list_offers`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  /** True when the tool changes anything outside the process (files, network writes, providers). */
  readonly mutates: boolean;
  handler(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists need an open schema type.
export type AnyToolDefinition = ToolDefinition<z.ZodObject<any>>;

/** Progress events streamed while a phase runs. `message` is always redacted. */
export interface RuntimeEvent {
  kind: "assistant-text" | "tool-call" | "tool-denied" | "tool-result" | "status";
  message: string;
  tool?: string;
}

export interface PhaseOutputSpec<T> {
  /** Name used in the structured-output request, for example `architecture_summary`. */
  name: string;
  description?: string;
  /** The model's output is validated against this schema; invalid output fails the phase. */
  schema: z.ZodType<T>;
}

export interface PhaseRequest<T = unknown> {
  phase: PhaseName;
  systemPrompt: string;
  prompt: string;
  /** Absolute project root. The agent's working directory and the boundary for file access. */
  projectRoot: string;
  profile: ToolProfile;
  /** Subset of the profile's built-in tools to enable. Defaults to all tools of the profile. */
  builtinTools?: BuiltinTool[];
  /** In-process tools available to the model in addition to built-ins. */
  tools?: AnyToolDefinition[];
  output?: PhaseOutputSpec<T>;
  /** Model id, for example `claude-opus-5-5`. Defaults to the runtime's configured model. */
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  /** Hard spend limit for this phase in US dollars. */
  maxBudgetUsd?: number;
  onEvent?: (event: RuntimeEvent) => void;
  signal?: AbortSignal;
}

export type PhaseStopReason =
  | "completed"
  | "max_turns"
  | "budget_exceeded"
  | "refused"
  | "invalid_output"
  | "aborted"
  | "error";

export interface PhaseUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface PhaseResult<T = unknown> {
  /** True only when `stopReason` is `completed` and, if an output schema was given, it validated. */
  ok: boolean;
  stopReason: PhaseStopReason;
  /** Validated structured output, present when `ok` and an output schema was requested. */
  output?: T;
  /** Final assistant text, redacted. */
  text: string;
  costUsd: number;
  turns: number;
  sessionId?: string;
  model?: string;
  usage?: PhaseUsage;
  /** Plain-English error when `ok` is false. */
  error?: string;
}

export interface RuntimeAvailability {
  ok: boolean;
  /** Why the runtime cannot run, in plain English. */
  reason?: string;
  /** What the user should do, for example "Set ANTHROPIC_API_KEY". */
  hint?: string;
}

/** Runs one LLM-backed phase. Implemented by `@opscrew/runtime-claude`; faked in tests. */
export interface AgentRuntime {
  readonly id: string;
  isConfigured(): Promise<RuntimeAvailability>;
  runPhase<T>(request: PhaseRequest<T>): Promise<PhaseResult<T>>;
}
