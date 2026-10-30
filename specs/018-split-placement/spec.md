# Feature Specification: Split placement and the private network

**Feature Branch**: `main` (feature directory `specs/018-split-placement`)
**Created**: 2026-10-30
**Status**: Draft
**Input**: The roadmap's "split placement" (founder, 2026-10-20) and the private WireGuard network
from the observability feature's "part 2" (founder, 2026-10-18), which 017 left out and the
founder moved here on 2026-10-30:
- one app across several servers: a service on a server of its own, also at another provider;
- a private link between the servers, with the services listening only on it and the firewall
  allowing only the app's servers;
- research first: Docker Swarm as the alternative to WireGuard plus Compose per server (done:
  [research.md](research.md) R1 chose WireGuard);
- the user's devices on the same private network, reaching SSH, Beszel and Portainer, so public
  SSH can close; the server's runners deploy over it;
- the production database and cache from the user's device over it: off by default, per service,
  read-only recommended;
- design shows the latency each cross-server hop adds and warns when it hurts;
- plans approved by hash on each server, destroy removing only what OpsCrew installed, and drift
  and status per server.

The founder gave the go-ahead for research, spec, plan, tasks and implementation on 2026-10-30.
The self-hosted monitoring stack is feature 019 ([roadmap](../roadmap.md)).

## Why

Today one app is one server: the web process, its workers and every database, cache and broker
share one machine. That is right for most apps, until one part outgrows it:
- a busy database wants more memory than the app's server can spare, or a disk of its own;
- a service has to stay where its data is while the app moves;
- the user already has a server with room, at another provider or at home.

The usual answers are a bigger server for everything, or a managed database at a hyperscaler's
prices. OpsCrew's users want the third answer: put that one service on a small server of its own,
linked privately to the app, without exposing the database to the internet.

The same private network solves a second problem. Today the user reaches a server's SSH, its
Beszel or its Portainer through the public SSH port, which is open to the internet (restricted
only by an allow-list most people leave open). A private network that the user's laptop and phone
can join lets them reach all of it privately, and lets public SSH close.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Give a service a server of its own (Priority: P1)

The user decides that a service, such as the app's Postgres, gets a server of its own. They add the
server to `opscrew/plan.yaml` and name it on the service, or answer design's prompt. Design shows
the new server's price, the monthly total, and how much slower each query becomes across the link.
`opscrew provision` creates the server, links the servers privately, starts the service there and
points the app at it. A live app's data moves with the service in a short maintenance window.

**Why this priority**: it is the feature. Every other story builds on the private network this one
creates.

**Independent Test**: deploy an example app with Postgres on one server, then give Postgres a
server of its own at the same provider. The app answers, every row is still there, and the
database's port answers only from the app's server over the private link: not from the internet,
and not from any other address.

**Acceptance Scenarios**:

1. **Given** a plan with a service placed on a second server, **When** the user runs
   `opscrew design`, **Then** design shows each server with its provider, location, size and
   monthly price, the services on it with their memory, the total, and the estimated delay each
   query to that service adds. It warns when the delay is large enough to slow the app's pages
   noticeably.
2. **Given** that plan, **When** the user runs `opscrew provision` and approves its plans,
   **Then** the second server is created (or set up, if it is the user's own), the private
   network joins the servers, the service starts on the second server listening only on the
   private network, and the app reaches it there. The app's own code and settings files are
   unchanged; only the address it is given changes.
3. **Given** a live app whose Postgres moves to a server of its own, **When** the user approves
   the move, **Then** design first shows the maintenance window it needs (from the database's
   size). In the window, the app stops, the data is copied, the app starts against the new server,
   and the old copy is removed only after the app answers. Any failure in the window starts the
   app again against the old copy.
4. **Given** a service on another server that has no login of its own (Kafka, Redpanda,
   OpenSearch), **When** design shows it, **Then** design says that only the app's servers can
   reach it, through the private network, and that it has no login.
5. **Given** a service on a second server, **When** the user moves it back to the app's server
   (or to another server) and approves, **Then** its data moves the same way. A server that no
   longer runs anything is deleted only through destroy's typed confirmation of its name.
6. **Given** the app's server or the service's server restarts, **When** it comes back, **Then**
   the private link and the service come back by themselves, and the app reconnects.
7. **Given** a placement OpsCrew can't link, such as two servers that both lack a public address,
   **When** design checks the plan, **Then** it refuses the plan before any change and says what
   would work.

---

### User Story 2 - Every command covers every server (Priority: P1)

Once an app spans several servers, the commands the user already knows work across all of them:
deploys update the services on every server, and `status`, `logs`, `drift`, `secure`, `verify`,
`destroy` and the scheduled check cover each server, saying which server each line is about.
`status` also shows the private network: each link, whether it is up, and its measured delay.

**Why this priority**: an app the user can't watch, check or tear down in one command is a
regression from one server.

**Independent Test**: on the deployment of US1, change the service's version and push: the deploy
updates it on its server. `status` lists both servers with their figures and the link's delay.
`logs --service db` shows the database's lines from its server. A hand-made change on the second
server shows in `drift`. `destroy` lists both servers and removes both after the typed names.

**Acceptance Scenarios**:

1. **Given** an app with a service on another server, **When** a commit is pushed, **Then** the
   deploy workflow updates that server's services before it switches the app, and a failure there
   stops the deploy before the app changes.
2. **Given** that app, **When** the user runs `opscrew status`, **Then** each server is shown with
   its figures (017) and containers, and the private network with each link's state, the time of
   its last handshake and its measured round trip.
3. **Given** that app, **When** the user runs `opscrew logs --service <name>`, **Then** the lines
   come from the server that runs it.
4. **Given** a change made by hand on any of the app's servers, **When** the user runs
   `opscrew drift`, **Then** it is reported with the server's name.
5. **Given** that app, **When** the user runs `opscrew secure`, **Then** every server is checked,
   including that each service on another server answers only on the private network.
6. **Given** that app, **When** the user runs `opscrew destroy`, **Then** every server OpsCrew
   created is listed, and each needs its typed name before it is deleted. On the user's own
   servers, only what OpsCrew installed is removed: its services, the private network's interface,
   its firewall rules and its records.
7. **Given** the scheduled check (017) is on, **When** it runs, **Then** it checks the disk of every
   server of the app.

---

### User Story 3 - Your devices on the private network (Priority: P2)

The user runs `opscrew vpn add laptop`. OpsCrew makes the device's key on this computer, adds the
device to the app's servers through a plan the user approves, and writes the device's configuration
for the official WireGuard app, or shows it as a QR code for a phone. With the tunnel on, the user
reaches each server's SSH, and Beszel's and Portainer's dashboards, on the private network's
addresses, with no SSH tunnel and no public dashboard. `opscrew vpn remove laptop` takes the device
off every server. This works for an app on one server too.

**Why this priority**: private access to the servers is the main safety gain of the network for
every app, not only for apps that split.

**Independent Test**: add a device, bring its tunnel up on a test machine, and reach SSH on each
server and Beszel's dashboard over the private addresses. Remove the device: its tunnel no longer
connects.

**Acceptance Scenarios**:

1. **Given** an app on one or more servers, **When** the user runs `opscrew vpn add <name>` and
   approves the plan, **Then** the device is added to every server with a public address, its
   configuration is written to a file only the user can read, and, with `--qr`, shown as a QR code.
   The device's private key is in that file only: never in a plan, the repository, a log or the
   audit log.
2. **Given** a device on the network, **When** its tunnel is up, **Then** SSH, Beszel's dashboard
   and Portainer's web UI (when those add-ons are on) answer on the server's private address, and
   `opscrew addon open` and `opscrew portainer` say to use that address instead of opening an SSH
   tunnel.
3. **Given** the network's devices, **When** the user runs `opscrew vpn list`, **Then** each device
   is shown with its address and when it last connected to each server.
4. **Given** a device that is lost, **When** the user runs `opscrew vpn remove <name>` and approves,
   **Then** the device is taken off every server and can no longer connect.
5. **Given** a device on the network, **When** it tries to reach a service's port that it wasn't
   granted (US5), **Then** the server refuses it.

---

### User Story 4 - Close public SSH (Priority: P2)

Once the deploys reach the servers from inside the private network, and the user's computer is a
device on it, `opscrew secure` offers to close public SSH on every server of the app. After that,
SSH answers only on the private network, and every OpsCrew command connects there.

**Why this priority**: an open SSH port is the largest remaining attack surface on OpsCrew's
servers. It depends on US3.

**Independent Test**: with deploys on the app server's own runner and this computer on the
network, close public SSH. Port 22 no longer answers from the internet; a push still deploys;
`status`, `logs` and `drift` still work from this computer.

**Acceptance Scenarios**:

1. **Given** deploys that still run on GitHub's own runners, or this computer not on the network,
   **When** the user asks to close public SSH, **Then** OpsCrew refuses and says which condition is
   missing and how to meet it.
2. **Given** both conditions are met, **When** the user approves the plans, **Then** SSH is closed
   to the internet on every server (firewall and cloud firewall) and allowed on the private
   network, under the same safeguard that undoes an SSH change when the connection is lost.
3. **Given** public SSH is closed, **When** the user runs any OpsCrew command that reaches a
   server, **Then** it connects over the private network, and says plainly when this computer's
   tunnel is down.
4. **Given** public SSH is closed, **When** the user asks to open it again, **Then** a plan they
   approve reopens it with the allow-list the plan holds.

---

### User Story 5 - The database or cache from your device (Priority: P3)

The user wants to look at production data with psql, DBeaver or redis-cli. They grant one device
access to one service: read-only (recommended) or full. OpsCrew creates a separate login for that
access, opens the service's port on the private network to that device only, and prints the
connection details. The app's own credentials never reach the device. Turning the access off
removes the login and the rule.

**Why this priority**: useful but optional, and it widens access to production data, so it comes
after the network and the devices.

**Independent Test**: grant a device read-only access to Postgres, connect with the printed details
over the tunnel and read a table; a write is refused. Another device can't connect. Turn it off:
the login is gone and the device can't connect.

**Acceptance Scenarios**:

1. **Given** a device on the network and a database or cache (Postgres, MySQL, MariaDB, MongoDB,
   Valkey, Redis or Dragonfly), **When** the user grants it read-only access and approves, **Then**
   a login that can read but not write is created, the service answers that device on the private
   network, and the connection details are printed once.
2. **Given** a grant of full access, **When** the user asks for it, **Then** OpsCrew warns plainly
   that the device can change production data, and creates a login of its own with the app's
   rights, never the app's own login.
3. **Given** grants, **When** the user runs `status` or `secure`, **Then** each grant is listed by
   device, service and kind of access.
4. **Given** a grant, **When** the user turns it off and approves, **Then** the login and the rule
   are removed, and a service that no device needs any more stops answering on the network
   (unless the app needs it there).
5. **Given** a service of another kind (a broker or search engine), **When** the user asks for
   access, **Then** it is refused with the reason.

---

### User Story 6 - The same from Claude Code (Priority: P2)

In Claude Code, the user asks which servers the app runs on, how the private network is doing, or
what a split would cost. The MCP server answers from read-only tools, and the plugin's skills
explain how to place a service and add a device.

**Why this priority**: plugin users get the same picture as CLI users. Adding a device makes a
private key, so it stays a CLI command and never passes through a model.

**Independent Test**: through the MCP server, list the servers and links of the US1 deployment,
with the measured delay, and the design's estimate for a placement. No tool returns a key.

**Acceptance Scenarios**:

1. **Given** an app on several servers, **When** an MCP client asks for its status, **Then** the
   answer includes each server and each link, the same as `opscrew status`.
2. **Given** a user asking in Claude Code to add a device, **When** the skill answers, **Then** it
   tells the user to run `opscrew vpn add` in their terminal, and says why.

---

### Edge Cases

- **A server without a public address** (the user's own server behind NAT, served through a
  Cloudflare Tunnel): it can be the app's server, linked to services on servers that have a public
  address, and it keeps its links alive from its side. A service can't be placed on such a server
  in this version, because deploys and OpsCrew's commands reach extra servers through their own
  public address. Devices reach it only through the servers that have one: design says so.
- **Two providers:** the app's server at Hetzner and the database at DigitalOcean (or the reverse)
  work the same. Design's delay estimate says when the hop crosses a long distance.
- **The address range is taken:** the private network uses a range of private addresses. When it
  clashes with a network one of the servers already has (a provider's private network, a home
  LAN), the host plan refuses with the range in use, and the user picks another in the plan.
- **WireGuard's port is taken** on the user's own server: the plan picks the next free port and
  says so.
- **Several apps on one own server** (013): each app has its own private network on that server,
  with its own interface and port.
- **Environments** (015): each environment has its own network, so a staging device can't reach
  prod.
- **Other data on the move:** Postgres's data is copied. Valkey, Redis and Dragonfly start empty on
  their new server, and design says that queued jobs would be lost, as `retarget` does today. Any
  other service that holds data on a live app is refused until retarget anywhere (022) brings its
  copy; on an app that was never deployed, every service can be placed anywhere.
- **The private network fails** (a provider blocks the UDP port, a key mismatch): `status` shows the
  link down with the time of its last handshake, `verify` and `secure` report it, and the app's
  health check fails as it would for any unreachable database.
- **A device with an old configuration after a server is added:** `vpn list` says which devices
  lack the new server; `vpn add <name> --again` writes a new configuration for that device.
- **The user's own server already runs WireGuard:** OpsCrew adds its own interface and leaves the
  existing one alone; a clashing range or port is handled as above.
- **Retarget:** an app with services on other servers can't be moved by `retarget` until 022; it
  refuses plainly, before any change.
- **Portainer, the user's computer, Cloudflare's hosting and GitHub Pages:** placement and the
  private network apply to servers only (cloud and own). Design refuses a placement on those
  targets and says why.
- **Add-ons (Beszel, Grafana Alloy):** they stay on the app's server in this version; the other
  servers' figures come from `status`. Monitoring every server is 019's.
- **Losing this computer's configuration while public SSH is closed:** the user adds this computer
  again from another device on the network, or opens SSH from the provider's console. The guide
  says both.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-1801**: The plan MUST let the user add servers to an app, each with a name, and place any of
  the app's services on one of them. The app's web process, workers, cron jobs and the edge stay on
  the app's server. A server is a cloud server (Hetzner or DigitalOcean, mixed freely with the app
  server's provider) or the user's own server with a public address.
- **FR-1802**: Design MUST show, for each server, its provider, location, size, monthly price and
  the services on it with their memory, and the total for the app. It MUST size a new cloud server
  from its services' memory, as it sizes the app's server.
- **FR-1803**: Design MUST estimate the delay of each hop between the app's server and a service on
  another server, say what it adds to a page that makes many queries in a row, and warn above a
  threshold. When the delay can't be estimated (the user's own servers), it MUST say that `status`
  measures it.
- **FR-1804**: The app's servers MUST be joined by one private, encrypted WireGuard network per
  app and environment. Each server MUST expose only WireGuard's UDP port to the internet beyond
  what it exposed before (SSH, and the web on the app's server).
- **FR-1805**: A service on another server MUST listen only on that server's private address, and
  MUST answer only the app's servers' private addresses and the devices granted access (US5). This
  MUST hold even though Docker's published ports bypass the host firewall.
- **FR-1806**: The private network MUST come back after a reboot of any server without action, and
  start before the services that listen on it.
- **FR-1807**: Every change the private network and the placement need MUST go through plans
  approved by their hash (constitution I): the IaC engine for cloud servers and cloud firewalls,
  and the host adapter for each server's own changes. Each server's host plan is shown and approved
  on its own.
- **FR-1808**: WireGuard's private keys MUST never appear in a plan, the repository, a log, the
  audit log, a model prompt or terminal output (constitution IV). A server's private key MUST reach
  only its own server. A device's private key MUST be written only into the configuration the user
  asked for.
- **FR-1809**: Moving a live service between the app's servers MUST copy Postgres's data in a
  maintenance window whose length design shows first. It MUST keep the old copy until the app
  answers against the new one, and MUST start the app again against the old copy when any step in
  the window fails. Valkey, Redis and Dragonfly MUST start empty with a warning. Other services with
  data on a live app MUST be refused until 022.
- **FR-1810**: The deploy workflow MUST update the services on every server of the app, before the
  app's switch, and MUST stop the deploy when a server's update fails.
- **FR-1811**: `status`, `logs`, `drift`, `secure`, `verify`, `destroy` and the scheduled check's
  disk check MUST cover every server of the app and name the server in what they show. `status`
  MUST show each link's state, last handshake and measured round trip.
- **FR-1812**: `destroy` MUST list every server and need each OpsCrew-created server's typed name
  before deleting it. On the user's own servers it MUST remove only what OpsCrew installed.
- **FR-1813**: `opscrew vpn add|remove|list` MUST manage the devices of an app's network. Adding a
  device MUST write its configuration to a file only the user can read and, on request, show it as
  a QR code. Removing one MUST take it off every server.
- **FR-1814**: With a device on the network, SSH and the dashboards of Beszel and Portainer MUST be
  reachable on each server's private address from devices only. The commands that open those
  dashboards MUST point to the private address when this computer is on the network.
- **FR-1815**: `opscrew secure` MUST offer to close public SSH on all of the app's servers only when
  every deploy of the app runs on a runner inside the network and this computer is a device on it.
  Closing and reopening MUST be plans approved by hash, guarded by the existing safeguard against
  locking the user out.
- **FR-1816**: With public SSH closed, every OpsCrew command that reaches a server MUST connect over
  the private network, and MUST say plainly when this computer's tunnel is down.
- **FR-1817**: A device MAY be granted access to a database or cache (Postgres, MySQL, MariaDB,
  MongoDB, Valkey, Redis, Dragonfly): read-only, or full with a warning. Each grant MUST have its own
  login, never the app's. Its password MUST be kept only on this computer, with the app's other
  generated secrets. Turning a grant off MUST remove its login and its rule. Grants MUST be listed
  in `status` and `secure`.
- **FR-1818**: Kafka, Redpanda and OpenSearch MUST be allowed on another server only behind FR-1805's
  address rule, and design MUST say they have no login. Devices MUST NOT be granted access to them.
- **FR-1819**: Design MUST refuse, before any change, a placement it can't link (no server with a
  public address between two servers), a placement on a target that isn't a server, and a service
  on a server without a public address. Every refusal MUST say what would work.
- **FR-1820**: `retarget` MUST refuse an app with services on other servers, before any change,
  until 022.
- **FR-1821**: The MCP server MUST return the servers, links, devices (names and addresses only) and
  grants as read-only data, and design's estimate for a placement. The plugin's skills MUST explain
  placement and devices, and send the user to the CLI to add a device.
- **FR-1822**: The user guide MUST have pages for:
  - placing a service on a server of its own, with the costs, the delay and the data move;
  - the private network and devices, with the official WireGuard apps;
  - closing public SSH, and getting back in when this computer's configuration is lost;
  - database and cache access from a device.
  The runbook OpsCrew writes into the user's repository MUST describe each server and the network.
- **FR-1823**: Live end-to-end tests MUST cover:
  - US1 and US2 on two cloud servers;
  - a device on the network (US3);
  - closing and reopening public SSH (US4);
  - a read-only grant (US5).
  The coverage page MUST record each run.

### Key Entities

- **Server:** the app's server or an extra one, by name. For a cloud server: provider, location,
  type and backups. For the user's own server: its facts, with its address kept on this computer
  only, as today.
- **Placement:** which server runs each of the app's services. The app's server by default.
- **Private network:** one per app and environment. Its address range, its UDP port, and each
  member's address and public key. Servers' endpoints (their public addresses) stay on this
  computer.
- **Device:** a named member that isn't a server, such as a laptop or a phone. Its address and
  public key; never its private key.
- **Access grant:** a device, a service and the kind of access (read-only or full). Its login's
  password is kept only on this computer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1801**: An example app with Postgres on a server of its own passes `verify`. From the
  internet, and from any address other than the app's server, the database's port doesn't answer.
  Each extra server answers from the internet only on SSH and WireGuard's UDP port.
- **SC-1802**: Moving a live example's Postgres to a server of its own, and back, keeps every row
  (counts and checksums match). The app is unavailable no longer than the window design showed.
- **SC-1803**: After either server reboots, the app answers again within 5 minutes with no action.
- **SC-1804**: A device added with `vpn add` reaches SSH on every server with a public address
  within 1 minute of bringing its tunnel up. After `vpn remove`, its tunnel can't reach any server.
- **SC-1805**: With public SSH closed, port 22 doesn't answer from the internet, a push still
  deploys, and `status`, `logs` and `drift` work from the device computer.
- **SC-1806**: A read-only grant reads, and every write through it is refused, for each of the
  seven kinds. After the grant is turned off, the login no longer exists.
- **SC-1807**: Across the live passes, no private key, password or generated secret appears in a
  plan, host plan, committed file, log, audit entry or terminal output, except the one device
  configuration the user asked for.
- **SC-1808**: For two cloud servers, design's delay estimate is within a factor of two of the
  round trip `status` measures.

## Assumptions

Defaults the lead chose on 2026-10-30. The founder can change any of them.

- **The network:**
  - Plain WireGuard, set up by OpsCrew: no account and no third party. Tailscale and Headscale come
    later ([roadmap](../roadmap.md)).
  - One network per app and environment. A device that should reach several apps joins each of
    them.
  - Every server of the app is linked to every other one. A device is linked to each server with a
    public address.
- **No TLS on top of WireGuard.** Every packet between the servers is already encrypted and tied to
  the sending server's key ([research.md](research.md) R3). TLS would need certificates and
  changes to how the app connects, for no gain on an encrypted link.
- **Logins:** the 15 services that have a login keep it. Kafka, Redpanda and OpenSearch stay
  without one, reachable only from the app's servers, because turning one on would break apps whose
  clients don't send it (R3).
- **What moves:** services only. Workers and cron jobs stay with the app on its server; they may
  come later.
- **Extra servers:** by default the same provider and location as the app's server (the shortest
  hop), sized for their services. They serve no web traffic.
- **Device configurations** are written under the user's OpsCrew folder on this computer, readable
  only by the user. A QR code is shown only on request.
- **Database access** covers Postgres, MySQL, MariaDB, MongoDB, Valkey, Redis and Dragonfly, as the
  founder's "the production database and cache" asked. Read-only is recommended and is the
  default answer.
- **Out of scope:**
  - Docker Swarm, and a Swarm the user already runs (later; research R1);
  - Tailscale and Headscale (later);
  - placement on Portainer, the user's computer and server-less targets;
  - a service on a server without a public address;
  - workers and cron on other servers;
  - add-ons on the extra servers (019 watches every server);
  - the self-hosted monitoring stack (019);
  - moving the data of services other than Postgres (022);
  - retarget for apps with extra servers (022).
