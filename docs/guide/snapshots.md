# Snapshots and restores

A snapshot is a copy of an environment's data at one moment: every database, cache, queue and
search engine next to your app, the app's own [SQLite](databases.md#sqlite) files, and its
[kept folder](components.md#the-apps-kept-folder). Take one before a risky change, restore it
without changing the version that runs, take them on a schedule, and keep an encrypted copy of
each off the server, so that losing the server doesn't lose your data.

```bash
npx opscrew snapshot                          # a snapshot of the environment's data, now
npx opscrew snapshot list                     # every snapshot, newest first
npx opscrew restore <id>                      # put a snapshot's data back
npx opscrew snapshot schedule on --every daily   # snapshots on a schedule, from the next provision
npx opscrew snapshot offsite on --to r2       # an encrypted copy of each in a bucket of its own
npx opscrew snapshot --server                 # the provider's snapshot of the whole server
```

Like every command, they take `--app <key>` and `--env <name>` for
[another app](several-apps.md) or [environment](environments.md).

## What a snapshot holds, and where it is

A snapshot holds one file for each service that keeps data, one for the app's SQLite volume, and
one for its kept folder:

| Kind | How it is copied |
|---|---|
| [PostgreSQL](https://www.postgresql.org/), [MySQL](https://www.mysql.com/), [MariaDB](https://mariadb.org/), [MongoDB](https://www.mongodb.com/) | A dump with the database's own tool, while it runs |
| [Valkey](https://valkey.io/), [Redis](https://redis.io/), [Dragonfly](https://www.dragonflydb.io/) | A copy of its data file, while it runs |
| The app's SQLite volume | Every SQLite database in it through SQLite's backup API, and its other files as they are, while the app runs |
| The app's kept folder (`storage.files.dir`: a plain PHP app's `storage/`, [Laravel](https://laravel.com/)'s `storage/app`) | Its files as they are, in one archive, while the app runs |
| Every other service with data: RabbitMQ, NATS, Kafka, Redpanda, OpenSearch, Elasticsearch, Meilisearch, Typesense, ClickHouse, Neo4j, Garage | That service alone stops, its files are copied, and it starts again |

A snapshot's id is the UTC time it was taken, for example `20261106T190000Z`. It records the
version that ran (the image digest), and each service's size and file. It stays on the machine
that holds the data:

| Where the app runs | Where its snapshots are |
|---|---|
| A server OpsCrew created, or [your own](own-server.md) | `.snapshots` in the app's folder, for example `/srv/apps/shop-staging/.snapshots` |
| A database on [another server](split-placement.md) | On that server, in its own `.snapshots`; the snapshot names where each part is |
| [Your computer](localhost.md) | `.snapshots` in the app's folder, `~/.opscrew/local/srv/apps/<app>/.snapshots` |
| [Your Portainer](portainer-target.md) | The stack's `snapshots` volume, `opscrew-<app>_snapshots` |

Only the deploy user can read the files. No password is ever on a command line, and nothing a
snapshot copied is ever printed. Two apps on one server each have their own snapshots.

A snapshot on the server is not a backup: it goes with the server. Keep
[an encrypted copy off the server](#an-encrypted-copy-off-the-server) for that.

## Taking one

```bash
npx opscrew snapshot --env staging
npx opscrew snapshot --skip kafka        # everything but kafka
```

First, OpsCrew checks the disk that holds the snapshots: with less than 1 GiB or 10% free, it
takes nothing and says how much space is needed. Then it shows what it copies:

```text
The snapshot of staging copies:
- db (PostgreSQL) on the app's server, while it runs
- queue (Valkey) on the app's server, while it runs
- sqlite (the app's SQLite files) on the app's server, while it runs
- files (the app's kept folder) on the app's server, while it runs
- kafka (Kafka) on the app's server: it stops alone for its copy (up to 120 seconds to stop cleanly, then as long as copying its files takes) and starts again
```

When a service must stop for its copy, OpsCrew asks you to approve that first, as a maintenance
window. Only that service stops, one at a time; the app and every other service keep running. In
your Portainer, the summary also shows the size of its data. In a script, `--allow-downtime`
approves the stop; without it, a script stops before anything stops. `--skip <service>` (repeat it
for several) leaves a service out.

OpsCrew refuses a snapshot while a deploy of the environment is queued or running, and while the
app [moves](retarget.md). Let the run end, then try again.

## Listing and deleting

```bash
npx opscrew snapshot list
npx opscrew snapshot list --json
```

```text
20261106T190000Z: by hand, 2026-11-06 19:00 UTC, version sha256:ab12cd34ef56, 1.2 GB, db, queue, sqlite, on the app's server, copied off the server
```

Each snapshot is listed once, newest first, with its kind (`by hand`, `before a release`,
`scheduled`, `whole server`), its time, the version that ran, its size, the services it holds, the
ones left out, and where it is. `--json` gives the same. The list changes nothing.

The list also reads the [off-server bucket](#an-encrypted-copy-off-the-server) and names the
copies that only the bucket still holds, for example after the server was replaced. Their records
are encrypted: add `--key-file <path>` with your age key to list what they hold.

```bash
npx opscrew snapshot delete 20261106T190000Z
```

`delete` removes the snapshot for good: where it is, its copy in the off-server bucket, and a
whole-server snapshot at its provider. You type its id to approve it (in a script, see
[In a script](#in-a-script)).

## Restoring

```bash
npx opscrew restore 20261106T190000Z
npx opscrew restore 20261106T190000Z --only db
```

A restore puts the snapshot's data back exactly as it was and keeps the version that runs. While
it runs, the app's requests wait and the app stops until its data is back:

1. OpsCrew reads the snapshot and checks it, before any change (see below).
2. It asks you to approve the restore, like a [destroy](environments.md#removing-an-environment):
   it says what is lost, everything written since the snapshot, and you type the app's name
   (`shop-staging` for staging, `shop` for prod).
3. It holds the app's requests and stops the app.
4. It copies the data as it is now, as a new snapshot, then puts back each service in the
   snapshot.
5. It starts the app and lets the held requests through.

When it is done, it names the snapshot it took just before, so `opscrew restore` can put that back
too. `--only <service>` puts back only that service, and `--only files` only the kept folder. In a script, see [In a script](#in-a-script).

### The version rule

Data is restored under the version it was taken with:

- **A snapshot of another version** is refused before any change, because its data may not fit
  the version that runs now. The message names
  `opscrew rollback --to <that version> --database snapshot`, which goes back to that version with
  its data (see [Rolling back a release](rollback.md#the-database)).
- **`--allow-other-version`** puts back the data alone and keeps the version that runs. It also
  restores a snapshot that records no version (one taken before the first deploy).
- **A service that stops for its copy** (Meilisearch, for example) must run the same image as when
  it was copied: its files may not open in another version. Otherwise it is refused; restore the
  others one at a time with `--only`.
- **On your computer,** each local build gets a new image, even from the same code, so a restore
  there often needs `--allow-other-version`. The message says so.

### When a restore fails

- **The put-back works:** OpsCrew puts back the copy it took just before the restore, starts the
  app on it, and says nothing changed.
- **On several servers:** when one fails, OpsCrew also puts back what it had restored on the
  others, under the same approval.
- **The put-back fails too,** or a server stops answering: the data may be partly changed, so the
  app stays stopped and no version runs on data that doesn't match. The message names each
  server's copy from just before (`opscrew restore <id>`). Once the cause is fixed, restore it:
  that starts the app again.

## Whole-server snapshots

On a server OpsCrew created at [Hetzner Cloud](https://www.hetzner.com/cloud),
[DigitalOcean](https://www.digitalocean.com/) or [Contabo](contabo.md), the provider can also
snapshot the whole disk:

```bash
npx opscrew snapshot --server                      # while the server runs
npx opscrew snapshot --server --stop               # shut it down for the snapshot, then start it
npx opscrew snapshot --server --server-name data   # one of the app's other servers
npx opscrew restore --server <id>                  # rebuild the server from it
```

- **Taken live by default.** OpsCrew first writes what the server holds in memory to its disk, so
  the data your app saved is in the snapshot; data being written at that very moment can still be
  incomplete. `--stop` shuts the server down first and starts it after; you approve that downtime
  first (`--allow-downtime` in a script).
- **Its price:** the summary shows the provider's rate and the most the snapshot can cost a month.
  After it is taken, OpsCrew shows its billed size and monthly price. It stays at the provider
  until you delete it.
- **Volumes** attached to the server are not in it.
- **Restoring rebuilds the server in place** from the snapshot: its disk is replaced, so everything
  written since, the app's data, version and settings included, is lost for good. Its addresses
  and firewall stay. You type the server's name to approve it (in a script, see
  [In a script](#in-a-script)).
  At Hetzner, OpsCrew lifts the server's delete and rebuild protection for the rebuild and sets it
  again right after, whether the rebuild succeeds or fails. Then it checks that the app answers,
  as `opscrew verify` does. The next `opscrew provision` doesn't replace the rebuilt server.
- **At Contabo,** snapshots are included in the server's price, up to the number its plan allows
  (1 on Cloud VPS 4, 2 or 3 on larger plans), snapshots taken by hand included. At the limit,
  OpsCrew refuses and says which one to delete. Restoring one that isn't the newest deletes the
  newer ones, and OpsCrew says so first. They go with the server when its term ends (see
  [Deploy to Contabo](contabo.md#snapshots)).
- **DigitalOcean's token** needs two more scopes, `snapshot:delete` and `droplet:admin`, only to
  delete or restore whole-server snapshots. Without them, OpsCrew says so.

Your own server, your Portainer and your computer refuse `--server`, and name the data snapshot
instead.

## The schedule

```bash
npx opscrew snapshot schedule on                    # weekly, the last 4 kept
npx opscrew snapshot schedule on --every daily --keep 7
npx opscrew snapshot schedule on --every 6h --stop kafka
npx opscrew snapshot schedule off
```

`schedule on` and `off` change only the plan (`snapshots.schedule`); `npx opscrew provision` then
puts the schedule on the server or in your Portainer, or takes it away.

- **`--every`:** `daily` at 00:00 UTC, `weekly` (the default) on Thursdays at 00:00 UTC, or
  `<n>h`, every n hours (1 to 168) on the hour, UTC. The slots count from the 1970 epoch, so they
  are the same on every server.
- **`--keep`:** how many scheduled snapshots stay, from 1 to 30 (default 4). Older ones are
  deleted after each new one.
- **`--stop <service>`:** the schedule leaves out the services that must stop for their copy,
  unless you name them; each named one stops alone for its copy.
- **On a server,** the schedule is one line in the deploy user's crontab. Your own server needs
  cron (on Debian and Ubuntu: `apt install cron`); without it, the deploy stops and says so.
- **In your Portainer,** small services in the app's stack take them. They copy only the services
  copied while they run, because stopping one needs Docker on the host, which the stack has no
  access to: `--stop` is refused there. Take a snapshot with those by hand.
- **Not on your computer,** which isn't always on to take them, and not in a preview environment.

`schedule off` leaves the snapshots already taken until you delete them. On your own server and in
your Portainer, `opscrew destroy` removes the schedule and keeps the snapshots, as it keeps the
data, unless you add `--delete-data`.

## An encrypted copy off the server

```bash
npx opscrew snapshot offsite on --to r2
npx opscrew snapshot offsite on --to hetzner --region fsn1 --days 30
npx opscrew snapshot offsite on --to digitalocean --region fra1
npx opscrew snapshot offsite off
```

Each snapshot taken by hand or on the schedule is encrypted on the machine that holds the data,
then uploaded to a bucket of its own. The server holds only your age key's public half, never the
key itself, so only your key opens the copies.

### The bucket

| `--to` | Where | Retention |
|---|---|---|
| `r2` | [Cloudflare R2](https://developers.cloudflare.com/r2/); needs the app's domain on Cloudflare | Cloudflare's lifecycle rule deletes each copy after `--days` |
| `hetzner` | [Hetzner Object Storage](https://www.hetzner.com/storage/object-storage/), in `--region` (default: the server's location, where it has object storage) | A lifecycle rule deletes each copy after `--days`, with versioning on |
| `digitalocean` | [DigitalOcean Spaces](https://www.digitalocean.com/products/spaces), in `--region` | The server deletes the copies older than `--days` after each upload |

`--days` is 90 by default (1 to 3650). The bucket is named `<app>-<env>-backups`, for example
`shop-staging-backups` for staging and `shop-prod-backups` for prod. `offsite on` shows the
expected monthly cost from the same price data provision uses; the providers' price pages have the
details. OpsCrew never moves the bucket to another provider or region.

`offsite on` changes only the plan (`snapshots.offsite`). `npx opscrew provision` then plans the
bucket, which you approve by its hash, and asks for the bucket's access key, which you create: it
shows the console steps for a key named `opscrew-<app>-backups`. In a script, set
`OPSCREW_OFFSITE_ACCESS_KEY_ID` and `OPSCREW_OFFSITE_SECRET_ACCESS_KEY`. The key goes to the server
in a file only the deploy user can read (in your Portainer, into the stack's environment), and is
kept on this computer for restores.

**The bucket's key can delete.** No provider offers a key that can only upload, so whoever holds
the server's key can delete or overwrite the copies. At Hetzner, versioning keeps what was deleted
or overwritten for `--days` more. R2 offers no versioning, and Spaces gets none either. An R2 token
can be limited to the bucket; a Hetzner key covers its whole project, and a Spaces key needs full
access to create the bucket.

### When copies are uploaded

- After each snapshot by hand or on the schedule, outside the app's start lock, so an upload never
  holds a deploy or a rollback.
- A copy that failed is tried again after the next snapshot, while it is within the retention.
  `opscrew snapshot` warns when the copy of the snapshot it took failed, with the upload's last
  error; the upload's whole output stays in `.snapshots/offsite.log` in the app's folder on the
  server.
- For about 15 minutes after a bucket is created, some of Hetzner's nodes answer that it doesn't
  exist. The upload then sends that part again a minute later, so the first snapshot after
  `opscrew provision` can take a few minutes longer.
- Snapshots before a release stay on the server, for the rollback.
- `opscrew snapshot list` says `copied off the server` once a snapshot's copy is complete.

### The key

The copies are encrypted with [age](https://age-encryption.org) to the age key of your
[recovery copy](secrets-recovery.md): the first key in `opscrew/.sops.yaml`. With the copy off the
server on, provision makes that key before it sets the deploy secrets, if there is none yet. The
backup key, if you added one, doesn't open the copies.

**Keep your old keys.** After `opscrew rotate recovery-key`, new copies are encrypted to the new
key, but the copies made before need the old one.

### Restoring from the copy

```bash
npx opscrew restore 20261106T190000Z --from offsite --key-file ~/opscrew-shop-age-key.txt
```

This computer downloads the copy, decrypts it with your key file, and sends it to the server (or
your Portainer), then restores it as above. The key never leaves this computer. It needs
[Docker](https://www.docker.com/) (which runs OpsCrew's pinned rclone image) or
[rclone](https://rclone.org/install/) on this computer, and the bucket's key. When the server
still holds the complete snapshot, OpsCrew restores it from there instead.

This is how the data comes back after a server is lost: provision the environment again, then
restore the copy.

### Deleting the bucket

OpsCrew never deletes the bucket or its copies: not `offsite off`, not `destroy`, not
`destroy --delete-data`. Deleting it is yours to do:

1. Run `npx opscrew snapshot offsite off` and `npx opscrew provision`, so no more copies are
   uploaded. The copies left expire after `--days`, except on Spaces, where they stay until you
   delete them.
2. Empty and delete the bucket in Cloudflare's dashboard (R2 Object Storage), the Hetzner Console
   (Object Storage) or the DigitalOcean control panel (Spaces Object Storage).
3. To start again with another bucket, also delete OpsCrew's record of it: `backups.tfstate` in
   `.opscrew/tfstate/`, and `backups-create.json` in `~/.opscrew/projects/<project>/` if it exists.
   `offsite on` with another provider or region refuses until then and names both files.

Then revoke the bucket's key in the same console.

## The snapshot before each release

With `deploy.snapshots` on (every environment but previews, prod included, by default), each
deploy takes a snapshot before its release command, so that
[a rollback can restore it](rollback.md#the-database).
`opscrew snapshot list` lists them as `before a release`. Besides what is copied while it runs,
they hold the ClickHouse and Neo4j services by default, each stopped for a moment while it is
copied. What they hold, how many stay and how `deploy.snapshotStop` chooses the services that stop
for their copy are in
[Snapshots before each release](rollback.md#snapshots-before-each-release); how a rollback
restores one in your Portainer is in [In your Portainer](rollback.md#in-your-portainer).

## Status and alerts

`npx opscrew status` shows the last snapshot and its result:

```text
Last snapshot: 20261107T000000Z, scheduled, 2026-11-07 00:00 UTC, every part copied, on the app's server, copied off the server.
```

With the schedule on, it also names each server whose last scheduled snapshot, or its copy off the
server, failed, and where its output is (`.snapshots/scheduled.log` in the app's folder).

The [scheduled check](alerts.md), when it is on, opens an issue when the last scheduled snapshot
of an app on a server failed, or its copy off the server did. It doesn't reach your Portainer:
there, `opscrew status` shows the snapshots.

In [Claude Code](claude-code-plugin.md), the status answer names the last snapshot, and the
read-only tool `opscrew_snapshots` lists them. Taking and restoring snapshots stay terminal
commands.

## Design and advice

On [your own server](own-server.md) or [your Portainer](portainer-target.md), no provider backs up
the data. So when the interview says the data matters, `npx opscrew design` proposes weekly
snapshots with the last 4 kept, and a copy off the server on Cloudflare R2 when the domain is
there. Otherwise it says how to add one at Hetzner or DigitalOcean. `npx opscrew advise` proposes
them when they are off.

## What isn't in a snapshot

- **The app's own object storage:** the files in its bucket on R2, Hetzner or Spaces (see
  [Object storage](object-storage.md)). A [Garage](https://garagehq.deuxfleurs.fr/) service on the
  server is in it, as a service that stops for its copy.
- **Volumes attached at the provider,** in a whole-server snapshot.
- **A moment between snapshots:** a restore goes back to the snapshot's time, not to any moment
  you choose.

Sites on [Cloudflare's hosting](cloudflare-hosting.md) and [GitHub Pages](github-pages.md) keep no
data on a server, so there is nothing to snapshot.

## In a script

| Command | Approved with |
|---|---|
| `opscrew snapshot` that stops a service, `snapshot --server --stop` | `--allow-downtime` |
| `opscrew snapshot delete <id>` | `--confirm <id>` |
| `opscrew restore <id>` | `--confirm <app name> --approve <hash>`, the hash from a run without them |
| `opscrew restore --server <id>` | `--confirm <server name> --approve <hash>`, the hash from a run without them |

`--yes` approves none of them. Flags that don't go together, such as `--skip` with `--server`, are
refused before any work. The exit code is 0 when done, 1 when refused or not approved, and 2 on an
error.
