import {
  addEnvironment,
  type EnvironmentSummary,
  type InterviewAnswers,
  listEnvironments,
  removeEnvironment,
  setDeploySource,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { DeployProviderSchema } from "@opscrew/plan-schema";
import { type Command, Option } from "commander";
import { askTypedName, checkConfirmName } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf } from "../deps";
import { chooseOption } from "../ui/options";
import { printNextSteps } from "../ui/output";
import { portainerInterviewOptions } from "../ui/portainer";
import { askQuestions } from "../ui/questions";

interface AddFlags {
  target?: string;
  from?: string;
  runner?: string;
  option?: string;
}

/** The answers the flags of `env add` give up front, by question id. */
function flagAnswers(flags: AddFlags): InterviewAnswers {
  return {
    ...(flags.target === undefined ? {} : { provider: flags.target }),
    ...(flags.from === undefined ? {} : { from: flags.from.trim() }),
    ...(flags.runner === undefined ? {} : { runner: flags.runner }),
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
      env.runner === "github"
        ? "GitHub's machines"
        : `runner on ${env.runner === "server" ? "the server" : "this computer"}`,
      env.deployed ? "yes" : "no",
    ]),
  ];
  const widths = (rows[0] ?? []).map((_, i) =>
    Math.max(...rows.map((row) => (row[i] ?? "").length)),
  );
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
    )
    .join("\n");
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
  env
    .command("add")
    .description(
      "Add an environment: ask its own questions (where it runs, its size, hostname, how it gets new versions, where its deploy job runs), design it and show its monthly cost",
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
    )
    .addOption(
      new Option(
        "--runner <where>",
        "Where its deploy job runs: github (GitHub's machines, the default), server or local (this computer)",
      ).choices(["github", "server", "local"]),
    )
    .option(
      "--option <id>",
      "Choose this design option without asking (ids are listed by the command)",
    )
    .action((name: string, flags: AddFlags) => add(ctx, name, flags));
  env
    .command("set")
    .description(
      "Change how an environment gets new versions; its next `opscrew provision --env <name>` applies the workflow change",
    )
    .argument("<name>", "The environment")
    .requiredOption(
      "--from <source>",
      "main (built and deployed on each push) or the environment it is promoted from",
    )
    .action(async (name: string, flags: { from: string }) => {
      const plan = await setDeploySource(ctx.cwd, name, flags.from.trim());
      const source = plan.environment?.deploySource;
      ctx.stdout(
        `The ${name} environment ${source?.from === "promote" ? `is deployed only by \`opscrew promote --to ${name}\`, with the image ${source.source} runs` : `is built and deployed on each push to ${plan.cicd.branch}`}.\n`,
      );
      printNextSteps(ctx, [
        `run \`opscrew provision --env ${name}\` to apply the change to its deploy workflow (it shows the change first).`,
      ]);
    });
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
