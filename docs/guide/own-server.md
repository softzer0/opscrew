# Deploy to a server you already have

OpsCrew can deploy your app to a server you already pay for or run yourself: a rented server at
Contabo, OVH, Hetzner Robot, Vultr or Linode, a machine at work, or a mini PC or Raspberry Pi at
home. You get the same result as on the servers OpsCrew creates for you: a hardened server, the app
deployed from GitHub with TLS, health checks and rollback, and the `verify`, `secure` and `drift`
checks.

OpsCrew never creates, reinstalls or deletes your server. It inspects it first, shows you every
change it would make, and changes nothing until you approve that exact list.

## What you need

- A server with Ubuntu 22.04, 24.04 or 26.04 LTS, or Debian 12 or 13, on amd64 (x86-64) or arm64
  (for example a Raspberry Pi with the 64-bit OS).
- SSH access with a key, as `root` or as a user that can run `sudo` without a password. OpsCrew
  never asks for a password or a passphrase: give it the path to your key file, or let it use your
  SSH agent (which also covers a key with a passphrase).
- One OpsCrew app per server. Sharing a server between several OpsCrew apps comes later.
- On your computer: Node.js 22 or newer, git, OpenTofu or Terraform, and a GitHub repository with
  your app, as for every OpsCrew deployment.
- For a custom domain: a domain whose DNS is on Cloudflare and a Cloudflare API token
  (`CLOUDFLARE_API_TOKEN`). A server that the internet cannot reach (see
  [Home servers](#home-servers-and-the-cloudflare-tunnel)) always needs one.

If your sudo user needs a password, OpsCrew stops and tells you how to allow passwordless sudo for
that user (a line in `/etc/sudoers.d/`), or connect as `root` instead.

## Step by step

1. `npx opscrew interview`: choose **A server you already have**. OpsCrew then asks for the server's
   address (IP address or host name), the SSH port (usually 22), the SSH user, which key to use (a
   path such as `~/.ssh/id_ed25519`, or `agent`), whether the internet can reach the server and how
   your site is served (see [How visitors reach your server](#how-visitors-reach-your-server)).
   In scripts, put the same answers in a file and pass `--answers <file>`:

   ```yaml
   provider: own
   server.host: 203.0.113.20
   server.port: 22
   server.user: root
   server.key: ~/.ssh/id_ed25519
   server.reachable: true
   ```

2. `npx opscrew design`: OpsCrew connects to the server for the first time and shows its SSH host
   key fingerprint. Check it against the server itself, for example in your provider's web console:
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. Approve only if they match. OpsCrew then
   reads the server's size, memory, disk and architecture (it changes nothing) and offers it as the
   one option. There is no server price, because you already pay for it. OpsCrew warns you when the
   server has less memory or free disk than the app needs.
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment. Merge its
   pull request.
4. `npx opscrew provision` shows two plans and asks for each separately:
   - the **infrastructure plan**: the DNS records on Cloudflare (or, for a home server, the
     Cloudflare Tunnel and its access rules), with its hash;
   - the **host plan**: every change OpsCrew would make on your server, each marked as already in
     place or to be changed, with its hash.

   It then stores the deploy secrets in GitHub and opens a pull request with the deploy workflow.
   Merging it runs the first deploy.
5. `npx opscrew verify` checks the live site and writes `opscrew/RUNBOOK.md`; `npx opscrew secure`
   checks the server's hardening.

Running `npx opscrew provision` again later shows what is still missing; on a prepared server both
plans show no changes and nothing on the server changes.

### In scripts

Without a terminal, nothing is approved for you:

```bash
npx opscrew design --host-key SHA256:...                  # the fingerprint you checked
npx opscrew provision --plan-only --yes                   # prints both hashes and the command
npx opscrew provision --approve <infrastructure hash> --approve <host plan hash> --yes
```

Each `--approve` names exactly one plan you reviewed. `--yes` only approves writing the files,
storing the GitHub secrets, pushing and opening the pull request; it never approves a plan.

## What OpsCrew changes on your server

The host plan lists these steps, and only the ones that are not in place yet are changed:

- **Docker Engine 28 or newer** and the Compose plugin from Docker's own repository (an older
  Docker from that repository is upgraded). Docker 28 keeps ports that are published only on the
  server itself really local.
- **Docker settings** in `/etc/docker/daemon.json`: log rotation, no-new-privileges, live-restore.
- **A `deploy` user** with the project's deploy key and access to Docker. GitHub Actions deploys
  as this user. It has no password.
- **SSH hardening** in `/etc/ssh/sshd_config.d/10-opscrew.conf`, checked with `sshd -t` before
  SSH reloads:
  - password logins are turned off, unless other users on the server still log in with a password
    and have no key; then OpsCrew asks you to choose: `--password-logins off` turns them off
    anyway, `--password-logins keep` leaves them on;
  - if you connect as `root`, root keeps logging in with its key only (so you are never locked
    out); otherwise root logins are turned off. The stricter option is a sudo user and no root
    login.
- **The ufw firewall**: incoming traffic is denied except SSH on the port your server really uses
  (never port 22 by assumption) and, when the server serves the web itself instead of through the
  tunnel, HTTP and HTTPS. OpsCrew does not add a second firewall when your server already uses
  firewalld or its own nftables rules; it stops and explains instead.
- **The Cloudflare-only filter**, only when you chose to serve directly behind Cloudflare's proxy
  (see [How visitors reach your server](#how-visitors-reach-your-server)).
- **fail2ban** for SSH, and **automatic security updates**.
- `/srv/app` and `/srv/data` for the app's runtime files and data, and a marker that this server
  runs your OpsCrew app.

SSH and firewall changes run under a safety switch: before the change, the server schedules its own
undo; afterwards OpsCrew opens new SSH connections as `deploy` and as your own user, and only when
both work does it cancel the undo. If they do not work, the server puts the previous settings back
by itself, even if OpsCrew lost its connection.

OpsCrew changes nothing it did not list, never removes software, users, containers or files it did
not install, and records every change (and the value it replaced) in `/etc/opscrew/host.json` on
the server. If the connection drops while it works, the next `npx opscrew provision` shows only what
is still missing.

## When OpsCrew stops without changing anything

It names what it found and what you can do when:

- another web server or app already listens on ports 80 or 443 (free the ports, or use a
  Cloudflare Tunnel);
- another firewall manages the server (firewalld, or nftables rules of its own);
- Docker comes from Snap, from your distribution's package (`docker.io`) or is Podman;
- the operating system is not one of the supported releases;
- your user needs a password for `sudo`;
- the server already runs another OpsCrew app.

## How visitors reach your server

The interview asks how your site is served. There are three ways:

1. **Through a Cloudflare Tunnel** (the default whenever your site is behind Cloudflare's proxy,
   also for a server with a public address, and the only way for a server the internet cannot
   reach). The server connects out to Cloudflare and opens no web port at all, so nobody can reach
   the app around Cloudflare. It needs Cloudflare Zero Trust turned on (free); see
   [Cloudflare Tunnel](#home-servers-and-the-cloudflare-tunnel) below. Pick this unless you have a
   reason not to.
2. **Directly behind Cloudflare's proxy, with a Cloudflare-only filter** (an explicit choice for a
   server with a public address and a domain on Cloudflare). Your domain points at the server
   through Cloudflare, and a filter lets only Cloudflare's addresses reach ports 80 and 443. The
   filter sits in Docker's own `DOCKER-USER` chain, because ports that Docker publishes bypass ufw
   and ufw rules could not limit them. It fails closed: if the filter cannot be installed when the
   server starts, Docker does not start either, so the site goes down instead of being open to
   everyone. Pick this when you cannot or do not want to use Cloudflare Zero Trust. When Cloudflare
   changes its address ranges, the next `npx opscrew provision` shows the update as a host plan
   change and `npx opscrew drift` reports it.
3. **Directly, DNS only** (no Cloudflare proxy, or your DNS somewhere else). The server answers
   everyone on ports 80 and 443, as any web server does, with no Cloudflare protection in front.
   Pick this only when you do not use Cloudflare. With another DNS provider you add the record
   yourself.

## Home servers and the Cloudflare Tunnel

When the internet cannot reach your server (at home, behind a router), or when you choose the
tunnel for a server with a public address, OpsCrew serves the app through a **Cloudflare Tunnel**:
the server connects out to Cloudflare, and no inbound web port is opened. The firewall then allows
only SSH.

- You need a domain whose DNS is on your Cloudflare account.
- **Cloudflare Zero Trust must be turned on** for your account: open
  [one.dash.cloudflare.com](https://one.dash.cloudflare.com/), pick a team name and the Free plan.
  OpsCrew tells you when it is not on yet, and changes nothing until it is.
- The server must be allowed to connect out to Cloudflare on port 7844.
- GitHub Actions still deploys after every merge: it reaches your server's SSH through a separate
  hostname (for the app `shop` on `example.com`: `ssh-shop.example.com`) that Cloudflare Access
  protects with a service token only your repository's deploy secrets hold. The tunnel's token
  stays on your server and in those secrets.
- While you run `npx opscrew provision`, your computer must reach the server directly (on the same
  network, or through your VPN).

Switching an existing deployment between serving directly and the tunnel runs as two applies:
OpsCrew first removes the old DNS records, then adds the new ones.

### Cloudflare token permissions

Your `CLOUDFLARE_API_TOKEN` needs Zone → Zone → Read, Zone → DNS → Edit, Zone → Config Rules → Edit
and Zone → Zone WAF → Edit, as for every OpsCrew deployment. Tunnel mode (and a Portainer subdomain)
also needs:

- Account → Cloudflare Tunnel → Edit
- Account → Access: Apps and Policies → Edit
- Account → Access: Service Tokens → Edit
- Account → Access: Organizations, Identity Providers, and Groups → Edit

## The server's host key

The first time OpsCrew connects, you confirm the server's SSH host key fingerprint (or pass it with
`--host-key` in scripts). OpsCrew pins it for this project. If the server ever presents a different
key, every command stops with a warning and changes nothing: someone may be intercepting the
connection. If you reinstalled the server or replaced its keys yourself, check the new fingerprint
on the server and run the command again with `--host-key` and that fingerprint.

## Where your server's address is kept

The address, SSH port, user, key path and the pinned host key are kept on your computer only, in
`.opscrew/server.json` (which `opscrew init --fix` adds to `.gitignore`). They never go into
`opscrew/plan.yaml`, other files in your repository, pull requests or commit messages. GitHub
Actions gets the address it deploys to as an encrypted deploy secret. If `.opscrew/server.json` is
damaged, fix it rather than deleting it: it holds the host key you confirmed.

## Day to day

- `npx opscrew drift` compares the server with what OpsCrew set up (SSH settings, firewall rules,
  the deploy user, runtime files and containers) and Cloudflare with the plan, and reports every
  difference without changing anything.
- `npx opscrew secure` checks the server's hardening and probes it from outside.
- `npx opscrew verify` checks the live site.

## Backups are your responsibility

OpsCrew cannot turn on backups or snapshots on a server it did not create. Back up the app's data
yourself, in particular `/srv/data` (where the database keeps its files) and the app's Docker
volumes, for example with your provider's backup feature or a nightly copy to another machine.

## Removing the app, and undoing OpsCrew's changes

`npx opscrew destroy` removes only what OpsCrew set up for the app: its containers and runtime
files, the deploy workflow's secrets, and the DNS records or tunnel it created. It asks you to type
the app's name first, and never deletes, rebuilds or reinstalls your server.

- The app's data stays on the server unless you add `--delete-data`; deleting it needs the app's
  name typed as well.
- `npx opscrew destroy --undo-host` also reverses OpsCrew's own changes to the server (the deploy
  user, its SSH and firewall settings, automatic updates, the runtime directories), from
  the record in `/etc/opscrew/host.json`, as a separate plan you approve. Docker stays installed,
  because other software may use it. It also works after an earlier `destroy`.
- In scripts: `npx opscrew destroy --confirm <app name>`; the undo plan then needs
  `--approve <its hash>`, which the run prints.

Moving an app between your own server and Hetzner Cloud or DigitalOcean is not supported yet.
