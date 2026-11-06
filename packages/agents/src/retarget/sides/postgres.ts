/**
 * Postgres in a move (ADR 0027 D3), the same on every side: `pg_dump -Fc` and `pg_restore` run in
 * one-off containers of the pinned postgres image on the Postgres service's network, through the
 * Docker API of any {@link SideDocker}. The dump is written into a move volume, which the window
 * copies like any other volume. The password reaches a one-off container only in a password file
 * (`.pgpass` format) written through the archive `PUT` before it starts, never in its environment
 * or command. The flags and users are those of `server-ops.ts`.
 */
import {
  ContainerLeftError,
  type DockerClient,
  type OneOffResult,
  runOneOff,
  sweepCarriers,
  tarStream,
} from "@opscrew/connector-docker";
import { errorMessage, OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { pollUntil } from "../../shared";
import { withoutData } from "../server-ops";
import type { SideDocker } from "./types";

/** The app's Postgres on one side of a move. */
export interface MovePostgres {
  /** The app's name, which names the move volume ({@link moveDumpVolume}). */
  app: string;
  /**
   * The Compose project the service runs in (`<app>` on a server, `opscrew-<app>` on Portainer):
   * the one-off containers join its `internal` network.
   */
  project: string;
  /** The Postgres service's Compose name (such as `db`): its host name on that network. */
  service: string;
  /** The password of the `app` user (the service's generated `password`). */
  password: string;
}

/** The label on every one-off container of a dump, with its move volume as the value. */
const ONE_OFF_LABEL = "opscrew.move-dump";
/** Where a one-off container mounts the move volume, and the dump's path in it. */
const MOUNT = "/dump";
const DUMP = `${MOUNT}/app.dump`;
/** Where a one-off container that logs in finds the password file (mode 0600). */
const PGPASS = "/tmp/opscrew.pgpass";

/** The move volume that holds the app's dump on each side: `opscrew-move-dump-<app>`. */
export function moveDumpVolume(app: string): string {
  return `opscrew-move-dump-${app}`;
}

/** `cause`, and that the one-off container `id` could not be removed after it either. */
function leftBehind(cause: unknown, id: string): OpsCrewError {
  const short = id.slice(0, 12);
  return new OpsCrewError(
    "COMMAND_FAILED",
    `${errorMessage(cause).replace(/\.?$/, ".")} OpsCrew could not remove its one-off container ${short} either, which may hold the database's password file.`,
    {
      hint: `Remove it on the Docker host with \`docker rm -f ${short}\`, then run the command again.`,
    },
  );
}

/** One `.pgpass` field: `\` and `:` escaped with a backslash, as libpq reads them. */
function pgpassField(value: string): string {
  return value.replace(/[\\:]/g, (char) => `\\${char}`);
}

/**
 * The last Postgres tool message of a one-off container's output: {@link withoutData} drops the
 * lines that can quote row data or SQL.
 */
function lastMessage(stderr: string): string {
  return (withoutData(stderr).split("\n").at(-1) ?? "").slice(0, 300);
}

/** The plain error when a one-off container could not `what` on the side. */
function failed(what: string, result: OneOffResult, hint: string): OpsCrewError {
  const said = lastMessage(result.stderr);
  return new OpsCrewError(
    "COMMAND_FAILED",
    `Could not ${what} (exit code ${result.exitCode}${said ? `: ${said}` : ""}).`,
    { hint },
  );
}

const DATABASE_HINT =
  "Check that the app's Postgres service runs and accepts the app's login, then run the command again.";

/**
 * Runs `cmd` in a one-off postgres container with the move volume mounted, on the Postgres
 * service's network; with `login`, the password file for the service's `app` user is written into
 * it at {@link PGPASS} through the archive API before it starts, and `PGPASSFILE` names it (the
 * path, not the password).
 */
function postgresOneOff(
  client: DockerClient,
  db: MovePostgres,
  cmd: string[],
  login: boolean,
): Promise<OneOffResult> {
  const volume = moveDumpVolume(db.app);
  const pgpass = `${pgpassField(db.service)}:5432:*:app:${pgpassField(db.password)}\n`;
  const file = { name: PGPASS.slice(1), type: "file", mode: 0o600, uid: 0, gid: 0 } as const;
  return runOneOff(
    client,
    {
      image: IMAGES.postgres.ref,
      cmd,
      ...(login ? { env: { PGPASSFILE: PGPASS } } : {}),
      labels: { [ONE_OFF_LABEL]: volume },
      mounts: [{ type: "volume", source: volume, target: MOUNT }],
      network: `${db.project}_internal`,
    },
    login
      ? (id) => client.putArchive(id, "/", tarStream([{ ...file, data: Buffer.from(pgpass) }]))
      : undefined,
  ).catch((error: unknown) => {
    // A container left behind may hold the database's password file: never silently.
    throw error instanceof ContainerLeftError ? leftBehind(error.cause, error.id) : error;
  });
}

/**
 * Checks the dump in the move volume (`pg_restore --list` reads its table of contents) and
 * returns its SHA-256, computed on the side's own server.
 */
async function dumpDigest(client: DockerClient, db: MovePostgres): Promise<string> {
  const result = await postgresOneOff(
    client,
    db,
    ["sh", "-c", `pg_restore --list ${DUMP} > /dev/null && sha256sum ${DUMP}`],
    false,
  );
  const hint =
    "The dump is incomplete or damaged; OpsCrew makes a new one when you run the command again. If it fails again, check the free disk space on both sides.";
  if (result.exitCode !== 0) throw failed("read the database dump", result, hint);
  const digest = /^([0-9a-f]{64})\s/.exec(result.stdout.trim())?.[1];
  if (digest === undefined) {
    throw new OpsCrewError("COMMAND_FAILED", "sha256sum did not report the dump's checksum.", {
      hint,
    });
  }
  return digest;
}

/** Creates the move volume on a side when it is missing, and returns its name. */
export async function ensureDumpVolume(client: DockerClient, app: string): Promise<string> {
  const volume = moveDumpVolume(app);
  if (!(await client.volumeExists(volume))) {
    await client.createVolume(volume);
  }
  return volume;
}

/**
 * The old side: dumps the `app` database (`pg_dump -Fc`, as the `app` user) into the move volume,
 * created when missing, while the database still runs. Returns the dump's SHA-256 once
 * `pg_restore --list` has read it.
 */
export async function dumpPostgres(docker: SideDocker, db: MovePostgres): Promise<string> {
  const { client } = docker;
  await ensureDumpVolume(client, db.app);
  const result = await postgresOneOff(
    client,
    db,
    // The service name reaches the shell as an argument, never as part of its script.
    ["sh", "-c", `umask 077 && exec pg_dump -h "$1" -U app -Fc -f ${DUMP} app`, "sh", db.service],
    true,
  );
  if (result.exitCode !== 0) throw failed("dump the database", result, DATABASE_HINT);
  return dumpDigest(client, db);
}

/** How long the new side's Postgres has to take connections before a restore: about 2 minutes. */
const READY_MS = 2 * 60_000;

/**
 * Polls `pg_isready` in one-off containers until the Postgres service takes connections, for at
 * most {@link READY_MS}; stops plainly when it never does.
 */
async function waitReady(client: DockerClient, db: MovePostgres, waits: Waits): Promise<void> {
  let last: OneOffResult = { exitCode: 1, stdout: "", stderr: "" };
  const ready = await pollUntil(
    async () => {
      last = await postgresOneOff(
        client,
        db,
        ["pg_isready", "-h", db.service, "-U", "app", "-d", "postgres"],
        false,
      );
      return last.exitCode === 0 ? true : undefined;
    },
    { timeoutMs: READY_MS, intervalMs: 2000, ...waits },
  );
  if (!ready) throw failed("reach the database within 2 minutes", last, DATABASE_HINT);
}

/** The clock and sleep of a wait (fakes in tests). */
export interface Waits {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Drops the `app` database and creates it again empty (owner `app`, from the `postgres` database,
 * `WITH (FORCE)`, which ends any session still connected): a restore afterwards holds exactly the
 * dump, and a rolled-back window leaves no part of a copy.
 */
export async function emptyPostgres(docker: SideDocker, db: MovePostgres): Promise<void> {
  const recreated = await postgresOneOff(
    docker.client,
    db,
    [
      "psql",
      "-h",
      db.service,
      "-U",
      "app",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP DATABASE IF EXISTS app WITH (FORCE)",
      "-c",
      "CREATE DATABASE app OWNER app",
    ],
    true,
  );
  if (recreated.exitCode !== 0) throw failed("empty the database", recreated, DATABASE_HINT);
}

/**
 * The new side's copy of the dump: `pg_restore --list` reads it, and its SHA-256 must be
 * `sha256`, the dump's on the old side. Nothing is dropped before it passes.
 */
export async function checkCopiedDump(
  docker: SideDocker,
  db: MovePostgres,
  sha256: string,
): Promise<void> {
  if ((await dumpDigest(docker.client, db)) !== sha256) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "The database dump copied to the new side differs from the dump on the old side.",
      {
        hint: "Check the free disk space on both sides; running the command again makes and copies a new dump.",
      },
    );
  }
}

/**
 * The restore of a dump {@link checkCopiedDump} passed: once Postgres takes connections, the
 * `app` database is recreated empty and the dump restored into it in one transaction.
 */
export async function restoreCheckedDump(
  docker: SideDocker,
  db: MovePostgres,
  waits: Waits = {},
): Promise<void> {
  const { client } = docker;
  await waitReady(client, db, waits);
  await emptyPostgres(docker, db);
  const restored = await postgresOneOff(
    client,
    db,
    [
      "pg_restore",
      "-h",
      db.service,
      "-U",
      "app",
      "-d",
      "app",
      "--no-owner",
      "--single-transaction",
      DUMP,
    ],
    true,
  );
  if (restored.exitCode !== 0) throw failed("restore the database", restored, DATABASE_HINT);
}

/**
 * Removes the move volume from a side, with any one-off or carrier container a lost connection
 * left on it; a volume already gone is fine.
 */
export async function removeDumpVolume(client: DockerClient, app: string): Promise<void> {
  const volume = moveDumpVolume(app);
  for (const container of await client.listContainers([`${ONE_OFF_LABEL}=${volume}`])) {
    await client.removeContainer(container.id);
  }
  await sweepCarriers(client, [{ kind: "volume", name: volume }]);
  if (await client.volumeExists(volume)) await client.removeVolume(volume);
}
