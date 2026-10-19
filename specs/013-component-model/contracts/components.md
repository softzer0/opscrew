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
  init?: (ctx: ServiceContext) => { command: string[] };          // one-shot: MongoDB's replica set, Garage's layout
  secrets: GeneratedSecret[];           // e.g. { name: "password", format: "hex32" }
  appVariables: (ctx: ServiceContext) => Record<string, string>;  // what the app receives, by its detected names
  hostSettings?: { sysctl: Record<string, string> };              // vm.max_map_count for the search engines
  targets: ("server" | "portainer")[]; // portainer omitted when a host setting is needed
}
```

**Guarantees:**
- The table is data. One renderer writes every service for Compose, and one for Portainer stacks.
- Every rendered service has `mem_limit` (the plan's `memoryMb`), `restart: unless-stopped`, the
  app's internal network, its volume, no `ports`, and its healthcheck.
- Secrets are referenced by name in an env file the app's Compose project reads. A value never
  appears in a rendered repository file.

## Process start forms (T1305)

| Builder | Worker | Cron (`cron` service) |
|---|---|---|
| generated Dockerfile | `command: ["sh", "-c", "<command>"]` | `command: ["supercronic", "/etc/opscrew/crontab"]` |
| own Dockerfile | `command: ["sh", "-c", "<command>"]` | the same (supercronic added by a seal step) |
| Buildpacks | Procfile type: `entrypoint: ["/cnb/process/<type>"]`; other: `entrypoint: ["/cnb/lifecycle/launcher", "--"]`, `command: ["<command>"]` | `entrypoint: ["/cnb/lifecycle/launcher", "--"]`, `command: ["supercronic", "/etc/opscrew/crontab"]` |
| Railpack | `command: ["<command>"]` (the image runs `bash -c`) | `command: ["supercronic /etc/opscrew/crontab"]` |

The spike (T1302) confirms each row; it changes this table if needed.

**Workers:** no `ports`, no healthcheck, `stop_grace_period: <stopGraceSeconds>s`, `mem_limit`,
`restart: unless-stopped`, and `deploy.replicas` as the count (or one service per copy, whichever
the spike shows Compose honours without Swarm).

**Cron:**
- The crontab is generated in `opscrew/runtime/crontab` and mounted read-only.
- A `route` job calls `http://app:<port><route>` with `Authorization: Bearer ${CRON_SECRET}`,
  through the probe tool (`app.build.probe`).
- `TZ` is the plan's time zone.
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

## The edge on a server (T1308)

- **`/srv/edge`:** Compose project `opscrew-edge`, with Caddy, kamal-proxy, and cloudflared when
  tunnelled, and the external network `opscrew-edge`.
- **Each app:** `/srv/apps/<app>/compose.yaml` (project `<app>`). Its web service joins
  `opscrew-edge`, with the network alias `<app>-web`.
- **Caddy:** imports `/srv/edge/sites/*.caddy`. `<app>.caddy` routes the app's hostnames to
  kamal-proxy, and a `www` name redirects to the main one.
- **kamal-proxy:** one service per app, `kamal-proxy deploy <app> --target <container>:<port>
  --host <domain> …`.
- **cloudflared:** one tunnel per host, with an ingress rule per hostname, all apps included.
- **Ownership:**
  - the edge belongs to the host record (`/etc/opscrew/host.json`, which lists the apps);
  - each app's record is `/etc/opscrew/apps/<app>.json`;
  - the edge goes with the last app.
- **Conflicts:** a hostname another app holds is refused before any change.
