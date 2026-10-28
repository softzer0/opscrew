# Feature Specification: Observability, light and free: logs, resource figures, alerts, and two opt-in add-ons

**Feature Branch**: `main` (feature directory `specs/017-observability`)
**Created**: 2026-10-24
**Status**: Draft
**Input**: The founder's scope, agreed on 2026-10-16 and kept in the roadmap of 2026-10-20: observability that is basic, light and free.
- `opscrew logs`;
- `opscrew status` with resource figures read on demand;
- uptime, health and low-disk alerts from a scheduled GitHub Actions check;
- opt-in Beszel on the server, and opt-in Grafana Alloy sending to Grafana Cloud's free tier, both light;
- no self-hosted Grafana, Prometheus or Loki stack;
- dashboards across several projects, team alerts and spend alerts belong to the later hosted control plane.

On 2026-10-24 the founder asked for this spec only, and on 2026-10-28 gave the go-ahead for the plan, tasks and implementation.

## Why

Once an app is live, its owner needs to answer three questions without logging in to a server:
- What is it saying? (logs)
- How is it doing? (resources)
- Is it up? (alerts)

Today OpsCrew answers none of them:
- `status` lists which containers run, but not how much memory, CPU or disk they use;
- there is no way to read the app's logs, short of an SSH session and the right `docker` command;
- nobody is told when the app stops answering or the disk fills up, until a visitor complains.

The usual answer is a monitoring stack: Prometheus, Grafana and Loki. That stack costs a small server's memory, and becomes one more thing to patch. OpsCrew's users are solo developers and small teams on small servers. They need the basics, for free, from the tools they already have: their terminal, GitHub, and optionally a light dashboard.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read the app's logs from the terminal (Priority: P1)

The user runs `opscrew logs` in the app's repository and sees the app's recent log lines, wherever it runs. They can follow new lines live, choose another part of the stack, such as a worker, the database or the reverse proxy, and limit the time span. They need no SSH command, container name or dashboard.

**Why this priority**: reading the logs is the first step whenever something goes wrong. Every target needs it, and it costs nothing.

**Independent Test**: deploy an example app on each target kind. `opscrew logs` shows the app's latest lines. `--follow` shows a request's line within seconds of the request, and `--service` shows a worker's or the database's lines. A secret the app prints appears masked.

**Acceptance Scenarios**:

1. **Given** an app on a cloud server or the user's own server, **When** the user runs `opscrew logs`, **Then** the app's last lines are shown, newest last, each with its time. `--follow` keeps showing new lines until the user stops it.
2. **Given** an app with workers, cron jobs or services, **When** the user names one with `--service <name>`, **Then** that part's lines are shown. A name that doesn't exist is refused, and the refusal lists the names that do.
3. **Given** an app in a Portainer or on the user's own computer, **When** the user runs `opscrew logs`, **Then** the lines come the same way: through the Portainer, or from local Docker.
4. **Given** a server-rendered app on Cloudflare's hosting, **When** the user runs `opscrew logs`, **Then** the logs of its recent requests are shown, with each request's status and any errors it raised. `--follow` shows requests as they arrive.
5. **Given** a site on GitHub Pages, or a static site on Cloudflare's hosting, **When** the user runs `opscrew logs`, **Then** OpsCrew says plainly that the host keeps no request logs for it, and shows the last deploy runs with their result and a link to each. Cloudflare serves a static site's files without running any of its code, so it logs no requests (research R2).
6. **Given** a log line that holds one of the app's secret values, or a value shaped like a known kind of secret, **When** the line is shown, **Then** that value is masked.
7. **Given** several apps or environments, **When** the user passes `--app` or `--env`, **Then** the lines are that app's and environment's, chosen the way every other command chooses them.

---

### User Story 2 - See how the server and the app are doing (Priority: P1)

The user runs `opscrew status`. Next to what runs, it now shows how the server and each part of the app are doing right now:
- the server's CPU load, memory and disk;
- each container's CPU and memory, against the limit OpsCrew gave it;
- each container's restarts.

The figures are read when the command runs; nothing runs on the server to collect them.

**Why this priority**: "the app is slow" and "the app keeps restarting" are the most common questions after "is it up". The answers are a single read away, and they tell the user whether to fix the code or resize the server.

**Independent Test**: on a deployed server app, `opscrew status` shows the server's load, memory and disk, and each container's CPU, memory and restarts. A container at 95% of its memory limit is flagged, and so is a disk 90% full.

**Acceptance Scenarios**:

1. **Given** an app on a server, **When** the user runs `status`, **Then** it shows the server's figures. Each is shown against its total: load against the CPU count, memory used of total, and disk used and free.
2. **Given** the same app, **When** the user runs `status`, **Then** each container shows its CPU, its memory against the limit OpsCrew set for it, its restart count and how long it has been running.
3. **Given** a figure past its threshold, **When** `status` shows it, **Then** it is flagged with what it means and what to do. The thresholds:
   - memory above 90% of a container's limit;
   - a disk 85% full, or 95% for the higher severity, the same as `secure`;
   - a container that restarted since the last deploy.
4. **Given** an app in a Portainer, **When** the user runs `status`, **Then** each container's figures are shown through the Portainer. Figures the Portainer can't give (the host's disk) are named as not available.
5. **Given** an app on Cloudflare's hosting, **When** the user runs `status`, **Then** it shows the last 24 hours' requests, errors and CPU time per request, against the free plan's daily request limit and CPU time per request. Requests served from a site's static files run no code and aren't counted; status says so.
6. **Given** a site on GitHub Pages, **When** the user runs `status`, **Then** it shows the latest build and its result. Nothing else applies, and status says so.

---

### User Story 3 - Be told when the app is down or the disk is filling up (Priority: P1)

OpsCrew adds a scheduled check to the user's repository that runs in GitHub Actions. Every few minutes it checks that each of the app's hostnames answers its health check over HTTPS with a valid certificate, and that each server's disk has room. When something fails, the check opens a GitHub issue in the repository, so everyone watching it is told. It can also post to a chat webhook. When the app recovers, the check closes the issue and says how long the problem lasted. Nothing runs on the user's server and nothing is paid for: a public repository's Actions minutes are free, and in a private one the check stays within a small share of the included minutes.

**Why this priority**: being told first, before the users notice, is what observability is for. GitHub Actions is the one scheduler every OpsCrew user already has.

**Independent Test**: deploy an example with the check on. Stop the app: within one check interval, plus GitHub's scheduling delay, an issue opens that names the app, the environment, the hostname and what failed. Start the app again: within one interval the issue closes with how long the app was down. Fill the disk past the threshold: an issue names the server and the free space.

**Acceptance Scenarios**:

1. **Given** a deployed environment, **When** the deploy-setup pull request is merged, **Then** the repository has the scheduled check. The user approved its interval and the checks it runs in the plan.
2. **Given** a hostname that doesn't answer its health check, **When** the check runs, **Then** it tries again a few times within the same run before it declares the app down. One slow answer opens no issue.
3. **Given** the app is declared down, **When** no issue is open for it yet, **Then** one issue opens, naming the app, the environment, the hostname, what failed and when. While the app stays down, later runs add nothing to the issue. Only a change, such as another check failing too, adds a comment.
4. **Given** an open issue, **When** the check passes again, **Then** the issue is closed with how long the problem lasted.
5. **Given** a server whose disk is past the threshold, **When** the check runs, **Then** an issue opens naming the server, its free space and what usually fills it (old images, logs), with the command to see more.
6. **Given** a certificate that expires within 14 days, **When** the check runs, **Then** an issue says that its renewal is failing, with the command to see why.
7. **Given** the user has set a chat webhook (Slack, Discord or ntfy), **When** an issue opens or closes, **Then** the same message is posted there. The webhook's address is a secret in GitHub, never in a file.
8. **Given** a public repository with no commits for 50 days, **When** the check runs, **Then** it warns, in an issue, that GitHub turns scheduled checks off after 60 days without activity. The issue says how to keep the check running. `status` shows when GitHub has turned the check off, and how to turn it back on.

---

### User Story 4 - A light dashboard on the server: Beszel (Priority: P2)

A user who wants charts and history turns on Beszel for a server. OpsCrew adds Beszel's light agent to the server, and its dashboard either on the same server or pointed at a Beszel the user already runs elsewhere. The user then sees CPU, memory, disk, network and each container's use over time, and can set Beszel's own alerts from its dashboard.

**Why this priority**: history and charts are useful but not essential. The scheduled check and `status` cover the basics, so this is opt-in.

**Independent Test**: turn on Beszel for a deployed server, with its plan approved by hash. The dashboard opens through an SSH tunnel and shows the server and its containers, using no more memory than design showed. Turning it off removes everything it added.

**Acceptance Scenarios**:

1. **Given** a deployed server, **When** the user turns Beszel on, **Then** the plan shows what will be added (the agent, and the dashboard or the link to an existing one), its memory limit and its share of the monthly price. Nothing changes until that plan's hash is approved.
2. **Given** the dashboard runs on the server, **When** the user opens it, **Then** it is reachable only through an SSH tunnel that OpsCrew opens, by default. Optionally it gets a hostname behind a login that only listed email addresses can pass, as Portainer's web UI does.
3. **Given** the user already runs a Beszel dashboard elsewhere, **When** they turn Beszel on with its address, **Then** only the agent is added, and it connects out to that dashboard. Its credentials are kept as secrets.
4. **Given** Beszel runs, **When** it reads the containers, **Then** it can only read them. It cannot start, stop or change any container.
5. **Given** Beszel is on, **When** the user turns it off, **Then** everything it added is removed after a plan approved by its hash. The dashboard's data is kept only if the user asks.

---

### User Story 5 - Logs and metrics in Grafana Cloud's free tier (Priority: P3)

A user who wants searchable logs and longer history, without running a monitoring stack, connects Grafana Cloud's free tier. OpsCrew adds Grafana Alloy, a light collector, to the server. Alloy sends the app's logs and the server's metrics to the user's Grafana Cloud account, where the user searches and charts them for 14 days.

**Why this priority**: a smaller group of users wants it; they already use Grafana or need log search across days. The free tier makes it cost nothing.

**Independent Test**: create a Grafana Cloud free account and an access token that can only write metrics and logs. Turn the add-on on for a deployed server. Within 5 minutes, the app's log lines and the server's CPU, memory and disk appear in Grafana Cloud. A secret the app prints arrives masked.

**Acceptance Scenarios**:

1. **Given** a Grafana Cloud account, **When** the user turns the add-on on, **Then** OpsCrew asks for the stack's addresses and an access token. It says exactly which permissions the token needs (write metrics, write logs) and where to create it. The token is kept as a secret on the server and in the recovery copy, never in a file in the repository.
2. **Given** the plan, **When** the user reviews it, **Then** it shows Alloy's memory limit and price share, and what is sent. It also shows the free tier's limits next to OpsCrew's estimate of the app's metric series and monthly log volume.
3. **Given** Alloy runs, **When** the app writes a log line, **Then** the line reaches Grafana Cloud with the app's, environment's and service's names. Values shaped like known kinds of secret are masked before they leave the server.
4. **Given** Alloy runs, **When** it reads the containers, **Then** it can only read them, as Beszel can.
5. **Given** the add-on is on, **When** the user turns it off, **Then** everything it added on the server is removed, its secret included, after a plan approved by its hash. The data already in Grafana Cloud stays there under the user's account.

---

### User Story 6 - The same from Claude Code (Priority: P2)

A user working in Claude Code asks "why is my app failing?" or "how much memory does it use?". The OpsCrew plugin answers from the same logs and figures, through read-only tools, with secrets masked before anything reaches the model.

**Why this priority**: the plugin is how many users run OpsCrew. Reading logs and figures is the most common question it would be asked.

**Independent Test**: in Claude Code with the plugin, ask for the app's recent errors and its memory use. The answers match `opscrew logs` and `opscrew status`. A secret the app printed never appears in the conversation.

**Acceptance Scenarios**:

1. **Given** the plugin, **When** the model asks for logs, **Then** a read-only tool returns at most a bounded number of recent lines, masked as in the terminal.
2. **Given** the plugin, **When** the model asks for status, **Then** the resource figures from US2 are part of the answer.

---

### Edge Cases

- **The server doesn't answer over SSH:** `logs` and `status` say so, and suggest `verify`. The scheduled check still reports the app down over HTTPS.
- **Deploys that reach the server through its own runner, with SSH from GitHub closed:** the disk check runs where the deploy job runs, so it needs no new way in.
- **Logs before the last deploy:** each deploy replaces the containers, and a server keeps logs only within the size limit OpsCrew sets for each container. `logs` says how far back its lines go. Grafana Cloud keeps 14 days, for users who need more.
- **Very chatty apps:** `logs` shows the last 200 lines by default, and `--since` and `--tail` change that. On Cloudflare, the free plan keeps 200,000 log events a day for 3 days until 2026-11-30, and from 2026-12-01 0.5 GB a day for 7 days (research R2). When an app goes past that, `logs` says lines are missing and why.
- **The app's own computer (localhost):** `logs` and `status` work against local Docker. The scheduled check doesn't apply, because GitHub can't reach the user's computer, and design says so.
- **A Portainer target:** `logs` and `status` read through the Portainer. The disk check, Beszel and Grafana Alloy are not offered in this version, and design says why.
- **GitHub Pages:** no runtime logs and no resource figures exist. The uptime and certificate checks apply.
- **Several apps and environments in one repository:** one scheduled check covers them all, so the Actions minutes don't multiply. Each issue names its app and environment.
- **A planned outage:** while OpsCrew moves an app (retarget's maintenance window) or destroys it, the check doesn't open an issue for it.
- **A fork of the repository:** GitHub keeps scheduled checks off in forks, so a fork opens no issues.
- **The repository's issues are turned off:** design says so, and the check then reports failure through its failed run and the webhook only.
- **A private repository on GitHub's free plan:** design shows the check's monthly minutes against the plan's included 2,000. With no payment method, GitHub stops jobs once the minutes run out; the check's default interval keeps it well within them.
- **A dashboard at a hostname:** it needs the same Cloudflare login as Portainer's web UI, and an email list. Design refuses a public dashboard with no login.
- **Grafana Cloud's free limits:** when the estimated metric series or monthly log volume pass the free tier's limits, design says so before any change. It offers fewer metrics or sampled logs.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-1701**: `opscrew logs` MUST show the app's log lines on every target, with `--follow`, `--service <name>`, `--since <duration>` and `--tail <lines>`, and with `--app` and `--env` as every command has them:
  - cloud and own servers, through the same read-only access `status` already uses;
  - a Portainer, through its API;
  - the user's computer, through local Docker;
  - Cloudflare's hosting, through Cloudflare's logs of a server-rendered app's requests, past and live; a static site has the last deploys instead, as GitHub Pages does;
  - GitHub Pages, which has no request logs: the last deploy runs instead, and a plain sentence saying so.
- **FR-1702**: Every log line OpsCrew shows, returns or sends MUST pass through the redactor first. The app's known secret values, and values shaped like known kinds of secret, MUST be masked (constitution IV). This covers lines shown in the terminal, returned by MCP, written in issues, posted to webhooks or shipped to Grafana Cloud.
- **FR-1703**: Reading logs and figures MUST change nothing on any target. On servers it MUST use only fixed, read-only commands. It MUST NOT add a way for any caller to run arbitrary commands on the server.
- **FR-1704**: `opscrew status` MUST show the resource figures of US2 for every target that has them, read when the command runs, each against its total or limit. It MUST flag the thresholds of US2 with what they mean and what to do, and MUST name the figures a target can't give.
- **FR-1705**: OpsCrew MUST add a scheduled check to the repository through the deploy-setup pull request, for the environments the plan turns it on for. Its interval and checks are part of the plan the user approves:
  - each hostname's health check over HTTPS;
  - the certificate's remaining days;
  - each server's free disk.
  One check MUST cover every app and environment in the repository.
- **FR-1706**: The check MUST declare a failure only after retrying within the same run. Its issues MUST behave as in US3:
  - one open issue per failing check, with no repeated comments while nothing changes;
  - closed on recovery, with how long the problem lasted;
  - labelled so the user and OpsCrew can find them.
- **FR-1707**: An optional chat webhook (Slack, Discord or ntfy) MUST receive the same messages. Its address MUST be stored only as a GitHub secret, through the typed GitHub adapter, never in any file, plan, log or audit entry.
- **FR-1708**: The check MUST warn about GitHub's 60-day inactivity rule in a public repository from day 50, and `status` MUST show when GitHub has turned the check off, with how to turn it on again.
- **FR-1709**: The check MUST NOT open issues for an environment while OpsCrew's own planned work makes it unavailable (retarget's maintenance window, destroy).
- **FR-1710**: Design MUST show what the check costs in Actions minutes per month, against the repository's plan, and choose the default interval so that a private repository on GitHub's free plan uses at most 750 minutes a month.
- **FR-1711**: Beszel MUST be an opt-in add-on for cloud and own servers. It is added and removed through plans approved by their hash (constitution I), with its memory limit and price share shown, as components are. It runs in one of two ways:
  - with its dashboard on the same server, reachable through an SSH tunnel by default, or at a hostname behind the same login as Portainer's web UI;
  - with only its agent, connected to a dashboard the user already runs, whose credentials are kept as secrets.
- **FR-1712**: Grafana Alloy MUST be an opt-in add-on for cloud and own servers. It sends the app's logs and the server's metrics to the user's Grafana Cloud stack:
  - its token is stored as a secret on the server and in the recovery copy;
  - the token's required permissions are named;
  - the free tier's limits are shown next to OpsCrew's estimate before any change;
  - adding and removing it go through plans approved by their hash.
- **FR-1713**: Neither add-on MAY have write access to Docker or the host. Each reads containers' state, figures and logs through access that allows reading only. Each runs with a memory limit, from a pinned image, under the server's hardening.
- **FR-1714**: On Cloudflare's hosting, the deploy configuration MUST keep Cloudflare's request logs on, and `init` MUST check that the Cloudflare token can read them, naming the missing permission.
- **FR-1715**: The MCP server MUST offer the logs (a bounded number of lines, masked) and the resource figures as read-only tools. The plugin's skills MUST use them when the user asks about errors, slowness or resources.
- **FR-1716**: The user guide MUST have pages for:
  - logs and resource figures;
  - the scheduled check and its alerts: what it checks, what it costs, the inactivity rule and the webhook;
  - Beszel;
  - Grafana Cloud.
  Each page says what the feature can't do.

### Key Entities

- **Scheduled check:** per repository. Its interval; for each app and environment, the hostnames, health paths and servers it checks; its thresholds; and whether a webhook is set.
- **Alert:** a failing check on one app, environment and hostname or server. Kept as an open GitHub issue: when it started, what failed, the latest change, and how long it lasted once closed.
- **Resource figures:** a reading taken when a command runs. The server's load, memory and disk; each container's CPU, memory against its limit, restarts and uptime. On Cloudflare: requests, errors and CPU time per request for the last day.
- **Observability add-on:** Beszel or Grafana Alloy on one server. Each records whether it is on, its pinned version and memory limit, and how it is reached: the dashboard's access, or the Grafana Cloud stack's addresses. Its secrets are kept apart, never in the plan.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1701**: On each target kind (cloud server, own server, Portainer, the user's computer, Cloudflare's hosting with a server-rendered app), `opscrew logs` shows the app's latest lines within 10 seconds. With `--follow`, a request's line appears within 10 seconds of the request.
- **SC-1702**: When a deployed example stops answering, an issue naming it opens within the check's interval plus 10 minutes of GitHub's scheduling delay. It closes within one interval after the example answers again.
- **SC-1703**: A server whose disk passes the threshold gets an issue naming its free space within one interval.
- **SC-1704**: In a run where the example app prints a seeded secret, the secret's value appears in none of the outputs: the terminal output of `logs`, the MCP answers, the issues, the webhook posts, the lines in Grafana Cloud, or the audit entries.
- **SC-1705**: With the default interval, the check uses at most 750 Actions minutes a month in a private repository: less than half of GitHub's free plan.
- **SC-1706**: Beszel, the dashboard included, and Grafana Alloy each stay within the memory limit design showed, in the live pass. Turning either off leaves nothing of it on the server.
- **SC-1707**: With Grafana Cloud connected, the app's log lines and the server's CPU, memory and disk appear there within 5 minutes. The metric series stay under a tenth of the free tier's 10,000.
- **SC-1708**: No new feature in 017 needs a paid plan anywhere: GitHub, Cloudflare, Beszel or Grafana Cloud.

## Assumptions

Defaults the lead chose on 2026-10-24. The founder can change any of them.

- **The scheduled check:**
  - On by default for prod, and off for other environments. The user can turn it on or off for each environment.
  - Every 15 minutes in public repositories, and every 60 minutes in private ones, about 720 minutes a month. Never more often than every 5 minutes, GitHub's limit.
  - It runs at an off-peak minute: GitHub delays scheduled runs at the top of each hour.
- **Alerts:**
  - A GitHub issue, which notifies everyone watching the repository. A failed run alone notifies only the person who last edited the schedule, so it isn't enough.
  - Optionally, one chat webhook: Slack, Discord or ntfy. Email, SMS and phone alerts are not included; GitHub's issue notifications already reach email.
- **Thresholds:**
  - disk at 85% (warning) and 95% (high), the same as `secure`;
  - memory at 90% of a container's limit;
  - a certificate with 14 days left (renewal normally happens at 30 days);
  - three tries, 30 seconds apart, before the app is declared down.
- **Beszel:**
  - The dashboard runs on the same server by default, reachable through an SSH tunnel. A hostname with Cloudflare's login is optional, as with Portainer.
  - Beszel's own alerts are set by the user in its dashboard; OpsCrew doesn't manage them.
- **Grafana Cloud:**
  - The user creates the account and the token, because OpsCrew can't create accounts.
  - Grafana Cloud's dashboards and alert rules are the user's to set.
  - Only a small set of host and container metrics is sent.
- **Cloudflare's request logs:**
  - On, using the free plan's allowance.
  - Cloudflare announced new pricing for them from 2026-12-01; design shows the price it reads at that time.
- **Out of scope:**
  - a self-hosted Grafana, Prometheus or Loki stack;
  - traces, profiling and error tracking (such as Sentry);
  - status pages;
  - dashboards across several projects, team alerts and spend alerts (the hosted control plane);
  - the disk check and the add-ons on Portainer and on the user's computer;
  - OpsCrew keeping log or metric history itself.
