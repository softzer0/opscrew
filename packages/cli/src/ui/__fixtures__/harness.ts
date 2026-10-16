/**
 * Test harness for the CLI commands: temp projects copied from `examples/`, an environment
 * without real credentials, a git-only command runner, a recording fetch and scripted prompts.
 * For tests only.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandOptions, CommandResult, CommandRunner, FetchLike } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { withServices, type CliServices } from "../../deps";
import { main } from "../../program";
import { createTestContext, type TestContext } from "../../test-context";
import type { UiChoice, UiPrompts } from "../prompts";

/** Absolute path of the repository's `examples/` directory. */
export const EXAMPLES_DIR = fileURLToPath(new URL("../../../../../examples/", import.meta.url));

/** Absolute path of git, or undefined when it is not installed (git tests skip). */
export const GIT = findExecutable("git");

/** A temp directory holding a project and an `OPSCREW_HOME`. */
export interface TempProject {
  /** Project root (a copy of the example, or empty). */
  root: string;
  /** Temp directory containing the project and the home directory. */
  dir: string;
  env: Record<string, string | undefined>;
  cleanup(): Promise<void>;
}

const DROPPED_ENV =
  /^(?:GIT_|GITHUB_TOKEN$|GH_TOKEN$|GH_ENTERPRISE_TOKEN$|ANTHROPIC_|CLAUDE_CODE_|HCLOUD_TOKEN$|DIGITALOCEAN_|CLOUDFLARE_|CF_API_TOKEN$|OPSCREW_|CI$)/i;

/** `process.env` without credentials, git configuration or OpsCrew settings, plus test homes. */
export function testEnv(dir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!DROPPED_ENV.test(key)) env[key] = value;
  }
  return {
    ...env,
    OPSCREW_HOME: path.join(dir, "opscrew-home"),
    GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Copies `examples/<example>` (fake-secret markers expanded) into a fresh temp directory. */
export async function tempProject(example?: string): Promise<TempProject> {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-cli-"));
  const root = path.join(dir, example ?? "app");
  if (example === undefined) await mkdir(root, { recursive: true });
  else await materializeFixture(path.join(EXAMPLES_DIR, example), root);
  await writeFile(
    path.join(dir, "gitconfig"),
    "[user]\n\tname = OpsCrew Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
  );
  return {
    root,
    dir,
    env: testEnv(dir),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/** Runs real git for `git` only; every other command (scanners, `gh`) reports "not found". */
export class GitOnlyRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });
  readonly calls: string[][] = [];
  async run(command: string, args: readonly string[], options?: CommandOptions) {
    this.calls.push([path.basename(command), ...args]);
    if (!/^git(?:\.exe)?$/i.test(path.basename(command))) {
      return { exitCode: 127, stdout: "", stderr: "not found" } satisfies CommandResult;
    }
    return this.#node.run(command, args, options);
  }
}

/** Runs git in `cwd` with `env` and returns stdout (throws on failure). */
export async function git(
  env: Record<string, string | undefined>,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const result = await new NodeCommandRunner().run(GIT ?? "git", ["-C", cwd, ...args], { env });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** A fetch that records every URL and answers 503 (tests that need data pass their own). */
export function recordingFetch(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = async (input: string | URL) => {
    urls.push(String(input));
    return new Response("unavailable in tests", { status: 503 });
  };
  return Object.assign(fetch, { urls });
}

/** One recorded prompt. */
export interface PromptCall {
  kind: "select" | "multiselect" | "text" | "confirm" | "password";
  message: string;
  options?: UiChoice[];
  initial?: unknown;
}

/** The value a scripted prompt returns; `CANCEL` simulates Ctrl+C. */
export const CANCEL: unique symbol = Symbol("cancel");

/**
 * Prompts answering from a script, in order. A text answer is checked with the prompt's
 * `validate` and throws when it would be rejected, so tests notice invalid scripts.
 */
export class ScriptedPrompts implements UiPrompts {
  readonly calls: PromptCall[] = [];
  readonly #answers: unknown[];

  constructor(answers: unknown[]) {
    this.#answers = [...answers];
  }

  #next(call: PromptCall): unknown {
    this.calls.push(call);
    if (this.#answers.length === 0) throw new Error(`No scripted answer for "${call.message}".`);
    return this.#answers.shift();
  }

  async select(options: { message: string; options: UiChoice[]; initialValue?: string }) {
    return this.#next({
      kind: "select",
      message: options.message,
      options: options.options,
      initial: options.initialValue,
    }) as string | symbol;
  }

  async multiselect(options: { message: string; options: UiChoice[]; initialValues?: string[] }) {
    return this.#next({
      kind: "multiselect",
      message: options.message,
      options: options.options,
      initial: options.initialValues,
    }) as string[] | symbol;
  }

  async text(options: {
    message: string;
    initialValue?: string;
    validate?: (value: string | undefined) => string | undefined;
  }) {
    const answer = this.#next({
      kind: "text",
      message: options.message,
      initial: options.initialValue,
    });
    if (typeof answer === "string") {
      const problem = options.validate?.(answer);
      if (problem !== undefined) throw new Error(`Scripted answer "${answer}" rejected: ${problem}`);
    }
    return answer as string | symbol;
  }

  async confirm(options: { message: string; initialValue?: boolean }) {
    return this.#next({
      kind: "confirm",
      message: options.message,
      initial: options.initialValue,
    }) as boolean | symbol;
  }

  async password(options: { message: string }) {
    return this.#next({ kind: "password", message: options.message }) as string | symbol;
  }

  isCancel(value: unknown): value is symbol {
    return value === CANCEL;
  }
}

/** A test context for `project` with a git-only runner and a recording fetch attached. */
export function projectContext(
  project: TempProject,
  options: { interactive?: boolean; services?: CliServices } = {},
): TestContext & { fetchUrls: string[] } {
  const ctx = createTestContext({
    cwd: project.root,
    env: project.env,
    isInteractive: options.interactive ?? false,
  });
  const fetch = recordingFetch();
  withServices(ctx, {
    runner: new GitOnlyRunner(),
    fetch,
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
    ...options.services,
  });
  return Object.assign(ctx, { fetchUrls: fetch.urls });
}

/** Runs `opscrew <args>` with `ctx` and returns the exit code. */
export function run(ctx: TestContext, ...args: string[]): Promise<number> {
  return main(["node", "opscrew", ...args], ctx);
}
