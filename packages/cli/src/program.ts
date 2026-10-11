import path from "node:path";
import { isUserFacingError } from "@opscrew/core";
import { Command, CommanderError } from "commander";
import { description } from "../package.json";
import { ALL_COMMANDS } from "./commands/index";
import { type CliContext, createDefaultContext } from "./context";
import { CliExit, ERROR_EXIT_CODE, exitCodeFor } from "./exit";

/** Builds the `opscrew` program with every command registered. Errors are thrown, not exited. */
export function createProgram(ctx: CliContext): Command {
  const program = new Command()
    .name("opscrew")
    .description(description)
    .version(ctx.version, "-V, --version", "Print the OpsCrew version")
    .helpOption("-h, --help", "Show help for a command")
    .option("--cwd <dir>", "Project directory to work in (defaults to the current directory)")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.stdout(text),
      writeErr: (text) => ctx.stderr(text),
    })
    .hook("preAction", () => {
      const { cwd } = program.opts<{ cwd?: string }>();
      if (cwd !== undefined) ctx.cwd = path.resolve(ctx.cwd, cwd);
    });
  for (const command of ALL_COMMANDS) command.register(program, ctx);
  return program;
}

/**
 * Runs the CLI for `argv` (as in `process.argv`) and returns the exit code: 0 on success, 1 for
 * errors, or the code a command asked for. Stack traces are printed only with `OPSCREW_DEBUG=1`.
 */
export function main(argv: readonly string[], ctx?: CliContext): Promise<number> {
  const context = ctx ?? createDefaultContext();
  return runProgram(createProgram(context), argv, context);
}

/** Parses `argv` with `program` and maps any error to output and an exit code (see `main`). */
export async function runProgram(
  program: Command,
  argv: readonly string[],
  ctx: CliContext,
): Promise<number> {
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (error) {
    return handleError(error, ctx);
  }
}

function handleError(error: unknown, ctx: CliContext): number {
  // Commander has already printed its own message (or the help / version text); usage errors exit 2.
  if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : ERROR_EXIT_CODE;
  if (error instanceof CliExit) return error.exitCode;

  const debug = ctx.env.OPSCREW_DEBUG === "1";
  if (isUserFacingError(error)) {
    ctx.reporter.error(error.message);
    if (error.hint && !error.message.includes(error.hint)) ctx.stderr(`  ${error.hint}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    ctx.reporter.error(`Something went wrong: ${message}`);
    if (!debug) ctx.stderr("  Re-run with OPSCREW_DEBUG=1 to see the details.\n");
  }
  if (debug && error instanceof Error && error.stack !== undefined) {
    ctx.stderr(`${error.stack}\n`);
  }
  return exitCodeFor(error);
}
