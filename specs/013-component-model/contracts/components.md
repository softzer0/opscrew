# Contract: the service catalog, process start forms, the deploy and the edge (013)

## `ServiceSpec` (packages/iac-templates/src/catalog; types in T1301, entries in T1304 and T1311)

```ts
export interface ServiceSpec {
  kind: ServiceKind;                    // postgres | mysql | mariadb | mongodb | valkey | rabbitmq | nats
                                        // | kafka | redpanda | garage | opensearch | elasticsearch
                                        // | meilisearch | typesense | clickhouse | neo4j
  image: ImagePinKey;                   // a key of pins.ts IMAGES (repo:tag@sha256)
  defaultVersion: string;               // conservative: the LTS line or the one before the newest
  majorLocked: boolean;                 // true: Dependabot proposes no major update
  licence: { id: string; permissive: boolean; note?: string };  // note: the plain sentence design shows
  memory: { defaultMb: number; minimumMb: number; smallestServerMb: number };
  port: number;                         // internal only, never published
  dataDir: string;                      // in the container; mounted from /srv/data/<app>/<service>
  configFiles?: (ctx: ServiceContext) => RenderedFile[];   // my.cnf, rabbitmq.conf, nats.conf, garage.toml
  command?: (ctx: ServiceContext) => string[];             // e.g. mongod --wiredTigerCacheSizeGB <n>
  environment: (ctx: ServiceContext) => Record<string, string>;   // the service's own settings, secrets by name
  healthcheck: string[];                // a CMD form that works with the image's own tools
  init?: (ctx: ServiceContext) => ServiceInitStep[];               // one-shot steps: MongoDB's replica set
                                        // (Garage needs none: it starts with its own --default-bucket)
  secrets: GeneratedSecret[];           // e.g. { name: "password", format: "hex32" }
  auth: "password" | "token" | "key" | "internal-only";   // internal-only: Valkey, Kafka, Redpanda,
                                        // OpenSearch (reachable only from the app's own containers)
  address: (ctx: ServiceContext) => string;                       // the service's URL or address on the app's network
  conventionalVariables: (ctx: ServiceContext, address: string) => Record<string, string>;
                                        // what the app receives by convention; the catalog's
                                        // appVariables(ctx) adds the app's own detected variable
  hostSettings?: { sysctl: Record<string, string> };              // vm.max_map_count for the search engines
  ulimits?: { nofile: number };        // the open-file limit, soft and hard (OpenSearch, Elasticsearch: 65536)
  targets: ("server" | "portainer")[]; // portainer omitted when a host setting is needed
}
```

**Guarantees:**
- The table is data. One renderer writes every service for Compose, and one for Portainer stacks.
- Every rendered service has `mem_limit` and `memswap_limit` (the plan's `memoryMb`), `restart: unless-stopped`, the
  app's internal network, its volume, no `ports`, and its healthcheck.
- Secrets are referenced by name in an env file the app's Compose project reads. A value never
  appears in a rendered repository file.

## Process start forms (T1305)

| Builder | Worker | Cron (`cron` service) |
|---|---|---|
| generated Dockerfile | `command: ["sh", "-c", "exec <command>"]` | `command: ["supercronic", "/etc/opscrew/crontab"]` |
| own Dockerfile | `command: ["sh", "-c", "exec <command>"]` | the same (supercronic added by a seal step) |
| Buildpacks | Procfile type: `entrypoint: ["/cnb/process/<type>"]`; other: `entrypoint: ["/cnb/lifecycle/launcher"]`, `command: ["exec <command>"]` (one string) | `entrypoint: ["/cnb/lifecycle/launcher", "--"]`, `command: ["supercronic", "/etc/opscrew/crontab"]` |
| Railpack | `command: ["exec <command>"]` (one string; the image runs `bash -c`) | `command: ["exec supercronic /etc/opscrew/crontab"]` |

The spike (T1302) confirmed each row. `exec` makes the command PID 1, so SIGTERM reaches it: a
shell left as PID 1 ignores it and the container is killed after the grace period.

**Workers:** no `ports`, no healthcheck, `stop_grace_period: <stopGraceSeconds>s`, `mem_limit` and
`memswap_limit` (the same value; Docker's default swap is twice the limit), `restart:
unless-stopped`, and `deploy.replicas` as the count (honoured by Compose and Portainer without
Swarm).

**Cron:**
- The crontab is generated in `opscrew/runtime/crontab` and mounted read-only.
- A `route` job sends a GET to `http://app:<port><route>` with `Authorization: Bearer
  ${CRON_SECRET}`, through the probe tool (`app.build.probe`): node, python, ruby, php or bash
  (`/dev/tcp`) can all send the header. With probe `none` or `wget`, design refuses route jobs and
  asks for a command job instead.
- Schedules are in UTC: supercronic's `CRON_TZ` covers the whole crontab, and Alpine images have no
  tzdata.
- Overlapping runs are skipped (supercronic's default).

## The deploy (workflow switch, T1305)

1. `docker compose up -d --no-deps --wait <steady services>`. These are the catalog services, the
   edge excluded; their data and containers are never recreated unless their configuration changed.
2. The release command, as today.
3. The web switch through kamal-proxy, as in 012 (`rolling`, or `recreate` for SQLite apps).
4. `docker compose up -d --no-deps <workers> cron` with the new image.
5. For 30 seconds, every worker must stay running (no exit, no restart).
6. On a failure in 3–5: the web and the workers go back to the previous image. The run names the
   worker and the command to read its log (`docker compose logs <worker>`).

**Guarantees:**
- Another app's containers are never touched.
- A service of the same app is restarted only when its own configuration changed.

## The edge on a server (T1308a, T1308b, T1308c)

- **`/srv/edge`:** Compose project `opscrew-edge`, with Caddy and kamal-proxy, and the external
  network `opscrew-edge`. Its Compose file carries a version stamp (`x-opscrew-edge-version`, a
  date plus a change number, compared as integers); Dependabot leaves the edge folder alone, since
  its pins move only with OpsCrew's releases and the stamp. Both containers have memory limits.
- **Each app:** `/srv/apps/<app>/compose.yaml` (project `<app>`). Its web service joins
  `opscrew-edge`.
- **Caddy:** imports `/srv/edge/sites/*.caddy`. `<app>.caddy` routes the app's hostnames to
  kamal-proxy, which redirects `www` with `--canonical-host`.
- **kamal-proxy:** one service per app, `kamal-proxy deploy <app> --target <container>:<port>
  --host <domain>,www.<domain> --canonical-host <domain> …`, with its config on a volume so routes
  survive a recreate. The target is the new web container's Compose name
  (`<app>-web-<n>`), unique across apps because each app is its own project.
- **cloudflared:** each app keeps its own tunnel, owned by its own Cloudflare root as today. Its
  connector is a host-network Compose project of its own, `<app>-tunnel`, set up by the host plan
  (as today's `opscrew-tunnel`, one per app, each with its own token and metrics port). It sends the
  app's hostnames to the edge's Caddy on `127.0.0.1:18080`, and its SSH and Portainer routes stay as
  today. Not in the app's own project: the deploy reaches a tunnelled server through this tunnel, so
  it must exist before the first deploy, and a deploy must never recreate it (T1308b's finding).
- **Who writes it:**
  - each deploy uploads `opscrew/runtime/edge/` and its site file;
  - the edge's Compose file is replaced only when the uploaded stamp is newer than the server's;
  - `docker compose -p opscrew-edge up -d` restarts only what changed, and Caddy reloads the sites.
- **Ownership:**
  - the host record (`/etc/opscrew/host.json`) lists the apps;
  - each app's record is `/etc/opscrew/apps/<app>.json`, with its hostnames and its memory limits;
  - the edge goes with the last app.
- **Conflicts:** refused before any change:
  - a hostname another app holds;
  - an app name another app uses;
  - the reserved name `opscrew-edge`.
