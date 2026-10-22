import {
  type AddEnvironmentOptions,
  addEnvironment,
  deployJobPlace,
  type EnvironmentSummary,
  type InterviewAnswers,
  listEnvironments,
  removeEnvironment,
  setDeploySource,
  setEnvironmentRunner,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployProviderSchema } from "@opscrew/plan-schema";
import { type Command, Option } from "commander";
import { askTypedName, checkConfirmName } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { chooseOption } from "../ui/options";
import { printNextSteps, textTable } from "../ui/output";
import { portainerInterviewOptions } from "../ui/portainer";
import { askQuestions } from "../ui/questions";
import { addHostKeyOption } from "./provision";

/** `--runner`, `--runner-host` and `--build` of `env add` and `env set`. */
interface RunnerFlags {
  runner?: string;
  runnerHost?: string;
  build?: string;
}

interface AddFlags extends RunnerFlags {
  target?: string;
  from?: string;
  option?: string;
  hostKey?: string;
}

/** The answers the flags of `env add` give up front, by question id. */
function flagAnswers(flags: AddFlags): InterviewAnswers {
  return {
    ...(flags.target === undefined ? {} : { provider: flags.target }),
    ...(flags.from === undefined ? {} : { from: flags.from.trim() }),
    ...(flags.runner === undefined ? {} : { runner: flags.runner }),
    ...(flags.runnerHost === undefined ? {} : { runnerHost: flags.runnerHost.trim() }),
    ...(flags.build === undefined ? {} : { build: flags.build }),
  };
}

/** `addEnvironment`'s options for a server the user owns: `--host-key`, and the tests' fakes. */
function ownServerOptions(
  ctx: CliContext,
  flag: string | undefined,
): Pick<AddEnvironmentOptions, "ownServer"> {
  const hostKey = flag?.trim();
  const services = servicesOf(ctx).provision?.own;
  if (hostKey === undefined && services === undefined) return {};
  return {
    ownServer: {
      ...(hostKey === undefined ? {} : { hostKey }),
      ...(services === undefined ? {} : { services }),
    },
  };
}

/**
 * `opscrew env add <name>`: the environment's own questions (in a terminal, those its flags do not
 * answer; in a script, the flags and the defaults), its requirements, and its design with the
 * monthly cost (contracts/environments.md "Commands").
 */
async function add(ctx: CliContext, name: string, flags: AddFlags): Promise<void> {
  const deps = createPhaseDeps(ctx, { ai: false, environment: name });
  const given = flagAnswers(flags);
  const prompts = promptsOf(ctx);
  const ask = (questions: Parameters<typeof askQuestions>[0]) =>
    askQuestions(questions, { prompts });
  const optionId = flags.option?.trim() || undefined;
  await addEnvironment(deps, {
    ...(ctx.isInteractive
      ? {
          ask: async (questions) => ({
            ...(await ask(questions.filter((question) => !(question.id in given)))),
            ...given,
          }),
          askServer: ask,
          askPortainer: ask,
        }
      : { answers: given }),
    portainer: portainerInterviewOptions(ctx, prompts, undefined),
    ...ownServerOptions(ctx, flags.hostKey),
    design: {
      ...(optionId === undefined ? {} : { optionId }),
      ...(ctx.isInteractive && optionId === undefined
        ? { choose: (options) => chooseOption(options, { prompts, write: ctx.stdout }) }
        : {}),
    },
  });
  // The design printed the cost and the next step (`opscrew provision --env <name>`).
}

/** The rows of `opscrew env list`. */
export function environmentTable(environments: readonly EnvironmentSummary[]): string {
  const rows = [
    ["Environment", "Runs on", "New versions", "Deploy job", "Deployed"],
    ...environments.map((env) => [
      env.name,
      env.target,
      env.from === "main" ? "each push" : `promoted from ${env.from}`,
      deployJobPlace(env.runner, env.runnerHost),
      env.deployed ? "yes" : "no",
    ]),
  ];
  return textTable(rows);
}

/** What `env set` says the environment now does: how it gets new versions, or where it runs its jobs. */
function settingLine(name: string, plan: DeployPlan, changed: "from" | "runner"): string {
  const environment = plan.environment;
  if (changed === "runner") {
    const place = deployJobPlace(environment?.runner ?? "github", environment?.runnerHost?.name);
    const build =
      environment?.build === "runner"
        ? ", which also builds its image"
        : "; GitHub's machines build its image";
    return `The ${name} environment's deploy job runs on ${place}${build}.`;
  }
  const source = environment?.deploySource;
  return `The ${name} environment ${source?.from === "promote" ? `is deployed only by \`opscrew promote --to ${name}\`, with the image ${source.source} runs` : `is built and deployed on each push to ${plan.cicd.branch}`}.`;
}

/**
 * `opscrew env set <name>`: how the environment gets new versions (`--from`), and where its
 * deploy job runs (`--runner`, with `--runner-host` and `--build`), each written to its plan;
 * its next provision shows and applies the change.
 */
async function set(ctx: CliContext, name: string, flags: RunnerFlags & { from?: string }) {
  if (flags.runner === undefined && (flags.runnerHost !== undefined || flags.build !== undefined)) {
    throw new OpsCrewError("INVALID_INPUT", "--runner-host and --build go with --runner.", {
      hint: `For example \`opscrew env set ${name} --runner host --runner-host <machine> --build runner\`.`,
    });
  }
  if (flags.from === undefined && flags.runner === undefined) {
    throw new OpsCrewError("INVALID_INPUT", "Say what to change with --from or --runner.", {
      hint: `For example \`opscrew env set ${name} --from main\` or \`opscrew env set ${name} --runner github\`.`,
    });
  }
  const lines: string[] = [];
  // The runner first: its checks refuse most often, and a refusal then saves nothing.
  if (flags.runner !== undefined) {
    const { paths } = createPhaseDeps(ctx, { ai: false, environment: name });
    const plan = await setEnvironmentRunner(paths, {
      runner: flags.runner,
      ...(flags.runnerHost === undefined ? {} : { runnerHost: flags.runnerHost }),
      ...(flags.build === undefined ? {} : { build: flags.build }),
    });
    lines.push(settingLine(name, plan, "runner"));
  }
  if (flags.from !== undefined) {
    lines.push(settingLine(name, await setDeploySource(ctx.cwd, name, flags.from.trim()), "from"));
  }
  ctx.stdout(`${lines.join("\n")}\n`);
  printNextSteps(ctx, [
    `run \`opscrew provision --env ${name}\` to apply the change to its deploy workflow (it shows the change first).`,
  ]);
}

/** Adds `--runner`, `--runner-host` and `--build` to `command`. */
function addRunnerOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        "--runner <where>",
        "Where its deploy job runs: github (GitHub's machines, the default), server, local (this computer) or host (a runner machine of yours)",
      ).choices(["github", "server", "local", "host"]),
    )
    .option(
      "--runner-host <name>",
      "With --runner host: the runner machine (default: the project's only one; `opscrew runner host list` names them)",
    )
    .addOption(
      new Option(
        "--build <where>",
        "Where its image is built: github (GitHub's machines, the default) or runner (its own runner: a runner machine with the server's CPU, or this computer's; never the server's)",
      ).choices(["github", "runner"]),
    );
}

/**
 * `opscrew env add|set|list|remove`: the app's environments beside prod (staging, dev, a copy on
 * this computer). Each has its own plan, state, secrets and approvals; the build and the
 * components are prod's. Every deployment command acts on one of them with `--env <name>`.
 */
export function register(program: Command, ctx: CliContext): void {
  const env = program
    .command("env")
    .description("Add, change, list or remove the app's environments (staging, dev, …)");
  const adding = env
    .command("add")
    .description(
      "Add an environment: ask its own questions (where it runs, its size, hostname, how it gets new versions, where its deploy job runs and its image is built), design it and show its monthly cost",
    )
    .argument("<name>", "The environment's name, for example staging or dev")
    .addOption(
      new Option(
        "--target <provider>",
        "Where it runs (default: prod's; dev: this computer)",
      ).choices(DeployProviderSchema.options),
    )
    .option(
      "--from <source>",
      "How it gets new versions: main (built and deployed on each push, the default) or the environment it is promoted from",
    );
  addHostKeyOption(addRunnerOptions(adding))
    .option(
      "--option <id>",
      "Choose this design option without asking (ids are listed by the command)",
    )
    .action((name: string, flags: AddFlags) => add(ctx, name, flags));
  const setting = env
    .command("set")
    .description(
      "Change how an environment gets new versions or where its deploy job runs; its next `opscrew provision --env <name>` applies the change",
    )
    .argument("<name>", "The environment")
    .option(
      "--from <source>",
      "main (built and deployed on each push) or the environment it is promoted from",
    );
  addRunnerOptions(setting).action((name: string, flags: RunnerFlags & { from?: string }) =>
    set(ctx, name, flags),
  );
  env
    .command("list")
    .description(
      "List the app's environments: where each runs, how it gets new versions, where its deploy job runs and whether it is deployed",
    )
    .action(async () => {
      const environments = await listEnvironments(createPhaseDeps(ctx, { ai: false }).paths);
      if (environments.length === 0) {
        ctx.stdout(
          "The app has no environment yet. Start with `opscrew design`, which plans prod.\n",
        );
        return;
      }
      ctx.stdout(`${environmentTable(environments)}\n`);
    });
  env
    .command("remove")
    .description(
      "Remove an environment's files (its plan, answers, workflow, infrastructure code and local state); refused while it is deployed",
    )
    .argument("<name>", "The environment")
    .option("--confirm <name>", "The environment's name, to remove it without a prompt (scripts)")
    .action((name: string, flags: { confirm?: string }) => remove(ctx, name, flags));
}

/**
 * `opscrew env remove <name>`: deletes the environment's deploy key, state passphrase and
 * generated secrets with its files, so a terminal has its name typed back and a script needs
 * `--confirm <name>`. prod is refused by `removeEnvironment` before anything is asked.
 */
async function remove(ctx: CliContext, name: string, flags: { confirm?: string }): Promise<void> {
  const deps = createPhaseDeps(ctx, { ai: false, environment: name });
  const again = `opscrew env remove ${name}`;
  checkConfirmName(
    flags.confirm,
    name,
    "the environment's name",
    `Run \`${again} --confirm ${name}\`.`,
  );
  if (flags.confirm === undefined && name !== "prod") {
    if (!ctx.isInteractive) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `Removing the ${name} environment deletes its deploy key, state passphrase and generated secrets on this computer, so it needs its name typed by a person, and this run is not interactive. Nothing was removed.`,
        { hint: `Run \`${again}\` in a terminal, or \`${again} --confirm ${name}\` in a script.` },
      );
    }
    ctx.stdout(
      `\nThis removes the ${name} environment's files: its plan and answers, its infrastructure code and deploy workflow, and what OpsCrew keeps for it on this computer (its deploy key, state passphrase and generated secrets).\n`,
    );
    const typed = await askTypedName(
      promptsOf(ctx),
      `Type ${name} to remove it (anything else cancels)`,
      name,
    );
    if (typed !== name) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The name typed was not ${name}, so nothing was removed.`,
        { hint: `Run \`${again}\` again when you are ready.` },
      );
    }
  }
  await removeEnvironment(deps);
}
