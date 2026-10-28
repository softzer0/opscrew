# Research: Observability, light and free

Research of 2026-10-28 (Sonnet for the products, and for the code map), from official sources: docs.github.com, github.blog/changelog, docs.slack.dev, docs.discord.com, docs.ntfy.sh, developers.cloudflare.com, docs.portainer.io, docs.docker.com, beszel.dev with github.com/henrygd/beszel, and grafana.com/docs with github.com/grafana/alloy. Items marked **open** are for the spike (T1702).

## R1. Logs and figures on servers, in a Portainer and on the user's computer

**Decision:**
- **Servers (cloud and own):** fixed read commands over the SSH access `status` already uses: `docker logs` for lines, and one fixed command for the figures.
- **Portainer:** Docker's API through Portainer's proxy.
- **The user's computer:** the Docker CLI, as `localhost` status does today.

**Rationale:**
- The read paths exist: `status` already reads `docker ps` over SSH, Portainer's container list, and local Docker. Logs and figures are more fixed commands on the same paths, with no new way in (FR-1703).
- Every container already logs to `json-file`, 10 MB × 3 files (`runtime/services.ts`, and the daemon default), and `docker logs` reads exactly that.

**Alternatives considered:**
- **An agent or exporter on the server:** it would run all the time, and the spec reads on demand.
- **Portainer's environment snapshot** for host totals: its fields aren't documented (UNCONFIRMED). `/info` is.

**Facts:**
- **`docker logs`** takes `--timestamps`, `--tail`, `--since` and `--follow`, and reads only `json-file` and `journald`. https://docs.docker.com/reference/api/engine/version/v1.47.yaml
- **The figures from one command:**
  - `nproc`, `/proc/loadavg`, `free -b` and `df -P -B1 /` for the server;
  - `docker stats --no-stream` for each container's CPU and memory against its limit;
  - `docker inspect --format` with only `RestartCount`, `State.StartedAt` and `HostConfig.Memory` (never `Config.Env`).

  A deploy recreates the containers, so `RestartCount` counts the restarts since the last deploy.
- **Portainer** proxies Docker's API at `/api/endpoints/{id}/docker/…` and "can be used to execute any of the Docker HTTP API requests". https://docs.portainer.io/api/access
  - **Logs:** `GET …/containers/{id}/logs?stdout=1&stderr=1&timestamps=1&tail=N&since=<unix>`. A container without a TTY answers in Docker's multiplexed framing: an 8-byte header (stream type, then a big-endian uint32 size) before each chunk. A TTY container answers raw.
  - **Stats:** `GET …/containers/{id}/stats?stream=false`. Without `one-shot` it waits two cycles, so `precpu_stats` is filled.
    - CPU % = `(cpu delta / system delta) × online_cpus × 100`.
    - Memory = `usage − inactive_file` on cgroup v2, or `usage − cache` on v1, against `memory_stats.limit`.
  - **Host:** `GET …/info` gives `NCPU` and `MemTotal`. `GET …/system/df` gives Docker's own usage only.
  - **The host's free disk:** Docker and Portainer have no field for it. Status names it as not available (US2 #4).
  - **Access:** an access token has its owner's access (`X-API-Key`). Roles are a Business Edition feature. In CE, a token is an administrator's or a standard user's (UNCONFIRMED from Portainer's Kubernetes roles page). https://docs.portainer.io/api/access, https://docs.portainer.io/advanced/docker-roles-and-permissions
  - **Open:**
    - whether `follow=1` streams through Portainer's proxy, or `--follow` polls with `since`;
    - what a CE standard user's token may read.
- **Following lines over SSH:** `SshRemoteExec.run` returns when the command ends. It has no `onLine` or `signal`, although `CommandRunner.run` has both. **Open:** that the remote `docker logs --follow` ends when the CLI stops; without a terminal, sshd does not hang up on the remote process.

## R2. Cloudflare's logs and analytics

**Decision:**
- `logs` reads past lines from the Workers Observability query API, and follows new ones through the Tail API.
- `status` reads the last 24 hours from the GraphQL Analytics API (`workersInvocationsAdaptive`).
- `init` checks the token's permissions for all three.

**Rationale:**
- These are Cloudflare's documented APIs.
- The deploy config already turns Workers Logs on (`serverless/wrangler.ts`: `observability.enabled`), so FR-1714's "keep it on" is a test that it stays.
- No wrangler on the user's computer: the typed connector calls the APIs with `fetch`, and Node's built-in `WebSocket` (stable since Node 22) reads the tail.

**Alternatives considered:**
- **`wrangler tail`:** a new dependency, and wrangler runs only in CI (016).
- **Logpush:** a paid feature, and a destination to manage.

**Facts:**
- **Turning logs on:** `[observability] enabled = true`, optional `head_sampling_rate` (default 1). https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- **Allowances:**
  - **Until 2026-11-30:**
    - Free: 200,000 events a day, kept 3 days.
    - Paid: 20 million a month, kept 7 days.
    - https://developers.cloudflare.com/workers/platform/pricing/
  - **From 2026-12-01, Cloudflare Observability's unified pricing, by volume:**
    - Free: 0.5 GB ingested a day, kept 7 days. Ingestion stops at the limit and resumes at 00:00 UTC.
    - Paid: 50 GB ingested and 10 GB-month stored, then $0.25 per GB and $0.10 per GB-month.
    - https://developers.cloudflare.com/observability/pricing/
  - So neither figure is hard-coded. `logs` and design name the allowance from a dated table in `prices.ts` (constitution: a static fallback is labelled with its date).
- **Query:** `POST /accounts/{account_id}/workers/observability/telemetry/query`. https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
  - The body takes `timeframe {from, to}` (ms), `view: "events"` and `limit` (up to 2,000). Its `parameters.filters` hold `$metadata.service` equal to the Worker's name.
  - An event has `timestamp`, `$metadata` (`level`, `message`, `error`, `statusCode`, `url`, `requestId`, …) and `$workers` (`outcome`, `scriptVersion`, …).
  - **Open:**
    - where console lines and exceptions sit in an event;
    - the permission: the page names Workers Observability Write, and a read-only one isn't shown.
- **Tail:** `POST /accounts/{account_id}/workers/scripts/{script}/tails` returns a WebSocket URL. https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/
  - The least privilege that allows it is Workers Tail Read.
  - At most 10 clients follow one Worker at once, and a busy Worker is sampled. https://developers.cloudflare.com/workers/observability/logs/real-time-logs/
  - **Open:** the message format.
- **Static assets:** a request that matches an asset is served without running the Worker, so it is in neither the logs nor the tail. Such requests are free and unlimited. https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
  - So a static site on Cloudflare has no request logs.
  - `logs` says so in one sentence and shows the deploys instead, as for GitHub Pages.
  - An SSR app's Worker requests are logged.
- **Analytics:**
  - The `workersInvocationsAdaptive` dataset gives `sum { requests errors subrequests }` and `quantiles { cpuTimeP50 cpuTimeP99 }` by `scriptName`. It needs Account Analytics Read, and allows 300 queries per 5 minutes. https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/, https://developers.cloudflare.com/analytics/graphql-api/limits/
  - **Open:** whether it answers on the Free plan, and whether asset requests count in it.
- **The Free plan's limits:** 100,000 requests a day, and 10 ms of CPU time per invocation. https://developers.cloudflare.com/workers/platform/pricing/

## R3. The scheduled check in GitHub Actions

**Decision:** one workflow per repository, `.github/workflows/opscrew-check.yml`.
- It runs a readable Node script that OpsCrew vendors, `opscrew/check/check.mjs`. The script has no dependencies, and is the same for every user.
- Generated JSON, `opscrew/check/check.json`, says what to check. It is rendered from every app's and environment's plan, as `dependabot.yml` is (016).
- It runs on a schedule at a minute off the hour, and on `workflow_dispatch`.
- **Permissions:** `contents: read` and `issues: write` only.

**Rationale:**
- **A script file, not a long shell step:**
  - it is tested in OpsCrew's own suite with injected `fetch`;
  - it reads as plain code in the user's repository;
  - it needs only Node's built-ins (`fetch`, `tls`, `child_process` for `ssh`).
- **One job for everything on GitHub's runners,** so a run is billed once (rounded up to a whole minute).

**Alternatives considered:**
- **Actions from the marketplace** (uptime or issue actions): third-party code with the repository's token. The constitution avoids them.
- **One workflow per environment:** the minutes multiply.

**Facts:**
- **Scheduling** (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows):
  - the shortest interval is 5 minutes;
  - runs can be delayed under load, and load peaks at the top of each hour;
  - only the default branch's file runs;
  - cron is in UTC.
- **Forks and inactivity:**
  - Scheduled workflows are off in forks of public repositories. https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows
  - "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days."
  - The workflow's `state` then reads `disabled_inactivity`: `GET /repos/{owner}/{repo}/actions/workflows/{file}`, with Actions: Read. `PUT …/enable` turns it on again, with Actions: Write. https://docs.github.com/en/rest/actions/workflows
  - Whether GitHub tells anyone when it turns a schedule off, and what counts as activity: not documented (UNCONFIRMED). So the check warns itself from day 50 (FR-1708), and `status` reads the state.
- **Notifications:** a scheduled run's notifications go to whoever last changed the cron line (the events page and the notifications page differ in detail). One person, so failures go into an issue (spec Assumptions).
- **Billing** (https://docs.github.com/en/billing/concepts/product-billing/github-actions, https://docs.github.com/en/billing/reference/actions-minute-multipliers):
  - Standard runners are free in public repositories.
  - Private repositories include 2,000 minutes a month on Free, and 3,000 on Pro and Team.
  - Each job is rounded up to the whole minute.
  - With no payment method, jobs stop when the minutes run out.
  - So an hourly check is 720 to 744 minutes a month, under FR-1710's 750, and every 15 minutes is about 2,900 (spec Assumptions).
- **`ubuntu-slim`:** a 1-vCPU runner that runs the job in a container. It has a 15-minute timeout, and Node 24, `curl`, `openssl`, `jq` and `gh`. https://docs.github.com/en/actions/reference/runners/github-hosted-runners, https://github.com/actions/runner-images
  - **Open:**
    - whether it starts and finishes the check within a billed minute;
    - whether it uses included minutes at the same rate as `ubuntu-latest`.
- **Which hosts to check:**
  - Each hostname's health path over HTTPS, and the days its certificate has left (Node's `tls.connect`, `getPeerCertificate().valid_to`).
  - On a proxied hostname, that is Cloudflare's certificate. The origin's certificate stays with `secure` and `status` (014).

### Reaching a server's disk

**Decision:**
- **The check key:** OpsCrew generates one key pair per repository.
  - On each checked server, its public key is in the deploy user's `authorized_keys` with `restrict,command="df -P -B1 /"`. That is OpenSSH's forced command: whatever the client asks, the server runs only `df`, with no terminal and no forwarding.
  - The private key is a repository secret, `OPSCREW_CHECK_SSH_KEY`. Each environment's address and host key are a repository secret, `<prefix>CHECK_SERVER` (`deploySecretPrefix`).
- **Where the disk is read:** where the deploy job runs.
  - **On GitHub's runners:** the hosted job uses the check key.
  - **A runner host (015):** a job on it uses the check key.
  - **The server's own runner:** a job on it runs `df` locally.

**Rationale:**
- **The deploy keys can't serve:**
  - they can live in GitHub environments with branch rules or required reviewers (`docs/guide/environments.md`), which a scheduled job can't pass;
  - a job in an environment also records a deployment each run;
  - a deploy key can run anything as the deploy user.
- **The check key can run only `df`,** so a leaked key reads one disk figure (FR-1703).
- **Addresses stay out of the repository:** `check.json` names the secret, never the address. A committed address would expose the origin of a proxied site. MCP already hides addresses (`mcp-server/src/tools/shared.ts`).
- **The server's own runner:** a job there is free (self-hosted). Job-level `concurrency` keeps one pending run per server when the server is down. The hosted job reports the outage over HTTPS meanwhile.

**Alternatives considered:**
- **A cron job on the server writing a file the edge serves:** something running on the server, and a public figure.
- **No disk check where SSH from GitHub is closed:** the spec's edge case asks for it.
- **The self-hosted job reporting to the hosted job through `needs`:** it waits as long as the runner is down.

**Open:** the forced command under OpsCrew's `sshd` hardening (009, 014), on a cloud server and an own server.

## R4. Alerts: issues and chat webhooks

**Decision:**
- **One open issue per failing check,** labelled `opscrew-check`, found again by a hidden marker in its body: `<!-- opscrew-check:<key> -->`.
- **What changes the issue:**
  - a comment only when what fails changes;
  - closed on recovery, with how long it lasted (`state_reason: completed`).
- **The webhook:** posts the same message when an issue opens or closes.
- **Repository issues off:** the run fails after posting the webhook, and writes the job summary.

**Rationale:**
- An issue notifies everyone watching the repository, and email reaches them through GitHub.
- The issue itself holds the state (when it started, what failed), so the check keeps no state of its own.

**Facts:**
- **Permissions and endpoints:**
  - `issues: write` covers creating, commenting, closing, labelling and creating labels. https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
  - Open issues by label: `GET /repos/{o}/{r}/issues?labels=opscrew-check&state=open` (pull requests come back too, with a `pull_request` key). https://docs.github.com/en/rest/issues/issues
  - Creating an issue where issues are off answers `410 Gone`, and `GET /repos/{o}/{r}` has `has_issues`. https://docs.github.com/en/rest/repos/repos
- **Labels:** whether a missing label is created with the issue is not documented (UNCONFIRMED). So the check creates the label first, and ignores the 422 when it exists.
- **Slack:** `POST` JSON `{"text": …}`, and the answer is `ok`. 4,000 characters are recommended. https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
- **Discord:** `POST` JSON `{"content": …, "allowed_mentions": {"parse": []}}`, up to 2,000 characters, and the answer is 204. https://docs.discord.com/developers/resources/webhook
- **ntfy:** `POST` the text to the topic's URL, with `Title`, `Priority` (1–5) and `Tags` headers, and optionally `Authorization: Bearer <token>`. A message is up to 4,096 bytes. ntfy.sh allows 250 messages a day. https://docs.ntfy.sh/publish/
- **What goes into an issue or a post (FR-1702):**
  - fixed sentences, the app's, environment's and server's names, the hostname, a status code, an error code (such as `ECONNREFUSED` or `CERT_HAS_EXPIRED`), the days left and the disk figures;
  - never a response's body or headers.

  So nothing the app returns can carry a secret into them. The webhook address is a GitHub secret, and the check never prints it.

## R5. Read-only Docker access for the add-ons

**Decision:**
- **The proxy:** an OpsCrew-rendered Caddy, from the image OpsCrew already pins. It listens on a Unix socket in a volume that only the add-on mounts, and passes only `GET` on an allow-list of paths to Docker's socket:
  - **Beszel:** `/_ping`, `/version`, `/info`, `/containers/json` and `/containers/{id}/stats`;
  - **Alloy:** the same, plus `/networks`, `/containers/{id}/logs` and `/containers/{id}/json` (spike result 3).
- **Everything else answers 403:** `POST`, `exec`, `archive`, `export`, image and volume calls.
- The proxy runs with `read_only`, `cap_drop: ALL`, `no-new-privileges`, no published port and a memory limit.

**Rationale:**
- Mounting the socket `:ro` doesn't make Docker's API read-only: it only stops writes to the socket file. Any API call still goes through.
- **The ready-made proxies are too broad:**
  - `linuxserver/socket-proxy` and `tecnativa/docker-socket-proxy` grant `CONTAINERS=1` to every `GET` under `/containers`;
  - that includes `archive`, which reads files from the app's containers, and `export`.
  - Beszel's maintainer recommends one with `CONTAINERS=1` (https://github.com/henrygd/beszel/discussions/1818).
- **An exact allow-list** is easy to read and test, and Caddy is already pinned and rendered by OpsCrew. It adds no new image.
- **Beszel needs neither container inspect nor logs** for its charts. Refusing them keeps the app's environment values and log lines away from Beszel, and from a hub elsewhere.
- **Alloy's `loki.source.docker` calls `ContainerInspect` and `ContainerLogs`** (both `GET`; `internal/component/loki/source/docker/tailer.go`). Inspect shows the containers' environment, which holds the app's secrets (`app.env`). The guide says so. Alloy runs on the user's server, and sends only masked log lines.

**Open:**
- each add-on through the proxy;
- the exact paths each needs;
- a refused path's effect;
- Alloy without inspect.

## R6. Beszel

**Decision:** Beszel v0.21, MIT, pinned by digest. It runs as one of two modes:
- **Hub mode:** the dashboard and the agent on the server.
- **Agent mode:** only the agent, connected out to a hub the user already runs.

The agent always connects to the hub over WebSocket (`HUB_URL`, `TOKEN`, `KEY`) with `DISABLE_SSH=true`, so no port is opened.

**Facts:**
- **Release and images:**
  - v0.21.1 came out on 2026-10-22, under the MIT licence. https://github.com/henrygd/beszel/releases
  - The images are `henrygd/beszel` (hub, `FROM scratch`, port 8090, data in `/beszel_data`) and `henrygd/beszel-agent` (`FROM scratch`), for amd64, arm64 and arm/v6-7.
- **Connections:**
  - The WebSocket mode (agent to hub) came in v0.12.0. The agent then stops its SSH listener. https://github.com/henrygd/beszel/releases/tag/v0.12.0
  - `DISABLE_SSH` exists on both sides. https://beszel.dev/guide/environment-variables
- **No clicks:**
  - `USER_EMAIL` and `USER_PASSWORD` create the first user on a new hub. https://beszel.dev/guide/environment-variables
  - A `config.yml` in `/beszel_data` declares systems (`name`, `host`, `port`, `token`, `users`), and is synced at start (`internal/hub/config/config.go`; the docs page answered 404).
  - **Open:** a system declared there, with a token OpsCrew generates, accepted from the local agent over WebSocket.
- **Docker:**
  - The agent only reads Docker's API: container list, inspect, stats with `one-shot`, logs, `/version` and `/info` (`agent/docker.go`).
  - `DOCKER_HOST` points it at a proxy.
  - The hub's `CONTAINER_DETAILS=false` turns off inspect and logs in the dashboard.
  - `network_mode: host` gives the host's network figures.
- **Memory:**
  - Not documented. Users report about 10–20 MiB for the agent, and about 18 MiB for the hub when idle (https://github.com/henrygd/beszel/issues/1822).
  - The plan's starting limits: hub 128 MB, agent 64 MB, proxy 32 MB. **Open:** measured over a day.
- **The dashboard:**
  - It is behind a PocketBase login (email and password, optionally OAuth or MFA).
  - `AUTO_LOGIN` is never set, and `DOCKER_IMAGE_CHECK=false` stops its registry calls.
  - Beszel's own alerts are set in the dashboard (Settings → Notifications). https://beszel.dev/guide/notifications

## R7. Grafana Alloy and Grafana Cloud

**Decision:** Grafana Alloy v1.21, Apache-2.0, pinned by digest.
- **Container logs:** `discovery.docker` and `loki.source.docker` through the proxy (R5), labelled with the app's, environment's and service's names from Compose's labels.
- **Server metrics:** `prometheus.exporter.unix` from `/proc`, `/sys` and `/` mounted read-only, kept to a short allow-list with `prometheus.relabel`.
- **Masking before anything leaves the server:**
  - `loki.secretfilter`;
  - `stage.replace` rules from OpsCrew's own token patterns;
  - a rule built from the app's known secret values.
- **Sending:** to the user's stack with basic auth: the stack's user ids, and the token as the password.
- **No `prometheus.exporter.cadvisor`:** its documented Docker setup needs `privileged`, a writable socket and a writable `/var/run`.

**Facts:**
- **The free tier:** 10,000 active metric series, 50 GB of logs a month, both kept 14 days, and 3 users. https://grafana.com/pricing/
- **The access policy token:**
  - Its scopes are `metrics:write` and `logs:write`. It is created in the Cloud Portal under Access Policies, or in the stack's Administration.
  - Alloy also needs the Prometheus `remote_write` URL and its user id, and the Loki push URL and its user id. These are two different ids, from the stack's details page.
  - https://grafana.com/docs/grafana-cloud/account-management/authentication-and-permissions/access-policies/
- **The image and its sizing:**
  - v1.21.2 came out on 2026-10-22. The image is `grafana/alloy`, and it runs with `run --storage.path=/var/lib/alloy/data`. https://grafana.com/docs/alloy/latest/set-up/install/docker/
  - The sizing guidance covers only large setups: about 11 GiB per million series, and about 120 MiB per MiB/s of logs. https://grafana.com/docs/alloy/latest/introduction/estimate-resource-usage/
  - The plan's starting limit is 192 MB with `GOMEMLIMIT` at 80%. **Open:** measured.
- **Stability:** `loki.secretfilter`, `loki.source.docker`, `loki.process`, `discovery.docker`, `prometheus.exporter.unix` and `prometheus.relabel` are generally available, so no stability flag is needed. https://grafana.com/docs/alloy/latest/reference/cli/run/
- **`loki.secretfilter`:**
  - It uses Gitleaks' rules.
  - Its docs warn that it costs CPU, and that it must not be the only redaction. https://grafana.com/docs/alloy/latest/reference/components/loki/loki.secretfilter/
- **`prometheus.exporter.unix`:**
  - It has `procfs_path`, `sysfs_path` and `rootfs_path`.
  - Its docs say it "may also need" more privileges. https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.unix/
  - **Open:** unprivileged, with read-only mounts.
- **The estimate design shows (FR-1712):**
  - **Series:** the allow-list's series, counted from the server's CPUs, filesystems and network interfaces (host facts).
  - **Logs:** a month at the rate of the last 24 hours. A fixed read sums the bytes of `docker logs --since 24h` for the app's containers.
  - Past either free limit, design offers fewer metrics, or sampled logs (`stage.sampling`).
- **Known values:**
  - The app's secret values change with deploys, so the deploy job writes a masking file next to `app.env` (root-only). It holds the values as one escaped RE2 alternation.
  - Alloy reads it with `local.file` (`is_secret`), into `stage.replace`.
  - **Open:** whether `stage.replace` takes an expression from another component's export, and is updated when the file changes.

## R8. Code map: where 017 plugs in

**status** (`packages/agents/src/status/`)
- `componentStatusReport` (`run.ts`) reads containers:
  - **cloud servers:** over `SshRemoteExec` as `deploy` (`readServerContainers`);
  - **own servers:** through `connectAndInspectOwnServer` (`shared/own-server.ts`);
  - **Portainer:** through `listContainers`;
  - **the user's computer:** through `localhost/status.ts`.
- `siteStatusReport` (`status/site.ts`) covers Cloudflare and GitHub Pages.
- No type holds CPU, memory, disk or restarts.
- The CLI (`cli/src/commands/status.ts`) prints lines.
- `--app` and `--env` resolve through `chooseEnvironment` (`cli/src/ui/environment.ts`), and in MCP through `toolEnvironment`.

**Remote reads**
- `SshRemoteExec` (`agents/src/shared/remote.ts`) runs a command string, with no streaming.
- There is no central allow-list. Fixed commands sit in:
  - `status/components.ts`;
  - `secops/src/hardening/checks.ts` (`HOST_CHECKS`);
  - `connectors/ssh-host/src/inspect.ts`.
- Every read is audited as `remote-exec`, without the address.

**Thresholds**
- `diskUsage` (`secops/src/hardening/checks.ts`): 85% medium, 95% high.
- Certificates:
  - `MIN_CERT_DAYS` is 14 (`agents/src/verify/checks.ts`);
  - `CERTIFICATE_WARN_DAYS` is 30 (`secops/src/hardening/tls.ts`).
- Memory headroom (`agents/src/shared/memory.ts`).

**The redactor** (`core/src/redact.ts`)
- `Redactor.addLiteral` and `TOKEN_PATTERNS`.
- CLI output and MCP results are redacted already.
- Only `provision` (`provision/secrets.ts`) and Portainer's drift register the app's values. `logs` and `status` need that too: one shared helper.

**Workflows** (`iac-templates/src/workflow/`)
- **Precedents:**
  - `dependabot/index.ts` for a file rendered from every app;
  - `shared.ts` for `runs-on`, `deploySecretName` and `deploySecretPrefix`.
- `publishDeploySetup` (`agents/src/provision/publish.ts`) opens the deploy-setup pull request.
- **Pins:** `pins.ts` holds `IMAGES`, `ACTIONS` (with `checkout` and `setupNode`) and `TOOLS`, and `caddy` is already pinned. `scripts/update-pins.mjs` refreshes them.

**Add-on precedent: Portainer's web UI (`plan.portainer`, `agents/src/portainer/`)**
- `access: local | subdomain`, with a hostname and emails behind Cloudflare Access through the tunnel (`infra/tunnel.ts`, `modules/cloudflare-access`).
- A host plan step (`planPortainer`, `ssh-host`), approved as `host-apply`.
- Secrets reach the server on stdin (`ApplyOptions.secrets`).
- `portainer status` prints the `ssh -N -L` command.

**Secrets**
- **On the server:** `/srv/apps/<app>/app.env` (and per service), written by the deploy job from GitHub secrets.
- **The recovery copy:** `HOME_FILES` and `STATE_FILES` in `agents/src/secrets/files.ts`.

**Planned outages**
- Retarget's window and destroy are recorded only on the user's computer. Retarget commits only at `--finish`.
- So a check in the repository cannot see them. The plan uses a repository variable.

**Connectors**
- **GitHub:** has secrets, runs, re-runs and environments. It has no issues, labels, variables or workflow state. `GITHUB_TOKEN_PERMISSIONS` has no Issues or Variables.
- **Cloudflare:** has Workers versions, deployments and custom domains. It has no logs, tail or analytics.
- **Portainer:** has container lists and stacks. It has no logs, stats or inspect.

**MCP and the plugin**
- **MCP:** `opscrew_status` is read-only, and no tool caps its output's size.
- **The plugin's skills:** `opscrew-adapt`, `opscrew-deploy` and `opscrew-scan`.

**The CLI:** 23 commands in `ALL_COMMANDS` (`cli/src/commands/index.ts`), and `program.test.ts` counts them.

## Open items for the spike (T1702)

1. **The Docker proxy (R5):**
   - Caddy, listening on a Unix socket in a volume and passing an allow-list of `GET` paths to Docker's socket;
   - Beszel's agent (host network) and Alloy each working through it;
   - the exact paths each needs;
   - a refused path answering 403 without breaking them;
   - logs streaming through it;
   - Alloy's `loki.source.docker` without inspect.
2. **Beszel (R6):**
   - a hub with `USER_EMAIL`, `USER_PASSWORD` and a `config.yml` system, and the local agent accepted over WebSocket with OpsCrew's token, with no clicks;
   - agent mode to a hub elsewhere (`HUB_URL`, `TOKEN`, `KEY`);
   - `CONTAINER_DETAILS=false`;
   - the hub, agent and proxy's memory over a day.
3. **Alloy (R7):**
   - `prometheus.exporter.unix` unprivileged with read-only mounts, and the series of the allow-list on a 2-CPU server;
   - `loki.secretfilter` with OpsCrew's `stage.replace` rules;
   - the known-values file through `local.file` into `stage.replace`;
   - memory under `GOMEMLIMIT`;
   - lines and metrics reaching a Grafana Cloud free stack with a `metrics:write` and `logs:write` token, within 5 minutes.
4. **The check key (R3):** `restrict,command="df -P -B1 /"` for the deploy user under OpsCrew's `sshd` settings, on a cloud server and an own server. A key that asks for another command gets `df`.
5. **The check on GitHub (R3, R4):**
   - `ubuntu-slim` versus `ubuntu-latest`: duration and billed minutes;
   - a label created before an issue;
   - an issue opened by `GITHUB_TOKEN` notifying a watcher;
   - `vars.OPSCREW_CHECK_PAUSED` read in a scheduled run;
   - the fine-grained permission for repository variables (Variables: Read and write);
   - the workflow's `state` read with OpsCrew's token.
6. **Cloudflare (R2):**
   - the telemetry query's permission (read-only or Write);
   - where console lines and exceptions sit in an event;
   - the delay before a request's event can be queried;
   - the Tail API's WebSocket from Node's `WebSocket`, and its message format;
   - `workersInvocationsAdaptive` on the Free plan, and whether asset requests count in it.
7. **Portainer (R1):**
   - `logs` with `follow=1` through the proxy;
   - stats and inspect (`RestartCount`) with a CE standard user's token.
8. **SSH follow (R1):** `docker logs --follow` over `ssh` ending on the server when the CLI stops (Ctrl-C), with and without `-tt`.

## Spike results (T1702)

Items 1–4, 7 and 8 were run on 2026-10-28 on local Docker (29.9, cgroup v2, 8 CPUs), with the pinned images and OpsCrew's own `sshArgs` and settings. Everything was removed afterwards. Items 5 and 6 need the e2e GitHub and Cloudflare accounts, and Alloy's delivery to Grafana Cloud (part of item 3) the founder's stack; a local Loki and Prometheus stood in for it.

1. **The Docker proxy (Caddy, pinned):**
   - **Starting it:**
     - With `cap_drop: [ALL]` alone, it doesn't start ("operation not permitted"): the binary carries `cap_net_bind_service`. `cap_add: [NET_BIND_SERVICE]` fixes that.
     - It also needs `tmpfs: [/data, /config]`, and runs with `read_only`, `no-new-privileges` and `network_mode: none`.
   - **The socket:** created `0200 root`, so the add-ons connect as root, which both are. A non-root client would need `bind …|0660` and a group.
   - **What passes:**
     - 200 for `/_ping`, `HEAD /_ping`, `/version`, `/info`, `/containers/json`, `/v1.47/…`, and stats by id and by name;
     - in Alloy's variant, `logs` and `json` too;
     - `logs?follow=1` streams line by line.
   - **What it refuses, with 403:** `POST stop`, `POST exec`, `archive`, `export`, `/images/json`, `/volumes`, `attach`, `top`, `DELETE`, `PUT`, `%2F`-encoded paths and `//images`. A dot-segment path gets Docker's 301 to the clean path, which passes the proxy again. The target container kept running.
   - **The Caddyfile:** `admin off`, `auto_https off` and `persist_config off`. An `http://` site with `bind unix//run/opscrew-docker-ro/docker.sock` routes `@allowed` (`method GET HEAD`, `path_regexp ^(/v1\.[0-9]+)?/(<list>)$`) to `reverse_proxy unix//var/run/docker.sock { flush_interval -1 }`, and answers anything else with `respond 403`.
2. **Beszel 0.21.1, hub mode with no clicks:**
   - **The hub:**
     - It reads its key from `/beszel_data/id_ed25519`, so OpsCrew generates it and knows `KEY` beforehand. `/api/beszel/info` returned that key.
     - `USER_EMAIL` and `USER_PASSWORD` create the user before `config.yml` is synced, so `systems: [{name, host: localhost, port: 45876, token: <48 hex>, users: [<email>]}]` resolves.
     - It ran with `read_only`, `cap_drop: ALL`, `no-new-privileges` and `tmpfs: [/tmp]`.
   - **The agent:**
     - It ran with `network_mode: host`, `read_only` and `cap_drop: ALL`, and with `HUB_URL=http://127.0.0.1:8090`, `TOKEN`, `KEY`, `DISABLE_SSH=true`, `DOCKER_HOST=unix:///run/opscrew-docker-ro/docker.sock` and `DOCKER_IMAGE_CHECK=false`.
     - It connected over WebSocket, and the system went up with system and per-container stats.
     - It reports every container on the server.
     - Through the proxy it uses only `/containers/json`, `/containers/{id}/stats`, `/info` and `/version`.
     - **`DOCKER_IMAGE_CHECK` is read by the agent,** not the hub. Without it, the agent calls `/images/<ref>/json`.
     - With `CONTAINER_DETAILS=false` on the hub, its logs and info routes answer 404. A refused path only logs an error.
     - **Its fingerprint** comes from the host unless `DATA_DIR` (`/var/lib/beszel-agent`) persists it, and a changed one is refused (from the source, not tested across a reboot).
   - **Memory after 5.5 minutes:** hub 10.8 MiB, agent 6.5 MiB, proxy 12.0 MiB.
3. **Alloy v1.21.2, unprivileged:**
   - **How it ran:** `read_only`, `cap_drop: ALL`, `no-new-privileges`, a 192 MB limit and `GOMEMLIMIT` at 153 MiB.
   - **Storage:** the image's `/var/lib/alloy` belongs to uid 473, so root without capabilities can't write it. `--storage.path=/var/lib/opscrew-alloy` on a fresh volume works, with `tmpfs: [/tmp]`.
   - **Docker access:**
     - `discovery.docker` also needs `GET /networks`.
     - `loki.source.docker` stops without `/containers/{id}/json`: the tailer inspects first.
     - With `/networks`, `json` and `logs` allowed, only the filtered Compose project was tailed, labelled `app`, `env` and `service`, with no repeats after a restart.
   - **Masking, 774 lines checked:**
     - a fake GitHub token arrived as `<opscrew:github-token>` (`stage.replace`);
     - a fake AWS key arrived as `<secretfilter:aws-access-token>`;
     - the known value arrived as `<opscrew:known-value>`;
     - none arrived unmasked.
   - **Known values from a file:**
     - `local.file` with `is_secret` can't be passed as a string; `convert.nonsensitive(local.file.mask.content)` can.
     - A write in place takes effect in about 7 s. A replace by rename can take up to the poll interval, so `poll_frequency = "10s"`.
     - After `nonsensitive`, the values show in Alloy's own API on `127.0.0.1:12345`.
   - **Metrics:**
     - Inside a container, `/proc` already gives the server's CPU, load and memory. Only `/` (as `rootfs_path`) and `/sys` need mounting, read-only.
     - `netdev` sees only the container's own network unless Alloy uses the host's.
     - `filesystem { mount_points_exclude = "^/.+" }` keeps only `/`.
     - The series: 8 CPUs × 5 modes + 3 load + 2 memory + 2 filesystem (+ 2 per interface on the host network) = 47–51. A 2-CPU server sends 17.
   - **Memory:** 70–79 MiB after 3–5 minutes with logs, metrics and `loki.secretfilter`.

4. **The check key:**
   - **Setup:** two sshd containers, one per OpsCrew setting:
     - Ubuntu 24.04 (OpenSSH 9.6p1) with the cloud-init drop-in (`AllowUsers deploy`, `MaxAuthTries 3`);
     - Debian 13 (OpenSSH 10.0p2) with the own-server drop-in.
   - **The line that works:** `restrict,command="df -P -B1 /" ssh-ed25519 AAAA… opscrew-check` in `deploy`'s `authorized_keys`.
   - **Other commands:** no command, `bash`, `rm -rf /tmp/x` and `cat /etc/passwd` all print only the `df` table, exit 0. `/tmp/x` is untouched.
   - **What fails:**
     - `-tt`: "PTY allocation request failed";
     - `-L`: "administratively prohibited";
     - `-W`: fails;
     - `-R`: nothing listens on the server;
     - `scp` and `sftp`: no file moves either way.
   - **No conflict with OpsCrew's settings:** `sshd -T` shows no `ForceCommand` and `AuthenticationMethods any`.
   - **The ordinary deploy key** beside it works as before.
   - **Not covered:** a user's own `ForceCommand` or `AllowUsers` on an own server would override or block it. OpsCrew sets neither.
7. **Portainer CE 2.45.2** (the pinned image), with an admin's token and a standard user's (`ptr_…`, `X-API-Key`):
   - **Logs:**
     - A container without a TTY answers `application/vnd.docker.multiplexed-stream`, with 8-byte frames of types 1 and 2. A TTY container answers `application/vnd.docker.raw-stream`, CRLF included.
     - **`follow=1` doesn't stream:** Portainer buffers it. The first bytes arrive after 42–44 s, in one burst of about 4 KiB, on 5 runs with both tokens. Closing the client does end it.
     - **Polling works:** `since=<seconds>.<nanoseconds + 1>`, from the last line's timestamp, answers in 80–220 ms with no repeated line. Millisecond precision repeats the last line.
   - **Stats:**
     - `stream=false` takes 1.0–1.9 s with `precpu_stats` filled;
     - `one-shot=true` takes under 70 ms with `precpu_stats` empty, so no CPU figure;
     - `inactive_file` is present.
   - **Inspect:** gives `RestartCount`, `State.StartedAt` and `HostConfig.Memory`, and also `Config.Env`.
   - **`/info`:** gives `NCPU` and `MemTotal` with either token.
   - **A standard user's token:**
     - reads logs, stats, inspect and `/info` for its own stacks' containers;
     - gets 403 "access denied to resource" for another user's stack or a container made with the Docker CLI;
     - `containers/json` lists only its own containers (2 where the admin saw 22).
8. **Following over SSH:**
   - **Setup:** Node spawned `ssh`, as `NodeCommandRunner` does (detached, stdin ignored), then stopped it with SIGTERM and with SIGKILL to the process group.
   - **Without `-tt`,** the remote process is orphaned to PID 1 and ends only when it next writes (SIGPIPE).
     - A quiet follower (`docker logs -f` on a silent container) stays running.
     - `ServerAliveInterval` doesn't help.
   - **With `-tt`,** it always ends, but the output has CRLF and stderr merged into stdout.
   - **Watching the parent ends it within about 1 s** on both OpenSSH versions, keeps stdout and stderr apart, and passes the follower's own exit code through: `<follow> & p=$!; while kill -0 $PPID 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null; wait $p`.

**What this changes:**
- **The proxy container:**
  - it gains `cap_add: [NET_BIND_SERVICE]`, `tmpfs: [/data, /config]` and `network_mode: none`;
  - Alloy's list adds `GET /networks` and `/containers/{id}/json`. Inspect is allowed: Alloy already holds the app's values for masking, so hiding the containers' environment from it would gain nothing.
- **Beszel:**
  - OpsCrew generates the hub's key;
  - `DOCKER_IMAGE_CHECK=false` and a `DATA_DIR` volume go on the agent;
  - `DISABLE_SSH=true` goes on both.
- **Alloy:**
  - It stays on its own network, without network figures, so its local API (which shows the masking values) is reachable only inside its container. Spec SC-1707 asks only for CPU, memory and disk.
  - Its flags: `--storage.path=/var/lib/opscrew-alloy` on a volume, and `--disable-reporting`.
  - Its mounts: `/` and `/sys`, read-only.
  - The masking file is read with `poll_frequency = "10s"`. With no values, it holds a pattern that never matches (`[^\s\S]`).
- **Memory defaults:**
  - Beszel's 128/64/32 stand;
  - Alloy's 192 stands;
  - Alloy's proxy shares the 32.
- **Portainer's `--follow`** polls with nanosecond `since`. Stats never use `one-shot`.
- **A standard user's token sees only that user's stacks,** so `status` and `logs` say so when the app's containers aren't visible to it, rather than calling them absent.
- **SSH's `--follow`** runs `docker logs --follow` inside the parent-watching wrapper above.
- **R3 holds as designed.**
