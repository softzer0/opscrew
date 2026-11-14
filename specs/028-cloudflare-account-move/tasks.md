---
description: "Tasks for 028-cloudflare-account-move"
---

# Tasks: Moving an app to another Cloudflare account

**Status**: DRAFT, revised after the lead's review and the founder's decisions of 2026-11-14.

**Input**: `specs/028-cloudflare-account-move/` (spec.md, plan.md, data-model.md, research.md R1–R9,
R10 after T2802) + features 007, 011, 013, 014, 015, 016, 023, 025; ADR 0014, 0017, 0027, 0032.

**Numbering**: T2801–T2899.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Decided by the lead /
Accept / Verify / Effort`. Implementers never edit `tasks.md`, specs, root configuration, a
`package.json`'s dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Rules for every task:**
- **Two accounts in every agents test:** the two-account Cloudflare fake (T2805), one token per
  account, so a call made with the wrong token fails the test. Zones are always looked up with their
  account.
- **Approvals:** every change through the approval plan.md's Constitution Check (I) names; deletions
  with `allowDestroy` and the typed name; A's pieces never change before the finish, except the DS
  record and the nameservers in the switch.
- **Leaks:** no token, key, certificate, connector token, R2 key or server address in output, plans,
  `-var`s, logs, audit entries, the move's record, the marks or MCP answers. Every agents task's tests
  include a leak check over everything its fakes saw.
- **Refusals** come before any change, in plain words, ending "Nothing was changed." with what to do
  next. User-facing text never names a feature or task number.
- **`cloudflare-move/types.ts`** is T2810's; a later task that needs a field asks the lead.
- **Text:** each task keeps the strings its files show in those files; T2828 gathers repeats.
- **No network in unit tests;** fakes for Cloudflare, the registrars, GitHub, the engine (or the real
  engines from `.tools/bin` where a test needs `init`, skipping without them), servers, Portainer.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Examples:** neutral only, `example.com`, `example-app`, `203.0.113.0/24`.

## Phase 1: Foundation (lead)

- [ ] T2801 The contract, ADR 0032 and the scaffold (lead)
  - Owns: `packages/contracts/src/runtime.ts`, `docs/adr/0032-*.md`, `packages/agents/src/cloudflare-move/{index,prepare,switch,finish,abort}.ts`, the export line in `packages/agents/src/index.ts`
  - Accept:
    - `PHASES` gains `cloudflare-move` after `retarget`.
    - ADR 0032 accepted.
    - `prepare.ts`, `switch.ts`, `finish.ts`, `abort.ts` export `prepareMove`, `switchMove`,
      `finishMove`, `abortMove` stubs (`(deps: PhaseDeps, options: unknown)`, throwing `INTERNAL` "not
      built yet"); `cloudflare-move/index.ts` exports them; `agents/src/index.ts` exports
      `./cloudflare-move`.
  - Verify: `pnpm check`
  - Effort: lead

- [ ] T2802 Spike S1 on the two accounts, and research R10 (lead)
  - Owns: research R10 in `specs/028-cloudflare-account-move/research.md`; the plan and wave 3's blocks where an answer is "no"
  - Needs: the founder's account B (R2 and Zero Trust on). The zone is opscrew.dev itself, active in A:
    a pending zone for it in B serves nothing.
  - Accept: the API's own answers (ids masked); for each "no", plan 13.'s fallback taken into the plan
    and the blocks of wave 3 before it starts:
    1. `POST /zones` in B for the zone active in A: accepted as pending? B's nameserver pair differs?
    2. On the pending zone: a proxied A record; a proxied CNAME to a tunnel of B; a self-hosted
       Access application on a hostname of it; an Origin CA certificate for its hostnames; a hostname
       client certificate upload and per-hostname AOP: accepted? Which status (`pending_deployment`,
       `active`)?
    3. What B's nameservers answer for the pending zone (`node:dns` `Resolver` pointed at them).
    4. An R2 bucket in B with the name of one in A: accepted?
    5. The `meta` fields `GET /zones/{id}/dns_records` returns for a Worker's custom domain record and
       other Cloudflare-managed records.
    6. `GET /zones/{id}/hold`.
    7. O2: an Origin CA certificate issued in each account (for a hostname of a zone there), compared
       by issuer and chain; the same root is taken as "accepted across accounts", which the real move
       confirms.
    8. Where opscrew.dev is registered (`getRegistration` in A; else the public registrar).
    - Everything the spike made is removed, and both accounts are listed afterwards.
  - Effort: lead

## Phase 2: Wave 1 (parallel)

- [ ] T2803 [P] [US1] The move's record in the plan
  - Owns: `packages/plan-schema/src/**`, `packages/plan-schema/schemas/**`
  - Reads: data-model 1; `plan-schema/src/plan.ts` (`RetargetSchema`, `checkRetarget`)
  - Depends: T2801
  - Accept:
    - `CloudflareMoveSchema` (strict) as data-model 1, with `CloudflareIdSchema` (32 lower-case hex);
      `DeployPlan.cloudflareMove` optional; `type CloudflareMove`.
    - Refinements with plain messages: never beside `retarget`; never in a preview environment's
      plan; `to.accountId` differs from `from.accountId`; `abort` only with `started` or `prepared`;
      `zone` equals `dns.zone` when the plan names one.
    - The JSON schemas regenerated; every existing fixture parses as before.
  - Verify: `pnpm --filter @opscrew/plan-schema gen:schemas && pnpm turbo run typecheck --filter=@opscrew/plan-schema && npx vitest run --root packages/plan-schema && pnpm lint`
  - Effort: medium

- [ ] T2804 [P] [US1] [US4] [US5] Cloudflare's client: zones, records, holds, Workers domains, probes
  - Owns: `packages/connectors/cloudflare/src/client.ts`, `packages/connectors/cloudflare/src/index.ts`, new `packages/connectors/cloudflare/src/client-move*.test.ts`
  - Reads: plan 3., 4., 5., 13.; research R1, R5, R8, R10; Cloudflare's API reference (official pages only) for each call
  - Depends: T2801
  - Decided by the lead: every new call is a `CloudflareClient` method (one file per task in this
    wave: T2805 owns the fake and the shared adapter).
  - Accept:
    - **Zones:** `findZone(domain, { accountId? })` sends `account.id` when given, reads every match
      (not `per_page=1`) and prefers `active` over any other status; `getZone(id)` (status,
      nameservers); `deleteZone(id)`; `zoneHold(id)` (`{ hold: boolean }`).
    - **Records with every field:** `listZoneRecords(zoneId)` (type, name, content, `data`, ttl,
      proxied, priority, comment, and the `meta` fields that mark a record as Cloudflare's own);
      `createZoneRecords(zoneId, records)` in batches of 200 keeping every field; `deleteRecord(zoneId,
      id)`.
    - **Workers custom domains:** `listZoneWorkerDomains(accountId, zoneId)`;
      `attachWorkerDomain(accountId, { hostname, zoneId, service })`, answering its id;
      `detachWorkerDomain(accountId, id)`.
    - **Permission probes** (read-only calls): `accountPermissions(accountId, needs)` for `tunnel`,
      `access-apps`, `access-service-tokens`, `access-organization`, `r2`, `workers`;
      `zonePermissions(zoneId, needs)` for DNS, each OpsCrew rule phase, SSL and certificates, zone
      settings; each answering the missing ones as the token builder names them.
    - Exported from the package root. Tests with `fetch` fakes for each call and its failures (403
      permission, 409 zone in another account, rate limits), a token that sees two accounts (the
      filter decides), a moved zone beside an active one, and no token in any error.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-cloudflare && npx vitest run --root packages/connectors/cloudflare && pnpm lint`
  - Effort: high

- [ ] T2805 [P] [US1] [US2] The two-account Cloudflare fake, and the shared adapter on a pending zone
  - Owns: `packages/connectors/cloudflare/src/testing/**`, `packages/connectors/cloudflare/src/shared.ts` (+ its tests)
  - Reads: plan 3., 4.4, 5., 6.; `testing/{index,fake-zone}.ts`; Cloudflare's API reference for each endpoint the fake answers
  - Depends: T2801
  - Accept:
    - **`fakeCloudflareAccounts(options)`** in `@opscrew/connector-cloudflare/testing`: a `fetch` that
      answers Cloudflare's HTTP API for several accounts, each reached by its own token: zones
      (create, delete, `account.id` filter, holds), each zone's status moving pending → active →
      moved with its nameservers and the activation check (rate-limited as on a free zone);
      records with `meta`; rulesets; certificate packs; Origin CA certificates; hostname client
      certificates and AOP settings; DNSSEC; tunnels with their connections; Access applications,
      policies, service tokens, organization and identity providers; R2 buckets; Workers scripts,
      subdomains and custom domains by zone; the permission probes' endpoints, with permissions
      withheld per token. A call with a token of another account is refused as Cloudflare does.
      `activate(zone)` and `move(zone)` let a test drive the zones; every call is recorded for leak
      checks.
    - **`applyShared(…, { waitForActive })`:** with `false`, the apply doesn't wait for AOP and
      certificate settings to be `active` (a pending zone); default `true`, so nothing else changes.
    - Tests of the fake through `CloudflareClient`'s existing methods and raw requests to the
      endpoints above; the shared adapter's suite unchanged plus the new option.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-cloudflare && npx vitest run --root packages/connectors/cloudflare && pnpm lint`
  - Effort: xhigh

- [ ] T2806 [P] [US1] The connector beside A's on a server
  - Owns: `packages/connectors/ssh-host/src/**`
  - Reads: plan 4.4, 7.4, 8.; `ssh-host/src/plan.ts` (`planTunnelToken`, `tunnelConnectorStep`, `tunnelDir`)
  - Depends: T2801
  - Accept:
    - `planNextTunnelConnector({ app, runAs, connector: { dir?, compose, tunnelId } })`: one step that
      writes the Compose file and a token file only its owner reads in `<tunnelDir>-next` (or `dir`),
      the token supplied at apply time on standard input and never part of the plan, and starts it;
      its title and reason say it runs the new account's connector beside the current one.
    - `planNextTunnelConnectorRemoval({ app, runAs, dir? })`: stops and removes that project and its
      folder, never the main connector's.
    - Both validated before any approval (`stepScripts`). Tests: the scripts (snapshots), the token
      absent from the plan and its hash, the removal leaving the main folder.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - Effort: medium

- [ ] T2807 [P] [US1] [US2] [US4] Templates: Cloudflare's addresses, B's ids, record names, the beside connector
  - Owns: new files `packages/iac-templates/src/infra/cloudflare-move*.ts`, `packages/iac-templates/src/runtime/tunnel-next*.ts`, `packages/iac-templates/src/portainer-target/next-connector*.ts` (+ their snapshots), and their export lines in `packages/iac-templates/src/{index,infra/index,runtime/index,portainer-target/index}.ts`
  - Reads: plan 3., 9.; data-model 3, 4; `infra/{index,cloudflare,tunnel,own,portainer,serverless,storage}.ts`, `hosting/dns.ts`, `runtime/index.ts`, `portainer-target/stack.ts`, the vendored modules under `packages/iac-templates/modules/`
  - Depends: T2801
  - Accept:
    - **`cloudflareAddressScope(address)`** (data-model 3) and `CLOUDFLARE_MODULE_NAMES` (`dns`,
      `tunnel`, `access`, `portainer_tunnel`, `worker`). A test renders every target's roots (cloud,
      own public and tunnel, Portainer in each web mode, Workers, Pages and its verification root, a
      hosting account's DNS root, R2 storage and backups) and checks every resource address in them:
      servers, networks, firewalls and `random_*`/`terraform_data` outside those modules are not
      Cloudflare's; `cloudflare_dns_record` and `cloudflare_certificate_pack` are zone-scoped; the
      rest account-scoped.
    - **`accountVariables(root, ctx)`:** the root's id variables (`cloudflare_zone_id`,
      `cloudflare_account_id`, `one_time_pin_identity_provider_id`, those it declares) as strings. A
      test renders every root above with two `CloudflareSetup`s and proves the two
      `terraform.tfvars.json` differ only in these keys.
    - **`opscrewRecordNames(plan, zone)`:** every DNS name the plan's roots give an OpsCrew record or
      a Worker custom domain, sorted; checked against the rendered HCL of each target.
      `workerCustomDomainAddresses(plan)`: `module.worker.cloudflare_workers_custom_domain.domain[0]`
      and `.www[0]` with their hostnames.
    - **The beside connector:** `renderNextTunnelConnectorCompose(plan)` (`<app>-tunnel-next` in
      `cloudflared-next/`, the host network, `tunnel.env` beside it); `renderNextConnectorStacks(plan)`
      for Portainer: `opscrew-<app>-tunnel-next` (web mode `tunnel`: cloudflared on the app stack's
      network `<stack>_internal` as an external network, reaching `caddy:80`) and
      `opscrew-<app>-portainer-tunnel-next` (redeploy `cloudflare`), each with `TUNNEL_TOKEN` from the
      stack's environment.
    - **Docker-gated test** (`OPSCREW_DOCKER_TESTS=1`): the app stack's template and the beside stack
      (curl in cloudflared's place) under `docker compose`: the beside container reaches `caddy:80`.
    - Every existing snapshot unchanged.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/infra/cloudflare-move src/runtime src/portainer-target src/hosting && pnpm lint`
  - Effort: high

- [ ] T2808 [P] [US1] [US4] Templates: the workflows' `_NEW` paths and the Workers root's `custom_domains`
  - Owns: `packages/iac-templates/src/workflow/{index,portainer,cloudflare-workers}.ts` (the parts below), `packages/iac-templates/src/infra/serverless.ts`, the snapshots and tests those change
  - Reads: plan 4.1, 10.; data-model 6; `workflow/index.ts` (the tunnel's `ProxyCommand`, `TUNNEL_DEPLOY_SECRETS`), `workflow/portainer.ts` (`WEBHOOK_CALL`, `PORTAINER_DEPLOY_SECRETS`), `workflow/cloudflare-workers.ts` (`CLOUDFLARE_DEPLOY_SECRETS`), `infra/serverless.ts` (`workerHost`)
  - Depends: T2801
  - Decided by the lead: the `_NEW` names are fields of the existing secret-name objects
    (`TUNNEL_DEPLOY_SECRETS.serviceTokenIdNew`…), so no new top-level export.
  - Accept:
    - **Tunnel SSH:** the job's env gains the `_NEW` service token; the generated `ProxyCommand` runs
      `cloudflared access ssh` with A's token and, when that fails and the `_NEW` token is set, once
      more with B's. A script test runs it with a stub `cloudflared` that refuses A's token.
    - **Portainer's webhook:** the call is made with A's Access headers and, when Access refuses
      them (403, or a redirect to its login) and the `_NEW` client is set, once more with B's (in a
      file only the runner user reads, as today). A script test with a stub `curl`.
    - **Workers:** while `CLOUDFLARE_API_TOKEN_NEW` is set, a second deploy step deploys the same
      build and secrets to `CLOUDFLARE_ACCOUNT_ID_NEW`; without it nothing runs.
    - **The Workers root:** `custom_domains` becomes a root variable (`true` in
      `terraform.tfvars.json`), passed to `module "worker"`; the move's shell is `-var
      custom_domains=false`. Both engines `validate`.
    - Without `_NEW` secrets every workflow behaves as before; the snapshots change only by these
      lines, for the targets named, and `isMoveReady(plan, committed)` tells T2810 whether committed
      files have them.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/workflow src/infra/serverless && pnpm lint`
  - Effort: high

- [ ] T2809 [P] [US5] The domain commands' pieces, for the move
  - Owns: `packages/agents/src/domain/**`
  - Reads: plan 5.; data-model 2, 5; `domain/{connect,switch,connect-plan,connect-state,connect-dns,services,registrars}.ts`
  - Depends: T2801
  - Accept: exported from `domain/index.ts`, with `domain connect` built on them and its tests unchanged:
    - `findDomainRegistrar(deps, services, domain, cloudflareAccount)`: `{ kind: "api", registrarId,
      registrar }` for the one configured Porkbun, Namecheap or GoDaddy account that owns it,
      `{ kind: "cloudflare" }` when Cloudflare Registrar holds it in that account, else
      `{ kind: "other" }`; never throws for "not found".
    - `readDs(ctx)`, `removeDsAndWait(ctx, stateFile)` (the wait note written to the given file) and
      `dsWaitStatus(stateFile, now)`.
    - `domainZonesFrom(client)`: a `DomainZoneApi` over any `CloudflareClient` (B's).
    - `publicNameservers(fetch, domain)`: the delegation from a DNS-over-HTTPS lookup.
    - `recordsMissingFromZone(source, zone)` and `sameRecordContent(a, b)`: connect-plan's
      comparison (type, name, normalised content) for zone-to-zone records with every field.
    - Tests against the registrar fakes, a Cloudflare Registrar domain, an unknown registrar, and
      connect's suite unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/domain && pnpm lint`
  - Effort: high

## Phase 3: Wave 2 (parallel)

- [ ] T2810 [P] [US1] [US2] The move's types, its session, the checks and the summary
  - Owns: `packages/agents/src/cloudflare-move/{types,session,checks,summary,texts}*.ts`, the type export line in `packages/agents/src/cloudflare-move/index.ts`
  - Reads: plan 4.1, 4.2, 11.; spec FR-2802 and the edge cases; `retarget/{session,start}.ts`, `domain/common.ts` (`resolveAccount`), `environments/{list,paths}.ts`, `serverless/cloudflare/checks.ts`
  - Depends: T2803, T2804, T2805, T2808, T2809
  - Decided by the lead: B's token is `OPSCREW_NEW_CLOUDFLARE_API_TOKEN`, A's `CLOUDFLARE_API_TOKEN`;
    both registered with the redactor before any call.
  - Accept:
    - **`types.ts`:** `MoveAccounts` (both `CloudflareClient`s, account and zone ids, B's
      `CloudflareSetup`), `MoveSession` (deps, services, the app's paths, the covered environments
      with their plans, both accounts, GitHub, `approve`, `command`), `MoveServices` (the fakes'
      seams: both Cloudflare APIs, engine, GitHub, remote, host, Portainer, Docker, registrars,
      `sleep`, `now`, `fetch`), `ShadowRoot` (`name`, `dir`, `statePath`, `dataDir`, `vars`),
      `StepStop`, `MoveResult`, and each step's options.
    - **`openMoveSession(deps, options)`:** the covered environments (the zone: `dns.zone`, else
      `findZone(dns.domain)` with A's token; those in another zone named as staying; a destroyed one
      skipped and named), A's account from A's zone, B's from `--to` (id or exact name), B's
      `CloudflareSetup` once B's zone exists, GitHub, the engine and the state passphrase as
      `existingStateEngine` reads them.
    - **Refusals before any change** (the spec's edge cases): a missing or wrong token, B equal to A,
      A's zone not active or held, a retarget or another move for the zone, a preview environment, the
      localhost target, B's missing account permissions (only those the app's pieces need), and
      committed files the move can't use yet (`isMoveReady`: "run `opscrew provision`, commit, then
      start the move").
    - **The other apps** found in A's zone, by hostname.
    - `moveSummary(session, sizes)` (plan 4.2); `confirmStart` refused → nothing changed.
    - Tests with the two-account fake: several environments (one in another zone), several apps,
      every refusal, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: high

- [ ] T2811 [P] [US1] [US3] Provision's seams the move plans through
  - Owns: `packages/agents/src/provision/{plan-apply,credentials,shared-cloudflare,origin-tls,storage}.ts` (+ tests)
  - Reads: plan 3., 4.4, 7.6, 11.; data-model 7; T2804's and T2805's blocks
  - Depends: T2804, T2805
  - Accept:
    - **`planAndApply`:** `vars` (passed to `plan` and kept by `planRunOptions` when a plan is made
      again); a `move` option that skips the server providers' follow-ups (`syncFirewalls`,
      `syncProviderBackups`, `markWantedBackups`), names its token variable in the hints
      (`OPSCREW_NEW_CLOUDFLARE_API_TOKEN` instead of `CLOUDFLARE_API_TOKEN`) and saves under
      `MOVE_PLAN_SUFFIX` (`-move.tfplan`), which provision, retarget, a Portainer change and
      rotation refuse to apply as they refuse `ROTATION_PLAN_SUFFIX`; callers pass `costDelta: null`.
      Every caller compiles unchanged.
    - **`setupCloudflare`:** `accountId?` passed to `findZone`; a zone whose status is `moved`
      refused: "<zone> moved to another Cloudflare account: set CLOUDFLARE_API_TOKEN to that account's
      token, then run the command again. Nothing was changed."
    - **The shared plan:** `planSharedCloudflare` and `applySharedCloudflare` take an optional record
      path and client (B's), and pass `waitForActive: false` on a pending zone; defaults unchanged.
    - **Origin TLS:** `originTlsNext` read, kept, promoted (`promoteNextOriginTls`) and forgotten;
      every key registered with the redactor.
    - **Bucket keys:** `requireStorageKey` and `requireOffsiteKey` take an R2 bucket's account; kept
      keys carry `account`; `NEW_OFFSITE_KEY_VARS` (`OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID`,
      `OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY`) for B's backups bucket; a kept key without `account`
      still matches.
    - Provision's tests pass unchanged; new tests for each seam, with a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/provision && pnpm lint`
  - Effort: high

- [ ] T2812 [P] [US1] [US2] The record, the local files, and the guards
  - Owns: `packages/agents/src/cloudflare-move/{record,progress}*.ts`, `packages/agents/src/provision/guard*.ts`, the guard in `packages/agents/src/destroy/run.ts`, the refusal in `packages/agents/src/retarget/{run,start}.ts`, the guard lines in `packages/agents/src/rotate/**` entry points and `packages/agents/src/environments/{add,previews}.ts`, the opt-out in `packages/agents/src/design/run.ts` (+ tests)
  - Reads: plan 2., 11.; data-model 1, 2; `retarget/pending.ts`, `provision/guard.ts`, `destroy/run.ts`, `rotate/` (each exported rotation), `environments/{add,previews}.ts`
  - Depends: T2803
  - Accept:
    - `record.ts`: read and write `cloudflareMove` in each covered plan (atomic); step transitions.
    - `progress.ts`: data-model 2's two files (zod, atomic), the pending plan as retarget's
      (`writePending`, `pendingMatches`, `clearPending` by action, environment and root).
    - **`requireNoCloudflareMove(plan)`** ("A move of <zone> to another Cloudflare account is in
      progress." with its step's hint: continue, `--switch`, `--finish`, `--abort`), called by
      `requireNoMoveInProgress` unless `{ allowCloudflareMove: true }` (which design passes), by
      `destroy` and by `retarget` (whose start also refuses, and the move refuses during a retarget).
      Snapshot, rollback and advise don't call it; `moveInProgress`'s messages stay retarget's.
    - Every rotation refuses at its entry point; adding a preview environment refuses.
    - Tests: each guard per step, design and snapshot still allowed, the record's round trip, a
      damaged local file read as absent.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move src/provision/guard src/destroy src/retarget/run src/retarget/start src/rotate src/environments src/design && pnpm lint`
  - Effort: high

## Phase 4: Wave 3 (parallel; after T2802's results)

- [ ] T2813 [P] [US1] [US3] [US4] Shadow states
  - Owns: `packages/agents/src/cloudflare-move/shadow*.ts`
  - Reads: plan 3.; data-model 3; research R10; `shared/engine.ts`, `provision/plan-apply.ts`, `retarget/plans.ts` (`planBounded`, saved-plan approvals), `provision/storage.ts`, `destroy/deletion.ts`
  - Depends: T2802, T2807, T2808, T2810, T2811, T2812
  - Accept:
    - `shadowRoots(session, environment)`: the roots of plan 3., each a `ShadowRoot` (data-model 3,
      `vars` from `accountVariables` with B's setup, plus `custom_domains=false` for a site's root).
    - `seedShadow(root)`: the environment's state copied, every Cloudflare address removed
      (`stateRemove`) against the shadow backend; no environment state → empty; seeded → kept.
    - `planShadow(session, root)`: plan 3.'s planning through `planAndApply`'s `move` option;
      `planBounded` allowing only creates of Cloudflare addresses; scripts stop with the hash,
      `--approve` applies the saved plan.
    - `shadowOutputs(root)`; `importIntoShadow(root, address, id)` (`importResource`);
      `swapShadow(root)` (two renames, resumable from the files present); `patchTfvars(root)` (only
      `accountVariables`' keys); `checkAfterSwap(session, root)` (`planBounded`: no change, or
      in-place updates of Cloudflare addresses only, approved by hash); `prepareRemoval(root)`
      (non-Cloudflare and zone-scoped addresses removed); `planRemoval(session, root, side)` (destroy
      plan with that side's token, ids and data folder: A's account-scoped pieces, or all of B's;
      `allowDestroy`, the app's name typed); `dropShadow(root)`.
    - Tests with the real engines from `.tools/bin` (skipping without them) on a fixture root with a
      server-like resource and Cloudflare-like resources behind a mock provider: seed, plan, import,
      swap, patch, check, removal, resuming after each rename; both engines; OpenTofu encryption;
      `-var`s with ids only.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/shadow && pnpm lint`
  - Effort: xhigh

- [ ] T2814 [P] [US1] B's shared plan, A's Origin CA certificate, B's shared removal
  - Owns: `packages/agents/src/cloudflare-move/shared*.ts`
  - Reads: plan 4.4.1, 7.7, 8.; ADR 0014, ADR 0017; `provision/{shared-cloudflare,origin-tls}.ts`; research R10.2, R10.7
  - Depends: T2802, T2805, T2810, T2811
  - Accept:
    - `planBShared(session, environment)`: provision's shared plan for this environment in B's zone
      with B's client and record (plan 4.4.1), approved by hash, `waitForActive: false` on a pending
      zone (or O1's fallback, per R10).
    - `revokeAOrigin(session, environment)`: A's Origin CA certificate of the app revoked with A's
      client, `cloudflare-apply` with `allowDestroy` and the app's name typed; A's rules, client
      certificate and AOP settings left to A's moved zone; A's Zero Trust pieces never touched.
    - `removeBShared(session, environment)` (abort): the app's hostnames off B's rules, B's client
      certificate and AOP settings removed, B's Origin CA certificate revoked, `originTlsNext`
      forgotten.
    - Tests: a proxied cloud server, Portainer in Caddy mode, an own server in tunnel mode (no origin
      TLS), a Workers site with `www`; no private key in any plan, hash or output.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/shared && pnpm lint`
  - Effort: high

- [ ] T2815 [P] [US1] B's connector beside A's
  - Owns: `packages/agents/src/cloudflare-move/connector*.ts`, additions to `packages/agents/src/provision/{portainer-flow,stack-plan}.ts` (+ tests)
  - Reads: plan 4.4.3, 7.4, 8., 9.; `rotate/infra-connectors.ts`, `shared/host-plan.ts`, `vpn/servers.ts` (`networkServer`), `provision/portainer-flow.ts`; T2806's and T2807's blocks
  - Depends: T2802, T2806, T2807, T2810
  - Accept:
    - `besideConnector(session, environment, tunnels)`: on a server (an own server in tunnel mode as
      root, a cloud server's subdomain connector as the login), `planNextTunnelConnector` with B's
      token on standard input, through `approveAndApplyHostPlan`; in Portainer, the beside stacks
      through one stack plan approved by hash. Up to date → skipped.
    - `takeOverConnector(session, environment, tunnels)` (finish): the main connector restarts with
      B's tunnel token (`serverTunnelConnectors(…).restart`, `portainerTunnelConnectors(…).restart`),
      then the beside connector is removed.
    - `removeBesideConnector(session, environment)` (abort), then `waitForNoConnection(client,
      account, tunnelId)` (`tunnelConnections` until `closed`, bounded, a plain stop otherwise), also
      used before A's tunnel is destroyed.
    - Tests with the host and Portainer fakes for each target and web mode, a run after each step,
      the token never in a plan, its hash or an output.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/connector src/provision && pnpm lint`
  - Effort: xhigh

- [ ] T2816 [P] [US3] R2: first copies, the finish's window, emptying buckets
  - Owns: `packages/agents/src/cloudflare-move/buckets*.ts`, `packages/agents/src/shared/rclone*.ts`, the rclone part of `packages/agents/src/retarget/bucket.ts` (+ tests)
  - Reads: plan 4.4.5, 7.1, 7.2, 7.3, 7.7, 8.; data-model 2, 7; `retarget/{bucket,window,server-ops}.ts`, `retarget/sides/postgres.ts` (the archive API's one-file write), `shared/deploy-pause.ts`, `provision/storage.ts`, `shared/app-env.ts` (`r2Endpoint`)
  - Depends: T2802, T2810, T2811, T2812
  - Accept:
    - **`shared/rclone.ts`:** retarget's rclone container (pinned image, keys on standard input, the
      redacted failure) extracted, with an R2 remote (`provider = Cloudflare`, the account's
      endpoint), an SSH runner and a Docker runner (Portainer: the configuration written through the
      archive API into the created container, removed afterwards); `retarget/bucket.ts` uses it and
      its tests pass unchanged.
    - `measureBuckets`; `firstCopies(session, environment)`: one `remote-exec` approval listing each
      bucket, its size, objects and minutes; `rclone copy --checksum --metadata`, resumable.
    - `bucketWindow(session, environment, pointAtB)` (plan 7.2): the approval with its length, the
      pause and the wait, `window.stoppedAt`, the stop, `rclone sync`, then `pointAtB()` (T2823's step
      1); on any failure the secrets and values back to A's and the app started on A; a run that finds
      `stoppedAt` starts the app on A first. `appSettingsForB(session, environment)` gives step 1 the
      bucket's part.
    - `lastBackupsCopy` (plan 7.3).
    - `emptyBuckets(session, environment, side)`: at the finish `rclone check --one-way` A → B, then
      `rclone delete`; at an abort B's without the check; each a `remote-exec` approval with
      `allowDestroy` and the bucket's name typed.
    - Tests: a cloud server and a Portainer app with both buckets, a window failing at each point
      (the app back on A), a resumed window, keys never in a command line, a container's `Env` or
      `Cmd`, an output or an audit entry.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/buckets src/shared/rclone src/retarget/bucket && pnpm lint`
  - Effort: xhigh

- [ ] T2817 [P] [US1] [US2] The zone plan: B's zone, the copy, the marks, coverage
  - Owns: `packages/agents/src/cloudflare-move/{zone,marks}*.ts`
  - Reads: plan 4.3, 4.5, 5.1, 5.2, 7.8; data-model 4, 5; `provision/shared-cloudflare.ts` (how a `cloudflare-apply` plan is shown and approved); T2804's and T2809's blocks
  - Depends: T2804, T2805, T2807, T2809, T2810
  - Accept:
    - `planZone(session, { marks })`: data-model 5's `ZoneCopy` made in agents on
      `recordsMissingFromZone`: create-only; differences and records only in B listed, never changed;
      Cloudflare-managed records, OpsCrew's and the marks skipped; the app's servers' addresses
      masked in what is shown; its hash over canonical JSON.
    - `applyZone(session, plan)`: approved by hash (`cloudflare-apply`); makes the plan again and
      refuses another hash; creates B's zone when asked, then checks B's nameservers (equal to A's →
      plan 4.3's stop) and B's zone-level permissions (each missing one named) before any record;
      then the records and the marks.
    - `marks.ts`: the label, the content (data-model 4, split in parts), parsing with zod,
      `readMarks(session)`, `writeMark` and `deleteMark` through `planZone`/`applyZone`.
    - `coverage(session)`: A's OpsCrew names (records with the comment, the rules' hostnames, Workers
      custom domains) against every mark's `hosts`: the names not covered, and the marks read.
    - Tests with the two-account fake: a first prepare, a second app's prepare in the same zone, A's
      records changed between them (created, changed: listed only), coverage with one app missing,
      marks in parts, the same nameservers, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/zone src/cloudflare-move/marks && pnpm lint`
  - Effort: high

- [ ] T2818 [P] [US1] [US4] The deploy's `_NEW` credentials
  - Owns: `packages/agents/src/cloudflare-move/deploy-secrets*.ts`
  - Reads: plan 4.4.4, 7.1, 7.5, 8., 10.; data-model 6; `rotate/infra.ts` (`accessSecrets`, `setSecretAt`), `serverless/cloudflare/{checks,provision}.ts` (`requireWorkersTokens`), `provision/origin-tls.ts` (`deployRenewedCertificate`), `retarget/types.ts` (`waitForWorkflowRun`)
  - Depends: T2808, T2810, T2812
  - Accept:
    - `addNewCredentials(session, environment, outputs)`: one `github-secrets` approval naming the
      `_NEW` secrets (never values): B's Access deploy credentials from the shadow outputs; for a
      Workers site B's account id and `OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN` (checked against B with
      `requireWorkersTokens`), then the deploy workflow dispatched and awaited so B's Worker runs the
      current code. Same values already set → skipped.
    - `promoteNewCredentials(session, environment)` (finish): the plain names take the `_NEW`
      values, the `_NEW` ones are deleted; `dropNewCredentials` (abort).
    - Tests with the GitHub fake for own-tunnel, Portainer webhook and Workers environments, with and
      without a GitHub environment, and a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/deploy-secrets && pnpm lint`
  - Effort: high

## Phase 5: Wave 4 (parallel)

- [ ] T2819 [US2] [US4] [US5] The switch and the HTTPS gap
  - Owns: `packages/agents/src/cloudflare-move/{switch,gap}*.ts`
  - Reads: plan 5., 6.; data-model 2; spec FR-2806 to FR-2809; `domain/{switch,connect}.ts`; T2809's and T2817's blocks
  - Depends: T2804, T2809, T2810, T2812, T2817
  - Accept:
    - `switchMove` replaces T2801's stub: plan 5.'s steps in order, each checked before it acts; the
      switch plan's hash covering everything 5.5 lists; with DNSSEC on, the DS run and stop, then a new
      plan and a new approval after the wait; the approval's text as 5.5; the nameserver change, or
      Cloudflare Registrar's steps, or another registrar's; the custom domains attached right after
      activation (and A's detached first when Cloudflare refuses, per plan 13.); DNSSEC on in B when
      `dsAtStart`; the output with the times, then each finish (origin-protected apps first). The marks
      stay.
    - `measureGap` (plan 6.): the 30-second loop with injected `sleep`, `now` and `fetch`, the two-hour
      limit then a stop the next run continues with the same times.
    - Resumed at every point (before and after the DS removal and the nameserver change, pending,
      active without a certificate, all answered) with nothing done twice; a rerun from another
      repository after activation finds the marks and the attached domains.
    - Tests with the two-account fake and the registrar fakes: Porkbun with and without DNSSEC,
      Cloudflare Registrar, another registrar, an unprepared app, a Workers site, a slow certificate, a
      hostname answering 526, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/switch src/cloudflare-move/gap && pnpm lint`
  - Effort: xhigh

- [ ] T2820 [US1] [US2] [US3] [US4] Prepare
  - Owns: `packages/agents/src/cloudflare-move/prepare*.ts`
  - Reads: plan 4., 9., 10.; data-model 1, 2
  - Depends: T2812, T2813, T2814, T2815, T2816, T2817, T2818
  - Accept:
    - `prepareMove` replaces T2801's stub: plan 4.'s steps for every covered environment and every
      target of plan 9.; the record's steps and `dsAtStart`; pending plans; the mark last; a recorded
      move continued without `--to`; a different `--to` refused.
    - Interrupted after every sub-step and run again (interactively and with `--approve`): nothing done
      twice, and A's fake saw no write.
    - Tests per target, two environments, two apps in one repository, a leak check over every fake.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: xhigh

- [ ] T2821 [US1] Abort
  - Owns: `packages/agents/src/cloudflare-move/abort*.ts`
  - Reads: plan 8.; data-model 1, 2, 3
  - Depends: T2809, T2812, T2813, T2814, T2815, T2816, T2817, T2818
  - Accept:
    - `abortMove` replaces T2801's stub: refused once the switch changed anything, judged as plan 8.
      says from the delegation, `dsAtStart` and the registry's DS records, B's zone status and the
      records' steps (no switch file needed); otherwise plan 8.'s order, each removal approved with its
      kind and typed name; B's zone deleted only with its name typed and no other mark or OpsCrew
      record in it.
    - Resumed after every step; A's fake saw no write in the whole abort.
    - Tests per target, an abort with another app prepared in B (the zone stays), an abort refused
      after the nameservers changed and after a DS removal, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: high

- [ ] T2822 [US1] [US4] Finish, part 1: A's removal, the site's adoption, the mark
  - Owns: `packages/agents/src/cloudflare-move/{finish-removal,finish-site}*.ts`
  - Reads: plan 7.5, 7.7, 7.8; data-model 3, 4
  - Depends: T2813, T2814, T2815, T2816, T2817, T2818
  - Accept:
    - `adoptSite(session, environment)`: the custom domains the switch attached imported into the
      site's shadow state (`workerCustomDomainAddresses`), the check plan with `custom_domains = true`
      (no change), then `promoteNewCredentials`.
    - `removeA(session, environment)`: A's tunnels waited on until they have no connection; the
      A-removal destroy plans (account-scoped only); A's buckets checked, emptied and deleted;
      `revokeAOrigin`; nothing zone-scoped in A touched.
    - `endFinish(session)`: the app's mark deleted; `cloudflareMove` removed from every covered
      plan; the local files deleted; the output's variables to change.
    - Each resumable; a refused typed name leaves the app on B and the step repeatable.
    - Tests per target with the two-account fake (A's zone moved), a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/finish-removal src/cloudflare-move/finish-site && pnpm lint`
  - Effort: high

## Phase 6: Wave 5

- [ ] T2823 [US1] [US3] Finish, part 2: the steps in order
  - Owns: `packages/agents/src/cloudflare-move/finish*.ts` except T2822's files
  - Reads: plan 7., 9.; data-model 1, 2, 3, 7
  - Depends: T2813, T2815, T2816, T2818, T2822
  - Accept:
    - `finishMove` replaces T2801's stub: refused unless every covered environment is `prepared` and
      B's zone is active; then plan 7.'s steps per environment and target: step 1's one approval and
      one deploy (or stack plan), wrapped by the window when there is an app bucket; the last backups
      copy; the connector; the site's adoption; the swap with the tfvars patch and the check plan
      (`adopted`); A's removal; the end.
    - Resumed after every step (the window's recovery first).
    - Tests per target, a leak check, and that after the finish `setupCloudflare` with A's token
      refuses the moved zone.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: xhigh

## Phase 7: Wave 6 (parallel)

- [ ] T2824 [US1] [US2] The CLI, status, MCP and the plugin
  - Owns: `packages/cli/src/commands/cloudflare*.ts`, `packages/cli/src/ui/cloudflare-move*.ts`, the command's registration in `packages/cli/src/commands/index.ts`, the move's line in `packages/cli/src/commands/status.ts`, `packages/cli/test/e2e/cloudflare-move.test.ts`, `packages/mcp-server/src/{server,tools/status}.ts` (+ tests), `plugin/skills/opscrew-deploy/SKILL.md`
  - Reads: plan 1., 11.; `cli/src/commands/retarget.ts`, `cli/src/ui/retarget.ts`, `cli/src/approval.ts`, `mcp-server/src/tools/status.ts`
  - Depends: T2819, T2820, T2821, T2823
  - Accept:
    - `opscrew cloudflare move` with plan 1.'s flags; `--env` refused plainly; typed names asked in a
      terminal, `--confirm` (repeatable) in a script; `--approve` and `--allow-downtime` as in
      retarget; `--help` explains each step.
    - `opscrew status`: the move's step per environment always, and the apps prepared (B's marks) only
      when `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` is set; `opscrew_status` the same in its data and text,
      naming the terminal command; the server's terminal-only list gains the move.
    - The deploy skill: when to move, the steps, every approval in the user's terminal.
    - The e2e with fakes runs prepare, switch, finish and abort for a cloud server, an own server in
      tunnel mode and a Workers site through the CLI.
  - Verify: `pnpm turbo run typecheck --filter=opscrew --filter=@opscrew/mcp-server && npx vitest run --root packages/cli test/e2e/cloudflare-move.test.ts src/commands && npx vitest run --root packages/mcp-server && node plugin/validate.mjs && pnpm lint`
  - Effort: high

- [ ] T2825 [P] [US1] [US2] [US3] [US4] [US5] The guide
  - Owns: `docs/guide/cloudflare-move.md`, its links in `docs/guide/{index,cloudflare,several-apps,environments,origin-protection,domains,retarget,object-storage,snapshots,previews,cloudflare-hosting}.md`, one line in `README.md`
  - Reads: spec FR-2817; plan 4. to 14.; quickstart; `docs/guide/retarget.md` (the style)
  - Depends: T2819, T2820, T2821, T2823
  - Accept: FR-2817's topics, true facts only, written for users: when to use it; B's token and its
    permissions; files brought up to date first; the steps; each registrar (Porkbun, Namecheap,
    GoDaddy, Cloudflare Registrar, another) and DNSSEC's wait with its second approval; the HTTPS gap
    and why (Universal SSL; paid certificates named; an HSTS-preloaded name makes it an outage); a
    site on Cloudflare's hosting answering once the switch attaches its custom domains; deploys on
    both sides of the switch; possible 526 answers until each finish while unconfirmed; R2's window
    and copies (and the lifecycle counting from the copy); several apps and repositories;
    environments; previews; what OpsCrew doesn't move (plan 14., a user's own R2 bucket used as
    `snapshots.offsite.provider: s3` among them); what stays in A; the variables after the finish;
    when an abort is refused; moving back.
  - Verify: `node -e "const fs=require('fs'),p=require('path');const d='docs/guide';const bad=[];for(const f of fs.readdirSync(d)){const t=fs.readFileSync(p.join(d,f),'utf8');for(const m of t.matchAll(/\]\(([^)#:]+\.md)(#[^)]*)?\)/g)){if(!fs.existsSync(p.join(d,m[1])))bad.push(f+' -> '+m[1])}}if(bad.length){console.error(bad.join('\n'));process.exit(1)}" && pnpm lint`
  - Effort: medium

## Phase 8: Wave 7

- [ ] T2826 The live test files for the rehearsal and the real move, and `docs/e2e.md`
  - Owns: `packages/cli/test/live/cloudflare-move*.ts`, the move's section of `docs/e2e.md`
  - Reads: plan 15.; quickstart's live part; `packages/cli/test/live/{harness,retarget-anywhere,own-server,live,snapshots-support,tls-support}.ts`
  - Depends: T2824
  - Accept:
    - Legs L0 to L6 of plan 15., gated on `OPSCREW_E2E_CLOUDFLARE_MOVE=1`, each run on its own with
      vitest `-t`, each skipping with a message without its variables; L4a and L4b chosen by L0's
      registrar; a leg that stops on a wait says when to run it again.
    - L0's inventories of both accounts, including what OpsCrew didn't make (plan 14.), written for
      the lead's checklist; the cleanup removes only P's and Q's pieces and never touches the real
      apps or A's moved zone.
    - The zone, both account ids and every address masked in every output under labels of their own;
      the leak search runs whole.
    - Pure helpers tested in `cloudflare-move-support.test.ts`; `docs/e2e.md` says how to run each
      leg, in which order, and what it costs.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && npx vitest run --root packages/cli test/live/cloudflare-move-support.test.ts && pnpm lint`
  - Effort: high

## Phase 9: The real move and the release (lead)

- [ ] T2827 The rehearsal and the real move of opscrew.dev (lead): T2826's legs on the final code,
  with the checklist of plan 15.; `docs/e2e-coverage.md`'s row and results (the gap's figures,
  SC-2801 to SC-2807); then `.env.e2e`'s tokens for the zone become B's.
- [ ] T2828 Simplify across the feature's code (lead): read-only reviews per area, then one
  implementer per area so no two edit the same file; known so far: the move's and retarget's
  pending-plan files, the texts kept per file, the two rclone call sites.
- [ ] T2829 `CLAUDE.md`'s package notes (the move's folder), and the roadmap: 028 done (lead).
- [ ] T2830 The release 0.2.9, following `docs/releasing.md` (lead).

## Dependencies and waves

| Wave | Tasks | Depends on |
|---|---|---|
| Lead | T2801, T2802 | — |
| 1 | T2803, T2804, T2805, T2806, T2807, T2808, T2809 | T2801 |
| 2 | T2810, T2811, T2812 | each its own of wave 1 |
| 3 | T2813, T2814, T2815, T2816, T2817, T2818 | wave 2, T2802 |
| 4 | T2819, T2820, T2821, T2822 | wave 3 |
| 5 | T2823 | T2822 and wave 3 |
| 6 | T2824, T2825 | waves 4 and 5 |
| 7 | T2826 | T2824 |
| Lead | T2827, T2828, T2829, T2830 | T2826 |

No two tasks of a wave share an `Owns` path. Wave 1's connector files are T2804's (`client.ts`,
`index.ts`) and T2805's (`testing/**`, `shared.ts`); its template files are T2807's (new files and
the index export lines) and T2808's (`workflow/{index,portainer,cloudflare-workers}.ts`,
`infra/serverless.ts`). Wave 2's provision files are T2811's (`plan-apply`, `credentials`,
`shared-cloudflare`, `origin-tls`, `storage`) and T2812's (`guard`). Wave 3's are T2815's
(`portainer-flow`, `stack-plan`) only. Wave 4's finish files are T2822's (`finish-removal`,
`finish-site`); T2823 owns the rest of `finish*` in wave 5.
