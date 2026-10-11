import { runVerify } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { runPhaseCommand, usageErrorsExit2 } from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { printNextSteps } from "../ui/output";

/**
 * `opscrew verify`: checks DNS, HTTPS and the certificate, the redirect, the health endpoint,
 * security headers, that secrets are not served, that the origin is not reachable around
 * Cloudflare and the latest deploy run, then writes `opscrew/RUNBOOK.md` (FR-216). Exit codes:
 * 0 every check passed (warnings allowed), 1 a check failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("verify")
    .description("Check that the deployment is up, healthy and secure")
    .exitOverride(usageErrorsExit2)
    .action(async () => {
      const result = await runPhaseCommand(ctx, () =>
        runVerify(createPhaseDeps(ctx, { ai: false }), deployServicesOf(ctx).verify ?? {}),
      );
      if (result.passed) {
        printNextSteps(ctx, [
          `read ${result.runbookPath}: it explains deploys, rollbacks, logs, SSH access, backups and secret rotation.`,
          "run `opscrew secure` to check the server's hardening and write opscrew/SECURITY_REPORT.md.",
        ]);
        return;
      }
      printNextSteps(ctx, [
        "fix the failed checks above (a deploy that is still running can cause some), then run `opscrew verify` again.",
      ]);
      throw new CliExit(REFUSED_EXIT_CODE);
    });
}
