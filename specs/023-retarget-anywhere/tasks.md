---
description: "Tasks for 023-retarget-anywhere"
---

# Tasks: Retarget anywhere

**Input:** `specs/023-retarget-anywhere/`: spec.md, plan.md and research.md (R1 to R5). Also
today's retarget (`packages/agents/src/retarget/`), move (`packages/agents/src/move/`), and
features 010 (own servers), 013 (several apps), 016 (sites) and 018 (split placement).

**Numbering**: T2301–T2399.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.

**Rules for every task:**
- **Approvals:**
  - Every change goes through its approval: IaC plans and host plans by hash, stacks by hash, the
    window's commands as one `remote-exec` approval.
  - Deletions need the typed name.
  - The user's own server, Portainer and its environment are never deleted or reset.
- **Leaks:** no token, key, password, server address or bucket key in output, plans, logs, audit
  entries, snapshots or MCP answers. Every agents task's tests include a leak check.
- **Fixtures** never contain secret-shaped literals: use `fakeSecret()`, or `{{FAKE:…}}` with
  `materializeFixture()`.
- **No network in unit tests:** use fakes for the providers, servers, Portainer, Docker, GitHub and
  Cloudflare.
- **Refusals** come before any change, in plain words, ending "Nothing was changed." with what to do
  next. User-facing text never names a feature number.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Examples:** neutral only, `example.com`, `example-app`, `203.0.113.0/24`.

## Phase 1: Foundation

- [x] T2301 The lead's groundwork:
  - ADR 0027: sides, the archive API, and the carrier and rclone images;
  - the contracts: `StreamRunner.open(cmd, args)` returning `{ stream: Duplex; exit }`,
    `DockerTransport.request({ method, path, headers, body?: Readable })` returning
    `{ status, headers, body }`, and `PhaseDeps.streams`;
  - the package scaffold `packages/connectors/docker` and the lockfile;
  - `packages/agents/src/retarget/sides/types.ts`;
  - the `busybox` and `rclone` digests in `packages/iac-templates/src/pins.ts`.

## Phase 2: Wave 1 (parallel)

- [x] T2302 [P] The move's schema, in `packages/plan-schema/`
  - Owns: `packages/plan-schema/src/**` (+ tests, regenerated schemas)
  - Depends: T2301
  - Accept:
    - `RetargetSchema.from.target` accepts any server target (cloud, own or Portainer) and the
      site targets.
    - New fields:
      - `from.objectStorage?`, the bucket being left: its presence means the bucket moves, and
        `plan.storage.objectStorage` is the new one;
      - `from.member?`, the old app server's network member;
      - `retarget.empty`, the services started empty (`app` for the app's own volumes; default
        `[]`);
      - Portainer `web` `caddy` gains `records?: boolean`.
    - The schema's refusals of moves to or from own servers and Portainer go. This computer and
      previews stay refused.
    - Existing fixtures, and cloud-to-cloud moves, parse as before.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema`
  - Effort: high

- [x] T2303 [P] The Docker connector and the stream runner, in `packages/connectors/docker/` and `packages/core/`
  - Owns: `packages/connectors/docker/src/**`, `packages/core/src/process*.ts` (+ tests)
  - Depends: T2301
  - Accept:
    - A typed subset of the Docker API through an injected `DockerTransport`:
      - containers: list by labels, create, start, stop, wait, logs, remove;
      - archive `GET` and `PUT`, streamed;
      - volumes: list, create, remove;
      - `system/df` and image pull.
    - The carrier operations (`readVolume`, `writeVolume`, `volumeDigest`) as plan.md
      describes.
    - `dialStdioTransport(open)` over `ssh … docker system dial-stdio`.
    - `StreamRunner` in core.
    - Errors in plain words, with no secret (a leak test).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-docker --filter=@opscrew/core`
  - Effort: xhigh

- [x] T2304 [P] [US2] Streaming through Portainer, in `packages/connectors/portainer/`
  - Owns: `packages/connectors/portainer/src/**` (+ tests)
  - Depends: T2301
  - Accept:
    - `pinnedStream`: chunked uploads and downloads, with the pinned certificate, `X-API-Key` and
      no fixed timeout.
    - `dockerProxyTransport(environmentId)`, satisfying `DockerTransport`.
    - `environmentKind`, to refuse Edge Agent environments.
    - A gated test against a local Portainer of the pinned image (`IMAGES.portainer`,
      `OPSCREW_DOCKER_TESTS=1`): a chunked `PUT` of
      1 GiB, and stopping and starting a stack's container with a standard user's token. If that
      needs an admin token, say so in the report.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-portainer`
  - Effort: high

- [x] T2305 [P] Layouts, records and the bucket root, in `packages/iac-templates/`
  - Owns: `packages/iac-templates/src/infra/**` (+ snapshots, fixtures)
  - Depends: T2302
  - Accept:
    - `moveLayout` for every pair of cloud, own and Portainer (Caddy with `records`).
    - The adopting `import` blocks for a Portainer side's records.
    - The Portainer root's `module.dns` with `records`.
    - The storage root with `bucket_previous` (`prevent_destroy`, a second provider alias).
    - Both engines `validate`, and the cloud-to-cloud snapshots are unchanged.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

## Phase 3: Wave 2 (parallel)

- [x] T2306 [P] [US3] Every catalog kind's copy, on Docker (spike S1 as a test)
  - Owns: `packages/agents/src/retarget/catalog-copy.docker.test.ts`, `packages/iac-templates/src/catalog/**`, `packages/iac-templates/src/runtime/components.ts`
  - Depends: T2303
  - Accept:
    - For every catalog kind and an app's SQLite volume, with the pinned images:
      1. seed data, users and passwords;
      2. stop the service;
      3. copy its stopped volumes with the connector into a second Compose project that has been
         created but not started;
      4. start that project;
      5. read the same data with the same logins; the digests match.
    - Each fix the test needs goes into the catalog (a stop grace period, a fixed hostname, Kafka's
      `meta.properties`).
    - `OPSCREW_DOCKER_CROSS_ARCH=1` adds the other architecture through `--platform`.
    - The report lists any kind that fails and why.
  - Verify: `OPSCREW_DOCKER_TESTS=1 pnpm --filter @opscrew/agents exec vitest run src/retarget/catalog-copy.docker.test.ts`
  - Effort: high

- [x] T2307 [P] [US1] The SSH sides: cloud and own
  - Owns: `packages/agents/src/retarget/sides/{ssh,cloud,own}*.ts`, `packages/agents/src/shared/{server-record,own-server}*.ts`
  - Depends: T2302, T2303
  - Accept:
    - `MoveSide` over `server-ops` and dial-stdio.
    - own `prepare` and `remove` as plan.md "1." describes, never the server itself.
    - The connections moved into `server.json`'s `retarget` slots and back.
    - Tests with fakes only, and a leak test.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2308 [P] [US2] The Portainer side, and Postgres in one-off containers
  - Owns: `packages/agents/src/retarget/sides/{portainer,postgres}*.ts`, `packages/agents/src/provision/{portainer-flow,stack-plan}.ts` (+ tests)
  - Depends: T2302, T2303, T2304
  - Accept:
    - `preparePortainerStacks` extracted, with provision's tests unchanged.
    - Edge Agent refused.
    - Postgres dump and restore for every side (`sides/postgres.ts`, over any `SideDocker`): one-off
      postgres containers on the service's network, the dump in a move volume that copies like any
      other, the password only in a `.pgpass` written through the archive API, and
      `pg_restore --list` plus a SHA-256 on both ends.
    - `remove`: the stacks and volumes, never the environment.
    - A leak test.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

## Phase 4: Wave 3 (parallel)

- [x] T2309 [US1] [US2] [US3] Start, steps, window and switch
  - Owns: `packages/agents/src/retarget/{start,steps,window,switch,run,session,servers,layouts,types,texts,plans,server-ops}.ts` (+ tests), and the phase type in `packages/agents/src/provision/own.ts`
  - Depends: T2305, T2306, T2307, T2308
  - Accept:
    - The steps (plan.md "2."), and the window (plan.md "3."), with `--empty` and the summary's
      sizes and minutes.
    - A rollback empties the new volumes, and the old side serves again (SC-2302).
    - The workflow pull request stop.
    - Every refusal of plan.md "4." and the spec's edge cases, before any change.
    - The DNS switch for every pair.
    - Found in T2307:
      - `recordMoveServers` (servers.ts) merges into `server.json`'s `retarget` object instead of
        replacing it, so the sides' `fromOwn` and `fromPortainer` slots survive (or calls
        `recordMoveAddress`).
      - `RetargetServices` gains `own` and `runnerGitHub`, passed to `ownSide`.
      - `OwnHostPhase` (provision/own.ts) includes `retarget`, so own host plans are audited as the
        move's.
      - A move to the user's server takes `--host-key` in a script. The password-logins hint names
        what the move offers, not `provision --password-logins`.
      - `requireNoProxySwitch` is shared with provision, and the move refuses a proxy switch on a
        server other apps share.
      - `startEdge` reloads Caddy on a shared edge, so certificates for the moved hostnames are
        tried again right after the switch.
      - The health check addresses the app's container (`<app>-app-1`), not the `app` alias, which is
        ambiguous on an edge network several apps share (server-ops).
      - No server address in the window's errors and hints (server-ops' messages, ssh's stderr
        line); the sides' wording ("your new server") everywhere.
      - `remoteFor` (session.ts) takes the port, and the sides' own `remoteOf` (sides/ssh.ts) goes.
    - Found in T2310: `loadMoveServers`, `layoutOf`/`previousTarget` (the final files' transitional
      layout), `requireSwitchSettled`, `storeDeploySecrets` and `restartOldApp` work for any old side
      through `moveSide`, not `previousCloud`; then end-to-end `--finish` and `--abort` tests for an
      own and a Portainer old side.
    - From T2306: the window stops each stateful service with a long timeout (120 s, `docker
      compose stop -t 120` on SSH sides, the stop call's `t` on Portainer), then checks it exited
      cleanly. A service that was killed (exit 137) or ran out of memory fails the window and rolls
      it back, so a killed database's files are never copied.
    - Also from T2310: `deletionStep`'s unused `beforeApply` goes (plans.ts); `forgetHostKeys` for an
      own old side forgets the admin login's host too, not only the move's addresses.
    - Found in T2308:
      - `RetargetServices` gains `portainer`; step `deployed` stores `portainerDeploySecrets` for a
        Portainer side.
      - Postgres goes through `sides/postgres.ts` on every side (`dumpPostgres`, `ensureDumpVolume`,
        the carrier copy of `moveDumpVolume(app)`, `restorePostgres`, `removeDumpVolume` on both
        sides afterwards and on rollback); its password is registered with the redactor.
      - server-ops' `withoutData` also drops `pg_dump: detail:` and `hint:` lines, which can quote
        rows (`move` uses it too).
      - A move between two Portainer environments is refused (one deploy branch, one webhook).
    - A leak test.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2310 [US1] [US2] Finish and abort, by side
  - Owns: `packages/agents/src/retarget/{finish,abort,removal}.ts` (+ tests)
  - Depends: T2307, T2308
  - Accept:
    - The old side at `--finish`, each after the typed name:
      - cloud, as today;
      - own, by a teardown host plan;
      - Portainer, by a stack teardown.
    - `--abort` removes the new side the same way.
    - Found in T2308: after a move from Portainer, `--finish` deletes the Portainer deploy branch the
      old side used.
    - From T2307's review: `finish.ts` and `abort.ts` call `side.remove` instead of keeping their own
      copies of the cloud removal (`finishFlags`, `removeNewServer`), which now live in
      `sides/cloud.ts`.
    - Found in T2307: the old cloud side's snapshot id is read back with `takeSnapshotBeforeDelete`
      (`SideStop` doesn't carry it), and the abort's bookkeeping is recorded inside the `confirm`
      wrapper (`remove` has no `beforeApply` hook).
    - SC-2304: never a server of the user's, Portainer or its environment.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 5: Wave 4 (parallel)

- [x] T2311 [US4] Buckets
  - Owns: `packages/agents/src/retarget/bucket*.ts`, `packages/agents/src/provision/storage.ts`, `packages/agents/src/destroy/storage.ts`, and the bucket call sites in `retarget/{start,steps,window,finish,abort}.ts` (+ tests)
  - Depends: T2309, T2310
  - Accept:
    - plan.md "5.".
    - FR-2312: the keys only on standard input, never in a plan, log or audit entry.
    - Two typed names at `--finish`: the app's and the bucket's.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [x] T2312 [US5] Sites between site hosts
  - Owns: `packages/agents/src/retarget/site*.ts`, the dispatch in `retarget/run.ts`, `packages/agents/src/serverless/**` (+ tests)
  - Depends: T2309
  - Accept:
    - plan.md "6.": Workers to Pages and back, with fakes.
    - A site to a server, or a server to a site, refused plainly.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

## Phase 6: Wave 5 (parallel)

- [ ] T2313 [US6] Several servers and monitoring
  - Owns: `packages/agents/src/network/**`, `packages/agents/src/retarget/network*.ts`, and the network call sites in `retarget/{start,steps,finish,abort}.ts` (+ tests)
  - Depends: T2311
  - Accept:
    - plan.md "7.". The old member leaves only at `--finish`.
    - Monitoring on the app server copied, and on its own server kept. Found in T2307: the sides'
      `stopServices` and `startServices` cover the monitoring stack's project.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [ ] T2314 The CLI, MCP, status and the e2e
  - Owns: `packages/cli/src/commands/retarget*.ts`, `packages/cli/test/e2e/retarget.test.ts`, `packages/mcp-server/src/**`, `packages/agents/src/status/**`, `plugin/skills/**`
  - Depends: T2311, T2312
  - Accept:
    - `--to own|portainer|<site host>`, `--answers`, `--empty` (repeatable), `--keep-bucket`,
      `--pages-verification` (found in T2312), and `--confirm` for both names.
    - Found in T2308: `RetargetApprovalHandler` handles a `stack-apply` teardown with `--approve` and
      `--confirm`, as it handles `iac-apply` deletions.
    - `opscrew_status` shows the step for every target.
    - The e2e with fakes covers each pair.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: high

- [ ] T2315 The guide
  - Owns: `docs/guide/retarget.md`, and links in `docs/guide/{own-server,portainer-target,object-storage,split-placement}.md`
  - Depends: T2309, T2314
  - Accept:
    - Every target, the data (copy or empty, and what empty loses), the window's length, buckets
      and egress, sites, and several servers.
    - "To keep a service": place it on an extra server first.
    - The shorter "can't move yet" list.
  - Verify: `pnpm lint`
  - Effort: medium

- [x] T2320 [US2] Found in T2309: a Portainer target whose records OpsCrew manages, and the paused deploys' hint
  - Owns: `packages/agents/src/destroy/portainer*.ts`, `packages/agents/src/drift/portainer*.ts`, `packages/agents/src/move/deploys.ts` (+ tests)
  - Depends: T2309
  - Accept:
    - `destroy` of a Portainer target with `web.records: true` deletes its DNS records with the rest
      (its root holds `module.dns` now), after the typed name; `drift` compares them.
    - `withDeploysPaused`'s hint names the command that holds the pause (`opscrew retarget` in a move,
      `opscrew provision` otherwise), not always provision.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

## Phase 7: Live

- [ ] T2316 [US1] [US2] [US3] [US4] The live pass, in `packages/cli/test/live/`
  - Owns: `packages/cli/test/live/retarget-anywhere*.ts`, `docs/e2e.md`
  - Depends: T2314
  - Accept, gated on `OPSCREW_E2E_RETARGET_ANYWHERE=1`:
    - An example app with Postgres, MySQL, Valkey holding jobs and a SQLite file moves from
      Hetzner, to a throwaway server provisioned as the user's own, to DigitalOcean. The own server
      is arm64 (a Hetzner CAX type), so the copy crosses architectures for real (T2306: QEMU can't run
      most kinds). Every row, job
      and file is there afterwards.
    - A Hetzner bucket moves.
    - A Portainer leg: to it and back.
    - A site leg (found in T2312): GitHub Pages to Cloudflare's hosting and back on the e2e domain.
      It checks that the Pages to Workers switch, whose record deletes and creates run in parallel,
      finishes (in one run or two).
    - A forced copy failure leaves the old app serving.
    - A leak search.
    - Cleanup always runs.
  - Verify: `pnpm turbo run typecheck --filter=opscrew`
  - Effort: high

- [ ] T2317 Live runs (lead): T2316's pass on the final code, recorded in `docs/e2e-coverage.md`.

## Phase 8: Finish

- [ ] T2318 Simplify (lead): a review of the feature's diff for reuse and simplicity. Known so far: provision/portainer-flow.ts sets the Portainer records' TF_VARs inline, beside T2320's `setPortainerRecordsAddress` (move it to shared/ and use it in all three); postgres.ts's one-file tar writer; the shared output filter (S4 from T2308's review).
- [ ] T2319 Release (lead): `docs/releasing.md`, with 022's opt-ins in the same release. (T2312's review: the Worker's custom domain moves to its new address in the infrastructure
  code by itself, a moves-only plan, so no changelog warning is needed.)
