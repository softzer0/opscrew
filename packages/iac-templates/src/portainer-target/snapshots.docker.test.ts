// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax in scripts, not JavaScript templates.
/**
 * Portainer's scheduled snapshots and off-server copy on Docker (plan.md 4. and 7., research R7
 * S2), with the services as the stack renders them:
 * 1. PostgreSQL with a table, Valkey in queue mode with keys, and a SQLite database in WAL mode in
 *    the `sqlite` volume, which a writer keeps writing to as the app's uid (1002);
 * 2. the stamp names the running image, the per-part loops run with `every` at 20 seconds, and the
 *    `snapshots` service finishes the slot: `about.json` names each part with its size and the
 *    running image's digest, the folder is 700 and its files 600, root's, and no marker is left;
 * 3. the dump restores its table's list, the RDB is an RDB, and the SQLite copy is one file
 *    holding the rows;
 * 4. the `offsite` service, its remote turned into a local folder, fetches and checks age and
 *    uploads every file encrypted, `about.json` too; each decrypts with the test's age identity to
 *    exactly the snapshot's file.
 * Neither the services' logs nor `about.json` hold a password.
 *
 * It pulls the pinned images and fetches age from GitHub, so it runs only with
 * OPSCREW_DOCKER_TESTS=1. It removes its containers and volumes, and the images it pulled.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgeIdentity } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { withSqlite } from "../workflow/__fixtures__/plans";
import { skipReason } from "../workflow/__fixtures__/sh";
import { portainerTestPlan } from "./__fixtures__/plans";
import { fillPortainerStack, renderPortainerStack } from "./index";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping Portainer's snapshots on Docker: ${reason}`);

const RUN = randomBytes(3).toString("hex");
const PROJECT = `opscrew-t2405-${RUN}`;
const SNAPSHOTS_VOLUME = `opscrew-snapshots-test-${RUN}`;
const IMAGE = `ghcr.io/acme/shop@sha256:${randomBytes(32).toString("hex")}`;
const BUCKET = "shop-prod-backups";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `shop` on Portainer: PostgreSQL `db`, Valkey `queue` in queue mode, SQLite, both copies on. */
function plan(): DeployPlan {
  const base = withSqlite(portainerTestPlan({ postgres: true }), { dir: "data" });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      build: {
        builder: "railpack",
        chosen: "auto",
        reason: "test",
        runtime: { language: "node", version: "24" },
        probe: "node",
      },
    },
    services: [
      ...base.services,
      {
        name: "queue",
        kind: "valkey",
        version: "8",
        memoryMb: 128,
        enabled: true,
        options: { mode: "queue" },
        reason: "Jobs.",
        licence: "BSD-3-Clause",
      },
    ],
    snapshots: {
      schedule: { every: "1h", keep: 2 },
      offsite: { provider: "r2", bucket: BUCKET },
    },
  });
}

type Service = Record<string, unknown> & {
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: unknown;
};

/** The writer: as root it gives the volume to uid 1002, then as that uid writes a row every 20 ms. */
const WRITER = [
  "import os, sqlite3, time",
  'os.chown("/data", 1002, 1002)',
  "os.setgroups([]); os.setgid(1002); os.setuid(1002)",
  'c = sqlite3.connect("/data/app.sqlite3", isolation_level=None)',
  'c.execute("pragma journal_mode=wal")',
  'c.execute("create table if not exists t (id integer primary key, v text)")',
  "i = 0",
  "while True:",
  "    i += 1",
  '    c.execute("insert into t (v) values (?)", ("row-%d" % i,))',
  "    time.sleep(0.02)",
].join("\n");

/** The test's project: the rendered stack's snapshot services, the two services and the writer. */
function project(recipient: string): object {
  const filled = fillPortainerStack(renderPortainerStack(plan(), testContext()).content, IMAGE);
  const stack = parse(filled) as {
    services: Record<string, Service>;
    volumes: Record<string, unknown>;
  };
  const take = (name: string): Service => {
    const service = stack.services[name];
    if (service === undefined) throw new Error(`The stack has no service ${name}.`);
    return service;
  };
  const services: Record<string, Service> = {};
  for (const name of ["db", "queue", "snapshots-db", "snapshots-queue", "snapshots-sqlite"]) {
    services[name] = take(name);
  }
  for (const name of ["snapshots-db", "snapshots-queue", "snapshots-sqlite"]) {
    const service = services[name] as Service;
    service.environment = { ...service.environment, OPSCREW_SNAPSHOT_EVERY: "20" };
  }
  const snapshots = take("snapshots");
  services.snapshots = {
    ...snapshots,
    environment: { OPSCREW_SNAPSHOT_GIVE_UP: "600" },
  };
  // The stamp, which names the running image, without waiting for an app this test doesn't run.
  const { depends_on: _, ...stamp } = take("stamp");
  services.stamp = stamp;
  // The off-server copy, its remote a local folder: rclone's `offsite:<bucket>/…` is then the
  // folder `<bucket>/…` under its working directory.
  const offsite = take("offsite");
  services.offsite = {
    ...offsite,
    environment: {
      RCLONE_CONFIG_OFFSITE_TYPE: "local",
      OPSCREW_OFFSITE_RECIPIENT: recipient,
    },
    working_dir: "/remote",
    volumes: [...(offsite.volumes ?? []), "remote:/remote"],
  };
  services.writer = {
    image: IMAGES.python.ref,
    user: "0:0",
    network_mode: "none",
    entrypoint: ["python3", "-c", WRITER],
    volumes: ["sqlite:/data"],
  };
  return {
    name: PROJECT,
    services,
    networks: { internal: {} },
    volumes: {
      db_data: {},
      queue_data: {},
      sqlite: {},
      version: {},
      snapshot_tools: {},
      remote: {},
      snapshots: { name: SNAPSHOTS_VOLUME },
    },
  };
}

/** Runs `docker args`, returning its output; throws with the output when it fails. */
function docker(args: string[], o: { cwd?: string; input?: string; timeoutMs?: number } = {}) {
  const result = spawnSync("docker", args, {
    cwd: o.cwd,
    input: o.input,
    env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    encoding: "utf8",
    timeout: o.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** `script` in a one-off container of `image` (`sh` as root), with `volumes`. */
function inside(image: string, volumes: string[], script: string, input?: string): string {
  return docker(
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--user",
      "0:0",
      ...volumes.flatMap((volume) => ["-v", volume]),
      "--entrypoint",
      "sh",
      image,
      "-c",
      script,
    ],
    { input },
  );
}

/** The images this test pulled, removed at the end. */
const pulled: string[] = [];
let dir: string | undefined;

afterAll(() => {
  if (dir !== undefined) {
    spawnSync("docker", ["compose", "-p", PROJECT, "down", "-v", "--remove-orphans", "-t", "1"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
    });
    rmSync(dir, { recursive: true, force: true });
  }
  for (const ref of pulled) spawnSync("docker", ["image", "rm", ref]);
});

describe.skipIf(reason !== undefined)(
  "Portainer's snapshots on Docker",
  { timeout: 900_000 },
  () => {
    it("takes a complete scheduled slot of PostgreSQL, Valkey and SQLite, and copies it off encrypted", async () => {
      const images = [
        IMAGES.postgres.ref,
        IMAGES.valkey.ref,
        IMAGES.python.ref,
        IMAGES.busybox.ref,
        IMAGES.rclone.ref,
        IMAGES.curl.ref,
      ];
      for (const ref of images) {
        if (spawnSync("docker", ["image", "inspect", ref]).status !== 0) pulled.push(ref);
      }
      const { identity, recipient } = generateAgeIdentity();
      const passwords = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
      dir = mkdtempSync(join(tmpdir(), "opscrew-portainer-snapshots-"));
      writeFileSync(join(dir, "compose.yaml"), stringify(project(recipient)));
      writeFileSync(
        join(dir, ".env"),
        [
          "OPSCREW_DB_USER=app",
          "OPSCREW_DB_NAME=app",
          `OPSCREW_DB_PASSWORD=${passwords[0]}`,
          `OPSCREW_SVC_QUEUE_PASSWORD=${passwords[1]}`,
          "",
        ].join("\n"),
      );
      const compose = (args: string[], timeoutMs?: number) =>
        docker(["compose", "-p", PROJECT, ...args], { cwd: dir, timeoutMs });

      compose(["up", "-d", "--wait", "--wait-timeout", "300", "db", "queue"], 900_000);
      compose([
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -c "CREATE TABLE t (id int PRIMARY KEY); INSERT INTO t SELECT generate_series(1, 100)"',
      ]);
      compose([
        "exec",
        "-T",
        "queue",
        "sh",
        "-c",
        'for i in $(seq 1 50); do echo "SET job:$i payload-$i"; done | REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli > /dev/null',
      ]);
      compose(["up", "-d", "writer"], 600_000);
      compose(["up", "--no-deps", "stamp"], 600_000);
      compose(
        ["up", "-d", "snapshots-db", "snapshots-queue", "snapshots-sqlite", "snapshots", "offsite"],
        900_000,
      );

      // Waits for a finished slot with its off-server copy.
      const volumes = [`${SNAPSHOTS_VOLUME}:/s`];
      const started = Date.now();
      let id = "";
      while (id === "") {
        if (Date.now() - started > 420_000) {
          throw new Error(`No slot was copied off in 7 minutes:\n${compose(["logs"])}`);
        }
        await sleep(5000);
        id = inside(
          IMAGES.busybox.ref,
          volumes,
          "for d in /s/*T*Z; do if [ -f $d/offsite.done ]; then echo ${d##*/}; break; fi; done",
        );
      }
      expect(id).toMatch(/^\d{8}T\d{6}Z$/);
      // No later slot changes or prunes the folder while it is checked.
      compose([
        "stop",
        "-t",
        "1",
        "snapshots-db",
        "snapshots-queue",
        "snapshots-sqlite",
        "snapshots",
      ]);
      compose(["stop", "-t", "1", "offsite"]);

      const about = JSON.parse(inside(IMAGES.busybox.ref, volumes, `cat /s/${id}/about.json`));
      expect(about).toMatchObject({
        id,
        kind: "scheduled",
        version: IMAGE.slice(IMAGE.indexOf("@") + 1),
      });
      expect(about.taken).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(about.services).toEqual([
        { name: "db", kind: "postgres", file: "db.dump", size: expect.any(Number) },
        { name: "queue", kind: "valkey", file: "queue.rdb", size: expect.any(Number) },
        { name: "sqlite", kind: "sqlite", file: "sqlite.db", size: expect.any(Number) },
      ]);
      for (const service of about.services) expect(service.size).toBeGreaterThan(0);

      // Modes and owner, and nothing but the files, about.json and offsite.done.
      const listing = inside(
        IMAGES.busybox.ref,
        volumes,
        `stat -c '%a %u:%g %n' /s/${id} /s/${id}/*`,
      ).split("\n");
      expect(listing).toEqual([
        `700 0:0 /s/${id}`,
        `600 0:0 /s/${id}/about.json`,
        `600 0:0 /s/${id}/db.dump`,
        `600 0:0 /s/${id}/offsite.done`,
        `600 0:0 /s/${id}/queue.rdb`,
        `600 0:0 /s/${id}/sqlite.db`,
      ]);

      // Each file is what it should be.
      const tables = inside(IMAGES.postgres.ref, volumes, `pg_restore -l /s/${id}/db.dump`);
      expect(tables).toContain("TABLE DATA public t");
      expect(inside(IMAGES.busybox.ref, volumes, `head -c 5 /s/${id}/queue.rdb`)).toBe("REDIS");
      const sqlite = inside(
        IMAGES.python.ref,
        volumes,
        `python3 -c 'import sqlite3; c = sqlite3.connect("/s/${id}/sqlite.db"); print(c.execute("pragma journal_mode").fetchone()[0], c.execute("select count(*) from t").fetchone()[0])'`,
      ).split(" ");
      expect(sqlite[0]).toBe("delete");
      expect(Number(sqlite[1])).toBeGreaterThan(0);

      // The off-server copy decrypts with the identity to exactly the snapshot's files.
      const remote = `/remote/${BUCKET}/backups/${id}`;
      const decrypted = inside(
        IMAGES.rclone.ref,
        [...volumes, `${PROJECT}_snapshot_tools:/tools:ro`, `${PROJECT}_remote:/remote:ro`],
        [
          "set -e",
          "umask 077",
          "cat > /tmp/id",
          `ls ${remote}`,
          "for f in about.json db.dump queue.rdb sqlite.db; do",
          `  a=$(/tools/age -d -i /tmp/id ${remote}/$f.age | sha256sum | cut -d ' ' -f 1)`,
          `  b=$(sha256sum /s/${id}/$f | cut -d ' ' -f 1)`,
          '  if [ "$a" = "$b" ]; then echo "$f same"; else echo "$f differs"; fi',
          "done",
        ].join("\n"),
        `${identity}\n`,
      ).split("\n");
      expect(decrypted).toEqual([
        "about.json.age",
        "db.dump.age",
        "queue.rdb.age",
        "sqlite.db.age",
        "about.json same",
        "db.dump same",
        "queue.rdb same",
        "sqlite.db same",
      ]);

      const logs = compose(["logs", "--no-color"]);
      for (const secret of passwords) {
        expect(logs).not.toContain(secret);
        expect(JSON.stringify(about)).not.toContain(secret);
      }
    });
  },
);
