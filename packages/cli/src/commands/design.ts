import { runDesign } from "@opscrew/agents";
import { type Money, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { chooseOption } from "../ui/options";

interface DesignFlags {
  option?: string;
}

/**
 * `opscrew design`: prices 2–3 options on the provider chosen in the interview (live when its API
 * token is set, otherwise its dated static price table), lets the user pick one in the terminal (or takes `--option <id>`, or the
 * recommendation when no terminal is available) and writes `opscrew/plan.yaml` (FR-107).
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("design")
    .description("Design the production architecture and estimate its monthly cost")
    .option("--option <id>", "Choose this option without asking (ids are listed by the command)")
    .action(async (flags: DesignFlags) => {
      const deps = createPhaseDeps(ctx, { ai: false });
      const { catalog } = servicesOf(ctx);
      const optionId = flags.option?.trim() || undefined;
      const interactive = optionId === undefined && ctx.isInteractive;

      let budget: Money | undefined;
      if (interactive) {
        budget = await readArtifact("requirements", deps.paths.files.requirements)
          .then((requirements) => requirements.budgetMonthly)
          .catch(() => undefined);
      }
      const prompts = promptsOf(ctx);
      const result = await runDesign(deps, {
        ...(optionId === undefined ? {} : { optionId }),
        ...(catalog === undefined ? {} : { catalog }),
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
              ? ` To plan another one, run \`opscrew design --option <id>\` with one of: ${others.map((o) => o.id).join(", ")}.`
              : ""
          }\n`,
        );
      }
      // runDesign itself prints the next step (`opscrew adapt`).
    });
}
