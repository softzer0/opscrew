---
description: "Tasks for 005-retarget"
---

# Tasks: Retarget

**Input**: `specs/005-retarget/` (spec.md, plan.md, research.md) + features 000–004.
**Numbering**: T501–T599. **Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends /
Accept / Verify / Effort`. Lead-owned contracts, schemas, types and stubs come from T501; fill only
your files. Fixtures never contain secret-shaped literals (`fakeSecret()` / `{{FAKE:…}}` +
`materializeFixture()`). User-facing text never puts a colon directly after an environment
variable name (the redactor masks what follows).

## Phase 1: Foundation (lead, serial)

- [X] T501 Contracts, schemas, layout type, retarget stubs and ADR 0007 (lead) in `packages/contracts/src/{iac,runtime}.ts`, `packages/plan-schema/src/**` (+ JSON Schemas), `packages/iac-templates/src/types.ts`, `packages/agents/src/retarget/index.ts`, `packages/agents/src/index.ts`, `docs/adr/0007-retarget-in-one-state.md`
  - Accept: plan.md "Contracts and schemas"; existing artefacts parse; `pnpm check` passes.
  - Effort: lead

## Phase 2: Building blocks (parallel)

- [X] T502 [P] [US1] [US2] Moved resources in plan summaries in `packages/iac-engine/src/`
  - Owns: `packages/iac-engine/src/**`, `packages/iac-engine/test/**`
  - Reads: plan.md "Engine"; research.md "`moved` blocks"; `packages/contracts/src/iac.ts`
  - Depends: T501
  - Accept: `PlanSummary.moves` from `previous_address` (pure moves are not changes; a moved and updated resource is both); recorded `show -json` fixtures for OpenTofu and Terraform; gated integration test (both binaries, `terraform_data`) for the rename-only plan (moves, no changes), a create plan and a removed-module destroy plan.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-engine`
  - Effort: high

- [X] T503 [P] [US1] [US2] Move layouts in the root module and the runbook section in `packages/iac-templates/`
  - Owns: `packages/iac-templates/{src,modules,scripts}/**` (except `src/types.ts`, lead), their tests and snapshots
  - Reads: plan.md "Templates"; research.md; `packages/iac-templates/src/types.ts` (`InfraLayout`)
  - Depends: T501
  - Accept: the six layouts of plan.md for Hetzner → DigitalOcean and DigitalOcean → Hetzner (modules, `moved` blocks, both provider blocks and modules, previous variables incl. `previous_delete_protection` for a Hetzner previous server, DNS and outputs following `live`, `other_server_*` outputs); without a layout byte-identical output (existing snapshots unchanged); snapshots per layout; the gated validate test validates every layout under both engines (`OPSCREW_IT=1`); runbook section "Moving to another provider".
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T504 [P] [US1] Workflow dispatch and run lookup in `packages/connectors/github/src/`
  - Owns: `packages/connectors/github/src/**`
  - Reads: plan.md "GitHub connector"; research.md "GitHub workflow dispatch"
  - Depends: T501
  - Accept: `dispatchWorkflow` (200 with `workflow_run_id`, 204), `getWorkflowRun`, `listWorkflowRuns` filters `event`/`createdSince`, `waitForWorkflowRun` (by id; else the newest `workflow_dispatch` run on the ref created since the dispatch; completed success/failure/cancelled; timeout) with fake fetch and fake clock; errors plain and token-free.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github`
  - Effort: medium

- [X] T505 [P] [US2] Reusable deletion helpers and the move guard in `packages/agents/src/destroy/`
  - Owns: `packages/agents/src/destroy/**`, `packages/cli/src/ui/__fixtures__/destroy.ts`
  - Reads: plan.md "Destroy pieces"; `specs/003-day2-operations/plan.md` "Destroy orchestration"
  - Depends: T501
  - Accept: exported helpers with explicit inputs (address prefix, provider, app name, server ids from plan JSON, root variable name, hosts) covering preview, snapshot with reuse record, restricted protection lift, typed confirmation, host-key removal; `opscrew destroy` behaviour and all its tests unchanged in meaning; destroy stops with `PHASE_PRECONDITION` while `plan.retarget` exists (message names continue/finish/abort).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew`
  - Effort: high

- [X] T506 [P] [US1] [US2] Applying moves-only plans and the move guards in `packages/agents/src/{provision,design,dns,drift}/`
  - Owns: `packages/agents/src/{provision,design,dns,drift}/**`
  - Reads: plan.md "Provision, design, dns, drift"
  - Depends: T501
  - Accept: `planAndApply` applies a plan with moves and no changes after an `iac-apply` approval titled as a state rename with nothing changing in the cloud (and `planOnly`/`approvePlanHash` work for it); "up to date" only without changes and moves; provision, design, dns and drift stop with `PHASE_PRECONDITION` while `plan.retarget` exists; existing tests keep their meaning.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [X] T507 [P] [US1] Typed server operations for the move in `packages/agents/src/retarget/server-ops.ts`
  - Owns: `packages/agents/src/retarget/server-ops.ts`, `packages/agents/src/retarget/server-ops.test.ts`
  - Reads: plan.md "Server operations"; research.md "What has to move"; `packages/agents/src/shared/{remote,wait}.ts`
  - Depends: T501
  - Accept: each operation of plan.md with a fake `RemoteExec` and fake runner (exact commands, working directory, `umask`, quoting, IPv6 brackets for `scp -3`, known_hosts and key options, timeouts scaled to the database size); failures as plain `OpsCrewError`s with redacted, truncated stderr and never dump contents; `waitAppHealthy` with fake clock.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 3: Orchestration

- [X] T508 [US1] [US2] [US3] The move: start, rename, create, deploy, migrate, switch, finish and abort in `packages/agents/src/retarget/`
  - Owns: `packages/agents/src/retarget/**` (except `server-ops*.ts`)
  - Reads: spec.md; plan.md "Orchestration"; the helpers from T502–T507
  - Depends: T502–T507
  - Accept: every step of plan.md with fakes (engine with saved plans, provider checks, GitHub, remote, runner, clock): happy path Hetzner → DigitalOcean and DigitalOcean → Hetzner; interruption after each step and resume (SC-503); maintenance failure rolls back to the old app; failed switch rolls back; no Postgres → no maintenance window; DNS other/none → manual switch; finish (snapshot, Hetzner unprotect, preview-bounded destroy, host keys, PR, plan cleared) and abort before the switch (new removed, secrets restored, renamed back, target restored); abort refused after the switch; non-interactive stops with hashes and continues with `--approve`; every apply preceded by its approval and every deletion by the typed name (SC-502); no token or dump content in reporter or audit output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

## Phase 4: Interfaces (parallel)

- [ ] T509 [P] [US1] [US2] [US3] [US4] `opscrew retarget` command, status line and an end-to-end move in `packages/cli/`
  - Owns: `packages/cli/src/**` (except `src/ui/__fixtures__/destroy.ts`), `packages/cli/test/e2e/**`
  - Reads: spec.md FR-501, FR-511; plan.md "CLI"
  - Depends: T508
  - Accept: flags and exit codes as for destroy/provision (0 done, 1 stopped on purpose, 2 error); interactive picker, summary prompt and typed confirmation; non-interactive hash stops; `opscrew status` shows the move; e2e with fakes: Hetzner → DigitalOcean start → switched → finish, and an abort; the bundle builds.
  - Verify: `pnpm turbo run typecheck test build --filter=opscrew`
  - Effort: high

- [X] T510 [P] [US4] Deploy skill, README and MCP texts about moving providers in `plugin/`, `README.md`, `packages/mcp-server/src/`
  - Owns: `plugin/**`, `README.md`, `packages/mcp-server/src/**`
  - Reads: spec.md US4, FR-511
  - Depends: T508
  - Accept: the skill explains that moves are terminal-only and how to run, finish and abort them; README mentions `opscrew retarget`; no MCP tool performs a move; `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: medium

## Phase 5: Verification

- [ ] T511 Live move Hetzner → DigitalOcean with data check, finish and teardown (lead) in `packages/cli/test/live/**`, `docs/e2e.md`
- [ ] T512 Feature verification (lead): `pnpm check`, bundle smoke test, converge review against FR-501..FR-512

## Dependencies & waves

- T501 first (serial, lead).
- Wave A (parallel): T502, T503, T504, T505, T506, T507.
- T508 after Wave A.
- Wave B (parallel): T509, T510.
- T511, T512 by the lead.
