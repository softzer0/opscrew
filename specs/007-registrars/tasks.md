---
description: "Tasks for 007-registrars"
---

# Tasks: Namecheap, Porkbun and GoDaddy

**Input**: `specs/007-registrars/` (spec.md, plan.md, research.md) + features 000–006.
**Numbering**: T701–T799. **Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends /
Accept / Verify / Effort`. Lead-owned contracts, skeletons and the registrar seam come from T701
and T706. Fixtures never contain secret-shaped literals or real contact data (use obviously fake
names such as "Test Person", `example.invalid`); user-facing text never puts a colon directly
after an environment variable name.

## Phase 1: Foundation (lead)

- [ ] T701 Registrar capabilities and optional methods, new env names and fake kinds, three connector skeletons, `fast-xml-parser`, lockfile, `connectDomain` stub and ADR 0009 (lead)
  - Accept: plan.md "Contracts"; Cloudflare adapter declares its capabilities; `pnpm check` passes.
  - Effort: lead

## Phase 2: Adapters (parallel)

- [ ] T702 [P] [US1] [US2] [US3] Porkbun client and `PorkbunRegistrar` in `packages/connectors/porkbun/src/`
  - Owns: `packages/connectors/porkbun/src/**`
  - Reads: plan.md "Porkbun"; research.md "Porkbun API v3"; `packages/contracts/src/registrar.ts`; the Cloudflare registrar adapter for conventions
  - Depends: T701
  - Accept: every client call with fake fetch (headers, paths, batch limits, rate-limit handling, error codes → plain English with `next_action` hints, keys never in errors); `createDomain` sends `cost` in cents and an `Idempotency-Key`, never retried on ambiguous answers (→ "may still have started"), clear rejections (`INSUFFICIENT_FUNDS`, spend cap, order too large, scope) distinct; registrar capabilities, quote, years > 1 refused, ownsDomain, nameservers, records, DNSSEC, auto-renew, accountCheck (scopes from `/ping`); `satisfies Registrar`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-porkbun`
  - Effort: high

- [ ] T703 [P] [US1] [US2] [US3] Namecheap client and `NamecheapRegistrar` in `packages/connectors/namecheap/src/`
  - Owns: `packages/connectors/namecheap/src/**`
  - Reads: plan.md "Namecheap"; research.md "Namecheap API"; `docs/adr/0009-registrar-contacts-and-connect.md`
  - Depends: T701
  - Accept: XML parsed with `fast-xml-parser` and validated with zod; global parameters, sandbox switch, ClientIp from env or the injected detector; every command of plan.md with recorded XML fixtures (fake contact data only); error numbers → plain English (API access, whitelist with the detected IPv4, balance, prices changed, not available); `domains.create` never retried, ambiguous → "may still have started", `NonRealTimeDomain` → pending; default address mapped to the four contacts and never present in errors, logs or return values (only `contactSummary` masked); capabilities (`dnssec`/`autoRenew` false); `satisfies Registrar`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-namecheap`
  - Effort: high

- [ ] T704 [P] [US1] [US2] [US3] GoDaddy client and `GoDaddyRegistrar` in `packages/connectors/godaddy/src/`
  - Owns: `packages/connectors/godaddy/src/**`
  - Reads: plan.md "GoDaddy"; research.md "GoDaddy Domains API v3" (fetch the official OpenAPI document `https://developer.godaddy.com/openapi/domains-v3.json` once to confirm paths, the profile listing and field names; official sources only)
  - Depends: T701
  - Accept: check, quote (`profileId` from env when set, else GoDaddy's default profile or account details; missing contacts → plain stop), register with `Idempotency-Key` + consent from the approved quote (202 → poll to COMPLETED/FAILED; ambiguous → "may still have started"), details, nameservers (async operation polled), records, accountCheck (403 eligibility → plain message); never sends inline contact data; token never in errors; `satisfies Registrar`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-godaddy`
  - Effort: high

- [ ] T705 [P] [US1] [US2] Zone nameservers, activation check, record batch, record scan, DS values and public IPv4 in `packages/connectors/cloudflare/src/`
  - Owns: `packages/connectors/cloudflare/src/**`
  - Reads: plan.md "Cloudflare"; research.md "Cloudflare"
  - Depends: T701
  - Accept: `createZone`/`findZone` return `nameServers`; `activationCheck`; `batchCreateRecords` with the record mapping of plan.md (tests per type, ALIAS at apex, MX priority, TXT); `scanDnsRecords` (trigger + read the review list, never accepting it); `getDnssec` returns DS fields; `detectPublicIpv4(fetch)`; existing tests unchanged; `CloudflareRegistrar` capabilities set.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare`
  - Effort: medium

## Phase 3: Seam (lead)

- [ ] T706 `registrarFor`, configured registrars and dashboard links in `packages/agents/src/domain/registrars.ts` (lead)
  - Depends: T702–T705
  - Effort: lead

## Phase 4: Agents

- [ ] T707 [US1] [US3] Buying through any registrar with the switch to Cloudflare, compare, status and auto-renew in `packages/agents/src/domain/`
  - Owns: `packages/agents/src/domain/**` except `connect*.ts` and `registrars.ts`
  - Reads: spec.md US1, US3; plan.md "Buying elsewhere"; the 006 buy flow and its tests
  - Depends: T706
  - Accept: buy per registrar with fakes (quote shown and bounded; masked contact and agreements in the approval; typed domain; never `--yes`; purchase record per registrar; idempotency; `switchToCloudflare` order zone → nameservers → DS (or printed DS + link) → activation check; plan records the registrar); Cloudflare behaviour unchanged (SC-704); compare; status and auto-renew per capabilities; no contact data in reporter, audit or errors (SC-702).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [ ] T708 [US2] Connecting a domain you already own in `packages/agents/src/domain/connect*.ts`
  - Owns: `packages/agents/src/domain/connect*.ts` (+ tests, fixtures under `domain/__fixtures__/connect*`)
  - Reads: spec.md US2, edge cases; plan.md "Connect"; `switchToCloudflare` from T707
  - Depends: T707
  - Accept: registrar found; records read (registrar DNS) or scan/BIND file; copy plan with mappings and uncopyable records listed; old DS records block or are removed after approval, the switch waiting for a later run; typed approvals; order zone → records → (DS removal, stop) → nameservers → activation check, new DS once the zone is active (SC-703 asserts the order); refusal changes nothing; resumable; plan/requirements updated.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [ ] T709 [P] [US3] Registrar checks in `opscrew init` in `packages/agents/src/init/`
  - Owns: `packages/agents/src/init/**`
  - Depends: T706
  - Accept: one optional check per configured registrar via `accountCheck` (Porkbun scopes, Namecheap access + IPv4 to whitelist, GoDaddy access); offline → presence only; never fails init; secrets never printed.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

## Phase 5: Interfaces

- [ ] T710 [US1] [US2] [US3] `--registrar`, `--compare` and `opscrew domain connect` in `packages/cli/src/commands/domain.ts`
  - Owns: `packages/cli/src/commands/domain.ts` (+ test), `packages/cli/src/ui/__fixtures__/domain.ts`, the program test if the command list changes
  - Depends: T707, T708
  - Accept: flags and exit codes as in 006; connect with `--records-file` and `--confirm`; the typed handler covers connect; the bundle builds with `fast-xml-parser`.
  - Verify: `pnpm turbo run typecheck test build --filter=opscrew`
  - Effort: high

- [ ] T711 [P] [US4] MCP check with registrar/compare, skill and README in `packages/mcp-server/src/`, `plugin/`, `README.md`
  - Owns: `packages/mcp-server/src/**`, `plugin/**`, `README.md`
  - Depends: T707
  - Accept: `opscrew_domain_check` takes `registrar` or `compare`; no buying or connecting tool; skill and README describe the registrars, connect and the contact rule; `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: medium

## Phase 6: Verification

- [ ] T712 Sandbox tests for Porkbun and Namecheap and docs (lead) in `packages/cli/test/live/**`, `docs/e2e.md`
- [ ] T713 Feature verification (lead): `pnpm check`, bundle smoke test, converge review against FR-701..FR-710
- [ ] T714 Converge fixes from the T713 review (status DNSSEC hint, Porkbun scopes before buying, duplicate lines, init check wording, hints, docs, Namecheap connect in the sandbox test)
  - Owns: the files named in the T713 findings
  - Effort: high

## Dependencies & waves

- T701 (lead) → Wave A: T702, T703, T704, T705 → T706 (lead) → T707, T709 (parallel) → T708 → T710, T711 → T712, T713 → T714.
