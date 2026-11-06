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
  - on Portainer, in a named volume `opscrew-snapshots-<app>`;
  - for a database on another server (018), on that server, with the snapshot's `about.json`
    naming each part's place.
- **`about.json`, written last:** id, kind (`manual`, `release`, `scheduled`), the version that ran
  (image digest), and each service's kind, size and file. 019's pre-release snapshots keep their
  digest folders and gain an `about.json`.
- **Files:** one per service: the four databases' dumps as in 019; `sqlite.db` (Python's backup
  API); `<service>.rdb` (Valkey, Redis, Dragonfly); `<service>.tar` (a stopped volume, through a
  busybox one-off on servers and 023's carrier on Portainer).
- **Modes:** files 600, folders 700, owned by the deploy user.

### 2. Per kind (R2)

| Kinds | Copy | Restore |
|---|---|---|
| PostgreSQL, MySQL, MariaDB, MongoDB | 019's dumps | 019's exact restores |
| SQLite (the `sqlite` volume) | a pinned `python` one-off: `sqlite3.connect(src).backup(dst)`, the app running | stop the app, replace the file, remove `-wal`/`-shm`, start |
| Valkey, Redis, Dragonfly | `valkey-cli`/`redis-cli --rdb <file>` from a one-off of the service's own image (an RDB over the network, the server running); Dragonfly's `SAVE` into its own dir if `--rdb` isn't served (spike S1) | stop the service, place the RDB, start |
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
  - a `snapshots` service writes `about.json` once they're done (spike S2 settles the
    coordination);
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

- **The bucket:** a second bucket in 013's `storage` root (`<app>-<env>-backups`), planned and
  approved by hash.
  - Its key is the user's, as 013's are: OpsCrew never creates storage keys, and R2's is scoped
    to the bucket.
  - Versioning is on where the provider offers it.
  - A lifecycle rule expires copies after `snapshots.offsite.days` (90 by default), through the
    S3 API. If Hetzner rejects it (spike S3), the script deletes copies older than the retention
    after each upload.
- **The upload:** `snapshot.sh offsite <id>` streams each file through `age -r <recipient>` (the
  recovery copy's recipient from `opscrew/.sops.yaml`) into `rclone rcat` (the pinned image, the
  key in a mode-600 env file the deploy uploads, as `.env` is).
  - The age binary is a new tool pin (`TOOLS.age`, linux amd64 and arm64 with SHA-256), uploaded
    beside the script and checked against its hash before each use.
  - Every snapshot taken while the copy is on is uploaded right after it.
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
- `snapshots.offsite?: { provider, bucket, days }`.
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

## Order

T2401 (spikes) → T2402 (contracts and plan fields, lead) → {T2403 connectors, T2404 server script,
T2405 Portainer} → {T2406 off-server, T2407 the commands, T2408 restore} → {T2409 whole server,
T2410 design/advise/status/MCP} → {T2411 CLI and plugin, T2412 guide} → T2413 live tests →
T2414 live runs → T2415 simplify → T2416 release.
