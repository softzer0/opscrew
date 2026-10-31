import type { CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";
import { durationText, errorMessage, OpsCrewError, type Redactor } from "@opscrew/core";
import {
  appDir,
  EDGE_DIR,
  EDGE_PROXIES,
  type EdgeProxy,
  processServices,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { pollUntil, sshArgs } from "../shared";

/**
 * Typed server operations for moving a deployment between servers (feature 005), and a service
 * between the app's servers (feature 018, `move/`). Every command is
 * fixed here; callers choose an operation and pass validated values, never shell text. Commands
 * run as the `deploy` user in the app's folder (`/srv/apps/<app>`), where the deploy workflow keeps
 * `compose.yaml` and the `.env` file that names `APP_IMAGE`; the proxy (Caddy or nginx) is the shared
 * edge's, in `/srv/edge`. A server OpsCrew creates runs one app.
 */

/** Where the database dump lives on both servers while it is moved (mode 0600, owned by deploy). */
export function dumpPath(folder: string): string {
  return `${folder}/opscrew-move.dump`;
}

/**
 * Compose services OpsCrew stops and starts during a move: the app's, and the edge's proxy (its
 * service is named after it: `caddy` or `nginx`).
 */
export type MoveService = "app" | EdgeProxy;

/** Passes user-visible text through the redactor (`deps.redactor.redact`). */
export type RedactText = (text: string) => string;

export interface ServerOpOptions {
  redact: RedactText;
  /** The app's folder on both servers (`appDir(plan)`, `/srv/apps/<app>`). */
  folder: string;
  /**
   * The app's processes besides the web one, which use its database too: the enabled workers and,
   * with cron jobs, `cron`. They stop and start with `app`.
   */
  processes?: readonly string[];
  /** The Postgres service's Compose name (default `db`), such as a moving service's own. */
  database?: string;
  /** The command the hints say to run again after a fix (default `opscrew retarget`). */
  command?: string;
}

/** {@link ServerOpOptions.database} with its default. */
function databaseOf(options: Pick<ServerOpOptions, "database">): string {
  return options.database ?? "db";
}

/** {@link ServerOpOptions.command} with its default. */
function commandOf(options: Pick<ServerOpOptions, "command">): string {
  return options.command ?? "opscrew retarget";
}

/** {@link ServerOpOptions} for `plan`'s app, its text redacted by `redactor`. */
export function serverOps(plan: DeployPlan, redactor: Pick<Redactor, "redact">): ServerOpOptions {
  return { redact: redactor.redact, folder: appDir(plan), processes: processServices(plan) };
}

/** Where a service's Compose project is: the app's folder, or the edge's for its proxy. */
function projectFolder(service: MoveService, options: Pick<ServerOpOptions, "folder">): string {
  return service === "app" ? options.folder : EDGE_DIR;
}

/** The service in words: the app, or the edge's proxy by its name. */
function serviceLabel(service: MoveService): string {
  return service === "app" ? "the app" : EDGE_PROXIES[service].label;
}

const MINUTE = 60_000;
/** 100 MB (binary, as database sizes are shown): the unit the move's time estimates count in. */
export const HUNDRED_MB = 100 * 1024 * 1024;
const STDERR_LIMIT = 500;

/**
 * Timeout for a database dump, copy or restore: 5 minutes plus 1 minute per started 100 MB of
 * database size, at most 6 hours. Unknown (non-finite) sizes get the ceiling.
 */
export function moveTimeoutMs(sizeBytes: number): number {
  const floor = 5 * MINUTE;
  const ceiling = 6 * 60 * MINUTE;
  if (!Number.isFinite(sizeBytes)) return ceiling;
  const extra = Math.ceil(Math.max(0, sizeBytes) / HUNDRED_MB) * MINUTE;
  return Math.min(ceiling, floor + extra);
}

/** Redacts first (so a secret is never cut in half), then truncates. */
function excerpt(text: string, redact: RedactText): string {
  const clean = redact(text.trim());
  return clean.length > STDERR_LIMIT ? `${clean.slice(0, STDERR_LIMIT)}…` : clean;
}

/**
 * Keeps only Postgres tool and shell messages from dump/restore stderr. Lines that can quote row
 * data or SQL (`DETAIL:`, `CONTEXT:`, `Command was:`, indented continuations, ...) are dropped.
 */
function withoutData(stderr: string): string {
  const dataLine = /^(DETAIL|CONTEXT|HINT|QUERY|STATEMENT|LINE \d+|Command was):/;
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !/^\s/.test(line) && !dataLine.test(line))
    .join("\n");
}

interface Step {
  /** "start the app", used as "Could not <what> <where>". */
  what: string;
  /** "on 203.0.113.10" or "from A to B". */
  where: string;
  hint: string;
  /** Filters stderr before redaction (dump/restore output may quote data). */
  filter?: (stderr: string) => string;
}

function failure(step: Step, detail: string, redact: RedactText): OpsCrewError {
  const text = excerpt(step.filter ? step.filter(detail) : detail, redact);
  return new OpsCrewError(
    "COMMAND_FAILED",
    `Could not ${step.what} ${step.where}${text ? `: ${text}` : "."}`,
    { hint: step.hint },
  );
}

/** Checks a result; stdout is never included in errors. */
function check(
  result: CommandResult,
  step: Step,
  timeoutMs: number,
  redact: RedactText,
): CommandResult {
  if (result.timedOut) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Could not ${step.what} ${step.where}: it did not finish within ${durationText(timeoutMs)}.`,
      { hint: step.hint },
    );
  }
  if (result.exitCode !== 0) {
    throw failure(step, result.stderr || `exit code ${result.exitCode}`, redact);
  }
  return result;
}

async function runStep(
  remote: RemoteExec,
  command: string,
  timeoutMs: number,
  step: Omit<Step, "where">,
  redact: RedactText,
): Promise<CommandResult> {
  const full: Step = { ...step, where: `on ${remote.host}` };
  let result: CommandResult;
  try {
    result = await remote.run(command, { timeoutMs });
  } catch (error) {
    throw failure(full, errorMessage(error), redact);
  }
  return check(result, full, timeoutMs, redact);
}

const composePsHint = (host: string, options: Pick<ServerOpOptions, "folder" | "command">) =>
  `Connect to the server (\`ssh deploy@${host}\`), run \`docker compose ps\` in ${options.folder} to see what is running, then run \`${commandOf(options)}\` again.`;

/** The workers and cron that stop and start with `app` ({@link ServerOpOptions.processes}). */
function processesOf(service: MoveService, options: ServerOpOptions): readonly string[] {
  return service === "app" ? (options.processes ?? []) : [];
}

/**
 * Stops a Compose service: `app` in the app's folder, then its workers and cron (so nothing of
 * the app writes to its database any more), or the edge's proxy in `/srv/edge`.
 */
export async function stopService(
  remote: RemoteExec,
  service: MoveService,
  options: ServerOpOptions,
): Promise<void> {
  const folder = projectFolder(service, options);
  const hint = composePsHint(remote.host, { ...options, folder });
  await runStep(
    remote,
    `cd ${folder} && docker compose stop ${service}`,
    2 * MINUTE,
    { what: `stop ${serviceLabel(service)}`, hint },
    options.redact,
  );
  const processes = processesOf(service, options);
  if (processes.length === 0) return;
  await runStep(
    remote,
    `cd ${folder} && docker compose stop ${processes.join(" ")}`,
    2 * MINUTE,
    { what: "stop the app's workers and cron", hint },
    options.redact,
  );
}

/** Starts a Compose service (as {@link stopService} finds it) with `docker compose up -d`. */
export async function startService(
  remote: RemoteExec,
  service: MoveService,
  options: ServerOpOptions,
): Promise<void> {
  const folder = projectFolder(service, options);
  const hint = composePsHint(remote.host, { ...options, folder });
  await runStep(
    remote,
    `cd ${folder} && docker compose up -d ${service}`,
    5 * MINUTE,
    { what: `start ${serviceLabel(service)}`, hint },
    options.redact,
  );
  const processes = processesOf(service, options);
  if (processes.length === 0) return;
  await runStep(
    remote,
    `cd ${folder} && docker compose up -d ${processes.join(" ")}`,
    5 * MINUTE,
    { what: "start the app's workers and cron", hint },
    options.redact,
  );
}

/**
 * The health check; `port` is the plan's (`app.port`, a validated TCP port), `edge` the server's
 * proxy, whose image (Caddy's, or nginx's on Alpine) has busybox `wget`.
 */
function healthCommand(port: number, healthPath: string, edge: EdgeProxy): string {
  // Single-quoted in the remote shell; quotes, whitespace, `$`, backticks and backslashes refused.
  if (!/^\/[^\s'"`$\\]*$/.test(healthPath)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The health check path ${JSON.stringify(healthPath)} cannot be used.`,
      {
        hint: "Set `app.healthPath` in opscrew/plan.yaml to a path that starts with `/` and has no spaces or quotes.",
      },
    );
  }
  // A one-off container of the edge's proxy (busybox wget) on the edge's network, which the app's
  // web service joins as `app` (a server OpsCrew creates runs one app): works whether or not the
  // proxy is running (it is stopped on the new server until DNS points at it).
  return `cd ${EDGE_DIR} && docker compose run --rm --no-deps -T --entrypoint wget ${edge} -q -O /dev/null -T 5 'http://app:${port}${healthPath}'`;
}

async function probe(
  remote: RemoteExec,
  command: string,
): Promise<{ healthy: boolean; detail: string }> {
  try {
    const result = await remote.run(command, { timeoutMs: MINUTE });
    if (result.timedOut) return { healthy: false, detail: "the check timed out" };
    return { healthy: result.exitCode === 0, detail: result.stderr };
  } catch (error) {
    return { healthy: false, detail: errorMessage(error) };
  }
}

/**
 * True when the app answers `http://app:<port><healthPath>` inside the server's Compose network.
 * Failures (including SSH errors) are false; invalid port or path throws `INVALID_INPUT`.
 */
export async function isAppHealthy(
  remote: RemoteExec,
  port: number,
  healthPath: string,
  edge: EdgeProxy,
): Promise<boolean> {
  return (await probe(remote, healthCommand(port, healthPath, edge))).healthy;
}

export interface WaitAppHealthyOptions extends ServerOpOptions {
  /** The server's proxy, whose image runs the check. */
  edge: EdgeProxy;
  /** Default 5 minutes. */
  timeoutMs?: number;
  /** Pause between checks; default 5 seconds. */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. */
  now?: () => number;
}

/** Polls {@link isAppHealthy} until it succeeds; throws `COMMAND_FAILED` after `timeoutMs`. */
export async function waitAppHealthy(
  remote: RemoteExec,
  port: number,
  healthPath: string,
  options: WaitAppHealthyOptions,
): Promise<void> {
  const command = healthCommand(port, healthPath, options.edge);
  const timeoutMs = options.timeoutMs ?? 5 * MINUTE;
  let detail = "";
  const healthy = await pollUntil(
    async () => {
      const probed = await probe(remote, command);
      detail = probed.detail;
      return probed.healthy ? true : undefined;
    },
    {
      timeoutMs,
      intervalMs: options.intervalMs ?? 5000,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
  );
  if (healthy) return;
  const last = excerpt(detail, options.redact);
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `The app on ${remote.host} did not answer on http://app:${port}${healthPath} within ${durationText(timeoutMs)}${last ? ` (last check: ${last})` : ""}.`,
    {
      hint: `See why on the server: \`ssh deploy@${remote.host}\`, then \`cd ${options.folder} && docker compose logs --tail 200 app\`.`,
    },
  );
}

const dbHint = (host: string, options: Pick<ServerOpOptions, "folder" | "database">) => {
  const db = databaseOf(options);
  return `Connect to the server (\`ssh deploy@${host}\`) and check the database with \`cd ${options.folder} && docker compose ps ${db}\` and \`docker compose logs --tail 100 ${db}\`.`;
};

/** Size of the `app` Postgres database in bytes, in the service {@link ServerOpOptions.database}. */
export async function databaseSize(remote: RemoteExec, options: ServerOpOptions): Promise<number> {
  const step = { what: "read the database size", hint: dbHint(remote.host, options) };
  const result = await runStep(
    remote,
    `cd ${options.folder} && docker compose exec -T ${databaseOf(options)} psql -U app -d app -tAc "select pg_database_size('app')"`,
    MINUTE,
    step,
    options.redact,
  );
  const text = result.stdout.trim();
  if (!/^\d+$/.test(text)) {
    throw failure(
      { ...step, where: `on ${remote.host}` },
      "Postgres did not report a size in bytes",
      options.redact,
    );
  }
  return Number(text);
}

/**
 * Writes a custom-format `pg_dump` of the `app` database to {@link dumpPath} (created with
 * `umask 077`). Timeout scaled by {@link moveTimeoutMs}.
 */
export async function dumpDatabase(
  remote: RemoteExec,
  sizeBytes: number,
  options: ServerOpOptions,
): Promise<void> {
  const { folder } = options;
  const dump = dumpPath(folder);
  await runStep(
    remote,
    `cd ${folder} && umask 077 && rm -f ${dump} && docker compose exec -T ${databaseOf(options)} pg_dump -U app -Fc app > ${dump}`,
    moveTimeoutMs(sizeBytes),
    { what: "dump the database", hint: dbHint(remote.host, options), filter: withoutData },
    options.redact,
  );
}

/**
 * Drops the `app` database and creates it again empty (owner `app`, as the Postgres image's
 * first start did), from the `postgres` maintenance database. `WITH (FORCE)` ends any session
 * still connected. Everything goes: every schema, extension and migration table, so a restore
 * afterwards holds exactly the dump.
 */
export async function recreateDatabase(
  remote: RemoteExec,
  options: ServerOpOptions,
): Promise<void> {
  await runStep(
    remote,
    `cd ${options.folder} && docker compose exec -T ${databaseOf(options)} psql -U app -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS app WITH (FORCE)' -c 'CREATE DATABASE app OWNER app'`,
    2 * MINUTE,
    { what: "empty the database", hint: dbHint(remote.host, options), filter: withoutData },
    options.redact,
  );
}

/**
 * Restores {@link dumpPath} into the `app` database in one transaction. The database must be
 * empty ({@link recreateDatabase}); nothing is dropped first. Timeout scaled by
 * {@link moveTimeoutMs}.
 */
export async function restoreDatabase(
  remote: RemoteExec,
  sizeBytes: number,
  options: ServerOpOptions,
): Promise<void> {
  const { folder } = options;
  const dump = dumpPath(folder);
  await runStep(
    remote,
    `cd ${folder} && chmod 600 ${dump} && docker compose exec -T ${databaseOf(options)} pg_restore -U app -d app --no-owner --single-transaction < ${dump}`,
    moveTimeoutMs(sizeBytes),
    { what: "restore the database", hint: dbHint(remote.host, options), filter: withoutData },
    options.redact,
  );
}

/** The Compose service that runs `app.releaseCommand` (only `docker compose run` starts it). */
const RELEASE_SERVICE = "release";
const RELEASE_COMMAND = `docker compose run --rm --no-deps -T ${RELEASE_SERVICE}`;

/**
 * True when the app's `compose.yaml` on the server defines the `release` service: the deployed
 * version has a release command, and its deploy workflow runs it before each new version starts.
 */
export async function hasReleaseService(
  remote: RemoteExec,
  options: ServerOpOptions,
): Promise<boolean> {
  const result = await runStep(
    remote,
    `cd ${options.folder} && docker compose --profile ${RELEASE_SERVICE} config --services`,
    MINUTE,
    { what: "read the Compose services", hint: composePsHint(remote.host, options) },
    options.redact,
  );
  return result.stdout.split(/\r?\n/).some((line) => line.trim() === RELEASE_SERVICE);
}

/**
 * Runs the `release` service (`app.releaseCommand`, usually the database migrations) once in a
 * one-off container of the deployed image, without starting other services. Timeout scaled by
 * {@link moveTimeoutMs}: migrations of the copied data take longer on a larger database.
 *
 * A failure names only the exit code: migration output quotes rows and SQL parameters (Prisma
 * `DbError { detail: … }`, SQLAlchemy `[parameters: …]`), so none of it reaches errors, logs or
 * the audit log. The hint says how to see it on the server.
 */
export async function runRelease(
  remote: RemoteExec,
  sizeBytes: number,
  options: Pick<ServerOpOptions, "folder">,
): Promise<void> {
  const timeoutMs = moveTimeoutMs(sizeBytes);
  const failed = (why: string) =>
    new OpsCrewError(
      "COMMAND_FAILED",
      `Could not run the release command (app.releaseCommand in opscrew/plan.yaml) on ${remote.host}: ${why} (it ran only on the copy of the database on the new server; your users' data on the old server is untouched).`,
      {
        hint: `The old server keeps serving your users. See the release command's full output on the new server: \`ssh deploy@${remote.host}\`, then \`cd ${options.folder} && ${RELEASE_COMMAND}\` (it runs on the copy only). Fix the release command (app.releaseCommand in opscrew/plan.yaml) or the app's migrations so they run on the old server's data, and push the fix (the deploy workflow now deploys to the new server).`,
      },
    );
  let result: CommandResult;
  try {
    result = await remote.run(`cd ${options.folder} && ${RELEASE_COMMAND}`, { timeoutMs });
  } catch {
    throw failed("the SSH connection failed");
  }
  if (result.timedOut) throw failed(`it did not finish within ${durationText(timeoutMs)}`);
  if (result.exitCode !== 0) throw failed(`it exited with code ${result.exitCode}`);
}

/**
 * Checks the dump at {@link dumpPath}: Postgres can read its table of contents
 * (`pg_restore --list`), and returns its SHA-256, so the copy on the new server can be compared
 * with the dump on the old one before anything is dropped. Timeout scaled by {@link moveTimeoutMs}.
 */
export async function verifyDump(
  remote: RemoteExec,
  sizeBytes: number,
  options: ServerOpOptions,
): Promise<string> {
  const { folder } = options;
  const dump = dumpPath(folder);
  const step = {
    what: "read the database dump",
    hint: `The dump is incomplete or damaged; OpsCrew makes a new one when you run \`${commandOf(options)}\` again. If it fails again, check the free disk space on both servers (\`ssh deploy@${remote.host} df -h ${folder}\`).`,
    filter: withoutData,
  };
  const result = await runStep(
    remote,
    `cd ${folder} && docker compose exec -T ${databaseOf(options)} pg_restore --list < ${dump} > /dev/null && sha256sum ${dump}`,
    moveTimeoutMs(sizeBytes),
    step,
    options.redact,
  );
  const hash = /^([0-9a-f]{64})\s/.exec(result.stdout.trim())?.[1];
  if (hash === undefined) {
    throw failure(
      { ...step, where: `on ${remote.host}` },
      "sha256sum did not report a checksum",
      options.redact,
    );
  }
  return hash;
}

/** The command, in backticks, that deletes {@link dumpPath} on `host` by hand. */
export function removeDumpByHand(host: string, folder: string): string {
  return `\`ssh deploy@${host} rm -f ${dumpPath(folder)}\``;
}

/** Deletes {@link dumpPath}; a missing file is not an error. */
export async function removeDump(remote: RemoteExec, options: ServerOpOptions): Promise<void> {
  await runStep(
    remote,
    `rm -f ${dumpPath(options.folder)}`,
    MINUTE,
    {
      what: "remove the database dump",
      hint: `Delete it by hand: ${removeDumpByHand(remote.host, options.folder)}.`,
    },
    options.redact,
  );
}

export interface CopyDumpOptions extends ServerOpOptions {
  /** Old server address (IPv4, IPv6 or host name). */
  from: string;
  /** New server address. */
  to: string;
  /** OpsCrew's deploy key (private key file). */
  keyFile: string;
  /** OpsCrew's known_hosts file with both servers' pinned host keys. */
  knownHostsFile: string;
  sizeBytes: number;
  /** Both servers' SSH port (default 22). */
  port?: number;
}

function scpTarget(host: string, folder: string): string {
  if (!/^[A-Za-z0-9:][A-Za-z0-9.:-]*$/.test(host)) {
    throw new OpsCrewError("INVALID_INPUT", `${JSON.stringify(host)} is not a server address.`);
  }
  return `deploy@${host.includes(":") ? `[${host}]` : host}:${dumpPath(folder)}`;
}

/**
 * Copies {@link dumpPath} from the old to the new server through this computer (`scp -3`), with
 * the same key, pinned host keys and options as every other OpsCrew SSH connection.
 */
export async function copyDump(runner: CommandRunner, options: CopyDumpOptions): Promise<void> {
  const source = scpTarget(options.from, options.folder);
  const destination = scpTarget(options.to, options.folder);
  const ssh = sshArgs({
    host: options.from,
    keyFile: options.keyFile,
    knownHostsFile: options.knownHostsFile,
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  // sshArgs ends with `-p <port> user@host`; scp takes the port as `-P` and the hosts in paths.
  const portAt = ssh.indexOf("-p");
  const args = ["-3", ...ssh.slice(0, portAt), "-P", ssh[portAt + 1] ?? "22", source, destination];
  const timeoutMs = moveTimeoutMs(options.sizeBytes);
  const step: Step = {
    what: "copy the database dump",
    where: `from ${options.from} to ${options.to}`,
    hint: `Check that this computer can reach both servers over SSH, then run \`${commandOf(options)}\` again.`,
  };
  let result: CommandResult;
  try {
    result = await runner.run("scp", args, { timeoutMs });
  } catch (error) {
    throw failure(step, errorMessage(error), options.redact);
  }
  check(result, step, timeoutMs, options.redact);
}
