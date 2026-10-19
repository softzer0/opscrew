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
      enabled: true
services:
  - name: mysql                    # the Compose service and data folder name; default: db (postgres),
                                   # cache (valkey cache), queue (valkey queue), else the kind
    kind: mysql                    # postgres | mysql | mariadb | mongodb | valkey | rabbitmq | nats
                                   # | kafka | redpanda | garage (part 1)
                                   # | opensearch | elasticsearch | meilisearch | typesense
                                   # | clickhouse | neo4j (part 2)
    version: "8.4"
    memoryMb: 512
    enabled: true
    options: {}                    # per kind, e.g. valkey { mode: queue|cache }, mongodb
                                   # { replicaSet: true }, kafka { retentionHours, retentionGb }
    variable: DATABASE_URL         # optional: the app's own variable for the address, from detection;
                                   # it gets the address too; unique among enabled services
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
    # No key here: the user's storage key is kept locally like a provider token.
```

**Validation:**
- Worker and service names are unique within the app and never `app`, `release`, `cron`, `proxy`
  or `caddy`.
- `single: true` forces `count: 1`.
- A cron entry has exactly one of `command` and `route`. Schedules are in UTC; there is no time zone
  field (research "Spike results" 6).
- A service's `memoryMb` is at least its catalog minimum.
- The sum of all limits, plus the edge and the system reserve, fits the server. Design checks this
  and the schema does not.
- `storage.objectStorage.provider` is offered by design for the target: `digitalocean` on
  DigitalOcean, `hetzner` on Hetzner (fsn1, nbg1, hel1), `garage` only on an own server or
  Portainer, `r2` when the plan uses Cloudflare (it needs OpsCrew's Cloudflare token and account).
  After a retarget, an existing provider stays valid: the bucket is kept.
- `storage.sqlite.dir` is relative to the app's folder in the image, `appRoot(plan)`: Buildpacks
  `/workspace`; Railpack `/app`; the generated Dockerfile `/app`, or `/app/<appDir>` for a Node.js
  app in a subfolder; the user's own Dockerfile, the last `WORKDIR` detect read.
- Part 2 kinds that need host settings are refused for a Portainer target.

**Expected storage use** (`storage.objectStorage.expected`), from the interview's
`expectedMonthlyUsers`, editable:

| Users a month | Stored | Egress a month |
|---|---|---|
| under 1k | 10 GB | 50 GB |
| 1k–10k | 50 GB | 250 GB |
| 10k–100k | 250 GB | 1,000 GB |
| over 100k | 1,000 GB | 5,000 GB |

**Sizing figures** (to be settled by the live runs):
- the system reserve is 384 MB;
- the edge is 128 MB (Caddy 64, kamal-proxy 32, cloudflared 32 when tunnelled);
- design refuses when the limits exceed the server's memory minus the reserve, and warns when less
  than 15% of it is left.

`app.build`, `deploy` and the rest are unchanged. `deploy.strategy` is `recreate` when
`storage.sqlite` is set.

## `opscrew/requirements.yaml`

`workerCommands` (optional): the commands the interview asked for detected workers with no
conventional command (BullMQ, asynq, river), by worker name. Design uses one when `facts.workers`
has no command; later designs keep the plan's command. Question ids `workerCommands.<name>`.

`keepExternalServices`: one answer per kind, `true` to keep the service the app uses now, `false` to
let OpsCrew run one on the server. A detected hosted service with no answer is kept, so OpsCrew never
replaces one unasked. `s3: true` keeps the app's own storage instead of a planned bucket. Question
ids `keepExternalServices.<kind>`.

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

- `/etc/opscrew/host.json` lists the apps.
- `/etc/opscrew/apps/<app>.json` per app: its hostnames, folders, Compose project, services and
  the sum of its memory limits.
- The edge's version is a stamp in `/srv/edge/compose.yaml` (OpsCrew's pin-set date); a deploy keeps
  the newer of its own and the server's.
- The single `/etc/opscrew/app.json` goes.

## Generated files

| File | Written by | Rewritten by OpsCrew? |
|---|---|---|
| `opscrew/runtime/compose.yaml` (app, workers, cron, services) | provision | yes, with newer pins kept |
| `opscrew/runtime/crontab` | provision, when there are cron jobs | yes |
| `opscrew/runtime/services/<kind>/…` (`my.cnf`, `rabbitmq.conf`, `nats.conf`, Garage's `garage.toml`) | provision | yes |
| `opscrew/runtime/edge/` (the edge Compose file with its stamp, the app's Caddy site file) | provision | yes |
| `opscrew/infra/storage/` (the bucket and its CORS; no key) | provision | yes |

## Generated values (projectHomeDir/generated_values.json)

Each service's password, key or token; `CRON_SECRET`; Garage's key, which OpsCrew generates and
imports. The user's storage key (Spaces, Hetzner, or the R2 token's keys) is kept in the project's
local secrets, like a provider token, and is never in infrastructure state.
