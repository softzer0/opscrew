# Feature Specification: Credential rotation

**Feature Branch**: `main` (feature directory `specs/025-credential-rotation`)
**Created**: 2026-11-08
**Status**: Draft
**Input**: The roadmap's "025 Credential rotation" (founder, 2026-11-06: security work that depends
on no provider, after 024's snapshots; every credential OpsCrew generates, each change a plan
approved by its hash, the recovery copy updated each time, no value in any output). Research:
[research.md](research.md); R9 holds the founder's two decisions this spec builds on.

## Why

OpsCrew makes every password, key and token once and never changes it. A credential that leaked
(a laptop lost, a log shared, a teammate gone) stays valid until the user replaces it by hand,
and doing that safely means knowing where OpsCrew copied it: the server's env files, GitHub
secrets, a Portainer stack, the recovery copy. Only the recovery copy's own key can be rotated
today. A command that changes each credential in the right order, without breaking the running
app, and says when one is old, closes that gap.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Rotate a service's password without breaking the app (Priority: P1)

**Why this priority**: the databases and caches hold the app's data; their passwords are the
credentials a leak exposes most.

**Independent Test**: on staging with PostgreSQL, MySQL and Valkey under steady requests,
`opscrew rotate db mysql cache`: the plan names each service and how it rotates; after approval
each gets a new password, the app keeps answering, and no old or new value appears anywhere.

**Acceptance Scenarios**:

1. **Given** an environment on a cloud server, the user's own server, Portainer or this
   computer, **When** the user runs `opscrew rotate <service>`, **Then** a plan lists each of
   the service's generated secrets and how it rotates: seamless (MySQL, Valkey, Redis, Dragonfly,
   Garage's key), a short swap (the others of research R5: new connections the old app opens fail for the
   seconds the plan states), or a restart of that service (ClickHouse, NATS, Meilisearch,
   Typesense's start key, Garage's RPC secret); after its approval by hash the change is applied.
2. **Then** the order is the research's: the runtime change, the env files and GitHub secrets
   (or the Portainer stack), the rolling deploy, and the old password's removal where two were
   held; the app's own address variables follow.
3. **Given** a service on another server (018), **Then** its change runs there and the app's
   server gets the new address.
4. **Given** a rotation that fails partway, **Then** the old values stay on this computer until it
   completes, OpsCrew says what was changed, and running the command again finishes it or puts
   the old value back.
5. **Given** a snapshot taken before a rotation, **When** it is restored (024's restore or a
   rollback's database), **Then** the restored service is given the current password again, so
   the app reaches it.

### User Story 2 - See what can be rotated and how old it is (Priority: P1)

**Independent Test**: `opscrew rotate` on an environment lists every credential with its age and
how it rotates; `--json` gives the same.

**Acceptance Scenarios**:

1. **When** the user runs `opscrew rotate` with no name, **Then** each credential OpsCrew made for
   the environment is listed by the name the command takes, with when it was made or last
   rotated, how it rotates (seamless, a short swap, a restart, users logged out, a new config on
   devices) and what else changes; then the user's own tokens with their expiry where readable.
2. **Given** a credential made before this feature, **Then** its age is "since <the first
   deploy>" at least.
3. **Given** `opscrew rotate --all`, **Then** every credential OpsCrew made for the environment is
   rotated in one plan (after a leak), each as it rotates alone; app secrets that log users out
   still need their typed confirmation.

### User Story 3 - Replace the SSH keys (Priority: P1)

**Independent Test**: `opscrew rotate deploy-key` on staging: a deploy with the new key passes and
the old key no longer opens the server.

**Acceptance Scenarios**:

1. **When** the user rotates `deploy-key`, `check-key` or `preview-key`, **Then** a new pair is
   made on this computer, its public half added to every server it opens (cloud servers over SSH,
   own servers through the host plan), the GitHub secret replaced, a deploy (or a check run, or
   the preview server's check) proven with the new key, and only then the old half removed.
2. **Then** the preview key joins the recovery copy (it is missing today).

### User Story 4 - The app's own secrets (Priority: P2)

**Acceptance Scenarios**:

1. **Given** Laravel's `APP_KEY`, **When** the user rotates `app`, **Then** the new value becomes
   current and the old one stays as the previous one (`APP_PREVIOUS_KEYS`), so nobody is logged
   out and stored data stays readable; the guide says when the old one can go. **Given** Better
   Auth's secret, **Then** the new one becomes current in `BETTER_AUTH_SECRETS` and the old one
   stays for decrypting only, so stored data stays readable; Better Auth checks sessions with the
   current secret alone, so every user is logged out, and the user types the app's name to go
   ahead, as in 2 (T2516's live pass, T2533).
2. **Given** a secret whose framework can't keep the old value (Rails, Django, Flask, Auth.js and
   NextAuth, `SESSION_SECRET`, `JWT_SECRET`, `COOKIE_SECRET`), **Then** the plan says first that
   every user is logged out or issued tokens stop working, and the user types the app's name to
   go ahead (founder, R9).
3. **Given** `CRON_SECRET`, **Then** both sides change in one deploy, with no confirmation.
4. **Given** `app:<NAME>`, **Then** only that secret rotates.

### User Story 5 - The private network and the user's devices (Priority: P2)

**Acceptance Scenarios**:

1. **When** the user rotates `network`, **Then** each server gets a new WireGuard key and the
   others take it in one change (`wg syncconf`; a new handshake of seconds); the plan names every
   device whose config must change, and OpsCrew writes each device's new config (a new key pair
   for it, as `opscrew vpn add` does) for the user to import, the old ones working until then.
2. **When** the user rotates `device:<name>`, **Then** that device gets a new key pair and config.
3. **When** the user rotates a device's login to Valkey, Redis or Dragonfly (018's grants),
   **Then** the new password is shown once, and the old one stops working after the deploy.

### User Story 6 - The user's own tokens (Priority: P2)

**Acceptance Scenarios**:

1. **Given** the Hetzner, DigitalOcean, Cloudflare and GitHub tokens, **Then** `opscrew rotate`
   lists each with its expiry where the provider shows it (Cloudflare's, GitHub's) and otherwise
   the date OpsCrew first saw it (a fingerprint, never the value).
2. **When** the user sets a new token in the environment and runs `opscrew rotate <token>`,
   **Then** OpsCrew checks it has the permissions OpsCrew needs, replaces every copy OpsCrew made
   of it (GitHub secrets, Portainer's registry entry), records the date, and says to delete the
   old one at the provider, naming the page.
3. **Given** the copies the user gave OpsCrew (the Workers deploy token, the GHCR read token, the
   check's ntfy token), **Then** the same.

### User Story 7 - Flag old credentials (Priority: P2)

**Acceptance Scenarios**:

1. **When** the user runs `opscrew advise`, **Then** it lists every credential older than a year
   (`credentials.maxAgeDays` in the plan, default 365) with the command that rotates it; the
   token-expiry warnings stay as they are (30 and 7 days).
2. **Given** the scheduled check with `check.credentials: true` in the plan (off by default),
   **Then** a credential older than that age opens an issue as the check's other findings do
   (founder, R9).

### User Story 8 - Everything else OpsCrew made (Priority: P2)

**Acceptance Scenarios**:

1. **Given** the Cloudflare Access service token and the Tunnel token, **When** rotated, **Then**
   an infrastructure plan replaces each (approved by hash), and the GitHub secrets and the
   server's file follow before the old one goes.
2. **Given** the state passphrase, **When** rotated, **Then** OpenTofu reads the state with the
   old one as its fallback and writes it with the new one in one approved apply, then the
   fallback is dropped.
3. **Given** the self-hosted monitoring's passwords, Portainer's admin password (when OpsCrew
   installed it) and Beszel's hub secrets, **Then** each rotates through its own API or the
   provision that set it.
4. **Given** `recovery-key`, **Then** it does what `opscrew secrets rotate` does today (that
   command moves here).

### User Story 9 - From Claude Code (Priority: P3)

**Acceptance Scenarios**:

1. **Given** Claude Code, **Then** the read-only MCP tool `opscrew_credentials` lists what
   `opscrew rotate` lists; rotating stays a terminal command.

---

### Edge Cases

- **A rotation while a deploy, a move or a snapshot runs**: refused, as those refuse each other.
- **Two computers**: a rotation records its date in a committed file (no values); provision on
  another computer whose values are older stops and names `opscrew secrets restore`.
- **Previews** make their own values on the preview server: a new preview gets new ones; only the
  preview key is OpsCrew's to rotate.
- **Kafka and Redpanda without their login** (019): nothing to rotate; the list says so.
- **MongoDB's replica-set key file and OpenSearch's transport certificate**: not rotated; the
  guide says how.
- **A service that is off** (`enabled: false`): rotated in its files only, with no runtime step.
- **Laravel's previous key**: kept until the user drops it (`opscrew rotate app --drop-previous`),
  since data encrypted with it may remain.
- **A user token that expired**: the list says so; commands that need it fail with the page to
  make a new one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-2501**: `opscrew rotate [<name>...] [--env <env>] [--all] [--json]` MUST list (no name)
  or rotate the named credentials of an environment, on every target that has generated values
  (cloud, own, Portainer, this computer, Cloudflare hosting for app secrets).
- **FR-2502**: Every rotation MUST be a plan approved by its hash, applied through the typed
  adapters and the IaC engine; app secrets that log users out MUST also need the app's name typed.
- **FR-2503**: Each service MUST rotate as research R2–R5 found: seamless where two values can be
  valid at once, otherwise a short ordered swap or a restart, the plan stating which and for how
  long; the running app MUST keep its open connections.
- **FR-2504**: No old or new value MUST appear in any output, log, audit entry, workflow log,
  committed file or prompt. Values reach servers only through env files, GitHub secrets, the
  Portainer stack and SSH's stdin, never on a command line on this computer or in a workflow; on
  the server, only the tools that take no other way (research R10) see one on their command line,
  inside the service's container, for the second they run.
- **FR-2505**: The recovery copy MUST be updated after every rotation (the existing pull request),
  and the preview key MUST join it.
- **FR-2506**: The SSH keys MUST be replaced add-first, proven, then removed (US3).
- **FR-2507**: App secrets MUST keep the previous value where the framework accepts it (Laravel,
  Better Auth), and otherwise need the typed confirmation (founder, R9).
- **FR-2508**: The WireGuard keys of servers and devices and the device logins MUST rotate as US5
  says.
- **FR-2509**: The user's tokens MUST be listed with their expiry or first-seen date, and a new
  one MUST replace every copy OpsCrew made of it (US6).
- **FR-2510**: `opscrew advise` MUST list credentials older than `credentials.maxAgeDays` (default
  365); the scheduled check MUST flag them when `check.credentials` is on (default off).
- **FR-2511**: The Access and Tunnel tokens, the state passphrase, the monitoring passwords,
  Portainer's admin password, Beszel's hub secrets and the recovery key MUST rotate (US8);
  `opscrew secrets rotate` moves to `opscrew rotate recovery-key`.
- **FR-2512**: A restore of data from before a rotation MUST set the current passwords again; a
  failed rotation MUST be resumable or undone with the old values kept until it completes.
- **FR-2513**: The MCP tool `opscrew_credentials` MUST list the credentials read-only; the plugin
  skill and the guide page `docs/guide/credential-rotation.md` MUST describe the command.

### Key Entities

- **Credential**: a name the command takes, its kind (service secret, app secret, SSH key,
  WireGuard key, device login, Cloudflare token, state passphrase, add-on secret, the user's
  token), how it rotates, what else changes, and when it was made or last rotated.
- **Rotation record**: per environment, committed, values never in it: each credential's name and
  the date it was made or last rotated.
- **Rotation plan**: the credentials, each step in order, the downtime or consequence of each, its
  hash; the old values kept on this computer until it completes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-2501**: In the live pass, rotating every service of staging under steady requests fails no
  request for the seamless kinds, and only new connections within the stated seconds for the
  others; the app answers throughout.
- **SC-2502**: After `deploy-key`, the old key no longer opens any server, and a deploy with the
  new one passes.
- **SC-2503**: A scan of every output, log, audit entry, workflow log and committed file of the
  live pass finds no old or new value.
- **SC-2504**: A snapshot taken before a rotation restores and the app reaches its data.
- **SC-2505**: advise flags a credential older than the age set, and the check does when on.

## Assumptions

- The founder's decisions of 2026-11-08 (research R9) and the roadmap's (a short ordered swap where
  a service holds one password).
- OpsCrew never makes the user's tokens; it checks and copies them.
- Not in scope: MongoDB's key file, OpenSearch's transport certificate, the app's own database
  users beyond OpsCrew's, credentials the user put in the app's environment themselves.
