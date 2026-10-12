import type { Command } from "commander";
import type { CliContext } from "../context";
import { CliExit, ERROR_EXIT_CODE } from "../exit";

/** `opscrew drift`: placeholder until task T310 (specs/003-day2-operations) lands. */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("drift")
    .description("Check whether the live infrastructure still matches the plan")
    .action(() => {
      ctx.reporter.error("`opscrew drift` is not available yet.");
      throw new CliExit(ERROR_EXIT_CODE);
    });
}
