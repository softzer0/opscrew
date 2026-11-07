/**
 * The live passes of feature 024 (docs/e2e.md "Snapshots and restores", plan.md 10.), each with
 * its own gate, run id, server and cleanup, on examples/flask-sqlite (its own SQLite file in its
 * `sqlite` volume) with feature 023's Postgres, MySQL and Valkey queue added in plan.yaml. The app
 * is named after the run (`e2e-snap-<run id>`), so its bucket and snapshots are the run's alone:
 * - **data**, with `OPSCREW_E2E_SNAPSHOTS=1`: staging at Hetzner, with Kafka added too. A snapshot
 *   in a script refuses to stop Kafka without `--allow-downtime`; `--skip kafka` stops nothing.
 *   With `--allow-downtime` under load, only Kafka restarts and no request fails (SC-2402). The
 *   data changed, `opscrew restore` puts every service back exactly, the version unchanged
 *   (SC-2401); `--only db` puts back only the database. `snapshot delete` needs the id typed. With
 *   `OPSCREW_E2E_SNAPSHOTS_SCHEDULE=1` too, a schedule at `1h` with `--keep 1`: two scheduled
 *   snapshots on the hour, the first pruned (SC-2403), then `schedule off` removes the crontab line.
 * - **the off-server copy**, with `OPSCREW_E2E_SNAPSHOTS_OFFSITE=1`, to R2 (`OPSCREW_E2E_R2=1`)
 *   and to Hetzner Object Storage (its S3 key): turned on before provision; a snapshot by hand is in
 *   the bucket as age files only, none readable (SC-2404, SC-2406). The server destroyed and
 *   provisioned again empty, `restore <id> --from offsite --key-file` puts the data back. The test
 *   deletes the bucket itself at the end: OpsCrew leaves that to the user.
 * - **a whole server**, with `OPSCREW_E2E_SNAPSHOTS_SERVER=1`: `snapshot --server` while the app
 *   serves, `restore --server` rebuilds it: the same server and address, its protection back, the
 *   SQLite value of the snapshot's time, and the app answers (SC-2405).
 * - **your Portainer**, with `OPSCREW_E2E_SNAPSHOTS_PORTAINER=1`: a Portainer set up as the user's
 *   on a throwaway server, a snapshot by hand under load and a restore through its API (SC-2401),
 *   then v2 over v1 and `rollback --database snapshot` back to v1 on its snapshot's data (US7).
 * Each pass ends with the leak search over every output, commit, pull request, audit entry, plan,
 * state file and deploy log, with every value the test wrote searched for, and no server address
 * in a snapshot, restore or rollback output (SC-2406).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { backupsBucketName } from "@opscrew/agents";
import { appDir, OFFSITE_LOG, portainerDeployBranch } from "@opscrew/iac-templates";
import { snapshotOffsiteOf, snapshotsOn, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { underLoad } from "./builder-checks";
import { httpRequest, minutes, waitFor } from "./cloud";
import { bucketPass, readValue, serverContainers, writeValue } from "./component-checks";
import { type StorageChoice, storageChoice } from "./components-support";
import { AppEnvironments, designProd, opscrewUntilApproved } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { deployBranchImage, repoInfo } from "./portainer-cloud";
import { portainerAnswers } from "./portainer-support";
import {
  execOn,
  expectProjectGone,
  type PortainerHost,
  setUpPortainer,
} from "./retarget-anywhere-checks";
import { composeProjectOf, inContainer, MOVE_SERVICES } from "./retarget-anywhere-support";
import { shownRollback } from "./rollback-support";
import {
  ageKeysOnServer,
  approvedRestore,
  BackupsBucket,
  changeData,
  type DeployRun,
  deployLogLeaks,
  designRunApp,
  hetznerImageExists,
  hetznerServer,
  listSnapshots,
  offsiteLogTail,
  readData,
  removeServerSnapshots,
  restoredMark,
  seedData,
  snapshotOf,
  waitForVersion,
} from "./snapshots-checks";
import {
  addressesInSnapshotOutputs,
  bucketObjectProblems,
  changeScripts,
  differingServices,
  KAFKA_SERVICE,
  kafkaMessages,
  type ListedSnapshot,
  OFFSITE_GATE,
  type OffsiteProvider,
  objectContentProblems,
  offsiteKey,
  onTheHour,
  PORTAINER_GATE,
  PORTAINER_VARIABLES,
  restartedServices,
  SCHEDULE_GATE,
  SERVER_GATE,
  SNAPSHOT_EXAMPLE,
  SNAPSHOT_VARIABLES,
  SNAPSHOTS_GATE,
  type SnapshotData,
  servicesIn,
  takenSnapshotId,
  withSnapshotServices,
  writtenValues,
} from "./snapshots-support";
import { deployRunProblem, missingVariables } from "./support";
import { requireDocker } from "./tls-checks";

const ENV = process.env;
const SETTINGS = { ...serverSettings(ENV), app: SNAPSHOT_EXAMPLE };
/** The data pass's environment, as the spec's independent tests name it. */
const STAGING = "staging";
const GHCR_READ_TOKEN = ENV.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";

const MISSING = {
  data: missingVariables(ENV, SNAPSHOTS_GATE, SNAPSHOT_VARIABLES),
  offsite: missingVariables(ENV, OFFSITE_GATE, SNAPSHOT_VARIABLES),
  server: missingVariables(ENV, SERVER_GATE, SNAPSHOT_VARIABLES),
  portainer: missingVariables(ENV, PORTAINER_GATE, PORTAINER_VARIABLES),
};
for (const [gate, missing] of [
  [SNAPSHOTS_GATE, MISSING.data],
  [OFFSITE_GATE, MISSING.offsite],
  [SERVER_GATE, MISSING.server],
  [PORTAINER_GATE, MISSING.portainer],
] as const) {
  if (ENV[gate] === "1" && missing.length > 0) {
    console.warn(
      `OpsCrew E2E (${gate}): skipped, set ${missing.join(", ")} (see docs/e2e.md, "Snapshots and restores").`,
    );
  }
}

/** The sorted names a listed data snapshot must copy, for the services a pass added. */
const COPIED = (kafka: boolean) =>
  [...Object.values(MOVE_SERVICES), "sqlite", ...(kafka ? [KAFKA_SERVICE] : [])].sort();

/** The app's address for a health URL: its `scheme://host`. */
const originOf = (url: string) => new URL(url).origin;

/** Every value the test writes into a service, searched for as a dumped value (FR-2409). */
function rememberDumped(run: LiveRun, values: readonly string[]): void {
  for (const value of values) run.scrubber.add(value, "dumped-value");
}

/**
 * The leak search of every pass: as for environments, then no address in its snapshot outputs,
 * then the deploy job's log of each of `deployRuns`.
 */
async function snapshotLeaks(
  run: LiveRun,
  envs: AppEnvironments,
  deployRuns: readonly DeployRun[] = [],
): Promise<string[]> {
  const addresses = run.scrubber.entries().filter(({ label }) => label.startsWith("server-"));
  return [
    ...(await envs.leaks({ cloudflare: true })),
    ...addressesInSnapshotOutputs(run.outputs, addresses),
    ...(await deployLogLeaks(run, deployRuns)),
  ];
}

/**
 * The start of each Hetzner pass: the throwaway repository prepared (`commit` its message) with
 * the Hetzner and Cloudflare tokens, GitHub's snapshot for the cleanup, prod designed and the app
 * named after the run.
 */
async function startPass(run: LiveRun, envs: AppEnvironments, commit: string): Promise<void> {
  await run.prepareRepo({
    commit,
    env: { HCLOUD_TOKEN: SETTINGS.hcloudToken, CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
  });
  await envs.snapshotGithub();
  await designProd(run, envs, SETTINGS.region);
  await designRunApp(run, envs);
}

// ---------------------------------------------------------------------------------------------
// The data pass: staging at Hetzner.

describe.skipIf(MISSING.data.length > 0)(
  MISSING.data.length > 0
    ? `live snapshots, data (skipped: set ${MISSING.data.join(", ")}; see docs/e2e.md)`
    : `live snapshots, data: examples/${SNAPSHOT_EXAMPLE} with Postgres, MySQL, a Valkey queue and Kafka on staging at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "snapshots, data",
      name: "snapshots",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    const env = ["--env", STAGING];
    const value = `value-${run.runId}`;
    const changed = `value-${run.runId}-changed`;
    const kafkaSeeded = kafkaMessages(run.runId, "a", 5);
    const kafkaAdded = kafkaMessages(run.runId, "b", 3);
    const changeMarker = `changed-${run.runId}`;
    const onlyMarker = `only-${run.runId}`;
    rememberDumped(run, [
      value,
      changed,
      ...kafkaSeeded,
      ...kafkaAdded,
      ...writtenValues([run.runId], [changeMarker, onlyMarker]),
    ]);
    let workflow = "";
    let health = "";
    let project = "";
    let version = "";
    let seeded: SnapshotData | undefined;
    /** The snapshot taken with Kafka stopped, which the restores put back. */
    let taken = "";
    const deployRuns: DeployRun[] = [];
    const exec = async () => execOn(await envs.shell(STAGING));
    const data = () => seeded as SnapshotData;

    /** Provision staging until done, then its deploy run (provision must open a pull request). */
    async function provisionAndDeploy(what: string): Promise<void> {
      await envs.provision(STAGING, what);
      const id = await run.deploy(what, [workflow]);
      if (id === undefined)
        throw new Error(`${what}: provision opened no deploy-setup pull request.`);
      deployRuns.push({ what, id });
      await run.waitForHealth(minutes(10), true, health);
    }

    /** The deploy user's crontab line of staging's scheduled snapshots, or `""`. */
    async function crontabLine(): Promise<string> {
      return (await exec())(
        `crontab -l 2> /dev/null | grep -F '# opscrew-snapshots ${envs.app(STAGING)}'; s=$?; [ "$s" -le 1 ]`,
      );
    }

    run.step(
      `1. examples/${SNAPSHOT_EXAMPLE}: prod designed, staging at Hetzner added with Postgres, MySQL, a Valkey queue and Kafka in its plan, provisioned and deployed; rows, jobs, messages and a SQLite value written`,
      minutes(75),
      async () => {
        // Prod is designed, as `env add` starts from it, but never provisioned: only staging runs.
        await startPass(run, envs, `e2e: examples/${SNAPSHOT_EXAMPLE} for snapshots`);
        await run.adaptAndMerge();
        await run.opscrewOk("env", "add", STAGING, "--target", "hetzner", "--from", "main");
        // As a user adds services to staging's plan.yaml; design keeps them.
        const file = envs.paths(STAGING).files.plan;
        await writeArtifact("plan", file, withSnapshotServices(await envs.readPlan(STAGING), true));
        await run.opscrewOk("design", ...env);
        const staging = await envs.designed(STAGING);
        const host = staging.dns.domain;
        if (host === undefined || host === run.appHost) {
          throw new Error("design gave staging no hostname of its own.");
        }
        health = `https://${host}${staging.app.healthPath}`;
        workflow = posix.basename(staging.cicd.workflowPath);
        project = composeProjectOf(staging);
        expect(
          staging.services.filter((service) => service.enabled).map((service) => service.name),
          "the services staging's design kept",
        ).toEqual(expect.arrayContaining([...Object.values(MOVE_SERVICES), KAFKA_SERVICE]));
        expect(staging.storage?.sqlite, "staging's SQLite volume").toBeDefined();
        await provisionAndDeploy("staging's first deploy");
        version = await envs.runningDigest(STAGING);
        await seedData(run, await exec(), project, kafkaSeeded);
        await writeValue(originOf(health), value);
        seeded = await readData(await exec(), project, true);
        log(
          "seeded: rows in Postgres and MySQL, jobs in Valkey, messages in Kafka, a SQLite value",
        );
      },
    );

    run.step(
      "2. opscrew snapshot in a script names Kafka's stop and refuses it without --allow-downtime, taking nothing; --skip kafka takes the rest and stops nothing; snapshot delete needs the id typed (US1, US2)",
      minutes(20),
      async () => {
        const before = await listSnapshots(run, env);
        const refused = await run.opscrew("snapshot", ...env);
        expect(refused.exitCode, `the refusal's exit code:\n${run.tail(refused.output)}`).toBe(1);
        for (const text of [
          "kafka (Apache Kafka)",
          "it stops alone for its copy",
          "seconds to stop cleanly",
          "--allow-downtime",
          "No snapshot was taken.",
        ]) {
          expect(
            refused.output.includes(text),
            `the refusal says "${text}":\n${run.tail(refused.output)}`,
          ).toBe(true);
        }
        expect(
          (await listSnapshots(run, env)).map((snapshot) => snapshot.id),
          "the snapshots after the refusal",
        ).toEqual(before.map((snapshot) => snapshot.id));

        const containers = await serverContainers(await exec());
        const skipped = await run.opscrewOk("snapshot", ...env, "--skip", KAFKA_SERVICE);
        expect(
          restartedServices(containers, await serverContainers(await exec()), project),
          "the services --skip kafka started again",
        ).toEqual([]);
        const id = takenSnapshotId(skipped.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(skipped.output)}`);
        const listed = snapshotOf(await listSnapshots(run, env), id);
        expect(servicesIn(listed), "the services it copied").toEqual(COPIED(false));
        expect(servicesIn(listed, "skipped"), "the services it left out").toEqual([KAFKA_SERVICE]);

        const unconfirmed = await run.opscrew("snapshot", "delete", id, ...env);
        expect(unconfirmed.exitCode, "snapshot delete without --confirm in a script").not.toBe(0);
        snapshotOf(await listSnapshots(run, env), id);
        await run.opscrewOk("snapshot", "delete", id, ...env, "--confirm", id);
        expect(
          (await listSnapshots(run, env)).some((snapshot) => snapshot.id === id),
          "the deleted snapshot is still listed",
        ).toBe(false);
        log(`observed: --skip kafka took ${id} with nothing stopped; it was deleted after its id`);
      },
    );

    run.step(
      "3. opscrew snapshot --allow-downtime under load: every service listed, only Kafka started again, no failed request, the version recorded (SC-2402)",
      minutes(20),
      async () => {
        const containers = await serverContainers(await exec());
        const result = await underLoad([health], "the snapshot", log, () =>
          run.opscrewOk("snapshot", ...env, "--allow-downtime"),
        );
        expect(
          restartedServices(containers, await serverContainers(await exec()), project),
          "the services the snapshot started again",
        ).toEqual([KAFKA_SERVICE]);
        const id = takenSnapshotId(result.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(result.output)}`);
        taken = id;
        const listed = snapshotOf(await listSnapshots(run, env), id);
        expect(listed.kind, "its kind").toBe("manual");
        expect(listed.version, "the version it recorded").toBe(version);
        expect(listed.where, "where it is").toBe("on the app's server");
        expect(servicesIn(listed), "the services it copied").toEqual(COPIED(true));
        log(`observed: ${id} holds ${servicesIn(listed).join(", ")}; only Kafka stopped`);
      },
    );

    run.step(
      "4. the data changed, opscrew restore <id> in a script shows what is lost and puts every service back exactly; the version that runs is unchanged (SC-2401)",
      minutes(30),
      async () => {
        await changeData(await exec(), project, changeMarker, kafkaAdded);
        await writeValue(originOf(health), changed);
        expect(
          differingServices(data(), await readData(await exec(), project, true)),
          "the services whose data changed",
        ).toEqual(Object.keys(data()));
        const restored = await approvedRestore(run, [taken, ...env]);
        expect(restored.confirm, "the name the restore asks to type").toBe(envs.app(STAGING));
        expect(
          restored.shown.includes("What is lost: everything written to"),
          `the approval names what is lost:\n${run.tail(restored.shown)}`,
        ).toBe(true);
        expect(
          restored.applied.output.includes(`Restored the snapshot ${taken} of ${STAGING}`),
          `the result:\n${run.tail(restored.applied.output)}`,
        ).toBe(true);
        await run.waitForHealth(minutes(5), true, health);
        expect(
          differingServices(data(), await readData(await exec(), project, true)),
          "the services whose data differs from the snapshot's after the restore",
        ).toEqual([]);
        await readValue(originOf(health), value);
        expect(await envs.runningDigest(STAGING), "the version after the restore").toBe(version);
        log("observed: every row, job, message and the SQLite value are back; the version stayed");
      },
    );

    run.step(
      "5. restore --only db puts back only the database: MySQL keeps its change (US3)",
      minutes(20),
      async () => {
        const changes = changeScripts(onlyMarker);
        const shell = await exec();
        await shell(inContainer(project, MOVE_SERVICES.postgres, changes.postgres));
        await shell(inContainer(project, MOVE_SERVICES.mysql, changes.mysql));
        await approvedRestore(run, [taken, ...env, "--only", MOVE_SERVICES.postgres]);
        await run.waitForHealth(minutes(5), true, health);
        expect(
          differingServices(data(), await readData(await exec(), project, true)),
          "the services that differ from the snapshot after restore --only db",
        ).toEqual(["mysql"]);
      },
    );

    const scheduleSkip =
      ENV[SCHEDULE_GATE] === "1"
        ? {}
        : { skip: `set ${SCHEDULE_GATE}=1 for the schedule's steps (about two hours more)` };
    /** The first scheduled snapshot, then the one after it. */
    let firstScheduled: ListedSnapshot | undefined;

    /** Waits up to 70 minutes for a scheduled snapshot that is not `known`. */
    function nextScheduled(known: readonly string[]): Promise<ListedSnapshot> {
      return waitFor(
        "a scheduled snapshot",
        minutes(70),
        async () =>
          (await listSnapshots(run, env)).find(
            (snapshot) => snapshot.kind === "scheduled" && !known.includes(snapshot.id),
          ),
        minutes(5),
      );
    }

    run.step(
      "S1. snapshot schedule on --every 1h --keep 1, provision and deploy: the crontab line, and a scheduled snapshot on the hour without Kafka (SC-2403)",
      minutes(110),
      async () => {
        await run.opscrewOk("snapshot", "schedule", "on", ...env, "--every", "1h", "--keep", "1");
        await provisionAndDeploy("the schedule turned on");
        expect(await crontabLine(), "the deploy user's crontab line").not.toBe("");
        const first = await nextScheduled([]);
        firstScheduled = first;
        expect(onTheHour(first.taken), `${first.id} taken on the hour (${first.taken})`).toBe(true);
        expect(servicesIn(first), "the scheduled snapshot's services").toEqual(COPIED(false));
        expect(servicesIn(first, "skipped"), "left out unless named in --stop").toEqual([
          KAFKA_SERVICE,
        ]);
        log(`observed: the scheduled snapshot ${first.id}`);
      },
      scheduleSkip,
    );

    run.step(
      "S2. the next scheduled snapshot an hour later prunes the first (--keep 1); the snapshot by hand stays; status names the last one (SC-2403)",
      minutes(80),
      async () => {
        const first = firstScheduled as ListedSnapshot;
        const second = await nextScheduled([first.id]);
        expect(onTheHour(second.taken), `${second.id} taken on the hour`).toBe(true);
        const hours = (Date.parse(second.taken) - Date.parse(first.taken)) / minutes(60);
        expect(Math.round(hours), "hours between the two scheduled snapshots").toBe(1);
        // The prune follows the second's take: wait until only the second is listed.
        const listed = await waitFor(
          "the first scheduled snapshot pruned (--keep 1)",
          minutes(10),
          async () => {
            const now = await listSnapshots(run, env);
            const kept = now.filter((snapshot) => snapshot.kind === "scheduled");
            return kept.length === 1 && kept[0]?.id === second.id ? now : undefined;
          },
          30_000,
        );
        snapshotOf(listed, taken);
        const status = await run.opscrewOk("status", ...env);
        expect(
          status.output.includes(`Last snapshot: ${second.id}, scheduled`),
          `status names the last snapshot:\n${run.tail(status.output)}`,
        ).toBe(true);
      },
      scheduleSkip,
    );

    run.step(
      "S3. snapshot schedule off, provision and deploy: the crontab line is gone and the scheduled snapshot stays (US5)",
      minutes(60),
      async () => {
        await run.opscrewOk("snapshot", "schedule", "off", ...env);
        await provisionAndDeploy("the schedule turned off");
        expect(await crontabLine(), "the deploy user's crontab line").toBe("");
        expect(
          (await listSnapshots(run, env)).some((snapshot) => snapshot.kind === "scheduled"),
          "a scheduled snapshot is still listed",
        ).toBe(true);
      },
      scheduleSkip,
    );

    run.step(
      "6. destroy leaves nothing at Hetzner, in Cloudflare or at GitHub",
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
      "7. no password, dumped value or server address in any output, deploy job's log, audit entry, commit, pull request, plan or state file (SC-2406)",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await snapshotLeaks(run, envs, deployRuns));
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

// ---------------------------------------------------------------------------------------------
// The off-server copy: to R2, and to Hetzner Object Storage.

for (const provider of ["r2", "hetzner"] as const satisfies readonly OffsiteProvider[]) {
  const storage = storageChoice(ENV, provider);
  const missing = [...MISSING.offsite, ...("skip" in storage ? [storage.skip] : [])];
  const where = provider === "r2" ? "Cloudflare R2" : "Hetzner Object Storage";

  describe.skipIf(missing.length > 0)(
    missing.length > 0
      ? `live snapshots, off-server copy to ${where} (skipped: ${missing.join("; ")}; see docs/e2e.md)`
      : `live snapshots, off-server copy to ${where}: examples/${SNAPSHOT_EXAMPLE} at Hetzner, destroyed and restored from the bucket`,
    () => {
      const run: LiveRun = new LiveRun({
        label: `snapshots, off-server to ${provider}`,
        name: `snapshots-${provider}`,
        settings: SETTINGS,
        afterCli: () => envs.rememberServers(),
      });
      const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
      const { log } = run;
      const value = `value-${run.runId}`;
      rememberDumped(run, [value, ...writtenValues([run.runId], [])]);
      const deployRuns: DeployRun[] = [];
      let ageKey = "";
      let site = "";
      let project = "";
      let seeded: SnapshotData | undefined;
      let bucket: BackupsBucket | undefined;
      let taken: ListedSnapshot | undefined;
      const exec = async () => execOn(await envs.shell());
      const copy = () => taken as ListedSnapshot;

      run.step(
        `O1. snapshot offsite on --to ${provider}, then provision and the first deploy: the bucket <app>-prod-backups, the recovery key; the data seeded`,
        minutes(75),
        async () => {
          await requireDocker(
            "This pass reads the off-server bucket with rclone, which this test runs from its pinned image in Docker on this computer",
          );
          await startPass(run, envs, `e2e: examples/${SNAPSHOT_EXAMPLE} for the off-server copy`);
          await writeArtifact(
            "plan",
            run.paths().files.plan,
            withSnapshotServices(await run.readPlan(), false),
          );
          await run.opscrewOk("design");
          await run.adaptAndMerge();
          // The bucket's key, as the components pass gets one, as OpsCrew reads it in a script.
          const pass = await bucketPass(
            {
              app: SNAPSHOT_EXAMPLE,
              searchEngine: false,
              // The pass runs only when the choice had no skip.
              storage: storage as StorageChoice,
            },
            SETTINGS.cloudflareToken,
            SETTINGS.domain,
          );
          if (pass === undefined || "skip" in pass) {
            throw new Error(`The bucket's key: ${pass?.skip ?? "none"}.`);
          }
          const { key, env: keyEnv } = offsiteKey(pass.env);
          for (const [name, secret] of Object.entries(keyEnv)) run.scrubber.add(secret, name);
          Object.assign(run.env, keyEnv);
          // The recovery copy's first key goes to a file of the test's own, its copy to a folder
          // (a public repository gets no committed copy in a script).
          const copies = join(run.work, "copies");
          await mkdir(copies, { recursive: true });
          await run.opscrewOk("secrets", "folder", copies);
          ageKey = join(run.work, "age-key.txt");
          run.provisionFlags = ["--key-out", ageKey];

          const on = await run.opscrewOk("snapshot", "offsite", "on", "--to", provider);
          expect(
            on.output.includes("Expected cost:"),
            `snapshot offsite on shows the bucket's expected cost:\n${run.tail(on.output)}`,
          ).toBe(true);
          const plan = await run.readPlan();
          const offsite = snapshotOffsiteOf(plan);
          expect(offsite?.provider, "the plan's off-server copy").toBe(provider);
          expect(offsite?.bucket, "the copies' bucket").toBe(backupsBucketName(plan));
          const zone = run.zone;
          if (offsite === undefined || zone === undefined) {
            throw new Error("The pass needs the off-server copy and the run's Cloudflare zone.");
          }
          // The bucket must be this run's own: the cleanup deletes it, and only it.
          const planned = new BackupsBucket(
            run,
            pass,
            provider,
            offsite.bucket,
            offsite.region,
            key,
            zone.accountId,
          );
          if (await planned.exists()) {
            throw new Error(
              `A bucket named ${offsite.bucket} is already there; this test would take it over. Delete it (in ${where}, emptied first), then run the test again.`,
            );
          }
          bucket = planned;
          await envs.provision("prod", "prod with the off-server copy");
          expect(
            await run.rememberSecretFile(ageKey, "age-identity"),
            "provision wrote the recovery copy's age key to --key-out",
          ).toBe(true);
          expect(await planned.exists(), `the bucket ${offsite.bucket} after provision`).toBe(true);
          deployRuns.push({
            what: "the first deploy",
            id: await run.deployAny("the first deploy"),
          });
          await run.waitForHealth();
          site = `https://${run.appHost}`;
          project = composeProjectOf(plan);
          await seedData(run, await exec(), project);
          await writeValue(site, value);
          seeded = await readData(await exec(), project, false);
        },
      );

      run.step(
        "O2. a snapshot by hand is copied off the server: in the bucket as age files only, one per part and its record, none holding a known value; the server holds no age key (SC-2404, SC-2406)",
        minutes(30),
        async () => {
          const result = await run.opscrewOk("snapshot");
          const id = takenSnapshotId(result.output);
          if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(result.output)}`);
          taken = await waitFor(
            `the snapshot ${id} copied off the server`,
            minutes(10),
            async () => {
              const listed = snapshotOf(await listSnapshots(run), id);
              return listed.offsite ? listed : undefined;
            },
            30_000,
          ).catch(async (error: unknown) => {
            // What the snapshot said, and the upload's own log on the server, both scrubbed.
            const dir = appDir(await run.readPlan());
            const log = await offsiteLogTail(await exec(), dir).catch(
              (failure: unknown) => `The log was not read: ${String(failure)}`,
            );
            throw new Error(
              `${String(error)}\nopscrew snapshot printed:\n${run.tail(result.output)}\nThe server's ${dir}/${OFFSITE_LOG}, its last lines:\n${run.tail(log)}`,
            );
          });
          expect(servicesIn(copy()), "the services it copied").toEqual(COPIED(false));
          const store = bucket as BackupsBucket;
          // Some of Hetzner's nodes do not know a new bucket for about 15 minutes, and answer that
          // it is not there: each read is tried again until it holds the copy.
          const objects = await waitFor(
            `the copy ${id} in the bucket`,
            minutes(5),
            async () => {
              const listed = await store.objects();
              const wrong = bucketObjectProblems(listed, id, servicesIn(copy()).length);
              if (wrong.length > 0) throw new Error(wrong.join(" "));
              return listed;
            },
            15_000,
          );
          const known = run.scrubber.entries().filter(({ label }) => !label.startsWith("server-"));
          const problems: string[] = [];
          for (const object of objects.filter((path) => path.startsWith(`${id}/`))) {
            const text = await waitFor(
              `${object} read`,
              minutes(5),
              () => store.read(object),
              15_000,
            );
            problems.push(...objectContentProblems(object, text, known));
          }
          expect(problems, "the copy's objects").toEqual([]);
          expect(
            await ageKeysOnServer(await exec(), appDir(await run.readPlan())),
            "age private keys on the server",
          ).toEqual([]);
          log(`observed: ${objects.length} objects in the bucket, every one an age file`);
        },
      );

      run.step(
        "O3. destroy, then provision and deploy again: the server is empty, the bucket keeps the copy, and snapshot list --key-file shows it only there",
        minutes(90),
        async () => {
          await envs.destroy("prod");
          await envs.expectNothingLeft("prod");
          expect(await (bucket as BackupsBucket).exists(), "the bucket after destroy").toBe(true);
          // Provisioned again: the cleanup's destroy covers the new server too.
          envs.destroyed.delete("prod");
          run.destroyed = false;
          await envs.provision("prod", "prod again, empty");
          deployRuns.push({
            what: "the deploy on the new server",
            id: await run.deployAny("the deploy on the new server"),
          });
          await run.waitForHealth();
          expect((await httpRequest(`${site}/data`)).status, "GET /data on the new server").toBe(
            404,
          );
          const listed = snapshotOf(await listSnapshots(run, ["--key-file", ageKey]), copy().id);
          expect(listed.where, "where the copy is").toContain("only in the off-server bucket");
          expect(servicesIn(listed), "the copy's services, read with the key").toEqual(
            COPIED(false),
          );
        },
      );

      run.step(
        "O4. restore <id> --from offsite --key-file: decrypted on this computer and sent to the server, every row, job and the SQLite value back (SC-2404, US6)",
        minutes(30),
        async () => {
          const args = [copy().id, "--from", "offsite", "--key-file", ageKey];
          const running = await envs.runningDigest();
          if (copy().version !== running) {
            // The new server runs a new build: the restore names the rollback, or the data alone.
            const refused = await run.opscrew("restore", ...args);
            expect(refused.exitCode, "the restore of another version's snapshot").not.toBe(0);
            for (const text of ["was taken while another version ran", "--allow-other-version"]) {
              expect(
                refused.output.includes(text),
                `the refusal says "${text}":\n${run.tail(refused.output)}`,
              ).toBe(true);
            }
            args.push("--allow-other-version");
          }
          const restored = await approvedRestore(run, args);
          expect(restored.confirm, "the name the restore asks to type").toBe(run.app());
          expect(
            restored.shown.includes("the key never leaves this computer"),
            `the approval says the key stays here:\n${run.tail(restored.shown)}`,
          ).toBe(true);
          await run.waitForHealth(minutes(5));
          expect(
            differingServices(seeded as SnapshotData, await readData(await exec(), project, false)),
            "the services whose data differs from the copy's after the restore",
          ).toEqual([]);
          await readValue(site, value);
          log("observed: the copy off the server put every row, job and the SQLite value back");
        },
      );

      run.step(
        "O5. destroy leaves nothing at Hetzner or in Cloudflare; then the test deletes the bucket, as the guide tells the user",
        minutes(30),
        async () => {
          await envs.destroy("prod");
          await envs.expectNothingLeft("prod");
          await run.expectCloudflareClean();
          expect(await (bucket as BackupsBucket).exists(), "the bucket after destroy").toBe(true);
          await (bucket as BackupsBucket).remove();
        },
      );

      run.step(
        "O6. no secret, key, dumped value or server address in any output, deploy job's log, audit entry, commit, pull request, plan or state file (SC-2406)",
        minutes(10),
        async () => {
          // Also after a provision that failed past writing the key: it is searched for.
          if (ageKey !== "") await run.rememberSecretFile(ageKey, "age-identity");
          run.expectNothingLeaked(await snapshotLeaks(run, envs, deployRuns));
        },
        { always: true },
      );

      envs.registerCleanup({
        // The cleanup's messages are scrubbed of the age key too.
        first: () => {
          if (ageKey !== "" && existsSync(ageKey)) {
            run.scrubber.add(readFileSync(ageKey, "utf8"), "age-identity");
          }
        },
        last: async (attempt) => {
          const store = bucket;
          if (store !== undefined) {
            await attempt(`delete the off-server bucket ${store.name}`, () => store.remove());
          }
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------------------------
// A whole-server snapshot and the rebuild from it.

describe.skipIf(MISSING.server.length > 0)(
  MISSING.server.length > 0
    ? `live snapshots, whole server (skipped: set ${MISSING.server.join(", ")}; see docs/e2e.md)`
    : `live snapshots, whole server: examples/${SNAPSHOT_EXAMPLE} at Hetzner, rebuilt from its snapshot`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "snapshots, whole server",
      name: "snapshots-server",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    const before = `value-${run.runId}-before`;
    const after = `value-${run.runId}-after`;
    rememberDumped(run, [before, after]);
    let snapshot = "";
    /** The run's server at Hetzner: the cleanup deletes only snapshots taken of it. */
    let serverId: number | undefined;
    const deployRuns: DeployRun[] = [];
    const site = () => `https://${run.appHost}`;

    run.step(
      `W1. examples/${SNAPSHOT_EXAMPLE} at Hetzner: provision, the first deploy, a SQLite value written`,
      minutes(60),
      async () => {
        await startPass(run, envs, `e2e: examples/${SNAPSHOT_EXAMPLE} for a whole-server snapshot`);
        await run.adaptAndMerge();
        await envs.provision("prod", "prod");
        serverId = (await hetznerServer(SETTINGS.hcloudToken, run.app())).id;
        deployRuns.push({
          what: "the first deploy",
          id: await run.deployAny("the first deploy"),
        });
        await run.waitForHealth();
        await writeValue(site(), before);
      },
    );

    run.step(
      "W2. snapshot --server --stop in a script refuses the shutdown without --allow-downtime; snapshot --server under load takes it live, with its price and the volumes not included (US4)",
      minutes(40),
      async () => {
        const refused = await run.opscrew("snapshot", "--server", "--stop");
        expect(refused.exitCode, `the refusal's exit code:\n${run.tail(refused.output)}`).toBe(1);
        expect(
          refused.output.includes("--allow-downtime"),
          `the refusal names --allow-downtime:\n${run.tail(refused.output)}`,
        ).toBe(true);
        await run.waitForHealth(minutes(2));
        const taken = await underLoad([await run.healthUrl()], "the live snapshot", log, () =>
          run.opscrewOk("snapshot", "--server"),
        );
        for (const text of [
          "A live snapshot may not be consistent",
          "are not included",
          "per GB per month",
        ]) {
          expect(
            taken.output.includes(text),
            `the summary says "${text}":\n${run.tail(taken.output)}`,
          ).toBe(true);
        }
        const id = takenSnapshotId(taken.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(taken.output)}`);
        snapshot = id;
        const listed = snapshotOf(await listSnapshots(run), id);
        expect(listed.kind, "its kind").toBe("server");
        expect(listed.server?.name, "its server").toBe(run.app());
        log(`observed: the whole-server snapshot ${id}`);
      },
    );

    run.step(
      "W3. restore --server <id> after the server's name typed: the same server and address, its protection back, the snapshot's SQLite value, the app answers, and drift finds nothing (SC-2405)",
      minutes(40),
      async () => {
        const server = await hetznerServer(SETTINGS.hcloudToken, run.app());
        await writeValue(site(), after);
        const restored = await approvedRestore(run, ["--server", snapshot]);
        expect(restored.confirm, "the name the restore asks to type").toBe(run.app());
        expect(
          restored.applied.output.includes("and the app answers"),
          `the result says the app answers:\n${run.tail(restored.applied.output)}`,
        ).toBe(true);
        expect(
          await hetznerServer(SETTINGS.hcloudToken, run.app()),
          "the server after the rebuild",
        ).toEqual(server);
        await run.waitForHealth();
        await readValue(site(), before);
        const drift = await run.opscrew("drift");
        expect(drift.exitCode, `opscrew drift after the rebuild:\n${run.tail(drift.output)}`).toBe(
          0,
        );
        log("observed: the rebuilt server kept its id, address and protection");
      },
    );

    run.step(
      "W4. snapshot delete <id> --confirm <id> deletes it at Hetzner (US2)",
      minutes(10),
      async () => {
        await run.opscrewOk("snapshot", "delete", snapshot, "--confirm", snapshot);
        expect(
          await hetznerImageExists(SETTINGS.hcloudToken, snapshot),
          "the snapshot at Hetzner",
        ).toBe(false);
      },
    );

    run.step("W5. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
      await envs.destroy("prod");
      await envs.expectNothingLeft("prod");
      await run.expectCloudflareClean();
    });

    run.step(
      "W6. no secret or server address in any output, deploy job's log, audit entry, commit, pull request, plan or state file (SC-2406)",
      minutes(10),
      async () => run.expectNothingLeaked(await snapshotLeaks(run, envs, deployRuns)),
      { always: true },
    );

    envs.registerCleanup({
      last: async (attempt) => {
        if (run.appName === undefined) return;
        const app = run.appName;
        await attempt(`delete this run's whole-server snapshots of ${app}`, () =>
          removeServerSnapshots(SETTINGS.hcloudToken, app, serverId, run.startedAt),
        );
      },
    });
  },
);

// ---------------------------------------------------------------------------------------------
// Your Portainer.

describe.skipIf(MISSING.portainer.length > 0)(
  MISSING.portainer.length > 0
    ? `live snapshots, Portainer (skipped: set ${MISSING.portainer.join(", ")}; see docs/e2e.md)`
    : `live snapshots, Portainer: examples/${SNAPSHOT_EXAMPLE} with Postgres, MySQL and a Valkey queue in your Portainer`,
  () => {
    const repoReadToken = ENV.OPSCREW_E2E_REPO_READ_TOKEN?.trim() ?? "";
    const run: LiveRun = new LiveRun({
      label: "snapshots, Portainer",
      name: "snapshots-portainer",
      settings: SETTINGS,
    });
    const envs = new AppEnvironments(run, "");
    const { log } = run;
    const value = `value-${run.runId}`;
    const changed = `value-${run.runId}-changed`;
    const changeMarker = `changed-${run.runId}`;
    const rollbackMarker = `rollback-${run.runId}`;
    const underV2 = `value-${run.runId}-v2`;
    rememberDumped(run, [
      value,
      changed,
      underV2,
      ...writtenValues([run.runId], [changeMarker, rollbackMarker]),
    ]);
    let portainer: PortainerHost | undefined;
    let project = "";
    let seeded: SnapshotData | undefined;
    let taken = "";
    const site = () => `https://${run.appHost}`;
    const exec = () => execOn(run.shell());

    run.step(
      "P1. a throwaway Hetzner server with Portainer CE: an admin, the local environment and its API key",
      minutes(40),
      async () => {
        run.scrubber.add(GHCR_READ_TOKEN, "OPSCREW_GHCR_READ_TOKEN");
        run.scrubber.add(repoReadToken, "OPSCREW_REPO_READ_TOKEN");
        const repo = await repoInfo(run.github);
        if (repo.private && repoReadToken === "") {
          throw new Error(
            "The throwaway repository is private, so Portainer needs a read-only token for it: set OPSCREW_E2E_REPO_READ_TOKEN (docs/e2e.md).",
          );
        }
        await run.prepareRepo({
          commit: `e2e: examples/${SNAPSHOT_EXAMPLE} for snapshots in your Portainer`,
          env: {
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            OPSCREW_GHCR_READ_TOKEN: GHCR_READ_TOKEN,
            ...(repo.private ? { OPSCREW_REPO_READ_TOKEN: repoReadToken } : {}),
          },
          // OpsCrew gets the Portainer API key once Portainer is set up, never a password.
          drop: ["PORTAINER_API_KEY", ...(repo.private ? [] : ["OPSCREW_REPO_READ_TOKEN"])],
        });
        await envs.snapshotGithub();
        portainer = await setUpPortainer(run);
        run.env.PORTAINER_API_KEY = portainer.token;
      },
    );

    run.step(
      "P2. the app in your Portainer (the updater, the tunnel) with Postgres, MySQL and a Valkey queue: provision, the first deploy, the data seeded",
      minutes(60),
      async () => {
        const host = portainer as PortainerHost;
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        const answers = join(run.work, "answers.json");
        await writeFile(
          answers,
          JSON.stringify(
            portainerAnswers({
              domain: run.appHost,
              url: host.url,
              redeploy: "updater",
              web: "tunnel",
            }),
          ),
        );
        await run.opscrewOk(
          "interview",
          "--answers",
          answers,
          "--portainer-cert",
          host.fingerprint,
        );
        await designRunApp(run, envs);
        // As the guide says to: prod takes a snapshot before each release only with
        // `deploy.snapshots`, which P5's rollback restores.
        const named = withSnapshotServices(await run.readPlan(), false);
        await writeArtifact("plan", run.paths().files.plan, {
          ...named,
          deploy: { ...named.deploy, snapshots: true },
        });
        await run.opscrewOk("design");
        // Design proposes the off-server copy for data that matters in a Portainer; this pass is
        // about snapshots by hand, and the copy has passes of its own.
        await run.opscrewOk("snapshot", "offsite", "off");
        const plan = await envs.designed("prod");
        expect(plan.target.provider, "the plan's target").toBe("portainer");
        expect(snapshotsOn(plan), "prod takes a snapshot before each release").toBe(true);
        await run.adaptAndMerge();
        await run.provisionUntilDone("the app in your Portainer");
        await run.deploy("the first deploy in your Portainer");
        await run.waitForHealth();
        project = composeProjectOf(plan);
        await seedData(run, exec(), project);
        await writeValue(site(), value);
        seeded = await readData(exec(), project, false);
      },
    );

    run.step(
      "P3. opscrew snapshot under load: every service copied in your Portainer while it runs, no failed request, the version recorded (SC-2402)",
      minutes(20),
      async () => {
        const result = await underLoad([await run.healthUrl()], "the snapshot", log, () =>
          run.opscrewOk("snapshot"),
        );
        const id = takenSnapshotId(result.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(result.output)}`);
        taken = id;
        const listed = snapshotOf(await listSnapshots(run), id);
        expect(listed.where, "where it is").toBe("in your Portainer");
        expect(servicesIn(listed), "the services it copied").toEqual(COPIED(false));
        expect(listed.version, "the version it recorded").toMatch(/^sha256:[0-9a-f]{64}$/);
      },
    );

    run.step(
      "P4. the data changed, opscrew restore <id> through Portainer's API puts every service back exactly (SC-2401)",
      minutes(30),
      async () => {
        await changeData(exec(), project, changeMarker);
        await writeValue(site(), changed);
        expect(
          differingServices(seeded as SnapshotData, await readData(exec(), project, false)),
          "the services whose data changed",
        ).toEqual(Object.keys(seeded as SnapshotData));
        const restored = await approvedRestore(run, [taken]);
        expect(restored.confirm, "the name the restore asks to type").toBe(run.app());
        expect(
          restored.applied.output.includes(`Restored the snapshot ${taken}`),
          `the result:\n${run.tail(restored.applied.output)}`,
        ).toBe(true);
        await run.waitForHealth(minutes(5));
        expect(
          differingServices(seeded as SnapshotData, await readData(exec(), project, false)),
          "the services whose data differs from the snapshot's after the restore",
        ).toEqual([]);
        await readValue(site(), value);
        log("observed: every row, job and the SQLite value are back in your Portainer");
      },
    );

    run.step(
      "P5. v2 deployed over v1 takes v1's snapshot; the data changed under v2; opscrew rollback --to <v1> --database snapshot, in a script then with --confirm and --approve: v1 runs on exactly that data, .restored is gone, and rollback --resume --deploy --yes deploys again past the guard (US7)",
      minutes(90),
      async () => {
        const plan = await run.readPlan();
        const branch = portainerDeployBranch(plan);
        // v1: what P2 deployed, its data put back by P4 as seeded.
        const v1 = await deployBranchImage(run.github, branch);
        const v1Commit = await run.git("rev-parse", "HEAD");
        const v2Commit = await run.merge("e2e: v2, over the snapshot of v1's data");
        const done = await run.github.waitForDeploy({ headSha: v2Commit });
        const problem = deployRunProblem(done);
        if (problem !== undefined) throw new Error(`v2's deploy run ${done.id}: ${problem}.`);
        const v2 = await waitFor("the deploy branch naming v2", minutes(10), async () => {
          const image = await deployBranchImage(run.github, branch);
          return image.digest === v1.digest ? undefined : image;
        });
        await waitForVersion(run, v2.version);
        expect(
          (await listSnapshots(run)).some(
            (snapshot) => snapshot.kind === "release" && snapshot.version === `sha256:${v1.digest}`,
          ),
          "the pre-release snapshot of v1's data in the stack's snapshots volume",
        ).toBe(true);

        await changeData(exec(), project, rollbackMarker);
        await writeValue(site(), underV2);
        expect(
          differingServices(seeded as SnapshotData, await readData(exec(), project, false)),
          "the services whose data changed under v2",
        ).toEqual(Object.keys(seeded as SnapshotData));

        const shown = await shownRollback(run, ["--to", v1Commit, "--database", "snapshot"]);
        expect(shown.to, "the version the printed command goes back to: v1's image").toBe(
          `sha256:${v1.digest}`,
        );
        expect(shown.database, "the printed command's --database").toBe("snapshot");
        expect(shown.confirm, "the printed command's --confirm").toBe(run.app());
        expect(
          (await deployBranchImage(run.github, branch)).digest,
          "after a run without --approve",
        ).toBe(v2.digest);
        await run.opscrewOk(
          "rollback",
          "--to",
          shown.to,
          "--database",
          "snapshot",
          "--confirm",
          run.app(),
          "--approve",
          shown.hash,
        );
        expect(
          (await deployBranchImage(run.github, branch)).digest,
          "the image after the rollback",
        ).toBe(v1.digest);
        await waitForVersion(run, v1.version);
        await run.waitForHealth(minutes(5));
        expect(
          differingServices(seeded as SnapshotData, await readData(exec(), project, false)),
          "the services whose data differs from v1's snapshot after the rollback",
        ).toEqual([]);
        await readValue(site(), value);
        expect(await restoredMark(exec(), plan), "/snapshots/.restored after the rollback").toBe(
          false,
        );

        // The next deploy: the guard lets it through, onto the data as it is.
        await run.opscrewOk("rollback", "--resume", "--deploy", "--yes");
        const next = await waitFor(
          "the deploy branch naming another version",
          minutes(15),
          async () => {
            const image = await deployBranchImage(run.github, branch);
            return image.digest === v1.digest ? undefined : image;
          },
        );
        await waitForVersion(run, next.version);
        await run.waitForHealth(minutes(5));
        expect(await restoredMark(exec(), plan), "/snapshots/.restored after the next deploy").toBe(
          false,
        );
        await readValue(site(), value);
        log("observed: the rollback put v1 back on its snapshot's data; the next deploy ran");
      },
    );

    run.step(
      "P6. destroy --delete-data removes the app's stacks and volumes, its snapshots with them, and nothing of the app stays in Cloudflare",
      minutes(30),
      async () => {
        await opscrewUntilApproved(run, ["destroy", "--confirm", run.app(), "--delete-data"]);
        run.destroyed = true;
        await expectProjectGone(exec(), project);
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "P7. no secret, dumped value or address in any output, audit entry, commit, pull request, plan or state file (SC-2406)",
      minutes(10),
      async () => run.expectNothingLeaked(await snapshotLeaks(run, envs)),
      { always: true },
    );

    envs.registerCleanup();
  },
);
