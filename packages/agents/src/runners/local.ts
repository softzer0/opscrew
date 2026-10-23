/**
 * The local runner (`environment.runner: local`, plan.md "12.", FR-1529): `opscrew runner start`
 * runs GitHub's pinned runner on this computer, as the user, in the foreground. Each session is
 * registered `--ephemeral` with the environment's label and a token fetched at its start; it takes
 * one deploy job, and is removed through GitHub's API when it ends, when the user stops it or on a
 * signal. Its jobs find this computer's stack folders, the local CA's certificate and the local
 * deploy lock in the runner's `.env`, and never the user's secrets.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { CommandResult } from "@opscrew/contracts";
import {
  errorMessage,
  isSecretEnvName,
  OpsCrewError,
  sanitizeAgentEnv,
  sha256Hex,
} from "@opscrew/core";
import { type RunnerPlatform, runnerLabel, TOOLS } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { environmentPaths } from "../environments/paths";
import { caFiles } from "../localhost/ca";
import { clearStaleLock, lockFile } from "../localhost/lock";
import {
  computer,
  type LocalhostServices,
  localRoots,
  requireShell,
  shellPath,
} from "../localhost/services";
import {
  applyRunnerSettings,
  checkRunnerRepository,
  deleteRegistrations,
  type RunnerGitHubApi,
  repositoryUrl,
  runnerRepository,
} from "./github";
import { planWhere, runnerSuffix } from "./words";

/** The runner's process as {@link startLocalRunner} drives it. */
export interface RunnerProcess {
  /** Settles with the exit code once the process ended. */
  exited: Promise<number>;
  /** Sends `signal` to the process and everything it started. */
  signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
}

/** Starts the runner's long-running process, each output line to `onLine`. */
export type StartRunnerProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; onLine: (line: string) => void },
) => RunnerProcess;

/** This computer's side effects the local runner uses; each defaults to the real one. */
export interface LocalRunnerServices {
  /** GitHub's runner API (default: the client of the user's GitHub token). */
  github?: RunnerGitHubApi;
  /** This computer: its OS, CPU, name, programs and sleep (default: the real ones). */
  computer?: LocalhostServices;
  /**
   * Calls `stop` on the signals that end the runner (default: SIGINT, SIGTERM and SIGHUP of this
   * process); returns what unsubscribes it.
   */
  onSignal?: (stop: () => void) => () => void;
  /** Starts the runner's `run` script (default: `node:child_process`, in its own process group). */
  start?: StartRunnerProcess;
}

/** A local runner that runs until {@link LocalRunner.stop} or a signal. */
export interface LocalRunner {
  /** Stops the runner and removes its registration; resolves once it is removed. */
  stop(): Promise<void>;
  /** Settles when the runner ended: stopped, or failed (the error says what to do). */
  finished: Promise<void>;
}

/** After a stop's SIGINT, how long the runner may finish its job before SIGTERM. */
const STOP_GRACE_MS = 60_000;
/** After SIGTERM, how long before SIGKILL. */
const KILL_AFTER_MS = 30_000;

/**
 * Stops plainly when the localhost plan builds its image on this computer (`image: local-build`):
 * the local runner's workflow deploys the image GitHub Actions built, and each provision would
 * build and start a local image in its place.
 * @throws OpsCrewError `PHASE_PRECONDITION`.
 */
export async function requireLocalRunnerImage(root: string, plan: DeployPlan): Promise<void> {
  if (plan.environment?.runner !== "local") return;
  if (plan.target.provider !== "localhost" || plan.target.image !== "local-build") return;
  const { file, flag } = await planWhere(root, plan);
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "The local runner deploys the image GitHub Actions built, but this environment builds its image on this computer (image: local-build), which the deploy would never pull. Nothing was changed.",
    {
      hint: `Set target.image to registry in ${file}, or set environment.runner to github there and deploy from this computer with \`opscrew provision${flag}\`.`,
    },
  );
}

/** GitHub's names of the systems it publishes a runner for, by `process.platform`. */
const RUNNER_OS: Partial<Record<NodeJS.Platform, string>> = {
  linux: "linux",
  darwin: "osx",
  win32: "win",
};

/** The runner release for this computer, by Node's `process.platform` and `os.arch()`. */
function runnerPlatform(platform: NodeJS.Platform, arch: string): RunnerPlatform | undefined {
  const asset = `${RUNNER_OS[platform]}-${arch}`;
  return asset in TOOLS.githubRunner.assets ? (asset as RunnerPlatform) : undefined;
}

/** `<computer>-<app>-<env>`: the runner's name on GitHub, in the characters GitHub takes. */
function runnerName(computerName: string, plan: DeployPlan): string {
  const env = runnerSuffix(plan);
  const host = computerName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return `${host.slice(0, Math.max(1, 63 - env.length))}-${env}`;
}

/** Signals of this process that end the runner. */
function processSignals(stop: () => void): () => void {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  return () => {
    for (const signal of signals) process.off(signal, stop);
  };
}

/**
 * The runner's process through `node:child_process`: on macOS and Linux in its own process group,
 * which each signal reaches as a whole; on Windows `taskkill /T` (with `/F` for SIGKILL).
 */
const startProcess: StartRunnerProcess = (command, args, options) => {
  const windows = process.platform === "win32";
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: !windows,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", options.onLine);
  }
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve(code ?? (signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0))),
    );
  });
  return {
    exited,
    signal(signal) {
      const pid = child.pid;
      if (pid === undefined) return;
      if (windows) {
        const force = signal === "SIGKILL" ? ["/F"] : [];
        spawn("taskkill", ["/pid", String(pid), "/T", ...force], {
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => child.kill(signal));
        return;
      }
      try {
        process.kill(-pid, signal);
      } catch {
        child.kill(signal);
      }
    },
  };
};

/** The last line of a command's output, redacted, for an error. */
function lastLine(deps: Pick<PhaseDeps, "redactor">, result: CommandResult): string {
  const lines = `${result.stdout}\n${result.stderr}`.trim().split("\n");
  return deps.redactor.redact(lines.at(-1)?.trim() || `exit code ${result.exitCode}`);
}

/**
 * The pinned runner in `dir` (its version in `.opscrew-version`): kept when it is there; otherwise
 * downloaded, checked against the pin's SHA-256 before anything in it runs, and unpacked into a
 * fresh folder.
 */
async function install(
  deps: PhaseDeps,
  dir: string,
  platform: RunnerPlatform,
  windows: boolean,
): Promise<void> {
  const { version } = TOOLS.githubRunner;
  const marker = join(dir, ".opscrew-version");
  if ((await readFile(marker, "utf8").catch(() => undefined))?.trim() === version) return;
  const asset = TOOLS.githubRunner.assets[platform];
  deps.reporter.step(`Downloading GitHub's runner ${version} for this computer (${platform})`);
  let bytes: Uint8Array;
  try {
    const response = await deps.fetch(asset.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Could not download GitHub's runner from ${asset.url} (${errorMessage(error)}).`,
      { hint: "Check the connection, then run the command again.", cause: error },
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== asset.sha256) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The download of GitHub's runner from ${asset.url} has SHA-256 ${actual}, not the pinned ${asset.sha256}, so OpsCrew did not use it.`,
      { hint: "Try again later; if it stays so, report it to OpsCrew." },
    );
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archive = `${dir}.${windows ? "zip" : "tar.gz"}`;
  await writeFile(archive, bytes);
  try {
    // Windows' own tar (bsdtar) unpacks the .zip; Git for Windows' tar on PATH could not.
    const tar = windows
      ? join(deps.env.SystemRoot ?? deps.env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
    const unpacked = await deps.runner.run(tar, [windows ? "-xf" : "-xzf", archive, "-C", dir]);
    if (unpacked.exitCode !== 0) {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `GitHub's runner could not be unpacked into ${dir} (${lastLine(deps, unpacked)}).`,
        { hint: "Check the free space and the folder's permissions, then run the command again." },
      );
    }
  } finally {
    await rm(archive, { force: true });
  }
  await writeFile(marker, `${version}\n`);
}

/**
 * The runner's `.env`, the environment of its jobs: this computer's stack folders, the local CA's
 * certificate and the local deploy lock (forward slashes, for the jobs' bash); on Windows also Git
 * for Windows' path conversion off, as for OpsCrew's own local deploys.
 */
export function localRunnerEnv(
  paths: Pick<PhaseDeps["paths"], "homeDir">,
  windows: boolean,
): string {
  const roots = localRoots(paths);
  return [
    `OPSCREW_APPS_DIR=${shellPath(roots.apps)}`,
    `OPSCREW_EDGE_DIR=${shellPath(roots.edge)}`,
    `OPSCREW_LOCAL_CA_FILE=${shellPath(caFiles(paths).certificate)}`,
    `OPSCREW_LOCAL_LOCK=${shellPath(lockFile(paths))}`,
    ...(windows ? ["MSYS_NO_PATHCONV=1", "MSYS2_ARG_CONV_EXCL=*"] : []),
    "",
  ].join("\n");
}

/**
 * The environment the runner and every job step it runs get: the user's, without anything
 * secret-shaped ({@link isSecretEnvName}, so no GitHub token), credential channels such as
 * `SSH_AUTH_SOCK`, provider and model credentials (`sanitizeAgentEnv`, then `ANTHROPIC_*` too);
 * PATH (Git for Windows' `bash` first when `bashDir` is given), the home folder and Docker's
 * settings stay.
 */
export function runnerEnvironment(
  env: Record<string, string | undefined>,
  bashDir?: string,
): Record<string, string> {
  const kept = Object.fromEntries(
    Object.entries(sanitizeAgentEnv(env)).filter(
      ([name]) => !isSecretEnvName(name) && !name.toUpperCase().startsWith("ANTHROPIC_"),
    ),
  );
  if (bashDir === undefined) return kept;
  const key = Object.keys(kept).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const rest = kept[key];
  return { ...kept, [key]: rest === undefined || rest === "" ? bashDir : `${bashDir};${rest}` };
}

/**
 * The runner's own script `base` (`config` or `run`) with `args`, run from its folder `dir`:
 * `<dir>/<base>.sh`, or on Windows `.\<base>.cmd` through cmd.exe. The `.\` keeps it found when
 * `NoDefaultCurrentDirectoryInExePath` is set (Claude Code and some security settings set it),
 * which stops cmd.exe from looking in the current folder for a bare name.
 */
export function runnerScript(
  windows: boolean,
  dir: string,
  base: "config" | "run",
  args: readonly string[],
): [string, string[]] {
  return windows
    ? ["cmd.exe", ["/d", "/c", `.\\${base}.cmd`, ...args]]
    : [join(dir, `${base}.sh`), [...args]];
}

/**
 * Starts the local runner of the localhost environment `environment` (contracts/runners.md
 * "Agents"): checks that its deploy job runs here and deploys an image GitHub Actions built, and
 * the repository (a public one needs every outside contributor's runs approved, set after its
 * `github-settings` approval); downloads and checks the pinned runner for this computer into
 * `<OpsCrew home>/runners/<app>-<env>` once; then, until stopped, registers a session `--ephemeral`
 * with the label `opscrew-<app>-<env>` and a fresh registration token (given only to the runner's
 * configuration, in its environment), runs it in the foreground, and removes its registration
 * through GitHub's API when it ends. A registration of the same name a crashed OpsCrew left is
 * deleted first, and a local deploy lock a killed job left is cleared before and after each
 * session. A stop lets the runner end its job (SIGINT, then SIGTERM, SIGKILL only after a
 * timeout). A failed session stops the runner with what to do.
 */
export async function startLocalRunner(
  deps: PhaseDeps,
  input: { environment: string; services?: LocalRunnerServices },
): Promise<LocalRunner> {
  const services = input.services ?? {};
  const paths = environmentPaths(deps.paths, input.environment);
  const plan = await readArtifact("plan", paths.files.plan);
  const command = `opscrew runner start --env ${input.environment}`;
  if (plan.target.provider !== "localhost" || plan.environment?.runner !== "local") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${input.environment} environment's deploy job does not run on this computer's runner (it needs the localhost target with environment.runner local), so OpsCrew started no runner.`,
      {
        hint: `Set environment.runner to local in the plan of an environment on this computer (\`opscrew env add <name> --target localhost --runner local\`), then run \`opscrew provision --env <name>\`.`,
      },
    );
  }
  await requireLocalRunnerImage(deps.paths.root, plan);
  const local = computer(deps, services.computer);
  const platform = runnerPlatform(local.platform, local.arch);
  if (platform === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub publishes no runner for this computer (${local.platform} ${local.arch}).`,
      {
        hint: "Use GitHub's machines for this environment's deploy job (environment.runner github).",
      },
    );
  }
  const windows = local.platform === "win32";
  // The job's `shell: bash` is Git for Windows' bash, first on the runner's PATH.
  const shell = windows ? await requireShell(local) : undefined;

  const repository = await runnerRepository(deps, services.github);
  const check = await checkRunnerRepository(repository);
  if (check.settings !== undefined && check.refusal !== undefined) {
    await applyRunnerSettings(
      deps,
      repository,
      { settings: check.settings, refusal: check.refusal },
      { command },
    );
  }

  const label = runnerLabel(plan);
  const dir = join(paths.homeDir, "runners", runnerSuffix(plan));
  await mkdir(dirname(dir), { recursive: true });
  await install(deps, dir, platform, windows);
  await writeFile(join(dir, ".env"), localRunnerEnv(paths, windows));
  const name = runnerName(local.computerName, plan);
  const env = runnerEnvironment(deps.env, shell === undefined ? undefined : dirname(shell));
  const script = (base: "config" | "run", args: readonly string[]) =>
    runnerScript(windows, dir, base, args);

  let stopping = false;
  let running: RunnerProcess | undefined;
  const removeRegistration = () =>
    deleteRegistrations(deps, repository, plan, { name }).catch((error) => {
      deps.reporter.warn(
        deps.redactor.redact(
          `OpsCrew could not remove the runner ${name} from GitHub (${errorMessage(error)}). Remove it under the repository's Settings → Actions → Runners.`,
        ),
      );
    });
  /** True when `proc` ends within `ms`. */
  const endsWithin = (proc: RunnerProcess, ms: number) =>
    Promise.race([proc.exited.then(() => true), local.sleep(ms).then(() => false)]);
  /** Lets the runner end its job: SIGINT, then SIGTERM, and SIGKILL only after a timeout. */
  const end = async (proc: RunnerProcess) => {
    proc.signal("SIGINT");
    if (await endsWithin(proc, STOP_GRACE_MS)) return;
    proc.signal("SIGTERM");
    if (await endsWithin(proc, KILL_AFTER_MS)) return;
    proc.signal("SIGKILL");
  };

  /** One session: registered, run until it took a job or was stopped, then removed. */
  const session = async (): Promise<"done" | "stopped"> => {
    // What a crashed OpsCrew or a killed job left: this name's registration, a dead deploy's lock.
    await deleteRegistrations(deps, repository, plan, { name });
    await clearStaleLock(paths);
    const token = await repository.api.runnerRegistrationToken(repository.owner, repository.repo);
    deps.redactor.addLiteral(token, "github-runner-registration-token");
    for (const file of [".runner", ".credentials", ".credentials_rsaparams"]) {
      await rm(join(dir, file), { force: true });
    }
    const [configure, configureArgs] = script("config", [
      "--unattended",
      "--url",
      repositoryUrl(repository),
      "--name",
      name,
      "--labels",
      label,
      "--work",
      "_work",
      "--ephemeral",
      "--replace",
    ]);
    // The token reaches the runner only in its environment, never on a command line.
    const configured = await deps.runner.run(configure, configureArgs, {
      cwd: dir,
      env: { ...env, ACTIONS_RUNNER_INPUT_TOKEN: token },
      timeoutMs: 300_000,
    });
    if (configured.exitCode !== 0) {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `GitHub's runner could not register with ${repository.owner}/${repository.repo} (${lastLine(deps, configured)}).`,
        {
          hint: `Check that the GitHub token has Administration (Read and write) on the repository, then run \`${command}\` again.`,
        },
      );
    }
    deps.reporter.success(
      `The runner ${name} is registered for ${label}; it runs the deploy job of the ${input.environment} environment on this computer. Stop it with Ctrl+C.`,
    );
    const [run, runArgs] = script("run", []);
    let code: number;
    try {
      const proc = (services.start ?? startProcess)(run, runArgs, {
        cwd: dir,
        env,
        onLine: (line) => deps.reporter.info(line),
      });
      running = proc;
      if (stopping) void end(proc);
      code = await proc.exited;
    } finally {
      running = undefined;
      await removeRegistration();
      await clearStaleLock(paths);
    }
    if (stopping) return "stopped";
    if (code !== 0) {
      throw new OpsCrewError("COMMAND_FAILED", `GitHub's runner stopped with exit code ${code}.`, {
        hint: `Run \`${command}\` again; its output above says what went wrong.`,
      });
    }
    return "done";
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (running !== undefined) void end(running);
  };
  const unsubscribe = (services.onSignal ?? processSignals)(stop);
  const finished = (async () => {
    try {
      while ((await session()) === "done" && !stopping) {
        deps.reporter.info("The runner ran its job; OpsCrew registers it again for the next one.");
      }
    } finally {
      unsubscribe();
    }
    deps.reporter.success(`The runner ${name} is stopped and removed from GitHub.`);
  })();
  return {
    finished,
    stop: async () => {
      stop();
      await finished.catch(() => undefined);
    },
  };
}
