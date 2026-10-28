# Beszel: charts and history for your server

[Beszel](https://beszel.dev/) is a light monitoring dashboard. It shows your server's CPU, memory,
disk and network, and each container's CPU and memory, over time, and it can send its own alerts.
OpsCrew can add it to a server it deploys to: one it created on Hetzner Cloud or DigitalOcean, or a
[server you already have](own-server.md). It is off until you turn it on.

`npx opscrew status` already shows the figures of the moment. Turn Beszel on when you want charts
and history.

## Two ways to run it

- **Hub mode** (the default): Beszel's dashboard (the hub) and its agent both run on your server.
- **Agent mode:** only the agent runs on your server, and it reports to a Beszel hub you already run
  elsewhere, for example one that watches all your servers.

In both, the agent connects to the hub over a WebSocket, so it opens no port on your server.

## Turn it on

```bash
npx opscrew addon enable beszel
```

OpsCrew first reads the server's memory, then shows the host plan of what it adds:

- the hub (128 MB);
- the agent (64 MB);
- OpsCrew's read-only Docker proxy (32 MB).

Each memory limit comes with its share of the server's monthly price, as [components](components.md)
do. The plan has its hash, and nothing changes until you approve it. In scripts,
`npx opscrew addon enable beszel --plan-only` shows the plan and its hash, and
`npx opscrew addon enable beszel --approve <hash>` applies exactly that plan.

Measured on a test server, Beszel used far less than its limits: about 11 MB for the hub, 7 MB for
the agent and 12 MB for the proxy.

In hub mode, OpsCrew generates the dashboard's password, the agent's token and the hub's key on your
computer. They are kept in `~/.opscrew/projects/<project>/beszel_secrets.json` (readable only by
you, and in the [recovery copy](secrets-recovery.md)). They go to the server over the SSH
connection only while the plan is applied, and never into a plan, a log or your repository.

Commit the changed `opscrew/plan.yaml` and files afterwards. The next `npx opscrew provision` also
includes them in its pull request.

With several [apps](several-apps.md) or [environments](environments.md), choose the one whose server
gets Beszel with `--app <key>` and `--env <name>`, as every command takes them:
`npx opscrew addon enable beszel --env staging`. Every `addon` command below takes them too. Another
environment's plan and secrets are in its own folders (`opscrew/environments/<env>/` and
`~/.opscrew/projects/<project>/environments/<env>/`).

## Open the dashboard

```bash
npx opscrew addon open beszel
```

opens an SSH tunnel to your server and keeps it open until you stop it with Ctrl+C. While it runs,
open <http://localhost:8090> in your browser and log in as `admin@opscrew.invalid` with the
`password` from `beszel_secrets.json`. That address is the dashboard's only user; it receives no
email. The dashboard listens only on the server itself (`127.0.0.1:8090`), never on the internet.

The password file is only on the computer that turned Beszel on, and in the recovery copy. Copy it
from there, or [restore the copy](secrets-recovery.md#restoring-on-a-new-computer), to open the
dashboard from another computer.

`npx opscrew addon status` shows whether Beszel runs, its containers' memory, and how to open it.

### Optional: a subdomain behind Cloudflare Access

```bash
npx opscrew addon enable beszel --access subdomain --hostname beszel --allow-email you@example.com
```

serves the dashboard at `beszel.example.com` for an app on `example.com` as well, the way
[Portainer's web UI](portainer.md#optional-a-subdomain-behind-cloudflare-access) does, with the same
needs: the app's domain on Cloudflare, Cloudflare Zero Trust turned on, and the extra token
permissions listed there.

- **It goes through a Cloudflare Tunnel,** so the server opens no port for it.
- **Cloudflare Access lets in only the addresses you list** with `--allow-email` (repeat it for
  several), each after a one-time code sent to that address. Beszel's own login follows.
- **OpsCrew never makes the dashboard public:** a subdomain without `--allow-email` is refused.
- **The name must be its own:** a hostname Portainer's web UI already uses on the server is refused.

Like Portainer's, this adds the Cloudflare plan and the infrastructure plan, each approved by its
hash, before the host plan.

### Agent mode: report to your own hub

In your hub, choose **Add system**: it shows the hub's public key and a token for the new system.
Then:

```bash
OPSCREW_BESZEL_TOKEN=<token> npx opscrew addon enable beszel --mode agent \
  --hub-url https://beszel.example.com --hub-key 'ssh-ed25519 AAAA…'
```

Without `OPSCREW_BESZEL_TOKEN`, OpsCrew asks for the token without showing it. The token is kept in
`beszel_secrets.json` and on the server, never in a file in your repository. The hub's address must
use HTTPS. The dashboard is then your hub: open it there.

## What Beszel can see

Beszel never touches Docker's socket. It reads Docker through a small proxy OpsCrew runs next to it,
which passes only these read requests:

- Docker's version and system information;
- the list of containers;
- each container's CPU, memory and network figures.

The proxy refuses everything else: starting, stopping or changing a container, running a command in
one, reading its files, its settings or its logs. So Beszel can't see the containers' settings, such
as your app's environment values, nor their log lines, and neither can a hub elsewhere.

Beszel shows every container on the server, those of other apps too.

Every Beszel container runs from an image pinned to a tested version, with a read-only file system,
no Linux capabilities and a memory limit, as the server's `deploy` user, which already has Docker
access. Its files are under `/home/deploy/opscrew/addons/beszel` on a server OpsCrew created, and
under `/srv/opscrew/addons/beszel` on your own.

On your own server with several OpsCrew apps, Beszel belongs to the app that turned it on. It already
shows every container on the server, so turning it on for another app is refused with the reason.

## Beszel's own alerts

Beszel can alert you when the CPU, memory or disk passes a limit you set, or when the server stops
reporting. Set them in the dashboard, under **Settings** → **Notifications** (see
[Beszel's notifications](https://beszel.dev/guide/notifications)). OpsCrew doesn't manage them.

A hub on the same server can't tell you that the server itself is down. The
[scheduled check](alerts.md) does, from GitHub.

## Turn it off

```bash
npx opscrew addon disable beszel
```

shows the plan that removes everything Beszel added to the server, and applies it after your
approval.

- **Hub mode:** the history goes too, so you type the app's name to confirm. In a script, add
  `--confirm <app name>`. With `--keep-data`, the history stays on the server and no name is needed;
  turning Beszel on again in hub mode uses it again, with the same password.
- **Agent mode:** the agent and its token are removed from the server and from your computer. Remove
  the system from your hub too.
- **A subdomain:** its tunnel route and Access rules go as well.

Commit the changed files afterwards.

## Rotating the token

Turning Beszel on again while it runs keeps the token the server already has. To use a new one,
turn it off, then on with the new one:

- **Agent mode:** in your hub, remove the system and add it again, which gives a new token. Then run
  `npx opscrew addon disable beszel`, and
  `OPSCREW_BESZEL_TOKEN=<new token> npx opscrew addon enable beszel --mode agent --hub-url … --hub-key '…'`.
- **Hub mode:** OpsCrew keeps the token, the password and the hub's key as long as Beszel's history
  is kept, so `disable --keep-data` and `enable` bring back the same ones. For new ones, run
  `npx opscrew addon disable beszel` without `--keep-data`, which deletes the history, then
  `npx opscrew addon enable beszel`.

## What it can't do

- **Run in a Portainer, on your computer, or on Cloudflare's hosting or GitHub Pages:** it needs a
  server OpsCrew deploys to. `npx opscrew logs` and `npx opscrew status` work on every target.
- **Show log lines or container settings:** the proxy keeps them from Beszel. `npx opscrew logs`
  shows the lines.
- **Alert you when its own server is down:** use the [scheduled check](alerts.md).
- **One Beszel per app on a shared server:** one per server, for the app that turned it on.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) can show Beszel's status and turn it on or off. You
approve each plan in a dialog. To open the dashboard, run `npx opscrew addon open beszel` in your
terminal.
