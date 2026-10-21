import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployPlan, ProjectFacts, Requirements } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { makeFacts, makeRequirements, testPlan } from "../testing";
import { designComponents, hostedChoices, memoryText, workerName } from "./components";
import { sizeFor } from "./sizing";
import { checkSqliteFolder, storageOffers } from "./storage";

type Service = ProjectFacts["services"][number];
const service = (kind: Service["kind"], ...evidence: string[]): Service => ({ kind, evidence });

/** The components designed for an app with `services` and no earlier plan. */
function designed(overrides: Partial<ProjectFacts>, requirements = makeRequirements()) {
  return designComponents({ facts: makeFacts(overrides), requirements });
}

describe("designComponents: one service per kind the app uses", () => {
  it.each([
    ["postgres", "dependency:pg", "db", "postgres", "17", 512, "PostgreSQL", "pg"],
    ["mysql", "dependency:mysql2", "mysql", "mysql", "8.4", 512, "GPL-2.0", "mysql2"],
    ["mariadb", "dependency:mariadb", "mariadb", "mariadb", "12.3", 384, "GPL-2.0", "mariadb"],
    ["mongodb", "dependency:mongoose", "mongodb", "mongodb", "8.0", 512, "SSPL-1.0", "mongoose"],
    ["amqp", "dependency:amqplib", "rabbitmq", "rabbitmq", "4.3", 384, "MPL-2.0", "amqplib"],
    ["nats", "dependency:nats", "nats", "nats", "2.15", 64, "Apache-2.0", "nats"],
    ["kafka", "dependency:kafkajs", "kafka", "kafka", "4.3", 1024, "Apache-2.0", "kafkajs"],
  ] as const)(
    "%s runs as %s's catalog entry",
    (kind, evidence, name, runs, version, memoryMb, licence, lib) => {
      const { components, lines } = designed({ services: [service(kind, evidence)] });
      expect(components.services).toEqual([
        expect.objectContaining({ name, kind: runs, version, memoryMb, enabled: true, licence }),
      ]);
      expect(components.services[0]?.reason).toContain(lib);
      expect(components.externalServices).toEqual([]);
      expect(lines.some((line) => line.includes(`(${name}, ${memoryMb} MB)`))).toBe(true);
    },
  );

  it("uses MariaDB instead of MySQL when the app declares it", () => {
    const { components } = designed({
      services: [service("mysql", "dependency:mysql2"), service("mariadb", "env:DB_CONNECTION")],
    });
    expect(components.services.map((s) => s.kind)).toEqual(["mariadb"]);
    expect(components.externalServices).toEqual([]);
  });

  it("runs MongoDB as a one-node replica set for Prisma, which needs transactions", () => {
    const { components } = designed({
      services: [service("mongodb", "dependency:@prisma/client", "prisma:mongodb")],
    });
    expect(components.services[0]).toMatchObject({
      kind: "mongodb",
      options: { replicaSet: true },
    });
    expect(components.services[0]?.reason).toContain("replica set");
  });

  it("gives Redis a cache, or a queue when a job library keeps its jobs there (FR-1321)", () => {
    const cache = designed({ services: [service("redis", "dependency:ioredis")] });
    expect(cache.components.services).toEqual([
      expect.objectContaining({ name: "cache", kind: "valkey", options: { mode: "cache" } }),
    ]);
    const queue = designed({
      services: [service("queue", "dependency:bullmq"), service("redis", "dependency:bullmq")],
    });
    expect(queue.components.services).toEqual([
      expect.objectContaining({ name: "queue", kind: "valkey", options: { mode: "queue" } }),
    ]);
    // Celery on Redis, and Laravel's queue on Redis.
    for (const services of [
      [service("queue", "dependency:celery"), service("redis", "dependency:celery[redis]")],
      [
        service("queue", "env:QUEUE_CONNECTION=redis"),
        service("redis", "env:QUEUE_CONNECTION=redis"),
      ],
    ]) {
      expect(designed({ services }).components.services[0]?.options).toEqual({ mode: "queue" });
    }
    // Celery on RabbitMQ with Redis for a cache: the broker follows Celery's broker URL.
    const amqp = designed({
      services: [
        service("amqp", "config:amqp-broker"),
        service("queue", "dependency:celery"),
        service("redis", "dependency:django-redis"),
      ],
    });
    expect(amqp.components.services.map((s) => [s.kind, s.options])).toEqual([
      ["valkey", { mode: "cache" }],
      ["rabbitmq", {}],
    ]);
  });

  it("adds a separate cache only when the app reads a separate cache address", () => {
    const { components } = designed({
      services: [
        service("queue", "dependency:bullmq"),
        { ...service("redis", "dependency:bullmq"), variable: "REDIS_URL" },
      ],
      envVars: [
        {
          name: "REDIS_CACHE_URL",
          files: [".env.example"],
          clientExposed: false,
          secretLikely: false,
          urlScheme: "redis",
        },
        { name: "REDIS_URL", files: [".env.example"], clientExposed: false, secretLikely: false },
      ],
    });
    expect(components.services.map((s) => [s.name, s.options, s.variable])).toEqual([
      ["queue", { mode: "queue" }, "REDIS_URL"],
      ["cache", { mode: "cache" }, "REDIS_CACHE_URL"],
    ]);
  });

  it("runs Kafka for Kafka clients and names Redpanda as the other choice", () => {
    const { components } = designed({ services: [service("kafka", "dependency:kafkajs")] });
    expect(components.services[0]?.reason).toContain("Redpanda is the other choice");
  });

  it("keeps Cassandra external, says why and names a hosted option", () => {
    const { components, lines } = designed({
      services: [service("cassandra", "dependency:cassandra-driver")],
    });
    expect(components.services).toEqual([]);
    expect(components.externalServices).toEqual(["cassandra"]);
    expect(lines.join("\n")).toContain("DataStax Astra DB");
  });

  it.each([
    ["opensearch", "dependency:@opensearch-project/opensearch", "3.9", 1024, "Apache-2.0"],
    ["elasticsearch", "dependency:@elastic/elasticsearch", "9.5", 1024, "Elastic-2.0"],
    ["meilisearch", "dependency:meilisearch", "1.55", 512, "MIT"],
    ["typesense", "dependency:typesense", "30.2", 512, "GPL-3.0"],
    ["clickhouse", "dependency:@clickhouse/client", "26.3", 1024, "Apache-2.0"],
    ["neo4j", "dependency:neo4j-driver", "2026.09", 1536, "GPL-3.0"],
  ] as const)(
    "runs %s on the server when the app uses it",
    (kind, evidence, version, memoryMb, licence) => {
      const { components, lines } = designed({ services: [service(kind, evidence)] });
      expect(components.services).toEqual([
        expect.objectContaining({ name: kind, kind, version, memoryMb, enabled: true, licence }),
      ]);
      expect(components.externalServices).toEqual([]);
      expect(lines.join("\n")).not.toContain("cannot run");
    },
  );

  it("names the licence of Elasticsearch, Typesense and Neo4j in plain words", () => {
    const { lines } = designed({
      services: [
        service("elasticsearch", "dependency:@elastic/elasticsearch"),
        service("typesense", "dependency:typesense"),
        service("neo4j", "dependency:neo4j-driver"),
        service("meilisearch", "dependency:meilisearch"),
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("Elasticsearch's official image is under the Elastic License 2.0");
    expect(text).toContain("Typesense is under the GPL 3.0");
    expect(text).toContain("Neo4j Community is under the GPL 3.0");
    expect(text).not.toContain("Meilisearch is under");
  });

  it("names each licence that is not permissive in one plain sentence (FR-1327)", () => {
    const { lines } = designed({
      services: [service("mongodb", "dependency:mongodb"), service("postgres", "dependency:pg")],
    });
    expect(lines).toContain(
      "MongoDB is under the SSPL: using it as your own app's database is unrestricted; its extra conditions apply only when you offer MongoDB itself as a service to others.",
    );
    expect(lines.join("\n")).not.toContain("PostgreSQL is under");
  });
});

describe("designComponents: the engine on Redis's protocol (FR-1321a)", () => {
  const ioredis = service("redis", "dependency:ioredis");
  const bullmq = [service("queue", "dependency:bullmq"), service("redis", "dependency:bullmq")];
  const own = (vcpus: number) =>
    designComponents({
      facts: makeFacts({ services: [ioredis] }),
      requirements: makeRequirements({ provider: "own" }),
      vcpus,
    });
  const DRAGONFLY_OFFER =
    "Dragonfly is the other choice: set this service's kind to dragonfly in opscrew/plan.yaml.";

  it("runs Valkey by default, naming Dragonfly where the server has 2 vCPUs or OpsCrew sizes it", () => {
    const cloud = designed({ services: [ioredis] });
    expect(cloud.components.services).toEqual([
      expect.objectContaining({ kind: "valkey", version: "8", options: { mode: "cache" } }),
    ]);
    expect(cloud.components.services[0]?.reason).toBe(
      `The app uses Redis through ioredis. Valkey, Redis's open-source fork, runs it. ${DRAGONFLY_OFFER}`,
    );
    expect(own(2).components.services[0]?.reason).toContain(DRAGONFLY_OFFER);
    expect(own(1).components.services[0]?.reason).not.toContain("Dragonfly");
    const portainer = designed(
      { services: [ioredis] },
      makeRequirements({ provider: "portainer" }),
    );
    expect(portainer.components.services[0]?.reason).not.toContain("Dragonfly");
    // A queue's reason says why it keeps its jobs, then which engine runs it.
    expect(designed({ services: bullmq }).components.services[0]?.reason).toBe(
      `BullMQ keeps its jobs in Redis, so it runs as a queue: it never evicts a job and keeps them on disk. Valkey, Redis's open-source fork, runs it. ${DRAGONFLY_OFFER}`,
    );
  });

  it("runs Redis 8 for a client that needs Redis's own data types, naming its licence", () => {
    const { components, lines } = designed({
      services: [service("redis", "dependency:redis-om", "redis-modules:redis-om")],
    });
    expect(components.services).toEqual([
      expect.objectContaining({
        name: "cache",
        kind: "redis",
        version: "8",
        memoryMb: 128,
        options: { mode: "cache" },
        licence: "RSALv2 OR SSPL-1.0 OR AGPL-3.0-only",
      }),
    ]);
    expect(components.services[0]?.reason).toBe(
      "The app uses Redis through redis-om. redis-om needs Redis's own data types (Search, JSON, Time Series or probabilistic structures), which only Redis 8 has together, so Redis 8 runs it.",
    );
    expect(lines.join("\n")).toContain(
      "Redis is under your choice of the RSALv2, the SSPLv1 or the AGPLv3",
    );
  });

  it("runs the engine the app's Compose file runs: Redis 8 or Dragonfly", () => {
    const redis = designed({
      services: [service("redis", "compose-image:redis", "dependency:ioredis")],
    });
    expect(redis.components.services[0]).toMatchObject({
      kind: "redis",
      options: { mode: "cache" },
    });
    expect(redis.components.services[0]?.reason).toBe(
      "The app uses Redis through ioredis. The app's Compose file runs Redis, so Redis 8 runs it here too.",
    );
    const dragonfly = designed({
      services: [service("redis", "compose-image:dragonfly", "dependency:ioredis")],
    });
    expect(dragonfly.components.services[0]).toMatchObject({
      name: "cache",
      kind: "dragonfly",
      version: "2",
      memoryMb: 512,
      options: { mode: "cache", lockOnHashtags: false },
      licence: "BSL-1.1",
    });
    expect(dragonfly.components.services[0]?.reason).toBe(
      "The app uses Redis through ioredis. The app's Compose file runs Dragonfly, so Dragonfly runs it here too.",
    );
    expect(dragonfly.lines.join("\n")).toContain(
      "Dragonfly is under the Business Source License 1.1",
    );
    expect(dragonfly.warnings).toEqual([]);
  });

  it("runs Valkey for KeyDB, saying why in one line", () => {
    const { components } = designed({
      services: [service("redis", "compose-image:keydb", "dependency:ioredis")],
    });
    expect(components.services[0]?.kind).toBe("valkey");
    expect(components.services[0]?.reason).toBe(
      `The app uses Redis through ioredis. The app's Compose file runs KeyDB, which has had no release since 2023, so Valkey, which speaks the same protocol, runs instead. ${DRAGONFLY_OFFER}`,
    );
  });

  it("gives Dragonfly BullMQ's hashtag locks, and warns that queue names need hashtags", () => {
    const facts = makeFacts({
      services: [
        ...bullmq.slice(0, 1),
        service("redis", "compose-image:dragonfly", "dependency:bullmq"),
      ],
    });
    const { components, warnings } = designComponents({ facts, requirements: makeRequirements() });
    // A rerun keeps them and the threads the plan got from its server, and says nothing changed.
    const written = components.services.map((s) =>
      s.kind === "dragonfly" ? { ...s, options: { ...s.options, threads: 2 } } : s,
    );
    const previous = { ...testPlan(), services: written, externalServices: [] };
    const again = designComponents({ facts, requirements: makeRequirements(), previous });
    expect(again.components.services).toEqual(written);
    expect(again.lines.join("\n")).not.toContain("Kept your changes");
    expect(components.services[0]).toMatchObject({
      name: "queue",
      kind: "dragonfly",
      options: { mode: "queue", lockOnHashtags: true },
    });
    expect(warnings).toEqual([
      'Dragonfly (queue) runs with --cluster_mode=emulated --lock_on_hashtags, as BullMQ needs: give each queue\'s name or prefix its own hashtag, such as {myqueue} (new Queue("{myqueue}") or prefix: "{myqueue}"), or BullMQ\'s scripts fail. See https://www.dragonflydb.io/docs/integrations/bullmq.',
    ]);
  });

  it("keeps the user's switch to Dragonfly or Redis 8 in plan.yaml, unless the server has 1 vCPU", () => {
    const requirements = makeRequirements({ provider: "own" });
    const facts = makeFacts({ services: bullmq });
    const fresh = designComponents({ facts, requirements, vcpus: 2 }).components;
    const switched = (kind: "dragonfly" | "redis", version: string, licence: string) => ({
      ...testPlan(),
      updatedAt: "2026-10-12T00:00:00.000Z",
      services: fresh.services.map((s) => ({ ...s, kind, version, licence })),
      externalServices: [],
    });
    const dragonfly = switched("dragonfly", "2", "BSL-1.1") as DeployPlan;
    const kept = designComponents({ facts, requirements, vcpus: 2, previous: dragonfly });
    expect(kept.components.services[0]).toMatchObject({
      kind: "dragonfly",
      version: "2",
      options: { mode: "queue", lockOnHashtags: true },
      licence: "BSL-1.1",
    });
    expect(kept.components.services[0]?.reason).toBe(
      "BullMQ keeps its jobs in Redis, so it runs as a queue: it never evicts a job and keeps them on disk. You chose Dragonfly in opscrew/plan.yaml.",
    );
    expect(kept.lines).toContain(
      "Kept your changes in opscrew/plan.yaml: the service queue (Dragonfly and version 2).",
    );
    // Valkey's limit is below the least Dragonfly starts with.
    expect(kept.components.services[0]?.memoryMb).toBe(384);
    expect(kept.lines).toContain(
      "Raised the service queue's memory from 128 MB to 384 MB, the least Dragonfly runs with.",
    );
    expect(kept.warnings[0]).toContain("{myqueue}");
    // A rerun changes nothing.
    const again = designComponents({
      facts,
      requirements,
      vcpus: 2,
      previous: { ...dragonfly, services: kept.components.services },
    });
    expect(again.components.services).toEqual(kept.components.services);
    expect(again.lines.join("\n")).not.toContain("its options");
    const redis = switched("redis", "8", "RSALv2 OR SSPL-1.0 OR AGPL-3.0-only") as DeployPlan;
    expect(
      designComponents({ facts, requirements, vcpus: 2, previous: redis }).components.services[0],
    ).toMatchObject({ kind: "redis", options: { mode: "queue" } });
    // A server with one vCPU: Valkey again, saying why.
    const small = designComponents({ facts, requirements, vcpus: 1, previous: dragonfly });
    expect(small.components.services[0]).toMatchObject({
      kind: "valkey",
      options: { mode: "queue" },
    });
    expect(small.lines).toContain(
      "The service queue runs Valkey, not the Dragonfly opscrew/plan.yaml chose: Dragonfly runs only on a server with 2 or more vCPUs, and yours has 1.",
    );
  });

  it("replaces a Valkey it chose once the app needs Redis 8 or its Compose file runs Dragonfly", () => {
    const first = designed({ services: [ioredis] }).components;
    const previous = {
      ...testPlan(),
      updatedAt: "2026-10-12T00:00:00.000Z",
      services: first.services,
      externalServices: [],
    };
    const redesign = (...evidence: string[]) =>
      designComponents({
        facts: makeFacts({ services: [service("redis", "dependency:ioredis", ...evidence)] }),
        requirements: makeRequirements(),
        previous,
      });
    const search = redesign("dependency:@redis/search", "redis-modules:@redis/search");
    expect(search.components.services).toEqual([
      expect.objectContaining({ name: "cache", kind: "redis" }),
    ]);
    const text = search.lines.join("\n");
    expect(text).toContain("Added the service cache (Redis).");
    expect(text).not.toContain("You chose");
    expect(redesign("compose-image:dragonfly").components.services).toEqual([
      expect.objectContaining({ name: "cache", kind: "dragonfly" }),
    ]);
  });

  it("warns that a Compose Dragonfly runs one thread on a server with 1 vCPU", () => {
    const { components, warnings } = designComponents({
      facts: makeFacts({
        services: [service("redis", "compose-image:dragonfly", "dependency:ioredis")],
      }),
      requirements: makeRequirements({ provider: "own" }),
      vcpus: 1,
    });
    expect(components.services[0]?.kind).toBe("dragonfly");
    expect(warnings).toEqual([
      "Dragonfly (cache) runs with one thread, because your server has 1 vCPU and Dragonfly uses one thread per vCPU, so Valkey would do the same job here. It runs because the app's Compose file runs it.",
    ]);
  });

  it("offers the hosted Redis's replacement by the same choice", () => {
    const upstash = (...evidence: string[]) =>
      hostedChoices(
        makeFacts({
          services: [service("redis", ...evidence)],
          hostedServices: [{ kind: "redis", variable: "REDIS_URL", provider: "Upstash" }],
        }),
      )[0]?.runs;
    expect(upstash("dependency:ioredis")).toBe("valkey");
    expect(upstash("dependency:redis-om", "redis-modules:redis-om")).toBe("redis");
  });
});

describe("designComponents: hosted services", () => {
  const neon = {
    services: [service("postgres", "dependency:pg")],
    hostedServices: [{ kind: "postgres" as const, variable: "DATABASE_URL", provider: "Neon" }],
  };

  it("keeps a hosted service unless the interview answered no, and runs it then", () => {
    // Unanswered (a service detected after the interview) and answered yes: kept.
    for (const keepExternalServices of [{}, { postgres: true }]) {
      const kept = designed(neon, makeRequirements({ keepExternalServices }));
      expect(kept.components.services).toEqual([]);
      expect(kept.components.externalServices).toEqual(["postgres"]);
      expect(kept.lines).toContain(
        "The app keeps using Neon for postgres (DATABASE_URL); set its address in the app's production environment.",
      );
    }
    const run = designed(neon, makeRequirements({ keepExternalServices: { postgres: false } }));
    expect(run.components.services.map((s) => s.kind)).toEqual(["postgres"]);
    expect(run.components.services[0]?.reason).toBe(
      "The app uses PostgreSQL through pg. It runs on your server instead of Neon, as the interview answered: move the data yourself.",
    );
  });

  it("keeps a kind that is not hosted only when its answer is yes", () => {
    const mysql = { services: [service("mysql", "dependency:mysql2")] };
    expect(designed(mysql).components.services.map((s) => s.kind)).toEqual(["mysql"]);
    const kept = designed(mysql, makeRequirements({ keepExternalServices: { mysql: true } }));
    expect(kept.components.services).toEqual([]);
    expect(kept.components.externalServices).toEqual(["mysql"]);
  });

  it("keeps MongoDB Atlas without asking (its SRV form)", () => {
    const atlas = {
      services: [service("mongodb", "dependency:mongoose")],
      hostedServices: [
        { kind: "mongodb" as const, variable: "MONGODB_URI", provider: "MongoDB Atlas" },
      ],
    };
    expect(designed(atlas).components.externalServices).toEqual(["mongodb"]);
    expect(hostedChoices(makeFacts(atlas))).toEqual([]);
    expect(hostedChoices(makeFacts(neon))).toEqual([
      { kind: "postgres", providers: ["Neon"], variables: ["DATABASE_URL"], runs: "postgres" },
    ]);
  });
});

describe("designComponents: the DATABASE_URL of two databases", () => {
  it("leaves it to the database the app reads it for, and gives the other its own name", () => {
    const { components, lines } = designed({
      services: [
        { ...service("postgres", "dependency:pg"), variable: "DATABASE_URL" },
        service("mysql", "dependency:mysql2"),
      ],
    });
    expect(components.services.map((s) => [s.kind, s.variable])).toEqual([
      ["postgres", "DATABASE_URL"],
      ["mysql", "MYSQL_URL"],
    ]);
    expect(lines).toContain(
      "The app has two databases that both use DATABASE_URL: PostgreSQL keeps it, and MySQL's address goes to MYSQL_URL. Make sure the app reads MySQL's address from MYSQL_URL.",
    );
    const mysqlFirst = designed({
      services: [
        service("postgres", "dependency:pg"),
        { ...service("mysql", "dependency:mysql2"), variable: "DATABASE_URL" },
        { ...service("mongodb", "dependency:mongodb"), variable: "MONGO_URL" },
      ],
    });
    expect(mysqlFirst.components.services.map((s) => [s.kind, s.variable])).toEqual([
      ["postgres", "POSTGRES_URL"],
      ["mysql", "DATABASE_URL"],
      ["mongodb", "MONGO_URL"],
    ]);
  });
});

describe("designComponents: workers and cron", () => {
  const library = (name: string, command?: string, single = false) => ({
    name,
    ...(command === undefined ? {} : { command }),
    source: "library" as const,
    single,
    evidence: [`dependency:${name}`],
  });

  it("normalises worker names and keeps a scheduler to one copy", () => {
    expect(workerName("celery_beat")).toBe("celery-beat");
    expect(workerName("Worker 2")).toBe("worker-2");
    expect(workerName("cron")).toBe("cron-worker");
    expect(workerName("1st")).toBe("st");
    const { components } = designed({
      workers: [
        library("celery_beat", "celery -A app beat", true),
        library("celery-worker", "celery -A app worker"),
      ],
    });
    expect(components.processes.workers).toEqual([
      {
        name: "celery-beat",
        command: "celery -A app beat",
        source: "library",
        count: 1,
        single: true,
        stopGraceSeconds: 30,
        memoryMb: 256,
        enabled: true,
      },
      expect.objectContaining({ name: "celery-worker", single: false }),
    ]);
  });

  it("takes a worker's command from the interview when no convention gives it, else warns", () => {
    const facts = { workers: [library("bullmq")] };
    const none = designed(facts);
    expect(none.components.processes.workers).toEqual([]);
    expect(none.warnings).toEqual([expect.stringContaining("no command that starts it")]);
    const answered = designed(
      facts,
      makeRequirements({ workerCommands: { bullmq: "node dist/worker.js" } }),
    );
    expect(answered.components.processes.workers).toEqual([
      expect.objectContaining({ name: "bullmq", command: "node dist/worker.js" }),
    ]);
    expect(answered.warnings).toEqual([]);
  });

  it("calls each vercel.json route on its schedule", () => {
    const { components, lines } = designed({
      cronJobs: [
        { schedule: "0 5 * * *", route: "/api/cron/cleanup", source: "vercel.json" },
        { schedule: "*/10 * * * *", route: "/api/cron", source: "vercel.json" },
      ],
    });
    expect(components.processes.cron).toEqual([
      { name: "cleanup", schedule: "0 5 * * *", route: "/api/cron/cleanup", enabled: true },
      { name: "cron", schedule: "*/10 * * * *", route: "/api/cron", enabled: true },
    ]);
    expect(lines.join("\n")).toContain("CRON_SECRET as its bearer token");
  });
});

describe("designComponents: storage", () => {
  it("keeps SQLite's folder on a volume", () => {
    const { components, lines } = designed({
      sqlite: { paths: ["storage/production.sqlite3"], dir: "storage" },
    });
    expect(components.storage).toEqual({ sqlite: { dir: "storage" } });
    expect(lines.join("\n")).toContain("in storage/ on a persistent volume");
  });

  const s3 = {
    services: [service("s3", "dependency:@aws-sdk/client-s3")],
    objectStorage: {
      client: "@aws-sdk/client-s3",
      presignedUploads: true,
      variables: ["S3_BUCKET"],
    },
  };
  const onCloudflare = { dnsProvider: "cloudflare" as const, domain: "shop.example.com" };
  /** The interview let OpsCrew create a bucket. */
  const bucket = { keepExternalServices: { s3: false } };
  const noBucketLine =
    "The app keeps its files where it stores them now (S3 through @aws-sdk/client-s3), so OpsCrew plans no bucket. To let OpsCrew create one, answer keepExternalServices.s3: false in `opscrew interview`, which lists the options and their prices.";

  it("plans no bucket without an answer, says so and how to ask for one (FR-1316a)", () => {
    // No endpoint the app reads, and an endpoint at a known host: both kept.
    const amazon = {
      ...s3,
      hostedServices: [{ kind: "s3" as const, variable: "S3_ENDPOINT", provider: "Amazon S3" }],
    };
    for (const facts of [s3, amazon]) {
      const { components, lines, warnings } = designed(facts, makeRequirements(onCloudflare));
      expect(components.storage).toBeUndefined();
      expect(components.services).toEqual([]);
      expect(components.externalServices).toEqual(["s3"]);
      expect(lines).toContain(noBucketLine);
      expect(warnings).toEqual([]);
    }
  });

  it("prices each option for the expected use and picks the cheapest (FR-1316)", () => {
    const small = designed(s3, makeRequirements({ ...onCloudflare, ...bucket }));
    expect(small.components.storage?.objectStorage).toEqual({
      provider: "r2",
      bucket: "demo-app-uploads",
      region: "auto",
      cors: true,
      expected: { storageGb: 10, egressGbPerMonth: 50 },
      price: {
        monthly: 0,
        currency: "USD",
        source: "https://developers.cloudflare.com/r2/pricing/",
        checkedOn: "2026-10-19",
      },
    });
    expect(small.components.externalServices).toEqual([]);
    const line = small.lines.find((l) => l.startsWith("Object storage")) ?? "";
    expect(line).toContain("Cloudflare R2 $0.00/month, the cheapest");
    // The others are shown, Garage too, with the per-account note.
    expect(line).toContain(
      "Also offered here: Garage on your server $0.00/month plus 64 MB of the server's memory, with the files on that server only; Hetzner Object Storage €6.49/month. To use another, set storage.objectStorage.provider in opscrew/plan.yaml.",
    );
    expect(line).toContain(
      "Hetzner charges the base price once per account, for every hour any bucket exists.",
    );
    // At more than 100k users Hetzner's 1 TB included storage wins.
    const big = designed(
      s3,
      makeRequirements({ ...onCloudflare, ...bucket, expectedMonthlyUsers: ">100k" }),
    );
    expect(big.components.storage?.objectStorage).toMatchObject({
      provider: "hetzner",
      region: "nbg1",
      expected: { storageGb: 1000, egressGbPerMonth: 5000 },
      price: { monthly: 10.37, currency: "EUR" },
    });
  });

  it("offers each provider only where it works", () => {
    const expected = { storageGb: 10, egressGbPerMonth: 50 };
    const providers = (requirements: Parameters<typeof storageOffers>[0]) =>
      storageOffers(requirements, expected).map((o) => [o.provider, o.region, o.optIn ?? false]);
    // Garage is offered on every target; on a cloud server only as the user's choice.
    const garage = ["garage", "garage", true];
    expect(providers(makeRequirements())).toEqual([garage, ["hetzner", "nbg1", false]]);
    expect(providers(makeRequirements({ region: "eu-north" }))).toEqual([
      garage,
      ["hetzner", "hel1", false],
    ]);
    // Hetzner Object Storage is in Germany and Finland only; R2 needs the domain on Cloudflare.
    expect(providers(makeRequirements({ region: "us-east" }))).toEqual([garage]);
    expect(providers(makeRequirements({ region: "us-east", ...onCloudflare }))).toEqual([
      garage,
      ["r2", "auto", false],
    ]);
    expect(providers(makeRequirements({ provider: "digitalocean", region: "us-east" }))).toEqual([
      garage,
      ["digitalocean", "nyc3", false],
    ]);
    // On a server the user owns or a Portainer, Garage can be the default.
    expect(providers(makeRequirements({ provider: "own" }))).toEqual([["garage", "garage", false]]);
    expect(providers(makeRequirements({ provider: "portainer", ...onCloudflare }))).toEqual([
      ["garage", "garage", false],
      ["r2", "auto", false],
    ]);
  });

  it("never picks Garage on a cloud server by itself, and uses it when the interview chose it", () => {
    for (const provider of ["hetzner", "digitalocean"] as const) {
      const region = { provider, region: "eu-central" as const };
      const picked = designed(s3, makeRequirements({ ...region, ...bucket }));
      expect(picked.components.storage?.objectStorage?.provider).toBe(provider);
      expect(picked.components.services).toEqual([]);
      const chosen = designed(
        s3,
        makeRequirements({ ...region, ...bucket, objectStorage: "garage" }),
      );
      expect(chosen.components.storage?.objectStorage).toMatchObject({
        provider: "garage",
        region: "garage",
        price: { monthly: 0, currency: "USD" },
      });
      expect(chosen.components.services).toEqual([
        expect.objectContaining({ name: "garage", kind: "garage", memoryMb: 64 }),
      ]);
      expect(chosen.lines.join("\n")).toContain("on this server only, with no copy elsewhere");
      // Its memory counts in sizing.
      const facts = makeFacts(s3);
      const requirements = makeRequirements({ ...region, ...bucket, objectStorage: "garage" });
      expect(sizeFor(facts, requirements, chosen.components).limitsMb).toBe(
        sizeFor(facts, requirements, picked.components).limitsMb + 64,
      );
    }
  });

  /** A plan written after the default answers' time, with `components`. */
  const planOf = (components: ReturnType<typeof designed>["components"]): DeployPlan => ({
    ...testPlan(),
    updatedAt: "2026-10-12T00:00:00.000Z",
    processes: components.processes,
    services: components.services,
    externalServices: components.externalServices,
    ...(components.storage === undefined ? {} : { storage: components.storage }),
  });
  /** The plan with the bucket designed for `requirements`, or set to Garage by hand. */
  const planWithBucket = (requirements: Requirements, garage = false): DeployPlan => {
    const plan = planOf(designed(s3, requirements).components);
    const storage = plan.storage?.objectStorage;
    if (storage === undefined) throw new Error("no bucket planned");
    return garage
      ? { ...plan, storage: { objectStorage: { ...storage, provider: "garage" } } }
      : plan;
  };
  /** Answers given after the plan was written. */
  const later = (overrides: Partial<Requirements>) =>
    makeRequirements({ answeredAt: "2026-10-13T00:00:00.000Z", ...bucket, ...overrides });
  const stays = (provider: string) =>
    `The bucket demo-app-uploads stays at ${provider}, where the app's files are; to move it, set storage.objectStorage.provider in opscrew/plan.yaml and move the files yourself.`;

  it("never moves an existing bucket for a newer interview answer (FR-1316a)", () => {
    const facts = makeFacts(s3);
    // An R2 bucket, with the users changed and Hetzner answered.
    const r2 = designComponents({
      facts,
      requirements: later({
        ...onCloudflare,
        expectedMonthlyUsers: "1k-10k",
        objectStorage: "hetzner",
      }),
      previous: planWithBucket(makeRequirements({ ...onCloudflare, ...bucket })),
    });
    expect(r2.components.storage?.objectStorage).toMatchObject({
      provider: "r2",
      bucket: "demo-app-uploads",
      expected: { storageGb: 50, egressGbPerMonth: 250 },
    });
    expect(r2.lines).toContain(stays("Cloudflare R2"));
    // A Hetzner bucket, with the app moved to DigitalOcean and Spaces answered.
    const spaces = designComponents({
      facts,
      requirements: later({ provider: "digitalocean", objectStorage: "digitalocean" }),
      previous: planWithBucket(makeRequirements(bucket)),
    });
    expect(spaces.components.storage?.objectStorage).toMatchObject({
      provider: "hetzner",
      region: "nbg1",
    });
    expect(spaces.lines).toContain(stays("Hetzner Object Storage"));
    // Garage set by hand, with Hetzner answered.
    const garage = designComponents({
      facts,
      requirements: later({ objectStorage: "hetzner" }),
      previous: planWithBucket(makeRequirements(bucket), true),
    });
    expect(garage.components.storage?.objectStorage).toMatchObject({ provider: "garage" });
    expect(garage.components.services.map((s) => s.kind)).toEqual(["garage"]);
    expect(garage.lines).toContain(stays("Garage on your server"));
  });

  it("keeps a planned bucket while the interview has not answered, and drops it on yes", () => {
    const facts = makeFacts(s3);
    const previous = planWithBucket(makeRequirements(bucket));
    const unanswered = designComponents({ facts, requirements: makeRequirements(), previous });
    expect(unanswered.components.storage?.objectStorage).toMatchObject({ provider: "hetzner" });
    expect(unanswered.lines).not.toContain(noBucketLine);
    expect(unanswered.warnings).toEqual([]);
    const kept = designComponents({
      facts,
      requirements: later({ keepExternalServices: { s3: true } }),
      previous,
    });
    expect(kept.components.storage).toBeUndefined();
    expect(kept.warnings).toEqual([
      "opscrew/plan.yaml had the bucket demo-app-uploads at Hetzner Object Storage; OpsCrew no longer plans it because the interview keeps the app's own storage. Its files stay there (destroy never deletes them). To keep using it, answer keepExternalServices.s3: false.",
    ]);
  });

  it("keeps Garage set in plan.yaml on a cloud server, and a rerun changes nothing (SC-1307)", () => {
    const requirements = makeRequirements({ ...bucket });
    const edited = planWithBucket(requirements, true);
    const facts = makeFacts(s3);
    const kept = designComponents({ facts, requirements, previous: edited }).components;
    expect(kept.storage?.objectStorage).toMatchObject({
      provider: "garage",
      region: "garage",
      bucket: "demo-app-uploads",
    });
    expect(kept.services.map((s) => s.kind)).toEqual(["garage"]);
    // Designing again with nothing changed gives the same components.
    const again = designComponents({ facts, requirements, previous: planOf(kept) }).components;
    expect(again).toEqual(kept);
  });

  it("runs Garage on the user's own server, saying the files stay on it (AGPL named)", () => {
    const { components, lines } = designed(s3, makeRequirements({ provider: "own", ...bucket }));
    expect(components.storage?.objectStorage).toMatchObject({
      provider: "garage",
      region: "garage",
    });
    expect(components.services).toEqual([
      expect.objectContaining({ name: "garage", kind: "garage", memoryMb: 64 }),
    ]);
    expect(lines.join("\n")).toContain("on this server only, with no copy elsewhere");
    expect(lines.join("\n")).toContain("Garage is under the AGPL 3.0");
  });

  it("plans no bucket when the interview keeps the app's own storage (s3: true)", () => {
    const { components, lines, warnings } = designed(
      s3,
      makeRequirements({ ...onCloudflare, keepExternalServices: { s3: true } }),
    );
    expect(components.storage).toBeUndefined();
    expect(components.externalServices).toEqual(["s3"]);
    expect(lines).toContain(noBucketLine);
    expect(warnings).toEqual([]);
  });

  it("warns when only Garage works where the app runs, and keeps its storage external", () => {
    const { components, warnings } = designed(
      s3,
      makeRequirements({ region: "us-east", ...bucket }),
    );
    expect(components.storage).toBeUndefined();
    expect(components.externalServices).toEqual(["s3"]);
    expect(warnings).toEqual([
      "The app stores files through S3 (@aws-sdk/client-s3), but OpsCrew offers no bucket by default where it runs. Choose Garage on the server (objectStorage: garage in `opscrew interview`; the files then live on that server only), put the domain on Cloudflare to use Cloudflare R2, or keep the storage the app uses now (keepExternalServices.s3: true).",
    ]);
  });
});

describe("designComponents: the user's edits to the previous plan (FR-1304)", () => {
  const facts = makeFacts({
    services: [
      service("mysql", "dependency:mysql2"),
      service("redis", "dependency:ioredis"),
      service("kafka", "dependency:kafkajs"),
    ],
    workers: [
      {
        name: "worker",
        command: "node worker.js",
        source: "procfile",
        single: false,
        evidence: ["procfile:worker"],
      },
      {
        name: "gone",
        command: "node gone.js",
        source: "procfile",
        single: false,
        evidence: ["procfile:gone"],
      },
    ],
  });
  const requirements = makeRequirements();
  const fresh = designComponents({ facts, requirements }).components;
  const userWorker = {
    name: "mailer",
    command: "node mail.js",
    source: "user" as const,
    count: 1,
    single: false,
    stopGraceSeconds: 30,
    memoryMb: 128,
    enabled: true,
  };
  const previous: DeployPlan = {
    ...testPlan(),
    updatedAt: "2026-10-12T00:00:00.000Z",
    app: { ...testPlan().app, memoryMb: 1024 },
    processes: {
      workers: [
        ...fresh.processes.workers.map((w) =>
          w.name === "worker" ? { ...w, count: 3, memoryMb: 512, stopGraceSeconds: 120 } : w,
        ),
        userWorker,
      ],
      cron: [],
    },
    services: fresh.services.map((s) =>
      s.kind === "mysql"
        ? { ...s, memoryMb: 768 }
        : s.kind === "valkey"
          ? { ...s, enabled: false }
          : {
              ...s,
              kind: "redpanda",
              version: "26.2",
              memoryMb: 1536,
              options: {},
              licence: "BSL-1.1",
            },
    ),
    externalServices: [],
  };

  it("keeps counts, memory, versions, a kind switched, a component turned off and the app's memory", () => {
    const facts2 = { ...facts, workers: facts.workers?.filter((w) => w.name !== "gone") };
    const { components, lines } = designComponents({ facts: facts2, requirements, previous });
    expect(components.app.memoryMb).toBe(1024);
    expect(components.processes.workers).toEqual([
      expect.objectContaining({ name: "worker", count: 3, memoryMb: 512, stopGraceSeconds: 120 }),
      userWorker,
    ]);
    expect(components.services.map((s) => [s.name, s.kind, s.memoryMb, s.enabled])).toEqual([
      ["mysql", "mysql", 768, true],
      ["cache", "valkey", 128, false],
      ["kafka", "redpanda", 1536, true],
    ]);
    // A re-detected component the user turned off stays off; Redis is then hosted elsewhere.
    expect(components.externalServices).toEqual(["redis"]);
    expect(lines).toContain(
      "Kept your changes in opscrew/plan.yaml: the app's memory (1024 MB), the service mysql (memory 768 MB), the service cache (turned off), the service kafka (Redpanda, version 26.2 and memory 1536 MB) and the worker worker (3 copies, memory 512 MB and stop grace 120 seconds).",
    );
    expect(lines).toContain(
      "Removed the worker gone: OpsCrew no longer finds it in the app's Procfile or job libraries.",
    );
    // Redpanda's licence is named once it is chosen.
    expect(lines.join("\n")).toContain("Business Source License 1.1");
  });

  it("raises a memory limit below the catalog's minimum, and says so", () => {
    const low: DeployPlan = {
      ...previous,
      services: previous.services.map((s) => (s.kind === "mysql" ? { ...s, memoryMb: 128 } : s)),
    };
    const { components, lines } = designComponents({ facts, requirements, previous: low });
    expect(components.services.find((s) => s.kind === "mysql")?.memoryMb).toBe(384);
    expect(lines).toContain(
      "Raised the service mysql's memory from 128 MB to 384 MB, the least MySQL runs with.",
    );
  });

  it("keeps a worker command the interview gave once the plan has it", () => {
    const bull = makeFacts({
      workers: [
        { name: "bullmq", source: "library", single: false, evidence: ["dependency:bullmq"] },
      ],
    });
    const answered = makeRequirements({ workerCommands: { bullmq: "node a.js" } });
    const first = designComponents({ facts: bull, requirements: answered }).components;
    const plan: DeployPlan = {
      ...testPlan(),
      updatedAt: "2026-10-12T00:00:00.000Z",
      processes: {
        workers: first.processes.workers.map((w) => ({ ...w, command: "node b.js" })),
        cron: [],
      },
    };
    // The plan's command wins over an older answer, and a newer answer over the plan's.
    const kept = designComponents({ facts: bull, requirements: answered, previous: plan });
    expect(kept.components.processes.workers[0]?.command).toBe("node b.js");
    const later = makeRequirements({
      answeredAt: "2026-10-13T00:00:00.000Z",
      workerCommands: { bullmq: "node c.js" },
    });
    const newer = designComponents({ facts: bull, requirements: later, previous: plan });
    expect(newer.components.processes.workers[0]?.command).toBe("node c.js");
  });
});

describe("memoryText", () => {
  it("shows each container's memory and its share of the server's price (SC-1308)", () => {
    const { components } = designed({ services: [service("mysql", "dependency:mysql2")] });
    expect(memoryText(components, 4096, 128, { amount: 8, currency: "EUR" })).toBe(
      "Memory limits: the app 512 MB (€1.00/month), mysql 512 MB (€1.00/month); OpsCrew's edge and the system 512 MB; 2.5 GB of 4.0 GB free.",
    );
    expect(memoryText(components, 4096, 128)).toBe(
      "Memory limits: the app 512 MB, mysql 512 MB; OpsCrew's edge and the system 512 MB; 2.5 GB of 4.0 GB free.",
    );
    // The nginx edge's 192 MB.
    expect(memoryText(components, 4096, 192)).toBe(
      "Memory limits: the app 512 MB, mysql 512 MB; OpsCrew's edge and the system 576 MB; 2.4 GB of 4.0 GB free.",
    );
  });
});

describe("checkSqliteFolder", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(process.env.OPSCREW_TEST_TMP ?? tmpdir(), "opscrew-sqlite-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  }

  it("refuses the app's root and a folder that holds the app's code or schema", async () => {
    const root = await repo({ "prisma/schema.prisma": "datasource db {}", "prisma/dev.db": "" });
    await expect(checkSqliteFolder(root, { appDir: "." }, ".")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      hint: expect.stringContaining(
        "Move the database into a folder of its own, for example data/",
      ),
    });
    await expect(checkSqliteFolder(root, { appDir: "." }, "prisma")).rejects.toThrow(
      /in prisma\/, which also holds the app's own files \(prisma\/schema\.prisma\)/,
    );
  });

  it("accepts a folder of its own, with database files or not there yet", async () => {
    const root = await repo({ "data/app.sqlite3": "", "data/.gitkeep": "", "storage/.keep": "" });
    await expect(checkSqliteFolder(root, { appDir: "." }, "data")).resolves.toBeUndefined();
    await expect(checkSqliteFolder(root, { appDir: "." }, "storage")).resolves.toBeUndefined();
    await expect(checkSqliteFolder(root, { appDir: "." }, "db")).resolves.toBeUndefined();
  });
});
