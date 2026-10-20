# Feature Specification: The component model: workers, cron and the services an app already uses

**Feature Branch**: `main` (feature directory `specs/013-component-model`)
**Created**: 2026-10-19
**Status**: Draft
**Input**: Founder decisions of 2026-10-13, 2026-10-14 and 2026-10-16 (provide a service only when the
app already uses it; reuse Procfile, supercronic and the builders' start commands; object storage
from the provider or Cloudflare R2, priced side by side; message brokers, MongoDB and SQLite storage;
several apps on one own server; two parts, the search and analytics engines in part 2) and the
research of 2026-10-19 (`research.md`).

## Why

Today OpsCrew deploys exactly one process, the web app, plus Postgres and Redis when the app uses
them. Real apps need more:
- **Background work:** a Django app with Celery, a Rails app with Sidekiq or Solid Queue, a Laravel
  app with its queue worker and scheduler. Today their jobs never run, and OpsCrew only warns.
- **Scheduled jobs:** exported Vercel and Lovable apps declare cron jobs in `vercel.json`, and other
  apps need a job every few minutes. Nothing runs them today.
- **Other databases:** apps on MySQL or MongoDB get no database. An app on SQLite loses its data on
  the next deploy.
- **Files:** apps that store uploads in S3-compatible storage need a bucket and its keys.
- **Brokers:** apps on RabbitMQ, NATS or Kafka cannot start without their broker.
- **One server, several apps:** a user who owns one server cannot put a second OpsCrew app on it.

The rule stays: OpsCrew provides only what the app already uses, found in its code and settings,
and never adds a service the app does not ask for. Each piece becomes a **component** with its own
size, memory limit and settings in `plan.yaml`, so the user sees what runs, what it costs and how
much of the server it takes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - My workers and scheduled jobs run too (Priority: P1)

An app with background jobs gets its workers next to the web process. An app with scheduled jobs
gets them run on time. OpsCrew finds them in the Procfile, in the job libraries the app uses, and in
`vercel.json`. It asks only for what it cannot find, such as a worker's command when no convention
gives it.

**Why this priority**: a queue without a worker silently drops work. It is the most common reason
a deployed app "works" but does not do its job, and every builder and target needs it.

**Independent Test**: deploy the Celery example with a worker, a beat scheduler and a cron job. Then
check that:
- a task queued from the web process is processed by the worker;
- the cron job runs on schedule;
- a merged change redeploys the workers with the new version.

**Acceptance Scenarios**:

1. **Given** an app whose Procfile lists `web` and `worker`, **When** the user designs and deploys,
   **Then** a worker runs from the same image with the Procfile's command, and it has no public port.
2. **Given** an app that uses a known job library (Celery, Sidekiq, Solid Queue, RQ, Dramatiq, BullMQ,
   Laravel's queue), **When** design runs, **Then** the plan lists a worker with the library's
   conventional command, or the interview asks for the command when there is no convention.
3. **Given** a scheduler that must run once (Celery beat, Laravel's scheduler, Solid Queue's
   dispatcher), **When** the plan is designed, **Then** it runs as exactly one process, and the user
   cannot raise its count.
4. **Given** `vercel.json` declares cron jobs, **When** the app is deployed, **Then** each job calls
   the app's own route on its schedule. The call carries a secret the app can check, the same way the
   original host sends it.
5. **Given** a cron entry the user adds in `plan.yaml`, **When** they provision again, **Then** it
   runs on its schedule inside the app's image, with the app's settings.
6. **Given** a cron job is still running at its next start time, **When** the time comes, **Then** the
   next run is skipped, not started twice.
7. **Given** a deploy of a new version, **When** the web process has switched, **Then** each worker is
   replaced by the new version and stopped gracefully, with its stop time. If a new worker does not
   keep running, the deploy fails, says which worker failed, and the previous version keeps running.
8. **Given** an app with an in-process scheduler (a library that runs inside the web process),
   **When** design runs, **Then** no extra process is added, and OpsCrew notes that the web process
   must stay a single copy.

---

### User Story 2 - The database my app already uses runs next to it (Priority: P1)

An app on MySQL or MongoDB gets that database as a container next to it, created with a generated
password. An app on SQLite keeps its database file across deploys. When the app points at a hosted
database (MongoDB Atlas, PlanetScale, a hosted Redis), OpsCrew asks whether to keep it, as it does
today for Supabase.

**Why this priority**: without its database, the app does not start. MySQL and MongoDB are the most
common databases after Postgres, and SQLite is the default of Rails 8 and many small apps.

**Independent Test**: deploy the MySQL, MongoDB and SQLite examples. Write data through each app,
deploy a change, and read the data back.

**Acceptance Scenarios**:

1. **Given** an app using a MySQL client, **When** it is designed and deployed, **Then** a MySQL
   database runs on the conservative supported version, tuned to its memory limit, and the app
   receives its connection settings under the names it reads.
2. **Given** an app that declares MariaDB, **When** it is designed, **Then** MariaDB is used instead of
   MySQL.
3. **Given** an app using MongoDB, **When** it is designed, **Then** OpsCrew shows MongoDB's licence
   (SSPL) and its memory needs. On deploy, MongoDB runs with its cache capped to its memory limit,
   and as a single-node replica set when the app needs transactions.
4. **Given** an x86 server whose CPU lacks the instructions MongoDB needs, **When** the user
   provisions, **Then** OpsCrew stops before any change, says why, and names the choices: a newer
   server type, or a hosted MongoDB.
5. **Given** an app on SQLite, **When** it is deployed and deployed again, **Then** the database file
   survives each deploy. The deploy stops the old copy before the new one starts, so two copies never
   write to it at once.
6. **Given** an app whose connection string points at a hosted service, **When** the interview runs,
   **Then** it asks whether to keep that service or let OpsCrew run one on the server, and says what
   running it on the server would add.

---

### User Story 3 - My files go to object storage I can afford (Priority: P2)

An app that stores files in S3-compatible storage gets a private bucket and its keys. Design shows
the options priced side by side:
- the provider's own storage (Hetzner Object Storage, DigitalOcean Spaces);
- Cloudflare R2;
- on the user's own server or Portainer, a small storage container.

The cheapest option is the default, and the user can pick another.

**Why this priority**: uploads are common in vibe-coded apps. A missing bucket breaks only the
upload features, so the app can still start without one.

**Independent Test**: deploy the object storage example on Hetzner with R2, and on an own server
with the storage container. Upload a file through the app and read it back after a redeploy.

**Acceptance Scenarios**:

1. **Given** an app that uses an S3 client, **When** design runs, **Then** it lists each storage
   option available for the target with its monthly price for the expected use, and marks the
   default.
2. **Given** Cloudflare R2 is chosen, **When** the user provisions, **Then** OpsCrew creates the bucket
   after the user approves the plan. It then asks for an R2 token limited to that bucket, which the
   user creates in Cloudflare's dashboard following OpsCrew's steps. The app receives the token's keys
   under the names it reads.
3. **Given** Hetzner Object Storage or DigitalOcean Spaces is chosen, **When** the user provisions,
   **Then** OpsCrew first asks for one key pair from the provider's console, with the steps to create
   a new key for this app. With that key, it creates the bucket through the approved plan, and the app
   receives the key. OpsCrew never creates keys itself, so no key is kept in infrastructure state.
4. **Given** the app uploads from the browser with presigned links, **When** the bucket is created,
   **Then** it accepts uploads from the app's own domain only.
5. **Given** the storage container on an own server, **When** the user designs, **Then** OpsCrew says
   that the files live on that server only, with no copy elsewhere, and shows its licence (AGPL).
6. **Given** the app is destroyed, **When** destroy runs without the option to delete data, **Then**
   the bucket and its files stay, and OpsCrew says where they are.

---

### User Story 4 - My message broker runs too (Priority: P2)

An app that talks to RabbitMQ, NATS or Kafka gets that broker as a container. An app whose queue
library keeps its jobs in Redis gets a Valkey set up for a queue (no eviction, kept on disk), not
for a cache.

**Why this priority**: broker-based apps are fewer than database-backed ones, but without their
broker they do not start at all.

**Independent Test**: deploy the RabbitMQ, NATS and Kafka examples. Publish a message from the web
process and see the worker consume it.

**Acceptance Scenarios**:

1. **Given** an app using an AMQP client, **When** it is deployed, **Then** RabbitMQ runs with a
   memory watermark that fits its limit, without its default guest login, and its management page is
   not reachable from outside.
2. **Given** an app using NATS, **When** it is deployed, **Then** NATS runs with persistence and
   authentication.
3. **Given** an app using a Kafka client, **When** it is designed, **Then** Apache Kafka is the
   default, sized by the server's memory, with retention bounded in time and size. Redpanda is offered
   as the user's choice, with its licence. On a server too small for either, OpsCrew refuses and
   names the smallest server that fits.
4. **Given** an app whose job library uses Redis, **When** it is deployed, **Then** Valkey runs
   without evicting keys and keeps its data on disk. A cache gets its own instance only when the app
   reads a separate cache address.
5. **Given** Celery, **When** design runs, **Then** the broker follows Celery's broker address: AMQP
   gives RabbitMQ, Redis gives Valkey.

---

### User Story 5 - Several apps on my own server (Priority: P2)

A user who owns one server can deploy a second, third or later OpsCrew app on it. Each app keeps its
own files, data, processes and services. The apps share the parts that can only exist once per
server: the web entry on ports 80 and 443, the switch between versions, the tunnel and the host
hardening.

**Why this priority**: 009's spec promised it, and users with one small server, often a home lab,
want to use all of it.

**Independent Test**: on one throwaway server, deploy two example apps on two hostnames. Deploy a
change to each under load, destroy the first, and check that the second kept answering throughout.

**Acceptance Scenarios**:

1. **Given** a server that already runs one OpsCrew app, **When** the user provisions a second app on
   it, **Then** OpsCrew plans only the second app's changes, the host plan shows what is shared, and
   the first app keeps serving.
2. **Given** two apps on one server, **When** either is deployed, **Then** the other is never
   restarted or interrupted.
3. **Given** two apps on one server, **When** the first is destroyed, **Then** only its files, data,
   processes, services and hostnames are removed. The shared parts stay until the last app is
   destroyed.
4. **Given** a second app whose hostname is already used by the first, **When** the user provisions,
   **Then** OpsCrew refuses before any change and names the app that has it.
5. **Given** the apps' memory limits add up to more than the server has, **When** the user provisions
   another app, **Then** OpsCrew warns, or refuses when the new app could not start, and says how much
   is in use.
6. **Given** a host that is reached only through Cloudflare Tunnels, **When** a second app is added,
   **Then** each app is served through its own tunnel on its own hostname, and the server still opens
   no web port.

---

### User Story 6 - Each component is sized, limited and priced (Priority: P2)

Every container OpsCrew runs has a memory limit. Design adds up the app, its workers and cron, its
services and the shared parts, and picks a server that fits, or on an own server checks that it
fits. The plan shows each component's memory, price share and licence, and the user can change them
in `plan.yaml`.

**Why this priority**: without limits, one hungry service can take down the whole server. Without a
sum, the price shown is wrong.

**Independent Test**: design an app with a worker, MySQL and RabbitMQ on a small budget. Check that:
- the server chosen holds the sum of the limits;
- each running container has its limit;
- raising a component's memory in `plan.yaml` gives a bigger server or a warning.

**Acceptance Scenarios**:

1. **Given** any deployed app, **When** its containers are inspected, **Then** each one has a memory
   limit, the same as in `plan.yaml`.
2. **Given** the user raises a component's memory in `plan.yaml`, **When** they run design again,
   **Then** the change is kept. The server and the price are re-checked, and design says what changed.
3. **Given** a component whose licence is not a permissive open-source licence (SSPL, BSL, ELv2, AGPL,
   GPL), **When** design adds it, **Then** design names the licence in one plain sentence: what it
   means for running the user's own app, and that the user's code is not affected.
4. **Given** nothing changed, **When** the user runs design, adapt or provision again, **Then** no
   component and no file changes.

---

### User Story 7 - Part 2: the search and analytics engine my app uses (Priority: P3)

An app that uses OpenSearch or Elasticsearch, Meilisearch, Typesense, ClickHouse or Neo4j gets that
engine as a single-node container, with a memory limit and its licence shown. On a server below the
engine's comfortable size, OpsCrew warns. Cassandra is never run on the server; OpsCrew keeps it as
an external service.

**Why this priority**: fewer apps use these, and each needs more memory, so they come after part 1.

**Independent Test**: deploy the search example with Meilisearch and the analytics example with
ClickHouse. Index or insert data through the app and query it back after a redeploy.

**Acceptance Scenarios**:

1. **Given** an app with an Elasticsearch client, **When** design runs, **Then** Elasticsearch is
   used, with its licence shown. An app with an OpenSearch client gets OpenSearch. OpsCrew never
   swaps one for the other.
2. **Given** an engine that needs a host kernel setting (OpenSearch, Elasticsearch), **When** the
   target is a server OpsCrew sets up or owns, **Then** the setting is part of the approved plan. On a
   Portainer target, OpsCrew refuses before any change and says what the user must set on the host.
3. **Given** Meilisearch, Typesense, ClickHouse or Neo4j, **When** they are deployed, **Then** each
   requires a generated key or password. None is reachable without it, or from outside the server.
4. **Given** an app using Cassandra, **When** design runs, **Then** OpsCrew keeps it external, says
   why, and names a hosted option.

---

### Edge Cases

- **A Procfile type with an unknown command, or a library with no conventional command (BullMQ,
  Go's asynq):** the interview asks for the command once, and `plan.yaml` keeps it.
- **A worker the user does not want:** setting it off in `plan.yaml` removes it. A later design does
  not bring it back.
- **The same job library in the web process and a worker:** each runs as planned. OpsCrew does not
  start the library's embedded mode a second time.
- **Cron in a time zone:** schedules are in UTC, as Vercel's are, and the guide says so.
- **A cron job that fails:** its output is in the cron container's log. Alerts come with 015.
- **A Rails app on SQLite with several database files** (primary, cache, queue, cable): all stay
  on the persistent volume.
- **An app that uses both MySQL and Postgres:** each runs, and each gets its own limit and password.
- **A MongoDB URI on the hosted service's SRV form:** it is kept external without asking. Only
  OpsCrew-run MongoDB gets a container.
- **An S3 client whose version cannot read a custom endpoint from the environment:** OpsCrew lists
  the small code change, or leaves it to the Code-change agent.
- **Object storage without the key pair** (Hetzner, Spaces, or R2's token after its bucket):
  provision stops before any change, or before the app's secrets for R2, with the steps to create
  the key. In a non-interactive run, the key comes from the environment.
- **A broker's data filling the disk:** retention bounds keep it within the plan's disk share, and
  the guide says how to change them.
- **Two apps on one own server using the same service kind:** each has its own instance with its
  own data. Nothing is shared between apps.
- **Destroying the last app on an own server:** the shared parts are removed too. The host's
  hardening is undone only with the option that undoes host changes, as today.
- **An engine too large for the server** (Kafka on 1 GB, OpenSearch on 2 GB): OpsCrew refuses or
  warns, with the smallest server that fits.
- **Retarget to another provider:** Postgres and Valkey move as today, and workers and cron move with
  the app. When the app has another stateful service (MySQL, MongoDB, a broker, an engine, SQLite),
  retarget refuses before anything changes, and says that copying their data comes later. The bucket
  stays where it is and keeps working.
- **An OpsCrew upgrade that changes the shared edge:** the next deploy on that server restarts the
  edge once, briefly, for every app on it, and says so.
- **Portainer target:** components run in the stack too, except what needs host settings or host
  files. OpsCrew says plainly what it cannot do there.

## Requirements *(mandatory)*

### Functional Requirements

**Components in the plan**

- **FR-1301**: `plan.yaml` MUST list the app's components:
  - the web process;
  - workers and cron jobs;
  - backing services (databases, caches, queues, brokers, object storage and, in part 2, search and
    analytics engines);
  - persistent storage for file-based databases.
  Each component has its kind, version, memory limit and settings.
- **FR-1302**: OpsCrew MUST add a component only when the app already uses it, detected from its
  client libraries, settings, Procfile or `vercel.json`. It MUST never introduce one.
- **FR-1303**: The interview MUST ask only what detection cannot tell. Examples: a worker's command
  with no convention, whether to keep a detected hosted service, and the choice between offered
  options when the default does not fit the budget.
- **FR-1304**: A later `opscrew design` MUST keep the user's edits to components (counts, memory,
  versions, options, a component turned off). It MUST re-check them against the server and the
  budget, and say what it changed.

**Processes**

- **FR-1305**: Workers MUST come from the Procfile (every type except `web` and `release`) and from
  known job libraries. Each runs from the app's image with its command, has no public port, gets a
  stop grace period (30 seconds by default, changeable), and is restarted when it exits.
- **FR-1306**: A worker MUST start the same way for every builder. Each builder has its own start
  form for a non-web command, and OpsCrew uses it.
- **FR-1307**: A scheduler that must run once MUST run as exactly one process.
- **FR-1308**: Cron jobs MUST come from `plan.yaml` and from `vercel.json`:
  - each job runs on its schedule inside the app's image, through a pinned scheduler verified by
    checksum;
  - an overlapping run is skipped;
  - schedules are in UTC.
- **FR-1309**: A `vercel.json` cron job MUST call the app's own route over the internal network, with
  a generated secret sent the way the original host sends it (`Authorization: Bearer`). OpsCrew MUST
  give the app that secret under the name it reads.
- **FR-1310**: A deploy MUST run the release command, switch the web process, then replace workers and
  cron with the new version. When a new worker does not keep running, the deploy MUST fail, name the
  worker and where its log is, and keep or restore the previous version of the web process and the
  workers.

**Databases and storage**

- **FR-1311**: MySQL MUST run on the conservative supported version (the LTS line before the newest),
  tuned for its memory limit. MariaDB is used only when the app declares it.
- **FR-1312**: MongoDB MUST run from the official image on a conservative version, with its cache
  capped to its limit. It runs as a single-node replica set when the app needs transactions. OpsCrew
  MUST check the CPU before provisioning on x86, and refuse with a plain message when the CPU lacks
  the instructions MongoDB needs.
- **FR-1313**: An app on SQLite MUST get a persistent volume on its database's folder, and the stop-first
  deploy strategy.
- **FR-1314**: Every database MUST get generated credentials, stored like OpsCrew's other generated
  values, never printed. The app MUST receive its connection settings under the names it reads.
- **FR-1315**: A detected hosted service MUST be asked about (keep it, or let OpsCrew run one), with
  what running it on the server would add (memory, and a larger server's price if needed). OpsCrew
  cannot see the hosted service's own bill, so it does not show a difference. A hosted service's own
  connection forms (such as MongoDB's SRV form) MUST be kept without asking.

**Object storage**

- **FR-1316**: Design MUST offer the object storage options available for the target, priced side by
  side for the expected use:
  - Cloudflare R2;
  - the provider's own storage;
  - a single-node storage container on the app's own server, on every target. On an own server or
    a Portainer target it can be the default; on a cloud server it is offered only as the user's
    choice, saying that the files then live only on that server (founder, 2026-10-20).

  The default is the cheapest option that is not opt-in.
- **FR-1316a**: An app's existing object storage MUST NOT be replaced unasked (founder, 2026-10-20).
  An S3 endpoint at a known host (AWS S3, Backblaze B2, Wasabi, DigitalOcean Spaces, Cloudflare R2,
  Hetzner Object Storage, Supabase Storage) counts as a hosted service, asked about as in FR-1315
  and kept without an answer. An S3 client with no endpoint setting is asked about too ("keep the
  storage the app uses now, or let OpsCrew create a bucket"), and with no answer OpsCrew plans no
  bucket.
- **FR-1317**: The bucket MUST be private, with keys limited to it where the service allows. It MUST
  accept browser uploads from the app's own origin only when the app uses presigned uploads.
- **FR-1318**: Creating a bucket MUST go through a plan the user approves by its hash. OpsCrew MUST
  NOT create storage keys:
  - the user creates one in the provider's console, with OpsCrew's steps: before the bucket for
    Hetzner and Spaces, and after it for R2, scoped to that bucket;
  - OpsCrew keeps it like a provider token, gives it to the infrastructure engine only through the
    environment, and gives it to the app as one of its secrets.
  No storage key is ever kept in infrastructure state.
- **FR-1319**: Destroy MUST keep buckets and their files unless the user asks to delete data. When
  they ask, destroy requires the same typed confirmation as other deletions.

**Brokers and queues**

- **FR-1320**: RabbitMQ, NATS, Apache Kafka (single node, KRaft) and Redpanda MUST be offered only for
  apps that use them:
  - Kafka is the default for Kafka clients, and Redpanda is the user's choice;
  - each runs with persistence and a memory setting that fits its limit;
  - RabbitMQ and NATS require a generated login. Kafka and Redpanda run without one, because their
    clients' authentication settings vary widely; they are reachable only from the app's own
    containers on its internal network, as Valkey is today;
  - each has bounded retention where it keeps logs;
  - none has a port open outside the server.
- **FR-1321**: When a job library keeps its jobs in Redis, Valkey MUST run without eviction and with
  its data on disk. A separate cache instance runs only when the app reads a separate cache address.
- **FR-1321a**: For the Redis protocol, Valkey MUST stay the default (founder, 2026-10-20). Instead:
  - **Redis 8** MUST run when the app's client shows it needs Redis's own data types: Search/Query,
    JSON, Time Series, probabilistic structures or vector sets. Redis 8 MUST also run when the app's
    own Compose file runs Redis. Its licence (RSALv2, SSPLv1 or AGPLv3) is named at design.
  - **Dragonfly** MUST be offered only as the user's choice, on a server with at least 2 vCPUs and
    room for 256 MB per thread, with its licence (BSL 1.1) named. It MUST also run when the app's
    own Compose file runs it.
  - A queue library that needs Dragonfly's own flags MUST get them, with a warning when the app's
    queue names need hashtags.
  - **KeyDB** is not offered. An app whose Compose file runs it gets Valkey, with one line saying so.

**Several apps on one own server**

- **FR-1322**: An own server MUST accept several OpsCrew apps:
  - each app has its own folder, data, processes and services;
  - the web entry, the version switch and the host hardening are shared and set up once;
  - each app keeps its own Cloudflare Tunnel when it uses one;
  - an app name used by another app on the server is refused;
  - a hostname belongs to one app.
- **FR-1323**: Deploying, destroying or changing one app MUST NOT restart or interrupt another. The
  shared parts MUST be removed only with the last app.
- **FR-1324**: The host plan and drift MUST show which app owns each part, and which parts are
  shared.

**Sizing, limits, versions and licences**

- **FR-1325**: Every container OpsCrew runs MUST have a memory limit taken from `plan.yaml`. Design MUST
  add up all limits, plus room for the system, to pick or check the server. On an own server it MUST
  use the server's inspected memory and the other apps' limits.
- **FR-1326**: Every new image MUST be pinned by digest on a conservative version. Major upgrades MUST
  be the user's choice, and Dependabot MUST not propose them for these images.
- **FR-1327**: A component under a licence other than a permissive open-source one MUST have its licence
  named at design, in plain words.
- **FR-1328**: No service MUST be reachable from outside the server. `secure` MUST check it, together
  with each service's authentication.

**Targets and day 2**

- **FR-1329**: Every target MUST run the components. Hetzner and DigitalOcean keep one app per server.
  A Portainer target runs them in its stacks, and refuses before any change what needs a host setting
  or host files, with a plain message.
- **FR-1330**: Part 2 engines (OpenSearch, Elasticsearch, Meilisearch, Typesense, ClickHouse, Neo4j)
  MUST run as single-node containers:
  - each has its memory limit and its required key or password;
  - each comes with a warning below its comfortable server size;
  - the host kernel setting the search engines need is part of the approved plan where OpsCrew
    manages the host.
  Cassandra MUST stay external.
- **FR-1331**: `status` MUST list each component and whether it runs. `drift` MUST report a component
  that differs from the plan. Destroy MUST remove every component, and keep the data unless asked
  otherwise.
- **FR-1332**: Retarget MUST move Postgres and Valkey as today, with the app's workers and cron. When the
  app has another stateful service (MySQL, MongoDB, a broker, an engine, SQLite), retarget MUST refuse
  before any change, and say that copying their data comes later. Buckets stay where they are.
- **FR-1333**: The guide MUST describe components, each service kind (version, memory, licence,
  settings), workers and cron, object storage choices with prices, and several apps on one own
  server.
- **FR-1334**: The acceptance matrix MUST add example apps for workers and cron, MySQL, MongoDB, SQLite,
  object storage, RabbitMQ, NATS and Kafka (part 1), and for one search and one analytics engine
  (part 2).

### Key Entities

- **Component**: a part of the deployed app. Its kind is web, worker, cron, database, cache, queue,
  broker, object storage, storage volume, or search or analytics engine. It has a version, a memory
  limit, settings, where it was found, and whether the user changed it.
- **Process**: the web process or a worker. It has a command, a count, a stop grace period, and the
  same image as the web process.
- **Cron job**: a schedule in UTC, and a command or a route.
- **Service**: a backing service OpsCrew runs. It has a kind, version, memory limit, a data volume,
  generated credentials, and its licence.
- **Object storage choice**: a provider (R2, Hetzner, DigitalOcean, a storage container), a bucket, a
  region and a price.
- **Host with several apps**: the own server's shared parts and the apps on it, each with its own
  components.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1301**: Every new example app builds and starts with its components in the local Docker
  pass, with no hand-written configuration:
  - workers and cron, MySQL, MongoDB, SQLite, object storage, RabbitMQ, NATS and Kafka in part 1;
  - one search and one analytics engine in part 2.
  The live set (the worker and cron example, MySQL, MongoDB, object storage, RabbitMQ, Kafka,
  Meilisearch, ClickHouse) deploys from a fresh repository and passes `verify`.
- **SC-1302**: In the worker example, a job queued from the web process is processed within
  30 seconds. A cron job runs within one minute of its scheduled time.
- **SC-1303**: Data written through each database, storage and broker example survives a redeploy and
  a restart of its containers in the local Docker pass, and a server reboot in the live set.
- **SC-1304**: Every container on every target has a memory limit, and the limits add up to no more
  than the chosen server's memory minus the system's share.
- **SC-1305**: Two apps on one own server each deploy a change under steady load (20 requests per
  second each) with no failed request. Destroying the first causes no failed request to the second.
- **SC-1306**: No service port is reachable from the internet on any target. A search for known
  secret values finds none in commits, pull requests, output, logs or attestations.
- **SC-1307**: Running design, adapt or provision again with nothing changed changes no component and
  no file.
- **SC-1308**: Before approving, the user sees each component's memory and price share. Every licence
  outside permissive open-source is named.

## Assumptions

- One server per app on Hetzner and DigitalOcean, as today. Several apps share a server only on the
  user's own server, and on a Portainer target, which already supports it.
- No high availability, replication or clustering: one container per component.
- Backups stay the provider's server backups (founder, 2026-10-13). They are crash-consistent only,
  and the guide says so. No off-server or logical backups in 013.
- Workers and cron jobs use the app's settings and secrets. They do not get their own.
- The object storage container is offered only on an own server or a Portainer target. It keeps
  files on that one server only.
- Public buckets, CDNs and custom domains for object storage are out of scope.
- Managed databases on hyperscalers are 017's.
- Memory figures in the research are starting points. The live runs settle each service's default
  limit and its smallest server.
- MinIO is not offered: it is archived and its images are gone (research R3).
