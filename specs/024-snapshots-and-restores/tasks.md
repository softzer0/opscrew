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

- [ ] T2403 [US4] The providers' snapshots and rebuilds in `packages/connectors/{hetzner,digitalocean}/**` (+ tests)
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

- [ ] T2404 [US1] [US3] [US5] [US7] The server's `snapshot.sh`, in `packages/iac-templates/src/workflow/**` (+ tests, Docker tests)
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

- [ ] T2405 [US1] [US5] [US7] Portainer's scheduled and pre-release snapshots in `packages/iac-templates/src/portainer-target/**` (+ tests, Docker test)
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

- [ ] T2406 [US6] The encrypted copy off the server: the bucket in the storage root and the upload, in `packages/iac-templates/src/{storage,workflow/snapshot-script.ts}` and `packages/agents/src/provision/storage.ts` (+ tests)
  - Owns: those paths
  - Reads: plan.md 7., research R3 and R7 (S3)
  - Depends: T2404
  - Accept:
    - **The bucket:** planned in the storage root with versioning and the lifecycle rule. The script's fallback deletion applies where lifecycle isn't supported.
    - **The upload:** `snapshot.sh offsite <id>` streams each file through the pinned `age` (its hash checked) into rclone, with the key in a mode-600 file.
    - **The recipient** comes from `opscrew/.sops.yaml`.
    - **Tests:** shim tests, and a Docker test uploading to a local S3 (a pinned MinIO or Garage) and decrypting with the test's key.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: xhigh

- [ ] T2407 [US1] [US2] `opscrew snapshot`, `snapshot list` and `snapshot delete`, in `packages/agents/src/snapshot/**` (+ tests)
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

- [ ] T2408 [US3] [US6] `opscrew restore <id>`, in `packages/agents/src/snapshot/restore.ts` (+ tests)
  - Owns: `packages/agents/src/snapshot/restore*.ts`
  - Reads: plan.md 6.–7.
  - Depends: T2407, T2406
  - Accept:
    - **The version check:** a snapshot of another version is refused with the rollback command; `--allow-other-version` restores the data alone.
    - **The approval:** destroy-grade, its hash covering the id, the services and `about.json`; the one-time approval file on servers.
    - **Restoring:** `--only` restores one service. Servers run the script; Portainer goes through the carrier.
    - **`--from offsite`:** downloads and decrypts on this computer with the recovery key file, then streams to the target.
    - **Tests:** fakes for each path, with a failure that puts the copy back.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

## Phase 4: Wave 3 (parallel)

- [ ] T2409 [US4] `opscrew snapshot --server` and `opscrew restore --server`, in `packages/agents/src/snapshot/server.ts` and the server modules' `ignore_changes` in `packages/iac-templates/src/{hetzner,digitalocean}/**` (+ tests)
  - Depends: T2403, T2407
  - Accept:
    - **Taking one:** live by default; `--stop` powers off and on, approved first. The price is shown, and attached volumes are named as not included.
    - **Restoring:** a rebuild with the server's name typed, then the app's health checked. The next provision plans no replacement.
    - **Refused** on own servers and Portainer.
    - **Tests:** with the connectors' fakes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: high

- [ ] T2410 [US5] [US6] [US8] The schedule and off-server commands, design, advise, status and MCP, in `packages/agents/src/{snapshot,design,advise,status}/**` and `packages/mcp-server/**` (+ tests)
  - Depends: T2406, T2407
  - Accept:
    - **The commands:** `snapshot schedule on|off` and `snapshot offsite on|off` write the plan, with the price shown, and say to provision.
    - **Proposals:** design proposes both for an own server or Portainer when the data matters; advise proposes them when they're off.
    - **Status** shows the last snapshot and its result.
    - **MCP:** the `opscrew_snapshots` tool is read-only.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/mcp-server`
  - Effort: high

## Phase 5: Wave 4

- [ ] T2411 [US1]–[US6] The CLI's `snapshot` and `restore` commands and the plugin's skill, in `packages/cli/src/commands/{snapshot,restore}.ts` and `plugin/skills/**` (+ tests)
  - Depends: T2407–T2410
  - Effort: high

- [ ] T2412 The guide: a new `docs/guide/snapshots.md`; `rollback.md`, `databases.md`, `own-server.md` and `portainer-target.md` link to it, and "backups are yours to set up" changes.
  - Depends: T2411
  - Effort: medium

- [ ] T2413 The live passes, in `packages/cli/test/live/snapshots*.ts` and `docs/e2e.md` (plan.md 10.)
  - Depends: T2411
  - Effort: high

- [ ] T2414 The live runs (lead), `docs/e2e-coverage.md` per run.
- [ ] T2415 The simplify pass (lead), its findings as tasks.
- [ ] T2416 The release (lead): `docs/releasing.md`.
