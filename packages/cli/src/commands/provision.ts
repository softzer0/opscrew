import {
  findSavedPlan,
  type PhaseDeps,
  type ProvisionOptions,
  type ProvisionResult,
  runProvision,
} from "@opscrew/agents";
import { isPlanHash, OpsCrewError } from "@opscrew/core";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { assumeYesHint, printPlanHash, runPhaseCommand, usageErrorsExit2 } from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { clackSecretPrompt, createEnvPrompt } from "../ui/env-prompt";
import { printNextSteps } from "../ui/output";

/** Flags shared by `provision` and `dns`. */
export interface InfraFlags {
  planOnly?: boolean;
  approve?: string;
  engine?: "tofu" | "terraform";
  /** False with `--no-push` (`dns` has no such flag, so it stays undefined there). */
  push?: boolean;
  yes?: boolean;
}

/** Help text of `--yes` for the commands that write files, secrets and pull requests. */
export const YES_DESCRIPTION =
  "In a non-interactive run, approve writing the generated files, storing GitHub secrets, pushing and the pull request (infrastructure changes still need --approve <hash>)";

/** Adds `--plan-only` and `--approve <hash>` to `command`. */
export function addPlanApproveOptions(command: Command): Command {
  return command
    .option("--plan-only", "Plan, run the policy checks and print the plan hash; change nothing")
    .option(
      "--approve <hash>",
      "Apply exactly the saved plan with this hash (from an earlier --plan-only run)",
    );
}

/** The command that applies the plan a `--plan-only` run saved, with the flags that matter. */
function approveCommand(command: string, planHash: string, flags: InfraFlags): string {
  return [
    `opscrew ${command} --approve ${planHash}`,
    ...(flags.engine === undefined ? [] : [`--engine ${flags.engine}`]),
    ...(flags.push === false ? ["--no-push"] : []),
    ...(flags.yes === true ? ["--yes"] : []),
  ].join(" ");
}

function stringOutput(outputs: Record<string, unknown>, name: string): string | undefined {
  const value = outputs[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Runs `provision` or `dns` from the command line: checks the flags, builds the phase deps (with
 * the `--approve <hash>` / `--yes` approval handler when no human is present and the terminal
 * prompt for production values when one is), runs the phase, maps errors to exit codes 1/2 and
 * prints the plan hash or the next steps.
 */
export async function runInfraCommand(
  ctx: CliContext,
  command: "provision" | "dns",
  flags: InfraFlags,
  run: (deps: PhaseDeps, options: ProvisionOptions) => Promise<ProvisionResult>,
): Promise<void> {
  const approve = flags.approve?.trim();
  const planOnly = flags.planOnly === true;
  const result = await runPhaseCommand(
    ctx,
    async () => {
      if (planOnly && approve !== undefined) {
        throw new OpsCrewError("INVALID_INPUT", "Use either --plan-only or --approve <hash>.", {
          hint: `Run \`opscrew ${command} --plan-only\` to see the plan and its hash, then \`opscrew ${command} --approve <hash>\` to apply it.`,
        });
      }
      if (approve !== undefined && !isPlanHash(approve)) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          "--approve expects the 64-character SHA-256 plan hash that `--plan-only` printed.",
          { hint: `Run \`opscrew ${command} --plan-only\` to get the hash of the current plan.` },
        );
      }
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(approve === undefined ? {} : { approvePlanHash: approve }),
        ...(flags.yes === true ? { assumeYes: true } : {}),
      });
      const prompts = promptsOf(ctx);
      const secretPrompt = servicesOf(ctx).prompts === undefined ? clackSecretPrompt : undefined;
      const result = await run(deps, {
        ...(planOnly ? { planOnly: true } : {}),
        ...(approve === undefined ? {} : { approvePlanHash: approve }),
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        ...(flags.push === false ? { push: false } : {}),
        services: {
          ...(ctx.isInteractive ? { askEnv: createEnvPrompt(prompts, secretPrompt) } : {}),
          ...deployServicesOf(ctx).provision,
        },
      });
      const saved =
        planOnly && result.planHash !== undefined
          ? await findSavedPlan(deps.paths.files.plansDir, result.planHash)
          : undefined;
      return { result, saved: saved !== undefined };
    },
    assumeYesHint(ctx, flags.yes),
  );

  const { planHash, outputs, applied } = result.result;
  if (planOnly) {
    if (planHash !== undefined && result.saved) {
      printPlanHash(ctx, planHash, approveCommand(command, planHash, flags));
      return;
    }
    ctx.stdout("\nNothing to apply: the infrastructure already matches the plan.\n");
    printNextSteps(ctx, [
      `run \`opscrew ${command}${flags.yes === true ? " --yes" : ""}\` to finish the remaining steps (server readiness, GitHub secrets and the pull request).`,
    ]);
    return;
  }

  const ipv4 = stringOutput(outputs, "server_ipv4");
  if (ipv4 !== undefined) {
    ctx.stdout(`\n${applied ? "Created or updated" : "Using"} the server at ${ipv4}.\n`);
  }
  printNextSteps(ctx, [
    "when the deploy run in GitHub Actions has finished, run `opscrew verify` to check the live site and write opscrew/RUNBOOK.md.",
    "run `opscrew secure` to check the server's hardening and write opscrew/SECURITY_REPORT.md.",
  ]);
}

/**
 * `opscrew provision`: renders the deployment files, plans the Hetzner (and Cloudflare)
 * infrastructure, runs the security policies and applies only after an approval bound to the plan
 * hash; then waits for the server, pins its host key, stores the GitHub deploy secrets and opens a
 * pull request (FR-213). Exit codes: 0 done, 1 refused or a policy failed, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("provision")
    .description("Plan and, after your approval, create the servers on your cloud");
  addPlanApproveOptions(command)
    .addOption(
      new Option("--engine <name>", "Infrastructure engine to use instead of the plan's").choices([
        "tofu",
        "terraform",
      ]),
    )
    .option(
      "--no-push",
      "Commit the generated files locally but do not push or open a pull request",
    )
    .option("--yes", YES_DESCRIPTION)
    .exitOverride(usageErrorsExit2)
    .action((flags: InfraFlags) => runInfraCommand(ctx, "provision", flags, runProvision));
}
