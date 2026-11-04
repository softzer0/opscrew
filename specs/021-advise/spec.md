# Feature Specification: Advise

**Feature Branch**: `main` (feature directory `specs/021-advise`)
**Created**: 2026-11-04
**Status**: Draft
**Input**: The roadmap's "021 Advise" (founder, 2026-10-18: "analyze the current setup and then
propose what to change and how to scale").
- `opscrew advise` reads the live deployment, `plan.yaml`, the interview's expected traffic and
  budget, and live provider prices, and proposes concrete changes, each explained, backed by the
  figures and priced.
- It changes nothing itself: each proposal is applied through the existing flows (a plan and a
  hash-bound approval). Deterministic first; a model only for the judgment it adds.
- Research: [research.md](research.md). R3 holds the lead's decisions this spec builds on.

## Why

Once an app runs, its owner has figures (`opscrew status`, and with 020 two weeks of history) but
nobody to read them. Is the server too big, or about to run out of memory? Is the disk filling? Is
the bill above the budget they gave? Are there security updates, Dependabot alerts or a token about
to expire? Each answer is somewhere in OpsCrew or the user's accounts, and each fix is an OpsCrew
command, but putting them together is the DevOps work the user doesn't have someone for.

`opscrew advise` puts them together: one list of what to change, why, what it costs or saves, and
the command that does it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - What to change, and why (Priority: P1)

The user runs `opscrew advise`. OpsCrew reads the environment and lists its proposals, the most
urgent first. Each proposal says:
- what to change, in one line (for example "Move server app to a cx33");
- why, with the figures it rests on (for example "memory at 91% (p95 over 14 days) of 4 GB");
- what it costs: the monthly price before and after, from the provider's live prices;
- how to apply it: `opscrew advise --apply <id>`, or the command that does it.

With nothing to propose, it says so, and what it looked at.

**Why this priority**: it is the feature.

**Independent Test**: deploy the example app to a server too small for it (or with backups off and
important data), run `opscrew advise`: the matching proposal is listed with its figures, its price
and its command.

**Acceptance Scenarios**:

1. **Given** a deployed environment, **When** the user runs `opscrew advise`, **Then** it reads the
   server's figures, the plan, the interview's answers and live prices, and changes nothing on any
   server, account or repository.
2. **Then** each proposal has a stable id, a title, its reasons with their figures, the monthly
   price before and after (or "no price change"), and how to apply it.
3. **Then** proposals are ordered: something about to break first (a disk filling, memory at its
   limit, a token about to expire), then security, then savings, then the rest.
4. **Given** nothing to change, **Then** it says so and lists what it checked.
5. **Given** `--json`, **Then** the same proposals as JSON, for scripts.
6. **Given** an environment that isn't deployed, **Then** it refuses, saying to run
   `opscrew provision` first.

---

### User Story 2 - Apply a proposal (Priority: P1)

The user picks a proposal and runs `opscrew advise --apply <id>`. For proposals the plan holds,
OpsCrew writes the change into the plan only, shows what changed and the new monthly price, and says
to run `opscrew provision`, which shows the change and applies it once its hash is approved, as
always. For the others, it prints the command that does it.

**Why this priority**: advice the user has to translate into plan edits by hand is half the work.

**Independent Test**: `opscrew advise --apply <id>` for a larger server: the plan's server type
changes, nothing else does; `opscrew provision` shows the resize and applies it after approval.

**Acceptance Scenarios**:

1. **Given** a proposal the plan holds (a server type, a container's memory limit, backups, the
   scheduled check), **When** the
   user runs `opscrew advise --apply <id>`, **Then** only the plan changes, the summary shows the
   change and the new monthly price, and it says to run `opscrew provision`.
2. **Given** a proposal applied through another command (monitoring, `retarget`, Dependabot's pull
   requests), **Then** `--apply` prints that command and changes nothing.
3. **Given** an id that isn't among the current proposals, **Then** it refuses before any change,
   naming the current ids.
4. **Given** the figures changed since the list was shown, **Then** `--apply` works on a fresh
   reading: it applies the proposal only when it still stands, and otherwise says so.
5. **Then** nothing is applied to a server, an account or the repository by `advise` itself.

---

### User Story 3 - Size from two weeks of history (Priority: P1)

With the self-hosted monitoring stack on (020), advise reads 14 days of each server's figures:
p95 CPU and memory, the disk's trend, each container's memory against its limit and its restarts.
It proposes a larger server when the figures say the server is short, a smaller and cheaper one
when they say it is far too big, and warns about a disk that will be full within 30 days.

**Why this priority**: right-sizing is the core of "how to scale", and only history makes it safe.

**Independent Test**: with monitoring on and a week of figures, a server whose p95 memory is high
gets a "larger" proposal with its figures; one far under its size gets a "smaller" proposal with the
saving.

**Acceptance Scenarios**:

1. **Given** at least 7 days of history, **When** p95 CPU and p95 memory both fit comfortably in the
   next smaller type at the same provider and location (R3, the thresholds in the plan), **Then** it
   proposes that type, with the monthly saving, and says the disk stays as it is.
2. **Given** p95 memory above 85% of the server, or the 15-minute load above the CPUs for most of
   the period, **Then** it proposes the smallest type that brings them under, with the added price,
   and says the app is offline one to three minutes and that the move is one way (the disk grows,
   and neither provider makes it smaller).
3. **Given** a container whose memory reached its limit (its maximum at 95% of it, or killed for
   memory), **Then** it says which, with the numbers, and proposes a higher limit in the plan (the
   web process's, a worker's or a service's `memoryMb`) when the server has room for it, or a
   larger server when it hasn't. Restarts are US6's.
4. **Given** the disk's trend reaches full within 30 days, **Then** it says when, and proposes a
   larger type (the only way to grow the disk today) or cleaning up images.
5. **Given** a server type that can't go smaller because its disk would shrink, **Then** it doesn't
   propose it.

---

### User Story 4 - Without history (Priority: P2)

Without monitoring, advise reads one moment, as `opscrew status` does. It still proposes what that
moment shows (memory at its limit, a disk at 85%, restarts), and every proposal that doesn't need
figures (cost, reliability, upkeep). It never proposes a smaller server from one reading, and it
says that turning monitoring on would let it.

**Why this priority**: most users start without monitoring; the advice must still be useful and
never wrong in the cheap direction.

**Acceptance Scenarios**:

1. **Given** no history, **Then** each figure-based proposal says it rests on one reading.
2. **Then** no proposal shrinks a server, and a closing line says `opscrew addon enable monitoring`
   would give two weeks of figures for that.

---

### User Story 5 - Cost (Priority: P2)

**Why this priority**: the interview asked for a budget; the user should hear when they pass it,
and when the same server costs less elsewhere.

**Acceptance Scenarios**:

1. **Given** the environment's monthly price above the interview's budget, **Then** it says by how
   much, and which of its other proposals would bring it under.
2. **Given** a type with at least the same CPUs, memory and disk, cheaper at the same provider in
   the same region, **Then** it proposes it with the saving.
3. **Given** the same server is cheaper at the other provider OpsCrew supports, **Then** it says so
   with both prices and names `opscrew retarget` (a move with a short maintenance window).
4. **Then** every price is the provider's live price, or the dated static one with that date.

---

### User Story 6 - Reliability (Priority: P2)

**Why this priority**: the cheapest outages to prevent are the ones a setting would have prevented.

**Acceptance Scenarios**:

1. **Given** backups off while the interview said the data is important or critical, **Then** it
   proposes turning them on, with their price.
2. **Given** the scheduled check off for prod, **Then** it proposes turning it on (free).
3. **Given** the scheduled check opened and closed its issue 3 times or more in 14 days, **Then** it
   reports a flapping health check, with the dates, and what to look at.
4. **Given** a container restarted 3 times or more in 14 days (or its count says so on one
   reading), **Then** it reports a restart loop, with `opscrew logs --failed` to see why.

---

### User Story 7 - Upkeep and security (Priority: P2)

**Why this priority**: these are the chores that slip, and each is a known risk.

**Acceptance Scenarios**:

1. **Given** open Dependabot alerts on the repository, **Then** it reports how many, by severity,
   and the open Dependabot pull requests that would fix them; with a token lacking "Dependabot
   alerts: read", it says which permission to add instead. With the alerts off on the repository
   (GitHub's default for a private one), it proposes turning them on.
2. **Given** pending security updates on a server, or a reboot required, **Then** it says so, with
   how to apply them (they install automatically; the reboot is the user's call).
3. **Given** `opscrew secure`'s findings from its host checks, **Then** it lists the failing ones,
   most severe first, and points to `opscrew secure` for the full report.
4. **Given** a GitHub or Cloudflare token that expires within 30 days, **Then** it says which and
   when, and how to replace it. Hetzner and DigitalOcean tokens have no readable expiry; it says
   nothing about them.

---

### User Story 8 - Components (Priority: P3)

**Why this priority**: bigger changes, worth knowing about, rarer than resizing.

**Acceptance Scenarios**:

1. **Given** a Postgres taking most of the app server's memory (p95 of its container) while the
   server is short, **Then** it proposes giving the database a server of its own (018), priced, as an
   alternative to a larger server.
2. **Given** a disk filling with the app's uploads while the plan keeps files on the server,
   **Then** it proposes object storage, priced where the provider has a price.

---

### User Story 9 - In Claude Code (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the plugin, **When** Claude Code calls `opscrew_advise`, **Then** it gets the same
   proposals, read only; applying stays a terminal command.
2. **Then** the plugin's skill says when to suggest it ("is it the right size?", "why is it
   slow?", "can it cost less?").

### Edge Cases

- **Several servers (018):** each server is advised on, by its name; a database server's figures
  count for that server.
- **Several environments and apps:** `--env` and `--app`, as every command.
- **The user's own server:** no resize or price proposals (OpsCrew can't change the hardware), but a
  server short of memory is still reported, with what would fit.
- **Portainer and this computer:** totals only, as `status`; no resize or price proposals.
- **Cloudflare's hosting and GitHub Pages:** no server; only the upkeep proposals (Dependabot,
  tokens).
- **A server reached over the private network only (public SSH closed):** read as `status` reads
  it.
- **Monitoring on with less than 7 days of figures:** treated as no history for shrinking; growing
  still uses what there is.
- **Prices unreachable:** the dated static prices, said so.
- **A proposal already applied but not provisioned yet:** says the plan already holds it and to run
  `opscrew provision`.
- **A move or a retarget in progress:** advise reports it and proposes nothing else that changes the
  plan.

## Requirements *(mandatory)*

### Functional Requirements

**Reading**
- **FR-2101**: `opscrew advise` MUST read the environment's servers (as `status` reads them), the
  plan, the interview's answers, and live provider prices; with monitoring on (020), 14 days of
  history through fixed read-only queries on the stack's server.
- **FR-2102**: It MUST change nothing on any server, account or repository. Every remote command it
  runs is fixed and read-only, audited as `remote-exec`.
- **FR-2103**: It MUST read GitHub's Dependabot alerts and pull requests, and the GitHub and
  Cloudflare tokens' expiry, with the tokens the user already gave; a missing permission is a
  finding, not a failure.

**Proposals**
- **FR-2104**: Each proposal MUST have a stable id, a category (size, cost, reliability, upkeep,
  security, components, moving), an urgency, a title, its reasons with the figures, the monthly
  price before and after, and how to apply it.
- **FR-2105**: The thresholds MUST be OpsCrew's own, written in the plan and the guide (R3): sizing
  on p95 over 14 days (at least 7), a disk projected full within 30 days or at 85%, memory above 85%,
  3 restarts or check flaps in 14 days, tokens expiring within 30 days.
- **FR-2106**: It MUST NOT propose a smaller server without at least 7 days of history, nor one whose
  disk would be smaller than the current one.
- **FR-2107**: Prices MUST come from the provider's live prices, or the dated static ones with their
  date.
- **FR-2108**: Every rule MUST be deterministic code. No model is used in this version.

**Applying**
- **FR-2109**: `opscrew advise --apply <id>` MUST write only the plan for proposals the plan holds
  (server type, a container's memory limit, backups, the scheduled check), after reading the
  environment again; and print the
  command for the others. It MUST refuse an unknown or no longer valid id before any change.
- **FR-2110**: Applying MUST go through `opscrew provision`'s plan and hash-bound approval; advise
  never applies anything itself.

**Surfaces**
- **FR-2111**: `--json` MUST print the proposals as JSON.
- **FR-2112**: The MCP server MUST offer `opscrew_advise`, read only; the plugin's skill says when to
  use it.
- **FR-2113**: The guide MUST gain an advise page: what it reads, each kind of proposal with its
  threshold, applying, and what it doesn't do.

**Targets**
- **FR-2114**: On Hetzner and DigitalOcean servers every category applies; on the user's own
  server, Portainer and this computer, no resize or price proposals; on Cloudflare's hosting and
  GitHub Pages, upkeep only.

### Key Entities

- **Proposal:** id, category, urgency, server (when it concerns one), title, reasons (each with its
  figure and its source: one reading or 14 days), price before and after, how to apply (a plan
  change, or a command).
- **The readings:** per server, one moment (as `status`) and, with monitoring, the 14-day
  statistics.
- **The thresholds:** constants in code, named in the guide.

## Success Criteria *(mandatory)*

- **SC-2101**: On the live example, `opscrew advise` finishes within 60 seconds and changes nothing
  (the audit log holds only reads).
- **SC-2102**: A server deliberately too small for its app (live pass) gets the "larger" proposal;
  `advise --apply` and `provision` resize it; the next `advise` no longer proposes it.
- **SC-2103**: No proposal ever shrinks a server without 7 days of history (tests over the rules).
- **SC-2104**: Every price shown matches the provider's live price list for the type (tests against
  the catalogue fakes; live pass against the real one).
- **SC-2105**: No token, secret or server address appears in advise's output, JSON or MCP answer.

## Assumptions

The lead's defaults, for the founder to change:
- **The thresholds of R3:** 14 days, p95, 85% memory, 30 days for a disk and a token, 3 restarts or
  flaps.
- **No model in this version:** proposals that would need judgment come from detection and design.
- **History only from the self-hosted stack (020);** Grafana Cloud's and Beszel's later.
- **Moving to another provider** names today's `retarget` (Hetzner and DigitalOcean); AWS when it
  exists.

## Out of scope

- Applying anything without `opscrew provision`'s approval, or on a schedule.
- History from Grafana Cloud (a read token) or Beszel (no documented API).
- AWS and the hyperscalers' managed services (024).
- Block volumes to grow a disk without a larger server.
- A model's judgment on the app's code.
- A cache the app's code uses but the plan doesn't run: design adds one when analysis finds the
  client.
