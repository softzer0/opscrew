# Feature Specification: Shared hosting accounts (cPanel, Plesk, DirectAdmin, SFTP) and LiteSpeed

**Feature Branch**: `main` (feature directory `specs/027-shared-hosting`)
**Created**: 2026-11-12
**Status**: Draft
**Input**: The roadmap's "027 Shared hosting (cPanel, Plesk, DirectAdmin, SFTP) and LiteSpeed"
(founder, 2026-11-07: the three panels and SFTP in one feature, before AWS; 2026-11-10: LiteSpeed
on hosting accounts; 2026-11-11: OpenLiteSpeed as a third proxy on servers). The founder gave the
go-ahead on 2026-11-12. Research: [research.md](research.md).

## Why

Many apps live on hosting the user already pays for: a control panel, no root, no Docker. A
WordPress site, a Laravel app, a static site or a small Node.js app on a cPanel account is deployed
today by uploading files by hand, with no rollback, no checks and secrets often inside the web
root. OpsCrew can't reach such an account at all: every target it knows has a server it can
harden, or a platform with its own API (Cloudflare, GitHub Pages).

This feature adds a new kind of target, **a hosting account**, reached through the panel's API
(cPanel, Plesk, DirectAdmin) or through SFTP alone. OpsCrew sets up what the app needs in the
panel, deploys releases from GitHub Actions with an atomic switch, rolls back by switching back,
and checks the account's security, with every change in a plan approved by its hash.

Most shared hosts run LiteSpeed in place of Apache under the same panels (the founder's test
account does), so OpsCrew handles both. And since LiteSpeed's free edition, OpenLiteSpeed, suits
PHP and WordPress apps on servers too, it becomes a third proxy next to Caddy and nginx.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy a PHP app or a static site to a cPanel account (Priority: P1)

**Why this priority**: it is the feature's point, and cPanel is the panel most hosts run.

**Independent Test**: the live pass on the founder's cPanel account deploys `examples/laravel-app`
and a static site to `e2e-…` subdomains: interview, design, provision, deploy, verify, a second
release, rollback and destroy, with nothing outside the `e2e-…` objects touched.

**Acceptance Scenarios**:

1. **Given** the panel's address, the account's user and an API token in the environment, **When**
   the user runs `opscrew interview`, **Then** "a hosting account" is offered next to the other
   targets, and OpsCrew finds out which panel answers (cPanel, Plesk or DirectAdmin) without
   asking.
2. **When** the user runs `opscrew design`, **Then** the plan says what the account offers and what
   the app gets there:
   - the web server (Apache or LiteSpeed), the PHP versions, the database engine, the disk quota
     left and the app slots left;
   - the hostname and its document root, the database and its user, the cron jobs;
   - no price: the user already pays for the account.
3. **Given** an app that doesn't fit a hosting account (a long-running worker, Redis or a queue,
   WebSockets from PHP, anything that needs Docker), **Then** design refuses it with the reason
   and names a server target instead.
4. **When** the user runs `opscrew provision` and approves the plan by its hash, **Then** OpsCrew
   makes, through the panel's API:
   - the hostname (a subdomain or addon domain) with its document root on the release OpsCrew
     switches;
   - the database and its user, with a generated password kept as a deploy secret;
   - the cron jobs the app declares;
   - the free certificate (AutoSSL) for the hostname, or says why the panel can't issue it;
   - the deploy key GitHub Actions uploads with, and the GitHub secrets and workflow.
5. **When** a commit reaches the deploy branch, **Then** the workflow builds the app, uploads it to
   a new release folder, keeps the app's secrets outside the web root, runs the app's release
   steps (migrations), switches the hostname to the new release in one step, and checks that the
   app answers. A failed check switches back.
6. **When** the user runs `opscrew verify`, **Then** OpsCrew checks that the app answers over
   HTTPS, that plain HTTP redirects, and that the app's secrets and the release folders can't be
   read from the web.

### User Story 2 - Roll back and remove an app on a hosting account (Priority: P1)

**Why this priority**: a deploy without a way back is what the user has today.

**Independent Test**: in the live pass, `opscrew rollback` serves the previous release at once,
and `opscrew destroy` leaves the account as it was before provision.

**Acceptance Scenarios**:

1. **When** the user runs `opscrew rollback`, **Then** the hostname switches back to the previous
   release in one step, the page cache is emptied and PHP serves the old code, and the app
   answers. The database follows 019's rules (a snapshot before each release where the account
   allows a dump).
2. **When** the user runs `opscrew destroy`, **Then** its plan lists what OpsCrew made and nothing
   else: the release folders, the hostname, the cron jobs, the deploy key, and the database after
   an offered dump. The user types the hostname to approve it.
3. **Given** files, databases or domains on the account that OpsCrew didn't make (an existing
   WordPress in `public_html`, for example), **Then** no plan ever changes or deletes them.

### User Story 3 - Deploy to any host with SFTP (Priority: P1)

**Why this priority**: the plainest target; it reaches hosts with no panel API or a panel OpsCrew
doesn't know.

**Independent Test**: the live pass deploys a static site and a plain PHP app over SFTP to the
founder's account (it has SSH), switches and rolls back.

**Acceptance Scenarios**:

1. **Given** an SFTP host, user and key, **When** the user designs and provisions, **Then** the
   plan names what stays the user's (the hostname, its document root, the database and the
   certificate) and what OpsCrew does (release folders, the switch, the deploy key and workflow).
2. **When** a release is deployed or rolled back, **Then** the switch is atomic over SFTP alone,
   without a shell.

### User Story 4 - LiteSpeed on hosting accounts (Priority: P1)

**Why this priority**: most hosts serve accounts with LiteSpeed, the founder's included; a deploy
that leaves old pages cached or old PHP running looks broken.

**Independent Test**: the live pass on the founder's LiteSpeed-served account checks that a new
release's pages and PHP code answer right after the switch, and after a rollback.

**Acceptance Scenarios**:

1. **Then** design and provision say which web server serves the account.
2. **Then** the `.htaccess` rules OpsCrew writes (HTTPS forced, the web root, secrets out of
   reach) work the same on Apache and LiteSpeed.
3. **When** a release is switched or rolled back, **Then** LiteSpeed's page cache is emptied (the
   LiteSpeed Cache plugin's for WordPress) and PHP serves the new release at once, even where
   LiteSpeed's PHP processes keep running across the switch.

### User Story 5 - Node.js and Python apps the panel runs (Priority: P2)

**Why this priority**: small Node.js and Python apps are common on hosting accounts, but fewer than
PHP and static sites.

**Independent Test**: the live pass deploys `examples/express-api` through cPanel's Node.js
support, restarts it on a new release and rolls it back.

**Acceptance Scenarios**:

1. **Given** a Node.js or Python app and an account whose panel runs them (cPanel's Application
   Manager or CloudLinux's selectors, Plesk's Node.js), **Then** design picks the runtime version,
   provision registers the app, and each deploy and rollback restarts it on the new release.
2. **Given** an account whose app slots are used up, or a panel that runs no such apps, **Then**
   design says so and names a server target.

### User Story 6 - Security, drift and snapshots on a hosting account (Priority: P2)

**Why this priority**: the checks OpsCrew gives every other target.

**Independent Test**: the live pass runs `secure`, `drift`, `snapshot` and `restore` on the
deployed app.

**Acceptance Scenarios**:

1. **When** the user runs `opscrew secure`, **Then** the report covers the scan of the app, the PHP
   version (end of life or not), the app's secrets outside the web root, file permissions and
   HTTPS forced.
2. **When** the user runs `opscrew drift`, **Then** it reports what changed in the panel since
   provision: the hostname's document root, the database, the cron jobs, the deploy key.
3. **When** the user runs `opscrew snapshot`, **Then** OpsCrew takes a dump of the app's database
   and a copy of its files (the encrypted copy off the account as 024 does), and `opscrew restore`
   puts them back after the user's approval.

### User Story 7 - Plesk and DirectAdmin (Priority: P2)

**Why this priority**: the other two panels most hosts run; there is no test account yet.

**Independent Test**: fake Plesk and DirectAdmin APIs pass the same flows as cPanel's live pass.

**Acceptance Scenarios**:

1. **Given** a Plesk or DirectAdmin account and its credentials (Plesk: the customer's login or an
   API key; DirectAdmin: a login key), **Then** US1, US2, US4, US5 and US6 work as on cPanel, or
   say plainly which part the panel's API can't do and what OpsCrew does instead (SFTP) or what the
   user does in the panel.

### User Story 8 - OpenLiteSpeed as a third proxy on servers (Priority: P2)

**Why this priority**: it serves PHP and WordPress apps on servers with a page cache, but Caddy and
nginx already cover every app.

**Independent Test**: a live pass like nginx's on a server: the first certificate and a renewal
under load, an addition, the cache emptied by a deploy, origin TLS behind Cloudflare, two apps on
one server, and a switch to Caddy and back.

**Acceptance Scenarios**:

1. **Given** a plan with OpenLiteSpeed as the server's proxy, **Then** visitors get what Caddy and
   nginx give: TLS 1.2 and 1.3 only, the same security headers, WebSockets and long requests, and
   a refusal for hostnames the server doesn't serve. Its admin console is off.
2. **Then** certificates come from Cloudflare (origin certificates) behind Cloudflare's proxy, and
   from its own renewals for DNS-only hostnames, renewed without dropping connections.
3. **Then** its additions file is checked by OpsCrew's rules and by its own configuration check
   before any change, and each deploy and rollback empties its page cache.
4. **Then** everything the proxy choice reaches follows (the switch between proxies, previews,
   localhost, retarget, status, secure, own-server inspection); a Portainer stack keeps Caddy.

### User Story 9 - From Claude Code, and in the guide (Priority: P3)

**Acceptance Scenarios**:

1. **Then** the MCP tools and the plugin's skills offer hosting accounts and OpenLiteSpeed, and the
   guide has a page per kind of account (cPanel, Plesk, DirectAdmin, SFTP), LiteSpeed's notes and
   OpenLiteSpeed's on the proxy page.

### Edge Cases

- **A token without the features OpsCrew needs, or a host that turned the API, SSH or cron off**:
  OpsCrew names what is missing and what the user can do (create a token with those features, ask
  the host), before any change.
- **The account's disk quota or app slots are nearly full**: design shows what is left; provision
  and deploy stop before an upload that wouldn't fit.
- **A hostname that already exists with content OpsCrew didn't put there**: never taken over; the
  plan stops and names it.
- **The app needs a PHP version the account doesn't offer, or the panel can't set it** (no
  MultiPHP, a CloudLinux PHP Selector with no API): design names the version and where to set it
  in the panel; verify checks the version the app gets.
- **AutoSSL can't cover the hostname** (its DNS doesn't point at the host): provision says why, and
  the deploy waits for a certificate before forcing HTTPS.
- **The domain's DNS is on Cloudflare**: OpsCrew points the hostname at the account's address
  through its Cloudflare connector, as for other targets.
- **An upload that stops halfway**: the release is never switched to; the next deploy starts a new
  one, and old unfinished releases are removed.
- **PHP keeps serving the old release** (OPcache without timestamp checks, a long realpath cache):
  the switch makes PHP load the new release before the health check.
- **The host hides the `Server` header**: OpsCrew asks the account's PHP which server runs it.
- **The panel's credentials in the app's files or environment**: `opscrew scan` reports them as a
  leaked secret.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-2701**: A hosting account MUST be a target kind of its own, `hosting`, with the panel
  (`cpanel`, `plesk`, `directadmin`, `sftp`) in the plan. No server is created, priced or hardened
  for it.
- **FR-2702**: Each panel MUST have a typed connector that validates every answer with zod and
  reads the panel's own success flag (cPanel answers HTTP 200 for failures, research R1). Every
  change MUST go through a plan approved by its SHA-256 hash, as an own server's host plans do
  (ADR 0011).
- **FR-2703**: The panel's credentials MUST be read from the environment, redacted everywhere,
  used only on the user's computer, and never written to the plan, state, generated files or CI.
  The deploy key is the only credential GitHub Actions gets.
- **FR-2704**: Design MUST read the account's facts (web server, PHP versions, database engine,
  quota, app slots, SSH access) and refuse apps that don't fit, with the reason and a server target
  named.
- **FR-2705**: Provision MUST make only what the plan lists (hostname and document root, database
  and user, cron jobs, certificate, deploy key, GitHub secrets and workflow), mark what it made, and
  never change or delete anything it didn't make.
- **FR-2706**: Deploys MUST upload each release into its own folder and switch the hostname to it
  atomically, over SFTP when the panel's API can't (research R5), keep the app's secrets outside
  the web root, and switch back when the health check fails.
- **FR-2707**: Rollback MUST switch back to the previous release; destroy MUST remove only what
  OpsCrew made, after the offered dump and the typed hostname.
- **FR-2708**: OpsCrew MUST say which web server serves the account. On LiteSpeed it MUST empty
  the page cache and make PHP serve the new release on every switch and rollback.
- **FR-2709**: `.htaccess` rules OpsCrew writes MUST work on Apache and LiteSpeed alike (HTTPS
  forced, the web root, secrets and release folders refused).
- **FR-2710**: Node.js and Python apps MUST run through the panel's own app support where it
  exists, and restart on each switch and rollback.
- **FR-2711**: Verify, status, secure, drift, snapshot and restore MUST cover hosting accounts as
  US1 and US6 say; commands that need a server (logs from containers, monitoring, previews,
  retarget to or from a hosting account) MUST say plainly that they don't apply.
- **FR-2712**: An SFTP-only target MUST deploy static sites and PHP apps, with the hostname,
  database and certificate left to the user and named in the plan.
- **FR-2713**: Plesk and DirectAdmin MUST pass the same flows as cPanel against fakes built from
  their documented APIs, and say plainly what their customer-level API can't do.
- **FR-2714**: OpenLiteSpeed MUST be a third `target.edge` choice on servers, from LiteSpeed's
  official image, with the protections, certificates, additions check, cache purge and reach of
  US8. Caddy's and nginx's generated files MUST stay byte-identical.
- **FR-2715**: The MCP tools, the plugin skills and the guide MUST cover hosting accounts and
  OpenLiteSpeed (US9).

### Key Entities

- **Hosting account**: the panel kind, its address and user, the facts design read (web server,
  PHP versions, database engine, quota, app slots, SSH), and the objects OpsCrew made there, each
  marked as OpsCrew's.
- **Hosting plan**: the changes to the account, its SHA-256 hash and approval, as a host plan.
- **Release**: a folder per deploy with the app's files, the one the hostname points at, and the
  ones kept for rollback.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-2701**: The live pass on the founder's cPanel account completes interview, design,
  provision, deploy, verify, a second release, rollback, secure, drift, snapshot, restore and
  destroy for a Laravel app and a static site, each on an `e2e-…` subdomain.
- **SC-2702**: An inventory of the account (domains, databases, users, cron jobs, keys, files)
  before and after the live pass differs only in `e2e-…` objects, and none is left after destroy.
- **SC-2703**: On the LiteSpeed-served account, the first request after a switch or rollback
  answers with the new release, with no page from the old one.
- **SC-2704**: A scan of every output, log, audit entry and committed file of the live passes finds
  none of the panel's credentials or the deploy key.
- **SC-2705**: Fake Plesk and DirectAdmin APIs pass the same flows as the cPanel pass.
- **SC-2706**: OpenLiteSpeed's live pass on a server covers what nginx's did, and the example apps'
  generated files for Caddy and nginx are byte-identical before and after the feature.

## Assumptions

- The founder's cPanel account (`OPSCREW_E2E_CPANEL_*` in `.env.e2e`) is the live test account;
  every test object on it is named `e2e-…` (founder, 2026-11-07). It is served by LiteSpeed and has
  SSH. Apache-served accounts, Plesk and DirectAdmin are covered by fakes until accounts exist.
- The facts research R7 lists are settled by a spike on that account before the connectors are
  built.
- Not in scope:
  - WHM, reseller and server-admin access; email accounts; the panel's own backups;
  - WordPress installers (Softaculous) and managing WordPress itself beyond deploying it;
  - moving an app between a hosting account and a server (`retarget`);
  - LiteSpeed Enterprise on servers (it is paid).
