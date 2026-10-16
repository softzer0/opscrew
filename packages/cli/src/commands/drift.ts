import { driftNextSteps, renderDriftReport, runDrift } from "@opscrew/agents";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { CliExit, ERROR_EXIT_CODE, REFUSED_EXIT_CODE } from "../exit";
import { quietReporter } from "../reporter";
import { runPhaseCommand } from "../ui/deploy";
import { printNextSteps } from "../ui/output";
import { addHostKeyOption, checkApproveFlags } from "./provision";

interface DriftFlags {
  json?: boolean;
  engine?: "tofu" | "terraform";
  /** Your own server: the host key fingerprint to trust on the first connection (scripts). */
  hostKey?: string;
}

/**
 * `opscrew drift`: compares the live infrastructure with the state (changes made outside OpsCrew),
 * the state with the infrastructure code (changes not applied yet) and the repository files with
 * what OpsCrew renders (FR-304); on a server the user owns also the server with what OpsCrew set
 * up (FR-911). Never changes anything. Exit codes: 0 everything matches, 1 something differs,
 * 2 the check could not run (missing state or passphrase, credentials, …).
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("drift")
    .description("Check whether the live infrastructure still matches the plan (changes nothing)")
    .option("--json", "Print the report as JSON")
    .addOption(
      new Option("--engine <name>", "Infrastructure engine to use instead of the plan's").choices([
        "tofu",
        "terraform",
      ]),
    );
  addHostKeyOption(command).action(async (flags: DriftFlags) => {
    const json = flags.json === true;
    // Progress is dropped for `--json` so stdout holds only the report; problems go to stderr.
    const deps = createPhaseDeps(ctx, {
      ai: false,
      ...(json ? { reporter: quietReporter(ctx.reporter) } : {}),
    });
    const services = servicesOf(ctx).provision;
    const hostKey = flags.hostKey?.trim();
    // Exit 1 means "something differs"; anything that stopped the check is an error (exit 2),
    // so scripts never mistake missing state or a missing passphrase for drift.
    const report = await runPhaseCommand(ctx, () => {
      checkApproveFlags("drift", flags);
      return runDrift(deps, {
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        ...(hostKey === undefined ? {} : { hostKey }),
        ...(services === undefined ? {} : { services }),
      });
    }).catch((error: unknown) => {
      throw error instanceof CliExit && error.exitCode !== 0 ? new CliExit(ERROR_EXIT_CODE) : error;
    });
    if (json) {
      ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.clean) throw new CliExit(REFUSED_EXIT_CODE);
      return;
    }
    ctx.stdout(`${renderDriftReport(report)}\n`);
    printNextSteps(ctx, driftNextSteps(report));
    if (!report.clean) throw new CliExit(REFUSED_EXIT_CODE);
  });
}
