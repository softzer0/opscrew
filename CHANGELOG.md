# Changelog

What changed in each release of OpsCrew: the `opscrew` CLI on npm and the Claude Code plugin, which
installs the same version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until 1.0, a release can change the files OpsCrew writes and the commands' flags.

## [0.2.6] - 2026-11-09

Every deploy workflow changes, a site's too. Run `npx opscrew provision` for each environment
and merge its pull request. Your plans keep working as they are.

- At its next deploy, each MySQL, MariaDB, Valkey, Redis, Dragonfly, Kafka, Redpanda, OpenSearch
  and Elasticsearch service starts once again with a new start command, for a few seconds, its
  data kept.
- An app on your Portainer, on Cloudflare's hosting or on GitHub Pages whose `APP_KEY` or
  `BETTER_AUTH_SECRET` OpsCrew generates gets `APP_PREVIOUS_KEYS` or `BETTER_AUTH_SECRETS` named
  in its stack template or deploy workflow at its next provision. It stays empty until a rotation
  keeps an old key there.

### Added

- **Rotate your app's credentials: `opscrew rotate`.** It replaces a password, key or token
  everywhere OpsCrew put it, in the right order and without breaking the running app, and never
  shows the old or the new value.
  - `npx opscrew rotate` lists every credential OpsCrew made for the environment, how it rotates
    and when it was made or last rotated, then your own tokens with their expiry.
  - Each rotation is a plan you approve by its hash. Services and the app's own secrets rotate
    together (`npx opscrew rotate db cache app`); everything else rotates alone. After a leak,
    `--all` rotates every service and app secret in one plan.
  - Services rotate seamlessly where they take two passwords (MySQL, Valkey, Redis, Dragonfly,
    Garage's access key), with a short swap or a short restart otherwise, on a cloud server, your
    own server and this computer. In your Portainer, every service of the stack restarts once with
    its new value. The app's deploys pause until it ends.
  - Laravel's `APP_KEY` rotates without logging anyone out, and Better Auth's secret keeps what it
    encrypted readable: the old value stays as the previous one until `--drop-previous`. App
    secrets that log users out, Better Auth's included, ask you to type the app's name first.
  - The deploy, check and preview keys, the private network's keys, a device's key and its
    logins, Cloudflare's Access and Tunnel tokens, the state passphrase, the monitoring's,
    Portainer's and Beszel's passwords and the recovery key each have their own name.
  - Your own tokens (Hetzner, DigitalOcean, Cloudflare, GitHub and the others you gave OpsCrew):
    make the new one at the provider, then `npx opscrew rotate <name>` checks it and replaces
    every copy OpsCrew made.
  - A rotation that stops goes on when you run it again, or `--undo` puts the old values back.
    Each one is recorded, names and dates only, in `opscrew/credentials.yaml`.
  - A restore of a snapshot taken before a rotation, including a whole-server one, sets the
    current passwords again.

  See [Rotating your app's credentials](docs/guide/credential-rotation.md).
- **Old credentials:** `opscrew advise` lists every credential older than a year
  (`credentials.maxAgeDays` in the plan changes the age), and with `check.credentials: true` the
  [scheduled check](docs/guide/alerts.md) opens an issue for one.
- **Two computers:** provision stops before changing anything when this computer's generated
  values are older than the last rotation, and says to run `npx opscrew secrets restore` first.
- **Plain PHP apps.** A PHP app without a framework, as made for shared hosting (a `composer.json`
  and a `public/index.php`), is built and deployed like any other app: only `public/` is served,
  its PHP extensions come from `composer.json` and the services it uses, and a `cron.php` runs
  every minute. See [A plain PHP app](docs/guide/builders.md#a-plain-php-app).
- **The app's kept folder:** the folder an app writes its files to (a plain PHP app's `storage/`,
  Laravel's `storage/app`) is a volume that every deploy keeps, in every snapshot and moved by
  `opscrew retarget`. See [The app's kept folder](docs/guide/components.md#the-apps-kept-folder).
- **A PHP app's database settings one by one:** an app that reads `DB_HOST` gets the host, port,
  database, user and password of its PostgreSQL, MySQL or MariaDB by the names it reads. See
  [The split settings](docs/guide/databases.md#the-split-settings).
- **The Claude Code plugin** has a rotation skill and the read-only tool `opscrew_credentials`.

### Changed

- Laravel apps are read as they are built: Laravel Sail's development settings are never asked
  for, its `storage/app` is kept, and a health route declared with `Route::get` is found.
- Each pull request provision opens after the first names what it changes, in its title and its
  body. A run that only updates the plan's records opens none, and a run while OpsCrew's deploy
  pull request is open updates that one.

### Removed

- `opscrew secrets rotate`: run `npx opscrew rotate recovery-key` instead.

### Fixed

- Analyze no longer warns about a missing Dockerfile for a PHP app with a `package.json` for its
  assets.
- `opscrew scan` no longer reports words, constant names or product tokens as high-entropy
  secrets, and reports values in test files as information only. Its vulnerability check reads
  `composer.lock`.
- Self-hosted monitoring's log masking leaves `APP_URL` readable.
- Provision and the other infrastructure commands try again when the OpenTofu or Terraform
  registry doesn't answer.
- OpsCrew keeps following a GitHub Actions run for up to five minutes while GitHub answers with a
  server error, instead of failing.

## [0.2.5] - 2026-11-07

Every server deploy workflow changes. Run `npx opscrew provision` for each environment and merge
its pull request. Your plans keep working as they are.

### Added

- **Snapshots and restores: `opscrew snapshot` and `opscrew restore`.** A snapshot copies every
  service of an environment that keeps data, and the app's SQLite files, on a server OpsCrew
  created, your own server, your computer or your Portainer.
  - PostgreSQL, MySQL, MariaDB, MongoDB, Valkey, Redis and Dragonfly are copied while they run.
    The brokers, the search engines, Garage and the other services with data each stop alone for
    their copy, and only when you allow it (`--allow-downtime` in a script); `--skip <service>`
    leaves one out.
  - A snapshot stays where the data is, named by the UTC time it was taken.
    `opscrew snapshot list` shows them, newest first; `opscrew snapshot delete <id>` deletes one.
  - `opscrew restore <id>` puts the data back exactly and keeps the version that runs. The app's
    requests wait while it runs, the data as it is now is saved as a new snapshot first, and you
    approve it like a destroy, with the app's name typed. `--only <service>` restores one service.

  See [Snapshots and restores](docs/guide/snapshots.md).
- **Snapshots on a schedule:** `opscrew snapshot schedule on --every daily|weekly|<n>h --keep <n>`,
  put on the server or in your Portainer by the next provision. `opscrew status` and the
  [scheduled check](docs/guide/alerts.md) report a scheduled snapshot that failed.
- **An encrypted copy off the server:** `opscrew snapshot offsite on --to r2|hetzner|digitalocean`
  uploads each snapshot, encrypted with age to your recovery copy's key, to a bucket of its own,
  kept for `--days` (90 by default). The server never holds the key.
  `opscrew restore <id> --from offsite --key-file <file>` brings the data back after the server is
  lost. See [An encrypted copy off the server](docs/guide/snapshots.md#an-encrypted-copy-off-the-server).
- **Whole-server snapshots at Hetzner and DigitalOcean:** `opscrew snapshot --server`, live or
  with `--stop`, shows its price; `opscrew restore --server <id>` rebuilds the server in place,
  with its addresses and firewall kept. See
  [Whole-server snapshots](docs/guide/snapshots.md#whole-server-snapshots).
- **The snapshot before each release covers all the data:** every service with data, a database
  on another server, SQLite, and your Portainer. `deploy.snapshotStop` adds a service that must stop
  for its copy. `opscrew rollback --database snapshot` restores it in your Portainer too. See
  [Snapshots before each release](docs/guide/rollback.md#snapshots-before-each-release).
- **Design and advise propose snapshots** on your own server or Portainer when the data matters,
  with a copy off the server.
- **The Claude Code plugin** has a snapshots skill and the read-only tool `opscrew_snapshots`,
  and its status answer names the last snapshot.

### Changed

- An app's key and an environment's name can no longer be `backups` or start with `backups-`:
  the off-server copy's bucket uses those names.

### Fixed

- `opscrew drift` no longer reports a server's image as changed after the server was rebuilt.
- On your computer, a port another container publishes counts as taken, so OpsCrew uses 8080 and
  8443 instead of failing when the app starts.
- `opscrew destroy` with nothing deployed removes what a provision that stopped part-way left in
  OpsCrew's shared Cloudflare rules, instead of refusing with "Nothing is deployed".

## [0.2.4] - 2026-11-06

Every server deploy workflow changes. Run `npx opscrew provision` for each environment and merge
its pull request, and approve a preview environment's recipe again with
`npx opscrew provision --env preview`. Your plans keep working as they are.

### Added

- **Move your app anywhere: `opscrew retarget`** now moves a live app with its data between any
  two of Hetzner Cloud, DigitalOcean, a server you already have and a Portainer you already run,
  in any direction, and a site between Cloudflare's hosting and GitHub Pages.
  - Every service's data moves in a maintenance window: PostgreSQL through its dump, the others
    (MySQL, MariaDB, MongoDB, Valkey, Redis, Dragonfly, the brokers, the search engines, Garage,
    your app's own files, self-hosted monitoring) by copying their stopped volumes, checked by
    SHA-256 on both sides. `--empty <service>` starts one empty instead.
  - A bucket at Hetzner Object Storage or DigitalOcean Spaces moves with the app, its size, copy
    time and cost shown first; `--keep-bucket` keeps it where it is.
  - Apps on several servers and self-hosted monitoring move too, and a move to an Arm server
    builds the image for it.
  - Your own server and your Portainer are never removed: `--finish` removes only the app.
  - A copy that fails puts the old side back with its data unchanged.

  See [Moving your app somewhere else](docs/guide/retarget.md).
- **A rollback can undo the database too.** `opscrew rollback` asks how to treat it:
  - **restore the snapshot** OpsCrew took before the release you undo: on by default for every
    environment except prod, for PostgreSQL, MySQL, MariaDB and MongoDB on the app's server, the
    last 3 kept (`deploy.snapshots`, `deploy.keepSnapshots` in the plan);
  - **migrate it down** with your app's own tool: Rails (with several databases too), Django,
    Alembic, Flask-Migrate, Knex, Sequelize, TypeORM or Laravel;
  - **or keep it** as it is.

  `--database snapshot|migrations|keep` chooses in a script. A choice that changes data is
  approved like a destroy, with the environment's name typed (`--confirm`). The server changes
  data only with a one-time approval OpsCrew leaves there, so a hand-made "Run workflow" can't,
  and a restore that fails puts the database back. See [The database](docs/guide/rollback.md#the-database).
- **Previews on your dev or staging server, or below your app's domain**, each opt-in:
  `opscrew env add preview --previews --share-server dev` runs them on that environment's server
  instead of one of their own, and `--app-zone` lets their domain sit below your app's (with
  Cloudflare's Advanced Certificate Manager). See
  [Fewer servers or one domain](docs/guide/previews.md#fewer-servers-or-one-domain).
- **The Claude Code plugin** knows the moves and the rollback's database choice.

### Changed

- A deploy run you cancel during its start step goes back to the version that ran before, as a
  failed one does.
- When OpsCrew stores deploy secrets, it also deletes the ones it stored earlier that the deploy
  no longer reads (for example `OPSCREW_ORIGIN_TLS` once origin TLS is off), named in the same
  approval. Your app's own variables are never deleted.
- Alembic and Flask-Migrate projects whose migrations have several heads deploy with
  `alembic upgrade heads` (`flask db upgrade heads`), and analyze says why.

### Fixed

- Valkey and Redis 8 couldn't start again in the same container on Ubuntu servers, for example
  after a reboot: each start now removes the previous start's password file first.
- Following a deploy run no longer fails when GitHub answers "Not Found" for a moment right after
  the run starts.

## [0.2.3] - 2026-11-05

Nothing to redo for an app without previews: your plans keep working as they are.

### Added

- **Preview environments: a link for every pull request.**
  - `opscrew env add preview --previews --domain <zone>` sets them up once on a small server of
    their own (at Hetzner, at DigitalOcean, or a server you already have that runs nothing else),
    and `opscrew provision --env preview` creates it. From then on, every pull request from a
    branch of your repository that changes the app gets its own preview: built and started when it
    opens, updated on each push, removed with its data and images when it is closed or merged. A
    comment on the pull request gives its address, and "View deployment" opens it.
  - Previews live on a Cloudflare domain used only for them, at `pr-<number>-<random>.<domain>`,
    behind Cloudflare's proxy with one Cloudflare Origin CA certificate: no public certificate ever
    names a preview, so its address can't be guessed or read from certificate logs. The preview
    server accepts web traffic only from Cloudflare.
  - Each preview runs its own databases and services, empty, then your release command, then your
    seed command once (found for Prisma, Rails, Laravel, Knex, Sequelize, AdonisJS and a
    `db:seed` script; `--seed` or `--no-seed`). Its passwords are made on the preview server;
    your values for previews come from `.env.preview` (test keys only).
  - You approve the previews' setup once, by its hash, typing `<app>-preview` to accept that each
    preview's data is deleted without asking again. The preview server itself enforces what you
    approved: the only key GitHub gets can run one command there, which checks every request, so a
    pull request that edits its workflow still can't go further.
  - Forks, Dependabot and drafts get no preview. At most 3 run at once by default (`--cap`); one
    without a push for 7 days is removed (`--lifetime`).
  - `opscrew preview list`, `opscrew preview logs <n>` and `opscrew preview destroy <n>`;
    `opscrew destroy --env preview` removes the server, the record, the certificate and every
    preview.

  See [Previews: a link for every pull request](docs/guide/previews.md).
- **Names nobody can guess for your other environments.** `opscrew env add <env>` now suggests
  `<env>-<random>.<zone>` when your app is behind Cloudflare's proxy, and `--hostname <name>` puts
  an environment on any name, another domain included. See
  [dev, staging and prod](docs/guide/environments.md).
- **The Claude Code plugin** knows previews: the read-only `opscrew_preview_list` tool, and when to
  suggest them.

### Changed

- Once a repository has previews, every app's deploy secrets must sit where a pull request can't
  read them: `opscrew provision --env preview` refuses until they do and names the command that
  moves them. A GitHub environment that has no rule at all, such as the `production` one GitHub
  creates by itself at your first deploy, now gets OpsCrew's branch rule after your approval; one
  with rules of yours stays as it is.
- `opscrew provision --env preview` refuses a `.env.preview` that git would commit; add `.env.*`
  to your `.gitignore`.
- Every deploy workflow now always deletes its intermediate images, and pull requests' images older
  than 31 days, even with image retention off. Run `opscrew provision` to have it.

## [0.2.2] - 2026-11-05

Nothing to redo: your plans keep working as they are.

### Added

- **`opscrew advise`: is the app the right size, can it cost less, is anything about to break.**
  - It reads each server's figures, with 14 days of history when
    [self-hosted monitoring](docs/guide/monitoring.md) is on, your plan and the interview's budget,
    the providers' live prices, the repository's Dependabot alerts and pull requests, the scheduled
    check's issues, `opscrew secure`'s host checks, and when your GitHub and Cloudflare tokens
    expire. It only reads: nothing changes on any server, account or repository.
  - It lists what it would change, the most urgent first (now, soon, when convenient), each with its
    figures, the monthly price before and after, and how to apply it: a larger or cheaper server, a
    higher memory limit for a container, a fix for a filling disk, backups, the scheduled check, a
    restart loop or a flapping check, Dependabot alerts, a reboot or security updates waiting, a
    token about to expire, Postgres on a server of its own, object storage.
  - It never proposes a smaller server on one reading, or with fewer than 7 days of history.
  - `opscrew advise --apply <id>` writes one field of `opscrew/plan.yaml` (a server's type, a
    container's memory limit, backups or the scheduled check), and `opscrew provision` applies it
    once you approve its hash. For the other proposals it prints the command to run, or what to do
    by hand. `--json` prints the proposals as JSON.
  - To have the Dependabot alerts read, give your GitHub token "Dependabot alerts: Read"; without
    it, advise says so and gives the rest of its advice.

  See [Advice on size, cost and upkeep](docs/guide/advise.md).
- **The Claude Code plugin** gives Claude advise's proposals through the read-only `opscrew_advise`
  tool when you ask "is it the right size?" or "can it cost less?". Applying one stays in your
  terminal.
- **A guide page for `opscrew retarget`:**
  [Moving your app to another cloud provider](docs/guide/retarget.md).

### Fixed

- **`opscrew provision` refuses a server type with a smaller disk than the server has,** before
  changing anything, even in a plan edited by hand. Before, Hetzner Cloud refused such a change
  only after switching the server off, and left it off.

## [0.2.1] - 2026-11-04

Nothing to redo: your plans keep working as they are. The first deploy after your next
`npx opscrew provision` updates the shared edge on the server once, as its version is raised.

### Added

- **Self-hosted monitoring: Prometheus, Loki and Grafana on a server of your own.**
  - `opscrew addon enable monitoring` writes it into your plan, with the server's type and monthly
    price, the agent's memory on each of your servers, the retention and the disk it takes.
    `opscrew provision` then sets it up, each change approved by its hash.
  - By default the stack runs on a small server of its own at your app's provider and location.
    `--on app` puts it on the app's server (from 4 GB). Another app or environment in the
    repository sends to the same server; `--new-server` gives it one of its own.
  - Grafana Alloy on every server sends the server's and the containers' figures, Caddy's and
    Postgres's figures, and your app's log lines, with secrets masked before they leave the server.
  - Six ready-made dashboards: servers, containers, HTTP traffic, Caddy, Postgres and logs.
  - Nothing is reachable from the internet. `opscrew addon open monitoring` gives Grafana's private
    address when this computer is a device on the private network, or opens an SSH tunnel.
  - Figures are kept 15 days and logs 7 by default; `--metrics-days` and `--logs-days` change it.
    `opscrew addon status` and `opscrew status` show each server's last data.
  - `opscrew addon disable monitoring` removes everything it installed; the monitoring server is
    deleted only after you type its name.

  Grafana and Loki are licensed AGPL-3.0 and run unmodified as containers. See
  [Self-hosted monitoring](docs/guide/monitoring.md).
- **The Claude Code plugin** shows monitoring's status and turns it on or off; its
  troubleshooting skill says how to open the dashboards and what each shows.

### Changed

- **Caddy keeps figures per hostname in every OpsCrew edge,** on the edge's internal network only,
  never published. Nothing reads them unless monitoring is on; every app on a server now shares
  the same edge again.
- **Grafana Alloy 1.21.3.** A plan that names 1.21.2 for Grafana Cloud keeps running it, by its
  tag; `opscrew addon enable grafana-cloud` moves it to the pinned version.

### Fixed

- **A new secret now reaches the server:** a rotated Grafana Cloud or Beszel token through
  `opscrew addon enable`, and a device's new database password from `opscrew vpn grant` after this
  computer lost the old one. Before, the server's check saw its files unchanged and skipped writing
  the new value.
- **A changed Alloy or Beszel configuration restarts its container.** Before, the new file was
  written but the running container kept the old one.
- **`opscrew provision` no longer refuses a plan whose extra server keeps no backups** while the
  app's server does: each server is checked against its own setting.

## [0.2.0] - 2026-11-01

Every deploy workflow changes in this release. Run `npx opscrew provision` for each environment
and merge its pull request; until then, `opscrew rollback` says so and changes nothing. An app
with OpenSearch gets its login with that same provision.

### Added

- **`opscrew rollback`: back to the version that ran before, with one command.**
  - It deploys that version's image by its digest: nothing is rebuilt and no release command runs.
  - It uses a deploy's own switch and checks, so with rolling deploys your site keeps serving.
  - `--list` shows the versions you can go back to, and `--to <commit or digest>` picks one.
  - It asks for approval in a terminal; a script passes `--approve <hash>`. `--yes` never
    approves a rollback.
  - Your data, schema and secrets stay as they are now. The guide says what that means for
    migrations.

  It works on servers OpsCrew creates, your own server, your Portainer and this computer. On
  Cloudflare's hosting it activates an earlier Worker version, and on GitHub Pages it re-runs an
  earlier run. See [Rolling back a release](docs/guide/rollback.md).
- **Deploys pause after a rollback,** so the next push doesn't undo it unnoticed: a push still
  builds, but doesn't deploy. `opscrew rollback --resume` turns deploys back on, and `--deploy`
  also deploys the branch's latest commit now.
- **`opscrew status` shows which version runs,** the one before it, and whether deploys are
  paused. `opscrew_status` in the Claude Code plugin includes the same.
- **`opscrew logs --failed`** shows the last lines of a new version that failed its health check.
  The server keeps them after the failed copy is removed, and the failure messages point there.
- **Logins for Kafka, Redpanda and OpenSearch.**
  - OpenSearch runs its security plugin, and its address carries the login: an app that reads
    `OPENSEARCH_URL` needs no change.
  - Kafka and Redpanda ask for a login when you set `login: true` in the service's options in
    `opscrew/plan.yaml`. Your app gets `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`,
    `KAFKA_SASL_PASSWORD` and `KAFKA_SECURITY_PROTOCOL`, and its Kafka client sends them.
  - `opscrew design` turns the login on when your app's code already reads those variables.

  See [Message brokers](docs/guide/brokers.md) and
  [Search and analytics](docs/guide/search-and-analytics.md).
- **The Claude Code plugin** suggests `opscrew rollback` in the terminal when a recent release is
  the likely cause, after stating what it leaves as it is.

### Changed

- **`promote` and `rollback` accept images built by GitHub's "Run workflow"** on the deploy
  branch, as well as those built by a push.
- **Going back on Cloudflare's hosting and GitHub Pages** is `opscrew rollback`, which also pauses
  their deploys. The runbooks and the deploy failure messages name it.
- **A failed release command** now says the migration may have run partly, where its output is, and
  what to do next.

### Fixed

- After a worker or cron process failed following a switch, the failure message pointed to the
  lines of the version restarted in its place, not to the failed one's.

## [0.1.3] - 2026-10-31

### Added

- **A server of its own for a service.** Put a database, cache or broker on another server by
  adding it under `servers` in `opscrew/plan.yaml` and naming it in the service's `server`. It can
  be another Hetzner Cloud server, a DigitalOcean Droplet or a server you already have.
  - `opscrew design` sizes and prices each server, and estimates the delay each query then adds.
  - Your app's code doesn't change: only the address it is given does.
  - `status`, `logs`, `drift`, `secure`, `verify` and `destroy` cover every server.

  See [A server of its own for a service](docs/guide/split-placement.md).
- **Moving a running service to another server, with its data.** `opscrew provision` copies
  PostgreSQL's data in a short maintenance window it shows you first, and pauses deploys meanwhile.
  `opscrew provision --finish-move` then deletes the old copy, after you type the service's name.
  In a script, `--allow-downtime` approves the window. Valkey, Redis and Dragonfly start empty on
  the new server; other services that keep data can't move yet.
- **A private network between your app's servers** (WireGuard): databases and caches on another
  server listen only there.
- **Your own devices on that network** (see
  [Your devices on the private network](docs/guide/private-network.md)):
  - `opscrew vpn add <name>` writes a WireGuard configuration for a laptop, or for a phone with
    `--qr`.
  - `opscrew vpn list` shows each device and when it last connected; `opscrew vpn remove` takes one
    off.
  - `opscrew vpn grant <device> <service>` gives a device its own login to a database or cache,
    read-only unless `--full`; `opscrew vpn revoke` removes it. See
    [Your production database from your device](docs/guide/database-access.md).
- **SSH closed to the internet.** `opscrew secure --close-public-ssh` makes every server answer
  SSH only on the private network, and `--open-public-ssh` opens it again. If you lose this
  computer's tunnel, the guide says how to get back in. See
  [Close public SSH](docs/guide/public-ssh.md).
- **Removing a server in a script.** `opscrew provision --confirm <app>-<server> --yes` lifts the
  delete protection of a Hetzner server you took out of `servers`, then prints the command that
  deletes it.
- [When a deploy fails, and how to recover](docs/guide/when-a-deploy-fails.md): what your visitors
  get, what OpsCrew already put back and what to do next, for each kind of failure.
- **The Claude Code plugin** shows each server and the private network in `opscrew_status`.
  `opscrew_placement_estimate` prices a placement and estimates its delay before you change
  anything, and the deploy and troubleshoot skills know about several servers.

### Fixed

- A script that runs `opscrew provision --approve` again with every hash it was given, the
  infrastructure plan's and each host plan's, no longer fails with "Saved plan is stale" on servers
  OpsCrew creates: an infrastructure plan that was already applied is planned afresh.
- `opscrew drift` no longer reports a Hetzner firewall rule as changed outside OpsCrew after a
  provision changed the firewall. The next `opscrew provision` updates the firewall once.
- `opscrew design` no longer makes a server it already created smaller than its disk allows: neither
  Hetzner Cloud nor DigitalOcean can shrink a disk, so the change used to fail at the provider. It
  keeps the server's type, says why, and keeps the server in its location rather than proposing to
  replace it.
- `opscrew destroy` stops before changing anything while the server's own runner is running a job,
  which GitHub would refuse to delete, and says to wait for the job or cancel it.
- `opscrew promote` names the branch an environment really deploys from. Its hint for `--version`
  on a server environment now says how to go back to an earlier version.
- `opscrew secure`'s advice for a pending reboot no longer suggests `sudo` on servers OpsCrew
  created, where the deploy user has none.

## [0.1.2] - 2026-10-29

### Added

- `opscrew logs` shows your app's latest log lines wherever it runs: on a server, in your Portainer,
  on this computer, or a server-rendered site on Cloudflare. `--follow` keeps showing new lines
  until Ctrl+C, and `--service`, `--since` and `--tail` choose which lines. Secrets are masked
  before a line is shown. See [Your app's logs and resource figures](docs/guide/logs-and-status.md).
- `opscrew status` shows how the app is doing right now: the server's load, memory and disk, and
  each container's CPU, memory, restarts and uptime. It flags a container near its memory limit, a
  disk past 85% and a restart since the last deploy, with what to do. On Cloudflare it shows the
  Worker's requests, errors and CPU time of the last day.
- A scheduled check in GitHub Actions, on by default for prod, checks that your app answers, that
  its certificate is valid and that its server's disk has room. When something fails it opens a
  GitHub issue, and it can post to Slack, Discord or ntfy; when the app recovers it closes the issue
  and says how long the problem lasted. `design` shows its Actions minutes a month, and `destroy`
  and `retarget` pause it. See [Alerts: the scheduled check](docs/guide/alerts.md).
- Two add-ons for a server OpsCrew deploys to, each turned on with `opscrew addon enable` after a
  plan you approve, and removed with `opscrew addon disable`:
  - [Beszel](docs/guide/beszel.md): charts and history of the server and its containers.
    `opscrew addon open beszel` opens its dashboard through an SSH tunnel;
  - [Grafana Cloud](docs/guide/grafana-cloud.md): your app's log lines and the server's metrics,
    sent to your own free Grafana Cloud stack by Grafana Alloy, with the app's secrets masked
    before they leave the server.

  Both see Docker only through OpsCrew's read-only proxy.
- The Claude Code plugin reads the logs (`opscrew_logs`), shows the figures and open alerts in
  `opscrew_status`, and turns the add-ons on and off. Its new `/opscrew:opscrew-troubleshoot`
  skill finds out why your app is failing or slow. See
  [the plugin's guide](docs/guide/claude-code-plugin.md).

### Changed

- With the scheduled check on, the GitHub token needs Issues: Read and Variables: Read and write. For
  a server-rendered site's past requests in `opscrew logs`, the Cloudflare token needs Workers
  Observability: Read. See [Security](docs/guide/security.md).
- Hints that pointed to `docker compose logs` on the server now name `opscrew logs`.

### Fixed

- On Debian, Ubuntu and other Linux systems where `sh` is dash, `provision` of an environment on
  this computer could not log in to GitHub Container Registry to pull the app's image. Docker got no
  token, though the token was right.

## [0.1.1] - 2026-10-24

### Added

- Host a site on Cloudflare, with no server: static sites from Workers static assets, and
  server-rendered Astro, Next.js (through OpenNext), Nuxt and SvelteKit apps as a Worker. `adapt`
  adds the Cloudflare adapter when the app does not use it yet. See
  [Host your site on Cloudflare](docs/guide/cloudflare-hosting.md).
- Publish a static site on GitHub Pages, on your domain. See
  [Publish your site on GitHub Pages](docs/guide/github-pages.md).
- `provision`, `verify`, `status`, `drift`, `secure`, `promote` and `destroy` work for both, with
  environments, from the CLI, the MCP server and the Claude Code plugin.
- On Cloudflare, `promote --version` refuses to roll back to a version from before one of the app's
  secrets changed, and names the secrets. If their old values are still safe,
  `--allow-old-secrets <name>` rolls back anyway, after an approval that names them.
- `app add` takes a site that has no manifest, such as a Hugo site.

### Changed

- A push runs an app's deploy workflow only when something the app deploys changes: its folder,
  the paths in `app.sharedPaths`, the workflow itself and the OpsCrew files the deploy reads. See
  [When a push deploys your app](docs/guide/when-deploys-run.md).
- Running `design` again keeps the plan's own settings, such as the app's name, the workflow's path
  and the Worker's name. Where you changed a value `analyze` found (the port or the health path, for
  example), design keeps yours and says what analyze found.
- An app in a folder takes its environment variables from its own folder, the workspace packages
  it uses and the committed env files at the repository root.
- `provision` commits only OpsCrew's own files to its deploy-setup branch, and says how to get back
  to the branch you were on.
- The CLI no longer installs the Claude Agent SDK (about 300 MB). The first AI step asks before
  downloading it once (`--yes` agrees); commands without AI never need it.
- The Claude Code plugin installs OpsCrew from a pinned lockfile instead of running `npx`: about
  35 MB.

### Fixed

- The provider lock files (`.terraform.lock.hcl`) go into the deploy-setup pull request instead of
  staying uncommitted.
- A Cloudflare deploy retries for up to 2 minutes when Cloudflare cannot find the Worker version it
  has just uploaded yet.
- `provision` on Cloudflare raises the zone's minimum TLS version to 1.2 when every proxied hostname
  in the zone is OpsCrew's, as it does for apps on a server. Other OpsCrew apps' Worker domains now
  count as OpsCrew's.
- A rollback with `--allow-old-secrets` no longer fails on Cloudflare's short answer: OpsCrew reads
  the latest deployment back to confirm it.
- On Windows, OpsCrew can start npm, npx, pnpm and yarn, which failed with `EINVAL`.

## [0.1.0] - 2026-10-23

The first release. OpsCrew takes an app from its GitHub repository to a hardened production
deployment on your own account:

- `scan` checks a repository for leaked secrets, exposed Supabase and Firebase data and risky
  config, free and without AI.
- `init`, `analyze`, `interview`, `design`, `adapt`, `provision`, `verify` and `secure` take the app
  from its code to a live, checked deployment. Every infrastructure change waits for your approval
  of its exact plan.
- Targets: Hetzner Cloud, DigitalOcean, [a server you already have](docs/guide/own-server.md),
  [a Portainer you already run](docs/guide/portainer-target.md) and
  [your own computer](docs/guide/localhost.md), with OpenTofu or Terraform.
- [Environments](docs/guide/environments.md) such as dev, staging and prod, and
  [self-hosted runners](docs/guide/runners.md).
- [Several apps in one repository](docs/guide/several-apps.md), and several apps in one
  [Cloudflare zone](docs/guide/cloudflare.md).
- Domains: `domain buy` and `domain connect`, through Cloudflare, Porkbun, Namecheap or GoDaddy.
- [Components](docs/guide/components.md) next to the app: databases, object storage, message
  brokers, search engines, workers and cron jobs.
- `destroy`, `retarget`, `status` and `drift` after the first deploy.
- The MCP server (`opscrew mcp`) and the Claude Code plugin.

[0.2.6]: https://github.com/softzer0/opscrew/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/softzer0/opscrew/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/softzer0/opscrew/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/softzer0/opscrew/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/softzer0/opscrew/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/softzer0/opscrew/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/softzer0/opscrew/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/softzer0/opscrew/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/softzer0/opscrew/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/softzer0/opscrew/compare/0dfc0e91...v0.1.1
[0.1.0]: https://github.com/softzer0/opscrew/tree/0dfc0e91
