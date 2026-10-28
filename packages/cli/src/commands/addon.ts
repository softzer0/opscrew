import {
  ADDON_NAMES,
  type AddonResult,
  type AddonRunOptions,
  type AddonServices,
  addonDisable,
  addonEnable,
  addonOpen,
  addonStatus,
  applyCommand,
  findSavedPlan,
  type PhaseDeps,
  shellWord,
} from "@opscrew/agents";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { Argument, type Command, Option } from "commander";
import { checkConfirmName, FlagConfirmation } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { quietReporter } from "../reporter";
import {
  assumeYesHint,
  collect,
  type PlannedHash,
  printPlanHashes,
  runPhaseCommand,
} from "../ui/deploy";
import { type AppEnvFlags, addEnvOption, chooseEnvironment } from "../ui/environment";
import { printNextSteps } from "../ui/output";
import { cancelled } from "../ui/prompts";
import { stopSignal } from "../ui/stop";
import {
  APPROVE_DESCRIPTION,
  addHostKeyOption,
  checkApproveFlags,
  engineOption,
  planChanges,
  YES_DESCRIPTION,
} from "./provision";

/** An add-on: `beszel` or `grafana-cloud`. */
type AddonKind = keyof typeof ADDON_NAMES;

const KINDS = Object.keys(ADDON_NAMES) as AddonKind[];

interface ChangeFlags extends AppEnvFlags {
  planOnly?: boolean;
  approve?: string[];
  hostKey?: string;
  engine?: "tofu" | "terraform";
  yes?: boolean;
}

interface EnableFlags extends ChangeFlags {
  mode?: "hub" | "agent";
  hubUrl?: string;
  hubKey?: string;
  access?: "local" | "subdomain";
  hostname?: string;
  allowEmail?: string[];
  metricsUrl?: string;
  metricsUser?: string;
  logsUrl?: string;
  logsUser?: string;
  logSampling?: string;
}

interface DisableFlags extends ChangeFlags {
  keepData?: boolean;
  /** The app's name, to approve deleting Beszel's history without a prompt (scripts). */
  confirm?: string;
}

/** The `<beszel|grafana-cloud>` argument. */
function kindArgument(): Argument {
  return new Argument("<addon>", "The add-on: beszel or grafana-cloud").choices(KINDS);
}

/** Adds the options `enable` and `disable` share: plan only, approvals by hash, host key, engine. */
function addChangeOptions(command: Command): Command {
  addEnvOption(command)
    .option("--plan-only", "Show the plans and their hashes; change nothing")
    .option("--approve <hash>", APPROVE_DESCRIPTION, collect);
  return addHostKeyOption(command).addOption(engineOption()).option("--yes", YES_DESCRIPTION);
}

/**
 * The add-on's options given to `enable`, as words of the command that applies its plans: the
 * host plan's hash depends on them, so the approving run repeats them.
 */
function enableWords(flags: EnableFlags): string[] {
  const options: [string, string | undefined][] = [
    ["--mode", flags.mode],
    ["--access", flags.access],
    ["--hostname", flags.hostname],
    ...(flags.allowEmail ?? []).map((email): [string, string] => ["--allow-email", email]),
    ["--hub-url", flags.hubUrl],
    ["--hub-key", flags.hubKey],
    ["--metrics-url", flags.metricsUrl],
    ["--metrics-user", flags.metricsUser],
    ["--logs-url", flags.logsUrl],
    ["--logs-user", flags.logsUser],
    ["--log-sampling", flags.logSampling],
  ];
  return options.flatMap(([option, value]) =>
    value === undefined ? [] : [`${option} ${shellWord(value.trim())}`],
  );
}

/** The plans of a `--plan-only` run that need approving, each labelled. */
async function plannedHashes(deps: PhaseDeps, result: AddonResult): Promise<PlannedHash[]> {
  const planned: PlannedHash[] = [];
  if (result.cloudflarePlanHash !== undefined) {
    planned.push({ label: "Cloudflare plan", hash: result.cloudflarePlanHash });
  }
  if (
    result.planHash !== undefined &&
    (await findSavedPlan(deps.paths.files.plansDir, result.planHash)) !== undefined
  ) {
    planned.push({ label: "infrastructure (Cloudflare Tunnel and Access)", hash: result.planHash });
  }
  for (const hash of result.hostPlanHashes) {
    if (await planChanges(deps, "host", hash)) {
      planned.push({ label: "host plan for the server", hash });
    }
  }
  return planned;
}

/** Asks for a value the add-on needs in a terminal: masked for a secret, never echoed. */
function askFor(ctx: CliContext): NonNullable<AddonServices["ask"]> {
  const prompts = promptsOf(ctx);
  return async ({ name, prompt, secret }) => {
    const message = `Enter ${prompt}`;
    const answer = secret ? await prompts.password({ message }) : await prompts.text({ message });
    if (prompts.isCancel(answer)) throw cancelled(`the question for ${name}`, "opscrew addon");
    return answer;
  };
}

/**
 * Runs `addon enable` or `disable`: checks the flags, chooses the app and environment, builds the
 * phase deps with the `--approve <hash>` handler (each hash grants exactly its plan; `--yes` only
 * the repository steps; `--confirm <app>` the deletion of Beszel's history), runs the change and
 * prints the plans' hashes or the next steps.
 */
async function runChange(
  ctx: CliContext,
  sub: "enable" | "disable",
  kind: AddonKind,
  flags: ChangeFlags & { confirm?: string },
  words: string[],
  run: (deps: PhaseDeps, plan: DeployPlan, options: AddonRunOptions) => Promise<AddonResult>,
): Promise<void> {
  const planOnly = flags.planOnly === true;
  let flag = "";
  const outcome = await runPhaseCommand(
    ctx,
    async () => {
      const hashes = checkApproveFlags(`addon ${sub} ${kind}`, flags);
      const environment = await chooseEnvironment(ctx, flags, `addon ${sub} ${kind}`);
      flag = environment.flag;
      const where = { app: environment.app, environment: environment.name };
      const plan = await readArtifact(
        "plan",
        createPhaseDeps(ctx, { ai: false, ...where }).paths.files.plan,
      );
      const app = plan.app.name;
      const confirm = flags.confirm?.trim();
      checkConfirmName(
        confirm,
        app,
        "the app's name",
        `To delete Beszel's history in a script, run \`opscrew addon disable beszel${flag} --approve <hash> … --confirm ${app}\`.`,
      );
      const deps = createPhaseDeps(ctx, {
        ai: false,
        ...where,
        approveHashes: hashes,
        ...(flags.yes === true ? { assumeYes: true } : {}),
        ...(sub === "disable"
          ? {
              wrapApprovals: (base, clock) =>
                new FlagConfirmation(base, {
                  kinds: ["host-apply"],
                  what: "deleting Beszel's history",
                  app,
                  confirmed: confirm !== undefined,
                  hashes,
                  interactive: ctx.isInteractive,
                  print: ctx.stdout,
                  clock,
                }),
            }
          : {}),
      });
      const hostKey = flags.hostKey?.trim();
      const result = await run(deps, plan, {
        ...(planOnly ? { planOnly: true } : {}),
        ...(hashes.length === 0 ? {} : { approvePlanHashes: hashes }),
        ...(hostKey === undefined ? {} : { hostKey }),
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        services: {
          ...(ctx.isInteractive ? { ask: askFor(ctx) } : {}),
          ...servicesOf(ctx).addon,
        },
      });
      return {
        result,
        app,
        planned: planOnly ? await plannedHashes(deps, result) : [],
        agentMode: plan.observability?.beszel?.mode === "agent",
      };
    },
    assumeYesHint(ctx, flags.yes),
  );
  if (planOnly) {
    const { planned } = outcome;
    if (planned.length === 0) {
      ctx.stdout("\nNothing to apply: the server and Cloudflare already match.\n");
      return;
    }
    const command = applyCommand(
      [`addon ${sub} ${kind}${flag}`, ...words].join(" "),
      planned.map((plan) => plan.hash),
      {
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        ...(flags.hostKey === undefined ? {} : { hostKey: flags.hostKey.trim() }),
        ...(flags.yes === true ? { yes: true } : {}),
      },
    );
    printPlanHashes(ctx, planned, command);
    if (sub === "disable" && kind === "beszel" && words.length === 0 && !outcome.agentMode) {
      ctx.stdout(
        `Deleting Beszel's history also needs the app's name: type it when the command asks in a terminal, or add --confirm ${outcome.app} to the command in a script (or keep the history with --keep-data).\n`,
      );
    }
    return;
  }
  printNextSteps(ctx, [
    sub === "enable"
      ? `run \`opscrew addon status${flag}\` any time to see what runs and how to open it.`
      : `run \`opscrew addon enable ${kind}${flag}\` to turn it on again.`,
  ]);
}

/**
 * `opscrew addon enable|disable|status|open` (FR-1711–FR-1713): Beszel and Grafana Cloud, off by
 * default, on a server OpsCrew deploys to (a cloud server or the user's own). Every change is a host
 * plan approved by its hash, as `portainer`'s; deleting Beszel's history also needs the app's name
 * (`--keep-data` keeps it). Tokens come from `OPSCREW_BESZEL_TOKEN` and
 * `OPSCREW_GRAFANA_CLOUD_TOKEN`, or a masked prompt in a terminal. `status` changes nothing and
 * never prints a secret; `open beszel` runs the SSH tunnel to its dashboard until Ctrl-C. Exit
 * codes: 0 done, 1 refused, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const addon = program
    .command("addon")
    .description(
      "Turn Beszel (a light dashboard) or Grafana Cloud (logs and metrics) on or off, or show and open them",
    );

  addChangeOptions(
    addon
      .command("enable")
      .description("Add Beszel or Grafana Cloud's collector (Grafana Alloy) to the app's server")
      .addArgument(kindArgument())
      .addOption(
        new Option(
          "--mode <mode>",
          "Beszel: hub (its dashboard and agent on the server, the default) or agent (only the agent, connected to your hub)",
        ).choices(["hub", "agent"]),
      )
      .option("--hub-url <url>", "Beszel's agent mode: the https address of your Beszel hub")
      .option("--hub-key <key>", "Beszel's agent mode: your hub's public key (ssh-ed25519 …)")
      .addOption(
        new Option(
          "--access <access>",
          "Beszel's dashboard: local (only through an SSH tunnel, the default) or subdomain (behind Cloudflare Access)",
        ).choices(["local", "subdomain"]),
      )
      .option(
        "--hostname <fqdn>",
        "With --access subdomain: the dashboard's hostname, or a label of your Cloudflare domain (for example beszel)",
      )
      .option(
        "--allow-email <email>",
        "With --access subdomain: an email address Cloudflare Access lets in (repeat for several)",
        collect,
      )
      .option("--metrics-url <url>", "Grafana Cloud: your stack's Prometheus remote_write URL")
      .option(
        "--metrics-user <id>",
        "Grafana Cloud: the numeric user id of your stack's Prometheus",
      )
      .option("--logs-url <url>", "Grafana Cloud: your stack's Loki push URL")
      .option("--logs-user <id>", "Grafana Cloud: the numeric user id of your stack's Loki")
      .option(
        "--log-sampling <percent>",
        "Grafana Cloud: the percentage of log lines sent, 1 to 100 (default 100)",
      ),
  ).action((kind: AddonKind, flags: EnableFlags) =>
    runChange(ctx, "enable", kind, flags, enableWords(flags), (deps, plan, options) =>
      addonEnable(deps, plan, kind, {
        ...options,
        ...(flags.mode === undefined ? {} : { mode: flags.mode }),
        ...(flags.access === undefined ? {} : { access: flags.access }),
        ...(flags.hostname === undefined ? {} : { hostname: flags.hostname }),
        ...((flags.allowEmail ?? []).length === 0 ? {} : { allowEmails: flags.allowEmail }),
        ...(flags.hubUrl === undefined ? {} : { hubUrl: flags.hubUrl }),
        ...(flags.hubKey === undefined ? {} : { hubKey: flags.hubKey }),
        ...(flags.metricsUrl === undefined ? {} : { metricsUrl: flags.metricsUrl }),
        ...(flags.metricsUser === undefined ? {} : { metricsUser: flags.metricsUser }),
        ...(flags.logsUrl === undefined ? {} : { logsUrl: flags.logsUrl }),
        ...(flags.logsUser === undefined ? {} : { logsUser: flags.logsUser }),
        ...(flags.logSampling === undefined ? {} : { logSampling: Number(flags.logSampling) }),
      }),
    ),
  );

  addChangeOptions(
    addon
      .command("disable")
      .description(
        "Remove Beszel or Grafana Alloy from the app's server, with its data (Beszel's history stays with --keep-data)",
      )
      .addArgument(kindArgument())
      .option("--keep-data", "Beszel: keep its history (the dashboard's data) on the server")
      .option(
        "--confirm <name>",
        "The app's name, to delete Beszel's history without a prompt (for scripts; with --approve and the host plan's hash)",
      ),
  ).action((kind: AddonKind, flags: DisableFlags) =>
    runChange(
      ctx,
      "disable",
      kind,
      flags,
      flags.keepData === true ? ["--keep-data"] : [],
      (deps, plan, options) =>
        addonDisable(deps, plan, kind, {
          ...options,
          ...(flags.keepData === true ? { keepData: true } : {}),
        }),
    ),
  );

  addEnvOption(
    addon
      .command("status")
      .description(
        "Show whether Beszel and Grafana Cloud are on, their containers' state and memory, and how to open them (changes nothing)",
      )
      .option("--json", "Print the status as JSON"),
  ).action(async (flags: AppEnvFlags & { json?: boolean }) => {
    const json = flags.json === true;
    const { app, name } = await chooseEnvironment(ctx, flags, "addon status");
    // Progress is dropped for `--json` so stdout holds only the status; problems go to stderr.
    const deps = createPhaseDeps(ctx, {
      ai: false,
      app,
      environment: name,
      ...(json ? { reporter: quietReporter(ctx.reporter) } : {}),
    });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const services = servicesOf(ctx).addon;
    const status = await addonStatus(deps, plan, services === undefined ? {} : { services });
    if (json) ctx.stdout(`${JSON.stringify(status, null, 2)}\n`);
  });

  addEnvOption(
    addon
      .command("open")
      .description(
        "Open Beszel's dashboard: runs the SSH tunnel to it until Ctrl-C and prints the local address",
      )
      .addArgument(kindArgument()),
  ).action(async (kind: AddonKind, flags: AppEnvFlags) => {
    const { app, name } = await chooseEnvironment(ctx, flags, `addon open ${kind}`);
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const stop = stopSignal(ctx);
    try {
      await addonOpen(deps, plan, kind, { signal: stop.signal });
    } finally {
      stop.release();
    }
  });
}
