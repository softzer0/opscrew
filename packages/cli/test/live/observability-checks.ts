/**
 * Feature 017's live checks (docs/e2e.md "Observability"):
 * - {@link logsAndFigures}, the step every target's pass takes: `logs` within 10 seconds, a
 *   request's line in `logs --follow` within 10 seconds of the request (SC-1701), Ctrl+C ending
 *   it, and `status`' figures;
 * - {@link observabilityPass}, the Hetzner pass of `live.test.ts` with `OPSCREW_E2E_OBSERVABILITY`
 *   and `OPSCREW_E2E_ADDONS`: the scheduled check run by dispatch (SC-1702, SC-1703, SC-1705) with
 *   its ntfy posts, Beszel through the tunnel and Grafana Cloud (SC-1706, SC-1707), destroy's pause,
 *   and the leak search with a seeded secret (SC-1704);
 * - {@link retargetPause}, the check during a move's pause (FR-1709).
 * Nothing here prints a secret, an issue's text or a log line: only labels, counts and timings.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BESZEL_EMAIL, BESZEL_LOCAL_URL, readServerAddresses } from "@opscrew/agents";
import { ADDON_PROJECTS, addonDir, appDirs } from "@opscrew/connector-ssh-host";
import { resolveProjectPaths } from "@opscrew/core";
import {
  appDir,
  CHECK_PAUSED_VARIABLE,
  CHECK_WORKFLOW_FILE,
  checkEnvironmentKey,
} from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import {
  type CheckIssue,
  canConnect,
  type GitHubRepo,
  httpRequest,
  minutes,
  sleep,
  waitFor,
} from "./cloud";
import type { DeployedRun } from "./component-checks";
import { CLI, type LeakSource, type LiveRun, leakSourcesOf, readGeneratedValues } from "./harness";
import {
  addonLeftoverCommand,
  addonLeftovers,
  billedMinutes,
  type FiguresKind,
  figureProblems,
  fillBytes,
  type GrafanaCloudSettings,
  issueKey,
  logLines,
  lokiQueryUrl,
  lokiStreams,
  memoryUsage,
  monthlyRuns,
  type NtfyMessage,
  ntfyMessages,
  ntfyPollUrl,
  OBSERVABILITY_APP,
  type ObservabilitySettings,
  prometheusQueryUrl,
  promVector,
  requestLogFiles,
  requestPath,
  resolvedAfter,
  SEEDED_VARIABLE,
  statusFigures,
} from "./observability-support";
import { McpSession } from "./portainer-cloud";
import { approveHashes, leakedLabels, Scrubber } from "./support";

/** SC-1701: the latest lines, and a request's line when following, within 10 seconds. */
const SC_1701_MS = 10_000;
/** SC-1707: the app's lines and the server's figures in Grafana Cloud within 5 minutes. */
const SC_1707_MS = minutes(5);
/** SC-1707: the series stay under a tenth of the free tier's 10,000. */
const SERIES_LIMIT = 1_000;
/** SC-1705: the check's minutes a month in a private repository. */
const MONTHLY_MINUTES = 750;
/** How full the test fills the disk: past the check's 85%, below its 95%. */
const FILL_PERCENT = 87;
/** The server's series Grafana Cloud must show: CPU, memory and disk. */
const SERVER_SERIES = [
  "node_cpu_seconds_total",
  "node_memory_MemAvailable_bytes",
  "node_filesystem_avail_bytes",
];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** What the observability checks need from a live run: its CLI, its log and its findings. */
export interface CliTarget {
  repo: string;
  env: Record<string, string | undefined>;
  opscrew: (...args: string[]) => Promise<{ exitCode: number; output: string }>;
  log: (message: string) => void;
  /** Masks the secrets the run knows in text the test prints. */
  scrub: (text: string) => string;
  /** Problems that do not stop the run but fail it at the end. */
  findings: string[];
  /** Keeps an output for the leak search (never printed). */
  keep: (label: string, output: string) => void;
}

/** A {@link LiveRun} as a {@link CliTarget}; make it once the run's repository is prepared. */
export function liveRunTarget(run: LiveRun): CliTarget {
  return {
    repo: run.repo,
    env: run.env,
    opscrew: (...args) => run.opscrew(...args),
    log: run.log,
    scrub: run.scrub,
    findings: run.findings,
    keep: (label, output) =>
      run.outputs.set(run.scrub(`#${run.outputs.size + 1} ${label}`), output),
  };
}

function tail(target: Pick<CliTarget, "scrub">, text: string, lines = 40): string {
  return target.scrub(text).trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

/** `opscrew <args>`, throwing with the output's (scrubbed) tail unless it exits 0. */
async function cliOk(target: CliTarget, ...args: string[]): Promise<string> {
  const result = await target.opscrew(...args);
  if (result.exitCode !== 0) {
    throw new Error(
      `opscrew ${args.join(" ")} exited with ${result.exitCode}:\n${tail(target, result.output)}`,
    );
  }
  return result.output;
}

/**
 * A long-running CLI command (`logs --follow`, `addon open beszel`), run as the user runs it and
 * stopped with Ctrl+C. Its output is kept for the leak search, never printed.
 */
class RunningCli {
  stdout = "";
  stderr = "";
  /** How it ended, once it has. */
  ended: { code: number | null; signal: string | null } | undefined;
  private readonly child: ChildProcess;
  private readonly waits: { text: string; resolve: (at: number) => void }[] = [];

  constructor(
    private readonly target: CliTarget,
    readonly args: readonly string[],
  ) {
    this.child = spawn(process.execPath, [CLI, ...args], {
      cwd: target.repo,
      env: target.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.stdout += chunk;
      const at = Date.now();
      for (const wait of this.waits.filter((item) => this.stdout.includes(item.text))) {
        this.waits.splice(this.waits.indexOf(wait), 1);
        wait.resolve(at);
      }
    });
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.once("exit", (code, signal) => {
      this.ended = { code, signal };
    });
  }

  /** Why it ended, while a wait for it would never finish. */
  readonly endedEarly = (): string | undefined =>
    this.ended === undefined
      ? undefined
      : `opscrew ${this.args.join(" ")} ended by itself (exit ${this.ended.code ?? this.ended.signal}):\n${tail(this.target, this.stderr)}`;

  /** When `text` showed on standard output, waiting up to `timeoutMs`; `undefined` if it did not. */
  appeared(text: string, timeoutMs: number): Promise<number | undefined> {
    if (this.stdout.includes(text)) return Promise.resolve(Date.now());
    return new Promise((resolve) => {
      const wait = { text, resolve };
      this.waits.push(wait);
      setTimeout(() => {
        const at = this.waits.indexOf(wait);
        if (at >= 0) {
          this.waits.splice(at, 1);
          resolve(undefined);
        }
      }, timeoutMs);
    });
  }

  /**
   * Ctrl+C (SIGINT), as the user stops it: it must end within 30 seconds with exit code 0 and no
   * error message. Windows has no way to send Ctrl+C to another process, so there it is killed
   * and the check is left to the person running the test (docs/e2e.md).
   */
  async stop(): Promise<void> {
    const what = `opscrew ${this.args.join(" ")}`;
    try {
      await this.interrupt(what);
    } finally {
      this.target.keep(what, `${this.stdout}\n${this.stderr}`);
    }
  }

  private async interrupt(what: string): Promise<void> {
    const early = this.endedEarly();
    if (early !== undefined) throw new Error(early);
    if (process.platform === "win32") {
      this.child.kill();
      this.target.log(`not checked on Windows: Ctrl+C on ${what} (check it by hand, docs/e2e.md)`);
      return;
    }
    const before = this.stderr.length;
    this.child.kill("SIGINT");
    const ended = await waitFor(
      `${what} ending on Ctrl+C`,
      30_000,
      async () => this.ended,
      250,
    ).catch(() => undefined);
    if (ended === undefined) {
      this.child.kill("SIGKILL");
      throw new Error(`${what} did not end within 30 s of Ctrl+C.`);
    }
    const said = this.stderr.slice(before);
    if (ended.code !== 0 || /error|failed|✗/i.test(said)) {
      throw new Error(
        `${what} ended with exit ${ended.code ?? ended.signal} on Ctrl+C${said.trim() === "" ? "" : `, saying:\n${tail(this.target, said)}`}`,
      );
    }
    this.target.log(`Ctrl+C ended ${what} with exit code 0 and no error message`);
  }
}

/**
 * The logs and figures step of every target (SC-1701, US2), with `args` (`--env dev`) on each
 * command: `opscrew logs` shows lines within 10 seconds; with `request` (which sends one request
 * to a path of the app, any answer), `logs --follow` shows the request's line within 10 seconds of
 * it and ends on Ctrl+C; `opscrew status` shows the figures of `figures`' target. A time over 10
 * seconds is a finding; no lines, no request line after three requests, or a missing figure stops
 * the step. Returns `status`' output.
 */
export async function logsAndFigures(
  target: CliTarget,
  options: {
    args?: readonly string[];
    request?: (path: string) => Promise<unknown>;
    figures: FiguresKind;
  },
): Promise<string> {
  const args = [...(options.args ?? [])];
  const command = ["opscrew logs", ...args].join(" ");
  const started = Date.now();
  const logs = await cliOk(target, "logs", ...args);
  const took = Date.now() - started;
  const count = logLines(logs).length;
  target.log(`${command} showed ${count} lines in ${seconds(took)} (SC-1701: within 10 s)`);
  if (count === 0) throw new Error(`${command} showed no line:\n${tail(target, logs)}`);
  if (took > SC_1701_MS) {
    target.findings.push(`${command} took ${seconds(took)}, not within 10 s (SC-1701)`);
  }
  if (options.request === undefined) {
    target.log(
      "not checked: a request's line in logs --follow (the app has no request log; docs/e2e.md)",
    );
  } else {
    await followRequest(target, args, options.request);
  }
  const status = await cliOk(target, "status", ...args);
  const figures = statusFigures(status);
  const problems = figureProblems(figures, options.figures);
  if (problems.length > 0) {
    throw new Error(`opscrew status: ${problems.join("; ")}:\n${tail(target, status)}`);
  }
  target.log(
    `status shows the figures: ${figures?.server === undefined ? "" : "the server's line, "}${figures?.worker === undefined ? "" : "the Worker's line, "}${figures?.parts.length ?? 0} parts, ${figures?.notAvailable.length ?? 0} named as not available, ${figures?.flags.length ?? 0} flagged`,
  );
  return status;
}

/**
 * `opscrew logs --follow` and a request to a path of its own: its line within 10 seconds of the
 * request (SC-1701; slower, or missed, is a finding), at most three requests 30 seconds apart,
 * then Ctrl+C ends it.
 */
async function followRequest(
  target: CliTarget,
  args: readonly string[],
  request: (path: string) => Promise<unknown>,
): Promise<void> {
  const follow = new RunningCli(target, ["logs", "--follow", ...args]);
  let done = false;
  try {
    await waitFor(
      "the first line of opscrew logs --follow",
      minutes(2),
      async () => (follow.stdout.includes("\n") ? true : undefined),
      500,
      follow.endedEarly,
    );
    // The follow starts once the latest lines are shown.
    await sleep(2_000);
    for (let attempt = 1; ; attempt++) {
      const path = requestPath("follow");
      const sent = Date.now();
      await request(path).catch(() => undefined);
      const seen = await follow.appeared(path, 30_000);
      if (seen !== undefined) {
        const took = seen - sent;
        target.log(`logs --follow showed the request's line ${seconds(took)} after the request`);
        if (took > SC_1701_MS) {
          target.findings.push(
            `logs --follow showed a request's line ${seconds(took)} after it, not within 10 s (SC-1701)`,
          );
        }
        break;
      }
      const early = follow.endedEarly();
      if (early !== undefined) throw new Error(early);
      target.findings.push(
        `logs --follow did not show the line of request ${attempt} within 30 s (SC-1701)`,
      );
      if (attempt === 3) {
        throw new Error("logs --follow showed none of three requests' lines within 30 s each.");
      }
    }
    done = true;
  } finally {
    await follow.stop().catch((error: unknown) => {
      if (done) throw error;
      target.log(`after the failure, stopping logs --follow: ${String(error)}`);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The scheduled check.

/** The check's `opscrew/check/check.json`, as far as the test reads it. */
interface CheckConfig {
  intervalMinutes: number;
  public: boolean;
  webhook?: string;
  environments: { key: string; hosts: { hostname: string }[]; server?: { id: string } }[];
}

/**
 * Runs the check's workflow on `main` by dispatch, as a user can (`gh workflow run
 * opscrew-check.yml`), and waits for it to succeed: it exits 0 whenever it could report. Returns
 * the run's id.
 */
export async function dispatchCheck(
  github: GitHubRepo,
  git: (...args: string[]) => Promise<string>,
  what: string,
  log: (message: string) => void,
): Promise<number> {
  await git("fetch", "-q", "origin");
  const head = await git("rev-parse", "origin/main");
  const since = new Date();
  await github.dispatchDeploy(CHECK_WORKFLOW_FILE);
  const run = await github.waitForDeploy(
    { headSha: head, event: "workflow_dispatch", since, workflow: CHECK_WORKFLOW_FILE },
    minutes(15),
  );
  if (run.conclusion !== "success") {
    throw new Error(`The check's run ${run.id} (${what}) ended ${run.conclusion}.`);
  }
  log(`the check's run ${run.id} (${what}) succeeded`);
  return run.id;
}

/** The check's issues of environment `key` opened since `since`. */
async function issuesOf(github: GitHubRepo, since: Date, key: string): Promise<CheckIssue[]> {
  return (await github.checkIssues(since)).filter((issue) =>
    issueKey(issue.body)?.startsWith(`${key}/`),
  );
}

/** Stops the app's Compose project on the server at `host` (as deploy), as a crash would. */
function stopApp(run: DeployedRun, host: string, plan: DeployPlan): Promise<string> {
  return run.ssh(host, `cd ${appDir(plan)} && docker compose stop`);
}

function startApp(run: DeployedRun, host: string, plan: DeployPlan): Promise<string> {
  return run.ssh(host, `cd ${appDir(plan)} && docker compose start`);
}

/** Waits until `url` answers below 400 (`up`) or does not (a status of 400 or more, or no answer). */
async function waitForHealth(url: string, up: boolean): Promise<void> {
  await waitFor(
    `${url} ${up ? "answering" : "failing"}`,
    minutes(5),
    async () => {
      const status = await httpRequest(url).then(
        (answer) => answer.status,
        () => 0,
      );
      return (status > 0 && status < 400) === up ? true : undefined;
    },
    5_000,
  );
}

/**
 * The check during a move (FR-1709): retarget's window put the environment in
 * `OPSCREW_CHECK_PAUSED`, where it stays until `--finish`, so a run of the check with the app
 * stopped on the new server at `host` opens no issue for it. The app is started again after.
 */
export async function retargetPause(run: DeployedRun, host: string, health: URL): Promise<void> {
  const log = (message: string) => console.log(`OpsCrew E2E (retarget's pause): ${message}`);
  const plan = await readArtifact("plan", join(run.repo, "opscrew/plan.yaml"));
  const key = checkEnvironmentKey(plan);
  const paused = JSON.parse((await run.github.variable(CHECK_PAUSED_VARIABLE)) ?? "{}") as Record<
    string,
    { reason?: string }
  >;
  if (paused[key]?.reason !== "retarget") {
    throw new Error(`${CHECK_PAUSED_VARIABLE} does not pause ${key} for the move.`);
  }
  await stopApp(run, host, plan);
  try {
    await waitForHealth(health.toString(), false);
    await dispatchCheck(run.github, run.git, "the app stopped during the move", log);
    const open = (await issuesOf(run.github, run.startedAt, key)).filter((issue) => issue.open);
    if (open.length > 0) {
      throw new Error(
        `The check opened ${open.length} issue(s) for ${key} while the move paused it.`,
      );
    }
    log(`no issue for ${key} while the move pauses it, with the app stopped`);
  } finally {
    await startApp(run, host, plan);
  }
  await waitForHealth(health.toString(), true);
}

// ---------------------------------------------------------------------------------------------
// The Hetzner pass.

/** What `live.test.ts` runs the observability pass with (its `DeployOptions`). */
export interface ObservabilityPass {
  /** Production values the app gets (the seeded secret), added to `OPSCREW_E2E_APP_ENV`'s. */
  appEnv: Record<string, string>;
  /** Files written into the app before its first commit (the request log). */
  files: Record<string, string>;
  /** Variables of every CLI run: the webhook's address, Grafana Cloud's write token. */
  env: Record<string, string>;
  /** The webhook in `opscrew/plan.yaml`, as a user sets it after design. */
  planEdit?: (plan: DeployPlan) => DeployPlan;
  afterDeploy: (run: DeployedRun) => Promise<void>;
  /** After the teardown: destroy's pause, and the check's issues the run left open. */
  afterTeardown: (destroyed: boolean) => Promise<string[]>;
}

/** What one pass learned for its teardown. */
interface PassState {
  startedAt?: Date;
  key?: string;
  /** The disk issue left open for destroy's pause to close. */
  diskIssue?: number;
  git?: (...args: string[]) => Promise<string>;
}

/**
 * The observability and add-on pass on a Hetzner server (docs/e2e.md "Observability"), with
 * `tokens` (the run's tokens, by their variables) among the leak search's values. The app is the
 * default example with its request log and a seeded secret (`SEEDED_SECRET`), printed only on the
 * test's own `-seeded-` requests, after Grafana Cloud's masking file is in place.
 */
export function observabilityPass(
  settings: ObservabilitySettings,
  github: GitHubRepo,
  tokens: readonly { label: string; value: string | undefined }[],
): ObservabilityPass {
  const seeded = `e2e-seeded-${randomBytes(16).toString("hex")}`;
  const ntfyUrl = `https://ntfy.sh/${settings.ntfyTopic}`;
  const state: PassState = {};
  const scrubber = new Scrubber();
  for (const { label, value } of tokens) scrubber.add(value, label);
  scrubber.add(seeded, "seeded-secret");
  scrubber.add(settings.ntfyTopic, "ntfy-topic");
  scrubber.add(settings.grafana?.token, "grafana-cloud-token");
  scrubber.add(settings.grafana?.readToken, "grafana-cloud-read-token");
  return {
    appEnv: { [SEEDED_VARIABLE]: seeded },
    files: requestLogFiles(OBSERVABILITY_APP, true) ?? {},
    env: {
      ...(settings.check ? { OPSCREW_CHECK_WEBHOOK: ntfyUrl } : {}),
      ...(settings.grafana === undefined
        ? {}
        : { OPSCREW_GRAFANA_CLOUD_TOKEN: settings.grafana.token }),
    },
    ...(settings.check
      ? {
          planEdit: (plan: DeployPlan): DeployPlan => ({
            ...plan,
            observability: {
              ...plan.observability,
              check: { ...plan.observability?.check, webhook: "ntfy" },
            },
          }),
        }
      : {}),
    afterDeploy: (run) => afterDeploy(run, settings, scrubber, state),
    afterTeardown: (destroyed) => afterTeardown(github, state, destroyed),
  };
}

/** One pass's run after its first deploy, with what the leak search reads. */
interface PassRun {
  run: DeployedRun;
  target: CliTarget;
  plan: DeployPlan;
  ipv4: string;
  /** Where the app answers: `https://<domain>`, or the server's address without a domain. */
  base: string;
  log: (message: string) => void;
  /** Masks what the test prints; its values are the leak search's. */
  scrubber: Scrubber;
  /** Terminal outputs besides the run's CLI outputs (follows, the tunnel). */
  outputs: string[];
  /** Texts to search besides the outputs, by where they are. */
  sources: LeakSource[];
}

async function afterDeploy(
  run: DeployedRun,
  settings: ObservabilitySettings,
  scrubber: Scrubber,
  state: PassState,
): Promise<void> {
  const log = (message: string) =>
    console.log(`OpsCrew E2E (observability): ${scrubber.scrub(message)}`);
  const paths = resolveProjectPaths(run.repo, { env: run.env });
  for (const value of (await readGeneratedValues(paths)) ?? []) {
    scrubber.add(value, "generated-value");
  }
  const plan = await readArtifact("plan", paths.files.plan);
  const ipv4 = (await readServerAddresses(paths)).deployment?.ipv4;
  if (ipv4 === undefined) throw new Error("OpsCrew recorded no server address.");
  const outputs: string[] = [];
  const findings: string[] = [];
  const target: CliTarget = {
    repo: run.repo,
    env: run.env,
    opscrew: run.opscrew,
    log,
    scrub: scrubber.scrub,
    findings,
    keep: (_label, output) => outputs.push(output),
  };
  const ctx: PassRun = {
    run,
    target,
    plan,
    ipv4,
    base: plan.deployment.url ?? `http://${ipv4}`,
    log,
    scrubber,
    outputs,
    sources: [],
  };
  state.startedAt = run.startedAt;
  state.git = run.git;
  state.key = checkEnvironmentKey(plan);
  const request = (path: string) => httpRequest(new URL(path, ctx.base).toString());

  await logsAndFigures(target, { request, figures: "server" });
  const grafana = settings.grafana;
  if (grafana !== undefined) await grafanaOn(ctx, grafana);
  await seededLine(ctx);
  if (settings.check) await checkPass(ctx, settings, state);
  if (settings.addons) await beszelPass(ctx);
  if (grafana !== undefined) await grafanaOff(ctx, grafana);
  else if (settings.addons) {
    log("not checked: Grafana Cloud (set its six variables; see docs/e2e.md)");
  }
  await leakSearch(ctx, settings);
  for (const finding of findings) log(`finding: ${finding}`);
  if (findings.length > 0) {
    throw new Error(`Findings of the observability pass:\n- ${findings.join("\n- ")}`);
  }
}

/**
 * A request that makes the app print the seeded secret: its line shows in `opscrew logs` and in
 * MCP's `opscrew_logs` with the secret masked (SC-1704).
 */
async function seededLine(ctx: PassRun): Promise<void> {
  const path = requestPath("seeded");
  await httpRequest(new URL(path, ctx.base).toString()).catch(() => undefined);
  const masked = (text: string) =>
    text.split(/\r?\n/).some((line) => line.includes(path) && line.includes("seeded=[REDACTED:"));
  await waitFor(
    "the seeded request's line, masked, in opscrew logs",
    minutes(1),
    async () => (masked(await cliOk(ctx.target, "logs", "--since", "15m")) ? true : undefined),
    5_000,
  );
  const mcp = await McpSession.start({
    cli: CLI,
    cwd: ctx.run.repo,
    env: ctx.run.env,
    approve: () => false,
  });
  try {
    const result = await mcp.call("opscrew_logs", { since: "15m" });
    if (result.isError || !masked(result.text)) {
      throw new Error("MCP's opscrew_logs did not return the seeded request's line, masked.");
    }
  } finally {
    await mcp.close();
    ctx.sources.push({
      kind: "file",
      where: "MCP's opscrew_logs (results, standard error)",
      text: mcp.transcript.join("\n"),
    });
  }
  ctx.log("the seeded request's line shows masked in opscrew logs and in MCP's opscrew_logs");
}

/**
 * The scheduled check by dispatch (quickstart "3."): a passing run and its billed minutes
 * (SC-1705); the app stopped opens one issue per hostname, posted to ntfy, shown by `status`, and
 * a second run adds nothing; started again, each closes with how long it lasted (SC-1702); the
 * disk filled past 85% opens the disk issue (SC-1703), posted to ntfy and flagged by `status`. The
 * disk issue stays open for destroy's pause to close.
 */
async function checkPass(
  ctx: PassRun,
  settings: ObservabilitySettings,
  state: PassState,
): Promise<void> {
  const { run, plan, ipv4, log, target } = ctx;
  if (plan.observability?.check?.enabled !== true || plan.observability.check.webhook !== "ntfy") {
    throw new Error("The plan does not have the scheduled check on with the ntfy webhook.");
  }
  if (!existsSync(join(run.repo, ".github/workflows", CHECK_WORKFLOW_FILE))) {
    throw new Error(`The deploy-setup pull request put no ${CHECK_WORKFLOW_FILE} on main.`);
  }
  const config = JSON.parse(
    await readFile(join(run.repo, "opscrew/check/check.json"), "utf8"),
  ) as CheckConfig;
  const key = checkEnvironmentKey(plan);
  const environment = config.environments.find((item) => item.key === key);
  const serverId = environment?.server?.id;
  if (environment === undefined || serverId === undefined || config.webhook !== "ntfy") {
    throw new Error(`check.json does not check ${key}'s hostnames and disk with the ntfy webhook.`);
  }
  const hosts = environment.hosts.map((host) => host.hostname);
  const health = new URL(plan.app.healthPath, ctx.base).toString();
  const check = (what: string) => dispatchCheck(run.github, run.git, what, log);
  const ours = () => issuesOf(run.github, run.startedAt, key);
  const ntfySince = Math.floor(run.startedAt.getTime() / 1000);

  const passing = await check("the app up");
  const jobs = await run.github.jobTimes(passing);
  const billed = billedMinutes(jobs);
  const stated = await run.github.billableMs(passing);
  const monthly = billed * monthlyRuns(config.intervalMinutes);
  log(
    `a passing run of the check: ${jobs.map((job) => `${job.name} ${seconds(Date.parse(job.completedAt) - Date.parse(job.startedAt))}`).join(", ")}; billed ${billed} min${stated === undefined ? "" : ` (GitHub states ${seconds(stated)})`}; every ${config.intervalMinutes} min that is ${monthly} min a month in a ${config.public ? "public" : "private"} repository (SC-1705: at most ${MONTHLY_MINUTES} in a private one)`,
  );
  if (!config.public && monthly > MONTHLY_MINUTES) {
    target.findings.push(
      `the check would use ${monthly} Actions minutes a month at its interval, over ${MONTHLY_MINUTES} (SC-1705)`,
    );
  }
  if ((await ours()).some((issue) => issue.open)) {
    throw new Error(`The check opened an issue for ${key} while the app was up.`);
  }

  // The app stopped: one issue per hostname, posted to ntfy, then nothing more.
  const httpsKeys = hosts.map((host) => `${key}/https/${host}`).sort();
  let opened: CheckIssue[] = [];
  await stopApp(run, ipv4, plan);
  try {
    await waitForHealth(health, false);
    await check("the app stopped");
    opened = (await ours()).filter((issue) => issue.open);
    const keys = opened.map((issue) => issueKey(issue.body)).sort();
    if (JSON.stringify(keys) !== JSON.stringify(httpsKeys)) {
      throw new Error(
        `With the app stopped, the check opened ${opened.length} issue(s), not one for each of the ${hosts.length} hostname(s).`,
      );
    }
    for (const issue of opened) {
      const host = hosts.find((name) => issueKey(issue.body) === `${key}/https/${name}`) ?? "";
      const named = [key.split("/")[0] ?? "", "(prod)", host].every((part) =>
        issue.title.includes(part),
      );
      if (!named || !issue.body.includes(host)) {
        throw new Error(`Issue #${issue.number} does not name the app, prod and its hostname.`);
      }
    }
    log(`the app stopped: issue(s) ${opened.map((issue) => `#${issue.number}`).join(", ")} opened`);
    await expectPosted(
      settings,
      ntfySince,
      opened.map((issue) => issue.title),
      "opened",
    );
    const status = await cliOk(target, "status");
    if (
      !status.includes("State: on") ||
      opened.some((issue) => !status.includes(`#${issue.number} `))
    ) {
      throw new Error(
        `status does not show the check on with its open alerts:\n${tail(target, status)}`,
      );
    }
    await check("the app still stopped");
    const again = await ours();
    const changed = again.filter(
      (issue) =>
        !opened.some(
          (before) =>
            before.number === issue.number &&
            before.comments.length === issue.comments.length &&
            issue.open,
        ),
    );
    if (changed.length > 0) {
      throw new Error(
        `A second run with the app still stopped changed issue(s) ${changed.map((issue) => `#${issue.number}`).join(", ")}.`,
      );
    }
    log("a second run with the app still stopped added nothing");
  } finally {
    await startApp(run, ipv4, plan);
  }
  await waitForHealth(health, true);
  await check("the app started again");
  const after = await ours();
  for (const issue of opened) {
    const now = after.find((item) => item.number === issue.number);
    const lasted = resolvedAfter(now?.comments ?? []);
    if (now === undefined || now.open || now.stateReason !== "completed" || lasted === undefined) {
      throw new Error(`Issue #${issue.number} was not closed with how long the app was down.`);
    }
    log(`issue #${issue.number} closed: resolved after ${lasted} (SC-1702)`);
  }
  await expectPosted(
    settings,
    ntfySince,
    opened.map(() => `OpsCrew check: resolved, ${key.split("/")[0]} (prod), HTTPS on`),
    "closed",
  );

  // The disk past 85%: its issue, posted to ntfy and flagged by status.
  const bytes = fillBytes(await run.ssh(ipv4, "df -P -B1 /"), FILL_PERCENT);
  await run.ssh(ipv4, `fallocate -l ${bytes} /home/deploy/opscrew-e2e-fill`);
  log(`filled the disk to ${FILL_PERCENT}% with a file of ${(bytes / 1e9).toFixed(1)} GB`);
  const figures = statusFigures(await cliOk(target, "status"));
  if (!figures?.flags.some((flag) => /^Warning: The server's disk is \d+% full/.test(flag))) {
    throw new Error("status does not flag the disk past 85%.");
  }
  await check("the disk past 85%");
  const disk = (await ours()).find(
    (issue) => issue.open && issueKey(issue.body) === `${key}/disk/${serverId}`,
  );
  if (
    disk === undefined ||
    !disk.title.includes(`disk over 85% full on ${serverId}`) ||
    !/is \d+% full: [\d.]+ GB free of [\d.]+ GB/.test(disk.body)
  ) {
    throw new Error("The check opened no disk issue naming the server and its free space.");
  }
  log(`the disk past 85%: issue #${disk.number} opened (SC-1703)`);
  await expectPosted(settings, ntfySince, [disk.title], "opened");
  state.diskIssue = disk.number;
}

/**
 * Waits up to 2 minutes until the ntfy topic holds a message titled with each of `titles` (each
 * as a prefix), posted since `since` (Unix seconds), as many times as it is listed.
 */
async function expectPosted(
  settings: ObservabilitySettings,
  since: number,
  titles: readonly string[],
  what: string,
): Promise<NtfyMessage[]> {
  return waitFor(
    `ntfy holding the ${titles.length} post(s) of the issue(s) ${what}`,
    minutes(2),
    async () => {
      const messages = await ntfyPoll(settings, since);
      const left = [...messages];
      for (const title of titles) {
        const at = left.findIndex((message) => message.title.startsWith(title));
        if (at < 0) return undefined;
        left.splice(at, 1);
      }
      return messages;
    },
    10_000,
  );
}

async function ntfyPoll(settings: ObservabilitySettings, since: number): Promise<NtfyMessage[]> {
  const answer = await fetch(ntfyPollUrl(settings.ntfyTopic, since));
  if (!answer.ok) throw new Error(`ntfy answered HTTP ${answer.status} to the poll.`);
  return ntfyMessages(await answer.text());
}

/**
 * After the teardown: a finished destroy paused the environment ("destroyed"), and a run of the
 * check then closes its disk issue with the pause's reason (quickstart "4."). Any issue of the run
 * still open is a problem (the repository's reset closes it).
 */
async function afterTeardown(
  github: GitHubRepo,
  state: PassState,
  destroyed: boolean,
): Promise<string[]> {
  const { startedAt, key, git } = state;
  if (startedAt === undefined || key === undefined || git === undefined) return [];
  const problems: string[] = [];
  const log = (message: string) => console.log(`OpsCrew E2E (observability): ${message}`);
  if (destroyed && state.diskIssue !== undefined) {
    const paused = JSON.parse((await github.variable(CHECK_PAUSED_VARIABLE)) ?? "{}") as Record<
      string,
      { reason?: string }
    >;
    if (paused[key]?.reason !== "destroyed") {
      problems.push(
        `destroy did not pause the scheduled check for ${key} (${CHECK_PAUSED_VARIABLE})`,
      );
    } else {
      await dispatchCheck(github, git, "after destroy", log);
      const disk = (await github.checkIssues(startedAt)).find(
        (issue) => issue.number === state.diskIssue,
      );
      if (
        disk?.open !== false ||
        !disk.comments.some((c) => c.startsWith("Closed while the check is paused."))
      ) {
        problems.push(
          `the check did not close disk issue #${state.diskIssue} as paused after destroy`,
        );
      } else {
        log(
          `after destroy, the check closed disk issue #${state.diskIssue} with the pause's reason`,
        );
      }
    }
  }
  const open = (await github.checkIssues(startedAt)).filter((issue) => issue.open);
  if (open.length > 0) {
    problems.push(
      `issue(s) ${open.map((issue) => `#${issue.number}`).join(", ")} of the scheduled check still open after the teardown (the repository's reset closes them)`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The add-ons.

/** One add-on's state in `opscrew addon status --json`. */
interface AddonState {
  kind: string;
  enabled: boolean;
  memoryMb?: number;
  secretsFile?: string;
  containers?: { name: string; running: boolean; memory?: string }[];
}

/**
 * `opscrew addon <args>`: the plans with `--plan-only`, then the run approving each printed hash
 * (and `confirm`, the app's name, for a plan that deletes history). Returns the plans' output.
 */
async function addonChange(
  target: CliTarget,
  args: readonly string[],
  confirm?: string,
): Promise<string> {
  const planned = await cliOk(target, "addon", ...args, "--plan-only", "--yes");
  const hashes = approveHashes(planned);
  if (hashes.length === 0) throw new Error(`opscrew addon ${args.join(" ")} planned nothing.`);
  await cliOk(
    target,
    "addon",
    ...args,
    ...hashes.flatMap((hash) => ["--approve", hash]),
    ...(confirm === undefined ? [] : ["--confirm", confirm]),
    "--yes",
  );
  return planned;
}

/**
 * `opscrew addon status --json`'s state of `kind`, with every container running; its memory is
 * logged, and over the limit design showed is a finding (SC-1706).
 */
async function addonRunning(ctx: PassRun, kind: string): Promise<AddonState> {
  const result = await ctx.run.opscrew("addon", "status", "--json");
  if (result.exitCode !== 0)
    throw new Error(`opscrew addon status --json exited with ${result.exitCode}.`);
  const state = (JSON.parse(result.stdout) as { addons: AddonState[] }).addons.find(
    (item) => item.kind === kind,
  );
  const containers = state?.containers ?? [];
  if (state?.enabled !== true || containers.length === 0 || containers.some((c) => !c.running)) {
    throw new Error(`addon status does not show ${kind} on with all its containers running.`);
  }
  let used = 0;
  for (const container of containers) {
    const usage = memoryUsage(container.memory ?? "");
    if (usage === undefined) throw new Error(`addon status shows no memory of ${container.name}.`);
    used += usage.usedBytes;
  }
  const limit = (state.memoryMb ?? 0) * 1024 * 1024;
  ctx.log(
    `${kind}'s memory: ${containers.map((c) => `${c.name} ${c.memory}`).join(", ")}; ${(used / 1024 ** 2).toFixed(1)} MiB of the ${state.memoryMb} MB design showed`,
  );
  if (used > limit) {
    ctx.target.findings.push(
      `${kind} uses more memory than the ${state.memoryMb} MB design showed (SC-1706)`,
    );
  }
  return state;
}

/** What is left of add-on `project` on the server (`paths` among it) must be nothing (SC-1706). */
async function expectAddonGone(
  ctx: PassRun,
  project: string,
  paths: readonly string[],
  what: string,
): Promise<void> {
  const left = addonLeftovers(await ctx.run.ssh(ctx.ipv4, addonLeftoverCommand(project, paths)));
  if (left.length > 0) throw new Error(`${what} left on the server: ${left.join(", ")}.`);
  ctx.log(`${what}: nothing of it is left on the server`);
}

/**
 * Beszel in hub mode (quickstart "5.", SC-1706): enabled by its host plan's hash; its API answers
 * through `opscrew addon open beszel`'s tunnel with this server up and its containers listed, and
 * not on the server's address; its memory logged; disabled (its history deleted), leaving nothing.
 */
async function beszelPass(ctx: PassRun): Promise<void> {
  const { target, run, scrubber } = ctx;
  await addonChange(target, ["enable", "beszel"]);
  const state = await addonRunning(ctx, "beszel");
  const file = state.secretsFile ?? "";
  const secrets = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  for (const [name, value] of Object.entries(secrets)) {
    if (name !== "mode" && name !== "hubPublicKey") scrubber.add(value, `beszel-${name}`);
  }
  if (await canConnect(ctx.ipv4, 8090)) {
    throw new Error("Beszel's dashboard answers on the server's own address.");
  }
  const open = new RunningCli(target, ["addon", "open", "beszel"]);
  let done = false;
  try {
    await waitFor(
      "Beszel's API through the tunnel",
      minutes(3),
      async () => ((await fetch(`${BESZEL_LOCAL_URL}/api/health`)).ok ? true : undefined),
      3_000,
      open.endedEarly,
    );
    const api = async (path: string, init?: RequestInit) => {
      const answer = await fetch(`${BESZEL_LOCAL_URL}${path}`, init);
      if (!answer.ok) throw new Error(`Beszel answered HTTP ${answer.status} to ${path}.`);
      return answer.json() as Promise<Record<string, unknown>>;
    };
    const auth = (await api("/api/collections/users/auth-with-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: BESZEL_EMAIL, password: secrets.password }),
    })) as { token: string };
    scrubber.add(auth.token, "beszel-session");
    const headers = { authorization: auth.token };
    const system = await waitFor(
      "the server up in Beszel",
      minutes(3),
      async () => {
        const { items } = (await api("/api/collections/systems/records", { headers })) as {
          items: { id: string; status: string }[];
        };
        return items.length === 1 && items[0]?.status === "up" ? items[0] : undefined;
      },
      5_000,
    );
    const containers = await waitFor(
      "the server's containers in Beszel",
      minutes(3),
      async () => {
        const filter = encodeURIComponent(`system="${system.id}"`);
        const { items } = (await api(
          `/api/collections/containers/records?perPage=500&filter=${filter}`,
          { headers },
        )) as { items: { name: string }[] };
        return items.some((item) => item.name.startsWith(`${ctx.plan.app.name}-`))
          ? items
          : undefined;
      },
      5_000,
    );
    ctx.log(
      `Beszel through the tunnel: the server is up with ${containers.length} containers, the app's among them`,
    );
    done = true;
  } finally {
    await open.stop().catch((error: unknown) => {
      if (done) throw error;
      ctx.log(`after the failure, stopping addon open beszel: ${String(error)}`);
    });
  }
  await addonChange(target, ["disable", "beszel"], run.appName);
  await expectAddonGone(ctx, ADDON_PROJECTS.beszel, [addonDir("beszel", "login")], "Beszel");
  if (existsSync(file)) {
    throw new Error("addon disable beszel left Beszel's secrets on this computer.");
  }
}

/** A GET of Grafana Cloud's API with the test's read token, as `user`. */
async function grafanaGet(url: string, user: string, grafana: GrafanaCloudSettings) {
  const auth = Buffer.from(`${user}:${grafana.readToken}`).toString("base64");
  const answer = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
  if (!answer.ok) throw new Error(`Grafana Cloud answered HTTP ${answer.status} to a query.`);
  return answer.json() as Promise<unknown>;
}

/**
 * Grafana Cloud on (quickstart "6.", SC-1707): enabled with the stack's addresses (the token from
 * `OPSCREW_GRAFANA_CLOUD_TOKEN`); the server's CPU, memory and disk queried back within 5 minutes,
 * the series under 1,000, Alloy's memory logged; then provision and the deploy that writes the
 * masking file, before any seeded line, and the seeded request's line within 5 minutes, labelled
 * app, env and service, with the secret masked.
 */
async function grafanaOn(ctx: PassRun, grafana: GrafanaCloudSettings): Promise<void> {
  const { target, plan, log } = ctx;
  const app = plan.app.name;
  const planned = await addonChange(target, [
    "enable",
    "grafana-cloud",
    "--metrics-url",
    grafana.metricsUrl,
    "--metrics-user",
    grafana.metricsUser,
    "--logs-url",
    grafana.logsUrl,
    "--logs-user",
    grafana.logsUser,
  ]);
  if (!/series/i.test(planned)) {
    throw new Error("addon enable grafana-cloud showed no estimate of the series before the plan.");
  }
  const enabled = Date.now();
  await addonRunning(ctx, "grafana-cloud");
  const metrics = (query: string) =>
    grafanaGet(prometheusQueryUrl(grafana.metricsUrl, query), grafana.metricsUser, grafana).then(
      promVector,
    );
  await waitFor(
    "the server's CPU, memory and disk in Grafana Cloud",
    minutes(10),
    async () => {
      const names = new Set(
        (await metrics(`count by (__name__) ({app="${app}"})`)).map((s) => s.metric.__name__),
      );
      return SERVER_SERIES.every((name) => names.has(name)) ? true : undefined;
    },
    15_000,
  );
  const took = Date.now() - enabled;
  log(`the server's CPU, memory and disk showed in Grafana Cloud ${seconds(took)} after enable`);
  if (took > SC_1707_MS) {
    target.findings.push(
      `the server's figures took ${seconds(took)} to reach Grafana Cloud (SC-1707)`,
    );
  }
  const series = (await metrics(`count({app="${app}"})`))[0]?.value ?? 0;
  log(`Grafana Cloud holds ${series} series of the app (SC-1707: under ${SERIES_LIMIT})`);
  if (!(series < SERIES_LIMIT)) {
    target.findings.push(
      `the app sends ${series} series to Grafana Cloud, not under ${SERIES_LIMIT} (SC-1707)`,
    );
  }
  await provisionAndDeploy(ctx, "the workflow that writes Grafana Alloy's masking file");

  const path = requestPath("seeded");
  const sent = Date.now();
  await httpRequest(new URL(path, ctx.base).toString()).catch(() => undefined);
  const streams = await waitFor(
    "the seeded request's line in Grafana Cloud",
    minutes(10),
    async () => {
      const found = lokiStreams(
        await grafanaGet(
          lokiQueryUrl(grafana.logsUrl, `{app="${app}"} |= "${path}"`, sent - 60_000),
          grafana.logsUser,
          grafana,
        ),
      );
      return found.some((stream) => stream.lines.length > 0) ? found : undefined;
    },
    15_000,
  );
  const lineTook = Date.now() - sent;
  log(`the seeded request's line showed in Grafana Cloud ${seconds(lineTook)} after the request`);
  if (lineTook > SC_1707_MS) {
    target.findings.push(
      `the app's line took ${seconds(lineTook)} to reach Grafana Cloud (SC-1707)`,
    );
  }
  for (const stream of streams) {
    const { app: label, env, service } = stream.labels;
    if (label !== app || env !== "prod" || service === undefined) {
      throw new Error("Grafana Cloud's stream of the app is not labelled app, env and service.");
    }
    if (!stream.lines.every((line) => line.includes("seeded=<opscrew:"))) {
      throw new Error("The seeded request's line reached Grafana Cloud without its secret masked.");
    }
  }
}

/**
 * Grafana Cloud off: the host plan removes Alloy, its buffer, its token and the app's masking
 * file; the token goes from this computer; provision's deploy-setup pull request then stops the
 * workflow writing the masking file, which must stay gone after that deploy (SC-1706).
 */
async function grafanaOff(ctx: PassRun, grafana: GrafanaCloudSettings): Promise<void> {
  // Every line the app sent this run, for the leak search.
  const lines = lokiStreams(
    await grafanaGet(
      lokiQueryUrl(
        grafana.logsUrl,
        `{app="${ctx.plan.app.name}"}`,
        ctx.run.startedAt.getTime(),
        5000,
      ),
      grafana.logsUser,
      grafana,
    ),
  ).flatMap((stream) => stream.lines);
  ctx.sources.push({
    kind: "file",
    where: "the app's lines in Grafana Cloud",
    text: lines.join("\n"),
  });
  await addonChange(ctx.target, ["disable", "grafana-cloud"]);
  const mask = `${appDirs(ctx.plan.app.name).app}/mask.re`;
  const leftovers = [
    addonDir("alloy", "login"),
    mask,
    addonDir("alloy", "login").replace(/\/alloy$/, ""),
  ];
  await expectAddonGone(ctx, ADDON_PROJECTS.alloy, leftovers, "Grafana Alloy");
  if (existsSync(resolveProjectPaths(ctx.run.repo, { env: ctx.run.env }).files.grafanaCloudToken)) {
    throw new Error("addon disable grafana-cloud left the token on this computer.");
  }
  await provisionAndDeploy(ctx, "the workflow without Grafana Alloy's masking file");
  await expectAddonGone(
    ctx,
    ADDON_PROJECTS.alloy,
    leftovers,
    "Grafana Alloy, after the next deploy",
  );
}

/**
 * `provision` as a user runs it after an add-on change: the plans, the run approving each printed
 * hash, then the merge of its deploy-setup pull request and that deploy, which must succeed.
 */
async function provisionAndDeploy(ctx: PassRun, what: string): Promise<void> {
  const { run, target, log } = ctx;
  const planned = await cliOk(target, "provision", "--plan-only", "--yes");
  const hashes = approveHashes(planned);
  await cliOk(target, "provision", ...hashes.flatMap((hash) => ["--approve", hash]), "--yes");
  const head = await run.git("rev-parse", "--abbrev-ref", "HEAD");
  if (!head.startsWith("opscrew/deploy-setup"))
    throw new Error(`provision opened no pull request for ${what}.`);
  const pull = await run.github.openPullRequest(head);
  if (pull === undefined) throw new Error(`provision left ${head} without a pull request.`);
  const sha = await run.github.merge(pull);
  await run.git("fetch", "-q", "origin");
  await run.git("checkout", "-q", "-B", "main", "origin/main");
  const deployed = await run.github.waitForDeploy({ headSha: sha }, minutes(25));
  if (deployed.conclusion !== "success") {
    throw new Error(`The deploy of ${what} (run ${deployed.id}) ended ${deployed.conclusion}.`);
  }
  log(`deployed ${what} (run ${deployed.id})`);
}

/**
 * The leak search (SC-1704): the seeded secret, the tokens, the ntfy topic, the add-ons' secrets
 * and the generated values in none of the terminal outputs, MCP's answers, the check's issues
 * (titles, bodies, comments), the ntfy posts, the Grafana Cloud lines, the commits, the pull
 * requests and the audit log. Only labels and places are printed.
 */
async function leakSearch(ctx: PassRun, settings: ObservabilitySettings): Promise<void> {
  const { run, scrubber } = ctx;
  const known = scrubber.entries();
  const sources: LeakSource[] = [
    ...run.outputs.map((text, i) => ({
      kind: "file" as const,
      where: `CLI output #${i + 1}`,
      text,
    })),
    ...ctx.outputs.map((text, i) => ({
      kind: "file" as const,
      where: `a long-running command's output #${i + 1}`,
      text,
    })),
    ...ctx.sources,
    ...(await leakSourcesOf({
      git: run.git,
      github: run.github,
      startedAt: run.startedAt,
      auditDir: resolveProjectPaths(run.repo, { env: run.env }).auditDir,
    })),
  ];
  for (const issue of await run.github.checkIssues(run.startedAt)) {
    sources.push({
      kind: "file",
      where: `issue #${issue.number}`,
      text: [issue.title, issue.body, ...issue.comments].join("\n"),
    });
  }
  if (settings.check) {
    const messages = await ntfyPoll(settings, Math.floor(run.startedAt.getTime() / 1000));
    if (messages.length === 0) throw new Error("ntfy holds none of the check's posts.");
    sources.push({
      kind: "file",
      where: `the ${messages.length} ntfy posts`,
      text: messages.map((message) => `${message.title}\n${message.message}`).join("\n"),
    });
  }
  const problems: string[] = [];
  for (const { where, text } of sources) {
    const found = leakedLabels(text, known);
    if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
  }
  for (const problem of problems) ctx.log(`leak: ${problem}`);
  if (problems.length > 0) throw new Error(`Leaks (SC-1704):\n- ${problems.join("\n- ")}`);
  ctx.log(
    `the leak search found none of ${known.length} known values in ${sources.length} places (SC-1704)`,
  );
}
