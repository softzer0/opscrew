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
- Research: [research.md](research.md). R5 holds the lead's decisions this spec builds on.

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

### Key Entities

- **Version:** one image of an environment, by its digest. Its commit, the commit's message, and
  when it was pushed. Read from the registry and the repository; nothing new is stored for it.
- **Rollback:** the environment, the current digest, the target digest, and its approval hash.
  Audited, and recorded with the environment's deployment.
- **Deploy pause:** per environment. Which version is pinned and since when. The workflow reads it
  before deploying.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1901**: After a release that deploys fine, `opscrew rollback` serves the previous version
  within 2 minutes of approval on a server environment. No request fails during the switch on a
  rolling deploy, and no build or release command runs.
- **SC-1902**: After a rollback, a push doesn't deploy until the user resumes. After
  `opscrew rollback --resume --deploy`, the latest commit is live.
- **SC-1903**: `opscrew rollback --to <commit>` goes back to any version still in the registry,
  and refuses one that isn't, before any change.
- **SC-1904**: After a deploy whose new copy failed its health check, `opscrew logs` shows that
  copy's last lines.
- **SC-1905**: No secret appears in any rollback output, audit entry or committed file across the
  live pass.

## Assumptions

Defaults the lead chose on 2026-10-31. The founder can change any of them.

- **Pause after a rollback** (research R1, Vercel and Render). The alternative, letting the next
  push deploy forward, makes a rollback silently temporary.
- **Settings and secrets stay current.** A rollback changes only the app's image. The image runs
  with today's settings and secrets, as on Vercel, unlike Heroku. Going back to an old secret is a
  separate decision the user makes with the secrets commands.
- **The release command never runs on a rollback.** An old version's migrations run against a
  newer schema could fail or do harm. The guide's rule (add in one release, remove in a later one)
  is what keeps the earlier version working.
- **How far back:** as far as the registry keeps this environment's images. Retention keeps the
  latest 10 by default; the user can change that in `opscrew/plan.yaml`.
- **The command:** `opscrew rollback` is new. `promote --digest` and `promote --version` keep
  working; their rollback use is documented as `opscrew rollback`.
- **Not in scope:**
  - rolling back the database or volumes (a backup restore is a later item on the roadmap);
  - rolling back infrastructure changes (`provision`) or a service's version;
  - Claude Code running the rollback itself, since it asks for approval in the terminal.
