# Data model: split placement and the private network

## The plan (`opscrew/plan.yaml`, per app and environment)

**Extra servers (`servers`)**, optional (absent: none, so existing plans keep their bytes; read it as `plan.servers ?? []`). With extra servers, `network` is required. The app's server stays `target`; it is called `app`
wherever the network or a placement names it.

| Field | Type | Rule |
|---|---|---|
| `name` | `[a-z][a-z0-9-]{0,14}` | Unique in the plan; never `app`. Names the server's module (`server_<name>`), its cloud resources (`<app>-<name>`), its GitHub secrets and the lines of every command. |
| `target` | union on `provider` | `hetzner` or `digitalocean`: `location`, `serverType`, `image?` and `backups`, as `CloudTargetSchema` without `edge` (an extra server serves no web traffic). `own`: `arch` only; it must have a public address (its address and login stay on this computer, as the app server's do). |

Rules (plan-schema's `superRefine`, each refusal with what would work):
- `servers` only when `target` is a cloud or own server (`onOneServer`): never Portainer,
  localhost, Cloudflare's hosting or GitHub Pages (FR-1819).
- An `own` extra server with `access: tunnel` doesn't exist: an extra own server is reached at its
  public address.
- Every extra server runs at least one service, or holds the old copy of a move (`move.from`).
  Removing a server from `servers` deletes it at the next provision, after the same `allowDestroy`
  approval and typed name as destroy (US1 #5).
- `retarget` and `servers` never together (FR-1820).

**Placement (`services[].server`)**, optional: the name of an extra server, or absent for the app's
server. Only services move: workers, cron jobs, the release command, SQLite and the edge stay on
the app's server.

**The private network (`network`)**, absent until design adds an extra server or `vpn add` adds a
device.

| Field | Type | Rule |
|---|---|---|
| `range` | IPv4 `/24` inside `10.200.0.0/13` | Design picks it from a hash of the app's key and environment, so two apps in one repository differ. The user may change it before the first apply; afterwards a change re-addresses every member through new host plans. |
| `members` | list, one per server | `name` (`app` or an extra server's), `address` (in `range`: the app's server `.1`, extra servers from `.2` in plan order), `port` (UDP, 51820 or higher: 51820 by default, on the user's own server the next free one from inspection), `publicKey` (base64, 32 bytes). |
| `devices` | list | `name` (`[a-z][a-z0-9-]{0,31}`, unique), `address` (from `.100` up), `publicKey`, `addedAt`. Never a private key. |
| `grants` | list | `device`, `service` (a service's name, of kind postgres, mysql, mariadb, mongodb, valkey, redis or dragonfly), `access` (`read-only` or `full`). |
| `publicSsh` | boolean, default `true` | `false` after `secure --close-public-ssh`. Then `security.sshAllowedCidrs` is `[]` for every server, and SSH answers only on the network. |

Derived, not stored:
- **interface** `wg-opscrew<k>`, where `k = port − 51820`. One interface per app and environment
  on a server.
- **peers** of a server: every other member, with `Endpoint` its public address and port when it
  has one (taken from this computer's server record at plan time), `AllowedIPs` its `/32`, and
  `PersistentKeepalive = 25` toward every other server, so idle links keep a fresh handshake and
  "up" means a handshake under 180 s for every link. Device peers on a server have none (the
  device's own configuration keeps the link alive).
- **the filter's sources** per published port: the app server's address, plus the addresses of
  the devices granted that service.

**Where each service runs (`deployment.placement`)**, written by provision after a successful
deploy: service name → server name (`app` or an extra server). Design compares it with
`services[].server` to find a move.

**A move in progress (`move`)**, absent when none. One at a time, resumable like `retarget`:

| Field | Type | Rule |
|---|---|---|
| `service` | service name | |
| `from`, `to` | server names | Different. |
| `step` | `started`, `deployed`, `switched` | `deployed`: the new copy runs, empty, on `to`. `switched`: the data is copied and the app uses `to`. The old copy stays, stopped, until `provision --finish-move`. |
| `sizeBytes` | integer | Measured at the start of the window; the timeouts and the window shown scale with it. |
| `copy` | `dump`, `empty` | `dump` for Postgres; `empty` for Valkey, Redis and Dragonfly. Any other kind with data on a live app is refused at design. |

## This computer's state

**`.opscrew/server.json`** (gitignored, per app and environment) gains:
- `servers`: extra server name → `{ ipv4, ipv6? }`, read from the root module's `extra_servers`
  output after apply (cloud) or entered at design (own).
- `ownServers`: extra server name → the same login record as `own` (user, port, key path, host key).
- `thisDevice`: the device name this computer is on the network as, set by `vpn add --this-computer`.

**`generated_values.json`** (0600, beside the deploy key) gains:
- `network`: member name → its WireGuard private key (base64).
- `grants`: `<device>/<service>` → that login's password.

Both are in the encrypted recovery copy (014) with the other generated values.

**Device configurations:** `<OpsCrew's user folder>/vpn/<app>-<environment>-<device>.conf`,
mode 0600, written once by `vpn add` (again with `--again`). OpsCrew never reads them back.

## On the servers

| Path | Owner | What |
|---|---|---|
| `/etc/wireguard/wg-opscrew<k>.conf` | root, 0600 | `Address`, `ListenPort`, `PostUp = wg set %i private-key …`, `[Peer]` blocks. No private key in it. |
| `/etc/wireguard/wg-opscrew<k>.key` | root, 0600 | The server's private key, written from standard input. |
| `/etc/systemd/system/docker.service.d/opscrew-network.conf` | root | `Wants=`/`After=wg-quick@wg-opscrew<k>.service` for each interface (the `network` step's). |
| `/usr/local/sbin/opscrew-network-filter-<if>`, `opscrew-network-filter@.service`, `docker.service.d/opscrew-network-filter-<if>.conf` | root | Per interface, chain `OPSCREW-<if>` jumped to from `DOCKER-USER`, run before Docker, which `Requires=` it (fail-closed), as 009's web filter is. |
| `/etc/opscrew/host.json` | root | The host record gains `networks`: interface → app, so a second app's plan picks the next port and never touches the first app's interface. |
| ufw | | `<port>/udp` allowed; the login's SSH port allowed on each interface; the host's Docker networks allowed to the private address on the published ports (`opscrew-network-local`); with `publicSsh: false`, the public SSH rules removed (on a server OpsCrew created also cloud-init's `22/tcp`). |

## In GitHub (secrets, through the typed adapter)

- `OPSCREW_SERVER_<NAME>_HOST` and `OPSCREW_SERVER_<NAME>_KNOWN_HOSTS` per extra server. The deploy
  key is the app's existing one, also authorized on each extra server.
- `OPSCREW_SERVICE_<NAME>_ENV` stays per service; the workflow writes it on the service's server.
- The scheduled check's `OPSCREW_CHECK_SERVER` becomes a list of every server of the environment.
