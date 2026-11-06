import {
  abortRetarget,
  finishRetarget,
  HOST_KEY_FINGERPRINT,
  type MoveTargetId,
  placeWords,
  type RetargetResult,
  type RetargetServices,
  readEnvironmentRequirements,
  runRetarget,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest, Clock } from "@opscrew/contracts";
import {
  approvalDecision,
  isPlanHash,
  isUserFacingError,
  OpsCrewError,
  systemClock,
} from "@opscrew/core";
import { CloudProviderSchema, readArtifact } from "@opscrew/plan-schema";
import { type Command, Option } from "commander";
import {
  askTypedName,
  checkConfirmName,
  formatRequest,
  hashListed,
  withAllowDowntime,
} from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { CliExit, REFUSED_EXIT_CODE } from "../exit";
import { collect, runPhaseCommand } from "../ui/deploy";
import { addEnvOption, type ChosenEnvironment, chooseEnvironment } from "../ui/environment";
import { chooseOption } from "../ui/options";
import { printNextSteps } from "../ui/output";
import { checkPortainerCert, PORTAINER_CERT_DESCRIPTION } from "../ui/portainer";
import { startQuestion } from "../ui/retarget";
import { createStorageKeyPrompt } from "../ui/storage-key-prompt";
import { addHostKeyOption, engineOption, YES_DESCRIPTION } from "./provision";
import { chooseEmptyInTerminal, newSideAnswers, parsePortainerAddress } from "./retarget-answers";

/** Flags of `opscrew retarget` (FR-501, FR-2315). */
export interface RetargetFlags {
  to?: MoveTargetId;
  option?: string;
  /** `--answers <file>`: the own server's (`server.*`) or Portainer's (`portainer.*`) answers. */
  answers?: string;
  /** `--host-key SHA256:…`: the new own server's host key, trusted without a prompt. */
  hostKey?: string;
  /** `--password-logins off|keep`: the choice a new own server with password users needs. */
  passwordLogins?: "off" | "keep";
  /** `--portainer-address <ipv4[,ipv6]>`: the Portainer host's public address. */
  portainerAddress?: string;
  /** `--portainer-cert SHA256:…`: Portainer's certificate fingerprint, trusted without a prompt. */
  portainerCert?: string;
  /** `--empty <service>` (repeatable): what starts empty on the new side instead of being copied. */
  empty?: string[];
  /** `--public-image`: the app's image is public, so Portainer pulls it without a registry entry. */
  publicImage?: boolean;
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
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: the app's environment. */
  env?: string;
}

export interface RetargetApprovalOptions {
  /** True when a person answers the prompts (no flag approves anything then, except below). */
  interactive: boolean;
  /** The app name a deletion plan's `confirmPhrase` must equal (finish and abort only). */
  appName?: string;
  /** `--approve <hash>`. */
  approve?: string;
  /** The app name typed at the prompt or given with `--confirm`, once known. */
  typed: () => string | undefined;
  /** Where approved requests are shown (`ctx.stdout`, which redacts). */
  print: (text: string) => void;
  /** The run's clock (default: the real time). */
  clock?: Clock;
}

/**
 * The plans a move's `--finish` or `--abort` deletes with: a server's infrastructure plan, the
 * teardown host plan of the user's own server, the stack teardown in the user's Portainer.
 */
const DELETION_KINDS: readonly ApprovalRequest["kind"][] = [
  "iac-apply",
  "host-apply",
  "stack-apply",
];

/**
 * The approvals of `opscrew retarget` on top of the normal handler (`base`); the maintenance
 * window's `--allow-downtime` is `MaintenanceWindowApproval`'s, around this handler:
 * - a deletion plan (`iac-apply`, `host-apply` or `stack-apply` with `allowDestroy` and the app
 *   name as `confirmPhrase`) is approved in a script
 *   only when `--approve` names its hash and `--confirm` is the app name, and in a terminal once
 *   the app name was typed at the confirmation prompt;
 * - everything else goes to `base`: plans by `--approve <hash>`, `--yes` for the GitHub
 *   secrets, the push and the pull request, or the interactive prompt.
 */
export class RetargetApprovalHandler implements ApprovalHandler {
  constructor(
    private readonly base: ApprovalHandler,
    private readonly options: RetargetApprovalOptions,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const { interactive, appName, approve, typed, print } = this.options;
    const clock = this.options.clock ?? systemClock;
    const deletion =
      DELETION_KINDS.includes(request.kind) &&
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
      ...(flags.answers !== undefined ? ["--answers"] : []),
      ...(flags.hostKey !== undefined ? ["--host-key"] : []),
      ...(flags.passwordLogins !== undefined ? ["--password-logins"] : []),
      ...(flags.portainerAddress !== undefined ? ["--portainer-address"] : []),
      ...(flags.portainerCert !== undefined ? ["--portainer-cert"] : []),
      ...(flags.empty !== undefined ? ["--empty"] : []),
      ...(flags.publicImage ? ["--public-image"] : []),
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
  const hostKey = flags.hostKey?.trim();
  if (hostKey !== undefined && !HOST_KEY_FINGERPRINT.test(hostKey)) {
    problems.push(
      "--host-key expects the new server's SHA-256 host key fingerprint: SHA256: followed by 43 letters, digits, + or /.",
    );
  }
  const to = flags.to;
  if (to !== undefined) {
    const wrong = sideFlags(flags)
      .filter((flag) => !flag.targets.includes(to))
      .map((flag) => flag.name);
    if (wrong.length > 0) {
      problems.push(
        `${wrong.join(", ")} ${wrong.length === 1 ? "does" : "do"} not apply to a move to ${to}.`,
      );
    }
  }
  return problems;
}

/** The given flags about the new side that only a move to the user's own server or Portainer uses. */
function sideFlags(flags: RetargetFlags): { name: string; targets: MoveTargetId[] }[] {
  const all: [given: boolean, name: string, targets: MoveTargetId[]][] = [
    [flags.answers !== undefined, "--answers", ["own", "portainer"]],
    [flags.hostKey !== undefined, "--host-key", ["own"]],
    [flags.passwordLogins !== undefined, "--password-logins", ["own"]],
    [flags.portainerAddress !== undefined, "--portainer-address", ["portainer"]],
    [flags.portainerCert !== undefined, "--portainer-cert", ["portainer"]],
    [flags.publicImage === true, "--public-image", ["portainer"]],
  ];
  return all.filter(([given]) => given).map(([, name, targets]) => ({ name, targets }));
}

/**
 * The flags only a move's start uses (the new side's answers and its host key), given while a move
 * is recorded. `--password-logins` and `--public-image` are left out: later steps use them too.
 */
function startOnlyFlags(flags: RetargetFlags): string[] {
  return sideFlags(flags)
    .map((flag) => flag.name)
    .filter((name) => name !== "--password-logins" && name !== "--public-image");
}

/** Flags a scripted run repeats with every command it is told to run next. */
function repeatedFlags(flags: RetargetFlags, environment: ChosenEnvironment): string[] {
  return [
    ...(environment.flag !== "" ? [environment.flag.trim()] : []),
    ...(flags.engine !== undefined ? [`--engine ${flags.engine}`] : []),
    // The new side's choices that later steps use (the stacks, the host plan).
    ...(flags.publicImage === true ? ["--public-image"] : []),
    ...(flags.passwordLogins !== undefined ? [`--password-logins ${flags.passwordLogins}`] : []),
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

async function runCommand(
  ctx: CliContext,
  flags: RetargetFlags,
  environment: ChosenEnvironment,
): Promise<RetargetResult> {
  const problems = flagProblems(flags);
  if (problems.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", problems.join(" "), {
      hint: "Run `opscrew retarget --help` to see how the flags fit together.",
    });
  }
  const certFingerprint = checkPortainerCert(flags.portainerCert);
  const portainerAddress =
    flags.portainerAddress === undefined
      ? undefined
      : parsePortainerAddress(flags.portainerAddress);
  const approve = flags.approve?.trim() || undefined;
  const mode = flags.finish ? "finish" : flags.abort ? "abort" : "run";
  const deps0 = createPhaseDeps(ctx, {
    ai: false,
    app: environment.app,
    environment: environment.name,
  });
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
      app: environment.app,
      environment: environment.name,
      ai: false,
      approveHashes: approve === undefined ? [] : [approve],
      ...(flags.yes === true ? { assumeYes: true } : {}),
      wrapApprovals: (base, clock) => {
        const handler = new RetargetApprovalHandler(base, {
          interactive: ctx.isInteractive,
          ...(approve !== undefined ? { approve } : {}),
          typed: () => undefined,
          print: ctx.stdout,
          clock,
        });
        return withAllowDowntime(ctx, flags.allowDowntime, handler, clock);
      },
    });
    const option = flags.option?.trim() || undefined;
    const plan = await readArtifact("plan", deps0.paths.files.plan);
    // The new side's answers and the data's questions only when a move starts.
    const starting = plan.retarget === undefined;
    const requirements = starting
      ? await readEnvironmentRequirements(deps0.paths).catch(() => undefined)
      : undefined;
    const budget =
      ctx.isInteractive && option === undefined ? requirements?.budgetMonthly : undefined;
    const to = flags.to ?? requirements?.provider;
    const ignored = starting ? [] : startOnlyFlags(flags);
    if (ignored.length > 0) {
      ctx.reporter.warn(
        `${ignored.join(", ")} only ${ignored.length === 1 ? "applies" : "apply"} when a move starts; the move to ${placeWords(plan.target)} uses what it recorded.`,
      );
    }
    const side = starting
      ? await newSideAnswers(ctx, deps0, {
          to,
          plan,
          flags: {
            ...(flags.answers !== undefined ? { answers: flags.answers } : {}),
            ...(portainerAddress !== undefined ? { portainerAddress } : {}),
            ...(certFingerprint !== undefined ? { portainerCert: certFingerprint } : {}),
          },
        })
      : {};
    const hostKey = flags.hostKey?.trim();
    return runRetarget(deps, {
      ...common,
      ...side,
      ...(flags.to !== undefined ? { to: flags.to } : {}),
      ...(option !== undefined ? { option } : {}),
      ...(hostKey !== undefined ? { hostKey } : {}),
      ...(flags.passwordLogins !== undefined ? { passwordLogins: flags.passwordLogins } : {}),
      ...(flags.publicImage === true ? { publicImage: true } : {}),
      ...(flags.empty !== undefined ? { empty: flags.empty } : {}),
      ...(flags.allowDowntime === true ? { allowDowntime: true } : {}),
      ...(flags.dnsSwitched === true ? { dnsSwitched: true } : {}),
      ...(ctx.isInteractive
        ? {
            ...(to !== undefined
              ? { chooseEmpty: chooseEmptyInTerminal(ctx, { provider: to }) }
              : {}),
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

  // --finish and --abort delete a side: the app name, typed or given with --confirm.
  const name = (await readArtifact("plan", deps0.paths.files.plan)).app.name;
  const command = `opscrew retarget${environment.flag} --${mode}`;
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
      `${mode === "finish" ? "Finishing the move deletes the old side" : "Aborting the move deletes the new side"} (a server OpsCrew created, or the app and its data on your own server or in your Portainer), which needs the app name typed by a person, and this run is not interactive. Nothing was changed.`,
      {
        hint: `Run \`${command}\` in a terminal, or \`${command} --confirm ${name}\` in a script.`,
      },
    );
  }
  let typed = scripted ? name : undefined;
  const deps = createPhaseDeps(ctx, {
    app: environment.app,
    environment: environment.name,
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
 * `opscrew retarget`: moves a live deployment between any two server targets (FR-501, ADR 0027):
 * a cloud provider, the user's own server (`--to own`, its answers from `--answers` or asked) or
 * Portainer (`--to portainer`, likewise, plus its host's public address); the new side next to the
 * old one, the app deployed there, its data copied in a maintenance window (`--empty` or a question
 * per service starts it empty), DNS switched; `--finish` removes the old side, `--abort` (before
 * the switch) the new one, never the user's server or Portainer itself. Every
 * infrastructure plan is approved by its hash; scripts stop at each plan with the hash and the
 * command to continue. Exit codes: 0 done (switched, finished or aborted), 1 stopped on purpose (a
 * plan to approve, a flag to pass, a refusal), 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("retarget")
    .description(
      "Move the live deployment to another cloud provider, your own server or your Portainer, with its data, step by step",
    )
    .addOption(
      new Option(
        "--to <target>",
        "Where to move to: a cloud provider, your own server (own) or your existing Portainer (default: the one in your answers)",
      )
        .choices([...CloudProviderSchema.options, "own", "portainer"])
        .conflicts(["finish", "abort"]),
    )
    .option("--option <id>", "Server option to move to without asking (ids are listed by the run)")
    .option(
      "--answers <file>",
      "Your own server's (server.*) or your Portainer's (portainer.*) answers from a YAML or JSON file, as `opscrew interview --answers` takes them, instead of asking",
    )
    .option("--portainer-cert <fingerprint>", PORTAINER_CERT_DESCRIPTION)
    .option(
      "--portainer-address <ipv4[,ipv6]>",
      "Your existing Portainer: the public address of its host, where its Caddy serves the app and the app's DNS records point (a terminal asks)",
    )
    .addOption(
      new Option(
        "--password-logins <choice>",
        "Your own server, when other users log in with a password and no SSH key: turn password logins off anyway, or keep them",
      ).choices(["off", "keep"]),
    )
    .option(
      "--public-image",
      "Your existing Portainer: the app's image on GitHub Container Registry is public, so Portainer pulls it without a registry entry (give it again on each run of the move)",
    )
    .option(
      "--empty <service>",
      "Start this service's data empty on the new side instead of copying it (app for the app's own files); repeat for each (a terminal asks)",
      collect,
    )
    .option(
      "--approve <hash>",
      "Apply exactly the saved plan with this hash (printed by the previous run) and continue",
    )
    .option(
      "--allow-downtime",
      "In a non-interactive run, allow the maintenance window that copies the app's data",
    )
    .option(
      "--dns-switched",
      "You changed the DNS records (or the address) to the new side yourself",
    )
    .addOption(engineOption())
    .addOption(
      new Option(
        "--finish",
        "After the switch, delete the old server, or remove the app from your own server or Portainer (asks for the app name)",
      ).conflicts("abort"),
    )
    .option(
      "--abort",
      "Before the switch, delete the new server (or remove the app from your own server or Portainer) and go back",
    )
    .option("--snapshot", "With --finish, take a snapshot of the old server first")
    .option("--no-snapshot", "With --finish, do not take a snapshot of the old server first")
    .option(
      "--confirm <name>",
      "The app name, to run --finish or --abort without prompts (for scripts and CI)",
    )
    .option("--yes", YES_DESCRIPTION);
  addHostKeyOption(addEnvOption(command))
    .addHelpText(
      "after",
      [
        "",
        "How a move works:",
        "  OpsCrew prepares the new side next to the old one (a new server on a cloud provider, the",
        "  app set up on your own server, or its stacks in your Portainer), deploys the app there",
        "  with your deploy workflow, copies the app's data in a maintenance window (each data",
        "  mount, unless you start it empty), switches DNS and keeps the old side (with its app",
        "  stopped) until you finish the move. Your own server and your Portainer are never",
        "  deleted: finishing removes only the app from them. The cloud providers' API tokens",
        "  (HCLOUD_TOKEN, DIGITALOCEAN_TOKEN), PORTAINER_API_KEY for Portainer and your GitHub",
        "  access are needed for the sides involved.",
        "",
        "  opscrew retarget --to digitalocean   start the move, or continue it after a stop",
        "  opscrew retarget --to own            move to your own server (asks how to reach it)",
        "  opscrew retarget --to portainer      move into your Portainer (asks for it)",
        "  opscrew retarget --finish            after the switch, remove the old side",
        "  opscrew retarget --abort             before the switch, undo the move",
        "",
        "In scripts each infrastructure plan stops with its hash: run the printed command with",
        "--approve <hash> to apply it. The maintenance window needs --allow-downtime, the GitHub",
        "steps --yes, and --finish or --abort need --confirm <app name>. A move to your own server",
        "or Portainer takes their answers with --answers <file> (and --host-key, --portainer-cert",
        "and --portainer-address); --empty <service> starts that service's data empty.",
        "`opscrew status` shows where a move stands.",
      ].join("\n"),
    )
    .action(async (flags: RetargetFlags) => {
      let environment: ChosenEnvironment = { app: undefined, name: "prod", flag: "" };
      const result = await runPhaseCommand(
        ctx,
        async () => {
          environment = await chooseEnvironment(ctx, flags, "retarget");
          return runCommand(ctx, flags, environment);
        },
        scriptHint(ctx, flags),
      );
      if (result.pendingPlanHash !== undefined) {
        ctx.stdout(`\nPlan hash (SHA-256): ${result.pendingPlanHash}\n`);
      }
      const repeat = repeatedFlags(flags, environment);
      printNextSteps(ctx, [
        ...result.next,
        ...(!result.done && !ctx.isInteractive && repeat.length > 0
          ? [`Pass ${repeat.join(" ")} again with that command.`]
          : []),
      ]);
      if (!result.done) throw new CliExit(REFUSED_EXIT_CODE);
    });
}
