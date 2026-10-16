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
  "retarget",
] as const;
export type PhaseName = (typeof PHASES)[number];

/** Reasoning effort requested from the model. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What an LLM phase is allowed to do. Enforced by the tool policy (`ToolPolicy`), never by
 * prompts alone.
 * - `none`: no tools; the phase only answers (with its structured output when it asks for one).
 * - `read-only`: read, list and search files inside the project root.
 * - `edit-repo`: additionally edit and create files inside the project root and run allow-listed
 *   read-only commands; running project code (package managers, build and test runners) needs a
 *   human approval, and git writes are denied.
 */
export type ToolProfile = "none" | "read-only" | "edit-repo";

/** Built-in agent tools that a profile may enable. */
export const BUILTIN_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

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
