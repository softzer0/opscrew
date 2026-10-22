import {
  inspectOwnServerForDesign,
  type OwnServerDesignInput,
  readEnvironmentRequirements,
  runDesign,
} from "@opscrew/agents";
import type { Money, Requirements } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { chooseOption } from "../ui/options";
import { addHostKeyOption, checkApproveFlags } from "./provision";

interface DesignFlags {
  option?: string;
  hostKey?: string;
  /** `--env <name>`: the app's environment (one `opscrew env add` added, or prod). */
  env?: string;
}

/**
 * `opscrew design`: prices 2–3 options on the provider chosen in the interview (live when its API
 * token is set, otherwise its dated static price table), lets the user pick one in the terminal (or takes `--option <id>`, or the
 * recommendation when no terminal is available) and writes `opscrew/plan.yaml` (FR-107). For a
 * server the user already owns it first connects (the host key confirmed in the terminal, or
 * `--host-key`, and pinned) and inspects the server read-only, then offers it as the one option,
 * without a price (FR-913). `--env` designs another environment again, from its own answers over
 * prod's.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("design")
    .description("Design the production architecture and estimate its monthly cost")
    .option("--option <id>", "Choose this option without asking (ids are listed by the command)");
  addEnvOption(command);
  addHostKeyOption(command).action(async (flags: DesignFlags) => {
    checkApproveFlags("design", flags);
    const { name, flag } = await chooseEnvironment(ctx, flags.env, "design");
    const deps = createPhaseDeps(ctx, { ai: false, environment: name });
    const optionId = flags.option?.trim() || undefined;
    const interactive = optionId === undefined && ctx.isInteractive;

    const requirements: Requirements | undefined = await readEnvironmentRequirements(
      deps.paths,
    ).catch(() => undefined);
    const budget: Money | undefined = interactive ? requirements?.budgetMonthly : undefined;
    let ownServer: OwnServerDesignInput | undefined;
    if (requirements?.provider === "own") {
      const hostKey = flags.hostKey?.trim();
      const own = servicesOf(ctx).provision?.own;
      ownServer = await inspectOwnServerForDesign(deps, {
        ...(hostKey === undefined ? {} : { hostKey }),
        ...(own === undefined ? {} : { services: own }),
      });
    }
    const prompts = promptsOf(ctx);
    const result = await runDesign(deps, {
      ...(optionId === undefined ? {} : { optionId }),
      ...(ownServer === undefined ? {} : { ownServer }),
      ...(interactive
        ? {
            choose: (options) =>
              chooseOption(options, {
                prompts,
                write: ctx.stdout,
                ...(budget === undefined ? {} : { budget }),
              }),
          }
        : {}),
    });

    if (optionId === undefined && !interactive) {
      const others = result.options.filter((option) => option.id !== result.chosen.id);
      ctx.stdout(
        `\nChose the recommended option, ${result.chosen.id}.${
          others.length > 0
            ? ` To plan another one, run \`opscrew design${flag} --option <id>\` with one of: ${others.map((o) => o.id).join(", ")}.`
            : ""
        }\n`,
      );
    }
    // runDesign itself prints the next step (`opscrew adapt`).
  });
}
