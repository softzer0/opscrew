/**
 * What feature 024's live passes (`snapshots.test.ts`) need on top of the harness that reaches
 * servers, providers or GitHub:
 * - the example's data seeded, changed and read in the containers of the app's target;
 * - `opscrew snapshot list --json` and `opscrew restore` as a script runs them;
 * - the app named after the run, so every resource and the bucket are the run's own;
 * - the off-server copies' bucket read with the pinned rclone image in local Docker, and deleted
 *   explicitly at the end (deleting it is the user's job, not OpsCrew's); the user's own bucket
 *   created first; the user's SFTP machine read as root there;
 * - the whole-server snapshots OpsCrew took of the run's server at Hetzner, deleted if a run left
 *   any;
 * - the deploy jobs' logs in the leak search.
 * Nothing here prints a secret, a dumped value or an address: everything logged goes through the
 * run's scrubber.
 */
import { rm } from "node:fs/promises";
import {
  offsiteRclone,
  type ProviderBucket,
  RCLONE_NOT_FOUND,
  r2Endpoint,
  STORAGE_ENDPOINTS,
} from "@opscrew/agents";
import {
  OFFSITE_LOG,
  OFFSITE_PREFIX,
  PORTAINER_VERSION_PATH,
  portainerSnapshotsVolume,
  RESTORED_IMAGE_FILE,
} from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import {
  api,
  HETZNER_API,
  httpRequest,
  minutes,
  type RootShell,
  retryDelete,
  waitFor,
} from "./cloud";
import type { BucketPass, ServerExec } from "./component-checks";
import type { AppEnvironments } from "./environment-checks";
import type { CliRun, LiveRun } from "./harness";
import { jobLog } from "./portainer-cloud";
import { BUSYBOX_IMAGE } from "./portainer-support";
import { readData as readMovedData, seedData as seedMovedData } from "./retarget-anywhere-checks";
import { inContainer, MOVE_SERVICES, seedScripts } from "./retarget-anywhere-support";
import {
  changeScripts,
  KAFKA_READ_SCRIPT,
  KAFKA_SERVICE,
  kafkaDigest,
  kafkaSeedScript,
  type ListedSnapshot,
  listedSnapshots,
  type OffsiteProvider,
  plantedFileScript,
  SFTP_MACHINE,
  SFTP_MACHINE_LABEL,
  type SnapshotData,
  SQLITE_CONTENT_SCRIPT,
  shownRestore,
} from "./snapshots-support";
import { leakedLabels, SERVER_DEPLOY_JOB } from "./support";

// ---------------------------------------------------------------------------------------------
// The run's own app name.

/**
 * After `analyze` (and the interview): the project's name in `opscrew/architecture.json` set to
 * the run's own, `e2e-snap-<run id>`, as design names the app after it, then `design`, which
 * must plan that name; then the zone's snapshot for the cleanup, taken under that name (the app's
 * hostname and `www.`). Returns prod's plan. The bucket, the snapshots' labels and every resource
 * are then the run's alone (examples/flask-sqlite has no project name, so OpsCrew would name it
 * after the checkout folder, the same in every run).
 */
export async function designRunApp(run: LiveRun, envs: AppEnvironments): Promise<DeployPlan> {
  const name = `e2e-snap-${run.runId}`;
  const file = run.paths().files.architecture;
  const architecture = await readArtifact("architecture", file);
  await writeArtifact("architecture", file, {
    ...architecture,
    facts: { ...architecture.facts, name },
  });
  // Design keeps an existing plan's app name, so the plan the first design wrote goes first.
  await rm(run.paths().files.plan, { force: true });
  await run.opscrewOk("design");
  const plan = await envs.designed("prod");
  if (plan.app.name !== name) {
    throw new Error(`design named the app ${plan.app.name}, not the run's ${name}.`);
  }
  await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// The example's data.

/** Runs `script` in `service` of `project` until it succeeds, for up to 5 minutes (it may start). */
function inService(exec: ServerExec, project: string, service: string, script: string) {
  return waitFor(
    `${service} in ${project} answering`,
    minutes(5),
    async () => exec(inContainer(project, service, script)),
    10_000,
  );
}

/**
 * Seeds feature 023's data in `project` (rows in both databases, jobs in Valkey, named after the
 * run), and `kafka`'s messages when given. The app's SQLite file is written through the app.
 */
export async function seedData(
  run: LiveRun,
  exec: ServerExec,
  project: string,
  kafka?: readonly string[],
): Promise<void> {
  await seedMovedData(run, exec, project);
  if (kafka !== undefined) await inService(exec, project, KAFKA_SERVICE, kafkaSeedScript(kafka));
}

/**
 * Changes every seeded service in `project` after a snapshot (`marker` names the change): a row
 * deleted and one added in both databases, the jobs replaced, and `kafka`'s messages added when
 * given. The app's SQLite file is changed through the app.
 */
export async function changeData(
  exec: ServerExec,
  project: string,
  marker: string,
  kafka?: readonly string[],
): Promise<void> {
  const changes = changeScripts(marker);
  await inService(exec, project, MOVE_SERVICES.postgres, changes.postgres);
  await inService(exec, project, MOVE_SERVICES.mysql, changes.mysql);
  await inService(exec, project, MOVE_SERVICES.valkey, seedScripts(marker).valkey);
  if (kafka !== undefined) await inService(exec, project, KAFKA_SERVICE, kafkaSeedScript(kafka));
}

/**
 * The data in `project`: feature 023's (the app's SQLite file by content), and with `kafka` the
 * topic's messages; each read tried again for up to 5 minutes while the services start.
 */
export async function readData(
  exec: ServerExec,
  project: string,
  kafka: boolean,
): Promise<SnapshotData> {
  const data = await readMovedData(exec, project, SQLITE_CONTENT_SCRIPT);
  if (!kafka) return data;
  const messages = await waitFor(
    `reading Kafka's messages in ${project}`,
    minutes(5),
    async () => kafkaDigest(await exec(inContainer(project, KAFKA_SERVICE, KAFKA_READ_SCRIPT))),
    10_000,
  );
  return { ...data, kafka: messages };
}

// ---------------------------------------------------------------------------------------------
// The commands, as a script runs them.

/** `opscrew snapshot list --json` with `args` (`--env staging`, `--key-file <path>`). */
export async function listSnapshots(
  run: LiveRun,
  args: readonly string[] = [],
): Promise<ListedSnapshot[]> {
  return listedSnapshots((await run.opscrewOk("snapshot", "list", "--json", ...args)).stdout);
}

/** The listed snapshot `id`; throws with the ids listed when there is none. */
export function snapshotOf(snapshots: readonly ListedSnapshot[], id: string): ListedSnapshot {
  const found = snapshots.find((snapshot) => snapshot.id === id);
  if (found === undefined) {
    throw new Error(
      `opscrew snapshot list does not list ${id}; it lists ${snapshots.map((s) => s.id).join(", ") || "none"}.`,
    );
  }
  return found;
}

/** A restore a script approved: what its first run showed, and the second run that applied it. */
export interface ApprovedRestore {
  shown: string;
  confirm: string;
  applied: CliRun;
}

/**
 * `opscrew restore` with `args` as a script runs it: first without `--approve`, which must stop at
 * the approval (exit 1) and show its hash and the name to type; then with `--confirm <name>` and
 * `--approve <hash>`, which must succeed. The caller checks the name typed.
 */
export async function approvedRestore(
  run: LiveRun,
  args: readonly string[],
): Promise<ApprovedRestore> {
  const shown = await run.opscrew("restore", ...args);
  if (shown.exitCode !== 1) {
    throw new Error(
      `opscrew restore without --approve must stop at its approval (exit 1), but exited with ${shown.exitCode}:\n${run.tail(shown.output)}`,
    );
  }
  const approval = shownRestore(shown.output);
  if (approval === undefined) {
    throw new Error(`opscrew restore showed no restore hash or name:\n${run.tail(shown.output)}`);
  }
  const applied = await run.opscrewOk(
    "restore",
    ...args,
    "--confirm",
    approval.confirm,
    "--approve",
    approval.hash,
  );
  return { shown: shown.output, confirm: approval.confirm, applied };
}

// ---------------------------------------------------------------------------------------------
// The off-server copies' bucket.

/**
 * Where the pass reads the off-server copies: a bucket ({@link BackupsBucket}) or the user's SFTP
 * machine ({@link SftpMachine}), each object's path relative to the copies' `backups/` folder.
 */
export interface CopyStore {
  /** Every object under `backups/`, its path relative to it. */
  objects(): Promise<string[]>;
  /** The object `backups/<path>` read whole (still encrypted), as text. */
  read(path: string): Promise<string>;
  /** Writes an empty object `backups/<path>` dated `at`, as the retention check plants one. */
  plant(path: string, at: Date): Promise<void>;
}

/**
 * The off-server copies' bucket `name` at `provider` (`region` its location; R2's `auto`, in the
 * zone's account `accountId`): read with the pinned rclone image in local Docker with the bucket's
 * key, which stays in rclone's environment; checked and deleted as the components pass's buckets
 * are (`pass`, its `bucketPass`). The copies are under `root` (rclone's path, by default the
 * bucket's `backups/`; in the user's own bucket `<bucket>/<app>-<env>/backups`).
 */
export class BackupsBucket implements CopyStore {
  /** The bucket's S3 endpoint. */
  readonly endpoint: string;
  /** rclone's settings (the bucket's key among them), and `docker`'s arguments that run it. */
  private readonly rclone: { settings: Record<string, string>; docker: string[] };
  /** The bucket as `pass` reads it: its provider, name and region (the rest is the app's only). */
  private readonly bucket: ProviderBucket;

  constructor(
    private readonly run: LiveRun,
    private readonly pass: Pick<BucketPass, "exists" | "deleteThroughApi">,
    readonly provider: Extract<OffsiteProvider, "r2" | "hetzner">,
    readonly name: string,
    region: string,
    key: { accessKeyId: string; secretAccessKey: string },
    accountId: string,
    private readonly root = `${name}/${OFFSITE_PREFIX}`,
  ) {
    const endpoint =
      provider === "r2" ? r2Endpoint(accountId) : STORAGE_ENDPOINTS.hetzner?.(region);
    if (endpoint === undefined) throw new Error("OpsCrew knows no endpoint for Hetzner's buckets.");
    this.endpoint = endpoint;
    this.rclone = offsiteRclone({ provider, region }, endpoint, key);
    this.bucket = { provider, bucket: name, region } as ProviderBucket;
  }

  /**
   * rclone's `args` (with `overrides` of its settings); its exit code 3 (not there) is returned,
   * any other failure thrown.
   */
  private async rcloneIn(
    args: readonly string[],
    what: string,
    overrides: Record<string, string> = {},
  ) {
    const { settings, docker } = this.rclone;
    const result = await this.run.runner.run("docker", [...docker, ...args], {
      env: { ...this.run.env, ...settings, ...overrides },
      timeoutMs: minutes(10),
    });
    if (result.exitCode !== 0 && result.exitCode !== RCLONE_NOT_FOUND) {
      const said = result.stderr.trim().split(/\r?\n/).at(-1) ?? "";
      throw new Error(
        `rclone could not ${what} in the bucket ${this.name} (exit ${result.exitCode}): ${this.run.scrub(said).slice(0, 300)}`,
      );
    }
    return result;
  }

  async objects(): Promise<string[]> {
    const listed = await this.rcloneIn(
      ["lsf", "-R", "--files-only", `offsite:${this.root}`],
      "list the copies",
    );
    if (listed.exitCode === RCLONE_NOT_FOUND) return [];
    return listedLines(listed.stdout);
  }

  async read(path: string): Promise<string> {
    const read = await this.rcloneIn(["cat", `offsite:${this.root}/${path}`], `read ${path}`);
    if (read.exitCode === RCLONE_NOT_FOUND) throw new Error(`The bucket has no ${path}.`);
    return read.stdout;
  }

  /** An empty object, its modification time (rclone's, which `--min-age` reads) `at`. */
  async plant(path: string, at: Date): Promise<void> {
    await this.rcloneIn(
      ["touch", "-t", at.toISOString().slice(0, 19), `offsite:${this.root}/${path}`],
      `write ${path}`,
    );
  }

  /**
   * Creates the bucket, as the user's own (the copies' settings never create one), then waits
   * until 5 listings in a row find it: for about 15 minutes some of Hetzner's nodes answer that a
   * new bucket is not there, and provision's write check would meet one.
   */
  async create(): Promise<void> {
    this.run.log(`creating the bucket ${this.name}, standing in for the user's own`);
    await this.rcloneIn(["mkdir", `offsite:${this.name}`], "create the bucket", {
      RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "false",
    });
    let found = 0;
    await waitFor(
      `the new bucket ${this.name} known to Hetzner's nodes`,
      minutes(20),
      async () => {
        const listed = await this.rcloneIn(["lsf", `offsite:${this.name}`], "list the bucket");
        found = listed.exitCode === 0 ? found + 1 : 0;
        return found >= 5 ? true : undefined;
      },
      10_000,
    );
  }

  /** Whether the bucket is there (R2's API, or Hetzner's answer to an unsigned `HEAD`). */
  exists(): Promise<boolean> {
    return this.pass.exists(this.bucket);
  }

  /**
   * Deletes every object (on Hetzner, whose bucket keeps versions, the old versions too) and then
   * the bucket, as the guide tells the user to; throws when the bucket is still there.
   */
  async remove(): Promise<void> {
    if (!(await this.exists())) return;
    const { deleteThroughApi } = this.pass;
    if (deleteThroughApi === undefined) throw new Error(`No way to delete ${this.name} is known.`);
    this.run.log(`deleting the off-server bucket ${this.name}, which OpsCrew leaves to the user`);
    await this.rcloneIn(["delete", `offsite:${this.name}`], "delete the copies");
    if (this.provider === "hetzner") {
      await this.rcloneIn(
        ["backend", "cleanup-hidden", `offsite:${this.name}`],
        "delete the copies' old versions",
      );
    }
    await deleteThroughApi(this.bucket);
    if (await this.exists()) {
      throw new Error(`The off-server bucket ${this.name} is still there after its deletion.`);
    }
  }
}

/** The non-empty lines of a listing, trimmed. */
function listedLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The copies on the user's SFTP machine (a throwaway server the test set up, {@link SFTP_MACHINE}),
 * read as root there through `shell`: under `root`, the folder `backups/` of the environment's
 * copies as the machine's own disk has it (inside the account's chroot).
 */
export class SftpMachine implements CopyStore {
  constructor(
    private readonly shell: RootShell,
    readonly root: string,
  ) {}

  async objects(): Promise<string[]> {
    const { root } = this;
    return listedLines(
      await this.shell.ok(
        `if [ -d ${root} ]; then cd ${root} && find . -type f | sed 's|^\\./||'; fi`,
      ),
    );
  }

  read(path: string): Promise<string> {
    return this.shell.ok(`cat ${this.root}/${path}`, minutes(5));
  }

  async plant(path: string, at: Date): Promise<void> {
    await this.shell.ok(plantedFileScript(`${this.root}/${path}`, at, SFTP_MACHINE.user));
  }

  /** Whether the folder `backups/<path>` is there. */
  async holds(path: string): Promise<boolean> {
    const dir = `${this.root}/${path}`;
    return (await this.shell.ok(`if [ -d ${dir} ]; then echo yes; else echo no; fi`)) === "yes";
  }
}

// ---------------------------------------------------------------------------------------------
// Hetzner's whole-server snapshots.

/** A snapshot at Hetzner: its id, the server it was taken of, and when. */
interface HetznerImage {
  id: number;
  created: string;
  created_from?: { id: number } | null;
}

/** The snapshots OpsCrew took at Hetzner of `app`'s servers (its labels, never `managed-by`). */
async function serverSnapshots(token: string, app: string): Promise<HetznerImage[]> {
  const selector = encodeURIComponent(`created-by=opscrew,app=${app}`);
  const listed = await api(
    HETZNER_API,
    token,
    "GET",
    `/images?type=snapshot&label_selector=${selector}`,
  );
  if (listed.status !== 200) throw new Error(`Hetzner answered HTTP ${listed.status} for images.`);
  return (listed.json as { images?: HetznerImage[] }).images ?? [];
}

/**
 * The cleanup's: deletes every whole-server snapshot of `app` OpsCrew took at Hetzner that this
 * run left, each a problem (the pass deletes its own with `opscrew snapshot delete`). Only the
 * run's are deleted: taken of the run's server `serverId` (when known), or since `since`. Any
 * other with the app's labels is a problem and stays.
 */
export async function removeServerSnapshots(
  token: string,
  app: string,
  serverId: number | undefined,
  since: Date,
): Promise<string[]> {
  const problems: string[] = [];
  for (const image of await serverSnapshots(token, app)) {
    const { id } = image;
    const ours =
      (serverId !== undefined && image.created_from?.id === serverId) ||
      Date.parse(image.created) >= since.getTime();
    if (!ours) {
      problems.push(
        `Hetzner has the whole-server snapshot ${id} of ${app} from before this run; it is not this run's, so the cleanup left it: check it in the console (Servers → Snapshots)`,
      );
      continue;
    }
    const deleted = await retryDelete(() => api(HETZNER_API, token, "DELETE", `/images/${id}`));
    problems.push(
      deleted
        ? `the run left the whole-server snapshot ${id} of ${app} at Hetzner; the cleanup deleted it`
        : `Hetzner kept the whole-server snapshot ${id} of ${app}: delete it in the console (Servers → Snapshots)`,
    );
  }
  return problems;
}

/** A server at Hetzner as a rebuild must keep it: its id, IPv4 address and protection. */
export interface HetznerServer {
  id: number;
  ipv4: string;
  protection: { delete: boolean; rebuild: boolean };
}

/** The server named `name` at Hetzner (the app's server is named after the app). */
export async function hetznerServer(token: string, name: string): Promise<HetznerServer> {
  const listed = await api(HETZNER_API, token, "GET", `/servers?name=${encodeURIComponent(name)}`);
  const server = (
    listed.json as
      | {
          servers?: {
            id: number;
            public_net: { ipv4?: { ip: string } | null };
            protection: { delete: boolean; rebuild: boolean };
          }[];
        }
      | undefined
  )?.servers?.[0];
  if (listed.status !== 200 || server === undefined) {
    throw new Error(`Hetzner lists no server ${name} (HTTP ${listed.status}).`);
  }
  return {
    id: server.id,
    ipv4: server.public_net.ipv4?.ip ?? "",
    protection: { delete: server.protection.delete, rebuild: server.protection.rebuild },
  };
}

/** Whether Hetzner still has the image `id`. */
export async function hetznerImageExists(token: string, id: string): Promise<boolean> {
  const got = await api(HETZNER_API, token, "GET", `/images/${id}`);
  if (got.status === 404) return false;
  if (got.status === 200) return true;
  throw new Error(`Hetzner answered HTTP ${got.status} for the image ${id}.`);
}

// ---------------------------------------------------------------------------------------------
// Your Portainer: the version its site serves, and the rollback's mark.

/** Waits up to `ms` until the site serves `version` at its version path, through Cloudflare. */
export async function waitForVersion(run: LiveRun, version: string, ms = minutes(15)) {
  const url = `https://${run.appHost}${PORTAINER_VERSION_PATH}`;
  run.log(`waiting for the site to serve version ${version}`);
  await waitFor(`the site serving version ${version}`, ms, async () => {
    const answer = await httpRequest(url);
    if (answer.status !== 200 || answer.body.trim() !== version) {
      throw new Error(`it answered ${answer.status} with ${answer.body.trim() || "(nothing)"}`);
    }
    return true;
  });
}

/**
 * Whether the stack's `snapshots` volume holds the rollback's mark (`.restored`), read as root on
 * the Portainer host with a read-only one-off of busybox that mounts it where the stack does.
 */
export async function restoredMark(exec: ServerExec, plan: DeployPlan): Promise<boolean> {
  const answer = await exec(
    `docker run --rm -v ${portainerSnapshotsVolume(plan)}:/snapshots:ro ${BUSYBOX_IMAGE} sh -c 'if [ -e ${RESTORED_IMAGE_FILE} ]; then echo yes; else echo no; fi'`,
  );
  return answer.trim() === "yes";
}

// ---------------------------------------------------------------------------------------------
// The leak search.

/** A deploy run whose deploy job's log the leak search reads. */
export interface DeployRun {
  what: string;
  id: number;
}

/**
 * The deploy job's log of each of `runs` (they take release snapshots, and the restores read their
 * output) searched for the run's known secrets and dumped values: the problems, by label only.
 * GitHub masks only its own secrets.
 */
export async function deployLogLeaks(run: LiveRun, runs: readonly DeployRun[]): Promise<string[]> {
  // The user's SFTP machine is named in the plan, so the deploy job may name it too.
  const secrets = run.scrubber
    .entries()
    .filter(({ label }) => !label.startsWith("server-") && !label.startsWith(SFTP_MACHINE_LABEL));
  const problems: string[] = [];
  for (const { what, id } of runs) {
    const text = await jobLog(run.github, id, SERVER_DEPLOY_JOB).catch((error: Error) => {
      problems.push(`the deploy job's log of ${what} (run ${id}) is unreadable: ${error.message}`);
      return "";
    });
    const found = leakedLabels(text, secrets);
    if (found.length > 0) {
      problems.push(`the deploy job's log of ${what} (run ${id}) contains: ${found.join(", ")}`);
    }
  }
  run.log(`observed: the leak search read the deploy job's log of ${runs.length} runs`);
  return problems;
}

/**
 * The last 40 lines of the off-server copy's upload log in the app's folder `dir` on the server
 * (`OFFSITE_LOG`), or that there is none, for a failure to show (scrubbed by the caller).
 */
export function offsiteLogTail(exec: ServerExec, dir: string): Promise<string> {
  const log = `${dir}/${OFFSITE_LOG}`;
  return exec(`if [ -f ${log} ]; then tail -n 40 ${log}; else echo "There is no ${log}."; fi`);
}

/**
 * No age private key (`AGE-SECRET-KEY-`, the prefix only, never a key) in the files of the app's
 * folder `dir` on its server (its `.env` files, the bucket's key file) or in its snapshots, read
 * through `exec` (FR-2409: the server holds only the recipient). grep's exit 1 is "none found".
 */
export async function ageKeysOnServer(exec: ServerExec, dir: string): Promise<string[]> {
  const found = await exec(
    `grep -rlI 'AGE-SECRET-KEY-' ${dir}/.snapshots $(find ${dir} -maxdepth 1 -type f); s=$?; [ "$s" -le 1 ]`,
  );
  return found
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((file) => `${file} on the server holds an age private key`);
}
