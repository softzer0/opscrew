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
| Loki | 3.7.0 | `grafana/loki:3.7.0` | AGPL-3.0 | https://grafana.com/docs/loki/latest/setup/install/docker/ |
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
