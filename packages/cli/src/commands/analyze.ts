import { runAnalyze } from "@opscrew/agents";
import { toPosixRelative } from "@opscrew/core";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, MODEL_SETUP_HINT, modelOption } from "../deps";
import { addAppOption, chooseApp } from "../ui/app";
import { printCosts, printNextSteps } from "../ui/output";

interface AnalyzeFlags {
  ai: boolean;
  model?: string;
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--dir <folder>`: the first app's folder, in a repository with several apps. */
  dir?: string;
}

/**
 * `opscrew analyze`: deterministic detection written to `opscrew/architecture.json` and
 * `opscrew/ARCHITECTURE.md`, refined by the read-only Analyst when a model is configured and
 * `--no-ai` is not given (FR-104). `--app` picks the repository's app; `--dir` the first app's
 * folder in a repository with several (a further app's is its record's).
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("analyze")
    .description("Analyse the app: frameworks, services and environment variables")
    .option("--no-ai", "Use only the deterministic analysis (no model, no cost)")
    .option("--model <id>", "Model for the Analyst (default claude-haiku-5-5, or OPSCREW_MODEL)")
    .option(
      "--dir <folder>",
      "In a repository with several apps, the folder of the app to deploy (`.` for the whole repository)",
    );
  addAppOption(command).action(async (flags: AnalyzeFlags) => {
    const model = modelOption(ctx, flags.model);
    const app = await chooseApp(ctx, flags.app, "analyze");
    const deps = createPhaseDeps(ctx, {
      ai: flags.ai,
      app: app.key,
      ...(model === undefined ? {} : { model }),
    });
    const result = await runAnalyze(deps, {
      ai: flags.ai,
      ...(model === undefined ? {} : { model }),
      ...(flags.dir === undefined ? {} : { appDir: flags.dir }),
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
    const markdown = toPosixRelative(deps.paths.root, deps.paths.files.architectureMd);
    printNextSteps(ctx, [
      `review ${markdown}, then run \`opscrew interview${app.flag}\` to describe your traffic, budget and domain.`,
    ]);
  });
}
