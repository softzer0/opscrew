# Implementation Plan: Advise

**Branch**: `main` | **Date**: 2026-11-04 | **Spec**: `specs/021-advise/spec.md`
**Research**: `specs/021-advise/research.md` (R1–R3; the spike adds R5)

The founder gave the go-ahead on 2026-11-04.

## Summary

`opscrew advise` reads an environment and lists priced proposals; `--apply <id>` writes the plan
for the ones the plan holds, and `opscrew provision` applies them as always.

- **Readings** (read only): per server, one moment as `status` reads it (`readServerResources`);
  with the self-hosted stack (020), 14 days of statistics through fixed Prometheus queries on the
  stack's server; the plan, the interview's answers, live prices (the design catalogues); GitHub's
  Dependabot alerts and pull requests, the scheduled check's issues of the last 14 days, and the
  GitHub and Cloudflare tokens' expiry; `secure`'s host checks.
- **Rules** (pure functions, deterministic): size, cost, reliability, upkeep and security,
  components. Each turns the readings into proposals with their figures, prices and how to apply.
- **Applying:** a proposal the plan holds becomes a plan edit (server type, backups, the scheduled
  check); the others name their command.
- **Surfaces:** the CLI command with `--json`, the MCP tool `opscrew_advise` (read only), the
  plugin's skill, a guide page.

## Technical Context

- **Stack:** the same as 000–020. **No new npm dependency, no new image, no new IaC module.**
- **No change in `@opscrew/contracts`, `plan-schema` or the IaC templates:** proposals are an
  agents type, exported from its root for the CLI and MCP.
- **Connectors gain read calls:** GitHub (Dependabot alerts, Dependabot's open pull requests, the
  check's issues since a date, the token's expiry header), Cloudflare (the token's verify answer
  with `expires_on`).
- **The spike (T2101, research R5):**
  - **S1, resizing at Hetzner through OpsCrew's module:** a move up keeps both addresses, grows the
    disk with the type (the filesystem follows at boot), and can't be undone: Hetzner refuses a
    type with a smaller disk, and the failed attempt leaves the server switched off. So the
    "larger" proposal says it is one way, the "smaller" rule keeps to types with at least the
    current disk, and provision refuses a smaller disk before any change (T2114).
  - **S2, the history queries:** settled on 14 days of backfilled figures in the pinned
    Prometheus under the stack's limits (plan.md 3.); restarts per container checked on real
    Docker with the pinned Alloy.
  - **S3, GitHub with the test tokens:** three answers for Dependabot alerts (the alerts, off, no
    permission), the expiry header's own date format, and the check's issues filtered by opening.
- **Tests:** unit tests over each rule with fixture readings (thresholds at their edges, the
  "never shrink on one reading" rule, prices against the catalogue fakes); connector tests with
  `fetch` fakes; the history parser on recorded answers; the CLI and MCP with fakes; a gated live
  pass (T2110).

## Constitution Check

- **I (safety gate):** advise changes nothing. `--apply` writes only the plan (as `addon enable`
  does); `opscrew provision` shows the change and applies it after its hash is approved. A resize
  stays an IaC plan with the provider's restart warning.
- **II (user owns everything):** the plan stays plain YAML; advise writes nothing else.
- **III (dual engine):** no new module.
- **IV (secrets):** tokens are used only by their connectors; no token, secret or server address in
  output, JSON, audit or MCP answers (leak tests). The token's expiry date is not a secret.
- **V (deterministic first):** every rule is code; no model in this version (research R3.6).
- **VI (contracts first):** the proposal type and the readings' type are one serial task (T2102),
  in agents, with the stubs the waves fill.
- **VIII (typed adapters):** reads through the existing connectors and the host adapter's fixed
  commands; the plan written through the plan's own writer.
- **IX (plain language):** each proposal says why with its figures, the price before and after, and
  the exact command.
- **X (simplicity):** one command; rules as pure functions; no history store (020's stack is the
  history); no model.

## Project Structure

```text
packages/connectors/github/src/      Dependabot alerts and pulls, the check's issues since, token expiry (T2103)
packages/connectors/cloudflare/src/  the token's verify answer with expires_on (T2103)
packages/agents/src/advise/
  types.ts                           Proposal, Readings, thresholds, ids (T2102)
  index.ts                           exports (T2102 stubs)
  history.ts                         the 14-day queries on the stack, parsed (T2104)
  rules/size.ts, rules/cost.ts       sizing and cost rules with prices (T2105)
  rules/reliability.ts, rules/upkeep.ts, rules/components.ts   (T2106)
  readings.ts, run.ts, apply.ts      gathering, ordering, applying (T2107)
packages/agents/src/provision/disk-guard.ts   refusing a smaller disk before the IaC plan (T2114)
packages/cli/src/commands/advise.ts  the command (T2108)
packages/mcp-server/src/tools/advise.ts   opscrew_advise (T2108)
plugin/skills/opscrew-troubleshoot   when to suggest advise (T2108)
docs/guide/advise.md                 the guide page (T2109)
packages/cli/test/live/advise.test.ts     the live pass (T2110)
docs/adr/0025-advise.md              (lead, T2101)
```

## Design

### 1. The types (T2102, serial)

`agents/src/advise/types.ts` (data-model.md, contracts/advise.md):
- `Proposal`: `id` (stable: `<category>.<server>.<what>`, for example `size.app.larger`), `category`
  (`size`, `cost`, `reliability`, `upkeep`, `security`, `components`, `moving`), `urgency`
  (`now`, `soon`, `when-convenient`), `server?`, `title`, `reasons: Reason[]` (each a sentence with
  its figure and its `basis`: `history` with its days, or `one-reading`), `price?: { before, after,
  currency, source, asOf? }`, `apply: { kind: "plan", change } | { kind: "command", command }`.
- `Readings`: per server `{ now: ResourceReading, history?: ServerHistory }`, the plan, the
  requirements, the prices (offers per provider and location), `upkeep` (Dependabot, tokens,
  security updates, host checks), `check` (the issues of 14 days), and what couldn't be read.
- `THRESHOLDS`: the constants of R3 (data-model.md).
- Stubs for the waves (`history.ts`, the rule files, `run.ts`, `apply.ts`) with their exports, so
  parallel tasks never edit the same `index.ts`.

### 2. The spike and the ADR (T2101, lead)

S1–S3 above; one line per question in research.md "R5". ADR 0025 records R3 as decided.

### 3. The history (T2104)

`readHistory(deps, plan)`: only when monitoring is on; on the stack's server (the owner's for a
sender, through `monitoringOwner`), fixed instant queries through Prometheus inside its container,
as `monitoringStatus` runs them (one command, the queries separated by markers), audited as
`remote-exec`, answers parsed with zod. Per `app`, `env`, `server` of this environment, the queries
of research R5 (S2), each checked against known figures:
- `days` (how far back the figures go), `cpuP95`, `memoryP95`, `loadOverCpus` (the share of the
  period the 15-minute load passed the CPUs), `diskFullInDays` (from the last 7 days' trend; no
  answer for a disk that isn't filling);
- per container (`service`): the p95 and the maximum of its working set, its current limit, its
  restarts (per container, so a deploy isn't one; the containers dashboard counts deploys too), and
  its OOM kills.
A server whose figures stopped answers no limit and no disk projection: listed as not read.

### 4. The rules (T2105, T2106)

Each rule is `(readings) => Proposal[]`, pure, tested on fixtures at the thresholds' edges.
- **size:** larger (memory p95 > 85% of the server, or the load above the CPUs for 25% of the
  period), smaller (history ≥ 7 days, and a smaller type at the same provider and location holds
  the p95 CPU and memory with 40% headroom and the containers' limits as design sizes them (not
  the interview's users band, which the figures replace), and its disk is not smaller than the
  current type's; never on one reading), the disk (full within 30 days, or ≥ 85% now; with a
  larger proposal, one type for both). The target type is the cheapest from the catalogue that
  meets the need; prices from `pricedOffer`. A larger type says what S1 found: the app offline one
  to three minutes at Hetzner (R5), about a minute per GB of disk in use at DigitalOcean (R1.1),
  the same addresses, and no way back to the current type (its disk grows). A short server with no
  larger type in the price list (or not resizable by OpsCrew) still gets the proposal, unpriced,
  naming what it needs.
- **cost:** over budget (the environment's monthly price against `budgetMonthly`, naming which other
  proposals bring it under); a cheaper type with at least the same CPUs, memory and disk in the same
  region; the other provider cheaper for the same need (names `opscrew retarget`).
- **reliability:** backups off with important or critical data; the check off for prod; check flaps
  (3 or more issues opened in 14 days); restart loops (3 or more in 14 days, or the count on one
  reading).
- **a container at its limit** (its maximum at 95% of it, or an OOM kill): a higher limit in the
  plan (`memory-limit`: 1.5 times, rounded up to 64 MB) when the server's p95 memory plus the raise
  stays under 85%, otherwise a larger server that holds both.
- **upkeep and security:** Dependabot alerts by severity, with their open pull requests (or the
  missing permission, or the alerts off: a proposal to turn them on in the repository's settings);
  pending security updates and a required reboot; `secure`'s failing host
  checks, most severe first; GitHub and Cloudflare tokens expiring within 30 days.
- **components:** Postgres's share of a short server's memory (p95 of its container) above 50%,
  proposing its own server (018) priced; a filling disk while the plan keeps uploads on the server,
  proposing object storage. (A cache the code uses is design's: it adds one when analysis finds
  the client.)
- **Targets:** the user's own server, Portainer and this computer get no resize or price proposals;
  Cloudflare's hosting and GitHub Pages only upkeep.

### 5. Gathering, ordering, applying (T2107)

- `runAdvise(deps, plan, options)`: refuses an environment that isn't deployed; reads everything of
  plan.md "Summary" (each source optional: what couldn't be read is listed, never fatal), runs the
  rules, orders by urgency then category, and returns `AdviceReport` (`proposals`, `checked`,
  `basis`: `history` with days or `one-reading`, `notRead`).
- `applyProposal(deps, plan, id)`: reads again, finds the proposal by id (refusing an unknown or no
  longer valid one, naming the current ids), and for a plan proposal writes the plan through its
  writer (the server's `serverType`, a container's `memoryMb`, the server's `backups`,
  `observability.check.enabled`); prints the new
  monthly price and "run `opscrew provision`". A command proposal prints its command.
- The audit log holds only reads (and the plan write with `--apply`).

### 5b. Provision refuses a smaller disk (T2114)

Research R5 (S1): Hetzner refuses a type with a smaller disk only after the provider has switched
the server off, and leaves it off. Design already never offers such a type to a deployed server;
a plan edited by hand would still reach the provider. So provision, before its IaC plan, compares
each deployed server's type with the plan's (design's `appServerChange`, `deployedExtraServers`,
`extraServerChanges`) and the two disks in the provider's catalogue (`resolveCatalog`), and
refuses a smaller one before any change. Known edges, not guarded: a first apply that failed after
creating the server (no `lastApplyAt` yet; the server is new and empty), and `terraform.tfvars.json`
left by a `--plan-only` run older than the guard.

### 6. Surfaces (T2108), the guide (T2109)

- **CLI:** `opscrew advise [--apply <id>] [--json] [--app] [--env]`; text grouped by urgency, each
  proposal with its figures, prices and command; the closing line for one reading.
- **MCP:** `opscrew_advise` (read only, `readOnlyHint`), the report as text and structured content;
  applying stays a terminal command.
- **The skill:** when to suggest it.
- **The guide:** `docs/guide/advise.md`: what it reads, each proposal with its threshold, applying,
  history and one reading, what it doesn't do; linked from the index, `logs-and-status.md` and
  `monitoring.md`.

### 7. The live pass (T2110)

Gated on `OPSCREW_E2E_ADVISE=1` and the Hetzner token: the example with Postgres on the smallest
type with backups off and important data; `advise` lists the backups proposal (and others the
reading supports); `advise --apply` writes the plan; `provision` applies it after approval; the next
`advise` no longer lists it; nothing changed by `advise` itself (the audit log); a leak search; the
duration (SC-2101). The resize path (SC-2102) uses the type S1 confirms.

## Order

T2101 (lead) → T2102 → wave 1 {T2103, T2104, T2105, T2106, T2114} → wave 2 {T2107} → wave 3
{T2108, T2109, T2110} → T2111 (live runs, lead) → T2112 (simplify, lead) → T2113 (release, lead).

## Complexity Tracking

| Item | Why it's needed | Simpler alternative rejected because |
|---|---|---|
| History from Prometheus queries | Sizing down safely needs two weeks of figures (R1.2). | Storing `status` readings locally gives a history only of the moments the user ran it. |
| `--apply` writing the plan | Advice translated into plan edits by hand is where users err. | Printing the YAML to edit leaves the type names and prices to copy by hand. |
