import {
  findSavedPlan,
  type PhaseDeps,
  type PortainerResult,
  type PortainerRunOptions,
  portainerDisable,
  portainerEnable,
  portainerStatus,
} from "@opscrew/agents";
import type { Reporter } from "@opscrew/contracts";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps } from "../deps";
import {
  assumeYesHint,
  collect,
  type PlannedHash,
  printPlanHashes,
  runPhaseCommand,
  usageErrorsExit2,
} from "../ui/deploy";
import { deployServicesOf } from "../ui/deploy-services";
import { printNextSteps } from "../ui/output";
import {
  APPROVE_DESCRIPTION,
  addHostKeyOption,
  checkApproveFlags,
  hostPlanChanges,
  YES_DESCRIPTION,
} from "./provision";

interface ChangeFlags {
  planOnly?: boolean;
  approve?: string[];
  hostKey?: string;
  engine?: "tofu" | "terraform";
  yes?: boolean;
}

interface EnableFlags extends ChangeFlags {
  subdomain?: string;
  allowEmail?: string[];
}

interface DisableFlags extends ChangeFlags {
  deleteData?: boolean;
}

/** Adds the options `enable` and `disable` share: plan only, approvals by hash, host key, engine. */
function addChangeOptions(command: Command): Command {
  command
    .option("--plan-only", "Show the plans and their hashes; change nothing")
    .option("--approve <hash>", APPROVE_DESCRIPTION, collect);
  return addHostKeyOption(command)
    .addOption(
      new Option("--engine <name>", "Infrastructure engine to use instead of the plan's").choices([
        "tofu",
        "terraform",
      ]),
    )
    .option("--yes", YES_DESCRIPTION)
    .exitOverride(usageErrorsExit2);
}

/** The command that applies what a `--plan-only` run planned (no options: the saved ones apply). */
function approveCommand(
  sub: "enable" | "disable",
  hashes: readonly string[],
  flags: ChangeFlags,
): string {
  return [
    `opscrew portainer ${sub}`,
    ...hashes.map((hash) => `--approve ${hash}`),
    ...(flags.engine === undefined ? [] : [`--engine ${flags.engine}`]),
    ...(flags.hostKey === undefined ? [] : [`--host-key ${flags.hostKey.trim()}`]),
    ...(flags.yes === true ? ["--yes"] : []),
  ].join(" ");
}

/** The plans of a `--plan-only` run that need approving, each labelled. */
async function plannedHashes(deps: PhaseDeps, result: PortainerResult): Promise<PlannedHash[]> {
  const planned: PlannedHash[] = [];
  if (
    result.planHash !== undefined &&
    (await findSavedPlan(deps.paths.files.plansDir, result.planHash)) !== undefined
  ) {
    planned.push({ label: "infrastructure (Cloudflare Tunnel and Access)", hash: result.planHash });
  }
  if (result.hostPlanHash !== undefined && (await hostPlanChanges(deps, result.hostPlanHash))) {
    planned.push({ label: "host plan for the server", hash: result.hostPlanHash });
  }
  if (result.dataPlanHash !== undefined) {
    planned.push({ label: "deletion of Portainer's data", hash: result.dataPlanHash });
  }
  return planned;
}

/**
 * Runs `portainer enable` or `disable`: checks the flags, builds the phase deps with the
 * `--approve <hash>` handler (each hash grants exactly its plan; `--yes` grants only the repository
 * steps), runs the change and prints the plans' hashes or the next steps.
 */
async function runChange(
  ctx: CliContext,
  sub: "enable" | "disable",
  flags: ChangeFlags,
  run: (deps: PhaseDeps, options: PortainerRunOptions) => Promise<PortainerResult>,
): Promise<void> {
  const planOnly = flags.planOnly === true;
  const outcome = await runPhaseCommand(
    ctx,
    async () => {
      const hashes = checkApproveFlags(`portainer ${sub}`, flags);
      const hostKey = flags.hostKey?.trim();
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...(hashes.length === 0 ? {} : { approvePlanHashes: hashes }),
        ...(flags.yes === true ? { assumeYes: true } : {}),
      });
      const services = deployServicesOf(ctx).portainer;
      const result = await run(deps, {
        ...(planOnly ? { planOnly: true } : {}),
        ...(hashes.length === 0 ? {} : { approvePlanHashes: hashes }),
        ...(hostKey === undefined ? {} : { hostKey }),
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        ...(services === undefined ? {} : { services }),
      });
      return { result, planned: planOnly ? await plannedHashes(deps, result) : [] };
    },
    assumeYesHint(ctx, flags.yes),
  );
  if (planOnly) {
    const { planned } = outcome;
    if (planned.length === 0) {
      ctx.stdout("\nNothing to apply: the server and Cloudflare already match.\n");
      return;
    }
    printPlanHashes(
      ctx,
      planned,
      approveCommand(
        sub,
        planned.map((plan) => plan.hash),
        flags,
      ),
    );
    if (outcome.result.dataPlanHash !== undefined) {
      ctx.stdout(
        "Deleting Portainer's data also needs the app's name typed, so run that command in a terminal.\n",
      );
    }
    return;
  }
  const files = outcome.result.files;
  printNextSteps(ctx, [
    ...(files.length > 0 || outcome.result.applied || outcome.result.hostApplied
      ? ["commit the changed files (opscrew/plan.yaml and any listed above) with your next change."]
      : []),
    sub === "enable"
      ? "run `opscrew portainer status` any time to see the tunnel command and where the admin password is."
      : "run `opscrew portainer enable` to turn Portainer on again.",
  ]);
}

/** Progress is dropped for `--json` so stdout holds only the status; problems go to stderr. */
function quietReporter(ctx: CliContext): Reporter {
  return {
    step: () => {},
    info: () => {},
    success: () => {},
    warn: (message) => ctx.reporter.warn(message),
    error: (message) => ctx.reporter.error(message),
  };
}

/**
 * `opscrew portainer enable|disable|status` (FR-914–FR-916): Portainer CE, off by default, on any
 * server OpsCrew deploys to. `enable` installs a pinned version that listens only on the server
 * itself (reached through an SSH tunnel), with an admin password generated on this computer;
 * `--subdomain` and `--allow-email` opt in to a subdomain behind Cloudflare Access. `disable`
 * removes it; its data only with `--delete-data` and the app's name typed. Every change is a plan
 * approved by its hash. `status` changes nothing and never prints the password. Exit codes:
 * 0 done, 1 refused, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const portainer = program
    .command("portainer")
    .description("Turn Portainer (a web UI for your containers) on or off, or show how to open it")
    .exitOverride(usageErrorsExit2);

  addChangeOptions(
    portainer
      .command("enable")
      .description(
        "Install Portainer CE on the server, reachable only through an SSH tunnel (or a subdomain behind Cloudflare Access)",
      )
      .option(
        "--subdomain <host>",
        "Opt in: also serve Portainer on this subdomain of your Cloudflare domain, behind Cloudflare Access (for example portainer)",
      )
      .option(
        "--allow-email <email>",
        "With --subdomain: an email address Cloudflare Access lets in (repeat for several)",
        collect,
      ),
  ).action((flags: EnableFlags) =>
    runChange(ctx, "enable", flags, (deps, options) =>
      portainerEnable(deps, {
        ...options,
        // Without these options, `--approve` applies exactly what the --plan-only run saved.
        ...(flags.subdomain === undefined ? {} : { subdomain: flags.subdomain }),
        ...((flags.allowEmail ?? []).length === 0 ? {} : { allowEmails: flags.allowEmail }),
      }),
    ),
  );

  addChangeOptions(
    portainer
      .command("disable")
      .description("Remove Portainer from the server (its data stays unless --delete-data)")
      .option(
        "--delete-data",
        "Also delete Portainer's data (its users and settings); asks you to type the app's name",
      ),
  ).action((flags: DisableFlags) =>
    runChange(ctx, "disable", flags, (deps, options) =>
      // `undefined` (not false) without the flag: `--approve` then keeps the planned choice.
      portainerDisable(deps, {
        ...options,
        deleteData: flags.deleteData === true ? true : undefined,
      }),
    ),
  );

  portainer
    .command("status")
    .description(
      "Show whether Portainer is on, the SSH tunnel command, the local address and where the password is (changes nothing)",
    )
    .option("--json", "Print the status as JSON")
    .exitOverride(usageErrorsExit2)
    .action(async (flags: { json?: boolean }) => {
      const json = flags.json === true;
      const status = await runPhaseCommand(ctx, () =>
        portainerStatus(
          createPhaseDeps(ctx, { ai: false, ...(json ? { reporter: quietReporter(ctx) } : {}) }),
        ),
      );
      if (json) ctx.stdout(`${JSON.stringify(status, null, 2)}\n`);
    });
}
