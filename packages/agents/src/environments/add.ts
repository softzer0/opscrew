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
import { readOwnServer, readPortainerConnection } from "../shared";
import { environmentPaths } from "./paths";
import { writeEnvironmentRequirements } from "./requirements";

/** What `opscrew env add` asks: the target, its size, hostname, deploy source and runner. */
export type EnvironmentQuestionId =
  | Extract<QuestionId, "provider" | "region" | "expectedMonthlyUsers" | "domain">
  | "from"
  | "runner";

/** One question of `opscrew env add` (same shape as a `Question`). */
export interface EnvironmentQuestion extends Omit<Question, "id"> {
  id: EnvironmentQuestionId;
}

type Runner = NonNullable<DeployPlan["environment"]>["runner"];

const RUNNERS: readonly Runner[] = ["github", "server", "local"];

/** Options of {@link addEnvironment}. */
export interface AddEnvironmentOptions {
  /**
   * Answers given up front (the CLI's flags, the MCP tool's input) by question id (`provider`,
   * `region`, `expectedMonthlyUsers`, `domain`, `from`, `runner`), with a server's `server.*` or a
   * Portainer's `portainer.*` follow-ups. A question left out takes its default; `ask` is then not
   * called.
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
  /** Design's choices: the option (the server's size), a catalogue, the server's inspection. */
  design?: Omit<RunDesignOptions, "environment">;
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
 * machines by default).
 */
export function environmentQuestions(
  name: string,
  context: { prodPlan: DeployPlan; base: Requirements; environments: readonly string[] },
  facts: ProjectFacts,
): EnvironmentQuestion[] {
  const { prodPlan, base, environments } = context;
  const interview = buildQuestions(facts, base);
  const asked = (id: QuestionId) => interview.find((q) => q.id === id) as Question;
  const provider = asked("provider");
  const hostname = defaultHostname(name, base);
  return [
    {
      ...provider,
      id: "provider",
      prompt: `Where should the ${name} environment run?`,
      options: [
        ...(provider.options ?? []),
        {
          value: "localhost",
          label: "This computer",
          hint: "the app's production stack in this computer's Docker, at a .localhost address",
        },
      ],
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
      ],
      default: "github",
      required: true,
    },
  ];
}

/** The answer `id` as trimmed lower-case text, `undefined` when not text. */
function choice(answers: InterviewAnswers, id: string): string | undefined {
  const value = answers[id];
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

/** The deploy source and runner answered, checked against the app's environments and the target. */
function environmentBlock(
  answers: InterviewAnswers,
  provider: Requirements["provider"],
  environments: readonly string[],
): NonNullable<RunDesignOptions["environment"]> {
  const from = choice(answers, "from");
  if (from === undefined || (from !== "main" && !environments.includes(from))) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `from must be main or one of the app's environments (${environments.join(", ")}), not ${JSON.stringify(String(answers.from ?? ""))}.`,
      { hint: "Answer main, or the environment whose releases this one takes." },
    );
  }
  const runner = choice(answers, "runner") as Runner | undefined;
  if (runner === undefined || !RUNNERS.includes(runner)) {
    throw new OpsCrewError("INVALID_INPUT", "runner must be github, server or local.", {
      hint: "Answer github (GitHub's machines), server or local.",
    });
  }
  const fits =
    runner === "github" ||
    (runner === "local"
      ? provider === "localhost"
      : provider !== "portainer" && provider !== "localhost");
  if (!fits) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      runner === "local"
        ? "runner local runs the deploy on this computer, so it needs this computer (localhost) as the target."
        : "runner server needs a server OpsCrew creates or your own server as the target: a Portainer redeploys by itself, and this computer has no server.",
      { hint: "Answer github, or choose a target that takes this runner." },
    );
  }
  return {
    deploySource: from === "main" ? { from: "main" } : { from: "promote", source: from },
    runner,
  };
}

/**
 * `opscrew env add <name>` for the environment `deps.paths` belong to: asks only its own questions
 * ({@link environmentQuestions}, defaults filling what `answers` leaves out), with prod's
 * connection as the default for a server the user owns or a Portainer and the interview's
 * follow-ups for another one; writes its own answers (only those that differ from prod's) and how
 * OpsCrew reaches its server; then designs it (`runDesign`, which shows its monthly cost).
 * Nothing is written when an answer is invalid.
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
  const questions = environmentQuestions(name, { prodPlan, base, environments }, facts);
  const given = options.answers ?? (options.ask === undefined ? {} : await options.ask(questions));
  const answers: InterviewAnswers = {
    ...Object.fromEntries(
      questions.flatMap((q) => (q.default === undefined ? [] : [[q.id, q.default]])),
    ),
    ...given,
  };

  let server = splitFollowUps(answers, "server", SERVER_FIELDS);
  const portainerSplit = splitFollowUps(server.rest, "portainer", PORTAINER_FIELDS);
  const { from: _from, runner: _runner, ...rest } = portainerSplit.rest;
  const requirements = answersToRequirements(rest, {
    now: deps.clock.now(),
    facts,
    previous: base,
  });
  const environment = environmentBlock(answers, requirements.provider, environments);
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
  const design = await runDesign(deps, { ...options.design, environment });
  return { requirements, design };
}
