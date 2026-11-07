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

- [x] T2420 [US7] The Portainer rollback restores its pre-release snapshot (plan.md D14, D19), in `packages/agents/src/rollback/**` and the guard in `packages/iac-templates/src/portainer-target/snapshots.ts` (+ tests)
  - Depends: T2408, T2417
  - Accept: with releases taking snapshots on Portainer, `opscrew rollback --to <v> --database snapshot` offers and restores the target's pre-release snapshot through T2408's Portainer restore, with the same approval and put-back on failure as servers; keep stays the default answer.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [x] T2421 [US5] The scheduled check (017) reports a failed scheduled snapshot (US5.2), in `packages/iac-templates/{check/**,src/generated/check.ts}`, `packages/connectors/ssh-host/src/{constants,plan,steps}.ts`, `packages/agents/src/{check/**,status/snapshots.ts}` (+ tests)
  - Depends: T2410
  - Accept: the check's forced SSH command also prints, per app folder, the time and last line of `.snapshots/scheduled.log`; the check script opens or updates its issue when the last scheduled run failed (the same rule as status, T2410). Existing servers get the widened key line through their next provision (a host plan on own servers). Portainer isn't reached by the check: status shows it, and the guide says so.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: high

- [x] T2422 [US1] The localhost target sees ports other containers publish (found in T2414's prep)
  - Accept: on Docker Desktop, the port check also reads the ports running containers publish (`docker ps`), so a port another container holds falls back to 8080/8443 as R4 says, instead of failing at `docker compose up` with "port is already allocated". Test with a fake Docker answer.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

- [x] T2423 Destroy removes a failed first provision's shared Cloudflare entries (found in T2414)
  - Accept: with no state and no deployment but this app's entries in OpsCrew's Cloudflare record, `opscrew destroy` plans and applies only the shared-rules removal (approved as today) instead of refusing "Nothing is deployed"; with nothing at all the refusal stays.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

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

- [x] T2412 The guide: a new `docs/guide/snapshots.md`; `rollback.md`, `databases.md`, `own-server.md` and `portainer-target.md` link to it, and "backups are yours to set up" changes.
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

- [x] T2413 The live passes, in `packages/cli/test/live/snapshots*.ts` and `docs/e2e.md` (plan.md 10.)
  - Depends: T2411
  - Effort: high

- [x] T2414 The live runs (lead), `docs/e2e-coverage.md` per run.
- [x] T2415 The simplify pass (lead), its findings as tasks.

### Simplify tasks (from T2415's review, 2026-11-07)

Three read-only reviewers went over `a5ab66cc..HEAD`: iac-templates; agents and the connectors;
the schema, core, the CLI, MCP, the guide and the plugin. Apart from the age pin (T2424), the
Portainer dump's login (T2424) and the wording below, no change alters behaviour, a refusal, an
approval, the scripts' files, exit codes or markers, or what is redacted; snapshots may change only
where a test fixture or the text below does.

- [x] T2424 [P] Simplify iac-templates, and the age pin the updater can refresh
  - Owns: `packages/iac-templates/src/**`, `packages/iac-templates/scripts/**` (+ tests, fixtures, snapshots)
  - Accept:
    - **The copies:** one `onlineCopy(part, file)` exported from `workflow/snapshots.ts` (the
      databases' login and dump, Valkey's and Redis' login and `--rdb`); the servers'
      `partCommands` and Portainer both use it, and Portainer keeps only Dragonfly's and SQLite's
      own, built from the exported constants. `portainerSnapshotParts` is `snapshotParts(plan)`'s
      online parts with Portainer's service, image, mounts and copy. Portainer's `pg_dump` logs in
      as `app`, as its `partRestore` does. `databaseKind` reads `DATABASE_KINDS`, the two
      Redis-protocol checks `REDIS_PROTOCOL_KINDS`, and `everySeconds` is `scheduleHours * 3600`.
    - **age (found in review: the pin updater never refreshes `binarySha256`, so an age bump
      would fail every copy off the server):** the checked archive stays in the tools folder;
      `age_ok` checks the archive's pinned SHA-256 before each use and unpacks the binary for that
      run only; `binarySha256` and its pins go. `pins.test.ts` checks age's hashes with its
      `HEX64` loop and builds its URLs from `TOOLS.age.version`.
    - **Hold and data:** one `holdsData(plan)` in `snapshots.ts` for `heldRefusal`, `holdScript`
      and `index.ts`'s two `snapshotScript(plan).length` uses; `holdApp(plan)` and
      `resumeApp(plan)` in `switch.ts`, used by `snapshot-script.ts` (`recordRunning` stays
      outside them); one `heldProbe(dir)` beside `RESTORE_HELD` for `index.ts`'s two held checks,
      with `-f` everywhere; `heldStep` goes, `outgoingStep` runs when `early`.
    - **The off-server copy:** one `rcloneSettings(copy)` in `offsite.ts` (exported, for T2425)
      for the server's and Portainer's rclone settings; one `age_ready` in `ageFunctions` for the
      "age could not be fetched" line.
    - **Small:** `migratedParts` includes SQLite, and `switch.ts`'s down-migration parts use
      `migratedParts(plan, APP_SERVER)`; `serverWords` exported from `switch.ts` for
      `snapshot-script.ts`'s three inline copies; one `said` beside `printfFormat` in
      `shared.ts`; one root-folder builder for `storageRootDir` and `backupsRootDir`;
      `offsiteVariables` inlined in `stack.ts`; `kafkaTool` exported from the root (for T2427).
    - **Tests:** the `snapshot-script.test.ts` test whose secrets never reach the script goes
      (the regex check after it stays); the fuller fake `flock` and `df` move to
      `workflow/__fixtures__/sh.ts` for both tests; one `__fixtures__/docker.ts` spawn helper (cwd,
      input, env, timeout) for the Docker tests.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, then with `OPSCREW_DOCKER_TESTS=1` `snapshot-script.docker.test.ts`, `workflow/snapshots.docker.test.ts` and `portainer-target/snapshots.docker.test.ts`
  - Effort: high

- [x] T2425 Simplify agents, the connectors and the snapshot contract
  - Owns: `packages/agents/src/**`, `packages/connectors/{hetzner,digitalocean}/src/**` (+ tests), `packages/contracts/src/connector.ts` (only the two fields below)
  - Depends: T2424
  - Accept:
    - **Words:** `shared/server-address.ts`'s `serverWords` replaces `snapshot/hosts.ts`'s
      `serverName` and `rollback/database.ts`'s two variants (`upperFirst` where capitalised;
      "server data" for "the server data", pinned texts follow); one `partWords`; one
      `KIND_WORDS: Record<SnapshotKind, string>` for `delete.ts` and `restore-checks.ts`
      (`list.ts`'s own stays); one `NOTHING_TAKEN`.
    - **The store:** `rollback/database.ts` uses `snapshot/store.ts`'s `About` and `aboutOf`; one
      `requireSnapshotId(id)` beside `SNAPSHOT_ID` for `delete.ts` and `restore.ts`;
      `offsite.ts` reads with `readValidJson`.
    - **Portainer:** one `stopAndSave(...)` in `restore-portainer.ts` for the restore's and the
      Portainer rollback's stop, copy and put-back (the rollback's marking passed in), the
      started-services set built once; `restore-offsite.ts`'s cleanup uses `portainer.ts`'s
      `box`; `portainer.ts` uses a `diskCommand(dir)` and `RUNNING_IMAGE_FILE`;
      `restore-portainer.ts` uses `COMPOSE_SERVICE_LABEL`.
    - **Hosts and calls:** one `dataHosts(run)` in `hosts.ts` for take, restore and list;
      `restoreEach`'s two script calls through one closure; one `offsitePreflight` in
      `provision/storage.ts` for `run.ts` and `portainer-flow.ts`.
    - **rclone:** one pure `offsiteRclone(offsite, endpoint, key)` returning the settings and the
      Docker arguments, and `RCLONE_NOT_FOUND`, exported from the root (for T2427), built on
      iac-templates' `rcloneSettings`; `restore-offsite.ts` and `offsiteBucket` use it.
    - **Small:** `retarget/sides/own.ts` uses `destroy/own.ts`'s `appSnapshots`;
      `status/snapshots.ts` uses `list.ts`'s `newestFirst`; `bucketEntries`, `readableBucket` and
      the `offsitePriceText` re-export unexported; one `SH_AVAILABLE` fixture; one agents test
      pins ssh-host's `snapshotScheduleTag(app)` equal to the tag of the crontab line `snapshot.sh`'s
      schedule renders (the packages share no dependency, so the two definitions stay).
    - **Connectors and contract:** the Hetzner connector's `said()` uses core's `errorText`;
      `ServerSnapshot.name` and `.labels`, which nothing reads, go with their mapping in both
      connectors.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-hetzner --filter=@opscrew/connector-digitalocean && pnpm typecheck`
  - Effort: high

- [x] T2426 [P] Simplify core's age test helpers, a schema test, the guide and the skill
  - Owns: `packages/core/src/{crypto/age.ts,testing/**}`, `packages/plan-schema/src/snapshots.test.ts`, `docs/guide/snapshots.md`, `plugin/skills/opscrew-snapshots/SKILL.md`
  - Accept:
    - `crypto/age.ts` exports (from the module, not the package root) `AGE_VERSION`, the X25519
      prefix, the chunk size, `hkdf` and the stanza strings; `testing/age.ts` imports them, and
      `@opscrew/core/testing` re-exports `AGE_VERSION` (for T2427).
    - `plan-schema`'s two Portainer tests become one loop over both paths.
    - **The guide:** "The snapshot before each release" and "Rolling back in your Portainer"
      become a few lines linking `rollback.md#snapshots-before-each-release` and
      `rollback.md#in-your-portainer`; where `scheduled.log` is and that status reports a failed
      scheduled snapshot, said once; the script approvals link to "In a script". Found in review:
      the bucket is named `<app>-<env>-backups` (`shop-prod-backups` for prod), not `<app>-backups`.
    - **The skill:** the list of kinds once. Found in review: versioning is on only at Hetzner,
      and on Spaces the copies stay after `offsite off` until the user deletes them (the server
      deletes old ones only after its uploads); Hetzner and R2 expire them after `--days`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core --filter=@opscrew/plan-schema && pnpm lint`
  - Effort: medium

- [x] T2427 Simplify the CLI, MCP and the live harness
  - Owns: `packages/cli/src/**`, `packages/cli/test/live/**`, `packages/mcp-server/src/**` (+ tests)
  - Depends: T2424, T2425, T2426
  - Accept:
    - **Copies the live tests drop:** `AGE_HEADER` uses `@opscrew/core/testing`'s `AGE_VERSION`;
      `rcloneSettings`, `rcloneDockerArgs`, the `BackupsBucket` endpoint choice and
      `RCLONE_NOT_FOUND` use agents' `offsiteRclone` (its support test goes); `kafkaTool` comes from
      iac-templates; `runAppName`'s regex check goes (`designRunApp` already checks the name).
    - **Shared with 019 and 023's passes:** one `storageChoice(env, provider)` from
      `componentSettings` for the components, retarget and snapshot support files and O1;
      retarget's `ROWS_TABLE`, `psql`, `mysql`, `seedData` and `readData` (a SQLite-script
      parameter) exported, the snapshot checks adding only Kafka; one `requireDocker(why)` with
      `tls-checks.ts`; `deployLogLeaks` in `snapshots-support.ts`, used by `rollback.test.ts`; one
      `deployBranchImage` with `portainer-target.test.ts`.
    - **`snapshots.test.ts`:** one `startPass(run, envs, commit)` for the three Hetzner passes;
      `snapshotLeaks(run, envs, deployRuns = [])`; `OFFSITE_PREFIX` for `BACKUPS_PREFIX`;
      `restoredMark` reads `RESTORED_IMAGE_FILE` as it is.
    - **CLI tests:** `snapshot.test.ts`'s and `restore.test.ts`'s `setup`, `lastCall` and `asking`
      (its refusal text a parameter) in `ui/__fixtures__`; `provision-offsite.test.ts`'s two tests
      become one.
    - **MCP:** one `refuseUnconfirmedOwnServer(...)` in `elicitation.ts` for `snapshots.ts`,
      `logs.ts` and `status.ts`; one plan-text function for `backupsPlanText` and `bucketPlanText`.
    - No live pass changes what it checks.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: high

- [ ] T2416 The release (lead): `docs/releasing.md`.
