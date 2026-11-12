# Implementation Plan: Shared hosting accounts (cPanel, Plesk, DirectAdmin, SFTP) and LiteSpeed

**Branch**: `main` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

## Summary

A new target kind, `hosting`, deploys an app to a shared hosting account. OpsCrew sets the account
up through the panel's API from the user's computer, in hosting plans approved by their hash. The
first plan installs a small deploy script, the **agent**, that cron runs every minute as the
account's user; its first report (PHP versions, tools, GitHub reachable, its own read-only GitHub
key) builds the second plan: the database, the app's settings, the hostname and its PHP version.
GitHub Actions builds each release and publishes it on a branch of the repository, signed with a
key only GitHub holds; the agent fetches it, checks the signature, prepares it, switches the
hostname's document root to it with one rename, restarts PHP, checks the app, and switches back on
a failure. No credential for the account reaches GitHub: the panel's token can't be limited
(research R10) and stays on the user's computer. Rollback, settings changes and snapshots are
one-time requests the CLI writes through the panel's API and the agent carries out.

An SFTP-only host has no cron and no panel: there GitHub Actions uploads and switches each release
over SFTP itself, and the CLI does the rest over SFTP. OpenLiteSpeed joins Caddy and nginx as a
third proxy on servers, a separate track.

## Technical Context

- TypeScript monorepo; connectors with injected `fetch`; host scripts as fixed templates with
  quoted parameters (`connectors/ssh-host/src/shell.ts`); the system `ssh` and `sftp` through the
  injected runner, as `agents/src/addons/status.ts` does.
- Builds on:
  - ADR 0011 (host plans approved by hash, two approvals in one provision), ADR 0019 (targets with
    no server, the `onServer` positive list), ADR 0023 and ADR 0028 (rollback, the deploy pause,
    snapshots filed under the outgoing release), ADR 0026 (bounds enforced on the target);
  - 013's plain PHP apps and Laravel's detection and release command; 014's recovery copy
    (`agents/src/secrets/files.ts`); 017's environments and GitHub environment secrets;
  - the GitHub connector (environments, secrets, `deleteBranch`).
- Research R8 maps where a target kind plugs in; R9 maps the proxy choice; R10 and R11 are what
  the test account showed, and what CloudLinux documents.

## Constitution Check

- **I (gate):** every change to the account is a step of a hosting plan approved by its SHA-256
  hash (new kind `hosting-apply`) and applied by OpsCrew's hosting adapter, the panel's connector,
  which refuses any other plan. Provision has two such plans, the second built from the agent's
  report, so nothing is decided during an apply that the approval didn't show. A destroy needs
  `allowDestroy` and the typed hostname. A rollback is a `promote` approval. Deploys of app code are
  not infrastructure changes, as on servers. Constitution 1.10.0 names the hosting adapter.
- **II (ownership):** the agent (`opscrew/hosting/agent.sh`, the same for every app) and each
  environment's settings (`opscrew/hosting/<env>.sh`, no secret in it) are committed; the account
  holds copies, checked by hash in `drift`. The built releases are on a branch of the user's own
  repository. Deleting OpsCrew leaves a cron line and a script the user can read and keep.
- **IV (secrets):** the panel's token is read from the environment on the user's computer only.
  The app's values and the database password go from the user's computer to 0600 files on the
  account, outside every web root, never to GitHub. GitHub holds the release signing key (an
  environment secret); the account holds only its public half and a read-only GitHub deploy key it
  generated itself, so nothing on the account can sign a release, and no secret is ever on a command
  line there. The guide states that a cPanel token is the whole account.
- **VI (contracts):** one new contract, `HostingPanel` (`contracts/src/hosting.ts`), with three
  implementations at once (cPanel, Plesk, DirectAdmin). The plan's target union gains `hosting`;
  `ApprovalKind` gains `hosting-apply`. ADR 0030 records the design; ADR 0031 records OpenLiteSpeed
  after its container spike.
- **VII (tests):** connectors against `fetch` fakes built from the spikes' answers (cPanel) and the
  documented APIs (Plesk, DirectAdmin); the agent run by `bash` with `git` and `openssl` against a
  local bare repository; the same flows against each panel's fakes (SC-2705); live passes on the
  founder's cPanel account, an SFTP host and an OpenLiteSpeed server.
- **X (lean):** no new runtime dependency. The agent is a bash script using `git`, `openssl`,
  `curl`, `tar`, `flock`, `ssh-keygen` and the account's PHP CLI, all on the test account (R11).

## Design

### 1. The target and the contract (T2701, T2702)

- **Plan target** `{ provider: "hosting", panel, app, webRoot, site?, php?, database?, cron[],
  runtime?, docroot? }`; the hostname is the plan's existing `dns.domain`, so the hostname checks,
  verify and status read it as for every target:
  - `panel`: `cpanel`, `plesk`, `directadmin` or `sftp`;
  - `app`: `static`, `php`, `node` or `python`;
  - `webRoot`: the folder inside a release the hostname serves: `public` for Laravel and for a
    plain PHP app with `public/index.php`; `.` for a static site (its release is the build's
    output) and for a plain PHP app without `public/`;
  - `site`: a static site's build (GitHub Pages' `SiteSchema`);
  - `php`: the version and how the hostname gets it (`account`, `multiphp` or `handler`), set by
    the second plan from the agent's report;
  - `database`: `mariadb` or `mysql`, the name without the account's prefix;
  - `cron`: the app's scheduled commands;
  - `runtime`: a Node.js or Python app's interpreter, version and startup file;
  - `docroot`: `outside` (the default) or `public_html` (section 5).

  The panel's address and the account's user stay in `.opscrew/hosting.json`, which joins the
  recovery copy's state files; the token comes from `OPSCREW_HOSTING_TOKEN`.
- **Guards:** `isHostingTarget`; `onServer` stays a positive list. Every exhaustive `switch` on
  `target.provider` gets a branch or a plain refusal (R8's list).
- **`HostingPanel`** (contract): `inspect()` (the account's domains, its address, quota, database
  engines and name limits, app selectors and slots, MultiPHP versions, whether document roots may
  be outside `public_html`), hostnames (a subdomain, or an addon domain for a name outside the
  account's domains), databases (made with their user and grant; removed and checked), cron lines,
  files (written atomically with a mode, a tar uploaded and unpacked, read, removed with their
  contents), certificates (read, requested, removed with a key no other certificate uses) and a
  hostname's PHP version (MultiPHP). What a panel's API can't do is a `PanelStep`: its exact text,
  shown in the plan for the user to do in the panel.

### 2. Two hosting plans at provision (`hosting-apply`)

ADR 0011's pattern for each: a zod schema of fixed step kinds, the hash of its canonical JSON, the
file under `.opscrew/plans/`, `approvals.request("hosting-apply", hash)`, an apply that recomputes
the hash and refuses a mismatch (`PLAN_HASH_MISMATCH`).

- **Plan A, the agent:** the app's folder `~/opscrew/<app>-<env>/` with the agent, its settings,
  the release signing key's public half and GitHub's host keys (from GitHub's `/meta`, for
  `github.com` and `[ssh.github.com]:443`); then the agent's cron line, `* * * * * /bin/bash
  ~/opscrew/<app>-<env>/agent.sh >> …/state/agent.log 2>&1`. Provision then waits up to 3 minutes
  for the agent's first report.
- **The first report** (`state/report`): the read-only deploy key the agent generated
  (`ssh-keygen -t ed25519`, its public half), `-v` and `-m` of the account's PHP CLI and of each
  alt-php and MultiPHP binary, the tools found, and GitHub reachable over SSH on 22 and 443. A fact
  that doesn't fit stops provision here with the reason and what to do; the agent and its line are
  recorded, and `opscrew destroy` removes them.
- **Plan B, the app,** built from the facts and the report:
  - the database and its user (the password generated at apply), the app's environment file with
    the database's values (`DB_HOST=localhost`, the prefixed names), `shared/mysql.cnf` for the
    dumps;
  - the settings file with the chosen PHP version's CLI and handler;
  - the hostname (and the link in `public_html` where needed), its PHP version through MultiPHP
    when that is the choice, the app's cron lines;
  - the DNS record when the domain is on Cloudflare (DNS only, through the existing
    `cloudflare-dns` module and the IaC approval);
  - the certificate wait (AutoSSL issues by itself, R10, R11; up to 5 minutes, its reason named
    otherwise);
  - on GitHub, through the existing approvals: the deploy key (`github-settings`), the signing key
    as an environment secret (`github-secrets`) and the workflow in the provision pull request.

  Values never enter the plan: the environment file is listed by its keys and a digest of the
  user's values; generated values are named as generated.
- **A panel step** (Plesk's scheduled task, for example) stops provision after listing it;
  provision run again continues once the user has done it.

Every object made is recorded in `.opscrew/hosting.json` with the panel's key for it, so destroy and
drift touch only those. A hostname that already exists is never taken over.

### 3. The agent (`opscrew/hosting/agent.sh`)

A bash script, the same for every app, its body in `main() { …; }; main "$@"; exit` so a rewrite
never breaks a running copy. It reads `settings.sh` (quoted assignments OpsCrew renders) and runs
under `flock -n`. Each run:

1. **First run:** generates its deploy key and writes the report (section 2).
2. **Requests** (section 6).
3. **A new release?** `git ls-remote` on `opscrew/release/<env>` with its key (`IdentitiesOnly`,
   `-F /dev/null`, its known-hosts file), over SSH on 22, or on `ssh.github.com:443` when 22 fails.
4. **Fetch and check:** a shallow fetch into a bare cache. The commit's trailer `OpsCrew-Release:
   <run id> <attempt> <env> <signature>` must verify with `openssl dgst -sha256 -verify
   keys/release.pub` over `<tree id> <run id> <attempt> <env>`, the environment must be its own,
   and `(run id, attempt)` must be greater than the last one attempted (`state/last`), so an old
   signed release pushed again is refused. A refusal is recorded and never deployed.
5. **Prepare** `releases/<run id>-<attempt>/` with `git archive`; link the shared paths (`.env`,
   Laravel's `storage`); carry over, byte for byte, what the panel and the selector wrote into the
   served folder of the running release (cPanel's `.htaccess` block, `.user.ini`, `php.ini`,
   `.well-known/`, the Passenger block); compose the release's `.htaccess` (section 5).
6. **Database and release command:** a dump (`mysqldump --defaults-extra-file=shared/mysql.cnf
   --single-transaction --no-tablespaces`) filed under the running release when snapshots are on
   (ADR 0028 D7: on except prod), 3 kept; then the release command with the chosen PHP CLI
   (`php artisan migrate --force`, then Laravel's caches, the cached config made 0600). A failure
   leaves the running release untouched.
7. **Switch:** `ln -s releases/<id> current.next && mv -T current.next current`.
8. **Make it serve:** write `~/.lsphp_restart.txt` (LiteSpeed's per-user PHP restart, R10; harmless
   elsewhere); for a PHP app, empty LSCache through a one-time PHP file with a random name that
   answers `X-LiteSpeed-Purge: *`, removed right after; a Node.js or Python app's `tmp/restart.txt`.
9. **Check** `https://<hostname><health path>` from the account (R11) until it answers 2xx or 3xx
   with the release's `X-OpsCrew-Release`: up to 60 s on LiteSpeed; on Apache, past
   `realpath_cache_ttl` (120 s), since a switch reaches every PHP process only then. Otherwise
   switch back, make it serve again, and record the failure. The header shows the web server's
   view; on LiteSpeed the restart is what makes PHP follow.
10. **Keep** the last 3 releases besides the running one; write `state/status` (running, previous,
    last attempt and its reason); keep `state/agent.log` to its last 1,000 lines.

The agent writes key=value files only (`state/report`, `state/status`, request results), which the
CLI validates with zod; it reads no JSON.

### 4. Releases from GitHub Actions (iac-templates `hosting/workflow.ts`)

- On a push to the deploy branch (paused by `OPSCREW_DEPLOY_PAUSED`, ADR 0023):
  - **build:** Composer `install --no-dev --optimize-autoloader --ignore-platform-req='ext-*'` in
    the pinned `php:<version>-cli` image (the PHP version is still checked; the extensions were
    checked against the account at provision); the asset build; a static site's build, whose
    output is the release; a Node.js app's build without `node_modules`;
  - **publish:** an orphan commit of the tree, made with a temporary index and `git add --force`
    so the app's `.gitignore` can't drop `vendor/` or `dist/`, without `.git`, `.github`,
    `node_modules` and `opscrew/`; signed with `openssl dgst -sha256 -sign` by the environment
    secret `OPSCREW_RELEASE_SIGNING_KEY` (ECDSA P-256); force-pushed to `opscrew/release/<env>`
    after a shallow fetch of the previous release, so only changed files are sent;
  - **wait:** until `https://<hostname>/` answers with this run's `X-OpsCrew-Release`, up to 10
    minutes; otherwise it fails with "The account didn't switch to this release: run `opscrew
    status --env <env>` to see why."
- A re-run of an old run is refused by the agent (its run id is lower); a new run deploys.
- Whoever can run the deploy environment's workflow can deploy, as on servers. A pull request's
  workflow can push the branch but has no signing key where GitHub limits environments to the
  deploy branch; where it can't (Free, private), the plan says so before the approval (ADR 0026
  D4).

### 5. The app on the account

- **Layout:** `~/opscrew/<app>-<env>/`: `agent.sh`, `settings.sh`, `keys/` (0700), `shared/` (0711;
  `.env`, `env.php`, `mysql.cnf` 0600), `releases/` (0711), `current`, `state/`, `requests/`,
  `dumps/` (0700). Folders the web server must cross are 0711, never readable by other accounts.
- **Document root:** `~/opscrew/<app>-<env>/current/<webRoot>` where the account allows roots
  outside `public_html` (the test account does). Where it doesn't, the root is a link
  `public_html/opscrew-<app>-<env>` → that path (cPanel keeps a link's path as the root, R10); the
  main domain could reach it as a folder, so OpsCrew's block refuses every other hostname. Not
  testable on the founder's account; fakes and the guide cover it.
- **`.htaccess`,** composed by the agent for each release: OpsCrew's block between `# BEGIN
  OpsCrew` and `# END OpsCrew`, then the blocks the panel and the selector wrote, then the app's
  own `.htaccess`, each kept byte for byte. OpsCrew's block (R4, R10, R11):
  - every hostname but the app's refused; `Options -Indexes`; dotfiles refused; with `webRoot`
    `.`, also `vendor/`, `composer.json`, `composer.lock` and the `storage` link;
  - the HTTPS redirect once the agent sees a valid certificate on its hostname;
  - `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, HSTS (on HTTPS only) and
    `X-OpsCrew-Release`;
  - the handler line when `php.via` is `handler`; `php_value auto_prepend_file` for a plain PHP
    app, inside `<IfModule LiteSpeed>`, `<IfModule lsapi_module>` and `<IfModule php_module>`, so
    an FPM or CGI host doesn't answer 500; there the same setting goes into the release's
    `.user.ini`.
- **The app's settings:** Laravel reads the linked `.env`. A plain PHP app gets them through
  `shared/env.php`, which loads the 0600 values file into `getenv()`, `$_ENV` and `$_SERVER` and
  answers 500 without printing anything when the file is missing. A change is a request
  (section 6).
- **PHP version** (R11). Design reads what the app needs: the PHP constraint and the `ext-*`
  requirements of `composer.json` and `composer.lock`. The report gives what the account has. Plan
  B picks, in this order:
  1. the account's version, when it fits;
  2. on cPanel with MultiPHP, the hostname's version through `LangPHP::php_set_vhost_versions`;
  3. on CloudLinux with LiteSpeed, the oldest alt-php version that fits whose default extensions
     cover the app, through `AddHandler application/x-httpd-alt-phpXY___lsphp .php`;
  4. otherwise provision stops, naming what the app needs, the account's version, and the two ways
     out: the panel's PHP selector (every site on the account changes with it) or per-site PHP
     from the host (CloudLinux Isolates). OpsCrew never changes the account's version.

  The release command and the app's cron jobs run with that version's CLI.
- **The app's cron jobs:** each line is `cd ~/opscrew/<app>-<env>/current && <PHP CLI> -d
  auto_prepend_file=<shared/env.php> <command> >> …/state/cron.log 2>&1`, never the account's
  `/usr/bin/php` (cron's `PATH` finds the account's 7.0, R10).
- **Web server:** design reads the account's main domain's `Server` header and shows it; the agent
  doesn't need to know it (the restart and the purge are harmless elsewhere).

### 6. Requests, rollback, destroy, status (agents)

- **Requests:** key=value files the CLI writes through the panel's API after the approval, under a
  temporary name renamed to `requests/<sha256 of the bytes>.req`. Each names its kind, the approved
  hash and `expires` (UTC epoch seconds, 30 minutes on). The agent carries one out once, before it
  expires, when its name matches its SHA-256, and answers in `state/<name>.result`. Kinds:
  `rollback` (a kept release, and whether to restore the dump filed under it, ADR 0028 D7, the
  database being dumped first, D11), `env` (`shared/.env.next` renamed into place, Laravel's config
  cache refreshed, PHP restarted), `snapshot`, `restore`, and `app` (section 8). Only the holder of
  the panel's token can write them; CI never can.
- **Rollback:** the default target is the release before the running one (ADR 0023 D4), read from
  `state/status`; the database choice; a `promote` approval bound to the plan's hash, both release
  ids and the choice (`allowDestroy` and the typed hostname for a restore); the request; the deploy
  pause set. The agent's `state/last` stays, so the release rolled back from can't come back by a
  push of its old commit.
- **Destroy,** a hosting plan with `allowDestroy` and the typed hostname:
  - a final dump offered (kept in `~/opscrew-dumps/` when accepted);
  - every cron line OpsCrew made, the agent's first;
  - the hostname and its `public_html` link;
  - the certificate AutoSSL issued for the hostname when it is installed nowhere, with its key when
    no other certificate uses it;
  - the database and its user, checked again at the end and, if it is back (R10), made and removed
    once more;
  - the app's folder, then `~/opscrew` when empty; the DNS record;
  - on GitHub: the deploy key, the signing key and the release branch.

  Nothing the record doesn't list.
- **Status** shows the running release, the last attempt and its reason, the certificate, the
  quota left, and on Apache that a switch reaches every PHP process within 120 s. `opscrew logs`
  shows the agent's last lines.

### 7. The panels

- **cPanel:** UAPI and API2 (R1, R10, R11), `Authorization: cpanel <user>:<token>`, port 2083;
  addon domains through API2 `AddonDomain::addaddondomain`; files written to a temporary name and
  renamed (`fileop rename` to a free name); certificates removed with `SSL::delete_cert` and
  `delete_key`.
- **Plesk and DirectAdmin:** their documented calls only (R2, R3), against fakes; everything else
  is a panel step. The same provision, rollback and destroy flows run against each fake (SC-2705).
- **Which panel:** from the answer on 2083, 8443 or 2222, without asking.

### 8. Node.js and Python apps (P2)

CloudLinux's selector, driven by the agent on an `app` request at provision (`cloudlinux-selector
create … --app-root ~/opscrew/<app>-<env>/current --app-uri / --version …`), `install-modules`
before the switch when the lockfile changed, and `tmp/restart.txt`. The selector's `node_modules`
link and Passenger block are carried into each release. The app's packages live in the selector's
one environment, so a release whose lockfile changed installs them a moment before its switch; the
guide says so. Destroy runs the selector's `destroy`, removes its empty `~/nodevenv/<app root>` and
its section in `~/.cl.selector/htaccess_cache` (R10). `examples/express-api` joins the cPanel pass.
cPanel's Application Manager and Plesk's Node.js are left for later.

### 9. Verify, secure, drift, snapshots (P2)

- **Verify:** HTTPS answers with the release header, HTTP redirects, `/.env`, `/.htaccess`, a
  release folder's path and (with `webRoot` `.`) `/vendor/composer/installed.json` are refused,
  another hostname is refused, and the PHP version the app answers with is the plan's.
- **Secure:** the scan; the hostname's PHP version against PHP's supported versions; the settings
  files' modes and places, the cached config's mode; `Options -Indexes` and the dotfile rule
  present; HTTPS forced.
- **Drift:** the hostname's document root, the database and user (and a reappearing one), the cron
  lines, the agent's and settings' SHA-256 against the committed files, the GitHub deploy key.
- **Snapshots:** `snapshot` and `restore` are requests; they stay in `dumps/` on the account, and
  the guide says to download them from the panel. A copy off the account comes later.

### 10. SFTP-only hosts

- The interview reads the host's key (`ssh-keyscan`, confirmed as for own servers) and asks for the
  folder and for the path PHP sees for it (different on a chrooted account).
- **Provision,** a hosting plan applied over `sftp -b` through the runner: the app's folder, the
  placeholder release and `current`, the settings files (0600, outside the web root; `env.php` with
  the `.htaccess` and `.user.ini` lines), and the CI key appended to `~/.ssh/authorized_keys` with
  `restrict` where the host keeps that file, otherwise a panel step. The plan names the hostname,
  its document root, the database and the certificate as the user's to set, and says the key can
  change every file of that SFTP user.
- **The workflow:** build as section 4; upload `releases/<run id>-<attempt>/`; `ln -s` and `rename`
  over `current` (OpenSSH's `posix-rename@openssh.com`, atomic); check the hostname; switch back
  on a failure; keep 3; write `state/status` over SFTP. The key is an environment secret.
- **Rollback** switches over SFTP from the user's computer after the `promote` approval;
  **status** reads `state/status`; **verify** is section 9's; **destroy** removes the folder and
  the key's line over SFTP. Static sites and plain PHP apps only, no release command, no database
  (FR-2712).

### 11. OpenLiteSpeed on servers (ADR 0031, after its spike; separate track)

A third `EdgeProxy`, `openlitespeed`, from `litespeedtech/openlitespeed` pinned by digest, along
R9's map with nginx's 014 work as the model: its configuration, a check before every change
(`openlitespeed -t`), a graceful restart, certificates (origin, and its own renewals through the
certbot path nginx uses), the additions file and its rules, the cache purge on deploy and rollback,
own-server inspection and teardown, previews and Portainer refusing it, the memory estimate. The
container spike R7 lists runs first (T2709); its facts go into research R12.

### 12. CLI, MCP, plugin, guide

`hosting-apply` joins `APPROVE_BY_HASH_KINDS`; commands that need a server say plainly they don't
apply to a hosting account. The MCP tools' help and the plugin's skills offer hosting accounts and
OpenLiteSpeed. The guide gains `hosting-accounts.md`, `cpanel.md`, `plesk.md`, `directadmin.md`,
`sftp.md`, LiteSpeed's notes, and OpenLiteSpeed on `reverse-proxy.md`.

### 13. Tests and live passes

- Connectors with `fetch` fakes; the hosting plans' hashes and refusals; the agent run by `bash`
  against a local bare repository (a good release, a bad or replayed signature, a failing release
  command, a failing check, each request kind, an expired or altered request, the carry-over of the
  panel's `.htaccess` block, a held lock); the workflow's snapshots; the same flows against each
  panel's fakes.
- **cPanel live pass** (`OPSCREW_E2E_CPANEL=1`, `OPSCREW_E2E_CPANEL_*`): SC-2701 for
  `examples/php-plain-mysql` (PHP 8.5 through the handler; database, cron, settings, storage),
  `examples/static-vite` and `examples/express-api` on `e2e-…` subdomains, with an inventory
  before and after (SC-2702), the first request after each switch checked (SC-2703), and a scan of
  every output (SC-2704). `examples/laravel-app` runs there only if the founder sets the account's
  PHP to 8.4 or newer (R11); otherwise its refusal message is checked.
- **SFTP live pass:** a Hetzner server the harness sets up as an SFTP-only host (a chrooted
  account, Apache with PHP-FPM serving its folder, so `.htaccess` and `.user.ini` apply).
- **OpenLiteSpeed live pass:** nginx's pass (`own-nginx.test.ts`) with the third proxy.

## Decisions (lead, 2026-11-12)

1. **Panel accounts deploy by pull.** The panel's token is the whole account (R10) and GitHub
   Actions can't reach the account over SSH, so no account credential goes to CI. The roadmap's
   "the token or key is a deploy secret" holds for SFTP hosts only.
2. **Releases are signed with ECDSA,** the private key in GitHub only, the public key on the
   account: nothing on the account can sign, and no key passes on a command line there.
3. **Two plans at provision,** the second built from the agent's report, so every approved plan
   shows exactly what its apply does.
4. **The agent generates its own GitHub key,** so the private half never leaves the account.
5. **The release branch is per environment and orphan,** force-pushed: one built tree per
   environment in the repository; the guide says what it is.
6. **Cron every minute:** a release goes live within about a minute of its build.
7. **Restarting lsphp restarts every PHP process of the account,** other sites' included, for a
   moment (R10). The guide says so; there is no narrower restart for a user.
8. **OpsCrew never changes the account's PHP version** (R11). The founder decides whether the test
   account moves to PHP 8.4 for a live Laravel run; without it, the pass uses
   `examples/php-plain-mysql`.
9. **Snapshots stay on the account** in 027; the copy off the account comes later.
10. **SFTP's live pass runs on a Hetzner server** set up as an SFTP-only host.
11. **OpenLiteSpeed is its own track,** after its container spike.

## Order

- **T2701 (lead):** the `HostingPanel` contract, ADR 0030, constitution 1.10.0, `hosting-apply`,
  the connector packages' skeletons, the workspace and the lockfile.
- **Wave 1:** T2702 the `hosting` target ∥ T2703 cPanel's connector ∥ T2704 the agent ∥ T2705 the
  workflow ∥ T2706 GitHub ∥ T2707 Plesk's connector ∥ T2708 DirectAdmin's connector ∥ T2709
  OpenLiteSpeed's container spike, R12 and ADR 0031 (lead).
- **Wave 2:** T2710 what the app needs, interview and design ∥ T2712 OpenLiteSpeed's configuration.
- **Wave 3:** T2711 the hosting plans, requests and provision.
- **Wave 4:** T2713 rollback, destroy, status and logs ∥ T2715 CLI and MCP ∥ T2716 OpenLiteSpeed's
  reach.
- **Wave 5:** T2714 SFTP-only hosts ∥ T2718 verify, secure, drift, snapshots ∥ T2720 the plugin's
  skills and MCP text.
- **Wave 6:** T2717 Node.js and Python ∥ T2719 the guide.
- **Wave 7:** T2721 the live test files and `docs/e2e.md`.
- **Lead:** T2722 the cPanel pass, T2723 the SFTP pass, T2724 the OpenLiteSpeed pass, T2725
  simplify, T2726 `CLAUDE.md` and the roadmap, T2727 the release.
