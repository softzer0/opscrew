---
description: "Tasks for 013-component-model"
---

# Tasks: The component model

**Input**: `specs/013-component-model/` (spec.md, plan.md, research.md R1–R8, data-model.md,
contracts/components.md, quickstart.md, ADR 0016) + features 000–012.

**Numbering**: T1301–T1399.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`.

**Rules for every task:**
- Fixtures never contain secret-shaped literals (`fakeSecret()`, or `{{FAKE:…}}` with
  `materializeFixture()`).
- No test touches the network, a real cloud or a model.
- Every container a task renders has a memory limit (FR-1325) and no published port for a service
  (FR-1328).
- Build only what Accept asks. Report anything else as a finding.

## Phase 1: Foundation (serial)

- [ ] T1301 Components in the plan and the facts, the catalog's types, and the pins in `packages/plan-schema/src/**`, `packages/iac-templates/src/{catalog/types.ts,pins.ts,prices.ts,index.ts}`, `packages/iac-templates/scripts/**`, and the call sites of today's `services` booleans
  - Owns: those paths (+ tests). Also the lines in `packages/agents`, `packages/iac-templates`, `packages/cli`, `packages/mcp-server` and `packages/secops` that read `plan.services.postgres` or `plan.services.redis`; change only those lines, to the new helper.
  - Reads: data-model.md; contracts/components.md "ServiceSpec"; plan.md "1."; research.md R1–R4, R8; `.tools/scratch/013-code-map.md`
  - Depends: —
  - Accept:
    - **`plan.yaml`** gains `app.memoryMb`, `processes.workers[]`, `processes.cron[]`, `services[]` and `storage`, exactly as data-model.md, with zod validation:
      - worker and service names unique, `[a-z][a-z0-9-]*`, never `app`, `release`, `cron`, `proxy` or `caddy`;
      - `single: true` forces `count: 1`; `count` is 1–10; `stopGraceSeconds` is 5–600;
      - a cron entry has exactly one of `command` and `route`;
      - `storage.objectStorage.provider` is one of `r2`, `digitalocean`, `hetzner` and `garage`.
    - **Today's `services: { postgres, redis }` booleans go.** A helper `serviceOf(plan, kind)` (or `hasService`) replaces every read of them across the packages. Behaviour stays the same: Postgres and Valkey (`mode: cache`) become entries of `services[]`, and `externalServices` stays. Every package still passes its tests.
    - **`ProjectFacts`** gains `workers[]`, `cronJobs[]`, `hostedServices[]`, `sqlite` and `objectStorage`. The service kinds grow to every kind in data-model.md. Detection fills them in T1303.
    - **The catalog's types:** `ServiceSpec` and `ServiceContext` in `packages/iac-templates/src/catalog/types.ts`, as in the contract, exported from the package root.
    - **`pins.ts`:**
      - adds by digest: MySQL 8.4, MariaDB (the current LTS line), MongoDB 8.0, RabbitMQ 4.3, NATS 2.15 alpine, `apache/kafka` 4.x, Redpanda 26.x, Garage;
      - adds supercronic v0.2.50 as a tool with a per-architecture SHA-256, computed from the release assets, and its upstream SHA-1;
      - `scripts/update-pins.mjs` refreshes them and checks supercronic's SHA-1 before writing a SHA-256;
      - Dependabot's no-major list is fed from the catalog later (T1304); here only the pins.
      - Use the research's digests where they exist. Run the pin script for the rest; never invent a digest.
    - **`prices.ts`:** the object storage price tables (R2, Spaces, Hetzner from research R3 with its source and date; Garage free), and one function per provider giving the monthly price for `{ storageGb, egressGbPerMonth }`. Unit tests cover each formula, Hetzner's per-account base included.
  - Verify: `pnpm turbo run typecheck test`
  - Effort: xhigh

## Phase 2: Local spike (lead or an agent with Docker; in parallel with T1303 and T1306)

- [ ] T1302 Local spike on Docker. It settles research.md "Open items" 1–4, 8, 10 and 13, and the results go into research.md as "Spike results":
  - Railpack: `docker inspect` of a real image; a worker started with `command: ["<cmd>"]`; SIGTERM reaching the process.
  - Buildpacks: `entrypoint: ["/cnb/process/worker"]` from a Procfile; the launcher form for a raw command; the seal with supercronic keeping the launcher.
  - kamal-proxy v0.10.2: two services on two hosts behind one proxy; one service with two hosts.
  - `mem_limit` and `deploy.resources.limits.memory` in `docker inspect`, with Docker Compose v2 and with a Portainer CE stack; and whether `deploy.replicas` works without Swarm.
  - supercronic: `ADD --checksum` on amd64 and arm64; a run skipped when the previous one overlaps.
  - Garage: the single-node init (layout, key, bucket) as a one-shot container, and its memory at idle.
  - MongoDB 8.0: a single-node replica set with Prisma, and its memory with the cache capped.
  - Each new image's user, shell and tools (`wget`, `curl`), and a healthcheck that works.
  - Effort: high

## Phase 3: Packages (parallel)

- [ ] T1303 [P] [US1] [US2] [US3] [US4] [US7] Detection of the new components in `packages/detect/src/**`
  - Owns: that folder, plus `packages/detect/test/**` (+ fixtures)
  - Reads: research.md R1–R5 detection lists; data-model.md "ProjectFacts"; spec FR-1302, FR-1305, FR-1308, FR-1315
  - Depends: T1301
  - Accept:
    - **Service kinds** from runtime dependencies only (never dev dependencies), per ecosystem from research's lists: MySQL, MariaDB (declared by the app: a MariaDB client, `DB_CONNECTION=mariadb` or a `mariadb` URL), MongoDB, AMQP, NATS, Kafka, S3, and the part 2 engines (OpenSearch and Elasticsearch told apart by their clients), Meilisearch, Typesense, ClickHouse, Neo4j, Cassandra (as external).
    - **Workers:**
      - every Procfile type except `web` and `release`, with its command;
      - job libraries with their conventional commands from research R1's table: Celery worker and beat, RQ, Dramatiq, Huey, Sidekiq, GoodJob, Solid Queue (`bin/jobs`), Resque, BullMQ (no conventional command), Laravel's `queue:work` and `schedule:work`, asynq, river;
      - schedulers marked `single`;
      - in-process schedulers recorded as a note, not a worker.
    - **Cron jobs** from `vercel.json` `crons` (path, schedule).
    - **Hosted services** from env examples and config: `mongodb+srv://`, PlanetScale, Upstash, Neon and the like, with the variable and the provider's name.
    - **Celery's broker** follows its broker URL's scheme: AMQP gives a broker, Redis gives a queue-mode Valkey.
    - **SQLite:** the database path from the framework's default or its configuration (Rails 8's four files, Django, Laravel, Prisma, Drizzle), and its folder.
    - **Object storage:** the S3 client, presigned-upload use (`@aws-sdk/s3-request-presigner` and the like), and the variable names the app reads.
    - Fixture tests per kind, and per worker library.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect`
  - Effort: high

- [ ] T1304 [P] [US1] [US2] [US4] [US6] The catalog's part 1 entries, and the services, workers and cron in Compose and Portainer stacks, in `packages/iac-templates/src/{catalog,runtime,portainer-target,dependabot}/**`
  - Owns: those folders (+ tests and snapshots)
  - Reads: contracts/components.md (ServiceSpec, start forms, the edge's per-app paths); research.md R1–R4, R7 and the spike results; spec FR-1305–FR-1314, FR-1320–FR-1321, FR-1325, FR-1328
  - Depends: T1301, T1302
  - Accept:
    - **Catalog entries:**
      - Postgres (moved from `dbService`);
      - Valkey in cache mode (LRU, no persistence) and in queue mode (`noeviction`, AOF);
      - MySQL 8.4 with a mounted small-server `my.cnf`;
      - MariaDB;
      - MongoDB 8.0 with `--wiredTigerCacheSizeGB` from its limit, and the replica set's one-shot init when `options.replicaSet`;
      - RabbitMQ with a mounted `rabbitmq.conf` (absolute watermark, `guest` removed) and `hostname`;
      - NATS (alpine, token config, JetStream volume);
      - Kafka KRaft single node (heap and retention from the plan);
      - Redpanda;
      - Garage with its init.
      Each has its licence, memory, healthcheck, secrets and app variables.
    - **One renderer** writes every service for Compose and one for Portainer stacks:
      - each has `mem_limit`, `restart: unless-stopped`, the internal network and no `ports`;
      - volumes go under `/srv/data/<app>/<service>` on servers, and named volumes in Portainer;
      - config files go to `opscrew/runtime/services/<kind>/`.
    - **Workers:** one service each, with the start form per builder from the contract (as the spike settled), `stop_grace_period`, `mem_limit`, no ports.
    - **Cron:** one `cron` service and the generated `opscrew/runtime/crontab`. Route jobs call through the probe tool with `Authorization: Bearer ${CRON_SECRET}`; `TZ` is set.
    - **The web service** gets `mem_limit` from `app.memoryMb`.
    - **Dependabot:** its no-major list is read from the catalog's `majorLocked`.
    - **Snapshots** for an app with a worker, cron, MySQL and RabbitMQ, for each builder's start form, and for a Portainer stack.
    - The app's variables come from the catalog. The Postgres and Valkey output stays the same apart from the new limits and paths.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [ ] T1305 [P] [US1] supercronic in the image, and the deploy order with the worker check, in `packages/iac-templates/src/{docker,workflow}/**`
  - Owns: those folders (+ tests and snapshots)
  - Reads: contracts/components.md "The deploy" and "Process start forms"; plan.md "5."; research.md R1 and the spike results; 012's `workflow/switch.ts`
  - Depends: T1301, T1302
  - Accept:
    - **supercronic** is added with `ADD --checksum=sha256:<pin> <url> /usr/local/bin/supercronic`, only when the plan has cron jobs:
      - in the generated Dockerfile's runtime stage;
      - in the seal step for Buildpacks and Railpack;
      - in a seal step added for an own Dockerfile.
      The architecture comes from the build runner.
    - **The deploy script's order:**
      1. the steady services from the plan's `services[]`, `up -d --no-deps --wait`;
      2. the release command;
      3. the web switch (`rolling`, or `recreate` for SQLite apps);
      4. workers and cron `up -d --no-deps` with the new image;
      5. a 30-second check that every worker keeps running.
      On a failure in steps 3–5, the web and the workers go back to the previous image, and the error names the worker and `docker compose logs <worker>`.
    - **Paths:** the deploy works in `/srv/apps/<app>`, not `/srv/app`. The edge's kamal-proxy service is named `<app>`, with `--host`. Coordinate the edge's own files with T1308b's contract.
    - **Never touched:** another app's containers, and a service of this app whose configuration did not change.
    - **Tests:**
      - bash tests with fake `docker` for the order;
      - the failing-worker rollback;
      - no restart of steady services;
      - snapshots of the seal with supercronic.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [ ] T1306 [P] [US3] Object storage in the IaC engine, in `packages/iac-templates/src/infra/**`, `packages/iac-templates/modules/**`
  - Owns: those paths (+ tests and snapshots); `packages/iac-templates/src/index.ts` only for new exports
  - Reads: plan.md "6."; research.md R3; contracts/components.md; spec FR-1316–FR-1319; constitution III
  - Depends: T1301
  - Accept:
    - **R2** in the Cloudflare root:
      - `cloudflare_r2_bucket`, plus its CORS for the app's origin when `cors`;
      - a bucket-scoped account token with R2 object read and write;
      - sensitive outputs: the access key (the token's id) and the secret (the SHA-256 of the token value).
    - **DigitalOcean Spaces** in the DigitalOcean root:
      - `digitalocean_spaces_bucket` and its CORS, with the user's Spaces key as provider settings from variables, never committed;
      - a bucket-scoped `digitalocean_spaces_key` for the app, as a sensitive output.
    - **Hetzner Object Storage** in the Hetzner root:
      - `hashicorp/aws` pointed at `<location>.your-objectstorage.com`, with path-style addressing and the account and region checks off;
      - the bucket and its CORS, with the user's key pair from variables.
    - **Validation:** every root still validates with both OpenTofu and Terraform (`OPSCREW_IT=1`). The new providers are pinned like the existing ones.
    - **Destroy:** a bucket is never destroyed unless the plan allows deleting data. Use `prevent_destroy` or the existing destroy-guard pattern, whichever the roots use today.
    - **Snapshots** for each provider. The test variables use `fakeSecret`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, plus `OPSCREW_IT=1` for the changed roots
  - Effort: high

## Phase 4: Design

- [ ] T1307 [US1] [US2] [US3] [US4] [US6] Components in design and the interview, in `packages/agents/src/{design,interview,shared}/**`
  - Owns: those folders (+ tests)
  - Reads: spec FR-1301–FR-1304, FR-1315–FR-1316, FR-1325, FR-1327; plan.md "7."; research.md R7, R8; data-model.md
  - Depends: T1303, T1304, T1306
  - Accept:
    - **Components from facts:**
      - services by kind, with the catalog's defaults and a reason;
      - workers and cron;
      - `storage.sqlite` with `deploy.strategy: recreate`;
      - `storage.objectStorage` with each available option priced for `expected` (from the interview's scale) and the cheapest chosen;
      - Kafka by default, Redpanda offered by server size;
      - Cassandra kept external.
    - **The interview:**
      - one generic question per hosted service (keep it, or let OpsCrew run one, with the price difference), replacing today's Supabase-only question;
      - a worker's command, asked only when no convention gives it.
    - **Licences:** each component that isn't permissive gets its licence named in one plain sentence at design.
    - **Sizing:** the sum of every limit, plus the edge and a system reserve, picks the server type. Design warns or refuses below a component's smallest server. On an own server it uses the inspected memory minus the other apps' limits.
    - **`keepPlanSettings`** keeps the user's component edits (counts, memory, versions, options, a component turned off) and says what changed.
    - **The app's variables** for every service and storage come from the catalog. The generated secrets (each service's, and `CRON_SECRET`) are stored like today's values.
    - **Tests** per kind, for prices, for sizing, and for the kept edits.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/mcp-server --filter=opscrew`
  - Effort: xhigh

## Phase 5: Several apps on one own server

- [ ] T1308a [US5] Several apps per host in the ssh-host connector, in `packages/connectors/ssh-host/src/**`
  - Owns: that folder (+ tests). If the host contract in `packages/contracts` must change, stop and report it.
  - Reads: contracts/components.md "The edge on a server"; data-model.md "Host record"; plan.md "8."; spec FR-1322–FR-1324
  - Depends: T1301
  - Accept:
    - **Records:** one per app at `/etc/opscrew/apps/<app>.json`, and the host record lists the apps. `/etc/opscrew/app.json` goes.
    - **The second-app refusal goes.** A hostname another app holds is refused before any change, naming that app.
    - **The host plan** marks each item as shared (the edge, hardening) or the app's own, and plans the shared parts only when they are missing.
    - **Removing an app** removes only its own parts. The edge goes with the last app; the hardening goes only with `--undo-host`, as today.
    - **Inspection** reports every app on the host.
    - **Fakes and tests:** two apps, a hostname conflict, the first and the last removal.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host`
  - Effort: xhigh

- [ ] T1308b [US5] The shared edge's templates in `packages/iac-templates/src/edge/**`, and the web service joining it, in `packages/iac-templates/src/runtime/**`
  - Owns: those folders (+ tests and snapshots)
  - Reads: contracts/components.md "The edge on a server"; the spike's kamal-proxy results; 011's tunnel templates
  - Depends: T1304, T1305
  - Accept:
    - **The edge Compose project** `opscrew-edge`: Caddy, kamal-proxy, and cloudflared when tunnelled, on the external network `opscrew-edge`.
    - **Caddy** imports `/srv/edge/sites/*.caddy`. A site file per app routes its hostnames to kamal-proxy, and redirects `www`.
    - **cloudflared:** one tunnel config with an ingress rule per app hostname.
    - **The app's web service** joins `opscrew-edge` with the alias `<app>-web`. The app's Compose file no longer holds Caddy or kamal-proxy.
    - **Cloud servers** render the same edge, with one app.
    - **Snapshots** for one app, two apps, and a tunnelled host.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [ ] T1308c [US5] Own-server flows for several apps in `packages/agents/src/{provision,destroy,drift}/**` (own-server parts)
  - Owns: the own-server files in those folders (`own*.ts`, `host*.ts`, + tests)
  - Reads: T1308a's connector API; T1308b's templates; spec FR-1322–FR-1324; 009's own-server flows
  - Depends: T1308a, T1308b, T1307
  - Accept:
    - provision installs or updates the edge, writes the app's site file and kamal-proxy service, and deploys only its app;
    - destroy removes the app, and the edge with the last one;
    - drift reads every app on the host and reports its own app's parts;
    - the memory check counts the other apps' limits;
    - tests with the fake connector: two apps, the first's destroy leaving the second, and a hostname conflict.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

## Phase 6: Day 2, Portainer and part 2

- [ ] T1309 [US2] [US3] [US6] Components on day 2 in `packages/agents/src/{provision,destroy,drift,status,secure,retarget}/**` (not the own-server files), `packages/secops/src/**`
  - Owns: those paths (+ tests), except the own-server files T1308c owns
  - Reads: spec FR-1312, FR-1318–FR-1319, FR-1328, FR-1331–FR-1332; plan.md "9."
  - Depends: T1307, T1308c
  - Accept:
    - **provision:**
      - asks once for the Hetzner or Spaces key pair, with the console steps, and keeps it like a provider token;
      - for MongoDB on an x86 server type without AVX (cloud types known; own server through inspection), stops before any change, saying why and what to do;
      - stores the components' generated secrets;
      - writes the steady services.
    - **destroy:** removes every component, and keeps data folders and buckets unless `--delete-data` is given with the typed confirmation, saying where they are.
    - **drift:** reports a component that differs from the plan.
    - **status:** lists each component and whether it runs.
    - **secure:** checks that no service port is public and that each service's auth is on (a secops check per kind).
    - **retarget:** refuses before any change when the app has a stateful service other than Postgres and Valkey. Buckets stay where they are.
    - **Tests** for each.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops`
  - Effort: xhigh

- [ ] T1310 [P] [US1] [US2] [US4] Components on a Portainer target in `packages/agents/src/**` (the Portainer files), `packages/iac-templates/src/portainer-target/**`
  - Owns: the Portainer files in agents (`portainer*.ts`, + tests) and `packages/iac-templates/src/portainer-target/**`
  - Reads: spec FR-1329; plan.md "10."; T1304's stack renderer
  - Depends: T1309
  - Accept:
    - stacks hold the components, with named volumes;
    - Garage is allowed;
    - a component that needs a host setting is refused before any change, with the setting to make by hand;
    - drift and destroy cover the components;
    - tests.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: high

- [ ] T1311 [P] [US7] Part 2 engines and the host setting, in `packages/iac-templates/src/catalog/**`, `packages/iac-templates/src/infra/**` (cloud-init), `packages/connectors/ssh-host/src/**` (the sysctl item), `packages/agents/src/design/**` (warnings)
  - Owns: those paths (+ tests)
  - Reads: research.md R5; spec FR-1330; contracts/components.md
  - Depends: T1309
  - Accept:
    - **Catalog entries, pinned by digest:**
      - OpenSearch, with the security plugin off on the internal network;
      - Elasticsearch, for Elasticsearch clients only, with security on and `ELASTIC_PASSWORD`;
      - Meilisearch, with `MEILI_ENV=production`, a master key and an indexing memory cap;
      - Typesense, with an API key;
      - ClickHouse, with the low-memory profile, a user and a password;
      - Neo4j Community, with `NEO4J_AUTH`, heap and pagecache.
      Each has its licence, memory, smallest server and healthcheck.
    - **`vm.max_map_count`:** in cloud-init on Hetzner and DigitalOcean, and as a host-plan item on an own server. Portainer refuses it (T1310's path).
    - **Design** warns below each engine's smallest server, and keeps Cassandra external with a hosted option named.
    - **Snapshots and tests.**
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents`
  - Effort: high

## Phase 7: Surfaces, examples and live tests

- [ ] T1312 [P] Surfaces and the guide in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`, `README.md`
  - Owns: those paths (+ tests)
  - Reads: spec FR-1333; plan.md "12."
  - Depends: T1311
  - Accept:
    - **Output:** `status` lists components. Design's output shows components, licences and prices.
    - **MCP tools** show the same.
    - **Plugin skills:** the deploy and adapt skills cover workers, cron and the storage key prompt.
    - **Guide pages**, each written for users:
      - `components.md`;
      - `workers-and-cron.md`;
      - `databases.md`;
      - `object-storage.md` (options, prices with the formulas, the key steps);
      - `brokers.md`;
      - `search-and-analytics.md`;
      - an update to the own-server page for several apps.
    - **The README** links to them.
    - `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`, `node plugin/validate.mjs`
  - Effort: high

- [ ] T1313 [P] Examples and the Docker pass in `examples/**`, `packages/cli/test/e2e/**`
  - Owns: those paths
  - Reads: plan.md "13."; quickstart.md "Local Docker pass"; spec FR-1334
  - Depends: T1311
  - Accept:
    - **New examples**, each small, with an `expected.json` naming its components:
      - part 1: `celery-worker`, `node-bullmq`, `express-mysql`, `node-mongo`, `flask-sqlite`, `s3-uploads`, `rabbitmq-worker`, `nats-app`, `kafka-app`;
      - part 2: `meili-search`, `clickhouse-events`.
    - **The Docker pass** starts each with its services and checks:
      - health;
      - a write that survives a restart;
      - a worker consuming;
      - a cron run within a minute;
      - every container's memory limit;
      - no published service port.
    - **Hygiene:** remove only what the pass created.
    - **Run the pass** for every new example, and report the results.
  - Verify: `OPSCREW_DOCKER_TESTS=1 OPSCREW_DOCKER_EXAMPLES=<the new examples> …` plus `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: xhigh

- [ ] T1314 Live tests in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: quickstart.md "Live"; 012's builder checks
  - Depends: T1312, T1313
  - Accept:
    - **Hetzner components:** each check from quickstart's "Live" step 1.
    - **Own server with two apps:** step 2, under load.
    - **Portainer:** components, and the host-settings refusal.
    - **Part 2:** Meilisearch and ClickHouse.
    - **Leftovers:** buckets and their tokens and keys included, with the cleanup removing them.
    - **The coverage page** gets the new rows.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: high

- [ ] T1315 Live runs (lead): the passes in `docs/e2e.md`; results in `docs/e2e.md` and `docs/e2e-coverage.md`

## Dependencies

T1301 → {T1302, T1303, T1306, T1308a} → {T1304, T1305} (after T1302) → T1307 → T1308b → T1308c →
T1309 → {T1310, T1311} → {T1312, T1313} → T1314 → T1315.

T1302 runs alongside T1303, T1306 and T1308a. T1304 and T1305 need T1302's start forms and limits.

## Parallel waves

1. T1301 alone.
2. T1302 (spike), T1303, T1306, T1308a.
3. T1304, T1305.
4. T1307.
5. T1308b, then T1308c.
6. T1309.
7. T1310, T1311.
8. T1312, T1313.
9. T1314, then T1315.

## Implementation strategy

- **MVP:** workers and cron (US1) with the databases (US2) on Hetzner: T1301–T1305, T1307 and the
  parts of T1309 and T1313 they need.
- **Then:** object storage (US3) and brokers (US4).
- **Then:** several apps on one own server (US5).
- **Then:** sizing everywhere (US6), and part 2 (US7).

Each phase is merged, gated and pushed before the next starts.
