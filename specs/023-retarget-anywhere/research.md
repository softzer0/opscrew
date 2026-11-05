# Research: retarget anywhere (023)

The founder agreed to the scope on 2026-10-20 ("moving from every to every provider no matter which
should be supported"), and gave the go-ahead on 2026-11-05, after 022's opt-ins. It ships in one
release with those opt-ins. Sources are official docs only; anything they don't state is marked
**Unconfirmed** and goes to the spike (R4).

## R1. Outside facts (2026-11-05)

### R1.1 Copying a service's data

The catalog's pinned versions: Valkey 8, Redis 8, Dragonfly 2, MySQL 8.4, MariaDB 12.3,
MongoDB 8.0, RabbitMQ 4.3, NATS 2.15, Kafka 4.3, Redpanda 26.2, Garage 2.4, OpenSearch 3.9,
Elasticsearch 9.5, Meilisearch 1.55, Typesense 30.2, ClickHouse 26.3, Neo4j 2026.09.

- **Some kinds have no online route.** Each of these needs the service stopped and its data
  directory copied:
  - Neo4j Community: `neo4j-admin database dump` runs only offline, and the dump has no users
    (neo4j.com/docs/operations-manual/current/backup-restore/offline-backup/).
  - Garage: stop, then copy the metadata and data directories together; keys and buckets live in
    the metadata (garagehq.deuxfleurs.fr/documentation/operations/recovering/).
  - RabbitMQ with its messages: "stop the node and copy the data directory", and the node name
    must stay the same (rabbitmq.com/docs/backup). Definitions alone carry no messages.
  - Kafka (KRaft): no official backup tool. The documented ways are a copy of the stopped
    broker's log directory, with its `meta.properties`, or MirrorMaker 2, which copies topics only
    (Unconfirmed: the Kafka docs pages didn't render).
  - Redpanda: the vendor's recovery features need Tiered Storage or an Enterprise licence
    (docs.redpanda.com/current/manage/disaster-recovery/). The free routes are MirrorMaker 2 and
    Redpanda Migrator, topics only. A copy of the stopped data directory is Unconfirmed as
    documented.
- **The other kinds have online dumps or snapshots,** each with its own tool, format and user
  handling:
  - MySQL and MariaDB: `--single-transaction` dumps, consistent for InnoDB only; accounts come
    along and replace the new container's.
  - MongoDB: `mongodump --archive --oplog`; users come along, and the restore must log in as the
    source's user.
  - Valkey, Redis and Dragonfly: `SAVE`, then copy the RDB or `.dfs` file; the target must be
    stopped to load it, and AOF wins over RDB when it is on.
  - OpenSearch and Elasticsearch: snapshots to an `fs` repository, which needs `path.repo` set on
    both sides; not point-in-time across shards.
  - Meilisearch: a snapshot (same version only) or a dump.
  - Typesense: `POST /operations/snapshot`.
  - ClickHouse: `BACKUP ALL`, which needs a configured backups disk; `SYSTEM RELOAD USERS` before
    26.10.
  - NATS: `nats stream backup` per stream, with the CLI in a separate container.
  - SQLite: `.backup` or `VACUUM INTO`, never a plain copy in WAL mode (sqlite.org/backup.html).
- **A stopped service's data directory is consistent** for every kind: each one flushes on a clean
  stop. The same image version on both sides reads it, and both architectures OpsCrew uses (amd64
  and arm64) are 64-bit little-endian. Unconfirmed for each kind's own files; the spike checks the
  catalog.
- The full notes are in the lead's scratch file. Their decisions are in R3.

### R1.2 Docker's archive API, and Portainer

- `GET` and `PUT /containers/{id}/archive?path=` stream a tar of a path in a container, including
  its mounted volumes. The container may be stopped or only created; `docker cp` uses this API
  (docs.docker.com/reference/api/engine/version/v1.43/). So a stopped service's volume can be read
  and written without a shell, an exec or an extra image.
- Portainer CE 2.33.1 (OpsCrew's pin) forwards the Docker Engine API at
  `/api/endpoints/{id}/docker/...`. An access token (`X-API-Key`) has the user's own access
  (docs.portainer.io/api/access). Portainer documents neither the proxy's limits, nor which calls
  it filters, nor whether a non-admin token may use them (Unconfirmed: spike S2).
- Edge Agent environments open a tunnel on demand, about 10 s, closed after 5 minutes idle
  (docs.portainer.io/advanced/edge-agent). Async Edge has no live proxy (Unconfirmed).

### R1.3 Buckets

- No server-side copy works across providers. rclone copies through the machine that runs it
  (`rclone copy`, `--checksum`, `--metadata`; `sync` can delete at the destination). rclone's
  `--server-side-across-configs` helps only within one backend (rclone.org/commands/rclone_sync/).
- **Egress** (2026-11-05):
  - Hetzner Object Storage: ingress and operations free; about 1 TB of traffic a month included
    in the base price, and beyond it Unconfirmed (docs.hetzner.com/storage/object-storage/overview).
  - DigitalOcean Spaces: $5 a month with 1,024 GiB outbound, then $0.01/GiB; inbound free
    (docs.digitalocean.com/products/spaces/details/pricing/, verified 2026-10-26).
  - R2: no egress fee; writes are Class A at $4.50 per million
    (developers.cloudflare.com/r2/pricing/).
- A bucket's size and object count come from listing it (`ListObjectsV2`, 1,000 keys a call) or
  `rclone size`. No provider metric was found.

## R2. What OpsCrew has to build on (code map, 2026-11-05)

- **`opscrew retarget`** (`agents/src/retarget/`) moves an app between Hetzner and DigitalOcean in
  steps kept in `plan.retarget.step`: `started`, `renamed` (the old server module renamed in
  state), `created`, `deployed`, `migrated` (the maintenance window), then `switched`.
  `--finish` deletes the old server after a typed confirmation and an optional snapshot;
  `--abort` undoes the move. Every IaC plan is approved by hash (`plans.ts`); the window's commands
  are a `remote-exec` approval, with `--allow-downtime` in a script.
- **The window** (`window.ts`) copies only Postgres:
  - It stops the old app, runs `pg_dump -Fc`, copies the dump with `scp -3` through this computer
    (`server-ops.ts` `copyDump`), and checks it (`verifyDump`).
  - Then it runs `pg_restore --single-transaction`, the release command, and the new app's health
    check.
  - `rollBackWindow` restarts the old app; `recoverInterruptedWindow` resumes after a crash.
  - Valkey starts empty, and the summary warns.
- **Refused today** (`start.ts`):
  - Portainer, localhost, own servers and sites (`shared/vps-target.ts`);
  - self-hosted monitoring, split placement (`plan.servers`), stateful kinds other than Postgres
    and Valkey, and SQLite (`requireMovableData`);
  - a closed public SSH, and the same provider;
  - previews (022).

  The sites', monitoring's and split placement's messages say "comes with retarget anywhere".
- **`move`** (`agents/src/move/`, a service moved between one app's servers) shares `server-ops`
  and copies Postgres only.
- **Generic:**
  - `providerProfile` and `vpsConnector` (hetzner, digitalocean, own);
  - own servers' addresses in `.opscrew/server.json`, and the own-server host plans
    (`provision/own.ts`);
  - Portainer stacks through `planStacks` and `applyStackPlan`. The Portainer client has no
    exec, archive or one-off container.
- **Buckets:** `plan.storage.objectStorage` (`providerBucket`: r2, digitalocean, hetzner) in the
  `storage` root, with its key kept by the user (`requireStorageKey`). Retarget today keeps the
  bucket where it is.
- **Tests:**
  - unit tests in `retarget/*.test.ts` and `move/*.test.ts`;
  - a non-interactive e2e with fakes, `cli/test/e2e/retarget.test.ts`;
  - a live Hetzner to DigitalOcean move, `cli/test/live/live.test.ts` (`retargetUntilDone`).

## R3. Lead decisions for the spec

1. **Every server target to every other.** Hetzner, DigitalOcean, the user's own server and the
   user's Portainer, in any direction. That includes moving from one server of the user's to
   another, and from one Portainer environment to another. A move within one cloud provider stays
   out: another size is advise's, and another location is a new server. The steps stay as today:
   1. start: pick the new target;
   2. prepare it: on a cloud provider, rename and create; on the user's own server, record,
      inspect and set up the host; on Portainer, the environment and its stacks;
   3. deploy and check there;
   4. the window;
   5. switch;
   6. `--finish` or `--abort`.
2. **Sites move too:** between Cloudflare's hosting and GitHub Pages, wherever design offers the
   new host for the app. A site has no data, so there is no window: provision the new one, check
   it, switch DNS. At `--finish` the old Worker or Pages site goes. Between a site and a server the
   app's whole design changes, so that stays out (later; plan review, 2026-11-05).
3. **This computer stays out.** It runs a copy for trying changes, not a deployment to move:
   `env remove`, then `env add`.
4. **One way to copy a service's data: its stopped volumes, through Docker's archive API.**
   - Postgres keeps its dump, which is already built and checked, and tolerates versions.
   - Every other stateful service, and the app's own volumes (SQLite files, uploads), is copied in
     the window:
     1. Once the old app has stopped, each service stops cleanly.
     2. Each of its volumes streams as a tar from the old side into the new side's service, which
        is created but not started, with a SHA-256 checked on both ends.
     3. Then the services start, then the app.
   - The plan pins the image versions, so both sides run the same ones.
   - The same calls work over SSH (`docker system dial-stdio`) and through Portainer's Docker
     proxy, so the copy has one shape everywhere. It streams through this computer, as the dump
     does, and is never stored there.
   - A pinned `busybox` carrier container empties and hashes a volume, since a service's image
     may lack the tools (plan review).
   - Rejected: a dump tool for each kind. That would be 17 tools, each with its own handling of
     users and consistency (R1.1).
5. **A choice for each service: copy (the default) or start empty.** `--empty <service>` in a
   script, or a question for each service. The summary says when empty is usually fine (a cache,
   or a search index the app rebuilds) and what is lost otherwise (queued jobs, messages, history).
6. **Buckets.**
   - **When it moves:** a bucket at the provider being left moves to the new provider's storage
     when the new target is a cloud provider with object storage (Hetzner and DigitalOcean).
     `--keep-bucket` keeps it where it is.
   - **How:**
     1. A new bucket, through the `storage` root and an approved plan.
     2. A first copy before the window, with rclone in a one-off container on the new server. Its
        keys go in on standard input and are removed afterwards.
     3. A last copy in the window.
     4. The app's settings switch to the new bucket.
     5. The old bucket is deleted at `--finish`, with a typed confirmation of its own.
   - **Shown first:** the size, the object count, the time and the egress cost.
   - **When it stays:** R2 stays, since it's Cloudflare's. A move to the user's own server or
     Portainer keeps the bucket, and says it keeps billing at the old provider. Garage is a
     service, copied as volumes.
7. **The user's own server, on either side.**
   - As the new target, the user names it (address, login) as `interview` asks. OpsCrew inspects
     it and sets it up with the own-server host plan.
   - As the old target, `--finish` removes the app from it: its containers, its volumes after the
     typed name, its site and its route. Never the server itself.
8. **Portainer, on either side.**
   - Stacks go through the existing stack plans.
   - The window stops and starts stacks through Portainer, and copies volumes through its Docker
     proxy (spike S2).
   - As the old target, `--finish` removes the app's stacks and volumes (typed name), never
     Portainer or its environment.
9. **Split placement and self-hosted monitoring.**
   - Extra servers stay where they are, and only the app server moves. The new app server joins
     the app's private network as a new member, as 018 adds a server. The services on it move
     with their data, and the old app server leaves the network at `--finish`.
   - Monitoring on the app server moves with its data, or starts empty. On a server of its own it
     stays, and the new app server's Alloy sends to it.
   - To keep a service at the old provider, place it on an extra server first (018's move), then
     retarget. No special mode.
10. **Unchanged:**
    - every plan approved by hash, and `--allow-downtime` in a script;
    - the window's rollback, and the typed confirmation at `--finish`;
    - previews refused, since their environment is made anew;
    - public SSH open on SSH targets for the window.

## R4. Spike questions (before the code depends on them)

- **S1:** a stopped-volume copy for each catalog kind, amd64 to arm64 and back, with the pinned
  images. Does the service start on the copy with its data, users and passwords? Run in Docker.
  (RabbitMQ's node name and Kafka's `meta.properties` are the known traps.)
- **S2:** Portainer 2.33.1's Docker proxy:
  - archive `GET` and `PUT` of a 1 GB volume through a created container;
  - creating, starting and stopping a stack's containers;
  - a token without admin rights;
  - an Edge Agent environment.
- **S3:** rclone between Hetzner Object Storage and DigitalOcean Spaces, from a one-off container
  with keys on standard input: the time for the first pass and for the last one; the pinned image.
- **S4:** the own-server host plan on the new side while the old cloud server still serves; and
  the private network with an app server leaving and joining.

## R5. Spike results

### S2: Portainer's Docker proxy (2026-11-05, a local Portainer CE 2.33.1)

- **Reading a volume:** `GET /api/endpoints/{id}/docker/containers/{id}/archive?path=/data` on a
  stopped container streamed a 1 GiB volume (random data, a uid 999 mode 600 file, a 1000:1001
  folder, a symlink) in 38 s, about 28 MB/s. `docker cp` took 8.8 s on the same data. Owners,
  modes and links survived.
- **Writing a volume:** `PUT .../containers/{id}/archive?path=/`, with `Content-Type:
  application/x-tar`, into a created container that never started, on a fresh volume, took 39 s.
  The tar's `data/` prefix landed in the `/data` mount, and the hash, owners and modes matched.
  `copyUIDGID=1` changed nothing visible.
- **Lifecycle:** `POST .../start` and `.../stop` return 204, and a created container starts through
  the proxy.
- **Limits:** a single 1 GiB request in each direction met no size limit, chunking or timeout. A
  client must not set a short timeout, since the time grows with the size.
- **Tokens:**
  - A standard user's token works once the user has access to the environment.
  - It reaches only containers that user created, and only by id: on others it gets 403, or 500
    "Mime: no media type".
  - Portainer CE's defaults let a standard user bind-mount host paths, so such a token is
    root-equivalent anyway. OpsCrew already treats the Portainer token as one.
- **Not checked:** Edge Agent environments, and containers that a stack created (the spike made
  its own). The live pass covers stacks; Edge stays refused for the window until checked.
