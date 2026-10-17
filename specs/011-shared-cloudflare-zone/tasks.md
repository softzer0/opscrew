---
description: "Tasks for 011-shared-cloudflare-zone"
---

# Tasks: Several OpsCrew apps in one Cloudflare zone

**Input**: `specs/011-shared-cloudflare-zone/` (spec.md, plan.md, research.md, data-model.md,
contracts/, quickstart.md) + features 000–010 (packages and conventions).
**Numbering**: T1101–T1199. **Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads /
Depends / Accept / Verify / Effort`. Fixtures never contain secret-shaped literals (`fakeSecret()` /
`{{FAKE:…}}` + `materializeFixture()`). No test touches a real Cloudflare account, network or model.
Starts after 010's DRY pass (Phase 7 of `specs/010-portainer-target/tasks.md`).

## Phase 1: Foundation (serial)

- [X] T1101 Approval kind, local record, constitution and ADR in `packages/contracts/src/safety.ts`, `packages/core/src/{approvals,paths}.ts` (+ tests); the constitution 1.5.0 and ADR 0014 by the lead
  - Owns: those paths (+ their tests)
  - Reads: plan.md "1. Contracts and approvals"; data-model.md "Local record"; how 010's T1001 added `stack-apply`
  - Depends: —
  - Accept:
    - `ApprovalKind` includes `"cloudflare-apply"`.
    - Core's approval table requires a 64-hex plan hash for `cloudflare-apply`, with the same messages as `stack-apply`. `--yes` never grants it.
    - `assertApprovedCloudflarePlan(hash, { allowDestroy })` is on the gate, like the host and stack ones.
    - `ProjectFiles` has `cloudflareRecord` (`.opscrew/cloudflare.json`).
    - Every other approval kind is unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/contracts --filter=@opscrew/core --filter=@opscrew/agents`
  - Effort: high

## Phase 2: Packages (parallel)

- [X] T1102 [P] [US1] [US2] [US3] [US4] [US5] Shared-resources adapter in `packages/connectors/cloudflare/src/shared.ts` (+ tests)
  - Owns: `packages/connectors/cloudflare/src/**` (+ tests)
  - Reads: contracts/cloudflare-shared.md; data-model.md; research.md R1–R5; the client's `inspectEntrypointRuleset`, `accessOrganization`, `accessIdentityProviders`
  - Depends: T1101
  - Accept: `SHARED_RULES`, `inspectShared`, `planShared`, `applyShared` and `SharedApplyError`, as the contract describes.
    - **Writes.** The four Rulesets calls follow the spike facts of R1. `PUT` is sent only to a missing entrypoint. OpsCrew's rule is found by its `ref` and changed by its `id`.
    - **Expressions.** Built from sorted, lower-case hostnames, using today's probe paths and the strict TLS setting.
    - **Plans.**
      - Adding the first hostname creates OpsCrew's rule (or the entrypoint).
      - Removing the last hostname deletes the rule. When the ruleset then has no rules, it is deleted too.
      - Nothing to change means an empty plan.
    - **Findings.**
      - `hostname-claimed`: the hostname is in the rule but not in the record.
      - `no-rule-slot`: the Free plan's 5 custom or 10 configuration rules are reached.
      - `expression-too-long`: over 4,096 characters, counted before the plan.
      - `rule-changed`: action, parameters, paths or enabled differ from the template; nothing is written for that rule.
      - `permission-missing`: 403 on a read.
    - **Apply.**
      - It checks the hash, re-reads the entrypoint, and stops with `PHASE_PRECONDITION` (nothing written) when OpsCrew's rule differs from the plan's `expect`.
      - It verifies the returned ruleset after each write.
      - It never retries a write after a 5xx, a timeout or a lost connection. The error says the change may have reached Cloudflare.
      - The Zero Trust organization and the one-time-PIN identity provider are created when absent and never deleted.
    - **Tests.** A fake zone behaves like the spike. One test confirms that the user's own rules come back byte-identical, in the same order, after every kind of change.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare`
  - Effort: xhigh

- [X] T1103 [P] [US1] [US2] Templates without zone rulesets or account-wide Zero Trust resources in `packages/iac-templates/**`
  - Owns: `packages/iac-templates/**` except `package.json` (+ tests, snapshots)
  - Reads: plan.md "3. Templates"
  - Depends: T1101
  - Accept:
    - **Removed rules.** `cloudflare-dns` no longer has `cloudflare_ruleset.config` or the `waf` module call, and `cloudflare-tunnel` has no `waf` call. `cloudflare-waf` is deleted, along with `manage_config_rule`, `manage_waf_rules`, `ruleset_ids` and the roots' `cloudflare_rulesets` output.
    - **Access module.** `cloudflare-access` has no `cloudflare_zero_trust_organization` and no identity-provider resource. `one_time_pin_identity_provider_id` is a plain input wherever the Portainer login is used, and `create_organization` goes.
    - **Checks.**
      - The generated `modules.ts` is regenerated.
      - Both engines validate every root (`OPSCREW_IT=1`).
      - The snapshots change only by these removals.
      - Hetzner, DigitalOcean, own-server and Portainer roots still render their DNS, tunnel and Access applications as before.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `OPSCREW_IT=1` for it
  - Effort: high

## Phase 3: Flows

- [X] T1104 [US1] [US3] [US5] Provision, `dns` and `domain connect` plan and apply the shared change in `packages/agents/src/{provision,shared,dns,domain,portainer}/**`
  - Owns: those folders (+ tests); the import lines that follow in `packages/cli/src/**` and `packages/mcp-server/src/**`
  - Reads: plan.md "4. Flows"; contracts/cloudflare-shared.md
  - Depends: T1102, T1103
  - Accept:
    - **Every target** with a Cloudflare zone (Hetzner, DigitalOcean, own server, Portainer) gets the shared change first, in a fixed order:
      1. `planShared` for the app's hostnames, plus the Zero Trust pieces when Access is used;
      2. the plan shown, with this app's hostnames added and removed and other apps' hostnames as a count;
      3. approval as `cloudflare-apply` (`--yes` never grants it, `--approve` takes its hash);
      4. `applyShared`;
      5. `.opscrew/cloudflare.json` written;
      6. then the IaC plan, which takes the organization and identity-provider ids from the result.
    - **`--plan-only`** shows the shared plan.
    - **Re-running** with nothing changed asks nothing.
    - **`dns` and `domain connect`** re-plan the shared change when hostnames change.
    - **The T919 entrypoint-ownership logic** in `provision/credentials.ts` and the skip warning go.
    - **The Portainer add-on and the Portainer target's Access** take the ids the same way.
    - **Tests** cover two apps in one fake zone, a zone with the user's own rules, a claimed hostname, the expression limit, and a plan made stale by a second app.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: xhigh

- [X] T1105 [US2] [US4] Destroy, drift and init in `packages/agents/src/{destroy,drift,init}/**`
  - Owns: those folders (+ tests)
  - Reads: plan.md "4. Flows"; data-model.md
  - Depends: T1104
  - Accept:
    - **Destroy.**
      - It plans the removal of this app's hostnames, including deleting an OpsCrew rule left empty and the entrypoint when that rule was its only one.
      - That removal is part of the deletion preview and the typed confirmation (`allowDestroy`), and runs after the IaC destroy.
      - Destroy says the Zero Trust organization and identity provider stay.
      - A damaged `.opscrew/cloudflare.json` stops with nothing changed.
    - **An empty entrypoint left by an interrupted destroy** (OpsCrew's rule deleted, the entrypoint's delete not answered): destroy deletes an entrypoint listed in the record's `createdEntrypoints` when it holds no rules (from the T1102 review).
    - **Drift** reports a missing OpsCrew rule, a missing hostname of this app, and a rule changed beyond its hostnames.
    - **Init** reads both entrypoints and names Zone WAF → Edit or Config Rules → Edit when a read answers 403.
    - Every target's destroy keeps its other checks.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: high

## Phase 4: Surfaces and live test

- [X] T1106 [US1] [US2] [US4] CLI, MCP tools, plugin and user docs in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`
  - Owns: those paths (+ tests)
  - Reads: plan.md "5. Surfaces"; quickstart.md
  - Depends: T1105
  - Accept:
    - **CLI.** It prints the shared plan, called "Cloudflare plan" in output to match core's approval messages, like the stack plan. When the Cloudflare plan deletes OpsCrew's rule, the printed `--approve` command also carries `--confirm <app>` (from T1104). `--approve` takes its hash (`cloudflare-apply` added to the CLI's `APPROVE_BY_HASH_KINDS`), and a CLI test shows `--yes` never grants it, next to the stack-plan one.
    - **MCP.** `opscrew_plan` and `opscrew_apply` include the shared plan. Its approval goes through the dialog, never auto-approved.
    - **Plugin.** The deploy skill mentions the extra approval.
    - **Guide.** The Cloudflare domain pages explain:
      - sharing a zone and an account between apps;
      - the two shared rules and their limits;
      - how to free a hostname;
      - the token permissions.
    - `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server` and `node plugin/validate.mjs`
  - Effort: high

- [X] T1107 [US1] [US2] [US3] Live tests with a second app in the same zone and account in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: plan.md "6. Live tests"; quickstart.md "Live"
  - Depends: T1106
  - Accept:
    - **Second app.** The own-server and Portainer live tests deploy a second app, B, into the same zone and account, on a hostname of the run (`e2e-<id>-b.<zone>`: Cloudflare's free certificate covers only one level below the zone).
      - B has its own throwaway repository, from the new optional `OPSCREW_E2E_GITHUB_REPO_B`. The run's GitHub token (and, for Portainer, `OPSCREW_E2E_REPO_READ_TOKEN`) must cover it too. Without it, the second-app checks are skipped with a plain message and the rest runs as before (lead, 2026-10-17).
      - Own server: one OpsCrew app per server until 013, so B goes on a second throwaway server created like step 1's, in tunnel mode. A and B then share the account's Zero Trust organization.
      - Portainer: B is a second stack in the same Portainer, with the Cloudflare Tunnel (web mode `tunnel`).
    - **User rules.** Before the first provision, they seed one user rule per phase that matches nothing (a hostname under the run's subdomain that does not exist).
    - **Protection.** They check that `/.env` is blocked for A and B, and that each hostname is in the shared rules its mode uses. A tunnel or Portainer app is only in the probe block, never in the strict-TLS rule (lead, 2026-10-17, from the T1107 report).
    - **Destroying A** leaves B working and protected.
    - **Destroying B** removes OpsCrew's rules and leaves the seeded rules byte-identical. The Zero Trust organization and identity provider remain.
    - **Cleanup.** It removes the seeded rules and keeps the leftover checks for this run's resources.
      - The harness's leftover check no longer looks for whole "OpsCrew …" rulesets (`rulesetOfRun`). It looks for OpsCrew's rules by `ref`.
      - None of the run's hostnames may remain in them.
      - A rule left holding only the run's hostnames is deleted and reported.
      - An entrypoint the run created (absent from the snapshot before the run) is deleted once empty.
      - "OpsCrew's rules are gone" is asserted only when they held none of the zone's other hostnames before the run.
      - `docs/e2e.md` says to run one live test per zone at a time.
    - **The leak check** covers the shared plans.
    - **Hetzner live run.** It checks its single app's hostnames in the shared rules.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` (live parts skipped)
  - Effort: xhigh

- [ ] T1108 Live runs (lead): own server, Portainer core (with the second app), Hetzner; results in `docs/e2e.md` and `docs/e2e-coverage.md`

- [ ] T1109 [US1] A second app's ghcr.io registry entry in the same Portainer, in `packages/connectors/portainer/src/**` and `docs/guide/portainer-target.md` (found by T1108)
  - Owns: those paths (+ tests); the test lines that follow in `packages/agents/src/**` and `packages/cli/src/**` when they assert the old user name
  - Reads: `packages/connectors/portainer/src/plan.ts` (`registryChange`, the token-replace change); `docs/e2e-coverage.md` row "GHCR accepts the GitHub owner as the registry user name" (any user name works, the token decides)
  - Depends: —
  - Accept:
    - **The cause (live, 2026-10-18).** Portainer refuses a registry entry whose URL and login user name match another entry's: "Another registry with the same URL and credentials already exists". OpsCrew logs every app's ghcr.io entry in as `opscrew`, so a second app in the same Portainer stops at its stack apply.
    - **The fix.** The default login user name of an app's entry is the entry's own name (`names.registry`, for example `opscrew-shop`), both when adding the entry and when replacing its token. An explicit `registry.username` still wins.
    - **The fake Portainer** refuses a second entry with the same URL and user name (with authentication on), with Portainer's message and status. A test adds two apps' entries for ghcr.io in one fake Portainer, and another test shows the refusal for an equal user name.
    - **The guide** (`portainer-target.md`): several apps in one Portainer each get their own ghcr.io entry. Portainer may log in to ghcr.io with any of them when it pulls, so every app's read token must be able to read every app's image (one classic token with `read:packages` from your GitHub account does).
    - Nothing else changes: entry names, grants, the record, destroy and token replacement.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-portainer --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: high

## Dependencies

T1101 → {T1102, T1103} → T1104 → T1105 → T1106 → T1107 → T1108.
