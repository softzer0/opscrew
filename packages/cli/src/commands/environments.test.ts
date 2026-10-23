import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type DestroyResult,
  type DriftReport,
  type LocalPlan,
  type LocalRunnerServices,
  localPlanFile,
  localPlanHash,
  type PhaseDeps,
  type PromoteGitHubApi,
  type ProvisionResult,
  type RunnerGitHubApi,
  type RunnerProcess,
} from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { TOOLS } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { inEnvironment, localPlan, withEnvironments } from "../ui/__fixtures__/environments";
import { projectContext, run, ScriptedPrompts, type TempProject } from "../ui/__fixtures__/harness";
import { runDestroyCommand } from "./destroy";
import { runInfraCommand } from "./provision";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** prod and staging, both on Hetzner. */
function stagingApp(): Promise<TempProject> {
  return withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
}

/** A local plan of `purpose` for the `dev` environment, saved where the phases save it. */
async function saveLocalPlan(
  deps: PhaseDeps,
  purpose: LocalPlan["purpose"],
  action: "create" | "keep" | "remove",
): Promise<string> {
  const plan: LocalPlan = {
    schemaVersion: 1,
    purpose,
    app: "shop-dev",
    environment: "dev",
    project: "opscrew-shop-dev",
    address: "https://shop-dev.localhost:8443",
    ports: { https: 8443, http: 8080 },
    items: [{ kind: "container", name: "opscrew-shop-dev-web-1", action }],
  };
  const hash = localPlanHash(plan);
  const file = localPlanFile(deps.paths, hash);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
  return hash;
}

describe("--env", () => {
  it("names the environments and --env when a script does not say which one", async () => {
    project = await stagingApp();
    const ctx = projectContext(project);
    expect(await run(ctx, "status")).not.toBe(0);
    expect(ctx.errors).toContain('several environments ("prod", "staging")');
    expect(ctx.errors).toContain("--env <name>");
  });

  it("asks in a terminal which environment the command is for", async () => {
    project = await stagingApp();
    const prompts = new ScriptedPrompts(["staging"]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "secrets", "status"), ctx.errors).toBe(0);
    expect(prompts.calls[0]).toMatchObject({
      message: "Which environment is this for?",
      options: [
        { value: "prod", label: "prod" },
        { value: "staging", label: "staging" },
      ],
    });
  });

  it("acts on the environment it names, and refuses one the app does not have", async () => {
    project = await stagingApp();
    const ctx = projectContext(project);
    expect(await run(ctx, "secrets", "status", "--env", "staging"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("first `opscrew provision` makes it");
    const unknown = projectContext(project);
    expect(await run(unknown, "secrets", "status", "--env", "qa")).not.toBe(0);
    expect(unknown.errors).toContain("staging");
  });
});

describe("the localhost target in the CLI", () => {
  it("--plan-only prints the local plan's hash with the command that applies it", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const ctx = projectContext(project);
    let hash = "";
    await runInfraCommand(ctx, "provision", { planOnly: true, env: "dev" }, async (deps) => {
      hash = await saveLocalPlan(deps, "setup", "create");
      return { applied: false, localPlanHash: hash, localApplied: false, outputs: {} };
    });
    expect(ctx.output).toContain(`    ${hash}`);
    expect(ctx.output).toContain(`opscrew provision --env dev --approve ${hash}`);
  });

  it("--plan-only says plainly when the local plan changes nothing", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const ctx = projectContext(project);
    await runInfraCommand(
      ctx,
      "provision",
      { planOnly: true, env: "dev" },
      async (deps): Promise<ProvisionResult> => ({
        applied: false,
        localPlanHash: await saveLocalPlan(deps, "setup", "keep"),
        localApplied: false,
        outputs: {},
      }),
    );
    expect(ctx.output).toContain("the app on this computer already matches the local plan");
    expect(ctx.output).not.toContain("--approve");
  });

  it("--plan-only stops plainly at a damaged local plan", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const ctx = projectContext(project);
    const hash = "a".repeat(64);
    await expect(
      runInfraCommand(ctx, "provision", { planOnly: true, env: "dev" }, async (deps) => {
        const file = localPlanFile(deps.paths, hash);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "not a plan\n");
        return { applied: false, localPlanHash: hash, localApplied: false, outputs: {} };
      }),
    ).rejects.toThrow();
    expect(ctx.errors).toContain(`The saved local plan ${hash}`);
    expect(ctx.errors).toContain("`opscrew provision --env dev --plan-only`");
  });

  it("`opscrew dns` says that an environment on this computer has no DNS", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const ctx = projectContext(project);
    expect(await run(ctx, "dns", "--env", "dev")).not.toBe(0);
    expect(ctx.errors).toContain("The dev environment runs on this computer, which has no DNS");
    expect(ctx.errors).not.toContain("not supported");
    expect(ctx.fetchUrls).toEqual([]);
  });

  it("destroy --confirm <app> approves the local teardown plan, never a setup plan", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const decisions: { purpose: string; approved: boolean }[] = [];
    const destroy = async (deps: PhaseDeps): Promise<DestroyResult> => {
      for (const purpose of ["teardown", "setup"] as const) {
        const hash = await saveLocalPlan(deps, purpose, "remove");
        const decision = await deps.approvals.request({
          kind: "host-apply",
          title: `Remove shop-dev from this computer (${purpose})`,
          details: "The local plan.",
          planHash: hash,
          allowDestroy: true,
          confirmPhrase: "shop-dev",
        });
        decisions.push({ purpose, approved: decision.approved });
      }
      return { destroyed: [], secretsRemoved: [], remaining: ["The data volumes."] };
    };
    const ctx = projectContext(project);
    await runDestroyCommand(ctx, { env: "dev", confirm: "shop-dev" }, destroy);
    expect(decisions).toEqual([
      { purpose: "teardown", approved: true },
      { purpose: "setup", approved: false },
    ]);
    expect(ctx.output).toContain("What remains:\n  - The data volumes.");
    expect(ctx.output).toContain("`opscrew provision --env dev`");
  });

  it("destroy refuses --undo-host on this computer before anything runs", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const ctx = projectContext(project);
    expect(await run(ctx, "destroy", "--env", "dev", "--undo-host")).not.toBe(0);
    expect(ctx.errors).toContain("--undo-host applies only to a server you already own");
    expect(ctx.errors).toContain("`opscrew destroy --env dev`");
  });

  it("`localhost trust` in a script only prints the command", async () => {
    project = await withEnvironments({});
    // A Linux home folder on every OS: a Windows temp path would be quoted in the command.
    const ctx = projectContext(project, {
      services: { localhost: { platform: "linux", homedir: "/home/me", computerName: "laptop" } },
    });
    expect(await run(ctx, "localhost", "trust"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("Command: certutil -d sql:/home/me/.pki/nssdb -A");
    expect(ctx.output).toContain("Run the command above yourself");
  });
});

describe("opscrew promote", () => {
  it("refuses an --approve value that is not a hash before anything runs", async () => {
    project = await stagingApp();
    const ctx = projectContext(project);
    expect(await run(ctx, "promote", "--to", "staging", "--approve", "yes")).not.toBe(0);
    expect(ctx.errors).toContain("--approve expects the 64-character SHA-256 promotion hash");
    expect(ctx.fetchUrls).toEqual([]);
  });

  it("refuses an environment deployed from main, with how to promote it", async () => {
    project = await stagingApp();
    const ctx = projectContext(project);
    expect(await run(ctx, "promote", "--to", "staging")).not.toBe(0);
    expect(ctx.errors).toContain("`opscrew env set staging --from <environment>`");
    expect(ctx.fetchUrls).toEqual([]);
  });

  it("shows a run that waits for a required reviewer as waiting, with its link", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const commit = "c".repeat(40);
    const runUrl = "https://github.com/acme/shop/actions/runs/777";
    const workflow = "name: OpsCrew deploy\n";
    const deployed = testPlan({ deployed: true });
    project = await withEnvironments(
      { staging: inEnvironment(deployed, "staging") },
      DeployPlanSchema.parse({
        ...deployed,
        environment: { deploySource: { from: "promote", source: "staging" } },
      }),
    );
    const file = path.join(project.root, ".github", "workflows", "opscrew-deploy.yml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, workflow);
    const bytes = Buffer.from(workflow, "utf8");
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const waiting = { id: 777, status: "waiting" as const, conclusion: null, htmlUrl: runUrl };
    const github: PromoteGitHubApi = {
      getRepo: async () => ({ defaultBranch: "main", private: true, canPush: true }),
      fileSha: async () => blob,
      getEnvironment: async () => undefined,
      taggedDigest: async (_owner, _image, tag) =>
        tag === "opscrew-staging" || tag === `${commit}-staging` ? digest : undefined,
      imageProvenance: async () => ({
        builderId: "https://github.com/acme/shop/actions/runs/501/attempts/1",
        runId: 501,
        repository: "acme/shop",
      }),
      imagePlatforms: async () => [{ os: "linux", architecture: "amd64" }],
      workflowRun: async () => ({
        repository: "acme/shop",
        headRepository: "acme/shop",
        event: "push",
        headBranch: "main",
        headSha: commit,
        path: ".github/workflows/opscrew-deploy-staging.yml",
      }),
      getWorkflowRun: async () => ({
        ...waiting,
        headSha: commit,
        createdAt: "2026-10-11T12:00:00Z",
      }),
      dispatchWorkflow: async () => ({ runId: 777, url: runUrl }),
      waitForWorkflowRun: async () => waiting,
    };
    const drift = async (): Promise<DriftReport> => ({
      drift: [],
      pending: [],
      files: { changed: [], created: [] },
      foreignDnsRecords: [],
      clean: true,
      checkedAt: "2026-10-11T12:00:00.000Z",
      provider: "hetzner",
    });
    const ctx = projectContext(project, {
      interactive: true,
      services: {
        runner: new RemoteOnlyRunner(),
        promote: { github, drift },
        approvalHandler: {
          request: async () => ({
            approved: true,
            approver: "test",
            decidedAt: "2026-10-11T12:00:00.000Z",
          }),
        },
      },
    });
    expect(await run(ctx, "promote", "--to", "prod"), ctx.errors).toBe(0);
    expect(ctx.output).toContain(`waits in GitHub for a required reviewer of prod: ${runUrl}`);
    expect(ctx.output).toContain("The deploy goes on once the reviewer approves it in GitHub.");
    expect(ctx.output).not.toContain("Deployed ");
  });
});

/** git answers the GitHub remote; the runner's `config` script passes. */
class RunnerRunner implements CommandRunner {
  async run(command: string, args: readonly string[], _options?: CommandOptions) {
    const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
    if (/git(\.exe)?$/i.test(command) && args.includes("get-url")) {
      return { ...ok, stdout: "https://github.com/acme/shop.git\n" };
    }
    return ok;
  }
}

describe("opscrew runner start", () => {
  it("runs in the foreground until stopped, then removes the runner", async () => {
    project = await withEnvironments({ dev: localPlan("dev", { runner: "local" }) });
    // The pinned runner is installed already, so nothing is downloaded.
    const dir = path.join(project.env.OPSCREW_HOME as string, "runners", "shop-dev");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".opscrew-version"), `${TOOLS.githubRunner.version}\n`);
    const calls: string[] = [];
    const github: RunnerGitHubApi = {
      runnerRegistrationToken: async () => fakeSecret("hcloud-token", "cli-runner-registration"),
      runnerRemoveToken: async () => fakeSecret("hcloud-token", "cli-runner-remove"),
      listRunners: async () => [],
      deleteRunner: async () => undefined,
      repositoryVisibility: async () => "private",
      forkPrApprovalPolicy: async () => "first_time_contributors",
      setForkPrApprovalPolicy: async () => {
        calls.push("set-fork-pr-policy");
      },
    };
    let stop: (() => void) | undefined;
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const localRunner: LocalRunnerServices = {
      github,
      computer: { platform: "linux", arch: "x64", computerName: "laptop" },
      // Ctrl+C: the CLI's signal handler, captured here and called by the test.
      onSignal: (handler) => {
        stop = handler;
        return () => undefined;
      },
      start: (): RunnerProcess => {
        let exit: (code: number) => void = () => undefined;
        const exited = new Promise<number>((resolve) => {
          exit = resolve;
        });
        ready();
        return {
          exited,
          signal: (signal) => {
            calls.push(signal);
            if (signal === "SIGINT") exit(130);
          },
        };
      },
    };
    const ctx = projectContext(project, {
      services: { runner: new RunnerRunner(), localRunner },
    });
    let done = false;
    const finished = run(ctx, "runner", "start", "--env", "dev").then((code) => {
      done = true;
      return code;
    });
    await started;
    expect(done).toBe(false);
    stop?.();
    expect(await finished, ctx.errors).toBe(0);
    expect(calls).toEqual(["SIGINT"]);
    expect(ctx.output).toContain("is stopped and removed from GitHub");
  });
});

/** git answers the GitHub remote; every other program is missing. */
class RemoteOnlyRunner implements CommandRunner {
  async run(command: string, args: readonly string[], _options?: CommandOptions) {
    if (/git(\.exe)?$/i.test(command) && args.includes("get-url")) {
      return { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: "not found" } satisfies CommandResult;
  }
}

/** GitHub's runner API with this environment's runner registered but offline. */
function offlineRunnerGitHub(): RunnerGitHubApi {
  return {
    runnerRegistrationToken: async () => fakeSecret("hcloud-token", "cli-status-registration"),
    runnerRemoveToken: async () => fakeSecret("hcloud-token", "cli-status-remove"),
    listRunners: async () => [
      {
        id: 7,
        name: "laptop-shop-dev",
        status: "offline",
        labels: ["self-hosted", "opscrew-shop-dev"],
        version: TOOLS.githubRunner.version,
      },
    ],
    deleteRunner: async () => undefined,
    repositoryVisibility: async () => "private",
    forkPrApprovalPolicy: async () => "first_time_contributors",
    setForkPrApprovalPolicy: async () => undefined,
  };
}

describe("the runner's state in status and secure", () => {
  it("`opscrew status --env dev` shows the local runner offline", async () => {
    project = await withEnvironments({ dev: localPlan("dev", { runner: "local" }) });
    const ctx = projectContext(project, {
      services: {
        runner: new RemoteOnlyRunner(),
        provision: { runnerGitHub: offlineRunnerGitHub() },
      },
    });
    expect(await run(ctx, "status", "--env", "dev"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("Self-hosted runner (opscrew-shop-dev, on this computer):");
    expect(ctx.output).toContain("offline (start it with `opscrew runner start --env dev`)");
  });

  it("`opscrew secure --env dev` warns that the local runner is offline", async () => {
    project = await withEnvironments({ dev: localPlan("dev", { runner: "local" }) });
    const ctx = projectContext(project, {
      services: {
        runner: new RemoteOnlyRunner(),
        secure: {
          runnerGitHub: offlineRunnerGitHub(),
          localhost: { platform: "linux", homedir: path.join(project.dir, "user-home") },
        },
      },
    });
    await run(ctx, "secure", "--env", "dev");
    expect(`${ctx.output}${ctx.errors}`).toContain(
      "GitHub lists the local runner as offline, so the environment's deploy jobs wait.",
    );
  });
});
