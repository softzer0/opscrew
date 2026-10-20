import type { ProjectFacts } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function detect(files: Record<string, string>): Promise<ProjectFacts> {
  const root = await makeTree(files, "components");
  roots.push(root);
  return detectProject(root);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

type Ecosystem = "npm" | "pypi" | "gem" | "composer" | "go" | "maven" | "gradle" | "nuget";

/** One manifest declaring `name` (`group:artifact` for Maven and Gradle), at runtime or for dev. */
function manifest(ecosystem: Ecosystem, name: string, dev = false): Record<string, string> {
  switch (ecosystem) {
    case "npm":
      return {
        "package.json": JSON.stringify({
          name: "app",
          [dev ? "devDependencies" : "dependencies"]: { [name]: "^1.0.0" },
        }),
      };
    case "pypi":
      return { [dev ? "requirements-dev.txt" : "requirements.txt"]: `${name}==1.0\n` };
    case "gem":
      return {
        Gemfile: dev ? `group :development, :test do\n  gem "${name}"\nend\n` : `gem "${name}"\n`,
      };
    case "composer":
      return {
        "composer.json": JSON.stringify({ [dev ? "require-dev" : "require"]: { [name]: "^1.0" } }),
      };
    case "go":
      return { "go.mod": `module example.com/app\n\ngo 1.23\n\nrequire ${name} v1.2.3\n` };
    case "maven": {
      const [groupId, artifactId] = name.split(":");
      const scope = dev ? "<scope>test</scope>" : "";
      return {
        "pom.xml": `<project><dependencies><dependency><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId>${scope}</dependency></dependencies></project>`,
      };
    }
    case "gradle":
      return {
        "build.gradle.kts": `dependencies {\n  ${dev ? "testImplementation" : "implementation"}("${name}:1.0.0")\n}\n`,
      };
    case "nuget":
      return {
        [dev ? "Api.Tests.csproj" : "Api.csproj"]:
          `<Project Sdk="Microsoft.NET.Sdk${dev ? "" : ".Web"}"><ItemGroup><PackageReference Include="${name}" Version="1.0.0" />${dev ? '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />' : ""}</ItemGroup></Project>`,
      };
  }
}

const kinds = (facts: ProjectFacts) => facts.services.map((service) => service.kind);

describe("service kinds from client libraries", () => {
  it.each([
    ["npm", "mysql2", "mysql"],
    ["npm", "mariadb", "mariadb"],
    ["npm", "mongoose", "mongodb"],
    ["npm", "amqplib", "amqp"],
    ["npm", "nats", "nats"],
    ["npm", "kafkajs", "kafka"],
    ["npm", "@aws-sdk/client-s3", "s3"],
    ["npm", "minio", "s3"],
    ["npm", "@opensearch-project/opensearch", "opensearch"],
    ["npm", "@elastic/elasticsearch", "elasticsearch"],
    ["npm", "meilisearch", "meilisearch"],
    ["npm", "typesense", "typesense"],
    ["npm", "@clickhouse/client", "clickhouse"],
    ["npm", "neo4j-driver", "neo4j"],
    ["npm", "cassandra-driver", "cassandra"],
    ["pypi", "pymysql", "mysql"],
    ["pypi", "mariadb", "mariadb"],
    ["pypi", "pymongo", "mongodb"],
    ["pypi", "pika", "amqp"],
    ["pypi", "nats-py", "nats"],
    ["pypi", "confluent-kafka", "kafka"],
    ["pypi", "opensearch-py", "opensearch"],
    ["pypi", "elasticsearch", "elasticsearch"],
    ["pypi", "meilisearch", "meilisearch"],
    ["pypi", "typesense", "typesense"],
    ["pypi", "clickhouse-connect", "clickhouse"],
    ["pypi", "neo4j", "neo4j"],
    ["pypi", "cassandra-driver", "cassandra"],
    ["gem", "trilogy", "mysql"],
    ["gem", "mongoid", "mongodb"],
    ["gem", "bunny", "amqp"],
    ["gem", "nats-pure", "nats"],
    ["gem", "karafka", "kafka"],
    ["gem", "aws-sdk-s3", "s3"],
    ["gem", "opensearch-ruby", "opensearch"],
    ["gem", "elasticsearch", "elasticsearch"],
    ["gem", "meilisearch-rails", "meilisearch"],
    ["gem", "typesense", "typesense"],
    ["gem", "click_house", "clickhouse"],
    ["gem", "neo4j-ruby-driver", "neo4j"],
    ["gem", "cassandra-driver", "cassandra"],
    ["composer", "mongodb/laravel-mongodb", "mongodb"],
    ["composer", "php-amqplib/php-amqplib", "amqp"],
    ["composer", "basis-company/nats", "nats"],
    ["composer", "league/flysystem-aws-s3-v3", "s3"],
    ["composer", "opensearch-project/opensearch-php", "opensearch"],
    ["composer", "elasticsearch/elasticsearch", "elasticsearch"],
    ["composer", "meilisearch/meilisearch-php", "meilisearch"],
    ["composer", "typesense/typesense-php", "typesense"],
    ["composer", "smi2/phpclickhouse", "clickhouse"],
    ["composer", "laudis/neo4j-php-client", "neo4j"],
    ["go", "github.com/go-sql-driver/mysql", "mysql"],
    ["go", "go.mongodb.org/mongo-driver/v2", "mongodb"],
    ["go", "github.com/rabbitmq/amqp091-go", "amqp"],
    ["go", "github.com/nats-io/nats.go", "nats"],
    ["go", "github.com/segmentio/kafka-go", "kafka"],
    ["go", "github.com/aws/aws-sdk-go-v2/service/s3", "s3"],
    ["go", "github.com/opensearch-project/opensearch-go/v4", "opensearch"],
    ["go", "github.com/elastic/go-elasticsearch/v8", "elasticsearch"],
    ["go", "github.com/meilisearch/meilisearch-go", "meilisearch"],
    ["go", "github.com/typesense/typesense-go/v3", "typesense"],
    ["go", "github.com/ClickHouse/clickhouse-go/v2", "clickhouse"],
    ["go", "github.com/neo4j/neo4j-go-driver/v5", "neo4j"],
    ["go", "github.com/gocql/gocql", "cassandra"],
    ["maven", "com.mysql:mysql-connector-j", "mysql"],
    ["maven", "org.mariadb.jdbc:mariadb-java-client", "mariadb"],
    ["maven", "org.springframework.boot:spring-boot-starter-data-mongodb", "mongodb"],
    ["maven", "org.springframework.boot:spring-boot-starter-amqp", "amqp"],
    ["maven", "io.nats:jnats", "nats"],
    ["maven", "org.springframework.kafka:spring-kafka", "kafka"],
    ["maven", "software.amazon.awssdk:s3", "s3"],
    ["maven", "org.opensearch.client:opensearch-java", "opensearch"],
    ["maven", "co.elastic.clients:elasticsearch-java", "elasticsearch"],
    ["maven", "com.meilisearch.sdk:meilisearch-java", "meilisearch"],
    ["maven", "org.typesense:typesense-java", "typesense"],
    ["maven", "com.clickhouse:clickhouse-jdbc", "clickhouse"],
    ["maven", "org.neo4j.driver:neo4j-java-driver", "neo4j"],
    ["maven", "org.apache.cassandra:java-driver-core", "cassandra"],
    ["gradle", "org.postgresql:postgresql", "postgres"],
    ["gradle", "org.springframework.kafka:spring-kafka", "kafka"],
    ["nuget", "MySqlConnector", "mysql"],
    ["nuget", "MongoDB.Driver", "mongodb"],
    ["nuget", "RabbitMQ.Client", "amqp"],
    ["nuget", "NATS.Net", "nats"],
    ["nuget", "Confluent.Kafka", "kafka"],
    ["nuget", "AWSSDK.S3", "s3"],
    ["nuget", "OpenSearch.Client", "opensearch"],
    ["nuget", "Elastic.Clients.Elasticsearch", "elasticsearch"],
    ["nuget", "MeiliSearch", "meilisearch"],
    ["nuget", "Typesense", "typesense"],
    ["nuget", "ClickHouse.Client", "clickhouse"],
    ["nuget", "Neo4j.Driver", "neo4j"],
    ["nuget", "CassandraCSharpDriver", "cassandra"],
  ] as const)("%s %s gives %s", async (ecosystem, name, kind) => {
    const facts = await detect(manifest(ecosystem, name));
    const evidence = ecosystem === "go" ? name.replace(/\/v\d+$/, "") : name;
    expect(facts.services.find((service) => service.kind === kind)?.evidence).toContain(
      `dependency:${evidence}`,
    );
  });

  it.each([
    ["npm", "kafkajs"],
    ["pypi", "pymongo"],
    ["gem", "mongo"],
    ["composer", "php-amqplib/php-amqplib"],
    ["maven", "org.mongodb:mongodb-driver-sync"],
    ["gradle", "io.nats:jnats"],
    ["nuget", "RabbitMQ.Client"],
  ] as const)("ignores a dev-only %s dependency (%s)", async (ecosystem, name) => {
    expect((await detect(manifest(ecosystem, name, true))).services).toEqual([]);
  });

  it("tells OpenSearch and Elasticsearch apart by their clients", async () => {
    expect(kinds(await detect(manifest("npm", "@opensearch-project/opensearch")))).toEqual([
      "opensearch",
    ]);
    expect(kinds(await detect(manifest("npm", "@elastic/elasticsearch")))).toEqual([
      "elasticsearch",
    ]);
  });

  it("records MariaDB only when the app declares it, in place of MySQL", async () => {
    const mysql = { "package.json": JSON.stringify({ name: "a", dependencies: { mysql2: "^3" } }) };
    expect(kinds(await detect(mysql))).toEqual(["mysql"]);
    const byUrl = await detect({ ...mysql, ".env.example": "DATABASE_URL=mariadb://db/app\n" });
    expect(byUrl.services).toEqual([
      {
        kind: "mariadb",
        evidence: ["dependency:mysql2", "env:DATABASE_URL"],
        variable: "DATABASE_URL",
      },
    ]);
    const laravel = await detect({
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
      ".env.example": "DB_CONNECTION=mariadb\nDB_HOST=127.0.0.1\n",
    });
    expect(laravel.services).toEqual([
      { kind: "mariadb", evidence: ["env:DB_CONNECTION=mariadb"] },
    ]);
  });

  it("reads Laravel's database connection", async () => {
    const facts = await detect({
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
      ".env.example": "DB_CONNECTION=pgsql\n",
    });
    expect(kinds(facts)).toEqual(["postgres"]);
  });

  it("reads Laravel's Redis queue, cache and sessions from the env example or config", async () => {
    const laravel = {
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^12" } }),
    };
    const queue = await detect({ ...laravel, ".env.example": "QUEUE_CONNECTION=redis\n" });
    expect(queue.services).toEqual([
      { kind: "queue", evidence: ["env:QUEUE_CONNECTION=redis"] },
      { kind: "redis", evidence: ["env:QUEUE_CONNECTION=redis"] },
    ]);
    const cache = await detect({
      ...laravel,
      ".env.example": "CACHE_STORE=redis\nSESSION_DRIVER=redis\nQUEUE_CONNECTION=database\n",
    });
    expect(cache.services).toEqual([
      { kind: "redis", evidence: ["env:CACHE_STORE=redis", "env:SESSION_DRIVER=redis"] },
    ]);
    expect((await detect({ ...laravel, ".env.example": "CACHE_DRIVER=redis\n" })).services).toEqual(
      [{ kind: "redis", evidence: ["env:CACHE_DRIVER=redis"] }],
    );
    const config = await detect({
      ...laravel,
      "config/queue.php": "<?php\nreturn ['default' => env('QUEUE_CONNECTION', 'redis')];\n",
      "config/cache.php": "<?php\nreturn ['default' => env('CACHE_STORE', 'database')];\n",
    });
    expect(config.services).toEqual([
      { kind: "queue", evidence: ["config:QUEUE_CONNECTION=redis"] },
      { kind: "redis", evidence: ["config:QUEUE_CONNECTION=redis"] },
    ]);
    // The env example's value wins over the config's default.
    const overridden = await detect({
      ...laravel,
      ".env.example": "QUEUE_CONNECTION=database\n",
      "config/queue.php": "<?php\nreturn ['default' => env('QUEUE_CONNECTION', 'redis')];\n",
    });
    expect(overridden.services).toEqual([]);
  });

  it("counts boto3 as S3 only with an S3 client in the code", async () => {
    expect(kinds(await detect({ "requirements.txt": "boto3\n" }))).toEqual([]);
    const facts = await detect({
      "requirements.txt": "boto3\n",
      "storage.py": 'import boto3\ns3 = boto3.client("s3")\n',
    });
    expect(kinds(facts)).toEqual(["s3"]);
  });

  it("gives each service the URL variable the app reads", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({
        name: "a",
        dependencies: {
          mongoose: "^8",
          amqplib: "^0.10",
          nats: "^2",
          kafkajs: "^2",
          ioredis: "^5",
        },
      }),
      ".env.example": [
        "MONGO_CONNECTION=mongodb://localhost:27017/app",
        "BROKER=amqp://localhost",
        "NATS_URL=nats://localhost:4222",
        "KAFKA_BROKERS=localhost:9092",
        "CACHE_URL=redis://localhost:6379",
        "",
      ].join("\n"),
    });
    expect(
      Object.fromEntries(facts.services.map((service) => [service.kind, service.variable])),
    ).toEqual({
      amqp: "BROKER",
      kafka: "KAFKA_BROKERS",
      mongodb: "MONGO_CONNECTION",
      nats: "NATS_URL",
      redis: "CACHE_URL",
    });
  });
});

describe("Celery's broker", () => {
  const celery = {
    "requirements.txt": "celery==5.4\n",
    "tasks.py":
      'import os\nfrom celery import Celery\napp = Celery("tasks", broker=os.environ["CELERY_BROKER_URL"])\n',
  };

  it("is AMQP for an amqp:// or pyamqp:// broker URL", async () => {
    for (const scheme of ["amqp", "pyamqp"]) {
      const facts = await detect({
        ...celery,
        ".env.example": `CELERY_BROKER_URL=${scheme}://rabbit//\nREDIS_URL=redis://cache:6379\n`,
      });
      expect(facts.services.find((service) => service.kind === "amqp")).toEqual({
        kind: "amqp",
        evidence: ["config:amqp-broker"],
        variable: "CELERY_BROKER_URL",
      });
      // The Redis the app reads besides is a cache, not Celery's broker.
      expect(facts.services.find((service) => service.kind === "redis")?.evidence).toEqual([
        "env:REDIS_URL",
      ]);
    }
  });

  it("is Redis for a redis:// broker URL", async () => {
    const facts = await detect({
      ...celery,
      ".env.example": "CELERY_BROKER_URL=redis://cache:6379/0\n",
    });
    expect(kinds(facts)).toEqual(["queue", "redis"]);
    expect(facts.services.find((service) => service.kind === "redis")).toEqual({
      kind: "redis",
      evidence: ["config:redis-broker"],
      variable: "CELERY_BROKER_URL",
    });
  });
});

describe("workers", () => {
  it("come from every Procfile type but web and release, schedulers single", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "^5" } }),
      Procfile:
        "web: node server.js\nrelease: npm run migrate\nworker: node worker.js\nclock: node clock.js\n",
    });
    expect(facts.workers).toEqual([
      {
        name: "clock",
        command: "node clock.js",
        source: "procfile",
        single: true,
        evidence: ["procfile:clock"],
      },
      {
        name: "worker",
        command: "node worker.js",
        source: "procfile",
        single: false,
        evidence: ["procfile:worker"],
      },
    ]);
    expect(facts.notes).toBeUndefined();
    const webOnly = await detect({
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "^5" } }),
      Procfile: "web: node server.js\nrelease: npm run migrate\n",
    });
    expect(webOnly.workers).toBeUndefined();
  });

  it("come from job libraries with their conventional commands", async () => {
    const celery = await detect({
      "requirements.txt": "celery[redis]\ndjango-celery-beat\n",
      "proj/celery.py": 'from celery import Celery\napp = Celery("proj")\n',
    });
    expect(celery.workers).toEqual([
      {
        name: "celery-beat",
        command:
          "celery -A proj.celery:app beat --loglevel=info --scheduler django_celery_beat.schedulers:DatabaseScheduler",
        source: "library",
        single: true,
        evidence: ["dependency:celery", "dependency:django-celery-beat"],
      },
      {
        name: "celery-worker",
        command: "celery -A proj.celery:app worker --loglevel=info --concurrency 2",
        source: "library",
        single: false,
        evidence: ["dependency:celery"],
      },
    ]);
  });

  it("run Celery in the room its containers have: two worker processes, beat's schedule in /tmp", async () => {
    const facts = await detect({
      "requirements.txt": "celery[redis]\n",
      "tasks.py":
        'from celery import Celery\napp = Celery("tasks")\napp.conf.beat_schedule = {"tick": {"task": "tasks.tick", "schedule": 30.0}}\n',
    });
    expect(facts.workers?.map((worker) => worker.command)).toEqual([
      "celery -A tasks:app beat --loglevel=info --schedule /tmp/celerybeat-schedule",
      "celery -A tasks:app worker --loglevel=info --concurrency 2",
    ]);
  });

  it.each([
    [{ "requirements.txt": "rq\n" }, "rq-worker", 'rq worker --url "$REDIS_URL"', false],
    [
      { "requirements.txt": "rq\n", ".env.example": "CACHE_URL=redis://cache:6379\n" },
      "rq-worker",
      'rq worker --url "$CACHE_URL"',
      false,
    ],
    [{ "requirements.txt": "django-rq\n" }, "rq-worker", "python manage.py rqworker", false],
    [
      {
        "requirements.txt": "dramatiq\ndjango-dramatiq\n",
        "app/tasks.py": "import dramatiq\n\n@dramatiq.actor\ndef send(): ...\n",
      },
      "dramatiq",
      "python manage.py rundramatiq",
      false,
    ],
    [
      {
        "requirements.txt": "dramatiq[redis]\n",
        "app/tasks.py": "import dramatiq\n\n@dramatiq.actor\ndef send(): ...\n",
      },
      "dramatiq",
      "dramatiq app.tasks",
      false,
    ],
    [
      {
        "requirements.txt": "huey\n",
        "jobs.py": "from huey import RedisHuey\nhuey = RedisHuey('app')\n",
      },
      "huey",
      "huey_consumer jobs.huey",
      false,
    ],
    [{ Gemfile: 'gem "sidekiq"\n' }, "sidekiq", "bundle exec sidekiq", false],
    [{ Gemfile: 'gem "sidekiq"\ngem "sidekiq-cron"\n' }, "sidekiq", "bundle exec sidekiq", true],
    [{ Gemfile: 'gem "good_job"\n' }, "good-job", "bundle exec good_job start", false],
    [
      { Gemfile: 'gem "solid_queue"\n', "bin/jobs": "#!/usr/bin/env ruby\n" },
      "solid-queue",
      "bin/jobs",
      true,
    ],
    [{ Gemfile: 'gem "resque"\n' }, "resque", "bundle exec rake resque:work QUEUE=*", false],
    [
      { "package.json": JSON.stringify({ name: "a", dependencies: { bullmq: "^5" } }) },
      "bullmq",
      undefined,
      false,
    ],
    [
      {
        "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
        "app/Jobs/SendMail.php": "<?php\n",
      },
      "queue-worker",
      "php artisan queue:work",
      false,
    ],
    [
      {
        "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
        "routes/console.php": "<?php\nSchedule::command('emails:send')->daily();\n",
      },
      "scheduler",
      "php artisan schedule:work",
      true,
    ],
    [manifest("go", "github.com/hibiken/asynq"), "asynq", undefined, false],
    [manifest("go", "github.com/riverqueue/river"), "river", undefined, false],
  ] as const)("%j gives the %s worker", async (files, name, command, single) => {
    const facts = await detect(files);
    const worker = facts.workers?.find((w) => w.name === name);
    expect(worker).toMatchObject({ name, source: "library", single });
    expect(worker?.command).toBe(command);
  });

  it("take the Procfile's command over a library's for the same process", async () => {
    const facts = await detect({
      "requirements.txt": "celery\n",
      "tasks.py": 'from celery import Celery\napp = Celery("tasks")\n',
      Procfile: "web: gunicorn app:app\nqueue: celery -A tasks worker -c 2\n",
    });
    expect(facts.workers).toEqual([
      {
        name: "queue",
        command: "celery -A tasks worker -c 2",
        source: "procfile",
        single: false,
        evidence: ["procfile:queue"],
      },
    ]);
    const bull = await detect({
      "package.json": JSON.stringify({ name: "a", dependencies: { bullmq: "^5", express: "^5" } }),
      Procfile: "web: node server.js\nworker: node worker.js\n",
    });
    expect(bull.workers?.map((w) => w.name)).toEqual(["worker"]);
  });

  it("leave the command out when no convention gives it", async () => {
    const facts = await detect({ "requirements.txt": "celery\n" });
    expect(facts.workers).toEqual([
      { name: "celery-worker", source: "library", single: false, evidence: ["dependency:celery"] },
    ]);
  });

  it("note an in-process scheduler instead of adding a worker", async () => {
    const node = await detect(manifest("npm", "node-cron"));
    expect(node.workers).toBeUndefined();
    expect(node.notes).toEqual([
      "The app runs scheduled jobs inside its own process (node-cron), so OpsCrew adds no separate process for them. Keep one copy of the app running, or make sure each job runs only once when several copies run.",
    ]);
    expect((await detect(manifest("pypi", "apscheduler"))).notes?.[0]).toContain("(APScheduler)");
    expect((await detect(manifest("nuget", "Hangfire.AspNetCore"))).notes?.[0]).toContain(
      "(Hangfire)",
    );
    expect((await detect(manifest("nuget", "Quartz"))).notes?.[0]).toContain("(Quartz)");
    const spring = await detect({
      ...manifest("maven", "org.springframework.boot:spring-boot-starter-web"),
      "src/main/java/app/App.java":
        "@SpringBootApplication\n@EnableScheduling\npublic class App {}\n",
    });
    expect(spring.notes?.[0]).toContain("(Spring's @Scheduled)");
    expect((await detect(manifest("npm", "node-cron", true))).notes).toBeUndefined();
  });
});

describe("cron jobs", () => {
  it("come from vercel.json crons", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({ name: "a", dependencies: { next: "^15" } }),
      "vercel.json": JSON.stringify({
        crons: [
          { path: "/api/cron/digest", schedule: "0 8 * * *" },
          { path: "/api/cleanup?days=7", schedule: "*/5 * * * *" },
        ],
      }),
    });
    expect(facts.cronJobs).toEqual([
      { schedule: "0 8 * * *", route: "/api/cron/digest", source: "vercel.json" },
      { schedule: "*/5 * * * *", route: "/api/cleanup?days=7", source: "vercel.json" },
    ]);
  });
});

describe("hosted services", () => {
  it("come from the URLs in env examples, with their variable and provider", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({
        name: "a",
        dependencies: { mongoose: "^8", ioredis: "^5" },
      }),
      ".env.example": [
        "MONGODB_URI=mongodb+srv://cluster0.abcde.example.net/app",
        'PLANETSCALE_URL="mysql://aws.connect.psdb.cloud/app?sslaccept=strict"',
        "UPSTASH_REDIS_URL=rediss://default@eu1-sharp-cat-12345.upstash.io:6379",
        "NEON_URL=postgresql://user@ep-cool-123.eu-central-1.aws.neon.tech/neondb",
        "LOCAL_URL=postgresql://localhost/app",
        "SITE_URL=https://www.example.com",
        "",
      ].join("\n"),
    });
    expect(facts.hostedServices).toEqual([
      { kind: "mongodb", variable: "MONGODB_URI", provider: "MongoDB Atlas" },
      { kind: "postgres", variable: "NEON_URL", provider: "Neon" },
      { kind: "mysql", variable: "PLANETSCALE_URL", provider: "PlanetScale" },
      { kind: "redis", variable: "UPSTASH_REDIS_URL", provider: "Upstash" },
    ]);
  });

  it("keep Supabase as today's supabase service", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({
        name: "a",
        dependencies: { "@supabase/supabase-js": "^2", pg: "^8" },
      }),
      ".env.example": "DATABASE_URL=postgresql://postgres@db.abcdefgh.supabase.co:5432/postgres\n",
    });
    expect(facts.hostedServices).toBeUndefined();
    expect(kinds(facts)).toEqual(["postgres", "supabase"]);
  });

  it("count an S3 endpoint at a known host as hosted object storage (FR-1316a)", async () => {
    const facts = await detect({
      ...manifest("npm", "@aws-sdk/client-s3"),
      ".env.example": [
        "AWS_URL=https://s3.eu-west-1.amazonaws.com",
        "AWS_LEGACY_URL=https://shop-uploads.s3-eu-west-1.amazonaws.com/files",
        "B2_URL=https://s3.us-west-004.backblazeb2.com",
        "WASABI_URL=https://s3.eu-central-1.wasabisys.com",
        "SPACES_URL=https://fra1.digitaloceanspaces.com",
        "R2_URL=https://0123456789abcdef.r2.cloudflarestorage.com",
        "HETZNER_URL=https://fsn1.your-objectstorage.com",
        "SUPABASE_S3_URL=https://abcdefgh.supabase.co/storage/v1/s3",
        // Supabase's other URLs, and AWS's databases, are not object storage.
        "SUPABASE_URL=https://abcdefgh.supabase.co",
        "RDS_URL=postgresql://app@s3-archive.abc123.eu-west-1.rds.amazonaws.com/app",
        "CACHE_URL=rediss://s3-sessions.abc123.euw1.cache.amazonaws.com:6379",
        "DUAL_URL=https://shop.s3.dualstack.us-east-1.amazonaws.com",
        // Other AWS services whose names start with `s3-` are not S3 either.
        "ELB_URL=https://s3-proxy-123.eu-west-1.elb.amazonaws.com",
        "KAFKA_BROKERS=b-1.s3-stream.abc.c3.kafka.eu-west-1.amazonaws.com:9092",
        "DOCDB_URL=mongodb://app@s3-docs.cluster-abc.eu-west-1.docdb.amazonaws.com:27017/app",
        "",
      ].join("\n"),
    });
    expect(facts.hostedServices).toEqual([
      { kind: "s3", variable: "AWS_LEGACY_URL", provider: "Amazon S3" },
      { kind: "s3", variable: "AWS_URL", provider: "Amazon S3" },
      { kind: "s3", variable: "B2_URL", provider: "Backblaze B2" },
      { kind: "redis", variable: "CACHE_URL", provider: "Amazon ElastiCache" },
      { kind: "s3", variable: "DUAL_URL", provider: "Amazon S3" },
      { kind: "s3", variable: "HETZNER_URL", provider: "Hetzner Object Storage" },
      { kind: "s3", variable: "R2_URL", provider: "Cloudflare R2" },
      { kind: "postgres", variable: "RDS_URL", provider: "Amazon RDS" },
      { kind: "s3", variable: "SPACES_URL", provider: "DigitalOcean Spaces" },
      { kind: "s3", variable: "SUPABASE_S3_URL", provider: "Supabase Storage" },
      { kind: "s3", variable: "WASABI_URL", provider: "Wasabi" },
    ]);
  });
});

describe("SQLite", () => {
  it("finds Rails 8's four production databases", async () => {
    const facts = await detect({
      Gemfile: 'gem "rails", "~> 8.0"\ngem "sqlite3", ">= 2.1"\n',
      "config/database.yml": `default: &default
  adapter: sqlite3
development:
  <<: *default
  database: storage/development.sqlite3
production:
  primary:
    <<: *default
    database: storage/production.sqlite3
  cache:
    <<: *default
    database: storage/production_cache.sqlite3
  queue:
    <<: *default
    database: storage/production_queue.sqlite3
  cable:
    <<: *default
    database: storage/production_cable.sqlite3
`,
    });
    expect(facts.sqlite).toEqual({
      paths: [
        "storage/production.sqlite3",
        "storage/production_cable.sqlite3",
        "storage/production_cache.sqlite3",
        "storage/production_queue.sqlite3",
      ],
      dir: "storage",
    });
  });

  it.each([
    [
      "Django",
      {
        "requirements.txt": "django\n",
        "proj/settings.py":
          'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}\n',
      },
      { paths: ["db.sqlite3"], dir: "." },
    ],
    [
      "Laravel",
      {
        "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
        ".env.example": "DB_CONNECTION=sqlite\n# DB_DATABASE=laravel\n",
      },
      { paths: ["database/database.sqlite"], dir: "database" },
    ],
    [
      "Prisma",
      {
        "package.json": JSON.stringify({ name: "a", dependencies: { "@prisma/client": "^6" } }),
        "prisma/schema.prisma":
          'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n',
        ".env.example": 'DATABASE_URL="file:./data/app.db"\n',
      },
      { paths: ["prisma/data/app.db"], dir: "prisma/data" },
    ],
    [
      "better-sqlite3",
      {
        "package.json": JSON.stringify({ name: "a", dependencies: { "better-sqlite3": "^11" } }),
        "src/db.ts":
          'import Database from "better-sqlite3";\nconst db = new Database("data/sqlite.db");\n',
      },
      { paths: ["data/sqlite.db"], dir: "data" },
    ],
    [
      "Drizzle",
      {
        "package.json": JSON.stringify({ name: "a", dependencies: { "drizzle-orm": "^0.40" } }),
        "drizzle.config.ts":
          'export default defineConfig({ dialect: "sqlite", dbCredentials: { url: "file:./db/local.db" } });\n',
      },
      { paths: ["db/local.db"], dir: "db" },
    ],
    [
      "Python's sqlite3",
      {
        "requirements.txt": "flask\n",
        "app.py": 'import sqlite3\n\ndb = sqlite3.connect("data/app.db")\n',
      },
      { paths: ["data/app.db"], dir: "data" },
    ],
    [
      "SQLAlchemy",
      {
        "requirements.txt": "fastapi\nsqlmodel\n",
        "db.py": 'engine = create_engine("sqlite+pysqlite:///data/app.sqlite3")\n',
      },
      { paths: ["data/app.sqlite3"], dir: "data" },
    ],
    [
      "Flask-SQLAlchemy",
      {
        "requirements.txt": "flask\nFlask-SQLAlchemy==3.1.1\n",
        "app.py": 'app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///project.db"\n',
      },
      { paths: ["instance/project.db"], dir: "instance" },
    ],
    [
      "an env file's SQLAlchemy URL",
      {
        "requirements.txt": "flask\nflask-sqlalchemy\n",
        ".env.example": "# DATABASE_URL=sqlite:///old.db\nDATABASE_URL=sqlite:///data/app.db\n",
      },
      { paths: ["instance/data/app.db"], dir: "instance/data" },
    ],
  ] as const)("finds %s's database file", async (_name, files, sqlite) => {
    expect((await detect(files)).sqlite).toEqual(sqlite);
  });

  it("skips SQLite paths it cannot place: absolute, in memory, or built at run time", async () => {
    const facts = await detect({
      "requirements.txt": "sqlalchemy\n",
      "db.py": [
        'a = create_engine("sqlite:////srv/app.db")',
        'b = create_engine("sqlite://")',
        'c = create_engine("sqlite:///:memory:")',
        'd = sqlite3.connect(f"{folder}/app.db")',
        "",
      ].join("\n"),
    });
    expect(facts.sqlite).toBeUndefined();
  });

  it.each([
    [
      "a Django default next to psycopg",
      {
        "requirements.txt": "django\npsycopg[binary]\ndj-database-url\n",
        "proj/settings.py":
          'import dj_database_url\nDATABASES = {"default": dj_database_url.config(default="sqlite:///db.sqlite3")}\n',
      },
    ],
    [
      "a default for DATABASE_URL next to psycopg2",
      {
        "requirements.txt": "flask\npsycopg2-binary\n",
        "app.py": 'import os\nURL = os.environ.get("DATABASE_URL", "sqlite:///app.db")\n',
      },
    ],
    [
      "a pytest file",
      {
        "requirements.txt": "flask\n",
        "db_test.py": 'import sqlite3\ndb = sqlite3.connect("data/test.db")\n',
      },
    ],
    [
      "Django's tests.py",
      {
        "requirements.txt": "django\n",
        "polls/tests.py": 'import sqlite3\ndb = sqlite3.connect("data/test.db")\n',
      },
    ],
    [
      "commented-out code",
      {
        "requirements.txt": "sqlalchemy\n",
        "db.py":
          '# engine = create_engine("sqlite:///data/old.db")\n# db = sqlite3.connect("data/old.db")\n',
      },
    ],
    [
      "documentation",
      {
        "requirements.txt": "flask\n",
        "docs/example.py": 'import sqlite3\ndb = sqlite3.connect("data/app.db")\n',
      },
    ],
    [
      "Alembic's migrations",
      {
        "requirements.txt": "sqlalchemy\nalembic\n",
        "migrations/env.py": 'config.set_main_option("sqlalchemy.url", "sqlite:///data/app.db")\n',
      },
    ],
    [
      "a JavaScript string",
      {
        "package.json": JSON.stringify({ name: "a", dependencies: { express: "^5" } }),
        "src/db.js": 'export const url = "sqlite:///data/dev.db";\n',
      },
    ],
  ] as const)("is not found in %s", async (_name, files) => {
    const facts = await detect(files);
    expect(facts.sqlite).toBeUndefined();
    expect(kinds(facts)).not.toContain("sqlite");
  });

  it("counts an env file's SQLAlchemy URL next to a server database's driver", async () => {
    const facts = await detect({
      "requirements.txt": "flask\npsycopg2-binary\n",
      ".env.example": "DATABASE_URL=sqlite:///data/app.db\n",
    });
    expect(facts.sqlite).toEqual({ paths: ["data/app.db"], dir: "data" });
  });

  it("is a service of a Python app, which needs no driver for it", async () => {
    const code = await detect({
      "requirements.txt": "flask\n",
      "app.py": 'import sqlite3\n\ndb = sqlite3.connect("data/app.db")\n',
    });
    expect(code.services).toEqual([{ kind: "sqlite", evidence: ["code:sqlite"] }]);
    const env = await detect({
      "requirements.txt": "flask\nflask-sqlalchemy\n",
      ".env.example": "DATABASE_URL=sqlite:///app.db\n",
    });
    expect(env.services).toEqual([{ kind: "sqlite", evidence: ["env:DATABASE_URL"] }]);
  });
});

describe("object storage", () => {
  it("records the S3 client, presigned uploads and the bucket and endpoint variables", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({
        name: "a",
        dependencies: { "@aws-sdk/client-s3": "^3", "@aws-sdk/s3-request-presigner": "^3" },
      }),
      ".env.example":
        "AWS_REGION=auto\nS3_BUCKET=uploads\nS3_ENDPOINT=http://localhost:9000\nAWS_ACCESS_KEY_ID=\n",
    });
    expect(facts.objectStorage).toEqual({
      client: "@aws-sdk/client-s3",
      presignedUploads: true,
      variables: ["S3_BUCKET", "S3_ENDPOINT"],
    });
  });

  it("finds boto3's presigned URLs and django-storages' variables", async () => {
    const facts = await detect({
      "requirements.txt": "django\ndjango-storages[s3]\nboto3\n",
      "app/views.py":
        'import os\nBUCKET = os.environ["AWS_STORAGE_BUCKET_NAME"]\nurl = client.generate_presigned_post(BUCKET, key)\n',
      ".env.example": "AWS_S3_ENDPOINT_URL=\n",
    });
    expect(facts.objectStorage).toEqual({
      client: "django-storages",
      presignedUploads: true,
      variables: ["AWS_S3_ENDPOINT_URL", "AWS_STORAGE_BUCKET_NAME"],
    });
  });

  it("is absent without an S3 client", async () => {
    expect((await detect(manifest("npm", "express"))).objectStorage).toBeUndefined();
  });

  it("lists only the bucket and endpoint variables of S3", async () => {
    const facts = await detect({
      ...manifest("npm", "@aws-sdk/client-s3"),
      ".env.example": [
        "S3_BUCKET=",
        "AWS_STORAGE_BUCKET_NAME=",
        "AWS_S3_ENDPOINT_URL=",
        "AWS_ENDPOINT_URL_S3=",
        "AWS_USE_PATH_STYLE_ENDPOINT=true",
        "NEXT_PUBLIC_S3_BUCKET=",
        "FIREBASE_STORAGE_BUCKET=",
        "GCS_BUCKET=",
        "S3_BUCKET_REGION=",
        "",
      ].join("\n"),
    });
    expect(facts.objectStorage?.variables).toEqual([
      "AWS_ENDPOINT_URL_S3",
      "AWS_S3_ENDPOINT_URL",
      "AWS_STORAGE_BUCKET_NAME",
      "S3_BUCKET",
    ]);
  });

  it("ignores S3 and presigned calls in scripts, tests and migrations", async () => {
    const facts = await detect({
      "requirements.txt": "boto3\n",
      "scripts/backup.py": 'import boto3\ns3 = boto3.client("s3")\n',
      "tests/test_upload.py": "url = client.generate_presigned_post(b, k)\n",
      "app/migrations/0002_files.py": 'boto3.resource("s3")\n',
    });
    expect(facts.services).toEqual([]);
  });
});

describe("review fixes", () => {
  const laravel = { "composer.json": JSON.stringify({ require: { "laravel/framework": "^10" } }) };

  it("ignores a Laravel schedule that is commented out", async () => {
    const facts = await detect({
      ...laravel,
      "app/Console/Kernel.php":
        "<?php\nclass Kernel {\n  protected function schedule(Schedule $s) {\n    // $schedule->command('inspire')->hourly();\n    /* $schedule->call(fn () => 1); */\n  }\n}\n",
      "routes/console.php":
        "<?php\n# Schedule::command('x')->daily();\n// Schedule::call(fn () => 1);\n",
    });
    expect(facts.workers).toBeUndefined();
  });

  it.each(["-B", "--beat"])(
    "runs Celery beat once inside a Procfile worker started with %s",
    async (flag) => {
      const facts = await detect({
        "requirements.txt": "celery\ndjango-celery-beat\n",
        "proj/celery.py": 'from celery import Celery\napp = Celery("proj")\n',
        Procfile: `web: gunicorn proj.wsgi\nworker: celery -A proj worker ${flag}\n`,
      });
      expect(facts.workers).toEqual([
        {
          name: "worker",
          command: `celery -A proj worker ${flag}`,
          source: "procfile",
          single: true,
          evidence: ["procfile:worker"],
        },
      ]);
    },
  );

  it("keeps Celery's AMQP broker beside the Redis extra", async () => {
    const facts = await detect({
      "requirements.txt": "celery[redis]\n",
      ".env.example": "CELERY_BROKER_URL=amqp://rabbit//\n",
    });
    expect(facts.services).toEqual([
      { kind: "amqp", evidence: ["config:amqp-broker"], variable: "CELERY_BROKER_URL" },
      { kind: "queue", evidence: ["dependency:celery"] },
      { kind: "redis", evidence: ["dependency:celery[redis]"] },
    ]);
  });

  it("adds every broker scheme Celery's settings show when no broker variable has one", async () => {
    const facts = await detect({
      "requirements.txt": "celery\n",
      "proj/settings.py":
        'CELERY_BROKER_URL = "amqp://guest@rabbit//"\nCELERY_RESULT_BACKEND = "redis://cache:6379/0"\n',
    });
    expect(kinds(facts)).toEqual(["amqp", "queue", "redis"]);
  });

  it("follows Dramatiq's broker extra", async () => {
    const redis = await detect({ "requirements.txt": "dramatiq[redis]\n" });
    expect(redis.services).toEqual([
      { kind: "queue", evidence: ["dependency:dramatiq"] },
      { kind: "redis", evidence: ["dependency:dramatiq[redis]"] },
    ]);
    const rabbit = await detect({ "requirements.txt": "dramatiq[rabbitmq]\n" });
    expect(rabbit.services).toEqual([
      { kind: "amqp", evidence: ["dependency:dramatiq[rabbitmq]"] },
      { kind: "queue", evidence: ["dependency:dramatiq"] },
    ]);
  });

  it("gives django-rq a queue on Redis", async () => {
    expect(kinds(await detect({ "requirements.txt": "django-rq\n" }))).toEqual(["queue", "redis"]);
  });

  it("records Upstash's REST URL as hosted, not as a Redis to run", async () => {
    const facts = await detect({
      ...manifest("npm", "@upstash/redis"),
      ".env.example": "UPSTASH_REDIS_REST_URL=https://eu1-sharp-cat-12345.upstash.io\n",
    });
    expect(facts.services).toEqual([]);
    expect(facts.hostedServices).toEqual([
      { kind: "redis", variable: "UPSTASH_REDIS_REST_URL", provider: "Upstash" },
    ]);
  });

  it("recognises more providers' hosts, web and bare ones included", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({ name: "a", dependencies: { pg: "^8" } }),
      ".env.example": [
        "CLICKHOUSE_URL=https://abc123.eu-central-1.aws.clickhouse.cloud:8443",
        "DATABASE_URL=postgresql://postgres@db.abcdefgh.supabase.co:5432/postgres",
        "ELASTICSEARCH_URL=https://my-deploy.es.us-east-1.aws.elastic-cloud.com",
        "KAFKA_BOOTSTRAP_SERVERS=pkc-abc12.us-east-1.aws.confluent.cloud:9092",
        "MEILISEARCH_HOST=https://ms-abc123.lon.meilisearch.io",
        "NEO4J_URI=neo4j+s://abcd1234.databases.neo4j.io",
        "POOLER_URL=postgresql://postgres@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
        "TYPESENSE_HOST=xyz-1.a1.typesense.net",
        "",
      ].join("\n"),
    });
    expect(facts.hostedServices).toEqual([
      { kind: "clickhouse", variable: "CLICKHOUSE_URL", provider: "ClickHouse Cloud" },
      { kind: "postgres", variable: "DATABASE_URL", provider: "Supabase" },
      { kind: "elasticsearch", variable: "ELASTICSEARCH_URL", provider: "Elastic Cloud" },
      { kind: "kafka", variable: "KAFKA_BOOTSTRAP_SERVERS", provider: "Confluent Cloud" },
      { kind: "meilisearch", variable: "MEILISEARCH_HOST", provider: "Meilisearch Cloud" },
      { kind: "neo4j", variable: "NEO4J_URI", provider: "Neo4j Aura" },
      { kind: "postgres", variable: "POOLER_URL", provider: "Supabase" },
      { kind: "typesense", variable: "TYPESENSE_HOST", provider: "Typesense Cloud" },
    ]);
  });

  it.each([
    ['BASE_DIR / "data" / "db.sqlite3"', "data/db.sqlite3"],
    ["os.path.join(BASE_DIR, 'data', 'db.sqlite3')", "data/db.sqlite3"],
  ])("joins Django's SQLite path %s", async (name, path) => {
    const facts = await detect({
      "requirements.txt": "django\n",
      "proj/settings.py": `DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ${name}}}\n`,
    });
    expect(facts.sqlite).toEqual({ paths: [path], dir: "data" });
  });
});

describe("the Redis-protocol engine an app needs", () => {
  const redis = (facts: ProjectFacts) =>
    facts.services.find((service) => service.kind === "redis")?.evidence;
  const ioredis = manifest("npm", "ioredis");

  it.each([
    ["redis:8-alpine", "redis"],
    ["bitnami/redis:7.4", "redis"],
    ["redis/redis-stack-server:7.4.0-v1", "redis"],
    ["docker.dragonflydb.io/dragonflydb/dragonfly:v1.30.0", "dragonfly"],
    ["dragonflydb/dragonfly", "dragonfly"],
    ["eqalpha/keydb", "keydb"],
  ])("names the engine the app's Compose file runs (%s)", async (image, engine) => {
    const facts = await detect({
      ...ioredis,
      "docker-compose.yml": `services:\n  cache:\n    image: ${image}\n`,
    });
    expect(redis(facts)).toEqual([`compose-image:${engine}`, "dependency:ioredis"]);
  });

  it("names no engine for an app that does not use Redis", async () => {
    const facts = await detect({
      ...manifest("npm", "pg"),
      "compose.yaml": "services:\n  kv:\n    image: dragonflydb/dragonfly\n",
    });
    expect(redis(facts)).toBeUndefined();
  });

  it.each([
    ["npm", "redis-om"],
    ["npm", "@redis/search"],
    ["npm", "@redis/json"],
    ["npm", "@redis/time-series"],
    ["npm", "@redis/bloom"],
    ["pypi", "redis-om"],
    ["nuget", "NRedisStack"],
  ] as const)("sees a %s client that needs Redis's own data types: %s", async (ecosystem, name) => {
    const facts = await detect(manifest(ecosystem, name));
    expect(redis(facts)).toEqual([`dependency:${name}`, `redis-modules:${name}`]);
  });

  it.each([
    ['index = r.ft("idx:docs")\n', true],
    ['r.json().set("doc:1", "$", doc)\n', true],
    ['r.ts().add("temp", "*", 21.5)\n', true],
    ['data = requests.get(url).json().get("items")\n', false],
    ["r.set('a', 1)\n", false],
  ])("counts redis-py only when the code calls its modules: %s", async (code, needs) => {
    const facts = await detect({
      "requirements.txt": "redis==5.0\nrequests==2.32\n",
      "app/main.py": `import redis\nr = redis.Redis()\n${code}`,
      "tests/test_x.py": 'r.ft("idx")\n',
    });
    expect(redis(facts)?.includes("redis-modules:redis")).toBe(needs);
  });

  it("counts Jedis only when the code calls its modules", async () => {
    const jedis = manifest("maven", "redis.clients:jedis");
    const source = (call: string) => ({
      ...jedis,
      "src/main/java/app/Search.java": `class Search { void run() { ${call} } }\n`,
    });
    const search = await detect(source('jedis.ftCreate("idx", options, schema);'));
    expect(redis(search)).toContain("redis-modules:redis.clients:jedis");
    const plain = await detect(source('jedis.set("a", "1");'));
    expect(redis(plain)).toEqual(["dependency:redis.clients:jedis"]);
  });
});
