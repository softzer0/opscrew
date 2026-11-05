import {
  applyProposal,
  type RunAdviseOptions,
  renderAdviceReport,
  renderAppliedProposal,
  runAdvise,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { quietReporter } from "../reporter";
import { addEnvOption, chooseEnvironment } from "../ui/environment";

interface AdviseFlags {
  /** `--apply <id>`: the proposal to apply. */
  apply?: string;
  json?: boolean;
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: the app's environment. */
  env?: string;
}

/**
 * `opscrew advise`: reads the environment (each server's figures, with self-hosted monitoring its
 * 14 days, the plan, the interview's answers, the providers' prices, Dependabot and the tokens'
 * expiry) and lists what to change, the most urgent first, each with its figures, its monthly price
 * before and after and how to apply it; it changes nothing. `--json` prints the report for scripts.
 * `--apply <id>` applies one proposal on a fresh reading: a plan proposal writes only its field of
 * the plan (then `opscrew provision` applies it after its hash is approved); the others print the
 * command that applies them, or what to do by hand.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("advise")
    .description(
      "Propose what to change in a deployed environment (size, cost, reliability, upkeep, security), each with its figures, its monthly price and how to apply it (changes nothing)",
    )
    .option(
      "--apply <id>",
      "Apply one proposal: write its change into the plan for `opscrew provision`, or print the command that applies it",
    )
    .option("--json", "Print the proposals as JSON");
  addEnvOption(command).action(async (flags: AdviseFlags) => {
    const json = flags.json === true;
    const id = flags.apply?.trim();
    if (json && id !== undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "--json lists the proposals; it doesn't go with --apply. Nothing was changed.",
        { hint: "Run `opscrew advise --json` for the list, or `opscrew advise --apply <id>`." },
      );
    }
    const { app, name, flag } = await chooseEnvironment(ctx, flags, "advise");
    // Progress is dropped for `--json` so stdout holds only the report; problems go to stderr.
    const deps = createPhaseDeps(ctx, {
      ai: false,
      app,
      environment: name,
      ...(json ? { reporter: quietReporter(ctx.reporter) } : {}),
    });
    const services = servicesOf(ctx).provision;
    const options: RunAdviseOptions = services === undefined ? {} : { services };
    const plan = await readArtifact("plan", deps.paths.files.plan);
    if (id !== undefined) {
      const applied = await applyProposal(deps, plan, id, options);
      ctx.stdout(`${renderAppliedProposal(applied)}\n`);
      return;
    }
    const report = await runAdvise(deps, plan, options);
    ctx.stdout(`${json ? JSON.stringify(report, null, 2) : renderAdviceReport(report, flag)}\n`);
  });
}
