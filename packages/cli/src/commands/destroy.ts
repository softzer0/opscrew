import type { Command } from "commander";
import type { CliContext } from "../context";
import { CliExit, ERROR_EXIT_CODE } from "../exit";

/** `opscrew destroy`: placeholder until task T310 (specs/003-day2-operations) lands. */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("destroy")
    .description("Delete the deployment's infrastructure (asks for the server name)")
    .action(() => {
      ctx.reporter.error("`opscrew destroy` is not available yet.");
      throw new CliExit(ERROR_EXIT_CODE);
    });
}
