// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import {
  type DATABASE_KINDS,
  type DeployPlan,
  keepSnapshotsOf,
  snapshotDatabases,
  snapshotsOn,
} from "@opscrew/plan-schema";
import { shellQuote } from "../runtime/services";
import { planFilePath, printfFormat, serverLogNote } from "./shared";

/** The snapshots' folder in the app's folder (plan.md 12.3). */
export const SNAPSHOTS_DIR = ".snapshots";

/** The last run's dumps' and restores' output, never printed (plan.md 12.3). */
export const SNAPSHOT_LOG = `${SNAPSHOTS_DIR}/snapshot.log`;

/** The file whose ISO time says that `.snapshots/<hex>` is complete (written last). */
export function snapshotTakenPath(hex: string): string {
  return `${SNAPSHOTS_DIR}/${hex}/taken`;
}

/** The one-time approval of a rollback that changes the data (plan.md 12.3), in the app's folder. */
export const ROLLBACK_APPROVAL_FILE = ".rollback-database";

/** The line of {@link ROLLBACK_APPROVAL_FILE}, without its newline (plan.md 12.3). */
export function rollbackApprovalLine(
  hex: string,
  choice: "snapshot" | "migrations",
  expiresAt: number,
): string {
  return `${hex} ${choice} ${expiresAt}`;
}

/** Where a one-off container of a database's service mounts the snapshot's folder. */
const MOUNT = "/snapshot";

/** How one database is dumped and restored, inside a one-off container of its service. */
interface DatabaseCommands {
  /** Sets the login from the service's own environment, inside the container. */
  login: string;
  /** Writes the dump of the running service `host` to `file`. */
  dump: (host: string, file: string) => string;
  /** Replaces the database of `host` with exactly what `file` holds. */
  restore: (host: string, file: string) => string;
}

/** MySQL's and MariaDB's commands: root, whose password reaches the client in `MYSQL_PWD`. */
function mysqlCommands(client: string, dump: string, rootPassword: string): DatabaseCommands {
  return {
    login: `export MYSQL_PWD="$${rootPassword}"`,
    dump: (host, file) =>
      `${dump} -h ${host} -u root --single-transaction --routines --events --triggers --no-tablespaces app > ${file}`,
    restore: (host, file) =>
      `${client} -h ${host} -u root -e "DROP DATABASE IF EXISTS app; CREATE DATABASE app" && ${client} -h ${host} -u root app < ${file}`,
  };
}

/** The file inside a MongoDB one-off container that holds the root password for its tools. */
const MONGO_CONFIG = "/tmp/opscrew-mongo.yaml";

/** The MongoDB tools' login: the root user `app` in `admin`, its password in {@link MONGO_CONFIG}. */
function mongoLogin(host: string): string {
  return `--host ${host} --username app --authenticationDatabase admin --config ${MONGO_CONFIG}`;
}

/**
 * The databases a snapshot holds, by kind, and their commands (research R9), with the catalog's
 * database and user `app` (`catalog/entries.ts`). No password is ever in an argument: each comes
 * from the service's env file inside the container, in the client's variable or a file there.
 * Each restore is exact: the tables and collections created since go too.
 */
const DATABASES: Record<(typeof DATABASE_KINDS)[number], DatabaseCommands> = {
  postgres: {
    login: 'export PGPASSWORD="$POSTGRES_PASSWORD"',
    dump: (host, file) => `pg_dump -h ${host} -U app -Fc -f ${file} app`,
    // `--clean` would drop only the objects in the dump: the database is made anew instead.
    restore: (host, file) =>
      `psql -X -q -h ${host} -U app -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS app WITH (FORCE)" -c "CREATE DATABASE app OWNER app" && pg_restore -h ${host} -U app -d app --no-owner --single-transaction ${file}`,
  },
  mysql: mysqlCommands("mysql", "mysqldump", "MYSQL_ROOT_PASSWORD"),
  mariadb: mysqlCommands("mariadb", "mariadb-dump", "MARIADB_ROOT_PASSWORD"),
  mongodb: {
    login: `printf "password: '%s'\\n" "$MONGO_INITDB_ROOT_PASSWORD" > ${MONGO_CONFIG}`,
    dump: (host, file) => `mongodump ${mongoLogin(host)} --db app --archive=${file} --gzip`,
    // `mongorestore --drop` would keep the collections that aren't in the dump.
    restore: (host, file) =>
      `HOME=/tmp mongosh --quiet --nodb --eval 'const c = connect("mongodb://${host}:27017/admin"); c.auth("app", process.env.MONGO_INITDB_ROOT_PASSWORD); c.getSiblingDB("app").dropDatabase()' && mongorestore ${mongoLogin(host)} --nsInclude="app.*" --archive=${file} --gzip`,
  },
};

/** The warning when the disk is too full for a snapshot; `%s` is the app's folder. */
function lowDisk(plan: DeployPlan): string {
  return `::warning::The disk that holds %s has less than 1 GiB or 10%% free, so OpsCrew takes no snapshot of the databases this time, and a rollback can't restore them to this moment. Free some space, or keep fewer snapshots (deploy.keepSnapshots in ${planFilePath(plan)}).`;
}

/** FR-1922: a dump failed at a deploy; `%s` is the app's folder. */
function snapshotFailed(plan: DeployPlan): string {
  return `::error::The snapshot of the databases before this release failed, so the new version was not started and the previous version keeps serving. The dump's output ${serverLogNote(plan, SNAPSHOT_LOG)} Fix its cause and push again, or set deploy.snapshots: false in ${planFilePath(plan)} to deploy without snapshots.`;
}

/** The shell functions {@link snapshotFunctions} renders. */
type SnapshotFunction =
  | "snapshot_room"
  | "snapshot_run"
  | "snapshot_take"
  | "snapshot_complete"
  | "snapshot_restore";

/**
 * The start script's snapshot functions (POSIX sh, in the app's folder; `folder` is that folder in
 * the script, `"$APPS_DIR"/<app>`), those of `names` only, none without a database
 * ({@link snapshotDatabases}):
 * - `snapshot_room`: whether the folder's disk has 1 GiB and 10% free; otherwise it warns, removes
 *   the partial snapshots and fails;
 * - `snapshot_run <folder> <rw|ro> <service> <script>`: `script` in a one-off container of the
 *   service (its pinned image and env file, on its network, as the deploy user), with
 *   `.snapshots/<folder>` at `/snapshot`, its output appended to {@link SNAPSHOT_LOG};
 * - `snapshot_take <hex>`: empties the log, dumps every database into `.snapshots/<hex>.partial`,
 *   the disk checked before and after each dump, writes `taken` and renames it `.snapshots/<hex>`,
 *   replacing an earlier one; returns 1 when a dump failed and 2 when the disk was too full, with
 *   no partial left either way;
 * - `snapshot_complete <hex>`: whether `.snapshots/<hex>` has `taken` and every database's dump;
 * - `snapshot_restore <hex>`: restores every database exactly from `.snapshots/<hex>`, its output
 *   added to the log; returns 1 when one failed.
 * Every folder is 0700 and every file 0600.
 */
export function snapshotFunctions(
  plan: DeployPlan,
  folder: string,
  names?: readonly SnapshotFunction[],
): string[] {
  const databases = snapshotDatabases(plan).map(({ name, kind }) => ({
    name,
    commands: DATABASES[kind],
    file: `${MOUNT}/${name}.dump`,
  }));
  if (databases.length === 0) return [];
  /** `command` in a one-off container of `name` that mounts the snapshot's folder `rw` or `ro`. */
  const run = (
    mode: "rw" | "ro",
    { name, commands }: (typeof databases)[number],
    command: string,
  ) =>
    `snapshot_run "$1"${mode === "rw" ? ".partial" : ""} ${mode} ${name} ${shellQuote(`umask 077 && ${commands.login} && ${command}`)}`;
  const functions: [SnapshotFunction, string[]][] = [
    [
      "snapshot_room",
      [
        "  if df -Pk . | awk 'NR == 2 { exit !($4 >= 1048576 && $4 * 10 >= $2) }'; then return 0; fi",
        `  printf ${printfFormat(lowDisk(plan))} ${folder}`,
        `  rm -rf ${SNAPSHOTS_DIR}/*.partial`,
        "  return 1",
      ],
    ],
    [
      "snapshot_run",
      [
        `  (umask 077; docker compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v ${folder}/${SNAPSHOTS_DIR}/"$1":${MOUNT}:"$2" --entrypoint sh "$3" -c "$4" < /dev/null >> ${SNAPSHOT_LOG} 2>&1)`,
      ],
    ],
    [
      "snapshot_take",
      [
        `  (umask 077 && mkdir -p ${SNAPSHOTS_DIR} && rm -rf ${SNAPSHOTS_DIR}/*.partial && mkdir ${SNAPSHOTS_DIR}/"$1".partial && : > ${SNAPSHOT_LOG}) || return 1`,
        "  snapshot_room || return 2",
        ...databases.flatMap((database) => [
          `  ${run("rw", database, database.commands.dump(database.name, database.file))} || { rm -rf ${SNAPSHOTS_DIR}/"$1".partial; return 1; }`,
          "  snapshot_room || return 2",
        ]),
        `  (umask 077 && date -u +%Y-%m-%dT%H:%M:%SZ > ${SNAPSHOTS_DIR}/"$1".partial/taken) || return 1`,
        `  rm -rf ${SNAPSHOTS_DIR}/"$1" && mv ${SNAPSHOTS_DIR}/"$1".partial ${SNAPSHOTS_DIR}/"$1"`,
      ],
    ],
    [
      "snapshot_complete",
      [
        `  [ -f ${snapshotTakenPath('"$1"')} ]${databases.map(({ name }) => ` && [ -f ${SNAPSHOTS_DIR}/"$1"/${name}.dump ]`).join("")}`,
      ],
    ],
    [
      "snapshot_restore",
      databases.map(
        (database) =>
          `  ${run("ro", database, database.commands.restore(database.name, database.file))} || return 1`,
      ),
    ],
  ];
  return functions
    .filter(([name]) => names?.includes(name) ?? true)
    .flatMap(([name, body]) => [`${name}() {`, ...body, "}"]);
}

/**
 * The deploy's snapshot (plan.md 12.4, FR-1921), after the services' setup and before the release
 * command: when snapshots are on ({@link snapshotsOn}) and `.env` names another image's digest
 * (`$running`, the script's; `$target` is `$1`'s), the databases are dumped under the running
 * version, then only the newest `deploy.keepSnapshots` snapshots stay. A failed dump stops the
 * deploy (FR-1922); too little disk warns, and the deploy goes on without a snapshot. Uses
 * {@link snapshotFunctions}; `folder` is the app's folder in the script.
 */
export function snapshotStep(plan: DeployPlan, folder: string): string[] {
  if (!snapshotsOn(plan)) return [];
  return [
    'if [ "$MODE" = deploy ] && [ -n "$running" ] && [ "$running" != "$target" ]; then',
    "  snap=0",
    '  snapshot_take "$running" || snap=$?',
    '  if [ "$snap" -eq 1 ]; then',
    `    printf ${printfFormat(snapshotFailed(plan))} ${folder}`,
    "    exit 1",
    "  fi",
    '  if [ "$snap" -eq 0 ]; then',
    `    echo ${shellQuote("OpsCrew took a snapshot of the databases before this release: a rollback to the previous version can restore it.")}`,
    `    for f in ${SNAPSHOTS_DIR}/*/taken; do if [ -f "$f" ]; then echo "$(cat "$f") \${f%/taken}"; fi; done | sort -r | sed '1,${keepSnapshotsOf(plan)}d' | while read -r _ dir; do rm -rf "$dir"; done`,
    "  fi",
    "fi",
  ];
}
