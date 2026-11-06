---
description: "Tasks for 019-rollback"
---

# Tasks: Rollback

**Input**: `specs/019-rollback/`:
- spec.md, plan.md, research.md (R1–R5, and R6 from T1901), data-model.md;
- contracts/rollback.md;

plus `docs/adr/0023-rollback-and-deploy-pause.md`, and features 000–018.

**Numbering**: T1901–T1999 (the database follow-up: T1930–T1943).

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

- [X] T1905 [US1] [US2] [US4] The workflows: the rollback dispatch, the job graph, the pause on every target, Portainer's release switch, in `packages/iac-templates/src/{workflow,portainer-target}/**`
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

- [X] T1908 [US1] [US2] [US3] [US4] The rollback: the server path (servers, promoted environments, Portainer), the pause, `--resume`, the records, in `packages/agents/src/rollback/**`
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
    - **Portainer drift after a rollback** (from T1905): `drift/portainer.ts` compares the deploy branch with `fillPortainerStack(template, image)`, which fills `run`. A rollback's commit holds `OPSCREW_RELEASE: skip`, and drift accepts it as in place. `packages/agents/src/drift/portainer.ts` (+ test) joins this task's Owns for that.
    - **Tests:**
      - two environments: only the rolled-back one's key changes;
      - a rollback of a rollback;
      - Portainer and promoted environments through the same path.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [X] T1909 [P] [US5] [US6] `status` and `opscrew_status`: the running version, the one before, the pause, in `packages/agents/src/status/**` and the MCP tool
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

- [X] T1910 [P] [US4] This computer, Cloudflare's hosting and GitHub Pages, in `packages/agents/src/rollback/{local,site}.ts`
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

- [X] T1911 [P] [US1] [US2] [US3] [US6] The CLI command and the plugin's skills, in `packages/cli/src/commands/rollback.ts` and `plugin/**`
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
    - **Services:** `servicesOf(ctx).rollback` fills `localhost` (this computer's executor) and `now`, which `RollbackServices` gained in T1908.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew && node plugin/validate.mjs`
  - Effort: high

- [X] T1912 [P] The guide and the runbook, in `docs/guide/**` and `packages/iac-templates/src/runbook/**`
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

- [X] T1913 The live test (gated on `OPSCREW_E2E_ROLLBACK=1` and the Hetzner pass's variables), in `packages/cli/test/live/rollback.test.ts` (+ support), `docs/e2e.md`, `docs/e2e-coverage.md`
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

- [x] T1917 [US4] Three fixes found by T1912's fact-check, in `packages/agents/src/{rollback,status}/**` and `packages/iac-templates/src/workflow/cloudflare-workers.ts` (+ tests)
  - Owns: those paths
  - Depends: T1910
  - Accept:
    - **GitHub Pages while paused.** A push while a rollback pauses deploys finishes as `success` with its deploy job skipped, and `pagesRuns` lists it, so `pagesMarks` (`rollback/site.ts`) and `previousPagesRun` (`status/site.ts`) take it for the running run. Example: B is bad, A is rolled back to, C is pushed while paused; the default target is then B. Fix: while a rollback pause exists, the running run is the pinned run id. A run whose deploy job didn't run is never "running". Test: a second rollback after a paused push goes further back than A, never to B.
    - **This computer without the local runner.** `rollback/resume.ts`'s `deploysOn` no longer says "each push to <branch> deploys it", since nothing deploys on push there. It says to run `opscrew provision` to deploy.
    - **The Workers deploy failure message** (`workflow/cloudflare-workers.ts`) names `opscrew rollback --to $PREVIOUS`, not `opscrew promote … --version`. Snapshots are updated.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: medium

- [x] T1918 [US4] GitHub Pages: the running run is one that published, found by T1917, in `packages/connectors/github/src/**` and `packages/agents/src/{rollback,status,promote}/**` (+ tests)
  - Owns: those paths
  - Depends: T1917
  - Accept:
    - **After `--resume` without `--deploy`,** a run whose publish job was skipped (C, pushed while paused) is no longer taken for the running run. The connector gains one method that lists a run attempt's jobs with their conclusions (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs`, Actions: Read). Without a pause, the running run is the newest whose job "Publish on GitHub Pages" (the template's name, imported, not copied) succeeded, and the default target is the run with the highest id below the running one's whose publish job succeeded (D4). The walk asks newest first and stops once it has both: normally two or three calls. Runs it found skipped are marked so in `--list`. A run below the default target that nobody checked may be picked with `--to`: re-running it publishes its commit.
    - **`promote/site.ts`'s `rollBackPages`** takes the running run from the same marks, so it no longer refuses `--to <C>` while paused as "the run that GitHub Pages serves now", and refuses `--to <A>`, the pinned run.
    - Tests with T1917's scenario: B is bad, A is rolled back to, C is pushed while paused, then `--resume` without `--deploy`. Status says A is running, B comes before it, and a rollback goes further back than A.
    - **From T1917's review: the pinned run never succeeds.** A's re-run waits for a reviewer who then rejects it, or it fails. Its latest attempt is then not `success`, so `pagesRuns` drops it and the marks are empty:
      - `rollback` refuses with the false "nothing to roll back to";
      - `--list` marks nothing as running;
      - status says "has not succeeded yet" with no next step.

      Instead, while a rollback pause names a run that isn't listed, `rollback` refuses saying the pinned run has not succeeded (it waits for a reviewer, or it failed), and offers `--to` (`--list` lists the runs) or `--resume`. Status gives the same next step, without "yet". Test it, and test status's "Running: nothing yet" line.
    - **Simplify, from the same review:** narrow the rollback pause once in `status/site.ts` and pass it to `pagesMarks`, which removes the dead `""` branch. Export `deploysOnTheirOwn` from `status/deploys.ts` and use it for `resume.ts`'s two copies of the localhost-without-runner check.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github --filter=@opscrew/agents`
  - Effort: high

- [x] T1919 [US6] `status` shows the deploys once provision ran, not only after `verify`, found by live run 1, in `packages/agents/src/status/**` (+ tests)
  - Owns: those paths
  - Depends: T1918 (same files; one implementer can do both)
  - Accept:
    - **The gap:** `componentStatusReport` prints the Deploys section only when `appDeployed(plan)`, and only `verify` sets `deployment.firstDeployAt`. A user who provisioned, merged and rolled back without ever running `verify` gets no "Running:" line and no "Paused since …" line, so a push that doesn't deploy has no explanation.
    - **The fix:** once provision has run for the environment, the Deploys section is printed whether or not `verify` ran. It reads GitHub, and reads the server only when the components were read. Before provision, nothing changes. With no deployed version yet, "Running: OpsCrew found no deployed version." stays.
    - **Test:** provisioned, never verified, rolled back. Status says which version runs and that deploys are paused.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

## Phase: Logins for Kafka, Redpanda and OpenSearch (US7, founder 2026-11-01; plan section 11, research R7 and R8)

- [x] T1920 [US7] The logins in the plan schema and the catalog, in `packages/plan-schema/src/**` and `packages/iac-templates/src/**` (+ tests, snapshots)
  - Owns: those paths
  - Reads: plan section 11, research R8 (the exact settings, commands and health checks the spike ran)
  - Accept:
    - **The option:** `kafka`'s options gain `login` (default `false`). `redpanda` gets options `{ login }`.
    - **OpenSearch** runs its security plugin as R8 ran it:
      - a `PASSWORD` secret;
      - no `DISABLE_SECURITY_PLUGIN`;
      - the `keytool` keystore made in the container when it is missing;
      - `internal_users.yml` written from `hash.sh` with `admin` and `reserved: false`;
      - the health check with `curl -u`;
      - `address` `http://admin:<password>@<host>:9200`.
    - **Kafka with `login`:**
      - the `CLIENT` listener (`SASL_PLAINTEXT`), and the loopback `PLAINTEXT://localhost:9094` advertised;
      - SCRAM-SHA-512, and the listener's JAAS entry;
      - `SASL_PASSWORD`;
      - the background `kafka-configs.sh` loop, then `exec /etc/kafka/docker/run`;
      - the health check on the user's SCRAM entry.
    - **Redpanda with `login`:**
      - the three loopback flags;
      - `RPK_USER`, `RPK_PASS` and `RPK_SASL_MECHANISM`;
      - the `login()` loop: `create || update`, then `superusers`, `enable_sasl` and `admin_api_require_auth`;
      - the health check: `ready` plus `admin_api_require_auth`.
    - **Without `login`:** Kafka and Redpanda render exactly as before.
    - **Secrets and Compose:** Kafka and Redpanda always carry a `PASSWORD` secret. Every `$` in Compose is `$$`.
    - **The app's variables:** with `login`, `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME` (`app`), `KAFKA_SASL_PASSWORD` and `KAFKA_SECURITY_PROTOCOL` are added.
    - **One exported helper, `serviceAuth(service)`:**
      - `internal-only` for Kafka and Redpanda without `login`;
      - the entry's own `auth` for everything else.
      - The runbook's no-login lines use it.
    - **Tests:** rendered Compose for each case, and the snapshots. Every password appears only by reference.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [x] T1921 [US7] Design, secure and the private network follow the service's login, in `packages/agents/src/**`, `packages/secops/src/**`, `packages/detect/src/**` and `examples/kafka-app/**` (+ tests)
  - Owns: those paths
  - Depends: T1920
  - Accept:
    - **Every reader of `spec.auth`** goes through `serviceAuth`: design's `noLoginLine` and `plan.ts`, `secure/services.ts`, `secure/portainer.ts`, and `secops/src/hardening/services.ts`. A Kafka with `login` is no longer "has no login".
    - **Devices:** these three still get no device access. The refusal says their one login is the app's.
    - **Design's default:** a new Kafka or Redpanda service gets `login: true` when the analysis found the app reading `KAFKA_SASL_USERNAME` and `KAFKA_SASL_PASSWORD`. Otherwise design's line says it has no login, how to set `login: true` in `opscrew/plan.yaml`, and that the app's client must then send SCRAM-SHA-512 with those variables.
    - **`examples/kafka-app`** sends SASL when `KAFKA_SASL_USERNAME` is set.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops --filter=@opscrew/detect`
  - Effort: high

- [x] T1922 [US7] The Docker pass checks the logins, in `packages/cli/test/e2e/**`
  - Owns: that path
  - Depends: T1920
  - Accept:
    - **`engines.test.ts`, OpenSearch:** 401 without the login and 200 with it, where the check used to be "answers without a login". The image facts it checks change to `keytool` and `hash.sh`.
    - **Kafka and Redpanda with `login`,** rendered and started as the deploy starts them:
      - a client without the login is refused (Kafka's only times out, so time-box it);
      - one with the app's variables produces and consumes;
      - Redpanda's admin API refuses a change from another container.
    - **SC-1906's four cases** for each of the three: a first start, a restart, a recreated container, and the login turned on over data written without one.
    - **Gating and cleanup:** gated by `OPSCREW_DOCKER_TESTS=1`, like the rest of the Docker pass; each Compose project is removed with its volumes.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && OPSCREW_DOCKER_TESTS=1 OPSCREW_DOCKER_ENGINES=opensearch,kafka,redpanda pnpm --filter opscrew exec vitest run test/e2e/engines.test.ts` (or the file the brokers' check lives in)
  - Effort: high

- [x] T1923 [US7] The guide and the plugin say it, in `docs/guide/**` and `plugin/**`
  - Owns: those paths
  - Depends: T1921
  - Accept:
    - **Pages:** `search-and-analytics.md`, the message-broker page and `split-placement.md`'s "Services with no login" describe the logins:
      - OpenSearch's login is in `OPENSEARCH_URL`;
      - Kafka's and Redpanda's `login: true` and the four variables, with a kafkajs example;
      - a Kafka client without the login only times out;
      - OpsCrew makes the password once, and changing it isn't a command;
      - once on, Redpanda's login stays on: Redpanda keeps it in its data. The page gives the `rpk` commands that turn it off by hand (`enable_sasl` and `admin_api_require_auth` false, logged in as `app`).
    - **Upgrades:** the next provision of an app with OpenSearch turns its login on.
    - **Scope:** the plugin's skills change only where they say these services have no login.
  - Verify: `node plugin/validate.mjs && pnpm lint`
  - Effort: medium

## Phase: The simplify pass (T1915's findings; three reviewers by area, 2026-11-01)

Each task keeps behaviour, apart from the bugs it names. Exported names used outside a task's Owns keep their signatures unless the task says otherwise; report any other change instead of making it.

- [x] T1924 Simplify the workflow templates and runbooks, in `packages/iac-templates/src/{workflow,runbook,runtime}/**` (+ tests, snapshots), not `runbook/network.ts`
  - Owns: those paths, plus `packages/iac-templates/src/index.ts` for its own exports
  - Accept:
    - **One command builder:** the runbook's `opscrew(plan, command, environments?)` (`runbook/shared.ts`) moves next to `appFlag` in `workflow/shared.ts`. It builds `provisionCommand`, `pause.ts`'s `rollbackCommand`, the Workers failure message and `switch.ts`'s `failedLogs` flags, and no second builder is added. `DISPATCH_WITH_DIGEST` and `DISPATCH_FOR_ROLLBACK` come from one builder.
    - **One `refuse(condition, message)`** in `workflow/shared.ts` for the `if …; then echo "::error::…"; exit 1; fi` blocks of `provenanceCheck` (`jobs.ts`), `cloudflare-workers.ts`'s `buildRunCheck`, and `CHECK_IMAGE`.
    - **The pause conditions and the deploy jobs' conditions come from one source:**
      - `pausedJob(plan, exempt?)` builds `!(exempt) && paused`, and a matching `unpaused(plan, exempt?)` serves the deploy jobs. This applies in `jobs.ts`, `github-pages.ts` and `cloudflare-workers.ts`.
      - `deployJob` uses one expression for both cases.
      - `labelJob` always carries its `if:`.
      - Snapshots change; behaviour doesn't. The job-graph tests prove it.
    - **`verifyJob`** uses `ROLLBACK_INPUTS` for the input names.
    - **One `fixForward(plan)`** in `runbook/shared.ts` serves both runbooks. `rollbackSection` uses `promoted(plan)`.
    - **Dead paths:** every catalog entry has a secret now, so `runtime/components.ts` `serviceEnvironment`'s inline path for servers and `workflow/index.ts` `envFileServices`' filter go.
    - **Two switch-script quirks:**
      - A re-run of the same image that fails shows its own lines, not the earlier run's kept ones.
      - A start-script failure after the switch that is neither the health check nor a worker is kept as `failed=start`, not `failed=check`.
      - Test both.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [x] T1925 Simplify rollback, promote, status and the shared deploy code, in `packages/agents/src/{rollback,promote,status,shared,logs}/**`, `packages/agents/src/localhost/apply.ts`, `packages/agents/src/localhost/plan.ts` and `packages/connectors/github/src/**` (+ tests)
  - Owns: those paths
  - Accept:
    - **Bug, the reviewer in the approval:** `rollback/server.ts` reads the GitHub environment's reviewers through `secretsEnvironment(plan)`, which is `undefined` for a prod-only app. Its deploy job runs in `production`, so the approval wrongly says nothing gates the deploy. Use `promote/site.ts`'s `reviewedEnvironment`, exported. One `guardText` serves all three copies of "GitHub also asks a required reviewer…" (`promote/run.ts`, `promote/site.ts`, `rollback/server.ts`). Test it with a prod-only app whose `production` has a reviewer.
    - **Bug, the local runner's rollback skips `requireApplied`:** this computer's local runner rolls back without it, because drift there counts stopped containers as pending, and a broken app has them. A workflow-only variant of the check covers it.
    - **One approval flow:** `promote/site.ts`'s `approve(run, …)` is exported, takes `Pick<SiteRun, "deps" | "approveHash" | "target" | "what">`, and serves `rollback/server.ts` and `rollback/local.ts`.
    - **One switch for this computer:** `localhost/apply.ts` gains `switchTo(…)` (switch, health check, switch back, outcome). `applyLocal` and `rollback/local.ts` both use it, and the helpers it hides are no longer exported.
    - **One `appImageOf(deps, plan, github)`** in `promote/image.ts` replaces the four builders of the app's GHCR image. They are in `rollback/server.ts` `versionsContext`, `rollback/local.ts` `pinnedImage`, `status/deploys.ts` `appImage` and `promote/run.ts`.
    - **A Worker rollback reads Cloudflare once:** `rollBackWorker` takes `known?` as `rollBackPages` does.
    - **The pending files:**
      - `readPendingPromotion` and `writePendingPromotion` lose their dead `file` parameter;
      - rollback's pending file keeps its own reader and writer;
      - `rollback/record.ts` reads `rollback.json` with `deploy-pause.ts`'s exported schema, and `status/deploys.ts` uses `readRollback`.
    - **One `auditFinishedRun(deps, run)`** in `shared/deploy-run.ts` (three copies).
    - **The deploy run:** `shared/deploy-run.ts` exports a classifier of `dispatchAndFollow`'s errors, so `rollback/server.ts` stops wrapping the API to tell them apart. `dispatchAndFollow` returns the run's `headSha`, and `rollback/resume.ts` drops its extra `getWorkflowRun`. `githubRepository` is typed so `rollbackRepository` needs no cast.
    - **One of each:**
      - one "Nothing was changed." constant;
      - one `commitWords(commit, message)` and one `shortImage(ref)`, next to `shortDigest` (`server.ts` `shortText`, `status/deploys.ts` `versionWords`, `versions.ts` `versionText`, `resume.ts`, `logs/failed.ts`, `rollback/local.ts`);
      - `messageOf` exported and used by `resume.ts`;
      - `waitForDeploys` polling through `runningDeploy`;
      - `pushesDeploy` exported, replacing `rollback/local.ts`'s `deploysFromBranch`;
      - one function each for "the run pinned … has not succeeded" (`status/site.ts`, `rollback/site.ts`) and for the refusal while a move's window pauses deploys (`rollback/server.ts`, `promote/shared.ts`).
    - **One running image:** `status/deploys.ts`'s `appImageIn`, `localhost/plan.ts`'s `runningImage` and `rollback/local.ts`'s `localImages` become one, and `runningImage` takes the file name.
    - **Status's GitHub notes:** status's two "GitHub can't be read" lines become one.
    - **`rollback --list` names each left-out image and why:** `RollbackResult.leftOut` carries `LeftOutVersion[]`.
    - **Dead exports and types:**
      - `waitAfterPause` export;
      - `ImageRollbackParts` and `imageRollbackHash` re-exports;
      - `VersionsImage`;
      - the generic on `previousWorkerVersion`;
      - `list.running as string`, since `chooseVersion` returns the digest.
    - **The GitHub connector's unused additions go:**
      - `listWorkflowRuns`' `event` filter, with its test;
      - `WorkflowRun.event` and `headBranch`;
      - `WorkflowRunSource.status` and `conclusion`. The fixtures keep those in a local type.
    - **Tests:**
      - `YES_KINDS`, `failure()`, `gitRemote()` and `planHash` move into `rollback/__fixtures__/versions.ts`;
      - `rollback/run.test.ts`'s duplicate "changes only the rolled-back environment's key" test goes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T1926 Simplify provision, design and the login checks, in `packages/agents/src/{provision,design,secure,vpn,retarget,drift,serverless}/**`, `packages/agents/src/localhost/provision.ts`, `packages/iac-templates/src/catalog/**` and `packages/iac-templates/src/runbook/network.ts` (+ tests)
  - Owns: those paths, plus `packages/iac-templates/src/index.ts` for the catalog's exports
  - Accept:
    - **`ServiceSpec.auth` and `serviceAuth` go:**
      - nothing but `serviceAuth` read `auth`, and every caller only asks whether a service has a login;
      - export `hasLogin` and use `!hasLogin(service)` in `runbook/network.ts`, `vpn/grants.ts`, `secure/services.ts`, `secure/portainer.ts`, `design/placement.ts` and `design/plan.ts`;
      - the catalog's `auth: …` lines and their test go.
    - **One `reportPausedMerge(deps, plan, github)`** in `provision/steps.ts` serves the four `pausedMergeNote` callers. `provision/run.ts` builds its `--resume` command inside the `throw` only.
    - **Dead paths:** every catalog entry has a secret, so the `secrets.length > 0` paths in `provision/secrets.ts`, `drift/servers.ts` and `drift/host.ts` go.
    - **Feature numbers:** user-facing messages no longer name feature numbers, which users don't know and which go stale (`retarget/start.ts` and `design/moves.ts` say "feature 022"). Tests follow.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: high

- [x] T1927 Simplify the CLI, the MCP server, the plugin and the test harnesses, in `packages/cli/**`, `packages/mcp-server/**`, `plugin/**` and `packages/agents/src/testing/**` (+ tests)
  - Owns: those paths, plus one re-export of `pinnedText` in `packages/agents/src/rollback/index.ts` and `packages/agents/src/logs/failed.test.ts`'s use of the new test helper
  - Accept:
    - **Bug, `rollback --list` cuts a site's pinned version short:** `rollback.ts`'s `pauseLine` prints `shortDigest` of a Worker version id or a Pages run id. Build the line from the agents' `pinnedText`. (Lead, during the task: the "to deploy forward again" wording for environments where pushes don't deploy is dropped; it needed a new export or a plan read, and the resume wording is right either way.)
    - **The CLI's rollback and promote result lines** no longer repeat what the agents' reporters already print.
    - **The live harnesses:**
      - `AppEnvironments.removeGithubLeftovers` clears each environment's deploy pause, and the four copies in `rollback`, `cloudflare-hosting`, `github-pages` and `split` go;
      - `mergeChange` splits into merge and wait, and `rollback.test.ts`'s `mergeEdit` goes;
      - `builder-checks.ts` and `split-checks.ts` use `support.ts`'s `SERVER_DEPLOY_JOB`;
      - `deployRunProblem` loses `deployJobFailed` and `FAILED_CONCLUSIONS`, which are dead;
      - `"Publish on GitHub Pages"` comes from `PAGES_PUBLISH_JOB`;
      - `generatesValues` loses its secrets check, which is always true.
    - **The Docker tests:** `cli/test/e2e/{docker,portainer-redeploy}.test.ts` fill the Portainer stack with `fillPortainerStack`.
    - **One test helper** in `@opscrew/agents/testing`, for example `keptFilesRemote(files, fallback?)`. It replaces the three copies of the fake that reads the kept files (cli `logs.test.ts`, mcp-server `logs.test.ts`, agents `logs/failed.test.ts`).
    - **The plugin:** the deploy skill's "Rolling back" keeps one or two lines and points to the troubleshoot skill's section.
    - **The MCP server:** `opscrew_promote` says "use rollback instead" in its description only.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: high

- [x] T1914 The live runs (lead): T1913's pass, then `docs/e2e-coverage.md` updated per run. Findings become tasks. After T1920–T1922, 013's live passes `kafka-app` (with `login: true`) and `meili-search` with OpenSearch run again on Hetzner.

- [x] T1915 The simplify pass (lead): `/simplify` (or reviewers) over the whole feature's diff; real findings become tasks. Done 2026-11-01 by three reviewers by area: their findings and the known items below are T1924–T1927. Known items from T1902's review: one `appEnvFlags(plan)` in `workflow/shared.ts` for `switch.ts`'s `failedLogs` and `provisionCommand`; a re-run of the same image may show the earlier run's kept lines (the `check` keep is skipped when `about` names the image), and a start-script failure after the switch that is neither the health check nor a worker is kept as `failed=check`. From T1909: `status/deploys.ts` reads `rollback.json` with its own small schema, which `rollback/record.ts`'s reader should replace; the two lines that say GitHub can't be read could be one. From T1905: `cli/test/e2e/{docker,portainer-redeploy}.test.ts` fill the Portainer stack by hand; `fillPortainerStack` would do it. From T1909's review: `status/deploys.ts`'s `appImageIn` repeats `localhost/plan.ts`'s `runningImage`. So does `rollback/local.ts`'s `localImages` (a third copy): let `runningImage` take the file name. From T1905's review: `workflow/pause.ts`'s `rollbackCommand` copies `provisionCommand`'s flags (one `opscrewCommand(plan, verb)` with T1902's `appEnvFlags`); `DISPATCH_WITH_DIGEST` and `DISPATCH_FOR_ROLLBACK` could come from one builder. From T1908: an exported classifier of `dispatchAndFollow`'s errors in `shared/deploy-run.ts` (`rollback/server.ts` wraps the API to tell them apart); `deploy-pause.ts` exporting its schema for `rollback/record.ts`; `githubRepository` typed so `rollbackRepository` needs no cast; `status/deploys.ts` using `record.ts`'s `readRollback`. `dispatchAndFollow` returning the run's `headSha` (the connector's `waitForWorkflowRun` returns it, `promote/__fixtures__/world.ts` too), so `rollback/resume.ts` drops its extra `getWorkflowRun`. From T1911: `rollback --list` shows only a count of left-out images, since `RollbackResult.leftOut` is a number; carrying `listVersions`'s `LeftOutVersion[]` would let it name each one and why. The CLI's rollback and promote result lines repeat what the agents' reporters already print. From T1910: this computer's local runner rolls back without `requireApplied` (drift there counts stopped containers as pending, which a broken app has); a workflow-only variant of the check would cover it. From T1913: the live rollback pass's own `mergeEdit` repeats `mergeChange`'s first half; splitting `mergeChange` into merge and wait in the harness would remove it. `builder-checks.ts` and `split-checks.ts` each define their own `DEPLOY_JOB`; `support.ts` now exports `SERVER_DEPLOY_JOB`. From T1917: the Workers failure message builds `opscrew rollback` with its flags inline, a third copy next to `provisionCommand` and `rollbackCommand` (the `opscrewCommand(plan, verb)` item). From T1920's review: every catalog entry now has a secret, so `spec.secrets.length > 0` is always true. The inline-environment path for servers in `runtime/components.ts` `serviceEnvironment`, `workflow/index.ts` `envFileServices`' filter, and the copies in `provision/secrets.ts`, `drift/servers.ts`, `drift/host.ts` and `cli/test/live/support.ts` can go. The lead's own: user-facing messages name feature numbers, which users don't know and which go stale (`retarget/start.ts` and `design/moves.ts` say "feature 022", now 023); drop the numbers.

- [x] T1916 The release (lead): `docs/releasing.md`, from the changelog to the plugin bump and the docs site sync.
  - The changelog says every deploy workflow changes. Before the first rollback, each environment needs `opscrew provision` and its merged pull request. It also says that the next provision of an app with OpenSearch turns on its login, and `OPENSEARCH_URL` changes.

## Phase: The database on a rollback (US8, founder 2026-11-06; plan section 12, research R9, ADR 0028)

Shipped with 023's release (T2319). The rules above hold. Additionally:
- **No leaks:** none of these may appear in an output, log line printed by the workflow, audit
  entry, approval text, committed file or fixture:
  - a database password;
  - a dumped value;
  - a line of `snapshot.log`, `release.log` or a status command's output.

  Passwords reach a dump or restore only inside its container (env or a file there), never in a
  process's arguments.
- **The server files** are plan.md 12.3's, exactly: names, modes, formats. They are the contract
  between T1933, T1934 and T1935.
- **Unchanged without the feature:** with `deploy.snapshots: false` and no `app.migrations`, a
  deploy's and a rollback's scripts behave as before, though their text changes.
- **Approvals:** a rollback that keeps the data stays the `promote`-kind approval of before. One
  that restores or migrates down also needs `allowDestroy` and the typed name. No new approval
  kind, and no change in `@opscrew/contracts`.

- [x] T1930 The plan's snapshot and migration fields in `packages/plan-schema/src/**` (+ tests, regenerated JSON schemas)
  - Owns: `packages/plan-schema/**`
  - Reads: plan.md 12.1, research R9 "Down migrations per tool"
  - Accept:
    - `deploy.snapshots` (optional boolean) and `deploy.keepSnapshots` (1–10, default 3) on `DeploySettingsSchema`.
    - `snapshotsOn(plan)` is exported and true only when:
      - the target is a cloud server, the user's own server or this computer;
      - the plan isn't a preview environment;
      - at least one PostgreSQL, MySQL, MariaDB or MongoDB service runs on the app's server;
      - `deploy.snapshots` is `true`, or absent on an environment other than prod.

      Tests cover each case.
    - `deploy.snapshots: true` is refused on a preview environment and on Portainer and site targets. The message says snapshots there come with a later release.
    - `app.migrations` is `{ tool, status, down }`, with `tool` from the exported `MIGRATION_TOOLS`. That table gives each of the eight tools its unit (`version`, `apps`, `count`, `each`) and `down`'s placeholders, as in plan.md 12.1. The refinement checks `down` against them, and requires `app.releaseCommand`.
    - JSON schemas regenerated.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema`
  - Effort: medium

- [x] T1932 [US8] Detect each down-migration tool's commands and keep them in the plan, in `packages/detect/src/release/**`, `packages/agents/src/design/{release,kept-edits}.ts` and the examples' `expected.json` (+ tests)
  - Owns: `packages/detect/src/release/**`, `packages/detect/src/detect.ts`, `packages/agents/src/design/release.ts`, `packages/agents/src/design/kept-edits.ts`, their tests, `examples/*/expected.json`
  - Reads: research R9's table, plan.md 12.1–12.2
  - Depends: T1930
  - Accept:
    - When release detection finds Rails, Django, Alembic, Flask-Migrate, Knex, Sequelize, TypeORM or Laravel, it also returns `migrations`. Its `status` and `down` commands match R9's table, with the release command's own folder prefix and options: the same `FLASK_APP`, the TypeORM data source, the Knex folder.
    - No other tool returns `migrations`. Prisma, Drizzle and the others of R9's "not offered" list are tested to return none.
    - Design writes `app.migrations` as it writes `releaseCommand`:
      - a user's own value is kept, and design names what analyze found when it differs;
      - it is removed when the release command goes.

      Tests cover all three.
    - The examples using these tools (`django-postgres`, `fastapi-sqlmodel`, `koa-knex`, `nestjs-typeorm`, `laravel-app`, and any other) have it in `expected.json`, and the detect fixtures pass.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect --filter=@opscrew/agents`
  - Effort: high

- [x] T1933 [US8] The snapshot before each release and the rollback's database step, in `packages/iac-templates/src/workflow/{switch,snapshots}.ts` (+ tests)
  - Owns: `packages/iac-templates/src/workflow/switch.ts`, `packages/iac-templates/src/workflow/snapshots.ts`, `packages/iac-templates/src/workflow/migrations.ts` (only the stub below), their tests and fixtures, the workflow snapshot fixtures that change
  - Reads: plan.md 12.3–12.4 and D10–D12, research R9's dump and restore table, `switch.ts`'s `switchApp`, `recreate` path and `keepFailed`, `agents/src/retarget/sides/postgres.ts` (the commands to reuse in shell form)
  - Depends: T1930
  - Accept:
    - **The snapshot**, at deploy, in `snapshots.ts` and called from `switchCommands`:
      - plan.md 12.4's step: the four databases, their dump commands, the files and modes of 12.3;
      - the disk check, partials and rotation;
      - no password in any argument;
      - a failed dump's `::error::` (FR-1922) and the low-disk `::warning::`.
    - **The rollback's database step** in `MODE` `rollback`:
      - the approval file's check and its one use;
      - the hold, the stop, and the dump of the current database;
      - the exact restore of each database;
      - the `recreate` switch and the resume;
      - the failure path, which puts the current database back, starts the running version again and leaves `.env` unchanged.

      No approval file, or a mismatched or expired one, means today's rollback.
    - **The stub `migrations.ts`** exports what T1935 fills in:
      - `migrationRecord(plan): string[]` (empty for now);
      - `migrationDown(plan): string[]` (a script fragment that exits non-zero with "Down migrations aren't available for this app.").

      `switchCommands` calls `migrationRecord` after the release command, and the database step calls `migrationDown` for `migrations`.
    - **Tests:**
      - The scripts run under `sh` with shims for every path: snapshot taken, skipped (first deploy, same image, low disk) and failed; restore succeeded and failed; approval file missing, mismatched, expired and used.
      - With snapshots off, a deploy's and a rollback's behaviour is unchanged.
      - `OPSCREW_DOCKER_TESTS=1`: for each of the four pinned images, a dump while rows are written, then an exact restore. The table or collection created after the snapshot is gone, and the rows equal the snapshot's.
    - The leak check covers every password the scripts handle.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, and the Docker test with `OPSCREW_DOCKER_TESTS=1` (its output in the report)
  - Effort: xhigh

- [x] T1934 [US8] The rollback's database choice, approval and one-time approval file, in `packages/agents/src/rollback/**` and `packages/cli/src/commands/rollback.ts` (+ tests)
  - Owns: `packages/agents/src/rollback/**`, `packages/cli/src/commands/rollback.ts`, `packages/cli/src/commands/rollback.test.ts`, `packages/cli/src/ui/rollback*.ts` if it exists
  - Reads: plan.md 12.3 and 12.5, FR-1924–FR-1926 and FR-1930, `agents/src/logs/failed.ts` (how a server's files are read, with `sudo` on own servers), `agents/src/rollback/{server,local,record,versions}.ts`, `agents/src/promote/site.ts` `approve`
  - Depends: T1930
  - Accept:
    - After the version is chosen, the command reads the target's snapshot (`taken`) and both migration records with a fixed read-only script, through the access `logs --failed` uses, or locally on this computer.
    - **The choice** offers the snapshot, down migrations and keep, by plan.md 12.5's rules, with its defaults and words. `--database snapshot|migrations|keep` chooses in a script. A choice not offered is refused with its reason, ending "Nothing was changed.".
    - **The approval:**
      - the hash covers the choice, the snapshot's `taken` and both records;
      - the text says what is lost;
      - a choice that changes data needs `allowDestroy` and the typed name `destroy --env` asks for (`--confirm <name>`);
      - `--yes` grants neither.
    - **The approval file:**
      - after approval and before the dispatch, the command writes `.rollback-database` (30 minutes) through the same access;
      - it removes the file when the dispatch or the run fails before its start step;
      - the result says what happened to the database, and `rollback.json` records `database`.
    - **Other targets:**
      - Portainer offers only keep, with the "comes later" line;
      - a site or preview refuses `--database snapshot|migrations`;
      - a database on another server, or the app's own files, are named as kept.
    - **Tests:**
      - every offer and refusal, the defaults on prod and staging;
      - the hash changing with the choice;
      - the typed confirmation, and the file written and removed;
      - the leak check (no address, password or record line in the output).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew`
  - Effort: xhigh

- [x] T1935 [US8] Down migrations for the eight tools: the record at deploy and the down step, in `packages/iac-templates/src/workflow/migrations.ts` (+ tests, Docker tests)
  - Owns: `packages/iac-templates/src/workflow/migrations.ts` and its tests, Docker test files and fixtures for it (under `packages/iac-templates/src/workflow/__fixtures__/migrations/` or `packages/cli/test/e2e/migrations*.ts`)
  - Reads: plan.md 12.3–12.4, research R9's table, T1933's `switch.ts` and `snapshots.ts`
  - Depends: T1933, T1932
  - Accept:
    - `migrationRecord(plan)` runs `app.migrations.status` in the new image after the release command, and writes `.schema/<hex>` in 12.3's format for each tool's unit. It keeps 20 records, and a failure only warns.
    - `migrationDown(plan)` runs the down command by unit in the running image:
      - `{version}` from the earlier record;
      - `n = count(current) − count(earlier)` runs, or Laravel's `--step=n`;
      - Django per app, `zero` included, in reverse order.

      Every value is checked against `^[A-Za-z0-9_.:-]+$`. A count that grew going back, or a missing record, exits non-zero before any change.
    - **Tests:** under `sh` with shims for each unit.
    - **Docker** (`OPSCREW_DOCKER_TESTS=1`): for each of the eight tools, a real app with two migrations:
      - the release command, then the record from the tool's real output;
      - the down to the first migration's state, checked in the database;
      - the examples where one exists, and small fixtures for Rails, Sequelize and Flask-Migrate.

      A tool whose real output differs from R9 is fixed here and reported.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, and the Docker tests with `OPSCREW_DOCKER_TESTS=1` (their output in the report)
  - Effort: xhigh

- [x] T1936 [US8] The guide and the plugin's skill: `docs/guide/{rollback,when-a-deploy-fails,environments,databases}.md`, `plugin/skills/opscrew-deploy/SKILL.md`
  - Owns: those files
  - Reads: plan.md 12.6, spec US8, the merged T1932–T1934 for the exact words and flags
  - Depends: T1934
  - Accept:
    - `rollback.md` gains "The database": the three choices, their defaults per environment, `--database` and `--confirm`, what each loses, the snapshots' disk use and `deploy.keepSnapshots`, and the eight tools. Its "The database stays as it is" becomes the keep choice.
    - It says what isn't covered yet and comes later: Portainer, the app's own files, a database on another server.
    - The other pages link to it. The skill says when to suggest each choice.
    - Written for users, no task IDs.
  - Verify: `pnpm lint`
  - Effort: medium

- [x] T1937 [US8] The live pass's database steps, in `packages/cli/test/live/rollback.test.ts` (+ its support files)
  - Owns: `packages/cli/test/live/rollback*.ts`, `docs/e2e.md` (its rollback section)
  - Reads: plan.md 12.7, SC-1907 and SC-1909, the existing rollback pass
  - Depends: T1933, T1934, T1935
  - Accept:
    - A staging environment with `koa-knex`. v1 is deployed and rows written. v2, whose migration adds a column, is deployed and more rows written.
    - The snapshot rollback, timed from approval (SC-1907): the column is gone, and the rows are those of the moment v2 was deployed.
    - `--resume --deploy` to v2, then the down-migration rollback: the column is gone and the rows stay.
    - A hand-made dispatch with no approval file changes no data (SC-1909).
    - The leak search covers the outputs, workflow logs and audit entries.
    - Gated as the rollback pass is, and its steps documented in `docs/e2e.md`.
  - Verify: `pnpm turbo run typecheck --filter=opscrew`; the live pass itself is T1938's
  - Effort: high

### The simplify pass's findings (T1938; two reviewers by side, 2026-11-06)

- [x] T1939 One owner of the server contract and the database kinds, and the scripts' simplifications, in `packages/plan-schema/src/**`, `packages/iac-templates/src/{index.ts,shared.ts,workflow/**,previews/**}`, `packages/agents/src/{rollback,destroy}/**` and `packages/agents/src/design/release.ts` (+ tests)
  - Owns: those paths, except `workflow/__fixtures__/sh.ts` (T1940)
  - Reads: the two simplify reviews' findings as listed here; plan.md 12.3–12.4
  - Accept:
    - **The server contract has one owner, `@opscrew/iac-templates`:**
      - `agents/src/rollback/database.ts` imports `ROLLBACK_APPROVAL_FILE`, `snapshotTakenPath`, `schemaRecordPath` and `rollbackApprovalLine` and deletes its own copies;
      - `rollbackApprovalLine` returns no trailing newline, and its writers add one;
      - iac-templates' own `DatabaseChoice` goes (the choice is typed `"snapshot" | "migrations"` inline);
      - `SNAPSHOTS_DIR`, `SNAPSHOT_LOG`, `SCHEMA_DIR` and `DatabaseChoice` leave the package root.
    - **One list of the four database kinds:**
      - plan-schema's `SNAPSHOT_KINDS` becomes an `as const` list named `DATABASE_KINDS`, with `snapshotDatabases(plan)` (the app server's services of those kinds) beside it;
      - `snapshotsOn`, the rollback's `unreadReason` and iac-templates' `snapshots.ts` use them;
      - `DATABASES` is typed by the kind, so the impossible `throw` goes;
      - `design/release.ts` and `destroy/checks.ts` import the list instead of their own.
    - **One preview guard:**
      - `switchCommands` renders the snapshot step and the migration record only when the database step applies;
      - `o.preview` is folded into `databaseRollback(plan, o)`;
      - the dead `environment.previews` check, the template's `snapshots: false` override and `migrationRecord`'s options parameter go (and with it the type import from `switch.ts`).
    - **Dead script parts and branches:**
      - `rollbackCommands` renders only `snapshot_run` and `snapshot_restore`;
      - `migrationDown(plan, migrations)` loses its branch for a plan without migrations, and that branch's test.
    - **Shared message helpers:** `printfFormat`, the release log's name and one `serverLogNote(plan, log)` in `shared.ts`, replacing the three copies of "stays on the server in …".
    - **Smaller:**
      - `record.ts`'s hash without conditional spreads (`canonicalJson` drops undefined members; the hash bytes stay the same);
      - `serverFolder`'s one-caller `run` inlined;
      - the "30 minutes" text from `APPROVAL_SECONDS`;
      - the tautological `MIGRATION_TOOLS` test goes;
      - `database.test.ts`'s duplicates of `run.test.ts`'s scenarios go;
      - `hexOf` instead of `.slice("sha256:".length)`;
      - comments longer than their code shortened to one line pointing at plan.md 12.4.
    - **No behaviour change:** every rendered script's behaviour and every approval hash stay the same, so the snapshot fixtures change only where text was dead or duplicated. Say which fixtures changed and why.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: high

- [ ] T1940 Shared shell-test helpers, in `packages/iac-templates/src/workflow/__fixtures__/sh.ts` and the tests that use them (+ a shared Docker skip reason)
  - Owns: `packages/iac-templates/src/workflow/__fixtures__/sh.ts`, `packages/iac-templates/src/workflow/{snapshots,migrations,switch,rollback}.test.ts`, the iac-templates Docker tests' skip reasons
  - Depends: T1939
  - Accept:
    - `shWorks`, `write`, `fakeBin(work, { name: script })`, `runSh(script, args, env)` and the fake docker's compose prologue live once in `__fixtures__/sh.ts`;
    - the follow-up's unit tests use them;
    - the Docker tests share one `skipReason`.
    - No test is dropped, and none changes what it checks.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: medium

- [x] T1941 The detect tests in one home, and the small leftovers, in `packages/detect/src/release/*.test.ts`, `packages/agents/src/design/{kept-edits,strategy}.ts` and `packages/cli/src/commands/rollback.ts`
  - Owns: those files (+ their tests)
  - Accept:
    - **The detect tests:** the "tools without down migrations" `it.each` block and the two positive cases (Rails, Alembic) that `migrations.test.ts` repeats from the per-tool files have one home (the per-tool files keep theirs; `migrations.test.ts` keeps what only it checks).
    - **The design files:** `kept-edits.ts`'s second migrations block joins the field loop if that stays readable, and its comments past 100 characters and `strategy.ts`'s broken doc comment are rewrapped.
    - **The CLI:** `rollback.ts`'s one-use `CheckedFlags` is inlined.
    - No behaviour change.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect --filter=@opscrew/agents --filter=opscrew`
  - Effort: medium

### Several databases and several heads (founder, 2026-11-06)

- [ ] T1942 Down migrations for a Rails app with several databases, in `packages/iac-templates/src/workflow/migrations.ts` (+ tests, the Docker test)
  - Owns: `packages/iac-templates/src/workflow/migrations.ts`, `migrations.test.ts`, `migrations.docker.test.ts` and its fixtures
  - Reads: research R9 ("Several databases or heads", the real outputs), plan.md 12.4
  - Why:
    - Rails 8 can keep Solid Cache, Queue and Cable in databases of their own.
    - `bin/rails db:version` then prints one `database: <name>` / `Current version: <v>` pair per database.
    - Today the record refuses that, so such an app gets no down migrations.
  - Accept:
    - **The record:** with several databases it writes one `database=<name> <version>` line per database (12.3's format gains that line kind); one database keeps `version=<v>`.
    - **The down step:** per database in the current record, in reverse order, runs the plan's `down` with `db:migrate` turned into `db:migrate:<name>` (`bin/rails db:migrate:<name> VERSION=<v>`, `VERSION=0` for a database the earlier record lacks). A `down` without `db:migrate ` in it exits non-zero before any change.
    - Every value is checked as today.
    - **Tests:** shim tests for the record and the down step. The Docker test gains a Rails fixture with two databases (PostgreSQL primary and a second database), proving each goes down to its first migration's schema.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`, and the Docker test with `OPSCREW_DOCKER_TESTS=1` (its output in the report)
  - Effort: high

- [x] T1943 Alembic projects with several heads deploy with `alembic upgrade heads`, in `packages/detect/src/release/python.ts` (+ tests)
  - Owns: `packages/detect/src/release/python.ts`, `python.test.ts`, `migrations.test.ts` (its Alembic cases)
  - Why:
    - A project whose migrations have several heads cannot deploy with OpsCrew's detected `alembic upgrade head` (or `flask db upgrade`): Alembic refuses "Multiple head revisions are present".
    - Several heads come from several `version_locations` bases or `branch_labels`, used on purpose by modular codebases, or from two branches' migrations not merged yet.
  - Accept:
    - **Detection:** detection reads the migration files' `revision` and `down_revision` (a tuple counts as a merge). When more than one revision is nobody's parent, the release command is `alembic upgrade heads` (`flask db upgrade heads`), the analysis gets a note, and no `migrations` is returned.
    - **The note's words:** plain, for example: "This app's Alembic migrations have several heads (branches of migrations), so OpsCrew runs `alembic upgrade heads`. Down migrations aren't offered for it yet: a rollback can restore a snapshot or keep the database."
    - **One head:** keeps `upgrade head` and its `migrations`.
    - **Tests:** one head, two heads, and a merge revision joining two heads (one head again). Check with a real Alembic container, or Alembic's documentation and source if no container fits, that `upgrade heads` and `flask db upgrade heads` are the right commands, and say which in the report.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect`
  - Effort: medium

- [ ] T1938 The live runs and the simplify pass (lead): T1937's pass until it passes, `docs/e2e-coverage.md` per run, then `/simplify` over the follow-up's diff. It ships in 023's release (T2319).
