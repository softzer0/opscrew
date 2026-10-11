import { stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PhaseDeps } from "@opscrew/agents";
import type { ApprovalHandler, UserFacingError } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { CollectingReporter, type ReportedMessage, type ResolvedMcpDeps } from "../deps";

/** The `projectDir` input every OpsCrew tool accepts. */
export const projectDirInput = {
  projectDir: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path of the project's repository root. Defaults to the MCP server's working directory.",
    ),
};

/** What a tool body returns: plain text for the model plus machine-readable data. */
export interface ToolOutput {
  text: string;
  data: Record<string, unknown>;
}

/** Context of one tool call. */
export interface ToolCall {
  /** Absolute, existing project directory. */
  projectDir: string;
  /** Collects phase messages; they are returned as `messages` in the structured content. */
  reporter: CollectingReporter;
  /** Builds (once) the `PhaseDeps` for this call with the collecting reporter. */
  phaseDeps(extras?: { approvalHandler?: ApprovalHandler }): Promise<PhaseDeps>;
}

/** Validates `projectDir` (absolute, an existing directory), defaulting to the server's cwd. */
export async function resolveProjectDir(deps: ResolvedMcpDeps, input?: string): Promise<string> {
  const dir = input ?? deps.cwd;
  if (!path.isAbsolute(dir)) {
    throw new OpsCrewError("INVALID_INPUT", `projectDir must be an absolute path (got "${dir}").`, {
      hint: "Pass the absolute path of the repository root, or omit projectDir to use the server's working directory.",
    });
  }
  let isDirectory = false;
  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new OpsCrewError("INVALID_INPUT", `The project directory ${dir} does not exist.`, {
      hint: "Pass the absolute path of the repository root as projectDir.",
    });
  }
  return path.resolve(dir);
}

/** JSON-safe, redacted copy of `value` (drops `undefined`, class instances become plain data). */
function clean<T>(deps: ResolvedMcpDeps, value: T): T {
  return deps.redactor.redactDeep(JSON.parse(JSON.stringify(value)) as T);
}

function warningsSection(messages: readonly ReportedMessage[], text: string): string {
  const warnings = messages
    .filter((m) => m.level === "warn" || m.level === "error")
    .map((m) => m.message)
    .filter((message) => !text.includes(message));
  if (warnings.length === 0) return "";
  return `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`;
}

/** A successful tool result: text plus `structuredContent`, both redacted. */
export function successResult(
  deps: ResolvedMcpDeps,
  output: ToolOutput,
  messages: readonly ReportedMessage[] = [],
): CallToolResult {
  const text = deps.redactor.redact(output.text + warningsSection(messages, output.text));
  return {
    content: [{ type: "text", text }],
    structuredContent: clean(deps, { ...output.data, messages }),
  };
}

/** Turns any error into a user-facing one; unexpected errors get a generic message and hint. */
export function toUserFacing(error: unknown): UserFacingError {
  if (isUserFacingError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "INTERNAL",
    message: `OpsCrew failed unexpectedly: ${detail}`,
    hint: "Try again. If it keeps failing, run the same step with the opscrew CLI in a terminal and report the error.",
  };
}

/** An error tool result (`isError: true`) with the message and the next step, redacted. */
export function errorResult(
  deps: ResolvedMcpDeps,
  error: unknown,
  messages: readonly ReportedMessage[] = [],
): CallToolResult {
  const failure = toUserFacing(error);
  const text =
    failure.hint === undefined
      ? failure.message
      : `${failure.message}\n\nNext step: ${failure.hint}`;
  return {
    isError: true,
    content: [{ type: "text", text: deps.redactor.redact(text) }],
    structuredContent: clean(deps, { error: failure, messages }),
  };
}

/**
 * Runs one tool call: resolves `projectDir`, gives the body a collecting reporter and lazy
 * `PhaseDeps`, and maps the outcome to a redacted result (errors → `isError: true`). Unexpected
 * errors are logged (stderr in production) with their stack.
 */
export async function runTool(
  deps: ResolvedMcpDeps,
  tool: string,
  projectDirArg: string | undefined,
  body: (call: ToolCall) => Promise<ToolOutput>,
): Promise<CallToolResult> {
  const reporter = new CollectingReporter(deps.redactor.redact);
  try {
    const projectDir = await resolveProjectDir(deps, projectDirArg);
    let built: Promise<PhaseDeps> | undefined;
    const call: ToolCall = {
      projectDir,
      reporter,
      phaseDeps: (extras = {}) => {
        built ??= Promise.resolve(
          deps.createPhaseDeps(projectDir, { reporter, redactor: deps.redactor, ...extras }),
        );
        return built;
      },
    };
    return successResult(deps, await body(call), reporter.messages);
  } catch (error) {
    if (!isUserFacingError(error)) {
      deps.log(
        `${tool} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
    return errorResult(deps, error, reporter.messages);
  }
}

/** Repo-relative POSIX form of an absolute path inside the project (for text and data). */
export function relativeTo(projectDir: string, file: string): string {
  return path.relative(projectDir, file).split(path.sep).join("/");
}

/** True when `file` exists. */
export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/** True for an `ArtifactError` / `OpsCrewError` with code `ARTIFACT_MISSING`. */
export function isMissingArtifact(error: unknown): boolean {
  return errorCode(error) === "ARTIFACT_MISSING";
}

/** Re-throws `error` with a tool-oriented hint when it is user-facing (keeps code and message). */
export function withHint(error: unknown, hint: string): never {
  if (isUserFacingError(error)) {
    throw new OpsCrewError(error.code as OpsCrewError["code"], error.message, {
      hint,
      cause: error,
    });
  }
  throw error;
}
