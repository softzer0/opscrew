import { stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  commandFlags,
  type PhaseDeps,
  portainerAddressNames,
  readServerAddresses,
  resolveApp,
  resolveEnvironment,
  runnerHostAddresses,
} from "@opscrew/agents";
import type { ApprovalHandler, UserFacingError } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, replaceNames, resolveProjectPaths } from "@opscrew/core";
import { appsOf, environmentsOf } from "@opscrew/plan-schema";
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

/** The `app` input of the tools that act on one of the repository's apps. */
export const appInput = {
  app: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The repository's app to act on: the key opscrew_app_add gave it, or . for the first app (opscrew_app_list names them). Leave it out while the repository has one app; with several, name the one the user means.",
    ),
};

/**
 * The further app's key a call acts on (agents' `resolveApp`, which asks no one here):
 * `requested` (`.` is the first app, `undefined`), else the only one; with several and none
 * named, `PHASE_PRECONDITION` with the apps.
 */
export async function toolApp(
  projectDir: string,
  requested: string | undefined,
): Promise<string | undefined> {
  try {
    return await resolveApp(projectDir, requested);
  } catch (error) {
    // Several apps and none named: the tools take `app`, not `--app`.
    if (requested !== undefined || !isUserFacingError(error)) throw error;
    if (error.code !== "PHASE_PRECONDITION") throw error;
    const example = (await appsOf(projectDir)).find((one) => one.key !== undefined)?.key;
    withHint(error, `Pass app, for example ${example}, or . for the first app.`);
  }
}

/** ` and app <key>` after the other inputs a result names for a tool call on the further app `appKey`, else "". */
export function andApp(appKey: string | undefined): string {
  return appKey === undefined ? "" : ` and app ${appKey}`;
}

/** The app and environment a tool call acts on, and their flags for the commands it suggests. */
export interface ToolEnvironment {
  /** The further app's key; `undefined` for the repository's first app. */
  appKey: string | undefined;
  name: string;
  /**
   * The app's ` --app <key>` (` --app .` for the first app beside further apps), then
   * ` --env <name>` while the app has several environments (a terminal run needs them), else
   * empty.
   */
  flag: string;
}

/**
 * The app ({@link toolApp}) and environment of a call (agents' `resolveEnvironment`, which asks
 * no one here): each as requested, else the only one; with several and none named,
 * `PHASE_PRECONDITION` with their names.
 */
export async function toolEnvironment(
  projectDir: string,
  app: string | undefined,
  requested: string | undefined,
): Promise<ToolEnvironment> {
  const appKey = await toolApp(projectDir, app);
  let name: string;
  try {
    name = await resolveEnvironment(projectDir, requested, { app: appKey });
  } catch (error) {
    // Several environments and none named: the tools take `environment`, not `--env`.
    if (requested !== undefined || !isUserFacingError(error)) throw error;
    if (error.code !== "PHASE_PRECONDITION") throw error;
    const names = await environmentsOf(projectDir, appKey);
    withHint(error, `Pass environment, for example ${names.find((n) => n !== "prod")}.`);
  }
  return { appKey, name, flag: await commandFlags(projectDir, name, appKey) };
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
   * Builds (once) the `PhaseDeps` for this call with the collecting reporter, for the app `app`
   * (a further app's key, {@link toolApp}; default the first app) at `environment`
   * ({@link toolEnvironment}; default prod).
   */
  phaseDeps(extras?: {
    approvalHandler?: ApprovalHandler;
    app?: string | undefined;
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
  /** The addresses the SSH firewall of a runner machine of the user's lets in. */
  sources: string[];
}

/**
 * {@link HiddenNames} from the `server.json` of every app's environments (local state only); an
 * environment whose record is unreadable adds none.
 */
async function hiddenNames(deps: ResolvedMcpDeps, projectDir: string): Promise<HiddenNames> {
  const apps = await appsOf(projectDir).catch(() => [{ key: undefined }]);
  const places: { app?: string; environment: string }[] = [];
  for (const { key } of apps) {
    const environments = await environmentsOf(projectDir, key).catch(() => ["prod"]);
    for (const environment of environments.length === 0 ? ["prod"] : environments) {
      places.push({ ...(key === undefined ? {} : { app: key }), environment });
    }
  }
  const names: HiddenNames = { server: [], portainer: [], runner: [], sources: [] };
  for (const place of places) {
    try {
      const { own, portainer } = await readServerAddresses(
        resolveProjectPaths(projectDir, { env: deps.env, ...place }),
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
  const machines = await runnerHostAddresses(resolveProjectPaths(projectDir, { env: deps.env }));
  names.runner.push(...machines.machines);
  names.sources.push(...machines.sources);
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
 * `value` with every own-server name replaced by "your server", every Portainer name by "your
 * Portainer", every runner machine's by "your runner machine" and every address its SSH firewall
 * lets in by "your address", in every string, deeply.
 */
function hideNames<T>(value: T, names: HiddenNames): T {
  if (Object.values(names).every((list) => list.length === 0)) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      // A runner machine's user@host login, then its address alone (replaceNames: longest first).
      const machines = replaceNames(item, names.runner, "your runner machine");
      const sources = replaceNames(machines, names.sources, "your address");
      return withoutPortainer(replaceNames(sources, names.server, "your server"), names.portainer);
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
