# Data model: self-hosted monitoring (020)

## The plan (`plan.observability.monitoring`)

Only where `onServer(plan)`: a server OpsCrew created or the user's own. Refused on Portainer,
localhost, Cloudflare and GitHub Pages, with the reason.

| Field | Type | Rule |
|---|---|---|
| `enabled` | boolean, default `false` | |
| `where` | union, below | Where the stack runs, or whom this environment sends to. |
| `versions` | `{ prometheus, loki, grafana, alloy }` | Pinned versions, from `pins.ts`. With Grafana Cloud on, `alloy` equals `grafanaCloud.version`. |
| `retention.metricsDays` | integer 1–90, default 15 | |
| `retention.logsDays` | integer 1–30, default 7 | |
| `retention.metricsMaxGb` | integer ≥ 1 | Set by design: 80% of the disk left after the logs' estimate. Prometheus's size cap. |
| `memoryMb` | `{ prometheus, loki, grafana, front, alloy, proxy }` | Defaults in `ADDON_MEMORY_DEFAULTS.monitoring` (from the spike, S2). Shown with their price share. |

**`where`:**

| `kind` | Other fields | Rule |
|---|---|---|
| `server` | `server`: a `servers` entry's name (default `monitoring`) | That server holds no `services[].server`, and is a `network` member. |
| `app` | none | The app's server has at least 4 GB, and the stack fits next to the app's limits (checked at design, with the server's facts). |
| `shared` | `owner`: `{ plan, server }`, the owner's plan file (`RepoPath`) and its server's name | `network` has a member named `owner.server` that is neither `app` nor a `servers` entry (the outside member). |

**Rules across the plan:**
- An outside member in `network.members` is allowed only with `where.kind: "shared"`.
- The monitoring server (`where.kind: "server"`) is exempt from 018's rule that every extra server
  runs an enabled service.
- With `where.kind: "shared"`, `versions` and `retention` are the owner's values copied into the
  sender's plan. The stack and status read the owner's. Design keeps the copies in step and
  refuses a sender whose values differ from its owner's, naming the owner's plan.
- On one of the user's own servers, monitoring belongs to one app, as 017's add-ons do. The host
  record says which.
- No service is placed on the monitoring server (`services[].server`).

**Example** (`opscrew/plan.yaml`, the owner):

```yaml
servers:
  - name: monitoring
    target: { provider: hetzner, mode: vps-compose, location: fsn1, serverType: cx23, backups: false }
network:
  range: 10.203.17.0/24
  members:
    - { name: app, address: 10.203.17.2, port: 51820, publicKey: "<44 chars>" }
    - { name: monitoring, address: 10.203.17.3, port: 51820, publicKey: "<44 chars>" }
observability:
  monitoring:
    enabled: true
    where: { kind: server, server: monitoring }
    versions: { prometheus: 3.15.1, loki: 3.7.9, grafana: 13.3.0, alloy: 1.21.3 }
    retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 }
```

**A sender** (`opscrew/plan.staging.yaml`):

```yaml
network:
  range: 10.205.40.0/24
  members:
    - { name: app, address: 10.205.40.2, port: 51820, publicKey: "<44 chars>" }
    - { name: monitoring, address: 10.205.40.3, port: 51821, publicKey: "<44 chars>" }  # the outside member
observability:
  monitoring:
    enabled: true
    where: { kind: shared, owner: { plan: opscrew/plan.yaml, server: monitoring } }
    versions: { prometheus: 3.15.1, loki: 3.7.9, grafana: 13.3.0, alloy: 1.21.3 }   # the owner's
    retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 }                     # the owner's
```

The outside member's port is its interface's on the monitoring server (`wg-opscrew1` here). Its
endpoint, the monitoring server's public address, is never committed: it comes from the owner's
server record on this computer.

## The labels every series carries

| Label | Where it comes from | On |
|---|---|---|
| `app` | the plan's `app.name` | everything |
| `env` | the plan's environment | everything |
| `server` | `app`, or the extra server's name | everything |
| `service` | the Compose service label | container figures and logs |
| `host` | Caddy's `per_host` | HTTP figures |

The dashboards' variables and queries use only these (T2005's test checks it).

## Secrets kept apart

| Secret | Where it lives | Written by |
|---|---|---|
| Grafana's admin password | generated; the generated values (0600) and the recovery copy; a file beside the stack's Compose file, `root:root 0640`, which Grafana (user 472, group 0) reads through its group | provision (`host-apply`, on stdin) |
| The Postgres monitoring login's password (`opscrew_monitor`) | generated; the generated values and the recovery copy; beside Alloy's Compose file, inside the whole data source (`postgresql://opscrew_monitor:…@<host>:5432/postgres`), a file only the deploy user can read (`0600`), since Alloy runs as that user | provision (`host-apply`, on stdin, to the `grant` and `alloy` steps) |
| The outside member's WireGuard private key | the sender's generated values (`network`), and the monitoring server's root-only key file for that interface | provision (`host-apply`, on stdin) |

None is ever in a plan, a committed file, a host plan's text, a log, an audit entry or an MCP
answer.

## On the servers

| Path | What | Owner |
|---|---|---|
| `~deploy/opscrew/addons/monitoring/` | the stack's `compose.yaml`, `prometheus.yml`, `loki.yaml`, `grafana/provisioning/**`, `grafana/dashboards/*.json`, the front's `Caddyfile`, and Grafana's password file `grafana_admin_credential` (`root:root 0640`) | the `monitoring` step |
| volumes `opscrew-monitoring_{prometheus,loki,grafana}` | the stack's data | the `monitoring` step; removed only with `removeData` |
| `~deploy/opscrew/addons/alloy/` | Alloy's `compose.yaml`, `config.alloy`, the Grafana Cloud token file, and the Postgres data source file `postgres_monitor_credential` (`0600`, the deploy user's) | the `alloy` step |
| `/srv/apps/<app>/mask.re` | the known values, one RE2 capture group, readable only by the deploy user (`0600`), as 017 writes it | the deploy job (app's server) and the extra servers' upload step |

## The host record

The `monitoring` step adds `addons.monitoring = { app, env }` to the host record. The `alloy`
step's entry keeps its app, and gains its destinations (`grafanaCloud`, `monitoring`).
