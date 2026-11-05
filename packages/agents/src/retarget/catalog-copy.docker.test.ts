/**
 * Spike S1 as a test (023, research R4): every stateful kind of the catalog, and an app's SQLite
 * volume, moves by a copy of its stopped volumes. For each kind, as OpsCrew renders it (the
 * localhost target's Compose file, which keeps a service's data in named volumes):
 * 1. Compose project A starts, and gets one record (or message, key, object) and, where the kind
 *    keeps its users in its data, a user with a password, each through the kind's own client;
 * 2. A stops cleanly (no SIGKILL at the end of its stop grace period);
 * 3. project B is created from the same file but not started, and each of A's volumes is copied
 *    into B's volume of the same Compose key with the connector's carrier, the digests matching;
 * 4. B starts, and reads the same data with the same logins.
 *
 * `OPSCREW_DOCKER_CROSS_ARCH=1` repeats each kind with B on the other architecture (`platform:`),
 * when the local Docker can emulate it (Docker Desktop's QEMU).
 *
 * It pulls the pinned images, so it runs only with OPSCREW_DOCKER_TESTS=1. The kinds run one at a
 * time; each removes both projects with their volumes and networks, and the images it pulled.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DockerClient,
  dialStdioTransport,
  dockerClient,
  sweepCarriers,
  volumeCarrier,
} from "@opscrew/connector-docker";
import { NodeStreamRunner } from "@opscrew/core";
import { IMAGES, initStepsFor, renderCompose, serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type SelfHostedServiceKind,
} from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { serviceEnvFiles } from "../provision/secrets";
import { testPlan } from "../testing";

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
if (reason) console.warn(`[agents] skipping the catalog's volume copies on Docker: ${reason}`);

/** The run's id, in every project's name. */
const RUN = randomBytes(3).toString("hex");

/** One docker command's result; a failure throws with its output. */
function docker(args: string[], o: { cwd?: string; timeoutMs?: number } = {}): string {
  const result = spawnSync("docker", args, {
    cwd: o.cwd,
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

/** Whether the local Docker has `ref`. */
function hasImage(ref: string): boolean {
  return spawnSync("docker", ["image", "inspect", ref]).status === 0;
}

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

/** The local engine's architecture, as Docker names platforms. */
function nativeArch(): "amd64" | "arm64" {
  return docker(["info", "--format", "{{.Architecture}}"]) === "aarch64" ? "arm64" : "amd64";
}

/** One Compose project of a kind's service, in its own folder. */
class Project {
  readonly network: string;
  constructor(
    readonly name: string,
    readonly dir: string,
    readonly service: string,
  ) {
    this.network = `${name}_internal`;
  }

  compose(args: string[], timeoutMs?: number): string {
    return docker(["compose", "-p", this.name, "-f", join(this.dir, "compose.yaml"), ...args], {
      cwd: this.dir,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  /** `argv` in the running service's container, with `env` added to its own environment. */
  exec(argv: readonly string[], env: Record<string, string> = {}): string {
    const vars = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
    return this.compose(["exec", "-T", ...vars, this.service, ...argv]);
  }

  /** `script` in the service's container with `sh -c`. */
  sh(script: string, env: Record<string, string> = {}): string {
    return this.exec(["sh", "-c", script], env);
  }

  /** The pinned curl on the project's network, with `args`. */
  curl(args: string[]): string {
    return docker(["run", "--rm", "--network", this.network, IMAGES.curl.ref, "-fsS", ...args]);
  }

  /** The service's container. */
  container(): string {
    return this.compose(["ps", "-aq", this.service]);
  }
}

/** What a kind's seed and check get. */
interface Ctx {
  project: Project;
  /** The service's generated secrets, by the catalog's secret name. */
  secrets: Record<string, string>;
  /** A fresh password for the user the seed adds. */
  password: string;
  /** The record the seed writes and the check reads back. */
  mark: string;
  /** What the seed found out for the check, such as an API key the service generated. */
  state: Record<string, string>;
}

/** One kind's case. */
interface Case {
  /** The kind, or `sqlite` for the app's SQLite volume. */
  kind: SelfHostedServiceKind | "sqlite";
  /** The plan entry's options. */
  options?: Record<string, unknown>;
  seed: (c: Ctx) => void | Promise<void>;
  check: (c: Ctx) => void | Promise<void>;
}

/** A JSON body for curl's `-d`. */
const json = (value: unknown) => JSON.stringify(value);

/** Valkey, Redis 8 and Dragonfly in queue mode (a cache keeps nothing on disk) with `cli`. */
function redisCase(kind: "valkey" | "redis" | "dragonfly", cli: string, variable: string): Case {
  const auth = (c: Ctx) => ({ REDISCLI_AUTH: c.secrets.password ?? "" });
  return {
    kind,
    options: { mode: "queue" },
    seed: (c) => {
      c.project.sh(`${cli} SET mark "$M" && ${cli} RPUSH jobs "$M"`, { ...auth(c), M: c.mark });
    },
    check: (c) => {
      // The password comes from the environment; it must still be the one that logs in.
      expect(c.project.sh(`REDISCLI_AUTH="$${variable}" ${cli} GET mark`)).toBe(c.mark);
      expect(c.project.sh(`${cli} LRANGE jobs 0 -1`, auth(c))).toBe(c.mark);
    },
  };
}

const CASES: Case[] = [
  {
    kind: "postgres",
    seed: (c) => {
      c.project.sh(
        `psql -v ON_ERROR_STOP=1 -U app -d app -c "CREATE TABLE t (v text); INSERT INTO t VALUES ('$M'); CREATE ROLE reader LOGIN PASSWORD '$P'; GRANT SELECT ON t TO reader;"`,
        { M: c.mark, P: c.password },
      );
    },
    // Over the container's own address: the image trusts its socket and loopback.
    check: (c) => {
      const read = (user: string, password: string) =>
        c.project.sh(`psql -h "$(hostname -i)" -U ${user} -d app -tAc "SELECT v FROM t"`, {
          PGPASSWORD: password,
        });
      expect(read("reader", c.password)).toBe(c.mark);
      expect(read("app", c.secrets.password ?? "")).toBe(c.mark);
    },
  },
  redisCase("valkey", "valkey-cli", "VALKEY_PASSWORD"),
  redisCase("redis", "redis-cli", "REDIS_PASSWORD"),
  redisCase("dragonfly", "redis-cli", "DFLY_requirepass"),
  ...(["mysql", "mariadb"] as const).map((kind): Case => {
    const client = kind === "mysql" ? "mysql" : "mariadb";
    const root = kind === "mysql" ? "MYSQL_ROOT_PASSWORD" : "MARIADB_ROOT_PASSWORD";
    return {
      kind,
      seed: (c) => {
        c.project.sh(
          `${client} -uroot -p"$${root}" app -e "CREATE TABLE t (v varchar(64)); INSERT INTO t VALUES ('$M'); CREATE USER 'reader'@'%' IDENTIFIED BY '$P'; GRANT SELECT ON app.t TO 'reader'@'%';"`,
          { M: c.mark, P: c.password },
        );
      },
      check: (c) => {
        const read = (user: string, password: string) =>
          c.project.sh(`${client} -h127.0.0.1 -u${user} -p"$P" app -N -e "SELECT v FROM t"`, {
            P: password,
          });
        expect(read("reader", c.password)).toBe(c.mark);
        expect(read("app", c.secrets.password ?? "")).toBe(c.mark);
      },
    };
  }),
  {
    kind: "mongodb",
    // The replica set keeps its member's name and the keyfile in the volumes too.
    options: { replicaSet: true },
    seed: (c) => {
      c.project.sh(
        `mongosh --quiet -u app -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin app --eval 'db.t.insertOne({ v: process.env.M }); db.createUser({ user: "reader", pwd: process.env.P, roles: [{ role: "read", db: "app" }] })'`,
        { M: c.mark, P: c.password },
      );
    },
    check: (c) => {
      const read = (user: string, password: string, source: string) =>
        c.project.sh(
          `mongosh --quiet -u ${user} -p "$P" --authenticationDatabase ${source} app --eval 'db.t.findOne().v'`,
          { P: password },
        );
      expect(read("reader", c.password, "app")).toBe(c.mark);
      expect(read("app", c.secrets.password ?? "", "admin")).toBe(c.mark);
    },
  },
  {
    // The image has no AMQP client: the management plugin's HTTP API, which each container turns
    // on for the test only, publishes a persistent message to a durable queue and reads it back.
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
    // The image has only nats-server: busybox's nc speaks NATS's text protocol to JetStream's API.
    kind: "nats",
    seed: (c) => {
      const stream = json({ name: "S", subjects: ["s.>"], storage: "file" });
      const out = natsTalk(c.project, [
        ["$JS.API.STREAM.CREATE.S", stream],
        ["s.one", c.mark],
      ]);
      expect(out).toContain('"seq":1');
    },
    check: (c) => {
      const out = natsTalk(c.project, [["$JS.API.STREAM.MSG.GET.S", json({ seq: 1 })]]);
      expect(out).toContain(`"data":"${Buffer.from(c.mark).toString("base64")}"`);
    },
  },
  {
    // With the login: a second SCRAM user, kept in the cluster's metadata log, reads the topic.
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
    // The image has only /garage: curl signs the S3 requests. A second key, which Garage makes
    // and keeps in its metadata, reads the object too.
    kind: "garage",
    seed: (c) => {
      garageS3(c.project, c.secrets["key-id"] ?? "", c.secrets["secret-key"] ?? "", [
        "-X",
        "PUT",
        "--data-binary",
        c.mark,
      ]);
      const created = c.project.exec(["/garage", "key", "create", "reader"]);
      c.state.keyId = /Key ID:\s*(\S+)/.exec(created)?.[1] ?? "";
      c.state.secret = /Secret key:\s*(\S+)/.exec(created)?.[1] ?? "";
      expect(c.state.keyId).toMatch(/^GK/);
      c.project.exec(["/garage", "bucket", "allow", "--read", "--key", "reader", BUCKET]);
    },
    check: (c) => {
      expect(garageS3(c.project, c.state.keyId ?? "", c.state.secret ?? "", [])).toBe(c.mark);
      expect(
        garageS3(c.project, c.secrets["key-id"] ?? "", c.secrets["secret-key"] ?? "", []),
      ).toBe(c.mark);
    },
  },
  {
    // Its security plugin's user API answers only an admin certificate here, so the one user is
    // `admin`: its password hash is in the security index, in the volume, from the first start.
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
    // A search key Meilisearch makes and keeps in its data reads the document.
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
      const key = JSON.parse(
        post("keys", { actions: ["documents.get"], indexes: ["t"], expiresAt: null }),
      );
      c.state.key = key.key;
    },
    check: (c) => {
      expect(meiliDocument(c.project, c.state.key ?? "")).toContain(`"v":"${c.mark}"`);
      expect(meiliDocument(c.project, "$MEILI_MASTER_KEY")).toContain(`"v":"${c.mark}"`);
    },
  },
  {
    // The image has no HTTP client: curl on the project's network. A scoped key Typesense makes
    // and keeps in its data reads the document.
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
      const key = JSON.parse(
        post("keys", { description: "reader", actions: ["documents:get"], collections: ["t"] }),
      );
      c.state.key = key.value;
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
    // The login is the environment's (the catalog leaves SQL user management off), so only the
    // data is in the volume.
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
  {
    // The app's own volume: a stand-in for the app's image with Python's sqlite3, in WAL mode.
    kind: "sqlite",
    seed: (c) => {
      c.project.exec(
        [
          "python3",
          "-c",
          `import os, sqlite3; c = sqlite3.connect("${SQLITE_FILE}"); c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE t (v TEXT)"); c.execute("INSERT INTO t VALUES (?)", (os.environ["M"],)); c.commit(); c.close()`,
        ],
        { M: c.mark },
      );
    },
    check: (c) => {
      expect(
        c.project.exec([
          "python3",
          "-c",
          `import sqlite3; print(sqlite3.connect("${SQLITE_FILE}").execute("SELECT v FROM t").fetchone()[0])`,
        ]),
      ).toBe(c.mark);
    },
  },
];

/** The bucket of the Garage case's plan. */
const BUCKET = "shop-uploads";

/** The SQLite case's database folder in the app (`storage.sqlite.dir`) and its file. */
const SQLITE_DIR = "data";
const SQLITE_FILE = `/app/${SQLITE_DIR}/app.sqlite3`;

/**
 * Turns RabbitMQ's management plugin on in the running container, and waits for its API. Healthy
 * means the node answers, which can be before its app has started and can take a plugin: so
 * both are repeated.
 */
async function rabbitmqManagement(project: Project, password: string): Promise<void> {
  await eventually(() => {
    project.exec(["rabbitmq-plugins", "enable", "rabbitmq_management"]);
    project.curl(["-u", `app:${password}`, "http://rabbitmq:15672/api/overview"]);
  });
}

/**
 * Sends each `[subject, payload]` to NATS with the token from the container's environment, each
 * with the reply subject `r`, and returns everything the server answered.
 */
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

/** An S3 request to Garage's bucket object `mark.txt`, signed with the key `id`. */
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

/** Meilisearch's document 1 of index `t`, with `key` (a shell word). */
function meiliDocument(project: Project, key: string): string {
  return project.sh(
    `wget -q -O- --header "Authorization: Bearer ${key}" http://127.0.0.1:7700/indexes/t/documents/1`,
  );
}

/** The case's plan: the localhost target, with the kind's service or the app on SQLite. */
function casePlan(kase: Case): DeployPlan {
  const base = testPlan({ userSecret: false, postgres: false });
  const services =
    kase.kind === "sqlite"
      ? []
      : [
          {
            kind: kase.kind,
            version: serviceSpec(kase.kind).defaultVersion,
            memoryMb: serviceSpec(kase.kind).memory.defaultMb,
            reason: "The app uses it.",
            licence: serviceSpec(kase.kind).licence.id,
            ...(kase.options === undefined ? {} : { options: kase.options }),
          },
        ];
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      build: {
        builder: "generated-dockerfile",
        chosen: "auto",
        reason: "The test chose it.",
        runtime: { language: "python", version: "3.14" },
        probe: "python",
      },
    },
    target: {
      provider: "localhost",
      mode: "local-compose",
      arch: "amd64",
      ports: { https: 8443, http: 8080 },
      image: "local-build",
      edge: "caddy",
    },
    dns: { provider: "none", proxied: false },
    cost: { ...base.cost, monthly: { amount: 0, currency: "EUR" }, breakdown: [] },
    services,
    ...(kase.kind === "sqlite"
      ? {
          storage: { sqlite: { dir: SQLITE_DIR } },
          deploy: { ...base.deploy, strategy: "recreate" },
        }
      : {}),
    ...(kase.kind === "garage"
      ? {
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
        }
      : {}),
  });
}

/**
 * The project's Compose file: the plan's rendered service alone (its volumes, settings and the
 * internal network), or for SQLite a stand-in of the app with the rendered app's volumes. With
 * `platform`, the service runs on that platform.
 */
function composeFile(plan: DeployPlan, kase: Case, platform?: string): string {
  const rendered = parse(renderCompose(plan).content);
  const name = plan.services[0]?.name ?? "app";
  const service =
    kase.kind === "sqlite"
      ? {
          image: IMAGES.python.ref,
          // A PID 1 that stops at once on SIGTERM, as the app does.
          command: ["sh", "-c", 'trap "exit 0" TERM; while :; do sleep 1; done'],
          volumes: rendered.services.app.volumes,
          networks: ["internal"],
        }
      : { ...rendered.services[name] };
  // The host settings' one-shot container stays out: the test checks the setting itself.
  delete (service as { depends_on?: unknown }).depends_on;
  const used = new Set((service.volumes as string[]).map((mount) => mount.split(":")[0] ?? ""));
  const volumes = Object.fromEntries(
    Object.entries(rendered.volumes ?? {}).filter(([key]) => used.has(key)),
  );
  return stringify({
    services: { [name]: { ...service, ...(platform === undefined ? {} : { platform }) } },
    networks: { internal: {} },
    ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    ...(rendered.configs === undefined ? {} : { configs: rendered.configs }),
  });
}

/** A new random value for each of the kind's secrets, in its format. */
function caseSecrets(kase: Case): Record<string, string> {
  if (kase.kind === "sqlite") return {};
  return Object.fromEntries(
    serviceSpec(kase.kind).secrets.map((secret) => [
      secret.name,
      secret.format === "garage-key-id"
        ? `GK${randomBytes(12).toString("hex")}`
        : randomBytes(32).toString("hex"),
    ]),
  );
}

/** Writes project `name`'s folder: the Compose file and the service's env file. */
function writeProject(
  root: string,
  name: string,
  plan: DeployPlan,
  kase: Case,
  secrets: Record<string, string>,
  platform?: string,
): Project {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "compose.yaml"), composeFile(plan, kase, platform));
  const service = plan.services[0];
  if (service !== undefined) {
    const files = serviceEnvFiles(plan, {
      values: { app: {}, build: {}, services: { [service.name]: secrets } },
    });
    writeFileSync(join(dir, `${service.name}.env`), files[service.name] ?? "");
  }
  return new Project(name, dir, service?.name ?? "app");
}

/**
 * Waits until the project's service is healthy (or, without a health check, running), and returns
 * how often its restart policy started it again; fails once it has exited for good or a third time.
 */
async function waitHealthy(project: Project, ms: number): Promise<number> {
  const id = project.container();
  const deadline = Date.now() + ms;
  for (;;) {
    const [restarts = "", json = ""] = docker([
      "inspect",
      "--format",
      "{{.RestartCount}} {{json .State}}",
      id,
    ]).split(/ (.*)/s);
    const state = JSON.parse(json);
    const health = state.Health?.Status ?? (state.Running ? "healthy" : state.Status);
    if (health === "healthy") return Number(restarts);
    const exited = state.Status === "exited" || Number(restarts) > 2;
    if (exited || Date.now() > deadline) {
      const logs = spawnSync("docker", ["logs", "--tail", "20", id], { encoding: "utf8" });
      throw new Error(
        `${project.name} ${exited ? `exited (code ${state.ExitCode}${state.OOMKilled ? ", out of memory" : ""}, ${restarts} restarts)` : "never became healthy"}:\n${logs.stdout}${logs.stderr}`,
      );
    }
    await sleep(2_000);
  }
}

/** The architecture B runs on in the cross pass, when the local Docker can emulate it. */
let otherArch: string | undefined;
/** The images present before the run, by reference. */
const before = new Map<string, boolean>();
/** Each pass's result, for the summary. */
const results: string[] = [];

function remember(ref: string): void {
  if (!before.has(ref)) before.set(ref, hasImage(ref));
}

/** Removes `ref` when the run pulled it. */
function removeIfPulled(ref: string): void {
  if (before.get(ref) === false && hasImage(ref)) {
    const removed = spawnSync("docker", ["image", "rm", ref], { encoding: "utf8" });
    if (removed.status !== 0) console.warn(`[agents] could not remove ${ref}: ${removed.stderr}`);
  }
}

describe.skipIf(reason !== undefined)("each catalog kind's volumes, copied on Docker", () => {
  const runner = new NodeStreamRunner();
  const transports = [1, 2].map(() =>
    dialStdioTransport(() => runner.open("docker", ["system", "dial-stdio"])),
  );
  const [here, there] = transports.map(dockerClient) as [DockerClient, DockerClient];
  const reader = volumeCarrier(here, IMAGES.busybox.ref);
  const writer = volumeCarrier(there, IMAGES.busybox.ref);
  const root = mkdtempSync(join(tmpdir(), "opscrew-catalog-copy-"));

  beforeAll(() => {
    for (const ref of [IMAGES.busybox.ref, IMAGES.curl.ref]) remember(ref);
    if (process.env.OPSCREW_DOCKER_CROSS_ARCH !== "1") return;
    const other = nativeArch() === "amd64" ? "arm64" : "amd64";
    const probe = spawnSync(
      "docker",
      ["run", "--rm", "--platform", `linux/${other}`, IMAGES.busybox.ref, "uname", "-m"],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (probe.status === 0) otherArch = other;
    else {
      console.warn(
        `[agents] skipping the other architecture (${other}): this Docker cannot run its containers (${probe.stderr.trim()})`,
      );
    }
  }, 300_000);

  afterAll(async () => {
    for (const transport of transports) await transport.close?.();
    removeIfPulled(IMAGES.busybox.ref);
    removeIfPulled(IMAGES.curl.ref);
    rmSync(root, { recursive: true, force: true });
    console.info(`[agents] catalog copies:\n${results.join("\n")}`);
  });

  /** A, seeded and stopped, copied into a created B (on `platform`), which then reads the data. */
  async function pass(kase: Case, platform: string | undefined): Promise<string> {
    const plan = casePlan(kase);
    const secrets = caseSecrets(kase);
    const suffix = platform === undefined ? "" : `-${platform.replace("linux/", "")}`;
    const a = writeProject(
      root,
      `opscrew-copy-${RUN}-${kase.kind}${suffix}-a`,
      plan,
      kase,
      secrets,
    );
    const b = writeProject(
      root,
      `opscrew-copy-${RUN}-${kase.kind}${suffix}-b`,
      plan,
      kase,
      secrets,
      platform,
    );
    const c: Omit<Ctx, "project"> = {
      secrets,
      password: randomBytes(24).toString("hex"),
      mark: `opscrew-${randomBytes(6).toString("hex")}`,
      state: {},
    };
    try {
      a.compose(["up", "-d", "--wait", "--wait-timeout", "600"], 900_000);
      for (const step of initStepsFor(plan)) {
        if (spawnSync("docker", ["exec", a.container(), ...step.check]).status !== 0) {
          a.exec(step.run);
        }
      }
      await kase.seed({ ...c, project: a });

      const stopping = Date.now();
      a.compose(["stop"], 900_000);
      const stopSeconds = Math.round((Date.now() - stopping) / 1000);
      const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", a.container()]));
      expect(state.ExitCode, "killed at the end of its stop grace period").not.toBe(137);
      expect(state.OOMKilled).toBe(false);

      b.compose(["pull", "--quiet"], 1_800_000);
      b.compose(["create"]);
      const label = "com.docker.compose.volume";
      const volumesOf = async (p: Project) =>
        new Map(
          (await here.listVolumes([`com.docker.compose.project=${p.name}`])).map((v) => [
            v.labels[label] ?? "",
            v.name,
          ]),
        );
      const [from, to] = [await volumesOf(a), await volumesOf(b)];
      expect([...to.keys()].sort()).toEqual([...from.keys()].sort());
      expect(from.size).toBeGreaterThan(0);
      const sizes = await here.volumeSizes();
      const copied: string[] = [];
      for (const [key, source] of from) {
        const target = { kind: "volume" as const, name: to.get(key) ?? "" };
        const origin = { kind: "volume" as const, name: source };
        const digest = await reader.volumeDigest(origin);
        const started = Date.now();
        await writer.writeVolume(target, await reader.readVolume(origin));
        expect(await writer.volumeDigest(target)).toBe(digest);
        const mb = ((sizes.get(source) ?? 0) / 1024 / 1024).toFixed(1);
        copied.push(`${key} ${mb} MB in ${Date.now() - started} ms`);
      }

      b.compose(["up", "-d", "--no-recreate"]);
      const restarts = await waitHealthy(b, platform === undefined ? 600_000 : 1_800_000);
      for (const step of initStepsFor(plan)) b.exec(step.check);
      await eventually(
        () => kase.check({ ...c, project: b }),
        platform === undefined ? 180_000 : 600_000,
      );
      const restarted = restarts > 0 ? `; B restarted ${restarts} times before it was healthy` : "";
      return `stopped in ${stopSeconds} s (exit ${state.ExitCode}); ${copied.join(", ")}${restarted}`;
    } finally {
      for (const p of [a, b]) {
        // A carrier left by a failed copy would keep its volume.
        const volumes = await here.listVolumes([`com.docker.compose.project=${p.name}`]);
        await sweepCarriers(
          here,
          volumes.map((v) => ({ kind: "volume" as const, name: v.name })),
        );
        spawnSync(
          "docker",
          ["compose", "-p", p.name, "-f", join(p.dir, "compose.yaml"), "down", "-v", "-t", "1"],
          { cwd: p.dir, encoding: "utf8", timeout: 300_000 },
        );
      }
    }
  }

  for (const kase of CASES) {
    it(kase.kind, async () => {
      const ref =
        kase.kind === "sqlite" ? IMAGES.python.ref : IMAGES[serviceSpec(kase.kind).image].ref;
      remember(ref);
      try {
        for (const platform of [undefined, ...(otherArch ? [`linux/${otherArch}`] : [])]) {
          const where = platform === undefined ? "native" : `to ${platform}`;
          try {
            const done = await pass(kase, platform);
            results.push(`${kase.kind} (${where}): copied OK; ${done}`);
          } catch (error) {
            // The error's first line, and the last line of the logs it carries.
            const lines = String(error).trim().split("\n");
            const said = lines.length > 1 ? ` … ${lines.at(-1)?.trim()}` : "";
            results.push(`${kase.kind} (${where}): FAILED: ${lines[0]}${said}`);
            throw error;
          } finally {
            console.info(`[agents] ${results.at(-1)}`);
          }
        }
      } finally {
        removeIfPulled(ref);
      }
    }, 3_600_000);
  }
});
