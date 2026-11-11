---
description: "Tasks for 026-contabo-provider-plugins"
---

# Tasks: Contabo, opening with the contract for cloud server providers

**Input**: `specs/026-contabo-provider-plugins/` (spec.md, plan.md, research.md R1–R5) + features
000–025.

**Numbering**: T2601–T2699.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration, a `package.json`'s
dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Byte-identical rule (SC-2602):** waves 1 and 2 change no `__snapshots__` file and no test
expectation beyond imports and moved fixtures. A diff that does is sent back.

## Phase 1: Contract and packages (lead)

- [x] T2601 The contract, ADR 0029 and the packages (lead)
  - Owns: `packages/contracts/src/**`, `docs/adr/0029-*.md`, `pnpm-workspace.yaml`, `packages/providers/*/package.json`, `packages/providers/*/tsconfig.json`, every consumer's `package.json`, `pnpm-lock.yaml`, `scripts/gen-provider-modules.ts`, the root `package.json`
  - Accept:
    - `CloudProviderDefinition` (contract version 1) in `packages/contracts/src/provider.ts` as plan 1 says, with `ModuleCall` and `ProviderRequirement` moved in; `ComputeOffer.setupFee?`, `ComputeOffer.includedSnapshots?`, `ProviderExtras.snapshotsIncluded?`, `AppServer.cancelledUntil?`.
    - `packages/connectors/{hetzner,digitalocean}` moved to `packages/providers/{hetzner,digitalocean}` as `@opscrew/provider-{hetzner,digitalocean}`, every import renamed, behaviour unchanged.
    - Skeletons of `@opscrew/providers` (`packages/providers/registry`) and `@opscrew/provider-contabo`, and the dependency on `@opscrew/providers` in agents, iac-templates, secops, detect, mcp-server and cli; the lockfile regenerated.
    - `scripts/gen-provider-modules.ts` (`pnpm gen:provider-modules`) writes `src/generated/module.ts` for each provider with a `module/` folder.
    - ADR 0029 records the contract, the one-way dependencies and what 028 adds.
  - Verify: `pnpm check`
  - Effort: lead

## Phase 2: Wave 1 (parallel)

- [x] T2602 [P] [US5] The registry `@opscrew/providers`
  - Owns: `packages/providers/registry/src/**`
  - Reads: plan 1–2; `packages/contracts/src/provider.ts`; `packages/plan-schema/src/enums.ts`
  - Depends: T2601, T2603, T2604 (it imports their definitions)
  - Accept:
    - `CLOUD_PROVIDERS` (Hetzner, then DigitalOcean), `cloudProvider(id)` (throws a plain `INVALID_INPUT` error naming the known ids). plan-schema's `isCloudProvider` stays the type guard; the equality test below keeps the two id lists equal.
    - Every definition is validated at load with zod: `contractVersion` 1, every required part present, region keys within `RegionSchema`, locations named, every region mapped, module files non-empty and without `cloud-init.yaml.tftpl`. A bad definition fails with the provider's id and the part.
    - A conformance test in the registry runs for every entry of `CLOUD_PROVIDERS`: the validation plus behavioural checks (`moduleArguments` for the app's server, an extra server and a prefix; `connector` with no credentials is `configured: false`; every token rule matches a `fakeSecret`-built sample). It lives in the registry because a provider package can't depend on the registry, which depends on it.
    - A test that `CLOUD_PROVIDERS`' ids equal `CloudProviderSchema`'s options.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/providers && pnpm lint`
  - Effort: high

- [x] T2603 [P] [US3] Hetzner's definition
  - Owns: `packages/providers/hetzner/src/**`, `packages/providers/hetzner/module/**`
  - Reads: plan 1–3; research R1; the Hetzner parts of `agents/src/providers/profiles.ts`, `agents/src/design/{wording,delay}.ts`, `agents/src/provision/plan-apply.ts`, `agents/src/destroy/{texts,storage}.ts`, `agents/src/init/checks.ts`, `agents/src/interview/questions.ts`, `iac-templates/src/providers.ts`, `iac-templates/src/infra/servers.ts`, `iac-templates/modules/hetzner-vps/**`, `secops/src/policies/plan.ts`, `secops/src/rules/secrets.ts`, `detect/src/env.ts`
  - Depends: T2601
  - Accept:
    - `definition: CloudProviderDefinition` exported from the package root, every value copied exactly (strings byte for byte, the same regexes) from where it lives today; the module's files copied into `module/` without the cloud-init copy, and `src/generated/module.ts` generated.
    - `removal: "delete"`, `resize: true`, `snapshots: { kind: "per-gb" }`, `serverSnapshotsOutliveServer: true`, credentials `mode: "any"`.
    - A local test checks the definition's shape and that the generated module is current (`collectProviderModule` from `scripts/gen-provider-modules.ts`); the registry's conformance test (T2602) covers it once merged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/provider-hetzner && pnpm lint`
  - Effort: high

- [x] T2604 [P] [US3] DigitalOcean's definition
  - Owns: `packages/providers/digitalocean/src/**`, `packages/providers/digitalocean/module/**`
  - Reads: as T2603, DigitalOcean's parts; `iac-templates/modules/digitalocean-droplet/**`
  - Depends: T2601
  - Accept: as T2603 for DigitalOcean (`resize: true`, `serverSnapshotsOutliveServer: true`, its extra shared tag, its scopes and scope note).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/provider-digitalocean && pnpm lint`
  - Effort: high

## Phase 3: Wave 2, the consumers read the registry (parallel)

- [ ] T2605 [P] [US3] iac-templates
  - Owns: `packages/iac-templates/**`
  - Reads: plan 2–3
  - Depends: T2602, T2603, T2604
  - Accept:
    - `PROVIDER_TEXT`, `cloudTarget`, `NOT_CLOUD`'s cloud test and `SHARED_RESOURCES` read the registry; no code in the package branches on `"hetzner"` or `"digitalocean"` as a cloud server provider (a test greps `src/` outside tests and fixtures; the object-storage code, `infra/storage.ts`, `prices.ts` and `offsite.ts`, keeps its bucket providers, plan 3).
    - The server modules come from the definitions, with the shared `cloud-init.yaml.tftpl` added to each, written to the same paths; `modules/hetzner-vps` and `modules/digitalocean-droplet` and their `SHARED_FILES` entries are removed; the Cloudflare modules and the check script stay generated as before.
    - The module validate and security tests iterate `CLOUD_PROVIDERS`.
    - The byte-identical rule.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: xhigh

- [ ] T2606 [P] [US3] agents: providers, design, interview, init
  - Owns: `packages/agents/src/{providers,design,interview,init,shared,testing}/**`
  - Reads: plan 3
  - Depends: T2602, T2603, T2604
  - Accept:
    - `providerProfile`, `VPS_PROVIDERS`, `providerFromTokens` and `vpsConnector` build on the registry (own, Portainer, localhost and the serverless profiles unchanged); `design/wording.ts`, `design/delay.ts`, `design/sizing.ts`, the interview's provider options and `init/checks.ts`'s token help read definitions.
    - No code in these folders branches on `"hetzner"` or `"digitalocean"` as a cloud server provider (a test greps them; the object-storage choice, `design/storage.ts` and `interview/components.ts`'s storage offers, stays, plan 3).
    - The byte-identical rule.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [ ] T2607 [P] [US3] agents: everything else that reads provider facts
  - Owns: `packages/agents/src/{retarget,provision,destroy,advise,rotate,snapshot,secure,environments,drift,verify,status,serverless,runners,monitoring,logs,localhost}/**`
  - Reads: plan 3
  - Depends: T2602, T2603, T2604
  - Accept:
    - `provision/plan-apply.ts`'s `PROVIDER_API`, `destroy/texts.ts`, `destroy/storage.ts`'s console names, `advise`'s cross-provider readings, `retarget`'s server lists and every other cloud provider table here read definitions through `providerProfile` or the registry.
    - No code in these folders branches on `"hetzner"` or `"digitalocean"` except the object-storage provider choice (plan 3), which stays.
    - The byte-identical rule.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [x] T2608 [P] [US3] secops and detect
  - Owns: `packages/secops/src/**`, `packages/detect/src/**`
  - Reads: plan 3
  - Depends: T2602, T2603, T2604
  - Accept:
    - SecOps's provider table and the providers' token rules come from the definitions, in the same order and with the same ids, so findings are unchanged; `detect`'s provider prefixes come from the registry.
    - The byte-identical rule.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops --filter=@opscrew/detect && pnpm lint`
  - Effort: high

- [ ] T2609 [P] [US3] mcp-server and cli
  - Owns: `packages/mcp-server/src/**`, `packages/cli/src/**`
  - Reads: plan 3
  - Depends: T2602, T2603, T2604
  - Accept:
    - The placement tool's provider enum, `retarget`'s `SERVERS` and its provider-gated flags, `interview`'s next step and the server text list the registry's providers (plus `own` and `portainer` where they are listed today).
    - The byte-identical rule.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server --filter=opscrew && pnpm lint`
  - Effort: high

## Phase 4: Wave 3, what Contabo needs from the consumers (parallel)

- [ ] T2610 [P] [US2] Removal by cancellation
  - Owns: `packages/agents/src/destroy/**`, `packages/cli/src/commands/destroy*.ts`
  - Reads: plan 4.1; spec US2
  - Depends: T2607, T2609
  - Accept:
    - For a definition with `removal: "cancel-at-term-end"`: the plan and the typed confirmation say the server is billed to the end of its term and that its disk and snapshots go then; the approved plan lists the shutdown (`servers.powerOff`) before the IaC destroy; after the apply, the end date read back (`findAppServers` → `cancelledUntil`) is shown and audited; no provider snapshot is offered when `serverSnapshotsOutliveServer` is false, and OpsCrew's data snapshot with its off-server copy is offered when the server holds data.
    - When the IaC destroy fails for such a provider (Contabo refuses to cancel a server not created through its API, a 422), the error shows the provider's reason and names its console (`texts.destroy.console`) as where to cancel by hand.
    - The snapshot limit counts snapshots taken by hand too: the refusal names the provider's console for those.
    - Tested with a fake definition and connector; Hetzner and DigitalOcean unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew && pnpm lint`
  - Effort: high

- [ ] T2611 [P] [US1] [US4] Prices, snapshot limits and size changes
  - Owns: `packages/agents/src/{design,advise,snapshot,retarget}/**`, `packages/cli/src/commands/{snapshot,restore,retarget}*.ts`
  - Reads: plan 4.2, 4.5
  - Depends: T2606, T2607, T2609
  - Accept:
    - Design, cost and advise add an offer's `setupFee` once (shown as one-time), state the minimum term for `cancel-at-term-end`, and price snapshots as "included, up to N" when `snapshotsIncluded`.
    - `resize: false` refuses design's and advise's size changes, naming the move to a new server (retarget) as the way.
    - `snapshot --server` refuses at `includedSnapshots`, naming the oldest to delete; a restore of a snapshot that is not the newest says first that the provider deletes the newer ones (for `snapshots.kind: "included"`).
    - A whole-server snapshot id may hold one colon (`<instance>:<snapshot>`, Contabo's): `snapshot delete` and `restore --server` accept it; data snapshot ids keep letters and digits only.
    - Tested with a fake definition; Hetzner and DigitalOcean unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew && pnpm lint`
  - Effort: high

- [ ] T2612 [P] [US1] Taking over a lost server, and credentials as a set
  - Owns: `packages/agents/src/{provision,init,rotate,providers}/**`, `packages/iac-templates/src/infra/**`
  - Reads: plan 4.3, 4.4
  - Depends: T2605, T2606, T2607
  - Accept:
    - Before provision's plan, the app's servers at the provider (`findAppServers`) are compared with the state; a running one the state lacks, named as one of the plan's servers, is shown and taken over with an `import` block rendered into the root module (plain HCL both engines accept), approved with the plan; one with `cancelledUntil` is never taken over, and the plan says a new server is bought. One with `nameOnly` (its tag never attached) is taken over only when OpsCrew's last provision of that environment stopped mid-apply (a marker under `.opscrew/` written before the apply and removed after it); otherwise the plan stops and names the server and what to do (rename or remove it in the provider's console).
    - `mode: "all"` credentials: init, provision's credential check, `providerFromTokens` and rotate's list of the user's tokens read every variable and name the missing ones.
    - Tested with fakes for all three behaviours, including SC-2605: a create that timed out, then a second provision, buys no second server; Hetzner and DigitalOcean plans unchanged when nothing is lost.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: xhigh

## Phase 5: Contabo

- [ ] T2613 The spike (lead)
  - Accept: once the founder's account exists, free calls only: a token and its lifetime; the images (Ubuntu 24.04's name and id); the data centers; the product ids of Cloud VPS 4, 6, 8 and 12; a `contabo_firewall` and a `contabo_secret` created and deleted alone through the engine; the setup fee from the founder's checkout; and T2614's open points: the error body's shape, the snapshot-limit refusal, whether a snapshot is usable as soon as the create answers, the statuses a revert goes through, that `opscrew-app:<app>` is an accepted tag name and an instance assignment's `resourceType`, the cancel date's value before a cancel, regional prices and which VAT the prices include. Recorded as research R6, and fixed in the connector where they differ.
  - Effort: lead

- [x] T2614 [US1] Contabo's client and connector
  - Owns: `packages/providers/contabo/src/**` except `definition.ts`
  - Reads: research R2, R6; plan 5; `packages/providers/hetzner/src/{connector,client}*.ts` as the model
  - Depends: T2601 (runs beside wave 1; the spike's facts, T2613, go into its price table afterwards)
  - Accept:
    - The client: OAuth2 password grant from the four `CNTB_OAUTH2_*` variables (all needed; the missing ones named), token cached to its expiry and renewed once on a 401, `x-request-id` on every call, zod on every answer, errors in plain English (402, 422 on cancel, 429), the four values registered with the redactor on read.
    - `contaboConnector`: `verifyCredentials`; a dated static catalog (`static-prices.ts`, the product ids from the API reference (R2), checked against R6 once the spike has run, the monthly rate, `setupFee`, `includedSnapshots`); `ServerSnapshotApi` as plan 5 (`findAppServers` by the tag `opscrew-app:<app>` plus untagged servers whose display name is the app's or `<app>-…` as `nameOnly`, with `cancelledUntil`; snapshot ids `<instance>:<snapshot>`; `rebuild` as revert; power off and on with waits).
    - Tests with `fetch` fakes: a renewed token, `findAppServers` finding a server whose create timed out, the cancel date read back, the snapshot limit, no credential in any error or log.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/provider-contabo && pnpm lint`
  - Effort: xhigh

- [ ] T2615 [US1] [US2] Contabo's definition and module
  - Owns: `packages/providers/contabo/src/definition.ts` (+ test), `packages/providers/contabo/module/**`, `packages/providers/contabo/src/generated/**`, `packages/providers/contabo/src/index.ts`
  - Reads: plan 4–5; research R2, R6; Hetzner's definition and module
  - Depends: T2602, T2614
  - Accept:
    - The definition: `removal: "cancel-at-term-end"` with `minimumTermMonths: 1`, `resize: false`, `snapshots: { kind: "included" }`, `serverSnapshotsOutliveServer: false`, `providerBackups: false`, `deleteProtection: false`, credentials `mode: "all"`, the regions of plan 5, the texts (runbook, destroy, init help, interview option), the SecOps row reading `contabo_firewall.instance_ids`, the 403 pattern.
    - `module/contabo-vps` as plan 5, passing `validate` under both engines; the registry's conformance test passes once T2616 adds Contabo to the list.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/provider-contabo && pnpm lint`
  - Effort: high

- [ ] T2616 Contabo joins the ids and the registry (lead)
  - Accept: `contabo` in `ProviderId`, `VpsProviderId`, plan-schema's provider enums and generated schemas, and `CLOUD_PROVIDERS`; `pnpm check` green, any exhaustive switch left over fixed.
  - Effort: lead

## Phase 6: Wave 5 (parallel)

- [ ] T2617 [P] [US6] The guide
  - Owns: `docs/guide/contabo.md`, `docs/guide/{index,object-storage,snapshots,retarget,credential-rotation}.md`, `docs/prices-compared.md`, `README.md`
  - Reads: spec US1, US2, US4, US6; plan 5–6
  - Depends: T2615
  - Accept: the Contabo page covers US6 (credentials and where to create them, that they reach the whole account, removal and the end date, the shutdown and starting it again in the panel, minimum term and setup fee, snapshot limits, regions, what isn't offered); the listed pages name Contabo where they list providers.
  - Verify: `pnpm lint`
  - Effort: medium

- [ ] T2618 [P] [US6] The plugin skills and the MCP text
  - Owns: `plugin/skills/**`, `plugin/README.md`, `packages/mcp-server/src/tools/*.ts` (text only)
  - Depends: T2616
  - Accept: `opscrew-deploy` and `opscrew-snapshots` say what differs on Contabo; the MCP tool descriptions that list providers include it; `node plugin/validate.mjs` passes.
  - Verify: `node plugin/validate.mjs && pnpm turbo run typecheck test --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: medium

- [ ] T2619 [P] [US1] [US2] The live test
  - Owns: `packages/cli/test/live/contabo*.ts`, `docs/e2e.md`
  - Reads: SC-2601, SC-2604; `packages/cli/test/live/live.test.ts` as the model
  - Depends: T2616
  - Accept: `contabo.test.ts` gated by `OPSCREW_E2E_CONTABO=1` and the four `OPSCREW_E2E_CONTABO_*` values: interview, design, provision, deploy, verify, a whole-server snapshot and its restore, secure, drift, destroy (the end date shown), then a scan of every output, log, audit entry, state file and committed file for the four values; skipped with a clear message without them; `docs/e2e.md` says how to run it and that each run buys a month.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: high

## Phase 7: Live, simplify, release (lead)

- [ ] T2620 The live pass on one Cloud VPS 4 (lead; the founder is asked before any rerun that needs another server), recorded on `docs/e2e-coverage.md`.
- [ ] T2621 Simplify pass over the feature's changes (lead).
- [ ] T2622 The constitution's provider order (Contabo with the hosting providers, a MINOR bump) and `CLAUDE.md`'s package list (lead).
- [ ] T2623 The release, following `docs/releasing.md` (lead).
