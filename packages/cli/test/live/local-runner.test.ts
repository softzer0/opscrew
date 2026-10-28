/**
 * The live test of feature 015's local runner (docs/e2e.md "The local runner", quickstart "5.",
 * SC-1507), with `OPSCREW_E2E_LOCAL_RUNNER=1` and Docker on this computer: in the Free private
 * throwaway repository, prod is designed at Hetzner and never provisioned; dev runs on this
 * computer with its deploy job on the local runner, which the test starts in-process with the
 * CLI's deps (on Windows no Ctrl+C reaches another process) and stops with `stop()`. The merge of
 * dev's deploy-setup pull request and a later change are deployed by the runner to the local
 * stack, and the site answers at `https://<app>.localhost` through 127.0.0.1, trusted only with
 * OpsCrew's local CA; this computer's trust store never changes. Docker is touched only through
 * the Compose project labels of dev and OpsCrew's edge, which must be absent before the run.
 */
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { join, posix } from "node:path";
import {
  caFiles,
  type LocalRunner,
  localRoots,
  localSite,
  startLocalRunner,
} from "@opscrew/agents";
import { EDGE_PROJECT, runnerLabel, runtimeDir, TOOLS } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterAll, describe, expect } from "vitest";
import { createPhaseDeps } from "../../src/deps";
import { createTestContext, type TestContext } from "../../src/test-context";
import { docker, imageIds, removeNewImages } from "../e2e/docker-support";
import { minutes, type RepoRunner, waitFor } from "./cloud";
import {
  AppEnvironments,
  designProd,
  expectNoRunner,
  jobsOnRunner,
  opscrewUntilApproved,
  secretsRecord,
  waitForRunner,
} from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { liveRunTarget, logsAndFigures } from "./observability-checks";
import { requestLogFiles } from "./observability-support";
import { repoInfo } from "./portainer-cloud";
import { deployedImage } from "./portainer-support";
import { BUILD_JOB, missingVariables } from "./support";

const GATE = "OPSCREW_E2E_LOCAL_RUNNER";
const MISSING = missingVariables(process.env, GATE, [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
]);
// No domain: dev answers on this computer only, so nothing touches the zone.
const SETTINGS = { ...serverSettings(process.env), domain: "" };
/** Optional: the classic `read:packages` token dev's provision reads GHCR with (docs/e2e.md). */
const GHCR_READ_TOKEN = process.env.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";
const DEV = "dev";
/** SC-1507: a pushed commit answers at the local address within 10 minutes. */
const SC_1507_MS = minutes(10);

if (process.env[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (local runner): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "The local runner").`,
  );
}

/** What Docker lists with one Compose project label. */
interface ComposeResources {
  containers: string[];
  networks: string[];
  volumes: string[];
}

/** The containers, networks and volumes Docker lists with the Compose project label `project`. */
async function composeResources(project: string): Promise<ComposeResources> {
  const list = async (args: string[]) => {
    const listed = await docker([
      ...args,
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    if (listed.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${listed.stderr.trim()}`);
    return listed.stdout.split(/\s+/).filter((name) => name !== "");
  };
  return {
    containers: await list(["ps", "-a", "--format", "{{.Names}}"]),
    networks: await list(["network", "ls", "--format", "{{.Name}}"]),
    volumes: await list(["volume", "ls", "--format", "{{.Name}}"]),
  };
}

/** What a GET to the local stack got: its status, or the error's code. */
type LocalAnswer = { status: number } | { error: string };

/**
 * One HTTPS GET of `path` from `https://<hostname>:<port>` through 127.0.0.1, with the hostname as
 * Host header and SNI (Windows and macOS resolve no `*.localhost` for Node), trusting only the
 * certificate `ca` when given, Node's own roots otherwise.
 */
function localGet(
  site: { hostname: string; port: number },
  path: string,
  ca?: string,
): Promise<LocalAnswer> {
  const host = site.port === 443 ? site.hostname : `${site.hostname}:${site.port}`;
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: site.port,
        path,
        servername: site.hostname,
        headers: { Host: host },
        agent: false,
        timeout: 15_000,
        ...(ca === undefined ? {} : { ca }),
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ error: error.code ?? error.message }),
    );
    req.end();
  });
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live local runner (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live local runner: examples/${SETTINGS.app}, dev on this computer deployed by its runner`,
  () => {
    const run: LiveRun = new LiveRun({ label: "local runner", name: "local", settings: SETTINGS });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken, { restoreMain: true });
    const { log } = run;
    let plan: DeployPlan | undefined;
    let label = "";
    let runner: RepoRunner | undefined;
    let local: LocalRunner | undefined;
    let ctx: TestContext | undefined;
    let images: Set<string> | undefined;
    /** The image digest dev ran after the first deploy on the runner. */
    let firstDigest = "";

    const devPlan = () => plan as DeployPlan;
    /** The Compose projects dev's stack makes on this computer: the app's and OpsCrew's edge. */
    const projects = () => [`opscrew-${envs.app(DEV)}`, EDGE_PROJECT];
    /** The runner's folder in the run's own OpsCrew home (`<home>/runners/<app>-dev`). */
    const runnerDir = () => join(run.paths(DEV).homeDir, "runners", label.slice("opscrew-".length));

    /** The image digest dev's stack runs, from its app folder's `.env` on this computer. */
    async function runningDigest(): Promise<string | undefined> {
      const file = join(localRoots(run.paths(DEV)).apps, envs.app(DEV), ".env");
      return deployedImage(await readFile(file, "utf8").catch(() => ""))?.digest;
    }

    /** dev's `.localhost` site on this computer, and the local CA's certificate that trusts it. */
    async function devSite() {
      const target = devPlan().target;
      if (target.provider !== "localhost") throw new Error("dev's plan is not on this computer.");
      const site = { ...(await localSite(run.paths(DEV), devPlan())), port: target.ports.https };
      return { site, ca: await readFile(caFiles(run.paths(DEV)).certificate, "utf8") };
    }

    /** Waits up to 10 minutes until dev's health route answers 200, trusted with the local CA. */
    async function waitForSite(): Promise<void> {
      const { site, ca } = await devSite();
      const path = devPlan().app.healthPath;
      await waitFor(
        "dev's health route answering 200 at its .localhost address",
        minutes(10),
        async () => {
          const answer = await localGet(site, path, ca);
          if ("status" in answer && answer.status === 200) return true;
          throw new Error(
            `it answered ${"status" in answer ? `HTTP ${answer.status}` : answer.error}`,
          );
        },
      );
      const untrusted = await localGet(site, path);
      expect(
        "error" in untrusted ? untrusted.error : `HTTP ${untrusted.status}`,
        "without the local CA the certificate is refused",
      ).toMatch(/CERT|SIGNATURE|ISSUER/);
      log("observed: dev answers 200 at its .localhost address, trusted only with the local CA");
    }

    /**
     * Waits until GitHub lists the local runner online, then adds the private parts of its key
     * (each session registers with a new one) to the scrubber. On Windows the runner keeps that key
     * encrypted for the user (DPAPI), so no part of it can be in a text.
     */
    async function runnerOnline(): Promise<RepoRunner> {
      const online = await waitForRunner(run.github, label);
      const file = join(runnerDir(), ".credentials_rsaparams");
      await waitFor("the local runner's key file", minutes(2), async () => {
        const text = await readFile(file, "utf8").catch(() => undefined);
        if (text === undefined) return undefined;
        if (envs.rememberRunnerKey(text) > 0) return true;
        // Encrypted bytes, not JSON: they may hold a "{" by chance, so any content counts.
        return process.platform === "win32" ? true : undefined;
      }).catch(() => {
        run.findings.push(
          "the local runner's key file was not readable, so the leak search misses it",
        );
      });
      return online;
    }

    /** The jobs of run `id` on the local runner: some, and never the build. */
    async function expectOnRunner(id: number): Promise<void> {
      const jobs = await jobsOnRunner(run.github, id, runner as RepoRunner, label);
      expect(jobs.length, "jobs that ran on the local runner").toBeGreaterThan(0);
      expect(jobs.includes(BUILD_JOB), "the build ran on GitHub's machines").toBe(false);
      log(
        `observed: run ${id}: ${jobs.join(", ")} on the local runner, the build on GitHub's machines`,
      );
    }

    /** Keeps the runner's output so far (the CLI's reporter, redacted) for the leak search. */
    function keepRunnerOutput(): void {
      if (ctx !== undefined) {
        run.outputs.set("opscrew runner start --env dev (in-process)", ctx.output + ctx.errors);
      }
    }

    async function stopRunner(): Promise<void> {
      await local?.stop();
      keepRunnerOutput();
    }

    run.step(
      "1. designs prod at Hetzner (never provisioned) in the private repository, with Docker here and none of OpsCrew's stacks on it",
      minutes(20),
      async () => {
        const info = await docker(["info", "--format", "{{.ServerVersion}}"]);
        if (info.exitCode !== 0) {
          throw new Error(
            "Docker is not running on this computer (`docker info` failed). Start it, then run the test again.",
          );
        }
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} with the local runner`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            ...(GHCR_READ_TOKEN === "" ? {} : { OPSCREW_GHCR_READ_TOKEN: GHCR_READ_TOKEN }),
          },
          files: requestLogFiles(SETTINGS.app) ?? {},
        });
        run.scrubber.add(GHCR_READ_TOKEN, "ghcr-read-token");
        if (!(await repoInfo(run.github)).private) {
          throw new Error(
            "The local runner test runs only on a private repository: OPSCREW_E2E_GITHUB_REPO is public, and a self-hosted runner must never serve a public repository. Point it at a private throwaway repository.",
          );
        }
        // The cleanup removes only the GitHub environments that appear during the run.
        await envs.snapshotGithub();
        await designProd(run, envs, SETTINGS.region);
      },
    );

    run.step(
      "2. adds dev on this computer with the local runner and provisions it: the local stack runs and dev's deploy-setup pull request is open",
      minutes(45),
      async () => {
        await run.opscrewOk("env", "add", DEV, "--target", "localhost", "--runner", "local");
        const designed = await envs.designed(DEV);
        label = runnerLabel(designed);
        for (const project of projects()) {
          const found = await composeResources(project);
          if (found.containers.length > 0 || found.volumes.length > 0) {
            throw new Error(
              `Docker on this computer already has the Compose project ${project}, which this test would remove. Remove it with \`opscrew destroy\` in its project, then run the test again.`,
            );
          }
        }
        // As a user edits the plan: the local runner deploys the image GitHub Actions built.
        const file = run.paths(DEV).files.plan;
        if (designed.target.provider === "localhost" && designed.target.image !== "registry") {
          await writeArtifact("plan", file, {
            ...designed,
            target: { ...designed.target, image: "registry" },
          });
        }
        plan = await readArtifact("plan", file);
        expect(plan.environment?.runner, "dev's deploy job runs on").toBe("local");
        expect(plan.target, "dev's target").toMatchObject({
          provider: "localhost",
          image: "registry",
        });
        images = await imageIds();
        await run.adaptAndMerge();
        await envs.provision(DEV, "dev on this computer");
        await envs.rememberLocalCa();
        plan = await run.readPlan(DEV);
        const { containers } = await composeResources(projects()[0] as string);
        expect(containers.length, "containers of dev's stack running here").toBeGreaterThan(0);
      },
    );

    run.step(
      "3. starts the local runner; the merge of dev's deploy-setup pull request deploys on it, and the site answers locally",
      minutes(45),
      async () => {
        ctx = createTestContext({ cwd: run.repo, env: run.env });
        local = await startLocalRunner(createPhaseDeps(ctx, { ai: false, environment: DEV }), {
          environment: DEV,
        });
        local.finished.catch((error: unknown) => {
          log(
            `the local runner stopped: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        runner = await runnerOnline();
        log("observed: GitHub lists the local runner online with dev's label");
        const workflow = posix.basename(devPlan().cicd.workflowPath);
        const id = await run.deploy("dev's first deploy on the local runner", [workflow]);
        if (id === undefined)
          throw new Error("dev's provision opened no deploy-setup pull request.");
        await expectOnRunner(id);
        await waitForSite();
        firstDigest = (await runningDigest()) ?? "";
        expect(firstDigest, "the image dev's stack runs").not.toBe("");
      },
    );

    run.step(
      "4. a merged change is deployed by the local runner and answers locally within 10 minutes (SC-1507)",
      minutes(45),
      async () => {
        runner = await runnerOnline();
        const workflow = posix.basename(devPlan().cicd.workflowPath);
        const started = Date.now();
        await expectOnRunner(
          await run.mergeChange("e2e: a change deployed by the local runner", [workflow]),
        );
        await waitFor("dev running the change's image", minutes(10), async () => {
          const digest = await runningDigest();
          return digest !== undefined && digest !== firstDigest ? digest : undefined;
        });
        await waitForSite();
        const took = Date.now() - started;
        log(`observed: the change answered locally ${Math.round(took / 1000)} s after its push`);
        expect(
          took,
          "from the change's merge to the new version answering (ms)",
        ).toBeLessThanOrEqual(SC_1507_MS);
      },
    );

    run.step(
      "4b. logs from local Docker: the latest lines within 10 seconds, a request's line in logs --follow within 10 seconds of it, then Ctrl+C; status: the figures (SC-1701)",
      minutes(10),
      async () => {
        const { site, ca } = await devSite();
        await logsAndFigures(liveRunTarget(run), {
          args: ["--env", DEV],
          ...(requestLogFiles(SETTINGS.app) === undefined
            ? {}
            : { request: (path: string) => localGet(site, path, ca) }),
          figures: "local",
        });
      },
    );

    run.step(
      "5. stop() ends the runner: GitHub lists no runner with dev's label, and its folder stays",
      minutes(10),
      async () => {
        await runnerOnline();
        const stopping = local as LocalRunner;
        await stopRunner();
        await expect(stopping.finished, "the runner's end").resolves.toBeUndefined();
        local = undefined;
        await expectNoRunner(run.github, label);
        const marker = await readFile(join(runnerDir(), ".opscrew-version"), "utf8");
        expect(marker.trim(), "the pinned runner kept in its folder").toBe(
          TOOLS.githubRunner.version,
        );
      },
    );

    run.step(
      "6. destroy --env dev removes the local stack and its GitHub secrets: nothing of it is left in Docker or at GitHub",
      minutes(20),
      async () => {
        // The local runner's provision stored dev's deploy secrets; the destroy removes them all.
        const record = await secretsRecord(run.paths(DEV));
        expect(record, "dev's record of the deploy secrets its provision stored").toBeDefined();
        await opscrewUntilApproved(run, [
          "destroy",
          "--env",
          DEV,
          "--confirm",
          envs.app(DEV),
          "--delete-data",
        ]);
        envs.destroyed.add(DEV);
        for (const project of projects()) {
          expect(await composeResources(project), `Docker's ${project} after the destroy`).toEqual({
            containers: [],
            networks: [],
            volumes: [],
          });
        }
        if (record !== undefined) await envs.expectSecretsGone(DEV, record);
      },
    );

    run.step(
      "7. no secret, runner token or credential, generated value or local CA key in any output, commit, pull request, audit entry or state file",
      minutes(10),
      async () => {
        keepRunnerOutput();
        run.expectNothingLeaked(await envs.leaks({ cloudflare: false }));
      },
      { always: true },
    );

    envs.registerCleanup();
    // Registered after the harness's cleanup, so it runs before it: the runner stops before
    // anything is destroyed, and dev's stack goes before the run's folder does.
    afterAll(async () => {
      const problems: string[] = [];
      const attempt = async (what: string, body: () => Promise<unknown>) => {
        try {
          await body();
        } catch (error) {
          problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await attempt("stop the local runner", stopRunner);
      // Set only after Docker had none of the run's Compose projects: what is left is the run's.
      const before = images;
      if (before !== undefined) {
        if (envs.provisioned.has(DEV) && !envs.destroyed.has(DEV)) {
          log("dev was not destroyed: running opscrew destroy first");
          await attempt("destroy dev", async () => {
            await opscrewUntilApproved(
              run,
              ["destroy", "--env", DEV, "--confirm", envs.app(DEV), "--delete-data"],
              (...args) => run.opscrewWithin(minutes(4), ...args),
            );
            envs.destroyed.add(DEV);
          });
        }
        for (const project of projects()) {
          await attempt(`remove what is left of ${project} in Docker`, async () => {
            const left = await composeResources(project);
            if (left.containers.length > 0) await docker(["rm", "-f", ...left.containers]);
            for (const network of left.networks) await docker(["network", "rm", network]);
            if (left.volumes.length > 0) await docker(["volume", "rm", "-f", ...left.volumes]);
          });
        }
        await attempt("remove the images this run pulled", async () => {
          // GHCR's images of the app, and the ones dev's first provision may build here (FR-1540).
          const refs = [
            `ghcr.io/${SETTINGS.githubRepo.toLowerCase()}`,
            `opscrew-local/${envs.app(DEV)}`,
          ];
          for (const name of ["compose.yaml", "edge/compose.yaml"]) {
            const file = join(run.repo, runtimeDir(devPlan()), name);
            const text = await readFile(file, "utf8").catch(() => "");
            for (const [, ref] of text.matchAll(/^\s+image: (\S+)$/gm)) {
              if (ref !== undefined && !ref.includes("$")) refs.push(ref);
            }
          }
          await removeNewImages(before, refs);
        });
      }
      if (problems.length > 0) {
        throw run.cleanError(
          new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`),
        );
      }
    }, minutes(15));
  },
);
