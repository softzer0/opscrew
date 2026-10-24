import {
  type AddEnvironmentOptions,
  addEnvironment,
  deployJobPlace,
  type EnvironmentSummary,
  type InterviewAnswers,
  listEnvironments,
  removeEnvironment,
  setEnvironment,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployProviderSchema } from "@opscrew/plan-schema";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { addAppOption, chooseApp, resolveCliApp } from "../ui/app";
import { chooseOption } from "../ui/options";
import { printNextSteps, textTable } from "../ui/output";
import { portainerInterviewOptions } from "../ui/portainer";
import { askQuestions } from "../ui/questions";
import { confirmRemoval } from "../ui/removal";
import { addHostKeyOption } from "./provision";

/** `--app <key>`, on every subcommand: the repository's app whose environments these are. */
interface AppFlags {
  app?: string;
}

/** `--runner`, `--runner-host` and `--build` of `env add` and `env set`. */
interface RunnerFlags extends AppFlags {
  runner?: string;
  runnerHost?: string;
  build?: string;
}

interface AddFlags extends RunnerFlags {
  target?: string;
  from?: string;
  branch?: string;
  option?: string;
  hostKey?: string;
}

/** The answers the flags of `env add` give up front, by question id. */
function flagAnswers(flags: AddFlags): InterviewAnswers {
  return {
    ...(flags.target === undefined ? {} : { provider: flags.target }),
    ...(flags.from === undefined ? {} : { from: flags.from.trim() }),
    ...(flags.branch === undefined ? {} : { branch: flags.branch.trim() }),
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
 * answer, and the setup of FR-1537 unless `--from` or `--branch` decide it; in a script, the
 * flags and the defaults), its requirements, and its design with the monthly cost
 * (contracts/environments.md "Commands").
 */
async function add(ctx: CliContext, name: string, flags: AddFlags): Promise<void> {
  const app = await resolveCliApp(ctx, flags.app, "env add");
  const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
  const given = flagAnswers(flags);
  const answered = new Set([
    ...Object.keys(given),
    ...("from" in given || "branch" in given ? ["setup"] : []),
  ]);
  const prompts = promptsOf(ctx);
  const ask = (questions: Parameters<typeof askQuestions>[0]) =>
    askQuestions(questions, { prompts });
  const optionId = flags.option?.trim() || undefined;
  await addEnvironment(deps, {
    ...(ctx.isInteractive
      ? {
          ask: async (questions) => ({
            ...(await ask(questions.filter((question) => !answered.has(question.id)))),
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
      env.from === "main" ? `each push to ${env.branch}` : `promoted from ${env.from}`,
      deployJobPlace(env.runner, env.runnerHost),
      env.deployed ? "yes" : "no",
    ]),
  ];
  return textTable(rows);
}

/**
 * What `env set` says the environment now does: how it gets new versions, the branch it follows,
 * or where it runs its jobs.
 */
function settingLine(
  name: string,
  plan: DeployPlan,
  changed: "from" | "branch" | "runner",
  flag: string,
): string {
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
  if (source?.from === "promote") {
    return changed === "branch"
      ? `The ${name} environment follows ${plan.cicd.branch} once it is built from main again (\`opscrew env set ${name}${flag} --from main\`); until then only \`opscrew promote${flag} --to ${name}\` deploys it.`
      : `The ${name} environment is deployed only by \`opscrew promote${flag} --to ${name}\`, with the image ${source.source} runs.`;
  }
  return `The ${name} environment is built and deployed on each push to ${plan.cicd.branch}.`;
}

/** The flags of `env set`. */
interface SetFlags extends RunnerFlags {
  from?: string;
  branch?: string;
}

/**
 * `opscrew env set <name>`: how the environment gets new versions (`--from`, and `--branch`, the
 * branch it follows from main), and where its deploy job runs (`--runner`, with `--runner-host`
 * and `--build`), each written to its plan; its next provision shows and applies the change.
 */
async function set(ctx: CliContext, name: string, flags: SetFlags) {
  const given = flags.app === undefined ? "" : ` --app ${flags.app.trim()}`;
  if (flags.runner === undefined && (flags.runnerHost !== undefined || flags.build !== undefined)) {
    throw new OpsCrewError("INVALID_INPUT", "--runner-host and --build go with --runner.", {
      hint: `For example \`opscrew env set ${name}${given} --runner host --runner-host <machine> --build runner\`.`,
    });
  }
  if (flags.from === undefined && flags.branch === undefined && flags.runner === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Say what to change with --from, --branch or --runner.",
      {
        hint: `For example \`opscrew env set ${name}${given} --from main\`, \`opscrew env set ${name}${given} --branch develop\` or \`opscrew env set ${name}${given} --runner github\`.`,
      },
    );
  }
  const app = await chooseApp(ctx, flags.app, "env set");
  const deps = createPhaseDeps(ctx, { ai: false, app: app.key, environment: name });
  const plan = await setEnvironment(deps, {
    ...(flags.from === undefined ? {} : { from: flags.from.trim() }),
    ...(flags.branch === undefined ? {} : { branch: flags.branch }),
    ...(flags.runner === undefined
      ? {}
      : {
          runner: {
            runner: flags.runner,
            ...(flags.runnerHost === undefined ? {} : { runnerHost: flags.runnerHost }),
            ...(flags.build === undefined ? {} : { build: flags.build }),
          },
        }),
  });
  const lines = [
    ...(flags.runner === undefined ? [] : [settingLine(name, plan, "runner", app.flag)]),
    // With --from the source's line names the branch too.
    ...(flags.branch === undefined || flags.from !== undefined
      ? []
      : [settingLine(name, plan, "branch", app.flag)]),
    ...(flags.from === undefined ? [] : [settingLine(name, plan, "from", app.flag)]),
  ];
  ctx.stdout(`${lines.join("\n")}\n`);
  printNextSteps(ctx, [
    `run \`opscrew provision${app.flag} --env ${name}\` to apply the change to its deploy workflow (it shows the change first).`,
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
 * components follow the image (its own design's when it builds, its source's when it is
 * promoted). Every deployment command acts on one of them with `--env <name>`, and every
 * subcommand on the app `--app <key>` names.
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
        "Where it runs (default: prod's; dev: this computer). A site on cloudflare-workers or github-pages keeps prod's target: each environment gets its own Worker, and GitHub Pages has prod only",
      ).choices(DeployProviderSchema.options),
    )
    .option(
      "--from <source>",
      "How it gets new versions: main (built and deployed on each push, the default) or the environment it is promoted from",
    )
    .option(
      "--branch <name>",
      "With --from main: the branch whose pushes build and deploy it (default: the repository's default branch); one the repository has and no other environment follows",
    );
  addHostKeyOption(addRunnerOptions(addAppOption(adding)))
    .option(
      "--option <id>",
      "Choose this design option without asking (ids are listed by the command)",
    )
    .action((name: string, flags: AddFlags) => add(ctx, name, flags));
  const setting = env
    .command("set")
    .description(
      "Change how an environment gets new versions, the branch it follows or where its deploy job runs; its next `opscrew provision --env <name>` applies the change",
    )
    .argument("<name>", "The environment")
    .option(
      "--from <source>",
      "main (built and deployed on each push) or the environment it is promoted from",
    )
    .option(
      "--branch <name>",
      "The branch whose pushes build and deploy it from main; one the repository has and no other environment follows",
    );
  addRunnerOptions(addAppOption(setting)).action((name: string, flags: SetFlags) =>
    set(ctx, name, flags),
  );
  const listing = env
    .command("list")
    .description(
      "List the app's environments: where each runs, how it gets new versions, where its deploy job runs and whether it is deployed",
    );
  addAppOption(listing).action(async (flags: AppFlags) => {
    const app = await chooseApp(ctx, flags.app, "env list");
    const environments = await listEnvironments(
      createPhaseDeps(ctx, { ai: false, app: app.key }).paths,
    );
    if (environments.length === 0) {
      ctx.stdout(
        `The app has no environment yet. Start with \`opscrew design${app.flag}\`, which plans prod.\n`,
      );
      return;
    }
    ctx.stdout(`${environmentTable(environments)}\n`);
  });
  const removing = env
    .command("remove")
    .description(
      "Remove an environment's files (its plan, answers, workflow, infrastructure code and local state); refused while it is deployed",
    )
    .argument("<name>", "The environment")
    .option("--confirm <name>", "The environment's name, to remove it without a prompt (scripts)");
  addAppOption(removing).action((name: string, flags: RemoveFlags) => remove(ctx, name, flags));
}

/** The flags of `env remove`. */
interface RemoveFlags extends AppFlags {
  confirm?: string;
}

/**
 * `opscrew env remove <name>`: deletes the environment's deploy key, state passphrase and
 * generated secrets with its files, so a terminal has its name typed back and a script needs
 * `--confirm <name>`. prod is refused by `removeEnvironment` before anything is asked.
 */
async function remove(ctx: CliContext, name: string, flags: RemoveFlags): Promise<void> {
  const app = await chooseApp(ctx, flags.app, "env remove");
  const deps = createPhaseDeps(ctx, { ai: false, app: app.key, environment: name });
  if (name !== "prod") {
    await confirmRemoval(ctx, {
      name,
      confirm: flags.confirm,
      what: "the environment's name",
      subject: `the ${name} environment`,
      details: `This removes the ${name} environment's files: its plan and answers, its infrastructure code and deploy workflow, and what OpsCrew keeps for it on this computer (its deploy key, state passphrase and generated secrets).`,
      again: `opscrew env remove ${name}${app.flag}`,
    });
  }
  await removeEnvironment(deps);
}
