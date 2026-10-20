# Deploy to a Portainer you already run

Many people already run [Portainer](https://www.portainer.io/) on a NAS (Synology, Unraid, TrueNAS)
or on any Docker host, and manage everything there. OpsCrew can deploy your app into that Portainer
as a stack, through Portainer's API. It needs no SSH and changes nothing on the host. You get the
same app runtime as on the servers OpsCrew creates: the app, its release command, and its
[components](components.md) (workers, cron jobs, databases, queues, brokers, Garage for object
storage, and the search and analytics engines that need no setting on the host). Every merged
change deploys by itself, with a health check and a rollback when
it fails wherever GitHub can reach the site (see
[How new versions reach Portainer](#how-new-versions-reach-portainer)), and `verify`, `secure` and
`drift` work as for every other deployment.

Nothing in Portainer changes until you approve the exact plan. OpsCrew shows it with its SHA-256
hash first.

This page is about a Portainer you already run. To install Portainer on a server OpsCrew deploys
to, see [Portainer: a web UI for your containers](portainer.md).

## What you need

- Portainer CE or Business Edition **2.45 or newer** with Docker Compose 2.23 or newer. OpsCrew
  checks both first and tells you when one is too old.
- An environment that is **a single Docker host**, either local or through the Portainer agent, on
  amd64 (x86-64) or arm64. OpsCrew refuses Docker Swarm, Kubernetes and Edge agent environments for
  now.
- Portainer's **HTTPS address**, for example `https://nas.local:9443`. OpsCrew sends the access
  token only over HTTPS. Plain `http://` works only for a Portainer on the same computer as OpsCrew.
- The tokens listed below, in environment variables of your own shell.
- On your computer: Node.js 22.9 or newer, git, OpenTofu or Terraform, and a GitHub repository with
  your app, as for every OpsCrew deployment.
- A domain for your site (optional with your own reverse proxy). With the Cloudflare Tunnel or
  Cloudflare redeploys, its DNS must be on Cloudflare. With your own reverse proxy or Caddy, DNS can
  be anywhere.

## The tokens and what they may do

OpsCrew reads every token from an environment variable and never saves it. It never asks for a
Portainer password. Give each token only the access listed here.

| Variable | When you need it | What to create |
|---|---|---|
| `PORTAINER_API_KEY` | Always | A Portainer access token: in Portainer, open your user menu → **My account** → **Access tokens** → **Add access token**. Use an administrator's account, or a standard user whom an administrator gave access to the chosen environment (in Portainer's environment settings) and who may manage stacks there. |
| `OPSCREW_GHCR_READ_TOKEN` | Your app's image is private (the default) | A GitHub classic token with only the `read:packages` scope: <https://github.com/settings/tokens/new?scopes=read:packages>. GitHub's fine-grained tokens cannot read packages. OpsCrew puts it only into Portainer's registry entry. |
| `OPSCREW_REPO_READ_TOKEN` | Your repository is private | A GitHub fine-grained token for only this repository with **Contents: Read-only**: <https://github.com/settings/personal-access-tokens/new>. Portainer reads the deploy branch with it; OpsCrew sends it only to Portainer, for this stack. |
| `CLOUDFLARE_API_TOKEN` | Visitors come through the Cloudflare Tunnel (web mode `tunnel`) | A Cloudflare API token with Zone → Zone → Read, Zone → DNS → Edit, Zone → Zone WAF → Edit and Zone → Config Rules → Edit for your zone, plus Account → Cloudflare Tunnel → Edit. Turn on Cloudflare Zero Trust for the account (the free plan is enough). |
| `CLOUDFLARE_API_TOKEN` | New versions reach Portainer through Cloudflare (redeploy mode `cloudflare`) | A Cloudflare API token with Zone → Zone → Read, Zone → DNS → Edit, Zone → Zone WAF → Edit and Zone → Config Rules → Edit for your zone, plus Account → Cloudflare Tunnel → Edit, Account → Access: Apps and Policies → Edit, Account → Access: Service Tokens → Edit and Account → Access: Organizations, Identity Providers, and Groups → Edit. With both modes, give one token both lists. Turn on Cloudflare Zero Trust for the account. |
| `GITHUB_TOKEN` (or `gh auth login`) | Always | As for every OpsCrew deployment: OpsCrew pushes the deploy branch and opens the pull request with it. |

With your own reverse proxy or Caddy and the `updater` redeploy mode, OpsCrew needs no Cloudflare
token at all. The Cloudflare lists above are what OpsCrew uses today; the gated live test will
narrow them further, and when a permission is missing OpsCrew names it. Zone WAF, Config Rules and
the Access organizations permission are for what OpsCrew shares between your apps in the zone and
the account; see [Your domain on Cloudflare](cloudflare.md). OpsCrew reads both kinds of rules in
the zone even when your app uses only one of them, so the token needs both rule permissions.

With an administrator's token OpsCrew adds the registry entry for your image itself. A standard
user's token works too; see [A limited token and a private image](#a-limited-token-and-a-private-image).

## Step by step

1. `npx opscrew interview`: choose **My existing Portainer**. OpsCrew asks for Portainer's address,
   shows the fingerprint of Portainer's certificate and asks you to trust it (see
   [Portainer's certificate](#portainers-certificate)), then lists the environments your token can
   see. Pick one, then choose how new versions reach Portainer and how visitors reach the app. In
   scripts, put the answers in a file and pass `--answers <file>` and
   `--portainer-cert SHA256:…`:

   ```yaml
   provider: portainer
   # ... the usual answers (expectedMonthlyUsers, budgetMonthly, uptime, ...), then:
   domain: shop.example.com
   dnsProvider: cloudflare
   portainer.url: https://nas.local:9443
   portainer.environment: local     # its name or id in Portainer
   portainer.redeploy: updater      # updater or cloudflare
   portainer.web: tunnel            # tunnel, proxy or caddy
   # portainer.port: 8080           # with proxy: the host port the app listens on
   ```

   The address and the environment are saved in `.opscrew/server.json` on your computer only, never
   in your repository. Only `provider: portainer` goes into `opscrew/requirements.yaml`.
2. `npx opscrew design` offers one option: your Portainer, with no server price (you already run
   it). OpsCrew builds the image for the environment's architecture.
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment. Merge its pull
   request.
4. `npx opscrew provision` shows up to three plans and asks for each separately:
   - the **Cloudflare plan**, when you use Cloudflare, with its hash: with the Cloudflare Tunnel
     (web mode `tunnel`), your app's hostnames in the probe block OpsCrew keeps in your zone for
     all its apps; with Cloudflare redeploys (redeploy mode `cloudflare`), the account's Zero Trust
     organization (see [Your domain on Cloudflare](cloudflare.md));
   - the **infrastructure plan** for Cloudflare (the tunnel, and Access in front of Portainer's
     webhook in the Cloudflare redeploy mode), when you use Cloudflare;
   - the **stack plan** for Portainer: every change OpsCrew would make there, each marked as
     already in place or to be changed, with its hash.

   It then creates the `opscrew-deploy` branch, stores the deploy secrets in GitHub and opens a pull
   request with the deploy workflow. Merging it runs the first deploy.
5. `npx opscrew verify` checks the live site and writes `opscrew/RUNBOOK.md`; `npx opscrew secure`
   checks the app's stack and writes `opscrew/SECURITY_REPORT.md`.

Running `npx opscrew provision` again later shows what is still missing. On an unchanged setup the
plans show no changes and nothing in Portainer changes.

### In scripts

Without a terminal nothing is approved for you. Each `--approve` names exactly one plan you
reviewed, and `--yes` only approves writing the files, storing the GitHub secrets, pushing and
opening the pull request. It never approves a plan.

```bash
npx opscrew provision --plan-only --yes                 # prints the hashes and the command
npx opscrew provision --approve <Cloudflare plan hash> --approve <infrastructure hash> --approve <stack plan hash> --yes
```

With the Cloudflare Tunnel (web mode `tunnel`) or Cloudflare redeploys (redeploy mode
`cloudflare`), OpsCrew creates a tunnel, and the first stack plan needs that tunnel's token, which
exists only after the infrastructure plan is applied. So such a first setup takes three runs: the
first `--plan-only` prints only the Cloudflare plan's and the infrastructure plan's hashes;
applying them ends with an error that asks for the stack plan's approval and prints its hash; the
third run approves that hash.

```bash
npx opscrew provision --plan-only --yes      # the Cloudflare and infrastructure hashes
npx opscrew provision --approve <Cloudflare plan hash> --approve <infrastructure hash> --yes || true   # applies them, prints the stack plan's hash
npx opscrew provision --approve <stack plan hash> --yes
```

## Portainer's certificate

Portainer uses a self-signed certificate by default. OpsCrew never skips the check. Instead it
shows the certificate's SHA-256 fingerprint the first time and continues only after you trust it,
like an SSH host key. Check it before you do: open Portainer in your browser, click the padlock and
view the certificate's SHA-256 fingerprint, or run this on the Portainer host itself:

```bash
openssl s_client -connect localhost:9443 </dev/null | openssl x509 -noout -fingerprint -sha256
```

OpsCrew pins the fingerprint and checks it before every request. If the certificate changes later,
every command stops, sends nothing and names both fingerprints. If you changed the certificate
yourself, run `npx opscrew interview` again to trust the new one (`--portainer-cert` in scripts).
Otherwise, do not continue: someone may be intercepting the connection to Portainer.

## What OpsCrew creates in Portainer

Every name starts with `opscrew-` and your app's name, so it cannot be mistaken for yours:

- **`opscrew-<app>`**: the app's stack, deployed from the `opscrew-deploy` branch of your
  repository. It holds the app, its release command (which runs before a new version takes
  traffic) and its components, with named volumes for their data. The app's secrets
  are set only as the stack's environment, through Portainer's API from your computer.
- **`opscrew-<app>-updater`** (redeploy mode `updater`): a tiny stack that only asks Portainer to
  redeploy the app.
- **`opscrew-<app>-portainer-tunnel`** (redeploy mode `cloudflare`): the Cloudflare connector in
  front of Portainer's webhook.
- **A `ghcr.io` registry entry** with your read-only registry token, granted to the environment, so
  Portainer can pull a private image (only with an administrator's token).
- **The `opscrew-deploy` branch** in your repository. It holds only the stack file with the current
  image, written by the deploy workflow.

OpsCrew records what it created in `.opscrew/server.json`, so removing the app later removes exactly
that.

If you deploy several apps to one Portainer, each app gets its own `ghcr.io` registry entry, named
after the app (`opscrew-<app>`). When Portainer pulls an image it may log in to `ghcr.io` with any of
these entries, so each app's read token must be able to read every app's image. One GitHub classic
token with only `read:packages` from your GitHub account does that: use it as
`OPSCREW_GHCR_READ_TOKEN` for every app.

### What OpsCrew never touches

- Your other stacks, containers, volumes, networks and registry entries. If a stack already uses
  one of OpsCrew's names (or, seen with an administrator's token, a Compose project started outside
  Portainer), OpsCrew stops and tells you how to choose another name.
- Portainer's own settings, users and security.
- The host: its operating system, firewall, SSH and Docker settings stay exactly as they are.
  Keeping them secure stays your job, and so does keeping Portainer up to date.

## How new versions reach Portainer

After each merge, GitHub Actions builds the image, pushes it to GitHub Container Registry and writes
the stack file with the new image to the `opscrew-deploy` branch. Then it checks the site's health.
When the check fails, it writes the previous image back, so the previous version runs again, and the
run fails.

Behind your own reverse proxy, GitHub Actions can check the site only when it can reach it from the
internet. When the app has no domain, or its domain answers only on your own network, the run skips
the health check and the rollback: it records the new image and finishes. Check such a site
yourself after a merge, for example with `npx opscrew verify --url <address>`. When a new version
fails, revert the change: merging the revert deploys the previous version.

- **`updater`** (recommended): the updater stack asks Portainer once a minute, over your local
  network and with Portainer's certificate pinned, to redeploy when the branch changed. Nothing is
  opened to the internet and no Cloudflare is needed. A merged change is live within a few minutes.
- **`cloudflare`**: the workflow asks Portainer to redeploy at once, through a hostname
  (`portainer-<app>.<your zone>`) protected by Cloudflare Access with a service token. Only Portainer's
  webhook path is reachable there, and only with that token. It needs your domain on Cloudflare and
  Cloudflare Zero Trust.

## How visitors reach your app

- **`tunnel`** (recommended with a domain on Cloudflare): a Cloudflare Tunnel runs in the app's
  stack. No port is opened on your host, and it works behind a router with no open ports.
- **`proxy`**: the app listens on a port of your host that you choose, for example `8080`. You route
  your domain to it with the reverse proxy you already run (Nginx Proxy Manager, Traefik, your NAS's
  own proxy) and manage its certificate there.
- **`caddy`**: Caddy serves the app on ports 80 and 443 of the host with automatic certificates.
  OpsCrew checks that the ports are free first. Your NAS's own web interface often uses them, and
  only one app on the host can have them. OpsCrew also waits for your DNS record before it starts
  Caddy, so Let's Encrypt issues the certificate at once. Without the record,
  `npx opscrew provision` stops before Caddy can start and names the record to create: Caddy asks
  for the certificate as soon as it starts, and DNS resolvers can remember a missing record for up
  to 30 minutes. Create the record, then run `npx opscrew provision` again: it continues from
  there. When you switch from the tunnel, that run first deletes the tunnel's record at the same
  name, so you create yours after it.

With `proxy` and `caddy`, OpsCrew creates no DNS record, because your home address can change and
OpsCrew never stores it. It prints the record to create instead: an A record (and AAAA for IPv6) to
your public address, or a CNAME to your dynamic-DNS name. With `proxy` it also says which port your
proxy should forward to.

### Switching how visitors reach the app

You can change the web mode later: run `npx opscrew interview` and `npx opscrew design` again, then
`npx opscrew provision`. The site is down during the switch: visitors cannot reach it on the new
route until you merge the deploy pull request and your DNS or reverse proxy points at the new route.
Leaving the tunnel also deletes it on Cloudflare, so that plan asks you to type the app's name
(`--confirm <app>` in scripts).

## A limited token and a private image

Only a Portainer administrator can add registry entries. With a standard user's token and a private
image, OpsCrew stops before it changes anything and shows these one-time steps. Do one of them, then
run `npx opscrew provision` again:

1. As a Portainer administrator: **Registries** → **Add registry** → **Custom registry**. Name it
   (for example `ghcr`), set the registry URL to `ghcr.io`, turn on **Authentication**, and enter your
   GitHub user name and a classic token with only `read:packages`. Then open the environment →
   **Registries**, choose **Manage access** next to the entry and add the user your token belongs
   to.
2. Or make the image public: on GitHub, open the package (your profile or organisation →
   **Packages**) → **Package settings** → **Change visibility** → **Public**. Then run
   `npx opscrew provision --public-image`.

OpsCrew cannot see whether an image is public before its first build, so it treats it as private
until you pass `--public-image`. It remembers that choice. To go back to a registry entry later, run
`npx opscrew provision --private-image`.

### Rotating a token

Portainer never shows the repository or registry token back, so OpsCrew sends them only when it
creates the stack or the registry entry. After you rotate one, set the new value and run
`npx opscrew provision --replace-token repository` or `--replace-token registry` (repeat the flag
for both). The stack plan names what it replaces, never the token.

## Your app's variables

OpsCrew reads the values of your app's environment variables on your computer: in a terminal it
offers the values in your project's `.env` (each only after you confirm it) or lets you type them
in; in scripts it reads them from the file `OPSCREW_APP_ENV_FILE` names. OpsCrew generates the values it creates itself, such as the database password, and
keeps them in its local state. At runtime the values live only in the stack's environment in
Portainer. The values the image needs while it is built are also stored in the GitHub Actions secret
`OPSCREW_BUILD_ENV`, which the deploy workflow reads. OpsCrew never prints, plans, audits or commits
any value; a changed value shows in a plan by its name only. An optional variable you leave unset reaches the app as an empty
value, so make sure your app treats an empty value like a missing one.

## Day 2

- `npx opscrew verify` checks the site through its domain. Behind your own reverse proxy, add
  `--url <address>` to check the address your proxy serves the app on (needed when the app has no
  domain).
- `npx opscrew secure` checks the app and its stack through Portainer's API. It does not check the
  host.
- `npx opscrew drift` compares the stack's file, its environment keys (never values), its redeploy
  setting, the registry entry and the deploy branch with what OpsCrew would set up now, plus the
  Cloudflare resources. It changes nothing; run `npx opscrew provision` to undo drift.

## Backups

OpsCrew cannot back up a Portainer host. The app's data lives in the stack's named volumes (for
example the Postgres volume) on that host. Back it up yourself: with your NAS's snapshot or backup
feature, or by copying the volumes regularly to somewhere else.

## Removing the app

```bash
npx opscrew destroy                 # asks you to type the app's name
npx opscrew destroy --delete-data   # also deletes the app's data volumes
```

`destroy` shows what it removes and asks you to type the app's name first. It removes only what
OpsCrew created: the app's stacks, the registry entry, the deploy secrets in GitHub, the
Cloudflare tunnel, DNS records and Access, and the app's hostnames in OpsCrew's rules in your zone
(other OpsCrew apps there keep theirs; the account's Zero Trust organization stays). Portainer itself, its settings, your other stacks and the
host stay exactly as they are. The app's data volumes stay too, unless you add `--delete-data`;
deleting them cannot be undone unless you have your own backup. A later `--delete-data` run also
deletes the volumes an earlier `destroy` kept.

In scripts, pass the app's name: `npx opscrew destroy --confirm <app>` (with `--delete-data` to
delete the data as well).

## From Claude Code

The [OpsCrew plugin](../../plugin/README.md) offers the same choices. Every change in Portainer is
approved by you in a dialog, and you confirm Portainer's certificate in a dialog too; Claude never
confirms either for you. The access token comes only from `PORTAINER_API_KEY`, and the tools show
"your Portainer" instead of its address. Removing the app and deleting its data stay in your
terminal.
