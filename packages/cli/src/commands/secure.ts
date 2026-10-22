import { runSecure } from "@opscrew/agents";
import { toPosixRelative } from "@opscrew/core";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { printNextSteps } from "../ui/output";

/**
 * `opscrew secure`: re-runs the repository scan, re-checks the applied plan's policies, runs the
 * hardening checks on the server over SSH and probes its ports from outside, then writes
 * `opscrew/SECURITY_REPORT.md` (FR-216). `--deep` also runs Lynis on the server, and ssh-audit and
 * testssl.sh in Docker on this computer, read-only (FR-1420). A self-hosted runner's state is
 * among the checks (FR-1530). `--env` picks the environment, whose own report it writes. Exit
 * codes: 0 nothing failed, 1 a check failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("secure")
    .description("Check the server's hardening and write the security report")
    .option(
      "--deep",
      "Also audit the whole server (Lynis), its SSH service (ssh-audit) and the TLS visitors see (testssl.sh); changes nothing",
    );
  addEnvOption(command).action(async (flags: { deep?: boolean; env?: string }) => {
    const { name, flag } = await chooseEnvironment(ctx, flags.env, "secure");
    const deps = createPhaseDeps(ctx, { ai: false, environment: name });
    const result = await runSecure(deps, {
      ...servicesOf(ctx).secure,
      ...(flags.deep === true ? { deep: true } : {}),
    });
    if (result.passed) {
      printNextSteps(ctx, [
        `keep ${result.reportPath} with your records and run \`opscrew secure${flag}\` again after server or infrastructure changes.`,
        `run \`opscrew verify${flag}\` to check the live site and refresh ${toPosixRelative(deps.paths.root, deps.paths.files.runbook)}.`,
      ]);
      return;
    }
    printNextSteps(ctx, [
      `fix the problems listed in ${result.reportPath} (each one says how), then run \`opscrew secure${flag}\` again.`,
    ]);
    throw new CliExit(REFUSED_EXIT_CODE);
  });
}
