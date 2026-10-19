/**
 * Backing-service detection from runtime dependencies, configuration and env files (development
 * and test dependencies never count). Evidence strings look like `dependency:pg`,
 * `prisma:postgresql`, `config:django.db.backends.postgresql`, `env:DATABASE_URL` or
 * `env:DB_CONNECTION=mariadb`.
 */
import type { EnvUrlScheme, ServiceKind } from "@opscrew/plan-schema";
import { type EnvUrl, serviceOfScheme } from "./connections";
import type { Dependency, DependencyEcosystem, Unit } from "./manifests";
import { sortStrings } from "./paths";

/** A detected service with sorted, unique evidence and the variable holding its URL. */
export interface DetectedService {
  kind: ServiceKind;
  evidence: string[];
  variable?: string;
}

/** Client packages per ecosystem; NuGet names in lower case (NuGet ignores case). */
const DEPENDENCY_SERVICES: Record<DependencyEcosystem, Record<string, ServiceKind[]>> = {
  npm: {
    pg: ["postgres"],
    postgres: ["postgres"],
    "@neondatabase/serverless": ["postgres"],
    "@vercel/postgres": ["postgres"],
    mysql: ["mysql"],
    mysql2: ["mysql"],
    mariadb: ["mariadb"],
    mongoose: ["mongodb"],
    mongodb: ["mongodb"],
    redis: ["redis"],
    ioredis: ["redis"],
    "redis-om": ["redis"],
    amqplib: ["amqp"],
    "amqp-connection-manager": ["amqp"],
    nats: ["nats"],
    "@nats-io/transport-node": ["nats"],
    kafkajs: ["kafka"],
    "@confluentinc/kafka-javascript": ["kafka"],
    bullmq: ["queue", "redis"],
    bull: ["queue", "redis"],
    "bee-queue": ["queue", "redis"],
    agenda: ["queue", "mongodb"],
    "@temporalio/worker": ["queue"],
    "better-sqlite3": ["sqlite"],
    sqlite3: ["sqlite"],
    "@supabase/supabase-js": ["supabase"],
    "@supabase/ssr": ["supabase"],
    firebase: ["firebase"],
    "firebase-admin": ["firebase"],
    "@aws-sdk/client-s3": ["s3"],
    minio: ["s3"],
    "@opensearch-project/opensearch": ["opensearch"],
    "@elastic/elasticsearch": ["elasticsearch"],
    meilisearch: ["meilisearch"],
    typesense: ["typesense"],
    "@clickhouse/client": ["clickhouse"],
    "neo4j-driver": ["neo4j"],
    "cassandra-driver": ["cassandra"],
    stripe: ["stripe"],
    nodemailer: ["email"],
    resend: ["email"],
    "@sendgrid/mail": ["email"],
    postmark: ["email"],
    "socket.io": ["websocket"],
    ws: ["websocket"],
    "node-cron": ["cron"],
    cron: ["cron"],
  },
  pypi: {
    psycopg: ["postgres"],
    "psycopg-binary": ["postgres"],
    psycopg2: ["postgres"],
    "psycopg2-binary": ["postgres"],
    asyncpg: ["postgres"],
    pymysql: ["mysql"],
    mysqlclient: ["mysql"],
    "mysql-connector-python": ["mysql"],
    aiomysql: ["mysql"],
    mariadb: ["mariadb"],
    pymongo: ["mongodb"],
    motor: ["mongodb"],
    mongoengine: ["mongodb"],
    redis: ["redis"],
    "flask-redis": ["redis"],
    "django-redis": ["redis"],
    "redis-om": ["redis"],
    pika: ["amqp"],
    "aio-pika": ["amqp"],
    "nats-py": ["nats"],
    "confluent-kafka": ["kafka"],
    "kafka-python": ["kafka"],
    aiokafka: ["kafka"],
    rq: ["queue", "redis"],
    "django-rq": ["queue", "redis"],
    celery: ["queue"],
    dramatiq: ["queue"],
    huey: ["queue"],
    arq: ["queue", "redis"],
    supabase: ["supabase"],
    "firebase-admin": ["firebase"],
    minio: ["s3"],
    "opensearch-py": ["opensearch"],
    elasticsearch: ["elasticsearch"],
    meilisearch: ["meilisearch"],
    typesense: ["typesense"],
    "clickhouse-connect": ["clickhouse"],
    "clickhouse-driver": ["clickhouse"],
    neo4j: ["neo4j"],
    neomodel: ["neo4j"],
    "cassandra-driver": ["cassandra"],
    stripe: ["stripe"],
    websockets: ["websocket"],
    apscheduler: ["cron"],
  },
  gem: {
    pg: ["postgres"],
    mysql2: ["mysql"],
    trilogy: ["mysql"],
    mongoid: ["mongodb"],
    mongo: ["mongodb"],
    redis: ["redis"],
    bunny: ["amqp"],
    sneakers: ["amqp"],
    "nats-pure": ["nats"],
    karafka: ["kafka"],
    "ruby-kafka": ["kafka"],
    rdkafka: ["kafka"],
    sidekiq: ["queue", "redis"],
    good_job: ["queue"],
    solid_queue: ["queue"],
    resque: ["queue", "redis"],
    sqlite3: ["sqlite"],
    "aws-sdk-s3": ["s3"],
    "opensearch-ruby": ["opensearch"],
    elasticsearch: ["elasticsearch"],
    meilisearch: ["meilisearch"],
    "meilisearch-rails": ["meilisearch"],
    typesense: ["typesense"],
    click_house: ["clickhouse"],
    "clickhouse-activerecord": ["clickhouse"],
    "neo4j-ruby-driver": ["neo4j"],
    activegraph: ["neo4j"],
    "cassandra-driver": ["cassandra"],
    stripe: ["stripe"],
  },
  composer: {
    "predis/predis": ["redis"],
    "mongodb/mongodb": ["mongodb"],
    "mongodb/laravel-mongodb": ["mongodb"],
    "php-amqplib/php-amqplib": ["amqp"],
    "vladimir-yuldashev/laravel-queue-rabbitmq": ["amqp"],
    "basis-company/nats": ["nats"],
    "laravel/horizon": ["queue", "redis"],
    "league/flysystem-aws-s3-v3": ["s3"],
    "async-aws/s3": ["s3"],
    "opensearch-project/opensearch-php": ["opensearch"],
    "elasticsearch/elasticsearch": ["elasticsearch"],
    "meilisearch/meilisearch-php": ["meilisearch"],
    "typesense/typesense-php": ["typesense"],
    "smi2/phpclickhouse": ["clickhouse"],
    "laudis/neo4j-php-client": ["neo4j"],
  },
  go: {
    "github.com/lib/pq": ["postgres"],
    "github.com/jackc/pgx": ["postgres"],
    "github.com/go-sql-driver/mysql": ["mysql"],
    "go.mongodb.org/mongo-driver": ["mongodb"],
    "github.com/redis/go-redis": ["redis"],
    "github.com/go-redis/redis": ["redis"],
    "github.com/rabbitmq/amqp091-go": ["amqp"],
    "github.com/streadway/amqp": ["amqp"],
    "github.com/nats-io/nats.go": ["nats"],
    "github.com/segmentio/kafka-go": ["kafka"],
    "github.com/IBM/sarama": ["kafka"],
    "github.com/Shopify/sarama": ["kafka"],
    "github.com/twmb/franz-go": ["kafka"],
    "github.com/confluentinc/confluent-kafka-go": ["kafka"],
    "github.com/hibiken/asynq": ["queue", "redis"],
    "github.com/riverqueue/river": ["queue"],
    "github.com/mattn/go-sqlite3": ["sqlite"],
    "modernc.org/sqlite": ["sqlite"],
    "github.com/aws/aws-sdk-go-v2/service/s3": ["s3"],
    "github.com/minio/minio-go": ["s3"],
    "github.com/opensearch-project/opensearch-go": ["opensearch"],
    "github.com/elastic/go-elasticsearch": ["elasticsearch"],
    "github.com/meilisearch/meilisearch-go": ["meilisearch"],
    "github.com/typesense/typesense-go": ["typesense"],
    "github.com/ClickHouse/clickhouse-go": ["clickhouse"],
    "github.com/neo4j/neo4j-go-driver": ["neo4j"],
    "github.com/gocql/gocql": ["cassandra"],
    "github.com/apache/cassandra-gocql-driver": ["cassandra"],
  },
  maven: {
    "org.postgresql:postgresql": ["postgres"],
    "com.mysql:mysql-connector-j": ["mysql"],
    "mysql:mysql-connector-java": ["mysql"],
    "org.mariadb.jdbc:mariadb-java-client": ["mariadb"],
    "org.mongodb:mongodb-driver-sync": ["mongodb"],
    "org.mongodb:mongodb-driver-reactivestreams": ["mongodb"],
    "org.springframework.boot:spring-boot-starter-data-mongodb": ["mongodb"],
    "org.springframework.boot:spring-boot-starter-data-mongodb-reactive": ["mongodb"],
    "org.springframework.boot:spring-boot-starter-data-redis": ["redis"],
    "redis.clients:jedis": ["redis"],
    "io.lettuce:lettuce-core": ["redis"],
    "org.springframework.boot:spring-boot-starter-amqp": ["amqp"],
    "com.rabbitmq:amqp-client": ["amqp"],
    "io.nats:jnats": ["nats"],
    "org.springframework.kafka:spring-kafka": ["kafka"],
    "org.apache.kafka:kafka-clients": ["kafka"],
    "org.xerial:sqlite-jdbc": ["sqlite"],
    "software.amazon.awssdk:s3": ["s3"],
    "com.amazonaws:aws-java-sdk-s3": ["s3"],
    "io.minio:minio": ["s3"],
    "org.opensearch.client:opensearch-java": ["opensearch"],
    "org.opensearch.client:opensearch-rest-high-level-client": ["opensearch"],
    "co.elastic.clients:elasticsearch-java": ["elasticsearch"],
    "org.springframework.boot:spring-boot-starter-data-elasticsearch": ["elasticsearch"],
    "com.meilisearch.sdk:meilisearch-java": ["meilisearch"],
    "org.typesense:typesense-java": ["typesense"],
    "com.clickhouse:clickhouse-jdbc": ["clickhouse"],
    "com.clickhouse:client-v2": ["clickhouse"],
    "org.neo4j.driver:neo4j-java-driver": ["neo4j"],
    "org.springframework.boot:spring-boot-starter-data-neo4j": ["neo4j"],
    "org.apache.cassandra:java-driver-core": ["cassandra"],
    "com.datastax.oss:java-driver-core": ["cassandra"],
    "org.springframework.boot:spring-boot-starter-data-cassandra": ["cassandra"],
  },
  nuget: {
    npgsql: ["postgres"],
    "npgsql.entityframeworkcore.postgresql": ["postgres"],
    "mysql.data": ["mysql"],
    mysqlconnector: ["mysql"],
    "pomelo.entityframeworkcore.mysql": ["mysql"],
    "mongodb.driver": ["mongodb"],
    "mongodb.entityframeworkcore": ["mongodb"],
    "stackexchange.redis": ["redis"],
    "microsoft.extensions.caching.stackexchangeredis": ["redis"],
    "rabbitmq.client": ["amqp"],
    "masstransit.rabbitmq": ["amqp"],
    "nats.net": ["nats"],
    "nats.client": ["nats"],
    "confluent.kafka": ["kafka"],
    "microsoft.data.sqlite": ["sqlite"],
    "microsoft.entityframeworkcore.sqlite": ["sqlite"],
    "awssdk.s3": ["s3"],
    minio: ["s3"],
    "opensearch.client": ["opensearch"],
    "opensearch.net": ["opensearch"],
    "elastic.clients.elasticsearch": ["elasticsearch"],
    nest: ["elasticsearch"],
    meilisearch: ["meilisearch"],
    typesense: ["typesense"],
    "clickhouse.client": ["clickhouse"],
    "clickhouse.driver": ["clickhouse"],
    "neo4j.driver": ["neo4j"],
    cassandracsharpdriver: ["cassandra"],
  },
};

const PRISMA_PROVIDERS: Record<string, ServiceKind> = {
  postgresql: "postgres",
  postgres: "postgres",
  cockroachdb: "postgres",
  mysql: "mysql",
  sqlite: "sqlite",
  mongodb: "mongodb",
};

const DJANGO_ENGINES: Record<string, ServiceKind> = {
  postgresql: "postgres",
  postgresql_psycopg2: "postgres",
  mysql: "mysql",
  sqlite3: "sqlite",
};

/** Laravel's `DB_CONNECTION` values. */
const LARAVEL_CONNECTIONS: Record<string, ServiceKind> = {
  mysql: "mysql",
  mariadb: "mariadb",
  pgsql: "postgres",
  sqlite: "sqlite",
};

/** Accumulates evidence per service kind. */
export class ServiceCollector {
  private readonly byKind = new Map<ServiceKind, Set<string>>();

  add(kind: ServiceKind, evidence: string): void {
    const set = this.byKind.get(kind) ?? new Set<string>();
    set.add(evidence);
    this.byKind.set(kind, set);
  }

  has(kind: ServiceKind): boolean {
    return this.byKind.has(kind);
  }

  /** Moves the evidence of `from` to `to`, dropping `from`. */
  merge(from: ServiceKind, to: ServiceKind): void {
    for (const evidence of this.byKind.get(from) ?? []) this.add(to, evidence);
    this.byKind.delete(from);
  }

  /** Services sorted by kind, each with sorted evidence. */
  toList(): DetectedService[] {
    return sortStrings(this.byKind.keys()).map((kind) => ({
      kind: kind as ServiceKind,
      evidence: sortStrings(this.byKind.get(kind as ServiceKind) ?? []),
    }));
  }
}

/** Services implied by one runtime dependency, by the client tables. */
function clientServices(dep: Dependency): ServiceKind[] {
  const name = dep.ecosystem === "nuget" ? dep.name.toLowerCase() : dep.name;
  return DEPENDENCY_SERVICES[dep.ecosystem][name] ?? [];
}

/**
 * Adds services implied by a unit's runtime dependencies. ORMs (Prisma, Drizzle, TypeORM,
 * Sequelize) are covered by their database driver or schema; SQLAlchemy counts as Postgres only
 * when a `postgres://` URL appears in Python code. boto3 counts as S3 only with an S3 client in
 * Python code (`pythonS3`: it also serves SQS or SES), django-storages only with its `s3` or
 * `boto3` extra or boto3 beside it. Celery's broker follows its broker URL's scheme
 * (`brokerScheme`, from a `*BROKER*` variable): AMQP or Redis. Without one, every AMQP and Redis
 * URL in Python code or committed env and compose files (`configUrlSchemes`) counts, and with
 * neither a Redis service in a committed compose file (`composeRedis`). `celery[redis]` and
 * Dramatiq's `redis` and `rabbitmq` extras add their broker too.
 */
export function addDependencyServices(
  collector: ServiceCollector,
  unit: Unit,
  context: {
    pythonUrlSchemes: ReadonlySet<string>;
    configUrlSchemes?: ReadonlySet<string>;
    composeRedis?: boolean;
    brokerScheme?: EnvUrlScheme;
    pythonS3?: boolean;
  },
): void {
  const has = (scheme: string) =>
    context.pythonUrlSchemes.has(scheme) || context.configUrlSchemes?.has(scheme) === true;
  const runtime = unit.dependencies.filter((dep) => !dep.dev);
  for (const dep of runtime) {
    const evidence = `dependency:${dep.name}`;
    for (const kind of clientServices(dep)) collector.add(kind, evidence);
    if (dep.ecosystem !== "pypi") continue;
    if (dep.name === "celery") {
      const redisExtra = dep.extras.includes("redis");
      if (redisExtra) collector.add("redis", `${evidence}[redis]`);
      const brokers: readonly string[] =
        context.brokerScheme === undefined ? ["amqp", "redis"].filter(has) : [context.brokerScheme];
      if (brokers.includes("amqp")) collector.add("amqp", "config:amqp-broker");
      if (brokers.includes("redis") && !redisExtra) collector.add("redis", "config:redis-broker");
      if (context.brokerScheme === undefined && brokers.length === 0 && !redisExtra) {
        if (context.composeRedis) collector.add("redis", "compose:redis");
      }
    }
    if (dep.name === "dramatiq") {
      if (dep.extras.includes("redis")) collector.add("redis", `${evidence}[redis]`);
      if (dep.extras.includes("rabbitmq")) collector.add("amqp", `${evidence}[rabbitmq]`);
    }
    if (dep.name === "sqlalchemy" && context.pythonUrlSchemes.has("postgres")) {
      collector.add("postgres", evidence);
    }
    if (dep.name === "boto3" && context.pythonS3) collector.add("s3", evidence);
    if (
      dep.name === "django-storages" &&
      (dep.extras.some((extra) => extra === "s3" || extra === "boto3") ||
        runtime.some((other) => other.ecosystem === "pypi" && other.name === "boto3"))
    ) {
      collector.add("s3", evidence);
    }
  }
}

/**
 * Adds the datasource provider of a Prisma schema (`prisma:postgresql`), plus the Prisma client
 * runtime dependency of the given units as evidence for the same service.
 */
export function addPrismaServices(
  collector: ServiceCollector,
  schemaText: string,
  units: readonly Unit[],
): void {
  const provider = prismaProvider(schemaText);
  const kind = provider ? PRISMA_PROVIDERS[provider] : undefined;
  if (!provider || !kind) return;
  collector.add(kind, `prisma:${provider}`);
  for (const unit of units) {
    for (const dep of unit.dependencies) {
      if (dep.ecosystem === "npm" && dep.name === "@prisma/client" && !dep.dev) {
        collector.add(kind, `dependency:${dep.name}`);
      }
    }
  }
}

/** The datasource provider of a Prisma schema (`postgresql`, `sqlite`). */
export function prismaProvider(schemaText: string): string | undefined {
  return /datasource\s+\w+\s*\{[^}]*?\bprovider\s*=\s*"(\w+)"/s.exec(schemaText)?.[1];
}

/** Adds database engines named in Django settings (`config:django.db.backends.postgresql`). */
export function addDjangoServices(collector: ServiceCollector, settingsText: string): void {
  for (const match of settingsText.matchAll(/["']django\.db\.backends\.(\w+)["']/g)) {
    const engine = match[1] ?? "";
    const kind = DJANGO_ENGINES[engine];
    if (kind) collector.add(kind, `config:django.db.backends.${engine}`);
  }
}

/**
 * Adds services the env files and variable names show: Laravel's `DB_CONNECTION`
 * (`dbConnection`), a `mariadb://` URL, `POSTGRES_*` → postgres, `REDIS_URL` → redis, and
 * `DATABASE_URL` → postgres unless its example URL is another database's or another database
 * (MySQL, MariaDB, SQLite, MongoDB) was already detected without Postgres. MariaDB, which the app
 * must declare, then takes over MySQL's evidence: they share clients.
 */
export function addEnvServices(
  collector: ServiceCollector,
  envVars: readonly { name: string; urlScheme?: EnvUrlScheme }[],
  urls: ReadonlyMap<string, EnvUrl>,
  dbConnection: string | undefined,
): void {
  const connection = dbConnection === undefined ? undefined : LARAVEL_CONNECTIONS[dbConnection];
  if (connection) collector.add(connection, `env:DB_CONNECTION=${dbConnection}`);
  for (const [name, url] of urls) {
    if (serviceOfScheme(url.scheme) === "mariadb") collector.add("mariadb", `env:${name}`);
  }
  const otherDatabase =
    !collector.has("postgres") &&
    (["mysql", "mariadb", "sqlite", "mongodb"] as const).some((kind) => collector.has(kind));
  for (const { name, urlScheme } of envVars) {
    if (name.startsWith("POSTGRES_")) collector.add("postgres", `env:${name}`);
    if (
      name === "DATABASE_URL" &&
      !otherDatabase &&
      (urlScheme === undefined || urlScheme === "postgres")
    ) {
      collector.add("postgres", `env:${name}`);
    }
    if (name === "REDIS_URL") collector.add("redis", `env:${name}`);
  }
  if (collector.has("mariadb")) collector.merge("mysql", "mariadb");
}

/** Laravel's settings that put the queue, the cache or sessions on Redis, and their config file. */
export const LARAVEL_REDIS_SETTINGS = [
  ["QUEUE_CONNECTION", "config/queue.php"],
  ["CACHE_STORE", "config/cache.php"],
  ["CACHE_DRIVER", "config/cache.php"],
  ["SESSION_DRIVER", "config/session.php"],
] as const;

/** The default a Laravel config file gives `name` (`env('QUEUE_CONNECTION', 'redis')`). */
export function laravelConfigDefault(phpText: string, name: string): string | undefined {
  return new RegExp(`\\benv\\(\\s*['"]${name}['"]\\s*,\\s*['"](\\w+)['"]`).exec(phpText)?.[1];
}

/**
 * Adds Redis for Laravel settings set to `redis` (`settings` as evidence, `env:CACHE_STORE=redis`
 * or `config:…` for a config file's default): a queue on Redis is also a `queue`, so it gets a
 * Redis that keeps its jobs, like Sidekiq's.
 */
export function addLaravelRedis(collector: ServiceCollector, settings: readonly string[]): void {
  for (const evidence of settings) {
    if (!evidence.endsWith("=redis")) continue;
    collector.add("redis", evidence);
    if (evidence.includes(":QUEUE_CONNECTION=")) collector.add("queue", evidence);
  }
}

/** Names apps conventionally read a service's URL or address from, the most usual first. */
const URL_VARIABLES: Partial<Record<ServiceKind, readonly string[]>> = {
  postgres: ["DATABASE_URL", "POSTGRES_URL"],
  mysql: ["DATABASE_URL", "MYSQL_URL"],
  mariadb: ["DATABASE_URL", "MARIADB_URL", "MYSQL_URL"],
  mongodb: ["MONGODB_URI", "MONGODB_URL", "MONGO_URI", "MONGO_URL", "DATABASE_URL"],
  redis: ["REDIS_URL"],
  amqp: ["AMQP_URL", "RABBITMQ_URL", "CLOUDAMQP_URL", "CELERY_BROKER_URL"],
  nats: ["NATS_URL"],
  kafka: ["KAFKA_BROKERS", "KAFKA_BOOTSTRAP_SERVERS"],
  opensearch: ["OPENSEARCH_URL", "OPENSEARCH_NODE"],
  elasticsearch: ["ELASTICSEARCH_URL", "ELASTICSEARCH_NODE"],
  meilisearch: ["MEILISEARCH_HOST", "MEILISEARCH_URL", "MEILI_HOST"],
  typesense: ["TYPESENSE_HOST", "TYPESENSE_URL"],
  clickhouse: ["CLICKHOUSE_URL", "CLICKHOUSE_HOST"],
  neo4j: ["NEO4J_URI", "NEO4J_URL"],
  cassandra: ["CASSANDRA_CONTACT_POINTS"],
};

/**
 * The variable the app reads `kind`'s URL from: one whose example URL has the service's scheme
 * (conventional names first), else a conventional name the app reads whose example, if any, is
 * not another service's URL. MariaDB accepts `mysql://` URLs.
 */
function urlVariable(
  kind: ServiceKind,
  names: readonly string[],
  urls: ReadonlyMap<string, EnvUrl>,
): string | undefined {
  const fits = (name: string): boolean | undefined => {
    const url = urls.get(name);
    if (url === undefined || url.scheme === "") return undefined;
    const of = serviceOfScheme(url.scheme);
    return of === kind || (kind === "mariadb" && of === "mysql");
  };
  const conventional = (URL_VARIABLES[kind] ?? []).filter((name) => names.includes(name));
  return (
    [...conventional, ...names].find((name) => fits(name) === true) ??
    conventional.find((name) => fits(name) !== false)
  );
}

/** The services with the variable each one's URL is read from, when one is found. */
export function withUrlVariables(
  services: readonly DetectedService[],
  names: readonly string[],
  urls: ReadonlyMap<string, EnvUrl>,
): DetectedService[] {
  return services.map((service) => {
    const variable = urlVariable(service.kind, names, urls);
    return variable === undefined ? service : { ...service, variable };
  });
}
