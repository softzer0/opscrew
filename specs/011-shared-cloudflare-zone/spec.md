# Feature Specification: Several OpsCrew apps in one Cloudflare zone

**Feature Branch**: `mvp` (feature directory `specs/011-shared-cloudflare-zone`)
**Created**: 2026-10-17
**Status**: Draft
**Input**: Founder decision 2026-10-16: the next feature, for every target (Hetzner, DigitalOcean,
own server, Portainer), after the founder asked whether several projects can share one Portainer
(they can; the zone's rules were the gap). Lead decision 2026-10-17, after research of Cloudflare's
Rulesets API and plan limits: OpsCrew keeps one shared rule per rule phase in the zone, listing the
hostnames of every OpsCrew app there; each app adds and removes only its own hostnames.

## Why

Each OpsCrew app protects its hostnames with two Cloudflare rules: one that blocks probes for
secrets and admin panels (`/.env`, `/.git`, `/wp-admin`, …) and one that makes Cloudflare verify the
origin's certificate (Full (strict) TLS). Today each app owns the zone's whole rule set for each of
those two kinds, and a zone can hold only one rule set of each kind. So the second OpsCrew app in a
zone, or any app in a zone where the user already wrote rules of their own, gets no protection: it
skips its rules with a warning. Destroying an app also deletes its whole rule sets, whoever else
relied on them. The same happens one level up: the first app that needs Cloudflare Access creates
the account's Zero Trust organization and its one-time-PIN login, later apps reuse them, and
destroying the first app deletes them and breaks the others.

People put several apps under one domain all the time (`shop.example.com`, `api.example.com`,
`status.example.com`). They should get the same protection for every app, keep their own rules, and
be able to remove one app without touching the others.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A second app in my zone is protected like the first (Priority: P1)

A user already deploys one app with OpsCrew under `example.com` and now deploys a second one under
`api.example.com`. OpsCrew shows that it will add the new hostname to OpsCrew's two shared rules in
the zone (the probe block and the strict TLS rule) and nothing else, and applies that only after the
user approves the exact change. Both apps are then protected, and the zone still uses only two rule
slots.

**Why this priority**: it is the feature; today the second app is unprotected.

**Independent Test**: deploy two apps into one zone (fakes, then live); both hostnames are in both
shared rules, each app's requests to `/.env` are blocked at Cloudflare, and the zone holds exactly
one OpsCrew rule per phase.

**Acceptance Scenarios**:

1. **Given** a zone with OpsCrew's shared rules for app A, **When** app B is provisioned in the
   zone, **Then** the plan shows B's hostnames added to each shared rule and no other change, and
   after approval both rules list A's and B's hostnames.
2. **Given** a zone with no rules yet, **When** the first app is provisioned, **Then** OpsCrew
   creates the zone's rule sets with one OpsCrew rule each, listing that app's hostnames.
3. **Given** app B's hostnames are already in both rules, **When** B is provisioned again, **Then**
   nothing changes and no approval is asked.

---

### User Story 2 - Removing one app leaves the others protected (Priority: P1)

A user destroys app A. OpsCrew removes only A's hostnames from the shared rules; app B keeps its
protection, its Access login and its tunnel. When the last OpsCrew app in the zone is destroyed,
OpsCrew deletes its now empty rules. The account's Zero Trust organization and one-time-PIN login
are never deleted by an app's destroy, and OpsCrew says so.

**Why this priority**: without it, destroying one app silently breaks the others.

**Independent Test**: with apps A and B in one zone and account, destroy A; B's hostnames are still
in both rules, B's Access application still accepts its login, and the organization and identity
provider still exist; destroy B; OpsCrew's rules are gone, the user's own rules and the Zero Trust
organization remain.

**Acceptance Scenarios**:

1. **Given** apps A and B in one zone, **When** A is destroyed, **Then** the destroy plan removes
   A's hostnames from each shared rule, the typed confirmation covers it, and B's hostnames stay.
2. **Given** only app B is left, **When** B is destroyed, **Then** OpsCrew deletes its two rules and
   leaves every rule it did not create.
3. **Given** app A created the Zero Trust organization and the one-time-PIN login, **When** A is
   destroyed, **Then** both stay and the output says they stay and cost nothing.

---

### User Story 3 - My own rules in the zone stay mine (Priority: P2)

A user already has their own WAF custom rules and configuration rules in the zone. OpsCrew adds its
rule to those rule sets instead of skipping, never changes or reorders the user's rules, and places
its own rule after them.

**Why this priority**: many zones already have rules; today OpsCrew gives up there.

**Independent Test**: a zone (fake, then live) with two user rules in each phase; after provision
and destroy, the user's rules are byte-identical and in the same order.

**Acceptance Scenarios**:

1. **Given** a zone whose rule sets hold only the user's rules, **When** an app is provisioned,
   **Then** OpsCrew's rule is added after them and the user's rules are unchanged.
2. **Given** the zone's rule slots for a phase are all used by the user's rules, **When** an app
   needs a new OpsCrew rule there, **Then** OpsCrew stops before any change and says how many slots
   the plan allows and what to remove or upgrade.

---

### User Story 4 - Day 2: re-runs, drift and changes made by others (Priority: P2)

Re-running provision changes nothing when nothing changed. `opscrew drift` reports when one of this
app's hostnames is missing from a shared rule, when OpsCrew's rule is gone, or when someone changed
OpsCrew's rule beyond its hostnames (its action, its paths, or turned it off). OpsCrew never
overwrites such a change: it reports it with the difference and how to restore it.

**Why this priority**: shared rules are changed by several apps and by people; the user must see
what differs without OpsCrew undoing their changes.

**Independent Test**: edit the shared rule by hand (disable it; drop this app's hostname; change the
blocked paths); drift reports each case; provision re-adds a missing hostname but refuses to apply
over a changed action or paths.

**Acceptance Scenarios**:

1. **Given** this app's hostname was removed from a shared rule by hand, **When** drift runs,
   **Then** it reports the missing hostname, and the next provision plans to add it back.
2. **Given** a person changed OpsCrew's rule action from block to log, **When** provision runs,
   **Then** OpsCrew does not change the rule, says what differs and how to restore it, and changes
   nothing else in that phase.
3. **Given** another app changed the shared rule between this app's plan and its apply, **When** the
   apply starts, **Then** OpsCrew stops before writing, changes nothing, and asks for a new plan.

---

### User Story 5 - Clear limits (Priority: P3)

A shared rule can hold only so many hostnames before it reaches Cloudflare's expression length
limit. OpsCrew counts before planning and stops with a plain message when an app would not fit, so
nothing is left half-applied.

**Why this priority**: rare (dozens of hostnames per zone), but it must fail cleanly.

**Independent Test**: a fake zone whose shared rule is near the limit; provisioning one more app
stops before any change with a message that names the limit and the hostnames already listed.

**Acceptance Scenarios**:

1. **Given** a shared rule close to the expression limit, **When** an app would push it over,
   **Then** OpsCrew stops before planning any Cloudflare change and says why.

### Edge Cases

- **A hostname is already in a shared rule but not recorded by this app** (another app uses it, or a
  project whose folder is gone): OpsCrew refuses to claim it, changes nothing, and says how to free
  it (remove it from the rule in the dashboard if the old app is gone).
- **Two apps are provisioned at the same time in one zone**: the rule set changes between plan and
  apply; the second apply stops before writing (User Story 4, scenario 3).
- **OpsCrew's rule was deleted by hand**: drift reports it; the next provision recreates it with this
  app's hostnames; other apps add theirs on their next provision (OpsCrew says so).
- **The app's hostnames change** (a new domain, `www` added or removed): one plan removes the old
  hostnames and adds the new ones.
- **A move between providers** (`retarget`) keeps the hostnames, so the shared rules do not change.
- **The Cloudflare token cannot edit WAF custom rules or configuration rules**: `opscrew init` and
  provision say which permission is missing; nothing changes.
- **The zone is on a paid plan** with more rule slots: the same two OpsCrew rules are used.
- **A rule set kind OpsCrew does not touch** (redirects, cache rules): never read or changed.
- **The Zero Trust organization exists but was not created by OpsCrew**: it is reused and never
  changed, as today.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-1101**: In each zone, OpsCrew MUST keep at most one rule of its own per rule phase it uses
  (the probe block in the WAF custom rules phase; strict TLS in the configuration rules phase), each
  marked by a fixed identifier, whose hostname set is the union of the hostnames of every OpsCrew app
  in the zone.
- **FR-1102**: Each app MUST record in its local state which hostnames it added, and MUST add and
  remove only those; it MUST NOT claim a hostname already listed that it did not record.
- **FR-1103**: OpsCrew MUST NOT change, reorder or delete any rule it did not create. It MUST add its
  rule to an existing rule set (after the rules already there) and create the zone's rule set for a
  phase only when there is none.
- **FR-1104**: Every change to OpsCrew's rules MUST be shown first (phase, hostnames added and
  removed, whether the rule is created or deleted) and applied only after an approval bound to the
  SHA-256 hash of that exact change; `--yes` never grants it, a non-interactive run needs
  `--approve <hash>`, and the MCP server asks through a dialog or refuses.
- **FR-1105**: Just before writing, OpsCrew MUST read the rule set again and stop without changing
  anything when OpsCrew's rule differs from what the approved plan expected.
- **FR-1106**: After writing, OpsCrew MUST read the rule set back and confirm the change, and MUST
  record every change in the audit log.
- **FR-1107**: Re-running provision when this app's hostnames are already in place MUST change
  nothing and ask nothing.
- **FR-1108**: When OpsCrew's rule differs beyond its hostnames (action, matched paths, setting,
  disabled), OpsCrew MUST report the difference and how to restore it and MUST NOT overwrite it.
- **FR-1109**: Before planning, OpsCrew MUST check that the shared rule stays within Cloudflare's
  expression length limit and that the phase has a free rule slot when a new rule is needed, and stop
  with a plain message otherwise.
- **FR-1110**: `opscrew destroy` MUST remove only this app's hostnames from the shared rules and
  delete a rule only when no hostname is left, as part of the destroy's typed confirmation.
- **FR-1111**: `opscrew drift` MUST report a missing OpsCrew rule, a missing hostname of this app and
  a rule changed beyond its hostnames.
- **FR-1112**: The account's Zero Trust organization and the one-time-PIN identity provider MUST be
  reused when present, created only when absent, and never deleted by an app's destroy; destroy MUST
  say they stay.
- **FR-1113**: The zone's rule sets MUST no longer be part of an app's infrastructure code; the
  current skip with a warning when another app or the user holds the rule set goes away.
- **FR-1114**: `--plan-only` MUST show the rule change without applying it, and every command that
  changes an app's hostnames (provision, `dns`, `domain connect`, destroy) MUST plan the rule change
  with the rest of its plan.
- **FR-1115**: `opscrew init` and provision MUST check that the Cloudflare token can edit WAF custom
  rules and configuration rules in the zone, and name the missing permission.
- **FR-1116**: Any zone-wide Cloudflare setting OpsCrew changes, in this or later features, MUST be
  set per hostname when the user's plan allows it; otherwise OpsCrew MUST read it first and never
  overwrite a value that already differs, saying so plainly.
- **FR-1117**: The CLI, the MCP tools and the plugin MUST offer the same plans and approvals for the
  rule changes.
- **FR-1118**: This MUST work for every target: Hetzner, DigitalOcean, the user's own server and
  Portainer.
- **FR-1119**: No token, secret or server address MUST appear in the rule plans, audit entries or
  output (hostnames are public and may appear).
- **FR-1120**: The user guide MUST explain sharing a zone and an account between apps, the two
  shared rules, the limits and how to free a hostname.
- **FR-1121**: The gated live tests MUST deploy a second app into the same zone and account, check
  both are protected, destroy one and check the other still is, then destroy the other and check
  nothing of OpsCrew's is left and the rules OpsCrew did not create are unchanged.

### Key Entities

- **Shared OpsCrew rule**: one per zone and phase; its fixed identifier, the action it takes and its
  hostname set.
- **App's hostname record**: the hostnames an app added to each shared rule, kept in the app's local
  state.
- **Rule plan**: the change to the shared rules for one app (hostnames to add and remove, the rule to
  create or delete, the rule set version it expects), with its SHA-256 hash.
- **Account-wide Zero Trust pieces**: the organization and the one-time-PIN identity provider, shared
  by every app in the account.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1101**: Two apps in one zone are both protected by the probe block and strict TLS, and the
  zone holds exactly two OpsCrew rules however many OpsCrew apps it has.
- **SC-1102**: After one of two apps is destroyed, the other's probe block, strict TLS, Access login
  and tunnel still work (checked live).
- **SC-1103**: Rules OpsCrew did not create are identical, in content and order, before and after a
  provision and a destroy (checked live with at least one such rule per phase).
- **SC-1104**: No rule change is ever applied without an approval of the hash shown, and a plan
  whose rule set changed since it was made is refused every time.
- **SC-1105**: A second provision with nothing changed makes zero Cloudflare rule changes.
- **SC-1106**: After the live test, nothing of OpsCrew's is left in the zone or the account except
  the Zero Trust organization and identity provider, and the leak check finds no token, secret or
  server address.

## Assumptions

- Every OpsCrew app's rules do the same thing for its hostnames (the same probe paths, the same TLS
  setting), so one shared rule per phase can serve all of them.
- Cloudflare's Free plan allows 5 WAF custom rules and 10 configuration rules per zone and
  expressions up to 4,096 characters; with two shared rules OpsCrew uses one slot per phase whatever
  the number of apps, and fits roughly 60 to 100 hostnames per rule.
- Cloudflare offers no optimistic locking for rule sets; re-reading just before writing (FR-1105)
  keeps the window small, and one user rarely provisions two apps in one zone at the same moment.
- OpsCrew is not released, so no migration is needed from the whole-rule-set ownership of today.
- Hostnames are public (they are in DNS), so listing other apps' hostnames in a shared rule
  reveals nothing new.
- Several OpsCrew apps on one server the user owns stays in feature 013 (component model); this
  feature is about the Cloudflare zone and account.
