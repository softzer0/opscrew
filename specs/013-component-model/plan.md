# Implementation Plan: The component model

**Branch**: `main` | **Date**: 2026-10-19 | **Spec**: `specs/013-component-model/spec.md` |
**Research**: `specs/013-component-model/research.md` (R1–R8, the spike's open items)

## Summary

**Components.** An app becomes a list of components in `plan.yaml`:
- the web process and its workers and cron jobs;
- the backing services it already uses (databases, queues, brokers, and in part 2 search and
  analytics engines);
- persistent storage for SQLite and object storage.
Each has a version, a memory limit and settings the user can change, and a later design keeps them.

**One service catalog.** A typed table in iac-templates holds, per service kind, the pinned image,
the default version and memory, the smallest server, the licence, the port, data folder,
healthcheck, the variables the app receives, the generated secrets and the host settings. One
renderer turns it into Compose and Portainer stacks. Postgres and Valkey move into it.

**Processes.** Workers run from the app's image with each builder's start form. Cron runs through
supercronic, built into the image with a checksum. A deploy replaces workers and cron after the web
switch, and fails back when a new worker does not stay up.

**Object storage.** R2, DigitalOcean Spaces and Hetzner Object Storage, all created through the IaC
engine. Garage is the storage container for an own server or Portainer.

**One server, several apps.** An own server holds several OpsCrew apps:
- each app has its own Compose project and folders;
- a shared edge (Caddy, kamal-proxy, cloudflared) serves them all;
- the edge goes with the last app.
The same layout is used on cloud servers, which keep one app each.

**Limits.** Every container gets a memory limit. Sizing adds them up.

## Technical Context

- **Stack:** the same as 000–012. No new package and no new runtime dependency in the CLI. Object
  storage uses providers the IaC engine already resolves from the registry, plus `hashicorp/aws`
  pointed at Hetzner's S3 endpoint. Both engines validate it.
- **Where things run:** every service runs as a container on the user's server, pinned by digest.
  supercronic is built into the app's image with `ADD --checksum`. Nothing new runs in the CLI.
- **Licences:** MongoDB (SSPL), Redpanda (BSL 1.1), Elasticsearch (ELv2), Garage (AGPL),
  Typesense and Neo4j Community (GPL) run as separate containers for the user's own app, never
  linked into OpsCrew. Design names each licence (FR-1327).
- **To verify in the local spike** (T1302):
  - Railpack's and Buildpacks' worker start forms;
  - kamal-proxy with two services on two hosts, on one proxy;
  - `mem_limit` honoured by Docker Compose and by a Portainer CE stack;
  - supercronic's `ADD --checksum` build on amd64 and arm64;
  - Garage's single-node init;
  - MongoDB's replica-set init with Prisma.
- **To verify in the live tests** (T1314):
  - the R2 bucket through the Cloudflare provider, and a token the user scopes to it;
  - the Hetzner bucket through the `aws` provider, with the user's key;
  - memory figures per service on 1, 2 and 4 GB servers.
- **Tests:** fakes and snapshots as before, the local Docker pass over the new examples, and gated
  live tests on Hetzner, an own server and Portainer.

## Constitution Check

- **I (safety gate).** No new mutation path:
  - Buckets and their CORS go through the IaC engine, in a separate `storage` root: the Cloudflare
    provider for R2, the `aws` provider pointed at the S3 endpoint for Spaces and Hetzner. Each is
    planned, checked and approved by its hash. OpsCrew never creates storage keys.
  - The host prerequisites (folders, the edge's place, the sysctl item for the search engines) and
    each app's host changes on an own server go through the host plan.
  - The edge's files and each app's runtime files arrive with the deploy the user merges, as the
    runtime files do today.
  - Services, workers and cron are part of the runtime files the provision pull request carries.
  - The deploy script never restarts another app, or a service of its own app.
  - Deleting a bucket or a service's data needs `--delete-data` with the typed confirmation.
  - No new approval kind, so no constitution change.
- **II (user owns everything).** Every component is plain YAML in `plan.yaml`, and every generated
  file (Compose, Caddy site files, supercronic's crontab, service configs) is in the repository. A
  later design keeps the user's edits (FR-1304).
- **III (dual engine).** The new `storage` root (R2 bucket, or an S3 bucket through `aws`) is in the
  common dialect. Both engines validate it.
- **IV (secrets).**
  - Every service's password, key or token is generated and stored with OpsCrew's other generated
    values. It reaches the server only in that app's env files. It is never printed, and never in
    a plan, a pull request or the repository.
  - The user's storage key is kept like a provider token. It reaches the engine only as an
    environment variable (`TF_VAR_…`), never a committed file, so no key is in infrastructure state.
    It reaches the app as one of its secrets.
  - Kafka and Redpanda run without a login, reachable only from the app's own containers on its
    internal network, as Valkey is today (FR-1320).
- **V (deterministic first).** Detection, the component list, sizing, prices and the catalog are pure
  functions. The model writes only code changes the templates cannot make, such as an S3 client that
  needs an endpoint setting.
- **VI (contracts first).** The new `plan.yaml` and `ProjectFacts` fields and the catalog's types
  change in one serial task (T1301a), recorded in ADR 0016. The host record is the ssh-host
  connector's own (T1308a).
- **VIII (typed adapters).** No new adapter. The ssh-host adapter learns several apps per host.
- **IX (plain language).** Every component has a one-sentence reason. Each licence is named in plain
  words. Every refusal (AVX, host settings on Portainer, a server too small) says what to do.
- **X (simplicity).**
  - One catalog instead of a function per service.
  - One edge layout for every server target.
  - No backup feature (the founder decided provider backups are enough).
  - Retarget refuses what it cannot copy yet, instead of a half-built copy.

## Project Structure

| Package | Change |
|---|---|
| `packages/plan-schema`, `packages/iac-templates/src/catalog/types.ts` | `app.memoryMb`, `processes`, `services[]`, `storage`; `ProjectFacts` workers, cron, the new service kinds, hosted URLs; the catalog's types; every reader and writer of the old booleans (T1301a) |
| `packages/iac-templates` (pins, prices) | new images and supercronic in `pins.ts`, `scripts/update-pins.mjs`, the storage price tables in `prices.ts` (T1301b) |
| `docs/adr/0016-components.md` | the ADR (lead, committed) |
| — | the local spike (T1302) |
| `packages/detect` | the new service kinds and their clients, workers (Procfile and job libraries), vercel.json crons, hosted-service URLs, MariaDB, SQLite paths (T1303) |
| `packages/iac-templates` (catalog, runtime, portainer-target, dependabot) | the catalog's part 1 entries; services, workers and cron in Compose and stacks, with limits (T1304) |
| `packages/iac-templates` (docker, workflow) | supercronic in the Dockerfile and the seal; the deploy order and the worker check (T1305) |
| `packages/iac-templates` (infra, generated modules) | the `storage` root: the R2 bucket, or an S3 bucket through `aws` (T1306) |
| `packages/agents` (design, interview) | components from facts, the generic hosted-service question, worker commands, storage options with prices, sizing, licences, kept edits (T1307) |
| `packages/connectors/ssh-host` | several apps per host, app records, CPU flags (T1308a) |
| `packages/iac-templates` (edge, runtime, workflow paths, modules' cloud-init) | the shared edge and the per-app layout on every server (T1308b) |
| `packages/agents` (own-server flows and every `/srv/app` path), `packages/secops` (paths) | several apps on an own server in provision, destroy and drift (T1308c) |
| `packages/agents` (provision, destroy, drift, secure, retarget), `packages/secops` | components day 2 and the storage key prompt (T1309) |
| `packages/agents` (Portainer flows), `packages/iac-templates` (portainer-target) | components in stacks; the host-settings refusal (T1310) |
| `packages/iac-templates`, `packages/agents`, `packages/connectors/ssh-host` | part 2 engines and `vm.max_map_count` (T1311) |
| `packages/cli`, `packages/mcp-server`, `plugin`, `docs/guide`, `packages/iac-templates/src/runbook` | surfaces, `status`, the runbook and guide pages (T1312) |
| `examples/`, `packages/cli/test/e2e` | the new examples and the Docker pass (T1313) |
| `packages/cli/test/live`, `docs/e2e*.md` | live tests (T1314) |

## Design

### 1. Plan, facts, catalog types and pins (T1301, serial, lead-reviewed)

- **`plan.yaml`** (data-model.md): `app.memoryMb`; `processes.workers[]`, `processes.cron[]`;
  `services[]`; `storage.sqlite`, `storage.objectStorage`. Today's `services: { postgres, redis }`
  booleans go (no migration).
- **`ProjectFacts`:**
  - `workers[]`: name, command (when known), source, single;
  - `cronJobs[]`: schedule, route, from `vercel.json`;
  - `services` gains the new kinds, and each entry its evidence and the URL variable it reads;
  - `hostedServices[]`: the kind, the variable, the provider's name;
  - `sqlite`: the database paths.
- **Catalog types** (`packages/iac-templates/src/catalog/types.ts`): `ServiceSpec` per kind. The
  contract is in contracts/components.md.
- **Pins:** the new images by digest; supercronic as a tool with a SHA-256 (and its upstream
  SHA-1 checked by the pin script); Hetzner's object storage price table with its source and date.
- **ADR 0016.**

### 2. The local spike (T1302)

On the lead's machine with Docker, settling research's open items 1–4, 8, 10 and 13:
- Railpack: `docker inspect` and a worker's `command`, with SIGTERM reaching it through `bash -c`.
- Buildpacks: `entrypoint: ["/cnb/process/worker"]` and the launcher form for a raw command.
- kamal-proxy: two services on two hosts, and whether one service can take two hosts.
- `mem_limit` in `docker inspect`, with Docker Compose v2 and with a Portainer CE stack.
- supercronic's `ADD --checksum` on amd64 and arm64.
- Garage: the single-node init (layout, key, bucket) as a one-shot container.
- MongoDB: a single-node replica-set init with Prisma.
- Each new image's user, its shell and tools, and its healthcheck.
Results go in research.md.

### 3. Detection (T1303)

- Client packages per ecosystem for MySQL, MariaDB, MongoDB, AMQP, NATS, Kafka, S3 and the part 2
  engines, from research's lists. Runtime dependencies only.
- **Workers:**
  - every Procfile type except `web` and `release`;
  - job libraries with their conventional commands, from R1's table;
  - single-instance schedulers marked.
- **Cron:** `vercel.json` `crons` (path, schedule).
- **Hosted URLs:** `mongodb+srv://`, PlanetScale, Upstash, Neon and the like, from the env examples,
  as `hostedServices`.
- **Celery's broker** follows its broker URL's scheme.
- **SQLite:** the framework's default database path, or the configured one.

### 4. The catalog and services (T1304)

- **One `ServiceSpec` per kind:** Postgres, MySQL, MariaDB, MongoDB, Valkey (cache or queue mode),
  RabbitMQ, NATS, Kafka, Redpanda, Garage (part 1 entries; part 2 in T1311).
- **Per spec:**
  - image pin, version and its major for Dependabot;
  - default and minimum memory, and the smallest server;
  - licence;
  - port, data folder and the config files to mount (MySQL `my.cnf`, `rabbitmq.conf`, NATS
    `nats.conf`);
  - healthcheck;
  - the variables the app receives, by convention (`DATABASE_URL` with the right scheme, `MONGODB_URI`,
    `AMQP_URL`, `NATS_URL`, `KAFKA_BROKERS`, `REDIS_URL` and the app's own names);
  - generated secrets;
  - a one-shot init (MongoDB's replica set, Garage's layout and key).
- **One renderer** writes each service with `mem_limit`, `restart: unless-stopped`, the internal
  network, a volume under `/srv/data/<app>/<service>` and no published port. Portainer stacks use
  named volumes.

### 5. Processes and the deploy (T1305)

- **Workers:** one Compose service per worker. Its start form per builder is in contracts. It gets
  `stop_grace_period`, `mem_limit` and `restart: unless-stopped`, no ports and no healthcheck. A
  `single` worker's count is pinned to 1.
- **Cron:**
  - a `cron` service from the app's image runs `supercronic /etc/opscrew/crontab`;
  - the crontab is a generated file in the repository;
  - `vercel.json` routes are called through the probe tool with `Authorization: Bearer $CRON_SECRET`;
  - schedules are in UTC (research "Spike results" 6).
- **supercronic in the image:** `ADD --checksum=sha256:<pin> <url> /usr/local/bin/supercronic` in the
  generated Dockerfile's runtime stage and in the seal step for Buildpacks and Railpack. An own
  Dockerfile gets the seal step only when the plan has cron jobs.
- **The deploy:**
  1. the steady services from the catalog, `up -d --wait`;
  2. the release command;
  3. the web switch;
  4. workers and cron `up -d --no-deps` with the new image;
  5. a 30-second check that each worker is still running. On failure, the web and the workers go
     back to the previous image, and the run names the worker and `docker compose logs <worker>`.
  SQLite apps use `recreate`.

### 6. Object storage in the IaC engine (T1306)

- **A separate `storage` root** (`opscrew/infra/storage`), so destroy and retarget leave the
  bucket alone unless the user asks to delete data. It holds only the bucket and its CORS.
- **OpsCrew never creates storage keys.** The user creates one in the provider's console with
  OpsCrew's steps, and pastes it once. It is kept like a provider token, and reaches the engine as
  `TF_VAR_…` environment variables and the app as its secrets.
- **R2:** `cloudflare_r2_bucket` (and its CORS) through the Cloudflare provider, with OpsCrew's
  Cloudflare token, which then needs the R2 storage permission; the guide and `init` name it. After
  the bucket exists, the user creates an R2 token limited to it, in Cloudflare's dashboard.
- **DigitalOcean Spaces and Hetzner Object Storage:** `hashicorp/aws` pointed at the provider's S3
  endpoint, with path-style addressing and its account and region checks off, using the user's key
  (created before the bucket). The guide advises a new key per app; Hetzner's keys cover a whole
  project.
- **Garage** (own server and Portainer): a catalog service with its init.
- **The app receives** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
  `AWS_ENDPOINT_URL_S3`, the bucket under the app's variable, and Laravel's names.
- **Prices:** each provider's own formula for the expected use (`storage.objectStorage.expected`,
  from the interview's scale, editable):
  - R2: storage per GB-month and operations per million, after the free tier; no egress charge;
  - Spaces: USD 5 with 250 GiB stored and 1,024 GiB out, then USD 0.02 per GiB stored and
    USD 0.01 per GiB out;
  - Hetzner: EUR 6.49 per account with 1 TB stored and about 1.1 TB out, then EUR 6.26 per
    TB-month stored and EUR 1.00 per TB out (research R3); the base is per account, which design
    says;
  - Garage: free, on the server's own disk.
  Design picks the cheapest for the expected use and shows the others.

### 7. Design (T1307)

- **Components from facts:** services, workers, cron, storage.
- **One generic hosted-service question** replaces the Supabase one, with what running it on the
  server would add.
- **The interview** asks a worker's command only when there is no convention.
- **Storage options with prices.**
- **Kafka by default**, Redpanda as the user's choice; refused below Kafka's smallest server.
- **Licences** named in plain words.
- **Sizing:**
  - the sum of the limits, plus the edge, plus a system reserve (research R7);
  - the server type is chosen to fit;
  - on an own server, it checks the inspected memory minus the other apps' limits.
- **`keepPlanSettings` keeps the user's component edits** (counts, memory, versions, options, a
  component turned off), and says what changed.
- **The SQLite strategy** is `recreate`.

### 8. Several apps on one own server and the edge (T1308a, T1308b, T1308c)

- **Layout on every server target:** `/srv/apps/<app>/` (compose.yaml, env files) and
  `/srv/data/<app>/`, with Compose project `<app>`.
- **The edge:** `/srv/edge` with Compose project `opscrew-edge`:
  - Caddy and kamal-proxy, on an external network `opscrew-edge` that each app's web service
    joins;
  - Caddy imports `/srv/edge/sites/*.caddy`, one file per app;
  - kamal-proxy holds one service per app, named `<app>`, with `--host <domain>`, targeting the
    app's web containers by their Compose names (unique per app). A `www` name is redirected by
    Caddy (the spike checks whether one service can take two hosts);
  - each app keeps its own Cloudflare Tunnel: its cloudflared runs in the app's own project, joins
    `opscrew-edge`, and sends its hostnames to Caddy. One root still owns one tunnel, as today.
- **Who writes the edge:** every deploy uploads the edge files from its repository
  (`opscrew/runtime/edge/`) and its own site file. A version stamp in the edge's Compose file decides
  which copy is kept: the newest wins, so an older app never downgrades the edge. Only a changed edge
  is restarted, which the deploy says.
- **The host plan** (own server) sets up the prerequisites: Docker, the `deploy` user, the
  folders, the firewall, the hardening, and the app records.
- **The ssh-host connector:**
  - one record per app, `/etc/opscrew/apps/<app>.json`, and the host record lists the apps;
  - the second-app refusal goes;
  - a hostname used by another app is refused;
  - the host plan shows the shared parts and the app's own;
  - an app name another app uses on the server, or the reserved `opscrew-edge`, is refused;
  - the per-app record keeps the app's hostnames and memory limits, for the next app's checks;
  - inspection reads the CPU flags too, for MongoDB's AVX check;
  - destroy removes only the app's parts, and the edge goes with the last app;
  - `--undo-host` stays for the hardening.
- **Cloud servers** (Hetzner, DigitalOcean) use the same layout, with one app per server.
  cloud-init prepares the folders, and the deploy brings up the edge.

### 9. Day 2 for components (T1309)

- **provision:** the storage key prompt, the AVX check for MongoDB on x86, the components'
  generated secrets, and the steady services.
- **destroy:** every component; data folders and buckets stay unless `--delete-data` is given with
  the typed confirmation.
- **drift:** components against the plan.
- **secure:** no service port public, and each service's auth on.
- **retarget:** keeps Postgres and Valkey as today, and buckets where they are. It refuses before any
  change when the app has another stateful service, and says when that will come.

### 10. Portainer (T1310)

- Stacks render the same components, with named volumes.
- Garage is allowed.
- What needs a host setting is refused before any change, with the setting to make by hand.

### 11. Part 2 engines (T1311)

- Catalog entries:
  - OpenSearch, with the security plugin off on the internal network;
  - Elasticsearch, for Elasticsearch clients only, with security on;
  - Meilisearch, in production mode with a master key;
  - Typesense, with an API key;
  - ClickHouse, with the low-memory profile and a user;
  - Neo4j Community, with auth.
- Each with a licence, a minimum server and a warning.
- `vm.max_map_count`:
  - on cloud servers, a one-shot privileged init container in the app's Compose file, before the
    engine, so an existing server gets it too;
  - on an own server, a host-plan item (`/etc/sysctl.d`), approved by its hash;
  - refused on Portainer.

### 12. Surfaces and guide (T1312)

- **CLI and MCP:** `status` lists each component and whether it runs. Design's output shows
  components, licences and each component's memory and price share.
- **The runbook** describes the components, the edge and the storage key.
- **Plugin skills:** updated.
- **The guide:**
  - `components.md`;
  - `workers-and-cron.md`;
  - `databases.md`;
  - `object-storage.md`;
  - `brokers.md`;
  - `search-and-analytics.md`;
  - an update to `own-server.md` for several apps.

### 13. Examples (T1313)

- **Part 1:**
  - `celery-worker` (worker and beat, a Redis queue, a plan cron job);
  - `node-bullmq` (a Procfile worker, and `vercel.json` crons);
  - `express-mysql`;
  - `node-mongo`;
  - `flask-sqlite`;
  - `s3-uploads` (presigned);
  - `rabbitmq-worker`;
  - `nats-app`;
  - `kafka-app`.
- **Part 2:** `meili-search`, `clickhouse-events`.
- **The Docker pass** starts each with its services, and checks a write and a read, a worker
  consuming, and a cron run.

### 14. Live tests (T1314)

- **Hetzner:** the worker and cron example, MySQL, MongoDB, object storage (R2 and Hetzner),
  RabbitMQ and Kafka. Each passes:
  - data survives a deploy and a reboot;
  - a worker consumes;
  - cron runs;
  - every container has its limit;
  - no service port is public.
- **Own server:** two apps on two hostnames, a change under load to each, then the first app's
  destroy with the second still answering.
- **Portainer:** components in stacks, and the host-settings refusal.
- **Part 2:** one search and one analytics engine.

## Order

The exact waves are in tasks.md. In short:
1. T1301a (contracts and call sites) and T1301b (pins and prices), in parallel.
2. T1302 (the spike, lead), T1303, T1306 and T1308a.
3. T1304, T1305.
4. T1307.
5. T1308b, then T1308c.
6. T1309.
7. T1311, then T1310.
8. T1312 and T1313.
9. T1314, then T1315.

## Complexity Tracking

| Choice | Why | Simpler alternative rejected because |
|---|---|---|
| One shared edge per host | Ports 80 and 443 can only be opened once per host | One edge per app needs other ports, which Cloudflare and users do not expect |
| The same layout on cloud servers | One code path for every server target | Two layouts double the runtime and destroy code |
| Object storage through the IaC engine, in its own root, with keys the user creates | No new adapter, no new approval kind, no key in state, least privilege for OpsCrew's tokens, and buckets kept apart from destroy and retarget | A custom S3 adapter needs a constitution change and its own plan format |
| supercronic built into the image | Works on every target, Portainer included, with one checksum | A host-mounted binary needs host files, which Portainer cannot provide |
| Retarget refuses the new stateful services | An honest stop instead of an untested data copy | A generic volume copy needs its own maintenance-window design and live tests |
