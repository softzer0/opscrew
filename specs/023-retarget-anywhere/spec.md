# Feature Specification: Retarget anywhere

**Feature Branch**: `main` (feature directory `specs/023-retarget-anywhere`)
**Created**: 2026-11-05
**Status**: Draft
**Input**: The roadmap's "023 Retarget anywhere" (founder, 2026-10-20: "moving from every to every
provider no matter which should be supported"; go-ahead 2026-11-05).
- `opscrew retarget` from any target to any target: cloud, the user's own server and Portainer,
  with all the app's data.
- **Data:**
  - a copy for every catalog kind, not only Postgres;
  - a bucket at the provider being left moves to the new provider's storage, with its size, time
    and egress shown first, and is deleted at `--finish`; R2 stays;
  - on Portainer, the copy goes through its API;
  - for each stateful component, copy its data or start empty.
- **Servers:**
  - the own server's host plan on the target side;
  - keeping a component on the old server;
  - never deleting the user's own old server.
- Research: [research.md](research.md). R3 holds the lead's decisions this spec builds on.

## Why

OpsCrew's promise is that the user owns everything and can leave any provider. Today
`opscrew retarget` moves an app only between Hetzner and DigitalOcean, and only its Postgres
database. Leaving for a server of one's own, a Portainer, or a site host means destroying the app,
copying data by hand and provisioning again. Moving between any two places, with every kind of
data, makes "you can always leave" true.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - To or from a server of your own (Priority: P1)

A user moves an app from Hetzner to a server they already have, or from their server to a cloud
provider, or from one of their servers to another. The flow is the one they know from
`retarget`.

**Why this priority**: the most common reason to leave a cloud provider is a server one already
pays for.

**Independent Test**: an app with Postgres and Valkey on Hetzner: `retarget --to own` with the
server's answers moves it, data included. `--finish` removes the Hetzner server. Moving back to a
cloud provider works the same, and `--finish` removes the app from the user's server, not the
server itself.

**Acceptance Scenarios**:

1. **Given** an app on a cloud server, **When** the user runs `retarget --to own` and names the
   server (address, SSH login; an answers file in a script), **Then** OpsCrew inspects it, plans
   its setup as a host plan approved by hash, deploys and checks the app there, copies the data in
   the window, and switches DNS.
2. **Given** an app on the user's server, **When** it moves to a cloud provider or another server
   of theirs, **Then** `--finish` removes the app from the old server (its containers, its volumes
   after the typed name, its site and its route) and never deletes or resets the server.
3. **Given** the new server already runs other apps, **Then** OpsCrew sets the app up beside them
   as for any server shared by several apps, and refuses what it would refuse there.

### User Story 2 - To or from your Portainer (Priority: P1)

A user moves an app to the Portainer they run, or from it to a server.

**Why this priority**: Portainer users manage their servers through it, and must not need SSH to
move an app.

**Independent Test**: an app with Postgres and MySQL moves from Hetzner to a Portainer
environment. Its stacks are created, the volumes copied through Portainer's API, and the Hetzner
server removed at `--finish`. Moving back to a server works the same, and `--finish` removes the
stacks and volumes but not the Portainer environment.

**Acceptance Scenarios**:

1. **When** the new target is Portainer, **Then** the stacks are planned and approved by hash as
   provision does, and the window stops and starts them and copies volumes through Portainer's
   Docker API. No SSH is needed on that side.
2. **When** Portainer is the old target, **Then** `--finish` removes the app's stacks and volumes
   after the typed name, never Portainer or the environment.
3. **Given** an Edge Agent environment, **Then** OpsCrew refuses the move before any change and
   says why (research R5).

### User Story 3 - All the data comes along (Priority: P1)

Every stateful service and the app's own volumes move: MySQL, MariaDB, MongoDB, Valkey, Redis,
Dragonfly, RabbitMQ, NATS, Kafka, Redpanda, Garage, OpenSearch, Elasticsearch, Meilisearch,
Typesense, ClickHouse, Neo4j, and SQLite files. The user may start any of them empty instead.

**Why this priority**: a move that loses data isn't a move.

**Independent Test**: an app with a MySQL table, a RabbitMQ queue holding messages, a Valkey queue
holding jobs, and a SQLite file. After the move, all four hold the same data, logins are
unchanged, and the window lasted about what the summary said.

**Acceptance Scenarios**:

1. **When** the move starts, **Then** the summary lists each stateful service, its size and the
   window's expected length. For each, it asks whether to copy (the default) or start empty
   (`--empty <service>` in a script), and says what starting empty loses.
2. **In the window,** the old app stops, then each service stops cleanly. Each volume streams from
   the old side into the new side's service, which has been created but not started, with a
   SHA-256 check on both ends. Then the services start, then the app; Postgres keeps its dump.
3. **When** any copy fails, **Then** the window rolls back: the old app and services start again,
   the new side's volumes are emptied, and nothing has switched.

### User Story 4 - Buckets move with the app (Priority: P2)

A bucket at the provider being left moves to the new provider's object storage.

**Why this priority**: an old bucket keeps billing, and keeps the user tied to the old provider.

**Independent Test**: an app with a Hetzner bucket of a few hundred files moves to DigitalOcean.
A Spaces bucket is created; the files are copied once before the window and again in it; the app
uses the new bucket; `--finish` deletes the old bucket after its typed name.

**Acceptance Scenarios**:

1. **When** the new target is the other cloud provider, **Then** the summary shows the bucket's
   size, object count, copy time and egress cost, and moves it by default. `--keep-bucket` keeps it.
2. **When** the new target is the user's server or Portainer, **Then** the bucket stays, and the
   summary says it keeps billing at the old provider. R2 always stays.
3. **Then** the old bucket is deleted only at `--finish`, after its own typed name.

### User Story 5 - Sites move too (Priority: P2)

A site moves between Cloudflare's hosting and GitHub Pages, where design offers the new host for
the app. Between a site and a server, the app's whole design changes, so that stays out (later).

**Why this priority**: the same promise of leaving, for apps without a server.

**Independent Test**: a static site on GitHub Pages moves to Cloudflare's hosting: the new site is
provisioned and checked, DNS switches, and `--finish` removes the Pages site.

**Acceptance Scenarios**:

1. **When** the user retargets a site, **Then** OpsCrew offers only the targets design offers the
   app, provisions the new one with its approvals, checks it, and switches DNS. There is no window,
   since a site has no data.
2. **When** a site would move to a server, or an app with a server to a site host, **Then**
   OpsCrew refuses it plainly and says how: `destroy`, then `interview`, `design` and
   `provision`.

### User Story 6 - Apps on several servers, and with monitoring (Priority: P3)

An app whose services sit on extra servers, or with self-hosted monitoring, moves its app server.

**Why this priority**: today these are refused, and the refusal promises this feature.

**Independent Test**: an app with Postgres on an extra server moves its app server to DigitalOcean.
The new app server joins the private network, Postgres stays where it is, and the app reaches it.

**Acceptance Scenarios**:

1. **When** the app server moves, **Then** the extra servers stay. The new app server joins the
   app's private network, and the old one leaves it at `--finish`.
2. **Given** monitoring on the app server, **Then** it moves with its data (or starts empty). On a
   server of its own it stays, and the new app server sends to it.
3. **To keep** a service at the old provider, the guide explains placing it on an extra server
   first, then moving.

### Edge Cases

- A target the app can't run on (an architecture without the app's image, too little memory) is
  refused at the start, as design refuses it.
- A move to the same place (the same provider; the same own server or Portainer environment) is
  refused.
- This computer as a target is refused: `env remove`, then `env add`.
- A preview environment is refused; it is made anew with `env add --previews`.
- A host environment of previews (022 US9) moves only after its previews are removed.
- An interrupted window recovers on the next run, as today.
- Public SSH closed on an SSH side: refused before any change, as today.
- A Cloudflare Tunnel on either side (an own server reached through one, Portainer's tunnel
  modes), and Portainer behind the user's own proxy with Cloudflare DNS: refused for now. Switching
  between a tunnel and address records needs two changes with an outage between them.
- Two Portainer environments, on one Portainer or two: refused (one deploy branch and webhook, one
  Portainer token).

## Requirements *(mandatory)*

### Functional Requirements

**Targets**
- **FR-2301**: `opscrew retarget` MUST move an app between any two server targets: Hetzner,
  DigitalOcean, the user's own server and the user's Portainer. That includes two servers of the
  user's. A move within one cloud provider, and one between two Portainer environments (one deploy
  branch and webhook), stay refused.
- **FR-2302**: A new own server MUST be named, inspected and set up through the own-server host plan
  (approved by hash). An old own server MUST keep everything but the app at `--finish`.
- **FR-2303**: A new Portainer MUST get its stacks through stack plans approved by hash. An old
  Portainer MUST keep everything but the app's stacks and volumes at `--finish`. Edge Agent
  environments are refused.
- **FR-2304**: Sites MUST move between Cloudflare's hosting and GitHub Pages, wherever design
  offers the new host for the app, without a window. A move between a site and a server is
  refused plainly.
- **FR-2305**: This computer and preview environments MUST be refused plainly. So MUST a
  previews' host environment while previews run on it.

**Data**
- **FR-2306**: Every enabled stateful service and the app's own volumes MUST be copied in the
  window as stopped volumes through Docker's archive API, over SSH or through Portainer. Each is
  checked with SHA-256 on both ends. Postgres keeps its dump.
- **FR-2307**: Each stateful service MUST be copyable or startable empty, by a question or by
  `--empty <service>`. The summary MUST say what starting empty loses.
- **FR-2308**: The summary MUST show each volume's size and the window's expected length before any
  change. The window's commands MUST be approved, with `--allow-downtime` in a script.
- **FR-2309**: A failed copy MUST roll the window back: the old side runs again, and the new
  side's copied volumes are emptied.

**Buckets**
- **FR-2310**: A bucket at the provider being left MUST move to the new cloud provider's storage by
  default (a new bucket through an approved plan; a copy before and in the window; the app
  switched), unless `--keep-bucket` is given. Its size, object count, time and egress MUST be
  shown first.
- **FR-2311**: The old bucket MUST be deleted only at `--finish`, after its own typed name. R2, and
  any bucket when the new target is no cloud provider, MUST stay, and the summary says so.
- **FR-2312**: A bucket's keys MUST reach the copy only on standard input, in a file that is
  removed afterwards, and never appear in a plan, a log or the audit.

**Several servers and monitoring**
- **FR-2313**: An app with extra servers MUST move only its app server. The new one joins the
  private network, and the old one leaves it at `--finish`.
- **FR-2314**: Self-hosted monitoring on the app server MUST move with its data or start empty; on
  its own server it MUST stay.

**Surfaces**
- **FR-2315**: `opscrew_status` MUST show a move's step for every target. The guide's retarget
  page MUST cover every target, the data, buckets, sites and several servers. Its "can't move
  yet" list shrinks to what is still refused.

### Key Entities

- **Retarget:** `plan.retarget`. It gains the old and new targets of any kind, the services to
  start empty, and the bucket's move.
- **Volume copy:** a service's (or the app's) named volume, its size and its SHA-256 on each side.

## Success Criteria *(mandatory)*

- **SC-2301**: Live:
  - Hetzner to the user's own server, and back to DigitalOcean, with Postgres, MySQL, Valkey
    holding jobs and a SQLite file: every row, job and file is there afterwards.
  - A move to and from Portainer, with its volumes copied.
- **SC-2302**: A failed copy at any point leaves the old app serving, with its data unchanged.
- **SC-2303**: No secret, address or bucket key appears in output, logs, audit entries or plans.
- **SC-2304**: The user's own server and Portainer are never deleted or reset.

## Assumptions

- **Downtime is accepted.** The window stops the app; the summary gives its length. A live,
  zero-downtime database move stays out.
- **Images are the same on both sides,** pinned by the plan; a volume copy needs it.
- **Data streams through this computer,** as the database dump does today.

## Out of scope

- Moves within one cloud provider: another location, or another size (advise).
- This computer as either side.
- Edge Agent Portainer environments (until checked).
- A site to a server, or a server to a site.
- A Cloudflare Tunnel on either side.
- Keeping a component on the old server as a special mode. Place it on an extra server first.
- AWS (029), which joins as another target.
