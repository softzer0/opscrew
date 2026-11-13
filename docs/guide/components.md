# What runs next to your app: components

Your app is more than its web process. It may run background workers, scheduled jobs, a database,
a cache, a message broker, a search engine, or keep files in object storage. OpsCrew calls each of
these a **component**. It finds them in your repository, plans each one with a version and a memory
limit, runs them next to your app on your own server, and shows you what they cost before anything
is created.

## What counts as a component

- **The web process**: your app, as it serves visitors.
- **Workers**: processes that run background jobs from the same image as the app. See
  [Workers and cron jobs](workers-and-cron.md).
- **Cron jobs**: commands or routes of your app that run on a schedule.
- **Services**: databases, caches, queues, brokers, and search and analytics engines that OpsCrew
  runs as containers on the server. See [Databases](databases.md), [Message brokers and
  queues](brokers.md) and [Search and analytics engines](search-and-analytics.md).
- **Storage**: a persistent volume for a [SQLite](https://www.sqlite.org/) database, a [kept folder](#the-apps-kept-folder) for
  the files the app writes, and a bucket for the app's files only when you ask for one in the
  interview: otherwise the app keeps the storage it uses now. See
  [Object storage](object-storage.md).

## How OpsCrew finds them

`npx opscrew analyze` reads your repository without running it:

- the client libraries your app depends on at runtime (for example `mysql2`, `pymongo`, `amqplib`,
  `@aws-sdk/client-s3` or `meilisearch`), and the address variables it reads (`DATABASE_URL`,
  `MONGODB_URI`, `AMQP_URL` …);
- the process types of a `Procfile`, and background-job libraries such as [Celery](https://docs.celeryq.dev/), [Sidekiq](https://sidekiq.org/), [BullMQ](https://bullmq.io/)
  or [Laravel](https://laravel.com/)'s queue;
- the `crons` of a `vercel.json`, and a plain PHP app's `cron.php`;
- the PHP extensions in `composer.json`'s `require` (`ext-pdo_mysql`, `ext-pgsql`, `ext-redis` …);
- the folder the app writes its files to: a plain PHP app's `storage/`, Laravel's `storage/app`;
- a hosted service the app already uses, such as a [MongoDB Atlas](https://www.mongodb.com/atlas) address in `.env.example`.

`npx opscrew interview` asks only what it cannot tell: the command of a worker whose library has
no usual one, and, for each hosted service, whether to keep it or let OpsCrew run one on the server.
A hosted service you do not answer for is kept, so OpsCrew never replaces one unasked.

## What design shows you

`npx opscrew design` prints one line per component with its version, its memory limit and why it
is there. For example, for a [Django](https://www.djangoproject.com/) app with [MySQL](https://www.mysql.com/) and Celery on a 4 GB server that costs €8.00 a
month:

```text
MySQL 8.4 (mysql, 512 MB): The app uses mysqlclient.
Worker worker (256 MB, 2 copies): celery -A shop worker --loglevel=info --concurrency 2
Cron job cleanup (0 3 * * *, UTC): python manage.py clearsessions
Memory limits: the app 512 MB (€1.00/month), worker 512 MB (€1.00/month), cron 512 MB (€1.00/month), mysql 512 MB (€1.00/month); OpsCrew's edge and the system 512 MB; 1.5 GB of 4.0 GB free.
```

The last line is the server's memory, shared out: each component's limit with its share of the
server's monthly price, the part OpsCrew's edge and the system keep, and what stays free. On a
server you already have, or in your [Portainer](https://www.portainer.io/), there is no price to share.

Licences are said in plain words when a component's licence is not a permissive one. MongoDB
(SSPL), MySQL and [MariaDB](https://mariadb.org/) (GPL 2.0), [Redis](https://redis.io/) 8 (RSALv2, SSPLv1 or AGPLv3), [Redpanda](https://www.redpanda.com/) and [Dragonfly](https://www.dragonflydb.io/)
(Business Source License), [Elasticsearch](https://www.elastic.co/elasticsearch) (Elastic License 2.0), [Garage](https://garagehq.deuxfleurs.fr/) (AGPL 3.0), [Typesense](https://typesense.org/) and
[Neo4j](https://neo4j.com/) Community (GPL 3.0) all allow running them for your own app; their conditions are about
sharing or offering that software itself.

For Redis, OpsCrew runs [Valkey](https://valkey.io/) unless your app shows it needs Redis 8 (Redis's own data types, or
Redis in its [Compose](https://docs.docker.com/compose/) file) or Dragonfly (in its Compose file, or your choice in `opscrew/plan.yaml`
on a server with 2 vCPUs or more); see
[Redis 8 or Dragonfly instead of Valkey](brokers.md#redis-8-or-dragonfly-instead-of-valkey).

## Memory limits and the size of the server

Every container gets a memory limit, so one that grows cannot take the whole server down with it.
When it reaches its limit, only that container is restarted. Design adds up:

- every component's limit (a worker's limit counts once per copy; the cron container gets the
  app's limit when a job runs a command, since it runs the app's code, and 64 MB when every job
  calls a route);
- 128 MB for OpsCrew's edge ([Caddy](https://caddyserver.com/), [kamal-proxy](https://github.com/basecamp/kamal-proxy), and the [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/) connector when the app
  uses one);
- 384 MB for the system.

On [Hetzner Cloud](hetzner.md) and [DigitalOcean](digitalocean.md) it picks a server that fits. Design refuses when the limits do not
fit the server, and warns when less than 15% of its memory stays free. On a server you already
have, it uses the memory it reads there, minus the limits of the other OpsCrew apps on it (see
[Deploy to a server you already have](own-server.md)).

Each service also has a smallest server it runs well on, from 512 MB for [NATS](https://nats.io/) or Valkey to 4 GB
for [OpenSearch](https://opensearch.org/), Elasticsearch and Neo4j. On Hetzner Cloud and DigitalOcean, design picks a server
at least that big. On a server you already have, it warns you when the server is smaller.

## The app's kept folder

Some apps write files they must keep: uploads, keys, a file that says the app is installed. A
plain PHP app keeps them in `storage/`, and Laravel in `storage/app` (its local disk; a
[SQLite](databases.md#sqlite) database in `storage/database` stays apart). OpsCrew makes that
folder a persistent volume, named in `opscrew/plan.yaml`:

```yaml
storage:
  files:
    dir: storage   # relative to your app
```

- **Every deploy keeps it.** On a server it is the [Docker](https://www.docker.com/) volume `<app>_files`, in your Portainer
  the stack's volume `<stack>_files`. The web process, the release command, the workers and the
  cron jobs all see the same files.
- **The app's own user owns it**, as with SQLite's folder (see
  [Who owns the database folder](databases.md#who-owns-the-database-folder)).
- **Two versions may use it at once.** Unlike SQLite, files are safe for two web containers, so
  deploys still switch [without downtime](zero-downtime.md).
- **It is in every [snapshot](snapshots.md)**, moves with [`npx opscrew retarget`](retarget.md),
  and `npx opscrew destroy` keeps it unless you add `--delete-data`.
- **In the repository, the folder holds only Git's placeholders** (`.gitignore`, `.gitkeep`,
  `.keep`) and `.htaccess` files: the volume hides the folder's files in the image, so design
  refuses a folder with your own files in it. It cannot be the app's whole folder, nor SQLite's
  folder or one inside it.

## Changing a component

Everything is in `opscrew/plan.yaml`: the web process's `app.memoryMb`, `processes.workers`,
`processes.cron`, `services` and `storage`. You can change a worker's command, count or memory, a
service's memory or settings, or turn a component off with `enabled: false` (the entry stays and
nothing runs). Then run `npx opscrew design`: it keeps your edits, says what changed, and checks
that everything still fits. `npx opscrew provision` applies the change after you approve it.

OpsCrew runs one version of each service, pinned by its image digest. [Dependabot](https://docs.github.com/en/code-security/dependabot) proposes newer
releases of the same major version in your repository; a new major version of a database or a
broker is yours to choose, because its data may need a migration.

## Day to day

- `npx opscrew status` lists each component and whether it runs once the app has been deployed,
  read from the server over SSH, or through your Portainer's API (which needs an administrator's
  access token).
- `npx opscrew drift` reports a component of the plan without a container on the server, a
  container the plan no longer has, and a stopped one.
- `npx opscrew destroy` removes every component. The data stays (the data folders on a server you
  own, the volumes in your Portainer, and the bucket) unless you add `--delete-data` and type the
  app's name.

## Where components run

- **Hetzner Cloud and DigitalOcean:** one app per server, with its components next to it. A service
  can also get a server of its own, linked privately to the app's: see
  [split placement](split-placement.md).
- **A server you already have:** several OpsCrew apps can share it, each with its own components
  and folders; see [Deploy to a server you already have](own-server.md).
- **Your Portainer:** the components run in the app's stack, with their data in named volumes.
  OpenSearch and Elasticsearch need a kernel setting on the [Docker](https://www.docker.com/) host that a stack cannot make,
  so OpsCrew does not run them there (see
  [Search and analytics engines](search-and-analytics.md#the-kernel-setting-of-opensearch-and-elasticsearch)
  and [Deploy to a Portainer you already run](portainer-target.md)).

Moving an app somewhere else with [`npx opscrew retarget`](retarget.md) moves every service's data
with it, and the app's own files (SQLite, uploads), unless you start a service empty; the workers
and cron jobs move too. See [The data](retarget.md#the-data) and [Buckets](retarget.md#buckets).
