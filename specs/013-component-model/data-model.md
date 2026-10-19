# Data model: 013

Everything is unreleased, so the schemas change directly, without migrations.

## `opscrew/plan.yaml` (packages/plan-schema)

```yaml
app:
  # … existing fields: name, port, healthPath, build, env, releaseCommand …
  memoryMb: 512                    # the web process's limit
processes:
  workers:
    - name: worker                 # Compose service name; unique; [a-z][a-z0-9-]*
      command: "celery -A app worker --loglevel info"
      source: library              # procfile | library | user
      count: 1                     # 1–10; fixed at 1 when single
      single: false                # schedulers that must run once (Celery beat, Laravel's scheduler)
      stopGraceSeconds: 30         # 5–600
      memoryMb: 256
      enabled: true                # false keeps the entry and runs nothing
  cron:
    - name: cleanup
      schedule: "*/15 * * * *"     # supercronic syntax (an optional seconds field)
      command: "python manage.py clearsessions"   # or `route`, not both
      route: "/api/cron/cleanup"   # vercel.json jobs: called with Authorization: Bearer $CRON_SECRET
      timeZone: UTC                # IANA name
      enabled: true
services:
  - kind: mysql                    # postgres | mysql | mariadb | mongodb | valkey | rabbitmq | nats
                                   # | kafka | redpanda | garage (part 1)
                                   # | opensearch | elasticsearch | meilisearch | typesense
                                   # | clickhouse | neo4j (part 2)
    version: "8.4"
    memoryMb: 512
    enabled: true
    options: {}                    # per kind, e.g. valkey { mode: queue|cache }, mongodb
                                   # { replicaSet: true }, kafka { retentionHours, retentionGb }
    reason: "The app uses mysql2."
    licence: GPL-2.0               # the catalog's; shown at design when not permissive
storage:
  sqlite:
    dir: storage                   # the database folder, relative to the app; a persistent volume
  objectStorage:
    provider: r2                   # r2 | digitalocean | hetzner | garage
    bucket: shop-uploads
    region: auto                   # the provider's region or location
    cors: true                     # only when presigned browser uploads are detected
    expected: { storageGb: 10, egressGbPerMonth: 50 }   # from the interview's scale; editable; prices use it
    price: { monthly: 0, currency: USD, source: "…", checkedOn: "2026-10-19" }
```

**Validation:**
- Worker and service names are unique within the app and never `app`, `release`, `cron`, `proxy`
  or `caddy`.
- `single: true` forces `count: 1`.
- A cron entry has exactly one of `command` and `route`.
- A service's `memoryMb` is at least its catalog minimum.
- The sum of all limits, plus the edge and the system reserve, fits the server. Design checks this
  and the schema does not.
- `storage.objectStorage.provider` must be offered for the target: `digitalocean` only on
  DigitalOcean, `hetzner` only on Hetzner, `garage` only on an own server or Portainer, `r2`
  everywhere.
- Part 2 kinds that need host settings are refused for a Portainer target.

`app.build`, `deploy` and the rest are unchanged. `deploy.strategy` is `recreate` when
`storage.sqlite` is set.

## `ProjectFacts` (opscrew/architecture.json)

| Field | Meaning |
|---|---|
| `workers[]` | name, command (when conventional), source (procfile, library), single, evidence |
| `cronJobs[]` | schedule, route, source (`vercel.json`) |
| `services[]` | gains the new kinds; each entry keeps its evidence and the URL variable it reads |
| `hostedServices[]` | kind, variable, provider name (Atlas, PlanetScale, Upstash, Neon …) |
| `sqlite` | the database paths found, and the folder |
| `objectStorage` | the client found, presigned-upload use, the variable names the app reads |

## Service catalog (packages/iac-templates/src/catalog)

See contracts/components.md for `ServiceSpec`. One entry per kind, as data, read by one renderer for
Compose and one for Portainer stacks.

## Host record (own server, packages/connectors/ssh-host)

- `/etc/opscrew/host.json` lists the apps and the edge's version.
- `/etc/opscrew/apps/<app>.json` per app: its hostnames, folders, Compose project and services.
- The single `/etc/opscrew/app.json` goes.

## Generated files

| File | Written by | Rewritten by OpsCrew? |
|---|---|---|
| `opscrew/runtime/compose.yaml` (app, workers, cron, services) | provision | yes, with newer pins kept |
| `opscrew/runtime/crontab` | provision, when there are cron jobs | yes |
| `opscrew/runtime/services/<kind>/…` (`my.cnf`, `rabbitmq.conf`, `nats.conf`, Garage's `garage.toml`) | provision | yes |
| `opscrew/runtime/edge/` (the edge Compose file, the Caddy site file) | provision | yes |
| `opscrew/infra/…` (R2, Spaces, S3 bucket resources) | provision | yes |

## Generated values (projectHomeDir/generated_values.json)

Each service's password, key or token; `CRON_SECRET`; the R2 token and S3 secret come from
Terraform state (encrypted), not this file. The user's pasted storage key is kept in the project's
local secrets, like a provider token.
