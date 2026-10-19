// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax in expected values, not JavaScript templates.
import type { DeployPlan, SelfHostedServiceKind } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { IMAGES } from "../pins";
import { GARAGE_STORAGE, withServices } from "./__fixtures__/plans";
import {
  CATALOG,
  checkServiceVersion,
  initStepsFor,
  pinnedVersion,
  SERVICE_SPECS,
  serviceSpec,
} from "./index";
import type { ServiceContext } from "./types";

const PART_ONE_KINDS: SelfHostedServiceKind[] = [
  "postgres",
  "valkey",
  "mysql",
  "mariadb",
  "mongodb",
  "rabbitmq",
  "nats",
  "kafka",
  "redpanda",
  "garage",
];

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
  it("has one entry per part 1 kind, each pinned by digest on the version of its pin", () => {
    expect(SERVICE_SPECS.map((spec) => spec.kind)).toEqual(PART_ONE_KINDS);
    for (const kind of PART_ONE_KINDS) {
      const spec = CATALOG[kind];
      expect(spec?.kind).toBe(kind);
      if (spec === undefined) continue;
      expect(IMAGES[spec.image].ref).toMatch(/:[^:@]+@sha256:[0-9a-f]{64}$/);
      expect(`${pinnedVersion(spec)}.`.startsWith(`${spec.defaultVersion}.`)).toBe(true);
      expect(spec.targets).toEqual(["server", "portainer"]);
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
      mysql: [512, 384, 1024],
      mariadb: [384, 256, 1024],
      mongodb: [512, 384, 1024],
      rabbitmq: [384, 256, 1024],
      nats: [64, 32, 512],
      kafka: [1024, 768, 2048],
      redpanda: [1536, 1024, 2048],
      garage: [64, 32, 512],
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
      mysql: ["GPL-2.0", false],
      mariadb: ["GPL-2.0", false],
      mongodb: ["SSPL-1.0", false],
      rabbitmq: ["MPL-2.0", true],
      nats: ["Apache-2.0", true],
      kafka: ["Apache-2.0", true],
      redpanda: ["BSL-1.1", false],
      garage: ["AGPL-3.0", false],
    });
    for (const spec of SERVICE_SPECS) {
      if (spec.licence.permissive) {
        expect(spec.licence.note).toBeUndefined();
      } else {
        expect(spec.licence.note).toMatch(new RegExp(`^${spec.title} is under .*your (own )?app`));
        expect(spec.licence.note?.split(". ")).toHaveLength(1);
      }
    }
  });

  it("logs the app in with a password, a token or a key, or keeps the service internal only", () => {
    expect(Object.fromEntries(SERVICE_SPECS.map((spec) => [spec.kind, spec.auth]))).toEqual({
      postgres: "password",
      valkey: "internal-only",
      mysql: "password",
      mariadb: "password",
      mongodb: "password",
      rabbitmq: "password",
      nats: "token",
      kafka: "internal-only",
      redpanda: "internal-only",
      garage: "key",
    });
    for (const spec of SERVICE_SPECS) {
      expect(spec.secrets.length > 0).toBe(spec.auth !== "internal-only");
    }
    expect(serviceSpec("garage").secrets).toContainEqual({
      name: "key-id",
      format: "garage-key-id",
    });
  });

  it("refuses a kind it cannot run yet", () => {
    expect(() => serviceSpec("opensearch")).toThrow(
      "This version of OpsCrew cannot run opensearch next to the app yet.",
    );
  });

  it("puts no secret in a settings file, a command or a setup step", () => {
    const plan = withServices(
      [
        ...PART_ONE_KINDS.filter((kind) => kind !== "mongodb").map((kind) => ({ kind })),
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
      return serviceSpec(kind).appVariables(c);
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
    expect(vars("valkey")).toEqual({ REDIS_URL: "redis://cache:6379" });
    expect(vars("garage")).toEqual({
      AWS_ACCESS_KEY_ID: "<key-id>",
      AWS_SECRET_ACCESS_KEY: "<secret-key>",
      AWS_REGION: "garage",
      AWS_ENDPOINT_URL_S3: "http://garage:3900",
    });
  });

  it("give the app's own detected variable the same address", () => {
    const plan = withServices([{ kind: "mysql" }]);
    expect(serviceSpec("mysql").appVariables(ctx(plan, "mysql", "MYSQL_URL"))).toEqual({
      DATABASE_URL: "mysql://app:<password>@mysql:3306/app",
      MYSQL_URL: "mysql://app:<password>@mysql:3306/app",
    });
  });

  it("leave REDIS_URL to a queue instance, so a separate cache gets only its own variable", () => {
    const plan = withServices([
      { kind: "valkey", options: { mode: "queue" } },
      { kind: "valkey", options: { mode: "cache" } },
    ]);
    const valkey = serviceSpec("valkey");
    expect(valkey.appVariables(ctx(plan, "queue"))).toEqual({ REDIS_URL: "redis://queue:6379" });
    expect(valkey.appVariables(ctx(plan, "cache", "CACHE_URL"))).toEqual({
      CACHE_URL: "redis://cache:6379",
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

  it("Valkey: a queue never evicts and keeps an append-only file; a cache evicts and keeps nothing", () => {
    const valkey = serviceSpec("valkey");
    expect(valkey.command?.(only("valkey", { options: { mode: "queue" }, memoryMb: 128 }))).toEqual(
      [
        "valkey-server",
        "--appendonly",
        "yes",
        "--maxmemory",
        "96mb",
        "--maxmemory-policy",
        "noeviction",
      ],
    );
    expect(valkey.command?.(only("valkey", { memoryMb: 256 }))).toEqual([
      "valkey-server",
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory",
      "192mb",
      "--maxmemory-policy",
      "allkeys-lru",
    ]);
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
    expect(garage.command?.(c)).toEqual(["/garage", "server", "--single-node"]);
    expect(garage.environment(c)).toEqual({
      GARAGE_RPC_SECRET: "<rpc-secret>",
      GARAGE_DEFAULT_ACCESS_KEY: "<key-id>",
      GARAGE_DEFAULT_SECRET_KEY: "<secret-key>",
    });
    expect(garage.healthcheck.test).toEqual(["CMD", "/garage", "status"]);
  });

  it("Garage: imports the app's key and makes its bucket, each step checked first", () => {
    const plan = withServices([{ kind: "garage" }], { storage: GARAGE_STORAGE });
    expect(serviceSpec("garage").init?.(ctx(plan, "garage"))).toEqual([
      {
        service: "garage",
        envFile: "garage.env",
        check: ["/garage", "key", "info", "${GARAGE_DEFAULT_ACCESS_KEY}"],
        run: [
          "/garage",
          "key",
          "import",
          "--yes",
          "-n",
          "shop",
          "${GARAGE_DEFAULT_ACCESS_KEY}",
          "${GARAGE_DEFAULT_SECRET_KEY}",
        ],
      },
      {
        service: "garage",
        check: ["/garage", "bucket", "info", "shop-uploads"],
        run: ["/garage", "bucket", "create", "shop-uploads"],
      },
      {
        service: "garage",
        envFile: "garage.env",
        run: [
          "/garage",
          "bucket",
          "allow",
          "--read",
          "--write",
          "--owner",
          "shop-uploads",
          "--key",
          "${GARAGE_DEFAULT_ACCESS_KEY}",
        ],
      },
    ]);
    // Without a Garage bucket in the plan, only the key.
    expect(serviceSpec("garage").init?.(only("garage"))).toHaveLength(1);
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
        { kind: "garage" },
        { kind: "postgres" },
        { kind: "mongodb", options: { replicaSet: true } },
        { kind: "mongodb", name: "off", enabled: false, options: { replicaSet: true } },
      ],
      { storage: GARAGE_STORAGE },
    );
    expect(initStepsFor(plan).map((step) => [step.service, step.run.slice(0, 3)])).toEqual([
      ["garage", ["/garage", "key", "import"]],
      ["garage", ["/garage", "bucket", "create"]],
      ["garage", ["/garage", "bucket", "allow"]],
      ["mongodb", ["bash", "-c", expect.stringContaining("rs.initiate")]],
    ]);
    expect(initStepsFor(withServices([{ kind: "postgres" }]))).toEqual([]);
  });
});
