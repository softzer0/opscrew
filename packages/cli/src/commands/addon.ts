import {
  ADDON_NAMES,
  type AddonResult,
  type AddonRunOptions,
  type AddonServices,
  addonDisable,
  addonEnable,
  addonOpen,
  addonStatus,
  findSavedPlan,
  type PhaseDeps,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { Argument, type Command, InvalidArgumentError, Option } from "commander";
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

/** An add-on: `beszel`, `grafana-cloud` or `monitoring` (self-hosted). */
type AddonKind = keyof typeof ADDON_NAMES | "monitoring";

const KINDS: AddonKind[] = [...(Object.keys(ADDON_NAMES) as AddonKind[]), "monitoring"];

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
  on?: "app" | "server";
  newServer?: boolean;
  metricsDays?: string;
  logsDays?: string;
}

interface DisableFlags extends ChangeFlags {
  keepData?: boolean;
  /** The app's name, to approve deleting Beszel's history without a prompt (scripts). */
  confirm?: string;
}

/** The `<beszel|grafana-cloud|monitoring>` argument. */
function kindArgument(): Argument {
  return new Argument("<addon>", "The add-on: beszel, grafana-cloud or monitoring").choices(KINDS);
}

/** Commander parser of `--port <local>`: a TCP port, 1 to 65535. */
function parsePort(value: string): number {
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError("Give a port number from 1 to 65535.");
  }
  return port;
}

/**
 * Stops before anything changes when `addon enable|disable monitoring` is given a flag of the
 * add-ons that change the server: monitoring only writes the plan, and `opscrew provision` shows
 * and applies each change by its hash.
 */
function requirePlanFlagsOnly(
  sub: "enable" | "disable",
  flags: ChangeFlags & { confirm?: string; keepData?: boolean },
): void {
  const given = [
    flags.planOnly === true ? "--plan-only" : undefined,
    (flags.approve ?? []).length > 0 ? "--approve" : undefined,
    flags.hostKey !== undefined ? "--host-key" : undefined,
    flags.engine !== undefined ? "--engine" : undefined,
    flags.keepData === true ? "--keep-data" : undefined,
    flags.confirm !== undefined ? "--confirm" : undefined,
  ].filter((flag) => flag !== undefined);
  if (given.length === 0) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `\`opscrew addon ${sub} monitoring\` only writes the plan, so ${given.join(", ")} ${given.length === 1 ? "does" : "do"} not apply to it. Nothing was changed.`,
    {
      hint: `Leave ${given.length === 1 ? "it" : "them"} out; \`opscrew provision\` then shows each change for your approval by its hash.`,
    },
  );
}

/** Adds the options `enable` and `disable` share: plan only, approvals by hash, host key, engine. */
function addChangeOptions(command: Command): Command {
  addEnvOption(command)
    .option("--plan-only", "Show the plans and their hashes; change nothing")
    .option("--approve <hash>", APPROVE_DESCRIPTION, collect);
  return addHostKeyOption(command).addOption(engineOption()).option("--yes", YES_DESCRIPTION);
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
  flags: ChangeFlags & { confirm?: string; keepData?: boolean },
  run: (deps: PhaseDeps, plan: DeployPlan, options: AddonRunOptions) => Promise<AddonResult>,
): Promise<void> {
  const planOnly = flags.planOnly === true;
  let flag = "";
  const outcome = await runPhaseCommand(
    ctx,
    async () => {
      if (kind === "monitoring") requirePlanFlagsOnly(sub, flags);
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
                  names: confirm === undefined ? [] : [confirm],
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
    // Agents' command makes the same plans again: the app's, environment's and add-on's options.
    const command = [
      outcome.result.approveCommand,
      ...planned.map((plan) => `--approve ${plan.hash}`),
      ...(flags.engine === undefined ? [] : [`--engine ${flags.engine}`]),
      ...(flags.hostKey === undefined ? [] : [`--host-key ${flags.hostKey.trim()}`]),
      ...(flags.yes === true ? ["--yes"] : []),
    ].join(" ");
    printPlanHashes(ctx, planned, command);
    if (sub === "disable" && kind === "beszel" && flags.keepData !== true && !outcome.agentMode) {
      ctx.stdout(
        `Deleting Beszel's history also needs the app's name: type it when the command asks in a terminal, or add --confirm ${outcome.app} to the command in a script (or keep the history with --keep-data).\n`,
      );
    }
    return;
  }
  if (kind === "monitoring") {
    printNextSteps(ctx, [
      `run \`opscrew provision${flag}\` to ${sub === "enable" ? "set it up" : "remove what monitoring installed"}: it shows each change for your approval by its hash.`,
    ]);
    return;
  }
  printNextSteps(ctx, [
    sub === "enable"
      ? `run \`opscrew addon status${flag}\` any time to see what runs and how to open it.`
      : `run \`opscrew addon enable ${kind}${flag}\` to turn it on again.`,
  ]);
}

/**
 * `opscrew addon enable|disable|status|open` (FR-1711–FR-1713, FR-2001, FR-2021, FR-2022): Beszel,
 * Grafana Cloud and self-hosted monitoring, off by default, on a server OpsCrew deploys to (a cloud
 * server or the user's own). Every Beszel or Grafana Cloud change is a host plan approved by its
 * hash, as `portainer`'s; deleting Beszel's history also needs the app's name (`--keep-data` keeps
 * it). Monitoring's enable and disable only write the plan: `opscrew provision` shows and applies
 * each change. Tokens come from `OPSCREW_BESZEL_TOKEN` and `OPSCREW_GRAFANA_CLOUD_TOKEN`, or a
 * masked prompt in a terminal. `status` changes nothing and never prints a secret; `open beszel`
 * and `open monitoring` run the SSH tunnel to the dashboard until Ctrl-C, or print its private
 * address on a device of the private network. Exit codes: 0 done, 1 refused, 2 error.
 */
export function register(program: Command, ctx: CliContext): void {
  const addon = program
    .command("addon")
    .description(
      "Turn Beszel (a light dashboard), Grafana Cloud (logs and metrics) or self-hosted monitoring (Prometheus, Loki and Grafana on your own server) on or off, or show and open them",
    );

  addChangeOptions(
    addon
      .command("enable")
      .description(
        "Add Beszel or Grafana Cloud's collector (Grafana Alloy) to the app's server, or write self-hosted monitoring into the plan for `opscrew provision` to set up",
      )
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
      )
      .addOption(
        new Option(
          "--on <where>",
          "Monitoring: server (the default: the repository's monitoring server, or a small one of its own) or app (the app's server, with at least 4 GB of memory)",
        ).choices(["app", "server"]),
      )
      .option(
        "--new-server",
        "Monitoring: a monitoring server of this environment's own, even when the repository has one",
      )
      .option("--metrics-days <n>", "Monitoring: the days figures are kept, 1 to 90 (default 15)")
      .option("--logs-days <n>", "Monitoring: the days logs are kept, 1 to 30 (default 7)"),
  ).action((kind: AddonKind, flags: EnableFlags) =>
    runChange(ctx, "enable", kind, flags, (deps, plan, options) =>
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
        ...(flags.on === undefined ? {} : { on: flags.on }),
        ...(flags.newServer === true ? { newServer: true } : {}),
        ...(flags.metricsDays === undefined ? {} : { metricsDays: Number(flags.metricsDays) }),
        ...(flags.logsDays === undefined ? {} : { logsDays: Number(flags.logsDays) }),
      }),
    ),
  );

  addChangeOptions(
    addon
      .command("disable")
      .description(
        "Remove Beszel or Grafana Alloy from the app's server, with its data (Beszel's history stays with --keep-data), or take self-hosted monitoring out of the plan for `opscrew provision` to remove",
      )
      .addArgument(kindArgument())
      .option("--keep-data", "Beszel: keep its history (the dashboard's data) on the server")
      .option(
        "--confirm <name>",
        "The app's name, to delete Beszel's history without a prompt (for scripts; with --approve and the host plan's hash)",
      ),
  ).action((kind: AddonKind, flags: DisableFlags) =>
    runChange(ctx, "disable", kind, flags, (deps, plan, options) =>
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
        "Show whether Beszel, Grafana Cloud and self-hosted monitoring are on, their containers' state and memory, how to open them, and monitoring's last data from each server, disk and retention (changes nothing)",
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
        "Open Beszel's dashboard or Grafana (monitoring): on a device of the private network prints its private address, otherwise runs the SSH tunnel to it until Ctrl-C and prints the local address",
      )
      .addArgument(kindArgument())
      .option(
        "--port <local>",
        "Monitoring: the port on this computer Grafana's tunnel listens on (default 3000)",
        parsePort,
      ),
  ).action(async (kind: AddonKind, flags: AppEnvFlags & { port?: number }) => {
    const { app, name } = await chooseEnvironment(ctx, flags, `addon open ${kind}`);
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const stop = stopSignal(ctx);
    try {
      await addonOpen(deps, plan, kind, {
        signal: stop.signal,
        ...(flags.port === undefined ? {} : { port: flags.port }),
      });
    } finally {
      stop.release();
    }
  });
}
