// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
/**
 * The catalog's entries (013): the databases, queues, brokers and object storage OpsCrew runs next
 * to the app (part 1), and the search and analytics engines (part 2). Images, versions and
 * licences: research.md R2, R3, R4, R5, R8 and R9 (Redis 8 and Dragonfly). Part 1's tools,
 * health checks and idle memory: research.md "Spike results" 7–9 (local Docker, 2026-10-19).
 *
 * Memory: each default and minimum leaves room above the idle memory the spike measured (the
 * comment at each entry). Design refuses a service on a server below its smallest one.
 */
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  APP_SERVER,
  type DeployPlan,
  DeviceNameSchema,
  type PlanService,
} from "@opscrew/plan-schema";
import { appServerOf } from "../runtime/move";
import { privateAddress } from "../runtime/network";
import { shellQuote } from "../runtime/services";
import { planFilePath } from "../workflow/shared";
import type { ServiceInitStep } from "../workflow/switch";
import type {
  DatabaseSettings,
  RotationCommand,
  SecretRotation,
  ServiceContext,
  ServiceHealthcheck,
  ServiceRotation,
  ServiceSpec,
} from "./types";

const BOTH_TARGETS: ServiceSpec["targets"] = ["server", "portainer"];
const PASSWORD = { name: "password", format: "hex32" } as const;
const ROOT_PASSWORD = { name: "root-password", format: "hex32" } as const;

// Rotation (feature 025, research R2–R5 and the spike R10): each recipe's commands run in the
// service's container, the values only in its env as OPSCREW_OLD and OPSCREW_NEW (types.ts).

/** The two values of a rotation, as the commands' shells read them. */
const OLD = '"$OPSCREW_OLD"';
const NEW = '"$OPSCREW_NEW"';

/** `script` through the image's `sh`. */
function sh(script: string): RotationCommand {
  return ["sh", "-c", script];
}

/** `script` through the image's bash, for a defaults or config file on a pipe (`<(…)`). */
function bash(script: string): RotationCommand {
  return ["bash", "-c", script];
}

/** A rotation of one secret that runs `begin` and nothing to finish. */
function swap(secret: string, seconds: number, begin: SecretRotation["begin"]): SecretRotation {
  return { secrets: [secret], mode: "swap", seconds, recreate: false, begin, finish: () => [] };
}

/** A rotation of one secret that keeps both values working from `begin` until `finish`. */
function dual(
  secret: string,
  steps: Pick<SecretRotation, "begin" | "finish" | "undo">,
): SecretRotation {
  return { secrets: [secret], mode: "dual", recreate: false, ...steps };
}

/** A secret that changes only with a restart: the service created again with the new env. */
function restart(secret: string, seconds: number): SecretRotation {
  return {
    secrets: [secret],
    mode: "restart",
    seconds,
    recreate: true,
    begin: () => [],
    finish: () => [],
  };
}

/**
 * Where a container keeps the current value of the app's password for the services whose start,
 * health check or tools need it after their first start: written from the env at its first start
 * only ({@link keepFile}), read there, and rewritten by a rotation ({@link newFile}). It is in the
 * container's own filesystem, never the data volume nor a mount, so a restart keeps a rotated value
 * and a container created again from a new env file starts from that.
 */
const PASSWORD_FILE = "/tmp/opscrew-password";

/** MySQL's and MariaDB's root password, as {@link PASSWORD_FILE}. */
const ROOT_PASSWORD_FILE = "/tmp/opscrew-root-password";

/** A subshell that writes the value in `variable` to `file`, readable by the container's user only. */
function writeFile(variable: string, file: string): string {
  return `(umask 077 && printf %s "$${variable}" > ${file})`;
}

/** A start's command that writes `file` from the env's `variable` unless the container has one. */
function keepFile(variable: string, file = PASSWORD_FILE): string {
  return `{ [ -f ${file} ] || ${writeFile(variable, file)}; }`;
}

/**
 * A rotation's command that makes the value in `variable` (`$OPSCREW_NEW`, or `$OPSCREW_OLD` for
 * an undo) the value of `file`, replaced at once: `write` writes it to `<file><suffix>` first.
 */
function newFile(
  file = PASSWORD_FILE,
  variable = "OPSCREW_NEW",
  write: (variable: string, file: string) => string = writeFile,
  suffix = ".new",
): string {
  return `${write(variable, `${file}${suffix}`)} && mv -f ${file}${suffix} ${file}`;
}

/** The value of `file`, as a shell word. */
function current(file = PASSWORD_FILE): string {
  return `"$(cat ${file})"`;
}

/**
 * `change` unless `done` (a command that passes only once the change is made: the new value logs
 * in, or the old one no longer does) passes, so a step run again after it passed changes nothing
 * and a resumed rotation never gets stuck on a login the step itself made stale.
 */
function unlessDone(done: string, change: string): string {
  return `{ ${done} > /dev/null 2>&1 || ${change}; }`;
}

/**
 * Whether the app logs in to `service`: always, except to a Kafka or Redpanda without
 * `options.login`, which then has no login (only the app's own containers reach it).
 */
export function hasLogin(service: PlanService): boolean {
  return !(service.kind === "kafka" || service.kind === "redpanda") || service.options.login;
}

/**
 * The service's host for the app (`host`), which is also the one it advertises to its clients
 * (`advertisedHost`: Kafka's and Redpanda's listeners, MongoDB's replica set): its Compose name on
 * the app's server, or the private address of the extra server it is placed on (ADR 0022). During a
 * move until its switch, the old copy's (`appServerOf`); the kinds that advertise their host never
 * move on a live app.
 */
function serviceHost(ctx: ServiceContext): string {
  const server = appServerOf(ctx.plan, ctx.service);
  return server === APP_SERVER ? ctx.service.name : privateAddress(ctx.plan, server);
}

/** The header of every settings file OpsCrew writes for a service, naming the plan's file. */
function header(plan: DeployPlan, comment: string, ...lines: string[]): string[] {
  return [
    `${comment} Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    ...lines.map((line) => `${comment} ${line}`),
  ];
}

/** {@link header} as XML comments. */
function xmlHeader(plan: DeployPlan, ...lines: string[]): string[] {
  return header(plan, "#", ...lines).map((line) => `<!-- ${line.slice(2)} -->`);
}

/** A URL the app logs in with: `<scheme>://<user>:<password>@<service>:<port><path>`. */
function loginUrl(ctx: ServiceContext, scheme: string, port: number, path: string): string {
  return `${scheme}://app:${ctx.secretRef(PASSWORD.name)}@${serviceHost(ctx)}:${port}${path}`;
}

/** A SQL database's settings one by one: the user and database `app`, as its {@link loginUrl}. */
function sqlSettings(ctx: ServiceContext, port: number): DatabaseSettings {
  return {
    host: serviceHost(ctx),
    port: String(port),
    database: "app",
    user: "app",
    password: ctx.secretRef(PASSWORD.name),
  };
}

/** True for a Valkey, Redis 8 or Dragonfly in queue mode. */
function queueMode(service: PlanService): boolean {
  return "mode" in service.options && service.options.mode === "queue";
}

/**
 * What the app receives from a Valkey, Redis 8 or Dragonfly at `url`: REDIS_URL, but a cache next
 * to a queue instance only its own cache variable, since REDIS_URL is the queue's (job libraries
 * read it).
 */
function redisVariables(ctx: ServiceContext, url: string): Record<string, string> {
  const besideQueue =
    !queueMode(ctx.service) && ctx.plan.services.some((other) => other.enabled && queueMode(other));
  return besideQueue ? {} : { REDIS_URL: url };
}

/** The URL of a Valkey, Redis 8 or Dragonfly, which require the password of their default user. */
function passwordRedisUrl(ctx: ServiceContext): string {
  return `redis://:${ctx.secretRef(PASSWORD.name)}@${serviceHost(ctx)}:6379`;
}

/** A health check that logs in with the container's current password and reads the reply. */
function redisCliCheck(cli = "redis-cli"): ServiceHealthcheck {
  // redis-cli (and valkey-cli) answers NOAUTH with exit code 0, so the check reads the reply.
  return { test: ["CMD-SHELL", `REDISCLI_AUTH=${current()} ${cli} ping | grep -q PONG`] };
}

/** Three quarters of the limit, as Valkey's own memory limit is (research R7). */
function redisMaxmemoryMb(service: PlanService): number {
  return Math.floor(service.memoryMb * 0.75);
}

const POSTGRES: ServiceSpec = {
  kind: "postgres",
  title: "PostgreSQL",
  image: "postgres",
  defaultVersion: "17",
  majorLocked: true,
  licence: { id: "PostgreSQL", permissive: true },
  // Not measured by the 013 spike; the default is what design gave Postgres before 013.
  memory: { defaultMb: 512, minimumMb: 256, smallestServerMb: 1024 },
  port: 5432,
  dataDir: "/var/lib/postgresql/data",
  environment: (ctx) => ({
    POSTGRES_USER: "app",
    POSTGRES_DB: "app",
    POSTGRES_PASSWORD: ctx.secretRef(PASSWORD.name),
  }),
  healthcheck: () => ({ test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"] }),
  secrets: [PASSWORD],
  // `postgresql://` for every name: SQLAlchemy rejects `postgres://`, while libpq, node-postgres,
  // Prisma, Sequelize, dj-database-url, Rails and the Go and Rust drivers accept both.
  address: (ctx) => loginUrl(ctx, "postgresql", 5432, "/app"),
  conventionalVariables: (_ctx, url) => ({ DATABASE_URL: url }),
  databaseSettings: (ctx) => sqlSettings(ctx, 5432),
  targets: BOTH_TARGETS,
  // `app` is the image's superuser, which the container's socket lets in without a password; the
  // image reads POSTGRES_PASSWORD on its first start only.
  rotation: {
    secrets: [
      swap(PASSWORD.name, 1, () => [
        sh(
          `printf "ALTER ROLE app PASSWORD '%s';\\n" ${NEW} | psql -X -q -v ON_ERROR_STOP=1 -U app -d app`,
        ),
      ]),
    ],
  },
};

/**
 * Valkey's and Redis 8's settings for the service's mode. Their own limit is 75% of the
 * container's (research R7). A queue never evicts and keeps an append-only file, so a full queue
 * refuses writes; a cache evicts the least recently used keys and keeps nothing on disk.
 */
function redisModeArgs(service: PlanService): string[] {
  const maxmemory = ["--maxmemory", `${redisMaxmemoryMb(service)}mb`];
  return queueMode(service)
    ? ["--appendonly", "yes", ...maxmemory, "--maxmemory-policy", "noeviction"]
    : ["--save", "", "--appendonly", "no", ...maxmemory, "--maxmemory-policy", "allkeys-lru"];
}

/** `arg` as one shell word: as it is, or quoted when the shell would split or expand it. */
function shellWord(arg: string): string {
  return /^[\w.,:/=@%+-]+$/.test(arg) ? arg : shellQuote(arg);
}

/**
 * The variable of a Valkey, Redis or Dragonfly service's environment that declares the devices'
 * logins: one `<device>:<access>:<sha256 of its password>` line per grant (research R6a).
 */
const ACL_USERS = "OPSCREW_ACL_USERS";

/**
 * Where a Valkey's, Redis's or Dragonfly's container keeps its users (the app's default user and
 * the devices' logins), each password as its SHA-256: written from the env at the container's first
 * start only, then by the server itself (`ACL SAVE`) after each rotation step, so a restart keeps
 * every password the server holds, and a container created again (a changed env file: a new
 * password or grant) starts from the env.
 */
const ACL_FILE = "/tmp/opscrew-users.acl";

/**
 * The name of the secret a Valkey, Redis or Dragonfly service's context resolves to the SHA-256
 * (lower-case hex) of `device`'s login password, for that device's line of `OPSCREW_ACL_USERS`:
 * the service's environment carries the hash only, never the password.
 */
export function grantHashSecret(device: string): string {
  return `grant-sha256:${device}`;
}

/** The plan's device grants on the service of `ctx`. */
function grantsOn(ctx: ServiceContext) {
  return ctx.plan.network?.grants.filter((grant) => grant.service === ctx.service.name) ?? [];
}

/** {@link ACL_USERS} when the service of `ctx` has device grants; else nothing. */
function aclUsers(ctx: ServiceContext): Record<string, string> {
  const grants = grantsOn(ctx);
  if (grants.length === 0) return {};
  const lines = grants.map(
    (grant) => `${grant.device}:${grant.access}:${ctx.secretRef(grantHashSecret(grant.device))}`,
  );
  return { [ACL_USERS]: lines.join("\n") };
}

/** The ACL rules of the default user, the app's login, on Valkey, Redis 8 and Dragonfly. */
const DEFAULT_ACL = "~* &* +@all";

/** The ACL rules of a device's login by its access (research R6a). */
type AclRules = Record<"read-only" | "full", string>;

/**
 * Valkey's and Redis 8's rules: read-only adds what clients send on connecting; full is every
 * data command but no server administration (`-@admin`: CONFIG, MODULE, SHUTDOWN, REPLICAOF, ACL).
 */
const REDIS_ACL: AclRules = {
  "read-only": "~* &* +@read +ping +hello +client|setname +client|setinfo -@write",
  full: `${DEFAULT_ACL} -@admin`,
};

/** Dragonfly's rules: read-only keys need its `%R~*` pattern; full has no server administration. */
const DRAGONFLY_ACL: AclRules = {
  "read-only": "resetkeys %R~* +@read +ping +hello -@write",
  full: "%RW~* +@all -@admin",
};

/**
 * The start wrapper's first commands (research R6a), the files owned by what may read them: when
 * the container has none yet, {@link ACL_FILE}, owned by the server's `user`, with the default user
 * from the app's password in `variable` (as its SHA-256, with {@link DEFAULT_ACL}), then one user
 * per line of {@link ACL_USERS} (none without grants) with its access's `rules` (a line with
 * another access gets none); and {@link PASSWORD_FILE} for the health check and a rotation's
 * commands. A start never opens an existing file for writing: with `fs.protected_regular`
 * (Ubuntu's default) not even root may do that in /tmp to a file another user owns.
 */
function aclFileCommands(variable: string, rules: AclRules, user: string): string[] {
  const users = [
    `printf '%s\\n' "$${ACL_USERS}" | while IFS=: read -r name access hash; do`,
    `case "$access" in read-only) rules='${rules["read-only"]}' ;; full) rules='${rules.full}' ;; *) continue ;; esac;`,
    `printf 'user %s on #%s %s\\n' "$name" "$hash" "$rules"; done;`,
  ].join(" ");
  return [
    "umask 077",
    `{ [ -f ${ACL_FILE} ] || { { h=$(printf %s "$${variable}" | sha256sum | cut -d ' ' -f 1); printf 'user %s on #%s %s\\n' default "$h" '${DEFAULT_ACL}'; ${users} } > ${ACL_FILE} && chown ${user}:${user} ${ACL_FILE}; }; }`,
    keepFile(variable),
  ];
}

/**
 * Valkey or Redis 8 (`server`) with its modes ({@link redisModeArgs}), on its ACL file from the
 * password in `variable` ({@link aclFileCommands}): the password never in a repository file nor the
 * server's command line. The image's entrypoint drops root to the user of the same name (and Redis
 * 8's loads its modules: Search, JSON, Time Series, Bloom) only when the command is the server.
 */
function passwordServerCommand(
  ctx: ServiceContext,
  server: "valkey" | "redis",
  variable: string,
): string[] {
  const args = redisModeArgs(ctx.service).map(shellWord);
  const start = [`exec docker-entrypoint.sh ${server}-server`, "--aclfile", ACL_FILE, ...args];
  return [
    "sh",
    "-c",
    [...aclFileCommands(variable, REDIS_ACL, server), start.join(" ")].join(" && "),
  ];
}

/**
 * `command` (a printf format, its `%s` filled with `value`) and `ACL SAVE` sent on stdin through
 * `cli`, logged in with the password `login` (a shell word), passing only when both replies are
 * `OK` (the CLI answers an error with exit code 0): the server holds the change and its ACL file
 * keeps it.
 */
function aclCommand(cli: string, login: string, command: string, value: string): string {
  return `[ "$(printf '${command}\\nACL SAVE\\n' ${value} | REDISCLI_AUTH=${login} ${cli} | grep -cx OK)" = 2 ]`;
}

/** Whether the password `value` (a shell word) logs in as `user` through `cli` (an `AUTH` on stdin). */
function redisLogsIn(cli: string, user: string, value: string): string {
  return `[ "$(printf 'AUTH %s %s\\n' ${user} ${value} | ${cli})" = OK ]`;
}

/**
 * Valkey's, Redis 8's and Dragonfly's rotations through `cli` (research R3, R10): a user holds any
 * number of passwords, so `begin` adds the new one (unless it logs in already) and makes it the
 * container's current one, and `finish` drops the old (unless it no longer logs in). A device's
 * login (018's grants) the same, logged in as the app's user with the container's current password.
 */
function redisRotation(cli: string): ServiceRotation {
  const device = (name: string) => DeviceNameSchema.parse(name);
  return {
    secrets: [
      dual(PASSWORD.name, {
        begin: () => [
          sh(
            `${unlessDone(redisLogsIn(cli, "default", NEW), aclCommand(cli, OLD, "ACL SETUSER default >%s", NEW))} && ${newFile()}`,
          ),
        ],
        finish: () => [
          sh(
            unlessDone(
              `! ${redisLogsIn(cli, "default", OLD)}`,
              aclCommand(cli, NEW, "ACL SETUSER default <%s", OLD),
            ),
          ),
        ],
      }),
    ],
    grant: {
      // Adding a password it holds already changes nothing.
      begin: (name) => [sh(aclCommand(cli, current(), `ACL SETUSER ${device(name)} >%s`, NEW))],
      finish: (name) => [
        sh(
          unlessDone(
            `! ${redisLogsIn(cli, device(name), OLD)}`,
            aclCommand(cli, current(), `ACL SETUSER ${device(name)} <%s`, OLD),
          ),
        ),
      ],
    },
  };
}

const VALKEY: ServiceSpec = {
  kind: "valkey",
  title: "Valkey",
  image: "valkey",
  defaultVersion: "8",
  // A new major reads the files an older one wrote, and a cache keeps none.
  majorLocked: false,
  licence: { id: "BSD-3-Clause", permissive: true },
  // Idle 5–10 MB (research R4); the rest is the data it keeps in memory.
  memory: { defaultMb: 128, minimumMb: 64, smallestServerMb: 512 },
  port: 6379,
  dataDir: "/data",
  command: (ctx) => passwordServerCommand(ctx, "valkey", "VALKEY_PASSWORD"),
  environment: (ctx) => ({ VALKEY_PASSWORD: ctx.secretRef(PASSWORD.name), ...aclUsers(ctx) }),
  healthcheck: () => redisCliCheck("valkey-cli"),
  secrets: [PASSWORD],
  address: passwordRedisUrl,
  conventionalVariables: redisVariables,
  targets: BOTH_TARGETS,
  rotation: redisRotation("valkey-cli"),
};

const REDIS: ServiceSpec = {
  kind: "redis",
  title: "Redis",
  image: "redis",
  defaultVersion: "8",
  majorLocked: true,
  licence: {
    id: "RSALv2 OR SSPL-1.0 OR AGPL-3.0-only",
    permissive: false,
    note: "Redis is under your choice of the RSALv2, the SSPLv1 or the AGPLv3: running its unmodified image for your own app puts no conditions on your app's code; they apply when you offer Redis itself as a service or change and share it.",
  },
  // Idle 11 MiB with its modules loaded (2026-10-20); the rest is the data it keeps in memory.
  memory: { defaultMb: 128, minimumMb: 64, smallestServerMb: 512 },
  port: 6379,
  dataDir: "/data",
  command: (ctx) => passwordServerCommand(ctx, "redis", "REDIS_PASSWORD"),
  environment: (ctx) => ({ REDIS_PASSWORD: ctx.secretRef(PASSWORD.name), ...aclUsers(ctx) }),
  healthcheck: () => redisCliCheck(),
  secrets: [PASSWORD],
  address: passwordRedisUrl,
  conventionalVariables: redisVariables,
  targets: BOTH_TARGETS,
  rotation: redisRotation("redis-cli"),
};

/** The memory Dragonfly refuses to start without, per thread. */
const DRAGONFLY_THREAD_MB = 256;

/** The vCPUs Dragonfly is offered from (FR-1321a), and its threads where they are not known. */
export const DRAGONFLY_MIN_VCPUS = 2;

/**
 * Dragonfly's flags, always with its threads and memory: three quarters of the limit, and one
 * thread for each 256 MB of that (it refuses to start with less; research R9), at most the
 * server's vCPUs (`options.threads`; {@link DRAGONFLY_MIN_VCPUS} when design does not know them).
 * Its HTTP console on the same port is off. A queue never evicts and keeps a snapshot, saved
 * every minute and when it stops; a cache evicts and keeps nothing. BullMQ's scripts need locks
 * by hashtag (https://www.dragonflydb.io/docs/integrations/bullmq). The wrapper
 * ({@link aclFileCommands}) starts it through the image's entrypoint on its ACL file, with
 * `DFLY_requirepass` unset (Dragonfly would read it at every start).
 */
function dragonflyCommand(ctx: ServiceContext): string[] {
  const flags = dragonflyFlags(ctx.service);
  const start = ["exec entrypoint.sh dragonfly --aclfile", ACL_FILE, ...flags.map(shellWord)];
  const script = [
    ...aclFileCommands("DFLY_requirepass", DRAGONFLY_ACL, "dfly"),
    "unset DFLY_requirepass",
    start.join(" "),
  ];
  return ["sh", "-c", script.join(" && ")];
}

/** {@link dragonflyCommand}'s flags. */
function dragonflyFlags(service: PlanService): string[] {
  const maxmemory = redisMaxmemoryMb(service);
  const options = service.kind === "dragonfly" ? service.options : undefined;
  const threads = Math.max(
    1,
    Math.min(Math.floor(maxmemory / DRAGONFLY_THREAD_MB), options?.threads ?? DRAGONFLY_MIN_VCPUS),
  );
  return [
    "--logtostderr",
    `--proactor_threads=${threads}`,
    `--maxmemory=${maxmemory}mb`,
    "--primary_port_http_enabled=false",
    ...(queueMode(service)
      ? ["--dbfilename=dump", "--snapshot_cron=* * * * *"]
      : ["--cache_mode=true", "--dbfilename="]),
    ...(options?.lockOnHashtags ? ["--cluster_mode=emulated", "--lock_on_hashtags"] : []),
  ];
}

const DRAGONFLY: ServiceSpec = {
  kind: "dragonfly",
  title: "Dragonfly",
  image: "dragonfly",
  defaultVersion: "2",
  majorLocked: true,
  licence: {
    id: "BSL-1.1",
    permissive: false,
    note: "Dragonfly is under the Business Source License 1.1: running it for your own app is allowed, offering it to others as an in-memory data store service is not, and it becomes Apache 2.0 on 2030-11-01.",
  },
  // Idle 37–47 MiB with one thread (2026-10-20); the smallest limit holds one thread's 256 MB.
  memory: { defaultMb: 512, minimumMb: 384, smallestServerMb: 2048 },
  port: 6379,
  dataDir: "/data",
  command: dragonflyCommand,
  // Dragonfly reads each of its flags from `DFLY_<flag>` (an unknown one stops it); the wrapper
  // unsets this one once the ACL file has it.
  environment: (ctx) => ({ DFLY_requirepass: ctx.secretRef(PASSWORD.name), ...aclUsers(ctx) }),
  // Its own health check sends PING without the password and counts any reply.
  healthcheck: () => redisCliCheck(),
  secrets: [PASSWORD],
  address: passwordRedisUrl,
  conventionalVariables: redisVariables,
  targets: BOTH_TARGETS,
  // Two passwords at once too (R10: `>new` adds one).
  rotation: redisRotation("redis-cli"),
};

/**
 * MySQL's settings for a small server (research R2): one buffer pool of the limit less about
 * 400 MB for everything else, in 128 MB chunks, at least 128 MB; no performance schema (about
 * 200 MB idle); 50 connections.
 */
function myCnf(plan: DeployPlan, memoryMb: number): string {
  const pool = Math.max(128, Math.floor((memoryMb - 400) / 128) * 128);
  return [
    ...header(plan, "#", `MySQL settings for its ${memoryMb} MB memory limit.`),
    "[mysqld]",
    `innodb_buffer_pool_size = ${pool}M`,
    "innodb_buffer_pool_instances = 1",
    "performance_schema = OFF",
    "max_connections = 50",
    "",
  ].join("\n");
}

/**
 * The bash script that sends `statement` (a printf format, each `%s` filled with the next of
 * `values`) on stdin to `client` (`mysql`, `mariadb`) as `root@localhost` over the container's
 * socket, with root's password `login` (a shell word) in a defaults file on a pipe, as the images'
 * own entrypoints log in: no value on any command line (research R10: only root may change the
 * app's login).
 */
function asRoot(client: string, login: string, statement: string, ...values: string[]): string {
  return [`printf "${statement}\\n"`, ...values, `| ${sqlClient(client, "root", login)}`].join(" ");
}

/** `client` as `user` over the container's socket, with the password `login` (a shell word). */
function sqlClient(client: string, user: string, login: string): string {
  return `${client} --defaults-extra-file=<(printf '[client]\\npassword=%s\\n' ${login}) -u${user}`;
}

/**
 * `change` (logged in as root) unless the new password logs in as `user` already: run twice,
 * MySQL's `RETAIN CURRENT PASSWORD` would keep the new password and drop the old.
 */
function unlessNewLogsIn(client: string, user: string, change: string): RotationCommand {
  return bash(unlessDone(`${sqlClient(client, user, NEW)} -e 'SELECT 1'`, change));
}

/**
 * MySQL's and MariaDB's start: root's password from the env's `variable` into
 * {@link ROOT_PASSWORD_FILE} at the container's first start only (the app's commands log in as root
 * with it, and root's rotation rewrites it), then the image's own start of `server`.
 */
function keepRootCommand(variable: string, server: string): string[] {
  return [
    "sh",
    "-c",
    `${keepFile(variable, ROOT_PASSWORD_FILE)} && exec docker-entrypoint.sh ${server}`,
  ];
}

/** Root's two accounts, `root@localhost` (the socket's) and `root@'%'` (TCP's), each with `change`. */
function rootAccounts(change: string): string {
  return `ALTER USER 'root'@'localhost' ${change}; ALTER USER 'root'@'%%' ${change};`;
}

/**
 * Root's `begin` through `client`: both accounts given the new password with `change` (logged in
 * with the old) unless it logs in already, then the container's current root password rewritten.
 */
function rootBegin(client: string, change: string): SecretRotation["begin"] {
  return () => [
    unlessNewLogsIn(client, "root", asRoot(client, OLD, rootAccounts(change), NEW, NEW)),
    sh(newFile(ROOT_PASSWORD_FILE)),
  ];
}

/** MySQL's `statement` logged in as root with the container's current root password. */
function mysqlRoot(statement: string, ...values: string[]): string {
  return asRoot("mysql", current(ROOT_PASSWORD_FILE), statement, ...values);
}

const MYSQL: ServiceSpec = {
  kind: "mysql",
  title: "MySQL",
  image: "mysql",
  defaultVersion: "8.4",
  majorLocked: true,
  licence: {
    id: "GPL-2.0",
    permissive: false,
    note: "MySQL is under the GPL 2.0: running it as your app's database puts no conditions on your app's code; they apply only when you share MySQL itself.",
  },
  // Idle 435 MiB with the image's defaults, which my.cnf lowers (no performance schema).
  memory: { defaultMb: 512, minimumMb: 384, smallestServerMb: 1024 },
  port: 3306,
  dataDir: "/var/lib/mysql",
  configFiles: (ctx) => [
    {
      name: "my.cnf",
      target: "/etc/mysql/conf.d/opscrew.cnf",
      content: myCnf(ctx.plan, ctx.service.memoryMb),
    },
  ],
  command: () => keepRootCommand("MYSQL_ROOT_PASSWORD", "mysqld"),
  environment: (ctx) => ({
    MYSQL_DATABASE: "app",
    MYSQL_USER: "app",
    MYSQL_PASSWORD: ctx.secretRef(PASSWORD.name),
    MYSQL_ROOT_PASSWORD: ctx.secretRef(ROOT_PASSWORD.name),
  }),
  // Liveness only: it exits 0 even when the login is refused, so it needs no password. Over TCP,
  // since the image's first-start server listens on the socket only.
  healthcheck: () => ({ test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"], startSeconds: 60 }),
  secrets: [PASSWORD, ROOT_PASSWORD],
  address: (ctx) => loginUrl(ctx, "mysql", 3306, "/app"),
  conventionalVariables: (_ctx, url) => ({ DATABASE_URL: url }),
  databaseSettings: (ctx) => sqlSettings(ctx, 3306),
  targets: BOTH_TARGETS,
  // An account keeps one old password beside the new (`RETAIN`) until `DISCARD`; the image reads
  // both env passwords on its first start only. The app's commands log in as root with the
  // container's current root password ({@link ROOT_PASSWORD_FILE}), which works wherever a
  // rotation stopped: root's `begin` writes the file only once the new password works. Each undo
  // is its own: `begin` with the values swapped would skip (the old password logs in, retained)
  // and `finish` would then discard it.
  rotation: {
    secrets: [
      dual(PASSWORD.name, {
        begin: () => [
          unlessNewLogsIn(
            "mysql",
            "app",
            mysqlRoot("ALTER USER 'app'@'%%' IDENTIFIED BY '%s' RETAIN CURRENT PASSWORD;", NEW),
          ),
        ],
        // A discard with no old password left changes nothing.
        finish: () => [bash(mysqlRoot("ALTER USER 'app'@'%%' DISCARD OLD PASSWORD;"))],
        // The old password the only one again (a new primary keeps the retained one until the
        // discard); run again, it changes nothing.
        undo: () => [
          bash(
            mysqlRoot(
              "ALTER USER 'app'@'%%' IDENTIFIED BY '%s'; ALTER USER 'app'@'%%' DISCARD OLD PASSWORD;",
              OLD,
            ),
          ),
        ],
      }),
      dual(ROOT_PASSWORD.name, {
        begin: rootBegin("mysql", "IDENTIFIED BY '%s' RETAIN CURRENT PASSWORD"),
        finish: () => [bash(asRoot("mysql", NEW, rootAccounts("DISCARD OLD PASSWORD")))],
        // The file's first, then the old password the only one on both accounts again, logged in
        // with it: before `finish` it always logs in (retained beside the new, or alone), also run
        // again, and the file holds a password that logs in between the two.
        undo: () => [
          sh(newFile(ROOT_PASSWORD_FILE, "OPSCREW_OLD")),
          bash(
            asRoot(
              "mysql",
              OLD,
              `${rootAccounts("IDENTIFIED BY '%s'")} ${rootAccounts("DISCARD OLD PASSWORD")}`,
              OLD,
              OLD,
            ),
          ),
        ],
      }),
    ],
  },
};

const MARIADB: ServiceSpec = {
  kind: "mariadb",
  title: "MariaDB",
  image: "mariadb",
  defaultVersion: "12.3",
  majorLocked: true,
  licence: {
    id: "GPL-2.0",
    permissive: false,
    note: "MariaDB is under the GPL 2.0: running it as your app's database puts no conditions on your app's code; they apply only when you share MariaDB itself.",
  },
  // Idle 125 MiB.
  memory: { defaultMb: 384, minimumMb: 256, smallestServerMb: 1024 },
  port: 3306,
  dataDir: "/var/lib/mysql",
  command: () => keepRootCommand("MARIADB_ROOT_PASSWORD", "mariadbd"),
  environment: (ctx) => ({
    MARIADB_DATABASE: "app",
    MARIADB_USER: "app",
    MARIADB_PASSWORD: ctx.secretRef(PASSWORD.name),
    MARIADB_ROOT_PASSWORD: ctx.secretRef(ROOT_PASSWORD.name),
  }),
  // The image writes the check's own login on first start.
  healthcheck: () => ({
    test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
    startSeconds: 30,
  }),
  secrets: [PASSWORD, ROOT_PASSWORD],
  address: (ctx) => loginUrl(ctx, "mysql", 3306, "/app"),
  conventionalVariables: (_ctx, url) => ({ DATABASE_URL: url }),
  databaseSettings: (ctx) => sqlSettings(ctx, 3306),
  targets: BOTH_TARGETS,
  // One password per account (`RETAIN` is a syntax error); the image reads both env passwords on
  // its first start only. The app never logs in as root, so root's change fails nothing; the app's
  // commands log in as root with the container's current root password (ROOT_PASSWORD_FILE).
  rotation: {
    secrets: [
      // Setting the password it has already changes nothing.
      swap(PASSWORD.name, 1, () => [
        bash(
          asRoot(
            "mariadb",
            current(ROOT_PASSWORD_FILE),
            "ALTER USER 'app'@'%%' IDENTIFIED BY '%s';",
            NEW,
          ),
        ),
      ]),
      dual(ROOT_PASSWORD.name, {
        begin: rootBegin("mariadb", "IDENTIFIED BY '%s'"),
        finish: () => [],
      }),
    ],
  },
};

/** MongoDB's replica set: one member, named after the service (clients connect to that name). */
const REPLICA_SET = "rs0";
const KEY_FILE = "/data/configdb/keyfile";

/** WiredTiger's cache: about half the limit, at least 0.25 GB (it may ignore container limits). */
function mongoCacheGb(memoryMb: number): number {
  return Math.max(0.25, Math.floor((memoryMb / 2 / 1024) * 100) / 100);
}

function replicaSet(ctx: ServiceContext): boolean {
  return ctx.service.kind === "mongodb" && ctx.service.options.replicaSet;
}

/**
 * The root password from the env into {@link PASSWORD_FILE} at the container's first start only
 * (the setup steps log in with it, and a rotation rewrites it), then `mongod` through the image's
 * entrypoint, which starts it as its own user. With a replica set, mongod needs a keyFile with a
 * password: it is written once into the configdb volume as root first.
 */
function mongoCommand(ctx: ServiceContext): string[] {
  const cache = ["--wiredTigerCacheSizeGB", String(mongoCacheGb(ctx.service.memoryMb))];
  const mongod = replicaSet(ctx)
    ? ["mongod", "--replSet", REPLICA_SET, "--keyFile", KEY_FILE, ...cache]
    : ["mongod", ...cache];
  return [
    "bash",
    "-c",
    [
      "set -e",
      keepFile("MONGO_INITDB_ROOT_PASSWORD"),
      ...(replicaSet(ctx)
        ? [
            `[ -f ${KEY_FILE} ] || { head -c 756 /dev/urandom | base64 -w 0 > ${KEY_FILE} && chmod 400 ${KEY_FILE} && chown 999:999 ${KEY_FILE}; }`,
          ]
        : []),
      `exec docker-entrypoint.sh ${mongod.join(" ")} --bind_ip_all`,
    ].join("; "),
  ];
}

/**
 * mongosh in the service's container, logged in as the root user with the container's current
 * password (its bash reads it, so the password is in no repository file and no log).
 */
function mongosh(script: string): string[] {
  return [
    "bash",
    "-c",
    `mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p ${current()} --authenticationDatabase admin --eval '${script}'`,
  ];
}

/**
 * The replica set's setup: unless `rs.status()` answers, initiate the set with the service name
 * as its one member (clients connect to the names the set lists), then wait up to 30 seconds for
 * it to accept writes, so the release command finds a primary.
 */
function mongoInit(ctx: ServiceContext): ServiceInitStep[] {
  if (!replicaSet(ctx)) return [];
  const member = `${serviceHost(ctx)}:27017`;
  return [
    {
      service: ctx.service.name,
      check: mongosh("rs.status().ok"),
      run: mongosh(
        `rs.initiate({ _id: "${REPLICA_SET}", members: [{ _id: 0, host: "${member}" }] }); for (let i = 0; i < 60 && !db.hello().isWritablePrimary; i++) sleep(500)`,
      ),
    },
  ];
}

const MONGODB: ServiceSpec = {
  kind: "mongodb",
  title: "MongoDB",
  image: "mongodb",
  defaultVersion: "8.0",
  majorLocked: true,
  licence: {
    id: "SSPL-1.0",
    permissive: false,
    note: "MongoDB is under the SSPL: using it as your own app's database is unrestricted; its extra conditions apply only when you offer MongoDB itself as a service to others.",
  },
  // Idle 121–157 MiB with a 0.25 GB cache.
  memory: { defaultMb: 512, minimumMb: 384, smallestServerMb: 1024 },
  port: 27017,
  // The image declares both as volumes: each needs a mount, or Docker adds an anonymous one.
  dataDir: { db: "/data/db", configdb: "/data/configdb" },
  command: mongoCommand,
  environment: (ctx) => ({
    MONGO_INITDB_ROOT_USERNAME: "app",
    MONGO_INITDB_ROOT_PASSWORD: ctx.secretRef(PASSWORD.name),
  }),
  healthcheck: () => ({
    test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"],
    startSeconds: 30,
  }),
  init: mongoInit,
  secrets: [PASSWORD],
  address: (ctx) => {
    const query = replicaSet(ctx)
      ? `?authSource=admin&replicaSet=${REPLICA_SET}`
      : "?authSource=admin";
    return loginUrl(ctx, "mongodb", 27017, `/app${query}`);
  },
  conventionalVariables: (_ctx, url) => ({ DATABASE_URL: url, MONGODB_URI: url }),
  targets: BOTH_TARGETS,
  // `app` is the root user; the image reads its env password on the first start only, and the
  // replica set's setup step logs in with the container's current one, which `begin` rewrites.
  // mongosh takes the login only as an argument (R10).
  rotation: {
    secrets: [
      swap(PASSWORD.name, 2, () => {
        const login = (value: string) =>
          `mongosh --quiet -u app -p ${value} --authenticationDatabase admin admin`;
        return [
          bash(
            `${unlessDone(`${login(NEW)} --eval 'db.runCommand({ ping: 1 }).ok'`, `${login(OLD)} --eval 'db.changeUserPassword("app", process.env.OPSCREW_NEW)'`)} && ${newFile()}`,
          ),
        ];
      }),
    ],
  },
};

/**
 * RabbitMQ's settings: an absolute memory alarm at 0.4 of the limit, since its own reading of
 * the container's limit is unreliable (research R4). The alarm blocks publishers, not the node.
 */
function rabbitmqConf(plan: DeployPlan, memoryMb: number): string {
  return [
    ...header(
      plan,
      "#",
      `RabbitMQ settings for its ${memoryMb} MB memory limit, loaded after the image's own.`,
      "The memory alarm blocks publishers well before Docker's limit would stop the node.",
    ),
    `vm_memory_high_watermark.absolute = ${Math.floor(memoryMb * 0.4)}MB`,
    "# The default user is `app` (RABBITMQ_DEFAULT_USER), so RabbitMQ never creates `guest`; were",
    "# it there, it could log in only from inside the container.",
    "loopback_users.guest = true",
    "",
  ].join("\n");
}

const RABBITMQ: ServiceSpec = {
  kind: "rabbitmq",
  title: "RabbitMQ",
  image: "rabbitmq",
  defaultVersion: "4.3",
  majorLocked: true,
  licence: { id: "MPL-2.0", permissive: true },
  // Idle 130 MiB.
  memory: { defaultMb: 384, minimumMb: 256, smallestServerMb: 1024 },
  port: 5672,
  dataDir: "/var/lib/rabbitmq",
  configFiles: (ctx) => [
    {
      name: "rabbitmq.conf",
      target: "/etc/rabbitmq/conf.d/90-opscrew.conf",
      content: rabbitmqConf(ctx.plan, ctx.service.memoryMb),
    },
  ],
  // Its data folder is named after the node, `rabbit@<hostname>`.
  hostname: true,
  environment: (ctx) => ({
    RABBITMQ_DEFAULT_USER: "app",
    RABBITMQ_DEFAULT_PASS: ctx.secretRef(PASSWORD.name),
  }),
  healthcheck: () => ({ test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"], startSeconds: 30 }),
  secrets: [PASSWORD],
  // `%2F` is the default virtual host `/`; a URL without a path leaves it to each client.
  address: (ctx) => loginUrl(ctx, "amqp", 5672, "/%2F"),
  conventionalVariables: (_ctx, url) => ({ AMQP_URL: url, RABBITMQ_URL: url }),
  targets: BOTH_TARGETS,
  // RABBITMQ_DEFAULT_PASS is read on the first boot only; rabbitmqctl takes the value only as an
  // argument (R10) and logs in with the node's cookie.
  rotation: {
    secrets: [swap(PASSWORD.name, 3, () => [sh(`rabbitmqctl change_password app ${NEW}`)])],
  },
};

/** Where NATS's container keeps the token, in the folder of its settings (the include's root). */
const NATS_TOKEN_FILE = "/etc/nats/opscrew-token.conf";

/**
 * A subshell that writes the token in the variable `variable` to `file` as the settings variable
 * `NATS_TOKEN`, readable by the container's root only.
 */
function natsTokenFile(variable: string, file: string): string {
  return `(umask 077 && printf 'NATS_TOKEN: "%s"\\n' "$${variable}" > ${file})`;
}

/**
 * NATS's settings, always mounted: the image's default carries a hard-coded cluster password
 * (research "Spike results" 9). Token login, JetStream on the data volume, and monitoring (for
 * the health check) on the container's loopback only. The token is the settings variable of
 * {@link NATS_TOKEN_FILE}, included first, which wins over the env var of the same name: the
 * container writes it from its env at its first start, and a rotation rewrites it and reloads
 * (research R10).
 */
function natsConf(plan: DeployPlan, memoryMb: number): string {
  return [
    ...header(plan, "#", `NATS settings for its ${memoryMb} MB memory limit.`),
    "port: 4222",
    'http: "127.0.0.1:8222"',
    "# NATS_TOKEN: the container writes it from its environment at its first start, and a",
    "# credential rotation rewrites it.",
    "include ./opscrew-token.conf",
    "authorization {",
    "  token: $NATS_TOKEN",
    "}",
    "jetstream {",
    "  store_dir: /data",
    `  max_memory_store: ${Math.floor(memoryMb / 4)}M`,
    "  max_file_store: 10G",
    "}",
    "",
  ].join("\n");
}

const NATS_CONF = "/etc/nats/nats-server.conf";

const NATS: ServiceSpec = {
  kind: "nats",
  title: "NATS",
  image: "nats",
  defaultVersion: "2.15",
  majorLocked: true,
  licence: { id: "Apache-2.0", permissive: true },
  // Idle 7 MiB.
  memory: { defaultMb: 64, minimumMb: 32, smallestServerMb: 512 },
  port: 4222,
  dataDir: "/data",
  configFiles: (ctx) => [
    { name: "nats.conf", target: NATS_CONF, content: natsConf(ctx.plan, ctx.service.memoryMb) },
  ],
  // The token's file first, only when the container has none yet: a restart keeps a rotated token.
  command: () => [
    "sh",
    "-c",
    `[ -f ${NATS_TOKEN_FILE} ] || ${natsTokenFile("NATS_TOKEN", NATS_TOKEN_FILE)} && exec nats-server --config ${NATS_CONF}`,
  ],
  environment: (ctx) => ({ NATS_TOKEN: ctx.secretRef("token") }),
  healthcheck: () => ({ test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:8222/healthz"] }),
  secrets: [{ name: "token", format: "hex32" }],
  address: (ctx) => `nats://${ctx.secretRef("token")}@${serviceHost(ctx)}:4222`,
  conventionalVariables: (_ctx, url) => ({ NATS_URL: url }),
  targets: BOTH_TARGETS,
  // One token: the reload applies the new one at once and closes the clients of the old (R10).
  rotation: {
    secrets: [
      {
        ...swap("token", 1, () => [
          sh(
            `${newFile(NATS_TOKEN_FILE, "OPSCREW_NEW", natsTokenFile)} && nats-server --signal reload=1`,
          ),
        ]),
        closesConnections: true,
      },
    ],
  },
};

/** The user of Kafka's and Redpanda's login, and its mechanism (research R8). */
const BROKER_USER = "app";
const SCRAM = "SCRAM-SHA-512";

/**
 * Kafka and Redpanda: where the app's Kafka clients connect, and the names they read it from; with
 * the login, OpsCrew's names for it too (no client has a convention of its own, research R7).
 */
const BROKER_VARIABLES: Pick<ServiceSpec, "address" | "conventionalVariables"> = {
  address: (ctx) => `${serviceHost(ctx)}:9092`,
  conventionalVariables: (ctx, brokers) => ({
    KAFKA_BROKERS: brokers,
    KAFKA_BOOTSTRAP_SERVERS: brokers,
    ...(hasLogin(ctx.service)
      ? {
          KAFKA_SASL_MECHANISM: SCRAM,
          KAFKA_SASL_USERNAME: BROKER_USER,
          KAFKA_SASL_PASSWORD: ctx.secretRef(PASSWORD.name),
          KAFKA_SECURITY_PROTOCOL: "SASL_PLAINTEXT",
        }
      : {}),
  }),
};

/** A KRaft cluster's ID: 16 bytes as unpadded base64url, fixed for the app and the service. */
function kafkaClusterId(ctx: ServiceContext): string {
  const hex = sha256Hex(`${ctx.plan.app.name}/${ctx.service.name}`).slice(0, 32);
  return Buffer.from(hex, "hex").toString("base64url");
}

/** With the login, the listener of the broker's own traffic and of the user's setup. */
const KAFKA_LOOPBACK = "PLAINTEXT://localhost:9094";

/**
 * Kafka's listeners; the controller's is on loopback either way. Without the login, the app's
 * PLAINTEXT on 9092. With it (research R8):
 * - the clients' listener on 9092 asks for SCRAM-SHA-512. It is named `CLIENT`: one named
 *   `SASL_PLAINTEXT` makes the image demand `KAFKA_OPTS`. The broker needs its JAAS entry even for
 *   SCRAM;
 * - the broker's own traffic uses the listener named `PLAINTEXT`, on loopback, so it is advertised;
 * - the password is `SASL_PASSWORD`: the image makes every `KAFKA_` variable a server property.
 */
function kafkaListeners(ctx: ServiceContext): Record<string, string> {
  const host = serviceHost(ctx);
  if (!hasLogin(ctx.service)) {
    return {
      KAFKA_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://localhost:9093",
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${host}:9092`,
      KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
    };
  }
  return {
    KAFKA_LISTENERS: `CLIENT://:9092,${KAFKA_LOOPBACK},CONTROLLER://localhost:9093`,
    KAFKA_ADVERTISED_LISTENERS: `CLIENT://${host}:9092,${KAFKA_LOOPBACK}`,
    KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
      "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,CLIENT:SASL_PLAINTEXT",
    KAFKA_SASL_ENABLED_MECHANISMS: SCRAM,
    KAFKA_LISTENER_NAME_CLIENT_SCRAM___SHA___512_SASL_JAAS_CONFIG:
      "org.apache.kafka.common.security.scram.ScramLoginModule required;",
    SASL_PASSWORD: ctx.secretRef(PASSWORD.name),
  };
}

/**
 * One combined broker and controller (KRaft) with every replication factor at 1: the image needs
 * all of them once any `KAFKA_*` setting is given. Its listeners: {@link kafkaListeners}. The
 * heap is half the limit; logs are kept `retentionHours` (Kafka's own 168 by default) and, with
 * `retentionGb`, at most that much per partition.
 */
function kafkaEnvironment(ctx: ServiceContext): Record<string, string> {
  const { retentionHours, retentionGb } = ctx.service.kind === "kafka" ? ctx.service.options : {};
  const heap = `${Math.floor(ctx.service.memoryMb / 2)}m`;
  return {
    CLUSTER_ID: kafkaClusterId(ctx),
    KAFKA_NODE_ID: "1",
    KAFKA_PROCESS_ROLES: "broker,controller",
    ...kafkaListeners(ctx),
    KAFKA_CONTROLLER_QUORUM_VOTERS: "1@localhost:9093",
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
    KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: "1",
    KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: "1",
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0",
    KAFKA_LOG_DIRS: "/var/lib/kafka/data",
    KAFKA_LOG_RETENTION_HOURS: String(retentionHours ?? 168),
    ...(retentionGb === undefined
      ? {}
      : { KAFKA_LOG_RETENTION_BYTES: String(retentionGb * 1024 ** 3) }),
    KAFKA_HEAP_OPTS: `-Xmx${heap} -Xms${heap}`,
  };
}

/**
 * One of Kafka's tools: a JVM of its own (about 2 seconds), with a small heap so it fits beside
 * the broker's.
 */
export function kafkaTool(name: string): string {
  return `KAFKA_HEAP_OPTS=-Xmx64m /opt/kafka/bin/${name}.sh`;
}

/** `kafka-configs.sh` on the loopback listener, for the login's user. */
const KAFKA_USER_CONFIGS = `${kafkaTool("kafka-configs")} --bootstrap-server localhost:9094`;
const KAFKA_USER_ENTITY = `--entity-type users --entity-name ${BROKER_USER}`;

/** `kafka-configs.sh` setting the login's password `password` (a shell word inside quotes). */
function kafkaSetPassword(password: string): string {
  return `${KAFKA_USER_CONFIGS} --alter --add-config "${SCRAM}=[password=${password}]" ${KAFKA_USER_ENTITY}`;
}

/**
 * With the login, the container adds its own user before the broker serves anyone (research R8):
 * the password from the env into {@link PASSWORD_FILE} at its first start only, then a background
 * loop sets the user's password from that file on the loopback listener until the broker answers
 * (harmless at every start, and on a broker that already holds data), and the image's own start
 * runs as PID 1. Without it, the image's own command.
 */
function kafkaCommand(ctx: ServiceContext): string[] | undefined {
  if (!hasLogin(ctx.service)) return undefined;
  const add = kafkaSetPassword(`$(cat ${PASSWORD_FILE})`);
  return [
    "sh",
    "-c",
    `${keepFile("SASL_PASSWORD")}; (until ${add}; do sleep 2; done) & exec /etc/kafka/docker/run`,
  ];
}

const KAFKA: ServiceSpec = {
  kind: "kafka",
  title: "Apache Kafka",
  image: "kafka",
  defaultVersion: "4.3",
  majorLocked: true,
  licence: { id: "Apache-2.0", permissive: true },
  // Idle 381 MiB with the image's default heap; a JVM, so 1 GB servers are refused.
  memory: { defaultMb: 1024, minimumMb: 768, smallestServerMb: 2048 },
  port: 9092,
  // The image also declares its secrets and shared config folders as volumes, which stay empty
  // here: each needs a mount of its own, or Docker adds an anonymous volume that `down` leaves
  // behind.
  dataDir: {
    data: "/var/lib/kafka/data",
    secrets: "/etc/kafka/secrets",
    config: "/mnt/shared/config",
  },
  // It runs as uid 1000.
  namedVolume: true,
  command: kafkaCommand,
  environment: kafkaEnvironment,
  // With the login, healthy only once its user exists, so the app never starts before it.
  healthcheck: (ctx) => ({
    test: [
      "CMD-SHELL",
      hasLogin(ctx.service)
        ? `${KAFKA_USER_CONFIGS} --describe ${KAFKA_USER_ENTITY} | grep -q ${SCRAM}`
        : `${kafkaTool("kafka-broker-api-versions")} --bootstrap-server localhost:9092 > /dev/null`,
    ],
    timeoutSeconds: 10,
    startSeconds: 60,
  }),
  // Also without the login, so turning it on changes no secret.
  secrets: [PASSWORD],
  ...BROKER_VARIABLES,
  targets: BOTH_TARGETS,
  // One credential per mechanism, set on the loopback listener; kafka-configs takes it only as an
  // argument (R10). The start loop sets the container's current one, which `begin` rewrites.
  // Without the login, nothing runs.
  rotation: {
    secrets: [
      swap(PASSWORD.name, 3, (ctx) =>
        hasLogin(ctx.service) ? [sh(`${kafkaSetPassword("$OPSCREW_NEW")} && ${newFile()}`)] : [],
      ),
    ],
  },
};

/** Redpanda's admin API answers this without a login, also once it asks for one (research R8). */
const REDPANDA_READY = "http://localhost:9644/v1/status/ready";

/**
 * With the login, Schema Registry, the HTTP Proxy and RPC on loopback: only 9092 and the admin
 * API's 9644 stay reachable.
 */
const REDPANDA_LOOPBACK = [
  "--rpc-addr",
  "127.0.0.1:33145",
  "--schema-registry-addr",
  "127.0.0.1:8081",
  "--pandaproxy-addr",
  "127.0.0.1:8082",
];

/**
 * The login's setup through `rpk` on the admin API, in the documented order (research R7, R8):
 * the user (`create` fails when it exists and `update` when it doesn't), the one superuser, SASL,
 * then an admin API that asks for the login. None needs a restart or changes data.
 */
const REDPANDA_LOGIN = [
  `{ rpk security user create ${BROKER_USER} -p "$RPK_PASS" --mechanism ${SCRAM} || rpk security user update ${BROKER_USER} --new-password "$RPK_PASS" --mechanism ${SCRAM}; }`,
  `rpk cluster config set superusers '["${BROKER_USER}"]'`,
  "rpk cluster config set enable_sasl true",
  "rpk cluster config set admin_api_require_auth true",
].join(" && ");

/** One core; its own memory is the limit less 512 MB for everything outside it. */
function redpandaStart(ctx: ServiceContext): string[] {
  return [
    "redpanda",
    "start",
    "--smp",
    "1",
    "--memory",
    `${ctx.service.memoryMb - 512}M`,
    "--reserve-memory",
    "0M",
    "--overprovisioned",
    "--kafka-addr",
    "0.0.0.0:9092",
    "--advertise-kafka-addr",
    `${serviceHost(ctx)}:9092`,
  ];
}

/**
 * Redpanda's start. With the login, a shell ({@link REDPANDA.entrypoint}) takes the password from
 * the env into {@link PASSWORD_FILE} at the container's first start only and gives `rpk` that
 * file's (`RPK_PASS`), repeats {@link REDPANDA_LOGIN} in the background until it passes (harmless at
 * every start, and on a cluster that already holds data), then runs the image's own start, on
 * loopback but for 9092 and 9644, as PID 1.
 */
function redpandaCommand(ctx: ServiceContext): string[] {
  const start = redpandaStart(ctx);
  if (!hasLogin(ctx.service)) return start;
  const run = [...start, ...REDPANDA_LOOPBACK].map(shellWord).join(" ");
  return [
    `${keepFile("RPK_PASS")}; export RPK_PASS=${current()}; login() { ${REDPANDA_LOGIN}; }; (until login; do sleep 2; done) & exec /entrypoint.sh ${run}`,
  ];
}

const REDPANDA: ServiceSpec = {
  kind: "redpanda",
  title: "Redpanda",
  image: "redpanda",
  defaultVersion: "26.2",
  majorLocked: true,
  licence: {
    id: "BSL-1.1",
    permissive: false,
    note: "Redpanda is under the Business Source License 1.1: running it for your own app is allowed, offering Redpanda itself as a service to others is not, and each release becomes Apache 2.0 after four years.",
  },
  // Idle 278 MiB with 1 GB of its own memory.
  memory: { defaultMb: 1536, minimumMb: 1024, smallestServerMb: 2048 },
  port: 9092,
  dataDir: "/var/lib/redpanda/data",
  // It runs as uid 101.
  namedVolume: true,
  command: redpandaCommand,
  // The image's entrypoint runs only `rpk`.
  entrypoint: (ctx) => (hasLogin(ctx.service) ? ["sh", "-c"] : undefined),
  // With the login, rpk logs in with these once the admin API asks for it.
  environment: (ctx): Record<string, string> =>
    hasLogin(ctx.service)
      ? { RPK_USER: BROKER_USER, RPK_PASS: ctx.secretRef(PASSWORD.name), RPK_SASL_MECHANISM: SCRAM }
      : {},
  // With the login, healthy only once the admin API asks for it, which comes last; rpk logs in with
  // the container's current password.
  healthcheck: (ctx) => ({
    test: hasLogin(ctx.service)
      ? [
          "CMD-SHELL",
          `curl -fsS ${REDPANDA_READY} > /dev/null && RPK_PASS=${current()} rpk cluster config get admin_api_require_auth | grep -qx true`,
        ]
      : ["CMD", "curl", "-fsS", REDPANDA_READY],
    startSeconds: 30,
  }),
  // Also without the login, so turning it on changes no secret.
  secrets: [PASSWORD],
  ...BROKER_VARIABLES,
  targets: BOTH_TARGETS,
  // `rpk` logs in with the old password and takes the new one only as an argument (R10); the start
  // loop, rpk and the health check then read the container's current one, which `begin` rewrites.
  // Without the login, nothing runs.
  rotation: {
    secrets: [
      swap(PASSWORD.name, 2, (ctx) =>
        hasLogin(ctx.service)
          ? [
              sh(
                `${unlessDone(`RPK_PASS=${NEW} rpk security user list`, `RPK_PASS=${OLD} rpk security user update ${BROKER_USER} --new-password ${NEW} --mechanism ${SCRAM}`)} && ${newFile()}`,
              ),
            ]
          : [],
      ),
    ],
  },
};

/** Garage on one node, without replication; its RPC secret is `GARAGE_RPC_SECRET`. */
function garageToml(ctx: ServiceContext): string {
  return [
    ...header(
      ctx.plan,
      "#",
      "Garage on one node, without replication. Its RPC secret is GARAGE_RPC_SECRET in the",
      "service's environment.",
    ),
    'metadata_dir = "/var/lib/garage/meta"',
    'data_dir = "/var/lib/garage/data"',
    'db_engine = "sqlite"',
    "replication_factor = 1",
    'rpc_bind_addr = "0.0.0.0:3901"',
    `rpc_public_addr = "${ctx.service.name}:3901"`,
    "",
    "[s3_api]",
    's3_region = "garage"',
    'api_bind_addr = "0.0.0.0:3900"',
    "",
  ].join("\n");
}

/** Garage's bucket for the app, when the plan keeps its files there. */
function garageBucket(ctx: ServiceContext): string | undefined {
  const storage = ctx.plan.storage?.objectStorage;
  return storage?.provider === "garage" ? storage.bucket : undefined;
}

/** The name Garage's start gives the key it makes from the env (`--default-access-key`). */
const GARAGE_KEY_NAME = "default access key";

/** The name a rotation gives the old key until it deletes it. */
const GARAGE_OLD_KEY_NAME = "opscrew-previous";

/**
 * Garage's key (research R3, R10). Its image has no shell, and `garage key import` takes the key
 * only as arguments, so no command gives it: `begin` renames the key in use, the service's start
 * (created again from the new env) makes the new key and allows it on the plan's bucket beside the
 * old one, and `finish` deletes the old key by its name. Where the plan keeps no bucket there, the
 * app makes its own buckets with its key, which a new key could not reach: refused. Every step is
 * guarded, so it works run again and wherever the rotation stopped: `begin` renames only while no
 * key has the old key's new name; `finish` deletes the old key only while a key has the name the
 * start gives the new one (a start from an env still naming the old key makes none); `undo` acts
 * only once the old key is renamed, deleting the new key if the start made it and giving the old
 * one its name back. None deletes the key in use.
 */
const GARAGE_KEY: SecretRotation = {
  secrets: ["key-id", "secret-key"],
  mode: "dual",
  seconds: 2,
  recreate: true,
  begin: (ctx) => {
    if (garageBucket(ctx) === undefined) {
      const file = planFilePath(ctx.plan);
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OpsCrew can't rotate the key of the Garage service ${ctx.service.name}: the app makes its own buckets with that key (${file} keeps no bucket there), and a new key could not reach them.`,
        {
          hint: `Keep the app's files in a Garage bucket of ${file} (storage.objectStorage with the provider garage), then run the command again.`,
        },
      );
    }
    return [
      {
        unless: [garageKeyExists(GARAGE_OLD_KEY_NAME)],
        run: ["/garage", "key", "rename", GARAGE_KEY_NAME, GARAGE_OLD_KEY_NAME],
      },
    ];
  },
  finish: () => [
    {
      when: [garageKeyExists(GARAGE_OLD_KEY_NAME), garageKeyExists(GARAGE_KEY_NAME)],
      run: ["/garage", "key", "delete", "--yes", GARAGE_OLD_KEY_NAME],
    },
  ],
  undo: () => [
    {
      when: [garageKeyExists(GARAGE_OLD_KEY_NAME), garageKeyExists(GARAGE_KEY_NAME)],
      run: ["/garage", "key", "delete", "--yes", GARAGE_KEY_NAME],
    },
    {
      when: [garageKeyExists(GARAGE_OLD_KEY_NAME)],
      run: ["/garage", "key", "rename", GARAGE_OLD_KEY_NAME, GARAGE_KEY_NAME],
    },
  ],
};

/** Passes when Garage holds a key named `name`. */
function garageKeyExists(name: string): RotationCommand {
  return ["/garage", "key", "info", name];
}

const GARAGE: ServiceSpec = {
  kind: "garage",
  title: "Garage",
  image: "garage",
  defaultVersion: "2.4",
  majorLocked: true,
  licence: {
    id: "AGPL-3.0",
    permissive: false,
    note: "Garage is under the AGPL 3.0: running it unchanged for your app's files puts no conditions on your app; only changes to Garage itself that others use over the network must be shared.",
  },
  // Idle 6–7 MiB.
  memory: { defaultMb: 64, minimumMb: 32, smallestServerMb: 512 },
  port: 3900,
  dataDir: "/var/lib/garage",
  configFiles: (ctx) => [
    { name: "garage.toml", target: "/etc/garage.toml", content: garageToml(ctx) },
  ],
  // One node that sets up its own layout (Garage 2.3 and later, research R3) and makes the app's
  // key (GARAGE_DEFAULT_ACCESS_KEY, GARAGE_DEFAULT_SECRET_KEY) itself, with a bucket in the plan
  // also the bucket (GARAGE_DEFAULT_BUCKET, every permission for the key): each only when missing,
  // so every start may repeat it.
  command: (ctx) => [
    "/garage",
    "server",
    "--single-node",
    garageBucket(ctx) === undefined ? "--default-access-key" : "--default-bucket",
  ],
  environment: (ctx) => {
    const bucket = garageBucket(ctx);
    return {
      GARAGE_RPC_SECRET: ctx.secretRef("rpc-secret"),
      GARAGE_DEFAULT_ACCESS_KEY: ctx.secretRef("key-id"),
      GARAGE_DEFAULT_SECRET_KEY: ctx.secretRef("secret-key"),
      ...(bucket === undefined ? {} : { GARAGE_DEFAULT_BUCKET: bucket }),
    };
  },
  healthcheck: () => ({ test: ["CMD", "/garage", "status"] }),
  secrets: [
    { name: "rpc-secret", format: "hex32" },
    { name: "key-id", format: "garage-key-id" },
    { name: "secret-key", format: "hex32" },
  ],
  address: (ctx) => `http://${serviceHost(ctx)}:3900`,
  conventionalVariables: (ctx, endpoint) => ({
    AWS_ACCESS_KEY_ID: ctx.secretRef("key-id"),
    AWS_SECRET_ACCESS_KEY: ctx.secretRef("secret-key"),
    AWS_REGION: "garage",
    AWS_ENDPOINT_URL_S3: endpoint,
  }),
  targets: BOTH_TARGETS,
  // The RPC secret is read at every start: only a restart changes it.
  rotation: { secrets: [GARAGE_KEY, restart("rpc-secret", 2)] },
};

// Part 2: the search and analytics engines (research.md R5). Each runs as one node, with its
// memory set from the plan's limit. Their smallest servers are judgement calls from R5: design
// warns below them.

/** OpenSearch and Elasticsearch map their indexes into memory; the host must allow that many maps. */
const MAX_MAP_COUNT = { sysctl: { "vm.max_map_count": "262144" } };

/** A JVM heap of half the limit: the rest is the engine's own off-heap memory and file cache. */
function halfHeap(ctx: ServiceContext): string {
  const heap = `${Math.floor(ctx.service.memoryMb / 2)}m`;
  return `-Xms${heap} -Xmx${heap}`;
}

/**
 * A health check for an image without curl or wget: bash sends `GET <path>` to its own port
 * through `/dev/tcp` and passes on a 2xx answer.
 */
function bashHttpCheck(port: number, path: string): string[] {
  return [
    "CMD",
    "bash",
    "-c",
    `exec 3<>/dev/tcp/127.0.0.1/${port} && printf 'GET ${path} HTTP/1.0\\r\\n\\r\\n' >&3 && read -r _ code _ <&3 && [ "\${code#2}" != "$code" ]`,
  ];
}

/** The cluster's health, yellow being the best one node gets for an index with replicas. */
const CLUSTER_HEALTH = "localhost:9200/_cluster/health?wait_for_status=yellow&timeout=5s";

/**
 * A password change through OpenSearch's or Elasticsearch's REST API (research R10): the JSON
 * `body` (a printf format filled with `values`) on stdin, sent with `method` to `path` as `user`,
 * logged in with the old password from a curl config on a pipe, unless the new one logs in
 * already; then the new one is the container's current one, which the health check reads
 * ({@link searchHealthcheck}). The env password seeds the first start only. curl waits out the
 * engine's passing 503 (Elasticsearch makes its security index at the first change), never a 401.
 */
function passwordApi(
  user: string,
  method: string,
  path: string,
  body: string,
  ...values: string[]
): RotationCommand {
  const as = (value: string) =>
    `curl -fsS --retry 5 --retry-delay 2 -o /dev/null --config <(printf 'user = "${user}:%s"\\n' ${value})`;
  const change = [
    `printf '${body}'`,
    ...values,
    `| ${as(OLD)} -X ${method} -H 'Content-Type: application/json' --data-binary @- http://localhost:9200${path}`,
  ].join(" ");
  return bash(`${unlessDone(`${as(NEW)} http://localhost:9200/`, change)} && ${newFile()}`);
}

/**
 * The cluster's health as `user`, with the container's current password in a curl config on
 * stdin (not on curl's command line).
 */
function searchHealthcheck(user: string): ServiceHealthcheck {
  return {
    test: [
      "CMD-SHELL",
      `printf 'user = "${user}:%s"\\n' ${current()} | curl -fsS -K - '${CLUSTER_HEALTH}' > /dev/null`,
    ],
    startSeconds: 90,
  };
}

/** OpenSearch's transport keystore in its config folder, with the JDK's default password. */
const OPENSEARCH_KEYSTORE = "node.p12";

/**
 * OpenSearch's security plugin as research R8 ran it, from the image's folder:
 * - the transport layer needs TLS even on one node. When the container has none yet, the JDK's
 *   keytool makes one self-signed key that trusts itself; it never leaves the container;
 * - the password from the env into {@link PASSWORD_FILE} at the container's first start only;
 * - `internal_users.yml` then holds only `admin`, with the bcrypt hash of that password and
 *   `reserved: false`. The image's own lets in `admin:admin`. It is read only when the security
 *   index is first made, so writing it at every start changes nothing after that;
 * - then the image's own start.
 */
function opensearchCommand(): string[] {
  const keystore = `config/${OPENSEARCH_KEYSTORE}`;
  const users = [
    "_meta:",
    '  type: "internalusers"',
    "  config_version: 2",
    "admin:",
    '  hash: "%s"',
    "  reserved: false",
    "  backend_roles:",
    '  - "admin"',
    "",
  ].join("\\n");
  const script = [
    "set -e",
    `[ -f ${keystore} ] || { k="keytool -keystore ${keystore} -storepass changeit"; $k -genkeypair -alias node -keyalg RSA -keysize 2048 -dname CN=opensearch -validity 36500; $k -exportcert -alias node -rfc | $k -importcert -noprompt -alias trusted; }`,
    keepFile("OPENSEARCH_PASSWORD"),
    `h=$(OPENSEARCH_PASSWORD=${current()} plugins/opensearch-security/tools/hash.sh -env OPENSEARCH_PASSWORD)`,
    `printf '${users}' "$h" > config/opensearch-security/internal_users.yml`,
    "exec ./opensearch-docker-entrypoint.sh opensearch",
  ];
  return ["bash", "-c", script.join("; ")];
}

const OPENSEARCH: ServiceSpec = {
  kind: "opensearch",
  title: "OpenSearch",
  image: "opensearch",
  defaultVersion: "3.9",
  majorLocked: true,
  licence: { id: "Apache-2.0", permissive: true },
  // A heap of 512 MB in a 1 GB limit; 4 GB servers, 2 GB being tight (R5).
  memory: { defaultMb: 1024, minimumMb: 768, smallestServerMb: 4096 },
  port: 9200,
  dataDir: "/usr/share/opensearch/data",
  // It runs as uid 1000.
  namedVolume: true,
  command: opensearchCommand,
  // The security plugin over plain HTTP on the app's internal network, as Elasticsearch: no demo
  // setup (public certificates and default users), and the security index made from OpsCrew's
  // users on the first start.
  environment: (ctx) => ({
    "discovery.type": "single-node",
    DISABLE_INSTALL_DEMO_CONFIG: "true",
    "plugins.security.allow_default_init_securityindex": "true",
    "plugins.security.ssl.transport.keystore_filepath": OPENSEARCH_KEYSTORE,
    "plugins.security.ssl.transport.truststore_filepath": OPENSEARCH_KEYSTORE,
    OPENSEARCH_JAVA_OPTS: halfHeap(ctx),
    OPENSEARCH_PASSWORD: ctx.secretRef(PASSWORD.name),
  }),
  healthcheck: () => searchHealthcheck("admin"),
  secrets: [PASSWORD],
  // opensearch-js and opensearch-py take the login in the URL.
  address: (ctx) => `http://admin:${ctx.secretRef(PASSWORD.name)}@${serviceHost(ctx)}:9200`,
  conventionalVariables: (_ctx, url) => ({ OPENSEARCH_URL: url }),
  ulimits: { nofile: 65536 },
  hostSettings: MAX_MAP_COUNT,
  targets: ["server"],
  // The account API: the internal users API is forbidden to `admin` (R10).
  rotation: {
    secrets: [
      swap(PASSWORD.name, 1, () => [
        passwordApi(
          "admin",
          "PUT",
          "/_plugins/_security/api/account",
          '{"current_password":"%s","password":"%s"}',
          OLD,
          NEW,
        ),
      ]),
    ],
  },
};

/**
 * Elasticsearch, for Elasticsearch clients only (from 7.14 they refuse OpenSearch): security on,
 * the `elastic` user's password from `ELASTIC_PASSWORD`, over plain HTTP on the app's internal
 * network (no certificates for the app to trust), and no machine learning (it needs 6 GB).
 */
const ELASTICSEARCH: ServiceSpec = {
  kind: "elasticsearch",
  title: "Elasticsearch",
  image: "elasticsearch",
  defaultVersion: "9.5",
  majorLocked: true,
  licence: {
    id: "Elastic-2.0",
    permissive: false,
    note: "Elasticsearch's official image is under the Elastic License 2.0 (its source is also under the AGPL 3.0 and the SSPL): running it for your own app is allowed, while offering Elasticsearch itself to others as a managed service is not.",
  },
  memory: { defaultMb: 1024, minimumMb: 768, smallestServerMb: 4096 },
  port: 9200,
  dataDir: "/usr/share/elasticsearch/data",
  // It runs as uid 1000.
  namedVolume: true,
  // The password from the env into PASSWORD_FILE at the container's first start only (its health
  // check reads it there, and a rotation rewrites it), then the image's own start.
  command: () => [
    "sh",
    "-c",
    `${keepFile("ELASTIC_PASSWORD")} && exec /usr/local/bin/docker-entrypoint.sh eswrapper`,
  ],
  environment: (ctx) => ({
    "discovery.type": "single-node",
    "xpack.security.enabled": "true",
    "xpack.security.http.ssl.enabled": "false",
    "xpack.security.transport.ssl.enabled": "false",
    "xpack.ml.enabled": "false",
    ELASTIC_PASSWORD: ctx.secretRef(PASSWORD.name),
    ES_JAVA_OPTS: halfHeap(ctx),
  }),
  healthcheck: () => searchHealthcheck("elastic"),
  secrets: [PASSWORD],
  address: (ctx) => `http://elastic:${ctx.secretRef(PASSWORD.name)}@${serviceHost(ctx)}:9200`,
  conventionalVariables: (_ctx, url) => ({ ELASTICSEARCH_URL: url }),
  ulimits: { nofile: 65536 },
  hostSettings: MAX_MAP_COUNT,
  targets: ["server"],
  rotation: {
    secrets: [
      swap(PASSWORD.name, 1, () => [
        passwordApi(
          "elastic",
          "POST",
          "/_security/user/elastic/_password",
          '{"password":"%s"}',
          NEW,
        ),
      ]),
    ],
  },
};

/**
 * Meilisearch in production mode, which needs the master key; indexing uses at most half the
 * limit (its default is two thirds of the server's memory), and it sends no analytics.
 */
const MEILISEARCH: ServiceSpec = {
  kind: "meilisearch",
  title: "Meilisearch",
  image: "meilisearch",
  defaultVersion: "1.55",
  majorLocked: true,
  licence: { id: "MIT", permissive: true },
  memory: { defaultMb: 512, minimumMb: 256, smallestServerMb: 2048 },
  port: 7700,
  dataDir: "/meili_data",
  environment: (ctx) => ({
    MEILI_ENV: "production",
    MEILI_MASTER_KEY: ctx.secretRef("master-key"),
    MEILI_HTTP_ADDR: "0.0.0.0:7700",
    MEILI_MAX_INDEXING_MEMORY: `${Math.floor(ctx.service.memoryMb / 2)} MiB`,
    MEILI_NO_ANALYTICS: "true",
  }),
  // Alpine's busybox wget.
  healthcheck: () => ({ test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:7700/health"] }),
  secrets: [{ name: "master-key", format: "hex32" }],
  // Laravel Scout's names, which the other clients' examples use too.
  address: (ctx) => `http://${serviceHost(ctx)}:7700`,
  conventionalVariables: (ctx, url) => ({
    MEILISEARCH_HOST: url,
    MEILISEARCH_KEY: ctx.secretRef("master-key"),
  }),
  targets: BOTH_TARGETS,
  // The master key is read at every start, and every API key made from it changes with it (R4).
  rotation: { secrets: [restart("master-key", 5)] },
};

/** Typesense, with its API key; it keeps its index in memory (1M short documents: about 165 MB). */
const TYPESENSE: ServiceSpec = {
  kind: "typesense",
  title: "Typesense",
  image: "typesense",
  defaultVersion: "30.2",
  majorLocked: true,
  licence: {
    id: "GPL-3.0",
    permissive: false,
    note: "Typesense is under the GPL 3.0 (its clients under Apache 2.0): running it as your app's search puts no conditions on your app's code; they apply only when you share Typesense itself.",
  },
  memory: { defaultMb: 512, minimumMb: 256, smallestServerMb: 2048 },
  port: 8108,
  dataDir: "/data",
  environment: (ctx) => ({
    TYPESENSE_DATA_DIR: "/data",
    TYPESENSE_API_KEY: ctx.secretRef("api-key"),
  }),
  healthcheck: () => ({ test: bashHttpCheck(8108, "/health") }),
  secrets: [{ name: "api-key", format: "hex32" }],
  // Its clients take the address in parts (Laravel Scout's names).
  address: (ctx) => `http://${serviceHost(ctx)}:8108`,
  conventionalVariables: (ctx) => ({
    TYPESENSE_HOST: serviceHost(ctx),
    TYPESENSE_PORT: "8108",
    TYPESENSE_PROTOCOL: "http",
    TYPESENSE_API_KEY: ctx.secretRef("api-key"),
  }),
  targets: BOTH_TARGETS,
  // The app reaches it with the start key, which changes only with a restart (R4, R10); the start
  // loads the index into memory, so a large one takes longer.
  rotation: { secrets: [restart("api-key", 10)] },
};

/**
 * ClickHouse's low-memory profile (research R5, https://clickhouse.com/docs/operations/tips): the
 * server stops queries at three quarters of the limit, its caches are small, and the system log
 * tables, which grow on their own, are off.
 */
function clickhouseServerXml(plan: DeployPlan, memoryMb: number): string {
  const mb = 1024 * 1024;
  return [
    ...xmlHeader(plan, `ClickHouse settings for its ${memoryMb} MB memory limit.`),
    "<clickhouse>",
    `    <max_server_memory_usage>${Math.floor(memoryMb * 0.75) * mb}</max_server_memory_usage>`,
    `    <mark_cache_size>${Math.floor(memoryMb / 8) * mb}</mark_cache_size>`,
    `    <index_mark_cache_size>${Math.floor(memoryMb / 16) * mb}</index_mark_cache_size>`,
    `    <uncompressed_cache_size>${16 * mb}</uncompressed_cache_size>`,
    "    <max_concurrent_queries>20</max_concurrent_queries>",
    ...[
      "asynchronous_metric_log",
      "metric_log",
      "part_log",
      "processors_profile_log",
      "query_thread_log",
      "query_views_log",
      "session_log",
      "text_log",
      "trace_log",
    ].map((table) => `    <${table} remove="1" />`),
    "</clickhouse>",
    "",
  ].join("\n");
}

/** Each query's share of a small server: two threads, small blocks, no parallel parsing. */
function clickhouseUsersXml(plan: DeployPlan): string {
  return [
    ...xmlHeader(plan, "The low-memory query settings of every ClickHouse user."),
    "<clickhouse>",
    "    <profiles>",
    "        <default>",
    "            <max_threads>2</max_threads>",
    "            <max_block_size>8192</max_block_size>",
    "            <max_download_threads>1</max_download_threads>",
    "            <input_format_parallel_parsing>0</input_format_parallel_parsing>",
    "            <output_format_parallel_formatting>0</output_format_parallel_formatting>",
    "        </default>",
    "    </profiles>",
    "</clickhouse>",
    "",
  ].join("\n");
}

/**
 * The app's ClickHouse user, in a `users.d` file of the container's own beside OpsCrew's mounted
 * one (whose content holds no value). The image's entrypoint would write the user from the env at
 * every start, and a user from its file can't be changed by SQL (research R2, R10); a file edited
 * in place applies in about 2 seconds.
 */
const CLICKHOUSE_APP_USER = "/etc/clickhouse-server/users.d/opscrew-app.xml";

/**
 * A subshell that writes the app's user `app` to `file`, readable by the server's user only, with
 * the SHA-256 of the password in the variable `variable` (never the password itself), as the
 * image's own file has it: every network, the default profile and quota, no user management, and
 * no `default` user.
 */
function clickhouseUserFile(variable: string, file: string): string {
  const xml = [
    "<clickhouse><users>",
    '<default remove="remove"></default>',
    "<app><profile>default</profile><networks><ip>::/0</ip></networks>",
    "<password_sha256_hex>%s</password_sha256_hex>",
    "<quota>default</quota><access_management>0</access_management></app>",
    "</users></clickhouse>",
  ].join("");
  return `(umask 077 && h=$(printf %s "$${variable}" | sha256sum | cut -d " " -f 1) && printf '${xml}\\n' "$h" > ${file} && chown clickhouse:clickhouse ${file})`;
}

const CLICKHOUSE: ServiceSpec = {
  kind: "clickhouse",
  title: "ClickHouse",
  image: "clickhouse",
  defaultVersion: "26.3",
  majorLocked: true,
  licence: { id: "Apache-2.0", permissive: true },
  // Its docs advise 32 GB; with the low-memory profile 2 GB servers work (R5).
  memory: { defaultMb: 1024, minimumMb: 768, smallestServerMb: 2048 },
  port: 8123,
  dataDir: "/var/lib/clickhouse",
  configFiles: (ctx) => [
    {
      name: "server.xml",
      target: "/etc/clickhouse-server/config.d/opscrew.xml",
      content: clickhouseServerXml(ctx.plan, ctx.service.memoryMb),
    },
    {
      name: "users.xml",
      target: "/etc/clickhouse-server/users.d/opscrew.xml",
      content: clickhouseUsersXml(ctx.plan),
    },
  ],
  // The app's user from the env at the container's first start only, then the image's own start
  // (which makes the database `app` on a new volume, logged in as that user) without its user
  // setup: a restart keeps a rotated password.
  command: () => [
    "bash",
    "-c",
    `[ -f ${CLICKHOUSE_APP_USER} ] || ${clickhouseUserFile("CLICKHOUSE_PASSWORD", CLICKHOUSE_APP_USER)} && CLICKHOUSE_SKIP_USER_SETUP=1 exec /entrypoint.sh`,
  ],
  environment: (ctx) => ({
    CLICKHOUSE_DB: "app",
    CLICKHOUSE_USER: "app",
    CLICKHOUSE_PASSWORD: ctx.secretRef(PASSWORD.name),
  }),
  healthcheck: () => ({ test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8123/ping"] }),
  secrets: [PASSWORD],
  address: (ctx) => loginUrl(ctx, "http", 8123, "/app"),
  conventionalVariables: (ctx, url) => ({
    CLICKHOUSE_URL: url,
    CLICKHOUSE_USER: "app",
    CLICKHOUSE_PASSWORD: ctx.secretRef(PASSWORD.name),
  }),
  targets: BOTH_TARGETS,
  // The user's file rewritten in place (a name ClickHouse doesn't read first, then moved), then
  // waited for until the new password logs in: clickhouse-client reads it from its env.
  rotation: {
    secrets: [
      swap(PASSWORD.name, 2, () => [
        bash(
          `${newFile(CLICKHOUSE_APP_USER, "OPSCREW_NEW", clickhouseUserFile, ".tmp")} && for i in $(seq 40); do CLICKHOUSE_PASSWORD=${NEW} clickhouse-client -u app -q 'SELECT 1' > /dev/null 2>&1 && exit 0; sleep 0.25; done; exit 1`,
        ),
      ]),
    ],
  },
};

/**
 * Neo4j Community: one database, the `neo4j` user's password from `NEO4J_AUTH`, and a heap and
 * page cache of a third of the limit each. Bolt and HTTP stay on the app's network.
 */
const NEO4J: ServiceSpec = {
  kind: "neo4j",
  title: "Neo4j Community",
  image: "neo4j",
  defaultVersion: "2026.09",
  // Calendar versions: the "major" is the year, so a lock would stop updates every January.
  majorLocked: false,
  licence: {
    id: "GPL-3.0",
    permissive: false,
    note: "Neo4j Community is under the GPL 3.0: running it as your app's database puts no conditions on your app's code; they apply only when you share Neo4j itself.",
  },
  memory: { defaultMb: 1536, minimumMb: 1024, smallestServerMb: 4096 },
  port: 7687,
  // The image declares both as volumes.
  dataDir: { data: "/data", logs: "/logs" },
  // Its clean stop took 10.5 seconds on an empty database (T2306, local Docker), so Compose's 10
  // killed it; the checkpoint grows with the data.
  stopGraceSeconds: 60,
  environment: (ctx) => {
    const third = `${Math.floor(ctx.service.memoryMb / 3)}m`;
    return {
      NEO4J_AUTH: `neo4j/${ctx.secretRef(PASSWORD.name)}`,
      NEO4J_server_memory_heap_initial__size: third,
      NEO4J_server_memory_heap_max__size: third,
      NEO4J_server_memory_pagecache_size: third,
    };
  },
  healthcheck: () => ({ test: bashHttpCheck(7474, "/"), startSeconds: 60 }),
  secrets: [PASSWORD],
  address: (ctx) => `bolt://${serviceHost(ctx)}:7687`,
  conventionalVariables: (ctx, url) => ({
    NEO4J_URI: url,
    NEO4J_USERNAME: "neo4j",
    NEO4J_PASSWORD: ctx.secretRef(PASSWORD.name),
  }),
  targets: BOTH_TARGETS,
  // NEO4J_AUTH is ignored once users exist; cypher-shell takes the login only as an argument (R10).
  rotation: {
    secrets: [
      swap(PASSWORD.name, 3, () => {
        const shell = (value: string) =>
          `cypher-shell -u neo4j -p ${value} -d system --format plain`;
        return [
          bash(
            unlessDone(
              `printf 'RETURN 1;\\n' | ${shell(NEW)}`,
              `printf "ALTER USER neo4j SET PASSWORD '%s' CHANGE NOT REQUIRED;\\n" ${NEW} | ${shell(OLD)}`,
            ),
          ),
        ];
      }),
    ],
  },
};

/** The service catalog's entries: one per kind OpsCrew runs. */
export const SERVICE_SPECS: readonly ServiceSpec[] = [
  POSTGRES,
  VALKEY,
  REDIS,
  DRAGONFLY,
  MYSQL,
  MARIADB,
  MONGODB,
  RABBITMQ,
  NATS,
  KAFKA,
  REDPANDA,
  GARAGE,
  OPENSEARCH,
  ELASTICSEARCH,
  MEILISEARCH,
  TYPESENSE,
  CLICKHOUSE,
  NEO4J,
];
