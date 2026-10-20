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
- Every container a task renders has a memory limit (FR-1325), and no service has a published port
  (FR-1328).
- No storage key is ever written to a committed file, a plan or infrastructure state.
- Build only what Accept asks. Report anything else as a finding.

## Phase 1: Foundation

- [X] T1301a Components in the plan and the facts, and the catalog's types, in `packages/plan-schema/**`, `packages/iac-templates/src/catalog/types.ts`, and every reader and writer of today's `services` booleans
  - Owns:
    - `packages/plan-schema/**` (+ tests, fixtures, the generated JSON schemas);
    - `packages/iac-templates/src/catalog/types.ts`, and `packages/iac-templates/src/index.ts` for its export;
    - in `packages/agents`, `packages/iac-templates`, `packages/cli`, `packages/mcp-server` and `packages/secops`, only the code, fixtures and tests that read or write `services.postgres` or `services.redis` (or build plans with them).
  - Reads: data-model.md; contracts/components.md "ServiceSpec"; plan.md "1."; `.tools/scratch/013-code-map.md`
  - Depends: —
  - Accept:
    - **`plan.yaml`** gains `app.memoryMb`, `processes.workers[]`, `processes.cron[]`, `services[]` (with `name`) and `storage`, exactly as data-model.md, with zod validation:
      - worker and service names are unique within the app, `[a-z][a-z0-9-]*`, and never `app`, `release`, `cron`, `proxy` or `caddy`;
      - a service's `name` defaults to `db` (postgres), `cache` (valkey cache), `queue` (valkey queue), else its kind;
      - `single: true` forces `count: 1`; `count` is 1–10; `stopGraceSeconds` is 5–600;
      - a cron entry has exactly one of `command` and `route`;
      - `storage.objectStorage.provider` is one of `r2`, `digitalocean`, `hetzner` and `garage`, and `expected` has `storageGb` and `egressGbPerMonth`;
      - `deploy.strategy` is `recreate` when `storage.sqlite` is set.
    - **Today's `services: { postgres, redis }` booleans go.** A helper `serviceOf(plan, kind)` replaces every read. Postgres and Valkey (`mode: cache`) become entries of `services[]` under the names `db` and `cache`. `externalServices` stays. Every package keeps its behaviour and passes its tests.
    - **`ProjectFacts`** gains `workers[]`, `cronJobs[]`, `hostedServices[]`, `sqlite` and `objectStorage`, and the service kinds of data-model.md. Detection fills them in T1303.
    - **The catalog's types:** `ServiceSpec` (with `auth`) and `ServiceContext`, as in the contract, exported from the iac-templates root.
  - Verify: `pnpm turbo run typecheck test`
  - Effort: xhigh

- [X] T1301b [P] Pins and storage prices in `packages/iac-templates/src/{pins.ts,prices.ts}`, `packages/iac-templates/scripts/**`
  - Owns: those paths (+ tests); `packages/iac-templates/src/index.ts` for the `prices` export only
  - Reads: research.md R1–R4, R8; plan.md "6."
  - Depends: —
  - Accept:
    - **`IMAGES` adds by digest:** MySQL 8.4, MariaDB (current LTS line), MongoDB 8.0, RabbitMQ 4.3, NATS 2.15 alpine, `apache/kafka` 4.x, Redpanda 26.x, Garage. Run `pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs` to fill the digests (read-only registry and GitHub calls); never invent one.
    - **supercronic v0.2.50** is a tool with a per-architecture SHA-256, computed from the release assets. `scripts/update-pins.mjs` refreshes it and checks upstream's SHA-1 before writing the SHA-256.
    - **`prices.ts`:**
      - R2: storage per GB-month and operations per million after the free tier, with no egress charge;
      - Spaces: USD 5 with 250 GiB stored and 1,024 GiB out, then USD 0.02 per GiB stored and USD 0.01 per GiB out;
      - Hetzner: EUR 6.49 per account with 744 TB-hours stored and 1.116 TB out in a 31-day month, then EUR 6.26 per TB-month and EUR 1.00 per TB (research R3, with its source and date);
      - Garage: free;
      - one function per provider, `monthlyPrice({ storageGb, egressGbPerMonth })`, with a note when the base is per account.
    - **Unit tests** for each formula, the edges of every quota included.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

## Phase 2: Spike (lead, in parallel with T1303, T1306 and T1308a)

- [X] T1302 Local spike on Docker (lead). It settles research.md's open items 1–4, 8, 10, 13 and 14. The results go into research.md as "Spike results", with one line per item: what was run, and what was seen.
  - Railpack: `docker inspect` of a real image; a worker started with `command: ["<cmd>"]`; SIGTERM reaching the process through `bash -c`.
  - Buildpacks: `entrypoint: ["/cnb/process/worker"]` from a Procfile; the launcher form for a raw command; the seal with supercronic keeping the launcher.
  - kamal-proxy v0.10.2: two services on two hosts behind one proxy; one service with two hosts.
  - `mem_limit`, `deploy.resources.limits.memory` and `deploy.replicas`, read back with `docker inspect`, under Docker Compose v2 (without Swarm) and in a Portainer CE stack.
  - supercronic: `ADD --checksum` on amd64 and arm64; a skipped overlapping run; `CRON_TZ` per job; a GET with an `Authorization` header through each probe tool.
  - Garage: the single-node init (layout, an imported key, a bucket) as a one-shot container; its idle memory; `hashicorp/aws` with a custom endpoint creating a bucket and its CORS against it.
  - MongoDB 8.0: a single-node replica set with Prisma, and its memory with the cache capped.
  - Each new image's user, shell and tools (`wget`, `curl`), and a healthcheck that works.

## Phase 3: Packages (parallel)

- [X] T1303 [P] [US1] [US2] [US3] [US4] [US7] Detection of the new components in `packages/detect/**`
  - Owns: `packages/detect/src/**`, `packages/detect/test/**` (+ fixtures)
  - Reads: research.md R1–R5 detection lists; data-model.md "ProjectFacts"; spec FR-1302, FR-1305, FR-1308, FR-1315
  - Depends: T1301a
  - Accept:
    - **Service kinds**, from runtime dependencies only (never dev dependencies), per ecosystem from research's lists:
      - MySQL;
      - MariaDB, when the app declares it (a MariaDB client, `DB_CONNECTION=mariadb`, or a `mariadb://` URL);
      - MongoDB, AMQP, NATS, Kafka and S3;
      - the part 2 engines: OpenSearch and Elasticsearch told apart by their clients, Meilisearch, Typesense, ClickHouse and Neo4j;
      - Cassandra, as external.
    - **Workers:**
      - every Procfile type except `web` and `release`, with its command;
      - job libraries with their conventional commands from research R1's table: Celery worker and beat, RQ, Dramatiq, Huey, Sidekiq, GoodJob, Solid Queue (`bin/jobs`), Resque, BullMQ (no command), Laravel's `queue:work` and `schedule:work`, asynq, river;
      - schedulers are marked `single`;
      - an in-process scheduler is a note, not a worker.
    - **Cron:** `vercel.json` `crons`, each with its path and schedule.
    - **Hosted services:** `mongodb+srv://`, PlanetScale, Upstash, Neon and the like, from env examples and config, each with its variable and the provider's name.
    - **Celery's broker** follows its broker URL's scheme: AMQP gives a broker, Redis gives a queue-mode Valkey.
    - **SQLite:** the database paths and their folder, for Rails 8 (four files), Django, Laravel, Prisma and Drizzle.
    - **Object storage:** the S3 client, presigned-upload use, and the variable names the app reads.
    - **Fixture tests** for each service kind and each worker library, plus one for a dev-only dependency that is ignored.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect`
  - Effort: high

- [X] T1304 [US1] [US2] [US4] [US6] The catalog's part 1 entries, and services, workers and cron in Compose and Portainer stacks, in `packages/iac-templates/src/{catalog,runtime,portainer-target,dependabot}/**`
  - Owns: those folders (+ tests and snapshots); `packages/iac-templates/src/index.ts` for their exports
  - Reads: contracts/components.md; research.md R1–R4, R7 and "Spike results"; spec FR-1305–FR-1314, FR-1320–FR-1321, FR-1325, FR-1328
  - Depends: T1301a, T1301b, T1302
  - Accept:
    - **Catalog entries, each with its licence, memory, healthcheck, `auth`, secrets and app variables:**
      - Postgres, moved from `dbService`;
      - Valkey in cache mode (LRU, no persistence) and in queue mode (`noeviction`, AOF);
      - MySQL 8.4 with a mounted small-server `my.cnf`;
      - MariaDB;
      - MongoDB 8.0 with `--wiredTigerCacheSizeGB` from its limit, and the replica set's one-shot init when `options.replicaSet`;
      - RabbitMQ with a mounted `rabbitmq.conf` (absolute watermark, `guest` removed) and `hostname`;
      - NATS (alpine, token config, JetStream volume);
      - Kafka KRaft single node (heap and retention from the plan, `internal-only`);
      - Redpanda (`internal-only`);
      - Garage, with the init importing an OpsCrew-generated key and creating the bucket.
    - **One renderer** writes every service for Compose, and one for Portainer stacks:
      - each service has `mem_limit`, `restart: unless-stopped`, the app's internal network and no `ports`;
      - volumes go under `/srv/data/<app>/<name>` on servers, and are named volumes in Portainer;
      - config files go to `opscrew/runtime/services/<name>/`.
    - **Workers:** one service each, with the start form per builder from the contract (each command starts with `exec`), `stop_grace_period`, `mem_limit` and `memswap_limit`, no ports, and `deploy.replicas` for the count.
    - **From the spike** (research "Spike results"): MongoDB writes its keyFile into the configdb volume at start and initiates the replica set with the service name as host; NATS always gets OpsCrew's own config; Garage's init steps run from the deploy script (T1305) through `docker compose exec`, each checked first, since its image has no shell; healthchecks as in the image table.
    - **Cron:** one `cron` service and the generated `opscrew/runtime/crontab`:
      - route jobs send a GET with `Authorization: Bearer ${CRON_SECRET}` through the probe tool;
      - with probe `none` or `wget`, the renderer refuses route jobs with a plain message.
    - **The web service** gets `mem_limit` from `app.memoryMb`.
    - **Dependabot:** its no-major list is read from the catalog's `majorLocked`.
    - **Snapshots:**
      - an app with a worker, cron, MySQL and RabbitMQ;
      - each builder's start form;
      - a Portainer stack;
      - unchanged Postgres and Valkey output, apart from the limits and paths.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T1305 [P] [US1] supercronic in the image, and the deploy order with the worker check, in `packages/iac-templates/src/{docker,workflow}/**`
  - Owns: those folders (+ tests and snapshots)
  - Reads: contracts/components.md "The deploy" and "Process start forms"; plan.md "5."; research.md R1 and "Spike results"; 012's `workflow/switch.ts`
  - Depends: T1301a, T1301b, T1302
  - Accept:
    - **supercronic** is added only when the plan has cron jobs, with `ADD --checksum=sha256:<pin> <url> /usr/local/bin/supercronic` for the build runner's architecture:
      - in the generated Dockerfile's runtime stage;
      - in the seal step for Buildpacks and Railpack;
      - in a seal step added for an own Dockerfile.
    - **The deploy script's order**, in today's app folder (T1308b moves the paths):
      1. the steady services from `services[]`, with `up -d --no-deps --wait`;
      2. the release command;
      3. the web switch (`rolling`, or `recreate` for SQLite apps);
      4. workers and cron with `up -d --no-deps` and the new image;
      5. a 30-second check that every worker keeps running.
      On a failure in steps 3–5, the web and the workers go back to the previous image, and the error names the worker and `docker compose logs <worker>`.
    - **Restarts:** a service whose configuration did not change is never restarted.
    - **Tests:**
      - bash tests with a fake `docker` for the order;
      - a failing worker and its rollback;
      - no restart of the steady services;
      - snapshots of the seal with supercronic for each builder.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T1305b [US1] Fixes from T1305's review, and the runtime files' wiring, in `packages/iac-templates/src/{workflow,docker}/**`, `packages/iac-templates/src/render.ts` (after T1304 merges)
  - Depends: T1304
  - Accept:
    - **Before the workers and cron are replaced,** the start script records which worker and cron services already have containers (`.processes.previous`). The rollback runs `up -d --no-deps` only for those, and `docker compose stop`s the rest. So a deploy that adds the first cron job or a new worker and then fails still ends `restored`, and leaves no container crash-looping on the old image.
    - **First-deploy wording:** the worker-failure message says "…back on the previous version, if there is one".
    - **Tests:**
      - a deploy that adds cron to an app without it, then fails after the switch, and the outcome is `restored`;
      - a worker with two containers (replicas);
      - a worker failure on a first deploy.
    - **Caching:** supercronic's `ADD` moves right after the runtime stage's `FROM`/`WORKDIR` (still before `USER`), so its layer stays cached across code changes.
    - **Wiring (from T1304):**
      - `renderDeployment` (`render.ts`) includes `renderRuntimeFiles(plan)` (the services' config files and the crontab);
      - the deploy workflow uploads `opscrew/runtime/services/`, the crontab, and each service's `<name>.env` (made by T1309 from the GitHub secret, as `db.env` is today) to the server.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T1306 [P] [US3] The `storage` root, in `packages/iac-templates/src/infra/**`, `packages/iac-templates/modules/**`, `packages/iac-templates/src/generated/**`
  - Owns: those paths (+ tests and snapshots); `packages/iac-templates/src/index.ts` for new exports
  - Reads: plan.md "6."; research.md R3; spec FR-1316–FR-1319; constitution III and IV
  - Depends: T1301a
  - Accept:
    - **A separate root**, `opscrew/infra/storage`, rendered only when `storage.objectStorage` is a provider bucket:
      - R2: `cloudflare_r2_bucket` and its CORS through the Cloudflare provider;
      - Spaces and Hetzner: `hashicorp/aws` pointed at the provider's S3 endpoint, with path-style addressing and its account and region checks off, and the bucket and its CORS.
    - **Keys:** the storage key comes only from the provider's own environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), never a Terraform variable (a sensitive `TF_VAR_` value is kept in the saved plan file). No key appears in a rendered file, a plan, an output or the state.
    - **CORS** allows only the app's own origins, and only when `cors` is set.
    - **The bucket** is never destroyed by a plan unless the plan allows deleting data. Use the roots' existing destroy guard, or a separate apply path that destroy skips.
    - **Engines:** the root validates with OpenTofu and Terraform (`OPSCREW_IT=1`), and its providers are pinned like the others.
    - **Snapshots** for each provider. The test variables use `fakeSecret`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, plus `OPSCREW_IT=1` for the storage root
  - Effort: high

## Phase 4: Design

- [X] T1307 [US1] [US2] [US3] [US4] [US6] Components in design and the interview, in `packages/agents/src/{design,interview,shared}/**`
  - Owns: those folders (+ tests), except the Portainer files (`design/portainer*.ts`)
  - Reads: spec FR-1301–FR-1304, FR-1315–FR-1316, FR-1325, FR-1327; plan.md "7."; research.md R7, R8; data-model.md (expected use, sizing figures)
  - Depends: T1303, T1304, T1306
  - Accept:
    - **Components from facts:**
      - services by kind, with the catalog's defaults and a reason;
      - workers and cron;
      - `storage.sqlite` with `deploy.strategy: recreate`;
      - `storage.objectStorage`, with each available option priced through `prices.ts` for `expected` (from data-model's table) and the cheapest chosen;
      - Kafka by default, with Redpanda offered;
      - Cassandra kept external.
    - **The interview:**
      - one generic question per hosted service (keep it, or let OpsCrew run one), with what running it on the server would add, replacing today's Supabase-only question;
      - a worker's command, asked only when no convention gives it.
    - **Licences:** each component that isn't permissive is named in one plain sentence. Design's summary shows each component's memory and its share of the server's price (SC-1308).
    - **Sizing on cloud targets:** the sum of the limits, plus the edge (128 MB) and the system reserve (384 MB), picks the server type. Design warns below 15% headroom, and refuses below a component's smallest server. The own-server check is T1308c's.
    - **`keepPlanSettings`** keeps the user's component edits (counts, memory, versions, options, a component turned off) and says what changed.
    - **The app's variables** for every service and storage come from the catalog. Generated secrets (each service's, and `CRON_SECRET`) are stored like today's.
    - **From T1304 and T1305:**
      - `CRON_SECRET` goes in the app's env when the plan has route jobs;
      - two databases both claiming `DATABASE_URL`: the one the app's detected variable names wins, and the other gets its own variable (`MYSQL_URL`, `MONGODB_URI`), said at design;
      - `adapt/build-files.ts` passes `supercronic: supercronicArch(plan)` to `renderDockerAssets` when the plan has cron jobs; your Owns include that call;
      - **SQLite in a folder with code:** where the framework reads the path from the environment, design moves the database into a folder of its own and sets the variable, saying so in one sentence:
        - Laravel: `storage/database`, with `DB_DATABASE`;
        - Prisma inside `prisma/`: `data/`, with a `file:` `DATABASE_URL`.
        Where the path comes from code or settings (Django's `NAME` with the folder at the app root, a path in code), design refuses with the change to make. Rails 8's `storage/` stays as is.
        The absolute path uses `appRoot(plan)` in `packages/iac-templates/src/app-root.ts` (also owned, with one export line in `index.ts`): Buildpacks `/workspace`; Railpack and the generated Dockerfile `/app`; undefined for the user's own Dockerfile, where design asks for the path. `examples/laravel-app` passes the e2e design test unchanged.
    - **Tests:**
      - one per kind;
      - prices;
      - sizing;
      - kept edits;
      - a design rerun with nothing changed changing no file (SC-1307).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/mcp-server --filter=opscrew`
  - Effort: xhigh

## Phase 5: Several apps on one server

- [X] T1308a [P] [US5] Several apps per host in the ssh-host connector, in `packages/connectors/ssh-host/**`
  - Owns: `packages/connectors/ssh-host/src/**` (+ tests). If the host contract in `packages/contracts` must change, stop and report it.
  - Reads: contracts/components.md "The edge on a server"; data-model.md "Host record"; plan.md "8."; spec FR-1322–FR-1324
  - Depends: T1301a
  - Accept:
    - **Records:**
      - one per app at `/etc/opscrew/apps/<app>.json`, with its hostnames, folders, Compose project, services and the sum of its memory limits;
      - the host record lists the apps;
      - `/etc/opscrew/app.json` goes.
    - **Refused before any change, naming the other app:** a hostname another app holds, an app name another app uses, and the reserved name `opscrew-edge`. The second-app refusal goes.
    - **The host plan** marks each item as shared (Docker, the `deploy` user, the folders `/srv/edge`, `/srv/apps` and `/srv/data`, the firewall, the hardening) or the app's own, and plans the shared parts only when they are missing.
    - **Removing an app** removes only its own parts. The edge goes with the last app; the hardening only with `--undo-host`.
    - **Inspection** reports every app on the host with its limits, and the CPU flags (for the AVX check).
    - **Tests with fakes:** two apps, each conflict, the first and the last removal.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host`
  - Effort: xhigh

- [X] T1308b [US5] The shared edge and the per-app layout on every server, in `packages/iac-templates/src/{edge,runtime,workflow}/**`, `packages/iac-templates/modules/**`, `packages/iac-templates/src/generated/**`
  - Owns: those paths (+ tests and snapshots)
  - Reads: contracts/components.md "The edge on a server"; "Spike results" (kamal-proxy); 011's tunnel templates
  - Depends: T1304, T1305, T1306
  - Accept:
    - **The edge Compose project** `opscrew-edge` holds Caddy and kamal-proxy on the external network `opscrew-edge`, with the version stamp.
    - **Caddy** imports `/srv/edge/sites/*.caddy`. A site file per app routes its hostnames to kamal-proxy, and redirects `www`.
    - **Each app's project** sits at `/srv/apps/<app>`, with data at `/srv/data/<app>`:
      - its web service joins `opscrew-edge`;
      - its cloudflared (when tunnelled) joins `opscrew-edge` and sends its hostnames to `http://caddy:80`;
      - its Compose file holds no Caddy or kamal-proxy.
    - **The deploy:**
      - uploads `opscrew/runtime/edge/` and the app's site file;
      - replaces the edge's Compose file only when the uploaded stamp is newer;
      - runs `docker compose -p opscrew-edge up -d` and reloads Caddy;
      - registers kamal-proxy service `<app>` with `--host`, targeting the new web container's Compose name;
      - works in `/srv/apps/<app>`.
    - **Cloud servers:** cloud-init in `modules/**` creates the folders, and the same edge comes up with the first deploy.
    - **Snapshots:**
      - one app, two apps, and a tunnelled app;
      - a bash test of the stamp rule: an older upload keeps the server's edge.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T1308c [US5] Several apps on an own server in the flows, and every `/srv/app` path, in `packages/agents/src/**` (own-server files and path users), `packages/secops/src/**` (path users)
  - Owns:
    - the own-server files in `packages/agents/src/{provision,destroy,drift}` (`own*.ts`, `host*.ts`, + tests);
    - every file in `packages/agents/src` and `packages/secops/src` that names `/srv/app`, for those lines only.
  - Reads: T1308a's connector API; T1308b's templates; spec FR-1322–FR-1325; 009's own-server flows
  - Depends: T1308a, T1308b, T1307
  - Start: cherry-pick T1308b's commit (`2843637`, not yet on main because it breaks 6 agents tests that this task fixes) onto your branch first; both merge together.
  - Also owns (from T1308b's report): `packages/connectors/ssh-host/src/**` for the tunnel connector per app and the temporary `/srv/app` compat; `packages/iac-templates/src/{edge,workflow,dependabot,tunnel}/**` for the small items below.
  - Accept (from T1308b):
    - **One host-network tunnel connector per app** (`<app>-tunnel`, its own token and metrics port), set up and removed by the host plan; the `tunnel-connector-in-use` refusal goes; the routes (`127.0.0.1:18080`, SSH, Portainer) stay as today;
    - **the temporary compat goes:** `LEGACY_APP_DIR` leaves `SHARED_DIRS` and the `runtime-dirs` undo; the `// T1308c:` second-app refusal in agents goes; drift's runtime-file check is back on, with the site file in place of the Caddyfile;
    - the 6 agents tests that read `opscrew/runtime/Caddyfile` read the site file;
    - every `/srv/app` path in agents and secops becomes `/srv/apps/<app>` (retarget's `server-ops`, `abort`, `switch`, `window`; `secure/probes.ts`; `testing/move.ts`; `verify/checks.ts`'s hint); retarget's `docker compose stop/up caddy` and its `wget` probe through `caddy` address the edge;
    - the edge's Caddy and kamal-proxy get memory limits (64 MB and 32 MB, the 128 MB edge figure in data-model includes cloudflared's 32 MB per tunnelled app);
    - Dependabot's `docker-compose` entry leaves out `/opscrew/runtime/edge`;
    - each app's deploy uses its own `DOCKER_CONFIG` (under `/srv/apps/<app>`), so one app's registry logout never breaks another's pull;
    - a second app on a server without a domain is refused before any change (only one app can take `:80`).
  - Accept:
    - **provision** writes the app's host items through the host plan and deploys only its app.
    - **destroy** removes the app, and the edge with the last one.
    - **drift** reads every app on the host and reports its own app's parts.
    - **Memory check:** the inspected memory minus the other apps' recorded limits must hold this app's limits. Design (T1307's figures) warns or refuses with how much is in use.
    - **AVX:** the CPU flags from inspection feed MongoDB's check (T1309 uses it).
    - **Paths:** every `/srv/app` path becomes `/srv/apps/<app>`.
    - **Tests with the fake connector:** two apps, the first's destroy leaving the second, a hostname conflict, and the memory check.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops`
  - Effort: xhigh

- [X] T1304b [P] [US2] The SQLite volume, in `packages/iac-templates/src/{runtime,portainer-target,docker,workflow}/**`
  - Owns: those paths (+ tests and snapshots)
  - Why: T1307 found that no merged task renders `storage.sqlite` (FR-1313).
  - Reads: spec FR-1313; data-model.md `storage.sqlite`; T1307's `appRoot(plan)`; 012's seal steps
  - Depends: T1307, T1308c
  - Accept:
    - **The volume:** a named volume `sqlite` in the app's Compose project (on servers and in Portainer stacks, like Kafka's and Redpanda's), mounted at `appRoot(plan)/<storage.sqlite.dir>` in the web, release, worker and cron containers.
    - **Writable by the app's non-root user,** on a fresh server and after a redeploy. Docker gives a new named volume the image folder's owner, so the folder must exist in the image, owned by that user:
      - the generated Dockerfile creates it;
      - the Railpack and Buildpacks seals do the same;
      - an own Dockerfile gets a seal step for it only when the plan has `storage.sqlite`;
      - one local `docker run` per builder confirms a write into a fresh volume.
    - **Destroy** keeps the volume unless data is deleted, as for Kafka's (T1309 removes named volumes on `--delete-data`; check it lists this one).
    - **Snapshots and tests.**
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

## Phase 6: Day 2, part 2 and Portainer

- [X] T1309 [US2] [US3] [US6] Components on day 2 in `packages/agents/src/{provision,destroy,drift,secure,retarget}/**`, `packages/secops/src/**`
  - Owns: those paths (+ tests), except the own-server files (T1308c) and the Portainer files (T1310's list)
  - Reads: spec FR-1312, FR-1318–FR-1319, FR-1328, FR-1331–FR-1332; plan.md "6." and "9."
  - Depends: T1308c
  - Accept:
    - **provision:**
      - asks for the storage key once, with the console steps for its provider: before the bucket for Hetzner and Spaces, and after it for R2, scoped to that bucket;
      - in a non-interactive run, reads the key from environment variables, and stops with the steps when they are missing;
      - keeps the key like a provider token, passes it to the engine as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (clearing `AWS_SESSION_TOKEN`, `AWS_PROFILE` and the other `AWS_*` login variables, so the user's own AWS login is never used), and gives it to the app as its secrets;
      - renders the `storage` root with `renderStorage` (T1306) and applies it through its own approved plan; R2 is offered only when the plan uses Cloudflare (it needs OpsCrew's Cloudflare token and account);
      - applies the `storage` root through its own approved plan;
      - for MongoDB on x86, stops before any change when the CPU lacks AVX, saying why and what to do (the own-server flags from T1308c; on cloud targets, a check only when the server type's CPU is known);
      - stores the components' generated secrets, and writes each service's `<name>.env` from the catalog's `environment(ctx)` with the real values into the deploy secrets, as `db.env` is today;
      - removes named volumes (Kafka, Redpanda) and data folders alike on `--delete-data`;
      - fills one GitHub secret per service with secrets, `serviceEnvSecret(name)` (`OPSCREW_SERVICE_<NAME>_ENV`, T1305b), and destroy deletes those too (`Object.values(DEPLOY_SECRETS)` does not list them);
      - rerun with nothing changed, changes no file (SC-1307);
      - adds every service's generated secrets (`values.services`, T1307) and the storage key to the redactor, as the app's values and Postgres's password are today;
      - when the provider says the bucket name is taken (Spaces and Hetzner names are shared by all their customers), stops with a plain message naming `storage.objectStorage.bucket` in plan.yaml as the field to change.
    - **Text left over from T1308c:**
      - `provision/dependabot.ts` joins its list of missing folders with `listText`;
      - dns's warning (`dns/run.ts`, that line and its tests only) names the app's Caddy site file, not "the new Caddyfile".
    - **destroy:** removes every component, and keeps data folders and the `storage` root unless `--delete-data` is given with the typed confirmation, saying where they are. With `--delete-data`, the storage root is rendered without `prevent_destroy` (with `force_destroy` on the aws provider's bucket) and destroyed through its own approved plan. Cloudflare deletes an R2 bucket only when it is empty: OpsCrew then says how to empty it in the dashboard, and never deletes files itself.
    - **drift:** reports a component that differs from the plan.
    - **secure:** checks that no service port is public, and that each service with `auth` other than `internal-only` has its login set (a secops check per kind).
    - **retarget:** refuses before any change when the app has a stateful service other than Postgres and Valkey. The `storage` root stays.
    - **Tests** for each.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops`
  - Effort: xhigh

- [X] T1311 [US7] Part 2 engines and the host setting, in `packages/iac-templates/src/{catalog,runtime}/**`, `packages/connectors/ssh-host/src/**`, `packages/agents/src/design/**` (not the Portainer files)
  - Owns: those paths (+ tests and snapshots)
  - Reads: research.md R5; spec FR-1330; contracts/components.md
  - Depends: T1309
  - Accept:
    - **Catalog entries, pinned by digest, each with its licence, memory, smallest server, healthcheck and `auth`:**
      - OpenSearch: security plugin off, `internal-only`;
      - Elasticsearch: for Elasticsearch clients only, security on, `ELASTIC_PASSWORD`;
      - Meilisearch: `MEILI_ENV=production`, a master key, an indexing memory cap;
      - Typesense: an API key;
      - ClickHouse: the low-memory profile, a user and a password;
      - Neo4j Community: `NEO4J_AUTH`, heap and pagecache.
    - **`vm.max_map_count`:**
      - cloud servers: a one-shot privileged init container in the app's Compose file, which the engine depends on;
      - an own server: a host-plan item in `/etc/sysctl.d`.
    - **Design** warns below each engine's smallest server, and keeps Cassandra external with a hosted option named.
    - **From T1304b:** design refuses a SQLite plan whose app folder is unknown (the user's own Dockerfile has no literal `WORKDIR`), with the same hint as the move case in `design/plan.ts`, instead of provision stopping later.
    - **Also from T1304b's review:** when a plan with `storage.sqlite` changes `app.build.builder` (or an own Dockerfile changes its `USER`), design warns that the existing `sqlite` volume keeps the old owner (Docker sets it only when the volume is created), and gives the fix: on a server, `docker run --rm -v <app>_sqlite:/d <pinned small image> chown -R <uid>:<gid> /d`; on Portainer, the same through a one-off container.
    - **From T1309:** the ssh-host inspection checks every service's `<name>.env` (mode and owner, as it does `db.env` today), so drift sees them.
    - **Snapshots and tests.**
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents`
  - Effort: high

- [X] T1310 [US1] [US2] [US4] [US7] Components on a Portainer target
  - Owns:
    - `packages/agents/src/portainer/**`;
    - `packages/agents/src/provision/{portainer*,stack-plan}.ts`;
    - `packages/agents/src/{destroy,drift}/portainer*.ts`;
    - `packages/agents/src/design/portainer*.ts`;
    - `packages/iac-templates/src/portainer-target/**`;
    - plus tests.
  - Reads: spec FR-1329; plan.md "10."; T1304's stack renderer; T1311's host-setting entries
  - Depends: T1311
  - Accept:
    - stacks hold the components, with named volumes;
    - Portainer runs no deploy steps, so MongoDB's replica-set initiation and Garage's layout, key and bucket happen through one-shot services in the stack (or Portainer refuses them with a plain message, whichever is smaller);
    - Garage is allowed;
    - a component with `hostSettings` is refused before any change, with the setting to make by hand;
    - design treats route cron jobs the image can't call as it does on servers (T1307): it plans them turned off, with the line saying why, using the stack renderer's own check;
    - **From T1309:** `buildAppEnvironment` gets `requireStorageKey` and `storageLogin` for R2 as on servers; secure checks each service's login through the stack's variables (names only); `AppEnvironment.dbEnv`, now read only by `drift/portainer.ts`, goes if the stack variables cover it.
    - **From T1311:** stacks render a service's `ulimits` (OpenSearch and Elasticsearch `nofile`), and refuse the engines with `hostSettings` as Accept says.
    - drift and destroy cover the components;
    - tests for each, including the refusal for OpenSearch.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: high

## Phase 7: Surfaces, examples and live tests

- [X] T1312 [P] Surfaces, `status`, the runbook and the guide, in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`, `README.md`, `packages/iac-templates/src/runbook/**`
  - Owns: those paths (+ tests)
  - Reads: spec FR-1331, FR-1333; plan.md "12."
  - Depends: T1310
  - Accept:
    - **`status`** lists each component and whether it runs, over SSH on servers and through Portainer's API.
    - **Drift on Hetzner and DigitalOcean** (deferred from T1309, which had no SSH read on cloud servers) reuses status's SSH read to report a component that differs from the plan, as drift already does on an own server (`drift/host.ts`). Owns `packages/agents/src/drift/**` for this.
    - **From T1311:** `RUNTIME_FILE_NAMES` stops always listing `db.env` once drift reads the services' env files from the catalog; the guide says that a changed `USER` in an own Dockerfile isn't detected (fix the SQLite volume's owner by hand, with the command), that the app gets Meilisearch's master key, and that ClickHouse's long-term releases are YY.3 and YY.8 (Dependabot also offers the others).
    - **From T1310:** the CLI's "the stack plan follows" note also appears in an R2-only `--plan-only` run on Portainer.
    - **Design's output and the MCP tools** show components, licences, and each component's memory and price share.
    - **The plugin's deploy and adapt skills** cover workers, cron and the storage key.
    - **The runbook** describes the components, the edge and the storage key, with the per-app data paths (`/srv/data/<app>/<name>`). `runbook/shared.ts` still names `/srv/app` and the Caddyfile: it becomes `/srv/apps/<app>`, the edge at `/srv/edge`, and the app's site file.
    - **The other `/srv/app` leftovers from T1308c:** `plugin/skills/opscrew-deploy/SKILL.md`'s host-plan line and `docs/guide/own-server.md` describe several apps, the edge and the per-app folders.
    - **Guide pages**, written for users:
      - `components.md`;
      - `workers-and-cron.md`;
      - `databases.md` (with SQLite: the volume, where the database lives in the image, that a folder an own Dockerfile copies as root stays root-owned, and that changing the builder later needs the volume's owner changed, with the command);
      - `object-storage.md` (options, the price formulas, each provider's key steps);
      - `brokers.md`;
      - `search-and-analytics.md`;
      - the own-server page updated for several apps;
      - the README links to them.
    - `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server --filter=@opscrew/iac-templates`, then `node plugin/validate.mjs`
  - Effort: high

- [ ] T1313 [P] Examples and the Docker pass in `examples/**`, `packages/cli/test/e2e/**`
  - Owns: those paths
  - Reads: plan.md "13."; quickstart.md "Local Docker pass"; spec FR-1334, SC-1301–SC-1303
  - Depends: T1310
  - Accept:
    - **New examples**, each small, with an `expected.json` naming its components:
      - part 1: `celery-worker`, `node-bullmq`, `express-mysql`, `node-mongo`, `flask-sqlite`, `s3-uploads` (against Garage locally), `rabbitmq-worker`, `nats-app`, `kafka-app`;
      - part 2: `meili-search`, `clickhouse-events`.
    - **The Docker pass** starts each with its rendered Compose project and checks:
      - the health route answers 200;
      - a write is read back after `docker compose restart` and after a redeploy;
      - a queued job is consumed within 30 seconds;
      - a cron job runs within one minute;
      - every container's memory limit;
      - no published service port.
    - **Image facts T1311 assumed:** curl in the OpenSearch and Elasticsearch images and wget in ClickHouse's (their healthchecks); ClickHouse accepting `remove="1"` on log tables it doesn't define; Neo4j's `/logs` volume; `up --wait` with a one-shot `-sysctl` container the engine depends on (`service_completed_successfully`). Fix what fails, in the catalog (approved outside Owns for these lines).
    - **An engines check** (from T1311's review): a gated Docker test that renders OpenSearch, Elasticsearch, Typesense and Neo4j from the catalog and starts each alone with its memory limit, one at a time, checking its healthcheck passes and that its login is required (Elasticsearch, Typesense, Neo4j). It also checks bash with `/dev/tcp` in the Typesense and Neo4j images, busybox `wget` in Meilisearch's, and OpenSearch 3.9 honouring `DISABLE_SECURITY_PLUGIN` and `DISABLE_INSTALL_DEMO_CONFIG`.
    - **Portainer stacks** (from T1310): render the stack files for `node-mongo` and `s3-uploads` (Garage) and run them with `docker compose` and their stack variables. Check that MongoDB's one-shot `-init` leaves a working replica set, and that it is safe on a second `up`. Check that Garage's `--default-bucket` and `--default-access-key` give the app a working key and bucket, both times.
    - **Hygiene:** remove only what the pass created, by id.
    - **Run the pass** for every new example, and report the results.
  - Verify:
    - `OPSCREW_DOCKER_TESTS=1 OPSCREW_DOCKER_EXAMPLES=celery-worker,node-bullmq,express-mysql,node-mongo,flask-sqlite,s3-uploads,rabbitmq-worker,nats-app,kafka-app,meili-search,clickhouse-events pnpm --filter opscrew exec vitest run test/e2e/docker.test.ts`
    - `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: xhigh

- [ ] T1314 Live tests in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: quickstart.md "Live"; 012's builder checks
  - Depends: T1312, T1313
  - Accept:
    - **Hetzner components:** the live set from SC-1301, each checked as in quickstart's step 1:
      - data survives a deploy and one server reboot;
      - the worker consumes, and cron runs;
      - every container has its limit;
      - no service port is public;
      - the leak search finds nothing.
    - **Own server with two apps:** quickstart's step 2, under 20 requests per second each.
    - **Portainer:** components, and the host-setting refusal.
    - **Part 2:** Meilisearch and ClickHouse.
    - **Leftovers:** buckets included. The cleanup removes the `storage` root, and the user's test keys stay theirs.
    - **The coverage page** gets the new rows.
    - **What the local Docker pass couldn't show** (T1313 ran its examples with named volumes, inline configs and the app off the edge network), checked on Hetzner after the first deploy and after the reboot:      - each `/srv/data/<app>/<service>` folder is non-empty and owned by the service's user, and no service restarted;      - each mounted settings file has the mode and owner its service needs, and is honoured (e.g. MySQL's `@@innodb_buffer_pool_size` matches OpsCrew's `my.cnf`);      - the `sysctl` file is in the host's `/etc/sysctl.d`, and the setting holds after the reboot;      - Caddy reaches each app through the shared edge, also with two apps on one own server, and the app publishes no port.
    - **The layout from T1308c:**
      - the live tests' `/srv/app` paths become `/srv/apps/<app>`, in `builder-checks.ts`, `live.test.ts`, `own-server.test.ts` and `support.ts`;
      - `secondAppSkip` in `harness.ts` goes, now that two apps may share a server;
      - so does `docs/e2e.md`'s `/srv/app/.env`.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: high

- [ ] T1315 Live runs (lead): the passes in `docs/e2e.md`; results in `docs/e2e.md` and `docs/e2e-coverage.md`

## Dependencies

{T1301a, T1301b} → {T1302 (lead), T1303, T1306, T1308a} → {T1304, T1305} (after T1302) → T1305b → {T1307, T1308b} → T1308c → {T1309, T1304b} → T1311 → T1310 → {T1312, T1313} → T1314 → T1315.

## Parallel waves

1. T1301a, T1301b.
2. T1302 (lead), T1303, T1306, T1308a.
3. T1304, T1305.
4. T1305b.
5. T1307, T1308b (T1308b touches only iac-templates; if it breaks agents, it merges together with T1308c).
6. T1308c.
7. T1309, T1304b (agents and iac-templates, disjoint).
8. T1311.
9. T1310.
10. T1312, T1313.
11. T1314, then T1315.

## Implementation strategy

- **MVP:** workers and cron (US1) with the databases (US2) on Hetzner: T1301a–T1305, T1307, and the
  parts of T1309 and T1313 they need.
- **Then:** object storage (US3) and brokers (US4).
- **Then:** several apps on one own server (US5).
- **Then:** sizing everywhere (US6), and part 2 (US7).

Each wave is merged, gated and pushed before the next starts.

## End-of-feature simplify pass (after T1315)

- Garage on servers: replace its three init steps with the image's own `--default-bucket` / `--default-access-key` flags, as Portainer stacks already do (T1310).
- The services' address through a fake `OPSCREW_SERVICE_ADDRESS` variable (`shared/app-env.ts` `serviceAddress`): a catalog `address(ctx)` instead (T1307's review).
- Cron's memory limit equals the app's `memoryMb`, so sizing counts it twice: a cron with only route jobs needs a small fixed limit (supercronic and the probe), command jobs keep the app's (T1312).
