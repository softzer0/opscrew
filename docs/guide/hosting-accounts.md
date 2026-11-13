# Deploy to a hosting account: cPanel, Plesk, DirectAdmin or SFTP

Many apps live on hosting you already pay for: a control panel, no root, no Docker. OpsCrew can
deploy to such an account. It sets the app up through the panel's API from your computer, then
deploys each release with a switch in one step, keeps the releases before it for a rollback, and
checks the app after every switch. Your app's secrets stay on the account, outside the web root.

Nothing on the account changes until you approve the exact plan, which OpsCrew shows with its
SHA-256 hash first. OpsCrew only ever changes or removes what it made there: an existing site, a
database or a mailbox of yours is never touched.

Each panel has its own page, with the variables to set and its limits:

- [cPanel](cpanel.md)
- [Plesk](plesk.md)
- [DirectAdmin](directadmin.md)
- [A host you reach over SFTP only](sftp.md)

This page is what they share. An account on a panel is called a *panel account* below; an SFTP host
works differently, as its page says.

## What fits

A hosting account runs code only while it answers a request. It fits:

- static sites, including those your build makes;
- PHP apps: plain PHP and [Laravel](https://laravel.com/), with a MySQL or MariaDB database;
- Node.js and Python apps, on a panel account whose panel runs them (CloudLinux's selector), while
  it has an app slot left.

`npx opscrew design` refuses an app that needs more, says why and names a server target instead:

- a worker that keeps running, or a queue (its worker keeps running too);
- Redis, or any service that runs only in a container (keep a hosted one with
  `keepExternalServices` in `opscrew interview`);
- WebSockets from PHP;
- PostgreSQL: OpsCrew makes only MySQL and MariaDB databases on an account so far;
- an app larger than the disk the account has left.

The PHP version and its extensions are read on the account at provision; see
[The PHP version](#the-php-version).

## What you need

- The variables of your panel, or of your SFTP host, in your shell (see the panel's page).
  `npx opscrew init` checks them; nothing is sent anywhere then.
- A GitHub repository with your app, and `GITHUB_TOKEN` as for every OpsCrew deployment (see
  [The GitHub token](security.md#the-github-token)). On a panel account it also needs
  Administration: Read and write, for the agent's deploy key.
- `CLOUDFLARE_API_TOKEN` only when the hostname's DNS is on Cloudflare: OpsCrew then adds its A
  record to the account's address, DNS only, through its own approval.

Then run the usual steps:

```bash
npx opscrew interview    # choose "A hosting account"; OpsCrew finds the panel and asks the hostname
npx opscrew design       # what the account offers and what the app gets there
npx opscrew provision    # the plans, each approved by its hash
```

The interview offers a hosting account only while your panel's or your SFTP host's variables are
set. It finds which panel answers by itself, and asks for the hostname: a new subdomain of one of
the account's domains, or a domain of yours the account doesn't serve yet (added to the account
as a new domain). OpsCrew never takes over a hostname that exists. Design shows the web server
(Apache or LiteSpeed), the database engine, the disk left and the app slots left, and no price: you
already pay for the account.

## How a deploy works

On a panel account, a small deploy script, the **agent**, runs on the account itself. Cron starts
it every minute as the account's user, with this cron line (its output goes to `state/agent.log` in
the same folder):

```text
* * * * * /bin/bash "$HOME/opscrew/<app>-<env>/agent.sh" >> …/state/agent.log 2>&1
```

When you push to the deploy branch:

1. **GitHub Actions builds the release:** Composer's packages, the assets, a static site's build.
2. **It publishes the release** on the branch `opscrew/release/<env>` of your repository, signed
   with the release signing key, a secret of the deploy environment (`OPSCREW_RELEASE_SIGNING_KEY`).
3. **The agent fetches it** within the minute, with a read-only deploy key it made itself on the
   account, and checks the signature with the key's public half. A release that isn't signed by
   that key, or one older than the last it tried, is refused and never deployed.
4. **It prepares the release** in a folder of its own, runs the release command (Laravel's
   migrations, for example) with the hostname's PHP, then **switches** the hostname to it with one
   rename.
5. **It checks the app** over HTTPS until it answers with the new release (the
   `X-OpsCrew-Release` header). When it doesn't, the agent switches back. A failed release command
   leaves the running release untouched.
6. **The workflow waits** until the account serves the release, up to 10 minutes. When it doesn't,
   the run fails and says to run `npx opscrew status --env <env>`, which shows why.

A release goes live about a minute after its build. The agent keeps the 3 releases before the
running one for a [rollback](#rolling-back).

On a panel account, no credential for the account is ever in GitHub. GitHub holds only the key
that signs releases; the account holds its public half, so nothing on the account can sign one.
Whoever can run the deploy environment's workflow can deploy, as on a server. A pull request's
workflow can't sign a release where GitHub limits the environment's secrets to the deploy branch;
where GitHub can't (a private repository on GitHub Free), OpsCrew says so before the signing
key's own approval.

### The release branch

`opscrew/release/<env>` holds one commit: the built release, without the `.git`, `.github`,
`node_modules` and `opscrew` folders. Each deploy replaces it with a force-push, so the branch has
no history. Leave it alone: it is how the agent gets each release, and `npx opscrew destroy`
removes it.

### On the account

Everything OpsCrew puts on the account is in `~/opscrew/<app>-<env>/`:

| Path | What it is |
|---|---|
| `agent.sh`, `settings.sh` | The agent and its settings, copies of `opscrew/hosting/agent.sh` and `opscrew/hosting/<env>.sh` in your repository |
| `releases/` | The running release and the 3 before it |
| `current` | The link to the running release; the hostname serves it |
| `shared/` | The app's settings (`.env`, 0600), the database's login for its dumps, Laravel's `storage` |
| `dumps/` | The database dumps and [snapshots](#snapshots) |
| `state/` | The agent's status, its log (its last 1,000 lines) and the app's cron output |

The hostname's document root is the running release's folder itself, where the panel allows a
document root outside `public_html`. Otherwise it is a link in `public_html` (cPanel) or the folder
the panel made for the hostname (DirectAdmin), pointing at the release. Such a folder can be
reached through the main domain too, which OpsCrew's `.htaccess` rules refuse: they answer only the
app's hostname.

## The panel's token

On a panel account, OpsCrew reads the panel's token from `OPSCREW_HOSTING_TOKEN` on your computer,
and uses it there only. It is never written to the plan, a file, a log or GitHub. The panel and
the user are saved in `.opscrew/hosting.json`, on your computer.

**A cPanel API token reaches the whole account:** every site, database and mailbox on it. cPanel
can't limit a token to some features or addresses: it drops such limits and keeps the token's full
access. Keep it in your shell's environment only, give it an expiry date in cPanel, and revoke it
in cPanel (Security → Manage API Tokens) when you no longer run OpsCrew's commands. Deploys don't
need it: the agent deploys without it.

## Provision: two plans

`npx opscrew provision` shows and applies two plans on a panel account, each approved by its own
hash:

1. **Plan A, the agent:** the app's folder with the agent, its settings and GitHub's host keys,
   then the agent's cron line. OpsCrew then waits up
   to 3 minutes for the agent's first report: the PHP versions and extensions on the account, its
   tools, whether it reaches GitHub, and its deploy key.
2. **Plan B, the app,** built from that report: a new release signing key (its private half goes
   to GitHub, its public half to the account), the database and its user (the password generated
   then, kept only in the app's settings on the account), the app's settings, the hostname with its
   document root and its PHP version, the app's cron jobs, and the certificate.

When the report shows the account can't run the app, provision stops after plan A with the reason
and what to do; `npx opscrew destroy` removes the agent.

Before plan B, the DNS record on Cloudflare gets its own approval. While plan B applies, the
signing key's private half goes to GitHub after its own approval. Then the agent's deploy key on
GitHub and the deploy workflow in the provision pull request, each with its own approval.

The values of your app's settings never appear in a plan: it lists their names and a digest. Where
the panel's API can't make something, the plan lists it as a step for you to do in the panel, with
the exact values; provision stops there, and running it again continues once you have done it.

On cPanel (AutoSSL) and DirectAdmin the panel issues the hostname's free certificate by itself;
provision waits up to 5 minutes for it and says why when it doesn't come. On Plesk the certificate
is yours (see [Plesk](plesk.md#its-limits)). Until the agent sees a valid certificate,
the app answers over HTTP; then OpsCrew's rules redirect HTTP to HTTPS.

## The PHP version

Design reads what your app needs from `composer.json` and `composer.lock`: its PHP version and
extensions. At provision, the agent's report says what the account has, and plan B picks the
first that fits:

1. the account's own PHP version;
2. a version for this hostname alone, set through the panel: cPanel's MultiPHP sets it; on Plesk
   and DirectAdmin it is a step for you in the panel;
3. on a CloudLinux account served by LiteSpeed, another version for this hostname through a handler
   line in its `.htaccess`, when that version's default extensions cover the app. Only the default
   extensions load that way: no `mbstring`, `fileinfo`, `intl` or `gd`, for example.

When none fits, provision stops before it makes the hostname or the database, and names what the
app needs and what the account has. **OpsCrew never changes the account's PHP version:** every site
on the account shares it, and a change could break the others. You can change it yourself in the
panel's PHP selector (every site on the account changes with it), or ask your host for PHP per site
(CloudLinux Isolates); then run `npx opscrew provision` again.

The release command and the app's cron jobs run with the chosen version's PHP, never with the PHP
cron finds first. `npx opscrew verify` checks the version the app answers with.

## LiteSpeed and Apache

Design says which web server serves the account. OpsCrew's `.htaccess` rules work the same on both.
After a PHP app's switch, the agent makes PHP serve the new release:

- **On LiteSpeed,** it restarts the account's PHP processes and empties LiteSpeed's page cache.
  The restart reaches **every PHP process of the account, other sites' included**, for a moment:
  LiteSpeed has no narrower restart for an account's user. It happens on every deploy and rollback
  of a PHP app; a static site's switch restarts nothing.
- **On Apache,** PHP keeps a path cache for up to 120 seconds (`realpath_cache_ttl`), so for up to
  2 minutes after a switch some requests may still run the release before. The agent's check
  waits that long before it counts, and `npx opscrew status` says so.

## Your app's settings

Your app's values and the database's password go from your computer to 0600 files in
`~/opscrew/<app>-<env>/shared/`, outside every web root. GitHub never gets them. Laravel reads its
`.env`; a plain PHP app reads them through `getenv()`, `$_ENV` and `$_SERVER`, which OpsCrew's
`env.php` fills before the app runs.

To change a value, run `npx opscrew provision` again: the plan lists the settings' names and a new
digest; nothing else changes. The agent puts the new settings in place.

OpsCrew's `.htaccess` block comes first in each release's `.htaccess`; what the panel wrote there
and your app's own `.htaccess` follow it, unchanged. The block turns directory listings off, refuses
dotfiles and every other hostname, redirects to HTTPS once there is a certificate, and sets the
security headers.

## Status, logs and checks

- `npx opscrew status` shows what the agent last did; see
  [What each target can't give](logs-and-status.md#what-each-target-cant-give).
- `npx opscrew logs` shows the agent's last lines; see
  [Your app's logs](logs-and-status.md#a-hosting-account).
- `npx opscrew verify` checks that the app answers over HTTPS with the release, that HTTP
  redirects, and that its settings, `.htaccess`, the release folders and Composer's packages can't
  be read from the web.
- `npx opscrew secure` checks the PHP version against PHP's supported versions, that the settings
  are outside the web root, OpsCrew's `.htaccess` rules and HTTPS. The account itself is your
  host's to secure: OpsCrew has no SSH, firewall or kernel there to check.
- `npx opscrew drift` reports what changed in the panel since provision: the document root, the
  database, the cron jobs, the agent and its settings, and the deploy key on GitHub.

## Snapshots

`npx opscrew snapshot` and `npx opscrew restore <id>` work through the agent. **Snapshots stay on
the account,** in `~/opscrew/<app>-<env>/dumps/`; how to keep a copy elsewhere is in
[On a hosting account](snapshots.md#on-a-hosting-account). With `deploy.snapshots` on (the
default), the agent also dumps the database before each release, and keeps the dumps of the
releases it keeps.

## Rolling back

```bash
npx opscrew rollback --list          # the releases the account keeps
npx opscrew rollback                 # back to the release before the running one
npx opscrew rollback --to <release>  # back to a kept release, such as 1234567890-1
```

The agent switches back in one step, and on LiteSpeed restarts PHP as after a deploy. Nothing is
rebuilt, and the release command doesn't run. For the database you choose between restoring the
dump taken when that release stopped running and keeping it as it is (`--database snapshot` or
`--database keep`); outside prod the dump is the default, on prod keeping it. Restoring needs the
hostname typed. Then deploys pause, as on a server; see
[Deploys pause after a rollback](rollback.md#deploys-pause-after-a-rollback).

## Removing the app

`npx opscrew destroy` shows a plan of what OpsCrew made, and nothing else, and needs the hostname
typed:

- a final dump of the database, offered first and kept in the app's `dumps/` folder (with
  `--no-snapshot`, none);
- the cron lines OpsCrew made, the agent's first;
- the hostname, and its link in `public_html` when there is one;
- the certificate issued for the hostname, when nothing else uses it;
- the database and its user;
- the app's folder (but the final dump), and `~/opscrew` when it is empty;
- the DNS record on Cloudflare; on GitHub, the deploy key, the signing key and the release branch.

## Commands that need a server

`opscrew vpn`, `opscrew runner`, `opscrew portainer`, the add-ons (Beszel, monitoring),
[previews](previews.md) and `opscrew retarget` need a server, and say so on a hosting account with
what to use instead. To move the app to a server, see
[What can't move yet](retarget.md#what-cant-move-yet).

## If you stop using OpsCrew

Your deployment keeps working. The agent and its cron line stay on the account, and the workflow
and the signing key stay in GitHub, so each push still deploys. The agent is a plain bash script
you can read in your repository (`opscrew/hosting/agent.sh`). To stop it, remove its cron line in
the panel; remove `~/opscrew/<app>-<env>/` there too when you no longer want the releases.
