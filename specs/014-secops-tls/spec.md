# Feature Specification: SecOps and TLS: only Cloudflare reaches the origin, recoverable secrets, deeper checks, a choice of proxy

**Feature Branch**: `main` (feature directory `specs/014-secops-tls`)
**Created**: 2026-10-21
**Status**: Draft
**Input**: Founder decisions of 2026-10-13, confirmed and amended on 2026-10-21:
- SOPS + age for the secrets copy, committed in the repository and optionally copied to a folder;
- Caddy with the user's own additions, and nginx + certbot as a managed alternative.

Also the research of 2026-10-21 (`research.md`).

## Why

An app OpsCrew deploys is reasonably hardened today:
- a firewall, key-only SSH, automatic updates;
- the origin limited to Cloudflare's address ranges when proxied;
- Full (strict) TLS;
- OpsCrew's probe-blocking rule.

Five gaps remain:
- **Any Cloudflare customer can reach the origin.** The firewall accepts every request from Cloudflare's address ranges, so someone else's Cloudflare zone pointed at the server's address gets through.
- **Losing the laptop loses the app's secrets.** Database passwords and service keys OpsCrew generated live in one local file and in GitHub's write-only secrets, so a new machine cannot recover them without resetting every database.
- **No deeper check exists.** `opscrew secure` checks what OpsCrew set up. It does not audit the server as a whole, the SSH algorithms, or the TLS a visitor actually sees.
- **TLS is left at defaults.** No CAA records limit which certificate authorities may issue for the app's names, and the Cloudflare zone still accepts TLS 1.0 and 1.1.
- **One proxy for everyone.** Users cannot add their own proxy rules (headers, redirects, rate limits), and those who run nginx everywhere else cannot use it.

Valkey also still runs without a password, unlike Redis 8 and Dragonfly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only my Cloudflare account can reach my app (Priority: P1)

When an app's hostnames are proxied by Cloudflare, the server accepts connections for them only from Cloudflare acting for the user's own zone. It serves a certificate only Cloudflare trusts, and it requires a client certificate that only the user's zone sends.

**Why this priority**: it closes the main way around Cloudflare's protections (the WAF, OpsCrew's probe-blocking rule, rate limits). Today anyone with a Cloudflare account can reach the origin directly.

**Independent Test**: deploy an app with a proxied domain. Then check three things:
- the site works through Cloudflare;
- a TLS connection to the server's address for the app's hostname, without the client certificate, is refused;
- the certificate the origin serves is a Cloudflare origin certificate for exactly the app's hostnames.

**Acceptance Scenarios**:

1. **Given** an app with proxied hostnames on Hetzner, DigitalOcean or the user's own server, **When** it is provisioned, **Then** the origin serves a Cloudflare origin certificate covering exactly those hostnames. The certificate's private key never leaves the user's machine and the server.
2. **Given** the same app, **When** it is provisioned, **Then** Cloudflare sends a client certificate of the app's own to those hostnames, and the origin refuses any connection to them without it. Cloudflare's shared certificate, which any customer can send, is never relied on.
3. **Given** a site that is live, **When** these protections are first turned on or later removed, **Then** no request fails in between. Cloudflare sends the client certificate before the origin requires it, and the origin stops requiring it before Cloudflare stops sending it.
4. **Given** a connection to the server for a hostname it does not serve, **When** it arrives, **Then** it is refused.
5. **Given** a Cloudflare token without the certificate permissions, **When** the user provisions, **Then** OpsCrew says which permission to add. Until it is added, the app keeps today's protection (Cloudflare's address ranges only), and `opscrew secure` lists the gap.
6. **Given** a hostname served through a Cloudflare Tunnel, **When** it is provisioned, **Then** none of this is added, because the server has no public origin for it.
7. **Given** the origin certificate nears its expiry, **When** the user runs `status`, `secure` or `provision`, **Then** OpsCrew warns at least 30 days ahead, and `provision` replaces it with no downtime.
8. **Given** the app is destroyed, **When** the teardown runs, **Then** its origin certificate is revoked and its client certificate and per-hostname settings are removed. Other apps in the zone, and the user's own settings, are untouched.

---

### User Story 2 - My app's secrets survive losing my laptop (Priority: P1)

OpsCrew keeps an encrypted copy of every secret it generated for the app, together with what it needs to manage the deployment from another machine (the infrastructure state, the deploy key, its records). The copy is committed in the app's repository, and optionally saved to a folder the user picks. Only a key the user keeps can open it. On a new machine the user restores everything with that key, and the app keeps its databases and services as they are.

**Why this priority**: losing these secrets means resetting every database password and redeploying, and data is lost if the user resets the wrong thing. It is the most damaging thing that can happen to a working deployment that has no fault.

**Independent Test**:
1. Provision an app with a database and a broker.
2. Delete OpsCrew's local data for the project.
3. On a fresh clone, restore with the key, then provision again.
4. Check that nothing is regenerated and the data is intact.

**Acceptance Scenarios**:

1. **Given** the first provision that generates secrets, **When** it runs, **Then** OpsCrew creates the user's key (or uses one they already have). It hands the key over once, as a private file at a path the user picks, with advice to move it into a password manager and delete the file. It also offers to add a second, offline backup key. The key is never printed.
2. **Given** generated secrets or infrastructure state, **When** they are created or change, **Then** the encrypted copy in the repository is updated in the next change set that OpsCrew proposes. It is also written at once to the user's chosen folder, if they named one, and `status` says when the repository's copy is behind.
3. **Given** a public repository, **When** the copy would first be committed, **Then** OpsCrew warns that anyone can keep the encrypted file and read the names of the files it holds, though not their contents, and asks before committing.
4. **Given** a new machine with the repository and the key, **When** the user restores, **Then** OpsCrew rebuilds its local secrets from the copy, and the next provision reuses them unchanged.
5. **Given** no key, or the wrong key, **When** the user restores, **Then** OpsCrew stops, says the copy cannot be opened without the key, and changes nothing.
6. **Given** the user wants a new key, **When** they rotate, **Then** the copy is re-encrypted to the new key. OpsCrew says that older commits stay readable with the old key, and that the secrets themselves need changing if the old key leaked.
7. **Given** the encryption tool is not installed, **When** OpsCrew needs it, **Then** OpsCrew fetches a pinned, checksum-verified version itself. The user installs nothing.

---

### User Story 3 - A deeper security check when I want one (Priority: P2)

Besides its own checks, `opscrew secure` can run three well-known auditing tools:
- a full audit of the server;
- an audit of its SSH configuration;
- an audit of the TLS a visitor sees.

The findings are ranked like OpsCrew's own, with the known noise set apart.

**Why this priority**: it gives a second, independent opinion on the server, using tools that auditors recognise, at no cost and without changing anything.

**Independent Test**: run the deeper check on a deployed app. Check that:
- the report lists each tool's findings with a severity and what to do;
- known noise is listed separately and explained;
- the server's files are the same before and after, apart from logs.

**Acceptance Scenarios**:

1. **Given** a deployed app on a server, **When** the user asks for the deeper check, **Then** the server audit, the SSH audit and the TLS audit run, and their findings appear in the security report with severities.
2. **Given** the server audit, **When** it runs, **Then** it changes nothing on the server, and it removes its own temporary files afterwards.
3. **Given** a proxied app, **When** the TLS audit runs, **Then** it tests what visitors see at Cloudflare and says so. The origin's certificate and client-certificate requirement are checked separately, from the server itself.
4. **Given** the user's machine cannot run the outside audits (no container runtime), **When** the deeper check runs, **Then** those two are skipped with how to enable them, and the server audit still runs.
5. **Given** a Portainer target, **When** the deeper check runs, **Then** only the TLS audit runs, and the report says why the others are not possible.
6. **Given** findings OpsCrew can fix, such as an SSH option, **When** the report is written, **Then** it names the change, and the change happens only through OpsCrew's approved plans, never automatically.
7. **Given** the deeper check is not requested, **When** `opscrew secure` runs, **Then** it behaves as today and takes no longer.

---

### User Story 4 - Only the authorities I use can issue certificates, and old TLS is off (Priority: P2)

OpsCrew publishes CAA records that name the certificate authorities for the app's hostnames that get their certificates on the server. It also turns off TLS 1.0 and 1.1 at the Cloudflare edge when the zone holds only OpsCrew apps.

**Why this priority**: both are cheap protections that auditors and scanners look for. They must never get in the way of the user's other sites in the same zone.

**Independent Test**: deploy a DNS-only app and a proxied app in a zone that holds only OpsCrew apps. Check that:
- each DNS-only hostname has CAA records naming the authorities its certificates come from;
- the zone's apex and other names are untouched;
- the edge refuses TLS 1.1.

Then repeat in a zone with a non-OpsCrew proxied site, where the minimum TLS version is only reported.

**Acceptance Scenarios**:

1. **Given** a hostname whose certificate comes from the server's proxy, **When** it is provisioned, **Then** CAA records at that hostname name only the authorities that proxy uses.
2. **Given** existing CAA records at the zone's apex or at names OpsCrew does not own, **When** OpsCrew provisions, **Then** they stay untouched. A CAA record of the user's at one of the app's own hostnames is reported, not replaced.
3. **Given** a zone whose proxied hostnames all belong to OpsCrew apps, and whose minimum TLS version is still the default, **When** the app is provisioned, **Then** the zone's minimum becomes TLS 1.2, recorded as set by OpsCrew.
4. **Given** a zone with other proxied sites, or a minimum TLS version someone changed, **When** the app is provisioned, **Then** OpsCrew changes nothing and the security report advises the change.
5. **Given** the app is destroyed, **When** the teardown runs, **Then** its CAA records go. The zone's minimum TLS version stays, because raising it harms no one.

---

### User Story 5 - I choose my reverse proxy and add my own rules (Priority: P2)

The proxy in front of the apps on a server is Caddy by default, or nginx if the user chooses it. Either way, the user can add their own rules per app: headers, redirects, rate limits, basic authentication. OpsCrew checks them before they go live. With nginx, certificates are obtained and renewed automatically, with no action from the user.

**Why this priority**: users with existing proxy setups and habits can bring them over. Additions let everyone tailor their app's front door without leaving OpsCrew.

**Independent Test**: deploy two apps on one server with nginx, one DNS-only and one proxied. Add a header in the user's own additions. Then check that:
- both sites work, with the same TLS and header protections as with Caddy;
- the header is served;
- an invalid addition is refused before any change;
- a simulated renewal replaces the DNS-only app's certificate and reloads nginx with no failed request.

**Acceptance Scenarios**:

1. **Given** a new server, **When** the user chooses nginx in the plan, **Then** the server's apps are served by nginx. Visitors see the same protections as with Caddy: TLS 1.2 and newer only, the same security headers, no version leak, WebSockets, long requests and large uploads working, and a redirect to HTTPS.
2. **Given** nginx and a DNS-only hostname, **When** the app is first deployed, **Then** its certificate is obtained during the deploy, and it is renewed automatically before expiry. nginx reloads without dropping connections, and the user does nothing.
3. **Given** nginx and a proxied hostname, **When** the app is deployed, **Then** it uses the Cloudflare origin certificate (User Story 1), not a public authority's.
4. **Given** a renewal that keeps failing, **When** the user runs `verify`, `status` or `secure`, **Then** OpsCrew warns while there are at least 30 days left, with the reason.
5. **Given** the user's own additions for an app, **When** they provision, **Then** OpsCrew validates them with the proxy's own checker and scans them with its rules before any change. Invalid or unsafe additions are refused with the reason, and the live configuration stays as it was. Unsafe means, for example, older TLS, an exposed admin interface, traffic sent elsewhere, or another app's hostnames.
6. **Given** several apps on one server, **When** one app asks for a different proxy than the server runs, **Then** OpsCrew refuses before any change. It says that the proxy is shared by every app on the server, and that a server's proxy can be switched while it holds only one OpsCrew app.
7. **Given** a server with one OpsCrew app, **When** the user switches its proxy and provisions, **Then** the plan shows the switch, and the switch causes at most a short, stated interruption.

---

### User Story 6 - Every database and cache has a password (Priority: P3)

Valkey now requires a password, like Redis 8 and Dragonfly already do. The app receives it in its connection address.

**Why this priority**: it is defence in depth. Valkey is reachable only from the app's own containers, but a password stops anything else that ends up on that network.

**Independent Test**: deploy the Valkey queue example. Check that a connection without the password is refused and the app's jobs still run.

**Acceptance Scenarios**:

1. **Given** an app with Valkey, **When** it is provisioned, **Then** Valkey requires a generated password, and the app's address variables include it.
2. **Given** an app deployed before this change, **When** it is provisioned again, **Then** Valkey gets its password, and its data and queued jobs are kept.
3. **Given** `opscrew secure`, **When** it checks the services, **Then** it confirms that Valkey refuses a connection without the password.

---

### Edge Cases

- **Several apps in one zone:** every Cloudflare change is per hostname, and other apps' and the user's own settings are never changed. Zone-wide settings follow feature 011's rule: read first, and never overwrite what someone else set.
- **A hostname switched between proxied and DNS-only:**
  - to DNS-only: a public certificate is obtained and the client-certificate requirement dropped first, while the hostname stays proxied, and the next run switches the record. OpsCrew says that this takes two runs;
  - to proxied: the reverse, in an order that never breaks the site.
- **The Cloudflare certificate API is unavailable or rate-limited** mid-provision: no half state goes live. The origin keeps its previous certificate, and the run says to retry.
- **The secrets copy and the local secrets differ**, for example after a restore from an older commit: OpsCrew stops and shows which secrets differ, by name only, and never silently overwrites either side.
- **A repository that becomes public** after the copy was committed: `secure` warns.
- **The user's backup key is lost too:** OpsCrew says the copy cannot be opened. The secrets can still be reset through the normal flows, at the cost of resetting the services.
- **The deeper check on a server where the user's IP is blocked** by fail2ban or a firewall: the run says so instead of reporting a false pass.
- **nginx with a hostname whose DNS does not yet point to the server:** the first certificate cannot be obtained, so the deploy says why and keeps the site on plain HTTP until the next run. This mirrors Caddy.
- **A certificate authority rate limit** (repeated failed deploys): the message names the limit and when to retry.
- **A Portainer target:** its stack's proxy gets the origin certificate and client-certificate requirement when OpsCrew runs that proxy. It does not when the user's own proxy fronts the stack, and the report says so.

## Requirements *(mandatory)*

### Functional Requirements

**Only Cloudflare reaches the origin**

- **FR-1401**: For each proxied hostname of an app whose proxy OpsCrew runs (servers and Portainer stacks), the origin MUST serve a Cloudflare origin certificate covering exactly the app's proxied hostnames. The certificate is valid for 15 years, Cloudflare's longest, so the site keeps working if the user stops using OpsCrew. Its private key is generated on the user's machine and kept only there and on the server.
- **FR-1402**: For each such hostname, Cloudflare MUST present a client certificate of the app's own, and the origin MUST refuse TLS connections for that hostname without it. Zone-wide and Cloudflare-shared client certificates are never used.
- **FR-1403**: Turning these protections on, renewing them and removing them MUST cause no failed request. Cloudflare sends before the origin requires, and the origin stops requiring before Cloudflare stops sending.
- **FR-1404**: The origin MUST refuse connections for hostnames it does not serve.
- **FR-1405**: Without the needed Cloudflare token permissions, provision MUST name the permissions to add, keep the existing protection, and record the gap for `secure`. It never fails the whole deploy for this.
- **FR-1406**: OpsCrew MUST track each origin and client certificate's expiry, warn at least 30 days ahead in `status`, `secure` and `provision`, and replace them through provision without downtime.
- **FR-1407**: Destroy MUST revoke the app's origin certificate and remove its client certificate and per-hostname settings, and leave everything else in the zone alone.
- **FR-1408**: Drift MUST report a client-certificate requirement turned off, or a certificate removed, outside OpsCrew.
- **FR-1409**: Hostnames served through a tunnel MUST get none of this.

**The encrypted secrets copy**

- **FR-1410**: OpsCrew MUST keep an encrypted copy of everything it keeps on the user's machine for the app and cannot rebuild:
  - the secrets it generates (service passwords and keys, route-job secrets);
  - the deploy key;
  - the infrastructure state and its passphrase;
  - its records of the server and of the app's Cloudflare settings.

  The copy is updated whenever one of them changes. Without the state, a new machine could not manage the existing deployment.
- **FR-1411**: The copy MUST be encrypted with SOPS to the user's age key or keys. It is committed in the app's repository through OpsCrew's existing change flow, and also written to a folder of the user's choice when they name one.
- **FR-1412**: OpsCrew MUST create the user's key on first use, or accept one the user provides. It hands the key over once, as a private file at a path the user picks, with storage advice, and never prints it. It supports a second backup key. The key never appears in the repository, a plan, a log, a prompt or OpsCrew's own state.
- **FR-1413**: `restore` MUST rebuild OpsCrew's local secrets from the copy given the key, and the next provision MUST reuse them unchanged. Without a working key it stops and changes nothing.
- **FR-1414**: Key rotation MUST re-encrypt the copy to the new key. It explains that older commits stay readable with the old key, and when to change the secrets themselves.
- **FR-1415**: Before the first commit to a public repository, OpsCrew MUST warn and ask for confirmation. The warning says that anyone can keep a copy of the encrypted file, and that the names of the files it holds are readable.
- **FR-1416**: OpsCrew MUST obtain the encryption tool itself, at a pinned version verified by checksum. The user installs nothing. If it cannot be obtained, OpsCrew says how to proceed and leaves the local secrets as they are.
- **FR-1417**: When the copy and the local secrets disagree, OpsCrew MUST stop and show the differing names, never values. Neither side is overwritten without the user's choice.

**Deeper checks**

- **FR-1420**: `opscrew secure` MUST offer an opt-in deeper check:
  - a full audit of the server;
  - an audit of its SSH service;
  - an audit of the TLS of its public endpoints.

  Each tool is pinned to a version and verified.
- **FR-1421**: The deeper check MUST change nothing on the server, apart from temporary files it removes afterwards. It never applies fixes. A fix OpsCrew can make is proposed as a change through its approved plans.
- **FR-1422**: Findings MUST appear in the security report with OpsCrew's severities and what to do. Known noise, documented per tool, is listed separately with the reason.
- **FR-1423**: For proxied hostnames, the TLS audit MUST be reported as Cloudflare's edge. The origin's certificate and client-certificate requirement MUST be verified from the server itself.
- **FR-1424**: When the user's machine cannot run an outside audit, it MUST be skipped with instructions while the rest runs. On a Portainer target, only the TLS audit runs, and the report says why.
- **FR-1425**: Without the deeper check, `opscrew secure` MUST behave and take as long as today.

**CAA and minimum TLS**

- **FR-1430**: For each hostname whose certificate comes from the server's proxy, OpsCrew MUST publish CAA records at that hostname naming only the authorities that proxy uses. It never publishes CAA at the zone apex or at names it does not own.
- **FR-1431**: Existing CAA records that are not OpsCrew's MUST be left unchanged, and they are reported if they conflict.
- **FR-1432**: OpsCrew MUST set the zone's minimum TLS version to 1.2 only when it is still the default and every proxied hostname in the zone belongs to an OpsCrew app. It records that OpsCrew set it. Otherwise `secure` advises it, and OpsCrew never lowers it.
- **FR-1433**: Destroy MUST remove the app's CAA records and leave the zone's minimum TLS version as it is.

**The reverse proxy**

- **FR-1440**: A server's proxy MUST be chosen in the plan: Caddy (the default) or nginx. Every app on one server uses the same proxy, and a conflicting choice is refused before any change, with the reason.
- **FR-1441**: With nginx, certificates for hostnames that are not proxied MUST be obtained during the first deploy and renewed automatically before expiry, with a reload that drops no connections and no action from the user.
- **FR-1442**: Both proxies MUST give visitors the same protections:
  - TLS 1.2 and newer;
  - the same security headers, with HSTS and a baseline set added to Caddy's too;
  - no version disclosure;
  - a redirect to HTTPS;
  - WebSockets, long requests and large uploads working;
  - a refusal for unknown hostnames.
- **FR-1443**: The user's own additions per app MUST be validated with the proxy's own checker and scanned with OpsCrew's rules before any change. Unsafe additions are refused with the reason, and the live configuration stays as it was. Unsafe means older TLS, an exposed admin interface, traffic sent somewhere other than the app, or another app's hostnames.
- **FR-1444**: Switching a server's proxy MUST be a planned, approved change, with at most a short interruption that the plan states. In v1 it is offered while the server holds only one OpsCrew app. With several, OpsCrew refuses and says why (switching several apps at once is later work).
- **FR-1445**: A certificate renewal that keeps failing MUST be reported by `verify`, `status` and `secure`, with the reason, while at least 30 days remain.

**Valkey**

- **FR-1450**: Valkey MUST require a generated password. The app's address variables carry it, an existing deployment gets it on its next provision with its data kept, and `secure` verifies that a connection without it is refused.

**Throughout**

- **FR-1460**: Every change on servers, at Cloudflare and in the repository MUST go through OpsCrew's plans approved by their hash.
- **FR-1461**: No private key, client key, age key or secret value MUST appear in a plan, a log, a prompt, an audit entry, a report or infrastructure state. Only the encrypted copy is committed.
- **FR-1462**: `status` MUST show each certificate's expiry, the server's proxy, and when the secrets copy was last updated with how many keys can open it.
- **FR-1463**: The user guide MUST explain each part for users: origin protection, the secrets copy (restore and rotation), the deeper checks, CAA and minimum TLS, the proxy choice and additions.

### Key Entities

- **Origin certificate:** per app, covering its proxied hostnames. It has an expiry, and its private key is local and on the server.
- **Client certificate (origin pulls):** per app. Uploaded to Cloudflare and enabled per hostname, and trusted by the origin.
- **Secrets copy** (the "recovery copy" in the plan): the encrypted file in the repository, and the optional folder copy. It holds the files of FR-1410, and has its recipients (the user's key and an optional backup key) and when it was last updated.
- **Age key:** held only by the user, shown once.
- **Deeper-check result:** per tool, with its version, findings, severities and noise.
- **Proxy choice:** per server, `caddy` or `nginx`.
- **User additions:** a file per app in the repository, in the chosen proxy's syntax.
- **Zone settings record:** what OpsCrew set in a zone (the minimum TLS version) and when, so it is never mistaken for someone else's setting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1401**: For a proxied app, 100% of direct TLS connections to the origin without the app's client certificate are refused, while every request through Cloudflare succeeds.
- **SC-1402**: With only the repository and their key, a user restores on a new machine and redeploys in under 5 minutes, with no secret regenerated and no data lost.
- **SC-1403**: The deeper check finishes in under 5 minutes on the smallest supported server, and the server's files are unchanged afterwards, apart from logs.
- **SC-1404**: No certificate that OpsCrew manages expires unnoticed. A warning appears at least 30 days ahead, and nginx renewals succeed with zero user actions.
- **SC-1405**: In a zone shared with other apps and the user's own records, no OpsCrew change alters anything that is not the app's own: records, client certificates, settings.
- **SC-1406**: The leak search finds no private key, age key or secret value in any output, commit, plan, report, audit entry or state file.
- **SC-1407**: Through either proxy, the TLS audit of a deployed app reports no finding of high severity or above.
- **SC-1408**: Enabling, renewing or removing origin protection, or switching the proxy, causes no failed request under steady traffic, apart from the switch's stated interruption.

## Assumptions

- **What the copy holds:** what OpsCrew generates or records for the app (FR-1410). Values the user supplied (provider tokens, the app's own API keys, the storage key) are already the user's own and are not copied. History (approvals, costs, saved plans) is not copied either.
- **Certificate lifetimes:** origin and client certificates are issued for 15 years, so a deployment keeps working without OpsCrew (constitution II). `provision` replaces one when the app's proxied hostnames change, or when fewer than 30 days remain.
- **CAA for Caddy:** Caddy keeps its default authorities, with one fallback, and CAA names both. With nginx, only the authority certbot uses is named.
- **Portainer:** stacks get origin protection when OpsCrew's proxy runs in the stack. The proxy choice (nginx) applies to servers; Portainer stacks keep Caddy.
- **The deeper check's outside audits** run in containers on the user's machine. A machine without a container runtime runs only the server audit.
- **The Cloudflare token** needs the certificate permissions for User Story 1. The guide and `opscrew init` list them.
- **Out of scope:**
  - closing public SSH, which needs 015's runners or a later private link;
  - HSTS preload;
  - mutual TLS between the app's own services;
  - Apache and Traefik (only on request);
  - a WAF beyond feature 011's rules;
  - passwords for Kafka, Redpanda and OpenSearch, which comes with 017's split placement.
