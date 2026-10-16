import { runSecure } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { printNextSteps } from "../ui/output";

/**
 * `opscrew secure`: re-runs the repository scan, re-checks the applied plan's policies, runs the
 * hardening checks on the server over SSH and probes its ports from outside, then writes
 * `opscrew/SECURITY_REPORT.md` (FR-216). Exit codes: 0 nothing failed, 1 a check failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("secure")
    .description("Check the server's hardening and write the security report")
    .action(async () => {
      const result = await runSecure(
        createPhaseDeps(ctx, { ai: false }),
        servicesOf(ctx).secure ?? {},
      );
      if (result.passed) {
        printNextSteps(ctx, [
          `keep ${result.reportPath} with your records and run \`opscrew secure\` again after server or infrastructure changes.`,
          "run `opscrew verify` to check the live site and refresh opscrew/RUNBOOK.md.",
        ]);
        return;
      }
      printNextSteps(ctx, [
        `fix the problems listed in ${result.reportPath} (each one says how), then run \`opscrew secure\` again.`,
      ]);
      throw new CliExit(REFUSED_EXIT_CODE);
    });
}
