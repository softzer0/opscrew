# Feature Specification: An existing Portainer as a deploy target

**Feature Branch**: `mvp` (feature directory `specs/010-portainer-target`)
**Created**: 2026-10-15
**Status**: Draft
**Input**: Founder decisions 2026-10-15: many people already run Portainer CE, often on a NAS
(Synology, Unraid, TrueNAS) or any Docker host, and manage everything through it; OpsCrew deploys
their app as a Portainer stack through Portainer's API, with no SSH and no changes to the host. This
is the next feature, before Proxmox (now 011). Redeploys are offered two ways (Portainer polling a
deploy branch by default; GitHub Actions calling Portainer through Cloudflare Access as an option),
and visitors reach the app three ways (a Cloudflare Tunnel by default; the user's own reverse proxy;
Caddy on ports 80/443).

## Why

Feature 009 deploys to a server the user owns, but it needs SSH and Ubuntu or Debian, and it changes
the host (Docker, the deploy user, SSH, the firewall). People who run Portainer on a NAS cannot use
it: their system is not Ubuntu or Debian, SSH is often off, and they do not want anything changed on
the box except their own stacks. They already trust Portainer with their containers; OpsCrew should
deploy into it the way they would by hand, but planned, approved, repeatable and kept secure, and it
should keep deploying every merged change without opening Portainer to the internet.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy my app to the Portainer I already run (Priority: P1)

A user with Portainer CE on a NAS or a Docker host chooses "my existing Portainer" in the interview,
gives its address and an access token, and picks the environment to deploy to. OpsCrew checks what it
can reach, then shows the exact stack it would create (the app, its release command and the database
or cache the app needs), the registry access Portainer needs to pull the image, and how merged
changes will reach Portainer. Nothing changes until the user approves that exact plan. After the
deploy pull request is merged, the app runs as a stack in Portainer and every later merge deploys by
itself.

**Why this priority**: it is the feature; without it nothing else here is useful.

**Independent Test**: fakes of Portainer's API cover checking, planning, approval and applying; the
gated live test deploys an example app to a real Portainer CE on a throwaway server and checks that
a merged change reaches it with nothing exposed.

**Acceptance Scenarios**:

1. **Given** a reachable Portainer and a token with access to one Docker environment, **When** the
   user runs `opscrew provision`, **Then** OpsCrew shows the stack, the registry entry, the
   repository access and the redeploy setting it would create, marks what already exists, and
   changes nothing in Portainer until the user approves the plan by its hash.
2. **Given** the approved plan, **When** OpsCrew applies it, **Then** Portainer runs the app's stack
   with the image built by the deploy workflow, the app's secrets are set only as the stack's
   environment, and every change is in the audit log without any secret value.
3. **Given** the deploy pull request is merged, **When** the deploy workflow has built the image,
   **Then** the new version runs in Portainer within the redeploy setting's time, and the workflow
   reports success only after the site answers its health check.
4. **Given** a merged change whose new version fails its health check, **When** the workflow sees
   the failure, **Then** the previous version runs again and the workflow reports the failure.
5. **Given** a stack OpsCrew already set up, **When** the user runs `opscrew provision` again,
   **Then** the plan shows no changes and nothing in Portainer changes.

---

### User Story 2 - Never touch what I did not give OpsCrew (Priority: P1)

The user's Portainer runs other stacks, maybe a reverse proxy, a media server, a database. OpsCrew
must never change, stop or delete anything it did not create, must never change Portainer's own
settings, and must stop with a plain explanation when it cannot do its job safely.

**Why this priority**: one mistake on someone's home server loses their trust for good.

**Independent Test**: fakes of Portainer in each conflicting state produce the right refusal; the
live test runs next to a decoy stack and checks it is unchanged after every command.

**Acceptance Scenarios**:

1. **Given** a stack with the app's name that OpsCrew did not create, **When** OpsCrew plans,
   **Then** it stops, says which stack it found and how to choose another name, and changes nothing.
2. **Given** a token that cannot reach the chosen environment or cannot manage stacks there,
   **When** OpsCrew checks Portainer, **Then** it stops with a plain message saying which access is
   missing and how to grant it.
3. **Given** a Portainer older than the supported minimum, or an environment that is not a single
   Docker host (Swarm or Kubernetes), **When** OpsCrew checks it, **Then** it stops with a plain
   message and changes nothing.
4. **Given** Portainer's address answers with a certificate OpsCrew has not seen before, **When** it
   connects the first time, **Then** it shows the certificate's fingerprint and continues only after
   the user confirms it; a different certificate later stops every command until the user confirms
   the change.
5. **Given** any OpsCrew command, **When** it finishes, **Then** every stack, volume, registry entry
   and setting OpsCrew did not create is exactly as before.

---

### User Story 3 - Visitors reach my app (Priority: P2)

The user wants the app on their domain over HTTPS. Their NAS may sit behind a router with no open
ports, and its own web interface often uses ports 80 and 443. The user picks how visitors reach the
app: through a Cloudflare Tunnel (the default), through the reverse proxy they already run, or
through Caddy on ports 80 and 443 when those are free.

**Why this priority**: an app nobody can reach is not deployed; but the deploy itself (US1) comes
first, and each way of reaching it can be tested on its own.

**Independent Test**: rendering and planning with fakes for each way; the live test serves the app
through the tunnel and through Caddy and checks the site over HTTPS.

**Acceptance Scenarios**:

1. **Given** a domain on Cloudflare and the tunnel chosen, **When** the plan is applied, **Then** the
   app answers over HTTPS on the domain, the stack opens no port on the host, and the tunnel's secret
   exists only in the stack's environment (and OpsCrew's local state).
2. **Given** the user's own reverse proxy chosen with a port, **When** the plan is applied, **Then**
   the app answers on that port of the host and OpsCrew tells the user exactly what to route to it;
   OpsCrew does not manage the certificate.
3. **Given** Caddy chosen, **When** OpsCrew checks the host, **Then** it refuses plainly if ports 80
   or 443 are already taken, and otherwise the app answers over HTTPS with an automatic certificate.

---

### User Story 4 - Instant redeploys through Cloudflare (Priority: P2)

By default Portainer looks for new versions on a schedule, so a merged change appears within
minutes. A user who wants each merge live at once, and a health check from the inside, chooses the
option where GitHub Actions calls Portainer directly through Cloudflare Access, without exposing
Portainer to the internet.

**Why this priority**: the default already deploys every merge; this is a faster, optional path.

**Independent Test**: rendering the workflow and the Cloudflare resources with fakes; the live test
deploys a merged change through Access and checks Portainer refuses a request without the service
token.

**Acceptance Scenarios**:

1. **Given** the option chosen and Cloudflare Zero Trust turned on, **When** the plan is applied,
   **Then** Portainer is reachable from GitHub Actions only through a hostname protected by Access
   with a service token, and from the internet not at all.
2. **Given** a merged change, **When** the deploy workflow runs, **Then** it updates the stack
   through Portainer's API, waits for the new version, checks its health and rolls back on failure.

---

### User Story 5 - Day 2 and teardown (Priority: P2)

The user runs drift, verify, secure and destroy as with other targets. OpsCrew compares what it set
up in Portainer with what it would set up now, checks the app from outside, and on destroy removes
only what it created, keeping the app's data unless the user explicitly asks otherwise.

**Why this priority**: an app OpsCrew cannot check or remove cleanly is a liability.

**Independent Test**: fakes of Portainer with drifted settings; destroy against fakes checks exactly
what is removed; the live test destroys and checks Portainer, the decoy stack and the data.

**Acceptance Scenarios**:

1. **Given** someone changed the stack's file, its environment keys or its redeploy setting in
   Portainer, **When** the user runs `opscrew drift`, **Then** OpsCrew reports exactly those
   differences, never an environment value.
2. **Given** a deployed app, **When** the user runs `opscrew destroy`, **Then** OpsCrew removes the
   app's stack, the registry entry and repository access it created, the deploy secrets and the DNS
   records, tunnel and Access it created; deletes the app's data only after an explicit approval for
   data loss and a typed confirmation of the app's name; and never touches Portainer itself or any
   other stack.
3. **Given** a Portainer target, **When** design, the runbook, secure or destroy run, **Then** they
   say plainly that OpsCrew does not change the host (its firewall, SSH and Portainer's own security
   stay the user's) and that backups are the user's responsibility; no server price is shown.

---

### Edge Cases

- Portainer answers only over plain HTTP (the legacy port): OpsCrew refuses to send the token
  unencrypted, unless the address is the user's own computer, and says how to use HTTPS.
- Portainer uses a self-signed certificate (its default): the fingerprint is confirmed on first use
  and pinned, never "skip verification".
- The token's user loses access later: commands stop with a plain message; nothing is half-applied.
- Portainer applies stack changes in the background: OpsCrew waits for the result (bounded) and
  reports success only when the stack runs the new version, or the failure Portainer reports.
- The host is an ARM NAS: OpsCrew builds the image for the host's architecture.
- The repository is private: Portainer reads the deploy branch with a read-only token the user
  provides; the token is stored only in Portainer's settings for that stack and OpsCrew's local state.
- The app needs Postgres or Redis: they run inside the app's stack with named volumes, like on other
  targets; their data stays on destroy unless explicitly deleted.
- Two OpsCrew apps on one Portainer: allowed under different stack names; only one may use Caddy on
  ports 80/443.
- The deploy branch is changed by hand: drift reports it; the next deploy writes it again.
- Portainer is restarted or updated during a deploy: the workflow's health check fails or times out,
  and the previous version is restored on the next run; the user is told plainly.
- The environment is a Portainer Edge agent: stack updates on schedule may behave differently;
  OpsCrew refuses Edge environments plainly for now.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-1001**: OpsCrew MUST offer "my existing Portainer" as a deploy target in the interview, the CLI
  and the MCP tools, asking for Portainer's address, an access token and the environment, and never
  for a Portainer password.
- **FR-1002**: OpsCrew MUST keep Portainer's address, the access token and the repository and
  registry tokens only in local state and in Portainer itself: never in `opscrew/plan.yaml`, the
  repository, pull requests, prompts, logs, audit entries or reports.
- **FR-1003**: OpsCrew MUST talk to Portainer only over HTTPS with the certificate confirmed on first
  use and pinned afterwards (plain HTTP only for the user's own computer), and stop when the
  certificate changes until the user confirms it.
- **FR-1004**: Before planning, OpsCrew MUST check, read-only, Portainer's version against the
  supported minimum, the environment's type (a single Docker host; Swarm, Kubernetes and Edge
  refused for now) and architecture, the token's access to manage stacks there, existing stacks and
  registry entries with the names it would use, and (for Caddy) whether ports 80 and 443 are free.
- **FR-1005**: OpsCrew MUST show the exact Portainer changes it would make (the stack and its
  settings, the registry entry, the repository access, the redeploy setting) as a plan bound to its
  SHA-256 hash, change nothing until that plan is approved by its hash (a new approval kind for
  Portainer changes; `--yes` never grants it), and apply it only through a typed Portainer adapter.
- **FR-1006**: OpsCrew MUST never change, stop, redeploy or delete a stack, volume, registry entry or
  setting it did not create, and MUST stop with a plain message when the name it needs is taken.
- **FR-1007**: The app's secrets MUST reach Portainer only as the stack's environment through
  Portainer's API from the user's computer; OpsCrew MUST never print, plan, audit or commit their
  values.
- **FR-1008**: The stack MUST run the same app runtime OpsCrew uses on its own servers (the app, its
  release command before a new version takes traffic, and the database or cache the app needs, with
  named volumes for their data), using the image the deploy workflow built, pulled with read-only
  registry access OpsCrew registers in Portainer.
- **FR-1009**: By default, merged changes MUST reach Portainer without Portainer being reachable from
  the internet: the deploy workflow records the new image in a dedicated deploy branch and Portainer
  checks that branch on a schedule and redeploys; the workflow checks the site's health and, on
  failure, records the previous image again so the previous version returns.
- **FR-1010**: As the user's explicit choice, the deploy workflow MAY instead update the stack
  through Portainer's API reached only through a hostname protected by Cloudflare Access with a
  service token, wait for the new version, check its health and roll back on failure; Portainer MUST
  stay unreachable from the internet otherwise.
- **FR-1011**: Visitors MUST reach the app the way the user chose: a Cloudflare Tunnel in the app's
  stack (default; no host ports opened), the user's own reverse proxy on a port the user chooses
  (OpsCrew says what to route and does not manage TLS), or Caddy on ports 80/443 with automatic
  certificates (only when those ports are free); the tunnel and Access are infrastructure code
  through the IaC engine behind the safety gate.
- **FR-1012**: Re-running provision MUST be idempotent: an unchanged setup shows no changes and
  changes nothing.
- **FR-1013**: `opscrew drift` MUST compare the stack's file, its environment keys (never values),
  its redeploy setting, the registry entry and the deploy branch with what OpsCrew would set up now,
  plus the Cloudflare resources, and report every difference.
- **FR-1014**: `opscrew destroy` MUST remove only what OpsCrew created for the app (the stack, the
  registry entry and repository access it created, the deploy secrets, the DNS records, tunnel and
  Access), MUST never touch Portainer itself or another stack, and MUST delete the app's data only
  with the destroy approval and a typed confirmation of the app's name.
- **FR-1015**: `verify` MUST check the site through its domain (or the user's route), and `secure`
  MUST check the app and its stack and say plainly that the host, its firewall, SSH and Portainer's
  own security are the user's responsibility, as are backups; no server price MUST be shown.
- **FR-1016**: Every failure MUST say in plain English what happened, what (if anything) was already
  changed, and what to do next.
- **FR-1017**: The MCP server and the Claude Code plugin MUST offer the same choices and enforce the
  same approvals as the CLI; deleting data stays in the terminal; the Portainer certificate is
  confirmed by the user, never by the model.

### Key Entities

- **Portainer target**: where the app runs: Portainer's address and pinned certificate, the
  environment, the access token (local state only), the redeploy mode (deploy branch or API through
  Cloudflare Access) and the web access mode (tunnel, own proxy, Caddy).
- **App stack**: the stack OpsCrew creates for one app: its name, file, environment keys and the
  redeploy setting; identified as OpsCrew's by its name and OpsCrew's record.
- **Stack plan**: the ordered Portainer changes (create or update the stack, the registry entry, the
  repository access, the redeploy setting; their removal on destroy), each marked as already in
  place or as a change, hashed and approved before it is applied.
- **Deploy branch**: a branch of the app's repository that holds only the stack file with the
  current image; written by the deploy workflow, read by Portainer.
- **Local record**: what OpsCrew created in Portainer (ids, names), kept on the user's computer so
  destroy removes exactly that.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1001**: A user with Portainer CE and a domain on Cloudflare goes from `opscrew init` to a
  verified site on their domain in under 20 minutes, without SSH and without anything changed on the
  host outside the app's stack.
- **SC-1002**: After a merge, the new version serves visitors within the redeploy setting's interval
  plus 5 minutes by default, and within 5 minutes of the image build with the Cloudflare option.
- **SC-1003**: A new version that fails its health check is replaced by the previous one without the
  user doing anything, in both redeploy modes.
- **SC-1004**: In the live test, a decoy stack and Portainer's own settings are byte-for-byte
  unchanged after every OpsCrew command, including destroy.
- **SC-1005**: No access token, registry or repository token, tunnel secret or app secret appears in
  the repository, pull requests, plans, CLI output, audit entries or reports (checked in the live
  test).
- **SC-1006**: A second `opscrew provision` on an unchanged setup shows no changes, every time.

## Assumptions

- The user already runs Portainer CE (current LTS 2.45.2; the supported minimum is set in research)
  with a Docker environment, and can create an access token for a user that may manage stacks there.
- Portainer's free edition is enough: stack webhooks and relative-path volumes, which are documented
  as Business Edition features, are not used.
- The app's image is built and pushed to GHCR by GitHub Actions, as for other targets; Portainer can
  reach GHCR and GitHub.
- A domain on Cloudflare is needed for the tunnel and the Cloudflare option; the user's own proxy and
  Caddy work with any DNS.
- OpsCrew does not harden or change the host, install anything on it or manage Portainer's own
  security; it says so.
- Backups (including the app's volumes) are the user's responsibility on this target.
- One app per stack name; several OpsCrew apps may share one Portainer.
