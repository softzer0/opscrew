# Implementation Plan: Retarget

**Branch**: `mvp` | **Date**: 2026-10-13 | **Spec**: `specs/005-retarget/spec.md` |
**Research**: `specs/005-retarget/research.md`

## Summary

`opscrew retarget` moves a live deployment to the other VPS provider inside the same root module
and state: a moves-only plan renames `module.server` to `module.server_previous`, a second plan
creates the new `module.server`, the deploy workflow puts the app on it, a maintenance window
copies Postgres server to server, a third plan switches DNS in place, and `--finish` deletes the
old server (or `--abort`, before the switch, deletes the new one and renames the old one back).
Every step is recorded in `plan.retarget` and resumable.

## Technical Context

Same stack as 000–004. No new dependencies. Uses OpenSSH `scp -3` (already required: `ssh`,
`ssh-keyscan`) and Postgres client tools inside the `db` container.

## Constitution Check

- I: seven kinds of plans (rename, create, switch, unprotect, destroy, abort-dns, abort-rename), each plan → policies →
  approval bound to the hash → apply; the moves-only plans are shown as "nothing changes in your
  cloud". Deletions (finish, abort) need `allowDestroy` + the typed app name and are bounded to
  the previewed addresses. The maintenance window (stopping the app, restoring the database on
  the new server) is a `remote-exec` approval listing its commands; scripts need
  `--allow-downtime`. Deploy-secret changes are `github-secrets` approvals. Non-interactive runs
  name each plan hash (`--approve <hash>`); no blanket approval for applies.
- II: the final infrastructure files land in a pull request; during the move the working tree
  holds the transitional root module (the user sees it in `git status`).
- III: `moved` blocks (Terraform ≥ 1.1, OpenTofu ≥ 1.6) are in the common subset; every layout is
  validated by both engines.
- IV: the database dump never passes through logs or the model; it exists only as `0600` files in
  `/srv/app` on the two servers and in transit over SSH, and is deleted after the restore.
- VIII: server commands are fixed, typed operations (`server-ops.ts`), not free-form shell.

## Project Structure

```text
packages/contracts/src/{iac,runtime}.ts                 # T501: ResourceMove, PlanSummary.moves, PHASES + retarget
packages/plan-schema/src/{plan,enums}.ts (+ JSON Schemas) # T501: DeployTargetSchema, plan.retarget
packages/iac-templates/src/types.ts                     # T501: InfraLayout type (+ T503 implementation)
packages/agents/src/retarget/index.ts, src/index.ts     # T501: barrel + stubs with final signatures
docs/adr/0007-retarget-in-one-state.md                  # T501
packages/iac-engine/src/**                              # T502
packages/iac-templates/{src,modules}/**                 # T503
packages/connectors/github/src/**                       # T504
packages/agents/src/destroy/**                          # T505
packages/agents/src/{provision,design,dns,drift}/**     # T506
packages/agents/src/retarget/server-ops*.ts             # T507
packages/agents/src/retarget/** (rest)                  # T508
packages/cli/src/**, packages/cli/test/e2e/**           # T509
packages/mcp-server/src/**, plugin/**, README.md        # T510
packages/cli/test/live/**, docs/e2e.md                  # T511 (lead)
```

## Design

### Contracts and schemas (T501, lead)

- `contracts/src/iac.ts`: `ResourceMove { from: string; to: string; type: string }`;
  `PlanSummary.moves?: ResourceMove[]` (resources whose `previous_address` differs; a pure move
  is not a `ResourceChange`).
- `contracts/src/runtime.ts`: `PHASES` gains `retarget` (after `verify`).
- `plan-schema`: `DeployTargetSchema` (the existing `plan.target` object, exported);
  `plan.retarget` (optional):

  ```ts
  retarget: z.strictObject({
    from: z.strictObject({
      target: DeployTargetSchema,
      serverIpv4: z.ipv4(),
      serverIpv6: z.ipv6().optional(),
      url: z.url().optional(),
    }),
    /** The new server, once created. */
    next: z.strictObject({ serverIpv4: z.ipv4(), serverIpv6: z.ipv6().optional() }).optional(),
    /** Last completed step. */
    step: z.enum(["started", "renamed", "created", "deployed", "migrated", "switched"]),
    /** Set while the old app is stopped by OpsCrew (maintenance window or after the switch). */
    oldAppStoppedAt: IsoDateTimeSchema.optional(),
    /** Present once `--abort` began: its last completed step. */
    abort: z.strictObject({ step: z.enum(["started", "new-removed", "secrets-restored"]) }).optional(),
    startedAt: IsoDateTimeSchema,
  }).optional()
  ```

  `plan.target` is the new target from the start of the move; `plan.deployment` always describes
  the server that receives traffic (the old one until the switch).
- `iac-templates/src/types.ts`: `RenderContext.layout?: InfraLayout`:

  ```ts
  export interface InfraLayout {
    /** `module "server"` and the target it deploys; absent when the configuration has none. */
    server?: DeployTarget;
    /** `module "server_previous"` during a move. */
    previous?: DeployTarget;
    /** A `moved` block (moves-only layouts). */
    moved?: { from: "server" | "server_previous"; to: "server" | "server_previous" };
    /** The module the DNS module and the `server_*` outputs follow. */
    live: "server" | "server_previous";
    /** Every provider whose provider block and module are rendered (both during a move). */
    providers: readonly VpsProvider[];
  }
  ```

  Without `layout` the renderer behaves exactly as today (`{ server: plan.target, live: "server",
  providers: [plan.target.provider] }`).
- `agents/src/retarget/index.ts`: `runRetarget`, `finishRetarget`, `abortRetarget` stubs (throw
  "not implemented yet"), option/result types (below); `agents/src/index.ts` exports.
- ADR 0007: one state, two-step rename/create, DNS switched in place, abort only before the
  switch.

### Engine (T502)

`parsePlanJson` collects `ResourceMove`s from `resource_changes[]` with `previous_address`
(pure moves are `no-op`; a move with an update stays a change at its new address and also a
move). `PlanSummary.moves` is set when non-empty; counts unchanged. Gated integration test with
both binaries using `terraform_data` and the A/B/C sequence from research.md.

### Templates (T503)

`renderDeployment(plan, ctx)` honours `ctx.layout`:

| Layout (built by T508) | Modules | `moved` | DNS + `server_*` outputs |
|---|---|---|---|
| rename | `server_previous` (from target) | `server` → `server_previous` | `server_previous` |
| both | `server_previous` + `server` (new) | — | `server_previous` |
| switched | `server_previous` + `server` | — | `server` |
| finish | `server` | — | `server` |
| abort-remove | `server_previous` | — | `server_previous` |
| abort-rename | `server` (from target) | `server_previous` → `server` | `server` |

- Both providers' `required_providers` entries and provider blocks, and both provider modules
  vendored, for every layout with two providers.
- Root variables for the previous server: `previous_location`, `previous_server_type`,
  `previous_image`, `previous_backups` (in tfvars), and for a Hetzner previous server
  `previous_delete_protection` (default true, never in tfvars, set to false by finish's unprotect
  plan); `delete_protection` stays the variable of a Hetzner `module "server"`.
- Outputs: `server_ipv4`, `server_ipv6`, `server_id`, `server_name`, `url` follow `live`; when both
  modules exist, `other_server_ipv4`, `other_server_ipv6`, `other_server_id` describe the other one.
- Without a layout, output is byte-identical (existing snapshots unchanged).
- Snapshot tests per layout and provider direction; the gated validate test covers every layout
  with both engines.
- Runbook: a "Moving to another provider" section (commands, maintenance window, finish/abort).

### GitHub connector (T504)

Signatures as in `RetargetGitHubApi` (`packages/agents/src/retarget/types.ts`, T501):
`dispatchWorkflow(owner, repo, workflowFile, ref)` → `{ runId?: number }` (accepts 200 with
`workflow_run_id` and 204); `getWorkflowRun(owner, repo, runId)`; `listWorkflowRuns` gains
`event` and `createdSince` filters; `waitForWorkflowRun(owner, repo, { workflowFile, ref, runId?,
since, timeoutMs?, pollMs? })` → `{ id, conclusion, htmlUrl }` finds the dispatched run (by id,
else the newest `workflow_dispatch` run on `ref` created since `since`) and resolves when it
completes (timeout → plain error with the run link when known).

### Destroy pieces (T505)

Behaviour of `opscrew destroy` unchanged; refactor into exported helpers with explicit inputs so
the move reuses them: `previewDeletion` (changes limited to an address prefix, deletes only),
`takeSnapshotBeforeDelete` (provider, app, server ids from plan JSON, reuse record),
`liftProtection` (root variable name, restricted unprotect check), `forgetHostKeys(deps, hosts)`,
and the typed confirmation flow. Destroy also refuses while `plan.retarget` exists.

### Provision, design, dns, drift (T506)

- `planAndApply`: a plan with no changes but `moves` is applied after an `iac-apply` approval whose
  title says the state is renamed and nothing changes in the cloud; "already up to date" only
  when there are neither changes nor moves.
- Guards: provision, design, dns and drift stop with `PHASE_PRECONDITION` while `plan.retarget`
  exists ("A move to <provider> is in progress …" + continue/finish/abort commands).

### Server operations (T507)

`agents/src/retarget/server-ops.ts`, fixed commands over `RemoteExec` (and the runner for `scp`),
all in `/srv/app` as `deploy`:

- `stopService(host, service)`, `startService(host, service)` (`app`, `caddy`), `isAppHealthy(host,
  port, healthPath)` (`docker compose exec -T caddy wget -q -O /dev/null -T 5
  http://app:<port><path>`), `waitAppHealthy` (polls with a timeout).
- `databaseSize(host)` (`psql -tAc "select pg_database_size('app')"` in `db`).
- `dumpDatabase(old)` (`umask 077; docker compose exec -T db pg_dump -U app -Fc app >
  opscrew-move.dump`), `copyDump(old, new)` (`scp -3` with the deploy key and OpsCrew's
  known_hosts, IPv6 in brackets), `restoreDatabase(new)` (`docker compose exec -T db pg_restore
  -U app -d app --clean --if-exists --no-owner --single-transaction < opscrew-move.dump`),
  `removeDump(host)`.
- Every command has a timeout scaled to the database size; failures become plain
  `OpsCrewError`s without the dump contents; stderr is redacted and truncated.

### Orchestration (T508, `agents/src/retarget/`)

```ts
interface RetargetOptions {
  to?: VpsProviderId;                 // default requirements.provider
  option?: string;                    // design option id
  approvePlanHash?: string;           // continue a non-interactive run
  allowDowntime?: boolean;            // non-interactive maintenance window
  dnsSwitched?: boolean;              // manual DNS confirmed (dns other/none)
  engine?: EnginePreference;
  services?: RetargetServices;        // engine, provider checks, github, remote, runner, sleep, now
  choose?: (options: DesignOption[]) => Promise<string>;           // CLI picker
  confirmStart?: (summary: RetargetSummary) => Promise<boolean>;    // steps, extra cost, downtime
}
```

Steps (each records `retarget.step` and is skipped when already done):

1. **start** (no `retarget`): preconditions (live deployment, other provider, both provider
   tokens, Cloudflare/GitHub as used, state passphrase, deploy key); design options for the new
   provider via the design module (no design guard); choice; summary (extra cost, database size,
   expected downtime) and `confirmStart`; write `plan.target` = new target, `cost`, `retarget`
   (`step: started`).
2. **rename** → layout rename → `planAndApply` (moves only) → `renamed`.
3. **create** → layout both → `planAndApply` → `other_server_*` outputs → `retarget.next` → wait for
   SSH, pin the host key, wait for cloud-init → `created`.
4. **deploy** → deploy secrets for the new host (`github-secrets`), dispatch `opscrew-deploy.yml` on
   `cicd.branch`, wait for success, `waitAppHealthy(new)`, stop Caddy on the new server →
   `deployed`.
5. **migrate** (self-hosted Postgres only; otherwise straight to `migrated`) → with Cloudflare,
   the switch plan is prepared and checked first (so it cannot fail while the app is offline) →
   database size and downtime → `remote-exec` approval (or `--allow-downtime`) → `oldAppStoppedAt`
   → stop old app → dump → copy → stop new app → restore → remove dumps → start new app →
   `waitAppHealthy(new)` → `migrated`; on failure: remove dumps, start old app, clear
   `oldAppStoppedAt`, stop with the cause. Restarting the old app after a completed copy first
   records `deployed` (the copy is stale) and repeats the window before any switch.
6. **switch** → Cloudflare: apply the prepared switch plan (DNS updates in place only); not
   managed: show the records or address and require confirmation (`--dns-switched`) →
   `deployment` ← new addresses and URL → `switched` (recorded right after the apply, which blocks
   abort) → `settleSwitch` on this and every later run and before `--finish`: start Caddy on the
   new server, without managed DNS wait until the domain resolves only to the new server, check
   the app through its URL (5 min), then stop the old app. A failed apply: record `deployed`,
   start old app, clear `oldAppStoppedAt` (the error names records that may already point at the
   new server).
7. **finish** (`finishRetarget`, step `switched`): `requireSwitchSettled` first (refuses while the
   new server does not serve the app; the old server is kept), then preview (layout finish plan,
   deletes only under `module.server_previous.`), typed app name, snapshot (auto: Postgres or
   backups on the old server; record `.opscrew/retarget-snapshot.json`), Hetzner unprotect via
   `previous_delete_protection=false` (layout switched), destroy apply (layout finish) bounded to
   the preview, forget the old host keys, render without a layout and write the files, publish them
   in a pull request (`publishDeploySetup`), remove `retarget`, mark the `retarget` phase `ok`.
8. **abort** (`abortRetarget`, step before `switched`): start the old app if OpsCrew stopped it
   (stale copy → `deployed`); with Cloudflare from `deployed` on, `abort-dns` points the records
   back (layout both, DNS-updates-only check, approval bound to the hash) when needed; if the new
   server exists: preview (layout abort-remove, deletes only under `module.server.`), typed app
   name, for a new Hetzner server first lift its protection (layout both, `delete_protection=false`,
   restricted to `module.server.`), destroy apply → `new-removed`; restore the deploy secrets to the
   old host (`github-secrets`) → `secrets-restored`; layout abort-rename moves-only apply;
   `plan.target` ← `from.target`, cost restored, forget the new host key, remove `retarget`, mark
   the phase `skipped`. `retarget.abort` is recorded after the typed name (or before the first
   change), so refusing leaves the move continuable.

Non-interactive: each run stops before an apply, saves the plan and records the step action and
hash in `.opscrew/retarget-pending.json`; `--approve <hash>` applies only that step's saved plan
and continues to the next stop. Deletion plans use the destroy helpers (`savePlan`,
`applyApprovedPlan`). `RetargetResult` carries `done` (exit 0 when true, 1 when stopped on
purpose), `pendingPlanHash`, `snapshotId` and `next`. The engine is initialised again after every
layout change (new module calls need `init`). Layouts are built in
`agents/src/retarget/layouts.ts` from `plan.target`, `retarget.from.target` and the step.
`planAndApply` gained the options `phase` (audit `retarget`), `approvalNotes` and `costDelta`
(no cost change for the switch and abort-dns plans).

### CLI (T509)

`opscrew retarget` with the flags of FR-501 (`--finish` and `--abort` exclusive), typed
confirmation via the destroy confirmation handler pattern, the option picker, the summary
prompt, next-step hints after each stop, `opscrew status` line for `retarget`; e2e with fakes for
Hetzner → DigitalOcean (start → switched → finish) and an abort.

### Docs and plugin (T510)

Deploy skill (terminal-only move, how to run it), README (moving between providers), MCP tool
descriptions mention that moves are terminal-only where relevant.

### Live test (T511, lead)

When both `OPSCREW_E2E_HCLOUD_TOKEN` and `OPSCREW_E2E_DIGITALOCEAN_TOKEN` are set: deploy on
Hetzner, write a row through the database, retarget to DigitalOcean non-interactively
(`--approve`, `--allow-downtime`), read the row back, finish, then destroy; cleanup fallbacks for
both providers.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| Two plans (rename, create) instead of one | Both engines reject a `moved` block that frees an address the configuration declares again (research.md) | A separate state per server would need cross-state DNS moves (imports, `state rm`) |
| Transitional root module in the working tree during a move | The engine needs the files on disk | Committing each transitional layout would spam pull requests; the final files are published once |
