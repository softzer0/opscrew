# Feature Specification: Contabo, opening with the contract for cloud server providers

**Feature Branch**: `main` (feature directory `specs/026-contabo-provider-plugins`)
**Created**: 2026-11-11
**Status**: Draft
**Input**: The roadmap's "026 Contabo, opening with the provider plugin system" (founder,
2026-11-06: Contabo before AWS, its research reading the official CLI `cntb`; 2026-10-16: the
plugin system). Research: [research.md](research.md). R5 holds the founder's two decisions this
spec builds on: 026 builds the contract for cloud server providers (installing packages comes
with AWS in 028), and one live pass on one Contabo Cloud VPS 4.

## Why

Contabo rents servers for a fraction of what most clouds charge, and many people leaving hosted
platforms already have an account there. OpsCrew can't create a server there today. Adding it the
way Hetzner and DigitalOcean were added would spread a third provider across some 60 files
(research R1). Instead, everything about one cloud server provider moves into one place, behind a
versioned contract. Hetzner and DigitalOcean move first, and Contabo is the first provider written
for it. That makes Contabo smaller to add and AWS's package possible later (028).

Contabo differs from the other two in ways the user must see before paying (R2):
- a destroy only cancels the server at the end of its term, at least a month;
- the smallest plan has a setup fee on monthly terms;
- there is no price API;
- its credentials reach the whole account.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy an app to a Contabo server (Priority: P1)

**Why this priority**: it is the feature's point, a cheap server for the app.

**Independent Test**: the live pass on one Cloud VPS 4 goes through interview, design, provision,
deploy, verify, status, secure and drift, and the app answers on its domain.

**Acceptance Scenarios**:

1. **Given** the four Contabo credentials in the environment, **When** the user runs
   `opscrew interview`, **Then** Contabo is offered next to Hetzner Cloud and DigitalOcean (and
   chosen without asking when only its credentials are set), with the regions it serves.
2. **When** the user runs `opscrew design`, **Then** the options show Contabo's Cloud VPS plans:
   - the monthly price, the one-time setup fee and the date of the price table;
   - that the contract runs at least one month and that a removal ends it only at the end of its
     term;
   - no provider backups (OpsCrew's own snapshots cover the data).
3. **When** the user runs `opscrew provision` and approves the plan by its hash, **Then**
   OpsCrew creates:
   - the server, on a monthly term, from Ubuntu 24.04 with the same first-boot setup as on the
     other providers;
   - its SSH key;
   - a Contabo firewall with the same rules: SSH from the allowed networks, the web ports on a
     server that serves the web, WireGuard where it is used.

   The deploy, verify, status, secure and drift commands then work as on the other providers.
4. **Given** a create that timed out or failed halfway, **When** provision runs again, **Then** a
   server with the app's name that OpsCrew's state doesn't know is shown and taken over in the
   plan, never bought a second time.
5. **Given** credentials that are missing or wrong, **Then** `opscrew init` and provision name the
   missing variables, link Contabo's page to create them, and say plainly that they reach the
   whole account.

---

### User Story 2 - Remove an app from Contabo honestly (Priority: P1)

**Why this priority**: a removal that seems to stop the billing but doesn't would cost the user
money without warning.

**Independent Test**: the live pass's `opscrew destroy` on the Contabo server cancels it. The plan
said it would, the date Contabo answers is shown, and the server is shut down.

**Acceptance Scenarios**:

1. **Given** an app on Contabo, **When** the user runs `opscrew destroy`, **Then** the plan says:
   - Contabo ends the server's contract at the end of its current term, and it is billed until
     then;
   - OpsCrew shuts it down and removes the app's other resources (its DNS records, firewall and
     SSH key) at once;
   - the server's disk and its Contabo snapshots go when the term ends.

   The typed confirmation names the server.
2. **When** the cancel is applied, **Then** OpsCrew shows the end date Contabo answers and records
   it in the audit log.
3. **Given** an app whose database or files live on the server, **Then** destroy offers OpsCrew's
   own snapshot, with its encrypted copy off the server, first (024). It does not offer a provider
   snapshot, which would go with the server.
4. **Given** a server that was cancelled earlier and is still in its term, **When** the user
   provisions the app again, **Then** the plan says a new server is bought (another month), since
   a cancelled one can't be taken back by OpsCrew.

---

### User Story 3 - Hetzner and DigitalOcean behind the contract, unchanged (Priority: P1)

**Why this priority**: they run real apps today; moving them must not change anything users see.

**Independent Test**: every existing test passes unchanged, apart from its imports. The files
OpsCrew generates for the example apps on Hetzner and DigitalOcean are byte-identical before and
after.

**Acceptance Scenarios**:

1. **Given** a project on Hetzner or DigitalOcean, **When** any command runs, **Then** its plans,
   generated files, prices, wording and errors are the same as before the move.
2. **Given** the move, **Then** everything about one cloud server provider is read from its
   definition:
   - its connector and price tables;
   - its profile (tokens, consoles, regions, error patterns);
   - its Terraform module and provider pin, its module arguments and shared resources, and its
     runbook text;
   - its firewall and server resources for the SecOps checks;
   - its token formats;
   - its interview option and wording.

   No other code branches on a cloud provider's id.
3. **Given** own server, Portainer, this computer and the serverless hosts, **Then** they keep
   their flows: they are kinds of target, not cloud server providers (R5).

---

### User Story 4 - Everything around a server, on Contabo (Priority: P2)

**Acceptance Scenarios**:

1. **Whole-server snapshots** (`opscrew snapshot --server`, `restore --server`):
   - They work through Contabo's snapshots, included in the plan's price up to its limit (1 on
     Cloud VPS 4, 2 or 3 on larger plans).
   - At the limit, the command refuses and names the snapshot to delete.
   - A restore of a snapshot that is not the newest says first that Contabo deletes the newer
     ones.
2. **Moves** (`opscrew retarget`) work to and from Contabo like any other server target. A
   change of plan size on Contabo is refused with the reason (its Terraform provider ignores it)
   and two ways named: a move to another provider, without downtime, or a new Contabo server of
   the size wanted through a data snapshot, destroy, provision and restore, with downtime
   (`retarget` doesn't move within one provider).
3. **Several servers** (018), **previews on a server** (022), **monitoring** (020),
   **logs**, **rollback** and **data snapshots** (019, 024) work on Contabo servers as on the
   others.
4. **`opscrew advise`** includes Contabo in its cost comparisons, labelled with the price table's
   date.
5. **`opscrew rotate`** lists the four Contabo credentials among the user's own tokens, with how to
   replace them (025).

---

### User Story 5 - The next provider is one package (Priority: P2)

**Why this priority**: it is what the contract is for. AWS's package (028) and any later cloud
server provider build on it.

**Independent Test**: Contabo's own tasks change only its provider package, the list of built-in
providers, the provider id lists the schemas generate from, and the docs.

**Acceptance Scenarios**:

1. **Given** the contract, **Then** a provider is one package that exports one definition
   implementing it:
   - plain data and functions, with no zod schemas or class instances crossing it;
   - a `contractVersion` the core checks.
2. **Given** a definition, **Then** the core validates everything it reads from it, as it does
   every external input.
3. **Given** a new definition missing a required part, **Then** the type check and one shared test
   per provider fail with what is missing.

---

### User Story 6 - From Claude Code, and in the guide (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the plugin, **Then** the MCP tools accept `contabo` wherever they accept a cloud
   provider, and the deploy and snapshot skills describe what differs on Contabo.
2. **Given** the guide, **Then** a page for Contabo says:
   - which credentials to create;
   - what a removal does, and the minimum term and setup fee;
   - the snapshot limits;
   - the regions;
   - what isn't offered (provider backups, Contabo's object storage and private networks).

   The pages that list providers include it.

### Edge Cases

- **A region Contabo doesn't serve** (`eu-north`): its nearest region (EU, in Germany) is used,
  and design says so.
- **Out of stock or a server limit**: the provider's answer is shown in plain English with what to
  try next, as on the other providers.
- **Only some of the four credentials set**: the missing ones are named; nothing is called.
- **Tokens expire mid-run**: OpsCrew gets a new token and repeats the read once. A create is never
  repeated.
- **The price table is old**: its date is shown wherever its prices are. The table is checked
  against contabo.com before each release.
- **A firewall Contabo refuses to create or attach**: provision stops before the deploy, says so,
  and leaves no server reachable without one.
- **A cancel Contabo refuses** (for example a server not created through its API): the plan's
  apply stops with Contabo's reason and the steps in its panel.
- **Contabo's credentials in the app's environment or files**: `opscrew scan` reports them as a
  leaked secret, as it does other providers' tokens.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-2601**: Every cloud server provider MUST be described by one definition that implements a
  versioned contract in `@opscrew/contracts` and lives in its own package. Consumers MUST read
  provider facts only through the list of built-in definitions, never branch on a cloud
  provider's id, and validate what they read.
- **FR-2602**: Hetzner and DigitalOcean MUST move into definitions with no change to any plan,
  generated file, price, message or test outcome.
- **FR-2603**: Contabo MUST be a built-in cloud server provider, `contabo`, written for the
  contract:
  - its connector calls Contabo's API with its typed client (OAuth2 password grant, an
    `x-request-id` on every call), never `cntb`;
  - its servers are created through the IaC engine with the `contabo/contabo` Terraform provider.
- **FR-2604**: Contabo's credentials MUST be read from `CNTB_OAUTH2_CLIENT_ID`,
  `CNTB_OAUTH2_CLIENT_SECRET`, `CNTB_OAUTH2_USER` and `CNTB_OAUTH2_PASS`. They MUST be redacted
  everywhere, used only on the user's computer and never written to state, tfvars, the server or
  CI.
- **FR-2605**: Design MUST price Contabo from a dated static table:
  - the monthly price, the setup fee and the minimum term;
  - no provider backups;
  - snapshots included up to the plan's limit.

  Every price MUST show the table's date.
- **FR-2606**: Provision MUST create the server on a monthly term with the shared first-boot
  setup, its SSH key and a firewall with the same rules as the other providers. It MUST stop
  before the deploy when the firewall is not in place.
- **FR-2607**: A create MUST never be repeated blindly. A server with the app's name that the
  state doesn't know MUST be shown and taken over in the plan.
- **FR-2608**: Destroy MUST cancel a Contabo server and shut it down. Its plan, approval and typed
  confirmation MUST say that billing runs to the end of the term, and the end date Contabo
  answers MUST be shown and audited. Data on the server MUST be offered OpsCrew's own snapshot
  first.
- **FR-2609**: Whole-server snapshots, restores, moves, several servers, previews, monitoring,
  logs, rollback, data snapshots, advise, rotate, status, secure and drift MUST work for Contabo
  as US4 says. A size change MUST be refused with the way to do it.
- **FR-2610**: The interview MUST offer Contabo and map OpsCrew's regions to Contabo's: EU for
  both European regions, US-east, US-west and SIN. Any region that maps elsewhere MUST be said in
  design.
- **FR-2611**: The MCP tools, the plugin skills and the guide (a Contabo page, plus the pages that
  list providers) MUST cover Contabo (US6).
- **FR-2612**: An ADR MUST record the contract and how a provider package implements it. The
  constitution's provider order MUST list Contabo with the hosting providers.

### Key Entities

- **Cloud provider definition**: a provider's id, `contractVersion`, connector factory, price
  tables and their date, profile, Terraform module and provider pin, module arguments, shared
  resources, runbook and plan wording, the resource types SecOps reads, token formats, and how a
  server is removed (deleted at once, or cancelled at the end of its term).
- **Built-in providers**: the ordered list of definitions the CLI ships (Hetzner, DigitalOcean,
  Contabo).
- **Contabo server term**: the contract period (one month), the setup fee, and once cancelled, the
  end date Contabo answered.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-2601**: The live pass on one Cloud VPS 4 completes interview, design, provision, deploy,
  verify, a whole-server snapshot and its restore, secure, drift and destroy. The app answers on
  its domain, and destroy shows the cancel date.
- **SC-2602**: For the example apps on Hetzner and DigitalOcean, the generated files are
  byte-identical before and after the move, and every existing test passes.
- **SC-2603**: Contabo's tasks change nothing outside its provider package, the built-in list, the
  provider id lists and the docs.
- **SC-2604**: A scan of every output, log, audit entry, state file and committed file of the live
  pass finds none of the four Contabo credentials.
- **SC-2605**: With a fake Contabo API that times out on create, a second provision buys no second
  server.

## Assumptions

- The founder's decisions of 2026-11-11 (research R5).
- Facts the research could not verify are checked when the founder's account exists, and before
  the live pass where they cost nothing:
  - the setup fee's amount;
  - how long provisioning takes;
  - whether a cancelled server keeps running until its end date;
  - whether snapshots outlive a cancelled server;
  - Ubuntu 24.04's image name;
  - the `period` values the API accepts.
- Contabo's firewall bug (provider issue #56) hit instances that had been recreated and adopted
  several times. Firewalls of normally created instances work, so the firewall is created through
  Terraform, and the live pass proves it.
- Not in scope:
  - Contabo's Object Storage, Auto Backup, private networks and rDNS;
  - its regions outside OpsCrew's five (UK, Australia, Japan, India, US-central);
  - terms longer than a month;
  - installing provider packages, which comes in 028.
