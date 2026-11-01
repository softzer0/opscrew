/**
 * The catalog's search and analytics engines (T1311), Redis 8 and Dragonfly (T1317), and Kafka and
 * Redpanda with their login (T1922), on Docker: each is rendered into OpsCrew's
 * server Compose file for a Hetzner server (`renderCompose`, adapted to this computer like the
 * Docker pass's) and started alone, as the deploy starts the services (`up -d --no-deps --wait`,
 * after the one-shot `sysctl` container where the engine needs a kernel setting), one at a time
 * because their memory adds up. Each must:
 * - pass its health check, with its memory limit;
 * - require its login (Elasticsearch, Typesense, Neo4j);
 * - for OpenSearch, and Kafka and Redpanda with `login: true` (SC-1906): refuse a client without
 *   the login and serve one with the app's variables (`OPENSEARCH_URL`, `KAFKA_SASL_*`) after a
 *   first start, a restart, a recreated container, and the login turned on over data written
 *   without one, which stays. OpenSearch also refuses the image's own `admin:admin`. A Kafka client
 *   without the login only times out, so it gets a few seconds. Redpanda's admin API refuses a
 *   change from another container, which can't reach its Schema Registry and HTTP Proxy either;
 * - show the image facts the catalog relies on: curl in the OpenSearch and Elasticsearch images
 *   (their health checks), OpenSearch's `keytool` and `hash.sh` (its login's setup) and no demo
 *   certificates; bash with `/dev/tcp` in the Typesense and Neo4j images; Neo4j's
 *   `/logs` among the volumes OpsCrew mounts (no anonymous volume); busybox wget in
 *   Meilisearch's; wget in ClickHouse's, and ClickHouse starting with `remove="1"` on the log
 *   tables it turns off;
 * - for Redis 8 and Dragonfly, as queues: refuse a command without the password and answer it
 *   with it (redis-cli of the pinned Redis image on the app's network); Redis 8's image loading
 *   Search, JSON, Time Series and Bloom (`MODULE LIST`, `FT.CREATE`, `JSON.SET`); Dragonfly
 *   running a BullMQ-style script under its hashtag locks, with no HTTP answer on its port; the
 *   password in neither log nor redis-server's command line.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon.
 * OPSCREW_DOCKER_ENGINES=a,b limits the run to those kinds. Each Compose project is removed with
 * its volumes; the engines' images stay, as base images do. No check prints a password: the
 * clients' output is shown with the engine's secrets replaced.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AppEnvironment, assembleAppEnv, serviceEnvSecrets } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import {
  hostSettingsServices,
  IMAGES,
  renderCompose,
  serviceEnvSecret,
  serviceSpec,
} from "@opscrew/iac-templates";
import { type DeployPlan, PlanServiceSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  type ComposeProject,
  type ComposeService,
  compose,
  composeOk,
  docker,
  dockerSkipReason,
  LABEL,
  limitProblems,
  localServerCompose,
  type ProjectContainer,
  projectContainers,
  runtimeFiles,
  TEN_MINUTES,
  TWO_MINUTES,
  tail,
} from "./docker-support";

const ENGINES = [
  "opensearch",
  "elasticsearch",
  "typesense",
  "neo4j",
  "meilisearch",
  "clickhouse",
  "redis",
  "dragonfly",
  "kafka",
  "redpanda",
] as const;
type Engine = (typeof ENGINES)[number];

/** The engines on Redis's protocol, which the pinned Redis image's redis-cli reaches. */
const REDIS_PROTOCOL: readonly Engine[] = ["redis", "dragonfly"];

/** The engines whose login SC-1906 checks in its four cases (Kafka and Redpanda with `login`). */
const LOGIN_CASES: readonly Engine[] = ["opensearch", "kafka", "redpanda"];

/**
 * A client of each broker in the broker's own image, as shell scripts that read the app's
 * variables (`KAFKA_BROKERS`, and the `KAFKA_SASL_*` ones when the app has a login), `TOPIC` and
 * `MESSAGE`: `setup` first, then one of the others. `list` lists the topics within seconds.
 */
const BROKER_CLIENTS: Record<
  "kafka" | "redpanda",
  { setup: string; produce: string; consume: string; list: string }
> = {
  kafka: {
    setup: [
      "export KAFKA_HEAP_OPTS=-Xmx128m",
      "cd /opt/kafka/bin",
      ": > /tmp/client.properties",
      `if [ -n "$KAFKA_SASL_USERNAME" ]; then printf 'security.protocol=%s\\nsasl.mechanism=%s\\nsasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="%s" password="%s";\\n' "$KAFKA_SECURITY_PROTOCOL" "$KAFKA_SASL_MECHANISM" "$KAFKA_SASL_USERNAME" "$KAFKA_SASL_PASSWORD" > /tmp/client.properties; fi`,
    ].join("; "),
    produce:
      'echo "$MESSAGE" | ./kafka-console-producer.sh --bootstrap-server "$KAFKA_BROKERS" --topic "$TOPIC" --producer.config /tmp/client.properties',
    consume:
      './kafka-console-consumer.sh --bootstrap-server "$KAFKA_BROKERS" --topic "$TOPIC" --from-beginning --max-messages 1 --timeout-ms 30000 --consumer.config /tmp/client.properties',
    // Without the login Kafka gives no error, so the client stops waiting after 5 seconds.
    list: [
      "printf 'default.api.timeout.ms=5000\\nrequest.timeout.ms=3000\\n' >> /tmp/client.properties",
      'timeout 30 ./kafka-topics.sh --bootstrap-server "$KAFKA_BROKERS" --list --command-config /tmp/client.properties',
    ].join("; "),
  },
  redpanda: {
    setup: [
      'export RPK_BROKERS="$KAFKA_BROKERS"',
      'if [ -n "$KAFKA_SASL_USERNAME" ]; then export RPK_USER="$KAFKA_SASL_USERNAME" RPK_PASS="$KAFKA_SASL_PASSWORD" RPK_SASL_MECHANISM="$KAFKA_SASL_MECHANISM"; fi',
    ].join("; "),
    produce: 'rpk topic create "$TOPIC" && echo "$MESSAGE" | rpk topic produce "$TOPIC"',
    consume: "timeout 60 rpk topic consume \"$TOPIC\" --num 1 --offset start --format '%v\\n'",
    list: "timeout 30 rpk topic list",
  },
};

/** The app's login variables for Kafka and Redpanda, which a client without the login leaves out. */
const BROKER_LOGIN = /^KAFKA_(SASL_|SECURITY_PROTOCOL$)/;

/** The app's `variables` without the broker's login: those of an app with the login off. */
function withoutBrokerLogin(variables: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => !BROKER_LOGIN.test(name)));
}

/**
 * A BullMQ-style script: it declares the queue's list and also writes a key of the same hashtag
 * it does not declare (BullMQ builds such keys from its prefix), which Dragonfly allows only with
 * its hashtag locks.
 */
const BULLMQ_STYLE_SCRIPT = [
  'redis.call("RPUSH", KEYS[1], ARGV[1])',
  'local id = string.gsub(KEYS[1], ":wait$", ":id")',
  'redis.call("INCR", id)',
  'return redis.call("LLEN", KEYS[1])',
].join("\n");

/** OPSCREW_DOCKER_ENGINES=a,b, or every engine. */
const REQUESTED = process.env.OPSCREW_DOCKER_ENGINES?.split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const RUN = ENGINES.filter((kind) => !REQUESTED?.length || REQUESTED.includes(kind));

const SKIP = dockerSkipReason();
if (SKIP !== undefined) console.warn(`Skipping the engines check: ${SKIP}.`);

/**
 * The engines with a login, each with a request on its network (curl's URL and options) and the
 * curl options that log in with its generated secret (`secret(name)`).
 */
const LOGINS: Partial<
  Record<
    Engine,
    (secret: (name: string) => string) => { url: string; request: string[]; login: string[] }
  >
> = {
  elasticsearch: (secret) => ({
    url: "http://elasticsearch:9200/",
    request: [],
    login: ["-u", `elastic:${secret("password")}`],
  }),
  typesense: (secret) => ({
    url: "http://typesense:8108/collections",
    request: [],
    login: ["-H", `X-TYPESENSE-API-KEY: ${secret("api-key")}`],
  }),
  neo4j: (secret) => ({
    url: "http://neo4j:7474/db/neo4j/tx/commit",
    request: ["-X", "POST", "-H", "Content-Type: application/json", "-d", '{"statements":[]}'],
    login: ["-u", `neo4j:${secret("password")}`],
  }),
};

/**
 * A Hetzner plan whose one service is `kind`, named after it, with the catalog's version and
 * memory: Redis 8 and Dragonfly as a queue, Dragonfly with BullMQ's hashtag locks, Kafka and
 * Redpanda with `login` (default true).
 */
function enginePlan(kind: Engine, login = true): DeployPlan {
  const spec = serviceSpec(kind);
  const options =
    kind === "redis"
      ? { mode: "queue" }
      : kind === "dragonfly"
        ? { mode: "queue", lockOnHashtags: true }
        : kind === "kafka" || kind === "redpanda"
          ? { login }
          : undefined;
  const service = PlanServiceSchema.parse({
    name: kind,
    kind,
    version: spec.defaultVersion,
    memoryMb: spec.memory.defaultMb,
    ...(options === undefined ? {} : { options }),
    reason: `The engines check runs ${spec.title}.`,
    licence: spec.licence.id,
  });
  return { ...testPlan({ postgres: false, userSecret: false }), services: [service] };
}

describe.skipIf(SKIP !== undefined)(
  SKIP === undefined ? "the catalog's engines" : `the catalog's engines (skipped: ${SKIP})`,
  () => {
    it("OPSCREW_DOCKER_ENGINES names only engines the check knows", () => {
      const unknown = (REQUESTED ?? []).filter(
        (name) => !(ENGINES as readonly string[]).includes(name),
      );
      expect(unknown, `known engines: ${ENGINES.join(", ")}`).toEqual([]);
    });

    describe.each(RUN)("%s", (kind) => {
      const plan = enginePlan(kind);
      const spec = serviceSpec(kind);
      // The engine and the one-shot container it waits for, as the deploy names them.
      const steady = [...hostSettingsServices(plan), kind];
      const project: ComposeProject = { name: `opscrew-engine-${kind}-${Date.now()}`, file: "" };
      let dir = "";
      let environment: AppEnvironment | undefined;
      let started: ProjectContainer | undefined;
      let serviceEnv: string | undefined;

      /** The engine's generated secret `name`. */
      function secret(name: string): string {
        const value = environment?.values.services[kind]?.[name];
        if (value === undefined) throw new Error(`${kind} has no secret ${name}.`);
        return value;
      }

      /** The engine's container, once the first test started it. */
      function engine(): ProjectContainer {
        if (started === undefined) throw new Error(`${kind} is not running (see the first test).`);
        return started;
      }

      /** `args` in the engine's container. */
      function exec(...args: string[]) {
        return docker(["exec", engine().name, ...args]);
      }

      /** The HTTP status curl gets from `url` on the engine's network, with curl's `options`. */
      async function status(url: string, ...options: string[]): Promise<string> {
        const result = await docker([
          "run",
          "--rm",
          "--label",
          LABEL,
          "--network",
          `${project.name}_internal`,
          IMAGES.curl.ref,
          ...["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20"],
          ...options,
          url,
        ]);
        return result.stdout.trim();
      }

      /** redis-cli's reply from the engine on its network, logged in when `login` is true. */
      async function redisCli(login: boolean, ...args: string[]): Promise<string> {
        const result = await docker([
          "run",
          "--rm",
          "--label",
          LABEL,
          "--network",
          `${project.name}_internal`,
          ...(login ? ["-e", `REDISCLI_AUTH=${secret("password")}`] : []),
          IMAGES.redis.ref,
          "redis-cli",
          "-h",
          kind,
          ...args,
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout.trim();
      }

      /** `text` with the engine's secrets replaced, so a check's message never shows them. */
      function redact(text: string): string {
        let shown = text;
        for (const value of Object.values(environment?.values.services[kind] ?? {})) {
          shown = shown.replaceAll(value, "[secret]");
        }
        return shown;
      }

      /** Writes the project: the steady services of the Compose `file`, and the engine's `env`. */
      async function writeProject(file: string, env: string | undefined): Promise<void> {
        // Without the app.
        const doc = parse(file) as { services: Record<string, ComposeService> };
        doc.services = Object.fromEntries(steady.map((name) => [name, doc.services[name] ?? {}]));
        await writeFile(project.file, stringify(doc, { lineWidth: 0 }));
        if (env !== undefined) await writeFile(path.join(dir, `${kind}.env`), env);
      }

      /** `up -d --no-deps --wait` with `args`, as the deploy starts a service; then the engine runs. */
      async function up(...args: string[]): Promise<ProjectContainer[]> {
        const began = Date.now();
        const result = await compose(
          project,
          ["up", "-d", "--no-deps", "--wait", ...args],
          TEN_MINUTES,
        );
        if (result.exitCode !== 0) {
          const logs = await compose(project, ["logs", "--tail", "60"]);
          throw new Error(
            redact(
              `${kind} did not become healthy (exit ${result.exitCode}):\n${tail(result.stderr, 20)}\nIts log:\n${tail(logs.stdout, 60)}`,
            ),
          );
        }
        console.info(`${kind}: healthy ${Math.round((Date.now() - began) / 1000)} s after up`);
        const containers = await projectContainers(project.name);
        started = containers.find((c) => c.service === kind);
        return containers;
      }

      /**
       * A broker's client `step` ({@link BROKER_CLIENTS}) on its network with the app's
       * `variables` and `topic`: its exit code, and its output with the engine's secrets replaced.
       */
      async function broker(
        variables: Readonly<Record<string, string>>,
        step: "produce" | "consume" | "list",
        topic = "",
      ): Promise<{ exitCode: number; output: string }> {
        if (kind !== "kafka" && kind !== "redpanda") throw new Error(`${kind} is not a broker.`);
        const client = BROKER_CLIENTS[kind];
        const file = path.join(dir, "client.env");
        const values = { ...variables, TOPIC: topic, MESSAGE: `checked-${topic}` };
        await writeFile(
          file,
          Object.entries(values)
            .map(([name, value]) => `${name}=${value}\n`)
            .join(""),
        );
        const result = await docker(
          [
            "run",
            "--rm",
            "--label",
            LABEL,
            "--network",
            `${project.name}_internal`,
            "--env-file",
            file,
            "--entrypoint",
            "sh",
            IMAGES[kind].ref,
            "-c",
            `${client.setup}; ${client[step]}`,
          ],
          TWO_MINUTES,
        );
        return { exitCode: result.exitCode, output: redact(`${result.stdout}\n${result.stderr}`) };
      }

      /** A client with the app's `variables` reads the message written to `topic`. */
      async function expectMessage(
        variables: Readonly<Record<string, string>>,
        topic: string,
      ): Promise<void> {
        const consumed = await broker(variables, "consume", topic);
        expect(consumed.exitCode, `consuming ${topic}:\n${tail(consumed.output, 20)}`).toBe(0);
        expect(consumed.output.split(/\r?\n/), `the message on ${topic}`).toContain(
          `checked-${topic}`,
        );
      }

      /**
       * SC-1906's check: a client without the login is refused, and one with the app's variables
       * is served (a broker's produces to `topic` and consumes it). Redpanda's admin API refuses a
       * change from another container.
       */
      async function checkLogin(topic: string): Promise<void> {
        const app = environment?.values.app ?? {};
        if (kind === "opensearch") {
          expect(await status("http://opensearch:9200/"), "without the login").toBe("401");
          expect(
            await status("http://opensearch:9200/", "-u", "admin:admin"),
            "with the image's own login",
          ).toBe("401");
          expect(await status(`${app.OPENSEARCH_URL}/`), "with OPENSEARCH_URL").toBe("200");
          return;
        }
        const began = Date.now();
        const refused = await broker(withoutBrokerLogin(app), "list");
        console.info(
          `${kind}: a client without the login stopped after ${Math.round((Date.now() - began) / 1000)} s`,
        );
        expect(refused.exitCode, `without the login:\n${tail(refused.output, 20)}`).not.toBe(0);
        expect(refused.output, "without the login").toMatch(
          kind === "kafka" ? /Timed out waiting for a node assignment/ : /SASL/,
        );
        const produced = await broker(app, "produce", topic);
        expect(produced.exitCode, `producing with the login:\n${tail(produced.output, 20)}`).toBe(
          0,
        );
        await expectMessage(app, topic);
        if (kind === "redpanda") {
          const change = await status(
            "http://redpanda:9644/v1/cluster_config",
            ...["-X", "PUT", "-H", "Content-Type: application/json"],
            ...["-d", '{"upsert":{"superusers":["intruder"]},"remove":[]}'],
          );
          expect(change, "a change to the admin API without the login").toBe("403");
          const superusers = await exec("rpk", "cluster", "config", "get", "superusers");
          expect(superusers.exitCode, redact(superusers.stderr)).toBe(0);
          expect(superusers.stdout, "the superusers").toContain("app");
          expect(superusers.stdout, "the superusers").not.toContain("intruder");
          // Schema Registry and the HTTP Proxy listen on loopback only.
          expect(await status("http://redpanda:8081/subjects"), "Schema Registry").toBe("000");
          expect(await status("http://redpanda:8082/topics"), "the HTTP Proxy").toBe("000");
        }
      }

      /**
       * The project as OpsCrew ran the engine without a login, with the app's variables then:
       * Kafka and Redpanda without `login` (the same secrets), OpenSearch as before its login (the
       * image's own command and the security plugin off).
       */
      function withoutLogin(): {
        file: string;
        env: string | undefined;
        app: Record<string, string>;
      } {
        if (kind === "opensearch") {
          const doc = parse(localServerCompose(plan)) as {
            services: Record<string, Record<string, unknown>>;
          };
          delete doc.services.opensearch?.command;
          const env = (serviceEnv ?? "")
            .split("\n")
            .filter((line) => !line.startsWith("plugins.security."))
            .join("\n");
          return {
            file: stringify(doc, { lineWidth: 0 }),
            env: `${env}DISABLE_SECURITY_PLUGIN=true\n`,
            app: {},
          };
        }
        if (environment === undefined) throw new Error(`${kind} has no environment yet.`);
        const off = enginePlan(kind, false);
        return {
          file: localServerCompose(off),
          env: serviceEnvSecrets(off, environment)[serviceEnvSecret(kind)],
          app: withoutBrokerLogin(environment.values.app),
        };
      }

      beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), `opscrew-engine-${kind}-`));
        project.file = path.join(dir, "compose.yaml");
        environment = await assembleAppEnv({ plan, ask: async () => ({ skip: true }) });
        serviceEnv = serviceEnvSecrets(plan, environment)[serviceEnvSecret(kind)];
        await writeProject(localServerCompose(plan), serviceEnv);
      });

      afterAll(async () => {
        // A client a failed check left running would keep the network from being removed.
        const left = await docker(["ps", "-aq", "--filter", `network=${project.name}_internal`]);
        const clients = left.stdout.split(/\s+/).filter((id) => id !== "");
        if (clients.length > 0) await docker(["rm", "-f", ...clients]);
        await compose(project, ["down", "-v", "--remove-orphans"]);
        await rm(dir, { recursive: true, force: true });
      }, TWO_MINUTES);

      it(
        "starts alone with its memory limit, and its health check passes",
        async () => {
          const containers = await up(...steady);
          const services = (
            parse(renderCompose(plan).content) as {
              services: Record<string, ComposeService>;
            }
          ).services;
          expect(limitProblems(containers, services), `${kind}: memory limits`).toEqual([]);
          expect(started?.running, `${kind} runs`).toBe(true);
          // On a cloud server the one-shot container sets the host's kernel setting first.
          const sysctl = containers.find((c) => c.service === "sysctl");
          if (spec.hostSettings !== undefined) {
            expect(sysctl, "the sysctl container").toMatchObject({ running: false, exitCode: 0 });
          } else {
            expect(sysctl, "a sysctl container").toBeUndefined();
          }
        },
        TEN_MINUTES + TWO_MINUTES,
      );

      it.runIf(LOGIN_CASES.includes(kind))(
        "refuses a client without its login and serves one with it, after a first start",
        async () => {
          await checkLogin("first-start");
        },
        TEN_MINUTES,
      );

      it.runIf(LOGINS[kind] !== undefined)(
        "refuses a request without its login and answers it with the login",
        async () => {
          const check = LOGINS[kind];
          if (check === undefined) return;
          const { url, request, login } = check(secret);
          expect(await status(url, ...request), "without the login").toBe("401");
          expect(await status(url, ...request, ...login), "with the login").toBe("200");
        },
        TWO_MINUTES,
      );

      it.runIf(REDIS_PROTOCOL.includes(kind))(
        "refuses a command without its password and answers it with the password",
        async () => {
          expect(await redisCli(false, "ping"), "without the password").toMatch(/^NOAUTH/);
          expect(await redisCli(true, "ping"), "with the password").toBe("PONG");
          // Neither its log nor (Redis 8) redis-server's command line shows the password.
          const logs = await docker(["logs", engine().name]);
          expect(`${logs.stdout}${logs.stderr}`.includes(secret("password")), "in its log").toBe(
            false,
          );
          if (kind === "redis") {
            const cmdline = await exec("cat", "/proc/1/cmdline");
            expect(cmdline.exitCode, cmdline.stderr).toBe(0);
            expect(cmdline.stdout).toContain("redis-server");
            expect(cmdline.stdout.includes(secret("password")), "on its command line").toBe(false);
          }
        },
        TWO_MINUTES,
      );

      it.runIf(kind === "dragonfly")(
        "gives no HTTP answer on its port: its HTTP console is off",
        async () => {
          expect(await status("http://dragonfly:6379/")).toBe("000");
        },
        TWO_MINUTES,
      );

      it.runIf(kind === "redis")(
        "loads Search, JSON, Time Series and Bloom in the pinned image",
        async () => {
          const modules = await redisCli(true, "MODULE", "LIST");
          for (const name of ["search", "ReJSON", "timeseries", "bf"]) {
            expect(modules.split(/\r?\n/), `the ${name} module`).toContain(name);
          }
          const create = ["FT.CREATE", "idx", "ON", "JSON", "PREFIX", "1", "doc:"];
          const schema = ["SCHEMA", "$.title", "AS", "title", "TEXT"];
          expect(await redisCli(true, ...create, ...schema), "FT.CREATE").toBe("OK");
          const doc = JSON.stringify({ title: "hello world" });
          expect(await redisCli(true, "JSON.SET", "doc:1", "$", doc), "JSON.SET").toBe("OK");
          expect(await redisCli(true, "FT.SEARCH", "idx", "hello"), "FT.SEARCH").toMatch(
            /^1\s+doc:1/,
          );
          // A queue keeps an append-only file.
          expect(await redisCli(true, "CONFIG", "GET", "appendonly")).toBe("appendonly\nyes");
          // The image's entrypoint, reached through `sh -c`, still dropped root.
          const status = await exec("cat", "/proc/1/status");
          const uid = /^Uid:\s+(\d+)/m.exec(status.stdout)?.[1];
          expect(uid, "the user of redis-server").toBeDefined();
          expect(uid, "redis-server runs as root").not.toBe("0");
        },
        TWO_MINUTES,
      );

      it.runIf(kind === "dragonfly")(
        "runs a BullMQ-style script under its hashtag locks, with its memory from the limit",
        async () => {
          const reply = await redisCli(
            true,
            "EVAL",
            BULLMQ_STYLE_SCRIPT,
            "1",
            "{myqueue}:wait",
            "job-1",
          );
          expect(reply, "the script's reply").toBe("1");
          expect(await redisCli(true, "GET", "{myqueue}:id")).toBe("1");
          // Three quarters of the limit.
          const maxmemory = Math.floor(spec.memory.defaultMb * 0.75) * 1024 * 1024;
          expect(await redisCli(true, "CONFIG", "GET", "maxmemory")).toBe(
            `maxmemory\n${maxmemory}`,
          );
        },
        TWO_MINUTES,
      );

      it(
        "has the tools and volumes the catalog relies on",
        async () => {
          if (kind === "opensearch" || kind === "elasticsearch") {
            const curl = await exec("curl", "--version");
            expect(curl.exitCode, `curl in the ${kind} image: ${curl.stderr}`).toBe(0);
          }
          if (kind === "opensearch") {
            // Its login's setup, from the image's folder.
            const tools = await exec(
              "bash",
              "-c",
              "command -v keytool && test -x plugins/opensearch-security/tools/hash.sh",
            );
            expect(
              tools.exitCode,
              `keytool and hash.sh in the OpenSearch image: ${tools.stderr}`,
            ).toBe(0);
            const config = await exec("ls", "-1A", "/usr/share/opensearch/config");
            expect(config.exitCode, config.stderr).toBe(0);
            const pem = config.stdout.split(/\r?\n/).filter((file) => file.endsWith(".pem"));
            expect(pem, "demo certificates").toEqual([]);
          }
          if (kind === "typesense" || kind === "neo4j") {
            const open = await exec(
              "bash",
              "-c",
              `exec 3<>/dev/tcp/127.0.0.1/${kind === "neo4j" ? 7474 : 8108}`,
            );
            expect(open.exitCode, `bash with /dev/tcp in the ${kind} image: ${open.stderr}`).toBe(
              0,
            );
          }
          if (kind === "neo4j") {
            const volumes = engine().mounts.filter((m) => m.type === "volume");
            expect(
              volumes.map((m) => `${m.destination} ${m.name}`).sort(),
              "Neo4j's volumes: none anonymous",
            ).toEqual([`/data ${project.name}_neo4j-data`, `/logs ${project.name}_neo4j-logs`]);
          }
          if (kind === "meilisearch") {
            const wget = await exec("sh", "-c", 'readlink -f "$(command -v wget)"');
            expect(wget.stdout.trim(), `wget in the Meilisearch image: ${wget.stderr}`).toBe(
              "/bin/busybox",
            );
          }
          if (kind === "clickhouse") {
            const wget = await exec("wget", "-q", "-O-", "http://127.0.0.1:8123/ping");
            expect(wget.stdout.trim(), `wget in the ClickHouse image: ${wget.stderr}`).toBe("Ok.");
            // The server started with OpsCrew's `remove="1"` on log tables, also on those the
            // image's own config.xml does not define, and none is left in its merged config.
            const settings = runtimeFiles(plan).get("services/clickhouse/server.xml") ?? "";
            const removed = [...settings.matchAll(/<(\w+) remove="1" \/>/g)].map(
              (match) => match[1] as string,
            );
            expect(removed.length, "the log tables OpsCrew turns off").toBeGreaterThan(0);
            /** The removed tables `file` defines, outside its comments. */
            const defined = async (file: string) => {
              const found = await exec("cat", file);
              expect(found.exitCode, `${file}: ${found.stderr}`).toBe(0);
              const xml = found.stdout.replace(/<!--[\s\S]*?-->/g, "");
              return removed.filter((table) => xml.includes(`<${table}>`));
            };
            const own = await defined("/etc/clickhouse-server/config.xml");
            const undefinedHere = removed.filter((table) => !own.includes(table));
            console.info(
              `${kind}: OpsCrew turns off ${removed.join(", ")}; the image's config.xml does not define ${undefinedHere.join(", ") || "any of them"}`,
            );
            expect(
              await defined("/var/lib/clickhouse/preprocessed_configs/config.xml"),
              "log tables left in the merged config",
            ).toEqual([]);
          }
        },
        TWO_MINUTES,
      );

      it.runIf(LOGIN_CASES.includes(kind))(
        "refuses a client without its login and serves one with it, after a restart",
        async () => {
          await composeOk(project, `restarting ${kind}`, ["restart", kind]);
          await up(kind);
          await checkLogin("restart");
        },
        TEN_MINUTES + TWO_MINUTES,
      );

      it.runIf(LOGIN_CASES.includes(kind))(
        "refuses a client without its login and serves one with it, after the container is recreated",
        async () => {
          await up("--force-recreate", kind);
          await checkLogin("recreate");
        },
        TEN_MINUTES + TWO_MINUTES,
      );

      it.runIf(LOGIN_CASES.includes(kind))(
        "keeps the data written without a login once the login is turned on, and asks for it",
        async () => {
          await composeOk(project, "removing the project", ["down", "-v", "--remove-orphans"]);
          const before = withoutLogin();
          await writeProject(before.file, before.env);
          await up(...steady);
          if (kind === "opensearch") {
            const written = await status(
              "http://opensearch:9200/kept/_doc/1?refresh=true",
              ...["-X", "PUT", "-H", "Content-Type: application/json", "-d", '{"kept":true}'],
            );
            expect(written, "a document written without a login").toBe("201");
          } else {
            const produced = await broker(before.app, "produce", "kept");
            expect(
              produced.exitCode,
              `producing without a login:\n${tail(produced.output, 20)}`,
            ).toBe(0);
          }
          await writeProject(localServerCompose(plan), serviceEnv);
          await up(kind);
          await checkLogin("login-on");
          const app = environment?.values.app ?? {};
          if (kind === "opensearch") {
            expect(await status(`${app.OPENSEARCH_URL}/kept/_doc/1`), "the document").toBe("200");
          } else {
            await expectMessage(app, "kept");
          }
        },
        2 * TEN_MINUTES,
      );
    });
  },
);
