# Feature Specification: Day-2 Operations

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/003-day2-operations`)
**Created**: 2026-10-12
**Status**: Ready for implementation
**Input**: Approved OpsCrew plan, section 3.1 (`opscrew init`, `status | drift`), section 7.3
(drift), section 7.7 (destroy guards, rollback, snapshots before destructive changes), and the open
items from the MVP converge review: no way to tear a deployment down, no drift check, no
preflight, monorepos limited to one app per repository.

## User Scenarios & Testing *(mandatory)*

The user has an app deployed with features 001 and 002 (a `plan.yaml` with `deployment` filled in,
local OpenTofu or Terraform state under `.opscrew/tfstate/`, deploy secrets in GitHub Actions).

### User Story 1 - Tear a deployment down safely (Priority: P1)

The user runs `opscrew destroy`. OpsCrew shows exactly what will be deleted (server, firewall, SSH
key, DNS records and rules), warns plainly when data lives only on the server (self-hosted
Postgres, uploads), offers a server snapshot first, then lifts delete protection and deletes
everything through the same plan → approval → apply path as provisioning, with the server name
typed to confirm. It removes the deploy secrets from GitHub so a later push cannot deploy to a dead
address, and records the teardown in the plan.

**Why this priority**: users must be able to stop paying and clean up without the console, and a
safe destroy is the counterpart of a safe apply (constitution I).

**Independent Test**: orchestrator tests with a fake engine, fake Hetzner and fake GitHub cover the
order of plans, the approvals and the refusal paths; the gated live test tears its deployment down
with `opscrew destroy`.

**Acceptance Scenarios**:

1. **Given** a deployed plan with self-hosted Postgres, **When** the user runs `opscrew destroy`,
   **Then** OpsCrew lists every resource to be deleted, says that the database and Hetzner backups
   are deleted with the server, and announces a snapshot (on by default when Postgres runs on the
   server or backups are on; `--snapshot` / `--no-snapshot` override); **When** the user types the
   server name, **Then** it takes the snapshot, lifts delete protection, applies the destroy plan
   and reports what remains (the snapshot, the GHCR images, the repository files).
2. **Given** the user types anything other than the server name, **When** asked to confirm,
   **Then** nothing is deleted and protection stays on.
3. **Given** a non-interactive run, **When** `opscrew destroy` runs without `--confirm <server
   name>`, **Then** it refuses with the exact command to use; **When** `--confirm` matches, **Then**
   it proceeds without prompts, but the protection-lifting plan is applied only if it changes
   nothing except the server's protection.
4. **Given** the destroy finished, **Then** the GitHub deploy secrets are deleted (after approval),
   the server's host key is removed from OpsCrew's known_hosts, and `plan.yaml` no longer lists a
   server address and records `destroyedAt`; `opscrew provision` can create a fresh deployment.

---

### User Story 2 - Know when reality drifted (Priority: P1)

The user runs `opscrew drift`. OpsCrew compares the live infrastructure with its state
(changes someone made in the Hetzner or Cloudflare console), the state with the infrastructure
code in the repository (changes not applied yet), and the infrastructure files with what OpsCrew
would render from `plan.yaml` (hand edits or an OpsCrew upgrade). It never changes anything.

**Why this priority**: the plan's day-2 promise; silent drift (an opened firewall port, a deleted
DNS record) is a security problem.

**Independent Test**: engine tests parse `resource_drift` from real refresh-only plans (gated on
the binaries); orchestrator tests with scripted plans cover clean, drifted, pending and edited
files.

**Acceptance Scenarios**:

1. **Given** a firewall rule was added in the console, **When** the user runs `opscrew drift`,
   **Then** the report names the firewall and the changed attribute, says it was changed outside
   OpsCrew, explains that `opscrew provision` would undo it, and exits 1.
2. **Given** nothing changed, **Then** the report says the deployment matches the plan and exits 0.
3. **Given** the user edited `opscrew/infra/prod/main.tf`, **Then** the report lists the file as
   differing from what OpsCrew renders.
4. **Given** the state is missing (another computer provisioned), **Then** drift explains where the
   state lives and exits 2 without planning against empty state.

---

### User Story 3 - Get ready in one command (Priority: P2)

The user runs `opscrew init` in a fresh clone. OpsCrew checks everything the flow needs (git and a
GitHub remote, OpenTofu or Terraform, ssh, tokens and what they can access, an optional model key)
and prints a checklist where every problem has the exact fix. With `--fix` (or after approval) it
adds `.opscrew/` to `.gitignore`.

**Why this priority**: the Phase 1b exit criterion ("a stranger deploys in under 20 minutes") fails
on missing tools and tokens long before any agent runs.

**Independent Test**: unit tests with fake runner, fetch and env cover each check's pass, warn and
fail paths.

**Acceptance Scenarios**:

1. **Given** no OpenTofu or Terraform, **When** the user runs `opscrew init`, **Then** the checklist
   marks it as a failure with install instructions and the command exits 1.
2. **Given** a Cloudflare token that cannot see the zone of the planned domain, **Then** the check
   names the missing permission and the token creation link.
3. **Given** `.opscrew/` is not ignored, **Then** init offers to add it and does so only after
   approval (or with `--fix`).
4. **Given** `--offline`, **Then** no token is verified over the network and the token checks say
   they were only checked for presence.

---

### User Story 4 - Deploy one app from a monorepo (Priority: P2)

In a repository with several deployable apps (for example `apps/web` and `apps/api`), the interview
asks which app to deploy, analysis and design then describe only that app, the Dockerfile builds it
from the repository root (so workspace packages are included), and the deploy works like a
single-app repository.

**Why this priority**: closes the known MVP limitation; Turborepo/pnpm workspaces are common among
the target audience's newer projects.

**Independent Test**: detect, interview, design, adapt and Docker template tests over the monorepo
fixtures; the e2e suite gains a two-app example.

**Acceptance Scenarios**:

1. **Given** `apps/web` (Next.js) and `apps/api` (Express), **When** the user runs `opscrew
   interview`, **Then** it asks which app to deploy, offering both; **When** the user picks
   `apps/web`, **Then** `architecture.json` describes the Next.js app and design proposes options
   for it.
2. **Given** the chosen app, **When** `opscrew adapt` runs, **Then** it writes `apps/web/Dockerfile`
   that builds from the repository root and the plan's `app.dockerfile` points to it.
3. **Given** `opscrew analyze --app apps/api`, **Then** the choice is recorded without asking.

---

### User Story 5 - The same from Claude Code (Priority: P3)

The plugin's MCP server offers `opscrew_drift` and `opscrew_init_check` (read-only). Destroy stays
terminal-only; the deploy skill explains how to tear down.

**Acceptance Scenarios**:

1. **Given** the MCP server, **When** the client lists tools, **Then** `opscrew_drift` and
   `opscrew_init_check` are present with read-only annotations and no destroy tool exists.

### Edge Cases

- Destroy when the server no longer exists (deleted in the console): the refresh drops it from
  state; the destroy plan only removes what is left; the snapshot step is skipped with a note.
- Destroy when the plan uses Cloudflare but the token is missing: stop before planning (a partial
  destroy would leave DNS pointing at a dead address).
- Destroy interrupted after protection was lifted: re-running continues (the unprotect plan is
  empty, the earlier snapshot is reused, the destroy plan proceeds); `drift` shows the lifted
  protection as a pending change meanwhile.
- Snapshot creation fails or times out: stop before deleting anything.
- Drift with Terraform state written by OpenTofu with encryption: explain the engine mismatch.
- Init on Windows: ssh checks use Windows OpenSSH; PATHEXT-aware detection.
- Monorepo where the chosen app imports workspace packages: the image installs from the root
  lockfile; Python apps in a subfolder copy only their folder.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-301**: `opscrew destroy [--snapshot | --no-snapshot] [--confirm <server name>] [--engine <name>]` MUST
  implement US1: preview of resources and data at risk, optional snapshot through a typed Hetzner
  adapter (default on when Postgres is self-hosted or backups are enabled), a protection-lifting
  plan applied after an `iac-apply` approval, a destroy plan applied after an `iac-apply` approval
  with `allowDestroy` and the server name as the typed phrase, deletion of the GitHub deploy
  secrets after a `github-secrets` approval, removal of the pinned host key, and an updated plan.
- **FR-302**: `@opscrew/connector-hetzner` MUST add typed write methods used only after approval:
  create a snapshot image of a server (with labels and description), wait for an action, and list
  servers by label selector.
- **FR-303**: `@opscrew/connector-github` MUST add deleting an Actions secret (404 counts as done).
- **FR-304**: `opscrew drift [--json]` MUST implement US2 with a refresh-only plan (drift), a normal
  plan (pending changes), a rendered-files comparison and DNS records at the app's hostnames that
  OpsCrew did not create; exit 0 when everything matches, 1 when anything differs, 2 when the
  check could not run (missing state, passphrase or deploy key, credentials); it never applies,
  never creates keys or passphrases and leaves no approvable plan behind.
- **FR-305**: `@opscrew/iac-engine` MUST support refresh-only plans and report drift
  (`resource_drift`) as resource address, action (update or delete) and changed attribute names,
  without attribute values.
- **FR-306**: `opscrew init [--fix] [--offline]` MUST implement US3 with checks for: Node version,
  git and the GitHub remote, OpenTofu/Terraform, ssh and ssh-keyscan, Hetzner, Cloudflare (when the
  plan or requirements use it) and GitHub tokens and their access, model credentials (optional),
  optional scanners (informational), and `.opscrew/` in `.gitignore`.
- **FR-307**: Detection MUST report the app directory in the facts and accept a chosen app
  directory; requirements MUST record the chosen app directory; the interview MUST ask for it when
  several apps qualify; `opscrew analyze --app <dir>` MUST record it without asking; Docker
  templates MUST build an app in a subfolder from the repository root.
- **FR-308**: The MCP server MUST add `opscrew_drift` and `opscrew_init_check`; the plugin skills
  MUST describe drift and terminal-only destroy.
- **FR-309**: The root infrastructure module MUST expose a `delete_protection` variable (default
  true) so destroy can lift protection without editing committed files.
- **FR-310**: The runbook MUST describe `opscrew drift` and `opscrew destroy`.

### Key Entities

- **Drift report**: drifted resources (address, action, attributes), pending changes, differing
  files, engine, checked-at time.
- **Init check**: id, title, status (pass, warn, fail, skip), message, fix.
- **Deployment** (in `plan.yaml`): gains `destroyedAt`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-301**: After `opscrew destroy`, no resource labelled `managed-by=opscrew,app=<name>` remains
  (asserted by the live test), and nothing was deleted without the typed server name.
- **SC-302**: `opscrew drift` on an unchanged deployment exits 0 and makes no changes (no apply
  call in any test).
- **SC-303**: `opscrew init` on a machine with everything installed finishes in under 10 seconds
  with network checks, and under 2 seconds with `--offline`.
- **SC-304**: The two-app example deploys either app through the e2e flow with the right Dockerfile.

## Assumptions

- State stays local (`.opscrew/tfstate`); remote state and scheduled drift in CI are a later
  feature (they need state the runner can read).
- Destroy is offered for Hetzner + Cloudflare deployments made by OpsCrew; resources created by
  other tools are never touched.
- Snapshots are billed by Hetzner per GB per month; OpsCrew says so and never deletes them.
