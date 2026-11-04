# Self-hosted monitoring: Prometheus, Loki and Grafana on your own server

OpsCrew can run a private monitoring stack for your app: [Prometheus](https://prometheus.io/) keeps
the figures, [Loki](https://grafana.com/oss/loki/) keeps the log lines, and
[Grafana](https://grafana.com/oss/grafana/) shows them in ready-made dashboards. Everything runs on
your own servers: no third party gets your data, and nothing limits how much you keep but your disk.
Nobody on the internet can reach it. It is off until you turn it on.

It works on servers OpsCrew deploys to: ones it created on Hetzner Cloud or DigitalOcean, and
[servers you already have](own-server.md).

Not sure you need it? `npx opscrew status` and `npx opscrew logs` show
[the moment's figures and the latest lines](logs-and-status.md), [Beszel](beszel.md) keeps a history
of the server's figures, and [Grafana Cloud](grafana-cloud.md) keeps logs and figures for 14 days on
Grafana's free tier. Self-hosted monitoring is for weeks of figures and searchable logs, on your own
servers.

## What runs, and where

- **The stack:** Prometheus, Loki, Grafana, and a small front that takes in what your servers send.
  By default it runs on a small server of its own, at your app's provider and location, with nothing
  else on it.
- **The agent:** [Grafana Alloy](https://grafana.com/docs/alloy/latest/) on every server of the
  environment, with OpsCrew's read-only Docker proxy next to it. It sends:
  - the server's CPU, load, memory, disk and network traffic;
  - each container's CPU, its memory against its limit, and its restarts;
  - your app's log lines;
  - Caddy's figures, on the server that runs the reverse proxy;
  - Postgres's figures, on the server that runs it, through a login of its own that can only read
    the database's statistics.

The monitoring server and your app's servers talk over the app's
[private network](private-network.md). If the app has none yet, turning monitoring on creates it,
with the app's server and the monitoring server as its members.

### Secrets are masked before they leave each server

Alloy masks every log line on the server it comes from, before it is sent, as it does for
[Grafana Cloud](grafana-cloud.md#secrets-are-masked-before-they-leave-the-server): values shaped
like known kinds of secret, Gitleaks' rules, and your app's own secret values from a masking file the
deploy writes on each server. The stack only ever stores the masked lines: a masked value shows as
OpsCrew's marker, such as `<opscrew:known-value>`.

## What it costs

The stack's containers have these memory limits, 1,088 MB in all:

| Container | Memory limit |
|---|---|
| Prometheus | 192 MB |
| Loki | 384 MB |
| Grafana | 416 MB |
| The front | 96 MB |

Every monitored server, the monitoring server included, also runs Alloy (256 MB) and its Docker
proxy (32 MB). Measured in OpsCrew's tests with three servers sending for an hour, each part's peak
stayed under these limits: Grafana, the largest, reached about 270 MB.

The monitoring server is the smallest type at your app's provider whose memory holds all of that and
the system's share. At Hetzner that is a 4 GB type such as the cx23, €5.49 a month plus €0.50 for
its public IPv4 address, as OpsCrew read Hetzner's prices on 2026-11-03 (excluding VAT). Before
anything changes, OpsCrew shows the type and its monthly price, and Alloy's memory on each of your
servers with its share of that server's price.

## Turn it on

```bash
npx opscrew addon enable monitoring
```

OpsCrew says what it adds, then writes it into `opscrew/plan.yaml`. It changes nothing on any server,
account or repository yet. It shows:

- the monitoring server: provider, location, type and monthly price;
- what runs on it, and Alloy's memory on each of your servers;
- how long figures and logs are kept, and the disk that takes;
- that the data stays on your own servers;
- that Grafana and Loki are licensed AGPL-3.0, run unmodified (see [the licences](#the-licences)).

Then run:

```bash
npx opscrew provision
```

It shows each change and applies it once you approve its hash, as for every change:

1. the infrastructure plan, which creates the monitoring server;
2. each server's host plans: the private network and its filter, Alloy, Postgres's monitoring login,
   and the stack on the monitoring server;
3. the deploy-setup pull request, which writes the masking file on every server.

Within a minute or two of the last step, every server's figures and logs are in Grafana. On a
brand-new app, Alloy on a server starts at the `provision` after the app's first deploy: provision
says so, so run it again once the app is deployed.

Commit the changed `opscrew/plan.yaml` and files afterwards.

With several [apps](several-apps.md) or [environments](environments.md), choose one with
`--app <key>` and `--env <name>`, as every command takes them. Every command below takes them too.

### On the app's own server

```bash
npx opscrew addon enable monitoring --on app
```

runs the stack next to your app, with no extra server and no extra price. It needs a server with at
least 4 GB of memory where the stack's limits fit next to the app's and the system's share. When
they don't, OpsCrew refuses before any change, and names a server type that would fit and the price
of a monitoring server of its own. `--on server` asks for the default.

### Several apps and environments: one monitoring server

When the repository already has a monitoring server, turning monitoring on in another app or
environment sends to that server: no new server is made. It joins that environment's private
network, and Grafana shows every app and environment, each one a choice in the dashboards. OpsCrew
shows the disk estimate for everything the server will then keep, and `provision` there also shows
the host plans that change the monitoring server, each approved by its hash.

A device on any of those networks sees every environment's dashboards: Grafana has one login.
`addon enable` says so when a second environment joins.

`--new-server` gives the environment a monitoring server of its own instead.

The server may be at another provider than the app: the private network crosses providers, and the
price shown is the monitoring server's.

## Open Grafana

```bash
npx opscrew addon open monitoring
```

- **This computer is a [device on the private network](private-network.md):** it prints Grafana's
  private address. Open it with the WireGuard tunnel on.
- **Otherwise:** it opens an SSH tunnel to the monitoring server and keeps it open until you stop it
  with Ctrl+C. While it runs, open <http://localhost:3000>. `--port <local>` picks another local
  port.

Log in as `admin`. OpsCrew generated the password: it is `monitoring.grafanaAdminPassword` in
`~/.opscrew/projects/<project>/generated_values.json` on the computer that turned monitoring on, and
in the [recovery copy](secrets-recovery.md). On another computer,
[restore the copy](secrets-recovery.md#restoring-on-a-new-computer). The password goes to the server
only while the plan is applied, and never into a plan, a log or your repository.

When [public SSH is closed](public-ssh.md) and this computer is not a device, `addon open` says so,
with the command that adds it as one.

### Who can reach what

- **From the internet:** the monitoring server answers only SSH and WireGuard's UDP port, and only
  WireGuard once public SSH is closed. `npx opscrew secure` and `npx opscrew verify` check it.
- **Your servers** on the private network reach only the two paths that receive figures and logs.
  They can't open Grafana or query Prometheus or Loki. Your app's servers never let the monitoring
  server in to any of their published ports.
- **Your devices** reach Grafana, and nothing else of the stack.
- **Grafana sends nothing to grafana.com:** no usage reports, update checks, news or plugin lookups.
  Sign-up and anonymous access are off.

## The dashboards

Grafana opens with six of OpsCrew's dashboards, in the folder **OpsCrew**. Each lets you choose the
app, the environment and the server:

- **Servers:** CPU, load, memory, disk in use and free, and network traffic, per server.
- **Containers:** each container's CPU, its memory against its limit, and its restarts.
- **HTTP traffic,** per hostname: requests, the share of 4xx and 5xx answers, and response times
  (the median and the slowest 5%).
- **Caddy:** requests in flight, its memory and CPU, and its own errors.
- **Postgres,** when the environment has Postgres: connections against the limit, transactions,
  cache hits, the database's size, deadlocks, and the age of the longest-running query.
- **Logs:** the lines by app, environment and service, with a box to search the text.

Good to know:

- **HTTP traffic and Caddy need Caddy,** the default [reverse proxy](reverse-proxy.md). With nginx or
  your own proxy, those two dashboards say so instead of showing empty panels. Caddy's figures are on
  in every OpsCrew edge, since every app on a server shares it, but they stay inside the server and
  are read only when monitoring is on.
- **An app with no domain yet has no HTTP figures:** Caddy serves it for any hostname, so the HTTP
  traffic and Caddy dashboards fill once the app has [its domain](domains.md).
- **MySQL, MariaDB, MongoDB and the other services** are on the Containers dashboard. Postgres is the
  only database with a dashboard of its own.
- **OpsCrew's dashboards are read-only.** Change one and Grafana asks you to save it as a copy.
  OpsCrew replaces its own whenever its version of one changes; your copies and your own dashboards
  are kept.

## Retention and disk

Figures are kept 15 days and logs 7 days by default. Change them with:

```bash
npx opscrew addon enable monitoring --metrics-days 30 --logs-days 14
```

then `npx opscrew provision`. Figures can be kept 1 to 90 days, logs 1 to 30. With several
environments on one monitoring server, its owner's settings apply to all of them: change them in the
environment that turned it on first.

Before anything changes, OpsCrew estimates the disk the retention takes:

- **Figures:** from each server's series. A 2-vCPU server with 8 containers, Caddy and Postgres sends
  about 180, roughly 30 MB over 15 days.
- **Logs:** from what your app's containers logged in the last 24 hours, read on the servers (no line
  leaves them for this). Loki keeps them in about a quarter of their size as text.

A retention whose estimate passes 80% of the monitoring server's disk is refused, with a shorter
retention that fits or a larger server type. Prometheus also stops at a size cap OpsCrew derives from
the disk, so a busier app than estimated loses its oldest figures rather than filling the disk. The
[scheduled check](alerts.md) warns when the monitoring server's disk passes 85%, as for every server.

## Status

```bash
npx opscrew addon status
```

shows:

- the stack's containers and their memory;
- for each server, when its last figures and its last log line arrived;
- the disk taken by figures and by logs;
- the retention.

A server that sent nothing for more than 5 minutes is flagged, with what to check: its agent, and its
link on the private network. `npx opscrew status` adds one line: whether every server sent within the
last 5 minutes.

When the monitoring server is down, each server's Alloy keeps its figures for up to 8 hours and its
log lines for about 20 minutes, and sends them when the server is back.

## Turn it off

```bash
npx opscrew addon disable monitoring
npx opscrew provision
```

The first command takes monitoring out of the plan; `provision` shows the host plans that remove
everything OpsCrew installed for it, each approved by its hash:

- **Alloy** goes from every server, except the app's server when [Grafana Cloud](grafana-cloud.md) is
  still on: there it goes back to sending to Grafana Cloud only.
- **The monitoring server** is deleted, with all its figures and logs, only after OpsCrew says so and
  you type its name.
- **With `--on app`,** the stack and its data are removed from the app's server only after the same
  typed confirmation.

Nothing OpsCrew installed for monitoring stays. On your own servers, only what was there before.

While other environments send to the monitoring server, turning it off (or destroying the
environment) where it was first turned on is refused, naming them: turn monitoring off there first.
Turning it off in one of those other environments, or destroying it, removes its agents and takes the
monitoring server off its network.

`npx opscrew retarget` refuses an environment with monitoring on: turn monitoring off and run
`provision` first.

## The licences

Grafana and Loki are licensed [AGPL-3.0](https://grafana.com/licensing/); Prometheus and Alloy
Apache-2.0. OpsCrew runs the official images, unmodified, as containers, and only writes their
configuration, which asks nothing of you. The AGPL's duty to publish source applies to a modified
version offered to others over a network. OpsCrew's dashboards are its own, Apache-2.0.

Each image is pinned to a tested version. A newer OpsCrew with newer versions shows them in the host
plans of your next `npx opscrew provision`.

## Grafana Cloud and Beszel too

- **[Grafana Cloud](grafana-cloud.md):** one Alloy on the app's server sends to both. Grafana Cloud
  keeps getting what it got before, sampled as you set it; the container, Caddy and Postgres figures
  go to your stack only. When the monitoring server is down for hours, Alloy's queue for it fills
  and Grafana Cloud's log lines wait too, until the oldest are dropped. `addon status` flags the
  silent server long before that.
- **[Beszel](beszel.md):** both run side by side and share nothing.

## What it doesn't do

- **Alerts:** the stack sends none. The [scheduled check](alerts.md) stays the alert path: it checks
  your app from GitHub and opens an issue when something fails, the monitoring server's disk
  included.
- **Run in a Portainer, on your computer, or on Cloudflare's hosting or GitHub Pages:** OpsCrew
  doesn't manage those hosts, or there is no host.
- **Two apps on one of your own servers:** a server runs one Alloy, so the second app's monitoring is
  refused with the reason, as for Grafana Cloud.
- **Reach it from the internet,** for example on a subdomain: only your devices and the tunnel.
- **Traces, dashboards for databases other than Postgres, and backups of the stack's data.**
- **Deploys and rollbacks** don't touch the stack or the agents; a deploy only refreshes the masking
  file.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) can show monitoring's status (each server's last data,
the disk and the retention) and turn it on or off, with the same approvals as the terminal. To open
Grafana, run `npx opscrew addon open monitoring` in your terminal.
