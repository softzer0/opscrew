// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax in expected values, not JavaScript templates.
// Feature 018: a service on another server, reached at its server's private address, and the
// device logins of Valkey, Redis and Dragonfly (T1805, ADR 0022, research R6a).
import type { DeployPlan, SelfHostedServiceKind } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { GARAGE_STORAGE, withPlacement, withServices } from "./__fixtures__/plans";
import {
  appVariables,
  grantHashSecret,
  hostSysctl,
  initStepsFor,
  renderContext,
  serviceSpec,
} from "./index";
import type { ServiceContext } from "./types";

/** The context of the plan's service `name`, its secrets as `<name>`. */
function ctx(plan: DeployPlan, name: string): ServiceContext {
  const service = plan.services.find((s) => s.name === name);
  if (service === undefined) throw new Error(`no service ${name}`);
  return { plan, service, secretRef: (secret) => `<${secret}>` };
}

const KINDS: SelfHostedServiceKind[] = [
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
  "opensearch",
  "elasticsearch",
  "meilisearch",
  "typesense",
  "clickhouse",
  "neo4j",
];

/** One service of each kind, named after it, all on the extra server `data` (10.200.4.2). */
const ELSEWHERE = withPlacement(withServices(KINDS.map((kind) => ({ kind, name: kind }))), {
  servers: { data: "hetzner" },
  placed: Object.fromEntries(KINDS.map((k) => [k, "data"])),
});

describe("a service on another server", () => {
  it.each([
    ["postgres", { DATABASE_URL: "postgresql://app:<password>@10.200.4.2:5432/app" }],
    ["valkey", { REDIS_URL: "redis://:<password>@10.200.4.2:6379" }],
    ["redis", { REDIS_URL: "redis://:<password>@10.200.4.2:6379" }],
    ["dragonfly", { REDIS_URL: "redis://:<password>@10.200.4.2:6379" }],
    ["mysql", { DATABASE_URL: "mysql://app:<password>@10.200.4.2:3306/app" }],
    ["mariadb", { DATABASE_URL: "mysql://app:<password>@10.200.4.2:3306/app" }],
    [
      "mongodb",
      {
        DATABASE_URL: "mongodb://app:<password>@10.200.4.2:27017/app?authSource=admin",
        MONGODB_URI: "mongodb://app:<password>@10.200.4.2:27017/app?authSource=admin",
      },
    ],
    [
      "rabbitmq",
      {
        AMQP_URL: "amqp://app:<password>@10.200.4.2:5672/%2F",
        RABBITMQ_URL: "amqp://app:<password>@10.200.4.2:5672/%2F",
      },
    ],
    ["nats", { NATS_URL: "nats://<token>@10.200.4.2:4222" }],
    ["kafka", { KAFKA_BROKERS: "10.200.4.2:9092", KAFKA_BOOTSTRAP_SERVERS: "10.200.4.2:9092" }],
    ["redpanda", { KAFKA_BROKERS: "10.200.4.2:9092", KAFKA_BOOTSTRAP_SERVERS: "10.200.4.2:9092" }],
    [
      "garage",
      {
        AWS_ACCESS_KEY_ID: "<key-id>",
        AWS_SECRET_ACCESS_KEY: "<secret-key>",
        AWS_REGION: "garage",
        AWS_ENDPOINT_URL_S3: "http://10.200.4.2:3900",
      },
    ],
    ["opensearch", { OPENSEARCH_URL: "http://10.200.4.2:9200" }],
    ["elasticsearch", { ELASTICSEARCH_URL: "http://elastic:<password>@10.200.4.2:9200" }],
    [
      "meilisearch",
      { MEILISEARCH_HOST: "http://10.200.4.2:7700", MEILISEARCH_KEY: "<master-key>" },
    ],
    [
      "typesense",
      {
        TYPESENSE_HOST: "10.200.4.2",
        TYPESENSE_PORT: "8108",
        TYPESENSE_PROTOCOL: "http",
        TYPESENSE_API_KEY: "<api-key>",
      },
    ],
    [
      "clickhouse",
      {
        CLICKHOUSE_URL: "http://app:<password>@10.200.4.2:8123/app",
        CLICKHOUSE_USER: "app",
        CLICKHOUSE_PASSWORD: "<password>",
      },
    ],
    [
      "neo4j",
      {
        NEO4J_URI: "bolt://10.200.4.2:7687",
        NEO4J_USERNAME: "neo4j",
        NEO4J_PASSWORD: "<password>",
      },
    ],
  ] as const)("gives the app %s at its server's private address", (kind, variables) => {
    expect(appVariables(ctx(ELSEWHERE, kind))).toEqual(variables);
  });

  it("covers every kind of the catalog", () => {
    expect(new Set(ELSEWHERE.services.map((s) => s.kind))).toEqual(new Set(KINDS));
  });

  it("gives the app's own detected variable the private address too", () => {
    const c = { ...ctx(ELSEWHERE, "postgres"), variable: "PG_URL" };
    expect(appVariables(c).PG_URL).toBe("postgresql://app:<password>@10.200.4.2:5432/app");
  });

  it("keeps the Compose name for a service on the app's server, next to one placed elsewhere", () => {
    const plan = withPlacement(withServices([{ kind: "postgres" }, { kind: "valkey" }]), {
      servers: { data: "hetzner" },
      placed: { db: "data" },
    });
    expect(appVariables(ctx(plan, "cache"))).toEqual({
      REDIS_URL: "redis://:<password>@cache:6379",
    });
    expect(appVariables(ctx(plan, "db")).DATABASE_URL).toContain("@10.200.4.2:5432/");
  });

  it("Kafka and Redpanda advertise their server's private address", () => {
    expect(
      serviceSpec("kafka").environment(ctx(ELSEWHERE, "kafka")).KAFKA_ADVERTISED_LISTENERS,
    ).toBe("PLAINTEXT://10.200.4.2:9092");
    expect(serviceSpec("redpanda").command?.(ctx(ELSEWHERE, "redpanda")).join(" ")).toContain(
      "--advertise-kafka-addr 10.200.4.2:9092",
    );
  });

  it("MongoDB's replica set lists its member at the private address, which the app connects to", () => {
    const plan = withPlacement(
      withServices([{ kind: "mongodb", name: "docs", options: { replicaSet: true } }]),
      { servers: { data: "hetzner" }, placed: { docs: "data" } },
    );
    const [step] = serviceSpec("mongodb").init?.(ctx(plan, "docs")) ?? [];
    expect(step?.run[2]).toContain('members: [{ _id: 0, host: "10.200.4.2:27017" }]');
    expect(appVariables(ctx(plan, "docs")).MONGODB_URI).toBe(
      "mongodb://app:<password>@10.200.4.2:27017/app?authSource=admin&replicaSet=rs0",
    );
  });

  it("is set up and has its host settings on its own server, not on the app's", () => {
    const plan = withPlacement(
      withServices(
        [
          { kind: "mongodb", name: "docs", options: { replicaSet: true } },
          { kind: "opensearch" },
          { kind: "garage" },
        ],
        { storage: GARAGE_STORAGE },
      ),
      {
        servers: { data: "hetzner", search: "hetzner" },
        placed: { docs: "data", opensearch: "search" },
      },
    );
    expect(initStepsFor(plan)).toEqual([]);
    expect(initStepsFor(plan, "data").map((step) => step.service)).toEqual(["docs"]);
    expect(hostSysctl(plan)).toEqual({});
    expect(hostSysctl(plan, "search")).toEqual({ "vm.max_map_count": "262144" });
    expect(hostSysctl(plan, "data")).toEqual({});
  });
});

/** Valkey `cache`, Redis `queue`, Dragonfly `store` and Postgres `db`, with the devices' grants. */
function granted(grants: { device: string; service: string; access: "read-only" | "full" }[]) {
  return withPlacement(
    withServices([
      { kind: "valkey", name: "cache" },
      { kind: "redis", name: "queue", options: { mode: "queue" } },
      { kind: "dragonfly", name: "store", memoryMb: 512, options: { mode: "cache" } },
      { kind: "postgres" },
    ]),
    { devices: ["laptop", "phone"], grants },
  );
}

const GRANTS = granted([
  { device: "laptop", service: "cache", access: "read-only" },
  { device: "phone", service: "cache", access: "full" },
  { device: "laptop", service: "queue", access: "read-only" },
  { device: "laptop", service: "store", access: "read-only" },
  { device: "phone", service: "store", access: "full" },
  { device: "laptop", service: "db", access: "read-only" },
]);

/**
 * The wrapper's ACL file: the default user from the password in `variable`, with every right, and
 * the devices' logins with the rules of each access.
 */
function aclFile(variable: string, rules: { readOnly: string; full: string }) {
  return `{ h=$(printf %s "$${variable}" | sha256sum | cut -d ' ' -f 1); printf 'user %s on #%s %s\\n' default "$h" '~* &* +@all'; printf '%s\\n' "$OPSCREW_ACL_USERS" | while IFS=: read -r name access hash; do case "$access" in read-only) rules='${rules.readOnly}' ;; full) rules='${rules.full}' ;; *) continue ;; esac; printf 'user %s on #%s %s\\n' "$name" "$hash" "$rules"; done; } > /tmp/opscrew-users.acl`;
}

const REDIS_RULES = {
  readOnly: "~* &* +@read +ping +hello +client|setname +client|setinfo -@write",
  full: "~* &* +@all",
};

describe("device logins on Valkey, Redis and Dragonfly (the ACL wrapper)", () => {
  it("declare each grant's login in OPSCREW_ACL_USERS, with only its password's SHA-256", () => {
    expect(serviceSpec("valkey").environment(ctx(GRANTS, "cache"))).toEqual({
      VALKEY_PASSWORD: "<password>",
      OPSCREW_ACL_USERS: `laptop:read-only:<${grantHashSecret("laptop")}>\nphone:full:<${grantHashSecret("phone")}>`,
    });
    expect(serviceSpec("redis").environment(ctx(GRANTS, "queue"))).toEqual({
      REDIS_PASSWORD: "<password>",
      OPSCREW_ACL_USERS: `laptop:read-only:<${grantHashSecret("laptop")}>`,
    });
    expect(serviceSpec("dragonfly").environment(ctx(GRANTS, "store"))).toEqual({
      DFLY_requirepass: "<password>",
      OPSCREW_ACL_USERS: `laptop:read-only:<${grantHashSecret("laptop")}>\nphone:full:<${grantHashSecret("phone")}>`,
    });
    // The hash's secret is its own per device, apart from the service's secrets.
    expect(grantHashSecret("laptop")).not.toBe(grantHashSecret("phone"));
    expect(serviceSpec("valkey").secrets.map((s) => s.name)).not.toContain(
      grantHashSecret("laptop"),
    );
  });

  it("Valkey: writes a fresh ACL file at every start and starts on it, without requirepass", () => {
    const [sh, flag, script] = serviceSpec("valkey").command?.(ctx(GRANTS, "cache")) ?? [];
    expect([sh, flag]).toEqual(["sh", "-c"]);
    expect(script).toBe(
      [
        "umask 077",
        aclFile("VALKEY_PASSWORD", REDIS_RULES),
        "chown valkey:valkey /tmp/opscrew-users.acl",
        "exec docker-entrypoint.sh valkey-server --aclfile /tmp/opscrew-users.acl --save '' --appendonly no --maxmemory 96mb --maxmemory-policy allkeys-lru",
      ].join(" && "),
    );
    expect(script).not.toContain("requirepass");
  });

  it("Redis: the same wrapper, through the image's own entrypoint", () => {
    const script = serviceSpec("redis").command?.(ctx(GRANTS, "queue"))?.[2];
    expect(script).toBe(
      [
        "umask 077",
        aclFile("REDIS_PASSWORD", REDIS_RULES),
        "chown redis:redis /tmp/opscrew-users.acl",
        "exec docker-entrypoint.sh redis-server --aclfile /tmp/opscrew-users.acl --appendonly yes --maxmemory 96mb --maxmemory-policy noeviction",
      ].join(" && "),
    );
  });

  it("Dragonfly: read-only keys with %R~*, and its own password flag unset before it starts", () => {
    const command = serviceSpec("dragonfly").command?.(ctx(GRANTS, "store"));
    expect(command?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(command?.[2]).toBe(
      [
        "umask 077",
        aclFile("DFLY_requirepass", {
          readOnly: "resetkeys %R~* +@read +ping +hello -@write",
          full: "%RW~* +@all",
        }),
        "chown dfly:dfly /tmp/opscrew-users.acl",
        "unset DFLY_requirepass",
        "exec entrypoint.sh dragonfly --aclfile /tmp/opscrew-users.acl --logtostderr --proactor_threads=1 --maxmemory=384mb --primary_port_http_enabled=false --cache_mode=true --dbfilename=",
      ].join(" && "),
    );
    // A flag with spaces stays one word for the shell.
    const queue = withPlacement(
      withServices([{ kind: "dragonfly", name: "store", options: { mode: "queue" } }]),
      { devices: ["laptop"], grants: [{ device: "laptop", service: "store", access: "full" }] },
    );
    expect(serviceSpec("dragonfly").command?.(ctx(queue, "store"))?.[2]).toMatch(
      / --dbfilename=dump '--snapshot_cron=\* \* \* \* \*'$/,
    );
  });

  it("keep today's start command and environment without a grant on the service", () => {
    const plain = withServices([
      { kind: "valkey", name: "cache" },
      { kind: "redis", name: "queue", options: { mode: "queue" } },
      { kind: "dragonfly", name: "store", memoryMb: 512, options: { mode: "cache" } },
      { kind: "postgres" },
    ]);
    // Only Postgres is granted: the three keep their command and environment.
    const onlyDb = granted([{ device: "laptop", service: "db", access: "read-only" }]);
    for (const name of ["cache", "queue", "store"]) {
      const spec = serviceSpec(plain.services.find((s) => s.name === name)?.kind ?? "valkey");
      expect(spec.command?.(ctx(onlyDb, name))).toEqual(spec.command?.(ctx(plain, name)));
      expect(spec.environment(ctx(onlyDb, name))).toEqual(spec.environment(ctx(plain, name)));
    }
    expect(serviceSpec("postgres").environment(ctx(onlyDb, "db"))).not.toHaveProperty(
      "OPSCREW_ACL_USERS",
    );
  });

  it("put no password and no hash in the start command", () => {
    // The rendering context refuses every secret: the command needs none, the environment does.
    const c = renderContext(GRANTS, ctx(GRANTS, "cache").service);
    expect(() => serviceSpec("valkey").command?.(c)).not.toThrow();
    expect(() => serviceSpec("valkey").environment(c)).toThrow(/cannot appear in a rendered file/);
  });
});
