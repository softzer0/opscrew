---
description: "Tasks for 004-digitalocean"
---

# Tasks: DigitalOcean Droplets

**Input**: `specs/004-digitalocean/` (spec.md, plan.md, research.md) + features 000–003 (packages
and conventions).
**Numbering**: T401–T499. **Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends /
Accept / Verify / Effort`. Lead-owned contracts, schemas, the provider seam, barrels and
placeholders come from T401 and T405; fill only your files. Fixtures never contain secret-shaped
literals (`fakeSecret()` / `{{FAKE:…}}` + `materializeFixture()`); a DigitalOcean token is
`fakeSecret("digitalocean-token")`.

## Phase 1: Foundation (lead, serial)

- [X] T401 Contracts, schemas, fake token kind, DigitalOcean package skeleton, lockfile and ADR 0006 (lead) in `packages/contracts/src/connector.ts`, `packages/plan-schema/src/**` (+ regenerated JSON Schemas), `packages/core/src/testing/fake-secrets.ts`, `packages/connectors/digitalocean/{package.json,tsconfig.json,src/index.ts}`, `packages/{agents,cli}/package.json`, `pnpm-lock.yaml`, `docs/adr/0006-vps-provider-seam.md`
  - Accept: plan.md "Contracts and schemas"; every existing artefact and fixture still parses; `pnpm check` passes.
  - Effort: lead

## Phase 2: Packages (parallel)

- [X] T402 [P] [US1] [US2] DigitalOcean client, catalogue, static prices and connector in `packages/connectors/digitalocean/src/`
  - Owns: `packages/connectors/digitalocean/src/**`
  - Reads: plan.md "DigitalOcean connector"; research.md "API v2", "Token scopes", "Pricing"; `packages/connectors/hetzner/src/**` (mirror its structure, errors and tests); `packages/contracts/src/connector.ts`
  - Depends: T401
  - Accept: every client method with fake fetch (headers, paths, pagination until no next page or an empty page, zod validation, lenient on unknown fields); 401/403 (scope list)/404/422/429 (waits until `ratelimit-reset`, at most 60 s, retries once) and network errors as plain `OpsCrewError`s that never contain the token; catalogue maps Basic regular and CPU-Optimized sizes only, filters by `available` and region, USD prices, extras per plan.md; static catalogue dated `2026-10-12`; connector: token order `DIGITALOCEAN_TOKEN` then `DIGITALOCEAN_ACCESS_TOKEN`, redactor registration, `verifyCredentials` (active / warning / locked / unverified email; identity never the email), `configured`, `catalog()` live vs static, `servers.findAppServers` (both tags required), `servers.snapshotServer` (action → wait → errored/timeout errors → snapshot found by name → id as string), read-only tools; `satisfies VpsConnector`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-digitalocean`
  - Effort: high

- [X] T403 [P] [US2] Hetzner connector implements `VpsConnector` (`configured`, `servers`) in `packages/connectors/hetzner/src/`
  - Owns: `packages/connectors/hetzner/src/**`
  - Reads: plan.md "Hetzner connector"; `packages/contracts/src/connector.ts`
  - Depends: T401
  - Accept: `servers.findAppServers` uses label selector `managed-by=opscrew,app=<app>` and returns string ids; `servers.snapshotServer` creates the snapshot with the request's description and labels, waits (request timeout, default 15 min), returns the image id as a string, and surfaces action errors; `servers` undefined without a token; `configured`; existing tests unchanged in meaning; `satisfies VpsConnector`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-hetzner`
  - Effort: medium

- [X] T404 [P] [US1] [US2] DigitalOcean module, provider-aware root rendering and runbook in `packages/iac-templates/`
  - Owns: `packages/iac-templates/modules/**`, `packages/iac-templates/src/**`, `packages/iac-templates/scripts/**`, their tests and snapshots
  - Reads: plan.md "Templates"; research.md "Terraform provider", "Behaviour that differs from Hetzner"; `packages/plan-schema/src/plan.ts`
  - Depends: T401
  - Accept: `modules/digitalocean-droplet/` per plan.md (tags, SSH key, Droplet with conditional daily backup policy, ipv6, monitoring, ignore_changes, firewall with explicit outbound rules, outputs); identical cloud-init copies enforced by a test; root module rendered by provider with no `delete_protection` for DigitalOcean and DigitalOcean tags; only used modules vendored; snapshots for a DigitalOcean plan with and without Cloudflare and with backups on/off; Hetzner snapshots unchanged; regenerated `src/generated/modules.ts`; runbook provider-aware with Hetzner text unchanged; the gated validate test runs the DigitalOcean root under both engines (skips with a clear message without binaries or network).
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T406 [P] [US1] [US2] DigitalOcean plan policies, token secret rule, redactor pattern and provider-neutral hardening texts in `packages/secops/src/`, `packages/core/src/redact.ts`
  - Owns: `packages/secops/src/**`, `packages/core/src/redact.ts`, `packages/core/src/redact.test.ts`
  - Reads: plan.md "Security checks"; existing Hetzner policies in `packages/secops/src/policies/plan.ts`
  - Depends: T401
  - Accept: policies per plan.md over recorded `show -json` documents for a DigitalOcean plan (firewall attached via configuration references, no firewall → finding, SSH open to the world → finding unless planned, backups mismatch → finding); Hetzner policy results unchanged; `opscrew scan` flags a seeded `fakeSecret("digitalocean-token")` with masked evidence; the redactor masks the token by value in any text; hardening and probe texts no longer assume Hetzner (neutral wording, or a new optional provider-name parameter so existing callers in `agents` still compile).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops --filter=@opscrew/core`
  - Effort: medium

## Phase 3: Provider seam (lead, serial)

- [X] T405 Provider profiles, `vpsConnector`, `services.provider` rename and `checkProvider` (lead) in `packages/agents/src/providers/**`, `packages/agents/src/provision/{types,credentials}.ts` and the `checkHetzner` call sites (provision, drift, init), `packages/agents/src/index.ts`, tests and fixtures that use the old key (agents, `packages/cli/src/ui/__fixtures__/deploy.ts`, `packages/mcp-server/src/tools/deploy.test.ts`)
  - Depends: T402, T403
  - Accept: plan.md "Provider seam"; `pnpm check` passes with Hetzner behaviour unchanged.
  - Effort: lead

## Phase 4: Agents (parallel)

- [X] T407 [P] [US1] [US3] Provider-aware design in `packages/agents/src/design/`
  - Owns: `packages/agents/src/design/**`
  - Reads: plan.md "Design"; spec US1 AS2, US3; `packages/agents/src/providers/**`
  - Depends: T405
  - Accept: DigitalOcean options from a fake catalogue (region mapping incl. the eu-north note, USD prices, 30 % daily backups, approximate EUR budget conversion labelled), static fallback labelled with its date and the token hint, option ids `digitalocean-single-<size>-<location>`, `plan.target` with `provider: digitalocean` and `image: ubuntu-24-04-x64`; Hetzner options and plans unchanged (existing tests); a live deployment with a different requested provider stops with `PHASE_PRECONDITION` and leaves `plan.yaml` untouched; a destroyed deployment may switch.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [X] T408 [P] [US1] [US2] Provider-aware provision, drift, init, secure and verify in `packages/agents/src/{provision,drift,init,secure,verify,dns,shared}/`
  - Owns: `packages/agents/src/{provision,drift,init,secure,verify,dns,shared}/**` (except the T405 files `provision/types.ts` and `provision/credentials.ts`, which may only gain hint text); the check-id assertion in `packages/mcp-server/src/tools/init.test.ts`
  - Reads: plan.md "Provision, drift, init, secure, verify"; spec US1 AS3–AS4, US2 AS2–AS4, edge cases; `packages/agents/src/providers/**`
  - Depends: T405
  - Accept: a DigitalOcean plan provisions end to end with fakes (fake engine with `digitalocean_*` changes, fake provider check); unavailable-size, server-limit and missing-scope errors give provider-specific hints; labels and PR body name the provider; drift on a DigitalOcean plan reports `digitalocean_firewall` drift; init: the provider check per plan.md for planned DigitalOcean, planned Hetzner, no choice with one token, both tokens, none, and `--offline`; secure and verify hints name the provider's console; no token value in reporter or audit output (seeded fake token); Hetzner tests unchanged in meaning.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [ ] T409 [P] [US2] Provider-neutral destroy with the DigitalOcean flow in `packages/agents/src/destroy/`
  - Owns: `packages/agents/src/destroy/**`, `packages/cli/src/ui/__fixtures__/destroy.ts`
  - Reads: plan.md "Destroy"; spec US2 AS1, FR-407, edge cases; `packages/agents/src/providers/**`; research.md "Behaviour that differs from Hetzner"
  - Depends: T405
  - Accept: DigitalOcean happy path (preview says no delete protection; confirm; snapshot through `ServerSnapshotApi`; no unprotect plan or `-var delete_protection`; destroy plan with `allowDestroy` + typed name; secrets and host key removed; report mentions retained backups and snapshot billing); Droplet already gone → snapshot skipped with a note; snapshot error or timeout → nothing deleted; reuse record with string ids, and a 003 record with a numeric image id still reused; `snapshotId` in the result; the snapshot (both providers) is appended to the audit log; no DigitalOcean token value in reporter or audit output (seeded fake token); every existing Hetzner destroy test keeps its meaning (protection lift, restricted unprotect plan, preview-bounded destroy, read-only passphrase); no `apply` before its approval.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew`
  - Effort: xhigh

- [X] T410 [P] [US1] Provider question in the interview in `packages/agents/src/interview/`
  - Owns: `packages/agents/src/interview/**`
  - Reads: plan.md "Interview"; spec US1 AS1; `packages/agents/src/providers/**` (`providerFromTokens`)
  - Depends: T405
  - Accept: the question per plan.md before `region`; default from the previous answer, then the single token set, then Hetzner; answers files accept `provider` (case-insensitive) and reject other values with the valid list; requirements always record the provider; existing interview tests keep their meaning.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

## Phase 5: Interfaces (parallel)

- [ ] T411 [P] [US1] [US2] Provider-neutral CLI texts and a DigitalOcean end-to-end run in `packages/cli/`
  - Owns: `packages/cli/src/**` (except `src/ui/__fixtures__/destroy.ts`), `packages/cli/test/e2e/**`
  - Reads: spec FR-409, SC-402; plan.md "CLI, MCP, plugin, docs"
  - Depends: T407–T410
  - Accept: help and messages name no provider where both apply (`--snapshot` "Take a snapshot of the server first"); the e2e suite runs one example through interview (answers file with `provider: digitalocean`) → design → adapt → provision with fakes and asserts the DigitalOcean root module, plan target and outputs; existing e2e and command tests pass; the bundle builds.
  - Verify: `pnpm turbo run typecheck test build --filter=opscrew`
  - Effort: high

- [ ] T412 [P] [US4] Provider-neutral MCP texts, DigitalOcean init-check test, plugin skill and README in `packages/mcp-server/src/`, `plugin/`, `README.md`
  - Owns: `packages/mcp-server/src/**`, `plugin/**`, `README.md`
  - Reads: spec US4, FR-409
  - Depends: T407–T410
  - Accept: MCP descriptions and messages name both providers or the planned one; `opscrew_init_check` with a DigitalOcean plan checks `DIGITALOCEAN_TOKEN` and never prints its value; the deploy skill and plugin keywords mention DigitalOcean; README lists DigitalOcean as supported; `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: medium

## Phase 6: Verification

- [X] T413 Live test for DigitalOcean with teardown through `opscrew destroy --confirm` and API cleanup by tag as the fallback (lead) in `packages/cli/test/live/**`, `docs/e2e.md`
- [ ] T414 Feature verification (lead): `pnpm check`, bundle smoke test, converge review against FR-401..FR-411, `CLAUDE.md` provider line

## Dependencies & waves

- T401 first (serial, lead).
- Wave A (parallel): T402, T403, T404, T406.
- T405 (lead) after T402 and T403.
- Wave B (parallel): T407, T408, T409, T410.
- Wave C (parallel): T411, T412.
- T413, T414 by the lead.
