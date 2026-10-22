import { ensureStateDir, OpsCrewError, toPosixRelative } from "@opscrew/core";
import {
  cloudflareEdgeCoverage,
  type DeployPlan,
  environmentsOf,
  likelyCloudflareZone,
  type ProjectFacts,
  type Question,
  type QuestionId,
  type Requirements,
  readArtifact,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type DesignResult, type RunDesignOptions, runDesign } from "../design/run";
import { answersToRequirements } from "../interview/answers";
import { hasFollowUps, splitFollowUps } from "../interview/follow-ups";
import {
  answersToOwnServer,
  buildServerQuestions,
  type OwnServerAnswers,
  recordOwnServerAnswers,
  SERVER_FIELDS,
  type ServerQuestion,
} from "../interview/own-server";
import {
  PORTAINER_FIELDS,
  type PortainerAnswers,
  type PortainerInterviewOptions,
  type PortainerQuestion,
  recordPortainerAnswers,
} from "../interview/portainer";
import { buildQuestions, type InterviewAnswers } from "../interview/questions";
import { portainerAnswers } from "../interview/run";
import type { OwnServerServices } from "../provision/types";
import { listRunnerHosts } from "../runners/machine";
import { readOwnServer, readPortainerConnection } from "../shared";
import { inspectOwnServerForDesign } from "../shared/own-server-design";
import { environmentPaths } from "./paths";
import { writeEnvironmentRequirements } from "./requirements";
import { requireMachineFits, runnerChoice } from "./runner";

/**
 * What `opscrew env add` asks: the target, its size, hostname, deploy source, runner (with the
 * runner machine when the project has runner machines) and where the image is built.
 */
export type EnvironmentQuestionId =
  | Extract<QuestionId, "provider" | "region" | "expectedMonthlyUsers" | "domain">
  | "from"
  | "runner"
  | "runnerHost"
  | "build";

/** One question of `opscrew env add` (same shape as a `Question`). */
export interface EnvironmentQuestion extends Omit<Question, "id"> {
  id: EnvironmentQuestionId;
}

/** Options of {@link addEnvironment}. */
export interface AddEnvironmentOptions {
  /**
   * Answers given up front (the CLI's flags, the MCP tool's input) by question id (`provider`,
   * `region`, `expectedMonthlyUsers`, `domain`, `from`, `runner`, `runnerHost`, `build`), with a
   * server's `server.*` or a Portainer's `portainer.*` follow-ups. A question left out takes its
   * default; `ask` is then not called.
   */
  answers?: InterviewAnswers;
  /** Asks the environment's questions interactively. */
  ask?: (questions: EnvironmentQuestion[]) => Promise<InterviewAnswers>;
  /** Asks the follow-ups for a server the user owns, with prod's as the defaults. */
  askServer?: (questions: ServerQuestion[]) => Promise<InterviewAnswers>;
  /** Asks the follow-ups for a Portainer, with prod's as the defaults. */
  askPortainer?: (questions: PortainerQuestion[]) => Promise<InterviewAnswers>;
  /** How OpsCrew reaches a Portainer (as for `opscrew interview`). */
  portainer?: PortainerInterviewOptions;
  /**
   * Design's choices: the option (the server's size), a catalogue, the server's inspection (by
   * default a server the user owns is inspected over SSH first, as for `opscrew design`).
   */
  design?: Omit<RunDesignOptions, "environment">;
  /**
   * A server the user owns: `--host-key` for its first connection when nobody can confirm it, and
   * its shell and host adapter (fakes in tests).
   */
  ownServer?: { hostKey?: string; services?: OwnServerServices };
}

/** What {@link addEnvironment} wrote: the environment's requirements, and its design. */
export interface AddEnvironmentResult {
  requirements: Requirements;
  /** The design, whose chosen option has the environment's monthly cost. */
  design: DesignResult;
}

/**
 * The default hostname of the environment `name`: `<name>.<domain>`, or, where Cloudflare's free
 * certificate would not cover that name, the one-level name it suggests (`staging-shop.example.com`).
 */
function defaultHostname(name: string, base: Requirements): string | undefined {
  const { domain } = base;
  if (domain === undefined) return undefined;
  const hostname = `${name}.${domain}`;
  if (base.dnsProvider !== "cloudflare") return hostname;
  return cloudflareEdgeCoverage(hostname, likelyCloudflareZone(domain))?.suggestion ?? hostname;
}

/**
 * The questions of `opscrew env add <name>`: only the environment's own. Its target (prod's by
 * default, this computer for `dev`), the region for a cloud server, its size (the expected users,
 * the fewest by default), its hostname (`<name>.<domain>`), how it gets new versions (from main by
 * default, or promoted from an existing environment) and where its deploy job runs (GitHub's
 * machines by default), with the project's `runnerHosts` (its runner machines' names) a runner
 * machine too and the question which one, and where its image is built.
 */
export function environmentQuestions(
  name: string,
  context: {
    prodPlan: DeployPlan;
    base: Requirements;
    environments: readonly string[];
    runnerHosts?: readonly string[];
  },
  facts: ProjectFacts,
): EnvironmentQuestion[] {
  const { prodPlan, base, environments } = context;
  const machines = context.runnerHosts ?? [];
  const interview = buildQuestions(facts, base);
  const asked = (id: QuestionId) => interview.find((q) => q.id === id) as Question;
  const provider = asked("provider");
  const hostname = defaultHostname(name, base);
  return [
    {
      // The interview's targets, this computer among them.
      ...provider,
      id: "provider",
      prompt: `Where should the ${name} environment run?`,
      default: name === "dev" ? "localhost" : prodPlan.target.provider,
    },
    { ...asked("region"), id: "region" },
    {
      ...asked("expectedMonthlyUsers"),
      id: "expectedMonthlyUsers",
      prompt: `How many people will use the ${name} environment each month?`,
      help: "It decides the server size. An environment for trying changes usually needs the smallest.",
      default: "<1k",
    },
    {
      ...asked("domain"),
      id: "domain",
      prompt: `Which hostname should the ${name} environment use?`,
      help: "Its own: no other environment may use it. Not used on this computer, which has its own .localhost address.",
      ...(hostname === undefined ? {} : { default: hostname }),
    },
    {
      id: "from",
      prompt: `How should the ${name} environment get new versions?`,
      kind: "single-select",
      options: [
        {
          value: "main",
          label: `Built and deployed on each push to ${prodPlan.cicd.branch}`,
        },
        ...environments.map((source) => ({
          value: source,
          label: `Promoted from ${source}`,
          hint: `deployed only by \`opscrew promote\`, with exactly the image ${source} runs`,
        })),
      ],
      default: "main",
      required: true,
    },
    {
      id: "runner",
      prompt: `Where should the ${name} environment's deploy job run?`,
      kind: "single-select",
      options: [
        { value: "github", label: "On GitHub's machines", hint: "as for prod today" },
        {
          value: "server",
          label: "On a runner on the server",
          hint: "a server OpsCrew creates or your own; GitHub then never connects to it over SSH",
        },
        { value: "local", label: "On a runner on this computer", hint: "this computer only" },
        ...(machines.length > 0
          ? [
              {
                value: "host",
                label: "On a runner machine of yours",
                hint: "a machine you added with `opscrew runner host add`; it deploys to the server over SSH",
              },
            ]
          : []),
      ],
      default: "github",
      required: true,
    },
    // Optional, with no default: `runnerChoice` fills them in (the only machine, GitHub's
    // machines), so answering github never asks for a machine.
    ...(machines.length > 0
      ? [
          {
            id: "runnerHost",
            prompt: `Which runner machine should run the ${name} environment's jobs?`,
            help: "Only when its deploy job runs on a runner machine; with one machine, that one.",
            kind: "single-select",
            options: machines.map((machine) => ({ value: machine, label: machine })),
            required: false,
          } satisfies EnvironmentQuestion,
        ]
      : []),
    {
      // Offered with every target: a runner machine, or this computer with its own runner.
      id: "build",
      prompt: `Where should the ${name} environment's image be built?`,
      help: "On its own runner only with a runner machine of the server's CPU, or with this computer's runner; GitHub's machines otherwise.",
      kind: "single-select",
      options: [
        { value: "github", label: "On GitHub's machines", hint: "as for prod" },
        {
          value: "runner",
          label: "On its own runner",
          hint: "a runner machine or this computer's runner; never the server's",
        },
      ],
      required: false,
    },
  ];
}

/** The answer `id` as trimmed text, `undefined` when not text. */
function text(answers: InterviewAnswers, id: string): string | undefined {
  const value = answers[id];
  return typeof value === "string" ? value.trim() : undefined;
}

/** The deploy source answered, checked against the app's environments. */
function deploySourceOf(
  answers: InterviewAnswers,
  environments: readonly string[],
): NonNullable<DeployPlan["environment"]>["deploySource"] {
  const from = text(answers, "from")?.toLowerCase();
  if (from === undefined || (from !== "main" && !environments.includes(from))) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `from must be main or one of the app's environments (${environments.join(", ")}), not ${JSON.stringify(String(answers.from ?? ""))}.`,
      { hint: "Answer main, or the environment whose releases this one takes." },
    );
  }
  return from === "main" ? { from: "main" } : { from: "promote", source: from };
}

/**
 * `opscrew env add <name>` for the environment `deps.paths` belong to: asks only its own questions
 * ({@link environmentQuestions}, defaults filling what `answers` leaves out), with prod's
 * connection as the default for a server the user owns or a Portainer and the interview's
 * follow-ups for another one; checks its runner (`runnerChoice`: a runner machine of the project
 * with the server's CPU when it builds there, never the environment's own server); writes its own
 * answers (only those that differ from prod's) and how OpsCrew reaches its server; inspects a
 * server the user owns over SSH, as `opscrew design` does; then designs it (`runDesign`, which
 * shows its monthly cost). Nothing is written when an answer is invalid, apart from a runner
 * machine that does not fit the user's own server, which only its inspection shows.
 * @throws OpsCrewError `INVALID_INPUT` for prod or an invalid answer, `PHASE_PRECONDITION` when
 * the environment exists or prod's plan does not yet.
 */
export async function addEnvironment(
  deps: PhaseDeps,
  options: AddEnvironmentOptions = {},
): Promise<AddEnvironmentResult> {
  const { paths } = deps;
  const name = paths.environment;
  if (name === "prod") {
    throw new OpsCrewError("INVALID_INPUT", "prod is the app's first environment already.", {
      hint: "Give the new environment another name, for example staging or dev.",
    });
  }
  const environments = await environmentsOf(paths.root);
  if (environments.includes(name)) {
    throw new OpsCrewError("PHASE_PRECONDITION", `The app already has a ${name} environment.`, {
      hint: `Run \`opscrew design --env ${name}\` to design it again, or \`opscrew env remove ${name}\` first.`,
    });
  }
  const prodPaths = environmentPaths(paths, "prod");
  const prodPlan = await readOptionalArtifact("plan", prodPaths.files.plan);
  if (prodPlan === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Every environment takes the app's shared parts from prod's plan, and opscrew/plan.yaml does not exist yet.",
      { hint: "Run `opscrew design` first, then add the environment." },
    );
  }
  const base = await readArtifact("requirements", paths.files.shared.requirementsBase);
  const { facts } = await readArtifact("architecture", paths.files.architecture);
  const runnerHosts = (await listRunnerHosts(deps)).map((machine) => machine.name);
  const questions = environmentQuestions(
    name,
    { prodPlan, base, environments, runnerHosts },
    facts,
  );
  const given = options.answers ?? (options.ask === undefined ? {} : await options.ask(questions));
  const answers: InterviewAnswers = {
    ...Object.fromEntries(
      questions.flatMap((q) => (q.default === undefined ? [] : [[q.id, q.default]])),
    ),
    ...given,
  };

  let server = splitFollowUps(answers, "server", SERVER_FIELDS);
  const portainerSplit = splitFollowUps(server.rest, "portainer", PORTAINER_FIELDS);
  const {
    from: _from,
    runner: _runner,
    runnerHost: _runnerHost,
    build: _build,
    ...rest
  } = portainerSplit.rest;
  const requirements = answersToRequirements(rest, {
    now: deps.clock.now(),
    facts,
    previous: base,
  });
  const deploySource = deploySourceOf(answers, environments);
  const runnerHost = text(answers, "runnerHost");
  const build = text(answers, "build");
  const runner = await runnerChoice(
    paths,
    {
      runner: text(answers, "runner") ?? "",
      ...(runnerHost !== undefined ? { runnerHost } : {}),
      ...(build !== undefined ? { build } : {}),
    },
    { provider: requirements.provider, deploySource },
  );
  // A server OpsCrew creates is amd64; the user's own server is checked once it is inspected.
  if (requirements.provider !== "own") {
    await requireMachineFits(paths, runner, { provider: requirements.provider, arch: "amd64" });
  }
  const cloudflareDomain =
    requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined;
  const domain = requirements.domain === undefined ? {} : { domain: requirements.domain };

  const prodOwn = requirements.provider === "own" ? await readOwnServer(prodPaths) : undefined;
  let ownServer: OwnServerAnswers | undefined;
  if (requirements.provider === "own") {
    const context = { ...(prodOwn ? { previous: prodOwn } : {}), cloudflareDomain, ...domain };
    if (!hasFollowUps(server) && options.askServer !== undefined) {
      server = splitFollowUps(
        await options.askServer(buildServerQuestions(context)),
        "server",
        SERVER_FIELDS,
      );
    }
    ownServer = answersToOwnServer(server, context);
  }
  let portainer: PortainerAnswers | undefined;
  if (requirements.provider === "portainer") {
    const previous = await readPortainerConnection(prodPaths);
    portainer = await portainerAnswers(deps, options, portainerSplit, {
      ...(previous ? { previous } : {}),
      cloudflareDomain,
      ...domain,
    });
  }

  await ensureStateDir(paths);
  if (ownServer !== undefined) await recordOwnServerAnswers(paths, ownServer, prodOwn);
  if (portainer !== undefined) await recordPortainerAnswers(paths, portainer);
  await writeEnvironmentRequirements(paths, requirements);
  deps.reporter.success(
    `Wrote ${toPosixRelative(paths.root, paths.files.requirements)}: the ${name} environment's own answers.`,
  );
  // A server the user owns is inspected before design, as `opscrew design` does (its size, the
  // apps on it, its CPU); the host key is confirmed at the first connection.
  const inspected =
    options.design?.ownServer ??
    (requirements.provider === "own"
      ? await inspectOwnServerForDesign(deps, {
          ...(options.ownServer?.hostKey !== undefined
            ? { hostKey: options.ownServer.hostKey }
            : {}),
          ...(options.ownServer?.services !== undefined
            ? { services: options.ownServer.services }
            : {}),
        })
      : undefined);
  if (requirements.provider === "own") {
    await requireMachineFits(paths, runner, {
      provider: "own",
      arch: inspected?.facts?.arch ?? "amd64",
    });
  }
  const design = await runDesign(deps, {
    ...options.design,
    ...(inspected !== undefined ? { ownServer: inspected } : {}),
    environment: { deploySource, ...runner },
  });
  return { requirements, design };
}
