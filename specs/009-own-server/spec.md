# Feature Specification: Your own server, and Portainer

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/009-own-server`)
**Created**: 2026-10-14
**Status**: Draft
**Input**: Founder decisions 2026-10-14: deploying to a server the user already owns comes next,
before the image builders (now feature 011, after Proxmox as a provider in 010); optional Portainer CE on any server OpsCrew deploys
to, off by default, reached through an SSH tunnel, with a Cloudflare Access subdomain only as an
explicit opt-in.

## Why

OpsCrew deploys only to servers it creates on Hetzner Cloud or DigitalOcean. Many users already
pay for a server elsewhere (Contabo, OVH, Vultr, Linode, a company machine) or run one at home (a
mini PC or Raspberry Pi behind a router). They should get the same result on that server: a
hardened host, the app deployed from GitHub, TLS, checks and day-2 commands, without OpsCrew ever
creating, wiping or reinstalling their machine. Some also want a web UI to look at their
containers, which Portainer provides, but its access to the Docker socket means it must never be
openly reachable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy to a server I already have (Priority: P1)

The interview asks where to run the app and offers "a server you already have" next to Hetzner
Cloud and DigitalOcean. The user gives the server's address, the SSH port, the SSH user (root or a
user with sudo) and which SSH key to use. OpsCrew connects, shows the server's host key fingerprint
for the user to confirm, inspects the server and shows a plan of the host changes it would make.
After the user approves that exact plan, OpsCrew prepares the server and the rest of the flow
works as on Hetzner: the deploy pull request, the first deploy from GitHub Actions, `verify`,
`secure` and `drift`.

**Why this priority**: it is the whole point of the feature and brings every server the user
already pays for into reach.

**Independent Test**: fakes for the SSH transport cover planning, approval and applying; the gated
live test prepares a fresh server it creates outside OpsCrew (treated as the user's own), deploys
an example app and tears it down.

**Acceptance Scenarios**:

1. **Given** a reachable Ubuntu LTS or Debian stable server and the user's SSH key, **When** the
   user runs `opscrew provision`, **Then** OpsCrew lists every host change it would make, marks
   what is already in place, and changes nothing until the user approves the plan by its hash.
2. **Given** an approved host plan, **When** OpsCrew applies it, **Then** the server has the
   container runtime, the non-root deploy user with the deploy key, hardened SSH, a firewall that
   allows only SSH and web traffic, automatic security updates and OpsCrew's app runtime; every
   change is in the audit log.
3. **Given** a server OpsCrew has already prepared, **When** the user runs `opscrew provision`
   again, **Then** the plan shows no changes and nothing on the server changes.
4. **Given** the first connection to a server, **When** OpsCrew shows the host key fingerprint,
   **Then** the user confirms it (or passes it with a flag in scripts) and OpsCrew pins it; a later
   connection with a different host key stops with a plain warning and changes nothing.
5. **Given** the prepared server, **When** the deploy pull request is merged, **Then** the app is
   built, deployed and served over HTTPS on the user's domain, exactly as on OpsCrew-created
   servers, including the release command and the health check.
6. **Given** an own-server plan, **When** design runs, **Then** it shows no server price ("you
   already pay for this server") and warns when the server's memory or disk is below what the app
   needs.

---

### User Story 2 - Never break or take over the server (Priority: P1)

The server may already run things. OpsCrew must leave them alone, never lock the user out of SSH,
and say exactly what it cannot do.

**Why this priority**: one locked-out or broken server would destroy trust in the product.

**Independent Test**: fake hosts in each conflicting state produce the right refusal or question
and no change; the live test checks that the user's own login works after setup.

**Acceptance Scenarios**:

1. **Given** another web server or app already listening on ports 80 or 443, **When** OpsCrew
   inspects the server, **Then** it names what is listening, changes nothing, and offers the
   alternatives (the tunnel, or freeing the ports first).
2. **Given** a server that uses another firewall (firewalld, its own nftables rules), runs Docker
   from Snap or uses Podman, or runs an unsupported OS, **When** OpsCrew inspects it, **Then** it
   explains what is different and what the user can do, and does not proceed.
3. **Given** the user connects as root, **When** OpsCrew hardens SSH, **Then** root keeps key-only
   access (passwords off) so the user is never locked out, and OpsCrew explains the stricter option.
4. **Given** any SSH or firewall change, **When** it is applied, **Then** OpsCrew first proves that
   the deploy user and the user's own login still work with keys, and puts the previous setting
   back if they do not.
5. **Given** existing containers, users, packages or files that OpsCrew did not create, **When**
   any OpsCrew command runs, **Then** none of them is changed or removed.

---

### User Story 3 - A home server without a public IP (Priority: P2)

A home-lab machine sits behind a router with no public address or open ports. OpsCrew serves the
app through a Cloudflare Tunnel on the user's Cloudflare domain: no inbound ports are opened, and
deploys from GitHub still happen automatically after a merge.

**Why this priority**: home labs are a large part of the "server I already have" audience, but the
feature is useful without them.

**Independent Test**: fakes for the Cloudflare tunnel API; the gated live test runs a server whose
firewall blocks web traffic from the internet and serves the app through the tunnel.

**Acceptance Scenarios**:

1. **Given** a server with no public address (or the user says it is not reachable from the
   internet), **When** design runs, **Then** OpsCrew plans the tunnel and requires a domain on the
   user's Cloudflare account.
2. **Given** the tunnel plan is approved, **When** it is applied, **Then** the app answers over
   HTTPS on the domain, the server's firewall allows no inbound web traffic, and the tunnel's
   secret exists only on the server and in the deploy secrets.
3. **Given** a merged change, **When** the deploy runs, **Then** it reaches the server without any
   inbound port being opened, and a failed deploy rolls back as on other servers.

---

### User Story 4 - Day 2 and teardown on my own server (Priority: P2)

**Why this priority**: the server outlives the app; the user must be able to check it and remove
the app cleanly.

**Independent Test**: fake hosts with drifted settings; destroy against a fake host checks exactly
what is removed.

**Acceptance Scenarios**:

1. **Given** someone changed the SSH settings, the firewall rules or OpsCrew's runtime files on the
   server, **When** the user runs `opscrew drift`, **Then** OpsCrew reports exactly those
   differences (there are no cloud resources to compare).
2. **Given** a deployed app, **When** the user runs `opscrew destroy`, **Then** OpsCrew removes only
   what it set up for the app (its containers, runtime files, deploy workflow and secrets, and the
   DNS records or tunnel it created), never deletes or reinstalls the server, and deletes the app's
   data only after an explicit approval for data loss and a typed confirmation of the app's name.
3. **Given** the user also wants OpsCrew's host changes undone, **When** they ask for it, **Then**
   OpsCrew shows and, after approval, reverses its host changes (deploy user, its SSH and firewall
   settings, its runtime) and leaves anything it did not install alone.
4. **Given** an own server, **When** design, the runbook or destroy run, **Then** they say plainly
   that OpsCrew cannot turn on backups or snapshots there and that backups are the user's
   responsibility.

---

### User Story 5 - Portainer when I want it (Priority: P3)

The user can turn on Portainer CE for a project on any server OpsCrew deploys to (their own,
Hetzner or DigitalOcean) to see and manage their containers in a web UI.

**Why this priority**: a convenience many self-hosters expect, but not needed to deploy.

**Independent Test**: rendering and planning with fakes; the live test enables it and checks it is
not reachable from the internet but works through the printed tunnel command.

**Acceptance Scenarios**:

1. **Given** a project, **When** the user does nothing, **Then** Portainer is not installed.
2. **Given** the user enables Portainer, **When** the change is approved and applied, **Then**
   Portainer runs a pinned version, listens only on the server itself, and OpsCrew prints the SSH
   tunnel command and the local address to open; nothing about Portainer is reachable from the
   internet.
3. **Given** Portainer is enabled, **When** it starts for the first time, **Then** its admin account
   already has a password OpsCrew generated (so nobody else can claim the instance), and that
   password is kept only in OpsCrew's local state and shown only when the user asks for it.
4. **Given** the user explicitly opts in to a subdomain, **When** it is applied, **Then** Portainer
   is served on that subdomain of their Cloudflare domain behind Cloudflare Access, which lets in
   only the email addresses the user listed, in addition to Portainer's own login.
5. **Given** Portainer is enabled, **When** the user turns it off, **Then** OpsCrew removes it, and
   its stored data only after a typed confirmation.

### Edge Cases

- The SSH key is protected by a passphrase or only in an SSH agent: OpsCrew uses the agent and
  never asks for or stores the passphrase.
- The sudo user needs a password: OpsCrew stops and explains how to allow passwordless sudo for that
  user (password-based sudo is not supported in this feature).
- SSH listens on a non-standard port: the firewall keeps that port open, never port 22 by
  assumption.
- The server's architecture is arm64 (Raspberry Pi, Ampere): the app image is built for it.
- The server's Docker is older than the version that keeps local-only ports truly local: OpsCrew
  plans an upgrade from Docker's repository and says why, or stops if Docker was installed some
  other way.
- The connection drops while changes are being applied: the next run picks up where it stopped,
  showing only what is still missing.
- A second OpsCrew app is pointed at a server that already runs one: OpsCrew refuses and says that
  sharing a server between apps comes with a later feature.
- The server reboots during setup (kernel update): OpsCrew waits for it and continues.
- The address is a hostname, not an IP: it is kept in local state like an IP, never in committed
  files.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-901**: The interview and design MUST offer "a server you already have" as a target next to
  Hetzner Cloud and DigitalOcean, asking for the address, SSH port, SSH user and SSH key (a path or
  the SSH agent); OpsCrew MUST never ask for, store or log a password, passphrase or private key.
- **FR-902**: The server's address MUST be kept only in local state, as for OpsCrew-created servers
  (FR-809): never in `opscrew/plan.yaml`, pull requests, commit messages or committed reports.
- **FR-903**: On first connection OpsCrew MUST show the host key fingerprint and require
  confirmation (or an explicit fingerprint in non-interactive mode), pin it, and refuse to continue
  when a later connection presents a different key.
- **FR-904**: Before any change OpsCrew MUST inspect the server: operating system and version
  (supported: the Ubuntu LTS and Debian stable releases Docker supports), architecture, free memory
  and disk, root or passwordless sudo, the active SSH settings and port, listeners on ports 80 and
  443, existing web servers and containers, the firewall in use, and how Docker is installed.
- **FR-905**: Host changes MUST follow the safety gate: a plan listing each change and what is
  already in place, policy checks, approval bound to the plan's SHA-256 hash, then apply; applying
  a plan whose hash differs from the approved one MUST be refused; every change MUST be written to
  the audit log; re-running MUST be idempotent and show only what would change.
- **FR-906**: OpsCrew MUST install Docker Engine and the Compose plugin from Docker's official
  repository (or keep a compatible existing install from it), at a version that keeps
  local-only ports local, and MUST NOT proceed on Docker from Snap, Podman or a distribution
  package it cannot upgrade, explaining what to do instead.
- **FR-907**: OpsCrew MUST create the non-root deploy user with the deploy key and harden SSH (no
  password logins; no root login unless the user connects as root, in which case root keeps
  key-only access), proving the deploy user's and the user's own key logins work before keeping
  any SSH change and restoring the previous setting otherwise.
- **FR-908**: OpsCrew MUST set up the host firewall to allow only the SSH port in use and, when the
  server serves the web directly, HTTP and HTTPS, adding the SSH rule before enabling it; only the
  reverse proxy (or the tunnel connector) may publish ports, every other container port MUST be
  bound to the server itself; servers that use another firewall MUST NOT get a second one.
- **FR-909**: OpsCrew MUST turn on automatic security updates and set up the same app runtime it
  uses on its own servers (Compose, the reverse proxy with automatic TLS), so deploys, the release
  command, health checks, rollback, `verify` and `secure` behave the same.
- **FR-910**: For a server without a public address OpsCrew MUST serve the app through a Cloudflare
  Tunnel on the user's Cloudflare domain with no inbound web ports, create and remove the tunnel
  and its DNS record through its Cloudflare adapter behind the safety gate, keep the tunnel's
  secret out of committed files, prompts and logs, and still deploy automatically after a merge.
  By default the same tunnel MUST serve every own server whose site is behind Cloudflare's proxy,
  also one with a public address. As the user's explicit choice, a server with a public address MAY
  instead serve directly behind Cloudflare's proxy with a host filter that lets only Cloudflare's
  addresses reach 80/443; because Docker-published ports bypass the host firewall, that filter MUST
  sit in Docker's own `DOCKER-USER` chain and MUST fail closed (Docker does not start without it).
  Serving directly without the filter is DNS only, never proxied, and the server answers on 80/443
  to everyone (founder, 2026-10-14).
- **FR-911**: `opscrew drift` on an own server MUST compare the server's state with what OpsCrew set
  up (SSH settings, firewall rules, deploy user, runtime files and containers) and report every
  difference.
- **FR-912**: `opscrew destroy` on an own server MUST remove only what OpsCrew set up for the app,
  MUST NEVER delete, rebuild or reinstall the server, MUST delete app data only with the
  destroy approval and a typed confirmation of the app's name, and MUST offer to reverse OpsCrew's
  host changes as a separate, approved step.
- **FR-913**: Design, the runbook and destroy MUST say that OpsCrew cannot enable backups or
  snapshots on the user's own server and that backups are the user's responsibility; design MUST
  show no server price and MUST warn when the server is smaller than the app needs.
- **FR-914**: Portainer CE MUST be off by default and enabled per project; when enabled it MUST run
  a pinned version on any target, listen only on the server itself, have its admin password set at
  first start from a password OpsCrew generates and keeps only in local state, and OpsCrew MUST
  print the SSH tunnel command to reach it.
- **FR-915**: Serving Portainer on a subdomain MUST be an explicit opt-in that puts it behind
  Cloudflare Access allowing only the email addresses the user lists (Portainer's own login stays
  in place); OpsCrew MUST set up and remove the Access application through its Cloudflare adapter
  behind the safety gate.
- **FR-916**: Turning Portainer off MUST remove it and delete its data only after a typed
  confirmation; the Portainer password MUST never appear in the repository, the plan, prompts,
  logs, audit entries or reports.
- **FR-917**: The MCP server and the Claude Code plugin MUST offer the same choices and enforce the
  same approvals as the CLI.

### Key Entities

- **Own-server target**: where the app runs when it is not an OpsCrew-created server: the address
  (local state only), SSH port and user, the key to use (a path or the agent), the pinned host key
  fingerprint, whether the server is reachable from the internet, and the facts found by
  inspection (OS, architecture, resources, conflicts).
- **Host plan**: the list of host changes OpsCrew would make, each marked as already in place or to
  be changed, with the SHA-256 hash the approval is bound to.
- **Host setup record**: what OpsCrew installed or changed on the server and the previous values it
  replaced, used by drift, destroy and undo.
- **Tunnel**: the Cloudflare Tunnel and DNS route OpsCrew created for a server without a public
  address.
- **Portainer settings**: enabled or not, the pinned version, local-only or subdomain behind
  Access with its allowed emails; the admin password lives only in local state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-901**: A user with an existing Ubuntu or Debian server deploys an example app with a custom
  domain in under 20 minutes from `opscrew init` (gated live test on a real server).
- **SC-902**: Re-running provision on a prepared server shows no changes and changes nothing (100%
  of re-runs in tests).
- **SC-903**: In every test scenario, the user's own SSH login works after setup and after destroy
  (zero lockouts).
- **SC-904**: On a server already serving web traffic or using another firewall, OpsCrew makes no
  change and names the conflict (every conflict scenario in tests).
- **SC-905**: An app on a server whose firewall blocks inbound web traffic is served over HTTPS
  through the tunnel, and a merged change deploys automatically (gated live test).
- **SC-906**: After destroy, the server is reachable, every file, user and container OpsCrew did
  not create is unchanged, and nothing of the app remains (tests compare before and after).
- **SC-907**: With Portainer enabled in the default mode, nothing answers on Portainer's ports from
  the internet, the UI works through the printed tunnel command, and its password appears in no
  committed file, log or audit entry (gated live test and secret scan).

## Assumptions

- Supported servers: the Ubuntu LTS and Debian stable releases Docker Engine supports (today Ubuntu
  22.04, 24.04 and 26.04, Debian 12 and 13), on amd64 or arm64, with systemd, reachable over SSH
  with a key, as root or a user with passwordless sudo.
- A domain on Cloudflare is required for servers without a public address and for the Portainer
  subdomain; servers with a public address can use any DNS, as today.
- How deploys reach a server without inbound ports (through the tunnel, or pulled by the server) is
  decided in the plan; the requirement is only that they happen automatically and safely.
- Moving an app between an own server and Hetzner or DigitalOcean (`retarget`) is out of scope.
- Portainer Business Edition, Portainer agents for other servers and Edge features are out of
  scope.
- Constitution: the provider order and the hash-bound apply (Principle I) are amended in the plan
  to cover servers the user owns and host plans applied by OpsCrew's host adapter.
- One OpsCrew app per server in this feature (founder, 2026-10-14): pointing a second OpsCrew app at
  a server that already runs one is refused with a plain message; sharing a server between apps
  comes with the component model (feature 012).
