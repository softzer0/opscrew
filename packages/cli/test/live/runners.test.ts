/**
 * The live tests of feature 015's self-hosted runners (docs/e2e.md "The server's runner" and "A
 * runner machine"), each in the Free private throwaway repository with the app's firewall letting
 * SSH in only from this computer (and the runner machine), never from GitHub's Actions ranges:
 * - `OPSCREW_E2E_RUNNER=1`: quickstart "4.", the server's runner on prod's server at Hetzner. The
 *   deploy job runs on it, a merged change goes live, and destroy unregisters it.
 * - `OPSCREW_E2E_RUNNER_HOST=1`: a throwaway Hetzner server, set up as a runner machine as the
 *   user's own server is (root's SSH login, the host key pinned), builds the image (`build:
 *   runner`) and deploys over SSH to prod's server, which OpsCrew creates.
 */
import { runnerLabel, TOOLS } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { minutes, type RepoRunner } from "./cloud";
import {
  AppEnvironments,
  actionsRanges,
  designProd,
  expectNoRunner,
  expectSshClosedToActions,
  jobsOnRunner,
  opscrewUntilApproved,
  TESTER_LABEL,
  waitForRunner,
} from "./environment-checks";
import { ENVIRONMENT_E2E_VARIABLES, overlapping } from "./environments-support";
import { LiveRun, serverSettings } from "./harness";
import { publicIpv4, repoInfo } from "./portainer-cloud";
import { BUILD_JOB, missingVariables } from "./support";

const MISSING = missingVariables(process.env, "OPSCREW_E2E_RUNNER", ENVIRONMENT_E2E_VARIABLES);
const HOST_MISSING = missingVariables(
  process.env,
  "OPSCREW_E2E_RUNNER_HOST",
  ENVIRONMENT_E2E_VARIABLES,
);
const SETTINGS = serverSettings(process.env, "OPSCREW_E2E_RUNNER_HOST_TYPE");
/** The runner machine's name in the project (never its address). */
const MACHINE = "e2e-runner";

for (const [gate, what, missing] of [
  ["OPSCREW_E2E_RUNNER", "the server's runner", MISSING],
  ["OPSCREW_E2E_RUNNER_HOST", "runner machine", HOST_MISSING],
] as const) {
  if (process.env[gate] === "1" && missing.length > 0) {
    console.warn(
      `OpsCrew E2E (${what}): skipped, set ${missing.join(", ")} (see docs/e2e.md, "The server's runner").`,
    );
  }
}

/** An app's runner folder on a server or runner machine (ssh-host's `runnerDir`). */
const runnerDir = (app: string) => `/srv/runners/${app}`;

/**
 * This computer's public IPv4 address as a `/32`, masked as {@link TESTER_LABEL} from now on. It
 * must be outside GitHub's Actions ranges `actions`, or a firewall letting it in would let GitHub's
 * machines in too.
 */
async function testerCidr(run: LiveRun, actions: readonly string[]): Promise<string> {
  const ip = await publicIpv4();
  run.scrubber.add(ip, TESTER_LABEL);
  const cidr = `${ip}/32`;
  if (overlapping([cidr], actions).length > 0) {
    throw new Error(
      "This computer's public address is inside GitHub's Actions ranges, so the firewall cannot keep GitHub's machines out and let this computer in. Run the test from another network.",
    );
  }
  return cidr;
}

/**
 * Stops unless the throwaway repository is private, before any server or plan: OpsCrew refuses a
 * self-hosted runner for a public repository, and these tests commit this computer's address.
 */
async function requirePrivate(run: LiveRun): Promise<void> {
  if (!(await repoInfo(run.github)).private) {
    throw new Error(
      "The runner tests run only on a private repository: OPSCREW_E2E_GITHUB_REPO is public. A self-hosted runner must never serve a public repository, and these tests commit this computer's address to it. Point OPSCREW_E2E_GITHUB_REPO at a private throwaway repository.",
    );
  }
}

/** Changes prod's `opscrew/plan.yaml` with `edit`, as a user edits it after design. */
async function editProdPlan(
  run: LiveRun,
  edit: (plan: DeployPlan) => DeployPlan,
): Promise<DeployPlan> {
  const file = run.paths().files.plan;
  await writeArtifact("plan", file, edit(await readArtifact("plan", file)));
  return run.readPlan();
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live server's runner (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live server's runner: examples/${SETTINGS.app} at Hetzner, the deploy job on the server`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "server's runner",
      name: "runner",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken, { restoreMain: true });
    let actions: string[] = [];
    let allowed: string[] = [];
    let label = "";
    let runner: RepoRunner | undefined;

    /** The jobs of run `id` on the server's runner: some, and never the build. */
    async function expectOnRunner(id: number): Promise<void> {
      const jobs = await jobsOnRunner(run.github, id, runner as RepoRunner, label);
      expect(jobs.length, "jobs that ran on the server's runner").toBeGreaterThan(0);
      expect(jobs.includes(BUILD_JOB), "the production server's runner never builds").toBe(false);
      await expectSshClosedToActions(SETTINGS.hcloudToken, envs.app(), actions, allowed);
    }

    run.step(
      "1. designs prod at Hetzner with the server's runner and SSH only from this computer",
      minutes(20),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} with the server's runner`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
          },
        });
        await requirePrivate(run);
        actions = await actionsRanges(run.github);
        allowed = [await testerCidr(run, actions)];
        await designProd(run, envs, SETTINGS.region);
        const plan = await editProdPlan(run, (plan) => ({
          ...plan,
          environment: {
            deploySource: { from: "main" },
            ...plan.environment,
            runner: "server",
          },
          security: { ...plan.security, sshAllowedCidrs: allowed },
        }));
        label = runnerLabel(plan);
      },
    );

    run.step(
      "2. provisions prod: the host plan installs the pinned runner, which GitHub lists online",
      minutes(45),
      async () => {
        await run.adaptAndMerge();
        const output = await envs.provision("prod", "the server's runner");
        for (const words of [label, TOOLS.githubRunner.version]) {
          expect(output.includes(words), `the host plan names ${words}`).toBe(true);
        }
        runner = await waitForRunner(run.github, label);
        await envs.rememberRunnerCredentials(await envs.shell(), runnerDir(envs.app()));
        await expectSshClosedToActions(SETTINGS.hcloudToken, envs.app(), actions, allowed);
      },
    );

    run.step(
      "3. the first deploy runs on the server's runner while the firewall refuses SSH from GitHub's ranges",
      minutes(45),
      async () => {
        await expectOnRunner(await run.deployAny("the first deploy on the server's runner"));
        await run.waitForHealth();
        await run.opscrewOk("verify");
        const status = await run.opscrewOk("status");
        expect(
          /\bonline\b/.test(status.output) && !/\boffline\b/.test(status.output),
          `status shows the runner online:\n${run.tail(status.output)}`,
        ).toBe(true);
      },
    );

    run.step("4. a merged change deploys on the runner and goes live", minutes(45), async () => {
      await expectOnRunner(await run.mergeChange("e2e: a change deployed by the server's runner"));
      await run.waitForHealth();
    });

    run.step(
      "5. destroy deletes the server and the runner's registration",
      minutes(30),
      async () => {
        await envs.destroy("prod");
        run.destroyed = true;
        await expectNoRunner(run.github, label);
        await envs.expectNothingLeft("prod");
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "6. no secret, runner token or credential, or server address in any output, commit, pull request, audit entry or state file",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await envs.leaks({ cloudflare: true, userCidrs: allowed }));
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

describe.skipIf(HOST_MISSING.length > 0)(
  HOST_MISSING.length > 0
    ? `live runner machine (skipped: set ${HOST_MISSING.join(", ")}; see docs/e2e.md)`
    : `live runner machine: examples/${SETTINGS.app} built on a throwaway runner machine, deployed at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "runner machine",
      name: "host",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken, { restoreMain: true });
    let fingerprint = "";
    let actions: string[] = [];
    let allowed: string[] = [];
    let label = "";
    let runner: RepoRunner | undefined;

    run.step(
      "1. creates a throwaway Hetzner server outside OpsCrew for the runner machine, and designs prod",
      minutes(30),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} built on a runner machine`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
          },
        });
        await requirePrivate(run);
        actions = await actionsRanges(run.github);
        fingerprint = await run.createServer();
        const machine = `${run.ipv4()}/32`;
        expect(
          overlapping([machine], actions).length,
          "the runner machine's address inside GitHub's Actions ranges",
        ).toBe(0);
        allowed = [await testerCidr(run, actions), machine];
        await designProd(run, envs, SETTINGS.region);
      },
    );

    run.step(
      "2. sets the server up as a runner machine, its host plan approved by its hash",
      minutes(30),
      async () => {
        await opscrewUntilApproved(run, [
          "runner",
          "host",
          "add",
          MACHINE,
          "--ssh",
          `root@${run.ipv4()}`,
          "--key",
          run.keyFile,
          "--host-key",
          fingerprint,
        ]);
        const listed = (await run.opscrewOk("runner", "host", "list")).stdout;
        expect(listed.includes(MACHINE), `runner host list shows ${MACHINE}`).toBe(true);
        await run.shell().ok("id -u deploy && docker version --format '{{.Server.Version}}'");
      },
    );

    run.step(
      "3. moves prod's build and deploy jobs to the runner machine, SSH only from it and this computer, and provisions prod",
      minutes(45),
      async () => {
        await run.opscrewOk(
          "env",
          "set",
          "prod",
          "--from",
          "main",
          "--runner",
          "host",
          "--runner-host",
          MACHINE,
          "--build",
          "runner",
        );
        const plan = await editProdPlan(run, (plan) => ({
          ...plan,
          security: { ...plan.security, sshAllowedCidrs: allowed },
        }));
        expect(plan.environment, "prod's runner").toMatchObject({
          runner: "host",
          runnerHost: { name: MACHINE },
          build: "runner",
        });
        label = runnerLabel(plan);
        await run.adaptAndMerge();
        await envs.provision("prod", "prod on the runner machine");
        runner = await waitForRunner(run.github, label);
        await envs.rememberRunnerCredentials(run.shell(), runnerDir(envs.app()));
        await expectSshClosedToActions(SETTINGS.hcloudToken, envs.app(), actions, allowed);
      },
    );

    run.step(
      "4. the first deploy builds the image on the runner machine and deploys over SSH while prod's server refuses GitHub's ranges",
      minutes(60),
      async () => {
        const id = await run.deployAny("the first deploy from the runner machine");
        const jobs = await jobsOnRunner(run.github, id, runner as RepoRunner, label);
        expect(jobs.includes(BUILD_JOB), "the build job ran on the runner machine").toBe(true);
        expect(
          jobs.length,
          "the build job and the deploy job on the runner machine",
        ).toBeGreaterThan(1);
        await expectSshClosedToActions(SETTINGS.hcloudToken, envs.app(), actions, allowed);
        await run.waitForHealth();
        await run.opscrewOk("verify");
      },
    );

    run.step(
      "5. destroy removes the runner from the machine and GitHub; then the machine leaves the project",
      minutes(30),
      async () => {
        await envs.destroy("prod");
        run.destroyed = true;
        await expectNoRunner(run.github, label);
        await envs.expectNothingLeft("prod");
        await run.expectCloudflareClean();
        const folder = await run.shell().run(`test -e ${runnerDir(envs.app())}`);
        expect(folder.exitCode, "the app's runner folder is gone from the machine").not.toBe(0);
        await opscrewUntilApproved(run, [
          "runner",
          "host",
          "remove",
          MACHINE,
          "--confirm",
          MACHINE,
        ]);
        const listed = (await run.opscrewOk("runner", "host", "list")).stdout;
        expect(listed.includes(MACHINE), `runner host list no longer shows ${MACHINE}`).toBe(false);
      },
    );

    run.step(
      "6. no secret, runner token or credential, or server address in any output, commit, pull request, audit entry or state file",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await envs.leaks({ cloudflare: true, userCidrs: allowed }));
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);
