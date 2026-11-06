# Feature Specification: Rollback

**Feature Branch**: `main` (feature directory `specs/019-rollback`)
**Created**: 2026-10-31
**Status**: Draft
**Input**: The roadmap's "019 Rollback" (founder, 2026-10-31).
- `opscrew rollback` puts an app's environment back on its previous deployment with one command,
  or on an earlier version the user picks.
- It was made a feature of its own after the first outside feedback asked how a failed deploy is
  recovered, before pointing OpsCrew at a real app.
- Also in scope, the rest of recovery: a failed copy's last log lines, the worker hint after a
  switch back, and advice for a migration that stopped halfway.
- Also in 019 (founder, 2026-11-01): logins for Kafka, Redpanda and OpenSearch, which ran with
  none (User Story 7).
- Research: [research.md](research.md). R5 holds the lead's decisions this spec builds on; R7 and
  R8 hold the logins' research and spike.

## Why

A deploy that fails its checks already never stays: OpsCrew switches the server back by itself. But
a release that passes every check can still be wrong: a broken page, a bug in a payment flow, a
slow query. Today the only way back is to revert the commit and wait for a new build, or to re-run
an old workflow run, which rebuilds that commit and works only for 30 days. Both take minutes while
the bug is live, and a rebuild may not even produce the same image.

The image that ran before is still in the registry, by its exact digest. Going back to it takes no
build, only the same safe switch a deploy uses. Every comparable tool (Kamal, Heroku, Render,
Vercel) works this way. Two of them also pause automatic deploys afterwards, so the next push
doesn't undo the rollback without anyone noticing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Back to the previous deployment (Priority: P1)

A release is live and wrong. The user runs `opscrew rollback`.
1. OpsCrew names the version running now and the one before it, with their commits, messages and
   times.
2. It says the database stays as it is.
3. It asks for approval, then switches the environment back to the previous image, with no build.

The site is served the whole time, as in a deploy.

**Why this priority**: it is the feature: the fastest safe way back from a bad release.

**Independent Test**:
1. Deploy an example app.
2. Push a change that deploys fine but changes a page.
3. Run `opscrew rollback`.

Within the time a switch takes, the page is the old one again, served by the previous image's
digest. No build ran, and no release command ran.

**Acceptance Scenarios**:

1. **Given** an environment on a server OpsCrew created or the user's own server, with at least two
   deployments, **When** the user runs `opscrew rollback` in a terminal, **Then**:
   - it shows the current version and the previous one (commit, message, time and short digest);
   - it says the data and schema stay as they are;
   - it asks for approval of exactly that switch;
   - after approval, it deploys the previous image through the same switch as a deploy: health
     check, the check from outside, and the automatic switch back if the old image fails too.
2. **Given** a script, **When** it runs `opscrew rollback` without `--approve`, **Then** it changes
   nothing and prints the command with the rollback's hash. **When** it runs with
   `--approve <hash>`, **Then** it applies exactly that rollback.
3. **Given** the app has a release command (migrations), **When** it rolls back, **Then** the
   release command does not run.
4. **Given** the previous image is no longer in the registry, **When** the user rolls back,
   **Then** it stops before any change, says so, and names the versions that are still there.
5. **Given** only one deployment ever ran, or a deploy is running now, or a move between servers is
   in progress, **When** the user rolls back, **Then** it refuses before any change and says why
   and what to do.

---

### User Story 2 - Deploys pause after a rollback (Priority: P1)

After a rollback, the bad commit is still on the branch, so the next push would deploy it again.
OpsCrew pauses that environment's automatic deploys and says so. `opscrew status` shows the pause
and which version is pinned. When the fix is pushed, or the user decides to go forward again, one
command resumes deploys.

**Why this priority**: without it a rollback lasts only until the next push, possibly a
colleague's, and nobody notices. Vercel and Render both pause for this reason.

**Independent Test**:
1. Roll back.
2. Push a commit: the deploy job is skipped and says why.
3. Run the resume command: the next push deploys again.

**Acceptance Scenarios**:

1. **Given** a rollback succeeded, **Then** that environment's deploys are paused, and the output
   says how to resume. Other environments of the app keep deploying.
2. **Given** deploys are paused, **When** a push arrives, **Then** the deploy run skips its deploy
   job and its summary says the environment is pinned to a rolled-back version.
3. **Given** deploys are paused, **When** the user runs `opscrew rollback --resume`, **Then**
   deploys resume. With `--deploy`, the branch's latest commit also deploys now.
4. **Given** deploys are paused, **When** the user runs `opscrew status`, **Then** it shows the
   pinned version, since when, and the resume command.

---

### User Story 3 - An earlier version (Priority: P2)

The user wants to go back further than one version, for example to before two bad releases.
`opscrew rollback --list` shows the versions still available, newest first, each with commit,
message, time and short digest. `opscrew rollback --to <commit or digest>` goes to one of them.

**Why this priority**: the previous version covers most cases. Going back further is less common,
but without it a second bad release can't be undone.

**Independent Test**: after three deploys, roll back to the first by its commit. The app serves the
first version's page.

**Acceptance Scenarios**:

1. **Given** an environment with several deployments, **When** the user runs
   `opscrew rollback --list`, **Then**:
   - it shows the environment's images still in the registry, newest first, marking the running
     one and the previous one;
   - it changes nothing.
2. **Given** a commit or digest from that list, **When** the user runs
   `opscrew rollback --to <it>`, **Then** it rolls back to that image as in US1.
3. **Given** a commit or digest not in the list (never built for this environment, gone from the
   registry, or built from another repository), **When** the user names it, **Then** it refuses
   and lists what is available.

---

### User Story 4 - Every target (Priority: P2)

Rollback works the same way wherever the app runs:
- servers OpsCrew created;
- the user's own server;
- the user's Portainer;
- this computer;
- Cloudflare's hosting;
- GitHub Pages.

Each target goes back by its own means, and the output says how.

**Why this priority**: users choose targets for other reasons, and rollback is a basic expectation
on each.

**Independent Test**: roll back once on each target that a live pass covers.

**Acceptance Scenarios**:

1. **Given** a Portainer target, **When** the user rolls back, **Then** the previous version's
   stack runs again, through the same deploy branch and redeploy as a deploy.
2. **Given** this computer, **When** the user rolls back, **Then** it goes back to the previous
   local image while that image is still on the computer. When it isn't, it says so.
3. **Given** Cloudflare's hosting, **When** the user rolls back, **Then** the previous Worker
   version serves at 100%, with no build. The checks of today's `promote --version` still apply,
   such as secrets changed since that version.
4. **Given** GitHub Pages, **When** the user rolls back, **Then** OpsCrew re-runs the previous
   version's workflow run, and says first that this rebuilds that commit and that GitHub allows it
   for 30 days.
5. **Given** an environment promoted from another, **When** the user rolls back, **Then** it goes
   back to the image it ran before, as `promote --digest` does today.

---

### User Story 5 - Knowing what failed, and what runs (Priority: P2)

When a deploy fails, the user can see why, even though OpsCrew already removed the failed copy.
`opscrew status` shows which version runs on a server.

**Why this priority**: a rollback is only half of recovery. The user then has to find and fix the
cause, and today the failed copy's logs are gone with the copy.

**Independent Test**: deploy a release that fails its health check. `opscrew logs` shows that
copy's last lines. `opscrew status` names the version still running.

**Acceptance Scenarios**:

1. **Given** a new copy failed its health check and was removed, **When** the user runs
   `opscrew logs`, **Then** it can show that copy's last lines, marked as the failed deploy's. The
   run's failure message says so.
2. **Given** a worker or cron process failed after a switch, **When** the run fails, **Then** its
   hint points to that failed process's own lines, not the restarted old version's.
3. **Given** the release command failed partway, **When** the run fails, **Then** its message says
   what may have been applied and what to do: check `release.log`, then fix the migration and
   deploy forward, or restore a backup.
4. **Given** a server environment, **When** the user runs `opscrew status`, **Then** it shows the
   running version (commit, short digest and time), and whether deploys are paused.

---

### User Story 6 - The same from Claude Code (Priority: P3)

In Claude Code, the plugin's `opscrew_status` shows the running version, the previous one and any
pause. The troubleshoot skill suggests `opscrew rollback` when a recent release is the likely
cause, and explains the database caveat.

**Why this priority**: plugin users get the same picture, but the rollback itself stays a terminal
command, since it asks for approval.

**Independent Test**: through the MCP server, `opscrew_status` returns the running and previous
versions, and the pause after a rollback.

**Acceptance Scenarios**:

1. **Given** a deployed environment, **When** `opscrew_status` runs, **Then** it includes the
   running version, the previous one, and whether deploys are paused.
2. **Given** a user in Claude Code asks to undo a release, **Then** the skill runs or suggests
   `opscrew rollback` in the terminal, after stating the database caveat.

---

### User Story 7 - Logins for Kafka, Redpanda and OpenSearch (Priority: P2)

Today these three run without a login, and only the network keeps others out. OpenSearch gets a
login by default, inside the address the app already reads. Kafka and Redpanda get one when the
user turns it on, because the app's code has to send it.

**Why this priority**: a login keeps the data closed when something else on the app's network or
server is compromised. Nothing changes for an app that doesn't turn it on, except on OpenSearch,
whose clients take the login inside the URL.

**Independent Test**: in local Docker, each service refuses a client without the login and serves
one with it, using the variables OpsCrew gives the app.

**Acceptance Scenarios**:

1. **Given** an app with OpenSearch, **When** it is provisioned or deployed, **Then**:
   - OpenSearch runs its security plugin, with plain HTTP;
   - `OPENSEARCH_URL` carries the user `admin` and a generated password;
   - a request without them gets 401;
   - existing indexes stay.
2. **Given** an app with Kafka or Redpanda and `login: true` in that service's options in
   `opscrew/plan.yaml`, **When** it is deployed, **Then**:
   - the clients' listener asks for SCRAM-SHA-512;
   - the app gets `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` and
     `KAFKA_SECURITY_PROTOCOL`;
   - a client without them is refused;
   - existing topics stay.
3. **Given** Kafka or Redpanda without the setting, **When** design runs, **Then** it says the
   service has no login, how to turn one on, and what the app's code must send. **When** the app's
   code already reads `KAFKA_SASL_USERNAME` and `KAFKA_SASL_PASSWORD`, design turns it on.
4. **Given** Redpanda with a login, **Then** its admin API, Schema Registry, HTTP Proxy and RPC take
   no change from another container without the login.
5. **Given** a service with a login on another server (018), **Then** design no longer says it has
   no login. A device still can't be given access to it: its one login is the app's.

---

### User Story 8 - A rollback undoes the database too (Priority: P1)

Founder, 2026-11-06, shipped with 023. A release whose migrations changed the database is rolled
back, and the earlier version gets the database it ran with, not only its image. Two ways:
- **a snapshot**, the default: OpsCrew dumps the app's databases before every release;
- **down migrations**, which the user picks: the newer version's migration tool migrates the
  database back down.

Snapshots are on by default for every environment except prod.

**Why this priority**: a rollback that leaves a newer schema behind fails exactly when the release
changed the database, which is when a rollback is needed most. Making every release add first and
remove later works, but most apps on dev and staging don't follow that rule.

**Independent Test**: on staging, deploy v1 and write rows; deploy v2, whose migration adds a
column, and write more rows. Then:
1. Roll back with the snapshot: v1 runs, the column is gone, and the database holds the rows of
   the moment v2 was deployed.
2. Deploy v2 again, roll back with down migrations: the column is gone and the rows stay.

**Acceptance Scenarios**:

1. **Given** an environment other than prod whose app has PostgreSQL, MySQL, MariaDB or MongoDB on
   its server, **When** a deploy runs, **Then**:
   - before the release command runs, OpsCrew dumps each of those databases on the server while
     the running version keeps serving;
   - it files the dump under the version that was running;
   - it keeps the snapshots of the last 3 versions (`deploy.keepSnapshots`).
2. **Given** a rollback to a version that has a snapshot, **When** the user runs
   `opscrew rollback`, **Then**:
   - it asks how to treat the database, the snapshot first, saying when it was taken and that
     everything written since is lost;
   - once approved, with the environment's name typed, requests are held while the app stops, and
     each database is replaced by its snapshot, tables newer migrations added included;
   - the earlier version starts, and the held requests go through.
3. **Given** an app whose migration tool can migrate down (Rails, Django, Alembic, Flask-Migrate,
   Knex, Sequelize, TypeORM or Laravel), **When** the user picks down migrations, **Then**:
   - the newer version's image migrates the database down to the schema the earlier version ran
     with;
   - the output says that the tables and columns the undone migrations added are dropped, with
     their data.

   It is offered only when OpsCrew recorded both versions' migration state.
4. **Given** prod, **Then** no snapshot is taken unless `deploy.snapshots` is `true` in its plan,
   and its rollback keeps the database as it is unless the user picks otherwise.
5. **Given** a script, **Then**:
   - `--database snapshot|migrations|keep` makes the choice. Without it, an environment other
     than prod restores its snapshot when there is one, and otherwise keeps the data;
   - a choice that changes data needs `--confirm <name>`, as `destroy --env` does.
6. **Given** a restore or down migration that fails partway, **Then**:
   - OpsCrew puts back the snapshot it took of the current database just before;
   - the version that ran before the rollback serves again;
   - the output says what failed and where its log is.
7. **Given** someone dispatches the deploy workflow's rollback by hand, without OpsCrew, **Then**
   the server changes no data: a database step needs the one-time approval that only
   `opscrew rollback` leaves on the server.

---

### Edge Cases

- **The previous image fails its checks.** The automatic switch back returns to the version that
  ran before the rollback, and the rollback reports that it failed.
- **The rollback target's services are gone.** A service the old version needs was removed from
  the plan since. The rollback refuses, as `promote` does today.
- **A placement change since then** (018). Only the app's image changes; services on other servers
  stay where they are, and their addresses come from the current app settings.
- **The app's settings changed since.** The rolled-back image runs with today's settings and
  secrets, and the output says so.
- **Retention deleted the target image.** It refuses; US1 #4 and US3 #3.
- **A deploy or a move is running.** It refuses; US1 #5.
- **Public SSH is closed (018).** The rollback runs on the runner that deploys today, which reaches
  the servers as deploys do.
- **A rollback of a rollback.** Rolling back again goes to the version before the current one, as
  any rollback does. `--resume` is how to go forward to the branch.
- **An environment promoted from another** pauses the same way. A promotion while paused needs
  `--resume` first.
- **Two apps on one server.** Each app rolls back on its own.
- **A Kafka client without the login** gets no clear error, only a timeout. The guide says so.
- **A login turned on, or off, for a service that holds data** keeps the data (R8).
- **Redpanda's login turned off again:** Redpanda keeps SASL in its own data, so the broker still
  asks for the login while the app no longer sends it. OpsCrew doesn't turn it off: the guide says
  so, and gives the `rpk` commands to do it by hand (lead, from T1920's review).
- **A rollback across the login change** runs the earlier image with today's settings, as with any
  setting: an earlier app version that didn't send the login can't reach Kafka or Redpanda.
- **No snapshot for the chosen version** (taken before snapshots were on, rotated out, or skipped
  for lack of disk space): the snapshot isn't offered. In a script, `--database snapshot` is
  refused before any change.
- **Too little disk space for a snapshot:** the deploy goes ahead without one, with a warning in
  its log. A dump that fails for any other reason fails the deploy before the release command, and
  the running version keeps serving.
- **A rollback across several versions** restores the snapshot of the chosen version, or migrates
  down across every migration added since.
- **Rolling forward again after a database rollback:** the snapshot OpsCrew took just before the
  restore is filed under the version that ran, so a later rollback to it can restore it.
- **Not yet, with 024:** the app's own files (a SQLite database, uploads), a database on another
  server (018) and Portainer get no snapshot. Their rollback keeps the data, and down migrations
  work on servers wherever the release command does.
- **A migration history that isn't a straight line** (a count tool whose earlier version has more
  migrations applied than the newer one): down migrations aren't offered.
- **Previews and sites** have no rollback of their data.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-1901**: `opscrew rollback` MUST switch an environment that runs on a server (OpsCrew-created
  or the user's own) to an earlier image of that environment, by its digest, without a build and
  without running the release command. It uses the same switch, health check, check from outside
  and automatic switch back as a deploy.
- **FR-1902**: With no version given, the target MUST be the deployment before the current one.
  With `--to <commit or digest>`, it is that version.
- **FR-1903**: The versions offered (`--list` and `--to`) MUST be this environment's images still
  in the registry, newest first.
  - Only images whose provenance checks out are offered: built by this repository's workflow from
    a commit on its deploy branch.
  - An image that is gone, or that fails the provenance or platform checks, is refused before any
    change.
- **FR-1904**: A rollback MUST be approved by a hash that binds the environment, the target digest
  and the environment's current deployment. In a terminal it asks; in a script it needs
  `--approve <hash>`. `--yes` MUST NOT grant it. Without approval it changes nothing and prints the
  command with the hash.
- **FR-1905**: Before it switches, the rollback MUST show:
  - the current version and the target, each with commit, message, time and short digest;
  - that the data, schema and secrets stay as they are now.
- **FR-1906**: After a successful rollback, the environment's automatic deploys MUST pause.
  - A deploy run that starts while paused skips its deploy job and says why.
  - `opscrew rollback --resume` ends the pause; with `--deploy`, it also deploys the branch's
    latest commit now.
  - Other environments are not affected.
- **FR-1907**: A rollback MUST refuse before any change while:
  - a deploy of the environment runs;
  - a move between servers is in progress;
  - only one version exists;
  - the environment is not provisioned, or has a provision pending.
- **FR-1908**: On the user's Portainer, a rollback MUST run the target version's stack through the
  deploy branch, as a deploy does. On this computer, it goes back to the previous local image while
  that image is still there.
- **FR-1909**: On Cloudflare's hosting and GitHub Pages, `opscrew rollback` MUST use the targets'
  own version history, as `promote --version` does today, and with its checks.
  - Before running, it MUST say how it goes back: a Worker version with no build, or a re-run that
    rebuilds a Pages version, possible for 30 days.
- **FR-1910**: When a new copy fails its health check, the deploy MUST keep that copy's last log
  lines on the server before removing it, and `opscrew logs` MUST be able to show them, marked as
  the failed deploy's.
- **FR-1911**: When a worker or cron process fails after a switch, the failure message MUST point
  to that process's own lines, not the restarted previous version's.
- **FR-1912**: When the release command fails, the message MUST say:
  - that the migration may have run partly;
  - where its output is (`release.log`);
  - what to do: fix the migration and deploy forward, or restore a backup.
- **FR-1913**: `opscrew status` MUST show, for a server environment, the running version (commit,
  short digest and time) and, when deploys are paused, the pinned version and how to resume.
  `opscrew_status` in the MCP server MUST include the same.
- **FR-1914**: No rollback path may print, record or commit a secret, and every change MUST be
  audited, as deploys are.
- **FR-1915**: The guide MUST document rollback, the pause and resume, and the database caveat. The
  failed-deploy page links to it.
- **FR-1916**: OpenSearch MUST run its security plugin, with:
  - a generated password for its one user, `admin`;
  - plain HTTP;
  - a transport certificate made inside the container, which never leaves it.

  `OPENSEARCH_URL` MUST carry the login, and the health check MUST use it. Data from before the
  login MUST stay.
- **FR-1917**: Kafka and Redpanda MUST accept `login: true` in the service's options. With it:
  - the clients' listener asks for SCRAM-SHA-512;
  - the user `app` has a generated password. The service creates the user itself before its health
    check passes, so the app never starts before the login exists;
  - the service's own traffic stays on loopback;
  - the app gets the four `KAFKA_*` variables of US7 #2.

  Turning the login on or off MUST keep the data.
- **FR-1918**: With Redpanda's login:
  - its admin API MUST require the login for changes;
  - its Schema Registry, HTTP Proxy and RPC MUST listen on loopback only.
- **FR-1919**: Design MUST say, per service, whether it has a login.
  - For Kafka and Redpanda without one, it says how to turn one on.
  - The default is on when the app's code reads the SASL variables.
  - Every message from 018 that says a service has no login MUST follow the service's actual
    setting. Devices still get no access to these three.
- **FR-1920**: The guide MUST document the logins:
  - the variables;
  - a kafkajs example;
  - that a Kafka client without the login only times out;
  - that OpsCrew generates the password once and has no command to change it.
- **FR-1921**: On a server environment with snapshots on, every deploy that changes the image MUST
  first dump each PostgreSQL, MySQL, MariaDB and MongoDB service on the app's server:
  - before the release command, while the running version serves;
  - filed under the running version's digest;
  - keeping the last `deploy.keepSnapshots` versions (1–10, default 3).

  Snapshots are on by default for every environment except prod and previews. `deploy.snapshots`
  in the plan turns them on or off.
- **FR-1922**: A deploy with too little free disk space for a snapshot MUST go ahead without one,
  warning in its log. Any other failed dump MUST stop the deploy before the release command.
- **FR-1923**: When the app's migration tool is one of the eight that can migrate down, every
  deploy MUST record the tool's migration state after the release command, under the new
  version's digest. A failed record only warns.
- **FR-1924**: `opscrew rollback` MUST ask how to treat the database:
  - restore the chosen version's snapshot (when it has one);
  - migrate down (when both versions' states are recorded and the history is a straight line);
  - keep it as it is.

  The default is the snapshot on an environment other than prod, and keeping it otherwise.
  `--database snapshot|migrations|keep` chooses in a script, and a choice not available is refused
  before any change.
- **FR-1925**: A rollback that restores or migrates down MUST be approved like a destroy: its hash
  covers the choice and the snapshot, its text says what is lost, and the user types the
  environment's name (`--confirm <name>`).
- **FR-1926**: The server MUST change data on a rollback only with the one-time approval OpsCrew
  writes there after the user's approval, naming the target digest and the choice, valid for 30
  minutes and used once.
- **FR-1927**: The database step MUST, in order:
  1. hold requests;
  2. stop the app's web, workers and cron;
  3. dump the current database under the running version (when snapshots are on);
  4. restore or migrate down;
  5. start the earlier version and let the held requests through.

  If step 4 fails, it MUST restore step 3's dump, start the running version again, and say what
  failed and where the log is.
- **FR-1928**: Restoring MUST put each database back exactly as its snapshot holds it, removing
  the tables, collections and other objects that aren't in it.
- **FR-1929**: Snapshots, logs and records MUST stay on the server, readable by the deploy user
  only; no password may appear in a process's arguments, and no dumped value in any output.
- **FR-1930**: Portainer, the app's own files and a database on another server MUST say that their
  data is kept and that snapshots for them come later. A site or a preview MUST refuse
  `--database snapshot|migrations`.

### Key Entities

- **Version:** one image of an environment, by its digest. Its commit, the commit's message, and
  when it was pushed. Read from the registry and the repository; nothing new is stored for it.
- **Rollback:** the environment, the current digest, the target digest, and its approval hash.
  Audited, and recorded with the environment's deployment.
- **Deploy pause:** per environment. Which version is pinned and since when. The workflow reads it
  before deploying.
- **Snapshot:** on the server, one per version, by its digest: when it was taken, and one dump per
  database. Never leaves the server.
- **Migration record:** on the server, one per version: the migration tool's state after that
  version's release command (a version, a count, or each Django app's last migration).
- **Database approval:** on the server, one at a time: the target digest, the choice and when it
  expires.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1901**: After a release that deploys fine, `opscrew rollback` serves the previous version
  within 3 minutes of approval on a server environment. No request fails during the switch on a
  rolling deploy, and no build or release command runs.
- **SC-1902**: After a rollback, a push doesn't deploy until the user resumes. After
  `opscrew rollback --resume --deploy`, the latest commit is live.
- **SC-1903**: `opscrew rollback --to <commit>` goes back to any version still in the registry,
  and refuses one that isn't, before any change.
- **SC-1904**: After a deploy whose new copy failed its health check, `opscrew logs` shows that
  copy's last lines.
- **SC-1905**: No secret appears in any rollback output, audit entry or committed file across the
  live pass.
- **SC-1906**: In the local Docker pass, Kafka, Redpanda and OpenSearch each refuse a client without
  the login and serve one with it, in four cases:
  - after a first start;
  - after a restart;
  - after the container is recreated;
  - after the login is turned on for a service that already holds data.

  No password appears in any output or committed file.
- **SC-1907**: On a staging environment in the live pass:
  - a rollback with the snapshot gives the earlier version its database within 5 minutes of
    approval, with the rows of the moment the newer version was deployed and none of its schema;
  - a rollback with down migrations removes the newer schema and keeps the rows.
- **SC-1908**: In the local Docker pass, each of the four databases comes back from its snapshot
  with exactly the snapshot's tables (or collections) and rows. Each of the eight migration tools
  migrates down to the recorded state.
- **SC-1909**: A hand-made dispatch of the rollback changes no data, and no password or dumped
  value appears in any output, log line or audit entry.

## Assumptions

Defaults the lead chose on 2026-10-31. The founder can change any of them.

- **Pause after a rollback** (research R1, Vercel and Render). The alternative, letting the next
  push deploy forward, makes a rollback silently temporary.
- **Settings and secrets stay current.** A rollback changes only the app's image. The image runs
  with today's settings and secrets, as on Vercel, unlike Heroku. Going back to an old secret is a
  separate decision the user makes with the secrets commands.
- **The release command never runs on a rollback.** An old version's migrations run against a
  newer schema could fail or do harm. The guide's rule (add in one release, remove in a later one)
  is what keeps the earlier version working when the database is kept. Since US8 (2026-11-06) a
  rollback can also restore a snapshot or run the newer version's down migrations, never the
  release command.
- **How far back:** as far as the registry keeps this environment's images. Retention keeps the
  latest 10 by default; the user can change that in `opscrew/plan.yaml`.
- **The command:** `opscrew rollback` is new. `promote --digest` and `promote --version` keep
  working; their rollback use is documented as `opscrew rollback`.
- **Logins (lead, 2026-11-01; R7 and R8):**
  - **OpenSearch's login is on by default.** Its clients take the login inside the URL, as
    Elasticsearch's do in OpsCrew already.
  - **Kafka's and Redpanda's are opt-in.** A Kafka client sends a login only when its code is
    configured to, and no variable convention exists.
  - **SCRAM-SHA-512,** which never sends the password itself.
  - **No TLS on top:** the traffic stays inside the app's Docker network, or inside WireGuard
    between servers (018).
- **Not in scope:**
  - users per device or per app for these three services, and changing their password;
  - rolling back volumes other than the four databases' (snapshots as commands are 024);
  - rolling back infrastructure changes (`provision`) or a service's version;
  - Claude Code running the rollback itself, since it asks for approval in the terminal.
