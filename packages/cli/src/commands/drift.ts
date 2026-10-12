import { providerProfile, renderDriftReport, runDrift } from "@opscrew/agents";
import type { Reporter, VpsProviderId } from "@opscrew/contracts";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps } from "../deps";
import { CliExit, ERROR_EXIT_CODE, REFUSED_EXIT_CODE } from "../exit";
import { runPhaseCommand, usageErrorsExit2 } from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { printNextSteps } from "../ui/output";

interface DriftFlags {
  json?: boolean;
  engine?: "tofu" | "terraform";
}

/** Progress is dropped for `--json` so stdout holds only the report; problems go to stderr. */
function quietReporter(ctx: CliContext): Reporter {
  return {
    step: () => {},
    info: () => {},
    success: () => {},
    warn: (message) => ctx.reporter.warn(message),
    error: (message) => ctx.reporter.error(message),
  };
}

/** The deployment's cloud provider by name; reports made before DigitalOcean support are Hetzner's. */
function providerName(provider: VpsProviderId | undefined): string {
  return providerProfile(provider ?? "hetzner").displayName;
}

/**
 * `opscrew drift`: compares the live infrastructure with the state (changes made outside OpsCrew),
 * the state with the infrastructure code (changes not applied yet) and the repository files with
 * what OpsCrew renders (FR-304). Never changes anything. Exit codes: 0 everything matches,
 * 1 something differs, 2 the check could not run (missing state or passphrase, credentials, …).
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("drift")
    .description("Check whether the live infrastructure still matches the plan (changes nothing)")
    .option("--json", "Print the report as JSON")
    .addOption(
      new Option("--engine <name>", "Infrastructure engine to use instead of the plan's").choices([
        "tofu",
        "terraform",
      ]),
    )
    .exitOverride(usageErrorsExit2)
    .action(async (flags: DriftFlags) => {
      const json = flags.json === true;
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(json ? { reporter: quietReporter(ctx) } : {}),
      });
      const services = deployServicesOf(ctx).provision;
      // Exit 1 means "something differs"; anything that stopped the check is an error (exit 2),
      // so scripts never mistake missing state or a missing passphrase for drift.
      const report = await runPhaseCommand(ctx, () =>
        runDrift(deps, {
          ...(flags.engine === undefined ? {} : { engine: flags.engine }),
          ...(services === undefined ? {} : { services }),
        }),
      ).catch((error: unknown) => {
        throw error instanceof CliExit && error.exitCode !== 0
          ? new CliExit(ERROR_EXIT_CODE)
          : error;
      });
      if (json) {
        ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
        if (!report.clean) throw new CliExit(REFUSED_EXIT_CODE);
        return;
      }
      ctx.stdout(`${renderDriftReport(report)}\n`);
      if (report.clean) {
        printNextSteps(ctx, [
          `nothing to do; run \`opscrew drift\` again after changes in the ${providerName(report.provider)} or Cloudflare console.`,
        ]);
        return;
      }
      printNextSteps(ctx, [
        "to undo changes made outside OpsCrew and apply pending code, run `opscrew provision` (it shows the plan first).",
        "to keep a change made in the console, update opscrew/plan.yaml to match before you provision again.",
      ]);
      throw new CliExit(REFUSED_EXIT_CODE);
    });
}
