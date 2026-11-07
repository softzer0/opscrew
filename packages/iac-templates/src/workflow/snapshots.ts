// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import {
  APP_SERVER,
  type DATABASE_KINDS,
  type DeployPlan,
  ONLINE_SNAPSHOT_KINDS,
  type SelfHostedServiceKind,
  servicesOn,
  snapshotScheduleOf,
  snapshotsOn,
} from "@opscrew/plan-schema";
import { dataDirs, serviceSpec } from "../catalog";
import { IMAGES } from "../pins";
import { SQLITE_VOLUME } from "../runtime";
import { shellQuote } from "../runtime/services";
import { planFilePath, printfFormat, serverLogNote } from "./shared";

/** The snapshots' folder in the app's folder (019 plan.md 12.3, 024 plan.md 1.). */
export const SNAPSHOTS_DIR = ".snapshots";

/** The last run's copies' and restores' output, never printed (plan.md 12.3). */
export const SNAPSHOT_LOG = `${SNAPSHOTS_DIR}/snapshot.log`;

/** The file whose ISO time says that `.snapshots/<id>` was taken (written before `about.json`). */
export function snapshotTakenPath(id: string): string {
  return `${SNAPSHOTS_DIR}/${id}/taken`;
}

/** The file that describes the complete snapshot `.snapshots/<id>`, written last (024 plan.md 1.). */
export function snapshotAboutPath(id: string): string {
  return `${SNAPSHOTS_DIR}/${id}/about.json`;
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

/**
 * The script in the app's folder on each server that holds data, which takes, restores, lists and
 * deletes its snapshots (024 plan.md 3.); the deploy uploads it.
 */
export const SNAPSHOT_SCRIPT = "snapshot.sh";

/**
 * The line that reads {@link SNAPSHOT_SCRIPT}'s functions into the start or rollback script, in
 * the app's folder, without running any of its commands.
 */
export const SNAPSHOT_FUNCTIONS = `OPSCREW_SNAPSHOT_FUNCTIONS=1 . ./${SNAPSHOT_SCRIPT}`;

/** One part of a snapshot: a service that keeps data, or the app's SQLite volume. */
export interface SnapshotPart {
  /** The service's name, or `sqlite` for the app's SQLite volume. */
  name: string;
  kind: SelfHostedServiceKind | "sqlite";
  /** Its file in the snapshot's folder (024 plan.md 1.). */
  file: string;
  /** Copied while it runs; otherwise stopped alone for its copy. */
  online: boolean;
  /** Valkey's, Redis's and Dragonfly's mode (`options.mode`). */
  mode?: "cache" | "queue";
}

/** True for a kind a snapshot copies while it runs ({@link ONLINE_SNAPSHOT_KINDS}). */
function onlineKind(kind: SelfHostedServiceKind): boolean {
  return ONLINE_SNAPSHOT_KINDS.some((online) => online === kind);
}

/** True for one of the four databases a snapshot dumps. */
function databaseKind(kind: string): kind is (typeof DATABASE_KINDS)[number] {
  return kind === "postgres" || kind === "mysql" || kind === "mariadb" || kind === "mongodb";
}

/**
 * The parts of a snapshot on `server` (the app's by default, or an extra server's name), in the
 * plan's order: each enabled service placed there, then on the app's server the app's SQLite
 * volume. The four databases' dumps are `<service>.dump`, Valkey's, Redis's and Dragonfly's
 * copies `<service>.rdb`, the SQLite volume `sqlite.tar` (D6) and every other kind's volumes
 * `<service>.tar` (024 plan.md 1., the store's contract).
 */
export function snapshotParts(plan: DeployPlan, server: string = APP_SERVER): SnapshotPart[] {
  const services = servicesOn(plan, server).map((service): SnapshotPart => {
    const extension = databaseKind(service.kind)
      ? "dump"
      : onlineKind(service.kind)
        ? "rdb"
        : "tar";
    return {
      name: service.name,
      kind: service.kind,
      file: `${service.name}.${extension}`,
      online: onlineKind(service.kind),
      ...("mode" in service.options ? { mode: service.options.mode } : {}),
    };
  });
  const sqlite: SnapshotPart[] =
    server === APP_SERVER && plan.storage?.sqlite !== undefined
      ? [{ name: "sqlite", kind: "sqlite", file: "sqlite.tar", online: true }]
      : [];
  return [...services, ...sqlite];
}

/**
 * True when each release snapshots the data on `server` (the app's by default, or an extra
 * server's name): snapshots on ({@link snapshotsOn}) and a part there ({@link snapshotParts}).
 */
export function releaseSnapshotOn(plan: DeployPlan, server: string = APP_SERVER): boolean {
  return snapshotsOn(plan) && snapshotParts(plan, server).length > 0;
}

/**
 * The extra servers, in plan order, whose data each release snapshots ({@link releaseSnapshotOn}):
 * the deploy takes their part of the snapshot from the runner, a rollback restores it there, and
 * the deploy keeps their {@link RUNNING_FILE} (plan.md D7).
 */
export function releaseSnapshotServers(plan: DeployPlan): string[] {
  return (plan.servers ?? [])
    .map((server) => server.name)
    .filter((name) => releaseSnapshotOn(plan, name));
}

/**
 * The file in the app's folder on an extra server that names the image running on the app's
 * server (`ghcr.io/…@sha256:<hex>`), which the deploy writes there once the app answers (T2417):
 * extra servers have no `.env`.
 */
export const RUNNING_FILE = ".running";

/**
 * `snapshot_running`, which prints the 64-hex digest of the version that runs, in the app's
 * folder: the one `.env` names, or on an extra server {@link RUNNING_FILE}'s; nothing when neither
 * names one by digest. The start script and the snapshot script read it alone.
 */
export function snapshotRunning(): string[] {
  return shellFunction("snapshot_running", [
    "  if [ -f .env ]; then",
    "    sed -n 's/^APP_IMAGE=.*@sha256:\\([0-9a-f]\\{64\\}\\)$/\\1/p' .env",
    `  elif [ -f ${RUNNING_FILE} ]; then`,
    `    sed -n 's/^[^=]*@sha256:\\([0-9a-f]\\{64\\}\\)$/\\1/p' ${RUNNING_FILE}`,
    "  fi",
  ]);
}

/** Where a one-off container of a service mounts the snapshot's folder. */
const MOUNT = "/snapshot";

/**
 * The snapshots being taken, as a shell word list: `<id>.partial` (a release or scheduled one) and
 * `<id>.taking` (one by hand). Only one script takes a snapshot at a time, so any other is stale.
 */
const TEMPORARY = `${SNAPSHOTS_DIR}/*.partial ${SNAPSHOTS_DIR}/*.taking`;

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
 * The databases a snapshot holds, by kind, and their commands (019 research R9), with the
 * catalog's database and user `app` (`catalog/entries.ts`). No password is ever in an argument:
 * each comes from the service's env file inside the container, in the client's variable or a file
 * there. Each restore is exact: the tables and collections created since go too.
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

/**
 * Valkey's, Redis's and Dragonfly's client in their own image, and the variable of the service's
 * env file that holds the default user's password (`catalog/entries.ts`).
 */
const REDIS_CLIENTS: Record<"valkey" | "redis" | "dragonfly", { cli: string; password: string }> = {
  valkey: { cli: "valkey-cli", password: "VALKEY_PASSWORD" },
  redis: { cli: "redis-cli", password: "REDIS_PASSWORD" },
  dragonfly: { cli: "redis-cli", password: "DFLY_requirepass" },
};

/** The name of the file Dragonfly's `SAVE RDB` writes in its data folder (`<name>.rdb`). */
const DRAGONFLY_SAVE = "opscrew-snapshot";

/**
 * The copy of the app's SQLite volume (plan.md D6, research R7 S1): a Python program for the pinned
 * Python image, run as root with the volume mounted read-write at `sys.argv[1]` while the app runs.
 * It takes the volume's owner, the app's user, so no `-wal` or `-shm` file it opens belongs to root,
 * and writes one tar of the volume to stdout:
 * - every SQLite database, found by its 16-byte header, copied through
 *   `sqlite3.connect(src).backup(dst)`, then `journal_mode=delete` on the copy, so it is one file;
 * - every other file and folder as it is, without the databases' `-wal`, `-shm` and `-journal`;
 * - numeric owners, which busybox's tar keeps when it restores the volume.
 * An empty volume exits 3 and writes nothing: the snapshot lists the part as skipped. Servers and
 * Portainer run this same program.
 */
export const SQLITE_COPY = [
  "import os, sqlite3, sys, tarfile, tempfile",
  "d = sys.argv[1]",
  "s = os.stat(d)",
  "os.setgroups([])",
  "os.setgid(s.st_gid)",
  "os.setuid(s.st_uid)",
  "if not os.listdir(d):",
  `    print("OpsCrew: the app's SQLite volume is empty, so the snapshot holds nothing of it.", file=sys.stderr)`,
  "    sys.exit(3)",
  "def numeric(info):",
  '    info.uname = info.gname = ""',
  "    return info",
  "def database(path):",
  "    if os.path.islink(path) or not os.path.isfile(path):",
  "        return False",
  '    with open(path, "rb") as f:',
  '        return f.read(16) == b"SQLite format 3\\x00"',
  // A failed copy leaves nothing behind in the container that runs it.
  "with tempfile.TemporaryDirectory() as tmp:",
  '    copy = os.path.join(tmp, "copy")',
  '    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.GNU_FORMAT) as tar:',
  "        for root, dirs, files in os.walk(d):",
  "            dirs.sort()",
  "            tar.add(root, os.path.relpath(root, d), recursive=False, filter=numeric)",
  "            for name in sorted(files):",
  "                path = os.path.join(root, name)",
  "                arcname = os.path.relpath(path, d)",
  '                if name.endswith(("-wal", "-shm", "-journal")):',
  "                    continue",
  "                if not database(path):",
  "                    tar.add(path, arcname, recursive=False, filter=numeric)",
  "                    continue",
  '                src = sqlite3.connect("file:" + path + "?mode=rw", uri=True)',
  "                dst = sqlite3.connect(copy)",
  "                src.backup(dst)",
  "                src.close()",
  '                dst.execute("pragma journal_mode=delete")',
  "                dst.close()",
  "                info = numeric(tar.gettarinfo(path, arcname))",
  "                info.size = os.path.getsize(copy)",
  '                with open(copy, "rb") as f:',
  "                    tar.addfile(info, f)",
  "                os.remove(copy)",
].join("\n");

/**
 * `python -c` with `program` as one line, `exec` of its text as a string literal: the deploy embeds
 * the script in its YAML one line at a time.
 */
function pythonOneLine(program: string): string {
  return `python -c ${shellQuote(`exec(${JSON.stringify(program)})`)}`;
}

/**
 * Busybox's commands that put a tar on stdin back into the stopped service's `dirs` exactly: each
 * emptied first, then only those folders' members extracted.
 */
function untar(dirs: readonly string[]): string {
  const members = dirs.map((dir) => dir.replace(/^\//, "")).join(" ");
  return `find ${dirs.join(" ")} -mindepth 1 -delete && tar -C / -xpf - ${members}`;
}

/** `script` in a busybox one-off with `service`'s volumes (`ro` or `rw`), stdin and stdout passed. */
function box(mode: "ro" | "rw", service: string, script: string): string {
  return `snapshot_box ${mode} ${service} ${shellQuote(script)}`;
}

/** The lines of a part's copy (`part_take`) and exact restore (`part_restore`), `$2` its folder. */
interface PartCommands {
  take: string[];
  restore: string[];
}

/**
 * How each part is copied into `.snapshots/$2` and restored from there (024 plan.md 2., research
 * R7): the four databases as 019 dumps and restores them; Valkey and Redis with `--rdb` from a
 * one-off of their own image (a cache restored as `dump.rdb`, removed once it is loaded; a queue
 * as the base of a new append-only folder); Dragonfly with `SAVE RDB`, copied out read-only (a
 * queue restored as its only `dump` file, a cache loaded with `DFLY LOAD` while it runs); the
 * SQLite volume with {@link SQLITE_COPY} (exit 3 when it is empty: the part is skipped), restored
 * the app stopped by emptying it and untarring; every other kind stopped alone, its volumes
 * tarred.
 */
function partCommands(part: SnapshotPart): PartCommands {
  const file = `.snapshots/"$2"/${part.file}`;
  if (part.kind === "sqlite") {
    const volume = `--network none -v "$_volume":/data`;
    return {
      take: [
        "snapshot_sqlite_volume || return 1",
        `docker run --rm ${volume} ${IMAGES.python.ref} ${pythonOneLine(SQLITE_COPY)} /data < /dev/null > ${file} 2>> ${SNAPSHOT_LOG}`,
      ],
      restore: [
        "snapshot_sqlite_volume || return 1",
        `docker run --rm -i ${volume} ${IMAGES.busybox.ref} sh -c ${shellQuote("find /data -mindepth 1 -delete && tar -C /data -xpf -")} < ${file} >> ${SNAPSHOT_LOG} 2>&1`,
      ],
    };
  }
  const { name, kind } = part;
  const service = name;
  if (databaseKind(kind)) {
    const commands = DATABASES[kind];
    const run = (mode: "rw" | "ro", command: string) =>
      `snapshot_run "$2" ${mode} ${service} ${shellQuote(`umask 077 && ${commands.login} && ${command}`)}`;
    return {
      take: [run("rw", commands.dump(service, `${MOUNT}/${part.file}`))],
      restore: [run("ro", commands.restore(service, `${MOUNT}/${part.file}`))],
    };
  }
  const spec = serviceSpec(kind);
  const dirs = dataDirs(spec).map(([, dir]) => dir);
  if (kind === "valkey" || kind === "redis" || kind === "dragonfly") {
    const [data = "/data"] = dirs;
    const { cli, password } = REDIS_CLIENTS[kind];
    const login = `umask 077 && export REDISCLI_AUTH="$${password}"`;
    const run = (mode: "rw" | "ro", command: string) =>
      `snapshot_run "$2" ${mode} ${service} ${shellQuote(`${login} && ${command}`)}`;
    const owner = `o="$(stat -c %u:%g ${data})"`;
    const stop = `docker compose stop -t 120 ${service} >> ${SNAPSHOT_LOG} 2>&1`;
    const queue = part.mode === "queue";
    if (kind !== "dragonfly") {
      const dir = `${data}/appendonlydir`;
      const base = "appendonly.aof.1.base.rdb";
      return {
        take: [run("rw", `${cli} -h ${service} --rdb ${MOUNT}/${part.file}`)],
        restore: queue
          ? [
              `${stop} || return 1`,
              `${box("rw", service, `${owner} && rm -rf ${dir} && mkdir ${dir} && cat > ${dir}/${base} && printf 'file ${base} seq 1 type b\\n' > ${dir}/appendonly.aof.manifest && chown -R "$o" ${dir}`)} < ${file} || return 1`,
              `snapshot_start ${service}`,
            ]
          : [
              `${stop} || return 1`,
              `${box("rw", service, `${owner} && cat > ${data}/dump.rdb && chown "$o" ${data}/dump.rdb`)} < ${file} || return 1`,
              `snapshot_start ${service} || return 1`,
              // A cache saves nothing: its next start must not load this copy again.
              `${box("rw", service, `rm -f ${data}/dump.rdb`)} < /dev/null`,
            ],
      };
    }
    const saved = `${data}/${DRAGONFLY_SAVE}.rdb`;
    return {
      take: [
        `${run("rw", `[ "$(${cli} -h ${service} SAVE RDB ${DRAGONFLY_SAVE})" = OK ]`)} || return 1`,
        `${box("ro", service, `cat ${saved}`)} < /dev/null > ${file} || return 1`,
        `${box("rw", service, `rm -f ${saved}`)} < /dev/null`,
      ],
      restore: queue
        ? [
            `${stop} || return 1`,
            `${box("rw", service, `${owner} && rm -f ${data}/dump* && cat > ${data}/dump.rdb && chown "$o" ${data}/dump.rdb`)} < ${file} || return 1`,
            `snapshot_start ${service}`,
          ]
        : [
            `${box("rw", service, `${owner} && cat > ${saved} && chown "$o" ${saved}`)} < ${file} || return 1`,
            `${run("ro", `[ "$(${cli} -h ${service} DFLY LOAD ${DRAGONFLY_SAVE}.rdb)" = OK ]`)} || return 1`,
            `${box("rw", service, `rm -f ${saved}`)} < /dev/null`,
          ],
    };
  }
  const tarDirs = dirs.map((dir) => dir.replace(/^\//, "")).join(" ");
  return {
    take: [`snapshot_tar ${service} "$2" ${shellQuote(tarDirs)}`],
    restore: [`snapshot_untar ${service} "$2" ${shellQuote(untar(dirs))}`],
  };
}

/** A shell function `name` with `body`'s lines. */
function shellFunction(name: string, body: readonly string[]): string[] {
  return [`${name}() {`, ...body, "}"];
}

/** A `case "$1"` over the parts, each branch `branch(part)`'s lines; `fallback` for any other. */
function partCase(
  parts: readonly SnapshotPart[],
  branch: (part: SnapshotPart) => readonly string[],
  fallback = "return 1",
): string[] {
  return [
    '  case "$1" in',
    ...parts.flatMap((part) => [
      `    ${part.name})`,
      ...branch(part).map((line) => `      ${line}`),
      "      ;;",
    ]),
    `    *) ${fallback} ;;`,
    "  esac",
  ];
}

/**
 * The snapshot functions of {@link SNAPSHOT_SCRIPT} on `server` (POSIX sh, in the app's folder,
 * which the script calls `folder`, `"$APPS_DIR"/<app>`); none without a part there
 * ({@link snapshotParts}). `SNAPSHOT_PARTS` and `SNAPSHOT_ONLINE` name the parts and those copied
 * while they run; the functions' own variables start with `_`, so they never change the start
 * script's:
 * - `part_file <part>`, `part_kind <part>`: the part's file and kind;
 * - `snapshot_room`: whether the folder's disk has 1 GiB and 10% free; otherwise it removes the
 *   partial snapshots and fails;
 * - `snapshot_run <folder> <rw|ro> <service> <script>`: `script` in a one-off container of the
 *   service (its pinned image and env file, on its network, as the deploy user), with
 *   `.snapshots/<folder>` at `/snapshot`, its output appended to {@link SNAPSHOT_LOG};
 * - `snapshot_box <ro|rw> <service> <script>`: `script` in a busybox one-off with no network and
 *   the service's container's volumes, stdin and stdout passed, its errors appended to the log;
 * - `snapshot_stop <service>`: 023's clean stop: 120 seconds, then the container must have exited
 *   on its own (not killed: exit 137) or never started;
 * - `snapshot_start <service>`: its own container started again, once healthy;
 * - `snapshot_tar` and `snapshot_untar`: a stop-only service's copy (stopped cleanly alone, its
 *   volumes tarred, started again when it ran, or a message how to start it) and restore (stopped,
 *   emptied, its folders untarred, started);
 * - `part_take <part> <folder>` (3: nothing to copy), `part_restore <part> <folder>`
 *   ({@link partCommands});
 * - `snapshot_running` ({@link snapshotRunning});
 * - `snapshot_about <id> <kind> <taken> <version> <folder> [<part>]...`: prints `about.json`, one
 *   line, as the store's contract has it (024 plan.md 1.): `version` the 64-hex digest or empty,
 *   each part's kind, file and size, or `skipped` for the parts not given;
 * - `snapshot_take <id> <kind> <version> [<part>]...`: empties the log, copies each part into
 *   `.snapshots/<id>.taking` (by hand) or `<id>.partial`, the disk checked before and after each,
 *   writes `taken` and then `about.json` (a part with nothing to copy skipped), and renames it
 *   `.snapshots/<id>`, replacing an earlier one; returns 1 when a copy failed and 2 when the disk
 *   was too full, with no partial left;
 * - `snapshot_complete <id>`: whether `.snapshots/<id>` has `about.json` and each file it names;
 * - `snapshot_parts <id>`: the parts whose file `.snapshots/<id>` holds;
 * - `snapshot_restore <id> [<part>]...`: restores each part (every one the snapshot holds by
 *   default) exactly, its output added to the log; returns 1 when one failed.
 * Every folder is 0700 and every file 0600.
 */
export function snapshotFunctions(plan: DeployPlan, server: string, folder: string): string[] {
  const parts = snapshotParts(plan, server);
  if (parts.length === 0) return [];
  const commands = new Map(parts.map((part) => [part.name, partCommands(part)]));
  const names = (list: readonly SnapshotPart[]) => list.map((part) => part.name).join(" ");
  const log = SNAPSHOT_LOG;
  const box = `docker run --rm -i --network none --volumes-from "$_box:$1" ${IMAGES.busybox.ref} sh -c "$3" 2>> ${log}`;
  return [
    `SNAPSHOT_PARTS=${shellQuote(names(parts))}`,
    `SNAPSHOT_ONLINE=${shellQuote(names(parts.filter((part) => part.online)))}`,
    ...shellFunction(
      "part_file",
      partCase(parts, (part) => [`echo ${part.file}`]),
    ),
    ...shellFunction(
      "part_kind",
      partCase(parts, (part) => [`echo ${part.kind}`]),
    ),
    ...shellFunction("snapshot_room", [
      "  if df -Pk . | awk 'NR == 2 { exit !($4 >= 1048576 && $4 * 10 >= $2) }'; then return 0; fi",
      `  rm -rf ${TEMPORARY}`,
      "  return 1",
    ]),
    ...shellFunction("snapshot_run", [
      `  (umask 077; docker compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v ${folder}/${SNAPSHOTS_DIR}/"$1":${MOUNT}:"$2" --entrypoint sh "$3" -c "$4" < /dev/null >> ${log} 2>&1)`,
    ]),
    ...shellFunction("snapshot_box", [
      '  _box="$(docker compose ps -aq "$2")"',
      '  [ -n "$_box" ] || return 1',
      `  ${box}`,
    ]),
    ...shellFunction("snapshot_stop", [
      `  docker compose stop -t 120 "$1" >> ${log} 2>&1 || return 1`,
      '  for _stopped in $(docker compose ps -aq "$1"); do',
      `    case "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$_stopped")" in`,
      '      "exited 137") return 1 ;;',
      '      "exited "* | "created "*) ;;',
      "      *) return 1 ;;",
      "    esac",
      "  done",
    ]),
    ...shellFunction("snapshot_start", [
      `  docker compose up -d --no-deps --no-recreate --wait "$1" >> ${log} 2>&1`,
    ]),
    ...shellFunction("snapshot_tar", [
      '  _ran="$(docker compose ps -q "$1")"',
      "  _copied=1",
      '  if ! snapshot_stop "$1"; then',
      `    printf ${printfFormat(`%s did not stop cleanly within 120 seconds (Docker killed it when the time ran out, or it ran out of memory), so OpsCrew did not copy its files.`)} "$1" >&2`,
      `  elif snapshot_box ro "$1" "tar -C / -cf - $3" < /dev/null > ${SNAPSHOTS_DIR}/"$2"/"$1".tar; then`,
      "    _copied=0",
      "  fi",
      '  if [ -n "$_ran" ] && ! snapshot_start "$1"; then',
      `    printf ${printfFormat(`%s did not start again after its copy. Its output is in %s/${SNAPSHOT_LOG}; start it with docker compose up -d %s in %s.`)} "$1" ${folder} "$1" ${folder} >&2`,
      "    return 1",
      "  fi",
      '  return "$_copied"',
    ]),
    ...shellFunction("snapshot_untar", [
      `  docker compose stop -t 120 "$1" >> ${log} 2>&1 || return 1`,
      `  snapshot_box rw "$1" "$3" < ${SNAPSHOTS_DIR}/"$2"/"$1".tar || return 1`,
      '  snapshot_start "$1"',
    ]),
    ...(parts.some((part) => part.kind === "sqlite")
      ? // The app's SQLite volume, `$_volume`; never made here: Docker would give a new volume
        // root as its owner, not the app's user.
        shellFunction("snapshot_sqlite_volume", [
          `  _volume="\${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}_${SQLITE_VOLUME}"`,
          '  docker volume inspect "$_volume" > /dev/null 2>&1',
        ])
      : []),
    ...shellFunction(
      "part_take",
      partCase(parts, (part) => commands.get(part.name)?.take ?? []),
    ),
    ...shellFunction(
      "part_restore",
      partCase(parts, (part) => commands.get(part.name)?.restore ?? []),
    ),
    ...snapshotRunning(),
    ...shellFunction("snapshot_about", [
      '  _about_version=""',
      '  if [ -n "$4" ]; then _about_version="sha256:$4"; fi',
      `  printf '{"id":"%s","kind":"%s","taken":"%s","version":"%s","services":[' "$1" "$2" "$3" "$_about_version"`,
      '  _about_folder="$5"',
      "  shift 5",
      '  _about_sep=""',
      "  for _about_part in $SNAPSHOT_PARTS; do",
      '    printf %s "$_about_sep"',
      '    _about_sep=","',
      '    case " $* " in',
      '      *" $_about_part "*)',
      '        _about_file="$(part_file "$_about_part")"',
      `        printf '{"name":"%s","kind":"%s","file":"%s","size":%s}' "$_about_part" "$(part_kind "$_about_part")" "$_about_file" "$(wc -c < "$_about_folder/$_about_file" | tr -d ' ')" ;;`,
      `      *) printf '{"name":"%s","kind":"%s","skipped":true}' "$_about_part" "$(part_kind "$_about_part")" ;;`,
      "    esac",
      "  done",
      `  printf ']}\\n'`,
    ]),
    ...shellFunction("snapshot_take", [
      '  _take_id="$1"; _take_kind="$2"; _take_version="$3"; shift 3',
      // T2405's store: Portainer's finisher claims the scheduled `*.partial` folders.
      '  _take_folder="$_take_id.partial"',
      '  if [ "$_take_kind" = manual ]; then _take_folder="$_take_id.taking"; fi',
      `  _take_in=${SNAPSHOTS_DIR}/"$_take_folder"`,
      `  (umask 077 && mkdir -p ${SNAPSHOTS_DIR} && rm -rf ${TEMPORARY} && mkdir "$_take_in" && : > ${log}) || return 1`,
      "  snapshot_room || return 2",
      '  _take_done=""',
      '  for _take_part in "$@"; do',
      "    _take_rc=0",
      '    (umask 077; part_take "$_take_part" "$_take_folder") || _take_rc=$?',
      // 3: nothing to copy (an empty SQLite volume), which the snapshot lists as skipped.
      '    if [ "$_take_rc" -eq 3 ]; then',
      '      rm -f "$_take_in"/"$(part_file "$_take_part")"',
      '    elif [ "$_take_rc" -ne 0 ]; then',
      `      printf ${printfFormat("The copy of %s failed.")} "$_take_part" >&2`,
      '      rm -rf "$_take_in"',
      "      return 1",
      "    else",
      '      _take_done="$_take_done $_take_part"',
      "    fi",
      "    snapshot_room || return 2",
      "  done",
      '  _taken="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
      '  (umask 077 && echo "$_taken" > "$_take_in"/taken && snapshot_about "$_take_id" "$_take_kind" "$_taken" "$_take_version" "$_take_in" $_take_done > "$_take_in"/about.json) || return 1',
      `  rm -rf ${SNAPSHOTS_DIR}/"$_take_id" && mv "$_take_in" ${SNAPSHOTS_DIR}/"$_take_id"`,
    ]),
    ...shellFunction("snapshot_complete", [
      `  [ -f ${SNAPSHOTS_DIR}/"$1"/about.json ] || return 1`,
      `  for _complete_file in $(grep -o '"file":"[^"]*"' ${SNAPSHOTS_DIR}/"$1"/about.json | cut -d '"' -f 4); do`,
      `    [ -f ${SNAPSHOTS_DIR}/"$1"/"$_complete_file" ] || return 1`,
      "  done",
    ]),
    ...shellFunction("snapshot_parts", [
      "  for _listed in $SNAPSHOT_PARTS; do",
      `    if [ -f ${SNAPSHOTS_DIR}/"$1"/"$(part_file "$_listed")" ]; then echo "$_listed"; fi`,
      "  done",
    ]),
    ...shellFunction("snapshot_restore", [
      '  _restore_id="$1"; shift',
      '  if [ "$#" -eq 0 ]; then set -- $(snapshot_parts "$_restore_id"); fi',
      '  for _restore_part in "$@"; do',
      '    part_restore "$_restore_part" "$_restore_id" || return 1',
      "  done",
    ]),
  ];
}

/** The warning when the disk is too full for a snapshot; `%s` is the app's folder. */
function lowDisk(plan: DeployPlan): string {
  return `::warning::The disk that holds %s has less than 1 GiB or 10%% free, so OpsCrew takes no snapshot of the data this time, and a rollback can't restore it to this moment. Free some space, or keep fewer snapshots (deploy.keepSnapshots in ${planFilePath(plan)}).`;
}

/** FR-1922: a copy failed at a deploy; `%s` is the app's folder. */
function snapshotFailed(plan: DeployPlan): string {
  return `::error::The snapshot of the data before this release failed, so the new version was not started and the previous version keeps serving. The copies' output ${serverLogNote(plan, SNAPSHOT_LOG)} Fix its cause and push again, or set deploy.snapshots: false in ${planFilePath(plan)} to deploy without snapshots.`;
}

/**
 * The deploy's snapshot on the app's server (019 plan.md 12.4, FR-1921; 024 US7), after the
 * services' setup and before the release command: when it snapshots the data there
 * ({@link releaseSnapshotOn}) and `.env` names another image's digest (`$running`, the script's;
 * `$target` is `$1`'s), {@link SNAPSHOT_SCRIPT}'s `take release` copies the data under the running
 * version, then keeps only the newest `deploy.keepSnapshots` release snapshots. A failed copy stops
 * the deploy (FR-1922); too little disk warns, and the deploy goes on without a snapshot. `folder`
 * is the app's folder in the script.
 */
export function snapshotStep(plan: DeployPlan, folder: string): string[] {
  if (!releaseSnapshotOn(plan)) return [];
  return [
    'if [ "$MODE" = deploy ] && [ -n "$running" ] && [ "$running" != "$target" ]; then',
    `  ${SNAPSHOT_FUNCTIONS}`,
    "  snap=0",
    "  snapshot_cmd_take release > /dev/null || snap=$?",
    '  if [ "$snap" -eq 1 ]; then',
    `    printf ${printfFormat(snapshotFailed(plan))} ${folder}`,
    "    exit 1",
    "  fi",
    '  if [ "$snap" -eq 2 ]; then',
    `    printf ${printfFormat(lowDisk(plan))} ${folder}`,
    "  fi",
    '  if [ "$snap" -eq 0 ]; then',
    `    echo ${shellQuote("OpsCrew took a snapshot of the data before this release: a rollback to the previous version can restore it.")}`,
    "  fi",
    "fi",
  ];
}

/** The minute of each hour at which the deploy user's crontab runs `take scheduled`. */
const SCHEDULE_MINUTE = 0;

/** The tag that ends the app's line in the deploy user's crontab. */
function scheduleTag(plan: DeployPlan): string {
  return `# opscrew-snapshots ${plan.app.name}`;
}

/** `snapshots.schedule.every` in hours: daily 24, weekly 168, `<n>h` n. */
export function scheduleHours(every: string): number {
  if (every === "daily") return 24;
  if (every === "weekly") return 168;
  return Number.parseInt(every, 10);
}

/**
 * The deploy's lines on `server` for scheduled snapshots (024 plan.md 3., D2), in a script whose
 * `$APPS_DIR` is the apps' folder; none on this computer. With `snapshots.schedule` and a part on
 * the server, the deploy user's crontab gets one line, tagged with the app's name, that runs
 * `take scheduled` each hour at minute {@link SCHEDULE_MINUTE} (the script takes a snapshot only
 * in the schedule's hours); otherwise an earlier line of the app goes. A server without
 * `crontab` stops the deploy when a schedule is on.
 */
export function snapshotScheduleLines(plan: DeployPlan, server: string): string[] {
  if (plan.target.provider === "localhost") return [];
  // The app's line ends with its tag: another app whose name starts with this one's keeps its own.
  // App names hold only letters, digits and hyphens, which a basic pattern reads as they are.
  const mine = shellQuote(` ${scheduleTag(plan)}$`);
  const schedule = snapshotScheduleOf(plan);
  if (schedule === undefined || snapshotParts(plan, server).length === 0) {
    return [
      `if crontab -l 2> /dev/null | grep -q ${mine}; then crontab -l | grep -v ${mine} | crontab -; fi`,
    ];
  }
  const where = server === APP_SERVER ? "This server" : `The server ${server}`;
  const line = `${SCHEDULE_MINUTE} * * * * sh %s/${plan.app.name}/${SNAPSHOT_SCRIPT} take scheduled > /dev/null 2>&1 %s\\n`;
  return [
    "if ! command -v crontab > /dev/null 2>&1; then",
    `  echo ${shellQuote(`::error::${where} has no crontab, which runs the scheduled snapshots (snapshots.schedule in ${planFilePath(plan)}). Install cron there (on Debian and Ubuntu: apt install cron) and push again, or turn the schedule off with opscrew snapshot schedule off.`)}`,
    "  exit 1",
    "fi",
    `{ crontab -l 2> /dev/null | grep -v ${mine} || true; printf ${shellQuote(line)} "$APPS_DIR" ${shellQuote(scheduleTag(plan))}; } | crontab -`,
  ];
}
