import type { Command } from "commander";
import type { CliContext } from "../context";
import { CliExit, ERROR_EXIT_CODE } from "../exit";

/** `opscrew init`: placeholder until task T310 (specs/003-day2-operations) lands. */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("init")
    .description("Check that everything OpsCrew needs is installed and configured")
    .action(() => {
      ctx.reporter.error("`opscrew init` is not available yet.");
      throw new CliExit(ERROR_EXIT_CODE);
    });
}
