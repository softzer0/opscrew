# Feature Specification: Snapshots and restores as commands

**Feature Branch**: `main` (feature directory `specs/024-snapshots-and-restores`)
**Created**: 2026-11-06
**Status**: Draft
**Input**: The roadmap's "024 Snapshots and restores as commands" (founder, 2026-11-06: placed
before AWS; every case 019's database rollback leaves out, where viable; scheduled snapshots and an
opt-in encrypted copy off the server, so that an own server and Portainer get real backups).
Research: [research.md](research.md); R6 holds the founder's four decisions this spec builds on.

## Why

Since 0.2.4 a rollback can restore a database snapshot, but only as part of a rollback, only for
four databases on the app's server, and only on servers OpsCrew deploys by script. Nothing lets a
user take a snapshot before a risky change, restore one without changing the version, or keep a
copy that survives losing the server. An own server and a Portainer have no backup at all; the
guide tells the user to set one up. Snapshots as commands, for every kind of data and target,
scheduled and copied off the server, close that gap.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Take a snapshot of an environment's data (Priority: P1)

**Why this priority**: the base every other story builds on, and on its own the answer to "save
everything before I try this".

**Independent Test**: `opscrew snapshot` on staging with PostgreSQL, a Valkey queue, Kafka and a
SQLite file: a snapshot with all four is listed, Kafka was stopped for its copy after the user
approved it, and nothing else stopped.

**Acceptance Scenarios**:

1. **Given** an environment on a cloud server, the user's own server, this computer or the user's
   Portainer, **When** the user runs `opscrew snapshot`, **Then** every service that keeps data and
   the app's own files are copied into one snapshot, named by its time, filed on the machine that
   holds the data, with the version that runs recorded beside it.
2. **Given** PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Valkey, Redis or Dragonfly, **Then** each
   is copied while it runs, with no interruption.
3. **Given** a service with no safe online copy (RabbitMQ, NATS, Kafka, Redpanda, OpenSearch,
   Elasticsearch, Meilisearch, Typesense, ClickHouse, Neo4j, Garage), **Then** the summary names it
   and the seconds it will be stopped; after the user's approval only that service stops for its
   copy and starts again; `--skip <service>` leaves one out.
4. **Given** a database on another server (018), **Then** it is copied on that server and the
   snapshot names where each part is.
5. **Given** too little free disk (the rollback's rule: 1 GiB and 10%), **Then** nothing is taken
   and the output says how much is needed.

### User Story 2 - List and delete snapshots (Priority: P1)

**Independent Test**: after two snapshots and a deploy that took a rollback snapshot,
`opscrew snapshot list` shows all three with their time, version, size, services and where they
are; `opscrew snapshot delete <id>` removes one after its name is typed.

**Acceptance Scenarios**:

1. **Given** snapshots on the server, off it and at the provider, **When** the user runs
   `opscrew snapshot list`, **Then** each is listed once with its kind (taken by hand, before a
   release, scheduled, whole server), time, the version that ran, size and services, and
   `--json` gives the same.
2. **When** the user runs `opscrew snapshot delete <id>`, **Then** it is removed after the user
   types its id (`--confirm <id>` in a script); a provider snapshot is deleted at the provider.

### User Story 3 - Restore a snapshot (Priority: P1)

**Independent Test**: on staging, take a snapshot, change rows, restore it: the rows are back,
the version that runs didn't change.

**Acceptance Scenarios**:

1. **Given** a snapshot taken while the same version ran, **When** the user runs
   `opscrew restore <id>`, **Then** after an approval like a destroy (its text names what is lost:
   everything written since; the environment's name typed), requests are held, the app stops, each
   service in the snapshot is put back exactly, and the app starts again.
2. **Given** a snapshot taken while another version ran, **Then** the restore is refused before any
   change, naming `opscrew rollback --to <that version> --database snapshot` as the way to restore
   it with its version; `--allow-other-version` restores the data alone.
3. **Given** `--only <service>`, **Then** only that service is restored.
4. **Given** a restore that fails partway, **Then** the copy taken just before it is put back and
   the app starts on it, as the rollback's database step does.

### User Story 4 - Whole-server snapshots (Priority: P2)

**Independent Test**: on a Hetzner environment, `opscrew snapshot --server` takes a provider
snapshot while the app keeps serving; `opscrew restore --server <id>` rebuilds the server from it
and the app answers at the same address.

**Acceptance Scenarios**:

1. **Given** a server OpsCrew created at Hetzner or DigitalOcean, **When** the user runs
   `opscrew snapshot --server`, **Then** the provider takes a snapshot while the server runs, with
   the warning that a live snapshot may not be consistent; `--stop` stops the server first and
   starts it after, the downtime approved first.
2. **Then** the summary shows its monthly price, and attached volumes are named as not included.
3. **When** the user runs `opscrew restore --server <id>`, **Then** after a destroy-grade approval
   (the server's name typed) the provider rebuilds the server from it in place, keeping its address,
   and OpsCrew checks the app answers.
4. **Given** the user's own server or Portainer, **Then** `--server` is refused, naming the data
   snapshot instead.

### User Story 5 - Scheduled snapshots (Priority: P2)

**Independent Test**: `opscrew snapshot schedule on --every 1h` on staging, provision: a snapshot
appears within the hour without any command; the oldest go beyond `--keep`.

**Acceptance Scenarios**:

1. **When** the user runs `opscrew snapshot schedule on` for an environment and provisions,
   **Then** a scheduled service on the server (or in the Portainer stack) takes a data snapshot
   weekly by default (`--every daily|weekly|<n>h`), keeps the last 4 (`--keep`), and leaves out the
   services that would have to stop unless the user named them (`--stop <service>`).
2. **Then** `opscrew snapshot list` shows them, and `opscrew status` the last one's time and result;
   a scheduled snapshot that failed is reported by the scheduled check (017) when it is on.
3. **When** the user runs `opscrew snapshot schedule off` and provisions, **Then** the service is
   gone and the snapshots stay until deleted.

### User Story 6 - An encrypted copy off the server (Priority: P2)

**Independent Test**: with the copy on to an R2 bucket, a snapshot appears there encrypted; after
the server is destroyed and provisioned again empty, `opscrew restore <id> --from offsite` puts the
data back.

**Acceptance Scenarios**:

1. **When** the user runs `opscrew snapshot offsite on --to r2|hetzner|digitalocean`, **Then** a
   bucket of its own is planned (approved by hash, as 013's buckets), and every snapshot, by hand or
   scheduled, is encrypted on the server to the recovery copy's age key and uploaded there.
2. **Then** the bucket expires copies after 90 days (`--days`), where the provider supports it; the
   summary shows the expected monthly cost.
3. **When** the user restores from it, **Then** OpsCrew downloads the copy to this computer,
   decrypts it with the user's key, and streams it to the server; the server never holds the key.
4. **Given** an own server or Portainer with data that matters, **Then** design proposes scheduled
   snapshots with the off-server copy, as it turns on the cloud providers' backups today.

### User Story 7 - The rollback's snapshot covers everything (Priority: P2)

**Acceptance Scenarios**:

1. **Given** Portainer, SQLite, a database on another server, or any other kind of US1, **When** a
   deploy runs with `deploy.snapshots` on, **Then** its pre-release snapshot covers them too
   (services that would have to stop only when named in `deploy.snapshotStop`), and
   `opscrew rollback --database snapshot` restores them.

### User Story 8 - From Claude Code (Priority: P3)

**Acceptance Scenarios**:

1. **Given** Claude Code, **Then** `opscrew_status` names the last snapshot, and the read-only MCP
   tool `opscrew_snapshots` lists them; taking and restoring stay terminal commands.

---

### Edge Cases

- **A service with no data** (a cache) is still copied; `--skip` leaves it out.
- **A snapshot of a running deploy**: refused while a deploy or move runs.
- **Two apps on one server**: each app's snapshots are its own.
- **Restore across a service's version change** (Meilisearch's snapshots need the same version):
  refused with the reason.
- **The app's uploads in object storage** are not in a snapshot: the guide says so.
- **The off-server bucket's key can delete** on every provider (R3): versioning is turned on where
  offered, and the guide says so.
- **Hetzner's `Expiration.Days`** unconfirmed: checked live; if unsupported, OpsCrew deletes copies
  older than the retention itself after each upload.
- **The recovery key rotated**: copies made before stay readable with the old key; the guide says
  to keep it.
- **A restore on Portainer**: through its Docker API, as 023's copy.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-2401**: `opscrew snapshot [--env <env>] [--skip <service>]...` MUST take a data snapshot of
  every stateful service and the app's own files on every target that holds data (cloud, own,
  this computer, Portainer), filed where the data lives, recording the version that runs.
- **FR-2402**: PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Valkey, Redis and Dragonfly MUST be
  copied while they run; every other kind by stopping only that service for its copy (023's clean
  stop), after an approval naming it.
- **FR-2403**: `opscrew snapshot list [--json]` and `opscrew snapshot delete <id>` (typed id) MUST
  cover snapshots on the server, off it and at the provider.
- **FR-2404**: `opscrew restore <id> [--only <service>] [--allow-other-version]` MUST be approved
  like a destroy (what is lost; the environment's name typed), hold requests, stop the app, put each
  service back exactly, start the app; refuse a snapshot of another version unless allowed; put the
  copy taken just before back on failure.
- **FR-2405**: `opscrew snapshot --server [--stop]` and `opscrew restore --server <id>` MUST use the
  provider's snapshot and rebuild through the connectors, never `tofu apply`; live by default;
  refused on own servers and Portainer.
- **FR-2406**: `opscrew snapshot schedule on|off [--every …] [--keep n] [--stop <service>]...` MUST
  render a scheduled snapshot service on servers and Portainer (default weekly, keep 4).
- **FR-2407**: `opscrew snapshot offsite on|off [--to …] [--days n]` MUST plan a bucket of its own,
  encrypt each snapshot on the server to the recovery copy's age recipient and upload it, expire
  copies after 90 days by default, and restore by decrypting on this computer.
- **FR-2408**: The rollback's pre-release snapshot MUST cover every kind and target of FR-2401
  (stop-only kinds only when named in `deploy.snapshotStop`).
- **FR-2409**: No password, key, dumped value or address in any output, log, audit entry or file
  that leaves the server; the server never holds the private key.
- **FR-2410**: Design MUST propose scheduled snapshots with the off-server copy for an own server or
  Portainer when the data matters; advise MUST propose them when they're off.

### Key Entities

- **Snapshot**: an id (its UTC time), its kind (by hand, pre-release, scheduled, whole server), the
  version that ran, its services with their sizes and where each part is, and whether an
  off-server copy exists.
- **Snapshot schedule**: per environment: how often, how many kept, which stop-only services.
- **Off-server copy**: per environment: the bucket, the retention, the recipient.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-2401**: In the live pass, a snapshot by hand and its restore put back every service's data
  exactly, on a cloud server and on Portainer.
- **SC-2402**: The online kinds are copied with no failed request under load; a stop-only service
  is stopped only for its own copy.
- **SC-2403**: A scheduled snapshot appears on time and the oldest beyond `--keep` go.
- **SC-2404**: After the server is destroyed, the off-server copy restores the data onto a new one;
  the bucket holds nothing readable without the user's key.
- **SC-2405**: A whole-server snapshot and its restore keep the server's address and the app answers.
- **SC-2406**: No secret in any output, log, audit entry, committed file or bucket object.

## Assumptions

- The founder's decisions of 2026-11-06 (research R6).
- Snapshots stay on the machine that holds the data, as the rollback's do; the off-server copy is
  the backup.
- A restore never changes the version that runs; the rollback does that.
- Not in scope: the app's object storage buckets, provider volume snapshots, point-in-time recovery.
