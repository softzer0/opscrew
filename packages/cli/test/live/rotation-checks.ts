/**
 * What feature 025's live passes (`rotation*.test.ts`, docs/e2e.md "Credential rotation") need on
 * top of the harness that reaches servers, providers or GitHub:
 * - `opscrew rotate` as a script runs it, each plan approved by the hash a run printed;
 * - logins to a service's container with a value on the SSH session's standard input, so a value
 *   is never on a command line, here or on the server;
 * - the record of a rotation merged with its deploy, the deploy pause, the unfinished rotation;
 * - the leak search's part on a server: the rotation's log and the containers' logs;
 * - a rotation in a terminal (a pty, or by hand), a Tunnel's connections and a Worker version's
 *   secrets at Cloudflare, a CLI run stopped part way, and a real Better Auth in Docker here.
 * Nothing here prints a secret: everything logged goes through the run's scrubber, and values only
 * ever travel on standard input or in a process's environment.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { credentialsRecordFile, readServerAddresses } from "@opscrew/agents";
import type { CommandRunner } from "@opscrew/contracts";
import { appDir, DEPLOY_PAUSED_VARIABLE, IMAGES, ROTATE_LOG } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { expect } from "vitest";
import { underLoad } from "./builder-checks";
import {
  api,
  DEPLOY_WORKFLOW,
  HETZNER_API,
  httpRequest,
  minutes,
  RootShell,
  waitFor,
} from "./cloud";
import type { AppEnvironments } from "./environment-checks";
import { CLI, type CliRun, type LiveRun } from "./harness";
import {
  BETTER_AUTH_MARKERS,
  betterAuthScript,
  inContainerWithInput,
  type LoginAs,
  type LoginKind,
  loginAnswer,
  loginScript,
  type Prompt,
  promptKeys,
  ptyCommand,
  recordProblems,
  rotationHashes,
  TERMINAL_GATE,
  terminalLauncher,
  terminalPrompts,
  tunnelConnections,
  versionSecretNames,
  windowAcceptor,
} from "./rotation-support";
import { workerRunning } from "./site-checks";
import { deployRunProblem, leakedLabels } from "./support";
import { requireDocker } from "./tls-checks";

// ---------------------------------------------------------------------------------------------
// Logins to the servers, with a value on standard input.

/** A login to a server as `RootShell` takes it: root on a throwaway server, deploy on OpsCrew's. */
export type ServerLogin = ConstructorParameters<typeof RootShell>[1];

/** Root's login on the run's throwaway server with the test's own key. */
export function rootLogin(run: LiveRun): ServerLogin {
  return {
    host: run.ipv4(),
    keyFile: run.keyFile,
    knownHostsFile: run.knownHostsFile,
    env: run.env,
  };
}

/**
 * `deploy`'s login to `environment`'s server, with OpsCrew's deploy key (or `keyFile`) and known
 * hosts, as `AppEnvironments.shell` makes it.
 */
export async function deployLogin(
  run: LiveRun,
  envs: AppEnvironments,
  environment = "prod",
  keyFile?: string,
): Promise<ServerLogin> {
  const paths = envs.paths(environment);
  const host = (await readServerAddresses(paths)).deployment?.ipv4;
  if (host === undefined) throw new Error(`OpsCrew recorded no server for ${environment}.`);
  return {
    host,
    keyFile: keyFile ?? paths.files.deployKey,
    knownHostsFile: paths.files.knownHosts,
    env: run.env,
    user: "deploy",
  };
}

/**
 * `command` on the server through `login`, with `input` on its standard input (a value never on
 * a command line); its output, or throws with its stderr's end, which the step scrubs.
 */
export function onServer(
  run: LiveRun,
  login: ServerLogin,
  command: string,
  input?: string,
  timeoutMs = minutes(5),
): Promise<string> {
  const runner: CommandRunner =
    input === undefined
      ? run.runner
      : { run: (name, args, options) => run.runner.run(name, args, { ...options, input }) };
  return new RootShell(runner, login).ok(command, timeoutMs);
}

/** One login a check tries: the value, who logs in, and whether it must work. */
export interface LoginCheck {
  /** In the step's failure and log: never the value. */
  what: string;
  service: string;
  kind: LoginKind;
  value: string;
  works: boolean;
  as?: LoginAs;
}

/**
 * Each check's login in its service's container of the Compose project `project` on the server,
 * the value on standard input: one that must work is tried for up to 2 minutes (a service that
 * starts), one that must be refused once.
 */
export async function expectLogins(
  run: LiveRun,
  login: ServerLogin,
  project: string,
  checks: readonly LoginCheck[],
): Promise<void> {
  for (const check of checks) {
    const attempt = async () =>
      loginAnswer(
        await onServer(
          run,
          login,
          inContainerWithInput(project, check.service, loginScript(check.kind, check.as)),
          `${check.value}\n`,
        ),
      );
    const works = check.works
      ? await waitFor(
          `${check.what} working`,
          minutes(2),
          async () => ((await attempt()) ? true : undefined),
          10_000,
        ).catch(() => false)
      : await attempt();
    expect(works, `${check.what} ${check.works ? "works" : "is refused"}`).toBe(check.works);
  }
  run.log(
    `observed: ${checks.map((check) => `${check.what} ${check.works ? "works" : "is refused"}`).join("; ")}`,
  );
}

// ---------------------------------------------------------------------------------------------
// `opscrew rotate` as a script runs it.

/** A rotation's plan as a script sees it: the first run's output and the hashes it showed. */
export interface ShownRotation {
  output: string;
  hashes: string[];
}

/**
 * `opscrew rotate <args>` without `--approve`, as a script runs it first: it must stop at its
 * approval (exit 1) and show a hash.
 */
export async function shownRotation(run: LiveRun, args: readonly string[]): Promise<ShownRotation> {
  const shown = await run.opscrew("rotate", ...args);
  const hashes = rotationHashes(shown.output);
  if (shown.exitCode !== 1 || hashes.length === 0) {
    throw new Error(
      `opscrew rotate ${args.join(" ")} without --approve must stop at its approval (exit 1) and show its hash, but exited with ${shown.exitCode}:\n${run.tail(shown.output)}`,
    );
  }
  return { output: shown.output, hashes };
}

/**
 * `opscrew rotate <args>` with each of `hashes` (`--approve`), `--confirm <confirm>` when given and
 * `--yes` (the record's pull request), until it exits 0, approving each plan a later run stops at
 * (an infrastructure plan, a host plan, the removal's own plan) by the hash it printed, in at most
 * five runs.
 */
export async function approvedRotation(
  run: LiveRun,
  args: readonly string[],
  hashes: readonly string[],
  options: { confirm?: string } = {},
): Promise<CliRun> {
  const approved = [...hashes];
  const extra = [...(options.confirm === undefined ? [] : ["--confirm", options.confirm]), "--yes"];
  for (let round = 1; ; round++) {
    const done = await run.opscrew(
      "rotate",
      ...args,
      ...approved.flatMap((hash) => ["--approve", hash]),
      ...extra,
    );
    if (done.exitCode === 0) return done;
    const next = rotationHashes(done.output).filter((hash) => !approved.includes(hash));
    if (next.length === 0 || round >= 5) {
      throw new Error(
        `opscrew rotate ${args.join(" ")} --approve … exited with ${done.exitCode}:\n${run.tail(done.output)}`,
      );
    }
    run.log(`opscrew rotate ${args.join(" ")}: approving the next plan's hash it printed`);
    approved.push(...next);
  }
}

/** A rotation a script approved: what its first run showed, and the run that finished it. */
export interface ApprovedRotation {
  shown: string;
  done: CliRun;
}

/** {@link shownRotation}, then {@link approvedRotation} with the hashes it showed. */
export async function scriptedRotation(
  run: LiveRun,
  args: readonly string[],
  options: { confirm?: string } = {},
): Promise<ApprovedRotation> {
  const shown = await shownRotation(run, args);
  return { shown: shown.output, done: await approvedRotation(run, args, shown.hashes, options) };
}

/**
 * The exit code of a login through `login` with the key `keyFile` instead of its own: 0 when it
 * logs in, 255 when SSH refuses it (or fails), else the forced command's (a restricted key's).
 */
export async function loginExitCode(
  run: LiveRun,
  login: ServerLogin,
  keyFile: string,
): Promise<number> {
  return (await new RootShell(run.runner, { ...login, keyFile }).run("true", 60_000)).exitCode;
}

/** A copy of the private key `file` at `copy` (0600), as it is now: a rotation replaces it. */
export async function keepKeyCopy(file: string, copy: string): Promise<void> {
  await mkdir(dirname(copy), { recursive: true });
  await writeFile(copy, await readFile(file, "utf8"), { mode: 0o600 });
}

/** The public keys (`<type> <base64>`) of the SSH keys at Hetzner labelled for `app` by OpsCrew. */
export async function hetznerKeys(token: string, app: string): Promise<string[]> {
  const selector = encodeURIComponent(`managed-by=opscrew,app=${app}`);
  const listed = await api(HETZNER_API, token, "GET", `/ssh_keys?label_selector=${selector}`);
  if (listed.status !== 200)
    throw new Error(`Hetzner answered HTTP ${listed.status} for SSH keys.`);
  return ((listed.json as { ssh_keys?: { public_key: string }[] }).ssh_keys ?? []).map((key) =>
    key.public_key.trim().split(/\s+/).slice(0, 2).join(" "),
  );
}

/**
 * The app's worker ran a job queued through the app (`POST /jobs/<id>`, then `GET /jobs/<id>`
 * answers 200) within 90 seconds, on `site`.
 */
export async function expectJobRuns(run: LiveRun, site: string, id: string): Promise<void> {
  const queued = await httpRequest(`${site}/jobs/${id}`, { method: "POST" });
  expect(queued.status, `POST /jobs/${id}`).toBe(202);
  await waitFor(
    `the worker running the job ${id}`,
    90_000,
    async () => ((await httpRequest(`${site}/jobs/${id}`)).status === 200 ? true : undefined),
    3_000,
  );
  run.log(`observed: the worker ran the job ${id}`);
}

/**
 * `body`, a rotation's approved run, under 20 requests a second to each of `urls`: failures
 * within one window of `seconds` (what the plan or the listing states) are accepted and logged,
 * any other fails the step (SC-2501).
 */
export function underRotation<T>(
  run: LiveRun,
  urls: readonly string[],
  what: string,
  seconds: number,
  body: () => Promise<T>,
): Promise<T> {
  const accept = windowAcceptor(seconds);
  return underLoad(urls, what, run.log, body, async (failure) => accept(failure.at));
}

// ---------------------------------------------------------------------------------------------
// The values, the unfinished rotation, the record and the pause.

/** OpsCrew's generated values of an environment (`generated_values.json`), parsed. */
export async function generatedValuesOf(paths: { projectHomeDir: string }): Promise<unknown> {
  return JSON.parse(await readFile(join(paths.projectHomeDir, "generated_values.json"), "utf8"));
}

/**
 * Adds the old and new values of the environment's unfinished rotation (`pending_rotation.json`)
 * to the scrubber; whether there is one. Only the pairs' `old` and `new`: the file also holds the
 * rotation's plan hash, which approvals and hints name on purpose, and the services' names.
 */
export async function rememberPending(
  run: LiveRun,
  paths: { projectHomeDir: string },
): Promise<boolean> {
  const file = join(paths.projectHomeDir, "pending_rotation.json");
  if (!existsSync(file)) return false;
  for (const value of pairValues(JSON.parse(await readFile(file, "utf8")))) {
    run.scrubber.add(value, "pending-rotation-value");
  }
  return true;
}

/** Every string under an `old` or a `new` key, at any depth. */
function pairValues(json: unknown): string[] {
  if (Array.isArray(json)) return json.flatMap(pairValues);
  if (json === null || typeof json !== "object") return [];
  return Object.entries(json).flatMap(([key, value]) =>
    (key === "old" || key === "new") && typeof value === "string" ? [value] : pairValues(value),
  );
}

/**
 * Merges the deploy pull request a rotation opened (its record and the recovery copy, files the
 * deploy workflows leave out, so the merge starts no deploy); then `opscrew/credentials.yaml` on
 * `main` must show each credential of `expected` at its generation, rotated since `since`.
 */
export async function mergeRecord(
  run: LiveRun,
  paths: Parameters<typeof credentialsRecordFile>[0],
  environment: string,
  expected: Readonly<Record<string, number>>,
  since: Date,
): Promise<void> {
  const merged = await run.mergeDeploySetup(`the record of the rotation in ${environment}`);
  if (merged === undefined) throw new Error("The rotation opened no pull request with its record.");
  const record = await readArtifact("credentials", credentialsRecordFile(paths));
  expect(recordProblems(record, environment, expected, since), "the record on main").toEqual([]);
  run.log(`observed: the record on main shows ${Object.keys(expected).join(", ")} rotated`);
}

/**
 * The next deploy, as a user starts one: `workflow` dispatched on `main`, which must deploy.
 * Returns its run's id.
 */
export async function deployAgain(
  run: LiveRun,
  what: string,
  workflow = DEPLOY_WORKFLOW,
): Promise<number> {
  await run.checkoutMain();
  const since = new Date();
  run.log(`dispatching ${workflow} on main (${what})`);
  await run.github.dispatchDeploy(workflow);
  const done = await run.github.waitForDeploy({
    headSha: await run.git("rev-parse", "HEAD"),
    event: "workflow_dispatch",
    since,
    workflow,
  });
  const problem = deployRunProblem(done);
  if (problem !== undefined) throw new Error(`The deploy run ${done.id} (${what}): ${problem}.`);
  run.log(`deploy run ${done.id} (${what}) succeeded`);
  return done.id;
}

/** Whether the app's deploys are paused in GitHub (`OPSCREW_DEPLOY_PAUSED` is set). */
export async function deploysPaused(run: LiveRun): Promise<boolean> {
  return (await run.github.variable(DEPLOY_PAUSED_VARIABLE)) !== undefined;
}

// ---------------------------------------------------------------------------------------------
// The leak search on a server.

/**
 * The leak search's part on a server through `login` (`where` names it): with `plan`, the
 * rotation's own log in its app's folder (`ROTATE_LOG`, on a server OpsCrew's script runs on),
 * and the last 5,000 lines of every container's log of each Compose project of `projects`,
 * searched for the run's secrets, the old and new values among them: the problems, by label only.
 */
export async function serverLogLeaks(
  run: LiveRun,
  login: ServerLogin,
  where: string,
  options: { plan?: DeployPlan; projects: readonly string[] },
): Promise<string[]> {
  const secrets = run.scrubber.entries().filter(({ label }) => !label.startsWith("server-"));
  const sources: [string, string][] = [];
  if (options.plan !== undefined) {
    const log = `${appDir(options.plan)}/${ROTATE_LOG}`;
    sources.push([`${log} on ${where}`, `if [ -f ${log} ]; then cat ${log}; fi`]);
  }
  for (const project of options.projects) {
    sources.push([
      `the logs of ${project}'s containers on ${where}`,
      `for c in $(docker ps -aq --filter label=com.docker.compose.project=${project}); do docker logs --tail 5000 "$c" 2>&1; done`,
    ]);
  }
  const problems: string[] = [];
  for (const [what, command] of sources) {
    const text = await onServer(run, login, command, undefined, minutes(5)).catch(
      (error: Error) => {
        problems.push(`${what} is unreadable: ${run.scrub(error.message).slice(0, 300)}`);
        return "";
      },
    );
    const found = leakedLabels(text, secrets);
    if (found.length > 0) problems.push(`${what} contains: ${found.join(", ")}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// A rotation in a terminal.

/**
 * How a rotation in a terminal runs on this computer: in a pty (`script`, outside Windows), by
 * hand (`OPSCREW_E2E_ROTATION_TERMINAL=1`), or not at all.
 */
export function terminalMode(): "pty" | "hand" | undefined {
  if (
    process.platform !== "win32" &&
    spawnSync("sh", ["-c", "command -v script"], { stdio: "ignore" }).status === 0
  ) {
    return "pty";
  }
  return process.env[TERMINAL_GATE] === "1" ? "hand" : undefined;
}

/** A run of the CLI in a terminal: its exit code, and how many prompts it answered in a pty. */
export interface TerminalRun {
  exitCode: number;
  prompts: number;
}

/**
 * `opscrew <args>` in a terminal, kept for the leak search (a run by hand keeps no output): in a
 * pty (`mode` `pty`, `script`), each approval answered once its prompt is drawn, after
 * `beforeAnswer` with the prompt's number; by hand (`hand`), from a launcher the run writes in its
 * own folder (it holds the run's settings, and goes with the folder), waited for 30 minutes.
 */
export async function inTerminal(
  run: LiveRun,
  args: readonly string[],
  mode: "pty" | "hand",
  beforeAnswer: (index: number) => Promise<void> = async () => undefined,
): Promise<TerminalRun> {
  const argv = [process.execPath, CLI, ...args];
  const label = run.scrub(`#${run.outputs.size + 1} opscrew ${args.join(" ")} (in a terminal)`);
  if (mode === "hand") {
    const slash = (path: string) => path.replaceAll("\\", "/");
    const launcher = slash(join(run.work, "rotate-in-a-terminal.sh"));
    const exitFile = slash(join(run.work, "rotate-in-a-terminal.exit"));
    await rm(exitFile, { force: true });
    const set: Record<string, string> = {};
    for (const [name, value] of Object.entries(run.env)) {
      if (value !== undefined && name !== "CI" && process.env[name] !== value) set[name] = value;
    }
    const unset = Object.keys(process.env).filter(
      (name) => run.env[name] === undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    );
    await writeFile(
      launcher,
      terminalLauncher(slash(run.repo), { set, unset }, argv.map(slash), exitFile),
      { mode: 0o700 },
    );
    run.log(`run this in a terminal and answer its prompts (up to 30 minutes): sh ${launcher}`);
    const exitCode = await waitFor(
      "the rotation run by hand in a terminal",
      minutes(30),
      async () =>
        existsSync(exitFile) ? Number((await readFile(exitFile, "utf8")).trim()) : undefined,
      5_000,
    );
    run.outputs.set(label, "");
    return { exitCode, prompts: 0 };
  }
  const env: Record<string, string> = { TERM: "xterm-256color" };
  for (const [name, value] of Object.entries(run.env)) {
    if (value !== undefined && name !== "CI") env[name] = value;
  }
  const { command, args: scriptArgs } = ptyCommand(process.platform, argv);
  return new Promise((resolve, reject) => {
    const child = spawn(command, scriptArgs, {
      cwd: run.repo,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let answered = 0;
    let answering = Promise.resolve();
    let failure: unknown;
    let closed = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), minutes(30));
    // A key sent as the CLI ends finds its input closed: nothing is left to answer then.
    child.stdin?.on("error", () => undefined);
    const onData = (chunk: string) => {
      output += chunk;
      const prompts = terminalPrompts(output);
      while (answered < prompts.length) {
        const index = answered++;
        const prompt = prompts[index] as Prompt;
        answering = answering.then(async () => {
          await beforeAnswer(index).catch((error: unknown) => {
            failure ??= error;
          });
          if (!closed) child.stdin?.write(promptKeys(prompt));
        });
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`The pty (${command}) did not start: ${error.message}`));
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timer);
      void answering.then(() => {
        run.outputs.set(label, output);
        child.stdin?.end();
        if (failure !== undefined) reject(failure);
        else resolve({ exitCode: code ?? 1, prompts: answered });
      });
    });
  });
}

/**
 * Waits up to `timeoutMs` until an audit entry of the environment at `paths` names `action`
 * (`change the Cloudflare Tunnel's secret`), written since `since`.
 */
export function waitForAudit(
  paths: { auditDir: string },
  action: string,
  since: Date,
  timeoutMs = minutes(30),
): Promise<true> {
  return waitFor(
    `an audit entry "${action}"`,
    timeoutMs,
    async () => {
      if (!existsSync(paths.auditDir)) return undefined;
      for (const file of await readdir(paths.auditDir)) {
        for (const line of (await readFile(join(paths.auditDir, file), "utf8")).split("\n")) {
          if (!line.includes(action)) continue;
          const at = /"at":"([^"]+)"/.exec(line)?.[1];
          if (at === undefined || Date.parse(at) >= since.getTime() - 5_000) return true;
        }
      }
      return undefined;
    },
    2_000,
  );
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: a tunnel's connections, the secrets of the version a Worker serves.

/** The id of the account's Cloudflare Tunnel `name` (`opscrew-<app>`); throws without one. */
export async function tunnelIdOf(run: LiveRun, name: string): Promise<string> {
  const account = run.zone?.accountId;
  if (account === undefined) throw new Error("The run has no Cloudflare zone.");
  const found = await run.cloudflare.list<{ id: string; name: string }>(
    `/accounts/${account}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
  );
  const tunnel = found.find((item) => item.name === name);
  if (tunnel === undefined) throw new Error(`Cloudflare has no tunnel ${name}.`);
  return tunnel.id;
}

/** The tunnel's connectors and their connections to Cloudflare now, by id. */
export async function connectionsOf(
  run: LiveRun,
  tunnelId: string,
): Promise<ReturnType<typeof tunnelConnections>> {
  const account = run.zone?.accountId;
  if (account === undefined) throw new Error("The run has no Cloudflare zone.");
  const got = await run.cloudflare.call(
    "GET",
    `/accounts/${account}/cfd_tunnel/${tunnelId}/connections`,
  );
  if (got.status !== 200) {
    throw new Error(`Cloudflare did not list the tunnel's connections (HTTP ${got.status}).`);
  }
  return tunnelConnections(got.json);
}

/** The names of the secrets of the version the Worker `worker` serves now. */
export async function servingSecrets(run: LiveRun, worker: string): Promise<string[]> {
  const account = run.zone?.accountId;
  if (account === undefined) throw new Error("The run has no Cloudflare zone.");
  const { version } = await workerRunning(run, worker);
  const got = await run.cloudflare.call(
    "GET",
    `/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/versions/${encodeURIComponent(version)}`,
  );
  if (got.status !== 200) {
    throw new Error(
      `Cloudflare did not show the version ${version} of ${worker} (HTTP ${got.status}).`,
    );
  }
  return versionSecretNames(got.json);
}

// ---------------------------------------------------------------------------------------------
// A CLI run stopped part way.

/**
 * `opscrew <args>`, stopped once its output shows `text` (its own process group too, so its ssh
 * stops with it): the output, kept for the leak search. Throws when it ends before.
 */
export function runUntil(
  run: LiveRun,
  args: readonly string[],
  text: string,
  timeoutMs = minutes(20),
): Promise<string> {
  const label = run.scrub(`#${run.outputs.size + 1} opscrew ${args.join(" ")} (stopped)`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: run.repo,
      env: run.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (process.platform === "win32" || child.pid === undefined) {
        child.kill();
        return;
      }
      try {
        process.kill(-child.pid);
      } catch {
        // The group ended on its own meanwhile.
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    const onData = (chunk: string) => {
      output += chunk;
      if (!stopped && output.includes(text)) stop();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", onData);
    child.once("close", (code) => {
      clearTimeout(timer);
      run.outputs.set(label, output);
      if (output.includes(text)) resolve(output);
      else {
        reject(
          new Error(
            `opscrew ${args.join(" ")} ended (exit ${code}) before it said "${text}":\n${run.tail(output)}`,
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Better Auth with both of its variables, in Docker on this computer.

/**
 * The T2509 check of a real Better Auth (the latest on npm, in OpsCrew's pinned Node image): a
 * user signed up under `BETTER_AUTH_SECRET` alone, then a start with `BETTER_AUTH_SECRET` the new
 * value and `BETTER_AUTH_SECRETS` both, as a rotation leaves them. Returns what the script printed
 * (its markers and Better Auth's version only); the values are made here and stay in Docker's
 * environment.
 */
export async function betterAuthCheck(run: LiveRun): Promise<string> {
  await requireDocker(
    "The Better Auth check runs a real Better Auth in OpsCrew's Node image in Docker on this computer",
  );
  const work = join(run.work, "better-auth");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "check.mjs"), betterAuthScript());
  const old = randomBytes(32).toString("base64url");
  const fresh = randomBytes(32).toString("base64url");
  const password = randomBytes(18).toString("base64url");
  for (const [value, label] of [
    [old, "better-auth-old-secret"],
    [fresh, "better-auth-new-secret"],
    [password, "better-auth-user-password"],
  ] as const) {
    run.scrubber.add(value, label);
  }
  const phase = async (name: "old" | "both", values: Record<string, string>) => {
    const result = await run.runner.run(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${work}:/work`,
        "-w",
        "/work",
        ...Object.keys(values).flatMap((variable) => ["-e", variable]),
        IMAGES.nodeAlpine.ref,
        "sh",
        "-c",
        `[ -d node_modules/better-auth ] || npm install --silent --no-audit --no-fund better-auth@latest > /dev/null 2>&1; sed -n 's/^ *"version": *"\\([^"]*\\)".*/better-auth \\1/p' node_modules/better-auth/package.json | head -n 1; node check.mjs ${name}`,
      ],
      { env: { ...run.env, ...values }, timeoutMs: minutes(10) },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `The Better Auth check (${name}) failed (exit ${result.exitCode}): ${run.tail(`${result.stdout}\n${result.stderr}`, 20)}`,
      );
    }
    return run.scrub(result.stdout);
  };
  await phase("old", { BETTER_AUTH_SECRET: old, E2E_USER_PASSWORD: password });
  const said = await phase("both", {
    BETTER_AUTH_SECRET: fresh,
    BETTER_AUTH_SECRETS: `2:${fresh},1:${old}`,
    E2E_USER_PASSWORD: password,
  });
  for (const marker of Object.values(BETTER_AUTH_MARKERS)) {
    expect(
      said.includes(marker),
      `Better Auth with both variables says "${marker}":\n${said}`,
    ).toBe(true);
  }
  return said;
}
