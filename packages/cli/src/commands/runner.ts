import { startLocalRunner } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { addEnvOption, chooseEnvironment } from "../ui/environment";

/**
 * `opscrew runner start [--env <name>]`: runs GitHub's self-hosted runner for an environment on
 * this computer (`environment.runner: local`) in the foreground, so its deploy job deploys to the
 * local stack. It registers the runner, runs one job at a time and registers it again; Ctrl+C
 * stops it gracefully (a running job may finish first) and removes it from GitHub.
 */
export function register(program: Command, ctx: CliContext): void {
  const runner = program
    .command("runner")
    .description("Run an environment's self-hosted GitHub Actions runner on this computer");
  const start = runner
    .command("start")
    .description(
      "Start the runner in the foreground until Ctrl+C, which stops it and removes it from GitHub",
    );
  addEnvOption(start).action(async (flags: { env?: string }) => {
    const { name } = await chooseEnvironment(ctx, flags.env, "runner start");
    const services = servicesOf(ctx).localRunner;
    const local = await startLocalRunner(createPhaseDeps(ctx, { ai: false, environment: name }), {
      environment: name,
      ...(services === undefined ? {} : { services }),
    });
    await local.finished;
  });
}
