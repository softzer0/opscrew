---
description: "Tasks for 019-rollback"
---

# Tasks: Rollback

**Input**: `specs/019-rollback/`:
- spec.md, plan.md, research.md (R1–R5, and R6 from T1901), data-model.md;
- contracts/rollback.md;

plus `docs/adr/0023-rollback-and-deploy-pause.md`, and features 000–018.

**Numbering**: T1901–T1999.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.

**Rules for every task:**
- **Fixtures** never contain secret-shaped literals. Use `fakeSecret()`, or `{{FAKE:…}}` with `materializeFixture()`. Digests and commits in tests are generated hex, never copied from a real registry.
- **No network:**
  - GitHub, GHCR, Cloudflare and the servers are fakes.
  - The workflow's scripts run in bash against `rollback.test.ts`'s fake server.
  - Tests that need bash or Docker skip with a clear message when it is absent.
- **No leaks:** none of these may appear in an approval's text, the output, an audit entry, the pause variable, a committed or generated file, a snapshot or an MCP answer (SC-1905):
  - an app secret, or a value of `app.env`;
  - a GitHub, GHCR or Cloudflare token, or a pull token;
  - a server's address;
  - an unmasked log line of a failed copy.

  Commit messages pass through the redactor. Every task's tests include a leak check for the values it handles.
- **Approvals:**
  - A rollback is a `promote`-kind approval bound to its hash. `--yes` never grants it, and scripts give `--approve <hash>`.
  - Resuming is a `github-settings` approval, which `--yes` grants.
  - No new approval kind, and no change in `@opscrew/contracts` or `plan-schema`.
- **Unchanged without a rollback:**
  - A push deploys as before, on every target: the job graph's push case is tested.
  - Provision's first deploy and `applyLocal` pass no mode.

  Every workflow's text does change once (plan.md 1., 4.).
- **Refusals** come before any change, are in plain words, and end "Nothing was changed." with what to do next.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** write long files with the Write or Edit tool, not shell heredocs (Windows Defender blocks some).
- **Neutral examples only:** `example.com`, `example-app`, and `203.0.113.0/24` for addresses.

## Phase 1: Foundation

- [X] T1901 The spikes and the ADR (lead): research.md R6, plus `docs/adr/0023-rollback-and-deploy-pause.md`.
  - **The spikes** (plan.md Technical Context), on the throwaway repository:
    - S3 first;
    - then S1, S2, S4;
    - and S5 with local Docker.
  - **The results:** one line per question in research.md "R6": what was run, and what was seen.
  - **They settle:**
    - the job-level `if:` text, including the `inputs` fallback;
    - whether environments on a non-default branch can be dispatched;
    - the tag list's paging and token types;
    - the Pages exemption;
    - the Portainer release switch.

    A finding that changes a design goes into plan.md before wave 2.
  - **The ADR** records D1–D6 as the lead decides them.

## Phase 2: Wave 1 (parallel)

- [X] T1902 [P] [US1] [US5] The switch: the release skipped on a rollback, the failed copy's lines, and the three messages, in `packages/iac-templates/src/workflow/switch.ts`
  - Owns:
    - `packages/iac-templates/src/workflow/{switch.ts,switch.test.ts,rollback.test.ts}`;
    - `packages/iac-templates/src/workflow/__snapshots__/**`, updated by the test run only;
    - in `packages/iac-templates/src/index.ts`, only the `FAILED_DEPLOY_DIR` export line.
  - Reads: plan.md "1." ("How `switchCommands` skips the release"), "6."; spec FR-1901, FR-1910–FR-1912; research.md R4; data-model.md "On the servers"
  - Depends: T1901
  - Accept:
    - **The mode:**
      - The start script reads `MODE="${2:-deploy}"`. With `rollback`, it skips the release block and prints that a rollback runs no release command (US1 #3).
      - Without `$2`, or with `deploy`, the fake server sees the same calls as before. Tested on a plan with a release command, workers and cron.
    - **In `rollback.test.ts`'s harness, a start with `$2 = rollback`:**
      - no `docker compose run … release`;
      - `release.log` untouched;
      - the switch, the workers and the 30-second check as a deploy;
      - a failed health check removes the copy, and the automatic switch back restores, as a deploy does.
    - **`keep_failed`,** with `.failed-deploy/` at 0700 and its files at 0600:
      - **A failed health check** (rolling and recreate): `about` (`image=`, `time=`, `failed=health`) and `app.log` (`docker logs --timestamps --tail 500` of the copy), written before the copy is removed.
      - **A worker that stopped:** `<worker>.log` and `failed=process <name>`, before the exit.
      - **`rollbackCommands` after the check from outside:** the replaced app container's lines, `failed=check`.
      - A failure of another image clears the old files first.
      - The paths are built from the scripts' roots, so this computer gets them under `OPSCREW_APPS_DIR`.
      - The harness's fake `docker` gains `logs`.
    - **`FAILED_DEPLOY_DIR`** is exported.
    - **Messages:**
      - `healthFailed` adds "`opscrew logs --failed`";
      - `processFailed` points to `opscrew logs --failed --service <name>`, with the app's `--app`/`--env` flags as `provisionCommand` builds them, and no longer to `docker compose logs` (FR-1911);
      - `releaseFailed` says the migration may have run partly, where `release.log` is, and to fix the migration and deploy forward, or restore a backup (FR-1912).

      None names a server's address or a secret.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm turbo run typecheck --filter=@opscrew/agents`
  - Effort: high

- [X] T1903 [P] [US1] [US3] The GitHub connector: GHCR's tag list, run fields, file text, in `packages/connectors/github/**`
  - Owns: `packages/connectors/github/**` (+ tests)
  - Reads: plan.md "3."; contracts/rollback.md "connector-github"; research.md R6 (S2); `ghcr.ts`, `github.ts`
  - Depends: T1901
  - Accept:
    - **`GhcrReader.tags`:**
      - every tag through `GET /v2/<name>/tags/list`, following GHCR's paging as S2 recorded;
      - one pull token;
      - `undefined` on 404;
      - the existing "denied" hint on 401/403.
    - **`describeTags`:** each tag's digest and `ImageFacts`, with one pull token for all. A tag GHCR lacks has no digest.
    - **`GitHubClient`** passes both through.
    - **`workflowRun`** adds `createdAt`, `status`, `conclusion` and `headCommit?`.
    - **`listWorkflowRuns`:** each run adds `event`, `headBranch` and `headCommit?`, and an `event` filter is accepted.
    - **`fileText(owner, repo, path, ref)`:**
      - the file's UTF-8 text from the contents API;
      - `undefined` on 404;
      - a file over 1 MB refused plainly.
    - **`GITHUB_TOKEN_PERMISSIONS`:** the Variables line names the check, a move and `opscrew rollback`.
    - **Tests with `fetch` fakes:**
      - tokens registered with the redactor before any read;
      - no commit message or file content in an error text.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github && pnpm turbo run typecheck --filter=@opscrew/agents`
  - Effort: high

- [X] T1904 [P] [US1] [US2] The shared pause and deploy run, and promote and the move on them, in `packages/agents/src/{shared,promote,move}/**`
  - Owns:
    - `packages/agents/src/shared/{deploy-pause,deploy-run}.ts` (+ tests);
    - `packages/agents/src/promote/**` (+ tests, fixtures);
    - `packages/agents/src/move/{deploys,window,index}.ts` (+ tests);
    - in `packages/agents/src/provision/run.ts`, only the paused note and the move's refusal (+ test);
    - in `packages/mcp-server/src/tools/environments.test.ts` and `packages/cli/src/commands/promote.test.ts`, only their fakes' new method.
  - Reads: plan.md "2." ("What to share…"), "4."; contracts/rollback.md "agents"; `move/deploys.ts`, `promote/{run,shared,image,record,site}.ts`
  - Depends: T1901
  - Accept:
    - **`shared/deploy-pause.ts`,** per the contract:
      - a move's entry keeps its exact bytes;
      - a rollback's entry has `image`, `commit` and `from`;
      - `setDeployPause` returns the entry it replaced, and `restoreDeployPause` puts it back (or removes the key);
      - `clearDeployPause(…, reason)` never removes another reason's entry;
      - the variable is deleted when empty;
      - a variable that isn't OpsCrew's JSON stops with today's hint;
      - every change is audited.
    - **`runningDeploy`, and `waitForDeploys` moved unchanged.**
    - **`shared/deploy-run.ts`:** `dispatchAndFollow` holds promote's step 5. Promote's existing tests pass, changing only their imports.
    - **promote:**
      - refuses while its target is paused, for either reason, before the approval: `PHASE_PRECONDITION`, with the hint `opscrew rollback --env <target> --resume`, or for a move, provision;
      - `requireApplied` takes the branch, and promote passes the default branch;
      - `rollBackWorker` and `rollBackPages` are exported with `{ command, versionFlag, beforeChange? }`, promote's own messages unchanged;
      - `requireRollbackServices`, `readPromotion` and `writePromotion` are exported, and the pending helpers take the file's name.
    - **D1 (as ADR 0023 decides):** `checkProvenance` also accepts a `workflow_dispatch` build of this repository on the builder branch. Other events refuse as today. Tests both ways.
    - **The move:**
      - provision refuses to start a move's window while a rollback entry exists, with the hint `opscrew rollback --resume`;
      - `resumeDeploys` clears only `move`.
    - **provision:** when the environment is paused by a rollback, its summary says the merged files deploy only after `opscrew rollback --resume --deploy`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/mcp-server --filter=opscrew`
  - Effort: high

## Phase 3: Wave 2 (parallel)

- [ ] T1905 [US1] [US2] [US4] The workflows: the rollback dispatch, the job graph, the pause on every target, Portainer's release switch, in `packages/iac-templates/src/{workflow,portainer-target}/**`
  - Owns:
    - `packages/iac-templates/src/workflow/**` except `switch.ts` (+ tests, snapshots, fixtures);
    - `packages/iac-templates/src/portainer-target/**` (+ tests, snapshots);
    - in `src/index.ts`, only new export lines.
  - Reads: plan.md "1.", "4.", "5." (Portainer, the sites); contracts/rollback.md "iac-templates"; research.md R6 (S1, S3, S4, S5); `jobs.ts`, `shared.ts`, `index.ts`, `build.ts`, `portainer.ts`
  - Depends: T1901, T1902
  - Accept:
    - **The inputs** of the contract, on branch-following server and Portainer workflows and on promoted ones.
    - **The job graph of plan.md 1.,** with YAML tests of each case's `needs` and `if:`:
      - push;
      - push while paused;
      - rollback dispatch;
      - a dispatch with no inputs;
      - promoted with and without `rollback`.
    - **`verify`** for branch-following environments uses `BUILD_BRANCH: <cicd.branch>`. Its script accepts `workflow_dispatch` (D1) and names `opscrew rollback`.
    - **Images and the jobs after the deploy:**
      - `imageOutput` alternates `build` and `verify`;
      - `label` needs `[build, verify, deploy]` with its `if:`;
      - `sign`, `tag` and `prune` are unchanged.
    - **The start step:**
      - `MODE` and `"$MODE"` as `$2`;
      - the summary line on a rollback;
      - `rollbackStep`'s messages in mode `rollback`.
    - **The pause:**
      - the condition is rendered always: servers, Portainer, the local runner, Cloudflare's hosting, and GitHub Pages with `github.run_attempt > 1`;
      - the `paused` job (`permissions: {}`, `jq`, a notice and the summary for both reasons, the key from `checkEnvironmentKey`);
      - `job()` renders `permissions: {}`.
    - **Portainer:**
      - the placeholder in the `release` service;
      - `writeScript` substitutes `skip` or `run`;
      - the commit message on a rollback;
      - the stack's `docker compose config` test passes.
    - **The bash harness** runs a rollback dispatch's start step on the fake server (no release) and a push's (as before).
    - **`deploySecretNamesFor` is unchanged.** Every snapshot change is explained by the above.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm turbo run typecheck --filter=@opscrew/agents`
  - Effort: xhigh

- [X] T1906 [P] [US1] [US3] The versions: the list, the marks, the default, `--to`, and the old plan's check, in `packages/agents/src/rollback/{versions,types}.ts`
  - Owns: `packages/agents/src/rollback/{versions,types}.ts` (+ tests, `rollback/__fixtures__/**`)
  - Reads: plan.md "3.", "2." (step 5); data-model.md "A version"; contracts/rollback.md "agents"; `promote/image.ts`, `environments/branches.ts` (`builderCicd`)
  - Depends: T1903, T1904
  - Accept:
    - **`listVersions`, per plan.md 3.:**
      - the runs of the builder's workflow and branch, the tags, and per candidate the digest, facts, provenance (`[env]` for a branch-following environment) and CPU;
      - newest first by the build run's time, at most 20;
      - what was left out, counted, with reasons (FR-1903).
    - **Marks and the default (D4):**
      - `running` from `opscrew-<env>`;
      - `previous` by the rule;
      - "only one version", and a missing label, refuse (FR-1907).
    - **`--to`:** a commit prefix, a digest, or a digest prefix. Not listed, running, or ambiguous each refuse with what is there (US1 #4, US3 #3).
    - **The old plan** (`fileText` at the target's commit):
      - services gone refuse;
      - workers, cron jobs and variables added since become lines for the approval;
      - an unreadable old plan is "not checked".
    - **`describeImage`.**
    - **Tests with a fake world:**
      - prod, staging (`<sha>-staging`), a promoted environment (the builder's form);
      - a failed build, a `workflow_dispatch` build, an arm64 image, an image gone;
      - a rollback of a rollback;
      - with and without GHCR access.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [X] T1907 [P] [US5] `opscrew logs --failed`, in `packages/agents/src/logs/**`, the CLI flag and MCP's `failed`
  - Owns:
    - `packages/agents/src/logs/**` (+ tests);
    - `packages/cli/src/commands/logs.ts` (+ test);
    - `packages/mcp-server/src/tools/logs.ts` (+ test).
  - Reads: plan.md "6."; data-model.md "On the servers"; `logs/{targets,commands,read}.ts`
  - Depends: T1902
  - Accept:
    - **Reading:**
      - `about` and `<service>.log` under `FAILED_DEPLOY_DIR`, through `logs`' existing access (the deploy user's shell, the own server's admin login with `sudo -n` where needed, this computer);
      - fixed `cat` commands;
      - the service checked against the plan's parts and `isContainerName`.
    - **The output:**
      - the first line names the failed copy's short digest, what failed, the time, and that it was removed;
      - lines parsed with `dockerLogLine` and masked (FR-1910, SC-1904).
    - **When nothing applies:**
      - none kept: it says so;
      - `--failed` with `--follow` or `--since`: refused;
      - Portainer and the sites: it says the target keeps none.
    - **`opscrew logs --failed [--service <name>]`** and MCP's `failed: true`, both read-only.
    - **Tests:**
      - a server, an own server through sudo, this computer;
      - a missing folder;
      - a leak check on a fake secret in the kept lines.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: high

## Phase 4: Wave 3 (parallel)

- [ ] T1908 [US1] [US2] [US3] [US4] The rollback: the server path (servers, promoted environments, Portainer), the pause, `--resume`, the records, in `packages/agents/src/rollback/**`
  - Owns:
    - `packages/agents/src/rollback/{index,run,server,resume,record}.ts` (+ tests);
    - `rollback/{local,site}.ts` only as exported stubs that T1910 fills (they throw "not available yet");
    - in `packages/agents/src/index.ts`, only new export lines.
  - Reads: plan.md "2.", "4.", "5." (Portainer, promoted); contracts/rollback.md "agents"; data-model.md "In GitHub", "This computer"; `promote/run.ts` as the model
  - Depends: T1904, T1905, T1906
  - Accept:
    - **Options and result per the contract,** with routing by target.
    - **The refusals of FR-1907,** each tested, before any change:
      - not provisioned, or a provision pending (`requireApplied` on `workflowBranch`, which also catches a workflow from before 019);
      - a deploy running;
      - a move (plan or variable);
      - `retarget`;
      - only one version.
    - **The approval (FR-1904, FR-1905):**
      - details as plan.md 2. step 6;
      - `imageRollbackHash` of the environment, the current digest, the target digest and the plan hash;
      - `--yes` never grants it;
      - a mismatch gives `PLAN_NOT_APPROVED`;
      - unapproved prints `opscrew rollback [--app <key>] --env <env> --to <digest> --approve <hash>`.
    - **The order:**
      1. set the pause, keeping the replaced entry;
      2. `waitForDeploys`;
      3. `dispatchAndFollow` with `{ digest, tag, rollback: "true" }` on `workflowBranch`.
    - **Each outcome:**
      - **Success:** `rollback.json`, plus `promotion.json` for a promoted environment, and the output says deploys are paused and how to resume (FR-1906).
      - **Waiting:** `pending-rollback.json` with `pauseBefore`.
      - **Failure, cancellation, or a definite refusal:** the pause is restored.
      - **The next run** checks the pending one first: it records it, or restores the pause.
    - **`--list`:** no approval and no write; the result carries the versions and the pause.
    - **`--resume [--deploy]`, per plan.md 4.:**
      - not paused: says so;
      - a move: refused;
      - a `github-settings` approval;
      - `--deploy` dispatches the branch with no inputs and follows it;
      - promoted: refused, with `opscrew promote`.
    - **Audit:** the pause set, restored and cleared; the dispatch; the outcome. No secret.
    - **Tests:**
      - two environments: only the rolled-back one's key changes;
      - a rollback of a rollback;
      - Portainer and promoted environments through the same path.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [ ] T1909 [P] [US5] [US6] `status` and `opscrew_status`: the running version, the one before, the pause, in `packages/agents/src/status/**` and the MCP tool
  - Owns:
    - `packages/agents/src/status/**` (+ tests, snapshots);
    - `packages/mcp-server/src/tools/status.ts` (+ test);
    - in `packages/cli/src/commands/status*.test.ts`, only the fakes' new method.
  - Reads: plan.md "7."; contracts/rollback.md "agents" (status); `status/check-state.ts` as the model
  - Depends: T1904, T1906
  - Accept:
    - **`deployStateReport`, called from `componentStatusReport` on every target:**
      - the server's `.env`/`.env.previous` and `.env`'s time, through `serverShell` (an own server through its login);
      - this computer's folder;
      - Portainer's labels;
      - `describeImage` for the commit, message and time;
      - the pause from GitHub, with `rollback.json` as the fallback.
    - **The lines of plan.md 7. (FR-1913):**
      - "paused since …, pinned to …, and the resume command";
      - "on";
      - "the rollback's run hasn't finished" when the server's image differs from the pinned one;
      - each read failure as a line saying why.
    - **The sites:** their rollback command becomes `opscrew rollback --to <id>`, plus the pause line.
    - **MCP:** `opscrew_status` data gains `deploys` (US6 #1), and its description says so.
    - **Tests:** a snapshot per target; existing status snapshots change only by the new section.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/mcp-server --filter=opscrew`
  - Effort: high

## Phase 5: Wave 4 (parallel)

- [ ] T1910 [P] [US4] This computer, Cloudflare's hosting and GitHub Pages, in `packages/agents/src/rollback/{local,site}.ts`
  - Owns:
    - `packages/agents/src/rollback/{local,site}.ts` (+ tests);
    - in `packages/agents/src/localhost/apply.ts`, only exporting `healthCheck`, `withRegistryLogin` and `outputTail`.
  - Reads: plan.md "5."; spec US4 #2–#4, FR-1908, FR-1909; `localhost/apply.ts`; `promote/site.ts`
  - Depends: T1902, T1908
  - Accept:
    - **This computer:** under the local lock.
      - The refusals:
        - no previous version;
        - the same image;
        - the previous image is the one this computer rolled back from;
        - the image missing from Docker (US4 #2).
      - The approval is `promote` kind with `imageRollbackHash` of the references.
      - Then:
        - `cp .env .env.previous`;
        - `switchCommands` with `set -- <image> rollback`;
        - the HTTPS check;
        - `rollbackCommands` on failure, with the error saying what runs.
      - The pause applies only when the local runner deploys from a branch.
    - **Cloudflare's hosting:**
      - default `before`, `--to <version>`, `--list`;
      - `rollBackWorker` with `versionFlag: "--to"` and `--allow-old-secrets` (US4 #3);
      - says "no build" before the approval;
      - the pause is set before the activation and restored on failure.
    - **GitHub Pages:**
      - default `pagesRuns[1]`, `--to <run id | commit>`;
      - says "rebuilds, 30 days" before the approval (US4 #4, FR-1909);
      - the pause is set before the re-run.
    - **After `beforeChange`:** any error raised after the pause was set (for example `rollBackWorker` refusing because secrets changed) restores the pause entry it replaced.
    - **Provision's paused note:** `provision/portainer-flow.ts` and the server-less provisions also say, through `mergeDeploysNote`, that their files deploy only after `opscrew rollback --resume --deploy` while a rollback pauses the environment, as T1904 made provision's server flow say. These files join this task's Owns for that note only.
    - **Tests:** each path, and each refusal.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [ ] T1911 [P] [US1] [US2] [US3] [US6] The CLI command and the plugin's skills, in `packages/cli/src/commands/rollback.ts` and `plugin/**`
  - Owns:
    - `packages/cli/src/commands/{rollback,rollback.test}.ts`;
    - in `packages/cli/src/commands/index.ts`, the registration;
    - in `packages/cli/src/deps.ts`, the `rollback` services (+ test);
    - `plugin/**`.
  - Reads: plan.md "2." (the command), "8."; contracts/rollback.md "CLI and MCP"; `commands/promote.ts` as the model
  - Depends: T1908
  - Accept:
    - **The flags of the contract,** with `--app` and `--env`, checked before any work:
      - `--approve` must be a hash;
      - `--yes` and `--deploy` only with `--resume`;
      - `--list` alone.
    - **The output:**
      - `--list` as a table, newest first, with the marks and the pause;
      - the rollback's result, a waiting run, and resumed;
      - next steps (`opscrew verify`, `--resume`);
      - exit codes 0, 1 and 2;
      - help text.
    - **The plugin:**
      - `opscrew-troubleshoot` and `opscrew-deploy` as plan.md 8. (US6 #2), the database caveat first;
      - the rollback always in the terminal;
      - `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew && node plugin/validate.mjs`
  - Effort: high

- [ ] T1912 [P] The guide and the runbook, in `docs/guide/**` and `packages/iac-templates/src/runbook/**`
  - Owns: those paths (+ runbook tests and snapshots)
  - Reads: spec (all); plan.md "1.", "4.–8."; contracts/rollback.md
  - Depends: T1905, T1907, T1908
  - Accept:
    - **New `rollback.md`,** with every part plan.md 8. lists, linked from `index.md` (FR-1915).
    - **`when-a-deploy-fails.md`,** reworked as plan.md 8. lists, linking to `rollback.md`.
    - **The other pages** plan.md 8. names.
    - **The runbook's "Roll back"** for servers, promoted environments and sites, including by hand in GitHub. Runbook snapshots updated.
    - **The upgrade note:** "run `opscrew provision` once per environment after upgrading".
    - **The token's Variables permission:** `security.md` and `alerts.md` name the permission as the connector's `GITHUB_TOKEN_PERMISSIONS` now words it (the scheduled check, a move, and `opscrew rollback`).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: medium

## Phase 6: Wave 5

- [ ] T1913 The live test (gated on `OPSCREW_E2E_ROLLBACK=1` and the Hetzner pass's variables), in `packages/cli/test/live/rollback.test.ts` (+ support), `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns:
    - `packages/cli/test/live/{rollback.test.ts,rollback-support.ts,rollback-support.test.ts}`;
    - `docs/e2e.md`, `docs/e2e-coverage.md`;
    - in `packages/cli/test/live/{cloudflare-hosting,github-pages}.test.ts`, only their rollback steps.
  - Reads: plan.md "9."; spec SC-1901–SC-1905; `harness.ts`, `builder-checks.ts` (`underLoad`), `environments.test.ts` (`promoteToProd`)
  - Depends: T1910, T1911
  - Accept:
    - **The steps of plan.md 9.,** each a test, sharing `LiveRun`:
      - one Hetzner server;
      - the test's own release command;
      - checks for SC-1901–SC-1905;
      - the approval-to-success time recorded.
    - **The site passes** roll back with `opscrew rollback`.
    - **Teardown:** every step tears down what it created, also on failure.
    - **The docs:**
      - `docs/e2e.md` explains how to run it;
      - `docs/e2e-coverage.md` gets the pass's row ("Not run yet") and the "Not tested live" items (Portainer, own server, this computer, promoted, reviewer-held).
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm --filter opscrew exec vitest run test/live/rollback-support.test.ts`
  - Effort: high

- [ ] T1914 The live runs (lead): T1913's pass, then `docs/e2e-coverage.md` updated per run. Findings become tasks.

- [ ] T1915 The simplify pass (lead): `/simplify` (or reviewers) over the whole feature's diff; real findings become tasks. Known items from T1902's review: one `appEnvFlags(plan)` in `workflow/shared.ts` for `switch.ts`'s `failedLogs` and `provisionCommand`; a re-run of the same image may show the earlier run's kept lines (the `check` keep is skipped when `about` names the image), and a start-script failure after the switch that is neither the health check nor a worker is kept as `failed=check`.

- [ ] T1916 The release (lead): `docs/releasing.md`, from the changelog to the plugin bump and the docs site sync.
  - The changelog says every deploy workflow changes. Before the first rollback, each environment needs `opscrew provision` and its merged pull request.
