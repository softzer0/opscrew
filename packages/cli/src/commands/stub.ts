import type { Command } from "commander";
import type { CliContext } from "../context";
import { CliExit } from "../exit";

/** Exit code of commands that are not implemented yet. */
export const NOT_AVAILABLE_EXIT_CODE = 2;

/** Registers a placeholder command that says it is not available yet and exits 2. */
export function registerStub(
  program: Command,
  ctx: CliContext,
  name: string,
  description: string,
): void {
  program
    .command(name)
    .description(description)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      ctx.stderr(`\`opscrew ${name}\` is not available yet.\n`);
      throw new CliExit(NOT_AVAILABLE_EXIT_CODE);
    });
}
