// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax in expected values, not JavaScript templates.
import {
  type DeployPlan,
  type SelfHostedServiceKind,
  SelfHostedServiceKindSchema,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { IMAGES } from "../pins";
import { GARAGE_STORAGE, withServices } from "./__fixtures__/plans";
import {
  appVariables,
  CATALOG,
  checkServiceVersion,
  hostSysctl,
  initStepsFor,
  pinnedVersion,
  SERVICE_SPECS,
  serviceSpec,
} from "./index";
import type { ServiceContext } from "./types";

const PART_ONE_KINDS: SelfHostedServiceKind[] = [
  "postgres",
  "valkey",
  "redis",
  "dragonfly",
  "mysql",
  "mariadb",
  "mongodb",
  "rabbitmq",
  "nats",
  "kafka",
  "redpanda",
  "garage",
];

const PART_TWO_KINDS: SelfHostedServiceKind[] = [
  "opensearch",
  "elasticsearch",
  "meilisearch",
  "typesense",
  "clickhouse",
  "neo4j",
];

/** The engines that need a host kernel setting, which a Portainer stack cannot make. */
const HOST_SETTING_KINDS: SelfHostedServiceKind[] = ["opensearch", "elasticsearch"];

/** The context of the plan's service `name`, its secrets as `<name>`. */
function ctx(plan: DeployPlan, name: string, variable?: string): ServiceContext {
  const service = plan.services.find((s) => s.name === name);
  if (service === undefined) throw new Error(`no service ${name}`);
  return {
    plan,
    service,
    secretRef: (secret) => `<${secret}>`,
    ...(variable === undefined ? {} : { variable }),
  };
}

/** The context of one service of `kind` (with `fields`) in an otherwise empty plan. */
function only(kind: SelfHostedServiceKind, fields: Record<string, unknown> = {}): ServiceContext {
  const plan = withServices([{ kind, ...fields }]);
  return ctx(plan, plan.services[0]?.name as string);
}

describe("the catalog", () => {
  it("has one entry per kind, each pinned by digest on the version of its pin", () => {
    expect(SERVICE_SPECS.map((spec) => spec.kind)).toEqual([...PART_ONE_KINDS, ...PART_TWO_KINDS]);
    for (const kind of SelfHostedServiceKindSchema.options) {
      const spec = CATALOG[kind];
      expect(spec?.kind).toBe(kind);
      expect(IMAGES[spec.image].ref).toMatch(/:[^:@]+@sha256:[0-9a-f]{64}$/);
      expect(`${pinnedVersion(spec)}.`.startsWith(`${spec.defaultVersion}.`)).toBe(true);
      // A new major of each engine may not read the data an older one wrote; Neo4j's "majors"
      // are calendar years.
      expect(spec.majorLocked).toBe(kind !== "valkey" && kind !== "neo4j");
    }
  });

  it("runs the engines that need a host kernel setting on servers only", () => {
    for (const spec of SERVICE_SPECS) {
      const needsHost = HOST_SETTING_KINDS.includes(spec.kind);
      expect(spec.hostSettings).toEqual(
        needsHost ? { sysctl: { "vm.max_map_count": "262144" } } : undefined,
      );
      expect(spec.targets).toEqual(needsHost ? ["server"] : ["server", "portainer"]);
    }
  });

  it("gives each service the memory research measured room for (default, minimum, smallest server)", () => {
    expect(
      Object.fromEntries(
        SERVICE_SPECS.map((spec) => [
          spec.kind,
          [spec.memory.defaultMb, spec.memory.minimumMb, spec.memory.smallestServerMb],
        ]),
      ),
    ).toEqual({
      postgres: [512, 256, 1024],
      valkey: [128, 64, 512],
      redis: [128, 64, 512],
      dragonfly: [512, 384, 2048],
      mysql: [512, 384, 1024],
      mariadb: [384, 256, 1024],
      mongodb: [512, 384, 1024],
      rabbitmq: [384, 256, 1024],
      nats: [64, 32, 512],
      kafka: [1024, 768, 2048],
      redpanda: [1536, 1024, 2048],
      garage: [64, 32, 512],
      opensearch: [1024, 768, 4096],
      elasticsearch: [1024, 768, 4096],
      meilisearch: [512, 256, 2048],
      typesense: [512, 256, 2048],
      clickhouse: [1024, 768, 2048],
      neo4j: [1536, 1024, 4096],
    });
  });

  it("names each licence, with a plain note for each that is not permissive", () => {
    expect(
      Object.fromEntries(
        SERVICE_SPECS.map((spec) => [spec.kind, [spec.licence.id, spec.licence.permissive]]),
      ),
    ).toEqual({
      postgres: ["PostgreSQL", true],
      valkey: ["BSD-3-Clause", true],
      redis: ["RSALv2 OR SSPL-1.0 OR AGPL-3.0-only", false],
      dragonfly: ["BSL-1.1", false],
      mysql: ["GPL-2.0", false],
      mariadb: ["GPL-2.0", false],
      mongodb: ["SSPL-1.0", false],
      rabbitmq: ["MPL-2.0", true],
      nats: ["Apache-2.0", true],
      kafka: ["Apache-2.0", true],
      redpanda: ["BSL-1.1", false],
      garage: ["AGPL-3.0", false],
      opensearch: ["Apache-2.0", true],
      elasticsearch: ["Elastic-2.0", false],
      meilisearch: ["MIT", true],
      typesense: ["GPL-3.0", false],
      clickhouse: ["Apache-2.0", true],
      neo4j: ["GPL-3.0", false],
    });
    for (const spec of SERVICE_SPECS) {
      if (spec.licence.permissive) {
        expect(spec.licence.note).toBeUndefined();
      } else {
        expect(spec.licence.note).toMatch(
          new RegExp(`^${spec.title}('s official image)? is under .*your (own )?app`),
        );
        expect(spec.licence.note?.split(". ")).toHaveLength(1);
      }
    }
  });

  it("logs the app in with a password, a token or a key, or keeps the service internal only", () => {
    expect(Object.fromEntries(SERVICE_SPECS.map((spec) => [spec.kind, spec.auth]))).toEqual({
      postgres: "password",
      valkey: "password",
      redis: "password",
      dragonfly: "password",
      mysql: "password",
      mariadb: "password",
      mongodb: "password",
      rabbitmq: "password",
      nats: "token",
      kafka: "internal-only",
      redpanda: "internal-only",
      garage: "key",
      opensearch: "internal-only",
      elasticsearch: "password",
      meilisearch: "key",
      typesense: "key",
      clickhouse: "password",
      neo4j: "password",
    });
    for (const spec of SERVICE_SPECS) {
      expect(spec.secrets.length > 0).toBe(spec.auth !== "internal-only");
    }
    expect(serviceSpec("garage").secrets).toContainEqual({
      name: "key-id",
      format: "garage-key-id",
    });
  });

  it("puts no secret in a settings file, a command or a setup step", () => {
    const plan = withServices(
      [
        ...[...PART_ONE_KINDS, ...PART_TWO_KINDS]
          .filter((kind) => kind !== "mongodb")
          .map((kind) => ({ kind, name: kind })),
        { kind: "mongodb", options: { replicaSet: true } },
      ],
      { storage: GARAGE_STORAGE },
    );
    for (const service of plan.services) {
      const spec = serviceSpec(service.kind);
      const strict: ServiceContext = {
        plan,
        service,
        secretRef: () => {
          throw new Error("a secret");
        },
      };
      expect(() => spec.configFiles?.(strict)).not.toThrow();
      expect(() => spec.command?.(strict)).not.toThrow();
      expect(() => spec.init?.(strict)).not.toThrow();
    }
  });
});

describe("the app's variables", () => {
  it("are each service's address under the conventional names, with the right scheme", () => {
    const vars = (kind: SelfHostedServiceKind, fields: Record<string, unknown> = {}) => {
      const c = only(kind, fields);
      return appVariables(c);
    };
    expect(vars("postgres")).toEqual({ DATABASE_URL: "postgresql://app:<password>@db:5432/app" });
    expect(vars("mysql")).toEqual({ DATABASE_URL: "mysql://app:<password>@mysql:3306/app" });
    expect(vars("mariadb")).toEqual({ DATABASE_URL: "mysql://app:<password>@mariadb:3306/app" });
    const mongo = "mongodb://app:<password>@mongodb:27017/app?authSource=admin";
    expect(vars("mongodb")).toEqual({ DATABASE_URL: mongo, MONGODB_URI: mongo });
    expect(vars("mongodb", { options: { replicaSet: true } }).MONGODB_URI).toBe(
      `${mongo}&replicaSet=rs0`,
    );
    const amqp = "amqp://app:<password>@rabbitmq:5672/%2F";
    expect(vars("rabbitmq")).toEqual({ AMQP_URL: amqp, RABBITMQ_URL: amqp });
    expect(vars("nats")).toEqual({ NATS_URL: "nats://<token>@nats:4222" });
    const kafka = { KAFKA_BROKERS: "kafka:9092", KAFKA_BOOTSTRAP_SERVERS: "kafka:9092" };
    expect(vars("kafka")).toEqual(kafka);
    expect(vars("redpanda")).toEqual({
      KAFKA_BROKERS: "redpanda:9092",
      KAFKA_BOOTSTRAP_SERVERS: "redpanda:9092",
    });
    expect(vars("valkey")).toEqual({ REDIS_URL: "redis://:<password>@cache:6379" });
    expect(vars("redis")).toEqual({ REDIS_URL: "redis://:<password>@cache:6379" });
    expect(vars("dragonfly", { options: { mode: "queue" } })).toEqual({
      REDIS_URL: "redis://:<password>@queue:6379",
    });
    expect(vars("garage")).toEqual({
      AWS_ACCESS_KEY_ID: "<key-id>",
      AWS_SECRET_ACCESS_KEY: "<secret-key>",
      AWS_REGION: "garage",
      AWS_ENDPOINT_URL_S3: "http://garage:3900",
    });
    expect(vars("opensearch")).toEqual({ OPENSEARCH_URL: "http://opensearch:9200" });
    expect(vars("elasticsearch")).toEqual({
      ELASTICSEARCH_URL: "http://elastic:<password>@elasticsearch:9200",
    });
    expect(vars("meilisearch")).toEqual({
      MEILISEARCH_HOST: "http://meilisearch:7700",
      MEILISEARCH_KEY: "<master-key>",
    });
    expect(vars("typesense")).toEqual({
      TYPESENSE_HOST: "typesense",
      TYPESENSE_PORT: "8108",
      TYPESENSE_PROTOCOL: "http",
      TYPESENSE_API_KEY: "<api-key>",
    });
    expect(vars("clickhouse")).toEqual({
      CLICKHOUSE_URL: "http://app:<password>@clickhouse:8123/app",
      CLICKHOUSE_USER: "app",
      CLICKHOUSE_PASSWORD: "<password>",
    });
    expect(vars("neo4j")).toEqual({
      NEO4J_URI: "bolt://neo4j:7687",
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: "<password>",
    });
  });

  it("give a search engine's own detected variable its address", () => {
    const plan = withServices([{ kind: "typesense" }]);
    expect(appVariables(ctx(plan, "typesense", "SEARCH_URL")).SEARCH_URL).toBe(
      "http://typesense:8108",
    );
  });

  it("give the app's own detected variable the same address", () => {
    const plan = withServices([{ kind: "mysql" }]);
    const c = ctx(plan, "mysql", "MYSQL_URL");
    expect(appVariables(c)).toEqual({
      DATABASE_URL: "mysql://app:<password>@mysql:3306/app",
      MYSQL_URL: "mysql://app:<password>@mysql:3306/app",
    });
    expect(serviceSpec("mysql").address(c)).toBe("mysql://app:<password>@mysql:3306/app");
  });

  it("leave REDIS_URL to a queue instance, so a separate cache gets only its own variable", () => {
    const plan = withServices([
      { kind: "valkey", options: { mode: "queue" } },
      { kind: "valkey", options: { mode: "cache" } },
    ]);
    expect(appVariables(ctx(plan, "queue"))).toEqual({
      REDIS_URL: "redis://:<password>@queue:6379",
    });
    expect(appVariables(ctx(plan, "cache", "CACHE_URL"))).toEqual({
      CACHE_URL: "redis://:<password>@cache:6379",
    });
    const dragonfly = withServices([
      { kind: "dragonfly", options: { mode: "queue" } },
      { kind: "dragonfly", options: { mode: "cache" } },
    ]);
    expect(appVariables(ctx(dragonfly, "cache", "CACHE_URL"))).toEqual({
      CACHE_URL: "redis://:<password>@cache:6379",
    });
  });
});

describe("the services' settings", () => {
  it("MySQL: a small-server my.cnf sized from its limit", () => {
    const files = (memoryMb: number) =>
      serviceSpec("mysql").configFiles?.(only("mysql", { memoryMb })) ?? [];
    const [cnf] = files(512);
    expect(cnf?.name).toBe("my.cnf");
    expect(cnf?.target).toBe("/etc/mysql/conf.d/opscrew.cnf");
    expect(cnf?.content).toContain(
      [
        "[mysqld]",
        "innodb_buffer_pool_size = 128M",
        "innodb_buffer_pool_instances = 1",
        "performance_schema = OFF",
        "max_connections = 50",
      ].join("\n"),
    );
    expect(files(1024)[0]?.content).toContain("innodb_buffer_pool_size = 512M");
    expect(files(2048)[0]?.content).toContain("innodb_buffer_pool_size = 1536M");
  });

  it("RabbitMQ: an absolute memory alarm at 0.4 of its limit, no guest, and its hostname", () => {
    const rabbitmq = serviceSpec("rabbitmq");
    const c = only("rabbitmq");
    const [conf] = rabbitmq.configFiles?.(c) ?? [];
    expect(conf?.name).toBe("rabbitmq.conf");
    // Loaded after the image's 10-defaults.conf, which lets guest log in from anywhere.
    expect(conf?.target).toBe("/etc/rabbitmq/conf.d/90-opscrew.conf");
    expect(conf?.content).toContain("vm_memory_high_watermark.absolute = 153MB\n");
    expect(conf?.content).toContain("loopback_users.guest = true\n");
    expect(rabbitmq.environment(c)).toEqual({
      RABBITMQ_DEFAULT_USER: "app",
      RABBITMQ_DEFAULT_PASS: "<password>",
    });
    expect(rabbitmq.hostname).toBe(true);
  });

  it("NATS: always OpsCrew's own config, with token login and JetStream on its data volume", () => {
    const nats = serviceSpec("nats");
    const c = only("nats");
    const [conf] = nats.configFiles?.(c) ?? [];
    expect(conf?.target).toBe("/etc/nats/nats-server.conf");
    expect(nats.command?.(c)).toEqual(["nats-server", "--config", "/etc/nats/nats-server.conf"]);
    expect(conf?.content).toContain("  token: $NATS_TOKEN\n");
    expect(conf?.content).toContain("  store_dir: /data\n");
    expect(conf?.content).toContain('http: "127.0.0.1:8222"\n');
    expect(nats.dataDir).toBe("/data");
    expect(nats.environment(c)).toEqual({ NATS_TOKEN: "<token>" });
    expect(nats.healthcheck.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "-O-",
      "http://127.0.0.1:8222/healthz",
    ]);
  });

  it("MongoDB: its cache from its limit, and a keyFile and replica set when asked", () => {
    const mongodb = serviceSpec("mongodb");
    expect(mongodb.command?.(only("mongodb"))).toEqual([
      "mongod",
      "--wiredTigerCacheSizeGB",
      "0.25",
      "--bind_ip_all",
    ]);
    expect(mongodb.command?.(only("mongodb", { memoryMb: 1024 }))?.[2]).toBe("0.5");
    expect(mongodb.command?.(only("mongodb", { memoryMb: 384 }))?.[2]).toBe("0.25");
    expect(mongodb.dataDir).toEqual({ db: "/data/db", configdb: "/data/configdb" });

    const replica = only("mongodb", { options: { replicaSet: true } });
    const [bash, flag, script] = mongodb.command?.(replica) ?? [];
    expect([bash, flag]).toEqual(["bash", "-c"]);
    // Written once, as root, into the configdb volume; then the image's own entrypoint.
    expect(script).toBe(
      "set -e; [ -f /data/configdb/keyfile ] || { head -c 756 /dev/urandom | base64 -w 0 > /data/configdb/keyfile && chmod 400 /data/configdb/keyfile && chown 999:999 /data/configdb/keyfile; }; exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /data/configdb/keyfile --wiredTigerCacheSizeGB 0.25 --bind_ip_all",
    );
    expect(mongodb.init?.(only("mongodb"))).toEqual([]);
  });

  it("MongoDB: the replica set is initiated once, with the service's name as its member", () => {
    const plan = withServices([{ kind: "mongodb", name: "docs", options: { replicaSet: true } }]);
    const [step, ...rest] = serviceSpec("mongodb").init?.(ctx(plan, "docs")) ?? [];
    expect(rest).toEqual([]);
    const login =
      'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
    expect(step).toEqual({
      service: "docs",
      check: ["bash", "-c", `${login} --eval 'rs.status().ok'`],
      run: [
        "bash",
        "-c",
        `${login} --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "docs:27017" }] }); for (let i = 0; i < 60 && !db.hello().isWritablePrimary; i++) sleep(500)'`,
      ],
    });
  });

  it("Valkey: its modes behind its password, read from a settings file it writes at start", () => {
    const valkey = serviceSpec("valkey");
    const queue = only("valkey", { options: { mode: "queue" }, memoryMb: 128 });
    // The password goes into a file valkey-server reads, never onto its command line; the
    // entrypoint drops root only for a command that is valkey-server.
    const auth =
      "umask 077 && printf 'requirepass %s\\n' \"$VALKEY_PASSWORD\" > /tmp/opscrew-auth.conf && chown valkey:valkey /tmp/opscrew-auth.conf && exec docker-entrypoint.sh valkey-server /tmp/opscrew-auth.conf";
    // A queue never evicts and keeps an append-only file; a cache evicts and keeps nothing.
    expect(valkey.command?.(queue)).toEqual([
      "sh",
      "-c",
      `${auth} --appendonly yes --maxmemory 96mb --maxmemory-policy noeviction`,
    ]);
    expect(valkey.command?.(only("valkey", { memoryMb: 256 }))?.[2]).toBe(
      `${auth} --save '' --appendonly no --maxmemory 192mb --maxmemory-policy allkeys-lru`,
    );
    expect(valkey.environment(queue)).toEqual({ VALKEY_PASSWORD: "<password>" });
    expect(valkey.secrets).toEqual([{ name: "password", format: "hex32" }]);
    expect(valkey.healthcheck.test).toEqual([
      "CMD-SHELL",
      'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli ping | grep -q PONG',
    ]);
    expect(valkey.dataDir).toBe("/data");
  });

  it("Redis 8: Valkey's modes behind its password, through the image's own entrypoint", () => {
    const redis = serviceSpec("redis");
    const queue = only("redis", { options: { mode: "queue" }, memoryMb: 128 });
    // The password goes into a file redis-server reads, never onto its command line; the
    // entrypoint loads the modules and drops root only for a command that is redis-server.
    const auth =
      "umask 077 && printf 'requirepass %s\\n' \"$REDIS_PASSWORD\" > /tmp/opscrew-auth.conf && chown redis:redis /tmp/opscrew-auth.conf && exec docker-entrypoint.sh redis-server /tmp/opscrew-auth.conf";
    expect(redis.command?.(queue)).toEqual([
      "sh",
      "-c",
      `${auth} --appendonly yes --maxmemory 96mb --maxmemory-policy noeviction`,
    ]);
    expect(redis.command?.(only("redis", { memoryMb: 256 }))?.[2]).toBe(
      `${auth} --save '' --appendonly no --maxmemory 192mb --maxmemory-policy allkeys-lru`,
    );
    expect(redis.environment(queue)).toEqual({ REDIS_PASSWORD: "<password>" });
    expect(redis.secrets).toEqual([{ name: "password", format: "hex32" }]);
    // redis-cli answers NOAUTH with exit code 0, so the check reads the reply.
    expect(redis.healthcheck.test).toEqual([
      "CMD-SHELL",
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -q PONG',
    ]);
    expect(redis.dataDir).toBe("/data");
  });

  it("Dragonfly: its threads and memory from its limit, snapshots in queue mode, BullMQ's locks", () => {
    const dragonfly = serviceSpec("dragonfly");
    const command = (memoryMb: number, options: object) =>
      dragonfly.command?.(only("dragonfly", { memoryMb, options }));
    // Three quarters of the limit, and a thread for each 256 MB of it (at least one); no HTTP
    // console on its port.
    expect(command(512, { mode: "queue" })).toEqual([
      "dragonfly",
      "--logtostderr",
      "--proactor_threads=1",
      "--maxmemory=384mb",
      "--primary_port_http_enabled=false",
      "--dbfilename=dump",
      "--snapshot_cron=* * * * *",
    ]);
    expect(command(384, { mode: "cache" })).toEqual([
      "dragonfly",
      "--logtostderr",
      "--proactor_threads=1",
      "--maxmemory=288mb",
      "--primary_port_http_enabled=false",
      "--cache_mode=true",
      "--dbfilename=",
    ]);
    // At most the server's vCPUs, and 2 when design does not know them.
    const threads = (memoryMb: number, vcpus?: number) =>
      command(memoryMb, { mode: "cache", ...(vcpus === undefined ? {} : { threads: vcpus }) })?.[2];
    expect(command(2048, { mode: "cache", threads: 8 })?.slice(2, 4)).toEqual([
      "--proactor_threads=6",
      "--maxmemory=1536mb",
    ]);
    expect(threads(2048, 4)).toBe("--proactor_threads=4");
    expect(threads(2048)).toBe("--proactor_threads=2");
    expect(threads(512, 4)).toBe("--proactor_threads=1");
    expect(command(512, { mode: "queue", lockOnHashtags: true })?.slice(-2)).toEqual([
      "--cluster_mode=emulated",
      "--lock_on_hashtags",
    ]);
    // Its smallest limit holds the 256 MB a thread needs with a quarter to spare.
    expect(Math.floor(dragonfly.memory.minimumMb * 0.75)).toBeGreaterThanOrEqual(256);
    expect(dragonfly.environment(only("dragonfly"))).toEqual({ DFLY_requirepass: "<password>" });
    expect(dragonfly.healthcheck.test).toEqual([
      "CMD-SHELL",
      'REDISCLI_AUTH="$DFLY_requirepass" redis-cli ping | grep -q PONG',
    ]);
    expect(dragonfly.dataDir).toBe("/data");
  });

  it("Kafka: one KRaft node, with the heap and retention from the plan, in a named volume", () => {
    const kafka = serviceSpec("kafka");
    const env = kafka.environment(only("kafka"));
    expect(env.KAFKA_HEAP_OPTS).toBe("-Xmx512m -Xms512m");
    expect(env.KAFKA_PROCESS_ROLES).toBe("broker,controller");
    expect(env.KAFKA_ADVERTISED_LISTENERS).toBe("PLAINTEXT://kafka:9092");
    expect(env.KAFKA_LISTENERS).toBe("PLAINTEXT://:9092,CONTROLLER://localhost:9093");
    expect(env.KAFKA_LOG_RETENTION_HOURS).toBe("168");
    expect(env.KAFKA_LOG_RETENTION_BYTES).toBeUndefined();
    expect(env.CLUSTER_ID).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(kafka.environment(only("kafka")).CLUSTER_ID).toBe(env.CLUSTER_ID);

    const bounded = kafka.environment(
      only("kafka", { memoryMb: 768, options: { retentionHours: 24, retentionGb: 5 } }),
    );
    expect(bounded.KAFKA_HEAP_OPTS).toBe("-Xmx384m -Xms384m");
    expect(bounded.KAFKA_LOG_RETENTION_HOURS).toBe("24");
    expect(bounded.KAFKA_LOG_RETENTION_BYTES).toBe(String(5 * 1024 ** 3));
    // The image runs as uid 1000: a folder Docker makes for a bind mount would be root's.
    expect(kafka.namedVolume).toBe(true);
    expect(kafka.secrets).toEqual([]);
  });

  it("Redpanda: one core with its own memory below the limit, advertised by its name", () => {
    const redpanda = serviceSpec("redpanda");
    const command = redpanda.command?.(only("redpanda")) ?? [];
    expect(command.slice(0, 2)).toEqual(["redpanda", "start"]);
    expect(command.join(" ")).toContain("--smp 1 --memory 1024M --reserve-memory 0M");
    expect(command.join(" ")).toContain("--advertise-kafka-addr redpanda:9092");
    expect(command).not.toContain("dev-container");
    expect(redpanda.namedVolume).toBe(true);
  });

  it("Garage: one node from OpsCrew's garage.toml, its secrets only in its environment", () => {
    const garage = serviceSpec("garage");
    const c = only("garage");
    const [toml] = garage.configFiles?.(c) ?? [];
    expect(toml?.target).toBe("/etc/garage.toml");
    expect(toml?.content).toContain('rpc_public_addr = "garage:3901"\n');
    expect(toml?.content).toContain("replication_factor = 1\n");
    expect(toml?.content).not.toMatch(/rpc_secret\s*=/);
    expect(garage.environment(c)).toEqual({
      GARAGE_RPC_SECRET: "<rpc-secret>",
      GARAGE_DEFAULT_ACCESS_KEY: "<key-id>",
      GARAGE_DEFAULT_SECRET_KEY: "<secret-key>",
    });
    expect(garage.healthcheck.test).toEqual(["CMD", "/garage", "status"]);
  });

  it("Garage: makes the app's key, and its bucket when the plan has one, itself when it starts", () => {
    const garage = serviceSpec("garage");
    expect(garage.init).toBeUndefined();
    // Without a Garage bucket in the plan, only the key.
    expect(garage.command?.(only("garage"))).toEqual([
      "/garage",
      "server",
      "--single-node",
      "--default-access-key",
    ]);
    const c = ctx(withServices([{ kind: "garage" }], { storage: GARAGE_STORAGE }), "garage");
    expect(garage.command?.(c)).toEqual(["/garage", "server", "--single-node", "--default-bucket"]);
    expect(garage.environment(c).GARAGE_DEFAULT_BUCKET).toBe("shop-uploads");
  });
});

describe("the search and analytics engines' settings", () => {
  it("OpenSearch: one node with the security plugin off and half its limit as heap", () => {
    const opensearch = serviceSpec("opensearch");
    expect(opensearch.environment(only("opensearch"))).toEqual({
      "discovery.type": "single-node",
      DISABLE_SECURITY_PLUGIN: "true",
      DISABLE_INSTALL_DEMO_CONFIG: "true",
      OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m",
    });
    expect(
      opensearch.environment(only("opensearch", { memoryMb: 2048 })).OPENSEARCH_JAVA_OPTS,
    ).toBe("-Xms1024m -Xmx1024m");
    expect(opensearch.healthcheck.test).toEqual([
      "CMD-SHELL",
      "curl -fsS 'localhost:9200/_cluster/health?wait_for_status=yellow&timeout=5s' > /dev/null",
    ]);
    // It runs as uid 1000.
    expect(opensearch.namedVolume).toBe(true);
  });

  it("Elasticsearch: security on with ELASTIC_PASSWORD, plain HTTP inside, no machine learning", () => {
    const elasticsearch = serviceSpec("elasticsearch");
    expect(elasticsearch.environment(only("elasticsearch"))).toEqual({
      "discovery.type": "single-node",
      "xpack.security.enabled": "true",
      "xpack.security.http.ssl.enabled": "false",
      "xpack.security.transport.ssl.enabled": "false",
      "xpack.ml.enabled": "false",
      ELASTIC_PASSWORD: "<password>",
      ES_JAVA_OPTS: "-Xms512m -Xmx512m",
    });
    // The password comes from the container's own environment, never from a file.
    expect(elasticsearch.healthcheck.test[1]).toContain('-u "elastic:$ELASTIC_PASSWORD"');
    expect(elasticsearch.namedVolume).toBe(true);
  });

  it("Meilisearch: production mode with its master key and indexing capped at half its limit", () => {
    expect(serviceSpec("meilisearch").environment(only("meilisearch"))).toEqual({
      MEILI_ENV: "production",
      MEILI_MASTER_KEY: "<master-key>",
      MEILI_HTTP_ADDR: "0.0.0.0:7700",
      MEILI_MAX_INDEXING_MEMORY: "256 MiB",
      MEILI_NO_ANALYTICS: "true",
    });
  });

  it("Typesense: its API key and data folder, checked through bash", () => {
    const typesense = serviceSpec("typesense");
    expect(typesense.environment(only("typesense"))).toEqual({
      TYPESENSE_DATA_DIR: "/data",
      TYPESENSE_API_KEY: "<api-key>",
    });
    expect(typesense.dataDir).toBe("/data");
    expect(typesense.healthcheck.test).toEqual([
      "CMD",
      "bash",
      "-c",
      'exec 3<>/dev/tcp/127.0.0.1/8108 && printf \'GET /health HTTP/1.0\\r\\n\\r\\n\' >&3 && read -r _ code _ <&3 && [ "${code#2}" != "$code" ]',
    ]);
  });

  it("ClickHouse: the low-memory profile, and the app's own user and database", () => {
    const clickhouse = serviceSpec("clickhouse");
    const c = only("clickhouse");
    expect(clickhouse.environment(c)).toEqual({
      CLICKHOUSE_DB: "app",
      CLICKHOUSE_USER: "app",
      CLICKHOUSE_PASSWORD: "<password>",
    });
    const [server, users] = clickhouse.configFiles?.(c) ?? [];
    expect(server?.target).toBe("/etc/clickhouse-server/config.d/opscrew.xml");
    expect(server?.content).toContain(
      `<max_server_memory_usage>${768 * 1024 * 1024}</max_server_memory_usage>`,
    );
    expect(server?.content).toContain(`<mark_cache_size>${128 * 1024 * 1024}</mark_cache_size>`);
    expect(server?.content).toContain('<trace_log remove="1" />');
    expect(server?.content).toMatch(/^<!-- Generated by OpsCrew .* -->\n/);
    expect(server?.content).not.toMatch(/<!--(?:(?!-->)[\s\S])*--(?!>)/);
    expect(users?.target).toBe("/etc/clickhouse-server/users.d/opscrew.xml");
    expect(users?.content).toContain("<max_threads>2</max_threads>");
    expect(clickhouse.healthcheck.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "--spider",
      "http://127.0.0.1:8123/ping",
    ]);
  });

  it("Neo4j: NEO4J_AUTH, and a heap and page cache of a third of its limit each", () => {
    const neo4j = serviceSpec("neo4j");
    expect(neo4j.environment(only("neo4j"))).toEqual({
      NEO4J_AUTH: "neo4j/<password>",
      NEO4J_server_memory_heap_initial__size: "512m",
      NEO4J_server_memory_heap_max__size: "512m",
      NEO4J_server_memory_pagecache_size: "512m",
    });
    expect(neo4j.dataDir).toEqual({ data: "/data", logs: "/logs" });
    expect(neo4j.healthcheck.test.slice(0, 3)).toEqual(["CMD", "bash", "-c"]);
  });

  it("hostSysctl: the kernel settings the plan's enabled services need, once each", () => {
    expect(
      hostSysctl(
        withServices([{ kind: "opensearch" }, { kind: "elasticsearch" }, { kind: "postgres" }]),
      ),
    ).toEqual({ "vm.max_map_count": "262144" });
    expect(hostSysctl(withServices([{ kind: "opensearch", enabled: false }]))).toEqual({});
    expect(hostSysctl(withServices([{ kind: "meilisearch" }]))).toEqual({});
  });
});

describe("the versions", () => {
  it("accept the pinned version at the plan's precision and refuse any other", () => {
    const mysql = only("mysql").service;
    expect(() => checkServiceVersion(mysql, serviceSpec("mysql"))).not.toThrow();
    expect(() => checkServiceVersion(only("kafka").service, serviceSpec("kafka"))).not.toThrow();
    expect(() => checkServiceVersion({ ...mysql, version: "9.7" }, serviceSpec("mysql"))).toThrow(
      "opscrew/plan.yaml asks for MySQL 9.7 (the service mysql), but this version of OpsCrew runs MySQL 8.4.",
    );
    expect(() =>
      checkServiceVersion({ ...mysql, version: "8.4.11" }, serviceSpec("mysql")),
    ).toThrow("MySQL 8.4.11");
  });
});

describe("initStepsFor", () => {
  it("gives the deploy every enabled service's steps, in the plan's order", () => {
    const plan = withServices(
      [
        { kind: "mongodb", name: "first", options: { replicaSet: true } },
        { kind: "garage" },
        { kind: "postgres" },
        { kind: "mongodb", options: { replicaSet: true } },
        { kind: "mongodb", name: "off", enabled: false, options: { replicaSet: true } },
      ],
      { storage: GARAGE_STORAGE },
    );
    expect(initStepsFor(plan).map((step) => [step.service, step.run.slice(0, 3)])).toEqual([
      ["first", ["bash", "-c", expect.stringContaining("rs.initiate")]],
      ["mongodb", ["bash", "-c", expect.stringContaining("rs.initiate")]],
    ]);
    expect(initStepsFor(withServices([{ kind: "postgres" }]))).toEqual([]);
  });
});
