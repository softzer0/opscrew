# When a deploy fails, and how to recover

This page follows one app through the ways a deploy can go wrong. For each one it says what you
see, what your visitors get, how to find the cause and how to get back. In most cases OpsCrew has
already put things back by the time the run turns red.

The rules behind every case:

- **A deploy changes your data only through your release command** (your migrations). The database
  keeps running through a deploy and its switch back; it restarts only when its own image or
  settings changed. OpsCrew never undoes a migration.
- **A version that fails a check doesn't stay.** Before it takes traffic, it is removed. After it
  takes traffic, OpsCrew switches the server back to the version that ran before, when there is
  one: a first deploy, or a deploy of the image already running, has nothing to go back to.
- **Infrastructure changes nothing without your approval.** A provision that stops half-way leaves
  what it already created, and the next run plans only what is missing.

## The app in this walkthrough

`shop` is a [Next.js](https://nextjs.org/) app with [PostgreSQL](https://www.postgresql.org/), like
[`examples/nextjs-postgres`](https://github.com/softzer0/opscrew/tree/main/examples/nextjs-postgres),
with [Prisma](https://www.prisma.io/) migrations. It runs on a [Hetzner Cloud](https://www.hetzner.com/cloud) server, and visitors reach it at
`shop.example.com` through [Cloudflare](https://www.cloudflare.com/)'s proxy. Its plan in `opscrew/plan.yaml` has:

- `app.healthPath: /api/health` and `app.port: 3000`;
- `app.releaseCommand: npx prisma migrate deploy`, which OpsCrew picks when the app has
  `prisma/migrations/` and the `prisma` package;
- `deploy.strategy: rolling`, because the server has at least 1 GB of memory.

Each push to `main` that changes the app runs the **OpsCrew deploy** workflow (see
[When a push deploys your app](when-deploys-run.md)). It has two main jobs: **Build the image**,
then **Deploy to the server**.

## Where to look

- **The workflow run** ([GitHub](https://github.com/) → **Actions** → **OpsCrew deploy**): which step failed, with
  OpsCrew's message.
- **`npx opscrew verify`**: whether the site is up and healthy, and whether the latest deploy run
  succeeded.
- **`npx opscrew status`** and **`npx opscrew logs`**: what runs and how it is doing, and its log
  lines (see [Your app's logs and resource figures](logs-and-status.md)).
- **`opscrew/RUNBOOK.md`**: the SSH command for the server, when you need to read a file there.

`verify` reports a failed run like this:

```text
The latest deploy ended with "failure": https://github.com/…/actions/runs/…
```

## The build fails

You push a commit that doesn't compile.

The **Build the image** job fails with your build's own error, for example from `next build`, and
the **Deploy to the server** job is skipped. Nothing changed on the server: the version that ran
before keeps serving. Read the failed step's log, fix the code and push again. A few build errors
say to re-run the workflow instead: open the run and choose **Re-run failed jobs**.

The image scan only reports. A scan that can't run doesn't stop the deploy.

## The new version fails its health check

The image builds, but the new version crashes on start, or `/api/health` answers with an error.

**What you see.** The **Start the new version** step fails with:

```text
The new version did not pass its health check (GET /api/health on port 3000) within 60 seconds,
so OpsCrew removed it. It received no traffic: the previous version keeps serving. Its last lines
are kept on the server: `opscrew logs --failed`. Check that the app listens on port 3000 (app.port
in opscrew/plan.yaml, passed to the app as PORT) and answers /api/health. It was built with …
```

The message ends with the builder that made the image (see
[How OpsCrew builds your app's image](builders.md)). Then the **Roll back to the previous version**
step reports "The deploy failed before the new version took traffic; the server still runs the
version it had."

**The state of the app.** Visitors noticed nothing. The new copy started next to the running one
and never received a request, and the running one never stopped. The release command had already
run, so its migrations stay applied, and the previous version runs against the new schema.

**Finding out why.** Before it removes the failed copy, OpsCrew keeps its last 500 log lines on the
server. Read them with:

```bash
npx opscrew logs --failed
```

The first line names the copy's image, what it failed and when (see
[A failed deploy's lines](logs-and-status.md#a-failed-deploys-lines)); `npx opscrew logs` shows the
version that still runs. Check the two things the message names: that the app listens on the port
in its `PORT` variable, and that it answers `/api/health`. To watch the new version start, run it
where you can see it, for example in
[your app's production stack on your own computer](localhost.md).
Fix the cause and push again.

### On a small server, or with SQLite

There the old version stops before the new one starts (`deploy.strategy: recreate`), so when the
new version fails its health check, visitors get errors until OpsCrew has switched back. A
migration the release command already ran stays applied; see
[Small servers restart the app instead](zero-downtime.md#small-servers-restart-the-app-instead).

## The migration fails

A new migration fails against the production database, for example because a new unique index
meets duplicate rows.

**What you see.** The **Start the new version** step fails with:

```text
The release command (app.releaseCommand in opscrew/plan.yaml) failed, so the new version was not
started and the previous version keeps serving. Its output stays on the server in
/srv/apps/shop/release.log (it can quote data from the database, so it is not printed here;
opscrew/RUNBOOK.md has the SSH command). A migration that stopped partway may have applied some of
its changes, and the previous version now runs with them: read release.log to see how far it got,
then fix the migration and push again to deploy forward, or restore a backup taken before this
deploy.
```

**The state of the app.** Visitors are served by the previous version all along: the release
command runs in a one-off container of the new image, before the switch. OpsCrew doesn't undo
anything the release command did: if the migration stopped halfway, what it already changed stays
changed, unless your migration tool or database rolled it back. The previous version runs against
the database as the migration left it.

**Finding out why.** The output isn't in the run's log, which is public in a public repository.
Log in with the SSH command in `opscrew/RUNBOOK.md` and read it:

```bash
cat /srv/apps/shop/release.log
```

**Recovering.** `release.log` shows how far the migration got. Then either:

- **Deploy forward:** fix the migration, or the data it tripped over, and push again. Each deploy
  runs the release command again, so a migration that stopped halfway must cope with the changes it
  already made, or you undo them by hand first.
- **Restore a backup** taken before this deploy, when the half-applied changes can't stay (see
  [Backups and snapshots](#backups-and-snapshots)).

`opscrew rollback` doesn't help here: the previous version already runs, and a rollback goes to an
earlier version than the one running.

## The snapshot before the release fails

On environments that take [snapshots before each release](rollback.md#snapshots-before-each-release)
(every one but prod, by default), the deploy copies the app's data before the release command. When
a copy fails, the deploy stops there and the previous version keeps serving. The message names the log
on the server (`.snapshots/snapshot.log` in the app's folder), which can quote data and so is not
printed. Fix what it shows, or set `deploy.snapshots: false` in the environment's plan and run
`npx opscrew provision` to deploy without snapshots. Too little disk space doesn't stop a deploy:
it goes ahead without a snapshot and its log has a warning.

## Migrations and the previous version

Every migration runs while the previous version still serves, and stays applied when a later step
fails and OpsCrew switches back. So the previous version must work with the new schema: add
columns and tables in one release, and remove the old ones in a later release, after nothing uses
them (see [Deploys without downtime](zero-downtime.md#limits)). The same rule keeps
[a rollback that keeps the database](rollback.md#keep-it-as-it-is) working: the earlier version
runs against today's schema, since a rollback runs no release command. A rollback can also
restore the snapshot taken before the release, or migrate the database down (see
[The database](rollback.md#the-database)).

## A worker or cron job doesn't stay up

When the app has workers or cron jobs, they start on the new image after the switch, and each must
keep running for 30 seconds. When one doesn't, the step fails with:

```text
The worker container did not keep running for 30 seconds after it started with the new version,
so the deploy failed and OpsCrew puts the web and the workers back on the previous version, if
there is one. Read its last lines, from before OpsCrew put the previous version back, with
`opscrew logs --failed --service worker`, then fix its command (processes in opscrew/plan.yaml) or
the app, and push again.
```

The rollback step then reports "The deploy failed; OpsCrew restored the previous version." For
those 30 seconds and the switch back, visitors were served by the new version. Its migrations stay
applied, and the previous version runs against the new schema.

The switch back replaces the worker's container, so `npx opscrew logs --service worker` shows the
previous version's lines. The command in the message shows the failed one's, which OpsCrew kept
before it removed it.

## The last check, through your domain, fails

After the switch, the **Check that the app is healthy** step asks for
`https://shop.example.com/api/health`, from outside, through Cloudflare. It tries 30 times, 6
seconds apart. When no try succeeds, it fails with "The new version did not answer at
https://shop.example.com/api/health.", and the rollback step switches back: "The deploy failed;
OpsCrew restored the previous version."

**The state of the app.** This check runs after the new version took traffic, so for those few
minutes visitors reached the new version, as the check did. The switch back is a rolling switch
too: the previous version starts, passes its health check and only then takes traffic. The new
version's migrations stay applied, and the previous version runs against the new schema.

**Finding out why.** The new version had passed its health check on the server, so the cause is
often between your visitors and the app: DNS, Cloudflare's settings, the certificate, or an app
that crashed right after it started. `npx opscrew verify` checks DNS, HTTPS, the certificate and
the health route one by one. `npx opscrew status` shows whether a container restarted, and
`npx opscrew logs --failed` the new version's last lines, which OpsCrew kept before it switched
back. Fix the
cause and push again, or re-run the workflow when the cause was outside the app.

## Other stops before the switch

These fail the run before the new version starts. Visitors keep the version that ran, and the run
says so:

- **[Caddy](https://caddyserver.com/) refused the app's site,** checked before anything reaches the server.
- **The shared proxy on the server did not start** or did not accept the app's site.
- **A service's one-time setup failed.**
- **A service on another of the app's servers did not update** (see
  [split placement](split-placement.md)).

When there is no previous version to go back to after the switch, the rollback step says: "The
deploy failed and there is no earlier version to restore (first deploy, or the same image was
already running). Fix the problem and push again."

In the rare case that the previous version fails its health check too, the step says "The deploy
failed and OpsCrew could not restore the previous version. Connect to the server and run
`docker compose ps` in /srv/apps/shop." Do that with the runbook's SSH command, and run
`npx opscrew logs`.

## The release is healthy, but wrong

The new version passes every check, but it has a bug, and you want the previous version back.

Roll back to the version that ran before:

```bash
npx opscrew rollback
```

OpsCrew shows the version running and the one before it, asks how to treat the database (on
staging, restoring the snapshot taken when that version stopped running is the default; on prod,
keeping it as it is), and asks for your approval. Then it deploys the earlier image by its digest, with the
same switch and checks as a deploy: nothing is rebuilt, and the release command does not run.
Afterwards a push to `main` builds but does not deploy, so the bad commit can't come back by
accident. When the fix is pushed, `npx opscrew rollback --resume --deploy` deploys `main` again.

`--list` shows the earlier versions, and `--to <commit>` goes further back. The same command works
for an environment promoted from another, and on every target. See
[Rolling back a release](rollback.md).

To fix forward instead, `git revert` the bad commit and push to `main`: the workflow deploys the
reverted code.

**What a rollback undoes in the database.** Keeping it as it is changes only which image runs: rows
written by the new version stay, and so do its migrations (see
[Migrations and the previous version](#migrations-and-the-previous-version)). Restoring the
snapshot puts back the database of the moment the new version was deployed, and loses everything
written since; down migrations drop the tables and columns the new version added. See
[The database](rollback.md#the-database). For data older than the snapshots, restore a backup
([below](#backups-and-snapshots)).

## `opscrew provision` stops half-way

`npx opscrew provision` shows the infrastructure plan, and applies it only after you approve its
hash. An apply can still fail part of the way through, for example when Hetzner has no server of
that type left in the location, or when a token lacks a permission.

**What you see.** In your terminal:

```text
Applying the plan failed:
…the last lines of OpenTofu's or Terraform's output…
```

followed by what to do next. OpsCrew names the common causes (your account's server limit, a token
missing a permission, a server type unavailable in the location) and says "Nothing that was already
created is removed." Otherwise it says "Fix the cause shown above, then run `opscrew provision`
again; it plans the remaining changes."

**The state of the app.** What was created before the failure exists in your Hetzner and
Cloudflare accounts and is billed as usual. It is recorded in the infrastructure state on the
computer that ran `provision`, so OpsCrew knows about it. The changes the apply didn't reach
haven't happened. When the app already ran, check it with `npx opscrew verify`.

**Recovering.** Either finish it or remove it:

- **Finish:** fix the cause and run `npx opscrew provision` again. It plans only the remaining
  changes. That is a new plan with a new hash, so it asks for your approval again. In a script, an
  old `--approve <hash>` doesn't apply to it.
- **Remove it:** `npx opscrew destroy` plans the deletion of everything in the state, asks you to
  type the server's name, and deletes it.

The apply can also succeed and a later step stop, while OpsCrew waits for the new server:

```text
The server at … did not open SSH within 5 minutes.
The server at … did not finish its first-boot setup within 8 minutes.
```

Check the server in [Hetzner Console](https://console.hetzner.cloud) (the second message gives a command that shows what the
server is doing), then run `npx opscrew provision` again: it continues where it stopped.

## When the server itself is in trouble

- **A reboot or a crash:** every running container restarts by itself when [Docker](https://www.docker.com/) starts, and
  Docker starts with the server; `npx opscrew status` flags containers that restarted (see
  [Your app's logs and resource figures](logs-and-status.md)). The server installs security updates
  on its own but OpsCrew never reboots it: `npx opscrew secure` says when a reboot is pending.
- **An alert:** the [scheduled check](alerts.md) opens an issue when the app stops answering, its
  certificate is about to expire or the disk fills up, and says what to run next.
- **A change made outside OpsCrew:** `npx opscrew drift` reports it, and `npx opscrew provision`
  undoes it after showing the plan; to keep it, update `opscrew/plan.yaml` first.
- **No way in, with public SSH closed and the tunnel lost:** see
  [Getting back in](public-ssh.md#getting-back-in-when-this-computers-configuration-is-lost).
  Deploys from the server's own runner keep working meanwhile; deploys from this computer's runner
  need its tunnel back.
- **The computer that ran `provision` is gone:** restore its files with your key, see
  [The recovery copy of your app's secrets](secrets-recovery.md).

### Backups and snapshots

- **Server backups:** when you tell `npx opscrew interview` that losing the data would be anything
  but "Not a problem", design turns on Hetzner's automated backups. Hetzner backs up the whole
  server every day and keeps the last seven (Hetzner Console → your server → **Backups**). They are
  copies of a running server: the database recovers from one as after a power cut.
- **Database dumps:** for a copy you can restore anywhere, dump the database on the server. See
  [Backups](databases.md#backups).
- **Snapshots:** `npx opscrew destroy` takes a Hetzner snapshot before it deletes the server when
  data lives on the server (here PostgreSQL) or backups are on, because Hetzner deletes a server's
  backups with it. Add `--no-snapshot` to skip it.

- **Snapshots of the data:** `npx opscrew snapshot` copies the app's data, and
  `npx opscrew restore <id>` puts it back without changing the version that runs; they can also be
  taken on a schedule, with an encrypted copy off the server. On
  [a server you already have](own-server.md) and in your Portainer, they are the backup. See
  [Snapshots and restores](snapshots.md).

Restore a Hetzner backup in Hetzner Console, or a dump with the commands in the runbook.

## Other targets

- **[A Portainer](portainer-target.md):** a failed deploy writes the previous version back.
  OpsCrew has no shell there, so it keeps no failed copy's lines for `logs --failed`.
- **[Cloudflare's hosting](cloudflare-hosting.md) and [GitHub Pages](github-pages.md):** a deploy
  starts no copy that could fail a health check, so `logs --failed` has nothing to show.
- **Everywhere,** `npx opscrew rollback` goes back to an earlier version after your approval, by
  the target's own means (see [Each target](rollback.md#each-target)).

## At a glance

| What failed | Visitors get | What runs afterwards | What you do |
|---|---|---|---|
| The build | The version that ran | The version that ran | Fix and push |
| The health check (rolling) | The version that ran, without a break | The version that ran, with the new migrations applied | `logs --failed`, fix and push |
| The health check (recreate) | Errors until the switch back | The version that ran, with the new migrations applied | `logs --failed`, fix and push |
| The migration | The version that ran | The version that ran; the database as the migration left it | Read `release.log`, then fix and push, or restore a backup |
| A worker or cron job | The new version for a short while | The version that ran, with the new migrations applied | `logs --failed --service <name>`, fix and push |
| The check through your domain | The new version for a few minutes | The version that ran, with the new migrations applied | Check DNS, Cloudflare and `verify` |
| Nothing, but the release is wrong | The new version, until you roll back | The earlier version, with today's database, its snapshot, or the database migrated down | `opscrew rollback`, then `--resume` once the fix is pushed |
| `opscrew provision` | What the plan changed, as far as the apply got | What was created stays | Run `provision` again, or `destroy` |
