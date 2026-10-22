import { stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  environmentFlag,
  type PhaseDeps,
  portainerAddressNames,
  readServerAddresses,
  resolveEnvironment,
  runnerHostAddresses,
} from "@opscrew/agents";
import type { ApprovalHandler, UserFacingError } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, replaceNames, resolveProjectPaths } from "@opscrew/core";
import { environmentsOf } from "@opscrew/plan-schema";
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

/** The `environment` input of the tools that act on one of the app's environments. */
export const environmentInput = {
  environment: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The app's environment to act on, for example staging (opscrew_env_list names them). Leave it out while the app has only prod; with several, name the one the user means.",
    ),
};

/** The environment a tool call acts on, and ` --env <name>` for the commands it suggests. */
export interface ToolEnvironment {
  name: string;
  /** ` --env <name>` while the app has several environments (a terminal run needs it), else empty. */
  flag: string;
}

/**
 * The environment of a call (agents' `resolveEnvironment`, which asks no one here): `requested`,
 * else the only one; with several and none named, `PHASE_PRECONDITION` with their names.
 */
export async function toolEnvironment(
  projectDir: string,
  requested: string | undefined,
): Promise<ToolEnvironment> {
  let name: string;
  try {
    name = await resolveEnvironment(projectDir, requested);
  } catch (error) {
    // Several environments and none named: the tools take `environment`, not `--env`.
    if (requested !== undefined || !isUserFacingError(error)) throw error;
    if (error.code !== "PHASE_PRECONDITION") throw error;
    const names = await environmentsOf(projectDir);
    withHint(error, `Pass environment, for example ${names.find((n) => n !== "prod")}.`);
  }
  return { name, flag: await environmentFlag(projectDir, name) };
}

/** The annotations of a tool that writes files but deletes nothing and can safely run again. */
export const IDEMPOTENT_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** The sentence for an applied Cloudflare plan (OpsCrew's shared Cloudflare resources). */
export function appliedCloudflarePlan(hash: string): string {
  return `Applied the Cloudflare plan ${hash} (OpsCrew's shared Cloudflare resources).`;
}

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
  /**
   * Builds (once) the `PhaseDeps` for this call with the collecting reporter, for `environment`
   * ({@link toolEnvironment}; default prod).
   */
  phaseDeps(extras?: {
    approvalHandler?: ApprovalHandler;
    environment?: string;
  }): Promise<PhaseDeps>;
}

/** Validates `projectDir` (absolute, an existing directory), defaulting to the server's cwd. */
async function resolveProjectDir(deps: ResolvedMcpDeps, input?: string): Promise<string> {
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
function successResult(
  deps: ResolvedMcpDeps,
  output: ToolOutput,
  messages: readonly ReportedMessage[],
): CallToolResult {
  const text = deps.redactor.redact(output.text + warningsSection(messages, output.text));
  return {
    content: [{ type: "text", text }],
    structuredContent: clean(deps, { ...output.data, messages }),
  };
}

/** Turns any error into a user-facing one; unexpected errors get a generic message and hint. */
function toUserFacing(error: unknown): UserFacingError {
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
function errorResult(
  deps: ResolvedMcpDeps,
  error: unknown,
  messages: readonly ReportedMessage[],
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

/** The names that must not reach the model, by what replaces them. */
interface HiddenNames {
  /** The address of the user's own server and the public addresses OpsCrew recorded. */
  server: string[];
  /** The address of the user's Portainer: its URL, origin and host name. */
  portainer: string[];
  /** The address and login of each runner machine of the user's. */
  runner: string[];
}

/**
 * {@link HiddenNames} from every environment's `server.json` (local state only); an environment
 * whose record is unreadable adds none.
 */
async function hiddenNames(deps: ResolvedMcpDeps, projectDir: string): Promise<HiddenNames> {
  const environments = await environmentsOf(projectDir).catch(() => ["prod"]);
  const names: HiddenNames = { server: [], portainer: [], runner: [] };
  for (const environment of environments.length === 0 ? ["prod"] : environments) {
    try {
      const { own, portainer } = await readServerAddresses(
        resolveProjectPaths(projectDir, { env: deps.env, environment }),
      );
      names.server.push(
        ...[own?.host, own?.publicIpv4, own?.publicIpv6].filter(
          (name): name is string => typeof name === "string" && name.trim() !== "",
        ),
      );
      if (portainer !== undefined) names.portainer.push(...portainerAddressNames(portainer.url));
    } catch {
      // An unreadable record names nothing to hide.
    }
  }
  names.runner.push(
    ...(await runnerHostAddresses(resolveProjectPaths(projectDir, { env: deps.env }))),
  );
  return names;
}

/**
 * `text` with every Portainer name ({@link portainerAddressNames}) replaced by "your Portainer"
 * in one pass (longest names first), matched case-insensitively and only as a whole name, as the
 * redactor matches them: a host name such as `nas` stays intact inside question ids (`nas.url`),
 * stack names (`opscrew-shop-nas-tunnel`) or other words.
 */
export function withoutPortainer(text: string, names: readonly string[]): string {
  return replaceNames(text, names, "your Portainer");
}

/**
 * `value` with every own-server name replaced by "your server" and every Portainer name by
 * "your Portainer" in every string, deeply.
 */
function hideNames<T>(value: T, names: HiddenNames): T {
  if (names.server.length === 0 && names.portainer.length === 0 && names.runner.length === 0) {
    return value;
  }
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      // A runner machine's user@host login, then its address alone (replaceNames: longest first).
      const machines = replaceNames(item, names.runner, "your runner machine");
      return withoutPortainer(replaceNames(machines, names.server, "your server"), names.portainer);
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    }
    return item;
  };
  return walk(value) as T;
}

/**
 * Runs one tool call: resolves `projectDir`, gives the body a collecting reporter and lazy
 * `PhaseDeps`, and maps the outcome to a redacted result (errors → `isError: true`). Then the
 * address of a server the user owns is hidden in the redacted result (FR-902): it reads "your
 * server" instead; the address of the user's Portainer reads "your Portainer" (FR-1002).
 * Unexpected errors are logged (stderr in production) with their stack.
 */
export async function runTool(
  deps: ResolvedMcpDeps,
  tool: string,
  projectDirArg: string | undefined,
  body: (call: ToolCall) => Promise<ToolOutput>,
): Promise<CallToolResult> {
  const reporter = new CollectingReporter(deps.redactor.redact);
  let projectDir: string | undefined;
  let result: CallToolResult;
  try {
    const dir = await resolveProjectDir(deps, projectDirArg);
    projectDir = dir;
    let built: Promise<PhaseDeps> | undefined;
    const call: ToolCall = {
      projectDir: dir,
      reporter,
      phaseDeps: (extras = {}) => {
        built ??= Promise.resolve(
          deps.createPhaseDeps(dir, { reporter, redactor: deps.redactor, ...extras }),
        );
        return built;
      },
    };
    result = successResult(deps, await body(call), reporter.messages);
  } catch (error) {
    if (!isUserFacingError(error)) {
      deps.log(
        `${tool} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
    result = errorResult(deps, error, reporter.messages);
  }
  if (projectDir === undefined) return result;
  return hideNames(result, await hiddenNames(deps, projectDir));
}

/** True for an `ArtifactError` / `OpsCrewError` with code `ARTIFACT_MISSING`. */
export function isMissingArtifact(error: unknown): boolean {
  return isUserFacingError(error) && error.code === "ARTIFACT_MISSING";
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
