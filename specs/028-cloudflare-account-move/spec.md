# Feature Specification: Moving an app to another Cloudflare account

**Feature Branch**: `main` (feature directory `specs/028-cloudflare-account-move`)
**Created**: 2026-11-14
**Status**: Draft
**Input**: The founder, 2026-11-14: "is opscrew able to transfer from one cloudflare account to
another setup?", then "can you please implement that too". His decisions the same day: it ships
as 0.2.9; a zone serving several OpsCrew apps moves with all of them; the R2 buckets are copied to
the new account. Research: [research.md](research.md).

## Why

Users move between Cloudflare accounts: an agency hands a client's app over to the client's own
account, a founder moves from a personal account to the company's, a team consolidates two
accounts. Cloudflare moves nothing between accounts by itself (research R1): the domain is added
to the new account, every record and setting copied, the account's own pieces (Tunnels, Access,
Workers, R2 buckets) recreated, and the nameservers switched. Done by hand for an app OpsCrew set
up, that means reading OpsCrew's state files, recreating what they describe and editing secrets on
servers and in GitHub. Today swapping `CLOUDFLARE_API_TOKEN` for the new account's token breaks
the app's next provision, because its state points at the old account. OpsCrew's promise is that
the user owns everything and can leave anything; this makes it true for the Cloudflare account.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One app moves to the new account (Priority: P1)

A user's app runs on a server OpsCrew created (or on their own server through a Tunnel, or in
their Portainer), behind Cloudflare, in account A. They make account B (and a token for it), then
run the move from the app's repository: OpsCrew builds the app's pieces in B while A keeps
serving, switches the domain's nameservers to B, waits until B serves the app, and then removes
what is left in A.

**Why this priority**: it is the whole feature for the most common case, one app in its zone.

**Independent Test**: move one app on a cloud server with its records, rules and origin
protection, and one app on an own server reached through a Tunnel, each in its own zone, from A to
B; both answer from B, nothing of theirs is left in A, and visitors were never refused before the
switch.

**Acceptance Scenarios**:

1. **Given** an app deployed behind Cloudflare in account A and a token for account B, **When**
   the user starts the move, **Then** OpsCrew checks the token reaches B with the permissions the
   move needs, adds the domain to B as a new zone (pending), copies the zone's records that are not
   OpsCrew's and plans the app's pieces in B for every environment, each plan shown and applied
   only after the user approves its hash, while A keeps serving every request.
2. **Given** an app reached through a Tunnel, **When** its side in B is prepared, **Then** the
   server (or the Portainer stack) runs B's connector beside A's through a host or stack plan
   approved by hash, so either account's zone can reach the app.
3. **Given** every piece prepared, **When** the user approves the switch, **Then** OpsCrew switches
   the domain's nameservers to B's (at Porkbun, Namecheap or GoDaddy through their APIs), asks
   Cloudflare to check them, waits until B's zone is active and its certificate is live, and reports
   how long visitors had no valid certificate.
4. **Given** the switch done, **When** the user finishes the move, **Then** the app's deploy
   secrets in GitHub and the files on its server point at B, A's connector is removed, and A's
   pieces of the app are removed after an approval with `allowDestroy` and the app's name typed.
5. **Given** a move prepared but not switched, **When** the user aborts it, **Then** B's pieces of
   the app and B's zone are removed and A serves as before.

---

### User Story 2 - Every app in the zone moves (Priority: P1)

A zone serves several OpsCrew apps, each from its own repository (and each with its
environments). The zone moves once, so all of them must be ready in B first. The user prepares
each app from its repository, switches once from any of them, then finishes each.

**Why this priority**: the founder's decision; a user with several apps in one domain is common
(OpsCrew's several-apps support exists for it), and moving only one app would break the others.

**Independent Test**: two apps from two repositories in one zone (one on a cloud server, one on an
own server through a Tunnel) move from A to B; the switch refuses until both are prepared; both
answer from B after it.

**Acceptance Scenarios**:

1. **Given** a zone serving apps P and Q, **When** the user starts the move in P's repository,
   **Then** OpsCrew lists every OpsCrew app it finds in the zone (by OpsCrew's records and rules)
   and says each needs its own prepare before the switch.
2. **Given** P prepared and Q not, **When** the user asks for the switch, **Then** it stops and
   names Q and the command to run in Q's repository.
3. **Given** P and Q prepared, **When** the switch runs from either repository, **Then** both apps
   are served from B after it, and the switch's output lists the finish to run in each.
4. **Given** every environment of an app (prod, staging, others), **When** the app is prepared,
   **Then** every environment's pieces are prepared, since they share the zone.

---

### User Story 3 - The data in R2 comes along (Priority: P1)

The app keeps files in an R2 bucket, and its snapshots' encrypted copies may sit in another. The
move makes new buckets in B, copies every object, switches the app to them in a short maintenance
window and, at the finish, deletes the old buckets after the user types their names.

**Why this priority**: the founder's decision; without it the old account can't be closed and the
app still depends on it.

**Independent Test**: an app with an R2 bucket of user files and the snapshots' copy in R2 moves;
every object is in B's buckets with the same content, the app reads and writes there, a restore
from an off-server copy works from B, and A's buckets are gone after the finish.

**Acceptance Scenarios**:

1. **Given** an app with R2 buckets, **When** the move is prepared, **Then** OpsCrew plans the new
   buckets in B (approved by hash) and shows each bucket's size, its object count and the copy's
   expected time before copying.
2. **Given** the buckets copied, **When** the app is switched to them, **Then** the app stops taking
   writes for the final copy only (a maintenance window whose length is shown first), then runs on
   B's buckets with their new keys, which the user creates as for any R2 bucket.
3. **Given** the snapshots' copies in R2, **When** the move finishes, **Then** the existing copies
   are in B's bucket, each new snapshot is copied there, and a restore from the copy works.
4. **Given** the finish, **When** A's buckets are deleted, **Then** it happens only after an approval
   with `allowDestroy` and each bucket's name typed.

---

### User Story 4 - Sites, shared hosting and GitHub Pages (Priority: P2)

A site on Cloudflare's hosting (Workers), a GitHub Pages site, or an app on a shared hosting
account uses the zone too. Their pieces move like the others: a Worker is deployed again in B, and
the records of the others are recreated in B's zone.

**Why this priority**: the other deploy targets that use a Cloudflare zone; fewer users than
servers.

**Independent Test**: a site on Cloudflare's hosting and a GitHub Pages site in one zone move; both
answer from B after the finish.

**Acceptance Scenarios**:

1. **Given** a site on Cloudflare's hosting, **When** it is prepared, **Then** its Worker is
   deployed in B, and its deploy workflow's account and token switch to B at the finish.
2. **Given** the switch, **When** B's zone is active, **Then** the site's custom domains are attached
   in B (Cloudflare allows them only on an active zone), and the gap is said before the switch.
3. **Given** a GitHub Pages site or a shared hosting account, **When** it is prepared, **Then** its
   records are planned in B's zone and it keeps answering through the switch.

---

### User Story 5 - Domains registered elsewhere, or at Cloudflare (Priority: P2)

The domain's registrar may be one OpsCrew drives (Porkbun, Namecheap, GoDaddy), Cloudflare
Registrar, or any other. OpsCrew switches the nameservers where it can, and otherwise prints
exactly what the user must do and waits.

**Why this priority**: every move needs the switch; most users' domains are at a registrar OpsCrew
already drives or at Cloudflare.

**Independent Test**: a switch at a registrar OpsCrew drives, and a switch the user makes by hand,
both end with B's zone active and the move continuing.

**Acceptance Scenarios**:

1. **Given** a domain at Porkbun, Namecheap or GoDaddy with that registrar's credentials set,
   **When** the switch is approved, **Then** OpsCrew sets B's nameservers there.
2. **Given** a domain registered at Cloudflare in A, **When** the switch runs, **Then** OpsCrew prints
   the dashboard steps of Cloudflare's move between accounts (started in A, accepted in B within
   five days) and waits for B's zone to become active, or stops and resumes when run again.
3. **Given** any other registrar, **When** the switch runs, **Then** OpsCrew prints B's nameservers,
   waits for the user to set them, and resumes when run again.
4. **Given** DNSSEC on, **When** the switch is prepared, **Then** OpsCrew turns it off and waits until
   the registry no longer publishes the old DS record before switching, as `domain connect` does,
   and turns DNSSEC on again in B after activation.

### Edge Cases

- **B's zone gets A's nameservers:** the switch would change nothing; OpsCrew stops before
  preparing and says to remove the zone in B and add it again.
- **The domain can't be added to B** (Cloudflare refuses it while active elsewhere, or a zone hold
  is on): OpsCrew stops with Cloudflare's reason and what to do.
- **A zone hold in A**: the move says to release it first.
- **A retarget in progress, or a move already running for the zone:** the move refuses until it is
  finished or aborted; a retarget refuses during a move.
- **Previews per pull request:** the move stops and says to turn previews off first and on again
  after the move (their zone and certificate are set up again by turning them on).
- **An app in the zone whose repository the user can't reach** (another team's): the switch names
  it; the user can't switch until it is prepared, or until it is removed from the zone.
- **The token for B lacks a permission:** the move names the missing permission before anything is
  created.
- **The switch interrupted:** running it again reads where it stopped (switched or not, active or
  not) and goes on; nothing is done twice.
- **B's certificate takes hours:** the move keeps waiting up to its limit, then stops saying the
  zone is active and the certificate pending, and the next run waits again.
- **The app's data changes during the R2 copy:** the final copy runs in the maintenance window, so
  nothing written before it is lost.
- **Several environments, one of them destroyed meanwhile:** the move covers the environments that
  exist when it is prepared and says which.
- **A's pieces shared with other apps** (the Zero Trust organization, the one-time PIN login): never
  removed from A, as today.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-2801**: OpsCrew MUST offer a command that moves an app's Cloudflare setup from the account
  holding its zone (A) to another account the user names (B), in steps the user runs: prepare,
  switch, finish, and abort before the switch.
- **FR-2802**: Before creating anything, the move MUST check that the token for B reaches B with
  every permission the app's pieces need, and that the token for A still reaches A, and name what
  is missing.
- **FR-2803**: Prepare MUST add the domain to B as a new zone when it is not there yet, stop when B's
  assigned nameservers equal A's, and copy the zone's records that belong to no OpsCrew app, keeping
  their proxied state, comments and TTL, through a plan approved by its hash.
- **FR-2804**: Prepare MUST plan each environment's pieces of the app in B (records, OpsCrew's rules
  for the zone, Tunnels, Access, Workers, R2 buckets, origin certificate and origin pulls) with B's
  zone and account, and apply them only after approval by hash, without changing A.
- **FR-2805**: For an app reached through a Tunnel, prepare MUST run B's connector beside A's on the
  server or in the Portainer stack, through a host or stack plan approved by hash.
- **FR-2806**: Each prepared app MUST be marked as prepared where any other app's switch can read it,
  and the switch MUST refuse until every OpsCrew app found in A's zone is prepared, naming those that
  are not and the command for each.
- **FR-2807**: Before the switch is approved, OpsCrew MUST say that visitors may get certificate
  errors from B's activation until B's certificate is live (minutes, at worst 24 hours), and that a
  site on Cloudflare's hosting is down until its custom domains are attached.
- **FR-2808**: The switch MUST turn DNSSEC off and wait for the old DS record to be gone when DNSSEC
  is on; set B's nameservers at Porkbun, Namecheap or GoDaddy when that registrar holds the domain;
  otherwise print what the user must do (Cloudflare Registrar's move between accounts, or the
  nameservers to set) and resume when run again.
- **FR-2809**: After the nameservers change, OpsCrew MUST ask Cloudflare to check them, wait until B's
  zone is active and its certificate live, attach what needs an active zone, turn DNSSEC on in B
  when it was on in A, and report the measured time without a valid certificate.
- **FR-2810**: Finish MUST, per app: replace the deploy secrets and server files that hold
  Cloudflare-issued values (tunnel token, Access service token, Workers account and token, origin
  certificate, R2 keys) with B's; remove A's connector; and make B's state the app's state, so the
  next provision, drift, status, rotate and destroy work on B only.
- **FR-2811**: For each R2 bucket of the app, the move MUST create the new bucket in B, show its
  size, object count and the copy's expected time, copy every object, and switch the app to it in a
  maintenance window that holds only the final copy; the snapshots' existing off-server copies MUST
  be in B's bucket after the finish.
- **FR-2812**: Finish MUST remove A's pieces of the app (Tunnels, Access, Workers, records, R2
  buckets) only after an approval flagged `allowDestroy` with the app's name, and each R2 bucket's
  name, typed; A's zone is left to Cloudflare (it shows "Moved Away" and is deleted after 7 days),
  and the account's shared Zero Trust pieces stay.
- **FR-2813**: Abort before the switch MUST remove B's pieces of the app (and B's zone when no other
  app was prepared in it) after approval, leave A unchanged, and stop B's connector; after the switch
  there is no abort: moving back is a move from B to A.
- **FR-2814**: Every step MUST be resumable: a run reads where the move stands from a record in the
  repository's `opscrew/` files and its local state, and repeats nothing already done.
- **FR-2815**: `opscrew status` MUST show a move in progress (its step, and for the switch the apps
  prepared), and `retarget`, `destroy` and a second move MUST refuse while one runs.
- **FR-2816**: No token, key, certificate, connector token or R2 key MAY appear in a prompt, output,
  log, audit entry, report, committed file or the move's record; each approval and each provider
  mutation MUST be in the audit log.
- **FR-2817**: The guide MUST explain the move: when to use it, the token for B, the steps for each
  registrar, the HTTPS gap, R2's maintenance window, several apps in one zone, previews, what stays
  in A, and how to move back; the Claude Code plugin MUST guide it, with every approval in the
  user's terminal.

### Key Entities

- **The move**: an app's move of its zone from account A to account B, with its step (prepared,
  switched, finished, or aborted), the accounts, the zone, the apps found in it, and per
  environment what was prepared in B.
- **The prepared mark**: what tells the switching run that an app in the zone is ready in B.
- **The two sides**: A's pieces (removed at the finish) and B's pieces (the app's state after it),
  per environment.
- **A bucket's copy**: an R2 bucket's size, object count, the copy's progress and its final copy in
  the maintenance window.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-2801**: Two apps from two repositories in one zone, one on a cloud server and one on an own
  server through a Tunnel, move from one account to another and both answer from the new account,
  in a live pass.
- **SC-2802**: Until the switch, no request to either app fails because of the move (measured
  under load during prepare).
- **SC-2803**: The time without a valid certificate after the switch is measured and reported by
  the move, and recorded in the live pass's results.
- **SC-2804**: Every object of the app's R2 bucket and of the snapshots' copies is in the new
  account with the same content, and nothing written before the maintenance window is lost.
- **SC-2805**: After the finish, nothing of the moved apps is left in the old account but the old
  zone (moved away) and the account's shared Zero Trust pieces.
- **SC-2806**: An abort before the switch leaves the old account serving exactly as before and the
  new account without the app's pieces.
- **SC-2807**: No token, key or certificate of either account appears in any output, log, audit
  entry, committed file, pull request or state file of the pass.

## Assumptions

- The user owns both accounts and makes the token for B with the permissions the guide lists (the
  same as for A, on B).
- Both accounts can be on Cloudflare's free plan; no paid certificate is used, hence the HTTPS gap.
- Registrars OpsCrew drives are reached with the credentials `domain connect` already reads.
- The new R2 buckets' keys are made by the user, as for any R2 bucket OpsCrew creates.
- The live pass needs a second Cloudflare account (free) and a domain whose nameservers OpsCrew can
  switch through a registrar's API, other than the domain the other live passes use.

## Out of scope

- Moving one app out of a zone that keeps serving other apps in A (a zone moves whole).
- Paid certificates to avoid the gap (Advanced Certificate Manager, custom certificates); the guide
  names them.
- Moving the previews' zone or certificate: previews are turned off for the move and on again after.
- Moving buckets that are not R2 (they don't depend on the Cloudflare account).
- Keeping DNSSEC on through the move (multi-signer between two Cloudflare accounts is not
  documented).
