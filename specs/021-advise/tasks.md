---
description: "Tasks for 021-advise"
---

# Tasks: Advise

**Input**: `specs/021-advise/`:
- spec.md, plan.md, research.md (R1–R3, and R5 from T2101), data-model.md;
- contracts/advise.md;

plus `docs/adr/0025-advise.md`, and features 000–020 (017's `status`, 020's stack above all).

**Numbering**: T2101–T2199.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.

**Rules for every task:**
- **Read only:** advise changes nothing on a server, account or repository; `--apply` writes only
  the plan. Every remote command is fixed and read-only, audited as `remote-exec`.
- **Fixtures** never contain secret-shaped literals: `fakeSecret()`, or `{{FAKE:…}}` with
  `materializeFixture()`.
- **No network in unit tests:** GitHub, Cloudflare, the providers' catalogues and the servers are
  fakes.
- **No leaks:** no token, secret value or server address in output, JSON, audit entries, snapshots or
  MCP answers. A token's expiry date is not a secret. Every task's tests include a leak check for
  what it handles.
- **Refusals** come before any change, in plain words, ending "Nothing was changed." with what to do
  next. User-facing text never names a feature number.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Neutral examples only:** `example.com`, `example-app`, `203.0.113.0/24`.

## Phase 1: Foundation

- [x] T2101 The spike and the ADR (lead): research.md R5, and `docs/adr/0025-advise.md` from Proposed to its final text.
  - **S1:** a throwaway Hetzner server moved one type up the way OpsCrew's module does it (the
    provider's default disk behaviour), timed: the downtime, whether the address stays, whether the
    disk grows, and whether it can go back down.
  - **S2:** the history queries of plan.md 3. on a real stack (the Docker pass's harness): each
    answers per server and container within a time limit; the days of history readable.
  - **S3:** with the test token, the throwaway repository's Dependabot alerts and pull requests, and
    the answer without "Dependabot alerts: read".
  - A finding that changes a design goes into plan.md before wave 1; the thresholds in data-model.md
    are confirmed or changed.

- [x] T2102 The types and the stubs, in `packages/agents/src/advise/`
  - Owns: `packages/agents/src/advise/{types.ts,index.ts}` (+ tests), the stubs `advise/{history,run,apply}.ts` and `advise/rules/{size,cost,reliability,upkeep,components}.ts` with their exports only, and the export line in `packages/agents/src/index.ts`
  - Reads: plan.md "1."; data-model.md; contracts/advise.md
  - Depends: T2101
  - Accept:
    - `Proposal`, `ProposalSchema` (zod), `Reason`, `Basis`, `PlanChange`, `ProposalPrice`,
      `Readings`, `ServerHistory`, `AdviceReport` and `THRESHOLDS` as the contract and data model
      say, exported from the agents root.
    - `ProposalSchema` parses every kind of proposal and refuses a malformed one (tests).
    - The stubs export the contract's names (functions throwing "not implemented yet").
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 2: Wave 1 (parallel)

- [x] T2103 [P] [US7] The connectors' reads: Dependabot, the check's issues, tokens' expiry, in `packages/connectors/{github,cloudflare}/`
  - Owns: `packages/connectors/github/src/**`, `packages/connectors/cloudflare/src/**` (+ tests)
  - Reads: research.md R1.4, R1.5, R5 (S3); contracts/advise.md "connectors"
  - Depends: T2101
  - Accept:
    - GitHub: `dependabotAlerts(owner, repo)`: `on` with the open alerts (severity, package and
      link), `off` for GitHub's 403 "Dependabot alerts are disabled for this repository.", and any
      other 403 a plain error naming "Dependabot alerts: Read" (R5, S3); `dependabotPulls(owner,
      repo)` (open pull requests by `dependabot[bot]`); `issuesSince(owner, repo, label, since)`
      (opened since the date, kept by `created_at`: GitHub's `since` is the last update);
      `tokenExpiry()` (the `GitHub-Authentication-Token-Expiration` header, `2026-11-27 17:25:14
      UTC` in the form GitHub sends it, as ISO 8601; `undefined` without one). Responses parsed
      with zod.
    - Cloudflare: `verifyToken()` with `status` and `expiresOn` when the answer has it.
    - `fetch` fakes only; no token in errors or logs (leak test).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github --filter=@opscrew/connector-cloudflare`
  - Effort: high

- [x] T2104 [P] [US3] The 14-day history from the self-hosted stack, in `packages/agents/src/advise/history.ts`
  - Owns: `packages/agents/src/advise/history.ts` (+ test, `advise/__fixtures__/**`)
  - Reads: plan.md "3."; research.md R1.7, R5 (S2); 020's `monitoring/status.ts` (how its fixed commands reach Prometheus) and `network/owner.ts`
  - Depends: T2102
  - Accept:
    - `readHistory(deps, plan)`: `undefined` without monitoring; otherwise one `ServerHistory` per
      server of the environment, from fixed queries on the stack's server (the owner's for a
      sender), audited as `remote-exec`, answers parsed with zod; the queries of R5 (S2) as they
      are, OOM kills included.
    - A server without enough figures has `days` below 7; a query that fails is reported, not
      fatal.
    - Tests on recorded answers; no address in output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [x] T2105 [P] [US3] [US4] [US5] The size and cost rules, with prices, in `packages/agents/src/advise/rules/{size,cost}.ts`
  - Owns: `packages/agents/src/advise/rules/{size,cost}.ts` (+ tests, fixtures)
  - Reads: plan.md "4."; data-model.md "The thresholds"; research.md R1.1, R1.2, R5 (S1); `design/{sizing,options,cost,servers}.ts` and the catalogues
  - Depends: T2102
  - Accept:
    - **a container at its limit** (`containerAtLimit`, or an OOM kill): a `memory-limit` plan
      change (`limitRaise`, rounded up to 64 MB) when the server has room, otherwise a larger server
      that holds it.
    - **size:** larger (memory p95 above `memoryHigh`, the load above the CPUs for `loadHighShare`
      of the period), the cheapest type that brings them under;
      smaller only with `minHistoryDaysToShrink` days and the next smaller type holding the p95 with
      `shrinkHeadroom`, never a smaller disk than the current one; the disk (`diskFullDays`,
      `diskHigh`); on one reading, no smaller server and every figure-based reason says so.
    - **cost:** over budget (naming which other proposals bring it under), a cheaper type with at
      least the same CPUs, memory and disk in the region, the other provider cheaper for the same
      need (names `opscrew retarget`).
    - Prices from the catalogue (live, or static with its date); before and after; tested against
      the catalogue fakes.
    - Targets: no resize or price proposal on the user's own server, Portainer or this computer.
    - Tests at each threshold's edges; the "never shrink on one reading" rule as its own test.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2106 [P] [US6] [US7] [US8] The reliability, upkeep, security and component rules, in `packages/agents/src/advise/rules/{reliability,upkeep,components}.ts`
  - Owns: `packages/agents/src/advise/rules/{reliability,upkeep,components}.ts` (+ tests, fixtures)
  - Reads: plan.md "4."; data-model.md; research.md R1.4–R1.6; `secops` host checks; 018's `services[].server`
  - Depends: T2102
  - Accept:
    - **reliability:** backups off with important or critical data (priced), the check off for prod,
      check flaps (`checkFlaps`), restart loops (`restarts`), each with its figures and command.
    - **upkeep and security:** Dependabot alerts by severity with their pull requests, the missing
      permission (a "not read" line), or the alerts off (a proposal to turn them on); pending
      security updates and a required reboot; `secure`'s failing host checks,
      most severe first; GitHub and Cloudflare tokens within `tokenDays` (`now` within 7).
    - **components:** Postgres above `databaseShare` of a short server's memory (its own server,
      priced), a filling disk with uploads on the server (object storage).
    - Cloudflare's hosting and GitHub Pages get only the upkeep proposals.
    - Tests at each threshold's edges.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [x] T2114 [P] Provision refuses a smaller disk, in `packages/agents/src/provision/`
  - Owns: `packages/agents/src/provision/disk-guard.ts` (+ test) and its call in `provision/run.ts`
  - Reads: research.md R5 (S1); `design/server-changes.ts` (`appServerChange`, `deployedExtraServers`, `extraServerChanges`), `design/run.ts` (`resolveCatalog`), `design/options.ts` (how design already keeps a type for its disk)
  - Depends: T2101
  - Accept:
    - Before its IaC plan, provision compares each deployed Hetzner or DigitalOcean server's type
      with the plan's (the app's and the extra servers'); when the new type's disk (the catalogue,
      live or static) is smaller than the current one's, it refuses before any change, for example:
      "Server app can't move from cx33 (80 GB disk) to cx23 (40 GB): Hetzner Cloud can't make a
      server's disk smaller, and the attempt would leave the server switched off. Set its
      serverType back to cx33, or pick a type with at least 80 GB of disk. Nothing was changed."
    - A larger disk, the same disk, a type the catalogue doesn't know (said as a warning, not
      refused), a new server and a replaced one (another location) are not refused.
    - Tests with catalogue fakes; nothing reaches the IaC engine when refused.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 3: Wave 2

- [x] T2107 [US1] [US2] [US4] Gathering, ordering and applying, in `packages/agents/src/advise/{readings,run,apply}.ts`
  - Owns: `packages/agents/src/advise/{readings,run,apply}.ts` (+ tests)
  - Reads: plan.md "5."; spec US1, US2, US4 and the edge cases; `status/resources.ts`, `secure/` host checks, `design/run.ts` catalogues, the plan writer `addons/run.ts` uses
  - Depends: T2103, T2104, T2105, T2106
  - Accept:
    - `runAdvise`: refuses an environment that isn't deployed; reads each source (what fails is
      listed in `notRead`, never fatal); runs the rules; orders by urgency then category; the
      `basis` per server; nothing written anywhere (fakes see no write; the audit log holds only
      reads).
    - `applyProposal`: reads again; refuses an unknown or no longer valid id before any change,
      naming the current ids; a plan proposal writes only its field and returns the summary with the
      new monthly price and "run `opscrew provision`"; a command proposal returns its command.
    - Several servers, several environments and apps, a move or retarget in progress, a proposal
      already in the plan: as the spec's edge cases.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

## Phase 4: Wave 3 (parallel)

- [x] T2108 [P] [US1] [US2] [US9] The CLI command, the MCP tool and the plugin's skill
  - Owns: `packages/cli/src/commands/advise.ts` (+ test) and its line in `commands/index.ts`, `packages/mcp-server/src/tools/advise.ts` (+ test) and its line in `server.ts`, `plugin/skills/opscrew-troubleshoot/**`
  - Reads: plan.md "6."; contracts/advise.md "CLI and MCP"
  - Depends: T2107
  - Accept:
    - `opscrew advise [--apply <id>] [--json] [--app] [--env]`, help text; text grouped by urgency,
      each proposal with its figures, prices and command; the one-reading closing line.
    - MCP `opscrew_advise`, read only (`readOnlyHint`), text and structured content; no apply.
    - The skill says when to suggest it. No token or address in any output (leak test).
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: high

- [x] T2109 [P] [US1] The guide page, in `docs/guide/advise.md`
  - Owns: `docs/guide/advise.md`, `docs/guide/index.md`, the links in `docs/guide/{logs-and-status,monitoring}.md`, the GitHub permission line in `docs/guide/security.md`
  - Reads: spec.md; plan.md; data-model.md "The thresholds"; the other guide pages for tone
  - Depends: T2107
  - Accept: what advise reads; each kind of proposal with its threshold; history and one reading;
    applying (`--apply`, then provision); that a larger server is one way and why a smaller one is
    rare (research R5, S1); the permissions it uses (Dependabot alerts: Read, also in
    `security.md`'s list); what it doesn't do. Linked from the index and the two pages.
  - Verify: `pnpm lint`
  - Effort: medium

- [x] T2110 [P] The live tests (gated on `OPSCREW_E2E_ADVISE=1` and the Hetzner token), in `packages/cli/test/live/advise.test.ts` (+ support), `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: plan.md "7."; spec SC-2101–SC-2105; the live harness and 018's or 020's pass for style
  - Depends: T2108
  - Accept: the live pass of plan.md 7., each step recorded as the coverage page records them; cleanup
    that deletes every server even when a step fails; `docs/e2e.md` says how to run it.
  - Verify: `pnpm turbo run typecheck --filter=opscrew` (the live run is T2111's)
  - Effort: high

## Phase 5: Live, simplify, release (lead)

- [ ] T2111 The live runs (lead): T2110's pass, then `docs/e2e-coverage.md` updated per run. Findings become tasks.
- [ ] T2112 The simplify pass (lead): reviewers by area over the whole feature's diff; real findings become tasks.
- [ ] T2113 The release (lead): `docs/releasing.md`, from the changelog to the plugin bump and the docs site sync (0.2.2: nothing to redo).

## Dependencies

T2101 → T2102 → {T2103, T2104, T2105, T2106, T2114} → T2107 → {T2108, T2109, T2110} → T2111 →
T2112 → T2113. T2103 and T2114 need only T2101 and can start with T2102.
