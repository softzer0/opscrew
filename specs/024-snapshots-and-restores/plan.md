# Implementation Plan: Snapshots and restores as commands

**Branch**: `main` | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

## Summary

Data snapshots of every kind on every target that holds data, taken by hand, before each release
(019's rollback) or on a schedule; restores without a rollback; whole-server snapshots at Hetzner
and DigitalOcean; and an age-encrypted copy in a bucket of its own. Servers run one script for all
of it; Portainer goes through 023's Docker API path and a few scheduled services in its stack.

## Technical Context

- TypeScript monorepo (`packages/*`), POSIX shell on servers, Docker Compose, OpenTofu/Terraform.
- Builds on:
  - 019: `iac-templates/src/workflow/snapshots.ts`, `switch.ts` database step, `agents/src/rollback/database.ts`.
  - 023: `connectors/docker` carrier, Portainer's Docker proxy, the window's clean stop.
  - 013: buckets in the `storage` root, the cron service.
  - The recovery copy: `agents/src/secrets/*`, `opscrew/.sops.yaml`.
- No change in the approval kinds: data restores and deletions are destroy-grade (`allowDestroy` and a typed name), plans by hash.

## Constitution Check

- **I (gate):**
  - every change of data or infrastructure is approved: a restore like a destroy, a whole-server restore with the server's name typed, the bucket by its plan hash;
  - the schedule and the off-server copy change the deploy workflow and the stack, so they come with provision's approvals.
- **IV (secrets):**
  - passwords stay inside containers, as in 019;
  - the bucket key lives only in a mode-600 file on the server and in this computer's storage key file;
  - the server holds only the age recipient, never the private key;
  - nothing dumped is printed.
- **Typed adapters:** provider snapshots and rebuilds go through the connectors, never `tofu apply` (R1).

## Design

### 1. The snapshot store and format

- **A snapshot is a folder named by its UTC time** (`20261106T190000Z`), the id. It lives:
  - on a server and this computer, in `<app folder>/.snapshots/` beside 019's pre-release ones;
  - on Portainer, in the stack's `snapshots` volume, `opscrew-<app>_snapshots` (D12);
  - for a database on another server (018), on that server, with the snapshot's `about.json`
    naming each part's place.
- **`about.json`, written last:** id, kind (`manual`, `release`, `scheduled`), the version that ran
  (image digest), and each service's kind, size and file. 019's pre-release snapshots keep their
  digest folders and gain an `about.json`.
- **Files:** one per service: the four databases' dumps as in 019; `sqlite.tar` (the `sqlite`
  volume, D6); `<service>.rdb` (Valkey, Redis, Dragonfly); `<service>.tar` (a stopped volume,
  through a busybox one-off on servers and 023's carrier on Portainer).
- **Modes:** files 600, folders 700, owned by the deploy user.
- **The contract** (T2405, 2026-11-06), the same on servers and Portainer:
  - `about.json` is one line:
    `{"id","kind","taken","version":"sha256:<hex>","services":[…]}`;
  - each service entry is `{"name","kind","file","size"}`, or
    `{"name","kind","failed":true}`, or `{"name","kind","skipped":true}` for a stop-only
    service left out;
  - `kind` is `manual`, `release` or `scheduled`;
  - pre-release folders are named by the 64-hex digest, the others by `YYYYMMDDTHHMMSSZ`;
  - a scheduled snapshot is written in `<id>.partial`, a manual one in `<id>.taking`, each
    renamed when complete;
  - SQLite's file is `sqlite.tar` (D6); a `sqlite` volume with nothing in it is `skipped`;
  - on Portainer, `/snapshots/.running` names the running image, written by the stamp after a
    new version starts.
  - a snapshot taken before any `.running` exists records `"version":""`: restores treat it
    as an unknown version (refused unless `--allow-other-version`);
  - the bucket holds `backups/<id>/<file>.age`, `about.json.age` written last (an extra server's parts under `backups/<id>/<server>/`); the snapshot
    folder gains an `offsite.done` marker once uploaded.

### 2. Per kind (R2)

| Kinds | Copy | Restore |
|---|---|---|
| PostgreSQL, MySQL, MariaDB, MongoDB | 019's dumps | 019's exact restores |
| SQLite (the `sqlite` volume) | a pinned `python` one-off mounting the volume read-write as the app's uid, the app running: every SQLite database in the volume (by its header) through `sqlite3.connect(src).backup(dst)`, then `journal_mode=delete` on the copy; the volume's other files as they are, without `-wal`, `-shm` or `-journal` files; all in one `sqlite.tar` (D6) | stop the app, empty the volume, untar, start |
| Valkey, Redis | `valkey-cli`/`redis-cli -h <service> --rdb <file>` from a one-off of the service's own image, the password in `REDISCLI_AUTH` from an env file, the server running | cache mode: stop, place `dump.rdb`, start; queue mode (AOF): stop, replace `appendonlydir/` with the RDB as `appendonly.aof.1.base.rdb` and its one-line manifest, start (R7) |
| Dragonfly | `SAVE RDB <name>` against the running server, then copied out by a one-off mounting its volume read-only | queue mode: stop, move old `dump*` files away, place `dump.rdb`, start; cache mode: `DFLY LOAD <file>`, running (R7) |
| Every other kind | stop only that service (`-t 120` and the clean-exit check, 023), tar its volumes, start it | stop it, empty and untar its volumes, start |

### 3. Servers: one script

- **`snapshot.sh`:** each deploy uploads it beside `start.sh`, rendered from the plan (the services,
  their kinds and volumes). It holds 019's functions grown to every kind. Commands:
  - `take <kind> [--skip s]... [--stop s]...`;
  - `restore <id> [--only s]`;
  - `list` (the `about.json` files);
  - `delete <id>`;
  - `offsite <id>`.

  Each restore takes the copy just before (019's step 3) and puts it back on failure. Holding
  requests, stopping and starting the app reuse 019's code.
- **By hand:** the CLI runs the script over the access `opscrew logs` uses (`serverShell`), or
  locally on this computer.
- **Pre-release snapshots** (019's `snapshotStep`) call `take release`. Stop-only kinds are included
  only when named in `deploy.snapshotStop`.
- **Scheduled:** the deploy writes one line in the deploy user's crontab, which runs
  `snapshot.sh take scheduled`. No host plan and no timer unit; removed when the schedule is off.
  Not on this computer.
- **Extra servers** (018) get their own `snapshot.sh` for their services; the app server's script
  calls theirs over the private network's SSH the deploy already uses, or the CLI does each.

### 4. Portainer

- **By hand:**
  - snapshots and restores go through 023's `SideDocker`: one-offs of each service's own image
    for the online kinds, and the carrier for the stop-only ones;
  - files land in the snapshots volume;
  - stopping and starting go through the Docker API, as 023's window does.
- **Scheduled:**
  - one small service per online kind in the stack, each built on that kind's own image, sleeping
    to the next slot and writing its file into the snapshots volume;
  - per-part loops write `<file>.tmp`, rename it and touch `<part>.done` (or `.failed`); a
    busybox `snapshots` service makes the volume `1777` first, waits for every part, and writes
    `about.json` (R7, S2);
  - the image digest comes from the stack's environment, which the deploy sets;
  - stop-only kinds aren't scheduled on Portainer, because stopping another container needs the
    Docker socket. The output and the guide say so.
- **Pre-release:** a one-off `snapshot` service in the stack runs before `release`, for the online
  kinds, keyed by the outgoing image.

### 5. Whole-server snapshots

- **Connectors:**
  - Hetzner gains `listSnapshots(serverId)` (labels `opscrew-app`, `opscrew-env`),
    `deleteImage`, and `rebuildServer(serverId, imageId)`;
  - DigitalOcean gains `deleteSnapshot` and `rebuildDroplet`;
  - the contract `ServerSnapshotApi` grows to match (lead).
- **Taking one:** live by default; `--stop` powers the server off, snapshots it and powers it on
  again.
- **Restoring:** a rebuild in place. Afterwards, provision's next plan must not want to replace the
  server, so the server resources carry `lifecycle { ignore_changes = [image] }` (both providers'
  modules).
- **Safety:** Hetzner's `root_password` answer is redacted and never stored. Attached volumes are
  named as not included.

### 6. Restore (the command)

- **The version check:**
  - the restore reads `about.json`;
  - a snapshot of another version is refused, naming the rollback command;
  - `--allow-other-version` restores the data alone.
- **The approval:** like 019's database choice, a destroy-grade approval whose hash covers the id,
  the services and `about.json`, with the environment's name typed. On servers a one-time approval
  file guards the script, as 019's does.
- **From the off-server copy (`--from offsite`):** the CLI downloads the object with rclone run
  locally (the pinned image in local Docker, or this computer's rclone) and decrypts it with the
  recovery key file. It then streams the plaintext to the server's snapshot folder, or Portainer's
  volume through the carrier, and restores from there.

### 7. The off-server copy

- **The bucket:** `<app>-<env>-backups`, in a `backups` root with its own state (D9), planned and
  approved by hash.
  - Its key is the user's, as 013's are: OpsCrew never creates storage keys, and R2's is scoped
    to the bucket.
  - Versioning is on where the provider offers it.
  - A lifecycle rule expires copies after `snapshots.offsite.days` (90 by default): Hetzner
    through the S3 API, with versioning and expiry of old versions; R2 through Cloudflare's
    lifecycle, with no versioning offered.
  - DigitalOcean Spaces, untested live, gets neither. There the script deletes copies older than
    the retention after each upload.
- **The upload:** `snapshot.sh offsite <id>` streams each file through `age -r <recipient>` (the
  recovery copy's recipient from `opscrew/.sops.yaml`) into `rclone rcat` (the pinned image, the
  key in a mode-600 env file the deploy uploads, as `.env` is).
  - The age binary is a new tool pin (`TOOLS.age`, linux amd64 and arm64 with SHA-256). The
    script fetches the pinned archive through the pinned rclone image, as Portainer's service
    does, checks the archive's and the binary's hashes, and the binary's again before each use
    (D10).
  - Every snapshot taken by hand or on the schedule while the copy is on is uploaded after it,
    once the start lock is released (D16). Pre-release snapshots stay on the server for the
    rollback.
- **Portainer:** an `offsite` service in the stack does the same with the snapshots volume
  (spike S2).

### 8. Design, advise, status

- Design proposes `snapshots.schedule` and `snapshots.offsite` for an own server or Portainer when
  `dataCriticality` isn't `none`, with the bucket's estimated price.
- Advise proposes them when they're off and the data matters.
- `opscrew status` shows the last snapshot and its result; the MCP tool `opscrew_snapshots` lists
  them.

### 9. The plan's fields (plan-schema, lead contract)

- `deploy.snapshotStop: string[]`: stop-only services the pre-release snapshot includes.
- `snapshots.schedule?: { every: "daily" | "weekly" | <n>h, keep: 1–30, stop: string[] }`.
- `snapshots.offsite?: { provider, bucket, region, days }`: `region` is required for Hetzner and
  DigitalOcean, and is `auto` for R2.
- Defaults: weekly, keep 4, 90 days.

### 10. Tests

- Unit tests under `sh` with shims for every script path.
- Docker tests for each kind's copy and exact restore, the stop-only tar, and Portainer's
  scheduled services.
- Live passes:
  - Hetzner staging: a snapshot by hand with Kafka stopped, a restore, a schedule at `1h`, the
    off-server copy to R2 restored after destroy, a whole-server snapshot and rebuild;
  - the user's Portainer: a snapshot by hand and a restore through its API.

### 11. Spikes first (T2401)

- **S1:** in Docker, with the pinned images:
  - `python` `sqlite3.backup` against a WAL database being written;
  - `valkey-cli --rdb` and `redis-cli --rdb` against running servers, and Dragonfly's answer to
    `--rdb`;
  - each restore.
- **S2:** a Portainer stack with per-kind scheduled services writing into one volume, and an
  `offsite` service.
- **S3 (live):** R2 and Hetzner lifecycle rules through the S3 API, and Hetzner's rebuild keeping
  IPs, firewall and network on a throwaway server.

## Decisions (lead, 2026-11-06)

- **D1:** one server script for snapshots by hand, scheduled and pre-release, not a cron container:
  stopping another service needs Docker on the host.
- **D2:** schedules on servers are a line in the deploy user's crontab, so no host plan and nothing
  for root.
- **D3:** stop-only kinds aren't scheduled on Portainer: no Docker socket in the stack.
- **D4:** restores of the off-server copy decrypt on this computer only.
- **D5:** a whole-server restore is a rebuild through the connectors, with `ignore_changes` on the
  image.
- **D6 (T2404's report):** SQLite is copied as the whole `sqlite` volume in one `sqlite.tar`.
  - Every database in the volume is copied online through the backup API; the other files are
    copied as they are.
  - **Why:** a Rails 8 app keeps several databases there (the app's, plus cache, queue and cable)
    and its uploads beside them, and a single `sqlite.db` missed them.
  - The Python program is written once in `workflow/snapshots.ts`; Portainer imports it.
- **D7 (T2404's report):** the release snapshot covers every kind of US7.
  - `snapshotsOn` is true for any stateful service or `sqlite` volume, on the app's server or an
    extra one.
  - On extra servers, the workflow reads the outgoing digest from the app's server before their
    deploy step. Each extra server then runs `snapshot.sh take release --version <digest>` before
    its services change.
  - The rollback's database step restores there too, from the runner, as the deploy reaches them.
  - The rollback offers only folders with an `about.json`.
  - Once the app answers (and after a rollback), the workflow writes the running digest to
    `.running` in the app folder on each extra server. `snapshot.sh` records it there, so their
    scheduled and manual snapshots know their version. `take --version sha256:<hex>` overrides
    it.
- **D8:** `take --id <id>` lets the CLI give one id to the parts of a snapshot spread over several
  servers. A restore on an extra server doesn't hold or stop the app. The CLI runs the app
  server's `snapshot.sh hold` first and `snapshot.sh resume` after (019's code; no approval file,
  since they lose no data) (T2408).
- **D9 (T2406's report):** the backups bucket has a `backups` root with its own state, not a
  second bucket in 013's `storage` root.
  - Moves, `destroy --delete-data` and drift never handle its key.
  - The copies outlive a destroyed server, which is their purpose.
  - Deleting the bucket is the user's, and the guide says how.
- **D10:** the script fetches `age` itself (7.), so the deploy uploads nothing new.
- **D11:** with the off-server copy on, provision makes the recovery copy's age key before it
  sets the deploy secrets. So the first provision already has the recipient. The first recipient
  in `opscrew/.sops.yaml` is used.
- **D12 (T2419's report):**
  - **Own servers:** the app's crontab line is removed by the ssh-host connector's teardown
    (`planTeardown`, approved by hash). Destroy, extra servers and moves all go through it.
  - **Portainer:** the snapshots volume is the stack's own `snapshots` volume
    (`opscrew-<app>_snapshots`, not `opscrew-snapshots-<app>`), recorded with `snapshot_tools`
    among the stack's volumes. So destroy deletes both only with `--delete-data`, as all data.
- **D13 (T2417's report):**
  - **`hold` and `resume` always exist:** `snapshot.sh` is rendered on the app's server whenever any server holds data, so they are there even when only extra servers hold data. Rendering them reuses `appHoldCommands`.
  - **`.running` on extra servers** is written whenever `snapshotsOn` is true or a schedule is on. Prod's scheduled snapshots then know their version.
  - **The rollback's down-migrations choice** saves the extra servers' data first, as it saves the app server's.
- **D14:** `opscrew rollback --database snapshot` on Portainer restores the pre-release snapshot through T2408's Portainer restore (T2420), so US7 covers Portainer too.
- **D15 (T2406's report):** `snapshots.offsite` is refused on localhost, like the schedule: its snapshots stay on this computer beside the data, and no bucket root is planned there.
- **D16 (T2406's review):**
  - **Uploads:** they run outside the start lock, so a long upload never holds a deploy or a rollback. Pre-release snapshots aren't uploaded.
  - **Retrying:** each `take` also uploads the complete snapshots that have no `offsite.done` yet, so a failed upload is retried, as Portainer's service retries.
  - **A re-upload** of an id first removes its `about.json.age`, so a partial re-upload never looks complete.
  - **The recipients** are kept in `.opscrew/recovery.json` too, so a first provision that fails before its pull request can run again.
  - **No age key:** a run that can't make one stops before any change.
- **D17 (T2419's report):** snapshots are data. On an own server, the teardown keeps `/srv/apps/<app>/.snapshots` unless `--delete-data` is given, as it keeps `/srv/data/<app>`, and names it as kept.
- **D18 (T2417's re-review):** a rollback that got stuck can be repaired.
  - **When the app's server had switched** (`.env` names the failed version and a marker
    exists): `opscrew rollback --to <the version that ran> --database snapshot` is accepted. It is
    a normal rollback to that version, restoring the copies saved under it on every server.
  - **When only extra servers changed before the switch** (`.env` still names the version that ran):
    the command is refused, naming `opscrew restore <hex> --only <services>` on each changed server
    (T2408), then starting the app. The stuck message tells the two cases apart.
  - The rollback step stops the app only when the app's server records that data changes began.

## Order

T2401 (spikes) → T2402 (contracts and plan fields, lead) → {T2403 connectors, T2404 server script,
T2405 Portainer} → {T2406 off-server, T2407 the commands, T2408 restore, T2417 every kind before a
release, T2418 Portainer's SQLite, T2419 no schedule left behind} → T2420 Portainer rollback → {T2409 whole server,
T2410 design/advise/status/MCP} → {T2411 CLI and plugin, T2412 guide} → T2413 live tests →
T2414 live runs → T2415 simplify → T2416 release.
