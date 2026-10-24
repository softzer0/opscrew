import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandRunner, Reporter } from "@opscrew/contracts";
import { exists, findExecutable, isRecord, OpsCrewError, readTextIfExists } from "@opscrew/core";
import { dependencies } from "../package.json";
import type { QueryFn } from "./runtime";

/** The Claude Agent SDK's package name. */
export const CLAUDE_AGENT_SDK = "@anthropic-ai/claude-agent-sdk";

/** The one SDK version OpsCrew is built and tested with, and installs when it is missing. */
export const CLAUDE_AGENT_SDK_VERSION: string = dependencies[CLAUDE_AGENT_SDK];

/** How the runtime finds the SDK on its first phase, or installs it once. */
export interface ClaudeAgentSdkOptions {
  /** OpsCrew's user-level folder (`ProjectPaths.homeDir`); the SDK goes into `claude-agent-sdk`. */
  homeDir: string;
  /** Runs npm for the one-time install. */
  runner: CommandRunner;
  /** Shows the install's progress. */
  reporter: Reporter;
  /**
   * Asks before the download (`question` names its size); true goes ahead. Absent when nobody
   * can answer (no terminal and no `--yes`): the AI step then stops with the install command.
   */
  confirmInstall?: (question: string) => Promise<boolean>;
  /** Imports a package name or a file URL. Default: `import()`. */
  importModule?: (specifier: string) => Promise<unknown>;
}

/**
 * The SDK's `query`: from a copy Node.js resolves (the monorepo, or one installed beside the
 * CLI), else from OpsCrew's own copy in `<homeDir>/claude-agent-sdk` at
 * {@link CLAUDE_AGENT_SDK_VERSION}, which it installs with npm (no install scripts) after asking.
 * `env` is used to find npm.
 */
export async function loadClaudeAgentSdk(
  options: ClaudeAgentSdkOptions,
  env: Record<string, string | undefined>,
): Promise<QueryFn> {
  const importModule = options.importModule ?? ((specifier: string) => import(specifier));
  try {
    return queryOf(await importModule(CLAUDE_AGENT_SDK));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  const dir = path.join(options.homeDir, "claude-agent-sdk");
  const unusable = await unusableCopy(dir);
  if (unusable !== undefined) await install(options, dir, env, unusable);
  const entry = createRequire(path.join(dir, "package.json")).resolve(CLAUDE_AGENT_SDK);
  return queryOf(await importModule(pathToFileURL(entry).href));
}

async function install(
  options: ClaudeAgentSdkOptions,
  dir: string,
  env: Record<string, string | undefined>,
  unusable: string,
): Promise<void> {
  const spec = `${CLAUDE_AGENT_SDK}@${CLAUDE_AGENT_SDK_VERSION}`;
  const args = ["install", "--prefix", dir, "--ignore-scripts", spec];
  const command = `npm install --prefix "${dir}" --ignore-scripts ${spec}`;
  const npm = findExecutable("npm", env);
  if (npm === undefined) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "npm is not installed here, so OpsCrew cannot install the Claude Agent SDK.",
      { hint: "Install npm (it comes with Node.js), then run this again." },
    );
  }
  const question = `OpsCrew's AI agents need the Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION}, ${unusable}. Download it into ${dir} now (about 300 MB, once)?`;
  if (options.confirmInstall === undefined || !(await options.confirmInstall(question))) {
    throw new OpsCrewError(
      "RUNTIME_NOT_CONFIGURED",
      `The AI agents need the Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} (about 300 MB, once), ${unusable}.`,
      { hint: `Install it with \`${command}\`, then run this again.` },
    );
  }
  options.reporter.step(`Installing the Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} into ${dir}`);
  await mkdir(dir, { recursive: true });
  const result = await options.runner.run(npm, args, { env, timeoutMs: 20 * 60_000 });
  if (result.exitCode !== 0) {
    // npm's first error line names the cause; its last one only points at a log file.
    const cause = result.stderr
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^npm (?:error|ERR!) /.test(line) && !line.includes("A complete log"));
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `npm could not install the Claude Agent SDK${cause === undefined ? "" : ` (${cause})`}.`,
      { hint: `Check the network, then run this again, or install it with \`${command}\`.` },
    );
  }
  options.reporter.success("Installed the Claude Agent SDK.");
}

/**
 * Why OpsCrew's own SDK copy in `dir` cannot be used (worded to follow "the SDK X, "), or
 * undefined when it is at {@link CLAUDE_AGENT_SDK_VERSION} with the Claude Code binary for this
 * computer. npm skips that binary's package when it fails and still succeeds, so a copy without
 * it is installed again.
 */
async function unusableCopy(dir: string): Promise<string | undefined> {
  const text = await readTextIfExists(
    path.join(dir, "node_modules", ...CLAUDE_AGENT_SDK.split("/"), "package.json"),
  );
  if (text === undefined) return "which is not installed yet";
  let version: unknown;
  try {
    const manifest: unknown = JSON.parse(text);
    version = isRecord(manifest) ? manifest.version : undefined;
  } catch {
    version = undefined;
  }
  if (version !== CLAUDE_AGENT_SDK_VERSION) {
    return `and the copy in ${dir} is ${typeof version === "string" ? `version ${version}` : "damaged"}`;
  }
  // The packages the SDK looks in for its binary (on Linux the glibc and the musl one), where npm
  // puts them in this folder. Not through Node.js's resolution: NODE_PATH could point elsewhere.
  const binary = `claude${process.platform === "win32" ? ".exe" : ""}`;
  const candidates =
    process.platform === "linux"
      ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
      : [`${process.platform}-${process.arch}`];
  for (const suffix of candidates) {
    const name = `${CLAUDE_AGENT_SDK}-${suffix}`;
    if (await exists(path.join(dir, "node_modules", ...name.split("/"), binary))) return undefined;
  }
  return `and the copy in ${dir} has no Claude Code binary for this computer`;
}

function queryOf(sdk: unknown): QueryFn {
  if (!isRecord(sdk) || typeof sdk.query !== "function") {
    throw new Error(`${CLAUDE_AGENT_SDK} does not export query().`);
  }
  return sdk.query as QueryFn;
}
