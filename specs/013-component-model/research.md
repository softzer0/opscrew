# Research: the component model (013)

Drafted 2026-10-19 from five research passes (processes, databases, object storage, brokers, search
and analytics), a read-only code map, and six targeted checks. Official sources only.

Tags: **[F]** fetched from the official URL on 2026-10-19. **[K]** from model knowledge, not
re-fetched: verify before relying on it. **[3rd]** third-party source. **verify** marks what the
plan's spike settles with a real run.

Scope. Today OpsCrew knows two self-hosted services (Postgres, Redis) and one process (the web
app). 013 makes "component" the unit: extra processes (workers, cron), more databases, object
storage, brokers, and (part 2) search and analytics engines. It also lets several OpsCrew apps share
one own server, and puts a memory limit on every container.

## Today (code map)

- `plan.yaml` has `services: { postgres, redis }` as booleans, with no version, size or memory
  (`plan-schema/src/plan.ts:517`). `externalServices` lists kinds kept external. The `ServiceKind`
  enum already names postgres, mysql, mongodb, redis, sqlite, supabase, firebase, s3, stripe, email,
  queue, websocket, cron (`enums.ts:68-83`). The only process is the web app (`app.port`,
  `healthPath`, `releaseCommand`).
- Detection (`detect/src/services.ts`) maps dependencies to kinds. Queue libraries (celery, rq,
  dramatiq, huey, arq, bullmq, sidekiq) give `queue`, plus `redis` for rq, arq, bullmq and sidekiq.
  Celery adds redis only with `celery[redis]`, a `redis://` URL or a compose redis service. The
  Procfile is read (`detect.ts:539`) but only `web` is used; other types become a note.
- Design (`sizing.ts`) self-hosts Postgres and Redis when used and not external. Sizes: Postgres by
  scale, Redis 0.5 GB. Derived URLs: `DATABASE_URL`, `REDIS_URL`. The interview asks only about
  hosted Supabase. A background-jobs warning exists (`design/background-jobs.ts`).
- Runtime (`renderCompose`, `iac-templates/src/runtime/index.ts`) renders `app`, a profile-only
  `release` service, `db` (Postgres, bind `/srv/data/postgres`), `cache` (Valkey with
  `--appendonly yes`, no healthcheck), `proxy` (kamal-proxy) and `caddy`, on one `internal`
  network. **No memory limits anywhere.** Portainer targets use named volumes.
- The switch step brings up the steady services (`db`, `cache`, `proxy`, `caddy`) with
  `up -d --no-deps --wait`, runs the release command, then kamal-proxy switches the target named
  `app`.
- Own servers run one app ("One server runs one OpsCrew app for now",
  `ssh-host/src/findings.ts:163`). Marker `/etc/opscrew/app.json`, host record
  `/etc/opscrew/host.json`. Shared per host: `/srv/app`, `/srv/data`, ports 80/443, the tunnel
  project `opscrew-tunnel` on `127.0.0.1:18080`, UFW, deploy user, sshd drop-in, fail2ban. File
  names under `/srv/app` are shared too.
- Secrets: the database password is generated or reused; `DATABASE_URL` is
  `postgresql://app:<pw>@db:5432/app`; `db.env` travels as a GitHub secret.
- Destroy and drift know only `db.env` and `/srv/data`. The secops probe flags 5432 and 6379 if
  public. Docs mention a Celery app (`slog_cvrp_app`) waiting for 013.

## R1. Processes: workers and cron

**Decision.**

- OpsCrew reads the Procfile itself (every type except `web` and `release`) and the detected worker
  libraries.
- A worker is a Compose service from the app's image: no ports, no proxy. Defaults:
  `stop_grace_period` 30 s (the user can change it), `restart: unless-stopped`, 1 replica, and a
  memory limit.
- Start forms by builder:
  - generated Dockerfile: `command`;
  - Buildpacks: `entrypoint: ["/cnb/process/<type>"]` for a Procfile type, else
    `/cnb/lifecycle/launcher -- <cmd>`;
  - Railpack: verify the image ENTRYPOINT first (below); the evidence says `command` is one string;
  - own Dockerfile: `command`.
- Schedulers that must run once (Celery beat, Laravel `schedule:work`, Solid Queue, sidekiq-cron)
  get exactly one replica.
- Worker health is the restart policy only.
- Cron: supercronic (MIT), added at build time with `ADD --checksum=sha256:<x>`. OpsCrew records the
  SHA-256 when it pins, because upstream publishes only SHA-1; the pin script checks the SHA-1 too.
  It goes in the generated Dockerfile and in the seal step for Buildpacks and Railpack. An own
  Dockerfile gets a seal step only when the plan has cron jobs.
- Cron jobs come from `plan.yaml` entries and from `vercel.json` `crons` (an HTTP call to the app's
  own route, with a generated `CRON_SECRET` sent as `Authorization: Bearer`, made with the image's
  probe tool, not curl).
- Cron runs as one `cron` service from the app image. Overlapping runs are skipped (supercronic's
  default).

**Rationale.** A separate cron container is the usual Docker answer. Cron inside the web container
multiplies with replicas and mixes logs. Queue libraries with their own command need their own
service; Spring, .NET, node-cron, Bree and APScheduler run inside the web process, so they get no
extra service (warn if replicas > 1). `whenever` only writes a crontab, so OpsCrew turns its output
into a supercronic crontab. Railpack exposes one start command only, so OpsCrew must parse the
Procfile itself.

**Alternatives considered.** Cron inside the app container (duplicates with replicas). Ofelia
(needs the Docker socket; rejected by the safety rules). Host cron (outside the Compose project,
not portable to Portainer). A health check per worker library (only Celery has a usable CLI ping;
offer it as an optional suggestion).

**Key facts.**

- Procfile [F] https://devcenter.heroku.com/articles/procfile: only `web` and `release` are special;
  other types are convention.
- Railpack reads a Procfile (deprecated) but picks one command: `RAILPACK_START_CMD` >
  `deploy.startCommand` > Procfile (`web`, then `worker`, then the first other type) [F]
  https://railpack.com/config/procfile/ . Other types are not in the image.
- **Railpack image config [F]** (source `core/../buildkit/convert.go` at v0.42.0, via
  https://github.com/railwayapp/railpack/blob/v0.42.0/buildkit/convert.go ): `Entrypoint` is
  hardcoded to `["/bin/bash", "-c"]`, `Cmd` is `[startCommand]` (falls back to `/bin/bash`),
  `WorkingDir` is `/app`. So a worker is `command: ["node worker.js"]` as ONE string; a list of
  words would be wrong. The fetch was summarised by the tool, not read raw: confirm with
  `docker inspect` on a real image (**verify**). This agrees with the earlier third-party report
  https://github.com/getployz/ployz/pull/1868 [3rd].
- CNB launcher [F] https://github.com/buildpacks/spec/blob/main/platform.md : `/cnb/process/<type>`
  symlinks exist per type. When a default process exists the ENTRYPOINT is `/cnb/process/web`, so a
  Compose `command:` becomes arguments to the web process. Workers must set `entrypoint:`. Paketo's
  Procfile buildpack [F] https://paketo.io/docs/howto/configuration/ .
- **supercronic [F]** https://github.com/aptible/supercronic/releases : latest v0.2.50, 16 Oct 2026;
  6 assets (the page lists four Linux binaries: amd64, 386, arm, arm64). Checksums are SHA-1 only,
  in the release notes: amd64 `0795da10bf6303e9680a2c2bd8dd6b9aa33ebda2`, arm64
  `e0023a0346354a153a4a2708c657308890823d14`. No SHA-256 is published. Licence MIT [F]
  https://api.github.com/repos/aptible/supercronic . README [F]: 5-field cron (seconds optional),
  SIGTERM/SIGINT graceful, must be PID 1 to get signals, overlapping runs skipped unless
  `-overlapping`, logs on stderr, `CRON_TZ` and `TZ` (needs tzdata).
- **Vercel crons [F]** https://vercel.com/docs/cron-jobs/manage-cron-jobs : `vercel.json` has
  `crons: [{ "path": "/api/x", "schedule": "*/5 * * * *" }]`. When `CRON_SECRET` is set, Vercel
  sends it as `Authorization: Bearer <secret>` (at least 16 random characters recommended). Vercel
  sends an `x-vercel-cron-schedule` header with the expression. It does not follow redirects, does
  not retry, and delivery is best effort (may run twice or be missed). Routes should be idempotent.
  Hobby accuracy limits do not apply to our own scheduler. The invoking method is not stated on
  this page; the examples are GET handlers, so use GET [K].
- Graceful stop: Sidekiq TERM waits `-t` (default 25 s), allow +5 s [F]
  https://github.com/sidekiq/sidekiq/wiki/Deployment ; Celery TERM is a warm shutdown that waits
  for running tasks [F] https://docs.celeryq.dev/en/stable/userguide/workers.html ; Laravel
  `queue:work` finishes the current job on TERM, `--timeout` must stay under `retry_after` [F]
  https://laravel.com/docs/12.x/queues . Solid Queue: TERM graceful, `shutdown_timeout` 5 s [F]
  https://github.com/rails/solid_queue . Default 30 s for workers, 10 s for cron.
- Laravel scheduling [F] https://laravel.com/docs/12.x/scheduling : `schedule:work` runs forever;
  `withoutOverlapping` and `onOneServer` need a shared cache.
- Kamal roles are the same idea (same image, different `cmd`, no proxy) [F]
  https://kamal-deploy.org/docs/configuration/roles/ ; Kamal waits `readiness_delay` and does not
  check worker health [F] https://kamal-deploy.org/docs/configuration/overview/ .
- Detection signals, all [K] (confirm against real manifests): Celery (`celery -A x worker`, `beat`),
  RQ, Dramatiq, Huey, Django-Q2 `qcluster`; Sidekiq, GoodJob, Solid Queue (`bin/jobs`, `config/recurring.yml`),
  Resque; BullMQ, Agenda (look for package.json scripts named worker, queue, jobs, cron);
  `queue:work`, `schedule:work`, Horizon; asynq, river (`cmd/worker`). Full list with URLs is in the
  processes research pass.
- Signals must reach the app: exec-form commands or `init: true` [K].

**Open questions.** Railpack ENTRYPOINT on a real image. Whether a Celery ping healthcheck is worth
offering. How a `vercel.json` cron path with query strings is passed to the probe tool. Whether the
seal step can add supercronic without breaking the Buildpacks non-root user (**verify**).

## R2. Databases: MySQL, MariaDB, MongoDB, SQLite

**Decision.**

- MySQL 8.4 LTS by default (9.7 LTS as the user's choice), tuned for small servers.
- MariaDB only when the app declares it.
- MongoDB 8.0 by default (9.0 as an option), official image only. On x86, AVX is checked before
  provisioning, with a plain refusal. `--wiredTigerCacheSizeGB` is set explicitly. A single-node
  replica set when the app uses transactions or Prisma. A `mongodb+srv://` URI means hosted Atlas:
  keep it external.
- SQLite: a volume on the database's directory, and the deploy strategy `recreate` for SQLite apps.
- No new backup feature (the founder decided provider backups are enough). The guide says provider
  snapshots are crash-consistent only.

**Rationale.** 8.4 has the widest driver support, and Docker's `latest` tag is an Innovation
release, which is supported only until the next one, so never use it. MongoDB 5.0+ needs AVX; many
cheap VPS and Raspberry-class ARM boards lack it, and the failure is a crash at start, so a
preflight is kinder. WiredTiger may ignore container limits, so size the cache explicitly. SQLite
with two copies running (start-first deploys) makes writers contend and runs migrations while the
old copy serves; stop-first avoids that at the price of a short pause.

**Alternatives considered.** Bitnami images (the free versioned tags are gone). Defaulting MySQL to
9.7 (newer, but 9.x removes `mysql_native_password`). Running MariaDB for MySQL apps (JSON type and
`utf8mb4_0900_*` collations do not load). A Litestream sidecar for SQLite (Apache-2.0, beta badge;
only worthwhile with an S3 bucket; not in 013, since no new backup feature).

**Key facts.**

- MySQL images [F] https://hub.docker.com/_/mysql : Innovation 26.7.0 (`latest`), LTS 9.7.2 (`lts`,
  `9.7`), LTS 8.4.11 (`8.4`). amd64 and arm64. 8.4 LTS to 9.7 LTS is a supported upgrade [F]
  https://dev.mysql.com/doc/refman/9.7/en/upgrade-paths.html ; 8.0 to 8.4 in place [F]. Env:
  `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `*_FILE` variants; data
  `/var/lib/mysql`; init vars ignored if the data directory exists [F hub].
- Small-server flags: `--innodb-buffer-pool-size=256M` (1 GB) or `512M` (2 GB),
  `--innodb-buffer-pool-instances=1`, `--performance-schema=OFF`, `--max-connections=50`; container
  limit about pool + 400 MB [K]. Buffer pool default 128 MB, rounded to chunk size [F]
  https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool-resize.html . Healthcheck
  `mysqladmin ping` with `start_period` 30-60 s [K].
- MariaDB: 12.3 is the current LTS [F] https://mariadb.com/kb/en/mariadb-server-release-dates/ . Env
  `MARIADB_*`; `healthcheck.sh --connect --innodb_initialized` [K].
- MongoDB images [F] https://github.com/docker-library/official-images/blob/master/library/mongo :
  9.0 (`latest`), 8.3 (rapid), 8.0, 7.0. SSPL: running it as your own app's database is
  unrestricted; section 13 targets offering MongoDB as a service [F]
  https://www.mongodb.com/legal/licensing/server-side-public-license/faq (a summary, not legal
  advice). AVX on x86_64, ARMv8.2-A on arm64; WiredTiger cache = max(50% of (RAM - 1 GB), 0.256 GB)
  and may ignore container limits [F]
  https://www.mongodb.com/docs/manual/administration/production-notes/ . Preflight
  `grep -qw avx /proc/cpuinfo` [K]. Env `MONGO_INITDB_ROOT_USERNAME` and `_PASSWORD` [F]
  https://hub.docker.com/_/mongo . Cache `0.25` GB on 1 GB, `0.5` on 2 GB; container limit cache +
  400-500 MB [K]. Prisma and transactions need a replica set even on one node (`--replSet rs0`,
  `rs.initiate()`) [K]. Healthcheck `mongosh --eval "db.adminCommand('ping')"` [K]. Env names
  `MONGODB_URI`, `MONGO_URL`, `DATABASE_URL` [K].
- Bitnami: versioned images moved to frozen `bitnamilegacy` from 2025-08-28 [F]
  https://github.com/bitnami/charts/issues/35164 . Use the official `mongo` image.
- SQLite: WAL needs all processes on one host, one writer, `SQLITE_BUSY` still possible, `-wal` and
  `-shm` must stay with the database [F] https://www.sqlite.org/wal.html . Mount the volume on the
  directory. Default paths [K]: Rails 8 `storage/production*.sqlite3` (four files), Django
  `db.sqlite3`, Laravel `database/database.sqlite`, Prisma `prisma/dev.db`. The Rails 8 paths were
  not confirmed in the Rails docs.
- Litestream [F] https://github.com/benbjohnson/litestream : v0.5.17, Apache-2.0, beta badge.
- Snapshots are crash-consistent only: InnoDB, WiredTiger and SQLite WAL recover from that, but the
  last seconds can be lost [K, judgement].
- Detection signals [K]: `mysql2`, `PyMySQL`, `mysqlclient`, `go-sql-driver/mysql`, `mysql-connector-j`,
  Laravel `DB_CONNECTION=mysql|mariadb`, `jdbc:mariadb:`; `mongoose`, `pymongo`, `motor`, `mongoid`,
  `go.mongodb.org/mongo-driver`, `spring-data-mongodb`. Ignore `mongodb-memory-server`.

**Open questions.** Run the MySQL 8.4 and Mongo 8.0 containers on 1 GB and 2 GB servers and measure
idle RSS. Does Prisma's MongoDB provider work with the single-node replica set init on first boot
(**verify**)? Which SQLite apps use more than one file (Rails 8)? Does 9.0 pass the AVX check on
ARM?

## R3. Object storage

**Superseded in part by plan.md "6." (2026-10-19, after the cross-artefact analysis):** buckets go
through the IaC engine in a separate `storage` root, and OpsCrew never creates keys. The user
creates one in each provider's console (for R2, a token limited to the bucket, after OpsCrew creates
it), so no key is in infrastructure state and OpsCrew's tokens need no key-creating permission. The
decision below is the original one.

**Decision.**

- Options, priced side by side. Design picks the cheapest by default:
  - Cloudflare R2: bucket and an S3 token through Cloudflare's API;
  - DigitalOcean Spaces: bucket and a per-bucket key through Terraform and the API;
  - Hetzner Object Storage: the user pastes one key pair from the console; OpsCrew creates the
    bucket through the S3 API; its price comes from a dated table in OpsCrew (the Cloud API has
    no object storage price), shown as "from hetzner.com, checked <date>";
  - Garage (AGPL, single node) on the user's own server or Portainer, or on request.
- MinIO is not offered.
- Private buckets. CORS for the app's own origin when presigned uploads are detected.
- Env vars: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3`, the
  bucket name, plus Laravel's names. SDKs that do not read `AWS_ENDPOINT_URL_S3` (JS v2, Go v1,
  Java 1.x) get a code-change note.

**Rationale.** R2 is free up to 10 GB and has no egress charge, so it wins at small sizes. Spaces
and Hetzner have a fixed floor even with an empty bucket. Hetzner wins at large storage. Hetzner
has no API for credentials or buckets, so one console step is unavoidable. MinIO's community
edition is archived and gone from Docker Hub.

**Alternatives considered.** MinIO (archived). SeaweedFS (Apache-2.0 [K], not checked in depth).
RustFS (young). Ceph RGW (needs a cluster). A Hetzner project per app for least-privilege keys
(too much user work).

**Key facts.**

- Hetzner [F] https://docs.hetzner.com/storage/object-storage/overview : locations fsn1, nbg1, hel1
  at `<loc>.your-objectstorage.com`; one base price per account, billed hourly while any bucket
  exists; the base includes 1 TB storage and 1 TB egress; 100 buckets, 200 credentials. Keys are
  project-wide. Many S3 features are missing [F]
  https://docs.hetzner.com/storage/object-storage/supported-actions (CreateBucket takes only
  object-lock, ACL and LocationConstraint; CopyObject only within a bucket; no custom domains).
  No Terraform resource for buckets or credentials in hcloud v1.70.0 [F]
  https://github.com/hetznercloud/terraform-provider-hcloud/tree/main/docs/resources . Credentials
  are console-only (FAQ about 2 years old, may be stale) [F]
  https://docs.hetzner.com/storage/object-storage/faq/s3-credentials/ . Buckets via the S3 API [F]
  https://docs.hetzner.com/storage/object-storage/getting-started/using-libraries/ .
- **Hetzner price in the API: no [F].** The Go SDK's schema for `GET /v1/pricing` (the official
  client, https://github.com/hetznercloud/hcloud-go/blob/main/hcloud/schema/pricing.go ) has these
  groups: Currency, VATRate, Image, FloatingIP(s), PrimaryIPs, Traffic, ServerBackup, ServerTypes,
  LoadBalancerTypes, Volume. No object storage and no storage box. (The docs.hetzner.cloud page
  itself did not render for our fetch tool, so this rests on the client schema.) So "read the price
  live" cannot use that endpoint.
- **Hetzner price [F]** https://www.hetzner.com/storage/object-storage/ (the official product page,
  checked by the founder on 2026-10-19; our fetch tool could not render it): EUR 6.49 a month
  excluding VAT as the base; additional storage EUR 6.26 per TB; additional outgoing traffic
  EUR 1.00 per TB; up to 100 buckets of up to 100 TB each. The 1 Apr 2026 change from the launch
  price of EUR 4.99 is in https://www.hetzner.com/pressroom/statement-price-adjustment/ . OpsCrew
  keeps these figures in a dated price table with this source, refreshed at release time.
- **How the Hetzner price scales [F]** https://docs.hetzner.com/storage/object-storage/overview
  (checked 2026-10-19):
  - the base price is **per account**, charged hourly with a monthly cap, for every hour with at
    least one bucket, even an empty one;
  - the base includes a quota that builds up hourly and lapses at the month's end: 744 TB-hours of
    storage (1 TB kept all month) and 1.116 TB of egress in a 31-day month, less in shorter months;
  - beyond the quota, pay as you go on the whole account, in 100 MB steps: storage as net price ×
    TB-hours (the EUR 6.26 per TB-month rate), egress at EUR 1.00 per TB;
  - free: ingress, traffic within the network zone (e.g. `eu-central`), and S3 operations (their
    egress is billed);
  - objects under 64 kB are billed as 64 kB.
  - **Monthly estimate** for steady use: `6.49 + 6.26 × max(0, storedTB − 1) + 1.00 × max(0,
    egressTB − 1.116)` (EUR, excluding VAT; the egress quota is smaller in months under 31 days).
  - When the user's account already pays the base for other buckets, the app's own cost is only what
    it adds beyond the shared quota. OpsCrew cannot see that, so design shows the full base price
    and says it is per account.
- DigitalOcean Spaces [F] https://docs.digitalocean.com/products/spaces/details/pricing/ : USD 5
  per month, 250 GiB and 1,024 GiB outbound included, then USD 0.02/GiB and USD 0.01/GiB. Regions
  [F] https://docs.digitalocean.com/products/spaces/details/availability/ . Terraform
  `digitalocean_spaces_bucket`, `_cors_configuration`, `digitalocean_spaces_key` with per-bucket
  grants [F] https://raw.githubusercontent.com/digitalocean/terraform-provider-digitalocean/main/docs/resources/spaces_key.md .
  Keys API `/v2/spaces/keys` [F]
  https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml .
  The help page still says keys are panel-only [F] https://docs.digitalocean.com/products/spaces/how-to/manage-access/
  (stale; verify live). The secret lands in Terraform state: treat state as secret. The bucket
  resource itself needs a Spaces key (chicken and egg) [K].
- Cloudflare R2 [F] https://developers.cloudflare.com/r2/pricing/ : Standard USD 0.015/GB-month,
  free tier 10 GB, 1M Class A, 10M Class B; egress free. Beyond the free tier, Class A operations
  are USD 4.50 and Class B USD 0.36 per million, each billed per started unit (checked by T1301b on
  2026-10-19). DigitalOcean Spaces' USD 5 subscription is per account: "Each subscription allows you
  to create multiple Spaces buckets", with its storage and transfer shared across them [F]
  https://docs.digitalocean.com/products/spaces/details/pricing/ . `cloudflare_r2_bucket` and friends
  (provider v5.28.0) [F]
  https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/r2_bucket.md .
  S3 credentials: Access Key ID = token `id`, Secret = SHA-256 hex of the token `value` [F]
  https://developers.cloudflare.com/r2/api/s3/tokens/ . The token value is shown once. Endpoint
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto` [K]. Permission groups and
  per-bucket scoping [F] https://developers.cloudflare.com/r2/api/tokens/ . OpsCrew's own
  Cloudflare token needs "API Tokens: Edit" to mint per-app tokens. `r2.dev` is for development
  only; production needs a custom domain [F] https://developers.cloudflare.com/r2/buckets/public-buckets/ .
- MinIO archive, Docker Hub removal [3rd]: https://pinggy.io/blog/minio_archived_self_hosted_s3_alternatives/ ,
  https://bex.co/blog/2026/09/25/minio-docker-hub-removal-quay-repoint .
- Garage [F] https://garagehq.deuxfleurs.fr/documentation/quick-start/ : AGPL-3.0, image
  `dxflrs/garage:v2.4.1`, `garage server --single-node --default-bucket`, no redundancy. Memory
  figures (about 15-20 MB empty) [3rd] https://rilavek.com/resources/self-hosted-s3-compatible-object-storage-2026 .
  Fewer S3 features (no versioning, lifecycle) [3rd].
- SDK endpoint variables [F] https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html :
  `AWS_ENDPOINT_URL_S3` works in AWS CLI v2, Go v2, Java 2.x, JS v3, .NET, PHP 3.x, Boto3, Ruby 3.x,
  Rust. Not in Go v1, Java 1.x, JS v2.
- Laravel [F] https://laravel.com/docs/12.x/filesystem : `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_DEFAULT_REGION`, `AWS_BUCKET`, `AWS_USE_PATH_STYLE_ENDPOINT`, `AWS_ENDPOINT`. Rails Active
  Storage (`storage.yml`, often credentials, not env) and django-storages
  (`AWS_S3_ENDPOINT_URL`, `AWS_STORAGE_BUCKET_NAME`) [K].
- Early-2025 SDK default checksums broke some S3-compatible services; set
  `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` and `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`
  [K]. Test on Hetzner and Garage.
- 10 GB stored, 50 GB egress per month: R2 USD 0.00, Spaces USD 5.00, Hetzner EUR 6.49 [F],
  Garage no extra cost.
- Detection signals [K]: `@aws-sdk/client-s3`, `boto3`, `django-storages`, `aws-sdk-s3`,
  `league/flysystem-aws-s3-v3`, `aws-sdk-go-v2/service/s3`, `software.amazon.awssdk:s3`,
  `config/storage.yml` with `service: S3`. Require an S3-specific package; plain `boto3` may be SQS
  or SES only. Keep detecting `minio` clients (they speak S3).

**Open questions.** Where to read Hetzner's live object-storage price (no pricing API). Live check
of the DigitalOcean keys API. Whether R2 custom-domain setup fits the existing zone work. Garage
bucket and key bootstrap on first start.

## R4. Message brokers and Redis-based queues

**Decision.**

- RabbitMQ 4.3: plain tag, an absolute memory watermark in a mounted `rabbitmq.conf`, `guest`
  deleted, `hostname` set.
- NATS 2.15 on alpine: JetStream, token auth via config, healthcheck `wget` on `/healthz`.
- Apache Kafka 4.x KRaft by default: single combined node, heap by server size, retention bounded,
  refused on 1 GB.
- Redpanda 26.x as the user's choice: BSL 1.1 is fine for the user's own app; community features
  only.
- Redis-backed queues: when a queue library uses Redis, Valkey runs in queue mode (`noeviction`,
  AOF). There is a separate cache instance only when the app reads a separate cache URL.
- Celery's broker is decided by its URL scheme.

**Rationale.** The RabbitMQ watermark is an alarm that blocks publishers, not a cap, and cgroup
detection is unreliable, so the docs recommend an absolute value. The NATS default image is scratch
(no shell), so a healthcheck needs the alpine variant. Kafka's JVM idles at 600-900 MB, hence the
refusal on 1 GB. Queue libraries need `noeviction`; a cache needs eviction. One instance cannot do
both. The earlier research proposed always two instances; the lead's rule (a second instance only
when the app reads a separate cache URL) is smaller, and the guide must explain that a cache
sharing a `noeviction` instance errors when memory is full.

**Alternatives considered.** The `-management` RabbitMQ tag (only on request; never publish 15672).
NATS on the scratch image (no healthcheck). `apache/kafka-native` (lower memory, less mature [K]).
Redpanda `dev-container` mode (not safe for data). Bitnami images (gone).

**Key facts.**

- RabbitMQ [F] https://hub.docker.com/_/rabbitmq : 4.3.6 latest; `4.2.9`, `4.1.8`, `4.0.9`; data
  `/var/lib/rabbitmq` (node-name path: set `hostname:`); config `/etc/rabbitmq/rabbitmq.conf`. The
  `RABBITMQ_VM_MEMORY_HIGH_WATERMARK` env is deprecated; use the conf file. Memory [F]
  https://www.rabbitmq.com/docs/memory (default 0.6 relative; absolute recommended in containers).
  Production checklist [F] https://www.rabbitmq.com/docs/production-checklist (delete `guest`,
  `disk_free_limit` default is dev-only). Suggest absolute about 0.4 x the container limit, disk
  free limit 1-2 GB [K]. Licence MPL 2.0 [K]. Healthcheck `rabbitmq-diagnostics -q ping` [K]. The
  default vhost `/` is `%2F` in a URL; generate alphanumeric passwords.
- NATS [F] https://github.com/nats-io/nats-server/releases : v2.15.1 (9 Oct 2026); images
  https://hub.docker.com/_/nats ; token auth [F]
  https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/tokens .
  Flags `-js`, `-sd`. Licence Apache 2.0 [K]. JetStream limits (`max_file_store`) and the alpine
  `wget` healthcheck [K].
- Kafka [F] https://kafka.apache.org/community/downloads/ : 4.3.1, 4.2.2, 4.1.2; images
  `apache/kafka`, `apache/kafka-native`. Env mapping and single-node combined settings [F]
  https://github.com/apache/kafka/blob/trunk/docker/examples/README.md and
  https://hub.docker.com/r/apache/kafka . The Hub page lists only `latest`: pin a tag and resolve
  the digest. User `appuser` uid 1000. Heap via `KAFKA_HEAP_OPTS`, retention env, size table
  (1 GB refuse; 2 GB heap 512m, limit 1g; 4 GB heap 1g, limit 1.5-2g; 8 GB+ heap 2g, limit 3g) [K].
- Redpanda [F] https://docs.redpanda.com/current/get-started/quick-start/ (v26.2.5); licence BSL
  1.1, converts to Apache 2.0 after 4 years; production use allowed except offering Redpanda as a
  service [F] https://github.com/redpanda-data/redpanda/blob/dev/licenses/bsl.md ,
  https://docs.redpanda.com/current/get-started/licensing/overview/ . Enterprise features need a
  key and enabling them without one blocks upgrades [F]. `--memory`, `--overprovisioned` [K].
  Realistic minimum about 1 GiB [K].
- Redis queues: BullMQ requires `noeviction` and AOF [F] https://docs.bullmq.io/guide/going-to-production ;
  Valkey eviction policies, two instances usually better [F] https://valkey.io/topics/lru-cache/ .
  Sidekiq guidance [K].
- Idle footprints are rules of thumb [K]: NATS 10-20 MB, Valkey 5-10 MB, RabbitMQ 120-200 MB,
  Kafka 500-900 MB. Measure in a live run.
- Detection signals [K]: `amqplib`, `pika`, `kombu`, `bunny`, `php-amqplib`, `amqp091-go`,
  `spring-boot-starter-amqp`; `nats`, `nats-py`, `nats.go`; `kafkajs`, `confluent-kafka`, `karafka`,
  `sarama`, `franz-go`, `spring-kafka`; env `AMQP_URL`, `CELERY_BROKER_URL`, `NATS_URL`,
  `KAFKA_BROKERS`, `KAFKA_BOOTSTRAP_SERVERS`. Images named in an existing compose file are strong
  signals. Count runtime dependencies only.

**Open questions.** Confirm the Kafka heap env and the Redpanda `--memory` flag on a live run.
What name the queue Valkey takes in Compose (`cache` today; a second instance needs a name) and
which URL variable each queue library reads. NATS auth config rendering. Check the licence files
for RabbitMQ and NATS before pinning.

## R5. Part 2: search and analytics engines

**Decision.**

- Single-node containers with memory caps and licences shown at opt-in, and a warning below each
  one's minimum server.
- OpenSearch 3.x with the security plugin disabled on the internal network (reachable only from the
  app's own containers, like Valkey today).
- Elasticsearch 9.x (ELv2) only when an Elasticsearch client is detected, with security on and
  `ELASTIC_PASSWORD`.
- Meilisearch: production mode, a master key, the indexing memory capped.
- Typesense: an API key.
- ClickHouse LTS: the low-memory profile, a user and password.
- Neo4j Community (calendar versions): `NEO4J_AUTH`, heap and pagecache set.
- `vm.max_map_count` for OpenSearch and Elasticsearch: via cloud-init on cloud servers, via the
  host plan on an own server. Refused with a plain message on a Portainer target.
- Cassandra is never self-hosted (keep it external, for example Astra).

**Rationale.** All of these are heavy for a small VPS, so the opt-in screen shows licence, minimum
server and a memory cap. Official Elasticsearch 7.14+ clients reject OpenSearch, and the reverse,
so the two are not interchangeable. A host kernel setting cannot be changed from a Portainer stack,
hence the refusal there. Cassandra is built for a ring; one node gets none of the benefit.

**Alternatives considered.** Keeping OpenSearch security on (needs a strong
`OPENSEARCH_INITIAL_ADMIN_PASSWORD`, https and a client that can do basic auth; kept as an option
when the client supports it). OpenSearch 2.19 (only for old clients). Neo4j Enterprise (licence
acceptance; never). Self-hosting Cassandra (4 GB minimum, 8 GB+ advised [K]).

**Key facts.**

| Engine | Version [F] | Licence | Min server | Source |
|---|---|---|---|---|
| OpenSearch | 3.9.0 (29 Sep 2026); 2.19.6 | Apache-2.0 [K] | 4 GB (2 GB tight) | https://github.com/opensearch-project/OpenSearch/releases |
| Elasticsearch | 9.5.5 | ELv2 in the image | 4 GB | https://www.elastic.co/guide/en/elasticsearch/reference/current/docker.html |
| Meilisearch | v1.55.0 (12 Oct 2026) | MIT (Enterprise BUSL, unused) | 2 GB | https://github.com/meilisearch/meilisearch |
| Typesense | v30.2 | GPL-3.0 server, Apache-2.0 clients | 2 GB (1 GB tiny) | https://github.com/typesense/typesense |
| ClickHouse | v26.7 stable; 26.3 LTS (`lts` tag) | Apache-2.0 [K] | 4 GB (2 GB tuned) | https://github.com/ClickHouse/ClickHouse/releases |
| Neo4j Community | 2026.09 | GPLv3 [K] | 4 GB (2 GB tight) | https://neo4j.com/docs/operations-manual/current/docker/introduction/ |

Minimum servers are judgement calls [K] built from the notes below.

- OpenSearch: docs https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/
  [F]. Security and demo TLS are on by default; `OPENSEARCH_INITIAL_ADMIN_PASSWORD` is required
  and strength-checked [F]. `DISABLE_SECURITY_PLUGIN=true`, `discovery.type=single-node`, heap
  `-Xms512m -Xmx512m`, user `opensearch` uid 1000, nofile 65536 and memlock [K]. Host
  `vm.max_map_count=262144` [F]. Single node needs replicas 0 or health stays yellow; watermarks
  85/90/95% [K].
- Elasticsearch: image `docker.elastic.co/elasticsearch/elasticsearch:9.5.5` [F]. Security on by
  default; `ELASTIC_PASSWORD` sets the password [F]. A container `-m 1GB` makes ES size its heap
  [F]; ML needs 6 GB, so `xpack.ml.enabled=false` [K]. Licence: AGPL added in Aug 2024 next to
  ELv2 and SSPL, but the stock image is ELv2; ELv2 forbids offering ES as a managed service [F]
  https://www.elastic.co/blog/elasticsearch-is-open-source-again (the image-licence reading is
  partly [K]). Healthcheck needs `-k` and credentials [K].
- Meilisearch: `MEILI_MASTER_KEY` (16 bytes minimum) is required with `MEILI_ENV=production`;
  default env is `development` with open routes; `MEILI_MAX_INDEXING_MEMORY` defaults to 2/3 of
  RAM; `MEILI_NO_ANALYTICS` [F]
  https://www.meilisearch.com/docs/resources/self_hosting/configuration/reference . Data path,
  `/health`, non-root check, version upgrades need dump and import (pin the tag) [K]. Give the app a
  scoped key, not the master.
- Typesense: `--data-dir /data --api-key=...`, port 8108, `/health` [F]
  https://typesense.org/docs/guide/install-typesense.html . Index in RAM: 1M short docs about
  165 MB [F README]. Skip `--enable-cors`.
- ClickHouse: env `CLICKHOUSE_DB`, `_USER`, `_PASSWORD`; the `default` user has no network access
  unless these are set [F] https://hub.docker.com/_/clickhouse . Ulimit nofile 262144 [F]. Docs
  recommend 32 GB+, 2 GB works with tuning; low-memory recipe [F]
  https://clickhouse.com/docs/operations/tips . Ratio, concurrency and log-table settings, and the
  `wget /ping` healthcheck [K]. Ship `config.d/` and `users.d/` XML. The two version sources
  differed slightly: resolve tag and digest at build time and prefer `lts`.
- Neo4j: `NEO4J_AUTH=neo4j/<password>`, env naming `NEO4J_server_memory_heap_max__size`,
  Bolt 7687 and HTTP 7474 (do not publish) [F]
  https://neo4j.com/docs/operations-manual/current/docker/configuration/ . Community: one user
  database, no clustering, no online backup [K]. Plugins download at start (network at boot) [K];
  skip `NEO4J_PLUGINS` unless needed. `neo4j:5` is stale.
- Cassandra [K]: drivers `cassandra-driver`, `gocql`, `java-driver-core`. Recommend external
  (Astra DB; check current free-tier limits).
- Client signals for each engine are [K] and listed in the search/analytics research pass.

**Open questions.** Image users, healthchecks, and whether the images carry `curl` or `wget`, per
engine. The OpenSearch `DISABLE_SECURITY_PLUGIN` flag in 3.x. Neo4j's current Docker Hub tag
(calendar versions; check for an LTS). Real idle memory per engine on a 4 GB server. Whether the
host plan can set `vm.max_map_count` persistently without clashing with other settings.

## R6. Several OpsCrew apps on one own server

**Changed by plan.md "8." (2026-10-19):** each app keeps its own Cloudflare Tunnel (its root owns it,
as today), with its cloudflared joining the shared edge network. The edge's files come with each
deploy, and a version stamp keeps the newest. kamal-proxy targets the web containers by their Compose
names.

**Decision.**

- Direction: one shared edge per host (Caddy and kamal-proxy), and one Compose project per app under
  `/srv/apps/<app>`, with data under `/srv/data/<app>`.
- kamal-proxy routes by host name (`kamal-proxy deploy <service> --host <hostname>`).
- One cloudflared per host, with an ingress rule per hostname.
- The host record lists the apps. Destroy removes only its app, and the edge goes with the last app.
- The same per-app layout on Hetzner and DigitalOcean servers, for one code path; they still run
  one app per server.

**Rationale.** Today `/srv/app` file names, ports 80/443, the tunnel project and the host record
are per host, but the Compose project is already named after the app. Moving per-app files into
per-app folders is the smaller change. Using the same layout on cloud servers avoids two code paths.

**Alternatives considered.** One edge per app on different ports (breaks 80/443 and Cloudflare
tunnels). Merging all apps into one Compose project (one destroy hits everything). Docker Swarm or
Kubernetes (far too large).

**Key facts.**

- **kamal-proxy host routing [F]** https://github.com/basecamp/kamal-proxy : the README shows
  `kamal-proxy deploy service1 --target web-1:3000 --host app1.example.com`; "the instance will
  only receive traffic for the specified host"; several services each with their own host run on
  one server; "Only one service at a time can route a specific host" (a second service gets
  "host is used by another service" until the first is removed). **Several hosts per one service
  is not documented** in the README: every example uses one `--host`. Treat it as unsupported
  until `kamal-proxy help deploy` or the source shows otherwise (**verify**). If an app needs two
  hostnames (for example `www`), use a redirect rule in Caddy, or one kamal-proxy service per
  hostname.
- Kamal itself runs multiple apps behind one proxy by host [K]; its roles and accessories
  documentation is cited in R1.
- Today's ssh-host limits: `findings.ts:163`, plan at `plan.ts:805-830`, apply at `apply.ts:406-413`
  (code map).
- Cloudflared ingress rules by hostname are standard configuration [K]; check the existing tunnel
  code before assuming it can hold several rules.

**Open questions.** Several hosts per service in kamal-proxy. How the switch step names targets
when two apps both have an `app` service (the target name should include the app). What happens to
UFW comments, the deploy user and the sshd drop-in when the last app is removed (they belong to
the host, not to an app). How drift reads a host with several apps. Port conflicts when two apps
publish the same internal port (they share no host ports, so none expected).

## R7. Memory limits and sizing

**Decision.**

- Every service, worker and cron container gets a Compose memory limit.
- Sizing adds up the app, workers, cron, services and the edge. Design picks a server that fits.
  On an own server, the inspected memory is checked, and OpsCrew warns or refuses.
- Pick `mem_limit` or `deploy.resources.limits.memory` (below).

**Recommendation for the open choice.** Use `mem_limit`, because the Compose reference defines it
as a service attribute that works without Swarm, while `deploy` is described as optional. Confirm
with a live `docker inspect` of `HostConfig.Memory` on both Docker Compose v2 and a Portainer CE
stack (**verify**). If both are set they must agree, so set only one.

**Rationale.** Without limits one runaway container (a JVM, an indexer) can push the host into the
OOM killer, which may kill the database. Limits make a failure local and visible. Today no limit
exists anywhere.

**Alternatives considered.** Setting both keys (they must be consistent; extra churn). Host-level
cgroup tuning (not portable to Portainer).

**Key facts.**

- **Compose spec [F]** https://docs.docker.com/reference/compose-file/services/ : "`mem_limit`
  configures a limit on the amount of memory a container can allocate... When set, `mem_limit` must
  be consistent with the `limits.memory` attribute in the Deploy Specification." "Deploy support is
  an optional aspect of the Compose Specification. If not implemented the `deploy` section is
  ignored." The deploy page [F] https://docs.docker.com/reference/compose-file/deploy/ says
  `limits` means "the platform must prevent the container from allocating more resources" and says
  nothing about Swarm. **The official pages do not say whether plain `docker compose` honours
  `deploy.resources.limits.memory`.** Docker Compose v2 applying it outside Swarm is common
  knowledge [K], not confirmed here.
- Per-service container limits from the research passes [K unless noted]: MySQL about pool + 400 MB;
  Mongo cache + 400-500 MB; RabbitMQ absolute watermark about 0.4 x limit; Kafka heap + 400-600 MB;
  Neo4j heap + pagecache + 500 MB; OpenSearch heap about half the limit; Valkey `maxmemory` about
  75% of the limit (decision from the brokers pass).
- JVM heaps and Mongo/Meili/ClickHouse internal caps must sit below the container limit, or the
  OOM killer fires first. Set both the engine cap and the container limit.
- The idle footprints are rules of thumb; the plan's spike should measure them.

**Open questions.** Which key a Portainer CE stack honours. How to size the app container itself
(Node, Python, Java differ; `plan.yaml` needs a field and a default). How the edge (Caddy,
kamal-proxy, cloudflared) is counted. Whether to leave headroom for the OS (for example 256-512 MB)
and how big it is on each provider's smallest server.

## R8. Version pins and licences shown to the user

**Decision.**

- Every new image is pinned by digest through `pins.ts` and `scripts/update-pins.mjs`, with
  conservative defaults (the LTS line, or the line before the newest).
- Majors are the user's: extend Dependabot's no-major list to the database and broker images.
- Licences are shown at opt-in: SSPL (MongoDB), BSL (Redpanda), ELv2 (Elasticsearch), AGPL (Garage),
  GPL (Typesense, Neo4j).

**Rationale.** A tag moves; a digest does not. A major upgrade of a database or broker needs a data
migration, so a bot must not do it. Several of these licences restrict a use that does not apply to
the user's own app, but the user should hear that once, in plain English, before opting in.

**Alternatives considered.** Tags only (supply-chain risk, already ruled out in 012). Bitnami images
(gone). Following the newest line (Innovation releases, rapid releases).

**Key facts.**

- Defaults and where they come from: MySQL 8.4 (9.7 optional) [F]; MariaDB 12.3 LTS [F]; MongoDB 8.0
  (9.0 optional) [F]; RabbitMQ 4.3 [F]; NATS 2.15 alpine [F]; Kafka 4.x (4.3.1 or 4.2.2) [F];
  Redpanda v26.x [F]; OpenSearch 3.x [F]; Elasticsearch 9.x [F]; Meilisearch 1.x, pinned exactly
  because upgrades need dump and import [K]; Typesense 30.x [F]; ClickHouse `lts` [F]; Neo4j
  calendar versions [F]; Garage v2.4.1 [F]; supercronic v0.2.50 [F].
- Licence statements: SSPL FAQ [F] (see R2); Redpanda BSL [F] (R4); Elastic [F] (R5); Garage AGPL
  [F] (R3); Typesense GPL-3.0 [F] https://github.com/typesense/typesense ; Neo4j Community GPLv3 [K];
  Meilisearch MIT with BUSL Enterprise [F] https://github.com/meilisearch/meilisearch . GPL and AGPL
  apply to distributing the software, not to a separate service that the app talks to over a
  network (judgement, not legal advice).
- Image sources: official Docker Hub images where they exist (`mysql`, `mariadb`, `mongo`,
  `rabbitmq`, `nats`, `clickhouse`, `neo4j`); `apache/kafka`, `opensearchproject/opensearch`,
  `docker.elastic.co/...`, `getmeili/meilisearch`, `typesense/typesense`, `dxflrs/garage`,
  `docker.redpanda.com/redpandadata/redpanda` [F/K per section]. Never Bitnami.
- Do not use `latest` or rolling tags (`mysql:latest` is Innovation, `mongo:latest` is the newest
  major).

**Open questions.** Digest and architecture checks (amd64 and arm64) for each new image. Whether
Dependabot can watch Compose image tags OpsCrew writes into runtime templates, or only the pin file.
Which images ship signatures worth verifying.

## R9. Other Redis-protocol engines: Dragonfly, Redis 8, KeyDB (2026-10-20)

The founder asked why only Valkey (2026-10-20). Valkey stays the default; the rest is T1317.

**Dragonfly** (official docs and GitHub, checked 2026-10-20):
- **Licence:** BSL 1.1, becoming Apache 2.0 on 2030-11-01. Its additional use grant allows use inside one's own product as long as that product is not an in-memory data store service. Self-hosting it for the user's app fits. Quote the grant from https://github.com/dragonflydb/dragonfly/blob/main/LICENSE.md, not from a summary.
- **Release and image:** the latest is v2.0.2 (2026-10-07). The image is `docker.dragonflydb.io/dragonflydb/dragonfly`, with tags `vX.Y.Z`; `dragonflydb/dragonfly` is on Docker Hub too.
- **Memory:**
  - at least 256 MiB of `--maxmemory` per proactor thread, or it refuses to start (from third-party issues, consistent with each other);
  - `--proactor_threads` defaults to one per core, so both flags are always set. In a small container that means one thread;
  - its Docker page says "Minimum 4GB of RAM to get the benefits of Dragonfly".
- **Persistence:** snapshots with `--dir`, `--dbfilename` and `--snapshot_cron`. AOF was not confirmed.
- **Eviction:** none by default (`cache_mode=false`; writes fail at the limit); `--cache_mode=true` for a cache.
- **Auth:** `--requirepass`, or `DFLY_PASSWORD`.
- **Healthcheck:** the built-in one uses `nc`, but it has broken before (issues 3644, 2650), so test it on the pin. The default user is probably `dfly` (unconfirmed).
- **BullMQ** (https://www.dragonflydb.io/docs/integrations/bullmq):
  - `--cluster_mode=emulated --lock_on_hashtags`, with each queue's name or prefix in its own hashtag (`{myqueue}`);
  - or `--default_lua_flags=allow-undeclared-keys`, which "locks the entire data store for each Lua script execution".
  - Nothing was checked for Sidekiq, Celery or Laravel.

**Redis 8** (https://redis.io/legal/licenses/, the GitHub releases, Docker Hub):
- **Licence:** from Redis 8 on, the user's choice of RSALv2, SSPLv1 or AGPLv3. Running the unmodified image for one's own app carries no source obligation.
- **Release and image:** the latest is 8.10.2 (2026-09-17); pin `redis:8.10.2-alpine@sha256:…`.
- **Modules:** whether the official image includes Search/Query, JSON, Time Series, probabilistic structures and vector sets by default was NOT confirmed. Check locally with `MODULE LIST` and `COMMAND INFO FT.SEARCH` before relying on it.
- **Signals that an app needs those features** (from knowledge, to verify): `redis-om` (Node and Python), `@redis/search`, `@redis/json`, `@redis/time-series`, `@redis/bloom`, NRedisStack. `redis-py` and Jedis count only when the code calls `.ft()`, `.json()` or `.ts()`.
- **Valkey:** `valkey-bundle` has JSON, Bloom and Search (`FT.CREATE`, `FT.SEARCH`, `FT.AGGREGATE`, …). Command-level compatibility with Redis is not confirmed, and it has no Time Series. The plain `valkey` image has none of them.

**KeyDB:**
- **Status:** the last release was v6.3.4 (2023-10-30), with no commits after early 2024. It is BSD-3 and tracks Redis 6.
- **Founder (2026-10-20):** dropped as obsolete. An app whose compose runs KeyDB gets Valkey, which speaks the same protocol, with one line saying so.

## Open items for the plan's spike

1. Railpack: `docker inspect` a real image; check that `command: ["<one string>"]` starts a worker
   and that signals (SIGTERM) reach the process through `bash -c`.
2. Buildpacks: `entrypoint: ["/cnb/process/worker"]` from a Procfile; the launcher form for a raw
   command; the supercronic seal step on a non-root image.
3. kamal-proxy: run `kamal-proxy help deploy` and test two services on two hosts; test two hosts for
   one service.
4. Compose: confirm `mem_limit` (and `deploy.resources.limits.memory`) in `docker inspect` on
   Docker Compose v2 and on a Portainer CE stack.
5. Hetzner Object Storage price: settled. The official page gives it (R3); OpsCrew keeps a dated
   table, since `/v1/pricing` has none.
6. DigitalOcean: a live call to `/v2/spaces/keys` with a scoped grant; the Terraform provider
   bootstrap with no Spaces key yet.
7. R2: create a bucket-scoped token and compute the S3 secret (SHA-256 of the token value) on a real
   account.
8. MongoDB: single-node replica set init with Prisma; AVX preflight message on a CPU without AVX.
9. Measure idle and loaded memory for MySQL, Mongo, RabbitMQ, NATS, Kafka, and the part 2 engines on
   1, 2 and 4 GB servers; settle the limits and minimum servers.
10. Image facts per engine: user, `curl`/`wget` presence, healthcheck command, and digests on both
    architectures.
11. Own server with two apps: edge ownership, cloudflared ingress rules, destroy of the first and
    the last app, and drift.
12. `vm.max_map_count` through cloud-init and through the host plan; the Portainer refusal text.
13. supercronic: pin script with both SHA-1 and SHA-256; check the `ADD --checksum` build on
    amd64 and arm64.
14. Vercel crons: HTTP method and `CRON_SECRET` handling through the probe tool (no curl in the
    image).
15. Rails 8 SQLite paths in the Rails docs; Neo4j's current Docker Hub tags.

## Spike results (T1302, 2026-10-19, local Docker)

Raw record with commands and output: `.tools/scratch/013-spike-results.md` (gitignored). Engine:
Docker Desktop, cgroup v1; arm64 binaries were only hashed, not run; the AVX refusal could not be
tried (this CPU has AVX).

1. **Railpack.** Entrypoint `["/bin/bash","-c"]`, Cmd one string. `command: ["<one string>"]` runs;
   a list of words silently runs the wrong thing. `bash -c "a && b"` keeps bash as PID 1, which
   ignores SIGTERM (exit 137 after the grace period), so worker commands start with `exec`. Railpack's
   own `npm run start` drops SIGTERM before node too (012's Railpack Node web containers stop
   without the app's shutdown handler; a follow-up, outside 013's table).
2. **Buildpacks.** `entrypoint: ["/cnb/process/<type>"]` works for a Procfile type, with SIGTERM
   reaching it. A raw command: `entrypoint: ["/cnb/lifecycle/launcher"]` with `command: ["<one
   string>"]` (not `launcher --` with one string: exit 82; `launcher --` with `sh -c` also works).
   The seal with `ADD --checksum --chmod=755` supercronic keeps the launcher and user 1002.
3. **kamal-proxy v0.10.2.** Routing by host works; a host held by another service is refused.
   Several hosts per service work (`--host a,b` or repeated), and `--canonical-host` redirects.
   Routes survive a recreate only with a volume on `/home/kamal-proxy/.config/kamal-proxy`.
4. **Compose without Swarm.** `mem_limit` and `deploy.resources.limits.memory` both set
   `HostConfig.Memory`; Compose refuses differing values; the limit is enforced (OOM kill).
   `deploy.replicas: 2` gives two containers. Docker's default `MemorySwap` is twice the limit, so
   OpsCrew also sets `memswap_limit` to the same value.
5. **Portainer CE 2.45.2.** A standalone stack gives the same limits and replicas as Compose.
6. **supercronic v0.2.50.** SHA-1s match the release notes; SHA-256 amd64 `d2d7c97f…cdd0`, arm64
   `a1c0af98…99e2` (also in GitHub's release API). A wrong checksum fails the build. Overlapping
   runs are skipped. node `fetch`, python `urllib` and bash `/dev/tcp` all send the Bearer header
   with the query string intact. **`CRON_TZ` covers the whole crontab** (the last line wins), and on
   Alpine any zone but UTC makes supercronic exit: cron runs in UTC (as Vercel's does).
7. **Garage v2.4.1.** Single-node init: layout assign and apply, `key import --yes` (keys `GK` + 24
   hex, a 64-hex secret), `key allow --create-bucket`, bucket create and allow. The image has **no
   shell**, and each init step refuses a rerun, so the deploy script runs the steps through
   `docker compose exec` from the server's shell, checking each first. OpenTofu 1.13.1 with
   `hashicorp/aws` 6.69.1 (custom endpoint, `s3_use_path_style`, the skip flags) created a bucket
   and its CORS, a second plan showed no changes, destroy worked; the key was in no log or state.
   Idle 6–7 MiB.
8. **MongoDB 8.0.34.** `--replSet rs0 --wiredTigerCacheSizeGB 0.25` under 512m works; a separate
   init container waits, then `rs.initiate` with the service name as the member host (a rerun is
   harmless). With a root password and `--replSet`, mongod needs a **keyFile**: written into the
   configdb volume at start. Prisma 6 and driver transactions work only with the replica set. Idle
   148–157 MiB.
9. **Images** (amd64; user / process user; shell; wget; curl; healthcheck; idle memory):
   - MySQL 8.4.11: root / 999; bash; no; yes; `mysqladmin ping -h 127.0.0.1` (exits 0 even when the
     login is refused: liveness only); 435 MiB;
   - MariaDB 12.3.3: root / 999; bash; no; no; `healthcheck.sh --connect --innodb_initialized`;
     125 MiB;
   - MongoDB 8.0.34: root / 999; bash; no; no; `mongosh --quiet --eval "db.adminCommand('ping').ok"`;
     121 MiB with a 0.25 GB cache;
   - RabbitMQ 4.3.6: root / 999; bash; no; no; `rabbitmq-diagnostics -q ping`; 130 MiB;
   - NATS 2.15.1 alpine: runs as root; busybox sh; wget; no; `wget -q -O- http://localhost:8222/healthz`;
     7 MiB. Its default config carries a hard-coded cluster password: OpsCrew always mounts its own;
   - apache/kafka 4.3.1: 1000; bash; wget; no; `kafka-broker-api-versions.sh --bootstrap-server
     localhost:9092` (about 2 s, a JVM); 381 MiB with the default heap;
   - Redpanda v26.2.5: 101; bash; no; curl; `curl -fsS http://localhost:9644/v1/status/ready`;
     278 MiB (`--smp 1 --memory 1G --mode dev-container`);
   - Garage v2.4.1: root; no shell; `/garage status`; 6–7 MiB.
