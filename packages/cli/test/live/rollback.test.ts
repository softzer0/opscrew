/**
 * The live tests of feature 019 (docs/e2e.md "Rollback", plan.md "9." and "12.7"):
 * - the image pass, with `OPSCREW_E2E_ROLLBACK=1`: `examples/nextjs-postgres` on one server at
 *   Hetzner behind Cloudflare, with the test's own release command. Two versions deploy (A, then
 *   B); `opscrew rollback` in a script shows the rollback to A and changes nothing, then
 *   `--approve <hash>` puts A back under load, with no build and no release command, timed from
 *   the approval (SC-1901). While paused a push (C) builds but doesn't deploy (SC-1902); `--list`
 *   shows the versions and `--to` a commit never built is refused (SC-1903); `--resume --deploy
 *   --yes` makes C live. A change whose new version never answers fails, C keeps running and
 *   `logs --failed` shows the copy's lines (SC-1904); it is reverted. Then destroy, and the leak
 *   search (SC-1905).
 * - the database pass, with `OPSCREW_E2E_ROLLBACK_DATABASE=1` (US8): `examples/koa-knex` on
 *   staging at Hetzner, where snapshots are on by default. v1 deploys and the test writes rows;
 *   v2, whose migration adds a column, deploys and the test writes more. The rollback with the
 *   snapshot gives v1 the database of the moment v2 deployed, timed from the approval (SC-1907);
 *   `--resume --deploy` brings v2 and its column back; the rollback with down migrations drops the
 *   column and keeps the rows. A rollback dispatched by hand, without the one-time approval on the
 *   server, changes no data (SC-1909). Then destroy, and the leak search over the outputs, the
 *   workflow logs and the audit entries.
 *
 * With both gates, the passes run one after the other in the same throwaway repository.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  appDir,
  checkEnvironmentKey,
  DEPLOY_PAUSED_VARIABLE,
  ROLLBACK_APPROVAL_FILE,
  snapshotTakenPath,
} from "@opscrew/iac-templates";
import { snapshotsOn, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { underLoad } from "./builder-checks";
import { minutes, waitFor } from "./cloud";
import { AppEnvironments, designProd } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { jobLog } from "./portainer-cloud";
import {
  COLUMNS_SQL,
  DATABASE_EXAMPLE,
  insertRowsSql,
  jobTimes,
  LABELS_SQL,
  listedVersions,
  NOTE_COLUMN,
  NOTE_MIGRATION,
  neverAnswering,
  PAUSED_JOB,
  pauseEntryOf,
  psqlLines,
  RELEASE_COMMAND,
  RELEASE_MARKER,
  ROLLBACK_DATABASE_GATE,
  ROLLBACK_GATE,
  ROLLBACK_VARIABLES,
  ROWS_MIGRATION,
  type RollbackApproval,
  rollbackDispatchInputs,
  rowLabels,
  runIdIn,
  SC_1901_MS,
  SC_1907_MS,
  shownRollback,
  statusDeploys,
} from "./rollback-support";
import { psql } from "./split-checks";
import {
  BUILD_JOB,
  type DeployJob,
  deployRunProblem,
  duration,
  leakedLabels,
  missingVariables,
  SERVER_DEPLOY_JOB,
} from "./support";

const MISSING = missingVariables(process.env, ROLLBACK_GATE, ROLLBACK_VARIABLES);
const MISSING_DATABASE = missingVariables(process.env, ROLLBACK_DATABASE_GATE, ROLLBACK_VARIABLES);
/** The default example: its release command and its health route are what the test checks. */
const SETTINGS = { ...serverSettings(process.env), app: "nextjs-postgres" };
/** The database pass's example: Knex migrations on PostgreSQL. */
const DATABASE_SETTINGS = { ...serverSettings(process.env), app: DATABASE_EXAMPLE };
/** The classic `read:packages` token OpsCrew reads the versions from GHCR with (docs/e2e.md). */
const GHCR_READ_TOKEN = process.env.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";
/** The database pass's environment: snapshots are on by default everywhere but prod. */
const STAGING = "staging";

for (const [gate, missing, what] of [
  [ROLLBACK_GATE, MISSING, "rollback"],
  [ROLLBACK_DATABASE_GATE, MISSING_DATABASE, "rollback, database"],
] as const) {
  if (process.env[gate] === "1" && missing.length > 0) {
    console.warn(
      `OpsCrew E2E (${what}): skipped, set ${missing.join(", ")} (see docs/e2e.md, "Rollback").`,
    );
  }
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

/**
 * The leak search reads outputs for secrets only; a rollback's output names no server address
 * either (its approvals, refusals and list, and what it read on the server): the problems found.
 */
function addressesInRollbacks(run: LiveRun): string[] {
  const addresses = run.scrubber.entries().filter(({ label }) => label.startsWith("server-"));
  const problems: string[] = [];
  for (const [label, output] of run.outputs) {
    if (!label.includes("opscrew rollback")) continue;
    const found = leakedLabels(output, addresses);
    if (found.length > 0) problems.push(`the output of ${label} contains: ${found.join(", ")}`);
  }
  return problems;
}

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
        log(
          `observed: the rollback run: ${jobTimes(jobs, started) ?? "GitHub lists no job started"}`,
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
        C.commit = await run.merge("e2e: change C, pushed while paused");
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
          resumed.output.includes(`prod runs ${short(C.commit)} (`),
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
        const broken = await run.merge(
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

        const reverted = await run.merge(
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
        const problems = [
          ...(await envs.leaks({ cloudflare: true })),
          ...addressesInRollbacks(run),
        ];
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

    envs.registerCleanup();
  },
);

describe.skipIf(MISSING_DATABASE.length > 0)(
  MISSING_DATABASE.length > 0
    ? `live rollback, database (skipped: set ${MISSING_DATABASE.join(", ")}; see docs/e2e.md)`
    : `live rollback, database: examples/${DATABASE_EXAMPLE} on staging at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "rollback, database",
      name: "rollback-db",
      settings: DATABASE_SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, DATABASE_SETTINGS.hcloudToken);
    const { log } = run;
    const v1: Deployed = { commit: "", digest: "" };
    const v2: Deployed = { commit: "", digest: "" };
    /** The digest of v2 deployed again by `--resume --deploy`: v2's commit, built again. */
    let v2AgainDigest = "";
    /** The value v2's rows have in the column v2's migration adds. */
    const note = `e2e-note-${run.runId}`;
    /** The labels the test's table must hold now, in the order written. */
    let rows: string[] = [];
    /** The labels the table held when v2 deployed: the snapshot's. */
    let atV2: string[] = [];
    /** Staging's deploy workflow (`opscrew-deploy-staging.yml`) and its health URL. */
    let workflow = "";
    let health = "";
    /** The deploy runs whose deploy job's log the leak search reads. */
    const deployRuns: { what: string; id: number }[] = [];

    /** Runs `text` in staging's PostgreSQL as the app's login; the values it printed. */
    async function sql(text: string): Promise<string[]> {
      const plan = await envs.readPlan(STAGING);
      return psqlLines(await psql(await envs.shell(STAGING), plan, text));
    }

    /** The test's table now: its columns and its rows' labels. */
    async function table(): Promise<{ columns: string[]; labels: string[] }> {
      return { columns: await sql(COLUMNS_SQL), labels: await sql(LABELS_SQL) };
    }

    /**
     * Writes three rows of the batch `batch` (with `note` in v2's column when `withNote`) and adds
     * them to the rows expected; each value is a dumped value the leak search looks for.
     */
    async function writeRows(batch: string, withNote: boolean): Promise<void> {
      const labels = rowLabels(run.runId, batch, 3);
      for (const label of labels) run.scrubber.add(label, "dumped-value");
      if (withNote) run.scrubber.add(note, "dumped-value");
      await sql(insertRowsSql(labels, withNote ? note : undefined));
      rows = [...rows, ...labels];
    }

    /** Whether `path`, in staging's app folder, exists on its server. */
    async function onServer(path: string): Promise<boolean> {
      const dir = appDir(await envs.readPlan(STAGING));
      const shell = await envs.shell(STAGING);
      return (
        (await shell.ok(`if [ -e ${dir}/${path} ]; then echo yes; else echo no; fi`)) === "yes"
      );
    }

    /**
     * Shows the rollback to v1 with `--database <choice>` as a script runs it, which changes
     * nothing (`running` still runs); checks the command it prints names v1, the choice and the
     * name `destroy --env` asks for, and that the approval says `says`.
     */
    async function shownDatabaseRollback(choice: string, says: readonly string[], running: string) {
      const shown = await shownRollback(run, [
        "--env",
        STAGING,
        "--to",
        v1.commit,
        "--database",
        choice,
      ]);
      expect(shown.to, "the version the printed command goes back to: v1's image").toBe(v1.digest);
      expect(shown.database, "the printed command's --database").toBe(choice);
      expect(
        shown.confirm,
        "the printed command's --confirm: the name destroy --env asks for",
      ).toBe(envs.app(STAGING));
      expect(
        says.every((text) => shown.output.includes(text)),
        `the approval says ${says.map((text) => `"${text}"`).join(" and ")}:\n${run.tail(shown.output)}`,
      ).toBe(true);
      expect(await envs.runningDigest(STAGING), "the image after a run without --approve").toBe(
        running,
      );
      expect(
        await onServer(ROLLBACK_APPROVAL_FILE),
        "a one-time approval on the server after a run without --approve",
      ).toBe(false);
      return shown;
    }

    /**
     * Applies a rollback `shown` printed (`--approve <hash>` with its `--database` and
     * `--confirm`); returns its output and how long it took from the approval. Its run joins the
     * leak search's.
     */
    async function applyRollback(
      shown: RollbackApproval,
    ): Promise<{ output: string; took: number }> {
      const { to, hash, database, confirm } = shown;
      if (database === undefined || confirm === undefined) {
        throw new Error("The printed command gives no --database or no --confirm.");
      }
      const started = Date.now();
      const applied = await run.opscrew(
        "rollback",
        "--env",
        STAGING,
        "--to",
        to,
        "--database",
        database,
        "--confirm",
        confirm,
        "--approve",
        hash,
      );
      const took = Date.now() - started;
      const runId = runIdIn(applied.output);
      // Before the exit code: a failed rollback's deploy job log is leak-searched too.
      if (runId !== undefined) {
        deployRuns.push({ what: `the rollback with --database ${database}`, id: runId });
      }
      if (applied.exitCode !== 0) {
        throw new Error(
          `opscrew rollback --database ${database} exited with ${applied.exitCode}:\n${run.tail(applied.output)}`,
        );
      }
      if (runId === undefined) {
        throw new Error(`The rollback named no workflow run:\n${run.tail(applied.output)}`);
      }
      const times =
        jobTimes(await run.github.jobs(runId), started) ?? "GitHub lists no job started";
      log(
        `observed: the rollback with --database ${database} succeeded ${duration(took)} after its approval; ${times}`,
      );
      expect(await envs.runningDigest(STAGING), "the image after the rollback").toBe(v1.digest);
      expect(
        await onServer(ROLLBACK_APPROVAL_FILE),
        "the one-time approval on the server after the rollback used it",
      ).toBe(false);
      await run.waitForHealth(minutes(2), true, health);
      return { output: applied.output, took };
    }

    run.step(
      `D1. examples/${DATABASE_EXAMPLE} with the test's table (in the throwaway copy only): prod designed, staging at Hetzner added with snapshots on and Knex's down migrations in its plan, provisioned and deployed (v1); rows written`,
      minutes(75),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${DATABASE_EXAMPLE} for the rollback's database`,
          env: {
            HCLOUD_TOKEN: DATABASE_SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: DATABASE_SETTINGS.cloudflareToken,
            OPSCREW_GHCR_READ_TOKEN: GHCR_READ_TOKEN,
          },
          files: { [ROWS_MIGRATION.path]: ROWS_MIGRATION.text },
        });
        run.scrubber.add(GHCR_READ_TOKEN, "ghcr-read-token");
        await envs.snapshotGithub();
        // Prod is designed, as `env add` starts from it, but never provisioned: only staging runs.
        await designProd(run, envs, DATABASE_SETTINGS.region);
        await run.adaptAndMerge();
        await run.opscrewOk("env", "add", STAGING, "--target", "hetzner", "--from", "main");
        const staging = await envs.designed(STAGING);
        const host = staging.dns.domain;
        if (host === undefined || host === run.appHost) {
          throw new Error("design gave staging no hostname of its own.");
        }
        health = `https://${host}${staging.app.healthPath}`;
        workflow = posix.basename(staging.cicd.workflowPath);
        expect(snapshotsOn(staging), "staging takes snapshots (on by default outside prod)").toBe(
          true,
        );
        expect(staging.app.migrations?.tool, "staging's app.migrations").toBe("knex");
        await envs.provision(STAGING, "staging");
        const first = await run.deploy("v1, staging's first deploy", [workflow]);
        if (first === undefined) {
          throw new Error("staging's provision opened no deploy-setup pull request.");
        }
        deployRuns.push({ what: "v1's deploy", id: first });
        await run.waitForHealth(minutes(10), true, health);
        v1.commit = await run.git("rev-parse", "HEAD");
        v1.digest = await envs.runningDigest(STAGING);
        expect(await table(), "the test's table after v1's deploy").toEqual({
          columns: ["id", "label"],
          labels: [],
        });
        await writeRows("a", false);
        log(`observed: v1 is ${short(v1.commit)}; ${rows.length} rows written`);
      },
    );

    run.step(
      "D2. v2, whose migration adds a column, merged and deployed: the column is there and the rows unchanged; more rows written",
      minutes(45),
      async () => {
        atV2 = [...rows];
        v2.commit = await run.merge(
          "e2e: v2 adds a column",
          NOTE_MIGRATION.path,
          NOTE_MIGRATION.text,
        );
        const done = await run.github.waitForDeploy({ headSha: v2.commit, workflow });
        const problem = deployRunProblem(done);
        if (problem !== undefined) {
          throw new Error(`v2's deploy run ${done.id} did not deploy: ${problem}.`);
        }
        deployRuns.push({ what: "v2's deploy", id: done.id });
        await run.waitForHealth(minutes(10), true, health);
        v2.digest = await envs.runningDigest(STAGING);
        expect(v2.digest, "v2's image").not.toBe(v1.digest);
        expect(await table(), "the test's table after v2's deploy").toEqual({
          columns: ["id", "label", NOTE_COLUMN],
          labels: atV2,
        });
        await writeRows("b", true);
        log(`observed: v2 is ${short(v2.commit)}; ${rows.length} rows in the table`);
      },
    );

    run.step(
      "D3. opscrew rollback --database snapshot in a script shows the restore and changes nothing; with --approve <hash> and the typed name, v1 runs with the database of the moment v2 deployed, without v2's column, within 5 minutes of the approval (SC-1907)",
      minutes(30),
      async () => {
        const shown = await shownDatabaseRollback(
          "snapshot",
          ["Restore the snapshot taken", "Everything written since is lost."],
          v2.digest,
        );
        const { output, took } = await applyRollback(shown);
        if (took > SC_1907_MS) {
          run.findings.push(
            `SC-1907: the rollback with the snapshot took ${duration(took)} from its approval, over ${duration(SC_1907_MS)}`,
          );
        }
        expect(
          output.includes("The database was restored from the snapshot taken"),
          `the result says the database was restored:\n${run.tail(output)}`,
        ).toBe(true);
        expect(
          await table(),
          "the test's table after the rollback with the snapshot: v1's columns and the rows of the moment v2 deployed",
        ).toEqual({ columns: ["id", "label"], labels: atV2 });
        log(
          `observed: the snapshot gave v1 back its ${atV2.length} rows; the ${rows.length - atV2.length} written since v2 deployed are gone`,
        );
        rows = [...atV2];
      },
    );

    run.step(
      "D4. rollback --resume --deploy --yes deploys v2 again: its release command adds the column back; more rows written",
      minutes(45),
      async () => {
        const resumed = await run.opscrew(
          "rollback",
          "--env",
          STAGING,
          "--resume",
          "--deploy",
          "--yes",
        );
        const runId = runIdIn(resumed.output);
        // Before the exit code: a failed deploy's job log is leak-searched too.
        if (runId !== undefined) deployRuns.push({ what: "the resume's deploy", id: runId });
        if (resumed.exitCode !== 0) {
          throw new Error(
            `opscrew rollback --resume --deploy exited with ${resumed.exitCode}:\n${run.tail(resumed.output)}`,
          );
        }
        expect(
          resumed.output.includes(`${STAGING} runs ${short(v2.commit)} (`),
          `the resume deployed v2's commit:\n${run.tail(resumed.output)}`,
        ).toBe(true);
        if (runId === undefined) {
          throw new Error(`The resume named no workflow run:\n${run.tail(resumed.output)}`);
        }
        await run.waitForHealth(minutes(10), true, health);
        v2AgainDigest = await envs.runningDigest(STAGING);
        expect(v2AgainDigest, "the image after --resume --deploy").not.toBe(v1.digest);
        expect(await table(), "the test's table after v2's release command ran again").toEqual({
          columns: ["id", "label", NOTE_COLUMN],
          labels: rows,
        });
        await writeRows("c", true);
        log(`observed: v2 runs again; ${rows.length} rows in the table`);
      },
    );

    run.step(
      "D5. the rollback to v1 with --database migrations: Knex's down migration drops v2's column and every row stays (SC-1907)",
      minutes(30),
      async () => {
        const shown = await shownDatabaseRollback(
          "migrations",
          ["Migrate it down with knex", "dropped, with their data."],
          v2AgainDigest,
        );
        const { output } = await applyRollback(shown);
        expect(
          output.includes("The database was migrated down with knex"),
          `the result says the database was migrated down:\n${run.tail(output)}`,
        ).toBe(true);
        expect(
          await table(),
          "the test's table after the down migrations: v1's columns and every row",
        ).toEqual({ columns: ["id", "label"], labels: rows });
        log(`observed: the down migration dropped ${NOTE_COLUMN} and kept ${rows.length} rows`);
      },
    );

    run.step(
      "D6. the deploy workflow's rollback dispatched by hand with GitHub's API, as opscrew rollback does but with no one-time approval on the server, switches the image and changes no data (SC-1909)",
      minutes(45),
      async () => {
        const plan = await envs.readPlan(STAGING);
        const before = await table();
        expect(
          await onServer(ROLLBACK_APPROVAL_FILE),
          "a one-time approval on the server before the hand-made dispatch",
        ).toBe(false);
        // The rollback before took it when v2 stopped running: an approval would restore it.
        expect(
          await onServer(snapshotTakenPath(v2AgainDigest.replace(/^sha256:/, ""))),
          "a complete snapshot of v2's running image on the server",
        ).toBe(true);
        await run.checkoutMain();
        const head = await run.git("rev-parse", "HEAD");
        const since = new Date();
        const started = await run.github.call(
          "POST",
          `/repos/${run.github.name}/actions/workflows/${workflow}/dispatches`,
          {
            ref: plan.cicd.branch,
            inputs: rollbackDispatchInputs(v2AgainDigest, v2.commit, STAGING),
          },
        );
        if (started.status !== 204) {
          throw new Error(`GitHub did not start ${workflow} (HTTP ${started.status}).`);
        }
        const done = await run.github.waitForDeploy({
          headSha: head,
          event: "workflow_dispatch",
          since,
          workflow,
        });
        deployRuns.push({ what: "the rollback dispatched by hand", id: done.id });
        const problem = deployRunProblem(done);
        if (problem !== undefined) {
          throw new Error(
            `The rollback dispatched by hand (run ${done.id}) did not deploy: ${problem}.`,
          );
        }
        expect(
          conclusionOf(done.jobs, BUILD_JOB) ?? "skipped",
          `the build job of run ${done.id}`,
        ).toBe("skipped");
        expect(
          await envs.runningDigest(STAGING),
          "the image after the hand-made dispatch: v2's, run against today's data",
        ).toBe(v2AgainDigest);
        expect(await table(), "the test's table after the hand-made dispatch").toEqual(before);
        await run.waitForHealth(minutes(2), true, health);
        log(
          `observed: the hand-made dispatch (run ${done.id}) switched to v2 and left the ${before.labels.length} rows and the columns as they were`,
        );
      },
    );

    run.step(
      "D7. destroy leaves nothing at Hetzner, in Cloudflare or at GitHub",
      minutes(30),
      async () => {
        const secrets = await envs.expectSecretsPlaced(STAGING);
        await envs.destroy(STAGING);
        await envs.expectNothingLeft(STAGING);
        await envs.expectSecretsGone(STAGING, secrets);
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "D8. no database password, dumped value or server address in any output, deploy job's log, audit entry, commit, pull request, plan or state file (SC-1909)",
      minutes(10),
      async () => {
        const problems = [
          ...(await envs.leaks({ cloudflare: true })),
          ...addressesInRollbacks(run),
        ];
        // The workflow logs: the deploy job dumps and restores. GitHub masks only its own secrets.
        const secrets = run.scrubber.entries().filter(({ label }) => !label.startsWith("server-"));
        for (const { what, id } of deployRuns) {
          const text = await jobLog(run.github, id, SERVER_DEPLOY_JOB).catch((error: Error) => {
            problems.push(
              `the deploy job's log of ${what} (run ${id}) is unreadable: ${error.message}`,
            );
            return "";
          });
          const found = leakedLabels(text, secrets);
          if (found.length > 0) {
            problems.push(
              `the deploy job's log of ${what} (run ${id}) contains: ${found.join(", ")}`,
            );
          }
        }
        log(`observed: the leak search read the deploy job's log of ${deployRuns.length} runs`);
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);
