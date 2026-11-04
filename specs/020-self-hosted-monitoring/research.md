# Research: self-hosted monitoring (020)

Research from 2026-11-01. Two parts:
- A Sonnet agent read only official sources: Prometheus, Loki, Grafana, Alloy, cAdvisor,
  node_exporter, postgres_exporter, Caddy and kamal-proxy (about 17 pages).
- A Haiku agent mapped what OpsCrew already has, with file and line (017's add-ons, 018's network
  and extra servers).

"Unconfirmed" marks a fact no fetched official page stated. Sections R1–R5 are findings, and R6
holds the lead's decisions, which the spec builds on. The spike (T2001) adds R7.

## R1. Versions, images and licences

| Project | Latest stable (2026-11-01) | Image | Licence | Source |
|---|---|---|---|---|
| Prometheus | 3.15.1 (2026-10-21) | `prom/prometheus` (also on quay.io) | Apache-2.0 | https://github.com/prometheus/prometheus/releases |
| Loki | 3.7.9 (2026-10-20; first read as 3.7.0, corrected in R7) | `grafana/loki:3.7.9` | AGPL-3.0 | https://grafana.com/docs/loki/latest/setup/install/docker/ |
| Grafana OSS | 13.3.0 (2026-10-27) | `grafana/grafana` | AGPL-3.0 | https://github.com/grafana/grafana/releases |
| Grafana Alloy | 1.21.3 (2026-10-28) | `grafana/alloy` (017 pins 1.21.2) | Apache-2.0 | https://github.com/grafana/alloy/releases |
| node_exporter | 1.12.1 (2026-07-14) | `quay.io/prometheus/node-exporter` | Apache-2.0 | https://github.com/prometheus/node_exporter/releases |
| cAdvisor | 0.60.6 (2026-09-18) | `ghcr.io/google/cadvisor` (v-prefixed tags since 0.57) | Apache-2.0 | https://github.com/google/cadvisor/releases |
| postgres_exporter | unconfirmed | `quay.io/prometheuscommunity/postgres-exporter` | Apache-2.0 | https://github.com/prometheus-community/postgres_exporter |

- Unconfirmed for every image: a multi-arch index with amd64 and arm64. `update-pins.mjs` reads
  the index and fails on a missing architecture, so the spike settles it (S6).
- Grafana 13.3.0's release notes were cut off when fetched. Read them for breaking changes before
  pinning (S3).
- **Promtail reached its end of life on 2026-03-02:** no more updates. Alloy replaces it.
  Source: https://grafana.com/docs/loki/latest/send-data/promtail/

## R2. Collecting: pull or push

- **Pull:** Prometheus scrapes node-exporter and cAdvisor on every server over the private
  network. Each server then runs two more containers, and the monitoring server keeps a list of
  targets that changes with every server.
- **Push:** one Alloy per server sends to the monitoring server.
  - Prometheus 3.x takes it with `--web.enable-remote-write-receiver`, on `/api/v1/write`.
    Source: https://prometheus.io/docs/prometheus/latest/storage/
  - Loki takes it on `/loki/api/v1/push` (unconfirmed on a fetched page; it's Loki's documented
    push API, which 017's Grafana Cloud add-on already uses).
- **Alloy's built-in exporters** cover what pull would need, in the one container 017 already pins:
  - `prometheus.exporter.unix` (node_exporter's collectors);
  - `prometheus.exporter.cadvisor`, Linux only. Its docs run it `privileged: true`, with `/` and
    `/sys` read-only, `/var/lib/docker` read-only, `/dev/disk` read-only, `/var/run` and the Docker
    socket. Arguments: `docker_only`, `store_container_labels`, `storage_duration`. Source:
    https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.cadvisor/
    Whether it works through 017's read-only Docker proxy, and without privileged mode, is
    unconfirmed (S1).
  - `prometheus.exporter.postgres` (postgres_exporter's collectors).
- **One Alloy, two destinations:** Alloy runs any number of `loki.write` and
  `prometheus.remote_write` components, so one Alloy can send to Grafana Cloud and to the monitoring
  server. Unconfirmed on a fetched page (S7).

## R3. Sizes and retention

- **Prometheus on disk:** about 1–2 bytes per sample;
  `retention_seconds × samples_per_second × bytes_per_sample`. Retention is
  `--storage.tsdb.retention.time` (default 15d) and `--storage.tsdb.retention.size` (default off);
  whichever is reached first applies. The docs advise keeping the size cap at 80–85% of the disk.
  Source: https://prometheus.io/docs/prometheus/latest/storage/
- **Prometheus in memory:** about 3 KB per active series is the common figure (unconfirmed).
- **Loki, one process with files on disk:**
  - schema v13 with the `tsdb` store and a 24-hour index period; v13 and tsdb are required for
    structured metadata, which 3.x turns on by default. Source:
    https://grafana.com/docs/loki/latest/setup/upgrade/
  - retention through the compactor: `compactor.retention_enabled: true`,
    `compactor.delete_request_store` (required with retention since 3.0; `filesystem` here is the
    lead's inference), `retention_delete_delay`, and `limits_config.retention_period`. Source:
    https://grafana.com/docs/loki/latest/operations/storage/retention/
  - Loki has no retention by size: only by time.
- **Memory, no official figures fetched:** Prometheus 300–600 MB, Loki 200–400 MB, Grafana
  150–250 MB, so about 1–1.5 GB for the stack, as the roadmap says. The spike measures it (S2).
- **A rough disk estimate:**
  - 3 servers and about 30 containers is about 7,000 series. At a 15-second interval that is about
    470 samples a second, 40 million a day, and about 1 GB over 15 days.
  - Logs depend on the app. 017's `grafanaEstimate` already reads a server's log volume, and
    design reuses it.

## R4. Grafana, dashboards and HTTP figures

- **Grafana hardening.** Source:
  https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/
  - `GF_ANALYTICS_REPORTING_ENABLED=false` (on by default, it reports to stats.grafana.org),
    `GF_ANALYTICS_CHECK_FOR_UPDATES=false`, `GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false` and
    `GF_ANALYTICS_FEEDBACK_LINKS_ENABLED=false`;
  - `GF_SECURITY_DISABLE_GRAVATAR=true`;
  - sign-up off by default (`[users] allow_sign_up`), and anonymous access off by default;
  - `GF_SERVER_HTTP_ADDR` sets the address it listens on (default all);
  - `$__file{path}` reads a setting from a file. The `GF_<SECTION>_<KEY>__FILE` form for the admin
    password is unconfirmed on the fetched page (S3).
  - Files under `/etc/grafana/provisioning` (datasources and dashboard providers, with
    `allowUiUpdates: false` and `editable: false`) were not fetched (S3).
- **Ready-made dashboards:**
  - The licence of grafana.com's community dashboards (Node Exporter Full 1860, 9628 and others)
    could not be confirmed: the terms page returned 404. They are not vendored.
  - The projects' own mixins (node_exporter's, postgres_exporter's `postgres_mixin`, Loki's) live
    in Apache-2.0 repositories, but they are Jsonnet and lean on recording rules.
  - So OpsCrew renders its own small dashboards, Apache-2.0, from code (R6).
- **Caddy's figures.** Source: https://caddyserver.com/docs/metrics
  - The `metrics` global option, with `per_host` for a host label. The figures are on the admin
    API's `/metrics` (default `localhost:2019`), or on a `metrics` handler in any site.
  - Series: `caddy_http_requests_total`, `caddy_http_request_duration_seconds`,
    `caddy_http_response_duration_seconds`, `caddy_http_request_errors_total`,
    `caddy_http_requests_in_flight`, plus `go_*` and `process_*`.
  - Counters must not be summed across handlers (double counting). Keep `observe_catchall_hosts`
    off: hosts nobody configured are an unbounded label.
- **kamal-proxy** has `--metrics-port` on `run` for Prometheus figures. Source:
  https://github.com/basecamp/kamal-proxy. The path, and whether v0.10 has it, are unconfirmed.
  OpsCrew reads HTTP figures from Caddy, the default edge, so kamal-proxy's aren't needed.
- **postgres_exporter's login:** `GRANT pg_monitor TO <login>` (PostgreSQL 10 and later). The
  password-file variables are deprecated, but `--datasource.uri-file` replaces them. Alloy's
  `prometheus.exporter.postgres` takes the data source from a secret value, which
  `local.file … is_secret = true` gives.
- **AGPL-3.0 (Grafana, Loki):** Grafana's licensing page states only the 2021 move to AGPLv3. That
  running unmodified official containers asks nothing of the user, and that only a modified version
  offered over a network must publish its source, is general knowledge, unconfirmed on Grafana's
  page. OpsCrew never links them into the CLI; it renders configuration for the official images.
  Source: https://grafana.com/licensing/

## R5. What OpsCrew has to build on (code map, 2026-11-01)

- **017's add-ons:**
  - `plan.observability` holds `check`, `beszel` and `grafanaCloud`
    (`packages/plan-schema/src/plan.ts`, with `ADDON_MEMORY_DEFAULTS`);
  - `agents/src/addons/` holds `addonEnable`, `addonDisable`, `addonStatus`, `addonOpen` (an SSH
    tunnel to Beszel's local port), the generated secrets and `grafanaEstimate` (series and log
    volume read from the server);
  - `iac-templates/src/addons/` renders `config.alloy` (Docker logs of the app's Compose project
    through the read-only proxy, OpsCrew's token patterns, the known-values file, `loki.secretfilter`,
    sampling, `prometheus.exporter.unix` on an allow-list of four figures, and the Grafana Cloud
    writers), Beszel's files and the proxy's Caddyfile (GET and HEAD only, per add-on paths);
  - the host steps `beszel` and `alloy` (`connectors/ssh-host/src/steps.ts`, `plan.ts`), one per
    server; the host record says which app owns each;
  - `agents/src/shared/memory.ts` adds the add-ons' limits to the server's budget.
- **018's network and extra servers:**
  - `plan.servers` (`ExtraServerSchema`, cloud or own) and `plan.network` (`range`, `members`,
    `devices`, `grants`, `publicSsh`);
  - `agents/src/network/` allocates, makes keys, derives peers and the filter's rules;
  - ssh-host's `network`, `network-filter`, `public-ssh` and `grant` steps;
  - an extra server is one more provider module in the root module. Provision deletes one that left
    the plan only with its name typed. The deploy workflow skips extra servers with nothing to run;
  - `addon open` and `portainer` use the private address when this computer is a device;
  - `vpn add` creates the network of a single-server app, and sends the user to `provision` for the
    cloud firewall's UDP rule.
- **Caddy:** the edge's admin API listens on `127.0.0.1:2019` inside its container (the health
  check uses it). No `metrics` option is set anywhere today.
- **No Prometheus, Loki or Grafana code exists.**

## R6. Lead decisions for the spec

1. **Push with Alloy, one per server.** Every server of a monitored environment runs Alloy, which
   017 already pins. It sends the server's and the containers' figures, the logs (masked as 017
   masks them) and, where they run, Caddy's and Postgres's figures. No node-exporter, cAdvisor or
   postgres_exporter containers, and no target list on the monitoring server. On the app's server,
   one Alloy sends to Grafana Cloud and the monitoring server when both are on.
2. **The monitoring server is one of 018's extra servers,** with no app services on it. That reuses
   its creation, sizing, prices, host key, network membership, the disk check, `secure`, `drift`,
   and deletion with a typed name. The deploy workflow already skips it (nothing to run).
3. **One monitoring server for the repository.** The first environment to turn monitoring on owns
   it; others in the same repository send to it by default. It joins each one's private network as
   a member, with one WireGuard interface per network, as an own server hosting several apps does
   in 018. Across repositories is later.
4. **Nothing public, and least access inside the network.** A front (Caddy, already pinned) on the
   monitoring server's private addresses passes only the two push paths, and only from the
   network's servers. Grafana answers only devices. App servers' filters never admit the monitoring
   server: with push it never connects to them. Grafana reads Prometheus and Loki on the stack's
   own Docker network, so neither query API is reachable from the network.
5. **OpsCrew's own dashboards,** rendered from code (Apache-2.0): servers, containers, HTTP traffic
   per hostname, Caddy, Postgres and logs, each with app, environment and server variables. Grafana
   provisions them read-only; the user's own dashboards live in Grafana's data and are kept.
6. **Retention:** 15 days of figures (with a size cap) and 7 days of logs by default, both
   settings, with the disk they take estimated at design. 017's check already watches every
   server's disk, the monitoring server's included.
7. **No alerting in the stack.** 017's scheduled check stays the alert path. Grafana alert rules are
   later, if users ask.
8. **On the app's server** only from 4 GB of memory, and only when the stack fits next to the app's
   limits.
9. **Not on Portainer, localhost or the server-less targets:** design says why, as for 017's
   add-ons.

## R7. The spike (T2001, 2026-11-04)

Run on local Docker (Docker Desktop on Windows, engine 29.9.2, cgroup v2), by two agents: the stack
(Prometheus, Loki, Grafana, the front) and the collector (Alloy, cAdvisor, Caddy, Postgres). The
memory run (S2) used both. The images are the pinned ones (T2003): Prometheus 3.15.1, Loki 3.7.9,
Grafana 13.3.0, Alloy 1.21.3, and OpsCrew's Caddy 2.11.7.

### The stack

- **Prometheus under OpsCrew's hardening** (read-only root, `cap_drop: ALL`, no new privileges):
  runs as the image's user 65534, and a new named volume takes that owner. No tmpfs is needed.
- **Prometheus refuses late samples:** remote-written samples more than about an hour behind the
  newest answer `400 out of bounds`, and Alloy drops a batch on a 400. With
  `storage.tsdb.out_of_order_time_window: 4h` in `prometheus.yml`, samples 90 and 180 minutes old
  were accepted and 300 minutes old refused. So `prometheus.yml` sets the window to match Alloy's
  WAL (S7).
- **S4, Loki 3.7.9** (3.7.0 the same) runs as 10001, and the new volume takes that owner. It
  starts, takes a push (204), and answers `query_range` directly and through Grafana.
  - **Retention needs a writable `/tmp`:** with a read-only root the compactor never deletes
    anything ("failed to create marker writer … read-only file system"), silently until data
    expires. With a tmpfs `/tmp`, retention 1 h and a 1-minute compaction, a stream pushed 49 h
    old was deleted (its index table and chunk files gone), a 3 h old one too, and a fresh one kept.
  - `retention_period` has no multiple-of-24 h rule: 1 h was accepted and applied. Only the
    schema's index period must be 24 h (tsdb, v13).
  - `reject_old_samples_max_age` refuses older lines at push (8 days old: 400; 6 days: accepted).
    Kept equal to the retention.
  - Loki adds a `service_name` label copied from `service`. `limits_config.discover_service_name:
    []` turns it off, which keeps the labels exactly the contract's.
  - `analytics.reporting_enabled: false` stops Loki's usage reports.
- **S3, Grafana 13.3.0:**
  - **Release notes:** one breaking change, `[marketplace]` renamed `[plugins_marketplace]` (not
    used here), and a fix for Classic dashboards turning into v2 JSON when a provisioned dashboard
    is saved. From 13.0: `grafana-cli` and `grafana-server` are gone (use `grafana cli`).
  - **Provisioning from files works:** the two data sources (`opscrew-prometheus`, `opscrew-loki`,
    `editable: false`, read-only in Grafana) query over the stack's network. With the dashboard
    provider's `allowUiUpdates: false`, the UI says the dashboard "cannot be saved from the Grafana
    UI because it has been provisioned" and offers only a copy, and the classic API answers `400
    Cannot save provisioned dashboard`. The user's copies and own dashboards survived a container
    recreate and a re-provision. A file removed removes its dashboard within 30 seconds.
  - **One gap:** an admin's `PUT` on the new `/apis/dashboard.grafana.app/…` API does overwrite a
    provisioned dashboard, and neither the 30-second sync nor a restart restores it. Only a change
    to the file's content does.
  - **`schemaVersion`:** Grafana 13.3's Classic export writes 42. File-provisioned classic JSON
    stays classic; even schemaVersion 27 with a `graph` panel loads and is migrated. OpsCrew
    renders classic JSON at 42.
  - **Variables:** multi-select with "All" needs `allValue: ".+"`, since Loki refuses a selector
    whose only matcher is `=~".*"`.
  - **The admin password file:** Grafana runs as 472 with group 0.
    - `GF_SECURITY_ADMIN_PASSWORD__FILE` (the image's `run.sh`) on a file it can't read logs
      "Permission denied" and starts with the default password `admin`: it fails open. It also
      leaves the password in `/proc/1/environ`.
    - `GF_SECURITY_ADMIN_PASSWORD=$__file{<path>}` (Grafana reads it itself) exits 1 on a file it
      can't read: it fails closed, and nothing stays in the environment.
    - root:root `0640` works (read through group 0); so does 472:0 `0400`.
    - The password is used only when the admin is first created: a different one in the file later
      changes nothing. `grafana cli … admin reset-admin-password --password-from-stdin` inside the
      container resets it.
  - **Defaults:** sign-up and organisation creation are off, and anonymous access is off. Open by
    default: Grafana's own `/metrics` (200 without a login) and public dashboards. Both are turned
    off.
  - **Phone-home,** watched with a capture in Grafana's network namespace:
    - with the defaults, 160 DNS lookups of grafana.com in 145 s: the plugin preinstaller (five
      apps), version lookups for every bundled plugin, the update check, the signing key;
    - with the settings below, none at start;
    - opening the "Add new connection" and "Plugins" pages still made Grafana's backend fetch the
      catalogue and ~230 logos from grafana.com, even with the plugin admin off. Pointing
      `GF_GRAFANA_COM_URL` and `GF_GRAFANA_COM_API_URL` at a closed local port stopped it: a
      15-page walk then made no external connection.
    - **The settings:** `GF_ANALYTICS_REPORTING_ENABLED`, `_CHECK_FOR_UPDATES`,
      `_CHECK_FOR_PLUGIN_UPDATES`, `_FEEDBACK_LINKS_ENABLED`, `GF_NEWS_NEWS_FEED_ENABLED`,
      `GF_PLUGINS_PLUGIN_ADMIN_ENABLED`, `GF_SNAPSHOTS_EXTERNAL_ENABLED`,
      `GF_PUBLIC_DASHBOARDS_ENABLED`, `GF_METRICS_ENABLED`, `GF_AUTH_ANONYMOUS_ENABLED`,
      `GF_USERS_ALLOW_SIGN_UP`, `GF_USERS_ALLOW_ORG_CREATE` all `false`;
      `GF_SECURITY_DISABLE_GRAVATAR`, `GF_PLUGINS_PREINSTALL_DISABLED`,
      `GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED` `true`; the two `GRAFANA_COM` URLs at
      `http://127.0.0.1:9`.
  - **Memory:** Grafana 13.3 starts each bundled data source that has a backend as a process of its
    own (14, at 25–40 MB each): 346–350 MiB idle, and OOM-killed at 256 MB on first start. With
    `GF_PLUGINS_DISABLE_PLUGINS` listing the twelve OpsCrew doesn't use, 199–205 MiB idle and about
    300 MiB after a walk through the UI.
  - Grafana needs a tmpfs `/tmp` (its plugins' Unix sockets).
- **The front** (the pinned Caddy):
  - `admin off`, two POST-only matchers rewritten to the exact upstream path, everything else
    `respond 403`. 25 refusals checked: other methods on the push paths, the query and label APIs,
    `/metrics`, admin, delete and read APIs, OTLP, `..` and `%2f` traversals. Variants that clean to
    `/api/v1/write` reach only the write handler.
  - **Body cap 8 MiB:** 7 MiB passes and 9 MiB answers 413. Alloy's batches stay under 1 MiB on the
    wire (remote write sends at most 2,000 samples a request, `loki.write` 1 MiB of lines before
    snappy). A cap too small would lose data, because Alloy drops a batch on a 4xx.
  - Runs as 65534 with `cap_add: NET_BIND_SERVICE` (the image's binary carries it as a file
    capability, as for 017's proxy) and tmpfs `/data` and `/config` owned by 65534.
  - Its healthcheck checks both upstreams' readiness, since Loki's image has no shell or `wget`.
  - A real Alloy push from two senders (two environments) arrived in both Prometheus and Loki.
- **Isolation:** Prometheus and Loki are only on the stack's internal network (no route out); the
  front and Grafana are also on a second network that publishes their ports. From there,
  `prometheus:9090` and `loki:3100` don't resolve, and the front's query paths answer 403.
- **S6:** all four pinned indexes list linux/amd64 and linux/arm64. Loki's newest 3.7 is 3.7.9
  (2026-10-20), not 3.7.0 as R1 says; the others are the newest of their lines.

### The collector

- **S1, cAdvisor inside Alloy.** Alloy vendors a fork of cAdvisor 0.60.5.
  - **Its Docker integration can't work unprivileged:** to build a container it reads the
    container's read-write layer, from `/var/lib/docker/image/<driver>/layerdb/…` (root-only, and
    it would expose every volume) or, with the containerd image store, through containerd's socket
    (root-equivalent). Docker 29 uses the containerd store on new installs: a fresh Ubuntu 24.04
    server at Hetzner reported `overlayfs`. A separate cAdvisor container runs the same code.
  - **What works:** cAdvisor on the cgroups only (`docker_host` at a socket that doesn't exist,
    `docker_only`, `raw_cgroup_prefix_allowlist = ["/docker/", "/system.slice/docker-"]`,
    `enabled_metrics = ["cpu", "memory", "oom_event", "network"]`), with names from
    `discovery.docker` through 017's proxy: one scrape target per container reads cAdvisor's output
    and keeps only its own series (`keepequal` on the id taken from the cgroup path). Series carry
    `service`, `container` and `container_id`, with the right CPU, working set, limit and start
    time.
  - **Mounts:** `/:/rootfs:ro` and `/sys:/sys:ro` (cAdvisor's paths are fixed), plus the proxy's
    socket. No `privileged`, no `/var/lib/docker`, `/var/run`, `/dev/disk` or containerd socket.
    Lost: per-container filesystem, disk I/O and network figures, and the image label. No dashboard
    uses them.
  - **The proxy needs no new path:** cAdvisor and `discovery.docker` call only `_ping`, `version`,
    `info`, `containers/json`, `networks` and `containers/{id}/json`.
  - **The server's network:** the unix exporter's `netdev` sees only Alloy's own bridge. cAdvisor's
    root cgroup reads the host's `/proc/1/net/dev` through `/rootfs`:
    `container_network_{receive,transmit}_bytes_total{id="/"}`, dropping `lo`, `veth*`, `br-*`,
    `docker*` and `wg*`.
  - **Restarts:** `changes((max by (app, env, server, service) (container_start_time_seconds))
    [$__range:15s])` counted one restart and one recreate. A deploy counts as one.
  - **Checked on a real server** (Hetzner cx23, Ubuntu 24.04, Docker 29.9.3, cgroup v2 with
    systemd): cgroups are `/system.slice/docker-<id>.scope`; all five test containers were named
    with their service, their limits and CPU were right, and the server's `eth0` traffic showed.
    The local runs had cgroup v1.
  - **Alloy's HTTP server listens on `127.0.0.1`** and scrapes cAdvisor there, so the app's
    containers on the networks Alloy joins can't reach its API.
  - **Memory:** `keepequal`'s cost grows with containers × containers: 63 MiB more than an info
    series at 32 containers, small at a server's usual 8–12. `discovery.docker` is limited to the
    app's Compose project and OpsCrew's own (edge, add-ons), which also keeps other containers on
    a shared server from getting this app's labels.
- **S5, Caddy's figures** (the pinned edge with kamal-proxy 0.10.2, `metrics { per_host }`, and
  `http://:9180 { metrics }` on the edge's network only):
  - **Series:** `caddy_http_requests_total{handler,host,server}`,
    `caddy_http_request_duration_seconds_{bucket,sum,count}{code,handler,host,method,server}`,
    `caddy_http_requests_in_flight`, `caddy_http_request_errors_total` (only after a handler
    error), `process_*`, `go_*`. 311 series unfiltered for one host; 78 kept.
  - **Caddy's own `server` label** (`srv0` for :443, `srv1` for :80, `srv2` for :9180) clashes with
    OpsCrew's: sent as is, HTTP series kept `server="srv0"`. Alloy copies it to `caddy_server` and
    drops `server` before adding OpsCrew's.
  - **The metrics site's own scrapes are counted,** as `handler="metrics", host="_other"`: Alloy
    drops them.
  - **Unknown hosts** are aborted by the catch-all sites and never counted. `host` is the Host
    header as sent, port included when the client gives one.
  - **No double counting:** one handler per request; the summed `_count` equals
    `requests_total` equals the requests sent. Requests per host: `sum by (host)
    (rate(caddy_http_request_duration_seconds_count{handler!="metrics"}[5m]))`; error shares the
    same with `code=~"4.."` or `"5.."`; p50 and p95 by `histogram_quantile` over `sum by (host, le)`.
- **S7, one Alloy, two destinations** (a second Loki and Prometheus standing in for Grafana Cloud):
  - **Sampling moves:** out of 017's `loki.process "mask"` into its own process on Grafana Cloud's
    branch, after the fan-out that follows `loki.secretfilter`. In two minutes the stack got 124 of
    124 lines, "Grafana Cloud" 55. Masking held on both branches. Only with monitoring on; a Grafana
    Cloud-only plan keeps today's file.
  - **The known-values file must be one capture group** `(…)`, as 017's deploy writes it; without
    the parentheses nothing is masked.
  - **A 2-minute stop** of the stack: afterwards it had every sample (from the WAL) and every line,
    about 20 s after it came back.
  - **A 10-minute stop with Alloy's defaults** lost data: one log batch ran out of retries at about
    6.5 minutes, and a reshard of the remote write (1 → 19 shards) during the outage dropped 718
    queued samples.
  - **With `queue_config { max_shards = 1 }`** on the stack's remote write **and `loki.write`'s
    `max_backoff_period = "30s"`, `max_backoff_retries = 40`:** every sample and every line of a
    10-minute stop arrived within 20–40 s of the return.
  - **What bounds a longer gap:** the WAL keeps figures up to `max_keepalive_time` (default 8 h;
    about 1 MB after 25 minutes). `loki.write` keeps lines in memory only (its WAL is experimental),
    bounded by retries × backoff per batch (40 × 30 s, about 20 minutes) and its queue.
  - **A dead destination can stall the live one:** once the failing `loki.write`'s in-memory queue
    (10 MiB) fills, the source stops reading, so Grafana Cloud's logs stall too, until batches are
    dropped. At a typical server's log rate that takes hours. Accepted and documented: the
    settings that change it are experimental, and a second masking chain would double the work.
- **Postgres** (the pinned `postgres:17-alpine`): `opscrew_monitor` with `LOGIN`, `CONNECTION
  LIMIT 3` and `GRANT pg_monitor` only; reading an app table gave "permission denied".
  - The file Alloy reads must hold the whole data source (`postgresql://opscrew_monitor:…@…`), read
    by `local.file` with `is_secret = true`. A password-only file passed through `string.format`
    fails, and its error printed the password. Alloy logs the data source with the password
    removed.
  - **Collectors:** `["database", "stat_database"]`, with the default and settings figures on.
    Everything on is 562 series; 40 kept.
  - **Series:** `pg_stat_database_numbackends` against `pg_settings_max_connections`;
    `pg_stat_database_xact_commit` + `_xact_rollback`; `_blks_hit` / (`_blks_hit` + `_blks_read`);
    `pg_database_size_bytes`; `pg_stat_database_deadlocks`; the oldest query
    `max(pg_stat_activity_max_tx_duration{state="active"})`.
- **Series per server** (the full list kept with the spike's files): the unix exporter 5 per CPU +
  7; cAdvisor 5 per container, plus 2 per physical interface; Caddy 78 for one host; Postgres 40. A
  2-vCPU server with 8 containers, the edge and Postgres sends about 180 series, roughly 30 MB over
  15 days. R3's "about 150 per container" was wrong by thirty times.
- **Scrape interval:** Alloy's default is 60 s, so every scrape sets `15s`.
- **Alloy's memory** (32 containers): logs and the unix exporter 96 MiB; with Grafana Cloud too 107;
  with Postgres and Caddy 117; with cAdvisor 161–234. At 017's 256 MB limit it ran at 200–242 MiB,
  held down by the garbage collector, so monitoring needs a larger limit (S2). 017's proxy used 27
  of its 32 MiB.
