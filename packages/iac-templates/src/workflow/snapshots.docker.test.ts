/**
 * `snapshot.sh take` and `snapshot.sh restore` against every kind of data with the pinned images
 * (024 plan.md 2., research R7), as the localhost target renders each service (named volumes, its
 * env file, the internal network), beside a stand-in of the app:
 * - the four databases (019's test): a writer keeps inserting rows while the snapshot is taken; the
 *   rows then change, a row goes, a table (collection) is added; the restore puts back every row
 *   from before the copy as it was and nothing written after it (PostgreSQL, MySQL and MariaDB up
 *   to one moment, with no gap), the app's own login writes again, and a second restore after more
 *   changes gives exactly the same rows;
 * - SQLite: the app's user writes rows in WAL mode while the copy is taken; the restore puts back a
 *   gapless prefix in `journal_mode=delete` with no `-wal`, and no file in the volume is root's;
 * - Valkey, Redis and Dragonfly, as a cache and as a queue: a writer pushes onto a list while the
 *   copy is taken; the restore gives a gapless prefix without the keys written after it; a queue
 *   keeps it across a restart, a cache leaves no file behind;
 * - every other kind (stop-only): a record and a second login (023's seeds), the service stopped
 *   alone for its copy and healthy again, a stray file added to its volume; the restore removes the
 *   stray file and the data reads back with both logins.
 * Each restore needs its one-time approval and copies the data first. Neither the scripts' output
 * nor `snapshot.log` holds a secret.
 *
 * It pulls the pinned images, so it runs only with OPSCREW_DOCKER_TESTS=1. The kinds run one at a
 * time; each removes its project with its volumes, and the images this test pulled.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeployPlan,
  DeployPlanSchema,
  type SelfHostedServiceKind,
} from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { dataDirs, initStepsFor, serviceSpec } from "../catalog";
import { withServices } from "../catalog/__fixtures__/plans";
import { onThisComputer } from "../edge/__fixtures__/localhost";
import { IMAGES } from "../pins";
import { renderCompose } from "../runtime";
import { skipReason } from "./__fixtures__/sh";
import { restoreApprovalLine, snapshotScript } from "./snapshot-script";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the snapshots on Docker: ${reason}`);

/** The run's id, in every project's name. */
const RUN = randomBytes(3).toString("hex");

/** The digest `.env` names as the running version. */
const VERSION = "c".repeat(64);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `fn`'s value once it stops throwing, retried every 2 seconds for up to `ms`. */
async function eventually<T>(fn: () => T, ms = 180_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(2_000);
    }
  }
}

/** One docker command's output; a failure throws with its output. */
function docker(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync("docker", args, {
    cwd: o.cwd,
    env: o.env ?? { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** A value as one line of an env file, as `opscrew provision` writes it. */
function dotenvLine(name: string, value: string): string {
  if (/^[A-Za-z0-9_.,:/@+=-]*$/.test(value)) return `${name}=${value}`;
  if (!value.includes("'") && !value.includes("\n")) return `${name}='${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\$/g, "$$$$");
  return `${name}="${escaped}"`;
}

/** The app stand-in: idle, stopping at once on SIGTERM. */
const IDLE = ["sh", "-c", 'trap "exit 0" TERM; while :; do sleep 1; done'];

/** One case's Compose project: the app's folder with `compose.yaml`, the env file and the script. */
class Project {
  readonly name: string;
  readonly apps: string;
  readonly dir: string;
  constructor(
    root: string,
    kind: string,
    readonly plan: DeployPlan,
    readonly service: string,
  ) {
    this.name = `opscrew-snap-${RUN}-${kind}`;
    this.apps = `${root.replaceAll("\\", "/")}/apps`;
    this.dir = `${this.apps}/${plan.app.name}`;
  }

  /** The environment of every docker call and script. */
  get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      COMPOSE_PROJECT_NAME: this.name,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
      OPSCREW_APPS_DIR: this.apps,
      OPSCREW_EDGE_DIR: `${this.apps}/../edge`,
    };
  }

  compose(args: string[]): string {
    return docker(["compose", ...args], { cwd: this.dir, env: this.env });
  }

  /** `script` in the running `service`'s container with `sh -c`, `env` added. */
  sh(script: string, env: Record<string, string> = {}, service = this.service): string {
    const vars = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
    return this.compose(["exec", "-T", ...vars, service, "sh", "-c", script]);
  }

  /** `script` in a busybox one-off with the service's volumes. */
  box(script: string): string {
    const id = this.compose(["ps", "-aq", this.service]);
    return docker(["run", "--rm", "--volumes-from", id, IMAGES.busybox.ref, "sh", "-c", script]);
  }

  /** The pinned curl on the project's network, with `args`. */
  curl(args: string[]): string {
    return docker([
      "run",
      "--rm",
      "--network",
      `${this.name}_internal`,
      IMAGES.curl.ref,
      "-fsS",
      ...args,
    ]);
  }

  /** `sh snapshot.sh <args>` in the app's folder, as the CLI runs it. */
  snap(args: string[]) {
    const result = spawnSync("sh", [`${this.dir}/snapshot.sh`, ...args], {
      cwd: this.dir,
      env: this.env,
      encoding: "utf8",
      timeout: 1_800_000,
    });
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      output: `${result.stdout}${result.stderr}`,
    };
  }

  /** A snapshot by hand (stopping `stop`), its id. */
  take(stop: string[] = []): { id: string; output: string } {
    const taken = this.snap(["take", "manual", ...stop.flatMap((s) => ["--stop", s])]);
    expect(taken.status, taken.output).toBe(0);
    return { id: taken.stdout, output: taken.output };
  }

  /** The approved restore of `id`, its output. */
  restore(id: string): string {
    const line = restoreApprovalLine(id, undefined, Math.floor(Date.now() / 1000) + 600);
    writeFileSync(join(this.dir, ".restore-snapshot"), `${line}\n`);
    const restored = this.snap(["restore", id]);
    expect(restored.status, restored.output).toBe(0);
    return restored.output;
  }

  /** `.snapshots/snapshot.log`. */
  log(): string {
    const file = join(this.dir, ".snapshots", "snapshot.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
}

/**
 * Writes the project's folder: the rendered service alone (its volumes, settings and the internal
 * network) with `app`, its env file from `secrets`, `.env` naming {@link VERSION} and the plan's
 * snapshot script.
 */
function writeProject(project: Project, secrets: Record<string, string>, app: object): void {
  const { plan } = project;
  mkdirSync(project.dir, { recursive: true });
  // An app on SQLite alone has nothing rendered here: its stand-in mounts the volume itself.
  const rendered =
    plan.services.length === 0 ? { services: {} } : parse(renderCompose(plan).content);
  const services: Record<string, object> = { app: { ...app, networks: ["internal"] } };
  const used = new Set<string>(["sqlite"]);
  for (const service of plan.services) {
    const own = { ...rendered.services[service.name] };
    delete own.depends_on;
    services[service.name] = own;
    for (const mount of own.volumes as string[]) used.add(mount.split(":")[0] ?? "");
    const env = serviceSpec(service.kind).environment({
      plan,
      service,
      secretRef: (name) => {
        const value = secrets[name];
        if (value === undefined) throw new Error(`No secret ${name}.`);
        return value;
      },
    });
    writeFileSync(
      join(project.dir, `${service.name}.env`),
      `${Object.entries(env)
        .map(([name, value]) => dotenvLine(name, value))
        .join("\n")}\n`,
    );
  }
  const volumes = Object.fromEntries(
    Object.entries(rendered.volumes ?? { sqlite: {} }).filter(([key]) => used.has(key)),
  );
  writeFileSync(
    join(project.dir, "compose.yaml"),
    stringify({
      services,
      networks: { internal: {} },
      ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
      ...(rendered.configs === undefined ? {} : { configs: rendered.configs }),
    }),
  );
  writeFileSync(join(project.dir, ".env"), `APP_IMAGE=ghcr.io/acme/shop@sha256:${VERSION}\n`);
  writeFileSync(join(project.dir, "snapshot.sh"), `${snapshotScript(plan).join("\n")}\n`);
}

/** A new random value for each of `kind`'s secrets, in its format. */
function secretsOf(kind: SelfHostedServiceKind): Record<string, string> {
  return Object.fromEntries(
    serviceSpec(kind).secrets.map((secret) => [
      secret.name,
      secret.format === "garage-key-id"
        ? `GK${randomBytes(12).toString("hex")}`
        : randomBytes(32).toString("hex"),
    ]),
  );
}

/** The plan of a case: `shop` in staging on this computer with `services`, and `fields`. */
function casePlan(services: Record<string, unknown>[], fields: Record<string, unknown> = {}) {
  return onThisComputer(withServices(services as Parameters<typeof withServices>[0], fields), {
    environment: "staging",
  });
}

/** Whether the local Docker has `ref`. */
function hasImage(ref: string): boolean {
  return spawnSync("docker", ["image", "inspect", ref]).status === 0;
}

/** The images present before the run, by reference. */
const before = new Map<string, boolean>();

function remember(ref: string): void {
  if (!before.has(ref)) before.set(ref, hasImage(ref));
}

/** Removes `ref` when the run pulled it. */
function removeIfPulled(ref: string): void {
  if (before.get(ref) === false && hasImage(ref)) spawnSync("docker", ["image", "rm", ref]);
}

const root = mkdtempSync(join(tmpdir(), "opscrew-snapshots-docker-"));
const SHARED = [IMAGES.busybox.ref, IMAGES.python.ref, IMAGES.curl.ref];

afterAll(() => {
  for (const ref of SHARED) removeIfPulled(ref);
  rmSync(root, { recursive: true, force: true });
});

/**
 * Runs `body` with the case's project up (`app` beside the service), then removes the project with
 * its volumes, and the service's image when this run pulled it.
 */
async function withProject(
  kind: string,
  plan: DeployPlan,
  service: string,
  secrets: Record<string, string>,
  app: object,
  body: (project: Project) => Promise<void>,
): Promise<void> {
  for (const ref of SHARED) remember(ref);
  const spec = plan.services[0];
  const image = spec === undefined ? undefined : IMAGES[serviceSpec(spec.kind).image].ref;
  if (image !== undefined) remember(image);
  const project = new Project(root, kind, plan, service);
  writeProject(project, secrets, app);
  try {
    project.compose(["up", "-d", "--wait", "--wait-timeout", "900"]);
    for (const step of initStepsFor(plan)) {
      const check = spawnSync("docker", ["compose", "exec", "-T", step.service, ...step.check], {
        cwd: project.dir,
        env: project.env,
      });
      if (check.status !== 0) project.compose(["exec", "-T", step.service, ...step.run]);
    }
    await body(project);
    for (const secret of Object.values(secrets)) expect(project.log()).not.toContain(secret);
  } finally {
    spawnSync("docker", ["compose", "down", "--volumes", "--remove-orphans", "--timeout", "5"], {
      cwd: project.dir,
      env: project.env,
    });
    if (image !== undefined) removeIfPulled(image);
  }
}

/** A writer started in the background, until /tmp/stop exists in its container. */
function background(
  project: Project,
  service: string,
  script: string,
  env: Record<string, string> = {},
): ChildProcess {
  const vars = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  return spawn("docker", ["compose", "exec", "-T", ...vars, service, "sh", "-c", script], {
    cwd: project.dir,
    env: project.env,
    stdio: "ignore",
  });
}

/** Stops `writer` (touching /tmp/stop in `service`) and waits for it to end. */
async function stopWriter(project: Project, service: string, writer: ChildProcess): Promise<void> {
  project.sh("touch /tmp/stop", {}, service);
  await new Promise((resolve) =>
    writer.exitCode === null ? writer.on("exit", resolve) : resolve(undefined),
  );
}

// ---- The four databases (019's cases) ----

interface Database {
  kind: "postgres" | "mysql" | "mariadb" | "mongodb";
  client: string;
  seed: string;
  rows: string;
  tables: string;
  change: string;
  writer: string;
  asApp: { client: string; write: string; read: string; remove: string };
}

const SQL_AS_APP = {
  write: "INSERT INTO t VALUES (2000000, 'row-2000000')",
  read: "SELECT v FROM t WHERE id = 2000000",
  remove: "DELETE FROM t WHERE id = 2000000",
};
const values = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `(${from + i}, 'row-${from + i}')`).join(", ");
const SQL = {
  rows: "SELECT id, v FROM t ORDER BY id",
  change: `UPDATE t SET v = 'changed' WHERE id = 1; DELETE FROM t WHERE id = 2; INSERT INTO t VALUES (1000000, 'late'); CREATE TABLE added (id int); INSERT INTO added VALUES (1);`,
};
const sqlWriter = (client: string) =>
  `i=101; while [ ! -f /tmp/stop ]; do echo "INSERT INTO t VALUES ($i, 'row-$i');"; i=$((i + 1)); sleep 0.01; done | ${client}`;
const mysqlLike = (
  kind: "mysql" | "mariadb",
  tool: string,
  prefix: "MYSQL" | "MARIADB",
): Database => {
  const session = `MYSQL_PWD="$${prefix}_ROOT_PASSWORD" ${tool} -h 127.0.0.1 -u root -N -B app`;
  return {
    kind,
    client: `${session} -e "$Q"`,
    seed: `CREATE TABLE t (id int PRIMARY KEY, v varchar(50)) ENGINE=InnoDB; INSERT INTO t VALUES ${values(1, 100)};`,
    rows: SQL.rows,
    tables: "SHOW TABLES",
    change: SQL.change,
    writer: sqlWriter(session),
    asApp: {
      client: `MYSQL_PWD="$${prefix}_PASSWORD" ${tool} -h 127.0.0.1 -u app -N -B app -e "$Q"`,
      ...SQL_AS_APP,
    },
  };
};
const MONGOSH = `HOME=/tmp mongosh --quiet --nodb --eval 'const db = connect("mongodb://127.0.0.1:27017/admin"); db.auth("app", process.env.MONGO_INITDB_ROOT_PASSWORD); const app = db.getSiblingDB("app"); '"$Q"`;
const DATABASES: Database[] = [
  {
    kind: "postgres",
    client: `PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -t -A -F " " -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -c "$Q"`,
    seed: `CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t VALUES ${values(1, 100)};`,
    rows: SQL.rows,
    tables: "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    change: SQL.change,
    writer: sqlWriter(
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1',
    ),
    asApp: {
      client: `PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -t -A -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -c "$Q"`,
      ...SQL_AS_APP,
    },
  },
  mysqlLike("mysql", "mysql", "MYSQL"),
  mysqlLike("mariadb", "mariadb", "MARIADB"),
  {
    kind: "mongodb",
    client: MONGOSH,
    seed: `app.t.insertMany(Array.from({ length: 100 }, (_, k) => ({ _id: k + 1, v: "row-" + (k + 1) })))`,
    rows: `app.t.find().sort({ _id: 1 }).forEach((d) => print(d._id + " " + d.v))`,
    tables: `app.getCollectionNames().sort().forEach((c) => print(c))`,
    change: `app.t.updateOne({ _id: 1 }, { $set: { v: "changed" } }); app.t.deleteOne({ _id: 2 }); app.t.insertOne({ _id: 1000000, v: "late" }); app.added.insertOne({ x: 1 })`,
    writer: `HOME=/tmp mongosh --quiet --nodb --eval 'const db = connect("mongodb://127.0.0.1:27017/admin"); db.auth("app", process.env.MONGO_INITDB_ROOT_PASSWORD); const fs = require("fs"); for (let i = 101; !fs.existsSync("/tmp/stop"); i++) { db.getSiblingDB("app").t.insertOne({ _id: i, v: "row-" + i }); sleep(10); }'`,
    asApp: {
      client: MONGOSH,
      write: `app.t.insertOne({ _id: 2000000, v: "row-2000000" })`,
      read: `print(app.t.findOne({ _id: 2000000 }).v)`,
      remove: `app.t.deleteOne({ _id: 2000000 })`,
    },
  },
];

// ---- Valkey, Redis and Dragonfly ----

/** The client of a Redis-protocol kind and the variable of its password. */
const REDIS = {
  valkey: { cli: "valkey-cli", password: "VALKEY_PASSWORD" },
  redis: { cli: "redis-cli", password: "REDIS_PASSWORD" },
  dragonfly: { cli: "redis-cli", password: "DFLY_requirepass" },
} as const;

// ---- The stop-only kinds (023's seeds and checks) ----

/** What a stop-only kind's seed and check get. */
interface Ctx {
  project: Project;
  secrets: Record<string, string>;
  password: string;
  mark: string;
  state: Record<string, string>;
}

interface StopOnly {
  kind: SelfHostedServiceKind;
  options?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  seed: (c: Ctx) => void | Promise<void>;
  check: (c: Ctx) => void | Promise<void>;
}

const json = (value: unknown) => JSON.stringify(value);
const BUCKET = "shop-uploads";

async function rabbitmqManagement(project: Project, password: string): Promise<void> {
  await eventually(() => {
    project.compose([
      "exec",
      "-T",
      "rabbitmq",
      "rabbitmq-plugins",
      "enable",
      "rabbitmq_management",
    ]);
    project.curl(["-u", `app:${password}`, "http://rabbitmq:15672/api/overview"]);
  });
}

function natsTalk(project: Project, messages: [string, string][]): string {
  const lines = messages
    .map(
      ([subject, payload]) =>
        `printf 'PUB %s r %d\\r\\n%s\\r\\n' '${subject}' ${Buffer.byteLength(payload)} '${payload}'; sleep 1;`,
    )
    .join(" ");
  return project.sh(
    `{ printf 'CONNECT {"auth_token":"%s","verbose":false}\\r\\nSUB r 1\\r\\n' "$NATS_TOKEN"; ${lines} sleep 1; } | nc 127.0.0.1 4222`,
  );
}

function garageS3(project: Project, id: string, secret: string, args: string[]): string {
  return project.curl([
    "--aws-sigv4",
    "aws:amz:garage:s3",
    "--user",
    `${id}:${secret}`,
    "-H",
    "x-amz-content-sha256: UNSIGNED-PAYLOAD",
    ...args,
    `http://garage:3900/${BUCKET}/mark.txt`,
  ]);
}

function meiliDocument(project: Project, key: string): string {
  return project.sh(
    `wget -q -O- --header "Authorization: Bearer ${key}" http://127.0.0.1:7700/indexes/t/documents/1`,
  );
}

const STOP_ONLY: StopOnly[] = [
  {
    kind: "rabbitmq",
    seed: async (c) => {
      await rabbitmqManagement(c.project, c.secrets.password ?? "");
      const api = (method: string, path: string, body: unknown) =>
        c.project.curl([
          "-u",
          `app:${c.secrets.password}`,
          "-X",
          method,
          "-H",
          "content-type: application/json",
          "-d",
          json(body),
          `http://rabbitmq:15672/api/${path}`,
        ]);
      api("PUT", "queues/%2F/q", { durable: true });
      expect(
        api("POST", "exchanges/%2F/amq.default/publish", {
          routing_key: "q",
          payload: c.mark,
          payload_encoding: "string",
          properties: { delivery_mode: 2 },
        }),
      ).toContain('"routed":true');
      api("PUT", "users/reader", { password: c.password, tags: "management" });
      api("PUT", "permissions/%2F/reader", { configure: "", write: "", read: ".*" });
    },
    check: async (c) => {
      await rabbitmqManagement(c.project, c.secrets.password ?? "");
      const read = (user: string, password: string) =>
        c.project.curl([
          "-u",
          `${user}:${password}`,
          "-X",
          "POST",
          "-H",
          "content-type: application/json",
          "-d",
          json({ count: 1, ackmode: "ack_requeue_true", encoding: "auto" }),
          "http://rabbitmq:15672/api/queues/%2F/q/get",
        ]);
      expect(read("reader", c.password)).toContain(`"payload":"${c.mark}"`);
      expect(read("app", c.secrets.password ?? "")).toContain(`"payload":"${c.mark}"`);
    },
  },
  {
    kind: "nats",
    seed: (c) => {
      const stream = json({ name: "S", subjects: ["s.>"], storage: "file" });
      expect(
        natsTalk(c.project, [
          ["$JS.API.STREAM.CREATE.S", stream],
          ["s.one", c.mark],
        ]),
      ).toContain('"seq":1');
    },
    check: (c) => {
      const out = natsTalk(c.project, [["$JS.API.STREAM.MSG.GET.S", json({ seq: 1 })]]);
      expect(out).toContain(`"data":"${Buffer.from(c.mark).toString("base64")}"`);
    },
  },
  {
    kind: "kafka",
    options: { login: true },
    seed: (c) => {
      c.project.sh(
        [
          "export KAFKA_HEAP_OPTS=-Xmx128m",
          "B=/opt/kafka/bin",
          "$B/kafka-topics.sh --bootstrap-server localhost:9094 --create --topic t --partitions 1 --replication-factor 1",
          'echo "$M" | $B/kafka-console-producer.sh --bootstrap-server localhost:9094 --topic t',
          `$B/kafka-configs.sh --bootstrap-server localhost:9094 --alter --add-config "SCRAM-SHA-512=[password=$P]" --entity-type users --entity-name reader`,
        ].join(" && "),
        { M: c.mark, P: c.password },
      );
    },
    check: (c) => {
      const read = (user: string, password: string) =>
        c.project.sh(
          [
            "export KAFKA_HEAP_OPTS=-Xmx128m",
            `printf 'security.protocol=SASL_PLAINTEXT\\nsasl.mechanism=SCRAM-SHA-512\\nsasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="%s" password="%s";\\n' "$U" "$P" > /tmp/client-$U.properties`,
            "/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --command-config /tmp/client-$U.properties --topic t --from-beginning --max-messages 1 --timeout-ms 60000 2>/dev/null",
          ].join(" && "),
          { U: user, P: password },
        );
      expect(read("reader", c.password)).toBe(c.mark);
      expect(read("app", c.secrets.password ?? "")).toBe(c.mark);
    },
  },
  {
    kind: "redpanda",
    options: { login: true },
    seed: (c) => {
      c.project.sh(
        [
          "rpk topic create t",
          'echo "$M" | rpk topic produce t',
          'rpk security user create reader -p "$P" --mechanism SCRAM-SHA-512',
          "rpk security acl create --allow-principal User:reader --operation read,describe --topic t --group '*'",
        ].join(" && "),
        { M: c.mark, P: c.password },
      );
    },
    check: (c) => {
      const read = (user: string, password: string) =>
        c.project.sh("rpk topic consume t -n 1 -o start -f '%v\\n'", {
          RPK_USER: user,
          RPK_PASS: password,
        });
      expect(read("reader", c.password)).toBe(c.mark);
      expect(read("app", c.secrets.password ?? "")).toBe(c.mark);
    },
  },
  {
    kind: "garage",
    fields: {
      storage: {
        objectStorage: {
          provider: "garage",
          bucket: BUCKET,
          region: "garage",
          expected: { storageGb: 1, egressGbPerMonth: 1 },
          price: {
            monthly: 0,
            currency: "EUR",
            source: "the server's own disk",
            checkedOn: "2026-11-05",
          },
        },
      },
    },
    seed: (c) => {
      garageS3(c.project, c.secrets["key-id"] ?? "", c.secrets["secret-key"] ?? "", [
        "-X",
        "PUT",
        "--data-binary",
        c.mark,
      ]);
      const created = c.project.compose([
        "exec",
        "-T",
        "garage",
        "/garage",
        "key",
        "create",
        "reader",
      ]);
      c.state.keyId = /Key ID:\s*(\S+)/.exec(created)?.[1] ?? "";
      c.state.secret = /Secret key:\s*(\S+)/.exec(created)?.[1] ?? "";
      expect(c.state.keyId).toMatch(/^GK/);
      c.project.compose([
        "exec",
        "-T",
        "garage",
        "/garage",
        "bucket",
        "allow",
        "--read",
        "--key",
        "reader",
        BUCKET,
      ]);
    },
    check: (c) => {
      expect(garageS3(c.project, c.state.keyId ?? "", c.state.secret ?? "", [])).toBe(c.mark);
      expect(
        garageS3(c.project, c.secrets["key-id"] ?? "", c.secrets["secret-key"] ?? "", []),
      ).toBe(c.mark);
    },
  },
  {
    kind: "opensearch",
    seed: (c) => {
      c.project.sh(
        `curl -sS --fail-with-body -u "admin:$OPENSEARCH_PASSWORD" -H "content-type: application/json" -X PUT 'localhost:9200/t/_doc/1?refresh=true' -d "{\\"v\\":\\"$M\\"}"`,
        { M: c.mark },
      );
    },
    check: (c) => {
      expect(
        c.project.sh('curl -fsS -u "admin:$P" localhost:9200/t/_doc/1', {
          P: c.secrets.password ?? "",
        }),
      ).toContain(`"v":"${c.mark}"`);
    },
  },
  {
    kind: "elasticsearch",
    seed: (c) => {
      const elastic =
        'curl -fsS -u "elastic:$ELASTIC_PASSWORD" -H "content-type: application/json"';
      c.project.sh(
        [
          `${elastic} -X PUT 'localhost:9200/t/_doc/1?refresh=true' -d "{\\"v\\":\\"$M\\"}"`,
          `${elastic} -X POST localhost:9200/_security/user/reader -d "{\\"password\\":\\"$P\\",\\"roles\\":[\\"viewer\\"]}"`,
        ].join(" && "),
        { M: c.mark, P: c.password },
      );
    },
    check: (c) => {
      const read = (user: string, password: string) =>
        c.project.sh('curl -fsS -u "$U:$P" localhost:9200/t/_doc/1', { U: user, P: password });
      expect(read("reader", c.password)).toContain(`"v":"${c.mark}"`);
      expect(read("elastic", c.secrets.password ?? "")).toContain(`"v":"${c.mark}"`);
    },
  },
  {
    kind: "meilisearch",
    seed: async (c) => {
      const post = (path: string, body: unknown) =>
        c.project.sh(
          `wget -q -O- --header "Authorization: Bearer $MEILI_MASTER_KEY" --header 'Content-Type: application/json' --post-data "$B" http://127.0.0.1:7700/${path}`,
          { B: json(body) },
        );
      post("indexes/t/documents", [{ id: 1, v: c.mark }]);
      await eventually(() =>
        expect(meiliDocument(c.project, "$MEILI_MASTER_KEY")).toContain(c.mark),
      );
      c.state.key = JSON.parse(
        post("keys", { actions: ["documents.get"], indexes: ["t"], expiresAt: null }),
      ).key;
    },
    check: (c) => {
      expect(meiliDocument(c.project, c.state.key ?? "")).toContain(`"v":"${c.mark}"`);
      expect(meiliDocument(c.project, "$MEILI_MASTER_KEY")).toContain(`"v":"${c.mark}"`);
    },
  },
  {
    kind: "typesense",
    seed: (c) => {
      const post = (path: string, body: unknown) =>
        c.project.curl([
          "-H",
          `X-TYPESENSE-API-KEY: ${c.secrets["api-key"]}`,
          "-H",
          "content-type: application/json",
          "-d",
          json(body),
          `http://typesense:8108/${path}`,
        ]);
      post("collections", { name: "t", fields: [{ name: "v", type: "string" }] });
      post("collections/t/documents", { id: "1", v: c.mark });
      c.state.key = JSON.parse(
        post("keys", { description: "reader", actions: ["documents:get"], collections: ["t"] }),
      ).value;
    },
    check: (c) => {
      const read = (key: string) =>
        c.project.curl([
          "-H",
          `X-TYPESENSE-API-KEY: ${key}`,
          "http://typesense:8108/collections/t/documents/1",
        ]);
      expect(read(c.state.key ?? "")).toContain(`"v":"${c.mark}"`);
      expect(read(c.secrets["api-key"] ?? "")).toContain(`"v":"${c.mark}"`);
    },
  },
  {
    kind: "clickhouse",
    seed: (c) => {
      c.project.sh(
        `clickhouse-client --user app --password "$CLICKHOUSE_PASSWORD" -d app --multiquery -q "CREATE TABLE t (v String) ENGINE = MergeTree ORDER BY v; INSERT INTO t VALUES ('$M')"`,
        { M: c.mark },
      );
    },
    check: (c) => {
      expect(
        c.project.sh('clickhouse-client --user app --password "$P" -d app -q "SELECT v FROM t"', {
          P: c.secrets.password ?? "",
        }),
      ).toBe(c.mark);
    },
  },
  {
    kind: "neo4j",
    seed: (c) => {
      c.project.sh(
        [
          `cypher-shell -u neo4j -p "\${NEO4J_AUTH#neo4j/}" "CREATE (:T {v: '$M'})"`,
          `cypher-shell -u neo4j -p "\${NEO4J_AUTH#neo4j/}" -d system "CREATE USER reader SET PASSWORD '$P' CHANGE NOT REQUIRED"`,
        ].join(" && "),
        { M: c.mark, P: c.password },
      );
    },
    check: (c) => {
      const read = (user: string, password: string) =>
        c.project.sh('cypher-shell -u "$U" -p "$P" --format plain "MATCH (n:T) RETURN n.v"', {
          U: user,
          P: password,
        });
      expect(read("reader", c.password)).toContain(`"${c.mark}"`);
      expect(read("neo4j", c.secrets.password ?? "")).toContain(`"${c.mark}"`);
    },
  },
];

describe.skipIf(reason !== undefined)("snapshot.sh on Docker", { timeout: 3_600_000 }, () => {
  for (const database of DATABASES) {
    it(`copies ${database.kind} while rows are written, then restores it exactly`, async () => {
      const plan = casePlan([{ kind: database.kind, name: "db" }]);
      const secrets = secretsOf(database.kind);
      await withProject(
        database.kind,
        plan,
        "db",
        secrets,
        { image: IMAGES.busybox.ref, command: IDLE },
        async (project) => {
          const query = (q: string, client = database.client) => project.sh(client, { Q: q });
          const lines = (q: string) =>
            query(q)
              .split("\n")
              .map((line) => line.trim().split(/\s+/).join(" "))
              .filter(Boolean);
          query(database.seed);
          const count = () => lines(database.rows).length;
          expect(count()).toBe(100);
          const writer = background(project, "db", database.writer);
          const started = Date.now();
          while (count() < 150) {
            if (Date.now() - started > 120_000) throw new Error("The writer wrote nothing.");
            await sleep(500);
          }
          const first = count();
          const { id, output } = project.take();
          const last = count();
          expect(last, "rows were written while the copy ran").toBeGreaterThan(first);
          await stopWriter(project, "db", writer);

          query(database.change);
          expect(query(database.tables)).toContain("added");
          const restored = project.restore(id);
          expect(lines(database.tables)).toEqual(["t"]);
          const rows = lines(database.rows);
          const ids = rows.map((row) => Number(row.split(" ")[0]));
          for (const row of rows) expect(row).toMatch(/^(\d+) row-\1$/);
          for (let n = 1; n <= first; n++) expect(ids).toContain(n);
          expect(Math.max(...ids)).toBeLessThanOrEqual(last);
          if (database.kind !== "mongodb") {
            expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
          }
          const { client, write, read, remove } = database.asApp;
          query(write, client);
          expect(query(read, client)).toBe("row-2000000");
          query(remove, client);

          query(database.change);
          const again = project.restore(id);
          expect(lines(database.rows)).toEqual(rows);
          for (const secret of Object.values(secrets)) {
            for (const text of [output, restored, again]) expect(text).not.toContain(secret);
          }
        },
      );
    });
  }

  it("copies the SQLite volume, two databases and an upload, while the app's user writes, then restores it exactly", async () => {
    const plan = DeployPlanSchema.parse({
      ...casePlan([]),
      storage: { sqlite: { dir: "data" } },
      deploy: { ...casePlan([]).deploy, strategy: "recreate" },
    });
    const app = {
      image: IMAGES.python.ref,
      command: IDLE,
      volumes: ["sqlite:/app/data"],
    };
    await withProject("sqlite", plan, "app", {}, app, async (project) => {
      // The volume is the app's user's, as the image's folder makes it.
      project.sh("chown 1002:1002 /app/data");
      // Before the app made anything, the volume is empty and skipped.
      const empty = project.take();
      const skipped = JSON.parse(
        readFileSync(join(project.dir, ".snapshots", empty.id, "about.json"), "utf8"),
      );
      expect(skipped.services).toEqual([{ name: "sqlite", kind: "sqlite", skipped: true }]);
      expect(existsSync(join(project.dir, ".snapshots", empty.id, "sqlite.tar"))).toBe(false);

      const python = (script: string) =>
        project.compose(["exec", "-T", "-u", "1002", "app", "python", "-c", script]);
      const DB = '"/app/data/app.sqlite3"';
      const CACHE = '"/app/data/cache.sqlite3"';
      python(
        `import sqlite3; c = sqlite3.connect(${DB}); c.execute("pragma journal_mode=wal"); c.execute("create table t (id integer primary key)"); c.commit()`,
      );
      // A second database in rollback-journal mode, and the app's uploads beside them.
      python(
        `import os, sqlite3; c = sqlite3.connect(${CACHE}); c.execute("create table c (k integer)"); c.executemany("insert into c values (?)", [(k,) for k in range(100)]); c.commit(); os.makedirs("/app/data/uploads"); open("/app/data/uploads/photo.txt", "w").write("photo bytes")`,
      );
      const cacheRows = () =>
        python(
          `import sqlite3; print(sqlite3.connect(${CACHE}).execute("select count(*) from c").fetchone()[0])`,
        );
      const writer = spawn(
        "docker",
        [
          "compose",
          "exec",
          "-T",
          "-u",
          "1002",
          "app",
          "python",
          "-c",
          `import os, sqlite3\nc = sqlite3.connect(${DB})\ni = 0\nwhile not os.path.exists("/tmp/stop"):\n    i += 1\n    c.execute("insert into t values (?)", (i,))\n    c.commit()`,
        ],
        { cwd: project.dir, env: project.env, stdio: "ignore" },
      );
      const count = () =>
        Number(
          python(
            `import sqlite3; print(sqlite3.connect(${DB}).execute("select count(*) from t").fetchone()[0])`,
          ),
        );
      while (count() < 500) await sleep(200);
      const first = count();
      const { id } = project.take();
      const last = count();
      expect(last).toBeGreaterThan(first);
      await stopWriter(project, "app", writer);
      // No file in the volume is root's: the copy ran as the app's user.
      expect(project.sh("find /app/data ! -user 1002")).toBe("");

      expect(existsSync(join(project.dir, ".snapshots", id, "sqlite.tar"))).toBe(true);

      // After the copy: a late row, the second database emptied, the upload replaced.
      python(
        `import os, sqlite3; c = sqlite3.connect(${DB}); c.execute("insert into t values (9999999)"); c.commit(); d = sqlite3.connect(${CACHE}); d.execute("delete from c"); d.commit(); os.remove("/app/data/uploads/photo.txt"); open("/app/data/uploads/new.txt", "w").write("new")`,
      );
      project.restore(id);
      const ids = python(
        `import sqlite3; print(" ".join(str(r[0]) for r in sqlite3.connect(${DB}).execute("select id from t order by id")))`,
      )
        .split(" ")
        .map(Number);
      expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
      expect(ids.length).toBeGreaterThanOrEqual(first);
      expect(ids.length).toBeLessThanOrEqual(last);
      expect(cacheRows()).toBe("100");
      for (const file of [DB, CACHE]) {
        expect(
          python(
            `import sqlite3; print(sqlite3.connect(${file}).execute("pragma journal_mode").fetchone()[0])`,
          ),
        ).toBe("delete");
      }
      expect(project.sh("cat /app/data/uploads/photo.txt")).toBe("photo bytes");
      // No -wal, -shm or -journal file, and nothing written after the copy.
      expect(project.sh("ls -A /app/data | sort | tr '\\n' ' '")).toBe(
        "app.sqlite3 cache.sqlite3 uploads",
      );
      expect(project.sh("ls -A /app/data/uploads")).toBe("photo.txt");
      expect(project.sh("find /app/data ! -user 1002")).toBe("");
    });
  });

  it("untars a stop-only service's copy only into its own folders", () => {
    remember(IMAGES.busybox.ref);
    const plan = casePlan([{ kind: "rabbitmq" }]);
    const line = snapshotScript(plan).find((l) => l.includes("snapshot_untar rabbitmq")) ?? "";
    const command = /'([^']*)'$/.exec(line)?.[1] ?? "";
    expect(command).toContain("tar -C / -xpf - var/lib/rabbitmq");
    // A tar with a member in another folder, and a stray file in the service's: the restore
    // empties the service's folder, puts back its member and writes nothing elsewhere.
    const seen = docker([
      "run",
      "--rm",
      "-e",
      `UNTAR=${command}`,
      IMAGES.busybox.ref,
      "sh",
      "-c",
      [
        "mkdir -p /var/lib/rabbitmq /var/lib/other",
        "echo kept > /var/lib/rabbitmq/x",
        "echo outside > /var/lib/other/evil",
        "tar -C / -cf /tmp/all.tar var/lib/rabbitmq var/lib/other",
        "rm /var/lib/other/evil",
        "echo stray > /var/lib/rabbitmq/stray",
        'sh -c "$UNTAR" < /tmp/all.tar',
        'echo "service: $(ls -A /var/lib/rabbitmq) other: $(ls -A /var/lib/other)"',
      ].join(" && "),
    ]);
    expect(seen).toBe("service: x other:");
  });

  for (const kind of ["valkey", "redis", "dragonfly"] as const) {
    for (const mode of ["cache", "queue"] as const) {
      it(`copies ${kind} as a ${mode} while it is written, then restores it exactly`, async () => {
        const plan = casePlan([{ kind, name: mode, options: { mode } }]);
        const secrets = secretsOf(kind);
        const { cli, password } = REDIS[kind];
        await withProject(
          `${kind}-${mode}`,
          plan,
          mode,
          secrets,
          { image: IMAGES.busybox.ref, command: IDLE },
          async (project) => {
            const redis = (command: string) =>
              project.sh(`REDISCLI_AUTH="$${password}" ${cli} ${command}`);
            const writer = background(
              project,
              mode,
              `i=1; while [ ! -f /tmp/stop ]; do REDISCLI_AUTH="$${password}" ${cli} RPUSH l $i > /dev/null; i=$((i + 1)); done`,
            );
            const length = () => Number(redis("LLEN l"));
            while (length() < 200) await sleep(200);
            const first = length();
            const { id } = project.take();
            const last = length();
            expect(last).toBeGreaterThan(first);
            await stopWriter(project, mode, writer);
            if (kind === "dragonfly") {
              expect(project.sh("ls /data")).not.toContain("opscrew-snapshot");
            }

            redis("SET late 1");
            redis("RPUSH l -1");
            project.restore(id);
            const list = () => redis("LRANGE l 0 -1").split("\n").map(Number);
            const items = list();
            expect(items).toEqual(Array.from({ length: items.length }, (_, i) => i + 1));
            expect(items.length).toBeGreaterThanOrEqual(first);
            expect(items.length).toBeLessThanOrEqual(last);
            expect(redis("EXISTS late")).toBe("0");
            if (mode === "queue") {
              // A queue keeps the restored data across a restart.
              project.compose(["restart", mode]);
              await eventually(() => expect(list()).toEqual(items));
            } else {
              // A cache leaves no copy behind for its next start to load.
              expect(project.sh("ls -A /data")).toBe("");
            }
          },
        );
      });
    }
  }

  for (const kase of STOP_ONLY) {
    it(`stops ${kase.kind} alone for its copy, then restores its volumes exactly`, async () => {
      const plan = casePlan(
        [{ kind: kase.kind, ...(kase.options === undefined ? {} : { options: kase.options }) }],
        kase.fields,
      );
      const secrets = secretsOf(kase.kind);
      const [[, dir] = ["", ""]] = dataDirs(serviceSpec(kase.kind));
      await withProject(
        kase.kind,
        plan,
        kase.kind,
        secrets,
        { image: IMAGES.busybox.ref, command: IDLE },
        async (project) => {
          const c: Ctx = {
            project,
            secrets,
            password: randomBytes(24).toString("hex"),
            mark: `opscrew-${randomBytes(6).toString("hex")}`,
            state: {},
          };
          await kase.seed(c);
          const app = project.compose(["ps", "-q", "app"]);
          const { id, output } = project.take([kase.kind]);
          expect(output).not.toContain("did not stop cleanly");
          expect(existsSync(join(project.dir, ".snapshots", id, `${kase.kind}.tar`))).toBe(true);
          // Only the service stopped; the app kept running.
          expect(project.compose(["ps", "-q", "app"])).toBe(app);
          await eventually(() => kase.check(c));

          project.box(`echo stray > ${dir}/opscrew-stray`);
          project.restore(id);
          expect(project.box(`ls -A ${dir}`)).not.toContain("opscrew-stray");
          await eventually(() => kase.check(c));
        },
      );
    });
  }
});
