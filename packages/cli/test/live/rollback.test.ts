/**
 * The live test of feature 019 (docs/e2e.md "Rollback", plan.md "9."), with
 * `OPSCREW_E2E_ROLLBACK=1`: `examples/nextjs-postgres` on one server at Hetzner behind Cloudflare,
 * with the test's own release command. Two versions deploy (A, then B); `opscrew rollback` in a
 * script shows the rollback to A and changes nothing, then `--approve <hash>` puts A back under
 * load, with no build and no release command, timed from the approval (SC-1901). While paused a
 * push (C) builds but doesn't deploy (SC-1902); `--list` shows the versions and `--to` a commit
 * never built is refused (SC-1903); `--resume --deploy --yes` makes C live. A change whose new
 * version never answers fails, C keeps running and `logs --failed` shows the copy's lines
 * (SC-1904); it is reverted. Then destroy, and the leak search (SC-1905).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appDir, checkEnvironmentKey, DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { underLoad } from "./builder-checks";
import { minutes, waitFor } from "./cloud";
import { AppEnvironments, designProd } from "./environment-checks";
import { CHANGE_FILE, LiveRun, serverSettings } from "./harness";
import { jobLog } from "./portainer-cloud";
import {
  listedVersions,
  neverAnswering,
  PAUSED_JOB,
  pauseEntryOf,
  RELEASE_COMMAND,
  RELEASE_MARKER,
  ROLLBACK_GATE,
  ROLLBACK_VARIABLES,
  runIdIn,
  SC_1901_MS,
  shownRollback,
  statusDeploys,
} from "./rollback-support";
import { clearDeployPause } from "./split-checks";
import {
  BUILD_JOB,
  type DeployJob,
  duration,
  leakedLabels,
  missingVariables,
  SERVER_DEPLOY_JOB,
} from "./support";

const MISSING = missingVariables(process.env, ROLLBACK_GATE, ROLLBACK_VARIABLES);
/** The default example: its release command and its health route are what the test checks. */
const SETTINGS = { ...serverSettings(process.env), app: "nextjs-postgres" };
/** The classic `read:packages` token OpsCrew reads the versions from GHCR with (docs/e2e.md). */
const GHCR_READ_TOKEN = process.env.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";

if (process.env[ROLLBACK_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (rollback): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Rollback").`,
  );
}

/** A deployed version: the commit it was built from and its image's digest. */
interface Deployed {
  commit: string;
  digest: string;
}

const short = (commit: string) => commit.slice(0, 7);

/** The conclusion of the job `name` among a run's jobs (`undefined` when GitHub lists none). */
const conclusionOf = (jobs: readonly DeployJob[], name: string) =>
  jobs.find((job) => job.name === name)?.conclusion;

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live rollback (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live rollback: examples/${SETTINGS.app} at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "rollback",
      name: "rollback",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    const A: Deployed = { commit: "", digest: "" };
    const B: Deployed = { commit: "", digest: "" };
    const C: Deployed = { commit: "", digest: "" };
    /** The app's entry in the deploy pause variable (`<app>/prod`), once designed. */
    let pauseKey: string | undefined;
    /** Every value of the deploy pause variable the test read while paused, for the leak search. */
    const pauseValues: string[] = [];

    /** The variable's value now, kept for the leak search. */
    async function pauseVariable(): Promise<string | undefined> {
      const value = await run.github.variable(DEPLOY_PAUSED_VARIABLE);
      if (value !== undefined) pauseValues.push(value);
      return value;
    }

    /** `release.log` on the server, where the release command's output stays. */
    async function releaseLog(): Promise<string> {
      return `${appDir(await run.readPlan())}/release.log`;
    }

    /** The modification time of `release.log` on the server (seconds since 1970). */
    async function releaseLogModified(): Promise<string> {
      return (await envs.shell()).ok(`stat -c %Y ${await releaseLog()}`);
    }

    /** The commit of the version `rollback --list` marks as running (the `opscrew-prod` label). */
    async function listedRunning(): Promise<string | undefined> {
      const listed = listedVersions((await run.opscrewOk("rollback", "--list")).output);
      return listed.find((row) => row.marks.includes("running"))?.commit;
    }

    /**
     * A change as a user merges one, without waiting for its run: `text` written to `file` (a
     * path in the repository) on a branch of its own, a pull request `title`, and its merge.
     * Returns the merge commit; `main` is checked out again.
     */
    async function mergeEdit(title: string, file: string, text: string): Promise<string> {
      const branch = `e2e/change-${run.runId}-${Date.now().toString(36)}`;
      await run.git("checkout", "-q", "-b", branch);
      await writeFile(join(run.repo, file), text);
      await run.git("add", file);
      await run.git("commit", "-q", "-m", title);
      await run.git("push", "-q", "-u", "origin", branch);
      const number = await run.github.createPullRequest(title, branch);
      log(`merging the change #${number} (${title})`);
      const sha = await run.github.merge(number);
      await run.checkoutMain();
      return sha;
    }

    run.step(
      "1. examples/nextjs-postgres at Hetzner with the test's release command: provision and the first deploy (A), then a merged change (B)",
      minutes(75),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} for rollback`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            OPSCREW_GHCR_READ_TOKEN: GHCR_READ_TOKEN,
          },
        });
        run.scrubber.add(GHCR_READ_TOKEN, "ghcr-read-token");
        await envs.snapshotGithub();
        const designed = await designProd(run, envs, SETTINGS.region);
        // As a user sets it in opscrew/plan.yaml: no example has a release command.
        await writeArtifact("plan", run.paths().files.plan, {
          ...designed,
          app: { ...designed.app, releaseCommand: RELEASE_COMMAND },
        });
        pauseKey = checkEnvironmentKey(await run.readPlan());
        await run.adaptAndMerge();
        await envs.provision("prod", "prod");
        await run.deployAny("the first deploy (A)");
        await run.waitForHealth();
        A.commit = await run.git("rev-parse", "HEAD");
        A.digest = await envs.runningDigest();
        await run.mergeChange("e2e: change B");
        await run.waitForHealth();
        B.commit = await run.git("rev-parse", "HEAD");
        B.digest = await envs.runningDigest();
        expect(B.digest, "B's image").not.toBe(A.digest);
        const released = await (await envs.shell()).ok(`cat ${await releaseLog()}`);
        expect(
          released.includes(RELEASE_MARKER),
          "release.log holds the release command's output after B's deploy",
        ).toBe(true);
        log(`observed: A is ${short(A.commit)}, B is ${short(B.commit)}`);
      },
    );

    run.step(
      "2. opscrew rollback in a script shows the rollback to A and changes nothing; with --approve <hash> under load, A runs with no failed request, no build and no release command, and opscrew-prod names it (SC-1901)",
      minutes(30),
      async () => {
        const key = pauseKey as string;
        const releasedAt = await releaseLogModified();
        const shown = await shownRollback(run);
        expect(shown.to, "the version the printed command goes back to: A's image").toBe(A.digest);
        expect(
          shown.now?.startsWith(short(B.commit)) === true &&
            shown.backTo?.startsWith(short(A.commit)) === true,
          `the approval names B as running now and A as the version to go back to:\n${run.tail(shown.output)}`,
        ).toBe(true);
        expect(
          await envs.runningDigest(),
          "the image prod runs after a run without --approve",
        ).toBe(B.digest);
        expect(
          pauseEntryOf(await pauseVariable(), key),
          "prod's deploy pause after a run without --approve",
        ).toBeUndefined();

        let took = 0;
        let started = 0;
        const approved = await underLoad([await run.healthUrl()], "the rollback", log, async () => {
          started = Date.now();
          const result = await run.opscrewOk("rollback", "--to", A.commit, "--approve", shown.hash);
          took = Date.now() - started;
          return result;
        });
        log(
          `observed: the rollback succeeded ${duration(took)} after its approval (SC-1901: at most ${duration(SC_1901_MS)})`,
        );
        if (took > SC_1901_MS) {
          run.findings.push(
            `SC-1901: the rollback took ${duration(took)} from its approval, over ${duration(SC_1901_MS)}`,
          );
        }
        expect(
          await envs.runningDigest(),
          "the image in the server's .env after the rollback",
        ).toBe(A.digest);
        expect(await releaseLogModified(), "release.log's modification time (no release ran)").toBe(
          releasedAt,
        );
        const runId = runIdIn(approved.output);
        if (runId === undefined) {
          throw new Error(`The rollback named no workflow run:\n${run.tail(approved.output)}`);
        }
        const jobs = await run.github.jobs(runId);
        // Where SC-1901's time goes: before the run's first job, then each job.
        const firstStart = Math.min(...jobs.map((job) => Date.parse(job.startedAt ?? "")));
        log(
          `observed: the rollback run's first job started ${duration(firstStart - started)} after the approval; ${jobs
            .filter((job) => job.startedAt && job.completedAt)
            .map(
              (job) =>
                `${job.name} ${duration(Date.parse(job.completedAt as string) - Date.parse(job.startedAt as string))}`,
            )
            .join(", ")}`,
        );
        const build = conclusionOf(jobs, BUILD_JOB);
        expect(build ?? "skipped", `the build job of the rollback run ${runId}`).toBe("skipped");
        expect(
          conclusionOf(jobs, SERVER_DEPLOY_JOB),
          `the deploy job of the rollback run ${runId}`,
        ).toBe("success");
        expect(await listedRunning(), "the version opscrew-prod names (rollback --list)").toBe(
          short(A.commit),
        );
        expect(pauseEntryOf(await pauseVariable(), key), "prod's deploy pause").toMatchObject({
          reason: "rollback",
          commit: A.commit,
          image: A.digest,
        });
        await run.waitForHealth(minutes(2));
      },
    );

    run.step("3. status shows A running and prod's deploys paused", minutes(10), async () => {
      const status = await run.opscrewOk("status");
      const deploys = statusDeploys(status.output);
      expect(
        deploys.running?.startsWith(short(A.commit)) === true &&
          deploys.running.includes(A.digest.slice(0, 19)),
        `status names A as running:\n${run.tail(status.output)}`,
      ).toBe(true);
      expect(
        deploys.paused?.includes(`pinned it to ${short(A.commit)}`) === true,
        `status says the deploys are paused, pinned to A:\n${run.tail(status.output)}`,
      ).toBe(true);
    });

    run.step(
      "4. a push of C while paused builds but doesn't deploy: the deploy job skipped, the paused job's notice there, A still running (SC-1902)",
      minutes(45),
      async () => {
        const title = "e2e: change C, pushed while paused";
        C.commit = await mergeEdit(
          title,
          CHANGE_FILE,
          `${title} (run ${run.runId}, ${new Date().toISOString()}).\n`,
        );
        const done = await run.github.waitForDeploy({ headSha: C.commit });
        expect(conclusionOf(done.jobs, BUILD_JOB), `C's build job (run ${done.id})`).toBe(
          "success",
        );
        expect(conclusionOf(done.jobs, SERVER_DEPLOY_JOB), `C's deploy job (run ${done.id})`).toBe(
          "skipped",
        );
        expect(conclusionOf(done.jobs, PAUSED_JOB), `the paused job (run ${done.id})`).toBe(
          "success",
        );
        // The job writes the same line to the run's summary, which GitHub's API doesn't give.
        const text = await waitFor(`the log of "${PAUSED_JOB}" in run ${done.id}`, minutes(2), () =>
          jobLog(run.github, done.id, PAUSED_JOB),
        );
        expect(
          text.includes(`Deploys of ${pauseKey} are paused since`) &&
            text.includes(`pinned it to ${short(A.commit)}`),
          `the paused job's notice in run ${done.id} names the pause and A`,
        ).toBe(true);
        expect(await envs.runningDigest(), "the image prod runs after C's push").toBe(A.digest);
        await run.waitForHealth(minutes(2));
        log(`observed: C is ${short(C.commit)}; its run ${done.id} built it and did not deploy`);
      },
    );

    run.step(
      "5. rollback --list shows C, B and A, newest first, with A running; --to a commit never built is refused before any change (SC-1903)",
      minutes(15),
      async () => {
        const list = await run.opscrewOk("rollback", "--list");
        const rows = listedVersions(list.output);
        const [c, b, a] = [C, B, A].map((version) =>
          rows.findIndex((row) => row.commit === short(version.commit)),
        ) as [number, number, number];
        expect(
          c >= 0 && b > c && a > b,
          `rollback --list shows C, B and A, newest first:\n${run.tail(list.output)}`,
        ).toBe(true);
        expect(rows[a]?.marks, "A's marks in rollback --list").toContain("running");
        log(`observed: rollback --list shows ${rows.length} versions`);

        const pausedBefore = await pauseVariable();
        // The example's own commit: pushed before the deploy workflow existed, so never built.
        const refused = await run.opscrew("rollback", "--to", run.exampleCommit);
        expect(refused.exitCode, `the refusal's exit code:\n${run.tail(refused.output)}`).toBe(1);
        expect(
          refused.output.includes("is not among prod's versions") &&
            refused.output.includes("Nothing was changed."),
          `the refusal says the commit is not among prod's versions and nothing changed:\n${run.tail(refused.output)}`,
        ).toBe(true);
        expect(await pauseVariable(), "the deploy pause variable after the refusal").toBe(
          pausedBefore,
        );
        expect(await envs.runningDigest(), "the image prod runs after the refusal").toBe(A.digest);
      },
    );

    run.step(
      "6. rollback --resume --deploy --yes turns the deploys back on and makes C live (SC-1902)",
      minutes(45),
      async () => {
        const resumed = await run.opscrewOk("rollback", "--resume", "--deploy", "--yes");
        expect(
          resumed.output.includes(`The deploy run of ${short(C.commit)}`),
          `the resume deployed C:\n${run.tail(resumed.output)}`,
        ).toBe(true);
        expect(
          pauseEntryOf(await run.github.variable(DEPLOY_PAUSED_VARIABLE), pauseKey as string),
          "prod's deploy pause after --resume",
        ).toBeUndefined();
        C.digest = await envs.runningDigest();
        expect(C.digest, "the image prod runs after --resume --deploy").not.toBe(A.digest);
        expect(await listedRunning(), "the version opscrew-prod names (rollback --list)").toBe(
          short(C.commit),
        );
        await run.waitForHealth();
      },
    );

    run.step(
      "7. a change whose new version never answers: the run fails, C keeps running, logs --failed shows the copy's lines (SC-1904); then the change is reverted",
      minutes(75),
      async () => {
        const dockerfile = (await run.readPlan()).app.dockerfile;
        const original = await readFile(join(run.repo, dockerfile), "utf8");
        const marker = `opscrew-e2e-never-answers-${run.runId}`;
        const broken = await mergeEdit(
          "e2e: a version that never answers",
          dockerfile,
          neverAnswering(original, marker),
        );
        const failed = await run.github.waitForDeploy({ headSha: broken });
        expect(failed.conclusion, `the run ${failed.id} of the version that never answers`).toBe(
          "failure",
        );
        expect(
          conclusionOf(failed.jobs, SERVER_DEPLOY_JOB),
          `its deploy job (run ${failed.id})`,
        ).toBe("failure");
        expect(await envs.runningDigest(), "the image prod runs after the failed deploy").toBe(
          C.digest,
        );
        await run.waitForHealth(minutes(2));
        const logs = await run.opscrewOk("logs", "--failed");
        expect(
          logs.output.includes(marker),
          `logs --failed shows the failed copy's lines:\n${run.tail(logs.output)}`,
        ).toBe(true);

        const reverted = await mergeEdit(
          "e2e: revert the version that never answers",
          dockerfile,
          original,
        );
        const fixed = await run.github.waitForDeploy({ headSha: reverted });
        expect(fixed.conclusion, `the run ${fixed.id} of the revert`).toBe("success");
        expect(
          conclusionOf(fixed.jobs, SERVER_DEPLOY_JOB),
          `its deploy job (run ${fixed.id})`,
        ).toBe("success");
        expect(await envs.runningDigest(), "the image prod runs after the revert").not.toBe(
          C.digest,
        );
        await run.waitForHealth();
      },
    );

    run.step(
      "8. destroy leaves nothing at Hetzner, in Cloudflare or at GitHub",
      minutes(30),
      async () => {
        await envs.destroy("prod");
        await envs.expectNothingLeft("prod");
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "9. no secret or server address in any rollback output, approval, audit entry, commit, pull request, plan, state file or the deploy pause variable (SC-1905)",
      minutes(10),
      async () => {
        const problems = await envs.leaks({ cloudflare: true });
        // The leak search reads outputs for secrets only; a rollback's output names no address
        // either (its approvals, refusals and list).
        const addresses = run.scrubber.entries().filter(({ label }) => label.startsWith("server-"));
        for (const [label, output] of run.outputs) {
          if (!label.includes("opscrew rollback")) continue;
          const found = leakedLabels(output, addresses);
          if (found.length > 0)
            problems.push(`the output of ${label} contains: ${found.join(", ")}`);
        }
        for (const [index, value] of pauseValues.entries()) {
          const found = leakedLabels(value, run.scrubber.entries());
          if (found.length > 0) {
            problems.push(
              `the deploy pause variable (read ${index + 1}) contains: ${found.join(", ")}`,
            );
          }
        }
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    // After the harness's cleanup of Cloudflare: prod's entry in the deploy pause variable, which
    // a run stopped between the rollback and --resume leaves behind.
    envs.registerCleanup({
      last: async (attempt) => {
        const key = pauseKey;
        if (key === undefined) return;
        await attempt("clear the deploy pause", () => clearDeployPause(run.github, key));
      },
    });
  },
);
