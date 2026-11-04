# Implementation Plan: Self-hosted monitoring

**Branch**: `main` | **Date**: 2026-11-01 | **Spec**: `specs/020-self-hosted-monitoring/spec.md`
**Research**: `specs/020-self-hosted-monitoring/research.md` (R1–R6, and the spike's R7)

The founder asked for the plan on 2026-11-01 and gave the go-ahead on 2026-11-04. The spike
(T2001, research R7) changed Design 4–9; the sections below include its results.

## Summary

Prometheus, Loki and Grafana on a small server of the user's own, reached only through 018's
private network. Every monitored server pushes to it through one Grafana Alloy.

**Turning it on** (US1, US4, US5)
- `opscrew addon enable monitoring` writes the plan only:
  - `observability.monitoring`;
  - the monitoring server as one of 018's extra servers, with no app services;
  - the network, when the environment has none.

  It shows the price, memory, retention, disk and licences first.
- `opscrew provision` applies it, as it applies 018's extra servers:
  - the IaC plan creates the server;
  - host plans, one per server, set up the network, the filter, Alloy, and the stack;
  - the deploy-setup pull request turns Caddy's figures on.
- **`--on app`** puts the stack on the app's server (from 4 GB).
- **In a repository that already has a monitoring server,** another app or environment sends to it:
  the monitoring server joins that environment's network with one more WireGuard interface.

**Collecting** (US1)
- One Alloy per server, extending 017's add-on. It sends:
  - the server's figures and each container's (cAdvisor, built into Alloy);
  - the app's logs on that server, masked as 017 masks them;
  - Caddy's figures, on the edge's server;
  - Postgres's figures, on its server, through a `pg_monitor` login.

**The stack** (US2, US3, US6)
- A Compose project `opscrew-monitoring`: Prometheus (remote-write receiver), Loki (one process,
  files on disk), Grafana, and a Caddy front.
- The front, on each private address, passes only the two push paths, and the filter admits only
  the network's servers to it.
- Grafana is published on each private address for devices (and on `127.0.0.1` for the tunnel),
  provisioned with two data sources and six dashboards OpsCrew renders.
- Retention by time (and by size for figures), estimated at design.

**Status, open, off** (US3, US6, US7)
- `addon status` and `status` read each server's last data through fixed commands.
- `addon open monitoring` gives the private address, or opens a tunnel.
- `addon disable monitoring` and `destroy` remove everything, the server with its typed name. They
  refuse while other environments still send to it.

## Technical Context

- **Stack:** the same as 000–019. **No new npm dependency.**
- **New images, pinned by digest in `pins.ts`:**
  - `prom/prometheus` (3.15.1), `grafana/loki` (3.7.9) and `grafana/grafana` (13.3.0);
  - Alloy moves to 1.21.3.
  - The front is the Caddy image already pinned.
  - cAdvisor stays inside Alloy (research R7, S1): no separate container.
- **No new provider API:** the monitoring server is more of 018's extra-server modules, and its
  prices come from the catalogues design already reads.
- **The spike (T2001, lead, local Docker),** results in research.md R7, before wave 1:
  - **S1:** Alloy's `prometheus.exporter.cadvisor` through 017's read-only proxy and without
    `privileged`: which mounts, which Docker API paths (the proxy's allow-list), what is lost. If
    it can't work without privileged mode, a separate pinned cAdvisor container with read-only
    mounts instead, and the plan changes before wave 1.
  - **S2:** the stack's memory, idle and with three Alloys sending for an hour, giving the defaults
    for each limit, `GOMEMLIMIT`, and the smallest server.
  - **S3:** Grafana 13.3:
    - provisioning from files, with `allowUiUpdates: false`;
    - the admin password from `GF_SECURITY_ADMIN_PASSWORD__FILE`, and the file's owner and mode
      for user 472;
    - the dashboard JSON `schemaVersion`;
    - no outbound call with every phone-home setting off (watched with the container on a network
      with no route out).
  - **S4:** Loki 3.7's smallest config with files on disk and compactor retention, with
    `delete_request_store: filesystem`: it starts, takes a push, answers a query, and deletes a
    stream past its retention.
  - **S5:** Caddy 2.11's `metrics { per_host }` with a `metrics` handler on a listener only Alloy
    reaches, and the series it gives behind kamal-proxy.
  - **S6:** amd64 and arm64 in each new image's index (`update-pins.mjs`).
  - **S7:** one Alloy with two `loki.write` and two `prometheus.remote_write` (Grafana Cloud and
    the stack), sampling only on Grafana Cloud's branch. Also how long the WAL keeps figures, and
    what `loki.write` keeps, while the stack is down.
- **Tests:**
  - unit tests with fakes: the renderers' snapshots, the host steps rendered and parsed, design's
    estimates and refusals, and the filter rules;
  - the Docker pass (T2016, `OPSCREW_DOCKER_TESTS=1`): the real stack and a real Alloy;
  - gated live tests (T2017) on Hetzner.

## Constitution Check

- **I (safety gate):**
  - **The monitoring server:** the IaC plan, `iac-apply`.
  - **Every server's changes:** host plans, `host-apply`, one per server, each by its hash: the
    network, the filter, Alloy, the Postgres login, the stack. Secrets go on standard input, never
    in a plan.
  - **Caddy's figures and the masking file on every server:** the deploy-setup pull request.
  - **Deleting:** the monitoring server only with `allowDestroy` and its typed name (018's path in
    provision and destroy). The stack's data on the app's server only with the same confirmation.
  - **No new approval kind.**
- **II (user owns everything):**
  - The stack's Compose file, Prometheus's, Loki's and Grafana's configs, the dashboards and
    Alloy's config are plain files under `opscrew/addons/` on the servers.
  - Without OpsCrew the stack keeps running: `docker compose` in that folder.
- **III (dual engine):** no new module. The monitoring server is 018's extra-server module, already
  validated under both engines. Its HCL snapshot is added.
- **IV (secrets):**
  - **Grafana's admin password and the Postgres monitoring password:** generated, kept with the
    generated values (0600, recovery copy). They reach their server only on standard input, into
    files only their reader can open: Grafana's `root:root 0640` (Grafana's group 0), Alloy's
    data source the deploy user's `0600`.
  - **Logs:** masked before they leave each server.
  - **The monitoring server's public address:** in this computer's state only, as every server's.
- **V (deterministic first):** sizing, prices, the disk estimate, every renderer, the dashboards and
  the filter rules are deterministic code. No model.
- **VI (contracts first):** one serial task (T2002): `observability.monitoring`, the outside
  network member, their rules and helpers. No change in `@opscrew/contracts`. ADR 0024 records the
  design.
- **VIII (typed adapters):** server changes through the host adapter (the new `monitoring` step,
  `alloy` on any server, `grant`'s `monitor` access). Cloud resources through the IaC engine.
  GitHub through its connector.
- **IX (plain language):** the price, the memory per server, the retention and disk, the licences,
  who can see the dashboards, and what each refusal needs.
- **X (simplicity):**
  - push through the agent 017 already ships, not a target list and three exporters;
  - 018's extra server and network, not a monitoring network of its own;
  - no alerting in the stack;
  - one database dashboard;
  - three new images, opt-in.

## Project Structure

```text
packages/plan-schema/src/         observability.monitoring, the outside member, rules, helpers (T2002)
packages/iac-templates/src/
  pins.ts                         prometheus, loki, grafana; alloy 1.21.3 (T2003)
  monitoring/                     the stack: compose, prometheus, loki, grafana provisioning, front (T2004)
  monitoring/dashboards/          the six dashboards and their queries (T2005)
  addons/alloy.ts                 sources per server, two destinations, cAdvisor, Caddy, Postgres (T2006)
  edge/, workflow/                Caddy's figures; the masking file on every server (T2007)
  runbook/observability.ts        the runbook's monitoring section (T2015)
packages/connectors/ssh-host/src/ the `monitoring` step, `alloy` on any server, `grant` monitor (T2008)
packages/agents/src/
  monitoring/                     settings, enable, disable, estimate, sizing, repo lookup (T2009)
  network/                        the monitoring member, the outside member, the filter (T2010)
  provision/monitoring.ts         host plans per server, secrets, the shared server (T2011)
  monitoring/status.ts, addons/status.ts   status, open (T2012)
  verify/, secure/, drift/        the stack and the agents (T2012)
  destroy/, retarget/             removal, refusals (T2013)
packages/cli/src/commands/        addon enable/disable/open/status monitoring; status (T2014)
packages/mcp-server/src/tools/    addons: monitoring (T2014)
plugin/skills/opscrew-troubleshoot   the dashboards (T2014)
docs/guide/monitoring.md          and links from the related pages (T2015)
docs/adr/0024-self-hosted-monitoring.md   (lead, T2001)
```

## Design

### 1. Plan (T2002, serial, lead-reviewed)
data-model.md "The plan" and contracts/monitoring.md "plan-schema":
- `MonitoringSchema` as `observability.monitoring`:
  - `enabled`;
  - `where`, a union:
    - `{ kind: "server", server }`, a `servers` entry;
    - `{ kind: "app" }`;
    - `{ kind: "shared", owner: { plan, server } }`: the owner's plan file and its server's name;
  - `versions` (`prometheus`, `loki`, `grafana`, `alloy`);
  - `retention` (`metricsDays` 1–90, default 15; `logsDays` 1–30, default 7; `metricsMaxGb`, set by
    design);
  - `memoryMb` (`prometheus`, `loki`, `grafana`, `front`, `alloy`, `proxy`), with defaults in
    `ADDON_MEMORY_DEFAULTS.monitoring` from S2.
- **Rules,** with plain messages:
  - only where `onServer(plan)`;
  - `kind: "server"` names a `servers` entry that no `services[].server` names, and that is a
    member of `network`;
  - `kind: "shared"` needs a `network` member named `owner.server` that is neither the app nor a
    `servers` entry (the outside member);
  - an outside member is allowed only then;
  - with Grafana Cloud on, `versions.alloy` equals `grafanaCloud.version`.
- **Helpers:**
  - `monitoringOf(plan)`;
  - `monitoringServerName(plan)` (`"app"`, a server's name, or the owner's);
  - `isOutsideMember(plan, member)`;
  - `MONITORING_PUSH_PORT` and `MONITORING_GRAFANA_PORT`.
- The JSON schema is regenerated.
- **A plan without `observability.monitoring` must parse and render byte-identical to today.**
- **Stubs:** T2002 also adds the empty modules the waves fill, with their exports, so parallel
  tasks never edit the same `index.ts`:
  - `iac-templates/src/monitoring/index.ts`;
  - `agents/src/monitoring/index.ts`;
  - `agents/src/provision/monitoring.ts`.

### 2. The spike and the ADR (T2001, lead)
S1–S7 above, on local Docker; one line per question in research.md R7. A result that changes the
design goes into this plan before wave 1. ADR 0024 records D1–D6 of research R6 as decided.

### 3. Pins (T2003)
- `IMAGES.prometheus`, `IMAGES.loki` and `IMAGES.grafana` by digest of their multi-arch index.
- `IMAGES.alloy` moves to 1.21.3.
- `update-pins.mjs` learns the three; the pin snapshot tests are updated.

### 4. The stack (T2004)
`renderMonitoringStack(input)`.
- **Input:**
  - the owner's settings;
  - the receiving addresses: one per network the server is a member of, with the members
    (servers) and devices of each;
  - whether devices exist.
- **Output:** the files under `opscrew/addons/monitoring/` (research R7 "The stack"; the spike's
  working files are the model):
  - **`compose.yaml`** (project `opscrew-monitoring`), every service `hardened()` with
    `cap_drop: ALL`, `read_only`, the image's own user, its limit (`mem_limit` and
    `memswap_limit`), `GOMEMLIMIT` at 80% of it, and its data on a named volume:
    - **Two networks:** `stack`, `internal: true` (no route out), for all four; and a second one
      for the two services that publish a port, `front` and `grafana`. Prometheus and Loki are
      only on `stack`.
    - **`prometheus`:**
      - `--web.enable-remote-write-receiver`;
      - `--storage.tsdb.retention.time=<metricsDays>d` and `--storage.tsdb.retention.size=<metricsMaxGb>GB`;
      - a healthcheck on `/-/ready`; no published port.
    - **`loki`:** `-config.file`, a tmpfs `/tmp` (without it retention silently deletes nothing),
      no published port, no healthcheck (its image has no shell or `wget`).
    - **`grafana`:**
      - published on `127.0.0.1:<grafana port>`, and on each private address when devices exist;
      - the `GF_*` settings of research R7 (S3), the two `GRAFANA_COM` URLs and
        `GF_PLUGINS_DISABLE_PLUGINS` included;
      - the admin password as `GF_SECURITY_ADMIN_PASSWORD=$$__file{<path>}`, never `__FILE`
        (which starts with the password `admin` when the file can't be read);
      - a tmpfs `/tmp`, and a healthcheck on `/api/health`.
    - **`front`** (Caddy):
      - published on each private address at `MONITORING_PUSH_PORT`;
      - `POST /api/v1/write` goes to `prometheus:9090`, `POST /loki/api/v1/push` to `loki:3100`,
        each rewritten to the exact path;
      - everything else answers 403;
      - `admin off`, and `request_body { max_size 8MiB }`;
      - user 65534 with `cap_add: NET_BIND_SERVICE` and tmpfs `/data` and `/config` owned by it,
        as 017's proxy;
      - a healthcheck that checks both upstreams' readiness, so `up --wait` means the stack is up.
  - **`prometheus.yml`:** no scrape jobs and no external labels (Alloy sets `app`, `env`,
    `server`); `storage.tsdb.out_of_order_time_window: 4h`, so figures an agent kept through an
    outage are accepted late.
  - **`loki.yaml`** (S4):
    - `auth_enabled: false`, schema v13, tsdb, a 24-hour index;
    - compactor retention with `retention_period: <logsDays × 24>h`, and
      `reject_old_samples_max_age` the same;
    - `discover_service_name: []` (no extra `service_name` label), `analytics.reporting_enabled:
      false`;
    - ingestion limits sized to the small server.
  - **`grafana/provisioning/datasources/opscrew.yaml`:** Prometheus `opscrew-prometheus` and Loki
    `opscrew-loki`, `editable: false`, `prune: true`.
  - **`grafana/provisioning/dashboards/opscrew.yaml`** (`allowUiUpdates: false`, folder "OpsCrew"),
    and `grafana/dashboards/*.json` from T2005.
- **The header comment** of each file says which plan generated it and how to regenerate it.
- With `kind: "app"` and no network, there are no private addresses: Grafana only on `127.0.0.1`,
  and the front unpublished.
- **The front always runs.** It is also on a network named `MONITORING_PUSH_NETWORK`
  (`opscrew-monitoring-push`, set with `name:`), which the Alloy on the stack's own server joins to
  push to `front` by name. That covers `kind: "app"` with no network too.
- **Grafana's password file** is `grafana_admin_credential` in `MONITORING_DIR` (not `…password`:
  the redactor would take the mount line for a labelled secret, as 017's Grafana Cloud file), mounted
  at `/run/opscrew/grafana_admin_credential`.

### 5. The dashboards (T2005)
- **One module per dashboard, rendering classic Grafana JSON at `schemaVersion` 42** (S3), with
  the series research R7 names:
  - **servers:** CPU, load, memory, disk use and free space, network in and out (cAdvisor's root
    cgroup, `container_network_*_bytes_total` by `interface`);
  - **containers:** CPU, working set against its limit (`container_spec_memory_limit_bytes`),
    restarts (`changes` of the highest `container_start_time_seconds` per `service`, R7 S1);
  - **http:** requests, 4xx and 5xx shares, p50 and p95 per `host`, from
    `caddy_http_request_duration_seconds` (R7 S5);
  - **caddy:** in flight, process memory and CPU, errors;
  - **postgres:** connections against `max_connections`, transactions, cache hit ratio, size,
    deadlocks, the oldest running query (R7 "Postgres");
  - **logs:** a logs panel and a volume panel, filtered by `app`, `env`, `service` and a text box.
- **Variables:** `app`, `env` and `server`, from label values, multi-select with "All" and
  `allValue: ".+"` (Loki refuses a selector whose only matcher is `=~".*"`).
- **Stable uids** (`opscrew-servers`, …).
- **The labels contract,** in contracts/monitoring.md, is what T2006's Alloy sends: every series
  has `app`, `env` and `server`; containers also `service`; Caddy also `host`.
- **`DASHBOARD_QUERIES`:** every panel's query, with its dashboard and panel title, for the Docker
  pass (SC-2003).
- **Unit tests:**
  - the JSON parses;
  - uids are unique;
  - every panel uses one of the two data source uids;
  - every label a query uses is in the contract, or is one of the series' own (`container`,
    `container_id`, `caddy_server`, `code`, `method`, `handler`, `datname`, `state`, `interface`,
    `cpu`, `mode`, `mountpoint`, `device`, `fstype`, `le`).
- **http and caddy with another edge:** with nginx or the user's own proxy, these two dashboards
  hold a text panel saying they need Caddy.

### 6. Alloy (T2006)
`renderAlloyConfig(plan, server, destinations)`, where `server` is `"app"` or an extra server's
name, and `destinations` is `{ grafanaCloud?, monitoring? }`.
Research R7 "The collector" is the source; the spike's working `config.alloy` is the model.
- **Sources, on every server:**
  - **logs:** the app's Compose project's containers on that server, through the proxy, labelled
    `app`, `env`, `server`, `service`;
  - **with monitoring:**
    - `prometheus.exporter.unix` with the collectors for the servers dashboard (CPU, load,
      memory, filesystems), and a keep-list;
    - **containers:** `prometheus.exporter.cadvisor` on the cgroups only (S1: `docker_host` at a
      socket that doesn't exist, `docker_only`, the cgroup allow-list, `enabled_metrics`), named
      through `discovery.docker` over the proxy: one scrape target per container, keeping only
      its own series (`keepequal` on the id from the cgroup path), labelled `service`,
      `container` and `container_id`. `discovery.docker` is limited to the app's Compose project
      and OpsCrew's own projects (the edge, the add-ons);
    - **the server's network:** cAdvisor's root cgroup (`id="/"`), without `lo`, `veth*`, `br-*`,
      `docker*` and `wg*`;
  - **with Grafana Cloud only:** today's four figures, unchanged.
- **On the edge's server, with monitoring:** a scrape of Caddy's metrics listener (T2007) on the
  edge's network. Caddy's `server` label becomes `caddy_server` before OpsCrew's `server` is set,
  and the metrics handler's own requests (`handler="metrics"`) are dropped.
- **On Postgres's server, with monitoring:** `prometheus.exporter.postgres` with the `database`
  and `stat_database` collectors and a keep-list, its whole data source read from a file
  (`local.file`, `is_secret = true`), logging in as `opscrew_monitor`.
- **Every scrape** sets `scrape_interval = "15s"` (Alloy's default is 60 s).
- **Masking:** unchanged, on every server; with monitoring the known-values file is read through
  `/rootfs` (the mount below). With monitoring on, the sampling moves out of
  `loki.process "mask"` into a process of its own on Grafana Cloud's branch (S7); without
  monitoring the file is today's.
- **The pipeline,** after masking:
  - fan out to the stack's `loki.write`;
  - and through sampling to Grafana Cloud's.
  - Figures go to both `prometheus.remote_write`s, Grafana Cloud's through today's allow-list.
- **The stack's writers:** `http://<the monitoring server's private address on this network>:<push
  port>/…`, or `http://front:<push port>/…` over `MONITORING_PUSH_NETWORK` on the stack's own server
  (`monitoringServerName(plan) === server`), with no auth (the filter and the front stand guard). The remote write has
  `queue_config { max_shards = 1 }`, and `loki.write` has `max_backoff_period = "30s"` and
  `max_backoff_retries = 40`: with them a 10-minute outage lost nothing (S7).
- **Every series** gets `app`, `env` and `server`.
- **Alloy's HTTP server** listens on `127.0.0.1:12345` only, and cAdvisor's targets are scraped
  there.
- **`renderAlloyCompose`:**
  - with monitoring, the mounts `/:/rootfs:ro` and `/sys:/sys:ro` (S1) instead of 017's
    `/host/root` and `/host/sys`; no `privileged`, no `/var/lib/docker`;
  - joins the edge's network on the edge's server (Caddy at `caddy:<CADDY_METRICS_PORT>`), the
    app's network on Postgres's server, and `MONITORING_PUSH_NETWORK` on the stack's own server,
    only with monitoring;
  - the Postgres data source file is `postgres_monitor_credential` beside the Compose file, mounted
    at `/etc/alloy/postgres_monitor_credential` (the name follows 017's `grafana_cloud_credential`);
  - the memory limits from `monitoring.memoryMb.alloy` and `.proxy` when monitoring is on.
- **The proxy's allow-list is unchanged:** cAdvisor and `discovery.docker` call only paths it
  already passes.
- **Byte-identical without monitoring:** a Grafana Cloud-only plan renders the same files as today
  (snapshots).

### 7. Caddy's figures and the masking file (T2007)
- **Caddy, always (lead decision at T2007's merge):**
  - the global `metrics { per_host }`;
  - a site `http://:<metrics port>` with only `metrics`, on the edge's internal network, never
    published;
  - `observe_catchall_hosts` stays off;
  - `EDGE_VERSION` raised.

  The edge is shared by every OpsCrew app on a server, and a deploy puts its own copy in place
  when the versions are equal and the content differs. With the figures only for monitored plans,
  a monitored app and another one on the same server would swap the edge on every deploy. Always
  on, every app renders the same edge, and the raised version keeps an older app's deploy from
  taking the figures away. Without monitoring nothing scrapes them.
- **The masking file:** written on every server of a monitored environment, by the deploy job for
  the app's server and by the extra servers' upload step, from the env values that server receives.
  Today it is written only for Grafana Cloud, and only on the app's server.
- Without monitoring, the workflow stays byte-identical (snapshots); the edge changes for every
  plan, as above.

### 8. The host adapter (T2008)
- **`ADDON_KINDS` gains `monitoring`.**
- **The `monitoring` step:**
  - **Params:** the rendered files (by hash) and `removeData`.
  - **Apply:**
    - write the files under `opscrew/addons/monitoring`;
    - write Grafana's password from standard input into a file `root:root 0640` (Grafana reads it
      through its group 0; S3);
    - `docker compose up -d --wait --remove-orphans`.
  - **Check:** the files' hashes and the containers running.
  - **Removal:** `docker compose down`, then the folder; the volumes only with `removeData`.
  - **The host record** says which app and environment own it.
- **The `alloy` step on any server:**
  - params gain `server` and the destinations;
  - secrets gain `monitoringPostgresPassword` (on stdin); the step writes the whole data source
    (`postgresql://opscrew_monitor:<password>@<host>:5432/postgres?sslmode=disable`) into a file
    only the deploy user can read (`0600`), since Alloy runs as that user;
  - the Grafana Cloud token stays as it is.
- **The `grant` step gains `access: "monitor"`, Postgres only:** it creates or updates
  `opscrew_monitor` with `LOGIN`, `CONNECTION LIMIT 3`, the password, and `GRANT pg_monitor`. Its
  check asks the engine for the login and the role.
- **Inspection facts:** the monitoring stack's containers and its files' hashes, and each server's
  Alloy destinations, for drift and status.
- **`ApplyOptions.secrets`** gains `grafanaAdminPassword` and `monitoringPostgresPassword`.

### 9. Agents: turning it on and off (T2009)
`agents/src/monitoring/`:
- **`monitoringEnable(deps, plan, { on, newServer })`:**
  - **Refusals, before any change:**
    - not `onServer`;
    - a second app on one of the user's own servers;
    - `--on app` below 4 GB or not fitting;
    - a server with no room for Alloy.
  - **The repository's monitoring server:** the repository's plans (013's app list) are read for
    one with `where.kind: "server"`. If one exists and `--new-server` isn't given, `where` becomes
    `shared` with that owner.
  - **Otherwise a server entry `monitoring`**, at the app's provider and location: the smallest type
    whose memory holds the stack's limits, Alloy and the system's share, through 018's sizing and
    price code.
  - **The network:** created when absent (018's `allocateNetwork`), with the server as a member.
    For `shared`, the outside member (T2010).
  - **The estimate,** `estimate.ts`:
    - series per server (research R7): 5 per vCPU + 7 for the server, 5 per container + 2 for the
      network, about 80 per hostname on the edge's server, and 40 on Postgres's;
    - figures over the retention, at 15-second intervals and the bytes per sample S2 measured;
    - the log volume over the retention, read as 017's `grafanaEstimate` reads it;
    - summed over every sending environment for a shared server;
    - `metricsMaxGb` is 80% of the disk left after logs;
    - a refusal above 80% (FR-2020).
  - **The summary text** (FR-2001), then the plan is written.
- **`monitoringDisable(deps, plan)`:**
  - refuses while other plans in the repository name this one as their owner (FR-2024), naming
    them;
  - otherwise removes the settings, and the server entry, which provision then deletes with its
    typed name.
- **Design keeps the settings and the server entry** across a re-design, and never places a
  service on the monitoring server.
- **`shared/memory.ts`** counts Alloy on every monitored server and the stack on its server.

### 10. Agents: the network (T2010)
- **The filter's rules (`networkFilterRules`):**
  - On every server, the monitoring server's address is never a source for a published port.
  - On the stack's server:
    - the push port admits every member that is a server, except itself;
    - Grafana's port admits the devices.
- **The outside member (shared):**
  - allocated in the sender's network: an address, and a port taken from the monitoring server's
    facts (the ports its other interfaces use);
  - a key made on this computer, its private half in the sender's generated values, as 018's
    members' keys are;
  - its endpoint from the owner's server record;
  - `networkSteps(plan, owner.server, facts)` gives the `network` and `network-filter` params for
    the monitoring server's interface for this network (`otherInterfaces` for the drop-in, as on an
    own server with several apps);
  - `readNetwork` includes it.
- **A member removed** (a sender destroyed or turned off) gives the removal params for that
  interface.

### 11. Agents: provision (T2011)
`provision/monitoring.ts`, called from `provision/run.ts` after the network's host plans:
1. **On Postgres's server, when the plan has Postgres:** the `grant` host plan for
   `opscrew_monitor`. The password is generated once and kept.
2. **The stack's server:**
   - the `monitoring` host plan, its input built from every plan in the repository that sends to
     it (owner and senders);
   - Grafana's password, generated once and kept;
   - for `shared`, first the monitoring server's `network` and `network-filter` host plans for this
     network (T2010's params), over its owner's SSH login.
3. **Every server of the environment:** the `alloy` host plan with its destinations.
4. **The deploy-setup pull request** carries T2007's file changes, through the existing render.

- Each host plan is shown and approved by its hash. The secrets are passed on apply only.
- **Turning off:**
  - removal host plans in reverse order: Alloy reverts to Grafana Cloud only when that is on;
  - the stack is removed, with its data, after the typed confirmation;
  - the server entry left the plan, so the existing path deletes the server with its typed name.
- Provision's summary names Grafana's address and `opscrew addon open monitoring`.

### 12. Agents: status, open, verify, secure, drift (T2012)
- **`monitoringStatus(deps, plan)`**, on the stack's server, through fixed commands audited as
  `remote-exec`:
  - the containers and their memory, as `ADDON_CONTAINERS_COMMAND`;
  - each server's last figures (`max by (app, env, server) (timestamp(node_load1))` through
    Prometheus's API inside the `prometheus` container);
  - its last log line (Loki's series API over the last hour, inside `loki`);
  - the volumes' sizes (`du -sb`);
  - the answers parsed with zod;
  - a server silent for more than 5 minutes flagged with what to check.
- **`addon status` and `status`** show it; `status` adds one line per monitored environment.
- **`addonOpen` for monitoring:**
  - the private address when `thisDevice` is set;
  - otherwise the SSH tunnel to `127.0.0.1:<grafana port>`;
  - with public SSH closed and no device, the refusal of US3 #5.
- **`verify`:** the stack's containers healthy, and every server's data recent.
- **`secure`:**
  - the monitoring server's public ports: SSH and the UDP port only;
  - the front and Grafana published only on private addresses, with the filter's rules in place.
- **`drift`:** the `monitoring` and `alloy` steps per server against the rendered files.

### 13. Agents: destroy and retarget (T2013)
- **`destroy` of an environment:**
  - the owner: refused while others send (FR-2024); otherwise the stack, Alloy everywhere, and the
    server with its typed name;
  - a sender: its Alloy removed, then on the monitoring server the interface's removal, the filter,
    and the stack re-rendered without its address.
- **`retarget`:** refuses with monitoring on, saying to run `opscrew addon disable monitoring` and
  `opscrew provision` first (FR-2026). 018's refusal of extra servers stays.

### 14. Surfaces (T2014), the guide (T2015)
- **CLI:**
  - `addon enable monitoring [--on app|server] [--new-server]`;
  - `addon disable monitoring`;
  - `addon open monitoring`;
  - `addon status`'s section, and `status`'s line.
- **MCP:** `opscrew_addon_enable`, `_disable` and `_status` accept `monitoring`, with the CLI's
  approvals. Status is read-only.
- **The plugin's `opscrew-troubleshoot` skill:** opening the dashboards, and what each one shows.
- **The guide:**
  - `docs/guide/monitoring.md`;
  - the index;
  - links from `logs-and-status.md`, `beszel.md`, `grafana-cloud.md` and `private-network.md`;
  - the runbook's monitoring section (`runbook/observability.ts`).

### 15. The Docker pass (T2016) and the live tests (T2017)
- **The Docker pass,** the rendered files on local Docker:
  - the stack, with the front published on a test network;
  - an example Compose project with Postgres and Caddy;
  - one Alloy rendered for the app's server, sending through the front.
- **Asserted:**
  - every `DASHBOARD_QUERIES` entry returns at least one series or line within 2 minutes (SC-2003);
  - a known value and a token-shaped value logged by the app are stored masked (SC-2004);
  - every container stays under its limit (SC-2005);
  - the front refuses every other path and method (403);
  - Grafana has its two data sources and six dashboards, the admin login from the file works,
    sign-up is off;
  - the WAL keeps figures through a 2-minute stop of the stack.
- **Live** (gated on `OPSCREW_E2E_MONITORING=1` and the Hetzner token):
  - the example with Postgres on Hetzner; `addon enable monitoring`, then `provision`;
  - every server's data within 2 minutes;
  - a scan of the monitoring server's public address;
  - a device (018's namespace harness) reaching Grafana, while an app server can't;
  - a second environment sharing the server;
  - `addon disable monitoring`, then `provision` deleting the server;
  - destroy, with nothing left.

## Order

T2001 (lead) → {T2002, T2003} → wave 1 {T2004, T2005, T2006, T2007, T2008} → wave 2 {T2009,
T2010} → wave 3 {T2011, T2012} → wave 4 {T2013, T2014, T2015} → wave 5 {T2016, T2017} → T2018
(live runs, lead) → T2019 (simplify, lead) → T2020 (release, lead).

## Complexity Tracking

| Item | Why it's needed | Simpler alternative rejected because |
|---|---|---|
| The monitoring server as a member of several networks | One server watching every environment of the repository is the roadmap's promise (US5). | A monitoring network of its own would give every server a second interface and every device a second configuration. A server per environment would double the price. |
| A front on the stack | Prometheus's and Loki's receiving paths share a port with their query APIs. | The filter alone would let any app server read every environment's logs. |
| OpsCrew's own dashboards | The community dashboards' licence couldn't be confirmed (research R4). | The projects' mixins need Jsonnet and recording rules. |
