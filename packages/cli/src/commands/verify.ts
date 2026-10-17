import { runVerify } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { printNextSteps } from "../ui/output";
import { SECURE_SERVER_STEP } from "./provision";

interface VerifyFlags {
  /** `--url <route>`: the user's Portainer behind their own reverse proxy only. */
  url?: string;
}

/**
 * `opscrew verify`: checks DNS, HTTPS and the certificate, the redirect, the health endpoint,
 * security headers, that secrets are not served, that the origin is not reachable around
 * Cloudflare and the latest deploy run, then writes `opscrew/RUNBOOK.md` (FR-216). For an app in
 * the user's Portainer behind their own reverse proxy, `--url <route>` checks the address the
 * proxy serves it on instead of the domain (FR-1015); every line shown passes through the
 * redactor, so Portainer's address never appears. Exit codes: 0 every check passed (warnings
 * allowed), 1 a check failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("verify")
    .description("Check that the deployment is up, healthy and secure")
    .option(
      "--url <route>",
      "Your Portainer behind your own reverse proxy: check this address (where your proxy serves the app) instead of the domain",
    )
    .action(async (flags: VerifyFlags) => {
      const url = flags.url?.trim();
      const result = await runVerify(createPhaseDeps(ctx, { ai: false }), {
        ...servicesOf(ctx).verify,
        ...(url === undefined || url === "" ? {} : { url }),
      });
      if (result.passed) {
        const portainer = result.plan.target.provider === "portainer";
        printNextSteps(ctx, [
          portainer
            ? `read ${result.runbookPath}: it explains deploys, rollbacks, logs, backups and secret rotation in your Portainer.`
            : `read ${result.runbookPath}: it explains deploys, rollbacks, logs, SSH access, backups and secret rotation.`,
          portainer
            ? "run `opscrew secure` to check the app's stack in your Portainer and write opscrew/SECURITY_REPORT.md."
            : SECURE_SERVER_STEP,
        ]);
        return;
      }
      printNextSteps(ctx, [
        "fix the failed checks above (a deploy that is still running can cause some), then run `opscrew verify` again.",
      ]);
      throw new CliExit(REFUSED_EXIT_CODE);
    });
}
