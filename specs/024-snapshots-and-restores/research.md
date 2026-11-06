# Research: snapshots and restores as commands (024)

Research from 2026-11-06, the evening 0.2.4 shipped (the founder's go-ahead). Three Sonnet agents
read only official documentation; a Haiku agent mapped the code. "Unverified" marks a fact no
fetched official page stated; the spike (plan) checks each one that a design leans on.

The scope is the roadmap's 024 section:
- commands to take, list and restore snapshots of an environment's data or its whole server;
- every data kind and target 019's database rollback left out;
- a restore without a rollback;
- scheduled snapshots, and an opt-in encrypted copy off the server, so that an own server and
  Portainer get real backups.

## R1. Whole-server snapshots at the providers

| | Hetzner Cloud | DigitalOcean |
|---|---|---|
| Create | `POST /servers/{id}/actions/create_image` (`type: snapshot`, `description`, `labels`); async, poll `GET /actions/{id}` | `POST /v2/droplets/{id}/actions` `{"type":"snapshot","name":…}`; no labels (the name carries them); "roughly 2 minutes per GB used" |
| While running | the docs recommend shutting down first: a live disk "may not be readable" | "Recommended" to power off, especially with databases |
| List / delete | `GET /images?type=snapshot&bound_to=<id>&label_selector=…`; `DELETE /images/{id}`; snapshots outlive the server | `GET /v2/droplets/{id}/snapshots`; `DELETE /v2/snapshots/{id}` |
| Restore | `POST /servers/{id}/actions/rebuild` with `image`: powers off, wipes the disk, keeps the server ID (IPs, firewalls, networks on the same server: unverified); returns a `root_password` unless SSH keys are used | `type: rebuild` with `image`: wipes the disk, keeps the Droplet ID and IP; same OS family only; a backup must become a snapshot first |
| Price | "billed on a per GB basis" (rate on hetzner.com/cloud: unverified) | $0.06 per GB-month, $0.01 minimum |
| Volumes | not included | not included (volume snapshots are separate) |
| Terraform | `hcloud_snapshot` exists; `image` on `hcloud_server` forces replacement | `digitalocean_droplet_snapshot` exists; `image` forces replacement |
| Limits | 3600 requests an hour per project | 5000 an hour, 250 a minute (unverified) |

Consequences:
- A restore is a rebuild through the provider's API, never `tofu apply`: the server keeps its ID
  and address. The plan's `image` then differs from the state: `ignore_changes = [image]` or a
  refresh (to settle in the plan).
- The daily provider backups (Hetzner's 7, DigitalOcean's schedule) stay what they are; a rebuild
  accepts them too (DigitalOcean after converting one to a snapshot).
- A consistent snapshot stops the server for minutes.

What OpsCrew has (code map):
- `destroy` takes a snapshot before deleting a server (`agents/src/destroy/deletion.ts`
  `snapshotWanted`, `api.snapshotServer` ~619; record `.opscrew/<purpose>-snapshot.json`).
- The connectors create snapshots (Hetzner `createSnapshot`, DigitalOcean `snapshotDroplet`,
  `listDropletSnapshots`), but nothing lists Hetzner's or deletes either, and nothing rebuilds.
- Contract: `ServerSnapshotApi` (`contracts/src/connector.ts:104-114`).

## R2. A consistent copy of every other data kind

PostgreSQL, MySQL, MariaDB and MongoDB already dump while running (019). The others, from each
project's documentation, with OpsCrew's pinned versions:

| Kind | Online, while it runs | Config needed | Restore |
|---|---|---|---|
| SQLite (the app's `sqlite` volume) | Python's `sqlite3.Connection.backup` "works even if the database is being accessed by other clients": the official `python` image can run it | none; mount the volume | stop the app, replace the file (and its `-wal`/`-shm`), start (unverified) |
| Valkey, Redis 8 | `BGSAVE`, then copy `dump.rdb` ("never modified once produced") | persistence on (the queue mode has it) | stop, place `dump.rdb`, start (Redis's own page unverified) |
| Dragonfly | `SAVE`/`BGSAVE` to `--dir` (blocking or not: unverified) | none | stop, place the file in `dir`, start (it loads on start) |
| RabbitMQ | definitions only (export JSON); messages need the node stopped | none | copy the data dir back with the same node name |
| NATS JetStream | `nats stream backup` (unverified) | none (unverified) | `nats stream restore` into an absent stream |
| Kafka, Redpanda | none (Redpanda's routes need tiered storage) | — | stopped copy of the data dir |
| OpenSearch, Elasticsearch | snapshot API into an `fs` repository | `path.repo` and a mounted folder, then a restart | restore API (indices closed or deleted first: unverified) |
| Meilisearch | `POST /snapshots` (same version only) or `POST /dumps` | writable `snapshots/`, `dumps/` | restart with `--import-snapshot` (empty db) or `--import-dump` |
| Typesense | `POST /operations/snapshot?snapshot_path=…` | a writable mounted path | stop, swap in the data dir, start |
| ClickHouse | `BACKUP … TO Disk('backups', …)` | a `config.d` disk definition, a volume, a restart | `RESTORE` on the live server (refuses non-empty tables) |
| Neo4j Community | none: `neo4j-admin database dump` needs the DBMS stopped | — | `neo4j-admin database load`, stopped; users and roles not in the dump |
| Garage | none for data (metadata auto-snapshots only) | — | stopped copy of meta and data, then `garage repair` |

What OpsCrew has:
- 023's carrier (`connectors/docker/src/carrier.ts`) reads a stopped volume or bind folder as tar,
  writes one exactly (emptying it first) and hashes it, over SSH (`dial-stdio`) or Portainer's
  Docker proxy.
- 023's window stops a service with `-t 120` and checks it exited cleanly.
- Every kind's data folders are in `iac-templates/src/catalog/entries.ts`.
- The app's own files: the `sqlite` volume only; uploads go to object storage.

## R3. The encrypted copy off the server

**Encryption.**
- age to a public key: the server holds only the recipient (`age1…`), so a compromised server
  reads nothing already uploaded. It streams (`dump | age -r … | rclone rcat`).
- No official container image exists; the release binaries are verified with Sigsum. OpsCrew
  would pin the binary and its SHA-256 itself.
- rclone `crypt` would keep a symmetric password on the server, which defeats the point.
- OpsCrew's recovery copy is already SOPS-encrypted to the age recipients in `opscrew/.sops.yaml`
  (`agents/src/secrets/*`, `core/src/crypto/age.ts`), and the user holds that key file. The
  off-server copy can use the same recipient, so one key the user already keeps restores both.

**Upload.** rclone is pinned (`rclone/rclone:1.75.2`, 023's bucket move: keys on stdin,
`--tmpfs /tmp`).

**Retention.** S3 lifecycle `Expiration.Days` by prefix:
- R2: yes (`PutBucketLifecycleConfiguration`; needs a token that can write the configuration);
- Spaces: yes (time-based);
- Hetzner: "automatic object expiry" on the product page, `Expiration.Days` unverified.

**The least-power key.**
- R2 tokens and Spaces keys can be limited to one bucket. Hetzner keys cover the project, limited
  by a bucket policy.
- No provider documents write-only keys, so the server's key can probably delete.
- Versioning or object lock where offered (Hetzner both, Spaces versioning, R2 unverified).

**Cost.**
- R2: $0.015 per GB-month, free egress, 10 GB free.
- Hetzner: €6.49 a month with 1 TB stored and 1 TB egress.
- Spaces: $5 a month with 250 GiB and 1 TiB egress.

## R4. Scheduling

013's cron service runs the app image with supercronic (`runtime/components.ts` `cronStart`,
`renderProcesses`; the crontab in UTC, a file on a server, a config in Portainer's stack). A
`snapshots` service on the same pattern would schedule them on every server target and on
Portainer alike, with no host timer. It needs its own image (the dump tools, rclone, age), not the
app's.

## R5. What design and advise do today

- The interview asks how bad losing data would be (`interview/questions.ts` `dataCriticality`).
- Design turns on the cloud provider's backups when it matters (`design/options.ts:133`), and
  says backups are the user's on Portainer (`design/portainer.ts:29`) and on their own server.
- Advise proposes turning backups on (`advise/rules/reliability.ts` `backupProposals`).

## R6. The founder's decisions (2026-11-06)

1. **Services without a safe online copy** (RabbitMQ's messages, Kafka, Redpanda, Neo4j, Garage,
   OpenSearch and Elasticsearch, and the other engines OpsCrew doesn't configure for their own
   snapshot APIs): a snapshot stops only that service for its copy (023's clean stop and carrier).
   A snapshot taken by hand shows and approves the stop; a scheduled one leaves such a service out
   unless the user opts it in per service. SQLite, Valkey, Redis, Dragonfly and the four databases
   are always copied while they run.
2. **A whole-server snapshot is live by default**; `--stop` stops the server first for a
   consistent one. Whole-server snapshots are taken by hand only.
3. **The off-server copy is encrypted to the recovery copy's age key**, the one the user already
   keeps: one key restores both, and the server only ever holds the public half.
4. **Scheduled snapshots' defaults:** weekly, the last 4 kept on the server, the off-server copies
   kept 90 days; each changeable in the plan.
