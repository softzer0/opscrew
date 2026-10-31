# Implementation Plan: Split placement and the private network

**Branch**: `main` | **Date**: 2026-10-30 | **Spec**: `specs/018-split-placement/spec.md`
**Research**: `specs/018-split-placement/research.md` (R1–R7, spikes R5a, R5b and R6a)

The founder gave the go-ahead for research, spec, plan, tasks and implementation on 2026-10-30.

## Summary

One app across several servers, linked by a private WireGuard network that the user's devices
can join too.

**Placement** (US1)
- `plan.yaml` gains `servers` (extra servers, cloud or own) and `server` on each service. Design
  sizes and prices each server, estimates each hop's delay, and refuses what can't be linked.
- An extra cloud server is one more provider module in the same root module. An extra own server
  gets the own-server setup it would get as an app server.
- A service on an extra server runs in that server's Compose project, published only on the
  server's WireGuard address. The app gets that address instead of the Compose name.
- A live service moves in a maintenance window: Postgres is dumped and restored, and Valkey, Redis
  and Dragonfly start empty. The old copy stays, stopped, until `provision --finish-move` removes
  it after a typed confirmation.

**The private network** (US1, US2)
- One WireGuard network per app and environment, a full mesh between its servers. Keys are made by
  OpsCrew locally, and each server's private key reaches only that server, on standard input.
- Each server's network is a host plan step (`network`), approved by its hash, on cloud and own
  servers alike. On cloud servers the host adapter becomes root through a one-shot privileged
  container (`docker` privilege), since `deploy` has no sudo there.
- A second step (`network-filter`) restricts each published port to the app's servers and the
  granted devices, in Docker's `DOCKER-USER` chain, before Docker starts (fail-closed).
- Every command covers every server: the deploy, `status` (with the links' measured delay),
  `logs`, `drift`, `secure`, `verify`, `destroy` and the scheduled check.

**Devices** (US3), **public SSH** (US4) and **database access** (US5)
- `opscrew vpn add|remove|list` writes a device's configuration (and a QR code on request), and
  adds it to the servers through host plans.
- `opscrew secure --close-public-ssh` closes port 22 on every server once deploys run on a runner
  inside the network and this computer is a device. Then every command connects over the network.
- `opscrew vpn grant|revoke` gives a device its own login to a database or cache, read-only by
  default. For the four databases, a host step makes the login with fixed statements. Valkey, Redis
  and Dragonfly declare it in the service's environment, and OpsCrew's start wrapper writes a fresh
  ACL file on every start.

**In Claude Code** (US6): read-only MCP data for servers, links, devices and grants; the skills
send the user to the CLI to add a device.

## Technical Context

- **Stack:** the same as 000–017.
  - **One new npm dependency:** `uqr` (MIT, no dependencies, 2026-04) in the CLI, to draw a
    device's configuration as a QR code in the terminal. Its only alternatives are unmaintained
    (`qrcode-terminal`, 2022) or larger (`qrcode`, three dependencies).
  - WireGuard keys come from Node's `crypto` (`x25519`, R5a).
- **On the servers:** `wireguard-tools` from the distribution's packages (Ubuntu 22.04/24.04,
  Debian 12/13; the module is in their kernels). No new image: the root path on cloud servers uses
  the Caddy image already pinned, whose busybox has `nsenter`.
- **Provider APIs:** none new. Extra cloud servers are more of the same Terraform/OpenTofu modules;
  prices come from the catalogues design already reads.
- **To verify in the real-server pass** (T1802, R5b): MTU on a real VM, the boot order across a
  reboot, the failure case, peer changes with the full temporary config, the iptables backend of
  Ubuntu 24.04 with Docker CE, root through Docker as `deploy`, and real sshd on the network.
- **Tests:**
  - unit tests with fakes (host steps rendered and parsed; HCL snapshots; Compose snapshots per
    server; workflow snapshots; design's estimates and refusals);
  - the HCL validated under both engines;
  - the Docker pass (T1819, `OPSCREW_DOCKER_TESTS=1`): two privileged Ubuntu containers as
    servers, as in R5a, running the real host steps, the filter and the device logins;
  - gated live tests (T1820) on two Hetzner servers.

## Constitution Check

- **I (safety gate):**
  - **Cloud resources** (extra servers, their firewalls, the UDP rule, closing SSH in the cloud
    firewall): the IaC plan, `iac-apply`.
  - **Each server's changes** (WireGuard, the filter, public SSH, device logins, the own-server
    setup of an extra own server): host plans, `host-apply`, one per server. The private key is the
    only secret, on standard input, never in the plan.
  - **Repository files and secrets:** the deploy-setup pull request (`pull-request`) and
    `github-secrets`, as today.
  - **Destroying:** an extra server is deleted only through destroy's `allowDestroy` approval and
    its typed name. The old copy of a moved service is deleted only by `provision --finish-move`,
    with `allowDestroy` and the typed service name.
  - **Closing public SSH:** refused unless its two conditions hold; applied under the dead-man
    switch that undoes an SSH change when the connection is lost.
  - **No new approval kind.**
- **II (user owns everything):**
  - The Compose files per server, the WireGuard configuration, the filter script, the units and
    the device configurations are plain files.
  - A user who deletes OpsCrew keeps a working network: wg-quick, systemd and iptables, with no
    OpsCrew process.
- **III (dual engine):** the module changes (`web`, `wireguard_port`, `ssh_key_id`) and the extra
  server modules are validated under both engines.
- **IV (secrets):**
  - **WireGuard private keys:** made on this computer and kept with the generated values (0600, in
    the recovery copy). A server's key reaches only that server, on standard input, into a
    root-only file the config doesn't contain. A device's key is written only into its
    configuration file, or shown as a QR code when asked.
  - **Device logins' passwords:** kept with the generated values, printed once by `vpn grant`.
    Valkey, Redis and Dragonfly receive only the SHA-256 of the password.
  - **Servers' public addresses:** stay in this computer's state and GitHub secrets. The private
    network's addresses and public keys are committed: they reveal nothing usable without a key.
- **V (deterministic first):** allocation, keys, sizing, prices, the delay estimate, the
  renderers, the filter rules and the logins are deterministic code. No model.
- **VI (contracts first):** one serial task (T1801a): plan-schema's `servers`,
  `services[].server`, `network`, `deployment.placement` and `move`. No change in
  `@opscrew/contracts`. ADR 0022 records the design.
- **VIII (typed adapters):** server changes go through the host adapter (its new steps and its
  `docker` privilege), cloud resources through the IaC engine, and GitHub through its connector.
- **IX (plain language):** prices per server, the delay per hop and what it does to a page, the
  maintenance window, what has no login, and what a refusal needs.
- **X (simplicity):**
  - plain WireGuard, not Swarm, Tailscale or Headscale;
  - no TLS on an already encrypted link;
  - services only, not workers;
  - extra servers with a public address only;
  - one new dependency.

## Project Structure

```text
packages/plan-schema/src/        servers, services[].server, network, deployment.placement, move (T1801a)
packages/connectors/ssh-host/src/
  privilege.ts                   the `docker` privilege: root steps through a privileged nsenter container (T1803)
  network.ts                     the `network` step: wireguard-tools, key, config, unit, drop-in, ufw, syncconf (T1803)
  wireguard.ts                   readWireGuard: `wg show <if> dump` parsed, through the privilege (T1803)
  network-filter.ts              the `network-filter` step: OPSCREW-<if> chain, unit before Docker (T1806)
  public-ssh.ts, grant.ts        the `public-ssh` and `grant` steps (T1806)
packages/iac-templates/
  modules/{hetzner-vps,digitalocean-droplet}/   web, wireguard_port, ssh_key_id, ssh_key_id output (T1804)
  shared/cloud-init.yaml.tftpl   no web rules on an extra server (T1804)
  src/infra/                     server_<name> modules, extra_servers output (T1804)
  src/runtime/, src/catalog/     Compose per server, addresses, advertised listeners, the ACL wrapper (T1805)
  src/addons/, src/portainer-host/   dashboards on the private address for devices (T1805)
  src/workflow/                  extra servers before the switch; published-port repair (T1807)
  src/check/                     the server list (T1807)
packages/agents/src/
  network/                       allocation, keys, peers, endpoints, host-step params, readNetwork (T1808)
  shared/{server-record,server-address,app-secrets}.ts   servers, ownServers, thisDevice; per-server remotes (T1808)
  design/                        servers, placement, sizing, prices, delay, refusals, moves (T1809)
  provision/                     extra servers, host plans per server, secrets, placement (T1810)
  move/                          the window for a live service; --finish-move (T1811)
  status/, logs/, verify/, secure/   every server; links; ports; grants (T1812)
  drift/, destroy/, retarget/, check/   every server; refusal; server list (T1813)
  vpn/                           devices (T1814), grants (T1816)
  secure/public-ssh.ts           close and open public SSH (T1815)
packages/cli/src/commands/       vpn.ts; secure, provision and status flags; QR output (T1817)
packages/mcp-server/src/tools/   network data in status; placement estimate (T1817)
plugin/skills/                   placement and devices (T1817)
docs/guide/                      split-placement.md, private-network.md, public-ssh.md, database-access.md (T1818)
docs/adr/0022-split-placement-and-private-network.md   (lead)
```

## Design

### 1. Plan (T1801a, serial, lead-reviewed)
data-model.md "The plan" and contracts/split-placement.md "plan-schema":
- `ExtraServerSchema`, `servers` on the plan, `server` on `ServiceEntrySchema`;
- `NetworkSchema` (`range`, `members`, `devices`, `grants`, `publicSsh`);
- `deployment.placement`, and `MoveSchema` as `move`;
- the cross-field rules with plain messages;
- helpers:
  - `APP_SERVER` (`"app"`);
  - `serverOfService(plan, service)`;
  - `servicesOn(plan, server)`;
  - `networkInterface(member)` (`wg-opscrew<k>`);
  - `GRANTABLE_KINDS`;
- the JSON schema regenerated.

A plan without `servers` and `network` must parse and render byte-identical to today.

### 2. The real-server pass (T1802, lead)
R5b's questions on two Hetzner servers in two locations; the results go into research.md before
wave 2. A result that changes the design goes into this plan first.

### 3. The host adapter (T1803, then T1806)
- **`docker` privilege** (T1803):
  - The probe prints `docker` when the login has neither root nor passwordless sudo, but `docker
    info` works.
  - Root steps then run as
    `docker run --rm -i --privileged --pid=host --net=host --ipc=host --uts=host <IMAGES.caddy.ref> nsenter -t 1 -m -u -i -n -p -- sh -s`,
    with the script and its secrets on standard input (R5a).
  - Inspection's read-only probes run as the login, as today.
  - On cloud servers the host plan's login is `deploy`.
- **`network` step** (T1803), params from `agents/network`:
  - `interface`, `address` (`/24`), `port`, `publicKey` (the server's own), `peers` (`name`,
    `publicKey`, `endpoint?`, `allowedIp`, `keepalive?`) and `otherInterfaces` (the host's other
    OpsCrew interfaces, for the drop-in).
  - **Check:**
    - the config file's hash;
    - the key file's public key (`wg pubkey < key`) against `publicKey`;
    - the unit enabled;
    - the drop-in;
    - the UDP rule.
  - **Apply:**
    - install `wireguard-tools` when missing;
    - write the key file from standard input (umask 077) only when the agents pass a key (it is
      missing or differs);
    - write the keyless config;
    - write the drop-in (`Wants=` and `After=` for every OpsCrew interface) and run
      `systemctl daemon-reload`;
    - enable the unit, and start it when it isn't up;
    - otherwise run `wg syncconf` on a full temporary config in `/run` (0600, removed afterwards)
      with the key read from the file (R5a);
    - `ufw allow <port>/udp` and `ufw allow in on <if> to any port 22 proto tcp`, with OpsCrew's
      comments;
    - the host record's `networks[<if>] = <app>`.
  - **Verify:** `wg show <if>` lists the peers, and the address is on the interface.
  - **Removal:** the reverse, the drop-in rewritten for the remaining interfaces.
  - **A firewall other than ufw** gives the existing finding with what to open by hand.
- **Facts** (T1803): the host's WireGuard interfaces, the UDP ports in use and its IPv4 routes. A
  route overlapping `network.range` is a finding naming the clash and the plan field to change.
  A taken port is picked around at design.
- **`readWireGuard(remote, iface)`** (T1803): `wg show <if> dump` through the privilege, parsed to
  each peer's public key, endpoint and latest handshake. It reads only.
- **`network-filter` step** (T1806):
  - Params: `interface`, `address` and `rules` (`port`, `sources[]`).
  - A script per interface rebuilds chain `OPSCREW-<if>`, jumped to from `DOCKER-USER`, with an
    `ACCEPT` per source and a `DROP` per port, matched on `--ctorigdst`/`--ctorigdstport`
    (R5a).
  - A templated unit `opscrew-network-filter@<if>.service` runs before Docker, and Docker's
    drop-in `Requires=` it (fail-closed, as 009's web filter).
  - The nftables-backend refusal is reused from the web filter.
  - Removal deletes the chain, the jump, the unit and the drop-in line.
- **`public-ssh` step** (T1806): params `open` and `interface`.
  - Closing removes ufw's public `22/tcp` rules and keeps the rule on the interface.
  - Opening restores the public rule from `security.sshAllowedCidrs`.
  - It runs under the existing dead-man switch for SSH and firewall changes.
- **`grant` step** (T1806): params `service`, `kind` (postgres, mysql, mariadb, mongodb), `login`,
  `access` and `remove`, with the password (and the root password for MySQL and MariaDB) on
  standard input.
  - It runs the statements of research R6a through `docker compose -p <app> exec -T <service>`,
    as `deploy`.
  - Its check asks the engine whether the login exists with that access.

### 4. Infrastructure code (T1804)
- **Modules:**
  - `web` (default `true`): `false` drops the 80/443 rules and cloud-init's web ufw rules;
  - `wireguard_port` (default `null`): adds the UDP rule from anywhere (R5);
  - `ssh_key_id` (default `null`): reuses the app server's key on the same provider, since both
    providers refuse a duplicate key;
  - an `ssh_key_id` output.
- **Root module:**
  - one `module "server_<name>"` per extra cloud server, named `<app>-<name>`, with its provider
    listed;
  - `extra_servers` output: name to `{ ipv4, ipv6, id, name }`;
  - the app server's module gets `wireguard_port` when the plan has a network;
  - `security.sshAllowedCidrs` applies to every server's firewall.
- Retarget's `server_previous` layout is unchanged, because retarget refuses plans with extra
  servers.

### 5. Runtime (T1805)
- **`renderCompose(plan)`** (the app's server) leaves out services placed elsewhere and keeps
  `depends_on` local. A service with a device grant is published on the app server's private
  address.
- **`renderServerCompose(plan, name)`** (an extra server): project `<app>`, only its services,
  each published as `<private address>:<port>:<port>`, on the project's network, with the sysctl
  init when needed; no edge.
- **The catalog's context** gains:
  - `host`: the Compose name, or the private address of the service's server when the app is
    elsewhere;
  - `advertisedHost` (Kafka and Redpanda advertise their server's private address when placed
    elsewhere).

  Every `address`, `loginUrl` and `passwordRedisUrl` uses `host`.
- **Device logins on Valkey, Redis and Dragonfly** (R6a):
  - With grants, the service's environment carries `OPSCREW_ACL_USERS` (`name:access:sha256`, one
    per line).
  - The start wrapper writes `/tmp/opscrew-users.acl` with the default user from the app's password
    plus those users, and starts the server with `aclfile` (Dragonfly with `--aclfile`).
  - Without grants, the start command is unchanged.
- **Dashboards:** with devices on the network, Beszel's hub and Portainer's web UI are also
  published on the app server's private address. The filter admits devices only.
- **`publishedOnNetwork(plan, server)`:** each service and port published on a private address,
  for the workflow's repair and for `status`.

### 6. Workflow and check (T1807)
- **The deploy, for each extra server in plan order, before the app's switch:**
  - upload its Compose file and its services' env files;
  - `docker compose pull`, then `up -d --wait --remove-orphans`;
  - `docker compose port` for each published port, and `up -d --force-recreate <service>` for one
    that isn't published (R5a);
  - a failure ends the job before the app changes.

  The same port repair runs for the app server's services published on its private address.
- **Where the job connects:** the extra server's public address from
  `OPSCREW_SERVER_<NAME>_HOST`, with its known host key. With `network.publicSsh: false`, the job
  runs on the app server's runner and connects to the private address instead.
- **The check:** the `OPSCREW_CHECK_SERVER` secret becomes a list with every server's id, address
  and known host. The disk job checks each one. With public SSH closed, only the runner job checks,
  over the private addresses.

### 7. Agents: the network core (T1808)
- **Allocation:**
  - `range` from a hash of the app's key and environment inside `10.200.0.0/13`;
  - member addresses in plan order;
  - ports from the facts of own servers;
  - device addresses from `.100` up.
- **Keys:** `x25519` through an injected key maker (tests are deterministic). Private keys go
  into the generated values (`network`), and public keys into the plan.
  - A member whose private key isn't on this computer keeps its public key while the server's key
    matches.
  - When it doesn't match, design makes a new pair, and every peer's plan changes.
- **Peers:** derived per member, with endpoints from this computer's server record. A member
  without a public address gets `PersistentKeepalive = 25` toward the others.
- **Server record:** `servers`, `ownServers` and `thisDevice`.
  - `serverAddress(deps, plan, name = "app")` and `serverRemote(deps, plan, name)` connect to the
    public address, or to the private one when `publicSsh` is `false`.
  - When that fails and `thisDevice` is set, the error says this computer's tunnel looks down.
- **`networkSteps(plan, name, facts)`:** the `network` and `network-filter` params for one server.
- **`readNetwork(deps, plan)`:** every server's `readWireGuard`, plus a ping of each other
  member's private address from the app's server (`ping -c 3 -q`, round trip).

### 8. Agents: design (T1809)
- **Servers:** validated (FR-1819) and kept from the user's edits. Each new cloud server is
  defaulted to the app's provider and location, and sized as the smallest type whose memory holds
  its services' limits plus the system's share.
- **Prices:** per server and the total. The cost block's server line becomes one line per server.
- **The delay estimate:** a table of the providers' locations (Hetzner fsn1, nbg1, hel1, ash, hil,
  sin; DigitalOcean's regions) with coordinates. A hop's round trip ≈ 1 ms + distance / 50 km (calibrated on fsn1 to hel1, R5b, and within fsn1 by T1821's live run; first written as 2 ms).
  - It's shown with what it adds to a page making 20 queries in a row.
  - It warns above 5 ms.
  - An own server's delay shows as "measured by `opscrew status`".
- **The network:** created or kept when `servers` isn't empty. Members follow the servers, and
  devices and grants are kept.
- **Moves:**
  - `deployment.placement` against `services[].server` gives a move, set in `move` with `copy`
    (`dump` for Postgres, `empty` for the three Redis-protocol kinds).
  - Any other kind with data on a live app is refused, until 023.
  - One move at a time.
  - The window is estimated from the database's size, read over SSH as retarget reads it.
- **Kafka, Redpanda and OpenSearch elsewhere:** the line says they have no login and only the
  app's servers reach them.

### 9. Agents: provision (T1810)
- **The IaC plan** creates the extra cloud servers. Their addresses go into the server record, and
  provision waits for each to be ready and pins its host key.
- **An extra own server** gets the own-server setup host plan (Docker, `deploy`, the deploy key,
  ufw), as an app server does.
- **Host plans per server:** `network` and `network-filter`, each shown and approved by its hash.
  The private key is passed on apply only when the facts say it is needed.
- **Secrets and files:**
  - `OPSCREW_SERVER_<NAME>_HOST` and `_KNOWN_HOSTS` per extra server;
  - the services' env secrets, with `OPSCREW_ACL_USERS` when grants exist;
  - the deploy-setup pull request with every server's Compose file and the workflow.
- **After the deploy `verify` sees succeed:** `deployment.placement` is written. With a `move`, it
  hands over to T1811.

### 10. Agents: the move (T1811)
Steps `started` → `deployed` → `switched`, resumable, reusing retarget's `server-ops` (dump,
`scp -3`, verify, restore, stop and start, health wait).
- **`deployed`:** during a move, the rendered files run the service on both servers: the new copy
  on `to`, empty, and the old one on `from`, still used by the app.
- **The window:**
  - pause the scheduled check;
  - stop the app, workers and cron;
  - `dump`: dump on `from`, copy, verify, restore on `to`;
  - `empty`: nothing to copy;
  - write the app's env with the new address on the app's server, and update `OPSCREW_APP_ENV`;
  - start the app, workers and cron, and wait for health;
  - any failure restores the old env and starts the app on the old copy.
- **`switched`:** the next render drops the old copy's container; its data folder stays.
- **`provision --finish-move`:** an `allowDestroy` approval and the typed service name, then the
  old copy's data folder removed. `move` is cleared and `deployment.placement` updated.

### 11. Agents: every command on every server (T1812, T1813)
- **T1812:**
  - `status`: each server's figures (017) and containers; the network's links (state, last
    handshake, measured round trip); ports that should be published but aren't; grants; public
    SSH;
  - `logs --service`: from the service's server;
  - `verify`: every server reachable, links up, ports published;
  - `secure`: every server; each service on another server answering only on the private address
    with the filter in place; grants and public SSH listed.
- **T1813:**
  - `drift`: host steps and Compose per server;
  - `destroy`: every extra cloud server in the IaC destroy, with its typed name; on extra own
    servers, the undo host plans (services, `network`, `network-filter`), leaving only what was
    there before;
  - `retarget`: refuses plans with `servers`;
  - the check's server list.

### 12. Agents: devices, public SSH and grants (T1814, T1815, T1816)
- **`vpn add <name> [--this-computer] [--qr] [--again]`** (T1814):
  - make the device's key;
  - add the device to `network.devices` (creating the network for a single-server app);
  - host plans for every server with a public address;
  - write `<user folder>/vpn/<app>-<env>-<name>.conf` (0600), and return the QR text when asked.
  - **`vpn remove`** and **`vpn list`** (handshakes from `readNetwork`).
  - `addon open` and `portainer` point to the private address when `thisDevice` is set.
- **`secure --close-public-ssh` / `--open-public-ssh`** (T1815):
  - **Conditions:**
    - the environment's runner is `server`, or `local` with this computer a device;
    - `thisDevice` is set, and its handshake on every server is less than 3 minutes old.
  - **Then:**
    - set `publicSsh: false` and `security.sshAllowedCidrs: []`;
    - run the IaC plan for the cloud firewalls;
    - run the `public-ssh` host plans;
    - pin the host keys under the private addresses.
  - Opening reverses it.
- **`vpn grant <device> <service> [--full]` / `vpn revoke`** (T1816):
  - add or remove the grant;
  - the password, generated and kept;
  - for the four databases, the `grant` host step on the service's server;
  - for the Redis-protocol kinds, the env secret and a deploy;
  - the filter's sources updated;
  - the service published on its server's private address when it wasn't.
  - The connection details are printed once (a `psql`, `mysql`, `mongosh` or `redis-cli` line, and
    a URL for DBeaver), never the app's own login. Full access asks for a confirmation after its
    warning.

### 13. Surfaces (T1817), the guide (T1818)
- **CLI:**
  - `opscrew vpn` (add, remove, list, grant, revoke);
  - `secure --close-public-ssh/--open-public-ssh`;
  - `provision --finish-move`;
  - `status`'s network section;
  - the QR code through `uqr`.
- **MCP:** `status` data gains servers, links, devices (names and addresses) and grants, plus a
  read-only `placement_estimate`. No tool makes a key.
- **The plugin's skills:** placement and devices.
- **The guide:** four pages (FR-1822), the index, and the runbook's per-server section.

### 14. The Docker pass (T1819) and the live tests (T1820, T1821)
- **Docker pass:** two privileged Ubuntu containers as servers, each with its own Docker (tmpfs
  `/var/lib/docker`, R5a):
  - the real `network` and `network-filter` steps;
  - the `docker` privilege;
  - a service published on the private address reached from the other's container;
  - a device namespace refused, then allowed after a grant;
  - the four databases' `grant` statements and the ACL wrapper on the pinned images.
- **Live (gated on `OPSCREW_E2E_SPLIT=1` and the Hetzner token):**
  - an example with Postgres moved to a second Hetzner server and back (rows checked);
  - `status`'s links;
  - a reboot of each server;
  - the deploy across both;
  - a device (a Linux namespace on the runner of the test) reaching SSH;
  - closing and reopening public SSH;
  - a read-only grant;
  - destroy.
  - With `OPSCREW_E2E_DIGITALOCEAN_TOKEN`, the second server at DigitalOcean.

## Order

T1801a → {T1801b, T1802} → wave 1 {T1803, T1804, T1805, T1807, T1808} → wave 2 {T1806, T1809,
T1812} → wave 3 {T1810, T1813} → wave 4 {T1811, T1814} → wave 5 {T1815, T1816} → wave 6
{T1817, T1818, T1819} → T1820 → T1821 (live runs) → T1822 (simplify) → release.

## Complexity Tracking

| Item | Why it's needed | Simpler alternative rejected because |
|---|---|---|
| Root on cloud servers through a privileged container | WireGuard, its unit, ufw and the filter need root. Cloud servers' `deploy` has no sudo, and cloud-init runs only at creation. | A sudo rule from cloud-init wouldn't reach servers that already exist. A WireGuard container would still need root for ufw, and its own unpinned packages. |
| A data move between the app's servers | The founder's main case is a live app's busy database getting its own server. | Placement only on new apps would leave every live app out. |
