/**
 * Postgres in a move against the local Docker, through `docker system dial-stdio` as on a side
 * reached over SSH: a database with rows is dumped in one Compose-like project, its move volume is
 * copied with the carrier into a second project's, and restored into a second Postgres, which then
 * holds the rows and nothing it held before. The password never reaches a container's Env or Cmd.
 * It pulls the pinned postgres and busybox images, so it runs only with OPSCREW_DOCKER_TESTS=1, and
 * removes what it made (the images too, when they weren't there before).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  type DockerClient,
  dialStdioTransport,
  dockerClient,
  volumeCarrier,
} from "@opscrew/connector-docker";
import type { DockerTransport } from "@opscrew/contracts";
import { NodeStreamRunner } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkCopiedDump,
  dumpPostgres,
  ensureDumpVolume,
  type MovePostgres,
  moveDumpVolume,
  removeDumpVolume,
  restoreCheckedDump,
} from "./postgres";
import type { SideDocker } from "./types";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[agents] skipping Postgres in a move against Docker: ${reason}`);

/** A pinned `name:tag@sha256:…` as `name@sha256:…`, the form `docker image inspect` finds. */
const byDigest = (ref: string) => ref.replace(/:[^:@/]+@/, "@");

/** Runs the docker CLI and returns its output; a failure fails the test with its error output. */
function docker(...args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

describe.skipIf(reason !== undefined)("Postgres in a move against the local Docker", () => {
  const run = randomBytes(4).toString("hex");
  const runner = new NodeStreamRunner();
  const transports = [1, 2].map(() =>
    dialStdioTransport(() => runner.open("docker", ["system", "dial-stdio"])),
  );
  /** Every container the move created through the API: its image, Env and Cmd. */
  const created: { Image: string; Env?: string[]; Cmd?: string[] }[] = [];
  const recording = (transport: DockerTransport): DockerTransport => ({
    async request(request) {
      if (request.method === "POST" && request.path.startsWith("/containers/create")) {
        if (typeof request.body === "string") created.push(JSON.parse(request.body));
      }
      return transport.request(request);
    },
  });
  const [oldClient, newClient] = transports.map((transport) =>
    dockerClient(recording(transport)),
  ) as [DockerClient, DockerClient];
  const side = (client: DockerClient): SideDocker => ({
    client,
    carrier: volumeCarrier(client, IMAGES.busybox.ref),
    close: async () => {},
  });
  // A password with a `:`, which the password file escapes.
  const passwords = [
    `pw:${randomBytes(9).toString("hex")}`,
    `pw:${randomBytes(9).toString("hex")}`,
  ];
  const [oldDb, newDb] = (["a", "b"] as const).map(
    (name, i): MovePostgres => ({
      app: `opscrew-test-${run}-${name}`,
      project: `opscrew-test-${run}-${name}`,
      service: "db",
      password: passwords[i] ?? "",
    }),
  ) as [MovePostgres, MovePostgres];
  const container = (db: MovePostgres) => `${db.project}-db-1`;
  const hadImages = new Map<string, boolean>();

  /** Runs `sql` in the side's Postgres, as the image's own clients do (no password there). */
  const psql = (db: MovePostgres, sql: string) =>
    docker(
      "exec",
      container(db),
      "psql",
      "-U",
      "app",
      "-d",
      "app",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      sql,
    );

  beforeAll(async () => {
    for (const ref of [IMAGES.postgres.ref, IMAGES.busybox.ref]) {
      hadImages.set(ref, spawnSync("docker", ["image", "inspect", byDigest(ref)]).status === 0);
    }
    // Each side's database, as a Compose project runs it: the service `db` on `<project>_internal`.
    for (const db of [oldDb, newDb]) {
      docker("network", "create", "--label", `opscrew.test=${run}`, `${db.project}_internal`);
      docker(
        "run",
        "-d",
        "--name",
        container(db),
        "--label",
        `opscrew.test=${run}`,
        "--network",
        `${db.project}_internal`,
        "--network-alias",
        db.service,
        "-e",
        "POSTGRES_USER=app",
        "-e",
        "POSTGRES_DB=app",
        "-e",
        `POSTGRES_PASSWORD=${db.password}`,
        IMAGES.postgres.ref,
      );
    }
    // Ready once it listens on TCP: the image's first-start server listens on its socket only.
    for (const db of [oldDb, newDb]) {
      for (let attempt = 0; ; attempt++) {
        const ready = spawnSync("docker", [
          "exec",
          container(db),
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "app",
          "-d",
          "app",
        ]);
        if (ready.status === 0) break;
        if (attempt > 120) throw new Error(`${container(db)} did not become ready`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    psql(
      oldDb,
      "create table orders (id int primary key, item text); insert into orders values (1, 'tea'), (2, 'cake')",
    );
    psql(newDb, "create table stale (id int)");
  }, 300_000);

  afterAll(async () => {
    for (const [client, db] of [
      [oldClient, oldDb],
      [newClient, newDb],
    ] as const) {
      await removeDumpVolume(client, db.app).catch(() => {});
      spawnSync("docker", ["rm", "-fv", container(db)]);
      spawnSync("docker", ["network", "rm", `${db.project}_internal`]);
    }
    for (const transport of transports) await transport.close?.();
    for (const [ref, had] of hadImages) {
      if (!had) spawnSync("docker", ["image", "rm", byDigest(ref)]);
    }
  }, 120_000);

  it("dumps, copies and restores the database, with matching hashes and no password in Env or Cmd", async () => {
    const old = side(oldClient);
    const fresh = side(newClient);
    const digest = await dumpPostgres(old, oldDb);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const from = { kind: "volume", name: moveDumpVolume(oldDb.app) } as const;
    const to = { kind: "volume", name: await ensureDumpVolume(newClient, newDb.app) } as const;
    await fresh.carrier.writeVolume(to, await old.carrier.readVolume(from));
    expect(await fresh.carrier.volumeDigest(to)).toBe(await old.carrier.volumeDigest(from));

    // It checks the copy's SHA-256 against the dump's before dropping anything.
    await checkCopiedDump(fresh, newDb, digest);
    await restoreCheckedDump(fresh, newDb);
    expect(psql(newDb, "select string_agg(item, ',' order by id) from orders")).toBe("tea,cake");
    expect(psql(newDb, "select to_regclass('stale') is null")).toBe("t");

    const postgresOneOffs = created.filter((spec) => spec.Image === IMAGES.postgres.ref);
    // The dump, its digest and the copy's, `pg_isready`, then psql and pg_restore.
    expect(postgresOneOffs.length).toBe(6);
    for (const spec of created) {
      for (const password of passwords) {
        expect(JSON.stringify([spec.Env, spec.Cmd])).not.toContain(password);
      }
    }
    expect([...new Set(postgresOneOffs.map((spec) => (spec.Env ?? []).join(" ")))].sort()).toEqual([
      "",
      "PGPASSFILE=/tmp/opscrew.pgpass",
    ]);

    // Afterwards nothing of the move is left on either side.
    for (const [client, db] of [
      [oldClient, oldDb],
      [newClient, newDb],
    ] as const) {
      await removeDumpVolume(client, db.app);
      expect(await client.volumeExists(moveDumpVolume(db.app))).toBe(false);
      expect(await client.listContainers([`opscrew.move-dump=${moveDumpVolume(db.app)}`])).toEqual(
        [],
      );
    }
  }, 300_000);
});
