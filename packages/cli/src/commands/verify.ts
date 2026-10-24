import { runVerify } from "@opscrew/agents";
import { toPosixRelative } from "@opscrew/core";
import { isServerlessProvider } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { secureServerStep, secureSiteStep } from "./provision";

interface VerifyFlags {
  /** `--url <route>`: the user's Portainer behind their own reverse proxy only. */
  url?: string;
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: the app's environment. */
  env?: string;
}

/**
 * `opscrew verify`: checks DNS, HTTPS and the certificate, the redirect, the health endpoint,
 * security headers, that secrets are not served, that the origin is not reachable around
 * Cloudflare and the latest deploy run, then writes `opscrew/RUNBOOK.md` (FR-216). For an app in
 * the user's Portainer behind their own reverse proxy, `--url <route>` checks the address the
 * proxy serves it on instead of the domain (FR-1015); every line shown passes through the
 * redactor, so Portainer's address never appears. `--env` picks the environment, whose own
 * runbook it writes. Exit codes: 0 every check passed (warnings allowed), 1 a check failed,
 * 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("verify")
    .description("Check that the deployment is up, healthy and secure")
    .option(
      "--url <route>",
      "Your Portainer behind your own reverse proxy: check this address (where your proxy serves the app) instead of the domain",
    );
  addEnvOption(command).action(async (flags: VerifyFlags) => {
    const url = flags.url?.trim();
    const { app, name, flag } = await chooseEnvironment(ctx, flags, "verify");
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const report = toPosixRelative(deps.paths.root, deps.paths.files.securityReport);
    const result = await runVerify(deps, {
      ...servicesOf(ctx).verify,
      ...(url === undefined || url === "" ? {} : { url }),
    });
    if (result.passed) {
      const { provider } = result.plan.target;
      if (isServerlessProvider(provider)) {
        printNextSteps(ctx, [
          `read ${result.runbookPath}: it explains deploys, status, rollbacks and destroy.`,
          secureSiteStep(flag, report),
        ]);
        return;
      }
      const portainer = provider === "portainer";
      printNextSteps(ctx, [
        portainer
          ? `read ${result.runbookPath}: it explains deploys, rollbacks, logs, backups and secret rotation in your Portainer.`
          : `read ${result.runbookPath}: it explains deploys, rollbacks, logs, SSH access, backups and secret rotation.`,
        portainer
          ? `run \`opscrew secure${flag}\` to check the app's stack in your Portainer and write ${report}.`
          : secureServerStep(flag, report),
      ]);
      return;
    }
    printNextSteps(ctx, [
      `fix the failed checks above (a deploy that is still running can cause some), then run \`opscrew verify${flag}\` again.`,
    ]);
    throw new CliExit(REFUSED_EXIT_CODE);
  });
}
