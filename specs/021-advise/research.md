# Research: advise (021)

Research from 2026-11-04. Three parts:
- A Sonnet agent read only official sources: Hetzner, DigitalOcean, Google Cloud and AWS
  documentation, GitHub docs, Cloudflare's API reference, Ubuntu, Grafana Cloud, Beszel and
  Prometheus (about 25 pages).
- A Haiku agent mapped what OpsCrew already has, with file and line.
- Two live calls with the test tokens settled two facts the documentation left open (R1.4, R1.5).

"Unconfirmed" marks a fact no fetched official page stated; the spike (T2101) settles the ones the
design needs. R1–R2 are findings; R3 holds the lead's decisions, which the spec builds on.

## R1. Outside facts

### R1.1 Resizing a server

- **Hetzner Cloud:** the server action `change_type` takes `server_type` and `upgrade_disk`.
  - `upgrade_disk: false` keeps the disk, which "allows downgrading the server type later"
    (hcloud-python's client; the CLI's flag is `--keep-disk`). A server can't move to a type with a
    smaller disk than it has. Only the same architecture (x86 or Arm). The partition must be grown
    by hand after a disk upgrade.
  - Unconfirmed: whether the server must be off, how long it takes, whether the IP stays (the API
    reference page renders by script and couldn't be read). The spike measures them.
  - Sources: https://docs.hetzner.com/cloud/servers/faq/,
    https://raw.githubusercontent.com/hetznercloud/hcloud-python/main/hcloud/servers/client.py,
    https://raw.githubusercontent.com/hetznercloud/cli/main/docs/reference/manual/hcloud_server_change-type.md
- **DigitalOcean:** the Droplet action `resize` with `size` and `disk`.
  - CPU and memory only is reversible; `disk: true` is permanent, and the disk never shrinks.
  - Downtime: plan about a minute per GB of disk used (often less); some downtime even without a
    disk change. The API powers the Droplet off itself.
  - Sources: https://docs.digitalocean.com/products/droplets/how-to/resize/,
    https://docs.digitalocean.com/reference/api/reference/droplet-actions/
- **OpsCrew today:** a change of `serverType` is already an in-place update in the IaC plan
  (`server_type = var.server_type`, not in `ignore_changes`), and design warns that the app is
  offline while the server restarts (R2.4). The Hetzner module's disk behaviour on a type change is
  for the spike to confirm (the provider's `keep_disk`).

### R1.2 Right-sizing as the clouds define it

- **Google Cloud:** machine-type recommendations look back 8 days, at average CPU over 60-second
  intervals, memory included (better with the Ops Agent). No numeric thresholds are published.
  Source: https://docs.cloud.google.com/compute/docs/instances/apply-machine-type-recommendations-for-instances
- **AWS Compute Optimizer:** looks back 14 days by default (paid enhanced metrics, 3 months), using
  the maximum point in each 5-minute interval; "over-provisioned" means at least one spec can go
  down and none is under-provisioned. Memory only with the CloudWatch agent. No numeric thresholds
  are published. Sources:
  https://docs.aws.amazon.com/compute-optimizer/latest/ug/ec2-metrics-analyzed.html,
  https://docs.aws.amazon.com/compute-optimizer/latest/ug/view-ec2-recommendations.html
- So OpsCrew defines and documents its own lookback, statistic and thresholds (R3).

### R1.3 A disk that is filling

- Prometheus's `predict_linear(v, t)` works on gauges, needs at least two samples, and gives NaN
  when the range holds an infinite value. The docs give no range or "days until full" recipe: that
  is ours. Source: https://prometheus.io/docs/prometheus/latest/querying/functions/

### R1.4 GitHub

- **Dependabot alerts:** `GET /repos/{owner}/{repo}/dependabot/alerts?state=open`. A classic token
  needs `security_events` (`public_repo` is enough for a public repository); a fine-grained token
  needs the repository permission "Dependabot alerts: read". Sources:
  https://docs.github.com/en/rest/dependabot/alerts,
  https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- **Dependabot's pull requests:** authored by `dependabot[bot]`, labelled `dependencies` by default;
  the open pull requests list filtered by author works without the search API. Source:
  https://docs.github.com/en/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates
- **A token's expiry:** the response header `GitHub-Authentication-Token-Expiration`, announced
  for personal access tokens in 2021
  (https://github.blog/changelog/2021-07-26-expiration-options-for-personal-access-tokens/).
  **Checked live on 2026-11-04:** a fine-grained token's `GET /user` answered with it, as
  `2026-11-27 17:25:14 UTC`. A token without an expiry sends none.

### R1.5 Cloudflare, Hetzner and DigitalOcean tokens

- **Cloudflare:** `GET /user/tokens/verify` (and `/accounts/{account_id}/tokens/verify`) answer
  `id`, `status` (`active`, `disabled`, `expired`) and, when set, `expires_on` and `not_before`.
  **Checked live:** the test token (no expiry) answered only `id` and `status`. Sources:
  https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/,
  https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
- **Hetzner Cloud and DigitalOcean:** no official page shows a way to read an API token's expiry.
  Treated as not readable.

### R1.6 Ubuntu updates

- **Reboot needed:** `/var/run/reboot-required` (and `.pkgs`), written through
  `/usr/share/update-notifier/notify-reboot-required` from `update-notifier-common`, which is
  seeded on every Ubuntu flavour; Canonical also documents `pro system reboot-required`. A 2025
  report says the file was missing after a kernel update on 24.04, so it is best effort. Sources:
  https://wiki.ubuntu.com/UpdateNotifier,
  https://ubuntu.com/server/docs/how-to/software/automatic-updates/,
  https://discourse.ubuntu.com/t/file-var-run-reboot-required-not-present-after-kernel-update/54134
- **Pending updates:** `apt-check` and `apt list --upgradable` are unconfirmed on an official page;
  `opscrew secure` already counts pending security updates with `apt list --upgradable` (R2.5).

### R1.7 Reading history from the add-ons

- **Grafana Cloud:** reading needs an access policy token with `metrics:read` (Prometheus/Mimir
  query endpoint, basic auth with the metrics instance ID) and `logs:read` (Loki's
  `/loki/api/v1/query_range`, the Loki instance ID). The token Alloy holds has only `*:write`, so
  reading needs a second token. Sources:
  https://grafana.com/docs/grafana-cloud/send-data/metrics/metrics-prometheus/query-http-api/,
  https://grafana.com/docs/grafana-cloud/send-data/logs/authenticate-to-query-logs/,
  https://grafana.com/docs/mimir/latest/references/http-api/
- **Beszel:** its REST page documents only the `systems` and `users` collections and warns the
  data structure "may change in minor releases"; a stats collection is unconfirmed officially.
  Source: https://beszel.dev/guide/rest-api
- **Prometheus:** `query_range` takes `query`, `start`, `end`, `step`, `timeout`, `limit`. A 14-day
  p95 per series is one instant query of `quantile_over_time(0.95, m[14d])`. Source:
  https://prometheus.io/docs/prometheus/latest/querying/api/

## R2. What OpsCrew has to build on (code map, 2026-11-04)

### R2.1 Figures

- **`opscrew status`** reads one moment and stores nothing: `readServerResources`
  (`packages/agents/src/status/resources.ts`) runs one fixed command (`nproc`, `/proc/loadavg`,
  `free -b`, `df -P -B1 /`, `docker stats --no-stream`, `docker inspect` for name, restart count,
  start time and memory limit), parsed with zod into `ResourceReading` (server: CPUs, load, memory,
  disk; containers: CPU, memory against limit, restarts). Portainer and this computer give totals
  only; Cloudflare's hosting gives the last 24 hours of Worker analytics.
- **Its flags** (`resourceFlags`): disk at 85% warn and 95% high, a container at 90% of its memory
  limit, any restart. No CPU or load flag.
- **History:** none is read today. Beszel's and Grafana Cloud's data are never queried. The
  self-hosted stack (020) is queried only for each server's last sample and the last hour of log
  counts (`monitoring/status.ts`, fixed commands inside the stack's containers), with figures kept
  15 days by default.

### R2.2 The interview

`RequirementsSchema` (`packages/plan-schema/src/requirements.ts`): `expectedMonthlyUsers` (a band:
`<1k`, `1k-10k`, `10k-100k`, `>100k`; the only traffic input), `budgetMonthly` (amount, EUR or
USD), `uptime` (`best-effort`, `standard`, `high`), `dataCriticality` (`none`, `important`,
`critical`), plus provider, region and storage choices.

### R2.3 Prices and sizing

- Live catalogues: `HetznerCatalog` (EUR, net) and `DigitalOceanCatalog` (USD), each with a dated
  static fallback; `resolveCatalog` and `extraCatalogs` in `design/run.ts`.
- `sizeFor` (`design/sizing.ts`): the need from the users band, the services and the edge;
  `buildDesignOptionSet` (`design/options.ts`): lean, comfortable and dedicated tiers per region;
  `costFor`/`pricedOffer` (`design/cost.ts`): server, IPv4 and backups; the plan's `cost` and
  `totalCost` for several servers.

### R2.4 How each change is applied today

| Change | Today's flow |
|---|---|
| Another server type (up or down) | `opscrew design` (or editing `target.serverType`), then `opscrew provision`: an in-place update in the IaC plan; design warns about the restart |
| More disk | only a larger type (no block volumes); the disk never shrinks |
| A cache | design adds Redis/Valkey when the app uses it; then provision |
| Object storage | `requirements.objectStorage` and design's storage offer; then provision |
| A database on its own server | `services[].server` (018's move, `designMove`), applied by provision, `--finish-move` |
| Backups | `target.backups`; then provision |
| The scheduled check | `observability.check.enabled`; provision renders its workflow |
| Another provider | `opscrew retarget` (Hetzner and DigitalOcean today) |
| Monitoring, Beszel, Grafana Cloud | `opscrew addon enable` |

### R2.5 Reliability and upkeep signals

- **Restarts:** the restart count per container (one reading); no rate.
- **The scheduled check (017):** runs in GitHub Actions and opens one issue labelled
  `opscrew-check` when the app fails, closing it when it passes. Its history is the issues.
- **Backups off:** `target.backups` with `dataCriticality`; the secops policy
  `backups-for-critical-data`.
- **`opscrew secure`:** `SecureResult` with `problems: SecurityProblem[]`; its host checks already
  count pending security updates and a required reboot (`packages/secops/src/hardening/checks.ts`).
- **Dependabot:** provision writes `.github/dependabot.yml`; nothing reads alerts or pull requests.
- **Token expiry:** nothing reads a token's expiry today.

### R2.6 Structure

- CLI commands register in `packages/cli/src/commands/index.ts`; MCP tools in
  `packages/mcp-server/src/server.ts` (read-only tools carry `readOnlyHint`).
- A phase that uses the model: `analyze/run.ts` (`runtime.runPhase` with a zod output, validated
  again after). Nothing named advise exists.

## R3. Lead decisions for the spec

1. **One read-only command.** `opscrew advise` reads the deployment, the plan, the interview and
   live prices, and lists proposals. It changes nothing on a server, account or repository.
2. **Every proposal says why and what it costs:** the figures it rests on, the monthly price
   before and after (live prices, dated when static), and how to apply it.
3. **Applied through the existing flows.** `opscrew advise --apply <id>` writes only the plan, as
   `addon enable` does, for the proposals the plan holds (server type, backups, the scheduled
   check, a service on its own server); `opscrew provision` then applies it, each change approved
   by its hash. The others name their command (`addon enable monitoring`, `retarget`, merging
   Dependabot's pull requests).
4. **History when there is one, honesty when there isn't.** With the self-hosted stack, advise
   reads 14 days through fixed queries (p95 CPU and memory, restarts, the disk's trend). Without
   it, one reading: proposals to go up or to fix something stand on it, but OpsCrew never proposes
   a smaller server on one reading, and it says turning monitoring on would let it.
5. **OpsCrew's own thresholds,** written down (the clouds publish none): smaller only when p95 CPU
   and p95 memory stay well under what the next smaller type gives, over at least 7 days; larger
   when p95 memory passes 85% of the server or a container its limit, or the load stays above the
   CPUs; a disk projected full within 30 days, or at 85% now.
6. **Deterministic, no model in this version.** Every rule is code and testable; the model would add
   only prose. Proposals that need judgment about the app's code (a cache, object storage) come from
   what detection and design already know.
7. **Not here:** Grafana Cloud's history (it needs a second token with read scopes) and Beszel's
   (no documented API); AWS (024); acting on its own or on a schedule.

## R4. Dropped from 021: one Alloy for several apps on the user's own server

**Dropped the same day** (the founder left the call to the lead): it is rare (several OpsCrew apps
on one own server, more than one wanting monitoring), the first app's monitoring already shows the
whole server and Beszel every container, and it would rework the Alloy path just released. Kept
here for when users ask; the roadmap lists it under "Later, if users ask".

Added to 021 by the founder on 2026-11-04: today a server runs one Grafana Alloy, rendered from one
app's plan, so a second OpsCrew app on the same own server is refused Grafana Cloud and the
self-hosted monitoring (017, 020). He asked for it lifted within one repository and across
repositories. Research the same day: a Sonnet agent on Alloy's official docs (the "latest" pages,
to check against v1.21.3 in the spike), a Haiku code map.

### R4.1 Alloy's configuration folders and modules

- **A folder as the configuration:** `alloy run <dir>` loads every `*.alloy` file in it (not nested
  folders) as one source; component labels must be unique across the files, and blocks such as
  `logging` must not repeat. Load order isn't stated. Source:
  https://grafana.com/docs/alloy/latest/reference/cli/run/
- **Errors:** a bad configuration at start stops Alloy; on a reload Alloy "continues functioning in
  the last valid state". Whether one bad file is skipped alone is unconfirmed: expect all or
  nothing.
- **Reloading:** `POST /-/reload` or SIGHUP; `run` doesn't watch the folder. `import.file` watches
  its path (fsnotify, polling every minute as a fallback). Source:
  https://grafana.com/docs/alloy/latest/reference/config-blocks/import.file/
- **Modules:** `import.file` takes a file or a folder (a folder is one module); a module holds only
  `declare` and `import` blocks; arguments in (`argument.x.value`) and exports out work both ways.
  Source: https://grafana.com/docs/alloy/latest/get-started/modules/
- **Fan-out:** `forward_to` is a list of receivers, each metric to every receiver; several
  `prometheus.remote_write` components each keep their own WAL.
- **Secrets:** `local.file` with `is_secret = true` keeps the value out of the UI; whether it stays
  redacted when passed into a module is unconfirmed.
- **Several Alloys on one host:** not documented; each would need its own listen address and
  storage path.

### R4.2 What OpsCrew has (code map)

- **The rule:** ssh-host's `addonTaken` refuses a second app's `alloy`, `beszel` or `monitoring`
  at plan time (`plan.ts`) and at apply time (`apply.ts`), with the owner recorded in
  `/etc/opscrew/host.json`'s `addons` (one app each); agents' `monitoringEnable` refuses it first on
  the user's own servers (`inspectOwnServers`). Specs: 017 data-model ("one of each per server"),
  020 spec (edge case and assumption).
- **What is per app in Alloy's configuration** (`iac-templates/src/addons/alloy.ts`): the logs'
  Compose project filter, the masking file (`/srv/apps/<app>/mask.re`), the `app`/`env`/`server`
  labels, the per-container figures (the app's project and OpsCrew's own), the Postgres data
  source; and the writers (Grafana Cloud's token file, the monitoring stack's address).
- **What is per server:** the unix exporter, cAdvisor, the read-only Docker proxy, the Compose
  project `opscrew-alloy` (its folder, its networks: the edge's, the monitoring push network,
  `<app>_internal` for Postgres), the memory limit.
- **Shared things OpsCrew already handles:** the edge (one per server, a version stamp so an older
  app never downgrades it, removed with the last app), each app's WireGuard interface (an owner per
  interface in `host.json`'s `networks`, refused to other apps).
- **Beszel:** one agent per server, refused for a second app too; it already shows every container
  on the server.

### R4.3 Lead decisions for part 2

1. **One Alloy per server, owned by the server.** Its configuration is a folder: a shared
   `server.alloy` (the exporters and the Docker discovery, no writers) and one `app-<key>.alloy` per
   app, written only by that app's provision, with every component label prefixed by the app's key.
2. **Each app's file is self-contained:** its logs (its own Compose project), its masking (its own
   `mask.re`), its containers' figures, the server's figures read from the shared exporters, its
   Postgres where it runs there, Caddy's figures for its own hostnames, and its own writers
   (Grafana Cloud with its own token file, or its monitoring stack). No file names another app, so
   one repository never needs another's plan, values or secrets. Within one repository and across
   repositories work the same way.
3. **The shared parts carry a version stamp,** as the edge does: the newer OpsCrew writes them, an
   older one keeps them. The Compose file's networks and memory limit are assembled on the server
   from what each app's part declares (a small needs file per app), so no repository writes another
   app's networks.
4. **A bad file never breaks the others:** the step checks the whole folder with Alloy's own
   validation before it reloads, and refuses (changing nothing) when it fails.
5. **Ownership:** `host.json` lists the apps that have a part; each changes or removes only its own;
   the shared parts and the container go with the last part.
6. **Beszel stays one per server:** it already shows every container; a second app's request says
   so.
7. **The spike (T2101) tries it on Alloy v1.21.3:** two app files and the shared file in one folder,
   a reload by SIGHUP, a bad file on reload, labels prefixed, the validation command inside the
   pinned image, and one app's destination down while the other's works.
