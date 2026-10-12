---
description: "Tasks for 003-day2-operations"
---

# Tasks: Day-2 Operations

**Input**: `specs/003-day2-operations/` (spec.md, plan.md) + features 000–002 (packages and
conventions).
**Numbering**: T301–T399. **Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends /
Accept / Verify / Effort`. Lead-owned contracts, schemas, barrels and placeholders come from T301;
fill only your files. Fixtures never contain secret-shaped literals (`fakeSecret()` / `{{FAKE:…}}`
+ `materializeFixture()`).

## Phase 1: Foundation (lead, serial)

- [X] T301 Contracts, schemas, barrels and placeholders (lead) in `packages/contracts/src/iac.ts`, `packages/plan-schema/src/{facts,requirements,plan}.ts` (+ regenerated JSON Schemas), `packages/agents/src/{destroy,drift,init}/index.ts`, `packages/agents/src/index.ts`, `packages/cli/src/commands/{destroy,drift,init,index}.ts`, `packages/mcp-server/src/tools/{drift,init}.ts`, `packages/mcp-server/src/server.ts`
  - Accept: plan.md "Contracts"; every package still passes `pnpm check`; placeholders throw or report "not implemented yet" (exit 2).
  - Effort: lead

## Phase 2: Packages (parallel)

- [X] T302 [P] [US2] Refresh-only plans and drift parsing in `packages/iac-engine/src/`
  - Owns: `packages/iac-engine/src/**`, `packages/iac-engine/test/**`
  - Reads: plan.md "Engine"; spec FR-305; `packages/contracts/src/iac.ts`
  - Depends: T301
  - Accept: `-refresh-only` passed when `refreshOnly`; `PlanSummary.drift` from `resource_drift` (managed resources only; attribute names only, never values; `delete` vs `update`); unit tests over recorded `show -json` documents (OpenTofu and Terraform shapes); gated integration test with `local_file` drift for both binaries.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-engine`
  - Effort: high

- [X] T303 [P] [US1] [US4] Delete-protection variable, monorepo Docker builds and runbook sections in `packages/iac-templates/src/`
  - Owns: `packages/iac-templates/src/{infra,docker,runbook}/**`, `packages/iac-templates/modules/**` (only if needed), their tests and snapshots
  - Reads: plan.md "Templates"; spec FR-307, FR-309, FR-310; `packages/plan-schema/src/facts.ts` (`appDir`)
  - Depends: T301
  - Accept: root module declares `delete_protection` (default true) and passes it to the server module, never in tfvars; both engines still validate the rendered HCL (existing gated test); every Docker stack honours `facts.appDir` per plan.md (workspace-aware install from the root, app-only copy for Python), with snapshots for an npm, a pnpm and a Python app in a subfolder; root-app output unchanged; runbook gains drift and teardown sections.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T304 [P] [US1] Snapshot, action and server-list methods for Hetzner; secret deletion for GitHub in `packages/connectors/{hetzner,github}/src/`
  - Owns: `packages/connectors/hetzner/src/**`, `packages/connectors/github/src/**`
  - Reads: plan.md "Adapters"; spec FR-302, FR-303
  - Depends: T301
  - Accept: `listServers({ labelSelector })` (paginated), `createSnapshot`, `waitForAction` (injected sleep/now, timeout → `PROVIDER_ERROR`), `deleteActionsSecret` (204/404 ok; invalid name → `INVALID_INPUT`); fake-fetch tests including 429 retry and an action that ends in `error`; tokens never in errors.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-hetzner --filter=@opscrew/connector-github`
  - Effort: medium

- [X] T305 [P] [US4] Chosen app directory in detection in `packages/detect/src/`
  - Owns: `packages/detect/src/**`, `packages/detect/test/**`
  - Reads: plan.md "Detection"; spec FR-307
  - Depends: T301
  - Accept: `DetectOptions.appDir`; facts carry `appDir`; a chosen member becomes the primary app with no candidates; an unknown directory → `INVALID_INPUT` listing the candidates; existing fixtures unchanged except the new `appDir` field (`.` for single apps); tests over `monorepo-turbo` and a two-app fixture.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect`
  - Effort: medium

## Phase 3: Phases

- [X] T306 [US1] Destroy orchestration in `packages/agents/src/destroy/`
  - Owns: `packages/agents/src/destroy/**`
  - Reads: plan.md "Destroy orchestration"; spec US1, FR-301; `packages/agents/src/provision/**` (reuse credentials, engine setup, `findSavedPlan`, fakes pattern)
  - Depends: T302, T303, T304
  - Accept: every step of plan.md in order; tests with fake engine (scripted unprotect, destroy and empty plans), fake Hetzner and GitHub: happy path with snapshot; wrong typed name → nothing deleted and protection kept; `--no-snapshot`; snapshot failure stops before any change; unprotect plan with unexpected changes stops; non-interactive with and without `--confirm`; server already gone; missing Cloudflare token stops; GitHub token missing → cleanup skipped with a warning; plan updated with `destroyedAt` and no addresses; host key removed; no secret value in reporter or audit output; no `apply` before its approval.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [X] T307 [P] [US2] Drift check in `packages/agents/src/drift/`
  - Owns: `packages/agents/src/drift/**`
  - Reads: plan.md "Drift"; spec US2, FR-304; `packages/agents/src/provision/**`
  - Depends: T302
  - Accept: `runDrift` → `DriftReport`; refresh-only + normal plan + `previewDeploymentFiles`; drift plan files deleted afterwards and never get a sidecar; missing state → `PHASE_PRECONDITION`; `renderDriftReport` (text, deterministic); tests: clean, drifted firewall, pending change, edited file, missing state, engine mismatch; `apply` never called.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [X] T308 [P] [US3] Preflight checks in `packages/agents/src/init/`
  - Owns: `packages/agents/src/init/**`
  - Reads: plan.md "Init"; spec US3, FR-306; connector root exports; `@opscrew/iac-engine` `detectEngines`
  - Depends: T301
  - Accept: `runInitChecks` → `InitCheck[]` for every check in FR-306 with plain-English fixes; `ensureGitignore` (approval or `fix`; idempotent; keeps line endings); offline mode; no token value in any message; tests with fake runner/fetch/env for pass, warn and fail of each check.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

- [X] T309 [US4] Monorepo app selection across analyze, interview, design and adapt in `packages/agents/src/{analyze,interview,design,adapt}/`
  - Owns: the monorepo-related parts of `packages/agents/src/{analyze,interview,design,adapt}/**` and their tests
  - Reads: plan.md "Monorepo"; spec US4, FR-307
  - Depends: T303, T305
  - Accept: interview asks `appDir` only with several candidates and re-runs deterministic analysis; analyze honours `appDir` (option and requirements); design's multi-app stop only without a choice; plan `app.dockerfile` = `<appDir>/Dockerfile`; adapt writes the Dockerfile in the app directory; tests over the two-app fixture end to end (analyze → interview → design → adapt with fakes).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 4: Interfaces

- [ ] T310 [US1] [US2] [US3] [US4] CLI commands destroy, drift, init and `analyze --app` in `packages/cli/src/commands/`
  - Owns: `packages/cli/src/commands/{destroy,drift,init}.ts` and their tests, the `--app` option in `analyze.ts` and its test, new files under `packages/cli/src/ui/`
  - Reads: spec FR-301, FR-304, FR-306, FR-307; `packages/cli/src/{deps,exit,approval}.ts`; existing deploy command patterns
  - Depends: T306–T309
  - Accept: `destroy [--no-snapshot] [--confirm <name>] [--engine]` (interactive typed confirmation; non-interactive only with `--confirm`), `drift [--json]` (exit 0/1/2), `init [--fix] [--offline]` (checklist, exit 1 on a failed required check), `analyze --app <dir>`; next-step hints; tests through `createProgram` with fakes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: high

- [X] T311 [P] [US5] MCP tools `opscrew_drift`, `opscrew_init_check` and skill updates in `packages/mcp-server/src/tools/{drift,init}.ts`, `plugin/skills/**`
  - Owns: `packages/mcp-server/src/tools/{drift,init}.ts` and tests, `plugin/skills/**`
  - Reads: spec US5, FR-308; `packages/mcp-server/src/tools/shared.ts`
  - Depends: T307, T308
  - Accept: both tools read-only annotated, outputs redacted, errors mapped; no destroy tool; skills describe drift and terminal-only destroy; `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: medium

## Phase 5: Verification

- [ ] T312 Live test tears down with `opscrew destroy --confirm` (API cleanup stays as the fallback) and a two-app e2e example (lead) in `packages/cli/test/{live,e2e}/**`, `examples/`, `docs/e2e.md`
- [ ] T313 Feature verification (lead): `pnpm check`, bundle smoke test, converge review against FR-301..FR-310

## Dependencies & waves

- T301 first (serial, lead).
- Wave A (parallel): T302, T303, T304, T305, T308.
- Wave B: T306 (after T302–T304), T307 (after T302), T309 (after T303, T305).
- Wave C: T310 (after T306–T309), T311 (after T307, T308).
- T312, T313 by the lead.
