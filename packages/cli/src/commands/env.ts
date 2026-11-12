import {
  type AddEnvironmentOptions,
  addEnvironment,
  deployJobPlace,
  type EnvironmentSummary,
  type InterviewAnswers,
  listEnvironments,
  previewRunnerRefusal,
  removeEnvironment,
  setEnvironment,
} from "@opscrew/agents";
import { listText, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployProviderSchema, readArtifact } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { type Command, Option } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { addAppOption, chooseApp, resolveCliApp } from "../ui/app";
import { ON_HOSTING_INSTEAD, requireServer } from "../ui/hosting";
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
  /** `--hostname`: the environment's hostname, answer `domain` (not with `--previews`). */
  hostname?: string;
  /**
   * `--previews`, with `--cap`, `--size`, `--lifetime`, `--domain`, `--seed` or `--no-seed`,
   * and the opt-ins `--share-server <env>` and `--app-zone`.
   */
  previews?: boolean;
  cap?: string;
  size?: string;
  lifetime?: string;
  domain?: string;
  seed?: string | false;
  shareServer?: string;
  appZone?: boolean;
}

/** The flags that go only with `--previews`: their key in {@link AddFlags}, and their name. */
const PREVIEW_FLAGS = {
  cap: "--cap",
  size: "--size",
  lifetime: "--lifetime",
  domain: "--domain",
  seed: "--seed",
  shareServer: "--share-server",
  appZone: "--app-zone",
} as const;

/**
 * Refuses, before anything is asked, flags that don't go together: a previews flag without
 * `--previews`; with it, `--cap` and `--size` together (the server type's memory gives the cap)
 * and a runner or build other than GitHub's (a pull request's code runs in the job), and `--hostname`
 * (each preview gets its own address in `--domain`).
 */
function checkPreviewFlags(flags: AddFlags, command: string): void {
  const given = Object.entries(PREVIEW_FLAGS)
    .filter(([key]) => flags[key as keyof typeof PREVIEW_FLAGS] !== undefined)
    .map(([key, flag]) => (key === "seed" && flags.seed === false ? "--no-seed" : flag));
  if (flags.previews !== true) {
    if (given.length === 0) return;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(given)} ${given.length === 1 ? "goes" : "go"} only with --previews. Nothing was changed.`,
      { hint: `To set up previews of pull requests, run \`${command} --previews\`.` },
    );
  }
  if (flags.hostname !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--hostname doesn't go with --previews: each preview gets its own address in the domain --domain gives. Nothing was changed.",
      { hint: `Leave --hostname out, for example \`${command} --previews --domain <name>\`.` },
    );
  }
  if (flags.cap !== undefined && flags.size !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--cap and --size don't go together: the server type's memory gives how many previews run at once. Nothing was changed.",
      { hint: `Give one of them, for example \`${command} --previews --cap 3\`.` },
    );
  }
  for (const flag of ["runner", "build"] as const) {
    const value = flags[flag];
    if (value === undefined || value === "github") continue;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${previewRunnerRefusal(flag, value)} Nothing was changed.`,
      { hint: `Leave --${flag} out, then run \`${command} --previews\` again.` },
    );
  }
}

/** The answers the flags of `env add` give up front, by question id. */
function flagAnswers(flags: AddFlags): InterviewAnswers {
  return {
    ...(flags.cap === undefined ? {} : { cap: flags.cap.trim() }),
    ...(flags.size === undefined ? {} : { size: flags.size.trim() }),
    ...(flags.lifetime === undefined ? {} : { lifetime: flags.lifetime.trim() }),
    ...(flags.domain === undefined ? {} : { domain: flags.domain.trim() }),
    ...(flags.hostname === undefined ? {} : { domain: flags.hostname.trim() }),
    ...(flags.seed === undefined ? {} : { seed: flags.seed === false ? false : flags.seed.trim() }),
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
 * (contracts/environments.md "Commands"). With `--previews`, a preview environment (`preview` by
 * default) and only the questions previews need (spec.md US1).
 */
async function add(ctx: CliContext, named: string | undefined, flags: AddFlags): Promise<void> {
  const appFlag = flags.app === undefined ? "" : ` --app ${flags.app.trim()}`;
  checkPreviewFlags(flags, `opscrew env add ${named ?? "preview"}${appFlag}`);
  const previews = flags.previews === true;
  if (named === undefined && !previews) {
    throw new OpsCrewError("INVALID_INPUT", "Name the environment to add.", {
      hint: `For example \`opscrew env add staging${appFlag}\`, or \`opscrew env add preview${appFlag} --previews\` for previews of pull requests.`,
    });
  }
  const name = named ?? "preview";
  const app = await resolveCliApp(ctx, flags.app, "env add");
  const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
  const given = flagAnswers(flags);
  const answered = new Set([
    ...Object.keys(given),
    ...("from" in given || "branch" in given ? ["setup"] : []),
    // The server type's memory gives the cap.
    ...("size" in given ? ["cap"] : []),
  ]);
  const prompts = promptsOf(ctx);
  const ask = (questions: Parameters<typeof askQuestions>[0]) =>
    askQuestions(questions, { prompts });
  const optionId = flags.option?.trim() || undefined;
  const shareServer = flags.shareServer?.trim();
  await addEnvironment(deps, {
    ...(previews ? { previews: true } : {}),
    // The opt-ins (spec.md US9, US10): the agent prints their warnings; without them a terminal
    // offers the choice and asks a confirmation that defaults to no.
    ...(shareServer === undefined ? {} : { shareServer }),
    ...(flags.appZone === true ? { appZone: true } : {}),
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
  // A hosting account's releases build on GitHub's runners: only `--runner github` fits there.
  if (flags.runner !== undefined && flags.runner !== "github") {
    const current = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
    if (current !== undefined) {
      requireServer(
        current,
        `\`opscrew env set --runner ${flags.runner}\``,
        ON_HOSTING_INSTEAD.runners,
      );
    }
  }
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
      "Add an environment: ask its own questions (where it runs, its size, hostname, how it gets new versions, where its deploy job runs and its image is built), design it and show its monthly cost; with --previews, previews of pull requests",
    )
    .argument(
      "[name]",
      "The environment's name, for example staging or dev (with --previews: preview by default)",
    )
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
    .option(
      "--hostname <name>",
      "The environment's hostname: any name, also in another domain your Cloudflare token covers (default: the suggested one, behind Cloudflare's proxy <name>-<random>.<prod's domain>, which nobody can guess)",
    )
    .option(
      "--previews",
      `A preview environment: one preview of the app per pull request, built and deployed by GitHub Actions on a server of its own (--target ${CLOUD_PROVIDERS.map((provider) => provider.id).join(", ")} or own; default prod's provider) or, with --share-server, another environment's`,
    )
    .option("--cap <n>", "With --previews: how many previews run at once, 1 to 20 (default 3)")
    .option(
      "--size <type>",
      "With --previews: the new server's type instead of --cap; its memory gives how many previews run at once",
    )
    .option(
      "--lifetime <days>",
      "With --previews: after how many days without a push a preview is removed, 1 to 30 (default 7)",
    )
    .option(
      "--domain <name>",
      "With --previews: a domain used only for previews, a Cloudflare zone of yours, where each preview gets an address nobody can guess (pr-<number>-<random>.<name>); no default, and not the app's own domain (`opscrew domain buy <name>` buys one) unless --app-zone",
    )
    .option(
      "--share-server <env>",
      "With --previews: run the previews on that environment's server, beside it, instead of a server of their own (never prod's); anyone who can push a branch then runs code beside its data and secrets, so only for an environment with test data and test keys",
    )
    .option(
      "--app-zone",
      "With --previews: --domain may be a name below the app's own domain (previews.<domain>); needs Cloudflare's Advanced Certificate Manager, a paid add-on, and Total TLS off, and cookies the app sets for the whole domain reach previews",
    )
    .option(
      "--seed <command>",
      "With --previews: the command that fills a new preview's database once (default: the one OpsCrew found)",
    )
    .option("--no-seed", "With --previews: no seed command; previews start with empty databases")
    .action((name: string | undefined, flags: AddFlags) => add(ctx, name, flags));
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
