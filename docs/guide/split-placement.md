# A server of its own for a service: split placement

By default, everything of your app runs on one server: the web process, its workers and cron jobs,
and every database, cache and broker. That is right for most apps, until one part outgrows it: a
busy database wants more memory than the app's server can spare, or you already have a server with
room, at another provider or at home.

OpsCrew can then give that one service a server of its own. The servers are joined by a
[private network](private-network.md), the service listens only there, and only the app's servers
reach it. Your app's code and settings files don't change: only the address the app is given does.

This works on servers: ones OpsCrew creates on Hetzner Cloud or DigitalOcean (mixed freely), and
[servers you already have](own-server.md) that the internet reaches at a public address. It doesn't
apply to a [Portainer](portainer-target.md), [your computer](localhost.md),
[Cloudflare's hosting](cloudflare-hosting.md) or [GitHub Pages](github-pages.md): design refuses it
there and says why.

## Place a service

Add the server to `opscrew/plan.yaml` and name it on the service:

```yaml
servers:
  - name: db
    target: { provider: hetzner, mode: vps-compose, location: nbg1, serverType: cx23, backups: true }
services:
  - kind: postgres
    server: db
    # … the rest as before
```

- **A server's name** is short (up to 15 lower-case letters, digits or hyphens) and never `app`,
  which is the app's own server. A server OpsCrew creates is named `<app>-<name>` at the provider.
- **Leave `location` and `serverType` out** and design fills them in: the app's server's location
  (the shortest hop), and the smallest type whose memory holds the services you put there, plus the
  system's share.
- **Only services move.** The web process, workers, cron jobs, the release command, SQLite and the
  reverse proxy stay on the app's server. An extra server serves no web traffic.
- **Your own server as the extra one:** give it `target: { provider: own, mode: vps-compose, arch: amd64 }`.
  Design asks for its address and login once and keeps them on this computer, as it does for the
  app's server.

Then run:

```bash
npx opscrew design      # each server, its price, the total and the delay estimate
npx opscrew provision   # the plans, each approved by its hash
```

## What it costs

`npx opscrew design` shows each server with its provider, location, size and monthly price, the
services on it with their memory limits, and the total for the app. An extra server on Hetzner
Cloud or DigitalOcean is billed like any other server of that size; a server you already have adds
no server cost. A budget you gave in the interview counts every server.

The private network itself costs nothing: OpsCrew sets up WireGuard on the servers, with no account
and no third party. The traffic between the servers counts toward each server's traffic at its
provider, as the app's own traffic does.

## The delay

Every query the app sends to a service on another server crosses the network and waits for the
answer. Design estimates that wait for each server:

```text
Each query from the app to db on server db waits about 2 ms (an estimate: 2 ms plus 1 ms per 50 km between nbg1 and nbg1, 0 km apart), so a page that makes 20 queries in a row takes about 40 ms longer.
```

- **It is an estimate,** from the distance between the two locations: about 2 ms, plus 1 ms for
  every 50 km. In the same location that is about 2 ms a query; between Falkenstein and Nuremberg
  about 6 ms; between Falkenstein and Helsinki about 28 ms (36 ms measured in OpsCrew's tests).
- **Design warns above 5 ms a query,** because a page that makes many queries one after another
  then slows down noticeably. It says what would shorten it: the extra server in the app's server's
  location, or the service back on the app's server.
- **On a server you already have,** OpsCrew doesn't know where it is, so design says that
  `npx opscrew status` measures the delay once the servers are linked.
- **`npx opscrew status` measures the real round trip** of every link, so you can check the
  estimate.

Prefer the same location as the app's server. Put a service farther away only when you have a
reason, such as a server you already have elsewhere.

## Moving a service of a live app

When the app already runs and you change a service's `server` (to another server, or back to the
app's server by removing `server`), its data moves with it.

1. **Design shows the maintenance window first.** It reads the database's size and estimates the
   app's downtime: about 2 minutes, plus a minute for every 100 MB of data.
2. **`npx opscrew provision` starts the new copy, empty,** on the new server, through the usual
   pull request and deploy. The app keeps using the old copy meanwhile.
3. **Then the window,** after you approve it (the approval lists every step):
   - the app's deploys are paused (the repository variable `OPSCREW_DEPLOY_PAUSED`; a push in the
     window skips its deploy job), and the window waits until no deploy runs;
   - the [scheduled check](alerts.md) is paused, if it is on;
   - the app, its workers and cron jobs stop;
   - Postgres's data is dumped on the old server, copied to the new one, checked and restored;
   - the app's settings get the new address, and the app starts against the new copy and must
     pass its health check;
   - the deploys and the check resume.
4. **A failure before the app has started on the new copy** puts the app's settings back and starts
   the app on the old copy: nothing is lost, and you run `npx opscrew provision` again when ready.
5. **Once the app has started on the new copy, OpsCrew only goes forward.** The app may already
   have written to the new copy, so going back would lose those writes. If a later step fails, run
   `npx opscrew provision` again: it finishes the switch.

The old copy stays on its server, stopped, with its data. When you are sure the app runs well on the
new one, remove it:

```bash
npx opscrew provision --finish-move
```

It asks you to type the service's name, then deletes the old copy and its data. A server that runs
nothing else after that leaves `servers`, and the next `npx opscrew provision` deletes it after you
type its name, as [destroy](#removing-a-server) does.

Which services can move with their data:

- **Postgres:** its data is copied, as above.
- **Valkey, Redis and Dragonfly:** they start empty on the new server, and design says so. Jobs
  waiting in a queue there are lost: let the queue drain first.
- **Every other service that keeps data** (MySQL, MariaDB, MongoDB, the brokers and the engines) is
  refused on a live app, before any change. On an app that was never deployed, every service can be
  placed on any server.

One service moves at a time. Moving the whole app to another provider is
`npx opscrew retarget`, which an app with extra servers can't use yet: it refuses before any change.

## Services with no login

Kafka, Redpanda and OpenSearch run without a login of their own (adding one would break apps whose
clients don't send it). On another server, design says so: only the app's servers reach them,
through the private network, and no [device](private-network.md) can be given access to them.

Every other service keeps the password OpsCrew generates for it. Between the servers, WireGuard
encrypts every packet and proves which server sent it, so OpsCrew adds no TLS on top.

## Every command covers every server

- **Deploys** update the services on every server before the app switches to its new version. A
  failure on a server stops the deploy before the app changes.
- **`npx opscrew status`** shows each server with its figures and containers, and the private
  network: each link, whether it is up, its last handshake and its measured round trip.
- **`npx opscrew logs --service db`** reads the lines on the server that runs `db`.
- **`npx opscrew drift`, `secure` and `verify`** check every server and name it in each line.
  `secure` also checks that each service on another server answers only on the private network.
- **The [scheduled check](alerts.md)** reads the disk of every server.

[Beszel](beszel.md) and [Grafana Cloud](grafana-cloud.md) stay on the app's server; `status` gives
the other servers' figures.

After a server restarts, the private network comes back first, then the services, and the app
reconnects, with no action from you.

## Removing a server

`npx opscrew destroy` lists every server of the app, and asks you to type each name before it deletes
a server OpsCrew created. On a server you already have, it removes only what OpsCrew installed: the
app's services, the private network's interface, its firewall rules and its records.

## What can go wrong

- **Design refuses the placement:** two servers without a public address (a server of yours behind
  a home router, reached through a Cloudflare Tunnel) can't be linked. Such a server can be the
  app's server, with services on servers that have one, but no service can be placed on it. Design
  says what would work before anything changes.
- **The address range is taken:** the private network uses a range such as `10.200.4.0/24`. When
  one of the servers already has a network in that range (a provider's private network, a home
  network), the host plan refuses and names it. Change `network.range` in `opscrew/plan.yaml` to
  another `/24` inside `10.200.0.0/13` before the first apply, then run `npx opscrew provision`.
- **WireGuard's port is taken** on a server you already have: the host plan picks the next free UDP
  port and says so.
- **A link is down:** `npx opscrew status` shows it with the time of its last handshake. The usual
  cause is a firewall in front of the server that blocks the network's UDP port (51820, or the port
  the plan names): let it in. Until the link is back, the app's health check fails as it would for
  any database it can't reach.
- **The delay is larger than you expected:** compare design's estimate with what `status`
  measures, and move the server to the app's server's location if they are far apart.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) can show the app's servers and links with their measured
delay, and what a placement would cost and how slow each query would get, before you change
anything.
