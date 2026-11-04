# Feature Specification: Self-hosted monitoring

**Feature Branch**: `main` (feature directory `specs/020-self-hosted-monitoring`)
**Created**: 2026-11-01
**Status**: Draft
**Input**: The roadmap's "020 Self-hosted monitoring" (founder, 2026-10-18; its own feature since
2026-10-30).
- A private, self-hosted monitoring stack, opt-in: Prometheus, Loki and Grafana, with ready-made
  dashboards for the server, the containers, the app's HTTP traffic, Postgres and Caddy.
- By default on a separate small monitoring server (about €4–5 a month at Hetzner) that watches
  all of the user's OpsCrew servers. On the app's server only when it has at least 4 GB.
- Reached only through 018's private network. The same gate as everything else: plans approved by
  hash, pinned versions, and destroy removes only what OpsCrew installed.
- Grafana and Loki are AGPL-3.0, fine as containers; OpsCrew says so when the user turns it on.
- Research: [research.md](research.md). R6 holds the lead's decisions this spec builds on.

## Why

017 gives every app logs and figures on demand, with nothing left running, and two opt-in add-ons.
Beszel keeps a history of the server's figures but no logs. Grafana Cloud keeps both, but the data
goes to Grafana, and its free tier caps how much. A user who wants weeks of figures and searchable
logs, on their own servers, with no third party and no volume limit, has no way to get them from
OpsCrew today.

018 made it safe to run one: a private network between the user's servers and devices. The stack
can sit on a small server of its own that nobody on the internet can reach, and every app server
sends to it over the network.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A monitoring server for an environment (Priority: P1)

The user runs `opscrew addon enable monitoring`. OpsCrew says what it adds before anything changes:
- a small server at the app's provider and location, with its type and monthly price;
- what runs on it: Prometheus for the figures, Loki for the logs, Grafana for the dashboards;
- the agent (Grafana Alloy) on each of the environment's servers, with its memory and price share;
- how long figures and logs are kept, and the disk that takes;
- that the data stays on the user's own servers;
- that Grafana and Loki are AGPL-3.0, run unmodified as containers.

It writes these settings into the plan. `opscrew provision` then shows and applies each change,
each approved by its hash:
1. the infrastructure plan: the new server;
2. each server's host plans: the private network, its filter, the agent, and the stack on the
   monitoring server;
3. the deploy-setup pull request, which turns Caddy's figures on.

Within a minute of the last step, every server's figures and logs are in the stack.

**Why this priority**: it is the feature: history of figures and logs, on the user's own server.

**Independent Test**:
1. Deploy an example app with Postgres to Hetzner.
2. Run `opscrew addon enable monitoring`, then `opscrew provision`.
3. Run `opscrew addon status`.

Every server is listed, with figures and logs received less than a minute ago.

**Acceptance Scenarios**:

1. **Given** an environment on a server OpsCrew created or on the user's own server, **When** the
   user runs `opscrew addon enable monitoring`, **Then**:
   - it shows the server, its price, the agent's memory on each server, the retention, the disk
     estimate, where the data stays and the licences;
   - it writes the settings into the plan;
   - it changes nothing on any server, account or repository, and says to run `opscrew provision`.
2. **Given** the settings are in the plan, **When** the user runs `opscrew provision`, **Then**
   it creates the server, sets up the network and installs the stack and the agents, each change
   shown and approved by its hash as provision approves it today.
3. **Given** the app had no private network (one server, no devices), **When** monitoring is
   turned on, **Then** the network is created with the app's server and the monitoring server as
   its members, as `opscrew vpn add` creates it.
4. **Given** the environment has extra servers (018), **Then** each runs the agent and sends.
5. **Given** the user wants another server type, location or one of their own servers, **When**
   they change the monitoring server's entry in the plan, **Then** it is validated, sized and
   priced as any extra server (018).
6. **Given** a log line holds one of the app's secrets or a value shaped like a token, **Then** it
   is masked before it leaves the server, as 017 masks the lines it sends to Grafana Cloud.

---

### User Story 2 - Ready-made dashboards (Priority: P1)

The user opens Grafana and finds OpsCrew's dashboards, filled with the environment's data: the
servers, the containers, HTTP traffic, Caddy, Postgres and the logs. Each one lets them pick the
app, the environment and the server.

**Why this priority**: an empty Grafana asks the user to learn PromQL first. The dashboards are what
makes the stack useful on day one.

**Independent Test**: on the example app from US1, open each dashboard. Every panel shows data.

**Acceptance Scenarios**:

1. **Servers:** CPU, load, memory, disk use and free space, and network traffic, per server.
2. **Containers:** each container's CPU, its memory against its limit, and its restarts.
3. **HTTP traffic,** per hostname: requests, the share of errors (5xx and 4xx apart), and response
   times (median and slowest 5%).
4. **Caddy:** requests in flight, its memory and CPU, and its own errors.
5. **Postgres,** for environments with Postgres: connections against the limit, transactions,
   cache hits, the database's size, deadlocks and the longest-running query's age.
6. **Logs:** the lines by app, environment and service, searchable by text. Masked values show as
   OpsCrew's markers.
7. **Given** the user changes one of OpsCrew's dashboards, **Then** Grafana asks them to save it as
   a copy. OpsCrew's own are replaced whenever OpsCrew's version of one changes, and the user's
   copies and their own dashboards are kept.
8. **Given** the edge is nginx or the user's own proxy, **Then** design says HTTP traffic and Caddy
   need Caddy, and those two dashboards say so instead of showing empty panels.

---

### User Story 3 - Private access only (Priority: P1)

Grafana is reached only over the private network. `opscrew addon open monitoring`:
- **this computer is a device (018):** prints Grafana's private address and where its password is;
- **otherwise:** opens an SSH tunnel to the monitoring server and prints a local address, until
  the user stops it, as `opscrew addon open beszel` does.

Other devices added with `opscrew vpn add` reach the same private address.

**Why this priority**: logs and figures say a lot about an app. A dashboard on the internet is an
attack surface the user didn't ask for.

**Independent Test**:
1. Scan the monitoring server's public address: only SSH and WireGuard's UDP port answer.
2. From a device, Grafana answers.
3. From an app server, Grafana and the query APIs don't.

**Acceptance Scenarios**:

1. **Given** the stack runs, **Then** from the internet the monitoring server answers only SSH and
   WireGuard's port, and only WireGuard's once public SSH is closed (018). `opscrew secure` and
   `opscrew verify` check it.
2. **Given** a server on the network, **Then** only the two paths that receive figures and logs
   answer it. Grafana, Prometheus's queries and Loki's queries don't.
3. **Given** a device on the network, **Then** Grafana answers it, and the receiving paths don't.
4. **Given** Grafana's login, **Then**:
   - its password is generated, kept with the generated values on this computer and in the
     recovery copy (014), and never written into the repository, the plan, a host plan's text, a
     log or an audit entry;
   - sign-up and anonymous access are off;
   - Grafana sends nothing to grafana.com: no usage reports, update checks or news.
5. **Given** public SSH is closed and this computer is not a device, **When** the user runs
   `opscrew addon open monitoring`, **Then** it says to add this computer as a device, with the
   command.

---

### User Story 4 - On the app's own server (Priority: P2)

A user with a large enough server doesn't want a second one. `opscrew addon enable monitoring --on
app` runs the stack next to the app, with no extra server.

**Why this priority**: it saves the monitoring server's price, but only fits larger servers.

**Independent Test**: on a 4 GB server with a small app, turn monitoring on with `--on app`. No
server is created, and the dashboards fill.

**Acceptance Scenarios**:

1. **Given** the app's server has at least 4 GB of memory and the stack's limits fit next to the
   app's limits and the system's share, **When** the user turns monitoring on with `--on app`,
   **Then** the stack runs on the app's server. Grafana is reached through the tunnel, and also on
   the server's private address when the network has devices.
2. **Given** the server has less than 4 GB, or the stack doesn't fit, **Then** it refuses before
   any change. It names the server type that would fit and the monitoring server's price, and ends
   "Nothing was changed."
3. **Given** the environment has extra servers, **Then** they send to the stack on the app's server
   over the network.

---

### User Story 5 - One monitoring server for the repository (Priority: P2)

The user has a second app, or a staging environment, in the same repository. Turning monitoring on
there offers the repository's monitoring server, which is already running. No new server is made:
the monitoring server joins that environment's private network, and Grafana shows every app and
environment, each one a choice in the dashboards.

**Why this priority**: one small server watching everything is the roadmap's promise. Without it,
each environment would cost a server of its own.

**Independent Test**: with monitoring on for prod, turn it on for staging. No server is created, and
staging's data appears in the same Grafana under its own environment.

**Acceptance Scenarios**:

1. **Given** the repository has a monitoring server, **When** the user turns monitoring on in
   another app or environment, **Then** it offers that server by default, with the disk estimate
   for everything it would then keep. `--new-server` makes a separate one instead.
2. **When** the user runs `opscrew provision` there, **Then** it also changes the monitoring
   server: a network interface for that environment, its filter, and the stack's receiving
   address. Each change is shown and approved by its hash.
3. **Then** Grafana holds every environment's data, labelled by app and environment.
4. **Given** other environments send to the monitoring server, **When** the user turns monitoring
   off or destroys the environment that owns it, **Then** it refuses before any change. It names
   those environments and says to turn monitoring off there first.
5. **Given** a device on any of the networks, **Then** it sees every environment's dashboards, and
   `addon enable` says so when a second environment joins.

---

### User Story 6 - Retention, disk and status (Priority: P2)

The user can see that the stack is working, and is told before it fills its disk.

**Why this priority**: a monitoring stack that stopped receiving, or filled its disk, fails exactly
when it's needed.

**Independent Test**:
1. Stop the agent on one server: `opscrew addon status` flags that server within 5 minutes.
2. Set the logs' retention to 1 day: provision applies it, and older lines are gone the next day.

**Acceptance Scenarios**:

1. **Given** the defaults, **Then** figures are kept 15 days and logs 7 days. The plan can change
   both (figures 1–90 days, logs 1–30 days). Design re-estimates the disk.
2. **Given** a retention whose estimate passes 80% of the monitoring server's disk, **Then** design
   refuses it, naming a shorter retention or a larger server.
3. **Then** figures also stop growing at a size cap from the disk, so a busier app than estimated
   loses its oldest figures rather than filling the disk.
4. **When** the user runs `opscrew addon status` or `opscrew status`, **Then** it shows:
   - the stack's containers and their memory;
   - for each server, when its last figures and its last log line arrived;
   - the disk taken by figures and by logs;
   - the retention.
5. **Given** a server's data stopped more than 5 minutes ago, **Then** status flags it, with what
   to check: its agent, and its link on the network.
6. **Given** the monitoring server's disk passes 85%, **Then** 017's scheduled check warns, as for
   every server.

---

### User Story 7 - Off, and destroy (Priority: P2)

**Why this priority**: the constitution's rule. What OpsCrew installs, OpsCrew can remove, with
nothing left behind.

**Independent Test**: turn monitoring off, provision, and check every server: no agent, no stack,
no monitoring server.

**Acceptance Scenarios**:

1. **Given** monitoring is on, **When** the user runs `opscrew addon disable monitoring` and then
   `opscrew provision`, **Then**:
   - every server's agent is removed, except the app server's when Grafana Cloud still uses it;
   - the monitoring server is deleted only with its name typed, after it says the figures and logs
     go with it;
   - on the app's server, the stack and its data are removed only after the same typed
     confirmation.
2. **When** the user destroys an environment that sends to another environment's monitoring
   server, **Then** its agents are removed, and the monitoring server leaves its network.
3. **Then** nothing OpsCrew installed stays. On the user's own servers, only what was there before.
4. **Given** an environment with a monitoring server, **When** the user runs `opscrew retarget`,
   **Then** it refuses before any change, as 018 refuses plans with extra servers, and says to turn
   monitoring off first. Retargeting it is part of 023.

---

### User Story 8 - In Claude Code (Priority: P3)

**Why this priority**: the plugin's users ask "is it healthy?" and "how do I see the logs?" there
first.

**Acceptance Scenarios**:

1. **Given** monitoring is on, **When** Claude Code calls `opscrew_addon_status`, **Then** the
   answer includes monitoring's state: each server's last data, the disk and the retention, read
   only.
2. **Then** the MCP add-on tools accept `monitoring` as they accept the other add-ons, with the same
   approvals as the CLI.
3. **Then** the plugin's skill says how to open the dashboards and what each one shows.

### Edge Cases

- **The monitoring server is down:** each agent keeps what it couldn't send on its own disk for a
  bounded time, and sends it when the server is back. `addon status` says how long that is.
- **An app server with no room for the agent:** design refuses, naming the larger server type.
- **Grafana Cloud is on too:** one agent on the app's server sends to both. When the monitoring
  server is down for hours, the agent's queue for it fills and Grafana Cloud's logs wait too, until
  the oldest are dropped; `addon status` flags the silent server long before.
- **Beszel is on too:** both run; they don't share anything.
- **Postgres on an extra server:** the agent on that server reads it.
- **MySQL, MariaDB, MongoDB and the other services:** their containers are on the Containers
  dashboard. A dashboard of their own is later.
- **Public SSH is closed:** host plans run over the private network, as for every command (018).
- **The repository's monitoring server is at another provider than the app:** the network crosses
  providers, as 018's does. The price shown is the monitoring server's.
- **Two apps of the repository on one of the user's own servers:** the second app's monitoring is
  refused with the reason, as 017 refuses a second Grafana Cloud agent on one server.
- **A deploy or a rollback:** unchanged. The agents and the stack are not part of the deploy. The
  deploy only refreshes the masking file, as it does for Grafana Cloud.
- **A new OpsCrew version with newer pinned images:** the next `provision` shows the host plans with
  the new versions.
- **The user's computer is not the one that turned monitoring on:** `addon open` says where
  Grafana's password is, and that the recovery copy holds it.
- **Portainer, this computer (localhost), Cloudflare and GitHub Pages:** refused, with the reason:
  OpsCrew doesn't manage those hosts, or there is no host.

## Requirements *(mandatory)*

### Functional Requirements

**Turning it on**
- **FR-2001**: `opscrew addon enable monitoring` MUST say, before any change: the monitoring
  server (provider, location, type, monthly price), what runs on it, the agent's memory and price
  share on each server, the retention and its disk estimate, that the data stays on the user's
  servers, and that Grafana and Loki are AGPL-3.0 and run unmodified.
- **FR-2002**: it MUST only write the plan. Servers, accounts and the repository change only
  through `opscrew provision`, each change shown and approved by its hash.
- **FR-2003**: the monitoring server MUST be one of the plan's extra servers (018), with no app
  services on it. By default it is at the app's provider and location, as the smallest type whose
  memory holds the stack's limits and the system's share.
- **FR-2004**: turning monitoring on MUST create the private network when the environment has none.
- **FR-2005**: with `--on app`, the stack MUST run on the app's server, only when it has at least
  4 GB of memory and the stack's limits fit next to the app's. Otherwise it refuses, naming what
  would fit.
- **FR-2006**: in a repository with a monitoring server, turning monitoring on in another app or
  environment MUST use that server by default, joining it to that environment's network.
  `--new-server` makes a separate one.
- **FR-2007**: monitoring MUST be refused on Portainer, localhost, Cloudflare and GitHub Pages,
  with the reason.

**Collecting**
- **FR-2008**: every server of a monitored environment MUST run one agent (Grafana Alloy, pinned)
  that sends:
  - the server's figures: CPU, load, memory, disk and network;
  - each container's CPU, memory, limit and restarts;
  - the logs of the app's containers on that server;
  - Caddy's figures, on the server that runs the edge;
  - Postgres's figures, on the server that runs it.
- **FR-2009**: the agent MUST mask log lines before they leave the server, as 017 does: OpsCrew's
  token patterns, the app's known values, and Gitleaks' rules.
- **FR-2010**: the agent MUST read Docker only through OpsCrew's read-only proxy, and Postgres
  through a login of its own that can only read the server's statistics.
- **FR-2011**: on a server where Grafana Cloud is on too, one agent MUST send to both.
- **FR-2012**: Caddy's figures MUST be on per hostname, served only on the edge's internal Docker
  network and never published. They are on in every edge, since the edge is shared by every OpsCrew
  app on a server. Without monitoring, every other generated file MUST stay byte-identical.

**The stack**
- **FR-2013**: the stack MUST run pinned images of Prometheus, Loki and Grafana, each with a memory
  limit, on the monitoring server (or the app's server with `--on app`).
- **FR-2014**: only the two receiving paths MUST answer on the network, and only to the network's
  servers. Grafana MUST answer only devices (and the tunnel). Neither query API is reachable from
  the network.
- **FR-2015**: app servers' filters MUST NOT admit the monitoring server to any of their published
  ports. SSH on the private network stays as 018 opened it, to every member, and a login still needs
  a key.
- **FR-2016**: Grafana MUST start with Prometheus and Loki as its data sources and OpsCrew's
  dashboards, provisioned from files and replaced whenever OpsCrew's version of one changes. The
  user's own dashboards are kept.
- **FR-2017**: Grafana's admin password MUST be generated and kept with the generated values and the
  recovery copy. Sign-up, anonymous access, usage reports, update checks and news MUST be off.
- **FR-2018**: OpsCrew's dashboards MUST be its own (Apache-2.0), one each for servers, containers,
  HTTP traffic, Caddy, Postgres and logs, with app, environment and server choices.

**Retention and status**
- **FR-2019**: figures MUST be kept 15 days and logs 7 days by default; the plan can set 1–90 and
  1–30 days. Figures also stop at a size cap derived from the disk.
- **FR-2020**: design MUST estimate the disk the retention takes, from the servers' series and log
  volume, and refuse a retention estimated above 80% of the disk.
- **FR-2021**: `opscrew addon status` and `opscrew status` MUST show the stack's containers, each
  server's last figures and last log line, the disk taken, and the retention, and flag a server
  silent for more than 5 minutes.

**Access**
- **FR-2022**: `opscrew addon open monitoring` MUST print the private address when this computer is a
  device, or open an SSH tunnel otherwise, and say where the password is.

**Off and destroy**
- **FR-2023**: `opscrew addon disable monitoring` followed by `provision` MUST remove every agent
  OpsCrew installed for monitoring and the stack. The monitoring server, or the stack's data on the
  app's server, MUST be deleted only with `allowDestroy` and the typed name.
- **FR-2024**: turning off or destroying the environment that owns a shared monitoring server MUST
  be refused while other environments send to it.
- **FR-2025**: destroying a sending environment MUST remove its agents and the monitoring server's
  membership in its network.
- **FR-2026**: `retarget` MUST refuse an environment with monitoring on, saying to turn it off first.

**Surfaces**
- **FR-2027**: the MCP add-on tools MUST accept `monitoring`, with the CLI's approvals. Status data is
  read-only.
- **FR-2028**: the guide MUST gain a monitoring page (what runs, the price, access, retention, the
  dashboards, the licences, turning it off), linked from the index and the observability pages.

### Key Entities

- **Monitoring settings** (`plan.observability.monitoring`): on or off, where the stack runs (an
  extra server, or the app's server), or which repository plan's server it sends to; the pinned
  versions; the retention; the memory limits.
- **The monitoring server:** an extra server (018) holding the stack and no app services.
- **The agent:** one Grafana Alloy per server, set up by a host plan, sending to the stack and, on
  the app's server, to Grafana Cloud when that is on.
- **The stack:** Prometheus, Loki, Grafana and the front that receives, as Compose files on the
  monitoring server, set up by a host plan.
- **Grafana's login:** a generated password, kept like every generated value.

## Success Criteria *(mandatory)*

- **SC-2001**: on the example app, every server's data is visible in Grafana within 2 minutes of
  `provision` finishing.
- **SC-2002**: from the internet, the monitoring server answers only SSH and WireGuard's port. From an
  app server, only the receiving paths answer.
- **SC-2003**: in the Docker pass and the live pass, every panel of every dashboard shows data on the
  example app.
- **SC-2004**: no app secret, token or known value appears in the stored logs (a leak check in the
  Docker pass and the live pass).
- **SC-2005**: the stack stays within its memory limits on the default monitoring server with three
  servers sending.
- **SC-2006**: a plan without monitoring renders every file byte-identical to today's (snapshots),
  except the shared edge, whose Caddy figures are always on (plan.md 7.).
- **SC-2007**: after turning monitoring off or destroying, nothing OpsCrew installed for it remains
  on any server.
- **SC-2008**: none of a token, an app secret, Grafana's password or a server's public address
  appears in an approval's text, the output, an audit entry, a committed or generated file, or an
  MCP answer.

## Assumptions

The lead's defaults, for the founder to change:
- **Where by default:** a separate server at the app's provider and location, the smallest type
  that fits (at Hetzner, a 4 GB type in the €4–5 range the roadmap names).
- **Retention:** 15 days of figures and 7 days of logs.
- **One monitoring server per repository,** owned by the first environment that turns it on. Across
  repositories is later.
- **No alerting in the stack:** 017's scheduled check stays the alert path.
- **Postgres is the only database with a dashboard of its own.**
- **HTTP figures come from Caddy,** the default edge. With nginx or the user's own proxy, those two
  dashboards say they need Caddy.
- **A second app on one of the user's own servers** can't turn monitoring on in this version, as
  for Grafana Cloud.
- **A device on any of the networks sees every environment's dashboards.** Grafana has one login.

## Out of scope

- Alert rules in Grafana, traces, and dashboards for databases other than Postgres.
- Monitoring servers shared across repositories, and dashboards across projects (the hosted
  control plane).
- Full-text log search with OpenSearch (later, if users ask, per the roadmap).
- Grafana on a public hostname behind Cloudflare Access.
- Backups of the stack's data, and a highly available stack.
- Tailscale or Headscale as the network.
- Retargeting an environment with monitoring on (023).
