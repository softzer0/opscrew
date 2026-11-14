---
name: opscrew-snapshots
description: Back up and restore the data of an app OpsCrew deployed, with OpsCrew's snapshots: see which snapshots exist (read-only), and guide the user through taking one before a risky change, putting one back, deleting one, a snapshot of the whole server at Hetzner or DigitalOcean, scheduled snapshots and an encrypted copy off the server, each run in their own terminal. Use when the user asks "is my data backed up?", "back up my database", "take a snapshot", "restore yesterday's data", "I deleted rows by mistake", "what snapshots do I have?", "schedule backups", "keep a copy somewhere else", "what if the server dies?", or about backups on their own server or Portainer.
---

# Snapshots and restores with OpsCrew

A snapshot copies every service of an environment that keeps data (its databases, caches, queues
and search engines, listed under "Taking one") and the app's SQLite files, in one folder named by
its UTC time (`20261106T190000Z`, its id), with the version that ran recorded beside it. It is
filed where the data lives: on the app's servers (a database on another server keeps its part
there), on this computer, or in the stack's snapshots volume of the user's Portainer.

Only looking happens through a tool. **Taking, restoring and deleting a snapshot, and turning the
schedule or the off-server copy on or off, stay in the user's terminal**, because each asks for
their approval. Never run them through a tool, never type a confirmation for them, and never pass
`--confirm`, `--approve` or `--allow-downtime` on their behalf.

## Looking: which snapshots exist

- Call `opscrew_snapshots` (read-only, with `app` and `environment` when the repository has several).
  Each snapshot has its id, kind (by hand, before a release, scheduled, whole server), time, the
  version that ran, size, its services (copied, left out or failed), where it is, and whether its
  encrypted copy off the server exists. On the user's own server it reads only once the server's
  SSH host key was confirmed in a terminal.
- Copies only the off-server bucket or folder still holds (their server was lost) are encrypted, so without
  the user's key OpsCrew names only their ids. In the terminal,
  `npx opscrew snapshot list --key-file <age key file>` lists them with their details.
- `opscrew_status` names the last snapshot with its time and result, and a scheduled snapshot that
  failed, with where its log is.
- Never claim a snapshot exists that the tool didn't list.

## Taking one

The user runs `npx opscrew snapshot` (add `--env <name>`, and `--app <key>` for a further app).

- PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Valkey, Redis and Dragonfly are copied while they
  run, with no interruption.
- Every other service with data (RabbitMQ, NATS, Kafka, Redpanda, OpenSearch, Elasticsearch,
  Meilisearch, Typesense, ClickHouse, Neo4j, Garage) has no safe online copy: it stops alone for
  its copy and starts again. The summary names it and how long, and the user approves that stop
  first. `--skip <service>` leaves a service out; in a script `--allow-downtime` approves the stop.
- It needs 1 GiB and 10% of the disk free, and it is refused while a deploy or a move runs: pass on
  what the refusal says to do.
- Uploads in object storage (the app's buckets) are never in a snapshot.

## Putting one back

The user runs `npx opscrew restore <id>` with the id `opscrew_snapshots` shows.

- Before they run it, say plainly what it loses: **everything written since the snapshot** in each
  service it restores. The approval is like a destroy: the user types the app's name (in a
  script, `--confirm <app name>` with `--approve <hash>` from an earlier run; never `--yes`).
- Requests are held and the app stops while the data goes back; then the app starts again. The
  version that runs never changes. A copy is taken just before, and put back if the restore fails.
- `--only <service>` restores one service.
- A snapshot taken while another version ran is refused: the way back to that version with its
  data is `npx opscrew rollback --to <that version> --database snapshot`.
  `--allow-other-version` restores the data alone; suggest it only when the user knows the schema
  didn't change in between.
- `--from offsite --key-file <age key file>` restores the encrypted copy off the server (below), for
  example onto a new server after the old one was lost: this computer downloads and decrypts it, so
  the server never holds the key.

## Deleting one

`npx opscrew snapshot delete <id>` removes it for good after the user types its id, with its
encrypted copy off the server. A whole-server snapshot is deleted at its provider.

## A snapshot of the whole server

On a server OpsCrew created at Hetzner, DigitalOcean or Contabo, `npx opscrew snapshot --server`
has the provider snapshot the server's whole disk while it runs; a live snapshot may not be
consistent, and `--stop` shuts the server down for it, after the user approves that downtime. At
Hetzner and DigitalOcean it costs a monthly price (the summary shows it), and volumes attached to
the server are not in it. `npx opscrew restore --server <id>` rebuilds the server from it in place,
keeping its address, after the user types the server's name; everything written on it since is
lost, and OpsCrew then checks that the app answers. On the user's own server or Portainer
`--server` is refused: the data snapshot is the one to use there.

On Contabo:

- Snapshots cost nothing extra up to the plan's count (1 on Cloud VPS 4, 2 or 3 on larger plans),
  including those taken in Contabo's panel. At the limit OpsCrew refuses and names the one to
  delete.
- Restoring a snapshot that is not the newest deletes the newer ones at Contabo; OpsCrew says so
  before the user approves.
- A snapshot's id is `<instance>:<snapshot>`; pass it whole.
- Contabo's snapshots go with the server when its term ends, and Contabo doesn't say whether its
  Auto Backup (on by default in prod) outlives it. The data snapshot with its copy off the server is
  the copy that stays, and the way to a Contabo server of another size (a plan can't be resized in
  place; the other way is `npx opscrew retarget` to another provider): take one,
  `npx opscrew destroy`, design and provision the new size, then
  `npx opscrew restore <id> --from offsite --key-file <path>`.

## Scheduled snapshots

`npx opscrew snapshot schedule on` writes the schedule into the plan: weekly by default
(`--every daily|weekly|<n>h`), the last 4 kept (`--keep <n>`), leaving out the services that would
have to stop unless the user names them (`--stop <service>`). Nothing changes until the user runs
`npx opscrew provision`, which sets it up on the servers or in the Portainer stack. In Portainer only
the services copied while they run are scheduled. There is no schedule on this computer.
`npx opscrew snapshot schedule off` and a provision remove it; the snapshots it took stay until
deleted.

## An encrypted copy off the server

A snapshot stays on the machine that holds the data, so it is lost with that machine. The real
backup is the copy off it, with `--days <n>` to keep each copy other than 90 days:
- `npx opscrew snapshot offsite on --to r2|hetzner|digitalocean` (with `--region` at Hetzner or
  DigitalOcean): a bucket of its own. `npx opscrew provision` then shows it with its expected
  monthly cost for the user's approval by its hash.
- `--to s3 --endpoint https://… --bucket <name> [--region <r>]`: the user's own S3-compatible
  bucket (Wasabi, Backblaze B2, MinIO, AWS S3, Contabo). OpsCrew prices nothing and never creates
  or deletes it; provision asks for its key in the terminal (or `OPSCREW_OFFSITE_ACCESS_KEY_ID` and
  `OPSCREW_OFFSITE_SECRET_ACCESS_KEY`).
- `--to sftp --host <h> [--port <p>] --user <u> --path /<folder>`: a folder on the user's own
  machine. The user makes an account of its own and a key without a passphrase, puts its public
  half in that account's `authorized_keys`, and sets `OPSCREW_OFFSITE_SFTP_KEY` to the private key
  file. `offsite on` shows the machine's host key fingerprint to confirm in the terminal (in a
  script, `--host-key SHA256:…`). Copies go to `<path>/<app>-<env>/backups/`.

Each writes the plan. On the user's own storage, provision checks that the server can write and
delete a test file there before it stores the deploy secrets, and says what to fix when it can't.
From then on every snapshot taken by hand or on the schedule is encrypted on the server to the
recovery copy's age key and uploaded.

- The server holds only the public key; the user's age key file opens the copies. They must keep
  it, and keep the old one after `npx opscrew rotate recovery-key`: copies made before stay
  readable only with it. Never ask for the key or its file's contents in the chat.
- The login can also delete: a bucket's access key, or an SFTP account that can write. Only at
  Hetzner is versioning on, keeping what was deleted or overwritten for `--days` more.
- At Hetzner and R2 the bucket's lifecycle rule expires each copy after `--days`. On DigitalOcean
  Spaces and the user's own bucket or machine only the server deletes old copies, after each upload.
- `npx opscrew snapshot offsite off` stops new uploads. The bucket or folder stays, and its copies
  until they expire at Hetzner and R2; elsewhere they stay until the user deletes them. OpsCrew
  never deletes them, not even with `destroy --delete-data`.
- Never ask for a bucket's key or the SFTP private key in the chat.

## Their own server or Portainer

There is no provider backup there. For data that matters, suggest scheduled snapshots with the
copy off the server, as `npx opscrew design` and `opscrew_advise` propose. Backing up the server or
the Portainer host itself stays the user's responsibility.
