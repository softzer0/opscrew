# Grafana Cloud: searchable logs and metrics, free

[Grafana Cloud](https://grafana.com/products/cloud/)'s free tier keeps logs and metrics for 14 days,
and lets you search and chart them in Grafana. OpsCrew can connect your server to it: it adds
[Grafana Alloy](https://grafana.com/docs/alloy/latest/), a light collector, which sends your app's
log lines and the server's metrics to your own Grafana Cloud account. You run no monitoring stack.
It is off until you turn it on.

It works on a server OpsCrew deploys to: one it created on Hetzner Cloud or DigitalOcean, or a
[server you already have](own-server.md).

## The account and the token

OpsCrew can't create the account for you:

1. Sign up at <https://grafana.com/auth/sign-up/create-user> and choose the free plan. Grafana Cloud
   creates a stack for you.
2. On the stack's details page in the [Grafana Cloud Portal](https://grafana.com/profile/org), note:
   - the Prometheus **remote write** URL (`https://…/api/prom/push`) and its user id, a number;
   - the Loki URL (the push URL ends in `/loki/api/v1/push`) and its user id, another number.
3. Create an access policy token under **Administration** → **Users and access** →
   **Cloud access policies** (see
   [Grafana's access policies](https://grafana.com/docs/grafana-cloud/account-management/authentication-and-permissions/access-policies/)).
   Give the policy only two scopes:
   - `metrics:write`;
   - `logs:write`.

   With only these, the token can send data and can't read anything back.

## Turn it on

```bash
OPSCREW_GRAFANA_CLOUD_TOKEN=<token> npx opscrew addon enable grafana-cloud \
  --metrics-url https://<prometheus-host>/api/prom/push --metrics-user 123456 \
  --logs-url https://<loki-host>/loki/api/v1/push --logs-user 654321
```

In a terminal, OpsCrew asks for any value you leave out, and for the token without showing it.

OpsCrew reads the server first, then shows the host plan with:

- **Alloy and OpsCrew's read-only Docker proxy,** each with its memory limit (192 MB and 32 MB) and
  next to its share of the server's monthly price on a server OpsCrew created, or the server's memory
  on your own. Measured in OpsCrew's tests, Alloy used 70 to 80 MB;
- **OpsCrew's estimate** of what the server will send, next to the free tier's limits.

Nothing changes until you approve the plan's hash. In scripts, add `--plan-only` to see the plan and
its hash, then `--approve <hash>` to apply exactly that plan.

The token is kept in `~/.opscrew/projects/<project>/grafana_cloud_token` (readable only by you, and in
the [recovery copy](secrets-recovery.md)) and in a file on the server that only the deploy user can
read. It goes to the server over the SSH connection only while the plan is applied, and never into a
plan, a log or your repository.

Commit the changed `opscrew/plan.yaml` and files afterwards. The next `npx opscrew provision` also
includes them in its pull request.

With several [apps](several-apps.md) or [environments](environments.md), choose the one whose server
sends with `--app <key>` and `--env <name>`, as every command takes them:
`npx opscrew addon enable grafana-cloud --env staging …`. Every `addon` command below takes them
too. Another environment's plan and token are in its own folders (`opscrew/environments/<env>/` and
`~/.opscrew/projects/<project>/environments/<env>/`).

## What is sent

- **Your app's log lines:** those of the web process, its workers, cron jobs and services, labelled
  with the app's, environment's and service's names (`app`, `env` and `service`). The lines of the
  reverse proxy the server's apps share are not sent.
- **The server's metrics:** CPU time per CPU (user, system, idle, I/O wait and steal), the load over 1,
  5 and 15 minutes, total and available memory, and the size and free space of the root disk.

`--log-sampling <percent>` sends only that share of the log lines, from 1 to 100 (all, without it).

Within 5 minutes of turning it on, search the lines in your stack's Grafana under **Explore** with
`{app="example-app"}`, and the metrics under the same menu.

### Secrets are masked before they leave the server

Alloy masks every line on your server, before it is sent:

- values shaped like known kinds of secret, with OpsCrew's own patterns (shown as
  `<opscrew:github-token>`, for example);
- Grafana's secret filter, built on Gitleaks' rules (shown as `<secretfilter:aws-access-token>`, for
  example);
- your app's own secret values, from a masking file the deploy job writes next to the app's
  environment file at each deploy (shown as `<opscrew:known-value>`). Values shorter than 8
  characters are not masked.

The masking file is written by the deploy workflow that turning Grafana Cloud on updates. Until the
first deploy with that workflow, which runs once the change is on your deploy branch, only the first
two kinds are masked: merge the change and deploy before your app prints its own secrets.

## The estimate and the free tier

Grafana Cloud's free tier keeps 10,000 active metric series and 50 GB of logs a month, each for 14
days, for up to 3 users (as OpsCrew read [Grafana's pricing](https://grafana.com/pricing/) on
2026-10-28).

Before any change, OpsCrew estimates what your server sends:

- **Series:** 5 for each CPU, plus 7: a 2-CPU server sends 17, far below 10,000.
- **Logs:** 30 times what your app's containers logged in the last 24 hours, read on the server
  (no line leaves it for this).

When the estimate passes the free tier, the plan says so, and gives the `--log-sampling` that would
fit. On the free plan, Grafana Cloud doesn't keep what goes past its limits. A paid Grafana plan holds
more, so OpsCrew never refuses.

## What Alloy can see on your server

Alloy reads Docker through a small proxy OpsCrew runs next to it, never Docker's socket itself. The
proxy passes only read requests: the list of containers and networks, each container's figures, its
logs and its settings. It refuses everything else, such as starting, stopping or changing a
container, or running a command in one.

**Alloy can read the containers' settings, your app's environment values included.** Its log reader
needs them to find the lines. Alloy runs only on your server, already holds your app's values to
mask them, and sends only masked lines. Its own local page, which shows the masking values, is
reachable only inside its container.

Alloy also reads the server's `/` and `/sys`, read-only, for the disk and CPU figures. Every
container runs from an image pinned to a tested version, with a read-only file system and a memory
limit:

- **Alloy** runs as the server's `deploy` user, which already has Docker access, with no Linux
  capability. It runs on a network of its own, not the server's, so it sends no network figures.
- **The read-only Docker proxy** runs as root with the deploy user's group, because Docker's socket
  is root's. It has no network, and only the capability to bind its socket.

On your own server with several OpsCrew apps, Grafana Cloud belongs to the app that turned it on:
Alloy sends that app's lines and the server's metrics. Turning it on for another app is refused with
the reason.

## No container metrics

Grafana Cloud gets the server's figures, not each container's. Grafana's container collector needs
privileged access to the server and a writable Docker socket, which OpsCrew doesn't give an add-on.
Each container's CPU and memory are in `npx opscrew status`, and over time in [Beszel](beszel.md).

## Turn it off

```bash
npx opscrew addon disable grafana-cloud
```

removes, after you approve its plan, everything it added to the server: Alloy, its buffer, the
proxy, the token and the masking file. It also deletes the token from your computer. Commit the
changed files afterwards.

The data already in Grafana Cloud stays in your account until Grafana Cloud's retention removes it.
OpsCrew never deletes tokens: delete the access policy token in Grafana Cloud if you no longer use
it.

## Rotating the token

Turning Grafana Cloud on again while it runs keeps the token the server already has. To use a new
one, create it in Grafana Cloud, then turn the add-on off and on with it:

```bash
npx opscrew addon disable grafana-cloud
OPSCREW_GRAFANA_CLOUD_TOKEN=<new token> npx opscrew addon enable grafana-cloud \
  --metrics-url … --metrics-user … --logs-url … --logs-user …
```

Then delete the old token in Grafana Cloud.

## What it can't do

- **Run in a Portainer, on your computer, or on Cloudflare's hosting or GitHub Pages:** it needs a
  server OpsCrew deploys to.
- **Container metrics and network figures:** see above.
- **Mask a secret it can't recognise** before the first deploy with the updated workflow, or one
  shorter than 8 characters.
- **Dashboards and alerts:** they are yours to set up in Grafana Cloud.
- **Keep more than the free tier allows** on the free plan.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) can show the add-on's status and turn it on or off. You
approve each plan in a dialog. Claude never sees the token.
