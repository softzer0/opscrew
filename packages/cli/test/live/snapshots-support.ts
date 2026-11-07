/**
 * Pure helpers of feature 024's live passes (`snapshots.test.ts`, docs/e2e.md "Snapshots and
 * restores"): the gates and variables of each pass, the services the passes add to
 * examples/flask-sqlite (feature 023's Postgres, MySQL and Valkey queue, and Kafka), the scripts
 * that seed, change and read their data in the containers, what the tests read in OpsCrew's output
 * (a snapshot's id, a restore's hash and typed name, `snapshot list --json`), which containers a
 * snapshot restarted, the off-server bucket's objects, and rclone's settings for it. No network, no
 * processes; unit-tested in `snapshots-support.test.ts`.
 */
import { createHash } from "node:crypto";
import { OFFSITE_KEY_VARS, STORAGE_KEY_VARS } from "@opscrew/agents";
import { IMAGES, OFFSITE_PREFIX, pinnedVersion, serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, PlanServiceSchema } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ServerContainer } from "./components-support";
import { ENVIRONMENT_E2E_VARIABLES } from "./environments-support";
import { type DataSnapshot, ROWS, withMoveServices } from "./retarget-anywhere-support";
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

/** Where the off-server pass keeps the copies. */
export type OffsiteProvider = "r2" | "hetzner";

/** The interview regions whose Hetzner locations have Object Storage (fsn1, nbg1, hel1). */
const STORAGE_REGIONS = ["eu-central", "eu-north"];

/**
 * Why the off-server pass to `provider` does not run beyond its gate and the common variables, or
 * `undefined` when it does: R2 needs the account's R2 turned on (`OPSCREW_E2E_R2=1`), Hetzner
 * Object Storage the user's S3 key and a region that has it.
 */
export function offsiteSkip(
  env: Record<string, string | undefined>,
  provider: OffsiteProvider,
): string | undefined {
  if (provider === "r2") {
    return env.OPSCREW_E2E_R2 === "1"
      ? undefined
      : "the copies on Cloudflare R2 need the account's R2 turned on: set OPSCREW_E2E_R2=1 once it is (docs/e2e.md)";
  }
  const missing = [
    "OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID",
    "OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY",
  ].filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) return `set ${missing.join(", ")}`;
  const region = env.OPSCREW_E2E_REGION?.trim() || "eu-central";
  return STORAGE_REGIONS.includes(region)
    ? undefined
    : `Hetzner Object Storage is only in ${STORAGE_REGIONS.join(" and ")}, not in OPSCREW_E2E_REGION=${region}`;
}

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
 * The run's own app name, `e2e-snap-<run id>`, so the backups bucket, the snapshots' labels and
 * every resource are this run's alone (examples/flask-sqlite has no project name, so OpsCrew would
 * name it after the checkout folder, the same in every run). Within the app names' rules
 * (`^[a-z0-9][a-z0-9-]{0,40}$`).
 */
export function runAppName(runId: string): string {
  const name = `e2e-snap-${runId}`;
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    throw new Error(`The run id ${runId} makes no valid app name.`);
  }
  return name;
}

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

/** feature 023's table in both databases (retarget-anywhere-support's, which seeds it). */
const ROWS_TABLE = "opscrew_e2e_rows";

const psql = (sql: string) => `psql -v ON_ERROR_STOP=1 -U app -d app -tAc "${sql}"`;
const mysql = (sql: string) => `MYSQL_PWD="$MYSQL_PASSWORD" mysql -uapp -N -B app -e "${sql}"`;

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

/** One of Kafka's own tools in its container, with a small heap (OpsCrew's `kafkaTool`). */
const kafkaTool = (name: string) =>
  `KAFKA_HEAP_OPTS=-Xmx64m /opt/kafka/bin/${name}.sh --bootstrap-server localhost:9092`;

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
    `${kafkaTool("kafka-topics")} --create --if-not-exists --topic ${KAFKA_TOPIC} --partitions 1 --replication-factor 1 > /dev/null`,
    `printf '%s\\n' ${messages.join(" ")} | ${kafkaTool("kafka-console-producer")} --topic ${KAFKA_TOPIC}`,
  ].join(" && ");
}

/**
 * The script that reads every message of the test's topic in Kafka's container: its end offset
 * first (`count <n>`), then exactly that many messages from the start, one per line.
 */
export const KAFKA_READ_SCRIPT = [
  `n=$(${kafkaTool("kafka-get-offsets")} --topic ${KAFKA_TOPIC} | awk -F: '{ s += $NF } END { print s + 0 }')`,
  'echo "count $n"',
  `if [ "$n" -gt 0 ]; then ${kafkaTool("kafka-console-consumer")} --topic ${KAFKA_TOPIC} --from-beginning --max-messages "$n" --timeout-ms 60000 2> /dev/null; fi`,
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

/** The first line of every age file: the bucket's objects are readable only with the key. */
export const AGE_HEADER = "age-encryption.org/v1";

/** The off-server copies' prefix in the bucket (`backups/`), as rclone lists it. */
export const BACKUPS_PREFIX = OFFSITE_PREFIX;

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
    .map((object) => `${BACKUPS_PREFIX}/${object} is not an age file`);
  const record = `${id}/about.json.age`;
  if (!objects.includes(record)) problems.push(`${BACKUPS_PREFIX}/${record} is missing`);
  const files = objects.filter((object) => object.startsWith(`${id}/`) && object !== record);
  if (files.length !== parts) {
    problems.push(`${BACKUPS_PREFIX}/${id}/ holds ${files.length} part files, not ${parts}`);
  }
  return problems;
}

/**
 * The problems of one object's content (`text`, read whole from the bucket): it must start with
 * the age header, and hold none of `known` (secrets and the values the test wrote).
 */
export function objectContentProblems(
  path: string,
  text: string,
  known: readonly { label: string; value: string }[],
): string[] {
  const problems = text.startsWith(AGE_HEADER) ? [] : [`${path} does not start with age's header`];
  const found = leakedLabels(text, known);
  if (found.length > 0) problems.push(`${path} contains: ${found.join(", ")}`);
  return problems;
}

/** rclone's settings for the remote `offsite:` (the bucket), as OpsCrew's own reads give them. */
export function rcloneSettings(options: {
  provider: "Cloudflare" | "Hetzner";
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> {
  return {
    RCLONE_CONFIG_OFFSITE_TYPE: "s3",
    RCLONE_CONFIG_OFFSITE_PROVIDER: options.provider,
    RCLONE_CONFIG_OFFSITE_REGION: options.region,
    RCLONE_CONFIG_OFFSITE_ENDPOINT: options.endpoint,
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: options.accessKeyId,
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: options.secretAccessKey,
    RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
  };
}

/**
 * `docker`'s arguments that run the pinned rclone image with `args`: each setting passed by its
 * name only (`-e NAME`), so its value stays in the child's environment and off its command line.
 */
export function rcloneDockerArgs(
  settings: Readonly<Record<string, string>>,
  args: readonly string[],
): string[] {
  return [
    "run",
    "--rm",
    ...Object.keys(settings).flatMap((name) => ["-e", name]),
    IMAGES.rclone.ref,
    ...args,
  ];
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
