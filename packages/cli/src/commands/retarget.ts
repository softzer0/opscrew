import {
  abortRetarget,
  finishRetarget,
  isMaintenanceWindowRequest,
  type RetargetResult,
  type RetargetServices,
  runRetarget,
} from "@opscrew/agents";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  Clock,
  VpsProviderId,
} from "@opscrew/contracts";
import {
  approvalDecision,
  isPlanHash,
  isUserFacingError,
  OpsCrewError,
  systemClock,
} from "@opscrew/core";
import { CloudProviderSchema, type Money, readArtifact } from "@opscrew/plan-schema";
import { type Command, Option } from "commander";
import { askTypedName, checkConfirmName, formatRequest, hashListed } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { runPhaseCommand } from "../ui/deploy";
import { chooseOption } from "../ui/options";
import { printNextSteps } from "../ui/output";
import { startQuestion } from "../ui/retarget";
import { createStorageKeyPrompt } from "../ui/storage-key-prompt";
import { engineOption, YES_DESCRIPTION } from "./provision";

/** Flags of `opscrew retarget` (FR-501). */
export interface RetargetFlags {
  to?: VpsProviderId;
  option?: string;
  approve?: string;
  allowDowntime?: boolean;
  dnsSwitched?: boolean;
  engine?: "tofu" | "terraform";
  finish?: boolean;
  abort?: boolean;
  /** `--snapshot` true, `--no-snapshot` false, neither undefined (finish only). */
  snapshot?: boolean;
  confirm?: string;
  yes?: boolean;
}

export interface RetargetApprovalOptions {
  /** True when a person answers the prompts (no flag approves anything then, except below). */
  interactive: boolean;
  /** The app name a deletion plan's `confirmPhrase` must equal (finish and abort only). */
  appName?: string;
  /** `--approve <hash>`. */
  approve?: string;
  /** `--allow-downtime`. */
  allowDowntime?: boolean;
  /** The app name typed at the prompt or given with `--confirm`, once known. */
  typed: () => string | undefined;
  /** Where approved requests are shown (`ctx.stdout`, which redacts). */
  print: (text: string) => void;
  /** The run's clock (default: the real time). */
  clock?: Clock;
}

/**
 * The approvals of `opscrew retarget` on top of the normal handler (`base`):
 * - non-interactive runs approve the maintenance window's `remote-exec` request, and nothing else,
 *   with `--allow-downtime` (a changed host key also arrives as `remote-exec` and goes to `base`,
 *   which refuses it);
 * - a deletion plan (`allowDestroy` with the app name as `confirmPhrase`) is approved in a script
 *   only when `--approve` names its hash and `--confirm` is the app name, and in a terminal once
 *   the app name was typed at the confirmation prompt;
 * - everything else goes to `base`: `iac-apply` by `--approve <hash>`, `--yes` for the GitHub
 *   secrets, the push and the pull request, or the interactive prompt.
 */
export class RetargetApprovalHandler implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly options: RetargetApprovalOptions,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const { interactive, appName, approve, allowDowntime, typed, print } = this.options;
    const clock = this.options.clock ?? systemClock;
    if (!interactive && allowDowntime === true && isMaintenanceWindowRequest(request)) {
      print(`  ✓ ${request.title} (allowed with --allow-downtime)\n`);
      return approvalDecision(clock, "--allow-downtime flag", true);
    }
    const deletion =
      request.kind === "iac-apply" &&
      request.allowDestroy === true &&
      appName !== undefined &&
      request.confirmPhrase === appName;
    if (deletion && !interactive) {
      const named = approve !== undefined && hashListed([approve], request.planHash);
      if (named && typed() === appName) {
        print(`  ✓ ${request.title} (approved with --approve and --confirm)\n`);
        return approvalDecision(clock, "--approve and --confirm flags", true, {
          confirmation: appName,
        });
      }
      return approvalDecision(clock, "--approve and --confirm flags", false, {
        reason: named
          ? `deleting needs --confirm ${appName}`
          : `deleting needs --approve with this plan's hash ${request.planHash ?? ""} and --confirm ${appName}`,
      });
    }
    if (deletion && typed() === appName) {
      print(formatRequest(request));
      print(`  ✓ ${request.title} (confirmed with the app name)\n`);
      return approvalDecision(clock, "typed app name", true, { confirmation: appName });
    }
    return this.base.request(request);
  }
}

/** Plain-English usage problems of a flag combination; empty when the flags fit together. */
export function flagProblems(flags: RetargetFlags): string[] {
  const problems: string[] = [];
  const mode = flags.finish ? "--finish" : flags.abort ? "--abort" : undefined;
  if (flags.finish && flags.abort) problems.push("Use either --finish or --abort, not both.");
  if (mode !== undefined) {
    const runOnly = [
      ...(flags.to !== undefined ? ["--to"] : []),
      ...(flags.option !== undefined ? ["--option"] : []),
      ...(flags.allowDowntime ? ["--allow-downtime"] : []),
      ...(flags.dnsSwitched ? ["--dns-switched"] : []),
    ];
    if (runOnly.length > 0) {
      problems.push(
        `${runOnly.join(", ")} only ${runOnly.length === 1 ? "applies" : "apply"} when starting or continuing a move, not with ${mode}.`,
      );
    }
  } else if (flags.confirm !== undefined) {
    problems.push("--confirm <app name> is only used with --finish or --abort.");
  }
  if (flags.snapshot !== undefined && !flags.finish) {
    problems.push(
      `${flags.snapshot ? "--snapshot" : "--no-snapshot"} is only used with --finish (the snapshot of the old server).`,
    );
  }
  const approve = flags.approve?.trim();
  if (approve !== undefined && !isPlanHash(approve)) {
    problems.push(
      "--approve expects the 64-character SHA-256 plan hash that an earlier `opscrew retarget` run printed.",
    );
  }
  return problems;
}

/** Flags a scripted run repeats with every command it is told to run next. */
function repeatedFlags(flags: RetargetFlags): string[] {
  return [
    ...(flags.engine !== undefined ? [`--engine ${flags.engine}`] : []),
    ...(flags.yes === true ? ["--yes"] : []),
  ];
}

/** Advice for an approval a non-interactive run refused (unless the error already says how). */
function scriptHint(ctx: CliContext, flags: RetargetFlags): (error: unknown) => string | undefined {
  return (error) => {
    if (ctx.isInteractive || !isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") {
      return undefined;
    }
    if (`${error.message} ${error.hint ?? ""}`.includes("--confirm")) return undefined;
    const yes =
      flags.yes === true
        ? ""
        : "add --yes to approve storing the GitHub deploy secrets, pushing and opening the pull request; ";
    return `This run is not interactive: ${yes}each infrastructure plan needs --approve <hash>, the maintenance window --allow-downtime, and deletions --confirm <app name> with --approve <hash>. A changed SSH host key needs an interactive terminal.`;
  };
}

async function runCommand(ctx: CliContext, flags: RetargetFlags): Promise<RetargetResult> {
  const problems = flagProblems(flags);
  if (problems.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", problems.join(" "), {
      hint: "Run `opscrew retarget --help` to see how the flags fit together.",
    });
  }
  const approve = flags.approve?.trim() || undefined;
  const mode = flags.finish ? "finish" : flags.abort ? "abort" : "run";
  const deps0 = createPhaseDeps(ctx, { ai: false });
  // The key of the app's bucket, which stays where it is, when this computer has none yet.
  const services: RetargetServices = {
    ...(ctx.isInteractive
      ? { askStorageKey: createStorageKeyPrompt(promptsOf(ctx), ctx.stdout) }
      : {}),
    ...servicesOf(ctx).retarget,
  };
  const common = {
    ...(approve !== undefined ? { approvePlanHash: approve } : {}),
    ...(flags.engine !== undefined ? { engine: flags.engine } : {}),
    services,
  };
  const prompts = promptsOf(ctx);

  if (mode === "run") {
    const deps = createPhaseDeps(ctx, {
      ai: false,
      approveHashes: approve === undefined ? [] : [approve],
      ...(flags.yes === true ? { assumeYes: true } : {}),
      wrapApprovals: (base, clock) =>
        new RetargetApprovalHandler(base, {
          interactive: ctx.isInteractive,
          ...(approve !== undefined ? { approve } : {}),
          ...(flags.allowDowntime === true ? { allowDowntime: true } : {}),
          typed: () => undefined,
          print: ctx.stdout,
          clock,
        }),
    });
    const option = flags.option?.trim() || undefined;
    let budget: Money | undefined;
    if (ctx.isInteractive && option === undefined) {
      budget = await readArtifact("requirements", deps0.paths.files.requirements)
        .then((requirements) => requirements.budgetMonthly)
        .catch(() => undefined);
    }
    return runRetarget(deps, {
      ...common,
      ...(flags.to !== undefined ? { to: flags.to } : {}),
      ...(option !== undefined ? { option } : {}),
      ...(flags.allowDowntime === true ? { allowDowntime: true } : {}),
      ...(flags.dnsSwitched === true ? { dnsSwitched: true } : {}),
      ...(ctx.isInteractive
        ? {
            ...(option === undefined
              ? {
                  choose: (options) =>
                    chooseOption(options, {
                      prompts,
                      write: ctx.stdout,
                      ...(budget === undefined ? {} : { budget }),
                    }),
                }
              : {}),
            confirmStart: async (summary) => {
              const answer = await prompts.confirm({
                message: startQuestion(summary),
                initialValue: false,
              });
              return !prompts.isCancel(answer) && answer === true;
            },
          }
        : {}),
    });
  }

  // --finish and --abort delete a server: the app name, typed or given with --confirm.
  const name = (await readArtifact("plan", deps0.paths.files.plan)).app.name;
  const command = `opscrew retarget --${mode}`;
  const scripted = flags.confirm !== undefined;
  checkConfirmName(
    flags.confirm,
    name,
    "the app name",
    `Run \`${command} --confirm ${name}\` with the app name.`,
  );
  if (!scripted && !ctx.isInteractive) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `${mode === "finish" ? "Finishing" : "Aborting"} the move deletes a server, which needs the app name typed by a person, and this run is not interactive. Nothing was changed.`,
      {
        hint: `Run \`${command}\` in a terminal, or \`${command} --confirm ${name}\` in a script.`,
      },
    );
  }
  let typed = scripted ? name : undefined;
  const deps = createPhaseDeps(ctx, {
    ai: false,
    approveHashes: approve === undefined ? [] : [approve],
    ...(flags.yes === true ? { assumeYes: true } : {}),
    wrapApprovals: (base, clock) =>
      new RetargetApprovalHandler(base, {
        interactive: ctx.isInteractive,
        appName: name,
        ...(approve !== undefined ? { approve } : {}),
        typed: () => typed,
        print: ctx.stdout,
        clock,
      }),
  });
  const confirm = async (preview: { name: string }) => {
    if (scripted) return typed === preview.name;
    typed = await askTypedName(
      prompts,
      `Type ${preview.name} to delete everything listed above (anything else cancels)`,
      preview.name,
    );
    return typed === preview.name;
  };
  if (mode === "finish") {
    return finishRetarget(deps, {
      ...common,
      snapshot: flags.snapshot === undefined ? "auto" : flags.snapshot,
      confirm,
    });
  }
  return abortRetarget(deps, { ...common, confirm });
}

/**
 * `opscrew retarget`: moves a live deployment to the other VPS provider (FR-501): the new server
 * next to the old one, the app deployed there, the database copied in a maintenance window, DNS
 * switched; `--finish` deletes the old server, `--abort` (before the switch) the new one. Every
 * infrastructure plan is approved by its hash; scripts stop at each plan with the hash and the
 * command to continue. Exit codes: 0 done (switched, finished or aborted), 1 stopped on purpose (a
 * plan to approve, a flag to pass, a refusal), 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("retarget")
    .description("Move the live deployment to another cloud provider, step by step")
    .addOption(
      new Option("--to <provider>", "Provider to move to (default: the one in your answers)")
        .choices(CloudProviderSchema.options)
        .conflicts(["finish", "abort"]),
    )
    .option("--option <id>", "Server option to move to without asking (ids are listed by the run)")
    .option(
      "--approve <hash>",
      "Apply exactly the saved plan with this hash (printed by the previous run) and continue",
    )
    .option(
      "--allow-downtime",
      "In a non-interactive run, allow the maintenance window that copies the database",
    )
    .option(
      "--dns-switched",
      "You changed the DNS records (or the address) to the new server yourself",
    )
    .addOption(engineOption())
    .addOption(
      new Option(
        "--finish",
        "After the switch, delete the old server (asks for the app name)",
      ).conflicts("abort"),
    )
    .option("--abort", "Before the switch, delete the new server and go back to the old one")
    .option("--snapshot", "With --finish, take a snapshot of the old server first")
    .option("--no-snapshot", "With --finish, do not take a snapshot of the old server first")
    .option(
      "--confirm <name>",
      "The app name, to run --finish or --abort without prompts (for scripts and CI)",
    )
    .option("--yes", YES_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "How a move works:",
        "  OpsCrew creates the new server next to the old one, deploys the app there with your",
        "  deploy workflow, copies the database in a short maintenance window, switches DNS and",
        "  keeps the old server (with its app stopped) until you finish the move. Both providers'",
        "  API tokens (HCLOUD_TOKEN and DIGITALOCEAN_TOKEN) and your GitHub access are needed.",
        "",
        "  opscrew retarget --to digitalocean   start the move, or continue it after a stop",
        "  opscrew retarget --finish            after the switch, delete the old server",
        "  opscrew retarget --abort             before the switch, undo the move",
        "",
        "In scripts each infrastructure plan stops with its hash: run the printed command with",
        "--approve <hash> to apply it. The maintenance window needs --allow-downtime, the GitHub",
        "steps --yes, and --finish or --abort need --confirm <app name>.",
        "`opscrew status` shows where a move stands.",
      ].join("\n"),
    )
    .action(async (flags: RetargetFlags) => {
      const result = await runPhaseCommand(
        ctx,
        () => runCommand(ctx, flags),
        scriptHint(ctx, flags),
      );
      if (result.pendingPlanHash !== undefined) {
        ctx.stdout(`\nPlan hash (SHA-256): ${result.pendingPlanHash}\n`);
      }
      const repeat = repeatedFlags(flags);
      printNextSteps(ctx, [
        ...result.next,
        ...(!result.done && !ctx.isInteractive && repeat.length > 0
          ? [`Pass ${repeat.join(" ")} again with that command.`]
          : []),
      ]);
      if (!result.done) throw new CliExit(REFUSED_EXIT_CODE);
    });
}
