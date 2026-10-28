# Your app's logs and resource figures

Two commands answer "what is my app saying?" and "how is it doing?" from your terminal, wherever the
app runs. You need no SSH command, no container name and no dashboard:

```bash
npx opscrew logs      # the app's latest log lines
npx opscrew status    # what runs, with its CPU, memory, disk and restarts
```

Both only read. Nothing is installed on your server to collect anything, and nothing is kept: each
run reads what is there at that moment.

## `opscrew logs`

```bash
npx opscrew logs                          # the web process's last 200 lines
npx opscrew logs --follow                 # then the new lines as they come, until Ctrl+C
npx opscrew logs --service db --since 1h  # the database's lines of the last hour
npx opscrew logs --tail 50                # only the last 50 lines
```

The lines come oldest first, newest last, each with its time in UTC. The first line says how far
back they go.

| Flag | What it does |
|---|---|
| `--follow` | After the lines read, shows new ones as they arrive, until you stop it with Ctrl+C |
| `--service <name>` | Another part of the app: a worker, a cron job or a service by its name in `opscrew/plan.yaml` (such as `db`), `cron` for the cron jobs, or `edge` for the reverse proxy in front of the app. Without it, the web process (`app`) |
| `--since <duration>` | Only the lines of the last `30s`, `15m`, `2h` or `3d` |
| `--tail <lines>` | How many of the latest lines (200 without it); on Cloudflare's hosting, requests |
| `--app <key>`, `--env <name>` | Another [app](several-apps.md) or [environment](environments.md), as every command takes them |

A name `--service` doesn't know is refused, and the refusal lists the names the app has.

- **The cron jobs** run in one container, so `--service <job>` and `--service cron` both show the
  lines of every cron job.
- **The edge** on a server is the reverse proxy every OpsCrew app on that server shares, so its lines
  are of all of them. In [a Portainer](portainer-target.md) it is the Caddy in the app's own stack.

### Where the lines come from

| Where the app runs | How `logs` reads |
|---|---|
| A server OpsCrew created | `docker logs` over SSH, as the `deploy` user with the project's deploy key, as `status` does |
| [Your own server](own-server.md) | `docker logs` over SSH, through the login OpsCrew uses there |
| [A Portainer](portainer-target.md) | Docker's API through Portainer, with `PORTAINER_API_KEY` |
| [Your computer](localhost.md) | Your local Docker |
| [Cloudflare's hosting](cloudflare-hosting.md), server-rendered | Cloudflare's logs of the Worker's requests; `--follow` uses Cloudflare's live tail |
| Cloudflare's hosting with a static site, and [GitHub Pages](github-pages.md) | No request logs: the last deploy runs instead |

On a server, `logs` runs one fixed, read-only `docker logs` command, built only from names it has
checked. It can't run anything else on the server, and each read is written to OpsCrew's audit log
without the server's address. When you stop `--follow`, the command ends on the server within about
a second.

In a Portainer, `--follow` asks for new lines every 2 seconds, because Portainer holds back a live
stream for about 40 seconds before it sends anything. A standard user's access token sees only that
user's own stacks: when the app's containers aren't visible to the token, `logs` says so (see
[The tokens and what they may do](portainer-target.md#the-tokens-and-what-they-may-do)).

When the server doesn't answer over SSH, `logs` says so and suggests `npx opscrew verify`.

### How far back the lines go

Each deploy starts new containers, and each container keeps up to 30 MB of logs (three files of
10 MB). Lines from before the last deploy, and lines older than those 30 MB, are gone. The first
line of the output gives the time of the oldest line shown.

For more history, [Grafana Cloud](grafana-cloud.md) keeps 14 days of your app's lines on its free
tier.

### Secrets are masked

Every line passes OpsCrew's masking before it is shown. It masks:

- the values OpsCrew generated for the app, such as the database password;
- your app's values in the file `OPSCREW_APP_ENV_FILE` names, when you set it;
- anything shaped like a known kind of secret, such as an API token or a private key.

A masked value shows as `[REDACTED:<kind>]`. A secret of your own with no known shape is masked only
when OpsCrew knows its value: set `OPSCREW_APP_ENV_FILE` to your production values file to cover it.

### Cloudflare's hosting

For a server-rendered app, `logs` shows each recent request of the Worker: its method and path
(never the query string, which can hold secrets), its status and outcome, then the lines the app
printed for it and any error it raised. OpsCrew shows no request headers and no visitor addresses.

- **`--tail` counts requests, not lines:** each request comes whole, its line with the method, path,
  status and outcome followed by its console lines and errors. Without `--tail`, the last 200
  requests; at most 2,000.
- **Past requests** can take up to about 30 seconds to show. `--follow` shows new requests at once.
- **Requests for the site's static files** run no code, so they are in no log.
- **`--service`** doesn't apply: the Worker is the whole app.
- **The permission:** reading past requests needs Account → Workers Observability → Read on
  `CLOUDFLARE_API_TOKEN`, on top of the Workers Scripts → Edit that hosting needs. The live tail
  works with Workers Scripts → Edit alone. `npx opscrew init` names a missing permission.

Cloudflare keeps the logs within its plan's allowance, and drops what goes past it. Nothing in
Cloudflare's answers says the allowance was reached, so `logs` always states it. As OpsCrew read
Cloudflare's [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and
[Observability pricing](https://developers.cloudflare.com/observability/pricing/) on 2026-10-28:

| | Workers Free | Workers Paid |
|---|---|---|
| Until 2026-11-30 | 200,000 log events a day, kept 3 days | 20 million log events a month, kept 7 days |
| From 2026-12-01 | 0.5 GB of logs a day, kept 7 days; past it, nothing is kept until 00:00 UTC | 50 GB a month included, then USD 0.25 per GB |

### GitHub Pages and static sites on Cloudflare

These hosts serve the site's files without running any of its code, so they keep no request logs.
`logs` says so in one sentence, then shows the site's last 10 deploy runs, each with its result and a
link. `--service` and `--follow` don't apply there.

## The figures in `opscrew status`

`npx opscrew status` shows what runs, and how it is doing right now:

- **The server:** its load over 1, 5 and 15 minutes against its number of CPUs, its memory in use
  of the total, and its disk used and free;
- **Each container:** its CPU, its memory against the limit OpsCrew gave it, how many times it
  restarted since the last deploy, and how long it has been running.

On a server, one fixed, read-only command reads all of them at once. It never reads the containers'
settings, so no environment value comes back.

Figures past a threshold are flagged with what they mean and what to do:

| Flag | When | What to do |
|---|---|---|
| Warning | A container uses 90% or more of its memory limit; at the limit, the system stops it and Docker starts it again | Raise its `memoryMb` in `opscrew/plan.yaml` and run `npx opscrew provision`, or find what in the app holds on to memory |
| Warning, then high | The disk is 85% full, and 95% for the higher severity (the same thresholds as `secure`) | Remove old images (`docker image prune` as the deploy user), or give the server a bigger disk |
| Warning | A container restarted since the last deploy: it crashed or ran out of memory | `npx opscrew logs --service <name>` shows why |

### What each target can't give

| Where the app runs | What `status` shows | Named as not available |
|---|---|---|
| A server OpsCrew created, or your own | Everything above | |
| A Portainer | Each container's figures, and the host's CPUs and total memory | The host's load, memory in use and disk: Docker's API through Portainer doesn't give them. Containers the token's user can't see are named too |
| Your computer | Each container's figures, and Docker's CPUs and total memory | Your computer's load, memory in use and disk |
| Cloudflare's hosting, server-rendered | The last 24 hours' requests, errors and CPU time per request, against Workers Free's 100,000 requests a day and 10 ms of CPU time per request | |
| GitHub Pages | The latest build and its result | Any figure: no code of the site runs |

On Cloudflare:

- **Errors** are the requests that raised an exception, not every answer with a 4xx or 5xx status.
- **Requests for the site's static files** run no code and aren't counted.
- **The figures** lag about a minute.

### The scheduled check

When the [scheduled check](alerts.md) is on, `status` also reads its state from GitHub:

- whether it runs;
- when GitHub turned it off, and how to turn it on again;
- the open alerts, each with its link.

## What it can't do

- **History:** `status` shows this moment only, and `logs` only what the containers still keep. For
  charts over days, use [Beszel](beszel.md) or [Grafana Cloud](grafana-cloud.md).
- **Search across days, or across apps:** `logs` reads one app and environment at a time.
- **Request logs of a static site,** on GitHub Pages or on Cloudflare's hosting.
- **The host's disk in a Portainer:** neither Docker nor Portainer gives it.
- **Logs Cloudflare didn't keep:** lines past the plan's allowance are gone.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) reads the same logs and figures through read-only tools
when you ask "why is my app failing?" or "how much memory does it use?". It returns at most 500
lines, masked as in the terminal, and never follows. For more lines or `--follow`, run
`npx opscrew logs` in your terminal.
