---
description: "Tasks for 024-snapshots-and-restores"
---

# Tasks: Snapshots and restores as commands

**Input**: `specs/024-snapshots-and-restores/`: spec.md, plan.md, research.md (R1–R6).

**Numbering**: T2401–T2499.

**Format**: `- [ ] T#### [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.

**Rules for every task:**
- **Fixtures and leaks:**
  - Fixtures never contain secret-shaped literals: `fakeSecret()`, or `{{FAKE:…}}` with
    `materializeFixture()`.
  - None of these may appear in an output, log line, audit entry, approval text, committed file,
    fixture or bucket object name: a password, key, dumped value, server address or the age
    private key.
  - Passwords reach a dump or restore only inside its container.
- **Approvals:**
  - A data restore and a snapshot's deletion are destroy-grade: `allowDestroy` and a typed name,
    `--confirm` in scripts, never `--yes`.
  - Infrastructure goes through plans approved by hash.
  - No new approval kind.
- **The store:** plan.md 1.'s files, names, modes and `about.json` are the contract between the
  tasks.
- **Unchanged without the feature:** with no schedule, no off-server copy and no snapshot command,
  deploys and rollbacks behave as in 0.2.4, though the scripts' text changes.
- **Scope:** build only what Accept asks; report anything else as a finding.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.

## Phase 1: Foundation

- [x] T2401 The spikes (lead with an agent): plan.md 11. S1 and S2 in local Docker, S3 live on a throwaway Hetzner server and the e2e R2 account. Results as research.md R7, one line per question; a finding that changes a design goes into plan.md first.
  - Effort: high

- [x] T2402 The plan's fields and the contracts (lead): `deploy.snapshotStop`, `snapshots.schedule`, `snapshots.offsite` (plan.md 9.), `ServerSnapshotApi`'s list, delete and rebuild, and `TOOLS.age`'s pin (linux amd64 and arm64, SHA-256).

## Phase 2: Wave 1 (parallel)

- [x] T2403 [US4] The providers' snapshots and rebuilds in `packages/connectors/{hetzner,digitalocean}/**` (+ tests)
  - Owns: those packages
  - Reads: research R1, plan.md 5.
  - Depends: T2402
  - Accept:
    - **Hetzner:** `listSnapshots` (by OpsCrew's labels), `deleteImage` and `rebuildServer` (redacting `root_password`).
    - **DigitalOcean:** `deleteSnapshot` and `rebuildDroplet` (a backup converted to a snapshot first).
    - **Both:** each through the action poll, with fakes for every answer.
    - **Unchanged:** destroy's snapshot keeps working.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-hetzner --filter=@opscrew/connector-digitalocean`
  - Effort: high

- [x] T2404 [US1] [US3] [US5] [US7] The server's `snapshot.sh`, in `packages/iac-templates/src/workflow/**` (+ tests, Docker tests)
  - Owns: `packages/iac-templates/src/workflow/{snapshots,switch,index}.ts` and a new `snapshot-script.ts`, their tests and fixtures
  - Reads: plan.md 1.–3. and 6., research R2 and R7 (S1)
  - Depends: T2401, T2402
  - Accept:
    - **The script:** the deploy uploads `snapshot.sh` with `take`, `restore`, `list`, `delete` and `offsite` (the last a no-op until T2406), for every kind of plan.md 2.
    - **Stopping:** stop-only kinds stop only that service, with 023's clean-stop rule.
    - **Restore:** each restore takes the copy just before and puts it back on failure. A restore needs the one-time approval file, as 019's database step does.
    - **Pre-release:** 019's pre-release snapshot uses the script and covers every kind, the stop-only ones only in `deploy.snapshotStop`.
    - **Schedule:** the deploy writes the deploy user's crontab line for `snapshots.schedule`, and removes it when the schedule is off.
    - **Extra servers** get their own script.
    - **Tests:** under `sh` with shims for every path. Docker tests copy and exactly restore every kind with the pinned images, under writes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, and the Docker tests with `OPSCREW_DOCKER_TESTS=1`
  - Effort: xhigh

- [x] T2405 [US1] [US5] [US7] Portainer's scheduled and pre-release snapshots in `packages/iac-templates/src/portainer-target/**` (+ tests, Docker test)
  - Owns: `packages/iac-templates/src/portainer-target/**` (+ tests)
  - Reads: plan.md 4. and 7., research R7 (S2)
  - Depends: T2401, T2402
  - Accept:
    - **Schedule:** the stack gains the per-kind scheduled services for the online kinds and the `snapshots` service writing `about.json`, all for `snapshots.schedule`.
    - **Pre-release:** a one-off `snapshot` service before `release`.
    - **Off-server:** an `offsite` service when `snapshots.offsite` is on.
    - **Unchanged:** a stack without either is as before.
    - **Tests:** the stack's text, plus a Docker test of the scheduled services writing a snapshot.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, the Docker test with `OPSCREW_DOCKER_TESTS=1`
  - Effort: high

## Phase 3: Wave 2 (parallel)

- [x] T2406 [US6] The encrypted copy off the server: the bucket in its own `backups` root (D9) and the upload, in `packages/iac-templates/src/{storage,workflow/snapshot-script.ts}` and `packages/agents/src/provision/{storage,portainer-flow,run,secrets,publish,steps,types}.ts`, `packages/agents/src/{secrets/copy,shared/apply-command}.ts`, the backups hash in `packages/cli/src/commands/provision.ts` and `packages/mcp-server/src/tools/deploy.ts` and the root's rendering (+ tests); the deploy's `offsite.env` (`workflow/{index,shared}.ts`) after T2417
  - Owns: those paths (`portainer-flow.ts` only to fill the Portainer stack's `OPSCREW_OFFSITE_*` variables, which T2405's `offsite` service reads)
  - Reads: plan.md 7., research R3 and R7 (S3)
  - Depends: T2404
  - Accept:
    - **The bucket:** planned in the storage root with versioning and the lifecycle rule. The script's fallback deletion applies where lifecycle isn't supported.
    - **The upload:** `snapshot.sh offsite <id>` streams each file through the pinned `age` (its hash checked) into rclone, with the key in a mode-600 file.
    - **The recipient** comes from `opscrew/.sops.yaml`.
    - **Tests:** shim tests, and a Docker test uploading to a local S3 (a pinned MinIO or Garage) and decrypting with the test's key.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2407 [US1] [US2] `opscrew snapshot`, `snapshot list` and `snapshot delete`, in `packages/agents/src/snapshot/**` (+ tests)
  - Owns: `packages/agents/src/snapshot/**`
  - Reads: plan.md 1., 3.–4., 6.
  - Depends: T2404, T2405
  - Accept:
    - **Servers:** `snapshot.sh` through `serverShell` (or locally).
    - **Portainer:** through 023's `SideDocker` and carrier.
    - **The summary** names the stop-only services and their stop, approved first. `--skip` leaves a service out.
    - **List** merges the server's, the provider's (T2403) and the bucket's copies.
    - **Delete** is destroy-grade.
    - **Refusals** while a deploy or move runs.
    - **Tests:** fakes for both targets; leak checks.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2408 [US3] [US6] `opscrew restore <id>`, in `packages/agents/src/snapshot/restore.ts` (+ tests)
  - Owns: `packages/agents/src/snapshot/restore*.ts`
  - Reads: plan.md 6.–7.
  - Depends: T2407, T2406
  - Accept:
    - **The version check:** a snapshot of another version is refused with the rollback command; `--allow-other-version` restores the data alone.
    - **The approval:** destroy-grade, its hash covering the id, the services and `about.json`; the one-time approval file on servers.
    - **Restoring:** `--only` restores one service. Servers run the script; Portainer goes through the carrier. With parts on extra servers, the CLI runs the app server's `snapshot.sh hold` first, restores each server's part, and runs `snapshot.sh resume` after, including on failure (plan.md D8). The app server's `snapshot.sh` is rendered whenever any server holds data, so `hold` and `resume` always exist (D13; `workflow/snapshot-script.ts`, after T2406 merges).
    - **`--from offsite`:** downloads and decrypts on this computer with the recovery key file, then streams to the target.
    - **A stuck rollback's repair** (D18): `restore <hex> --only <services>` restores a pre-release snapshot by its digest on an extra server, with the app held around it.
    - **The bucket from this computer** (FR-2403, T2407's report): `snapshot list` also shows copies that are only in the bucket (their server gone), and `snapshot delete` removes the off-server copy too, both with the bucket's key on this computer.
    - **Tests:** fakes for each path, with a failure that puts the copy back.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2417 [US7] The release snapshot for every kind and extra server (plan.md D7), in `packages/plan-schema/src/plan.ts` (`snapshotsOn` only), `packages/agents/src/rollback/**` and `packages/iac-templates/src/workflow/{servers,switch,snapshots,index}.ts` (+ tests)
  - Owns: those paths, their tests and stored snapshots
  - Reads: plan.md 1.–3. and D7, specs/019-rollback/plan.md 12.
  - Depends: T2404
  - Accept:
    - **`snapshotsOn`** is true for any stateful service or `sqlite` volume, on the app's server or an extra one: online kinds always, stop-only kinds when named in `deploy.snapshotStop`.
    - **Extra servers:** the workflow reads the outgoing digest from the app's server before their deploy step. Each extra server runs `snapshot.sh take release --version <digest>` before its services change. Once the app answers, and after a rollback, the workflow writes the running digest to `.running` on each.
    - **The rollback** restores on each extra server that holds a part, and the offers cover every kind. Only folders with an `about.json` are offered.
    - **Tests:** an app with only SQLite, one with only Valkey, and one with a database on an extra server, each snapshotted before its release and restored by `rollback --database snapshot`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2418 [US1] [US7] Portainer's SQLite as `sqlite.tar` (plan.md D6), in `packages/iac-templates/src/portainer-target/**` (+ tests, Docker test)
  - Owns: `packages/iac-templates/src/portainer-target/**`
  - Depends: T2404
  - Accept: the scheduled and pre-release SQLite parts use the Python program from `workflow/snapshots.ts`; a volume with several databases and other files gives one `sqlite.tar`; an empty volume is `skipped`. The Docker test covers both. The snapshots volume is the stack's `snapshots` (`opscrew-<app>_snapshots`), recorded with `snapshot_tools` among the stack's volumes (D12). `portainerSnapshotParts(plan)` and `portainerServiceEnvironment(plan, service)` are exported for T2407.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, the Docker test with `OPSCREW_DOCKER_TESTS=1`
  - Effort: high

- [x] T2419 [US5] Destroy and moves leave no snapshot schedule behind (plan.md D12), in `packages/connectors/ssh-host/src/**`, `packages/agents/src/testing/own.ts` and `packages/agents/src/destroy/portainer.ts` (+ tests)
  - Owns: those paths and their tests
  - Reads: plan.md 1., 3.–4., D12; `packages/iac-templates/src/workflow/snapshots.ts` (the crontab tag)
  - Depends: T2404; the Portainer part after T2418
  - Accept:
    - **Own servers:** `planTeardown` removes the deploy user's line ending in ` # opscrew-snapshots <app>` (end-anchored) in a host-plan step, as the connector removes cron lines today. That covers destroy, extra servers and moves off an own server. Other apps' lines stay; a missing crontab or line is fine. `FakeHostServer` keeps a crontab in its facts.
    - **Portainer:** destroy's data warning and its "kept" text name the `snapshots` and `snapshot_tools` volumes as holding the app's snapshots (T2418 records them among the stack's volumes).
    - **Tests:** a second app's line survives; the Portainer texts name the volumes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents`
  - Effort: high

- [ ] T2420 [US7] The Portainer rollback restores its pre-release snapshot (plan.md D14, D19), in `packages/agents/src/rollback/**` and the guard in `packages/iac-templates/src/portainer-target/snapshots.ts` (+ tests)
  - Depends: T2408, T2417
  - Accept: with releases taking snapshots on Portainer, `opscrew rollback --to <v> --database snapshot` offers and restores the target's pre-release snapshot through T2408's Portainer restore, with the same approval and put-back on failure as servers; keep stays the default answer.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [x] T2421 [US5] The scheduled check (017) reports a failed scheduled snapshot (US5.2), in `packages/iac-templates/{check/**,src/generated/check.ts}`, `packages/connectors/ssh-host/src/{constants,plan,steps}.ts`, `packages/agents/src/{check/**,status/snapshots.ts}` (+ tests)
  - Depends: T2410
  - Accept: the check's forced SSH command also prints, per app folder, the time and last line of `.snapshots/scheduled.log`; the check script opens or updates its issue when the last scheduled run failed (the same rule as status, T2410). Existing servers get the widened key line through their next provision (a host plan on own servers). Portainer isn't reached by the check: status shows it, and the guide says so.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: high

## Phase 4: Wave 3 (parallel)

- [x] T2409 [US4] `opscrew snapshot --server` and `opscrew restore --server`, in `packages/agents/src/snapshot/server.ts` and the server modules' `ignore_changes` in `packages/iac-templates/src/{hetzner,digitalocean}/**` (+ tests)
  - Depends: T2403, T2407
  - Accept:
    - **Taking one:** live by default; `--stop` powers off and on, approved first. The price is shown, and attached volumes are named as not included.
    - **Restoring:** a rebuild with the server's name typed, then the app's health checked. The next provision plans no replacement.
    - **Refused** on own servers and Portainer.
    - **Tests:** with the connectors' fakes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: high

- [x] T2410 [US5] [US6] [US8] The schedule and off-server commands, design, advise, status and MCP, in `packages/agents/src/{snapshot,design,advise,status}/**` and `packages/mcp-server/**` (+ tests)
  - Depends: T2406, T2407
  - Accept:
    - **The commands:** `snapshot schedule on|off` and `snapshot offsite on|off` write the plan, with the price shown, and say to provision.
    - **Proposals:** design proposes both for an own server or Portainer when the data matters; advise proposes them when they're off. Portainer's notes (`design/portainer.ts` `PORTAINER_NOTES`, also shown by destroy) no longer say OpsCrew can't back up a Portainer host.
    - **Status** shows the last snapshot and its result.
    - **MCP:** the `opscrew_snapshots` tool is read-only.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/mcp-server`
  - Effort: high

## Phase 5: Wave 4

- [x] T2411 [US1]–[US6] The CLI's `snapshot` and `restore` commands and the plugin's skill, in `packages/cli/src/commands/{snapshot,restore}.ts` and `plugin/skills/**` (+ tests)
  - Depends: T2407–T2410
  - Effort: high

- [ ] T2412 The guide: a new `docs/guide/snapshots.md`; `rollback.md`, `databases.md`, `own-server.md` and `portainer-target.md` link to it, and "backups are yours to set up" changes.
  - Also say (found while building):
    - **Before the first release snapshot:** the first deploy after turning snapshots on has no pre-release snapshot.
    - **DigitalOcean scopes:** `snapshot:delete` and `droplet:admin` are needed only to delete or restore whole-server snapshots.
    - **The bucket's key can delete** (R3): versioning is on at Hetzner, and R2 offers none.
    - **Deleting the backups bucket** is the user's job, and the page says how.
    - **Keep old recovery keys:** copies made before a key change need the old one.
    - **Not in a snapshot:** the app's own object storage.
    - **Whole-server restore at Hetzner:** OpsCrew lifts and restores the server's protection for the rebuild.
    - **Portainer:** the scheduled check (017) doesn't reach it, so `opscrew status` shows its snapshots.
    - **The check key:** `alerts.md` changes "runs only df" to what the check key now reads.
    - **ADR 0021:** gets a one-line note that 024 widened the check key's command.
  - Depends: T2411
  - Effort: medium

- [ ] T2413 The live passes, in `packages/cli/test/live/snapshots*.ts` and `docs/e2e.md` (plan.md 10.)
  - Depends: T2411
  - Effort: high

- [ ] T2414 The live runs (lead), `docs/e2e-coverage.md` per run.
- [ ] T2415 The simplify pass (lead), its findings as tasks.
- [ ] T2416 The release (lead): `docs/releasing.md`.
