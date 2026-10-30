# Research: split placement and the private network (018)

Research from 2026-10-30: three Sonnet agents on official sources (Docker Swarm, WireGuard, the
engines' logins and TLS) and two code maps of every place that assumes one server. "Unverified"
marks a fact no fetched official page confirmed; the spikes in the plan check those that matter.
The plan phase adds its own sections below these.

## R1. Docker Swarm, or WireGuard plus a Compose project per server

The founder asked (2026-10-21) to research Swarm before choosing.

**Facts:**
- Swarm mode is maintained. Docker Engine 29.9.2 (2026-10-20) is the latest release.
  - 29.9.0 (2026-10-08) fixed overlay peers becoming unreachable after a rejoin, a gossip drop, and
    encrypted-overlay traffic that could be sent unencrypted.
  - 29.8.2 (2026-09-30) fixed a CVE that let unprivileged users on a node forge frames into
    encrypted overlays.
  - Source: https://docs.docker.com/engine/release-notes/29/
- The Swarm overview carries no deprecation notice. Mirantis's last public commitment (2020)
  promises support with no end date; no 2026 statement was found.
  https://docs.docker.com/engine/swarm/,
  https://www.mirantis.com/blog/mirantis-will-continue-to-support-and-develop-docker-swarm/
- **Ports between nodes:**
  - 2377/tcp for the managers;
  - 7946/tcp+udp for discovery (fixed);
  - 4789/udp for VXLAN data;
  - IP protocol 50 (ESP) for encrypted overlays.
  - VXLAN has no authentication: never allow 4789 at a perimeter, and use `--opt encrypted` on
    untrusted networks, which has a noticeable cost.
  - Sources: https://docs.docker.com/engine/swarm/swarm-tutorial/,
    https://docs.docker.com/engine/network/drivers/overlay/
- Every node must be reachable at its advertised address, so a home server behind NAT is a poor
  fit. ESP across NAT and across providers: unverified.
  https://docs.docker.com/engine/swarm/networking/
- **Quorum:** N managers tolerate (N−1)/2 failures.
  - With one manager, losing it freezes all management.
  - Two managers are worse than one.
  - Three managers use every server a typical OpsCrew user has.
  - Source: https://docs.docker.com/engine/swarm/admin_guide/
- **Data:** tasks are rescheduled when a node dies, but named volumes are local to a node, so a
  database must be pinned to its node anyway.
- **`docker stack deploy`** differs from Compose:
  - secrets are immutable;
  - the routing mesh hides the client's address (unverified);
  - `build` and `depends_on` conditions are ignored (unverified; the reference names only `links`).
  - Sources: https://docs.docker.com/reference/cli/docker/stack/deploy/,
    https://docs.docker.com/reference/compose-file/deploy/
- **Portainer:** its Git stack form is the same for Swarm and standalone environments, but
  `env_file: stack.env` doesn't work on Swarm. https://docs.portainer.io/user/docker/stacks/add

**Decision:** WireGuard plus a Compose project per server.

**Rationale:**
- Mixed providers and servers behind NAT are common for OpsCrew's users; WireGuard needs one
  reachable UDP port, and keepalives carry it through NAT.
- Swarm's rescheduling doesn't help the stateful services that are the reason to split.
- Its quorum is awkward at two or three servers.
- It would replace OpsCrew's Compose files, the kamal-proxy switch, `depends_on` health
  conditions and the edge's view of client addresses.
- Its overlay networking had a run of bugs and a CVE in 2026.
- A WireGuard network keeps each server's public surface at one UDP port and fits the host plans
  approved by hash.

**Alternative kept for later:** a Swarm the user already runs, through the Portainer adapter
(see [roadmap](../roadmap.md), "Later").

## R2. WireGuard

**Installing it:**
- `apt install wireguard` on Ubuntu and Debian; the tools are in `wireguard-tools`.
- Kernels 5.6 and later have the module, so Ubuntu 22.04/24.04 and Debian 12/13 need no extra
  module package (the install page only implies this).
- Source: https://www.wireguard.com/install/

**`wg-quick` configuration:**
- `Address`, `ListenPort`, `PrivateKey`, `PostUp`/`PostDown` (`%i` is the interface), `MTU` and
  `Table`.
- `SaveConfig` must stay off: it overwrites the file on shutdown.
- When unset, the MTU is picked from the endpoint's route; the common 1420 is unverified.
- Sources: https://man7.org/linux/man-pages/man8/wg-quick.8.html,
  https://man7.org/linux/man-pages/man8/wg.8.html

**Peers:**
- `AllowedIPs` both filters what a peer may send and routes what goes to it.
- `Endpoint` follows the latest authenticated packet, so roaming works.
- `PersistentKeepalive` is off by default; 25 seconds is the quickstart's value behind NAT.
  https://www.wireguard.com/quickstart/
- `PresharedKey` is optional.
- `wg syncconf <if> <(wg-quick strip <if>)` applies peer changes without dropping sessions. It
  needs bash's process substitution or a temporary file, and changes to `Address` or `PostUp` need
  a restart.

**Keys:**
- Curve25519, 32 bytes, base64 in the `wg` tools. https://www.wireguard.com/protocol/
- Node's `crypto` supports `x25519`, exporting JWK (`d` and `x`, base64url per RFC 8037), so
  OpsCrew can make keys without the `wg` binary. https://nodejs.org/api/crypto.html
- WireGuard clamps private keys on use. A test compares against `wg pubkey` when the binary is
  present.

**Clients:** the official apps for Windows, macOS, iOS and Android, and `wg-quick` on Linux. They
import a configuration file; the mobile apps also scan a QR code (widely documented, not on the
fetched pages).

**Docker and the firewall:**
- Published ports are handled in the `nat` table before ufw's chains, so ufw doesn't filter them.
  https://docs.docker.com/engine/network/packet-filtering-firewalls/
- Binding a port to one host address limits where it is reachable.
  https://docs.docker.com/engine/network/port-publishing/
- OpsCrew already filters published ports in the `DOCKER-USER` chain on servers it serves directly
  behind Cloudflare (009's web filter).
- **Unverified, so spiked:**
  - whether a container whose port is bound to the WireGuard address fails to start when the
    interface is down (so WireGuard must start before Docker);
  - whether a container on a bridge network reaches a peer's WireGuard address through the
    host's route and Docker's masquerading.

**Provider pieces:**
- Hetzner Cloud Firewall: inbound is closed until allowed. https://docs.hetzner.com/cloud/firewalls/overview/
- DigitalOcean's Cloud Firewall takes UDP rules from any source, and is independent of ufw.
  https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/
- Hetzner's private Networks are free but limited to one network zone.
  https://docs.hetzner.com/networking/networks/faq/
- DigitalOcean's VPC is private to one region (the region limit is unverified).
  https://docs.digitalocean.com/products/networking/vpc/
- Neither reaches another provider, a home server or a device, so they are no replacement for
  WireGuard.

**Tailscale and Headscale:**
- Headscale is BSD-3-Clause and supports the official clients, including iOS and Android, with
  some configuration. https://github.com/juanfont/headscale,
  https://headscale.net/stable/about/clients/
- Tailscale's free Personal plan is "only suitable for non-commercial use".
  https://tailscale.com/pricing

**Decision:** plain WireGuard in 018; Tailscale and Headscale later
([roadmap](../roadmap.md)). A plain WireGuard network needs no account and no extra server, and
it is free for any use.

## R3. Logins and TLS on the services that cross servers

**What OpsCrew runs today** (`packages/iac-templates/src/catalog/entries.ts`): 15 of the 18 kinds
have a login whose secret OpsCrew generates:
- Postgres, MySQL, MariaDB, MongoDB, Valkey, Redis, Dragonfly, RabbitMQ, Elasticsearch, ClickHouse
  and Neo4j by password;
- NATS by token; Garage by key; Meilisearch by master key; Typesense by API key.

Kafka, Redpanda and OpenSearch run without one (`auth: "internal-only"`), reachable only from the
app's own containers.

**Engine facts:**
- **Valkey and Redis:** the default user is `on nopass ~* &* +@all`. `requirepass` sets that
  user's password. A read-only user is `ACL SETUSER <u> on ><pw> ~* +@read -@write`. TLS is
  `tls-port` with `tls-cert-file`, `tls-key-file` and `tls-ca-cert-file`, and `tls-auth-clients`
  makes it mutual TLS by default. https://valkey.io/topics/acl/, https://valkey.io/topics/tls/
- **Dragonfly:** `--requirepass` and `--aclfile`. Read-only keys use `%R~*`; its command
  categories aren't documented, so test `+@read -@write`.
  https://www.dragonflydb.io/docs/managing-dragonfly/acl
- **Kafka (apache/kafka):** SASL is configured through a JAAS file and listener settings. Setting
  any `KAFKA_*` variable drops all the image's defaults. Clients must configure SASL in code.
  Authentication without an authorizer lets any user read and write.
  https://hub.docker.com/r/apache/kafka,
  https://github.com/apache/kafka/blob/trunk/docker/examples/README.md
- **Redpanda:** a SCRAM superuser must exist before `enable_sasl`, or you are locked out. New users
  have no rights until ACLs grant them. https://docs.redpanda.com/current/manage/security/authentication/
- **OpenSearch:** since 2.12 the security plugin needs a strong `OPENSEARCH_INITIAL_ADMIN_PASSWORD`.
  Its demo certificates aren't for production, and its own certificates are needed for transport
  TLS. https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/,
  https://docs.opensearch.org/latest/security/configuration/tls/
- **Postgres:** a read-only role is `GRANT pg_read_all_data` (PostgreSQL 14+) plus `CONNECT`.
  **MySQL and MariaDB:** `GRANT SELECT, SHOW VIEW`. **MongoDB:** the `read` role. These come from
  the engines' documentation as commonly known; they weren't fetched, so the spike checks each
  against the pinned image.

**Decisions (lead):**
- **Encryption in transit is WireGuard's.** Every packet between the servers is encrypted and
  authenticated by the sending server's key, so OpsCrew adds no TLS on top. TLS would need a
  private CA, certificate renewal and changes in the app's connection settings (a CA file, a URL
  scheme, client certificates for Valkey's default mutual TLS). That conflicts with "the app's
  code is not rewritten for its infrastructure", for no gain on a link that is already encrypted
  end to end between the two servers.
- **Who may connect is decided per address:** a service on another server accepts connections
  only from the app servers' WireGuard addresses (and from the devices the user grants, R6).
  WireGuard proves each address with its key.
- **The 15 kinds with a login keep it.**
- **Kafka, Redpanda and OpenSearch stay without one.** Turning a login on would break every app
  whose client doesn't send it (Kafka and Redpanda clients set SASL in code), and OpenSearch's
  security plugin needs its own certificates. Across servers they are reachable only from the app
  servers' WireGuard addresses, and devices never get access to them. Design says so when one of
  them moves.

## R4. Where the code assumes one server (code maps, 2026-10-30)

- **Plan:**
  - `plan.target` is one `DeployTargetSchema` (`plan-schema/src/plan.ts:300`). Each environment is
    its own plan.
  - No component has a server field.
  - `deployment`, `dns`, `portainer` and `security.sshAllowedCidrs` are per plan.
- **Infrastructure code:**
  - The root module renders one `module "server"` (plus `server_previous` during a move, which
    needs two different providers). `servers` outputs are keyed by provider.
  - Server and firewall names are the app's name (`iac-templates/src/providers.ts:127`).
  - No `count` or `for_each` on servers.
  - The firewalls open 22/tcp from `ssh_allowed_cidrs` and 80/443 for the web.
- **Addresses:** `.opscrew/server.json` holds one `deployment` address (ADR 0010).
  `serverAddress(deps, plan)` (`agents/src/shared/server-address.ts:70`) returns it to status,
  logs, drift, destroy, secure, verify, the add-ons, the runners, provision and design.
- **Runtime:**
  - The app finds a service by its Compose name (`catalog/entries.ts:36` `loginUrl`, `:57`
    `passwordRedisUrl`, and per kind).
  - Services publish no ports.
  - The project's network named `internal` is an ordinary bridge with outbound access (only its
    name says internal). Workers, cron and the release command are on it, so they can reach
    another server's WireGuard address through the host.
- **Deploy workflow:** one `OPSCREW_HOST` secret with its known host key
  (`iac-templates/src/workflow/shared.ts:30`). It uploads the Compose project to `/srv/apps/<app>`
  and starts it.
- **Host plans:**
  - A plan of fixed steps, hashed and approved as `host-apply`; secrets go only on standard input
    (`connectors/ssh-host`).
  - ufw rules are written per port, with no source.
  - The dead-man switch guards SSH and firewall changes.
  - 017's add-ons are the model for an extra piece of software on a server; a host-level service
    with its systemd unit is the model for WireGuard (`ssh-firewall.ts`).
- **The scheduled check** already keys the disk check by server id; its `OPSCREW_CHECK_SERVER`
  secret holds one server per environment.
- **Retarget** moves Postgres (dump on the old server, `scp -3` through this computer, restore)
  and starts Valkey empty, in a maintenance window (`agents/src/retarget/window.ts`). It refuses
  other stateful kinds.
- **Portainer:** one `environmentId` per plan.

## R5. The shape of the private network (lead decisions)

- **One network per app and environment:** its own interface, UDP port and private /24.
  - It matches the plan, keeps prod and staging apart, and needs no coordination between plans.
  - Several apps on one own server get one interface each.
  - A device that joins several apps' networks has one tunnel per app.
- **Full mesh between the app's servers.** Each server peers with every other, and a device peers
  with every server that has a public address.
  - A server without a public address keeps its links up with a 25-second keepalive toward the
    servers that have one.
  - Two servers without a public address can't be linked; design refuses that.
  - A hub that forwards between peers would need forwarding rules against Docker's default
    `FORWARD` drop, and would add a single point of failure.
- **Keys are made by OpsCrew locally** (Node's x25519):
  - Each server's private key is kept with the app's other generated secrets, as database
    passwords are, and reaches its server only on standard input during an approved host apply,
    into a root-only file.
  - Plans and files carry only public keys.
  - A device's private key goes only into that device's configuration; OpsCrew keeps its public key.
  - Generating keys on each server instead would make every server's plan depend on keys that
    exist only after another server's apply.
- **UDP is open to everyone** on WireGuard's port, in the cloud firewall and ufw: WireGuard
  answers nothing without a valid key, and roaming devices have no fixed address. Restricting it
  to the servers' addresses would break devices and tie each server's firewall to the others'.
- **Each server's services listen only on its WireGuard address.** The `DOCKER-USER` chain admits
  only the allowed WireGuard addresses (fail-closed, as the web filter is), and WireGuard starts
  before Docker.

## R6. Devices, public SSH and database access (from the observability "part 2", founder 2026-10-18)

- **Devices** join with a configuration file and, for phones, a QR code. They reach each server's
  SSH, and Beszel's and Portainer's dashboards, on the network's addresses.
- **Public SSH can close** once:
  - every deploy reaches the servers from inside the network (the server's own runner, from 015);
  - and the user's computer is a device on it.
  - The change is a host plan under the dead-man switch, plus the cloud firewall rule. The
    scheduled check's disk job then runs on the server's own runner.
- **The production database and cache from a device** (founder, 2026-10-18):
  - off by default, per service and per device;
  - read-only (a separate login, recommended) or full access (its own login, with a plain warning);
  - the app's own credentials never reach the device;
  - `status` and `secure` show who has access;
  - OpsCrew prints the connection details for psql, DBeaver or redis-cli;
  - turning it off removes the access rule and the extra login.
  - Only the databases and caches: Postgres, MySQL, MariaDB, MongoDB, Valkey, Redis and Dragonfly.

## R6a. Spike: device logins on the pinned images (2026-10-30, local Docker)

Run with OpsCrew's pinned images and its own start settings: Postgres 17 (alpine), MySQL 8.4,
MariaDB 12.3, MongoDB 8.0, Valkey 8.1, Redis 8.10.2 and Dragonfly 2.0.2. The app's login is
`app`, on the database `app`, everywhere.

**Postgres:**
- Read-only: `CREATE ROLE <u> LOGIN PASSWORD …; GRANT pg_read_all_data TO <u>;`. No `CONNECT`
  grant is needed. It reads existing tables and tables made later. Writes fail with
  `permission denied for table …`, and `CREATE TABLE` with `permission denied for schema public`.
- Full: `CREATE ROLE <u> LOGIN PASSWORD …; GRANT app TO <u>; ALTER ROLE <u> SET role = app;`.
  Plain `GRANT ALL` fails on `ALTER` (`must be owner`); role membership gives the app's rights,
  and what it creates is owned by `app`.
- Removal: `REASSIGN OWNED BY <u> TO app; DROP OWNED BY <u>; DROP ROLE <u>;`.
- `app` is the superuser, so it creates the logins. Logins live in the data and survive a
  restart.
- The image trusts `127.0.0.1` inside the container, so tests must connect over a network to
  check the password.

**MySQL and MariaDB** (the same statements):
- Read-only: `CREATE USER '<u>'@'%' IDENTIFIED BY …; GRANT SELECT, SHOW VIEW ON app.* TO '<u>'@'%';`.
  Writes fail with `ERROR 1142 … command denied`.
- Full: `GRANT ALL PRIVILEGES ON app.* TO '<u>'@'%'`, the same grants as `app`.
- Removal: `DROP USER '<u>'@'%'`.
- **`app` can't create users** (`ERROR 1227`): the statements run as root, with the generated
  root password on standard input.

**MongoDB:**
- Read-only: `db.getSiblingDB("admin").createUser({user, pwd, roles: [{role: "read", db: "app"}]})`,
  run as `app` (the root user). The login's URL needs `authSource=admin`. Writes fail with
  `not authorized on app to execute command { insert … }`, and other databases are refused.
- Full: roles `readWrite` and `dbAdmin` on `app`.
- Removal: `dropUser`.
- Logins survive a restart.

**Valkey and Redis 8** (the same):
- Read-only: `ACL SETUSER <u> on >… ~* &* +@read +ping +hello +client|setname +client|setinfo -@write`.
  The four extra grants are needed because many clients send PING, HELLO and CLIENT SETNAME on
  connect. Writes fail with `NOPERM`. CONFIG, FLUSHALL, INFO, EVAL, MONITOR and SHUTDOWN are
  refused; KEYS and SCAN are allowed (they are in `@read`).
- Full: `+@all` on `~* &*`.
- **Persistence:** OpsCrew starts them with a generated `requirepass` and no ACL file, so a user
  made with `ACL SETUSER` is lost at the next start. A naive `aclfile` is dangerous: a file
  without the default user's line starts the server with `nopass`.

**Dragonfly:**
- Read-only: `ACL SETUSER <u> ON >… resetkeys %R~* +@read +ping +hello -@write`. The key pattern
  must be `%R~*`. Writes and admin commands fail with `NOPERM … has no ACL permissions`.
- Full: `%RW~* +@all`.
- Persistence is the same problem as Valkey's. Once an ACL file is saved, its default user's hash
  wins over `DFLY_requirepass`, so a rotated password wouldn't take effect.

**Decisions:**
- **Postgres, MySQL, MariaDB and MongoDB:** a device's login is made and removed by fixed
  statements in a host step, run through `docker compose exec` on the service's server, with the
  passwords on standard input. MySQL and MariaDB run them as root.
- **Valkey, Redis and Dragonfly:** a device's login is declared, not made. The service's
  environment (its GitHub secret) carries each extra login as `<name>` plus the SHA-256 of its
  password. OpsCrew's start wrapper writes a fresh ACL file in `/tmp` on every start:
  - the default user's line from the app's password;
  - the extra users' lines, with the read-only or full rules above.

  The server then starts on it. Nothing is saved, so a restart can't lose a login or revive an
  old password, and turning a grant off is a deploy that drops its line. A service without
  grants keeps today's start command.

## R7. Latency between servers

No provider publishes latency figures between its locations, or to other providers. Design
estimates a cross-server hop from the two locations' great-circle distance: light in fibre covers
about 100 km per millisecond of round trip once routing is counted, plus about 1 ms. It labels the
result as an estimate. Design shows what that hop adds to a page that makes many database queries
in a row, and warns when it does. `status` measures the real round trip over the link (from the
app's server to each other server). The location of the user's own server isn't known, so design
says it will be measured.
