# Implementation Plan: Observability, light and free: logs, resource figures, alerts, and two opt-in add-ons

**Branch**: `main` | **Date**: 2026-10-28 | **Spec**: `specs/017-observability/spec.md`
**Research**: `specs/017-observability/research.md` (R1–R8, open items 1–8 for the spike)

The founder gave the go-ahead for the plan, tasks and implementation on 2026-10-28.

## Summary

Four ways to see an app once it is live. Nothing new runs on the server unless the user turns an add-on on.

**`opscrew logs`** (US1)
- The app's lines on every target, through the read paths `status` already uses:
  - fixed `docker logs` commands over SSH;
  - Docker's API through the Portainer;
  - local Docker;
  - Cloudflare's query and tail APIs.
- GitHub Pages, and a static site on Cloudflare, have no request logs. `logs` says so and shows the last deploys.
- Every line passes through the redactor, with the app's known secret values registered first.

**Resource figures in `opscrew status`** (US2)
- Read when the command runs:
  - the server's load, memory and disk;
  - each container's CPU and memory against its limit, restarts and uptime;
  - on Cloudflare, the last day's requests, errors and CPU time against the free plan.
- Thresholds are flagged with what to do.
- `status` also shows the scheduled check's state.

**The scheduled check** (US3)
- **The files:** one workflow per repository, a vendored Node script with no dependencies, and generated JSON listing what to check. They come in the deploy-setup pull request.
- **What it checks:** each hostname's health path over HTTPS, its certificate, and each server's disk.
- **The alert:** a GitHub issue per failing check, opened, commented on change, and closed with the duration. Optionally a Slack, Discord or ntfy post too.
- **Reaching the disk:** with a key the server lets run only `df`.
- **Planned outages:** retarget and destroy pause the check through a repository variable.

**Two opt-in add-ons on servers** (US4, US5)
- **Beszel:** the dashboard and agent, or only the agent connected out to the user's own hub.
- **Grafana Alloy:** sends masked logs and a few server metrics to the user's Grafana Cloud free stack.
- **How they're added:** each through a host plan approved by its hash, as Portainer's web UI is (009), with its memory limit and price share shown.
- **Docker access:** each reads Docker through an OpsCrew-rendered Caddy that passes only `GET` on an allow-list of paths.

**In Claude Code** (US6)
- A read-only `opscrew_logs` tool, bounded and masked.
- The figures in `opscrew_status`.
- A skill for "why is it failing" and "how much does it use".

## Technical Context

- **Stack:** the same as 000–016.
  - **No new npm dependency** in OpsCrew.
  - The tail uses Node's built-in `WebSocket` (Node ≥ 22).
  - The check script uses only Node's built-ins on GitHub's runner.
- **External images and actions, pinned in `pins.ts`:**
  - `henrygd/beszel` and `henrygd/beszel-agent` (v0.21), and `grafana/alloy` (v1.21), each by digest;
  - Caddy, `actions/checkout` and `actions/setup-node`, already pinned;
  - `update-pins.mjs` learns the new images.
- **API calls:**
  - **Cloudflare (typed connector):**
    - the Workers Observability query;
    - the Tail API (create a tail, then read its WebSocket);
    - the GraphQL Analytics API (`workersInvocationsAdaptive`);
    - the permission check for each.
  - **GitHub (typed connector):**
    - the check workflow's state;
    - open issues by label;
    - repository variables (get, set and delete);
    - `has_issues`;
    - the account's plan, for included minutes.
  - **Portainer (typed connector):**
    - container logs (demultiplexed);
    - stats;
    - inspect (only `RestartCount`, `StartedAt` and the memory limit are kept);
    - `/info`.
  - **Servers:** fixed read commands over `SshRemoteExec`, which gains streaming for `--follow`.
- **Token permissions, only when used:**
  - **Cloudflare:** Workers Tail Read, Workers Observability (spike item 6) and Account Analytics Read.
  - **GitHub:**
    - Issues: Read (status);
    - Actions: Read (the check's state);
    - Variables: Read and write (the pause), named by `GITHUB_TOKEN_PERMISSIONS`.
  - **Grafana Cloud:** an access policy token with only `metrics:write` and `logs:write`, created by the user.
- **To verify in the spike** (T1702): research's open items 1–8.
- **Tests:**
  - fakes for the new connector methods;
  - the check script run in Vitest with injected `fetch`, `ssh` and clock;
  - snapshots of the workflow, the add-on Compose files, the Caddy proxy config and the Alloy config;
  - the Docker pass (T1713): the proxy refusing what's off its list, Beszel and Alloy through it, and the forced-command key;
  - gated live tests (T1714): the check opening and closing an issue on the throwaway repository, the add-ons on an e2e server, and Cloudflare's logs.

## Constitution Check

- **I (safety gate):**
  - **Reading changes nothing:** `logs`, `status` and the MCP tools only read (FR-1703).
  - **Server changes:**
    - the check key, Beszel and Alloy on a server are host plan steps, approved by hash (`host-apply`);
    - a Beszel dashboard at a hostname also needs the IaC plan (`iac-apply`) and the shared Access rules (`cloudflare-apply`), as Portainer's does.
  - **GitHub changes:**
    - the check's files come in the deploy-setup pull request (`pull-request`), with the plan that shows the interval, the checks and the cost;
    - the check's secrets go through `github-secrets`;
    - the pause variable is a repository setting (`github-settings`), set by retarget and destroy inside their own approved flows.
  - **Turning an add-on off** removes everything it added, its data included, after a teardown plan approved by hash with `allowDestroy` and the typed app name. `--keep-data` keeps Beszel's dashboard history (spec US4 #5).
  - **No new approval kind.**
- **II (user owns everything):**
  - The workflow, the script, its JSON, the add-on Compose files, the proxy config and the Alloy config are plain files.
  - The check keeps working without OpsCrew.
  - Beszel's data stays on the user's server, and Grafana Cloud's in the user's account.
- **III (dual engine):** the only HCL change is Beszel's Access application in the existing `cloudflare-access` module, validated under both engines. No new module.
- **IV (secrets):**
  - **Where lines are masked:**
    - in the terminal, in MCP answers, and in Alloy before they leave the server, which uses `loki.secretfilter`, OpsCrew's patterns and the app's known values;
    - issues and webhook posts never carry what the app returns (R4).
  - **What is secret, and where it is kept:**
    - the check key, the webhook address, Beszel's token and password, and the Grafana Cloud token;
    - kept in GitHub secrets, in root-only files on the server, and in the recovery copy;
    - never in a plan, a committed file, a log or an audit entry.
  - Server addresses stay out of the committed check config (R3).
- **V (deterministic first):** everything here is deterministic code: the check, the thresholds, the cost, the estimates and the renderers. No model.
- **VI (contracts first):** one serial task (T1701a), recorded in ADR 0021:
  - plan-schema's `observability` block;
  - `RemoteExec`'s streaming options.
- **VIII (typed adapters):**
  - Reads go through the typed connectors and fixed commands.
  - Server changes go through the host adapter.
  - The variable and secrets go through the GitHub connector.
- **IX (plain language):**
  - the check's cost in minutes against the plan;
  - GitHub's 60-day rule;
  - what each target can't give (Portainer's host disk; logs on GitHub Pages and on a static site on Cloudflare);
  - Cloudflare's dated allowance;
  - the free tiers' limits.
- **X (simplicity):**
  - No monitoring stack.
  - One check per repository, and one job on GitHub's runners.
  - Caddy, already pinned, as the proxy.
  - Three new images, each opt-in.

## Project Structure

```text
packages/plan-schema/src/        observability: check, beszel, grafanaCloud (T1701a)
packages/contracts/src/io.ts     RemoteExec.run: onLine, signal (T1701a)
packages/connectors/
  cloudflare/                    workersLogs (query), workersTail, workersAnalytics, their permissions
  github/                        workflowState, openIssues, repo variables, hasIssues, plan minutes
  portainer/                     containerLogs (demux), containerStats, containerInspect (picked fields)
  ssh-host/                      host steps check-key, beszel, alloy; their secrets on stdin
packages/iac-templates/src/
  check/                         check.mjs (vendored), renderCheck (workflow + check.json)
  addons/                        Beszel and Alloy Compose, the Caddy Docker proxy, config.alloy
  workflow/                      the deploy job's masking file, only when Alloy is on
  pins.ts                        beszel, beszelAgent, alloy
packages/agents/src/
  logs/                          readLogs per target, the line format, follow
  status/                        resource figures, thresholds, the check's state
  shared/                        remote streaming, registerAppSecrets
  check/                         check settings, cost, files for provision, the pause
  addons/                        enable/disable/status/open, memory and price, Grafana estimate
  design/, provision/, retarget/, destroy/   the check's seams
packages/cli/src/commands/       logs.ts, addon.ts; status output
packages/mcp-server/src/tools/   logs.ts; status data
plugin/skills/opscrew-troubleshoot/
docs/guide/                      logs-and-status.md, alerts.md, beszel.md, grafana-cloud.md, index.md
```

## Design

### 1. Contracts and plan (T1701a, serial, lead-reviewed)
- **`plan.observability`** (data-model.md):
  - **`check`:**
    - `enabled`: design defaults it to on for prod, off elsewhere;
    - `intervalMinutes` (5, 10, 15, 20, 30 or 60) and `webhook` (`slack`, `discord` or `ntfy`): repository-wide, read from the first app's prod plan only, and refused in any other plan (agents' check, with the fix).
  - **`beszel`:**
    - `enabled`, `version` and `mode` (`hub` or `agent`);
    - `access` (`local` or `subdomain`), with `hostname` and `allowedEmails` as Portainer's;
    - `hubUrl` and `hubKey` for agent mode;
    - `memoryMb` per container.
  - **`grafanaCloud`:**
    - `enabled` and `version`;
    - `metrics { url, user }` and `logs { url, user }`;
    - `logSampling` (1 to 100 percent, default 100);
    - `memoryMb`.
  - **Refusals:**
    - Beszel and Grafana Cloud only on the cloud and own targets (`onServer`);
    - the check refused on localhost;
    - every refusal with a plain reason.
- **`RemoteExec.run`'s options** gain `onLine(stream, line)` and `signal`, as `CommandRunner.run` has. Every implementation and fake keeps working without them.
- **ADR:** 0021.

### 2. Pins (T1701b)
`beszel`, `beszelAgent` and `alloy` in `IMAGES`, by digest, refreshed by `update-pins.mjs`.

### 3. The spike (T1702, lead)
Research's open items 1–8, on an e2e server, the throwaway repository and the e2e Cloudflare account. The results go into `research.md` "Spike results" before wave 2. A finding that changes the design goes into this plan first.

### 4. Connectors (T1703 Cloudflare, T1704 GitHub, T1705 Portainer, T1706 ssh-host)
- **Cloudflare:**
  - **`workersLogs(accountId, worker, { from, to, limit })`:** the query API. Each event becomes `{ time, level, message, status?, outcome?, error? }`.
  - **`workersTail(accountId, worker, { signal, onEvent })`:** creates the tail, reads its WebSocket and deletes the tail when stopped.
  - **`workersAnalytics(accountId, worker, since)`:** requests, errors, and CPU time p50 and p99.
  - **`CLOUDFLARE_OBSERVABILITY_PERMISSIONS`** and a check that names each missing one.
- **GitHub:**
  - `checkWorkflowState(owner, repo, file)`;
  - `openIssues(owner, repo, label)` (pull requests skipped);
  - `getRepoVariable`, `setRepoVariable` and `deleteRepoVariable`;
  - `getRepo` gains `hasIssues`;
  - `includedMinutes(owner)` from the account's plan;
  - `GITHUB_TOKEN_PERMISSIONS` gains Issues: Read and Variables: Read and write, used only with the check.
- **Portainer:**
  - **`containerLogs(envId, id, { tail, since, timestamps })`:** demultiplexes Docker's framing, and passes a TTY container's stream as it is.
  - **`containerStats`:** one sample with `precpu_stats` filled.
  - **`containerInspect`:** validates and keeps only `RestartCount`, `State.StartedAt` and `HostConfig.Memory`.
  - **`dockerInfo`:** gains `NCPU` and `MemTotal`.
- **ssh-host:**
  - **Host steps:**
    - `check-key`: the check's public key in the deploy user's `authorized_keys` with `restrict,command="df -P -B1 /"`; removed on teardown;
    - `beszel` and `alloy`: their Compose files under `opscrew/addons/<name>`, as Portainer's are; started, and removed on teardown with their data, unless the user keeps Beszel's.
  - **`ApplyOptions.secrets`** gains `beszelPassword`, `beszelToken` and `grafanaCloudToken`, sent on stdin.
- Every answer is validated with zod.

### 5. The check (T1707)
- **`check.mjs`:** vendored and the same for everyone.
  - **Each environment in `check.json`:**
    - each hostname's health path over HTTPS, with a 10-second timeout, retried three times, 30 seconds apart, before a failure;
    - the certificate's days left, below 14 counting as a failure;
    - the disk over SSH with the check key, or locally, at 85% (warning) and 95% (high).
  - **Issues:**
    - found by label and marker;
    - one per failing check (key `<app>/<env>/<check>/<host or server>`);
    - a comment only when the failure changes;
    - closed with the duration.
  - **The webhook:** the same text, cut to each service's limit.
  - **Planned outages:** `vars.OPSCREW_CHECK_PAUSED`, a JSON map of `<app>/<env>` to a reason. Paused environments are skipped, and their open issues are closed with the reason.
  - **GitHub's 60-day rule:** in a public repository, from day 50 without a commit on the default branch, an issue says GitHub turns scheduled checks off after 60 days, and how to keep this one running.
  - **Issues off (410):** the webhook is posted, the job summary written, and the run fails.
  - Everything it needs is injected, so Vitest runs it.
- **`renderCheck(plans, repo)`** writes the workflow and `check.json` from every app's and environment's plan:
  - **The schedule:**
    - the interval, at a minute derived from the repository's name, never `:00`;
    - `workflow_dispatch`.
  - **Permissions:** `contents: read` and `issues: write`.
  - **A guard:** `if: github.repository == '<owner>/<repo>'`.
  - **The jobs:**
    - **`check`:** one job on `ubuntu-slim` (or `ubuntu-latest`, as the spike settles), 5-minute timeout. It runs the HTTPS checks for everything, and the disk of every server reached over SSH from GitHub.
    - **One job per server deployed from its own runner,** or from a runner host. It runs `setup-node` and the disk check there, with job-level `concurrency`.
  - **The environment variables:** `env:` names each environment's `<prefix>CHECK_SERVER` secret and `OPSCREW_CHECK_SSH_KEY`, and the webhook secrets when set.
  - **`check.json`:** holds names, hostnames, health paths, the server's id and which secret has its address. Never an address.

### 6. Add-on renderers and the masking file (T1708)
- **The Docker proxy:**
  - a Caddyfile listening on `unix//run/opscrew-docker-ro/docker.sock`;
  - only `GET` on the add-on's allow-list (R5) goes through to `unix//var/run/docker.sock`, and everything else answers 403;
  - streaming passed through (`flush_interval -1`);
  - the container runs with `read_only`, `cap_drop: ALL`, `no-new-privileges` and a memory limit.
- **Beszel:**
  - **Hub mode:**
    - the hub on `127.0.0.1:8090`, with `USER_EMAIL`, `USER_PASSWORD` from a root-only env file, `CONTAINER_DETAILS=false` and `DOCKER_IMAGE_CHECK=false`;
    - `config.yml` declaring the server with OpsCrew's token;
    - the agent with `HUB_URL=http://127.0.0.1:8090`, `TOKEN`, `KEY` and `DISABLE_SSH=true`, on the host network, its `DOCKER_HOST` the proxy's socket.
  - **Agent mode:** only the agent and the proxy, `HUB_URL` the user's hub.
- **Alloy:**
  - **`config.alloy`:**
    - `discovery.docker` and `loki.source.docker` through the proxy, for the app's Compose project only;
    - labels `app`, `env` and `service`;
    - `loki.process` with `loki.secretfilter`, `stage.replace` from OpsCrew's token patterns, the known-values file, and `stage.sampling` when `logSampling` is below 100;
    - `prometheus.exporter.unix` with `/proc`, `/sys` and `/` read-only under `/host`, its collectors limited, and `prometheus.relabel` keeping the allow-list;
    - `loki.write` and `prometheus.remote_write` with basic auth, the token from a root-only file.
  - **`GOMEMLIMIT`** at 80% of the limit.
- **Beszel at a hostname:** `cloudflare-access` gains Beszel's Access application next to Portainer's, and `infra/tunnel.ts` routes the hostname to the hub. Without it, the HCL is byte-identical.
- **The masking file:** when Grafana Cloud is on, the deploy job writes `/srv/apps/<app>/mask.re` (root-only) from `app.env`'s values, as the spike settles. Server workflows without Grafana Cloud stay byte-identical (snapshots). The file holds the same values as `app.env`, root-only on the server, and is never committed.

### 7. Agents: logs and figures (T1709)
- **`readLogs(deps, plan, { service, since, tail, follow })`**, per target as in the Summary.
  - **Lines:** `<time> <service> <text>`, newest last, 200 by default.
  - **Services:** the web process, each worker, each cron job, each service, and `edge`. The shared edge's lines are named as shared. Any other name is refused with the list.
  - **The first line** says how far back the lines go: each deploy starts fresh, and each container keeps 30 MB.
  - **Following:**
    - over SSH, streaming;
    - in a Portainer, polling with `since`, or streaming as the spike settles;
    - on Cloudflare, the tail.
  - **No request logs:** on GitHub Pages and a static site on Cloudflare, the sentence and the last deploys.
- **`registerAppSecrets(deps, plan)`:** registers the app's known values, as provision does. `logs`, `status` and the MCP tools call it, and provision moves to it.
- **The figures, in a `ResourceReading`:**
  - **On servers, one fixed command (R1):**
    - project names are checked before they reach the command;
    - the output is parsed with zod;
    - the read is audited as `remote-exec`.
  - **Flags:** memory at 90% of a limit, the disk at 85% and 95% (`diskUsage`'s thresholds, exported from secops), and a restart since the last deploy. Each says what it means and what to do.
  - **Portainer:** the host's disk is named as not available.
  - **Cloudflare:** the last 24 hours against 100,000 requests a day and 10 ms of CPU. Asset requests aren't counted, and status says so.
  - **GitHub Pages:** the latest build, as today.
- **The check's state in `status`:**
  - on, off by GitHub's inactivity rule (with how to turn it on), or not set up;
  - the open alert issues, with links.

### 8. Agents: the check (T1710)
- **Design:**
  - **What it shows:**
    - the check per environment;
    - the interval;
    - the minutes a month against the repository's plan (FR-1710).
  - **The default interval:** 15 minutes when public, 60 when private, and never more than 750 minutes a month on GitHub Free.
  - **What it says:**
    - when issues are off;
    - when a target has no disk check (Portainer, Cloudflare, GitHub Pages);
    - that localhost gets no check.
- **Provision:**
  - **The check key:** generated once per repository (`~/.opscrew/projects/<id>/check_key`, in the recovery copy), and added to the server by the `check-key` host step.
  - **The secrets** (`github-secrets`): `OPSCREW_CHECK_SSH_KEY`, the environment's `<prefix>CHECK_SERVER` (address, port, host key), and the webhook's address when set, asked like an app secret.
  - **The files** (`renderCheck`) go into the deploy-setup pull request, re-rendered from every plan.
  - **Its pause** is cleared after a healthy deploy.
- **Retarget:** sets the environment's pause when the window opens, and clears it at `--finish`.
- **Destroy:** sets it, with the reason "destroyed". The next deploy-setup pull request drops the environment from `check.json`.

### 9. Agents: add-ons (T1711)
- **`addonEnable`, `addonDisable`, `addonStatus` and `addonOpen`, for `beszel` and `grafana-cloud`,** as Portainer's command flow is:
  - the plan is written;
  - the host plan is shown with each container's memory limit and its share of the monthly price, and approved by hash;
  - the secrets are sent on stdin;
  - the result is recorded.
- **Beszel:**
  - **Hub mode:** generates the password and the token (in the recovery copy).
  - **Agent mode:** asks for the hub's address, its public key and the token.
  - **`open`:** runs the SSH tunnel to `127.0.0.1:8090` until stopped, and prints the address.
  - **`subdomain`:** goes through Portainer's tunnel and Access path.
- **Grafana Cloud:**
  - asks for the stack's four values and the token, naming the token's two scopes and where to create it;
  - reads the series and log estimates (R7), and shows them against the free tier before any change;
  - the token is kept in a new recovery-copy entry.
- **Memory:** `appMemoryLimits` and design's memory line count enabled add-ons.
- **One of each per server:** on an own server with several apps, the add-on belongs to the app that turned it on. Another app's `enable` is refused with the reason (data-model.md).

### 10. Surfaces (T1712a CLI, MCP and plugin; T1712b the guide)
- **The CLI:**
  - **`opscrew logs`:** `--follow`, `--service`, `--since <duration>`, `--tail <lines>`, `--app` and `--env`.
  - **`opscrew addon enable|disable|status|open <beszel|grafana-cloud>`:** `--mode`, `--hub-url`, `--access`, `--hostname`, `--allow-email`, `--keep-data` and `--confirm <app>`.
  - **`status`:** prints the figures and the check's state.
  - `ALL_COMMANDS` grows to 25.
- **MCP:**
  - **`opscrew_logs`:** read-only, at most 500 lines and 64 KiB, with no follow, redacted.
  - **`opscrew_status`'s data** gains `resources` and `check`.
- **The plugin:** a skill, `opscrew-troubleshoot`, for errors, slowness and resources, using these tools.
- **The guide:**
  - `logs-and-status.md`, `alerts.md`, `beszel.md` and `grafana-cloud.md`, each saying what it can't do;
  - the index, and the runbook's lines for the check and the add-ons.

### 11. The Docker pass (T1713, `OPSCREW_DOCKER_TESTS=1`)
- **The proxy:** passes the allow-list and refuses `POST`, `exec`, `archive` and `export`.
- **The add-ons:** Beszel's hub and agent, and Alloy (against a local Loki and Prometheus receiver), work through it and stay within their memory limits.
- **The check key:** sshd with the forced command answers `df` to any command.

### 12. Live tests and runs (T1714, T1715)
- **The check on the throwaway repository:** stop the e2e app, see the issue open, start it, see it close with the duration; the webhook to a test ntfy topic.
- **The add-ons on an e2e server:** Beszel in hub mode, then turned off, leaving nothing; Alloy reaching a Grafana Cloud free stack when its credentials are present.
- **Logs and status:**
  - `logs --follow` on a cloud server and on Cloudflare, within 10 seconds of a request;
  - `status`'s figures.
- **The leak search** with a seeded secret over:
  - the terminal output;
  - MCP's answers;
  - the issues;
  - the webhook posts;
  - Grafana Cloud's lines;
  - the audit log.

## Order

T1701a → T1701b → T1702 (spike) → {T1703, T1704, T1705, T1706, T1707, T1708} in parallel → {T1709, T1710, T1711} → {T1712a, T1712b, T1713} → T1714 → T1715 → T1716 (simplify pass).

## Complexity Tracking

None. No principle is bent:
- **The check key** adds a second key to servers, but one that can run only `df`, through a host plan approved by its hash.
- **The add-ons** read Docker through an exact `GET` allow-list instead of the socket, so FR-1713 holds. Each is opt-in and removable.
