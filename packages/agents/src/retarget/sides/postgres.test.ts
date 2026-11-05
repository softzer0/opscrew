import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { dockerClient, volumeCarrier } from "@opscrew/connector-docker";
import {
  type FakeContainer,
  FakeDocker,
  type FakeRun,
  parseTar,
  type TarEntry,
} from "@opscrew/connector-docker/testing";
import type { DockerTransport } from "@opscrew/contracts";
import { errorMessage } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import {
  dumpPostgres,
  ensureDumpVolume,
  type MovePostgres,
  moveDumpVolume,
  removeDumpVolume,
  restorePostgres,
} from "./postgres";
import type { SideDocker } from "./types";

const APP = "example-app";
const PASSWORD = fakeSecret("generic-password", "move-db");
const VOLUME = moveDumpVolume(APP);

async function bytes(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** An archive `PUT` into a container, and the container's state when it came. */
interface Upload {
  state: string | undefined;
  entries: TarEntry[];
}

/**
 * One side of a move: Docker in memory, whose one-off postgres containers answer as Postgres's
 * tools do. They log in only with the `.pgpass` written into them before they start.
 */
function fakeSide(project: string) {
  const fake = new FakeDocker();
  fake.images.add(IMAGES.postgres.ref);
  fake.images.add(IMAGES.busybox.ref);
  const uploads = new Map<string, Upload[]>();
  const ran: FakeContainer[] = [];
  const restored: Buffer[] = [];
  /** What each tool prints to stderr when it fails (empty: it succeeds). */
  const database = { dropped: 0, stderr: "", psql: "", restore: "" };
  const transport: DockerTransport = {
    async request(request) {
      const archive = /^\/containers\/([^/]+)\/archive/.exec(request.path);
      if (request.method === "PUT" && archive !== null && request.body instanceof Readable) {
        const id = archive[1] ?? "";
        const data = await bytes(request.body);
        uploads.set(id, [
          ...(uploads.get(id) ?? []),
          { state: fake.containers.get(id)?.state, entries: parseTar(data) },
        ]);
        return fake.request({ ...request, body: Readable.from([data], { objectMode: false }) });
      }
      return fake.request(request);
    },
  };
  const dumpOf = (container: FakeContainer) => {
    const mount = container.mounts.find((entry) => entry.target === "/dump");
    const volume = fake.volumes.get(mount?.source ?? "");
    return { volume, file: volume?.files.get("app.dump") };
  };
  const loggedIn = (container: FakeContainer) => {
    const pgpass = uploads
      .get(container.id)
      ?.flatMap((upload) => upload.entries)
      .find((entry) => entry.name === "tmp/opscrew.pgpass");
    return (
      container.env.includes("PGPASSFILE=/tmp/opscrew.pgpass") &&
      pgpass?.mode === 0o600 &&
      pgpass.uid === 0 &&
      pgpass.data?.toString("utf8") === `db:5432:*:app:${PASSWORD}\n`
    );
  };
  const refused: FakeRun = {
    exitCode: 1,
    stderr:
      'pg_dump: error: connection to server at "db" failed: fe_sendauth: no password supplied\n',
  };
  fake.onStart = (container) => {
    ran.push({ ...container });
    if (container.image !== IMAGES.postgres.ref) return undefined;
    const script = container.cmd.join(" ");
    const { volume, file } = dumpOf(container);
    if (script.includes("pg_dump")) {
      if (!loggedIn(container)) return refused;
      if (database.stderr !== "") return { exitCode: 1, stderr: database.stderr };
      volume?.files.set("app.dump", {
        type: "file",
        mode: 0o600,
        uid: 0,
        gid: 0,
        data: Buffer.from(`PGDMP rows of ${project}`),
      });
      return { exitCode: 0 };
    }
    if (script.includes("pg_restore --list")) {
      if (file?.data === undefined) {
        return { exitCode: 1, stderr: "pg_restore: error: could not open input file\n" };
      }
      const digest = createHash("sha256").update(file.data).digest("hex");
      return { exitCode: 0, stdout: `${digest}  /dump/app.dump\n` };
    }
    if (container.cmd[0] === "psql") {
      if (!loggedIn(container)) return refused;
      if (database.psql !== "") return { exitCode: 1, stderr: database.psql };
      database.dropped += 1;
      return { exitCode: 0 };
    }
    if (container.cmd[0] === "pg_restore") {
      if (!loggedIn(container) || file?.data === undefined) return refused;
      if (database.restore !== "") return { exitCode: 1, stderr: database.restore };
      restored.push(file.data);
      return { exitCode: 0 };
    }
    return { exitCode: 127, stderr: "unknown command\n" };
  };
  const client = dockerClient(transport);
  const docker: SideDocker = {
    client,
    carrier: volumeCarrier(client, IMAGES.busybox.ref),
    close: async () => {},
  };
  const db: MovePostgres = { app: APP, project, service: "db", password: PASSWORD };
  return { fake, docker, db, uploads, ran, restored, database };
}

/** Everything a test can see of a side: its containers' environment and commands. */
function containerText(side: ReturnType<typeof fakeSide>): string {
  return JSON.stringify(
    side.ran.map((container) => [container.env, container.cmd, container.labels]),
  );
}

/** Copies the move volume from `old` to `next` with the carrier, as the window does. */
async function copyDump(old: ReturnType<typeof fakeSide>, next: ReturnType<typeof fakeSide>) {
  await ensureDumpVolume(next.docker.client, APP);
  const source = { kind: "volume", name: VOLUME } as const;
  await next.docker.carrier.writeVolume(source, await old.docker.carrier.readVolume(source));
}

describe("Postgres in a move", () => {
  it("dumps on the old side and restores on the new one through one-off postgres containers", async () => {
    const old = fakeSide("example-app");
    const next = fakeSide("opscrew-example-app");

    const digest = await dumpPostgres(old.docker, old.db);
    expect(old.fake.volumes.has(VOLUME)).toBe(true);
    await copyDump(old, next);
    await restorePostgres(next.docker, next.db, digest);

    expect(next.restored.map(String)).toEqual(["PGDMP rows of example-app"]);
    expect(next.database.dropped).toBe(1);
    // pg_dump with the flags and user of today's window, then pg_restore --list and the hash.
    const pgOneOffs = (side: ReturnType<typeof fakeSide>) =>
      side.ran.filter((container) => container.image === IMAGES.postgres.ref);
    expect(pgOneOffs(old).map((container) => container.cmd)).toEqual([
      [
        "sh",
        "-c",
        'umask 077 && exec pg_dump -h "$1" -U app -Fc -f /dump/app.dump app',
        "sh",
        "db",
      ],
      ["sh", "-c", "pg_restore --list /dump/app.dump > /dev/null && sha256sum /dump/app.dump"],
    ]);
    // On the new side: the copy checked first, then the database recreated, then the restore.
    expect(pgOneOffs(next).map((container) => container.cmd)).toEqual([
      ["sh", "-c", "pg_restore --list /dump/app.dump > /dev/null && sha256sum /dump/app.dump"],
      [
        "psql",
        "-h",
        "db",
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
      [
        "pg_restore",
        "-h",
        "db",
        "-U",
        "app",
        "-d",
        "app",
        "--no-owner",
        "--single-transaction",
        "/dump/app.dump",
      ],
    ]);
    for (const [side, network] of [
      [old, "example-app_internal"],
      [next, "opscrew-example-app_internal"],
    ] as const) {
      for (const container of pgOneOffs(side)) {
        expect(container.network).toBe(network);
        expect(container.mounts.map((mount) => [mount.type, mount.source, mount.target])).toEqual([
          ["volume", VOLUME, "/dump"],
        ]);
      }
      // Every one-off container and carrier is gone afterwards.
      expect(side.fake.containers.size).toBe(0);
    }
  });

  it("gives the password only in a file written before the container starts, never in Env or Cmd", async () => {
    const old = fakeSide("example-app");
    const next = fakeSide("opscrew-example-app");
    const digest = await dumpPostgres(old.docker, old.db);
    await copyDump(old, next);
    await restorePostgres(next.docker, next.db, digest);

    for (const side of [old, next]) {
      expect(containerText(side)).not.toContain(PASSWORD);
      for (const [, uploads] of side.uploads) {
        for (const upload of uploads.filter((item) =>
          item.entries.some((entry) => entry.name === "tmp/opscrew.pgpass"),
        )) {
          expect(upload.state).toBe("created");
          expect(
            upload.entries.map(({ name, mode, uid, gid }) => ({ name, mode, uid, gid })),
          ).toEqual([{ name: "tmp/opscrew.pgpass", mode: 0o600, uid: 0, gid: 0 }]);
        }
      }
    }
    // Only the containers that log in get it: pg_restore --list reads a file.
    const withLogin = (side: ReturnType<typeof fakeSide>) =>
      side.ran.filter((container) =>
        side.uploads
          .get(container.id)
          ?.some((upload) => upload.entries.some((entry) => entry.name === "tmp/opscrew.pgpass")),
      ).length;
    expect(withLogin(old)).toBe(1);
    expect(withLogin(next)).toBe(2);
    // The environment names the file, never the password; containers that read a file get none.
    for (const side of [old, next]) {
      expect([...new Set(side.ran.map((container) => container.env.join(" ")))].sort()).toEqual([
        "",
        "PGPASSFILE=/tmp/opscrew.pgpass",
      ]);
    }
  });

  it("stops before dropping anything when the copy differs from the dump", async () => {
    const old = fakeSide("example-app");
    const next = fakeSide("opscrew-example-app");
    const digest = await dumpPostgres(old.docker, old.db);
    await copyDump(old, next);
    const copy = next.fake.volumes.get(VOLUME)?.files.get("app.dump");
    if (copy?.data !== undefined) copy.data = Buffer.from("PGDMP cut short");

    await expect(restorePostgres(next.docker, next.db, digest)).rejects.toThrow(
      "differs from the dump on the old side",
    );
    expect(next.database.dropped).toBe(0);
    expect(next.restored).toEqual([]);
  });

  it("says why a dump failed without the rows or the password Postgres quoted", async () => {
    const old = fakeSide("example-app");
    old.database.stderr = [
      'pg_dump: error: query failed: ERROR:  permission denied for table "users"',
      `DETAIL:  Failing row contains (1, ${PASSWORD}).`,
      `pg_dump: detail: Command was: COPY public.users (id, secret) TO stdout; -- ${PASSWORD}`,
      "",
    ].join("\n");

    const error = await dumpPostgres(old.docker, old.db).catch((caught: unknown) => caught);
    const text = `${errorMessage(error)} ${JSON.stringify(error)}`;
    expect(errorMessage(error)).toContain("Could not dump the database (exit code 1");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("Failing row");
    expect(old.fake.containers.size).toBe(0);
  });

  it("removes a one-off container that holds the password file when the archive PUT or the wait fails", async () => {
    for (const [method, path] of [
      ["PUT", /\/archive/],
      ["POST", /\/wait$/],
    ] as const) {
      const old = fakeSide("example-app");
      old.fake.fail(method, path, 500, "the Docker daemon is unavailable");
      await expect(dumpPostgres(old.docker, old.db)).rejects.toThrow(
        "the Docker daemon is unavailable",
      );
      expect(old.fake.containers.size).toBe(0);

      const next = fakeSide("opscrew-example-app");
      const digest = await dumpPostgres(old.docker, old.db);
      await copyDump(old, next);
      // In the restore, the first archive PUT is the password file of the container that empties
      // the database (the copy's check logs in nowhere); the first wait is the copy's check.
      next.fake.fail(method, path, 500, "the Docker daemon is unavailable");
      await expect(restorePostgres(next.docker, next.db, digest)).rejects.toThrow(
        "the Docker daemon is unavailable",
      );
      expect(next.fake.containers.size).toBe(0);
      expect(next.database.dropped).toBe(0);
    }
  });

  it("says so when a failed one-off container with the password file cannot be removed either", async () => {
    const old = fakeSide("example-app");
    old.fake.fail("PUT", /\/archive/, 500, "the Docker daemon is unavailable");
    old.fake.fail("DELETE", /^\/containers\//, 500, "the Docker daemon is unavailable");
    const error = await dumpPostgres(old.docker, old.db).catch((caught: unknown) => caught);
    const [left] = [...old.fake.containers.keys()];
    const short = left?.slice(0, 12);
    expect(errorMessage(error)).toContain(
      `OpsCrew could not remove its one-off container ${short} either, which may hold the database's password file.`,
    );
    expect(JSON.stringify(error)).toContain(`docker rm -f ${short}`);
    expect(`${errorMessage(error)} ${JSON.stringify(error)}`).not.toContain(PASSWORD);
  });

  it("says why emptying or restoring the database failed, without the password, and leaves no container", async () => {
    const quoted = [
      `DETAIL:  Key (secret)=(${PASSWORD}) already exists.`,
      `pg_restore: detail: Command was: COPY public.users (id, secret) FROM stdin; -- ${PASSWORD}`,
      "",
    ];
    for (const [tool, stderr, wording] of [
      [
        "psql",
        ['psql: error: ERROR:  database "app" is being accessed by other users', ...quoted].join(
          "\n",
        ),
        'Could not empty the database (exit code 1: psql: error: ERROR:  database "app" is being accessed by other users).',
      ],
      [
        "restore",
        [
          'pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint "users_pkey"',
          ...quoted,
        ].join("\n"),
        'Could not restore the database (exit code 1: pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint "users_pkey").',
      ],
    ] as const) {
      const old = fakeSide("example-app");
      const next = fakeSide("opscrew-example-app");
      const digest = await dumpPostgres(old.docker, old.db);
      await copyDump(old, next);
      next.database[tool] = stderr;

      const error = await restorePostgres(next.docker, next.db, digest).catch(
        (caught: unknown) => caught,
      );
      expect(errorMessage(error)).toBe(wording);
      expect(`${errorMessage(error)} ${JSON.stringify(error)}`).not.toContain(PASSWORD);
      expect(next.fake.containers.size).toBe(0);
      expect(next.restored).toEqual([]);
    }
  });

  it("pulls the pinned postgres image when the server lacks it", async () => {
    const old = fakeSide("example-app");
    old.fake.images.delete(IMAGES.postgres.ref);
    await dumpPostgres(old.docker, old.db);
    expect(old.fake.calls).toContain(
      `POST /images/create?fromImage=${encodeURIComponent(IMAGES.postgres.ref)}`,
    );
  });

  it("removes the move volume with what a lost connection left on it", async () => {
    const old = fakeSide("example-app");
    await dumpPostgres(old.docker, old.db);
    // A one-off container and a carrier a lost connection left behind.
    await old.docker.client.createContainer({
      image: IMAGES.postgres.ref,
      labels: { "opscrew.move-dump": VOLUME },
      binds: [`${VOLUME}:/dump`],
    });
    await old.docker.client.createContainer({
      image: IMAGES.busybox.ref,
      labels: { "opscrew.carrier": VOLUME },
      binds: [`${VOLUME}:/data:ro`],
    });
    old.fake.addVolume("other-volume");

    await removeDumpVolume(old.docker.client, APP);
    expect(old.fake.volumes.has(VOLUME)).toBe(false);
    expect(old.fake.volumes.has("other-volume")).toBe(true);
    expect(old.fake.containers.size).toBe(0);
    // Already gone: nothing to do.
    await removeDumpVolume(old.docker.client, APP);
  });
});
