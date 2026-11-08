// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import {
  APP_SERVER,
  DATABASE_KINDS,
  type DeployPlan,
  ONLINE_SNAPSHOT_KINDS,
  REDIS_PROTOCOL_KINDS,
  type SelfHostedServiceKind,
  servicesOn,
  snapshotScheduleOf,
  snapshotsOn,
} from "@opscrew/plan-schema";
import { dataDirs, serviceSpec } from "../catalog";
import { IMAGES } from "../pins";
import { FILES_VOLUME, SQLITE_VOLUME } from "../runtime";
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

/**
 * The generation of each service's values on the server, in the app's folder (025 plan.md 12.):
 * one `<service> <generation>` line per service rotated there, the generation the rotation record
 * (`opscrew/credentials.yaml`) gives it; a service it does not name has its first values,
 * generation 1. Numbers only, never a value. `rotate.sh` writes it as each service's data takes
 * its new value (and the old again on an undo), and a rotation on this computer the same. The
 * `about.json` of a volume copy of a stop-only kind, the only copy that holds the service's logins,
 * records the generation it was taken under, so a restore of an older one knows the values its
 * data logs in with; a whole server's own file gives its services' (T2520).
 */
export const SNAPSHOT_GENERATIONS = `${SNAPSHOTS_DIR}/generations`;

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

/** One part of a snapshot: a service that keeps data, the app's SQLite volume or its kept folder. */
export interface SnapshotPart {
  /** The service's name; `sqlite` for the app's SQLite volume, `files` for its kept folder's. */
  name: string;
  kind: SelfHostedServiceKind | "sqlite" | "files";
  /** Its file in the snapshot's folder (024 plan.md 1.). */
  file: string;
  /** Copied while it runs; otherwise stopped alone for its copy. */
  online: boolean;
  /** Valkey's, Redis's and Dragonfly's mode (`options.mode`). */
  mode?: "cache" | "queue";
  /**
   * The image the service runs, as its Compose service pins it, which `about.json` records with
   * its copy; none for the app's volumes.
   */
  image?: string;
}

/** True for a kind a snapshot copies while it runs ({@link ONLINE_SNAPSHOT_KINDS}). */
function onlineKind(kind: SelfHostedServiceKind): boolean {
  return ONLINE_SNAPSHOT_KINDS.some((online) => online === kind);
}

/** True for one of the four databases a snapshot dumps ({@link DATABASE_KINDS}). */
function databaseKind(kind: string): kind is (typeof DATABASE_KINDS)[number] {
  return DATABASE_KINDS.some((database) => database === kind);
}

/** True for Valkey, Redis or Dragonfly ({@link REDIS_PROTOCOL_KINDS}). */
function redisProtocolKind(kind: string): kind is (typeof REDIS_PROTOCOL_KINDS)[number] {
  return REDIS_PROTOCOL_KINDS.some((redis) => redis === kind);
}

/**
 * The parts of a snapshot on `server` (the app's by default, or an extra server's name), in the
 * plan's order: each enabled service placed there, then on the app's server the app's SQLite
 * volume and its kept folder's volume. The four databases' dumps are `<service>.dump`, Valkey's,
 * Redis's and Dragonfly's copies `<service>.rdb`, the SQLite volume `sqlite.tar` (D6), the kept
 * folder `files.tar` and every other kind's volumes `<service>.tar` (024 plan.md 1., the store's
 * contract). The kept folder is copied while the app runs, as its files are.
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
      image: IMAGES[serviceSpec(service.kind).image].ref,
    };
  });
  if (server !== APP_SERVER) return services;
  const { sqlite, files } = plan.storage ?? {};
  return [
    ...services,
    ...(sqlite === undefined
      ? []
      : [{ name: "sqlite", kind: "sqlite", file: "sqlite.tar", online: true } as const]),
    ...(files === undefined
      ? []
      : [{ name: "files", kind: "files", file: "files.tar", online: true } as const]),
  ];
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

/** The parts on `server` that a rollback's down migrations change: its databases and SQLite. */
export function migratedParts(plan: DeployPlan, server: string): SnapshotPart[] {
  return snapshotParts(plan, server).filter(
    (part) => part.kind === "sqlite" || databaseKind(part.kind),
  );
}

/**
 * True when any of the app's servers holds data ({@link snapshotParts}): then the app's server has
 * {@link SNAPSHOT_SCRIPT}, and a restore can hold the app.
 */
export function holdsData(plan: DeployPlan): boolean {
  const servers = [APP_SERVER, ...(plan.servers ?? []).map((server) => server.name)];
  return servers.some((server) => snapshotParts(plan, server).length > 0);
}

/**
 * The extra servers, in plan order, whose data a rollback changes, each after its own one-time
 * approval, saving it first under the running version (plan.md D7, D13): for `snapshot`, those
 * that hold part of the release snapshot ({@link releaseSnapshotServers}); for `migrations`, with
 * `app.migrations`, those that hold a database the down migrations change; with neither, those of
 * either choice.
 */
export function rollbackServers(plan: DeployPlan, choice?: "snapshot" | "migrations"): string[] {
  const snapshot = releaseSnapshotServers(plan);
  const migrations =
    plan.app.migrations === undefined
      ? []
      : (plan.servers ?? [])
          .map((server) => server.name)
          .filter((name) => migratedParts(plan, name).length > 0);
  if (choice === "snapshot") return snapshot;
  if (choice === "migrations") return migrations;
  return (plan.servers ?? [])
    .map((server) => server.name)
    .filter((name) => snapshot.includes(name) || migrations.includes(name));
}

/**
 * The extra servers, in plan order, whose {@link RUNNING_FILE} the deploy keeps, so their
 * snapshots record the version that runs: those with a part ({@link snapshotParts}), when
 * snapshots are on before each release or on a schedule (plan.md D13).
 */
export function runningServers(plan: DeployPlan): string[] {
  if (!snapshotsOn(plan) && snapshotScheduleOf(plan) === undefined) return [];
  return (plan.servers ?? [])
    .map((server) => server.name)
    .filter((name) => snapshotParts(plan, name).length > 0);
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

/**
 * `snapshot_version`, which prints the 64 hex digits of the version a snapshot records: the one
 * {@link snapshotRunning} prints, else, for a local build on this computer (`.env`'s `APP_IMAGE`
 * without a digest), its image's ID (`docker image inspect`); nothing without either. Only
 * `snapshot.sh` records it: the start script's own version stays {@link snapshotRunning}'s, so a
 * local build's deploy takes no release snapshot.
 */
function snapshotVersionFunction(): string[] {
  return shellFunction("snapshot_version", [
    '  _version="$(snapshot_running)"',
    '  if [ -z "$_version" ] && [ -f .env ]; then',
    "    _version_image=\"$(sed -n 's/^APP_IMAGE=//p' .env)\"",
    '    case "$_version_image" in',
    '      "" | *@sha256:*) ;;',
    "      *) _version=\"$(docker image inspect --format '{{.Id}}' \"$_version_image\" 2> /dev/null | sed -n 's/^sha256:\\([0-9a-f]\\{64\\}\\)$/\\1/p')\" ;;",
    "    esac",
    "  fi",
    '  echo "$_version"',
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
export const REDIS_CLIENTS: Record<
  (typeof REDIS_PROTOCOL_KINDS)[number],
  { cli: string; password: string }
> = {
  valkey: { cli: "valkey-cli", password: "VALKEY_PASSWORD" },
  redis: { cli: "redis-cli", password: "REDIS_PASSWORD" },
  dragonfly: { cli: "redis-cli", password: "DFLY_requirepass" },
};

/**
 * The name of the file Dragonfly's `SAVE RDB` writes in its data folder (`<name>.rdb`), never a
 * `dump*` it would load.
 */
export const DRAGONFLY_SAVE = "opscrew-snapshot";

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
 * How a part's copy is put back exactly (024 plan.md 2., research R7), the same on servers and in
 * the user's Portainer, shaped like Portainer's copies: sh that runs inside containers, with no
 * password in an argument. In this order: the service stops cleanly (with `stop`), `put` runs, the
 * service starts again (with `stop`), then `load`, then `after`.
 */
export interface PartRestore {
  /** True when the service stops for `put` and starts again after it. */
  stop: boolean;
  /**
   * Busybox sh, as root, with the service's data volumes read-write at their folders (the app's
   * SQLite volume or kept folder's volume at `/data`), that puts the copy at `from` (`-`: on stdin)
   * back in place of the data there.
   */
  put?: (from: string) => string;
  /**
   * sh in a one-off of the service's own image with its environment, on its network, that loads
   * the copy at `file` into the running service: the four databases' exact restores (the tables and
   * collections made since go too), and Dragonfly's cache from the copy `put` placed.
   */
  load?: (file: string) => string;
  /** Busybox sh like `put`'s, once the service runs again: a cache's placed copy removed. */
  after?: string;
}

/** `cat` of `from`, or of stdin for `-`. */
function catOf(from: string): string {
  return from === "-" ? "cat" : `cat ${from}`;
}

/** Valkey's, Redis's and Dragonfly's client login, its password from the service's environment. */
function redisLogin(kind: keyof typeof REDIS_CLIENTS): string {
  return `export REDISCLI_AUTH="$${REDIS_CLIENTS[kind].password}"`;
}

/**
 * The copy of the running `part` into `file`, sh inside a one-off of its own image with the
 * service's environment, its login from there (no password in an argument): the four databases'
 * dumps (019 research R9), and Valkey's and Redis's `--rdb`. Undefined for the other parts, which
 * Dragonfly, SQLite and the stop-only kinds copy their own way. Servers and Portainer both run it.
 */
export function onlineCopy(part: SnapshotPart, file: string): string | undefined {
  const { name: host, kind } = part;
  if (databaseKind(kind)) {
    const commands = DATABASES[kind];
    return `${commands.login} && ${commands.dump(host, file)}`;
  }
  if (kind === "valkey" || kind === "redis") {
    return `${redisLogin(kind)} && ${REDIS_CLIENTS[kind].cli} -h ${host} --rdb ${file}`;
  }
  return undefined;
}

/**
 * The exact restore of `part` ({@link PartRestore}): the four databases as 019 restores them;
 * Valkey and Redis as `dump.rdb` for a cache (removed once it is loaded), and as the base of a new
 * append-only folder for a queue; Dragonfly as its only `dump` file for a queue, and with
 * `DFLY LOAD` while it runs for a cache; the SQLite volume and the kept folder's (the app stopped)
 * and every stop-only kind's folders emptied and untarred.
 */
export function partRestore(part: SnapshotPart): PartRestore {
  if (part.kind === "sqlite" || part.kind === "files") {
    return {
      stop: false,
      put: (from) => `find /data -mindepth 1 -delete && tar -C /data -xpf ${from}`,
    };
  }
  const { name: service, kind } = part;
  if (databaseKind(kind)) {
    const commands = DATABASES[kind];
    return {
      stop: false,
      load: (file) => `umask 077 && ${commands.login} && ${commands.restore(service, file)}`,
    };
  }
  const dirs = dataDirs(serviceSpec(kind)).map(([, dir]) => dir);
  if (redisProtocolKind(kind)) {
    const [data = "/data"] = dirs;
    const owner = `o="$(stat -c %u:%g ${data})"`;
    const queue = part.mode === "queue";
    if (kind !== "dragonfly") {
      const dir = `${data}/appendonlydir`;
      const base = "appendonly.aof.1.base.rdb";
      return queue
        ? {
            stop: true,
            put: (from) =>
              `${owner} && rm -rf ${dir} && mkdir ${dir} && ${catOf(from)} > ${dir}/${base} && printf 'file ${base} seq 1 type b\\n' > ${dir}/appendonly.aof.manifest && chown -R "$o" ${dir}`,
          }
        : {
            stop: true,
            put: (from) =>
              `${owner} && ${catOf(from)} > ${data}/dump.rdb && chown "$o" ${data}/dump.rdb`,
            // A cache saves nothing: its next start must not load this copy again.
            after: `rm -f ${data}/dump.rdb`,
          };
    }
    const saved = `${data}/${DRAGONFLY_SAVE}.rdb`;
    return queue
      ? {
          stop: true,
          put: (from) =>
            `${owner} && rm -f ${data}/dump* && ${catOf(from)} > ${data}/dump.rdb && chown "$o" ${data}/dump.rdb`,
        }
      : {
          stop: false,
          put: (from) => `${owner} && ${catOf(from)} > ${saved} && chown "$o" ${saved}`,
          load: () =>
            `umask 077 && ${redisLogin(kind)} && [ "$(${REDIS_CLIENTS[kind].cli} -h ${service} DFLY LOAD ${DRAGONFLY_SAVE}.rdb)" = OK ]`,
          after: `rm -f ${saved}`,
        };
  }
  const members = dirs.map((dir) => dir.replace(/^\//, "")).join(" ");
  return {
    stop: true,
    put: (from) => `find ${dirs.join(" ")} -mindepth 1 -delete && tar -C / -xpf ${from} ${members}`,
  };
}

/**
 * A server's lines of `part`'s exact restore ({@link partRestore}) from `file`, `$2` its folder: a
 * stop-only kind through `snapshot_untar`, the others stopped and started as their restore says,
 * with `put` and `after` in busybox one-offs and `load` in a one-off of the service.
 */
function serverRestore(part: SnapshotPart, file: string): string[] {
  const restore = partRestore(part);
  const { name: service } = part;
  const put = restore.put?.("-");
  if (part.kind === "sqlite" || part.kind === "files") {
    return [
      // `snapshot_sqlite_volume` or `snapshot_files_volume` (appVolumeFunction).
      `snapshot_${part.kind}_volume || return 1`,
      `docker run --rm -i --network none -v "$_volume":/data ${IMAGES.busybox.ref} sh -c ${shellQuote(put ?? "")} < ${file} >> ${SNAPSHOT_LOG} 2>&1`,
    ];
  }
  if (!part.online) return [`snapshot_untar ${service} "$2" ${shellQuote(put ?? "")}`];
  const more = (later: boolean) => (later ? " || return 1" : "");
  return [
    ...(restore.stop
      ? [`docker compose stop -t 120 ${service} >> ${SNAPSHOT_LOG} 2>&1 || return 1`]
      : []),
    ...(put === undefined ? [] : [`${box("rw", service, put)} < ${file} || return 1`]),
    ...(restore.stop
      ? [
          `snapshot_start ${service}${more(restore.load !== undefined || restore.after !== undefined)}`,
        ]
      : []),
    ...(restore.load === undefined
      ? []
      : [
          `snapshot_run "$2" ro ${service} ${shellQuote(restore.load(`${MOUNT}/${part.file}`))}${more(restore.after !== undefined)}`,
        ]),
    ...(restore.after === undefined ? [] : [`${box("rw", service, restore.after)} < /dev/null`]),
  ];
}

/** The kept folder's copy: one tar of the folder `dir`, to stdout. */
export function filesTar(dir: string): string {
  return `tar -C ${dir} -cf - .`;
}

/**
 * How each part is copied into `.snapshots/$2` and restored from there (024 plan.md 2., research
 * R7): the four databases as 019 dumps them; Valkey and Redis with `--rdb` from a one-off of their
 * own image; Dragonfly with `SAVE RDB`, copied out read-only; the SQLite volume with
 * {@link SQLITE_COPY} (exit 3 when it is empty: the part is skipped); the kept folder's volume
 * read-only, as one tar ({@link filesTar}) from busybox; every other kind stopped alone, its
 * volumes tarred. An app's volume that does not exist yet (the deploy that adds SQLite or the kept
 * folder snapshots before the app first starts with it) has nothing to copy: exit 3, skipped. Each
 * is restored as {@link partRestore} says ({@link serverRestore}), which fails without its volume.
 */
function partCommands(part: SnapshotPart): PartCommands {
  const file = `.snapshots/"$2"/${part.file}`;
  const restore = serverRestore(part, file);
  if (part.kind === "sqlite") {
    const volume = `--network none -v "$_volume":/data`;
    return {
      take: [
        "snapshot_sqlite_volume || return 3",
        `docker run --rm ${volume} ${IMAGES.python.ref} ${pythonOneLine(SQLITE_COPY)} /data < /dev/null > ${file} 2>> ${SNAPSHOT_LOG}`,
      ],
      restore,
    };
  }
  if (part.kind === "files") {
    return {
      take: [
        "snapshot_files_volume || return 3",
        `docker run --rm --network none -v "$_volume":/data:ro ${IMAGES.busybox.ref} sh -c ${shellQuote(filesTar("/data"))} < /dev/null > ${file} 2>> ${SNAPSHOT_LOG}`,
      ],
      restore,
    };
  }
  const { name: service, kind } = part;
  const run = (command: string) =>
    `snapshot_run "$2" rw ${service} ${shellQuote(`umask 077 && ${command}`)}`;
  const copy = onlineCopy(part, `${MOUNT}/${part.file}`);
  if (copy !== undefined) return { take: [run(copy)], restore };
  const dirs = dataDirs(serviceSpec(kind)).map(([, dir]) => dir);
  if (kind === "dragonfly") {
    const { cli } = REDIS_CLIENTS[kind];
    const saved = `${dirs[0] ?? "/data"}/${DRAGONFLY_SAVE}.rdb`;
    return {
      take: [
        `${run(`${redisLogin(kind)} && [ "$(${cli} -h ${service} SAVE RDB ${DRAGONFLY_SAVE})" = OK ]`)} || return 1`,
        `${box("ro", service, `cat ${saved}`)} < /dev/null > ${file} || return 1`,
        `${box("rw", service, `rm -f ${saved}`)} < /dev/null`,
      ],
      restore,
    };
  }
  const tarDirs = dirs.map((dir) => dir.replace(/^\//, "")).join(" ");
  return { take: [`snapshot_tar ${service} "$2" ${shellQuote(tarDirs)}`], restore };
}

/** A shell function `name` with `body`'s lines. */
function shellFunction(name: string, body: readonly string[]): string[] {
  return [`${name}() {`, ...body, "}"];
}

/**
 * The shell function `name` that sets `$_volume` to the app's volume `volume` (the SQLite
 * volume's, the kept folder's) of its Compose project, and fails when it does not exist. It never
 * makes one: Docker would give a new volume root as its owner, not the app's user.
 */
function appVolumeFunction(name: string, volume: string): string[] {
  return shellFunction(name, [
    `  _volume="\${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}_${volume}"`,
    '  docker volume inspect "$_volume" > /dev/null 2>&1',
  ]);
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
 * - `part_file <part>`, `part_kind <part>`, `part_image <part>`: the part's file, kind and image
 *   (nothing for the SQLite volume and the kept folder's);
 * - `snapshot_room`: whether the folder's disk has 1 GiB and 10% free; otherwise it removes the
 *   partial snapshots and fails;
 * - `snapshot_run <folder> <rw|ro> <service> <script>`: `script` in a one-off container of the
 *   service (its pinned image and env file, on its network, as the deploy user), with
 *   `.snapshots/<folder>` at `/snapshot`, its output appended to {@link SNAPSHOT_LOG};
 * - `snapshot_box <ro|rw> <service> <script>`: `script` in a busybox one-off with no network and
 *   the service's container's volumes, stdin and stdout passed, its errors appended to the log;
 * - `snapshot_stop <service>`: 023's clean stop: 120 seconds, then the container must have exited
 *   on its own (not killed: exit 137) or never started;
 * - `snapshot_start <service>`: its own container started again, once healthy (at once for one
 *   `SNAPSHOT_NO_WAIT` names: its health check may log in with values it gets only then);
 * - `snapshot_tar` and `snapshot_untar`: a stop-only service's copy (stopped cleanly alone, its
 *   volumes tarred, started again when it ran, or a message how to start it) and restore (stopped,
 *   emptied, its folders untarred, started);
 * - `part_take <part> <folder>` (3: nothing to copy), `part_restore <part> <folder>`
 *   ({@link partCommands});
 * - `snapshot_running` ({@link snapshotRunning}) and `snapshot_version` ({@link snapshotVersionFunction});
 * - `snapshot_about <id> <kind> <taken> <version> <folder> [<part>]...`: prints `about.json`, one
 *   line, as the store's contract has it (024 plan.md 1.): `version` the 64-hex digest or empty,
 *   each part's kind, file, size, image (a service's) and, for a stop-only part,
 *   generation (where {@link SNAPSHOT_GENERATIONS} names one), or `skipped` for the parts not given;
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
    ...shellFunction(
      "part_image",
      partCase(parts, (part) => [
        part.image === undefined ? ":" : `echo ${shellQuote(part.image)}`,
      ]),
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
      // One SNAPSHOT_NO_WAIT names starts without waiting for its health check (T2514).
      '  case " ${SNAPSHOT_NO_WAIT:-} " in',
      `    *" $1 "*) docker compose up -d --no-deps --no-recreate "$1" >> ${log} 2>&1 ;;`,
      `    *) docker compose up -d --no-deps --no-recreate --wait "$1" >> ${log} 2>&1 ;;`,
      "  esac",
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
      ? appVolumeFunction("snapshot_sqlite_volume", SQLITE_VOLUME)
      : []),
    ...(parts.some((part) => part.kind === "files")
      ? appVolumeFunction("snapshot_files_volume", FILES_VOLUME)
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
    ...snapshotVersionFunction(),
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
      '        _about_image="$(part_image "$_about_part")"',
      '        if [ -n "$_about_image" ]; then _about_image=",\\"image\\":\\"$_about_image\\""; fi',
      '        _about_generation=""',
      // Only a volume copy of a stop-only kind holds its logins (T2514).
      `        case " $SNAPSHOT_ONLINE " in *" $_about_part "*) ;; *) if [ -f ${SNAPSHOT_GENERATIONS} ]; then _about_generation="$(awk -v s="$_about_part" '$1 == s && $2 ~ /^[1-9][0-9]*$/ { g = $2 } END { if (g != "") print g }' ${SNAPSHOT_GENERATIONS})"; fi ;; esac`,
      '        if [ -n "$_about_generation" ]; then _about_generation=",\\"generation\\":$_about_generation"; fi',
      `        printf '{"name":"%s","kind":"%s","file":"%s","size":%s%s%s}' "$_about_part" "$(part_kind "$_about_part")" "$_about_file" "$(wc -c < "$_about_folder/$_about_file" | tr -d ' ')" "$_about_image" "$_about_generation" ;;`,
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
      // 3: nothing to copy (an empty SQLite volume, or an app's volume not made yet), which the
      // snapshot lists as skipped.
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
