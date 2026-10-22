import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApprovalRequest,
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "@opscrew/contracts";
import { OpsCrewError, readTextIfExists } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { TOOLS } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan, localProject } from "../localhost/__fixtures__/computer";
import { lockFile } from "../localhost/lock";
import { ScriptedApprovalHandler } from "../testing";
import { FakeRunnerGitHub, listedRunner } from "./__fixtures__/github";
import {
  type LocalRunnerServices,
  type RunnerProcess,
  requireLocalRunnerImage,
  startLocalRunner,
} from "./local";

/** The dev environment on this computer, deployed by the local runner. */
function devPlan(image: "registry" | "local-build" = "registry"): DeployPlan {
  const plan = localPlan({ environment: "dev", image });
  return DeployPlanSchema.parse({
    ...plan,
    environment: { ...plan.environment, runner: "local" },
  });
}

/** The commands the runner start runs to its end: git answers the GitHub remote, `config` passes. */
class RunnerComputer implements CommandRunner {
  readonly calls: { command: string; args: string[]; options?: CommandOptions }[] = [];
  config: CommandResult = { exitCode: 0, stdout: "√ Runner successfully added", stderr: "" };

  async run(command: string, args: readonly string[], options?: CommandOptions) {
    this.calls.push({ command, args: [...args], ...(options ? { options } : {}) });
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    if (command === "git") {
      return args.includes("get-url")
        ? { ...ok, stdout: "https://github.com/acme/shop.git\n" }
        : ok;
    }
    return /config\.(sh|cmd)$/.test(command) || args.includes("config.cmd") ? this.config : ok;
  }
}

/** The runner's `run` process: it ends on the signals in `endsOn`, or when a test ends it. */
class FakeProcess implements RunnerProcess {
  readonly signals: string[] = [];
  endsOn = new Set<string>(["SIGINT"]);
  private resolve: (code: number) => void = () => undefined;
  readonly exited = new Promise<number>((resolve) => {
    this.resolve = resolve;
  });
  constructor(
    readonly command: string,
    readonly env: Record<string, string>,
  ) {}
  signal(signal: string): void {
    this.signals.push(signal);
    if (this.endsOn.has(signal)) this.resolve(130);
  }
  end(code: number): void {
    this.resolve(code);
  }
}

/** A process id that no longer runs: a node process that ran and ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

/** A project with the dev environment's plan, this computer and GitHub, the runner installed. */
async function setup(
  o: { plan?: DeployPlan; installed?: boolean; answer?: (r: ApprovalRequest) => boolean } = {},
) {
  const computer = new RunnerComputer();
  const { deps } = await localProject(o.plan ?? devPlan(), undefined, {
    environment: "dev",
    approve: new ScriptedApprovalHandler(o.answer ?? (() => true)),
  });
  deps.runner = computer;
  const dir = join(deps.paths.homeDir, "runners", "shop-dev");
  if (o.installed !== false) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".opscrew-version"), `${TOOLS.githubRunner.version}\n`);
  }
  const github = new FakeRunnerGitHub();
  const processes: FakeProcess[] = [];
  let started: ((proc: FakeProcess) => void) | undefined;
  /** The next `run` process the runner starts. */
  const next = () =>
    new Promise<FakeProcess>((resolve) => {
      started = resolve;
    });
  let signalled: (() => void) | undefined;
  let unsubscribed = false;
  const services: LocalRunnerServices = {
    github,
    // The grace periods never run out unless a test says so.
    computer: {
      platform: "linux",
      arch: "x64",
      computerName: "test laptop",
      sleep: () => new Promise(() => undefined),
    },
    onSignal: (stop) => {
      signalled = stop;
      return () => {
        unsubscribed = true;
      };
    },
    start: (command, _args, options) => {
      const proc = new FakeProcess(command, options.env);
      options.onLine("Listening for Jobs");
      processes.push(proc);
      started?.(proc);
      return proc;
    },
  };
  const start = () => startLocalRunner(deps, { environment: "dev", services });
  return {
    deps,
    computer,
    github,
    dir,
    start,
    next,
    processes,
    services,
    signal: () => signalled?.(),
    unsubscribed: () => unsubscribed,
  };
}

const NAME = "test-laptop-shop-dev";
const LABEL = "opscrew-shop-dev";

async function expectError(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

describe("startLocalRunner", () => {
  it("registers an ephemeral session with the label, the token only in its environment, and runs it", async () => {
    const s = await setup();
    const first = s.next();
    const runner = await s.start();
    const proc = await first;
    const config = s.computer.calls.find((c) => c.command.endsWith("config.sh"));
    expect(config?.command).toBe(join(s.dir, "config.sh"));
    expect(config?.args).toEqual([
      "--unattended",
      "--url",
      "https://github.com/acme/shop",
      "--name",
      NAME,
      "--labels",
      LABEL,
      "--work",
      "_work",
      "--ephemeral",
      "--replace",
    ]);
    expect(config?.options?.cwd).toBe(s.dir);
    const [token] = s.github.tokens;
    expect(config?.options?.env?.ACTIONS_RUNNER_INPUT_TOKEN).toBe(token);
    // The token is never on a command line, in the run's environment, a file or the output.
    expect(proc.command).toBe(join(s.dir, "run.sh"));
    expect(proc.env.ACTIONS_RUNNER_INPUT_TOKEN).toBeUndefined();
    for (const call of s.computer.calls) expect(call.args.join(" ")).not.toContain(token);
    expect(s.deps.reporter.text()).not.toContain(token as string);
    // The jobs' environment: this computer's stack, the local CA and the deploy lock.
    const home = s.deps.paths.homeDir.replaceAll("\\", "/");
    expect(await readFile(join(s.dir, ".env"), "utf8")).toBe(
      [
        `OPSCREW_APPS_DIR=${home}/local/srv/apps`,
        `OPSCREW_EDGE_DIR=${home}/local/srv/edge`,
        `OPSCREW_LOCAL_CA_FILE=${home}/local-ca/ca.pem`,
        `OPSCREW_LOCAL_LOCK=${home}/local/deploy.lock`,
        "",
      ].join("\n"),
    );
    expect(await readTextIfExists(join(s.dir, ".env"))).not.toContain(token as string);
    expect(s.deps.reporter.text()).toContain("Listening for Jobs");

    s.github.runners = [listedRunner(5, NAME, LABEL), listedRunner(6, "other-pc-shop-dev", LABEL)];
    await runner.stop();
    // A graceful stop: the runner ends its job on SIGINT.
    expect(proc.signals).toEqual(["SIGINT"]);
    // Removed through the API: this computer's registration only, audited without a phase.
    expect(s.github.calls).toContain("delete acme/shop 5");
    expect(s.github.runners.map((r) => r.id)).toEqual([6]);
    const deleted = s.deps.audit.entries.filter((e) => e.action.startsWith("delete the self"));
    expect(deleted.map((e) => [e.action, e.phase])).toEqual([
      [`delete the self-hosted runner ${NAME}`, undefined],
    ]);
    expect(s.unsubscribed()).toBe(true);
  });

  it("gives the runner and its jobs none of the user's secrets", async () => {
    const s = await setup();
    s.deps.env = {
      ...s.deps.env,
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/me",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      GITHUB_TOKEN: fakeSecret("github-token", "runner-env"),
      GH_TOKEN: fakeSecret("github-token", "runner-env-gh"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token", "runner-env"),
      OPSCREW_GHCR_READ_TOKEN: fakeSecret("github-token", "runner-env-ghcr"),
      ANTHROPIC_API_KEY: fakeSecret("anthropic-key", "runner-env"),
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    };
    const first = s.next();
    const runner = await s.start();
    const proc = await first;
    const config = s.computer.calls.find((c) => c.command.endsWith("config.sh"));
    for (const env of [proc.env, config?.options?.env ?? {}]) {
      for (const name of [
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "HCLOUD_TOKEN",
        "OPSCREW_GHCR_READ_TOKEN",
        "ANTHROPIC_API_KEY",
        "SSH_AUTH_SOCK",
      ]) {
        expect(env[name], name).toBeUndefined();
      }
      expect(env).toMatchObject({
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/me",
        DOCKER_HOST: "unix:///var/run/docker.sock",
      });
    }
    await runner.stop();
  });

  it("stops and unregisters on a signal", async () => {
    const s = await setup();
    const first = s.next();
    const runner = await s.start();
    await first;
    s.github.runners = [listedRunner(5, NAME, LABEL)];
    s.signal();
    await runner.finished;
    expect(s.github.runners).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      `The runner ${NAME} is stopped and removed from GitHub.`,
    );
  });

  it("signals SIGTERM after the grace period, and SIGKILL only after a timeout", async () => {
    const s = await setup();
    s.services.computer = { ...s.services.computer, sleep: async () => undefined };
    const first = s.next();
    const runner = await s.start();
    const proc = await first;
    proc.endsOn = new Set(["SIGKILL"]);
    await runner.stop();
    expect(proc.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("clears a lock a killed deploy left, and never one a running deploy holds", async () => {
    const s = await setup();
    const lock = lockFile(s.deps.paths);
    await mkdir(join(lock, ".."), { recursive: true });
    // A lock a crashed deploy left before the start does not block the first job.
    await writeFile(lock, `${deadPid()}\n`);
    const first = s.next();
    const runner = await s.start();
    await first;
    expect(await readTextIfExists(lock)).toBeUndefined();
    // The stop cut a job that held the lock: it is cleared after the session.
    await writeFile(lock, `${deadPid()}\n`);
    await runner.stop();
    expect(await readTextIfExists(lock)).toBeUndefined();
    // A lock a running deploy holds stays.
    await writeFile(lock, `${process.pid}\n`);
    const again = s.next();
    const second = await s.start();
    await again;
    await second.stop();
    expect(await readTextIfExists(lock)).toBe(`${process.pid}\n`);
  });

  it("deletes the registration a crashed OpsCrew left before registering", async () => {
    const s = await setup();
    s.github.runners = [listedRunner(5, NAME, LABEL, { status: "offline" })];
    const first = s.next();
    const runner = await s.start();
    await first;
    const calls = s.github.calls;
    expect(calls.indexOf("delete acme/shop 5")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("delete acme/shop 5")).toBeLessThan(
      calls.indexOf("registration-token acme/shop"),
    );
    await runner.stop();
  });

  it("registers again with a fresh token after its job, until stopped", async () => {
    const s = await setup();
    const first = s.next();
    const runner = await s.start();
    const proc = await first;
    const second = s.next();
    proc.end(0);
    await second;
    expect(s.github.calls.filter((c) => c.startsWith("registration-token"))).toHaveLength(2);
    expect(s.computer.calls.filter((c) => c.command.endsWith("config.sh"))).toHaveLength(2);
    await runner.stop();
  });

  it("removes its registration and stops with what to do when the runner fails", async () => {
    const s = await setup();
    const first = s.next();
    const runner = await s.start();
    const proc = await first;
    s.github.runners = [listedRunner(5, NAME, LABEL)];
    proc.end(1);
    const error = await expectError(runner.finished, "COMMAND_FAILED");
    expect(error.message).toContain("exit code 1");
    expect(s.github.runners).toEqual([]);
    expect(s.unsubscribed()).toBe(true);
  });

  it("downloads the pinned runner for this computer and refuses one that does not match its SHA-256", async () => {
    const s = await setup({ installed: false });
    const fetched: string[] = [];
    s.deps.fetch = async (input) => {
      fetched.push(String(input));
      return new Response("not the runner");
    };
    s.services.computer = { platform: "darwin", arch: "arm64", computerName: "test-laptop" };
    const error = await expectError(s.start(), "COMMAND_FAILED");
    expect(fetched).toEqual([TOOLS.githubRunner.assets["osx-arm64"].url]);
    expect(error.message).toContain(
      `not the pinned ${TOOLS.githubRunner.assets["osx-arm64"].sha256}`,
    );
    expect(s.computer.calls.some((c) => c.command === "tar")).toBe(false);
    expect(s.github.calls).not.toContain("registration-token acme/shop");
  });

  it("refuses a public repository until outside contributors' runs need approval", async () => {
    let allow = false;
    const s = await setup({ answer: (r) => r.kind !== "github-settings" || allow });
    s.github.visibility = "public";
    const error = await expectError(s.start(), "APPROVAL_REFUSED");
    expect(error.message).toContain("should almost never serve a public repository");
    expect(s.computer.calls.some((c) => c.command.endsWith("config.sh"))).toBe(false);
    allow = true;
    const first = s.next();
    const runner = await s.start();
    await first;
    expect(s.github.policy).toBe("all_external_contributors");
    await runner.stop();
  });

  it("refuses an environment whose deploy job does not run here, or that builds its image here", async () => {
    const github = await setup({ plan: localPlan({ environment: "dev", image: "registry" }) });
    expect((await expectError(github.start(), "PHASE_PRECONDITION")).message).toContain(
      "does not run on this computer's runner",
    );
    const built = await setup({ plan: devPlan("local-build") });
    const error = await expectError(built.start(), "PHASE_PRECONDITION");
    expect(error.message).toContain("image: local-build");
    expect(error.hint).toContain("opscrew/environments/dev/plan.yaml");
    await expect(
      requireLocalRunnerImage(built.deps.paths.root, devPlan()),
    ).resolves.toBeUndefined();
    expect(built.github.calls).toEqual([]);
  });
});
