/**
 * The snapshot's dump and exact restore against each of the four pinned databases (research R9,
 * plan.md 12.7). For each kind, as the localhost target renders its service (named volumes, its
 * env file, the internal network):
 * 1. the service starts and gets a table (a collection for MongoDB) `t` of 100 rows;
 * 2. a writer in the service's container keeps inserting rows while the start script's
 *    `snapshot_take` dumps the database with the commands the deploy uses;
 * 3. after the snapshot the rows change, a row goes, and a table (collection) `added` is created;
 * 4. `snapshot_restore` puts the database back: `added` is gone, every row from before the dump is
 *    there as it was, and nothing written after it is; PostgreSQL, MySQL and MariaDB hold every
 *    row up to one moment, with no gap;
 * 5. a second restore after more changes gives exactly the same rows.
 * Neither the scripts' output nor `snapshot.log` holds a password.
 *
 * It pulls the pinned images, so it runs only with OPSCREW_DOCKER_TESTS=1. The kinds run one at a
 * time; each removes its project with its volumes, and the image when this test pulled it.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DeployPlan, snapshotsOn } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { serviceSpec } from "../catalog";
import { withServices } from "../catalog/__fixtures__/plans";
import { onThisComputer } from "../edge/__fixtures__/localhost";
import { IMAGES } from "../pins";
import { renderCompose, renderRuntimeFiles } from "../runtime";
import { runtimeDir } from "../runtime-dir";
import { snapshotFunctions } from "./snapshots";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  if (info.status !== 0 || info.stdout.trim() !== "linux") {
    return "no Docker engine for Linux containers is running";
  }
  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return compose.status === 0 ? undefined : "docker compose is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the snapshots on Docker: ${reason}`);

/** The run's id, in every project's name. */
const RUN = randomBytes(3).toString("hex");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A database kind of the test, with its SQL or MongoDB shell in the service's container. */
interface Kind {
  kind: "postgres" | "mysql" | "mariadb" | "mongodb";
  image: string;
  /** A shell command in the service's container that runs `$Q` (SQL, or JavaScript for MongoDB). */
  client: string;
  /** Creates `t` with the rows 1 to 100. */
  seed: string;
  /** The rows of `t` as `<id> <v>` lines, by id. */
  rows: string;
  /** The tables (collections) of the database, one per line. */
  tables: string;
  /** After the snapshot: changes row 1, removes row 2, adds row 1000000 and the table `added`. */
  change: string;
  /** A shell loop in the container that inserts rows from 101 on until /tmp/stop exists. */
  writer: string;
}

const values = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `(${from + i}, 'row-${from + i}')`).join(", ");

/** The SQL kinds' common statements. */
const SQL = {
  rows: "SELECT id, v FROM t ORDER BY id",
  change: `UPDATE t SET v = 'changed' WHERE id = 1; DELETE FROM t WHERE id = 2; INSERT INTO t VALUES (1000000, 'late'); CREATE TABLE added (id int); INSERT INTO added VALUES (1);`,
};

/** A writer that pipes one INSERT every 10 ms into one client session. */
const sqlWriter = (client: string) =>
  `i=101; while [ ! -f /tmp/stop ]; do echo "INSERT INTO t VALUES ($i, 'row-$i');"; i=$((i + 1)); sleep 0.01; done | ${client}`;

const mysqlLike = (kind: "mysql" | "mariadb", tool: string, root: string): Kind => {
  const session = `MYSQL_PWD="$${root}" ${tool} -h 127.0.0.1 -u root -N -B app`;
  return {
    kind,
    image: kind === "mysql" ? IMAGES.mysql.ref : IMAGES.mariadb.ref,
    client: `${session} -e "$Q"`,
    seed: `CREATE TABLE t (id int PRIMARY KEY, v varchar(50)) ENGINE=InnoDB; INSERT INTO t VALUES ${values(1, 100)};`,
    rows: SQL.rows,
    tables: "SHOW TABLES",
    change: SQL.change,
    writer: sqlWriter(session),
  };
};

/** mongosh in the container, logged in from its environment (no password in an argument). */
const MONGOSH = `HOME=/tmp mongosh --quiet --nodb --eval 'const db = connect("mongodb://127.0.0.1:27017/admin"); db.auth("app", process.env.MONGO_INITDB_ROOT_PASSWORD); const app = db.getSiblingDB("app"); '"$Q"`;

const KINDS: Kind[] = [
  {
    kind: "postgres",
    image: IMAGES.postgres.ref,
    client: `PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -t -A -F " " -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -c "$Q"`,
    seed: `CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t VALUES ${values(1, 100)};`,
    rows: SQL.rows,
    tables: "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    change: SQL.change,
    writer: sqlWriter(
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1',
    ),
  },
  mysqlLike("mysql", "mysql", "MYSQL_ROOT_PASSWORD"),
  mysqlLike("mariadb", "mariadb", "MARIADB_ROOT_PASSWORD"),
  {
    kind: "mongodb",
    image: IMAGES.mongodb.ref,
    client: MONGOSH,
    seed: `app.t.insertMany(Array.from({ length: 100 }, (_, k) => ({ _id: k + 1, v: "row-" + (k + 1) })))`,
    rows: `app.t.find().sort({ _id: 1 }).forEach((d) => print(d._id + " " + d.v))`,
    tables: `app.getCollectionNames().sort().forEach((c) => print(c))`,
    change: `app.t.updateOne({ _id: 1 }, { $set: { v: "changed" } }); app.t.deleteOne({ _id: 2 }); app.t.insertOne({ _id: 1000000, v: "late" }); app.added.insertOne({ x: 1 })`,
    writer: `HOME=/tmp mongosh --quiet --nodb --eval 'const db = connect("mongodb://127.0.0.1:27017/admin"); db.auth("app", process.env.MONGO_INITDB_ROOT_PASSWORD); const fs = require("fs"); for (let i = 101; !fs.existsSync("/tmp/stop"); i++) { db.getSiblingDB("app").t.insertOne({ _id: i, v: "row-" + i }); sleep(10); }'`,
  },
];

/** The kind's plan: `shop` in staging on this computer, with the kind's service `db` only. */
function kindPlan(kind: Kind["kind"]): DeployPlan {
  return onThisComputer(withServices([{ kind, name: "db" }]), { environment: "staging" });
}

/** One kind's Compose project in its app folder `dir`. */
class Project {
  readonly name: string;
  constructor(
    readonly dir: string,
    kind: string,
  ) {
    this.name = `opscrew-snapshots-${RUN}-${kind}`;
  }

  /** The environment of every docker call and script: the project, and no path conversion. */
  get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      COMPOSE_PROJECT_NAME: this.name,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
    };
  }

  compose(args: string[], timeoutMs = 300_000): string {
    const result = spawnSync("docker", ["compose", ...args], {
      cwd: this.dir,
      env: this.env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(
        `docker compose ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout}${result.stderr}`,
      );
    }
    return result.stdout.trim();
  }

  /** `query` through the kind's client in the service's container. */
  query(kind: Kind, query: string): string {
    return this.compose(["exec", "-T", "-e", `Q=${query}`, "db", "sh", "-c", kind.client]);
  }

  /** The output lines of `query`, each one's fields separated by one space. */
  lines(kind: Kind, query: string): string[] {
    return this.query(kind, query)
      .split("\n")
      .map((line) => line.trim().split(/\s+/).join(" "))
      .filter(Boolean);
  }
}

/** The app folder of `plan` under `apps`: its runtime files, the database's alone in compose.yaml. */
function writeApp(apps: string, plan: DeployPlan, secrets: Record<string, string>): string {
  const dir = join(apps, plan.app.name);
  const runtime = runtimeDir(plan);
  for (const file of renderRuntimeFiles(plan)) {
    const path = join(dir, file.path.slice(runtime.length + 1));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  const rendered = parse(renderCompose(plan).content);
  const service = { ...rendered.services.db };
  delete service.depends_on;
  const used = new Set((service.volumes as string[]).map((mount) => mount.split(":")[0] ?? ""));
  const volumes = Object.fromEntries(
    Object.entries(rendered.volumes ?? {}).filter(([key]) => used.has(key)),
  );
  writeFileSync(
    join(dir, "compose.yaml"),
    stringify({
      services: { db: service },
      networks: { internal: {} },
      ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
      ...(rendered.configs === undefined ? {} : { configs: rendered.configs }),
    }),
  );
  const [db] = plan.services;
  if (db === undefined) throw new Error("The plan has no database.");
  const env = serviceSpec(db.kind).environment({
    plan,
    service: db,
    secretRef: (name) => {
      const value = secrets[name];
      if (value === undefined) throw new Error(`No secret ${name}.`);
      return value;
    },
  });
  writeFileSync(
    join(dir, "db.env"),
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  return dir;
}

/** `snapshot_take` or `snapshot_restore` of `hex`, as the start script runs them, in `project`. */
function snapshotScript(
  plan: DeployPlan,
  apps: string,
  project: Project,
  call: "snapshot_take" | "snapshot_restore",
  hex: string,
) {
  const script = [
    "set -eu",
    `cd "$APPS_DIR"/${plan.app.name}`,
    ...snapshotFunctions(plan, `"$APPS_DIR"/${plan.app.name}`),
    `${call} "$1"`,
  ];
  const result = spawnSync("sh", ["-s", "--", hex], {
    input: `${script.join("\n")}\n`,
    env: { ...project.env, APPS_DIR: apps.replaceAll("\\", "/") },
    encoding: "utf8",
    timeout: 600_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Whether the local Docker has `ref`. */
function hasImage(ref: string): boolean {
  return spawnSync("docker", ["image", "inspect", ref]).status === 0;
}

/** The images this test pulled, removed at the end. */
const pulled: string[] = [];

afterAll(() => {
  for (const ref of pulled) spawnSync("docker", ["image", "rm", ref]);
});

describe.skipIf(reason !== undefined)("the snapshots on Docker", { timeout: 900_000 }, () => {
  for (const kind of KINDS) {
    it(`dumps ${kind.kind} while rows are written, then restores it exactly`, async () => {
      const plan = kindPlan(kind.kind);
      expect(snapshotsOn(plan)).toBe(true);
      if (!hasImage(kind.image)) pulled.push(kind.image);
      const secrets = Object.fromEntries(
        serviceSpec(kind.kind).secrets.map((secret) => [
          secret.name,
          randomBytes(16).toString("hex"),
        ]),
      );
      const root = mkdtempSync(join(tmpdir(), "opscrew-snapshots-docker-"));
      const apps = join(root, "apps");
      const project = new Project(writeApp(apps, plan, secrets), kind.kind);
      let writer: ChildProcess | undefined;
      try {
        project.compose(["up", "-d", "--wait", "--wait-timeout", "300", "db"], 900_000);
        project.query(kind, kind.seed);
        const count = () => project.lines(kind, kind.rows).length;
        expect(count()).toBe(100);

        // Rows keep coming while the snapshot is taken.
        writer = spawn("docker", ["compose", "exec", "-T", "db", "sh", "-c", kind.writer], {
          cwd: project.dir,
          env: project.env,
          stdio: "ignore",
        });
        const started = Date.now();
        while (count() < 150) {
          if (Date.now() - started > 120_000) throw new Error("The writer wrote nothing.");
          await sleep(500);
        }
        const before = count();
        const hex = "c".repeat(64);
        const taken = snapshotScript(plan, apps, project, "snapshot_take", hex);
        expect(taken.status, taken.output).toBe(0);
        const after = count();
        expect(after, "rows were written while the dump ran").toBeGreaterThan(before);
        project.compose(["exec", "-T", "db", "touch", "/tmp/stop"]);
        const done = writer;
        await new Promise((resolve) =>
          done.exitCode === null ? done.on("exit", resolve) : resolve(undefined),
        );
        writer = undefined;

        const folder = join(project.dir, ".snapshots", hex);
        expect(readFileSync(join(folder, "taken"), "utf8")).toMatch(
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/,
        );
        expect(statSync(join(folder, "db.dump")).size).toBeGreaterThan(0);
        if (process.platform !== "win32") {
          expect((statSync(join(folder, "db.dump")).mode & 0o777).toString(8)).toBe("600");
        }

        // After the snapshot: a changed row, a removed one, a late one and a new table.
        project.query(kind, kind.change);
        expect(project.query(kind, kind.tables)).toContain("added");

        const restored = snapshotScript(plan, apps, project, "snapshot_restore", hex);
        expect(restored.status, restored.output).toBe(0);
        expect(project.lines(kind, kind.tables)).toEqual(["t"]);
        const rows = project.lines(kind, kind.rows);
        const ids = rows.map((row) => Number(row.split(" ")[0]));
        for (const row of rows) expect(row).toMatch(/^(\d+) row-\1$/);
        // Every row from before the dump started, none written after it ended.
        for (let id = 1; id <= before; id++) expect(ids).toContain(id);
        expect(Math.max(...ids)).toBeLessThanOrEqual(after);
        if (kind.kind !== "mongodb") {
          // One moment: every row up to the last one, with no gap.
          expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
        }

        // A second restore after more changes gives exactly the same rows.
        project.query(kind, kind.change);
        const again = snapshotScript(plan, apps, project, "snapshot_restore", hex);
        expect(again.status, again.output).toBe(0);
        expect(project.lines(kind, kind.rows)).toEqual(rows);

        const log = readFileSync(join(project.dir, ".snapshots", "snapshot.log"), "utf8");
        for (const secret of Object.values(secrets)) {
          for (const text of [taken.output, restored.output, again.output, log]) {
            expect(text).not.toContain(secret);
          }
        }
      } finally {
        if (writer !== undefined && writer.exitCode === null) writer.kill();
        spawnSync(
          "docker",
          ["compose", "down", "--volumes", "--remove-orphans", "--timeout", "5"],
          {
            cwd: project.dir,
            env: project.env,
          },
        );
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
