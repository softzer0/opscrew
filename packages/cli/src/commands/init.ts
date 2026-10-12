import { ensureGitignore, type InitCheck, initPassed, runInitChecks } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { runPhaseCommand, usageErrorsExit2 } from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { printNextSteps } from "../ui/output";

interface InitFlags {
  fix?: boolean;
  offline?: boolean;
}

const MARK: Record<InitCheck["status"], string> = { pass: "✓", warn: "!", fail: "✗", skip: "-" };

function checklist(checks: readonly InitCheck[]): string {
  const lines = ["OpsCrew preflight", ""];
  for (const check of checks) {
    // " — ", not ":", so "Hetzner Cloud token: HCLOUD_TOKEN" never looks like a labelled secret.
    lines.push(`  ${MARK[check.status]} ${check.title} — ${check.message}`);
    if (check.fix !== undefined && check.status !== "pass") lines.push(`      ${check.fix}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `opscrew init`: checks everything the flow needs (git and a GitHub remote, OpenTofu or
 * Terraform, ssh, tokens and their access, an optional model key, `.opscrew/` in `.gitignore`) and
 * prints a checklist with the fix for every problem (FR-306). Offers to ignore `.opscrew/` (or does
 * it with `--fix`). Exit codes: 0 ready, 1 a required check failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("init")
    .description("Check that everything OpsCrew needs is installed and configured")
    .option("--fix", "Add .opscrew/ to .gitignore without asking")
    .option("--offline", "Do not verify tokens over the network (only check they are set)")
    .exitOverride(usageErrorsExit2)
    .action(async (flags: InitFlags) => {
      const deps = createPhaseDeps(ctx, { ai: false });
      const services = deployServicesOf(ctx).init;
      let checks = await runPhaseCommand(ctx, () =>
        runInitChecks(deps, {
          ...(flags.offline === true ? { offline: true } : {}),
          ...(services === undefined ? {} : { services }),
        }),
      );
      const gitignore = checks.find((check) => check.id === "gitignore");
      const offerGitignore = gitignore !== undefined && gitignore.status !== "pass";
      // --fix asks nothing, so the checklist can already show the result.
      if (offerGitignore && flags.fix === true) {
        const changed = await runPhaseCommand(ctx, () => ensureGitignore(deps, { fix: true }));
        if (changed) {
          checks = checks.map((check) =>
            check.id === "gitignore"
              ? { ...check, status: "pass", message: "added .opscrew/ to .gitignore" }
              : check,
          );
        }
      }
      ctx.stdout(checklist(checks));
      // Without --fix the question comes after the checklist, so the user sees why it is asked.
      if (offerGitignore && flags.fix !== true) {
        await runPhaseCommand(ctx, () => ensureGitignore(deps));
      }
      if (!initPassed(checks)) {
        printNextSteps(ctx, [
          "fix the items marked ✗ (each line says how), then run `opscrew init` again.",
        ]);
        throw new CliExit(REFUSED_EXIT_CODE);
      }
      printNextSteps(ctx, [
        "run `opscrew scan` to check the repository for security problems.",
        "then `opscrew analyze`, `opscrew interview` and `opscrew design` to plan the deployment.",
      ]);
    });
}
