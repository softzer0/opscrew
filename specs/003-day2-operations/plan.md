# Implementation Plan: Day-2 Operations

**Branch**: `mvp` | **Date**: 2026-10-12 | **Spec**: `specs/003-day2-operations/spec.md`

## Summary

Four additions on top of the MVP: `opscrew destroy` (snapshot → lift protection → destroy plan,
each approved, then GitHub secret cleanup), `opscrew drift` (refresh-only plan + normal plan +
rendered-file diff, never applies), `opscrew init` (preflight checklist, optional `.gitignore`
fix) and monorepo app selection (`appDir` in facts and requirements, Docker builds from the
repository root). Plus MCP tools for drift and init checks.

## Technical Context

Same stack as features 000–002 (TypeScript 7, pnpm workspaces, Vitest 5, zod 4, OpenTofu ≥ 1.6 /
Terraform ≥ 1.6, hcloud provider ~> 1.70, cloudflare provider ~> 5.27). No new dependencies.

## Constitution Check

- I (plan → policy → approval → apply): destroy uses two saved plans, each approved by hash;
  the destroy plan needs `allowDestroy` + the typed server name. The non-interactive `--confirm`
  path answers with the typed name and refuses a protection-lifting plan that changes anything
  except `delete_protection`/`rebuild_protection` of `hcloud_server`. Snapshot creation is a typed
  adapter call inside the approved destroy flow (it only adds a resource). Drift never applies.
- IV (secrets): drift reports attribute names, never values; init checks never print tokens.
- Dual engine: refresh-only plans exist in both engines (Terraform ≥ 0.15.4, all OpenTofu).
- Package boundaries: contract changes are lead-owned (T301); each package task owns one package.

## Project Structure

```text
packages/contracts/src/iac.ts            # T301: plan option refreshOnly, PlanSummary.drift
packages/plan-schema/src/{facts,requirements,plan}.ts  # T301: facts.appDir, requirements.appDir,
                                                       #       deployment.destroyedAt (+ JSON Schema)
packages/iac-engine/src/{engine,plan-json}.ts          # T302
packages/iac-templates/src/{infra,docker,runbook}/**   # T303
packages/connectors/{hetzner,github}/src/**            # T304
packages/detect/src/**                                 # T305
packages/agents/src/{destroy,drift,init}/**            # T306, T307, T308 (barrel exports by T301)
packages/agents/src/{analyze,interview,design,adapt}/**  # T309 (monorepo pieces only)
packages/cli/src/commands/{destroy,drift,init}.ts, analyze.ts (--app)  # T310
packages/mcp-server/src/tools/{drift,init}.ts, plugin/skills/**         # T311
packages/cli/test/live/**, docs/e2e.md                 # T312 (lead)
```

## Design

### Contracts (T301, lead)

- `IacEngine.plan(dir, planFile, options & { destroy?; refreshOnly? })`.
- `PlanSummary.drift?: ResourceDrift[]` with `ResourceDrift { address; type; name; provider;
  action: "update" | "delete"; attributes: string[] }` (top-level attribute names whose values
  differ; values never copied).
- `ProjectFactsSchema.appDir` (repo-relative POSIX, default `"."`).
- `RequirementsSchema.appDir` (optional repo-relative path; becomes question id `appDir`).
- `DeployPlan.deployment.destroyedAt` (optional ISO time).
- Barrels and placeholders: `agents/src/{destroy,drift,init}/index.ts`, CLI command stubs for
  `destroy`, `drift`, `init`, MCP `tools/{drift,init}.ts` registration stubs.

### Engine (T302)

`plan()` passes `-refresh-only` when `refreshOnly`; `parsePlanJson` maps `resource_drift[]` (mode
`managed` only) to `ResourceDrift` (action from `change.actions`: `["delete"]` → delete, anything
else → update; attributes = sorted union of top-level keys whose JSON differs between `before`
and `after`). A refresh-only plan has `changes: []`. Integration test (gated by `OPSCREW_IT=1`,
provider download needed): a `hashicorp/local` `local_file` applied, then edited or deleted on disk,
produces drift with both binaries; unit tests use recorded `show -json` documents.

### Templates (T303)

- Root module: `variable "delete_protection" { type = bool, default = true }` passed to
  `module "server"`; never written to `terraform.tfvars.json`.
- Docker: every stack honours `facts.appDir`. JS stacks build from the repository root with the
  workspace-aware install (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install
  --frozen-lockfile`) and build/run the app with the package manager's workspace flag
  (`npm run build --workspace <dir>`, `pnpm --filter <package name> run build`,
  `yarn workspace <name> build`); Python stacks copy `<dir>` only. The rendered file lives at `<appDir>/Dockerfile`; the
  plan keeps `buildContext: "."` and `dockerfile: "<appDir>/Dockerfile"`.
- Runbook: sections "Check for drift" (`opscrew drift`) and "Tear it down" (`opscrew destroy`,
  snapshot note, what remains).

### Adapters (T304)

- Hetzner: `listServers({ labelSelector })`, `createSnapshot(serverId, { description, labels })`
  → `{ imageId, actionId }` (`POST /servers/{id}/actions/create_image`, `type: "snapshot"`),
  `waitForAction(actionId, { timeoutMs, intervalMs, sleep, now })` (`GET /actions/{id}` until
  `success`; `error` → `PROVIDER_ERROR` with the API's message). Same retry/429 handling.
- GitHub: `deleteActionsSecret(owner, repo, name)` (`DELETE /repos/{o}/{r}/actions/secrets/{name}`;
  204 and 404 both succeed; name validated like `setActionsSecret`).

### Detection (T305)

`detectProjectDetails(root, { appDir })`: when `appDir` names a workspace member (or `.`), that
unit is the primary app and `appCandidates` is empty; an unknown directory → `INVALID_INPUT`
listing the candidates. Facts gain `appDir` (the primary unit's directory).

### Destroy orchestration (T306, `agents/src/destroy`)

`runDestroy(deps, { snapshot = "auto", confirm?, engine?, services? })`:
1. Load plan; require the local state file, infrastructure code that declares
   `variable "delete_protection"` (older deployments: run `opscrew provision` first) and, with
   OpenTofu state encryption, the existing passphrase (read, never created); else
   `PHASE_PRECONDITION`.
2. Credentials: Hetzner always; Cloudflare token present and valid when the plan uses it (no
   record checks, so a teardown is never blocked by foreign records); GitHub optional (missing
   token, repository or origin → secrets cleanup skipped with the reason).
3. Engine, `TF_ENCRYPTION`, `init` (same backend path).
4. Preview: `engine.plan(..., { destroy: true })` with `delete_protection=false` → list of
   resources to delete (this plan is discarded). Data warning when `services.postgres` or
   `target.backups`; the snapshot is announced. Then the `confirm` hook: the CLI has the user
   type the server name once (or checks `--confirm`) before anything changes; a mismatch stops
   with nothing changed. The answer is audited.
5. Snapshot (`auto` → on when Postgres or backups; `--snapshot` always; `--no-snapshot` off):
   find the server by labels `managed-by=opscrew,app=<name>`; reuse the snapshot an earlier run
   of the same server took (`.opscrew/destroy-snapshot.json`), else create one labelled `app`,
   `created-by=opscrew`, `reason=destroy`, `taken-at` (never `managed-by`, so cleanups keep it);
   wait (timeout 15 min); failure stops everything.
6. Unprotect (skipped when the preview deletes no server): `plan` with
   `vars: { delete_protection: "false" }`; changes must be updates of `hcloud_server` that change
   only `delete_protection`/`rebuild_protection` and turn delete protection off (a value known
   only after apply counts as a change; else stop); approval `iac-apply`; `assertApprovedPlan`;
   apply.
7. Destroy: `plan` with `destroy: true` and the same var; it may only delete, and only
   resources that were in the confirmed preview (else stop); approval `iac-apply` with
   `allowDestroy: true`, `confirmPhrase: plan.app.name`, details = resource list + data warning +
   snapshot id (the CLI's handler answers both plan approvals with the name typed in step 4);
   `assertApprovedPlan({ allowDestroy: true })`; apply.
8. Cleanup: approval `github-secrets` ("Remove the deploy secrets …") → `deleteActionsSecret` for
   every `DEPLOY_SECRETS` name; remove the server's line from `known_hosts`; update the plan:
   drop `serverIpv4`, `serverIpv6`, `url`, `lastCompletedPhase`; set `destroyedAt` (provision
   drops it again on the next deployment); record both approvals in `plan.approvals`; delete
   `deploy_secrets.json` and the snapshot record; write it;
   mark phase `provision` as `skipped` with "infrastructure destroyed"; audit every step.
9. Report what remains: snapshot (id, billed per GB per month), GHCR images, repository files
   (`opscrew/infra`, workflow; the workflow cannot deploy without the secrets).
Refusals at any step leave everything after it untouched; plan files are deleted after use and
never get a sidecar. Non-interactive: `--confirm` must equal the server name (checked before any
cloud call); it then also approves removing the deploy secrets.

### Drift (T307, `agents/src/drift`)

`runDrift(deps, { engine?, services? }) → DriftReport`: require deployment and a non-empty state
file (OpenTofu-encrypted state is recognised from the file; else `PHASE_PRECONDITION` explaining
that the state lives on the computer that provisioned), the existing passphrase and deploy key
(read, never created); DNS records OpsCrew did not create are reported, not fatal;
credentials (Hetzner; Cloudflare when used); engine + encryption + init; refresh-only plan →
`drift`; normal plan → `pending`; `previewDeploymentFiles` → changed/created infra and runtime
files; plan files are written under `.opscrew/plans/drift-*.tfplan` and deleted afterwards (no
sidecar, so they can never be approved). `renderDriftReport` (plain text and JSON). Never calls
`apply`.

### Init (T308, `agents/src/init`)

`runInitChecks(deps, { offline?, fix?, services? }) → InitCheck[]` with injected `which`,
`version` probes, fetch and runner; `ensureGitignore(deps)` appends `.opscrew/` after a
`repo-write` approval (or `fix`). Checks never print token values and run in parallel with a 10 s
budget per network check.

### Monorepo (T309)

- Analyze: honours `requirements.appDir` or an `appDir` option (CLI `--app`), passes it to
  detection, records it in facts; the multi-app risk only when no app is chosen.
- Interview: question `appDir` (single-select of `appCandidates`, asked only when there are
  several); after answering, re-runs deterministic analysis for the chosen app so
  `architecture.json` matches (AI summary dropped with a note).
- Design: the multi-app stop only when facts describe the root and no app is chosen; the plan's
  `app.dockerfile` is `<appDir>/Dockerfile`, `buildContext` `.`.
- Adapt: deterministic files written in the app directory (`.dockerignore` at the root since the
  build context is the root).

### MCP and plugin (T311)

`opscrew_drift` (readOnlyHint, openWorldHint) and `opscrew_init_check` (readOnlyHint) via
`runTool`; skills: deploy skill gains "Check for drift" and "Tear down (terminal only:
`npx opscrew destroy`)".

## Complexity Tracking

None: no new packages or dependencies.
