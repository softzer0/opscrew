/**
 * Pure helpers of feature 024's live passes (`snapshots.test.ts`, docs/e2e.md "Snapshots and
 * restores"): the gates and variables of each pass, the services the passes add to
 * examples/flask-sqlite (feature 023's Postgres, MySQL and Valkey queue, and Kafka), the scripts
 * that seed, change and read their data in the containers, what the tests read in OpsCrew's output
 * (a snapshot's id, a restore's hash and typed name, `snapshot list --json`), which containers a
 * snapshot restarted, and the off-server bucket's objects. No network, no processes; unit-tested in
 * `snapshots-support.test.ts`.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { OFFSITE_KEY_VARS, STORAGE_KEY_VARS } from "@opscrew/agents";
import { AGE_VERSION } from "@opscrew/core/testing";
import { kafkaTool, OFFSITE_PREFIX, pinnedVersion, serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, PlanServiceSchema } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ServerContainer } from "./components-support";
import { ENVIRONMENT_E2E_VARIABLES } from "./environments-support";
import {
  type DataSnapshot,
  mysql,
  psql,
  ROWS,
  ROWS_TABLE,
  withMoveServices,
} from "./retarget-anywhere-support";
import { leakedLabels, printedHash } from "./support";

// ---------------------------------------------------------------------------------------------
// The passes and their variables.

/** The data pass on staging at Hetzner: a snapshot by hand with Kafka stopped, and its restore. */
export const SNAPSHOTS_GATE = "OPSCREW_E2E_SNAPSHOTS";
/** The data pass's schedule at `1h` (about two hours more): its own gate, off by default. */
export const SCHEDULE_GATE = "OPSCREW_E2E_SNAPSHOTS_SCHEDULE";
/** The off-server copy, restored after the server is destroyed. */
export const OFFSITE_GATE = "OPSCREW_E2E_SNAPSHOTS_OFFSITE";
/** The whole-server snapshot and the rebuild from it. */
export const SERVER_GATE = "OPSCREW_E2E_SNAPSHOTS_SERVER";
/** The snapshot and restore in a Portainer set up as the user's. */
export const PORTAINER_GATE = "OPSCREW_E2E_SNAPSHOTS_PORTAINER";

/** What every pass needs besides its gate: an app at Hetzner behind Cloudflare. */
export const SNAPSHOT_VARIABLES = ENVIRONMENT_E2E_VARIABLES;

/** The Portainer pass also needs the classic token Portainer pulls the app's image with. */
export const PORTAINER_VARIABLES = [
  ...ENVIRONMENT_E2E_VARIABLES,
  "OPSCREW_E2E_GHCR_READ_TOKEN",
] as const;

/**
 * Where the off-server pass keeps the copies: a bucket OpsCrew creates on R2 or at Hetzner, the
 * user's own S3-compatible bucket (one the test creates first in Hetzner Object Storage), or a
 * folder on the user's own machine over SFTP (a throwaway Hetzner server the test sets up).
 */
export type OffsiteProvider = "r2" | "hetzner" | "s3" | "sftp";

/**
 * The bucket key a pass got as `OPSCREW_STORAGE_*` (the components pass's `bucketPass`), and the
 * same key as the off-server copies' bucket's `OPSCREW_OFFSITE_*`, which OpsCrew reads in a script.
 */
export function offsiteKey(storageEnv: Readonly<Record<string, string>>): {
  key: { accessKeyId: string; secretAccessKey: string };
  env: Record<string, string>;
} {
  const accessKeyId = storageEnv[STORAGE_KEY_VARS.accessKeyId];
  const secretAccessKey = storageEnv[STORAGE_KEY_VARS.secretAccessKey];
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error("The bucket's key has no access key ID or secret.");
  }
  return {
    key: { accessKeyId, secretAccessKey },
    env: {
      [OFFSITE_KEY_VARS.accessKeyId]: accessKeyId,
      [OFFSITE_KEY_VARS.secretAccessKey]: secretAccessKey,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The example's data: examples/flask-sqlite with feature 023's services, and Kafka.

/** The example of every data pass: its own SQLite file in its `sqlite` volume (`PUT /data`). */
export const SNAPSHOT_EXAMPLE = "flask-sqlite";

/**
 * The values the seed and the changes write that the leak search looks for (a Valkey job of each
 * marker, and the changes' markers themselves, which the databases hold).
 */
export function writtenValues(seedMarkers: readonly string[], changes: readonly string[]) {
  return [...[...seedMarkers, ...changes].map((marker) => `job-1-${marker}`), ...changes];
}

/** Kafka's service name: a stop-only kind, copied with the service stopped alone. */
export const KAFKA_SERVICE = "kafka";

/**
 * feature 023's services (Postgres `db`, MySQL `mysql`, a Valkey queue `queue`), and with `kafka`
 * Kafka too, added as a user adds them to `services` in plan.yaml before design runs again.
 */
export function withSnapshotServices(plan: DeployPlan, kafka: boolean): DeployPlan {
  const moved = withMoveServices(plan);
  if (!kafka || moved.services.some((service) => service.name === KAFKA_SERVICE)) return moved;
  const spec = serviceSpec("kafka");
  const service = PlanServiceSchema.parse({
    name: KAFKA_SERVICE,
    kind: "kafka",
    version: pinnedVersion(spec),
    memoryMb: spec.memory.defaultMb,
    reason: "Added in plan.yaml by the snapshots live test: a service copied while stopped.",
    licence: spec.licence.id,
  });
  return { ...moved, services: [...moved.services, service] };
}

/**
 * The scripts that change both databases' seeded rows after a snapshot, so a restore must undo
 * them: the first row deleted and a row past the seeded ones written (`marker` its value). Valkey's
 * jobs change with `seedScripts` and another marker.
 */
export function changeScripts(marker: string): { postgres: string; mysql: string } {
  if (!/^[a-z0-9-]+$/.test(marker)) throw new Error(`The marker "${marker}" is not plain.`);
  const sql = `delete from ${ROWS_TABLE} where id = 1; insert into ${ROWS_TABLE} (id, v) values (${ROWS + 1}, '${marker}')`;
  return { postgres: psql(sql), mysql: mysql(sql) };
}

/**
 * The script that reads the app's SQLite file in its container as its content, not its bytes: a
 * snapshot copies it through SQLite's backup API, so the file put back holds the same rows in
 * other bytes. Prints the SHA-256 of its SQL dump.
 */
export const SQLITE_CONTENT_SCRIPT = `python -c "import hashlib, sqlite3; print(hashlib.sha256('\\n'.join(sqlite3.connect('data/app.db').iterdump()).encode()).hexdigest())"`;

/** The test's topic in Kafka, with one partition so its messages keep their order. */
const KAFKA_TOPIC = "opscrew-e2e";

/** One of Kafka's own tools in its container (OpsCrew's), on the broker's plain listener. */
const kafka = (name: string) => `${kafkaTool(name)} --bootstrap-server localhost:9092`;

/** `count` messages of the run `runId`'s batch `batch` (`e2e-kafka-<run>-<batch><n>`). */
export function kafkaMessages(runId: string, batch: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `e2e-kafka-${runId}-${batch}${index + 1}`);
}

/**
 * The script that writes `messages` (plain: letters, digits and dashes) to the test's topic in
 * Kafka's container, the topic made first when it is not there.
 */
export function kafkaSeedScript(messages: readonly string[]): string {
  if (messages.length === 0) throw new Error("No messages to write.");
  for (const message of messages) {
    if (!/^[A-Za-z0-9-]+$/.test(message)) throw new Error(`The message "${message}" is not plain.`);
  }
  return [
    `${kafka("kafka-topics")} --create --if-not-exists --topic ${KAFKA_TOPIC} --partitions 1 --replication-factor 1 > /dev/null`,
    `printf '%s\\n' ${messages.join(" ")} | ${kafka("kafka-console-producer")} --topic ${KAFKA_TOPIC}`,
  ].join(" && ");
}

/**
 * The script that reads every message of the test's topic in Kafka's container: its end offset
 * first (`count <n>`), then exactly that many messages from the start, one per line.
 */
export const KAFKA_READ_SCRIPT = [
  `n=$(${kafka("kafka-get-offsets")} --topic ${KAFKA_TOPIC} | awk -F: '{ s += $NF } END { print s + 0 }')`,
  'echo "count $n"',
  `if [ "$n" -gt 0 ]; then ${kafka("kafka-console-consumer")} --topic ${KAFKA_TOPIC} --from-beginning --max-messages "$n" --timeout-ms 60000 2> /dev/null; fi`,
].join("; ");

/**
 * What {@link KAFKA_READ_SCRIPT} printed, as `<count>:<sha256 of the messages in order>`. Throws
 * when it read fewer messages than the topic's end offset says it has.
 */
export function kafkaDigest(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  const count = Number(/^count (\d+)$/.exec(lines[0] ?? "")?.[1]);
  if (!Number.isInteger(count)) throw new Error("Kafka's read printed no count.");
  const messages = lines.slice(1);
  if (messages.length !== count) {
    throw new Error(`Kafka's topic holds ${count} messages, but ${messages.length} were read.`);
  }
  return `${count}:${createHash("sha256").update(messages.join("\n")).digest("hex")}`;
}

/** What the data pass compares: feature 023's data (SQLite by content) and Kafka's messages. */
export type SnapshotData = DataSnapshot & { kafka?: string };

/**
 * The services whose data differs from `before` in `now`, by name, never by value: after a change
 * every one of them must differ, after a restore none may.
 */
export function differingServices(before: SnapshotData, now: SnapshotData): string[] {
  return (Object.keys(before) as (keyof SnapshotData)[]).filter((key) => before[key] !== now[key]);
}

// ---------------------------------------------------------------------------------------------
// What OpsCrew printed.

/**
 * The id of the snapshot `opscrew snapshot` took ("Took the snapshot <id> of …"): a data
 * snapshot's UTC time, or with `--server` the provider's number. `undefined` when it took none.
 */
export function takenSnapshotId(output: string): string | undefined {
  return [...output.matchAll(/Took the snapshot (\d{8}T\d{6}Z|\d+) of /g)].at(-1)?.[1];
}

/**
 * What a restore without `--approve` showed: its hash (`Restore hash: <hex>`) and the name typing
 * approves it ("Typing <name> approves it."), which a script gives as `--confirm <name>`.
 */
export function shownRestore(output: string): { hash: string; confirm: string } | undefined {
  const hash = printedHash(output, "Restore hash");
  const confirm = [...output.matchAll(/Typing (\S+) approves it\./g)].at(-1)?.[1];
  return hash === undefined || confirm === undefined ? undefined : { hash, confirm };
}

const ListedServiceSchema = z.object({
  name: z.string(),
  kind: z.string(),
  server: z.string().optional(),
  state: z.enum(["copied", "skipped", "failed"]),
  size: z.number().optional(),
});

const ListedSnapshotSchema = z.object({
  id: z.string(),
  kind: z.enum(["manual", "release", "scheduled", "server"]),
  taken: z.string(),
  version: z.string(),
  size: z.number().optional(),
  services: z.array(ListedServiceSchema),
  where: z.string(),
  offsite: z.boolean(),
  server: z.object({ provider: z.string(), id: z.string(), name: z.string() }).optional(),
});

/** One snapshot of `opscrew snapshot list --json`. */
export type ListedSnapshot = z.infer<typeof ListedSnapshotSchema>;

/** The snapshots `opscrew snapshot list --json` printed on its standard output, newest first. */
export function listedSnapshots(stdout: string): ListedSnapshot[] {
  const parsed = z
    .object({ snapshots: z.array(ListedSnapshotSchema) })
    .safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    throw new Error(`opscrew snapshot list --json printed another shape: ${parsed.error.message}`);
  }
  return parsed.data.snapshots;
}

/** The names of a listed snapshot's services in `state` (`copied` by default), sorted. */
export function servicesIn(snapshot: ListedSnapshot, state: "copied" | "skipped" = "copied") {
  return snapshot.services
    .filter((service) => service.state === state)
    .map((service) => service.name)
    .sort();
}

/**
 * Whether the snapshot taken at `taken` (ISO) ran on time for a schedule at minute 0 of each hour:
 * within its first 10 minutes.
 */
export function onTheHour(taken: string): boolean {
  const at = new Date(taken);
  return !Number.isNaN(at.getTime()) && at.getUTCMinutes() < 10;
}

// ---------------------------------------------------------------------------------------------
// The containers.

/**
 * The services of the Compose project `project` whose container a snapshot started again: each
 * container listed `before` that has another start time `after`, or is gone. Containers that
 * appeared meanwhile (one-offs) are not the app's and are left out.
 */
export function restartedServices(
  before: readonly ServerContainer[],
  after: readonly ServerContainer[],
  project: string,
): string[] {
  const now = new Map(after.map((container) => [container.name, container]));
  return before
    .filter((container) => container.project === project && container.running)
    .filter((container) => {
      const later = now.get(container.name);
      return later === undefined || !later.running || later.startedAt !== container.startedAt;
    })
    .map((container) => container.service)
    .sort();
}

// ---------------------------------------------------------------------------------------------
// The off-server bucket.

/**
 * What is wrong with the bucket's objects (`lsf -R` under `backups/`, relative to it) for the copy
 * `id` of `parts` parts on the app's server, by path only: an object that is not an age file, the
 * copy without its record (`about.json.age`, written last), or another number of part files.
 */
export function bucketObjectProblems(
  objects: readonly string[],
  id: string,
  parts: number,
): string[] {
  const problems = objects
    .filter((object) => !object.endsWith(".age"))
    .map((object) => `${OFFSITE_PREFIX}/${object} is not an age file`);
  const record = `${id}/about.json.age`;
  if (!objects.includes(record)) problems.push(`${OFFSITE_PREFIX}/${record} is missing`);
  const files = objects.filter((object) => object.startsWith(`${id}/`) && object !== record);
  if (files.length !== parts) {
    problems.push(`${OFFSITE_PREFIX}/${id}/ holds ${files.length} part files, not ${parts}`);
  }
  return problems;
}

/**
 * The problems of one object's content (`text`, read whole from the bucket): it must start with
 * age's header (`AGE_VERSION`), and hold none of `known` (secrets and the values the test wrote).
 */
export function objectContentProblems(
  path: string,
  text: string,
  known: readonly { label: string; value: string }[],
): string[] {
  const problems = text.startsWith(AGE_VERSION) ? [] : [`${path} does not start with age's header`];
  const found = leakedLabels(text, known);
  if (found.length > 0) problems.push(`${path} contains: ${found.join(", ")}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The retention of the copies on the user's own storage.

/** The id OpsCrew gives a data snapshot taken at `at`: its UTC time to the second. */
export function snapshotIdAt(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * What is wrong after the upload that deletes the copies older than `--days` (`objects` relative
 * to `backups/`): an object of the copy `planted`, dated two days back, still there, or one of
 * `copies` just taken (each its id and number of parts) no longer whole.
 */
export function retentionProblems(
  objects: readonly string[],
  planted: string,
  copies: readonly { id: string; parts: number }[],
): string[] {
  const problems = objects
    .filter((object) => object.startsWith(`${planted}/`))
    .map((object) => `${OFFSITE_PREFIX}/${object}, dated two days back, is still there`);
  for (const { id, parts } of copies) problems.push(...bucketObjectProblems(objects, id, parts));
  return [...new Set(problems)];
}

/**
 * The script (as root on the SFTP machine) that writes the empty file `file` dated `at`, its
 * folder made when missing, both owned by `owner`, as the SFTP account's own uploads are.
 */
export function plantedFileScript(file: string, at: Date, owner: string): string {
  if (!/^[A-Za-z0-9/._-]+$/.test(file)) throw new Error(`The path "${file}" is not plain.`);
  const dir = posix.dirname(file);
  return [
    `mkdir -p ${dir}`,
    `: > ${file}`,
    `touch -d @${Math.floor(at.getTime() / 1000)} ${file}`,
    `chown ${owner}:${owner} ${dir} ${file}`,
  ].join(" && ");
}

// ---------------------------------------------------------------------------------------------
// The user's own machine over SFTP.

/**
 * The SFTP machine's account for the copies, chrooted to its home, and the folder it writes
 * (`--path`, as SFTP shows it inside the chroot).
 */
export const SFTP_MACHINE = {
  user: "e2ebackups",
  home: "/srv/sftp/e2ebackups",
  path: "/backups",
} as const;

/**
 * The script (as root) that sets up a throwaway server as the user's machine for the copies, as
 * the guide tells the user to: the account {@link SFTP_MACHINE} chrooted to its home, SFTP only
 * (`internal-sftp`), with `publicKey` (the key made on this computer) in its `authorized_keys`
 * and its own folder `/backups`.
 */
export function sftpMachineSetup(publicKey: string): string {
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$/.test(publicKey)) {
    throw new Error("That is not an ed25519 public key.");
  }
  const { user, home, path } = SFTP_MACHINE;
  return [
    "set -eu",
    `id ${user} > /dev/null 2>&1 || useradd --home-dir ${home} --no-create-home --shell /usr/sbin/nologin ${user}`,
    // The chroot must be root's; the account writes only its own folder in it.
    `install -d -o root -g root -m 755 /srv/sftp ${home}`,
    `install -d -o ${user} -g ${user} -m 755 ${home}${path}`,
    `install -d -o ${user} -g ${user} -m 700 ${home}/.ssh`,
    `printf '%s\\n' '${publicKey}' > ${home}/.ssh/authorized_keys`,
    `chown ${user}:${user} ${home}/.ssh/authorized_keys`,
    `chmod 600 ${home}/.ssh/authorized_keys`,
    // `Match all` closes the block: sshd_config's own lines follow its Include.
    "cat > /etc/ssh/sshd_config.d/50-opscrew-e2e-backups.conf <<'EOF'",
    `Match User ${user}`,
    "  ChrootDirectory %h",
    "  ForceCommand internal-sftp",
    "  PasswordAuthentication no",
    "  AllowTcpForwarding no",
    "  X11Forwarding no",
    "  PermitTTY no",
    "Match all",
    "EOF",
    "sshd -t",
    "systemctl reload ssh",
  ].join("\n");
}

/**
 * The start of the labels the SFTP machine's addresses are masked under. The harness masks a
 * throwaway server's as `server-*`, which the leak search takes for the app server's; the user's
 * machine is named in the plan and in what OpsCrew prints on purpose.
 */
export const SFTP_MACHINE_LABEL = "sftp-machine-";

/**
 * The scrubber's `server-*` entries (right after the SFTP machine was made, only its addresses)
 * under {@link SFTP_MACHINE_LABEL} instead, to add again.
 */
export function sftpMachineAddresses(
  entries: readonly { label: string; value: string }[],
): { label: string; value: string }[] {
  return entries
    .filter(({ label }) => label.startsWith("server-"))
    .map(({ label, value }) => ({ label: `${SFTP_MACHINE_LABEL}${label.slice(7)}`, value }));
}

// ---------------------------------------------------------------------------------------------
// The leak search.

/**
 * The outputs of the snapshot, restore and rollback commands (by their labels) that name a server
 * address among `addresses` (the scrubber's `server-*` entries): the problems found, by label only.
 */
export function addressesInSnapshotOutputs(
  outputs: ReadonlyMap<string, string>,
  addresses: readonly { label: string; value: string }[],
): string[] {
  const problems: string[] = [];
  for (const [label, output] of outputs) {
    if (!/opscrew (?:snapshot|restore|rollback)\b/.test(label)) continue;
    const found = leakedLabels(output, addresses);
    if (found.length > 0) problems.push(`the output of ${label} contains: ${found.join(", ")}`);
  }
  return problems;
}
