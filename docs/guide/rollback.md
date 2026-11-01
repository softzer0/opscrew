# Rolling back a release

A release can pass every check and still be wrong: a broken page, a bug in a payment flow, a slow
query. `opscrew rollback` puts the environment back on the version that ran before, with one
command. It deploys the earlier image by its exact digest, so nothing is rebuilt, and it uses the
same switch and checks as a deploy, so with [rolling deploys](zero-downtime.md) your site keeps
serving while it switches.

```bash
npx opscrew rollback                  # back to the version before the one running now
npx opscrew rollback --list           # the versions you can go back to
npx opscrew rollback --to 3f2a1c9     # back to one of them, by its commit or digest
npx opscrew rollback --resume         # deploys from the branch again
```

Like every command, it takes `--app <key>` and `--env <name>` for
[another app](several-apps.md) or [environment](environments.md).

A deploy that fails its checks doesn't need this: OpsCrew already switches back by itself (see
[When a deploy fails, and how to recover](when-a-deploy-fails.md)).

## Roll back, or fix forward?

- **Roll back** when the bad release is live and the fix will take more than a few minutes. Your
  visitors get the earlier version back within the time a deploy's switch takes, and you fix the
  cause without hurry.
- **Fix forward** (push a fix or a `git revert`) when the fix is small, or when the bad release
  changed the database in a way the earlier version can't work with (see
  [The database stays as it is](#the-database-stays-as-it-is)).

## What a rollback does

On a server OpsCrew created, [a server you already have](own-server.md) or
[your Portainer](portainer-target.md):

1. OpsCrew reads the environment's versions: the images its deploy workflow built that are still
   in GitHub Container Registry.
2. It picks the version before the one running, or the one you named with `--to`.
3. It shows both versions and asks for your approval.
4. It pauses the environment's automatic deploys, then starts its deploy workflow with the earlier
   image's digest.
5. The workflow checks where the image was built, skips the build, and deploys the image through
   the same switch as a deploy: the health check, the check from outside through your domain, and
   the automatic switch back if the earlier version fails them too. The release command does not
   run.

When the run succeeds, OpsCrew says so and how to resume deploys:

```text
prod runs 3f2a1c9 "Fix checkout total" again (sha256:ab12cd34ef56, https://github.com/…/actions/runs/…): no build, and no release command ran.
prod's deploys are paused: a push to main builds but doesn't deploy. When the fix is pushed, run `opscrew rollback --env prod --resume` (add --deploy to deploy main's latest commit now).

Rolled prod back to 3f2a1c9 "Fix checkout total" (sha256:ab12cd34ef56), the earlier image with no build: https://github.com/…/actions/runs/…
```

Its next steps are `opscrew verify`, to check the live site, and `opscrew rollback --resume` once
the fix is ready.

## Which versions you can go back to

```bash
npx opscrew rollback --list
```

`--list` changes nothing and takes no other flag. It shows the environment's versions as a table,
newest first: the newest 20 builds, and those around the version running and the one before
it:

```text
Versions of prod, newest first:

  Version              Commit   Built                 Mark      Message
  sha256:12ab34cd56ef  9e8d7c6  2026-10-31 09:58 UTC  running   Add invoices page
  sha256:ab12cd34ef56  3f2a1c9  2026-10-30 16:20 UTC  previous  Fix checkout total
```

**Mark** names the version running and the one `opscrew rollback` goes to without `--to`
(`previous`). On a site, **Version** is the Worker's version id or the Pages run's id. Below the
table, the list says whether deploys are paused, and the command to go back to one of them.

A version is listed only when OpsCrew may deploy it: its image is still in GitHub Container
Registry, its build provenance shows that this repository's deploy workflow built it from the
environment's branch, and it was built for the environment's CPU. The list says how many images it
left out ("Not offered: 2 more images of prod that failed the provenance or CPU check, or that the
registry no longer has."). When you name one of those with `--to`, OpsCrew refuses and says why.

**The default** is the deployment before the one running: the image labelled
`opscrew-<env>-previous`. After a rollback that label names the version you rolled back from, so a
second `opscrew rollback` goes one further back, to the newest version built before the running one
whose build succeeded. It never undoes the first rollback: to go forward again, use
[`--resume`](#deploys-pause-after-a-rollback), or `--to` with a newer version. Sites follow the
same rule: the default is the Worker version or Pages run that served before the one running, when
it is older, otherwise the newest older one.

**`--to`** takes a commit (7 to 40 of its hexadecimal digits) or a digest (`sha256:` and at least
12 of its digits). OpsCrew refuses, before any change, a version that is not in the list (it names
the newest five and the oldest one still there) and the version already running. A `--to` that is
neither a commit nor a digest, or that matches more than one version, stops before any change too,
as an error (exit code 2).

## What the approval shows

```text
Roll prod back to 3f2a1c9 (sha256:ab12cd34ef56)
Now: 9e8d7c6 "Add invoices page", built 2026-10-31T09:58:12Z (sha256:12ab34cd56ef)
Back to: 3f2a1c9 "Fix checkout total", built 2026-10-30T16:20:41Z (sha256:ab12cd34ef56)
Image: ghcr.io/…@sha256:…, built by https://github.com/…/actions/runs/…
The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.
Target: prod (https://shop.example.com), opscrew/plan.yaml with plan hash …; nothing is waiting for `opscrew provision`
Deploy: opscrew-deploy.yml on main, given the digest; nothing is rebuilt. Afterwards prod's deploys pause until `opscrew rollback --env prod --resume`.
Rollback hash: …
```

For an environment that follows a branch, it also names what changed in `opscrew/plan.yaml` since
that version, from the plan at its commit:

- **Workers, cron jobs and variables added since:** they run with the earlier image too, so check
  that it copes with them.
- **A service removed since** (a database, a cache): OpsCrew refuses, since nothing would bring it
  back. Choose a version built after it was removed, or fix forward.

When OpsCrew can't read the plan at that commit, the approval says it did not check it.

With [image signing](supply-chain.md#signing-images) on, the approval says the workflow checks the
image's signature before anything is deployed. When the environment's GitHub environment has
required reviewers, the approval says GitHub asks them too, before the deploy job runs.

The approval is bound to a hash of the environment, the version running, the version to go back to
and the environment's plan. If any of them changes, it no longer applies.

## The database stays as it is

A rollback changes only which image runs. The data, the database schema and your app's settings
and secrets stay as they are now, and the release command (your migrations) does not run: an
earlier version's migrations, run against a newer schema, could fail or do harm. The earlier
version runs against today's schema, with today's settings.

So the earlier version must work with the newer schema. Add columns and tables in one release, and
remove the old ones in a later release, once nothing uses them (see
[Migrations and the previous version](when-a-deploy-fails.md#migrations-and-the-previous-version)).
A rollback can't undo a migration. To go back to older data, restore a backup (see
[Backups and snapshots](when-a-deploy-fails.md#backups-and-snapshots)).

## Deploys pause after a rollback

The bad commit is still on the branch, so the next push would deploy it again. After a rollback,
OpsCrew pauses the environment's automatic deploys. Other environments keep deploying.

- **A push** still runs the deploy workflow and builds its image, but the deploy job is skipped.
  The run's summary says why: "Deploys of shop/prod are paused since …: `opscrew rollback` pinned
  it to 3f2a1c9 (sha256:ab12cd34ef56). This run built … but didn't deploy it." So you can see that
  a fix builds, and `opscrew rollback --to <its commit>` can deploy it while deploys stay paused,
  without its release command: for a fix that changes the database, use `--resume --deploy`.
- **`npx opscrew status`** shows the version running, the one before it, and the pause:

  ```text
  Deploys (read from the server and GitHub now):
    Running: 3f2a1c9 "Fix checkout total" (sha256:ab12cd34ef56), since 2026-10-31 10:04 UTC
    Before it: 9e8d7c6 "Add invoices page" (sha256:12ab34cd56ef)
    Paused since 2026-10-31 10:02 UTC: `opscrew rollback` pinned it to 3f2a1c9 (sha256:ab12cd34ef56). Run `opscrew rollback --resume` when the fix is pushed (add --deploy to deploy main's latest commit now).
  ```

- **[`opscrew promote`](environments.md#promotion)** refuses to deploy to a paused environment.

When the fix is pushed, resume:

```bash
npx opscrew rollback --resume            # pushes deploy again; the next one deploys
npx opscrew rollback --resume --deploy   # also deploys the branch's latest commit now
```

`--resume` asks for your approval, then removes the environment's entry from the pause. With
`--deploy` it also starts the deploy workflow on the branch: it builds the latest commit and
deploys it, with the release command, and the approval names that commit. When that run waits in
GitHub for a required reviewer, OpsCrew says so with the run's link: it deploys once the reviewer
approves it. When deploys aren't paused, `--resume` alone says so and changes nothing. A promoted
environment takes no `--deploy`: run `--resume`, then `opscrew promote --to <env>`.

While a rollback pauses the environment, `npx opscrew provision` says that the files its pull
request merges deploy only after `opscrew rollback --resume --deploy` (for a promoted environment,
`--resume` and then `opscrew promote`).

The pause is the repository variable `OPSCREW_DEPLOY_PAUSED` (GitHub → Settings → Secrets and
variables → Actions → Variables): a JSON object with one entry per paused environment, holding the
pinned commit and digest and no secret. The same variable pauses deploys while a service
[moves between your servers](split-placement.md); `--resume` never ends that pause, and a rollback
refuses while it is there. Your GitHub token needs the Variables permission for this (see
[The GitHub token](security.md#the-github-token)).

## Each target

| Where the app runs | How it goes back |
|---|---|
| A server OpsCrew created, or [your own](own-server.md) | The earlier image by its digest, through the deploy workflow, as above |
| [Your Portainer](portainer-target.md) | The deploy workflow writes the stack with the earlier image to the deploy branch, in a commit "Roll back to <image>", and Portainer redeploys it. The stack's `release` service skips the release command |
| [An environment promoted from another](environments.md#promotion) | The image it ran before, through its deploy workflow on the default branch. Afterwards `opscrew promote --to <env>` refuses until `opscrew rollback --resume` |
| [Your computer](localhost.md) | The image it ran before, while Docker still has it |
| [Cloudflare's hosting](cloudflare-hosting.md#rolling-back) | An earlier Worker version, activated again: no build |
| [GitHub Pages](github-pages.md#rolling-back) | A re-run of an earlier Pages run, which builds the site again from that run's commit |

- **Your computer** keeps only the version before (`.env.previous` in the app's folder), so
  `--list` shows two images and `--to` is refused. After a rollback, the version before is the one
  you rolled back from, and OpsCrew refuses to go back to it: deploy forward with
  `npx opscrew provision`. When Docker no longer has the earlier image, OpsCrew says so and changes
  nothing. Deploys pause only when the [local runner](runners.md#the-local-runner) deploys the
  environment from its branch; then a rollback also refuses while a deploy run is queued or
  running.
- **Cloudflare's hosting:** `--to` takes a Worker version id, which `--list` shows. When one of
  your app's secrets changed since that version, OpsCrew refuses, as Cloudflare does; see
  [After a secret changed](cloudflare-hosting.md#after-a-secret-changed).
- **GitHub Pages:** `--to` takes a Pages run's id or its commit (7 or more of its digits), and
  `--list` shows the successful runs. OpsCrew says first that the re-run builds the site again (a
  base image or a dependency may have changed since) and that GitHub re-runs a run only for 30
  days. A re-run deploys even while deploys are paused.
- **On a site,** a run's summary and `opscrew status` name the pinned version by its whole Worker
  version id or Pages run id.

## In a script

`--yes` never approves a rollback. Without `--approve`, `opscrew rollback` changes nothing and
prints the command with the rollback's hash. Review the rollback, then run that command:

```bash
npx opscrew rollback --env prod                                         # shows the rollback and its hash
npx opscrew rollback --env prod --to sha256:… --approve <hash>          # applies exactly that rollback
```

On your computer the printed command has no `--to`, since there is only the version before. When
anything the hash covers changed in between (a deploy ran, or the plan changed), OpsCrew refuses
and shows the rollback again with its new hash.

Resuming is a smaller change: `npx opscrew rollback --resume --yes` resumes without asking.

Flags that don't go together are refused before any work, with the right command.

The exit code says how it ended:

| Code | When |
|---|---|
| 0 | Rolled back, listed, resumed, or the run waits in GitHub for a required reviewer |
| 1 | Refused before any change, or not approved (no `--approve`, or a hash that is no longer this rollback's) |
| 2 | Could not run: flags that don't go together, a `--to` that is not a commit or digest, or that matches several versions (or any `--to` on your computer), missing credentials, or a rollback run that failed |

Claude Code doesn't roll back for you: the [plugin](claude-code-plugin.md) shows the versions and
the pause, and asks you to run `opscrew rollback` in your terminal.

## When OpsCrew refuses

Every refusal comes before any change, says "Nothing was changed." and what to do next. A rollback
refuses when:

- **The environment isn't provisioned,** or has a change waiting for `opscrew provision`, or its
  deploy workflow is not the one its plan generates: run `npx opscrew provision` and merge its pull
  request (see [After upgrading OpsCrew](#after-upgrading-opscrew)).
- **A deploy of the environment is queued or running:** let it end, then roll back. OpsCrew names
  the run.
- **A move is in progress,** to another target or of a service between your servers.
- **There is only one version,** or GitHub Container Registry has no image labelled
  `opscrew-<env>`, so OpsCrew can't tell which version runs.
- **The earlier image is gone** from the registry (see [How far back](#how-far-back)).

While a rollback run waits for a required reviewer, `opscrew rollback` says so (exit 0) and
`--resume` refuses. Once the run ended, `opscrew rollback` records it; when the run failed, it puts
the pause back and goes on with a new rollback, which asks for your approval.

Reading the versions needs access to GitHub Container Registry. GitHub's fine-grained tokens may
not have it: set `OPSCREW_GHCR_READ_TOKEN` to a classic token with only the `read:packages` scope,
as for [promote](environments.md#the-registry-token-for-promote).

## When the rollback fails

When the earlier version fails its health check or the check from outside, the environment keeps,
or gets back, the version it ran before the rollback, as for any deploy. The run fails and says
which:

- "The rollback failed before the earlier version took traffic; the server still runs the version
  it had."
- "The rollback failed: the earlier version did not pass its checks, so OpsCrew put back the
  version that ran before the rollback."

`opscrew rollback` then fails with the run's link, and puts the deploy pause back as it was before
the rollback.

`npx opscrew logs --failed` shows the last lines of the earlier version's copy when it failed its
health check (see [`logs --failed`](logs-and-status.md#a-failed-deploys-lines)). Then roll back to
another version (`--list`), or fix forward.

## How far back

As far back as GitHub Container Registry keeps the environment's images. After each healthy deploy,
OpsCrew keeps the newest 10 deployed images and deletes older ones, but never the one running or
the one before it (see [Old images are cleaned up](supply-chain.md#old-images-are-cleaned-up)). To
keep more, raise `cicd.imageRetention.keep` in `opscrew/plan.yaml` and run
`npx opscrew provision`.

A rollback deletes no image. While deploys are paused, pushes still build images, and those count
toward the 10 at the next deploy.

## By hand, without OpsCrew

Everything a rollback does is in your repository and visible in GitHub, so you can do it without
OpsCrew. Each environment's `opscrew/RUNBOOK.md` has the steps with its own names:

1. Open the deploy run that built the version you want: its summary says "Pushed
   `<image>:<tag>` as `<image>@<digest>`".
2. Add the environment's entry to the repository variable `OPSCREW_DEPLOY_PAUSED`, so no push
   deploys over the rollback.
3. In GitHub → **Actions** → the environment's deploy workflow, choose **Run workflow** on its
   branch (the default branch for a promoted environment), enter the digest as `digest` and the tag
   as `tag`, and tick `rollback`.

The run's verify job checks the image's provenance (and with signing on, its signature), so only
images this repository's branch built can deploy. On GitHub Pages, re-run the earlier run instead
(**Re-run all jobs**).

## After upgrading OpsCrew

Rollback changes every deploy workflow once. After upgrading OpsCrew, run `npx opscrew provision`
once for each environment (`--env <name>`) and merge its pull request. Until then,
`opscrew rollback` refuses and says so.
