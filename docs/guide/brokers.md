# Message brokers and queues

When your app sends work or events through a queue or a broker, OpsCrew runs it next to the app on
the same server: Valkey (or Redis 8 or Dragonfly) for Redis-based queues and caches, RabbitMQ,
NATS, and Apache Kafka or Redpanda. Each runs as a container with a memory limit and no open port,
and costs nothing beyond
the server memory it takes, which design shows with its share of the server's price (see
[Components](components.md)).

## What OpsCrew runs

| Service | Version | Memory limit (lowest) | Smallest server | Licence | Login |
|---|---|---|---|---|---|
| Valkey | 8 | 128 MB (64 MB) | 512 MB | BSD 3-Clause | none: only the app's containers reach it |
| Redis | 8 | 128 MB (64 MB) | 512 MB | RSALv2, SSPLv1 or AGPLv3, your choice | generated password |
| Dragonfly | 2 | 512 MB (384 MB) | 2 GB, 2 vCPUs | Business Source License 1.1 | generated password |
| RabbitMQ | 4.3 | 384 MB (256 MB) | 1 GB | MPL 2.0 | generated password |
| NATS | 2.15 | 64 MB (32 MB) | 512 MB | Apache 2.0 | generated token |
| Apache Kafka | 4.3 | 1024 MB (768 MB) | 2 GB | Apache 2.0 | none: only the app's containers reach it |
| Redpanda | 26.2 | 1536 MB (1024 MB) | 2 GB | Business Source License 1.1 | none: only the app's containers reach it |

OpsCrew picks the broker from your app's client library (`amqplib`, `pika`, `nats`, `kafkajs`,
`confluent-kafka` …) and the address variables it reads. Celery's broker follows the scheme of its
broker URL (`redis://` runs Valkey, `amqp://` RabbitMQ).

Every broker listens only on the app's own network: no port is open to the internet or to other
apps on the server. Like the databases, each runs from an image pinned by digest, and Dependabot
proposes newer releases of the same major version, never a new major one.

## What your app receives

| Service | Variables | Address |
|---|---|---|
| Valkey | `REDIS_URL` | `redis://queue:6379` or `redis://cache:6379` |
| Redis 8, Dragonfly | `REDIS_URL` | `redis://:<password>@queue:6379` or `redis://:<password>@cache:6379` |
| RabbitMQ | `AMQP_URL`, `RABBITMQ_URL` | `amqp://app:<password>@rabbitmq:5672/%2F` |
| NATS | `NATS_URL` | `nats://<token>@nats:4222` |
| Kafka, Redpanda | `KAFKA_BROKERS`, `KAFKA_BOOTSTRAP_SERVERS` | `kafka:9092` or `redpanda:9092` |

When your app reads its own variable for the address (for example `CELERY_BROKER_URL`), that one
gets the address too.

## Valkey: a queue or a cache

Valkey is the open-source continuation of Redis, and Redis clients work with it unchanged. It runs
in one of two modes, because a queue and a cache need opposite settings:

- **Queue mode** (`queue`), when a job library uses it (BullMQ, Sidekiq, Celery, RQ, Laravel's
  queue): it never evicts keys and keeps an append-only file on disk, so no job is lost. When its
  memory is full, it refuses new writes instead of dropping jobs.
- **Cache mode** (`cache`): it evicts the least recently used keys when its memory is full and
  keeps nothing on disk.

An app that uses Redis only as a cache gets one Valkey in cache mode. An app with jobs and a cache
gets one Valkey in queue mode, which the cache shares, unless the app
reads a separate cache address (for example `CACHE_URL`): then it gets a second Valkey in cache
mode. A cache that shares the queue's Valkey gets errors instead of evictions once its memory is
full, so give it a larger memory limit, or give the app a separate cache address. Valkey's own
limit is three quarters of its container's limit; the mode is `options.mode` on the service in
`opscrew/plan.yaml`. Redis 8 and Dragonfly take the same two modes.

## Redis 8 or Dragonfly instead of Valkey

Valkey is the default, and OpsCrew picks another engine only when your app shows it needs one:

- **Redis 8** runs when your app's client uses Redis's own data types, which Valkey does not have
  together: Search and Query, JSON, Time Series and probabilistic structures. OpsCrew sees this in
  `redis-om` (Node.js and Python), `@redis/search`, `@redis/json`, `@redis/time-series`,
  `@redis/bloom` and NRedisStack, and in redis-py or Jedis when the code calls `.ft()`,
  `.json().set()` and the like, or `ftCreate()`, `jsonSet()` and the like. Redis 8 also runs when
  your app's own Compose file runs Redis: the official `redis` image, `bitnami/redis`, or
  `redis/redis-stack` or `redis/redis-stack-server`. Its image includes those data types,
  and it requires a generated password. Redis 8 is under your choice of the RSALv2, the SSPLv1 or the
  AGPLv3: running its unmodified image for your own app puts no conditions on your app's code; they
  apply when you offer Redis itself as a service or change and share it.
- **Dragonfly** runs when your app's own Compose file runs it, or when you choose it: set the
  service's `kind` to `dragonfly` in `opscrew/plan.yaml` and run `npx opscrew design` again, which
  keeps your choice. Design names it as the other choice when the server has at least 2 vCPUs:
  a server OpsCrew creates is sized to 2 vCPUs for it, and on your own server design reads its
  vCPUs. Dragonfly needs 256 MB of memory per thread, so OpsCrew always sets its threads and memory
  from the limit: three quarters of the limit, and one thread for each 256 MB of that, at most
  `options.threads`, which design sets to the server's vCPUs when it writes the plan (in your
  Portainer, whose host it does not know, at most 2; set it yourself there). Its lowest
  limit is 384 MB, and it shines from about 4 GB. A Dragonfly queue keeps a snapshot on disk, saved
  every minute and when it stops, so a crash can lose the jobs of the last minute; a Dragonfly cache
  keeps nothing. Dragonfly is under the Business Source License 1.1: running it for your own app is
  allowed, offering it to others as an in-memory data store service is not, and it becomes Apache
  2.0 on 2030-11-01 ([its licence](https://github.com/dragonflydb/dragonfly/blob/main/LICENSE.md)).

For an app on BullMQ, Dragonfly runs with `--cluster_mode=emulated --lock_on_hashtags`, which
BullMQ's scripts need there. Each queue's name or prefix must then be in its own hashtag, such as
`new Queue("{myqueue}")` or `prefix: "{myqueue}"`, and design warns you about it (see
[Dragonfly's BullMQ page](https://www.dragonflydb.io/docs/integrations/bullmq)).

KeyDB is not offered: it has had no release since 2023. An app whose Compose file runs KeyDB gets
Valkey, which speaks the same protocol, and design says so.

## RabbitMQ

RabbitMQ runs with a user `app` and a generated password; it never creates its `guest` user. Its
memory alarm is set to 0.4 of the container's limit: when RabbitMQ reaches it, it stops accepting
new messages until consumers catch up, well before the container could be stopped for lack of
memory. Its management web interface is not included.

## NATS

NATS runs with JetStream on (its persistent streams, kept in the data folder, up to 10 GB on disk
and a quarter of the memory limit in memory) and a generated token, which the app's `NATS_URL`
carries. OpsCrew always mounts its own settings file, since the image's own one contains a fixed
cluster password.

## Apache Kafka and Redpanda

Kafka runs as one combined broker and controller (KRaft mode, no ZooKeeper), with every
replication factor at 1 and a heap of half its memory limit. A Kafka node is a Java program that
needs about 1 GB of memory on its own, so OpsCrew sizes Hetzner and DigitalOcean servers to at
least 2 GB for it. Logs are kept for 168 hours by default; set `options.retentionHours` and, to cap
the disk each partition takes, `options.retentionGb` on the service in `opscrew/plan.yaml`.

Redpanda speaks Kafka's protocol, so Kafka clients work with it unchanged. OpsCrew runs Kafka by
default, and Redpanda when you choose it in `opscrew/plan.yaml`. Redpanda is under the Business
Source License 1.1: running it for your own app is allowed, offering Redpanda itself as a service
to others is not, and each release becomes Apache 2.0 after four years. OpsCrew uses only its
community features.

## Where the data is

On a server, RabbitMQ, NATS and a Valkey, Redis 8 or Dragonfly queue keep their data in
`/srv/data/<app>/<name>`; Kafka
and Redpanda, whose images run as their own users, in a Docker volume of the app's Compose project
(`<app>_kafka_data`, `<app>_redpanda_data`). In your Portainer, every broker's data is in the named
volumes of the app's stack. `npx opscrew destroy` keeps the data unless you add `--delete-data` and
type the app's name.
