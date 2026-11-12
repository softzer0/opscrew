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

- [x] T2605 [P] [US3] iac-templates
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

- [x] T2606 [P] [US3] agents: providers, design, interview, init
  - Owns: `packages/agents/src/{providers,design,interview,init,shared,testing}/**`
  - Reads: plan 3
  - Depends: T2602, T2603, T2604
  - Accept:
    - `providerProfile`, `VPS_PROVIDERS`, `providerFromTokens` and `vpsConnector` build on the registry (own, Portainer, localhost and the serverless profiles unchanged); `design/wording.ts`, `design/delay.ts`, `design/sizing.ts`, the interview's provider options and `init/checks.ts`'s token help read definitions.
    - No code in these folders branches on `"hetzner"` or `"digitalocean"` as a cloud server provider (a test greps them; the object-storage choice, `design/storage.ts` and `interview/components.ts`'s storage offers, stays, plan 3).
    - The byte-identical rule.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [x] T2607 [P] [US3] agents: everything else that reads provider facts
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

- [x] T2609 [P] [US3] mcp-server and cli
  - Owns: `packages/mcp-server/src/**`, `packages/cli/src/**`
  - Reads: plan 3
  - Depends: T2602, T2603, T2604
  - Accept:
    - The placement tool's provider enum, `retarget`'s `SERVERS` and its provider-gated flags, `interview`'s next step and the server text list the registry's providers (plus `own` and `portainer` where they are listed today).
    - The byte-identical rule.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server --filter=opscrew && pnpm lint`
  - Effort: high

## Phase 4: Wave 3, what Contabo needs from the consumers (parallel)

- [x] T2610 [P] [US2] Removal by cancellation
  - Owns: `packages/agents/src/destroy/**`, `packages/cli/src/commands/destroy*.ts`
  - Reads: plan 4.1; spec US2
  - Depends: T2607, T2609
  - Accept:
    - For a definition with `removal: "cancel-at-term-end"`: the plan and the typed confirmation say the server is billed to the end of its term and that its disk and snapshots go then; the approved plan lists the shutdown (`servers.powerOff`) before the IaC destroy; after the apply, the end date read back (`findAppServers` → `cancelledUntil`) is shown and audited; no provider snapshot is offered when `serverSnapshotsOutliveServer` is false, and OpsCrew's data snapshot with its off-server copy is offered when the server holds data.
    - When the IaC destroy fails for such a provider (Contabo refuses to cancel a server not created through its API, a 422), the error shows the provider's reason and names its console (`texts.destroy.console`) as where to cancel by hand.
    - Tested with a fake definition and connector; Hetzner and DigitalOcean unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew && pnpm lint`
  - Effort: high

- [x] T2611 [P] [US1] [US4] Prices, snapshot limits and size changes
  - Owns: `packages/agents/src/{design,advise,snapshot,retarget}/**`, `packages/cli/src/commands/{snapshot,restore,retarget}*.ts`
  - Reads: plan 4.2, 4.5
  - Depends: T2606, T2607, T2609
  - Accept:
    - Design, cost and advise add an offer's `setupFee` once (shown as one-time), state the minimum term for `cancel-at-term-end`, and price snapshots as "included, up to N" when `snapshotsIncluded`.
    - `design/storage.ts`: Garage stays opt-in on every cloud provider (`isCloudProvider`), the default provider is `DEFAULT_CLOUD_PROVIDER`, and the provider's own bucket is offered only where it sells one (the bucket providers, plan 3); `storageRegionAt` likewise.
    - `resize: false` refuses design's and advise's size changes, naming two ways: a move to another provider with `opscrew retarget` (a short maintenance window for the data), or a new server at the same provider through a data snapshot with its off-server copy, destroy, provision and `opscrew restore <id> --from offsite` (with downtime; retarget doesn't move within one provider).
    - `offering.providerBackups: false`: design never turns on or prices the provider's backups and says OpsCrew's own data snapshots cover the data.
    - `snapshot --server` refuses at `includedSnapshots`, naming the oldest to delete; a restore of a snapshot that is not the newest says first that the provider deletes the newer ones (for `snapshots.kind: "included"`).
    - A whole-server snapshot id may hold one colon (`<instance>:<snapshot>`, Contabo's): `snapshot delete` and `restore --server` accept it; data snapshot ids keep letters and digits only.
    - Tested with a fake definition; Hetzner and DigitalOcean unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew && pnpm lint`
  - Effort: high

- [x] T2612 [P] [US1] Taking over a lost server, and credentials as a set
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

- [x] T2613 The spike (lead; done 2026-11-12, research R6 and R7; what needs an instance goes to T2620)
  - Accept: once the founder's account exists, free calls only: a token and its lifetime; the images (Ubuntu 24.04's name and id); the data centers; the product ids of Cloud VPS 4, 6, 8 and 12; a `contabo_firewall` and a `contabo_secret` created and deleted alone through the engine; the setup fee from the founder's checkout; and T2614's open points: the error body's shape, the snapshot-limit refusal, whether a snapshot is usable as soon as the create answers, the statuses a revert goes through, that `opscrew-app:<app>` is an accepted tag name and an instance assignment's `resourceType`, the cancel date's value before a cancel, regional prices and which VAT the prices include. And T2615's: **first, the firewall's rule semantics** (does an empty IPv4 or IPv6 source list mean nobody or anybody; outbound traffic; a rule with no ports), since SSH limited to IPv4 networks must not be open over IPv6; Ubuntu 24.04's image id (the definition's `defaultImage` is a placeholder until then); the `unavailable` and `serverLimit` error texts; whether `period` or `default_user` read back differently (drift, provider issue #45); that `contabo_instance` imports by its instance id (the takeover's `import` block, T2612); and for the live test's cleanup (T2619): the field names of firewalls and secrets (`firewallId`, `status`, `instances[].instanceId`, `secretId`, `type`, `value`), the cancel endpoint `POST /v1/compute/instances/{id}/cancel`, and the `name` filter on `/v1/firewalls`, `/v1/secrets` and `/v1/tags`. Recorded as research R6, and fixed in the connector and the definition where they differ.
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

- [x] T2615 [US1] [US2] Contabo's definition and module
  - Owns: `packages/providers/contabo/src/definition.ts` (+ test), `packages/providers/contabo/module/**`, `packages/providers/contabo/src/generated/**`, `packages/providers/contabo/src/index.ts`
  - Reads: plan 4–5; research R2, R6; Hetzner's definition and module
  - Depends: T2602, T2614
  - Accept:
    - The definition: `removal: "cancel-at-term-end"` with `minimumTermMonths: 1`, `resize: false`, `snapshots: { kind: "included" }`, `serverSnapshotsOutliveServer: false`, `providerBackups: false`, `deleteProtection: false`, credentials `mode: "all"`, the regions of plan 5, the texts (runbook, destroy, init help, interview option), the SecOps row reading `contabo_firewall.instance_ids`, the 403 pattern.
    - `module/contabo-vps` as plan 5, passing `validate` under both engines; the registry's conformance test passes once T2616 adds Contabo to the list.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/provider-contabo && pnpm lint`
  - Effort: high

- [x] T2616 Contabo joins the ids and the registry (lead)
  - Accept: `contabo` in `ProviderId`, `VpsProviderId`, plan-schema's provider enums and generated schemas, and `CLOUD_PROVIDERS`; `pnpm check` green, any exhaustive switch left over fixed; every message that still names the cloud providers in its text is built from the registry with `orText`/`listText` (T2606's list: `providers/profiles.ts`' two hints, `vpsConnector`'s default hint, `design/servers.ts`, `design/own-servers.ts`, `shared/server-record.ts`, and any other a grep for `Hetzner Cloud or DigitalOcean` and `hetzner, digitalocean` finds); `runners/cloud.ts`' "the other provider" names the others (`orText`) once there are three. For a provider with `offering.providerBackups: false`: the runbook (`iac-templates/src/runbook/index.ts`) never offers to turn its backups on and points to OpsCrew's data snapshots instead (provision's refusal of `backups: true` moved to T2627, T2611's report). For credentials as a set: `plan-apply.ts`' refused-apply hint, `credentials.ts`' wrong-credentials hint and init's "X and Y are both set" word a set of variables properly (T2612's report), and so do `destroy/deletion.ts`' and `snapshot/provider.ts`' "set A or B" and `mcp-server/tools/design.ts`' check of a partly set group; `opscrew destroy` removes the takeover marker (`.opscrew/<env>/apply-started.json`).
  - Effort: lead

- [x] T2624 [US2] [US4] A move off a provider that cancels
  - Owns: `packages/agents/src/retarget/**`, `packages/cli/src/commands/retarget*.ts`
  - Reads: plan 4.1; T2610's `packages/agents/src/destroy/cancel.ts`
  - Depends: T2610, T2611
  - Accept:
    - `opscrew retarget --finish` that removes the old server at a `cancel-at-term-end` provider says, before its approval, that the old server is cancelled and billed to the end of its term; shuts it down after approval and before the apply (audited); reads its end date back and shows and audits it, as destroy does (reuse T2610's code through `../destroy`, no copy).
    - Hetzner and DigitalOcean moves unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew && pnpm lint`
  - Effort: high

- [x] T2625 [US4] Provision removes a server at a provider that cancels
  - Owns: `packages/agents/src/provision/**`
  - Reads: plan 4.1; T2610's `packages/agents/src/destroy/cancel.ts`
  - Depends: T2610, T2612
  - Accept:
    - When `opscrew provision` removes a server at a `cancel-at-term-end` provider (design dropped an extra server, or a move's old server), its plan says the server is cancelled and billed to the end of its term and that its disk and snapshots go then; the server is shut down after approval and before the apply (audited); its end date is read back, shown and audited; a refused cancel names the provider's console. Reuse T2610's code through `../destroy`, no copy.
    - Hetzner and DigitalOcean unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: high

- [x] T2626 [US4] Advise compares providers on the same basis
  - Owns: `packages/agents/src/advise/**`, `docs/guide/advise.md`
  - Reads: T2616's report and review; `packages/agents/src/design/cost.ts` (`offerTerms`, `pricedOffer`)
  - Depends: T2616
  - Accept:
    - advise's move to another provider compares prices on the same VAT basis (both with or both without, as the user's currency shows elsewhere), with or without the provider's backups alike, and names each side's price date.
    - A proposal to move to a provider with terms states the trade-offs plainly: the one-time setup fee, the minimum term and that a removal ends only at the end of it, no size change in place, no automatic backups from the provider (OpsCrew's data snapshots instead).
    - It is proposed only when the saving is real on that basis, at least 10% of the current monthly price, and covers any setup fee within 3 months (lead, 2026-11-12); a Hetzner app no longer gets a move to Contabo by an unequal comparison. `overBudget` labels VAT the same way.
    - `docs/guide/advise.md` says so.
    - Hetzner's and DigitalOcean's proposals to each other are unchanged; one run-level test still yields no proposal for a healthy app (T2616's review N3).
    - T2616's review lists the eight unequal points (VAT, backups, setup fee, terms, price dates, included extras, "the same server", currency): each is either made equal or said plainly.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: high

- [x] T2627 [US1] [US4] Provision and the runbook for providers with terms
  - Owns: `packages/agents/src/{provision,init,destroy/deletion.ts,snapshot/provider.ts,providers}/**`, `packages/iac-templates/src/runbook/**`, `packages/iac-templates/src/infra/infra.test.ts`
  - Depends: T2616
  - Accept:
    - provision refuses a plan whose cloud target has `backups: true` at a provider with `offering.providerBackups: false`, with the reason and what to do.
    - One helper names a set's missing credentials ("X needs all of A, B, C and D: … not set"), in `agents/src/providers/profiles.ts`, used by `provision/credentials.ts`, `destroy/deletion.ts` and `snapshot/provider.ts`.
    - Init's message when several providers have credentials names each provider with its variables in brackets; its fix and pass texts fit a set of four (T2616's review N2).
    - The runbook's backups text for such a provider says `opscrew provision` follows `snapshot schedule on` and `snapshot offsite on`, and that a restore from the off-server copy takes `--from offsite --key-file <path>` (T2616's review N1).
    - `iac-templates/src/infra/infra.test.ts`' skip message names the cloud providers from the registry (N4).
    - The runbook's "Server size: run `opscrew design`" bullet, for a provider with `offering.resize: false`, names the two ways design names (T2611's `resizeWaysText`), or points to them.
    - Hetzner and DigitalOcean unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: medium

- [x] T2628 [US1] Design prints the chosen option's terms in a script
  - Owns: `packages/agents/src/design/run.ts` (+ tests)
  - Depends: T2611
  - Accept:
    - Without a terminal (`--option`, answers file), `opscrew design` prints the chosen option's terms as the interactive chooser shows them: the one-time setup fee, the minimum term and that a removal ends at the end of it, "included, up to N" snapshots, and that the provider offers no automatic backups (T2611's `offerTerms` and `noProviderBackupsText`), for a provider with such terms.
    - Hetzner's and DigitalOcean's script output is unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: medium

## Phase 6: Wave 5 (parallel)

- [x] T2617 [P] [US6] The guide
  - Owns: `docs/guide/contabo.md`, `docs/guide/{index,object-storage,snapshots,retarget,credential-rotation}.md`, `docs/prices-compared.md`, `README.md`
  - Reads: spec US1, US2, US4, US6; plan 5–6
  - Depends: T2615
  - Accept: the Contabo page covers US6 (credentials and where to create them, that they reach the whole account, removal and the end date, the shutdown and starting it again in the panel, minimum term and setup fee, snapshot limits, regions, what isn't offered); the listed pages name Contabo where they list providers.
  - Verify: `pnpm lint`
  - Effort: medium

- [x] T2618 [P] [US6] The plugin skills and the MCP text
  - Owns: `plugin/skills/**`, `plugin/README.md`, `packages/mcp-server/src/tools/*.ts` (text only), `packages/cli/src/commands/retarget.ts` (help text only)
  - Depends: T2616
  - Accept: `opscrew-deploy` and `opscrew-snapshots` say what differs on Contabo; the MCP tool descriptions that list providers include it, and the rule that names the tools OpsCrew never runs names `cntb` too; where a text names a provider's credential variable (the deploy tools, `retarget`'s help), a provider whose `credentials.mode` is `all` has every variable named, and retarget's hand-wrapped help stays wrapped; `node plugin/validate.mjs` passes.
  - Verify: `node plugin/validate.mjs && pnpm turbo run typecheck test --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: medium

- [x] T2619 [P] [US1] [US2] The live test
  - Owns: `packages/cli/test/live/contabo*.ts`, `docs/e2e.md`
  - Reads: SC-2601, SC-2604; `packages/cli/test/live/live.test.ts` as the model
  - Depends: T2616
  - Accept: `contabo.test.ts` gated by `OPSCREW_E2E_CONTABO=1` and the four `OPSCREW_E2E_CONTABO_*` values: interview, design, provision, deploy, verify, a whole-server snapshot and its restore, secure, drift, destroy (the end date shown), then a scan of every output, log, audit entry, state file and committed file for the four values; skipped with a clear message without them; `docs/e2e.md` says how to run it and that each run buys a month.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: high

## Phase 6b: What the spike found (research R6, R7)

- [x] T2629 [US1] Contabo's firewall through the connector
  - Owns: `packages/providers/contabo/**`
  - Reads: research R6, R7; ADR 0029 D8; `WantedFirewallOutput` (`packages/contracts/src/provider.ts`), `FirewallApi` and `WantedFirewall` (`packages/contracts/src/connector.ts`)
  - Accept:
    - `module/main.tf` has no `contabo_firewall`. A `terraform_data "firewall"` takes as `input` the firewall the module wants, in `WantedFirewallOutput`'s shape: `<name>-firewall`, its description, `server_ids = [tostring(contabo_instance.this.id)]`, and the rules the module writes today (SSH from the allowed networks and none when there are none, the web ports on a server that serves the web, ICMP, WireGuard). `output "wanted_firewall"` is that input. A family with no network gets `127.0.0.1/32` or `::1/128`, never an empty list.
    - The definition: `connectorFirewall: true`, `firewallResourceType: "terraform_data.firewall"`, `homeCacheFiles` as now. SecOps's `rules` and `attached` read the `terraform_data`'s `input` (attached: its `server_ids` hold the server's id, or the configuration references the server). An empty source list reads as any source.
    - The connector has `firewalls` when the credentials are set, as the contract says, through Contabo's API (R6). It compares the exact name after the substring filter. It creates a firewall with its rules and status `active`, sets the description and rules of one that differs (the API reference says whether by `PUT` or `PATCH`), and adds and removes servers (`POST` and `DELETE /v1/firewalls/{id}/instances/{instanceId}`). It waits, bounded and with a plain error, until each server's `instanceStatus` is `ok`. It never compares, writes or deletes Contabo's own drop rule. It reads `instances` as a list of objects, a list of numbers or a JSON-encoded string, and `instanceStatus` too. Every answer is checked with zod, and errors take the client's redacted path.
    - `pnpm gen:provider-modules` regenerated.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/provider-contabo --filter=@opscrew/providers && pnpm lint`
  - Effort: xhigh

- [x] T2630 [P] [US1] A provider's login cache never outlives an engine command
  - Owns: `packages/iac-engine/src/**`, `packages/agents/src/shared/engine.ts` (+ test)
  - Reads: research R6 ("The provider's login cache"); ADR 0029 D9
  - Accept: `EngineOptions.homeCacheFiles` (paths relative to the home folder). Before and after every engine command, the engine removes each of them under the home folder the command's environment names: `HOME`, else `USERPROFILE`, as the providers' Go code finds it. A missing file is fine. A removal that fails before a command stops it, with a plain error naming the file. Agents' `selectEngine` passes every registered provider's `homeCacheFiles`. The tests inject the removal and never touch a real home folder.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-engine && pnpm turbo run typecheck --filter=@opscrew/agents && pnpm lint`
  - Effort: medium

- [x] T2631 [US1] [US2] The connector's firewall in the flows
  - Owns: `packages/iac-templates/src/**` (the infra rendering, its tests and snapshots), `packages/agents/src/{provision,destroy,drift,retarget,rotate,shared,testing}/**` (the testing fakes name Contabo's firewall), `packages/secops/src/**` (+ tests)
  - Reads: research R7; ADR 0029 D8; the contract's `FirewallApi`
  - Depends: T2629
  - Accept:
    - iac-templates: a root output `wanted_firewalls`, a map from each server's module name to its provider and its module's `wanted_firewall` (the provider because a removed server is no longer in the plan, lead 2026-11-12), written only for servers whose provider has `connectorFirewall`. Hetzner's and DigitalOcean's rendered roots stay byte-identical.
    - Provision: after every successful apply, OpsCrew reads `wanted_firewalls` and passes each to its provider's `firewalls.sync`, then says and audits what changed. A failure says the server may not be protected yet and to run provision again; that run plans nothing new and syncs again.
    - Destroy, retarget's `--finish` and `--abort`, and provision's own removals: each wanted firewall of a server they remove is deleted through `firewalls.remove` after its apply, then said and audited.
    - Drift: `firewalls.differences` of each wanted firewall, reported as drift of its `terraform_data.firewall` with the differences in plain English.
    - SecOps: a `firewallResourceType` of the form `<type>.<name>` matches the resources of that type and name.
    - Other providers' flows are unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/secops && pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [x] T2632 The live test after the spike (lead): the SSH key's value from `GET /v1/secrets/{id}`; the firewall checks through the connector's view (`instances` in any of its shapes, each server's `instanceStatus` `ok`, no difference from the wanted firewall); no Contabo login left in the home folder after the run (step 9); the plan guard reads `terraform_data.firewall`. To see live (T2620): deleting a firewall that protects a cancelled server, adding a server while it is still provisioning, and whether Contabo rewrites a source it stores (a sync would then repeat and drift would never settle).

## Phase 6c: What the live pass found (research R8)

- [x] T2633 [US2] A Contabo server removed through the connector (ADR 0029 D10)
  - Owns: `packages/iac-engine/src/**`, `packages/providers/contabo/src/**`, `packages/agents/src/{provision,destroy,retarget,shared,testing}/**` (+ tests)
  - Reads: research R8; ADR 0029 D8 and D10; the contract's `connectorRemoval` and `ServerSnapshotApi.cancelServer`; T2631's `shared/firewalls.ts` (the same apply paths)
  - Depends: T2631
  - Accept:
    - iac-engine: `stateRemove(dir, addresses, options)` takes those addresses out of the state (`state rm`, with the run's env and state encryption); a failure is `ENGINE_FAILED` naming them.
    - Contabo: `cancelServer` sends `POST /v1/compute/instances/{id}/cancel` with the body `{}` and answers the `cancelDate`; a server already cancelled answers its end date without a second cancel. The definition sets `connectorRemoval: true`.
    - Every apply of an approved plan (provision's `planAndApply`, destroy's and retarget's deletion steps, destroy's busy-tunnel branch): when the plan deletes the server resource (`serverResourceType`) of a `connectorRemoval` provider, OpsCrew, after the approval and after the shutdown the flow already does, cancels each such server through `cancelServer` (its id from the change's `before`), says and audits it with its end date, removes those addresses from the state, plans again with the same options, and applies that plan only when its resource changes are the approved plan's without those addresses (address and actions); otherwise it stops naming the differences and applies nothing more. A failed cancel stops before the state is touched. The end date read after the apply still works.
    - Other providers' flows make exactly the same engine calls as before.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-engine --filter=@opscrew/provider-contabo && pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [x] T2634 Design and advise say that a provider without a price API prices from its dated list, credentials set or not (lead; `e56a1f9e`).
- [x] T2635 A live whole-server snapshot runs `sync` on the server first, on every provider (lead; `76b6aaf2`).
- [x] T2636 A Contabo snapshot's time comes from OpsCrew's stamp, not Contabo's hour-early `createdDate` (lead; `d21ad684`).
- [x] T2637 Contabo's module outputs the IPv6 address shortened (the AAAA record never looks changed) and ignores `add_ons` (lead; `a447ae31`).
- [x] T2639 Assigning a Contabo firewall waits, up to 10 minutes, for the firewall add-on Contabo attaches to a new server (lead; `4cafc731`).
- [x] T2640 A provision with nothing to apply records an apply the state holds when `plan.yaml` lacks it (lead; `df425acb`).
- [x] T2638 The live test (lead): its cleanup removes a leftover Contabo firewall through the connector (servers taken off it first; a direct delete answered 409 with a cancelled server on it).

## Phase 7: Live, simplify, release (lead)

- [x] T2620 The live pass on one Cloud VPS 4 (lead; the founder is asked before any rerun that needs another server), recorded on `docs/e2e-coverage.md`.
- [x] T2621 Simplify pass over the feature's changes (lead; done 2026-11-12 except where noted). Kept on purpose: each provider package keeps its own copies of the module-argument helpers and its SecOps reading code (a provider stays self-contained for 028), the takeover's import blocks stay appended after rendering and the plan's imports parsed in agents (no contract change for no gain). Noted: secops's `PlannedResource` becomes the contract's `PlannedResourceJson`; the definitions' copied module-argument helpers; `profiles.ts`' second parse of the region keys and of `DEFAULT_CLOUD_PROVIDER`; the two agents grep tests become one; agents (`provision/servers.ts`, `rotate/infra.ts`) read the shared resources' addresses with iac-templates' `sharedResources` instead of their own parse of `extraShared`; `provision/servers.ts`' lift of delete protection fails closed if more than one provider has it (T2607 review N1); the defensive fallbacks T2607's review listed (S2); the takeover's import blocks become a `RenderContext` field instead of an append to the rendered `main.tf`, and whether the plan's imports belong in iac-engine's plan summary (T2612's report); one "is/are not set" helper for the three copies (T2612's review); one helper for "Nothing is saved on … until its term ends" (destroy and provision, T2625's review); one credential-list helper for mcp-server's `CLOUD_CREDENTIALS` and `retarget`'s help (T2618's report); the `OPSCREW_IT` infra and cloud-init engine loop limited to fewer move directions (17.5 minutes with Contabo, T2616's report); Contabo's fixture plans in iac-templates with `pricesIncludeVat: true`, which its catalog no longer says (prices before VAT since 2026-11-12); the iac-templates shell-script tests' timeouts under load (`workflow/snapshots.test.ts`' rollback cases).
- [x] T2622 The constitution's provider order (Contabo with the hosting providers, a MINOR bump) and `CLAUDE.md`'s package list (lead).
- [ ] T2623 The release, following `docs/releasing.md` (lead).
