import { canonicalJson, listText, OpsCrewError, type ProjectPaths } from "@opscrew/core";
import {
  type DeployPlan,
  type DeployProvider,
  EnvironmentSchema,
  targetArch,
} from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import { listRunnerHosts, requireOtherMachine, requireRunnerHost } from "../runners/machine";
import { onOneServer } from "../shared/vps-target";

type Environment = NonNullable<DeployPlan["environment"]>;
type Runner = Environment["runner"];

/** Where an environment's deploy job runs, and with `build: runner` its build. */
export type RunnerChoice = Pick<Environment, "runner" | "runnerHost" | "build">;

/** The runner answered: `runner`, the runner machine's name for `host`, and where to build. */
export interface RunnerAnswer {
  runner: string;
  /** The runner machine of `runner: host`; the only one the project has by default. */
  runnerHost?: string;
  /** `github` (the default) or `runner`. */
  build?: string;
}

const RUNNERS: readonly Runner[] = ["github", "server", "local", "host"];

/** What the environment deploys to, as far as its runner is concerned. */
export interface RunnerTarget {
  provider: DeployProvider;
  deploySource: Environment["deploySource"];
}

/** Why `runner` cannot serve the target, or undefined. */
function misfit(runner: Runner, provider: DeployProvider): string | undefined {
  const onServer = onOneServer(provider);
  if (runner === "local" && provider !== "localhost") {
    return "runner local runs the deploy on this computer, so it needs this computer (localhost) as the target.";
  }
  if (runner === "server" && !onServer) {
    return "runner server needs a server OpsCrew creates or your own server as the target: a Portainer redeploys by itself, and this computer, Cloudflare hosting and GitHub Pages have no server.";
  }
  if (runner === "host" && !onServer) {
    return "runner host needs a server OpsCrew creates or your own server as the target: the runner machine deploys to it over SSH, which a Portainer, this computer, Cloudflare hosting and GitHub Pages do not take.";
  }
  return undefined;
}

/** The refusal of a build on a runner machine whose CPU is not the server's. */
function archMismatch(
  machine: { name: string; arch: string },
  environment: string,
  target: { provider: DeployProvider; arch: "amd64" | "arm64" },
): OpsCrewError {
  const { provider } = target;
  const server =
    provider === "hetzner" || provider === "digitalocean"
      ? `every server type OpsCrew offers at ${providerProfile(provider).displayName} is ${target.arch} (x86-64)`
      : `the ${environment} environment's server is ${target.arch}`;
  return new OpsCrewError(
    "INVALID_INPUT",
    `The runner machine ${machine.name} is ${machine.arch}, and ${server}: an image built on ${machine.name} would not run on the server, so it cannot build the ${environment} environment's image.`,
    {
      hint: `Build on GitHub's machines (build github), which build for the server's ${target.arch}, or choose a runner machine with an ${target.arch} CPU for this environment.`,
    },
  );
}

/**
 * The runner block of the environment `paths` belong to, from `answer`, checked for its target:
 * a runner that fits it (`local` for this computer, `server` and `host` for a server OpsCrew
 * creates or the user's own); for `host`, a runner machine recorded on this computer (the only one
 * by default), with its CPU in `runnerHost`; and `build: runner` only on a local runner or a
 * runner machine, for an environment that follows main. {@link requireMachineFits} checks the
 * machine against the server once that is known.
 * @throws OpsCrewError `INVALID_INPUT` with what to answer instead, `PHASE_PRECONDITION` for a
 * runner machine this computer does not know.
 */
export async function runnerChoice(
  paths: ProjectPaths,
  answer: RunnerAnswer,
  target: RunnerTarget,
): Promise<RunnerChoice> {
  const environment = paths.environment;
  const runner = answer.runner.trim().toLowerCase() as Runner;
  if (!RUNNERS.includes(runner)) {
    throw new OpsCrewError("INVALID_INPUT", "runner must be github, server, local or host.", {
      hint: "Answer github (GitHub's machines), server, local (this computer) or host (a runner machine).",
    });
  }
  const problem = misfit(runner, target.provider);
  if (problem !== undefined) {
    throw new OpsCrewError("INVALID_INPUT", problem, {
      hint: "Answer github, or choose a target that takes this runner.",
    });
  }
  const build = answer.build?.trim().toLowerCase() ?? "github";
  if (build !== "github" && build !== "runner") {
    throw new OpsCrewError("INVALID_INPUT", "build must be github or runner.", {
      hint: "Answer github (GitHub's machines build the image) or runner (the environment's own runner builds it).",
    });
  }
  if (build === "runner" && runner !== "local" && runner !== "host") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      runner === "server"
        ? "The server's runner never builds: the app's build scripts would then run on the server the app serves from."
        : "build runner builds on the environment's own runner, and its deploy job runs on GitHub's machines.",
      {
        hint: "Build on GitHub's machines (build github), or build on a runner machine (runner host) or, for this computer, the local runner (runner local).",
      },
    );
  }
  if (build === "runner" && target.deploySource.from !== "main") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The ${environment} environment is promoted from ${target.deploySource.source}, so it deploys the image ${target.deploySource.source} built and builds none.`,
      { hint: "Leave build at github, or deploy the environment from main." },
    );
  }
  if (runner !== "host") {
    return { runner, ...(build === "runner" ? { build: "runner" as const } : {}) };
  }
  const name = answer.runnerHost?.trim() || (await onlyMachine(paths));
  const record = await requireRunnerHost(paths, name);
  return {
    runner,
    runnerHost: { name: record.name, arch: record.arch },
    ...(build === "runner" ? { build: "runner" as const } : {}),
  };
}

/**
 * The runner machine of `choice` against the environment's server: never that server itself (the
 * server's runner is for that), and with `build: runner` of the server's CPU (FR-1534), the server
 * types that match named. Nothing to check on another runner.
 * @throws OpsCrewError `INVALID_INPUT`.
 */
export async function requireMachineFits(
  paths: ProjectPaths,
  choice: RunnerChoice,
  server: { provider: DeployProvider; arch: "amd64" | "arm64" },
): Promise<void> {
  if (choice.runner !== "host" || choice.runnerHost === undefined) return;
  const record = await requireRunnerHost(paths, choice.runnerHost.name);
  await requireOtherMachine(paths, record, paths.environment);
  if (choice.build === "runner" && record.arch !== server.arch) {
    throw archMismatch(record, paths.environment, server);
  }
}

/** The project's only runner machine on this computer; else `INVALID_INPUT` naming them. */
async function onlyMachine(paths: ProjectPaths): Promise<string> {
  const machines = (await listRunnerHosts({ paths })).map((machine) => machine.name);
  if (machines.length === 1) return machines[0] as string;
  throw new OpsCrewError(
    "INVALID_INPUT",
    machines.length === 0
      ? "runner host runs the deploy job on a runner machine, and this computer knows none for the project."
      : `runner host needs the runner machine's name: this project has ${listText(machines)}.`,
    {
      hint:
        machines.length === 0
          ? "Add one with `opscrew runner host add <name> --ssh <user@host[:port]>`, then choose it with --runner-host <name>."
          : "Choose one with --runner-host <name>.",
    },
  );
}

/**
 * `plan` of the environment `paths` belong to with where it runs its deploy job (`opscrew env set
 * <name> --runner …`, and with `build` its build), checked for its target ({@link runnerChoice};
 * without `build`, the plan's own where it still fits). `plan` itself when it is unchanged.
 */
export async function withRunner(
  paths: ProjectPaths,
  plan: DeployPlan,
  answer: RunnerAnswer,
): Promise<DeployPlan> {
  const current = plan.environment;
  const runner = answer.runner.trim().toLowerCase();
  const kept =
    answer.build === undefined &&
    current?.build === "runner" &&
    (runner === "local" || runner === "host")
      ? { build: "runner" }
      : {};
  const { provider } = plan.target;
  const choice = await runnerChoice(
    paths,
    { ...answer, ...kept },
    { provider, deploySource: current?.deploySource ?? { from: "main" } },
  );
  await requireMachineFits(paths, choice, { provider, arch: targetArch(plan.target) });
  const { runner: _runner, runnerHost: _host, build: _build, ...rest } = current ?? {};
  const environment = EnvironmentSchema.parse({ ...rest, ...choice });
  if (current !== undefined && canonicalJson(current) === canonicalJson(environment)) return plan;
  return { ...plan, environment };
}
