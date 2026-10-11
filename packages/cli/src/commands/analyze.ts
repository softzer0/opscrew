import { runAnalyze } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, MODEL_SETUP_HINT, modelOption } from "../deps";
import { printCosts, printNextSteps } from "../ui/output";

interface AnalyzeFlags {
  ai: boolean;
  model?: string;
}

/**
 * `opscrew analyze`: deterministic detection written to `opscrew/architecture.json` and
 * `opscrew/ARCHITECTURE.md`, refined by the read-only Analyst when a model is configured and
 * `--no-ai` is not given (FR-104).
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("analyze")
    .description("Analyse the app: frameworks, services and environment variables")
    .option("--no-ai", "Use only the deterministic analysis (no model, no cost)")
    .option("--model <id>", "Model for the Analyst (default claude-haiku-5-5, or OPSCREW_MODEL)")
    .action(async (flags: AnalyzeFlags) => {
      const model = modelOption(ctx, flags.model);
      const deps = createPhaseDeps(ctx, {
        ai: flags.ai,
        ...(model === undefined ? {} : { model }),
      });
      const result = await runAnalyze(deps, {
        ai: flags.ai,
        ...(model === undefined ? {} : { model }),
      });

      const { architecture } = result;
      ctx.stdout(`\n${architecture.summary.trim()}\n`);
      if (architecture.risks.length > 0) {
        ctx.stdout(`\nRisks to handle before deploying:\n`);
        for (const risk of architecture.risks) ctx.stdout(`  - ${risk}\n`);
      }
      if (deps.runtime !== undefined && (result.costUsd > 0 || architecture.aiEnriched)) {
        ctx.stdout("\n");
        await printCosts(ctx, deps, result.costUsd);
      }
      if (flags.ai && deps.runtime === undefined) ctx.stdout(`\n${MODEL_SETUP_HINT}\n`);
      printNextSteps(ctx, [
        "review opscrew/ARCHITECTURE.md, then run `opscrew interview` to describe your traffic, budget and domain.",
      ]);
    });
}
