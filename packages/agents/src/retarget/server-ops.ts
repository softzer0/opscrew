import type { CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { sshArgs } from "../shared";

/**
 * Typed server operations for moving a deployment between servers (feature 005). Every command is
 * fixed here; callers choose an operation and pass validated values, never shell text. Commands
 * run as the `deploy` user in `/srv/app`, where the deploy workflow keeps `compose.yaml` and the
 * `.env` file that names `APP_IMAGE`.
 */

/** Where the database dump lives on both servers while it is moved (mode 0600, owned by deploy). */
export const DUMP_PATH = "/srv/app/opscrew-move.dump";

/** Compose services OpsCrew stops and starts during a move. */
export type MoveService = "app" | "caddy";

/** Passes user-visible text through the redactor (`deps.redactor.redact`). */
export type RedactText = (text: string) => string;

export interface ServerOpOptions {
  redact: RedactText;
}

const MINUTE = 60_000;
const MB = 1024 * 1024;
const STDERR_LIMIT = 500;
const SERVICES: readonly MoveService[] = ["app", "caddy"];
const SERVICE_LABEL: Record<MoveService, string> = { app: "the app", caddy: "Caddy" };

/**
 * Timeout for a database dump, copy or restore: 5 minutes plus 1 minute per started 100 MB of
 * database size, at most 6 hours. Unknown (non-finite) sizes get the ceiling.
 */
export function moveTimeoutMs(sizeBytes: number): number {
  const floor = 5 * MINUTE;
  const ceiling = 6 * 60 * MINUTE;
  if (!Number.isFinite(sizeBytes)) return ceiling;
  const extra = Math.ceil(Math.max(0, sizeBytes) / (100 * MB)) * MINUTE;
  return Math.min(ceiling, floor + extra);
}

function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return `${Math.round(ms / 1000)} seconds`;
  if (minutes >= 120 && minutes % 60 === 0) return `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
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
      `Could not ${step.what} ${step.where}: it did not finish within ${duration(timeoutMs)}.`,
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
    throw failure(full, error instanceof Error ? error.message : String(error), redact);
  }
  return check(result, full, timeoutMs, redact);
}

const composePsHint = (host: string) =>
  `Connect to the server (\`ssh deploy@${host}\`), run \`docker compose ps\` in /srv/app to see what is running, then run \`opscrew retarget\` again.`;

function assertService(service: MoveService): void {
  if (!SERVICES.includes(service)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew can only stop or start ${SERVICES.join(" and ")}.`,
    );
  }
}

/** Stops a Compose service (`app` or `caddy`) in `/srv/app`. */
export async function stopService(
  remote: RemoteExec,
  service: MoveService,
  options: ServerOpOptions,
): Promise<void> {
  assertService(service);
  await runStep(
    remote,
    `cd /srv/app && docker compose stop ${service}`,
    2 * MINUTE,
    { what: `stop ${SERVICE_LABEL[service]}`, hint: composePsHint(remote.host) },
    options.redact,
  );
}

/** Starts a Compose service (`app` or `caddy`) in `/srv/app` with `docker compose up -d`. */
export async function startService(
  remote: RemoteExec,
  service: MoveService,
  options: ServerOpOptions,
): Promise<void> {
  assertService(service);
  await runStep(
    remote,
    `cd /srv/app && docker compose up -d ${service}`,
    5 * MINUTE,
    { what: `start ${SERVICE_LABEL[service]}`, hint: composePsHint(remote.host) },
    options.redact,
  );
}

function healthCommand(port: number, healthPath: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OpsCrewError("INVALID_INPUT", `The app port ${port} is not a valid TCP port.`, {
      hint: "Set `app.port` in opscrew/plan.yaml to a number between 1 and 65535.",
    });
  }
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
  // A one-off Caddy container (busybox wget) on the Compose network: works whether or not the
  // `caddy` service is running (it is stopped on the new server until DNS points at it).
  return `cd /srv/app && docker compose run --rm --no-deps -T --entrypoint wget caddy -q -O /dev/null -T 5 'http://app:${port}${healthPath}'`;
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
    return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
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
): Promise<boolean> {
  return (await probe(remote, healthCommand(port, healthPath))).healthy;
}

export interface WaitAppHealthyOptions extends ServerOpOptions {
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
  const command = healthCommand(port, healthPath);
  const timeoutMs = options.timeoutMs ?? 5 * MINUTE;
  const intervalMs = options.intervalMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const { healthy, detail } = await probe(remote, command);
    if (healthy) return;
    if (now() >= deadline) {
      const last = excerpt(detail, options.redact);
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `The app on ${remote.host} did not answer on http://app:${port}${healthPath} within ${duration(timeoutMs)}${last ? ` (last check: ${last})` : ""}.`,
        {
          hint: `See why on the server: \`ssh deploy@${remote.host}\`, then \`cd /srv/app && docker compose logs --tail 200 app\`.`,
        },
      );
    }
    await sleep(intervalMs);
  }
}

const dbHint = (host: string) =>
  `Connect to the server (\`ssh deploy@${host}\`) and check the database with \`cd /srv/app && docker compose ps db\` and \`docker compose logs --tail 100 db\`.`;

/** Size of the `app` Postgres database in bytes. */
export async function databaseSize(remote: RemoteExec, options: ServerOpOptions): Promise<number> {
  const step = { what: "read the database size", hint: dbHint(remote.host) };
  const result = await runStep(
    remote,
    `cd /srv/app && docker compose exec -T db psql -U app -d app -tAc "select pg_database_size('app')"`,
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
 * Writes a custom-format `pg_dump` of the `app` database to {@link DUMP_PATH} (created with
 * `umask 077`). Timeout scaled by {@link moveTimeoutMs}.
 */
export async function dumpDatabase(
  remote: RemoteExec,
  sizeBytes: number,
  options: ServerOpOptions,
): Promise<void> {
  await runStep(
    remote,
    `cd /srv/app && umask 077 && rm -f ${DUMP_PATH} && docker compose exec -T db pg_dump -U app -Fc app > ${DUMP_PATH}`,
    moveTimeoutMs(sizeBytes),
    { what: "dump the database", hint: dbHint(remote.host), filter: withoutData },
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
    `cd /srv/app && docker compose exec -T db psql -U app -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS app WITH (FORCE)' -c 'CREATE DATABASE app OWNER app'`,
    2 * MINUTE,
    { what: "empty the database", hint: dbHint(remote.host), filter: withoutData },
    options.redact,
  );
}

/**
 * Restores {@link DUMP_PATH} into the `app` database in one transaction. The database must be
 * empty ({@link recreateDatabase}); nothing is dropped first. Timeout scaled by
 * {@link moveTimeoutMs}.
 */
export async function restoreDatabase(
  remote: RemoteExec,
  sizeBytes: number,
  options: ServerOpOptions,
): Promise<void> {
  await runStep(
    remote,
    `cd /srv/app && chmod 600 ${DUMP_PATH} && docker compose exec -T db pg_restore -U app -d app --no-owner --single-transaction < ${DUMP_PATH}`,
    moveTimeoutMs(sizeBytes),
    { what: "restore the database", hint: dbHint(remote.host), filter: withoutData },
    options.redact,
  );
}

/** The Compose service that runs `app.releaseCommand` (only `docker compose run` starts it). */
const RELEASE_SERVICE = "release";
const RELEASE_COMMAND = `docker compose run --rm --no-deps -T ${RELEASE_SERVICE}`;

/**
 * True when `/srv/app/compose.yaml` on the server defines the `release` service: the deployed
 * version has a release command, and its deploy workflow runs it before each new version starts.
 */
export async function hasReleaseService(
  remote: RemoteExec,
  options: ServerOpOptions,
): Promise<boolean> {
  const result = await runStep(
    remote,
    `cd /srv/app && docker compose --profile ${RELEASE_SERVICE} config --services`,
    MINUTE,
    { what: "read the Compose services", hint: composePsHint(remote.host) },
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
export async function runRelease(remote: RemoteExec, sizeBytes: number): Promise<void> {
  const timeoutMs = moveTimeoutMs(sizeBytes);
  const failed = (why: string) =>
    new OpsCrewError(
      "COMMAND_FAILED",
      `Could not run the release command (app.releaseCommand in opscrew/plan.yaml) on ${remote.host}: ${why} (it ran only on the copy of the database on the new server; your users' data on the old server is untouched).`,
      {
        hint: `The old server keeps serving your users. See the release command's full output on the new server: \`ssh deploy@${remote.host}\`, then \`cd /srv/app && ${RELEASE_COMMAND}\` (it runs on the copy only). Fix the release command (app.releaseCommand in opscrew/plan.yaml) or the app's migrations so they run on the old server's data, and push the fix (the deploy workflow now deploys to the new server).`,
      },
    );
  let result: CommandResult;
  try {
    result = await remote.run(`cd /srv/app && ${RELEASE_COMMAND}`, { timeoutMs });
  } catch {
    throw failed("the SSH connection failed");
  }
  if (result.timedOut) throw failed(`it did not finish within ${duration(timeoutMs)}`);
  if (result.exitCode !== 0) throw failed(`it exited with code ${result.exitCode}`);
}

/**
 * Checks the dump at {@link DUMP_PATH}: Postgres can read its table of contents
 * (`pg_restore --list`), and returns its SHA-256, so the copy on the new server can be compared
 * with the dump on the old one before anything is dropped. Timeout scaled by {@link moveTimeoutMs}.
 */
export async function verifyDump(
  remote: RemoteExec,
  sizeBytes: number,
  options: ServerOpOptions,
): Promise<string> {
  const step = {
    what: "read the database dump",
    hint: `The dump is incomplete or damaged; OpsCrew makes a new one when you run \`opscrew retarget\` again. If it fails again, check the free disk space on both servers (\`ssh deploy@${remote.host} df -h /srv/app\`).`,
    filter: withoutData,
  };
  const result = await runStep(
    remote,
    `cd /srv/app && docker compose exec -T db pg_restore --list < ${DUMP_PATH} > /dev/null && sha256sum ${DUMP_PATH}`,
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

/** Deletes {@link DUMP_PATH}; a missing file is not an error. */
export async function removeDump(remote: RemoteExec, options: ServerOpOptions): Promise<void> {
  await runStep(
    remote,
    `rm -f ${DUMP_PATH}`,
    MINUTE,
    {
      what: "remove the database dump",
      hint: `Delete it by hand: \`ssh deploy@${remote.host} rm -f ${DUMP_PATH}\`.`,
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
  /** SSH port on both servers; default 22. */
  port?: number;
}

function scpTarget(host: string): string {
  if (!/^[A-Za-z0-9:][A-Za-z0-9.:-]*$/.test(host)) {
    throw new OpsCrewError("INVALID_INPUT", `${JSON.stringify(host)} is not a server address.`);
  }
  return `deploy@${host.includes(":") ? `[${host}]` : host}:${DUMP_PATH}`;
}

/**
 * Copies {@link DUMP_PATH} from the old to the new server through this computer (`scp -3`), with
 * the same key, pinned host keys and options as every other OpsCrew SSH connection.
 */
export async function copyDump(runner: CommandRunner, options: CopyDumpOptions): Promise<void> {
  const source = scpTarget(options.from);
  const destination = scpTarget(options.to);
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
    hint: "Check that this computer can reach both servers over SSH, then run `opscrew retarget` again.",
  };
  let result: CommandResult;
  try {
    result = await runner.run("scp", args, { timeoutMs });
  } catch (error) {
    throw failure(step, error instanceof Error ? error.message : String(error), options.redact);
  }
  check(result, step, timeoutMs, options.redact);
}
