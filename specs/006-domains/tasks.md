---
description: "Tasks for 006-domains"
---

# Tasks: Buying domains through Cloudflare

**Input**: `specs/006-domains/` (spec.md, plan.md, research.md) + features 000–005.
**Numbering**: T601–T699. **Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends /
Accept / Verify / Effort`. Lead-owned contracts, schemas and stubs come from T601. Fixtures never
contain secret-shaped literals; user-facing text never puts a colon directly after an environment
variable name. Tasks touching the CLI wait for feature 005's CLI task (T509).

## Phase 1: Foundation (lead, serial)

- [X] T601 Registrar contract, `domain-purchase`/`domain-settings` approval kinds, `plan.dns.registration`, domain stubs, constitution amendment 1.1.0 and ADR 0008 (lead) in `packages/contracts/src/{safety,registrar,index}.ts`, `packages/plan-schema/src/**` (+ JSON Schemas), `packages/agents/src/domain/index.ts`, `packages/agents/src/index.ts`, `.specify/memory/constitution.md`, `docs/adr/0008-registrar-seam.md`
  - Accept: plan.md "Contracts"; `--yes` cannot approve the new kinds (test in `packages/cli/src/approval.test.ts`); `pnpm check` passes.
  - Effort: lead

## Phase 2: Building blocks (parallel)

- [X] T602 [P] [US1] [US3] Cloudflare Registrar client and `CloudflareRegistrar` in `packages/connectors/cloudflare/src/`
  - Owns: `packages/connectors/cloudflare/src/**`
  - Reads: plan.md "Cloudflare Registrar client"; research.md "Cloudflare Registrar API"; `packages/contracts/src/registrar.ts`
  - Depends: T601
  - Accept: every method with fake fetch (paths incl. sandbox, `Prefer: respond-async`, 201/202 handling, workflow states, 404 → undefined, zone "already exists" → existing zone, string prices → `Money`, reason codes → plain English); `CloudflareRegistrar satisfies Registrar`; errors plain, token-free; credentials list the Registrar and zone-create permissions; existing tests unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare`
  - Effort: high

- [X] T603 [P] [US1] [US2] [US3] Search, buy, status and auto-renew in `packages/agents/src/domain/`
  - Owns: `packages/agents/src/domain/**`
  - Reads: spec.md; plan.md "Orchestration"; `packages/contracts/src/registrar.ts`; `packages/agents/src/provision/credentials.ts` (Cloudflare setup patterns)
  - Depends: T601
  - Accept: with a fake `Registrar` and fake zone/DNSSEC calls: happy path; approval `domain-purchase` with `confirmPhrase` before any create (SC-601); `maxPrice` bound; price re-check; interruption after the purchase record / after create / during polling → no second create (SC-602); `action_required`/`blocked`/`failed`; premium/unavailable/needs-dashboard stops; multiple accounts; zone exists; requirements and plan updated (other domain → confirmation); audit without contact data; status and auto-renew (`domain-settings` approval).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [X] T604 [P] [US3] Registrar access in the init checklist in `packages/agents/src/init/`
  - Owns: `packages/agents/src/init/**`
  - Reads: spec.md US3 AS3, FR-607
  - Depends: T601, T602
  - Accept: the Cloudflare check reports Registrar access (yes / missing permission with the fix) as a warning, online only; offline says it was not checked; existing init tests keep their meaning.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

## Phase 3: Interfaces

- [ ] T605 [US1] [US2] [US3] `opscrew domain` commands in `packages/cli/src/`
  - Owns: `packages/cli/src/commands/domain.ts` and its test, the command registration and program test, `packages/cli/src/approval.ts` (typed purchase confirmation)
  - Reads: spec.md FR-601, FR-604; plan.md "CLI"
  - Depends: T603, feature 005 T509
  - Accept: the four subcommands with exit codes (0 done, 1 stopped on purpose, 2 error); interactive typed confirmation; non-interactive requires `--confirm` and `--max-price`; `--yes` never buys; next-step hints; the bundle builds.
  - Verify: `pnpm turbo run typecheck test build --filter=opscrew`
  - Effort: high

- [X] T606 [P] [US4] `opscrew_domain_check`, skill and README in `packages/mcp-server/src/`, `plugin/`, `README.md`
  - Owns: `packages/mcp-server/src/**`, `plugin/**`, `README.md`
  - Reads: spec.md US4, FR-608
  - Depends: T603
  - Accept: read-only tool annotated, output redacted, errors mapped; no purchase tool; skill says buying is terminal-only (`npx opscrew domain buy`); `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: medium

## Phase 4: Verification

- [ ] T607 Sandbox purchase test and docs (lead) in `packages/cli/test/live/**` or `packages/connectors/cloudflare/test/live/**`, `docs/e2e.md`
- [ ] T608 Feature verification (lead): `pnpm check`, bundle smoke test, converge review against FR-601..FR-609

## Dependencies & waves

- T601 first (serial, lead).
- Wave A (parallel): T602, T603; then T604.
- T605 after T603 and feature 005's T509; T606 after T603.
- T607, T608 by the lead.
