# Feature Specification: Retarget

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/005-retarget`)
**Created**: 2026-10-13
**Status**: Ready for implementation
**Input**: Approved OpsCrew plan, section 3.1 (`retarget` = move a deployment between providers
from the same plan), section 4.5 gap 6 (portability: start cheap, move when it grows), section 8
Phase 2; feature 004 (two VPS providers, design refuses to switch a live deployment's provider).

## User Scenarios & Testing *(mandatory)*

The user has a live deployment made by OpsCrew (features 002–004) on Hetzner Cloud or
DigitalOcean and wants it on the other provider without losing data and with as little downtime
as possible. OpsCrew creates the new server next to the old one, deploys the app there, copies
the database during a short maintenance window, switches DNS, and deletes the old server only
when the user says the new one is good.

### User Story 1 - Move a live app to the other provider (Priority: P1)

**Why this priority**: portability is a core promise (users start on a cheap VPS and move when
they need other regions or prices), and today the only path is destroy and re-provision, which
loses the database.

**Independent Test**: orchestrator tests with a fake engine, fake connectors, fake GitHub and a
fake remote shell walk every step, including interruptions and failures; template tests and the
gated engine tests prove the infrastructure layouts with both engines; the gated live test moves
an example from Hetzner Cloud to DigitalOcean.

**Acceptance Scenarios**:

1. **Given** a live Hetzner deployment with Cloudflare DNS and self-hosted Postgres and both
   provider tokens set, **When** the user runs `opscrew retarget --to digitalocean`, **Then**
   OpsCrew offers the DigitalOcean options for the plan's region and budget (as `opscrew design`
   does), and after the choice shows the steps, the extra monthly cost while both servers run,
   the database size and the expected maintenance window; nothing changes before the user
   continues.
2. **When** the user continues, **Then** OpsCrew applies a plan that only renames the current
   server in the infrastructure state (nothing changes in the cloud), then a plan that creates the
   new server next to the old one, each after an approval bound to its plan hash; it waits for
   the new server and pins its host key.
3. **Then** the GitHub deploy secrets point to the new server (after approval), the deploy
   workflow runs for the current branch and succeeds, and OpsCrew confirms over SSH that the app
   answers on the new server; the old server still serves users.
4. **When** the user confirms the maintenance window, **Then** OpsCrew stops the app on the old
   server, copies the database to the new server, starts the app there and checks it; if any of
   these fails, the app on the old server is started again and nothing else changes.
5. **Then** the DNS records are switched in place to the new server (after approval), OpsCrew
   checks the app through its domain, and `plan.yaml` lists the new server as the deployment; the
   old server stays (with its app stopped) until the user finishes the move.
6. **Given** a run that was interrupted at any step, **When** the user runs `opscrew retarget`
   again, **Then** it continues from the last completed step.

---

### User Story 2 - Finish or abort safely (Priority: P1)

**Why this priority**: a move is only safe when the old server is removed deliberately, and when
the user can step back before users are switched.

**Acceptance Scenarios**:

1. **Given** a switched move, **When** the user runs `opscrew retarget --finish`, **Then** OpsCrew
   lists only the old server's resources, offers a snapshot (on by default when the database or
   backups lived there), asks for the app name, lifts Hetzner delete protection with a plan that
   changes nothing else, applies a destroy plan limited to the listed resources, removes the old
   host key, commits the final infrastructure files in a pull request, and clears the move from
   `plan.yaml`.
2. **Given** a move before the DNS switch, **When** the user runs `opscrew retarget --abort`,
   **Then** OpsCrew deletes the new server's resources (after the typed app name), renames the old
   server back in the state, points the deploy secrets back to the old server, makes sure the app
   runs there, and restores the plan's target.
3. **Given** a move after the DNS switch, **When** the user runs `opscrew retarget --abort`,
   **Then** it refuses and explains that the way back is another `opscrew retarget`.
4. **Given** a move in progress, **When** the user runs `opscrew provision`, `design`, `dns`,
   `drift` or `destroy`, **Then** the command stops and says how to continue, finish or abort the
   move.

---

### User Story 3 - Scripts and CI (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a non-interactive run, **When** `opscrew retarget` reaches a plan, **Then** it saves
   the plan, prints its hash and the command to continue (`opscrew retarget --approve <hash>`),
   and stops; the maintenance window needs `--allow-downtime`; `--finish` and `--abort` need
   `--confirm <app name>` and the plan hashes as above.

---

### User Story 4 - Know where a move stands (Priority: P3)

**Acceptance Scenarios**:

1. **Given** a move in progress, **When** the user runs `opscrew status`, **Then** a `retarget`
   line shows the source and target providers, the last completed step and the next command.
2. **Given** Claude Code with the OpsCrew plugin, **Then** the deploy skill explains that moving
   providers is terminal-only and how to run it; no MCP tool performs a move.

### Edge Cases

- The requested provider is the plan's current provider: refuse (moves within one provider are a
  later feature; server names would collide).
- Either provider's token, the GitHub token or (when used) the Cloudflare token is missing or
  rejected: stop before the first plan.
- No self-hosted Postgres (no database, or an external one such as Supabase): no data to copy;
  the old app keeps running until the DNS switch (no maintenance window).
- DNS not managed by OpsCrew (`dns.provider: none`, with or without a domain): OpsCrew shows the
  records to change (or, without a domain, the new address) and continues after the user confirms
  (`--dns-switched` in scripts); it then waits up to 5 minutes until the domain resolves only to
  the new server before checking the app. With self-hosted Postgres the old app stays stopped
  until then, so the downtime includes the user's DNS change (the summary says so and advises a
  low TTL).
- The deploy workflow fails: stop; the old server still serves; fix and re-run, or abort.
- The database copy or restore fails, or the new app is unhealthy after it: start the old app
  again, delete the dump files, stop; re-running repeats the maintenance window.
- Interrupted during the maintenance window: the next `opscrew retarget` (or `--abort`) first
  makes sure the old app runs again unless the copy had completed.
- The DNS switch apply fails: start the old app again and return to the step before the
  maintenance window, so users are served while the user fixes the cause.
- The new server cannot get a TLS certificate within a few minutes after the switch: say so with
  the next step (the old app stays stopped; `--abort` is no longer possible).
- A Hetzner deployment made before the `delete_protection` variable existed: the rename plan
  would also change the server (protection), so it stops before any change and asks the user to
  run `opscrew provision` first (which adds the variable) and then move.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-501**: `opscrew retarget [--to <provider>] [--option <id>] [--approve <hash>]
  [--allow-downtime] [--dns-switched] [--engine <name>]`, `opscrew retarget --finish
  [--snapshot | --no-snapshot] [--confirm <app name>] [--approve <hash>]` and
  `opscrew retarget --abort [--confirm <app name>] [--approve <hash>]` MUST implement US1–US3;
  `--yes` approves the GitHub secrets, push and pull request steps in scripts.
- **FR-502**: `plan.yaml` MUST record a move in progress (`retarget`: the previous target and
  addresses, the new server's addresses, the last completed step, times) and the CLI state MUST
  know a `retarget` phase; files without `retarget` stay valid.
- **FR-503**: The IaC engine MUST report moved resources (from `previous_address`) and OpsCrew
  MUST apply a plan that only moves resources, after an approval that says nothing changes in the
  cloud.
- **FR-504**: The infrastructure templates MUST render the move layouts (rename, both servers,
  switched, finish, abort) with both providers' modules and provider blocks while a move is in
  progress, the DNS module pointing at the live server, and outputs for both servers; every
  layout MUST validate under OpenTofu and Terraform.
- **FR-505**: Every infrastructure change of a move MUST go through plan → policy checks →
  approval bound to the plan hash → apply; deletions MUST need `allowDestroy` and the typed app
  name; GitHub secret changes a `github-secrets` approval; the maintenance window a `remote-exec`
  approval that lists its commands.
- **FR-506**: The maintenance window MUST stop the old app, dump the database on the old server,
  copy the dump server to server through OpenSSH, restore it on the new server, delete the dump
  files (the new app is stopped during the restore), start and health-check the new app, and roll
  back to the old app on any failure; restarting the old app after a completed copy returns the
  move before the window; the expected downtime MUST be shown first (database size). The
  Cloudflare switch plan is prepared and checked before the window and applied after it.
- **FR-507**: `@opscrew/connector-github` MUST dispatch a workflow and find and wait for the run
  it started.
- **FR-508**: Provision, design, dns, drift and destroy MUST refuse to run while a move is in
  progress, with the commands to continue, finish or abort.
- **FR-509**: `--finish` MUST delete only the old server's resources (snapshot, protection lift on
  Hetzner, preview-bounded destroy, typed name), remove its host key, publish the final
  infrastructure files in a pull request and clear the move.
- **FR-510**: `--abort` MUST be possible until the DNS switch and restore the previous deployment
  exactly (target, state addresses, deploy secrets, running app); after a switch apply that
  failed half-way it first points the records back with a plan bound to its hash; once the typed
  name was given the move can only be aborted. `--finish` first checks that the new server serves
  the app (Caddy, URL; without managed DNS the domain resolves to it) and otherwise keeps the old
  server.
- **FR-511**: `opscrew status`, CLI help, the runbook, the deploy skill and the README MUST
  describe moving between providers.
- **FR-512**: A gated live test MUST move an example from Hetzner Cloud to DigitalOcean when both
  e2e tokens are set, check that the data survived, finish the move and tear everything down.

### Key Entities

- **Move** (`plan.retarget`): previous target (provider, location, server type, image, backups)
  and its addresses, the new server's addresses, the last completed step, start time, and
  whether a maintenance window is open.
- **Layout**: which server modules the rendered root module contains and where DNS points.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-501**: In the live test a row written before the move is readable through the app's
  database after it, and the app answers through the domain before and after.
- **SC-502**: No test path deletes a resource without the typed app name, and no plan is applied
  without an approval bound to its hash (asserted on every step).
- **SC-503**: Interrupting the move after any step and running `opscrew retarget` again completes
  it (one test per step).
- **SC-504**: All feature 002–004 tests keep their meaning; rendered infrastructure files without
  a move are byte-identical (the runbook gains the section "Moving to another provider").

## Assumptions

- Only the self-hosted Postgres database moves; the Valkey cache starts empty and Caddy gets new
  certificates on the new server.
- Both servers run in parallel for the duration of the move; OpsCrew shows the extra cost.
- The deploy workflow (`opscrew-deploy.yml`) on the default branch is the one OpsCrew generated
  and has `workflow_dispatch`.
- Moves within one provider (another location or size) and MCP tools for moving are later
  features.
