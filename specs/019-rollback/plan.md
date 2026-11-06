# Implementation Plan: Rollback

**Branch**: `main` | **Date**: 2026-10-31 | **Spec**: `specs/019-rollback/spec.md`
**Research**: `specs/019-rollback/research.md` (R1–R5; the spikes of T1901 go into R6)

## Summary

`opscrew rollback` puts an environment back on an earlier image of its own, by digest. It runs no build and no release command, and uses the same switch a deploy uses. Then it pauses that environment's automatic deploys until `--resume`.

**The rollback** (US1, US3)
- **The workflow.** Every server environment's deploy workflow takes a rollback dispatch, branch-following ones included. The inputs are `digest`, `tag` and `rollback`.
  - Such a run skips the build and checks the image's provenance again in `verify`.
  - Its start step runs the same switch with the release command turned off.
- **The CLI.**
  - It lists the environment's versions from GHCR's tags and the deploy workflow's runs.
  - It picks the version before the running one, or the one `--to` names.
  - It checks provenance, CPU and services as `promote` does.
  - It asks for a `promote`-kind approval bound to a hash of the environment, the current digest, the target digest and the plan.
  - Then it pauses deploys, waits until no deploy runs, dispatches the workflow and follows the run.

**The pause** (US2)
- The pause reuses 018's repository variable `OPSCREW_DEPLOY_PAUSED`, with entries of reason `rollback` beside `move`.
- Every deploy workflow now carries the job-level `if:`. Today it is rendered only while a move is planned.
- A small `paused` job says in the run's summary why the deploy was skipped.
- `opscrew rollback --resume [--deploy]` removes the entry. With `--deploy` it also starts the workflow on the branch.

**Every target** (US4)
- **Portainer:** the same dispatch. The deploy job writes the stack with the target image, and its `release` service turned off.
- **This computer:** the switch to `.env.previous`'s image, locally, while Docker still has it.
- **Cloudflare's hosting and GitHub Pages:** the rollbacks `promote --version` does today, reached through `opscrew rollback`, with the pause.
- **Promoted environments:** their existing dispatch, plus `rollback: true`.

**Recovery** (US5)
- The switch keeps a failed copy's last lines in `.failed-deploy/` in the app's folder, and `opscrew logs --failed` shows them.
- The worker hint and the release-failure message say what to do.

**In Claude Code** (US6)
- `status` and `opscrew_status` show the running version, the one before it and the pause.
- The troubleshoot skill suggests the terminal command, with the database caveat.

## Technical Context

- **Stack:** the same as 000–018. **No new dependency.**
- **GitHub and GHCR:**
  - **The registry's tag list:** the OCI distribution API `GET /v2/<name>/tags/list`, through `GhcrReader`, with a classic `read:packages` token (`OPSCREW_GHCR_READ_TOKEN`): S2 found that a fine-grained token and gh's login token get 403, so a refusal without it names that variable. Paging follows GHCR's relative `Link` header (S2).
  - **Fields GitHub already returns:** on workflow runs, `event`, `head_branch`, `head_commit`, `created_at` and `conclusion`. The contents API's file text gives the plan at a commit.
  - **Not the Packages REST API**, which retention uses inside the workflow. GitHub documents it for classic tokens. Whether a fine-grained token can read it, or GHCR's tag list, is unconfirmed (S2).
  - **The Variables permission** is now needed for every rollback, not only for the check and a move. The token permission text changes.
- **Tests:**
  - unit tests with fakes: GitHub, GHCR, Cloudflare, drift and the servers;
  - the workflow's scripts run in bash against `rollback.test.ts`'s fake server, with its fake `docker` gaining `logs`;
  - YAML tests of each job graph case;
  - a gated live pass on Hetzner (T1913).
- **Spikes before wave 2** (T1901, on the throwaway repository):
  - **S1:** a `workflow_dispatch` with inputs on a branch other than the default (an environment following `develop`), with the workflow file only there, then on both branches.
  - **S2:** GHCR's `tags/list` paging (`n`, `last`, `Link`) with gh's token, a classic `read:packages` token and a fine-grained token, on a private package.
  - **S3:** the job graph on real runs:
    - a push;
    - a push while paused;
    - a dispatch with `rollback: "true"`;
    - a dispatch with no inputs;
    - whether `inputs.rollback` is usable in a job-level `if:` on a push (S3: yes, `inputs` is `{}`; never compare it with 'true', since a dispatch makes it a boolean);
    - `!cancelled()` with a skipped need.
  - **S4:** GitHub Pages: `github.run_attempt > 1` in a re-run's job `if:`, and whether a re-run reads `vars` again.
  - **S5:** whether `docker compose up -d` recreates the Portainer stack's `release` service when only its environment changes. This needs local Docker only.

## Constitution Check

- **I (safety gate):**
  - **A rollback is a `promote`-kind approval.** The contracts already describe that kind as "a promotion, or a rollback". It is bound to a hash of the environment's key, the current digest, the target digest and the plan's hash.
    - `--yes` never grants it. A script needs `--approve <hash>`, and without it nothing changes.
    - The pause is set under the same approval, which lists it.
  - **Resuming is a `github-settings` approval**, which `--yes` grants in a script.
  - **No infrastructure, host plan or DNS changes.** The servers change only through the deploy workflow's switch, as with a deploy, or through this computer's local executor under its lock.
  - **No new approval kind.**
  - **Audited:** the pause set, restored and cleared; the dispatch; the run's outcome; the local switch; a Worker activation and a Pages re-run.
- **II (user owns everything):**
  - The workflow's inputs and the pause variable are plain, documented and committed or visible in GitHub.
  - The runbook says how to roll back by hand: GitHub → Actions → Run workflow with `digest`, `tag` and `rollback`, plus the variable. A user without OpsCrew can still do it.
  - `.failed-deploy/` holds plain files.
- **III (dual engine):** no HCL changes.
- **IV (secrets):**
  - The pause entry holds only a digest and commits.
  - Commit messages and log lines go through the redactor.
  - The failed copy's lines stay on the server: 0600, the deploy user's, as `release.log`. `logs --failed` masks them like every line.
- **V (deterministic):** no model anywhere.
- **VI (contracts first):**
  - No change in `@opscrew/contracts` or `plan-schema`.
  - The connector's additions are additive.
  - ADR 0023 records the dispatch, the pause and D1 (lead, with T1901).
- **VIII (typed adapters):** GitHub through its connector, and Cloudflare through `promote/site.ts`'s client.
- **IX (plain language):** before the switch, the rollback says:
  - that the data, the schema and the secrets stay as they are;
  - that the release command doesn't run;
  - how each target goes back. Pages rebuilds, and GitHub allows a re-run for 30 days.
- **X (simplicity):**
  - one workflow per environment, as today;
  - one variable, shared with 018;
  - promote's path reused;
  - no new dependency.

## Project Structure

```text
packages/iac-templates/src/
  workflow/switch.ts               $2 = rollback skips the release; .failed-deploy; messages (T1902)
  workflow/{shared,jobs,build,index}.ts    inputs, verify for branch envs, job graph, pause condition and job, MODE (T1905)
  workflow/{portainer,cloudflare-workers,github-pages}.ts   the same for Portainer and the sites (T1905)
  portainer-target/stack.ts        the release placeholder (T1905)
  runbook/{shared,site}.ts         "Roll back" (T1912)
packages/connectors/github/src/    tag list, run fields, file text, token permission text (T1903)
packages/agents/src/
  shared/deploy-pause.ts           the variable: read, set, restore, clear by reason, runs in progress (T1904, from move/deploys.ts)
  shared/deploy-run.ts             dispatch and follow, the reviewer wait (T1904, from promote/run.ts)
  promote/**                       uses both; refuses while paused; requireApplied's branch; site rollbacks exported; D1 (T1904)
  move/{deploys,window,index}.ts, provision/run.ts   the move's pause on the shared module; refusals; the note (T1904)
  rollback/{versions,types}.ts     versions, marks, the default, --to, describeImage, the old plan (T1906)
  rollback/{index,run,server,resume,record}.ts      the command (T1908)
  rollback/{local,site}.ts         this computer, Cloudflare's hosting and GitHub Pages (T1910)
  logs/**                          --failed (T1907)
  status/{deploys,run,site}.ts     running, before, pause (T1909)
packages/cli/src/commands/{rollback,index,logs}.ts, deps.ts   (T1911, T1907)
packages/mcp-server/src/tools/{status,logs}.ts                (T1909, T1907)
plugin/skills/opscrew-{troubleshoot,deploy}/SKILL.md          (T1911)
docs/guide/rollback.md (new) and the pages of 8.              (T1912)
packages/cli/test/live/rollback.test.ts (+ support), docs/e2e.md, docs/e2e-coverage.md   (T1913)
docs/adr/0023-rollback-and-deploy-pause.md                    (lead)
```

## Design

### 1. The rollback dispatch (T1902, T1905)

**Triggers** (`workflow/shared.ts` `workflowStart`):
- **A branch-following server or Portainer environment:** `workflow_dispatch` gains three optional inputs.
  - `digest` (string, default `""`);
  - `tag` (string, default `""`);
  - `rollback` (boolean, default `false`).

  Each is described as "for a rollback; `opscrew rollback` fills it in". A run started by hand without them builds and deploys as today.
- **A promoted environment:** `DISPATCH_WITH_DIGEST` gains `rollback` (boolean, default `false`). `promote` passes nothing.

**Jobs.** `<key>` is `checkEnvironmentKey(plan)`, as in 018's condition. `PAUSED` stands for `contains(vars.OPSCREW_DEPLOY_PAUSED, '"<key>"')`.

| Job | Branch-following `if:` | `needs` | Promoted |
|---|---|---|---|
| `paused` (new) | `!inputs.rollback && PAUSED` | — | same |
| `build` | `!inputs.rollback` | — | none |
| `verify` | `inputs.rollback` | — | always, as today |
| `deploy` | `!cancelled() && (needs.build.result == 'success' \|\| needs.verify.result == 'success') && (inputs.rollback \|\| !PAUSED)` | `[build, verify]` | `inputs.rollback \|\| !PAUSED`, needs `verify` |
| `sign` | unchanged | `build`: skipped on a rollback, since `build` is | none |
| `tag`, `prune` | `!cancelled() && needs.build.result == 'success' && needs.deploy.result == 'success'` (S3: without it they are skipped on every push, since `deploy` now needs the skipped `verify`) | `build`, `deploy` | none |
| `label` | `!cancelled() && needs.deploy.result == 'success'` | `[build, verify, deploy]` | unchanged |

- **Image outputs:** `imageJob` and `imageOutput` (shared.ts) become `imageJobs(plan)`. For a branch-following environment the output is `${{ needs.build.outputs.image || needs.verify.outputs.image }}`, and the same for `tag`.
- **`verifyJob`** (jobs.ts) is rendered for branch-following environments too, with `BUILD_BRANCH` set to `cicd.branch`.
  - Its texts name `opscrew rollback` beside `opscrew promote`.
  - It accepts `workflow_dispatch` builds too (D1).
- **`build`** (`build.ts` `buildJob`) gains its `if:`.
- **`job()`** renders `permissions: {}` for an empty list, so the `paused` job holds no permission.

**The start step** (`workflow/index.ts` `startStep`):
- `env: MODE: ${{ inputs.rollback && 'rollback' || 'deploy' }}`, and `${reach.sh} -s -- "$IMAGE" "$MODE"`.
- On a rollback, the step summary says: "Rolled back to `<image>` (built from `<commit>`): no build, no release command."
- In mode `rollback`, `rollbackStep`'s "restored" message reads: "The rollback failed: the earlier version did not pass its checks, so OpsCrew put back the version that ran before the rollback."

**How `switchCommands` skips the release:** a second positional argument. It is not a `SKIP_RELEASE` variable and not a separate script.
- Environment variables don't cross `ssh … sh -s`, but positional arguments reach the script identically in three places:
  - over SSH;
  - in the runners' local `sh`;
  - in this computer's executor (`set -- <image> rollback`).
- A second script would duplicate the switch and drift from it.
- The script starts with `MODE="${2:-deploy}"`. The release block becomes `if [ "$MODE" = rollback ]; then echo "A rollback runs no release command: the data and the schema stay as they are."; else <today's block>; fi`.
- Everything else is the same as a deploy:
  - pull and the edge;
  - services and init;
  - the processes recorded, the switch, the workers;
  - the 30-second check.
- Provision's first deploy and `applyLocal` pass no `$2`, so their behaviour is unchanged.

**Labels and retention after a rollback:**
- **Labels:** `label` tags the target `opscrew-<env>` and the image it replaced `opscrew-<env>-previous`, from the deploy job's `previous` output (`.env.previous`), as after any deploy. After a rollback, `-previous` therefore names the image rolled back from. Two consequences:
  - retention keeps it;
  - `promote` from this environment promotes the rolled-back image, which is what the environment runs.
- **`prune` needs `build`,** so it never runs on a rollback.
- **While paused:**
  - push runs build and sign;
  - `deploy`, `tag`, `prune` and `label` are skipped.

  Images built meanwhile count toward `keep` at the next forward deploy. That deploy protects the pinned image as its `previous`.
- **The default target** is not simply `-previous` (3.).

**The scheduled check:** unchanged.
- A rollback is a deploy through the same switch: the check isn't paused (unlike a move's window), and it never reads `OPSCREW_DEPLOY_PAUSED`.
- A rolling switch serves throughout. With `deploy.strategy: recreate`, a check that falls inside the switch can fail once, as during any deploy.

**Who can start it:** anyone with write access can dispatch the workflow with inputs, as with promote today.
- `verify` checks the provenance, and the cosign signature with `supplyChain.sign`. So only images this repository's branch built can deploy.
- OpsCrew's approval guards against mistakes, as promote's approval says.

### 2. The command and its agent (T1904, T1908, T1911)

```
opscrew rollback [--to <commit|digest|version>] [--list] [--resume [--deploy] [--yes]]
                 [--approve <hash>] [--allow-old-secrets <names>] [--app <key>] [--env <name>]
```
- `packages/cli/src/commands/rollback.ts`, registered after `promote` in `commands/index.ts`, with services from `servicesOf(ctx).rollback`.
- **Flags:**
  - `--list` is read-only and stands alone.
  - `--yes` works only with `--resume`. Otherwise it is refused, as promote words it: no flag grants a rollback.
  - `--deploy` works only with `--resume`.
  - `--allow-old-secrets` applies on Cloudflare's hosting only, as `promote --version`.
- **Exit codes:**
  - 0: rolled back, listed, resumed, or waiting for a reviewer;
  - 1: refused, or not approved;
  - 2: error.

**The agent, `packages/agents/src/rollback/`:**
- `index.ts`: `rollback(deps, options)` and its types;
- `run.ts`: the checks and the routing by target;
- `server.ts`: the dispatch path for servers, promoted environments and Portainer;
- `local.ts`, `site.ts`: 5.;
- `resume.ts`: 4.;
- `record.ts`: `imageRollbackHash`, `rollback.json`, `pending-rollback.json`;
- `versions.ts`, `types.ts`: 3.

**The server path.** Every refusal comes before any change and ends "Nothing was changed."
1. **The plan.** Refuse when:
   - it isn't provisioned (`hasDeployment`) or is destroyed;
   - a `retarget` is in progress;
   - a move is in progress (`plan.move`, or a `move` entry in the variable).
2. **GitHub** (promote's `githubRepository`). A pending rollback is checked first, from `pending-rollback.json`, as promote's `checkPending` does.
3. **`requireApplied`, on the branch the workflow runs on** (`workflowBranch`).
   - Drift's pending changes refuse (FR-1907, "a provision pending").
   - The workflow there must be the one the plan generates. This also catches a workflow from before 019, with the hint to run provision and merge its pull request.
4. **A run of the workflow queued or in progress refuses**, naming its link (FR-1907).
5. **The versions** (3.):
   - the current one is `opscrew-<env>`; the target is the default or `--to`, and must differ from the current one;
   - provenance: `checkProvenance` with `[env]` for a branch-following environment, with the app's environments for a promoted one;
   - CPU: `checkPlatform`;
   - services:
     - **A promoted environment:** `requireRollbackServices` with `promotion.json`, as today.
     - **A branch-following environment:** the plan file at the target's commit (`fileText` of `planFilePath`), parsed.
       - Enabled services it has that today's plan lacks refuse (spec edge case).
       - Workers, cron jobs and variables added since are listed in the approval, since they run with the earlier image too.
       - An unreadable old plan is "not checked", as promote's `unchecked`.
6. **The approval** (`promote` kind). Title: `Roll <env> back to <short commit> (sha256:<12>)`. Details:
   - `Now: <short commit> "<message>", built <time> (sha256:<12>)`, and `Back to:` the same;
   - "The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.";
   - what was added since (step 5);
   - "Deploy: <workflow> on <branch>, given the digest; nothing is rebuilt. Afterwards <env>'s deploys pause until `opscrew rollback --resume`.";
   - the signature line, the reviewer line and the hash.

   Handling of the answer:
   - an `--approve` mismatch gives `PLAN_NOT_APPROVED`;
   - no approval gives `PlanRefusedError`, with `opscrew rollback --env <env> --to <full digest> --approve <hash>`.
7. **The run:**
   - set the pause, keeping the entry it replaces (4.);
   - `waitForDeploys`, for runs created just before the pause;
   - `dispatchAndFollow` with `{ digest, tag, rollback: "true" }` on the workflow branch.
8. **The outcome:**
   - **Success:** `rollback.json` is written, plus `promotion.json` for a promoted environment. The output says deploys are paused and how to resume.
   - **Waiting for a reviewer:** `pending-rollback.json` is written, with the replaced pause entry. The status is `waiting`.
   - **Failure, cancellation, or a definite refusal of the dispatch:** the pause entry is restored to what it was, and the command fails with `COMMAND_FAILED`, naming the run. The message says the automatic switch back returned the environment to the version it ran.

**What to share, and what to move into `shared/` (T1904):**
- **Move to `agents/src/shared/deploy-pause.ts`** (from `move/deploys.ts`):
  - the variable's schema, with reasons `move | rollback` and optional `image`, `commit`, `from`;
  - read, set (returning the replaced entry), restore and clear-by-reason;
  - `runningDeploy` and `waitForDeploys`.

  `move/deploys.ts` keeps `withDeploysPaused` and `resumeDeploys` on top of it, and they clear only `move`.
- **Move to `agents/src/shared/deploy-run.ts`** (promote's step 5):
  - the dispatch and its audit once accepted;
  - the "definite refusal" versus "may have started" errors;
  - following the run and the wait for a reviewer.

  Used by promote, by rollback and by `--resume --deploy`.
- **Stay in promote, imported by rollback:**
  - `checkProvenance`, `checkPlatform`, `imageFactsOf`, `imageReference`, `AppImage` (`promote/image.ts`);
  - `githubRepository` and `requireApplied`, which gains the branch; promote passes the default branch (`promote/shared.ts`);
  - `requireRollbackServices` and `readPromotion`/`writePromotion`, exported;
  - the pending helpers, which take the file's name;
  - `rollBackWorker` and `rollBackPages` (`promote/site.ts`), exported with the command and the version flag their messages name, and a `beforeChange` hook for the pause.
- **`chooseImage` stays promote's.** The rollback chooses from its own list.
- **`promote` refuses while its target is paused,** before the approval, with the hint `opscrew rollback --env <env> --resume`. Otherwise its run would skip the deploy and promote would record an image that never ran.

### 3. Versions from GHCR (T1903, T1906)

**What exists:**
- The connector reads one tag's digest (`taggedDigest`) and one image's provenance and CPUs (`imageFacts`). It lists no package versions.
- Retention lists versions inside the workflow, through the Packages REST API with the job's token (`retention.ts`).

**The list, in three reads:**
1. **The workflow's runs, in one call:** `listWorkflowRuns` for the builder's workflow and branch, `perPage: 100`, newest first. The builder is the environment itself, or `builderCicd` for a promoted environment. Each run now carries `event`, `headBranch`, `headCommit.message`, `createdAt` and `conclusion`.
2. **GHCR's tags:** `imageTags`, paged, with one pull token.
3. **Per candidate:** each run, newest first, whose commit has this environment's tag (`environmentTag(sha, env)`, or the builder's form for a promoted environment), at most 20. Each gets:
   - `describeTags` (digest and facts with one pull token);
   - then `checkProvenance` and `checkPlatform`.

   A candidate that fails is left out. The list says how many were left out, and why. `--to` refuses it, with its reason.

**`Version` fields:**
- `digest`, `image`, `tag`, `commit`;
- `message`: the first line, redacted;
- `builtAt`: the build run's `created_at`;
- `runUrl`;
- `buildSucceeded`: the build run's conclusion was success;
- `marks`.

**Marks:**
- **`running`:** the digest `opscrew-<env>` names.
- **`previous`,** the default target: `opscrew-<env>-previous` when it is in the list and was built before the running one. That is the case after any forward deploy, where it is the deployment before.
  - Otherwise, after a rollback, `-previous` is the newer image rolled back from. The default is then the newest listed version built before the running one whose build run succeeded.
  - None gives the "only one version" refusal (FR-1907).
  - A missing `opscrew-<env>` label refuses, saying OpsCrew can't tell what runs.

**`--to`:**
- It accepts a commit (a unique prefix of 7 to 40 hex digits), a digest (`sha256:` plus 64 hex digits) or a digest prefix of 12 or more.
- **Not in the list:** refused, naming the oldest version still there and listing the newest five (US1 #4, US3 #3).
- **The running one:** refused, "it runs already".
- **Ambiguous:** refused, listing the matches.

**`describeImage(image, digest)`** gives the commit, message and build time from provenance and its run. Status uses it.

This computer and the sites have their own lists (5.).

### 4. The deploy pause (T1904, T1905, T1908)

**The variable** is 018's `OPSCREW_DEPLOY_PAUSED`: JSON `{ "<app>/<env>": entry }`.
- **A move's entry:** `{ reason: "move", since }`, unchanged.
- **A rollback's entry:** `{ reason: "rollback", since, image: "sha256:…", commit, from }`, where `from` is the commit rolled back from.
- It holds no secret.

**The workflow** (T1905): the condition is rendered always, in every target's deploy workflow:
- servers;
- Portainer;
- this computer's local runner;
- Cloudflare's hosting;
- GitHub Pages.

GitHub reads `vars` when the run is created; 018's live run recorded this in `docs/e2e-coverage.md`. Exemptions:
- **A rollback dispatch** (`inputs.rollback`): it must deploy while paused, for a rollback of a rollback.
- **GitHub Pages: a re-run** (`github.run_attempt > 1`), since a re-run is how Pages rolls back (S4). A re-run started by hand in GitHub deploys too, and the guide says so.

**The `paused` job:**
- It runs on GitHub-hosted runners with no permission.
- It reads the entry with `jq`, from `env: PAUSED: ${{ vars.OPSCREW_DEPLOY_PAUSED }}`.
- It writes a `::notice::` and the step summary:
  - **Rollback:** "Deploys of <key> are paused since <since>: `opscrew rollback` pinned it to <commit> (sha256:<12>). This run built <sha> but didn't deploy it. `opscrew rollback --resume --deploy` deploys the branch's latest commit."
  - **Move:** "…while a service moves between the app's servers; `opscrew provision` resumes them."
- Push runs still build while paused. A fix shows that it builds, and `--to` can deploy it while staying paused.

**Where it is recorded locally:**
- **`rollback.json`** in the environment's state folder, beside `promotion.json`. It holds the last rollback (digest, commit, from, run, at, hash), with the record it replaced as `previous`.
  - GitHub's variable is the truth.
  - The file is what `status` falls back to when GitHub can't be read, and what `local.ts` uses (5.).
- **`pending-rollback.json`** while a run waits for a reviewer. It holds the pause entry it replaced, to restore it if the run fails.

**The order that closes the race** GitHub's create-time read leaves:
1. Refuse when a run is in progress.
2. Set the entry.
3. `waitForDeploys`, for runs created before the entry.
4. Dispatch.

A push after step 2 skips its deploy job.

**What `status` reads:** the entry, and the server's `.env`; `rollback.json` as the fallback.
- "Deploys: paused since <since> by `opscrew rollback`, pinned to <commit> (sha256:<12>). Resume: `opscrew rollback --resume` (add --deploy to deploy <branch>'s latest commit now)."
- "Paused for a move's window."
- When the server's image differs from the pinned one: "the rollback's run hasn't finished".

**`--resume`:**
- **Not paused:** it says so, and exits 0.
- **A move's entry:** refused; the window holds it, and `opscrew provision` ends it.
- **Otherwise:** a `github-settings` approval, "Resume the deploys of <key>", which `--yes` grants in a script. Then the rollback entry is cleared, and audited.
- **`--deploy`:**
  - **A branch-following environment:** the approval adds "and start <workflow> on <branch> now: it builds <sha> "<message>" and deploys it, with its release command". Then `dispatchAndFollow` runs with no inputs.
  - **A promoted environment:** refused, with the hint "run `opscrew promote --to <env>`".
  - **This computer without the local runner:** nothing deploys it automatically, so `--resume` only clears the entry.

**Together with a move's pause.** There is one entry per environment, so:
- a rollback refuses while a `move` entry exists or `plan.move` is set;
- provision refuses to start a move's window while a `rollback` entry exists, with "run `opscrew rollback --resume` first";
- `--resume` never clears a move's entry, and the move's `resumeDeploys` clears only `move`;
- promote refuses while paused for either reason;
- provision says that its pull request deploys only after `opscrew rollback --resume --deploy` when the environment is paused by a rollback.

### 5. Each target (T1905, T1908, T1910)

- **Servers OpsCrew created, and the user's own servers:** the server path (2.).
- **Portainer:**
  - The same dispatch and jobs: `renderPortainerWorkflow` uses the same `imageSourceJob`, `deployJob` and `afterDeployJobs`.
  - The deploy job writes the stack with the target image to the deploy branch.
  - Portainer redeploys, and the job waits for `/opscrew-version`. It writes the previous tree back on failure, as a deploy does.
  - **The release:** the stack runs it as the one-off service `release` that the app waits for (`portainer-target/stack.ts`). So:
    - its environment gains `OPSCREW_RELEASE: "__OPSCREW_RELEASE__"`;
    - its command is wrapped: `if [ "$$OPSCREW_RELEASE" = skip ]; then exit 0; fi; <cmd>`;
    - `writeScript` substitutes `skip` on a rollback and `run` otherwise;
    - the commit message is "Roll back to $IMAGE".
  - Unsure: whether Compose recreates `release` when only its environment changes. It is expected by the config hash; S5 checks it.
- **This computer** (`rollback/local.ts`), under `withLocalLock`:
  - It reads `.env` and `.env.previous` in the app's folder (`runningImage`). It refuses when:
    - there is no previous version;
    - the previous image is the same one;
    - `rollback.json` says the previous version is the one this computer rolled back from ("this computer keeps only the version before; deploy forward with `opscrew provision`").
  - `docker image inspect` finds no such image: refused, naming it (US4 #2).
  - The approval is `promote` kind, bound to `imageRollbackHash` of the environment, the current reference, the target reference and the plan hash.
  - Then:
    - `cp .env .env.previous`;
    - `switchCommands` with `set -- <image> rollback`, through `withRegistryLogin` for a GHCR image;
    - the HTTPS health check through 127.0.0.1;
    - `rollbackCommands` on failure, as `applyLocal` does.

    `apply.ts` exports `healthCheck`, `withRegistryLogin` and `outputTail`.
  - The pause applies only when the local runner deploys the environment from its branch.
- **Cloudflare's hosting** (`rollback/site.ts`):
  - The default target is `runningVersions(...).before`. `--to` takes a version id. `--list` comes from the Worker's versions and deployments.
  - It delegates to `rollBackWorker`, keeping the secrets-changed check and `--allow-old-secrets` (US4 #3).
  - Before the approval it says "Cloudflare serves that Worker version at 100% within a minute; nothing is rebuilt".
  - The pause is set before the activation, and restored if it fails.
- **GitHub Pages:**
  - The default target is `pagesRuns[1]`. `--to` takes a run id or a commit.
  - It delegates to `rollBackPages`. First it says "GitHub re-runs that run: it builds the site again from <commit>, and a base image or a dependency may have changed since; GitHub re-runs a run for up to 30 days" (US4 #4).
  - The pause is set before the re-run, which the `run_attempt` exemption lets deploy.
- **Promoted environments:**
  - The server path, with the workflow's existing inputs plus `rollback`.
  - Services are checked with `promotion.json`.
  - A success writes `promotion.json` too, so a later promote or rollback checks against what runs (US4 #5).
  - `promote --digest` and `promote --version` keep working.

### 6. Recovery gaps (T1902, T1907)

**The failed copy's last lines** (FR-1910, FR-1911):
- **Where:** `$APPS_DIR/<app>/.failed-deploy/`.
  - `/srv/apps/<app>/.failed-deploy/` on a server;
  - under `OPSCREW_APPS_DIR` on this computer.

  The folder is 0700 and the files 0600, written by the deploy user (umask 077), as `release.log` is.
- **`about`:** `image=`, `time=` (UTC), and `failed=`, one of `health`, `process <name>` or `check`.
- **`<service>.log`:** `docker logs --timestamps --tail 500 <container>`, both streams.
- **`keep_failed <service> <container> <why>`,** at the top of `switchCommands` and `rollbackCommands`, called:
  - in `switchApp`, before `docker rm -f "$new"` (a failed health check, both strategies);
  - in `startProcesses`, before `exit 1`, for the worker's container that stopped;
  - in `rollbackCommands`, for the app containers it replaces after the check from outside failed.
- A failure of another image clears the old files first. A successful deploy leaves them, and `logs --failed` shows their time.
- **Not covered:**
  - Portainer: OpsCrew has no shell there.
  - Services on extra servers (018): a deploy doesn't replace them with a copy.

**`opscrew logs --failed [--service <name>]`** (T1907):
- It reads `about` and `<service>.log` through the access `logs` already uses (`logs/targets.ts`):
  - the deploy user's shell;
  - the own server's admin login, with `sudo -n` where it reads Docker that way;
  - this computer.

  Both are fixed `cat` commands, with the service checked against `isContainerName` and the plan's parts.
- The first line says: "Lines of the copy of <short digest> that failed its <health check | process | check from outside> at <time>; OpsCrew removed it. `opscrew logs` shows the version running now."
- The lines are parsed with `dockerLogLine` and masked as every line.
- **When there is nothing to show:**
  - none kept: it says so;
  - with `--follow` or `--since`: refused;
  - on Portainer and the sites: it says the target keeps none.
- MCP's `opscrew_logs` gains `failed`, read-only.

**Messages** (`workflow/switch.ts`):
- **`healthFailed`** adds "Its last lines are kept on the server: `opscrew logs --failed`."
- **`processFailed`,** the worker hint (FR-1911), replaces `docker compose logs %s` with: "its last lines, from before OpsCrew put the previous version back: `opscrew logs --failed --service %s`". It carries the app's `--app` and `--env` flags.
- **`releaseFailed`** (FR-1912): "…failed, so the new version was not started and the previous version keeps serving. Its output stays on the server in <release.log> (…not printed here; <runbook> has the SSH command). A migration that stopped partway may have applied some of its changes, and the previous version now runs with them: read release.log to see how far it got, then fix the migration and push again to deploy forward, or restore a backup taken before this deploy."

### 7. `status` and `opscrew_status` (T1909)

- **`status/deploys.ts`:** `deployStateReport(deps, plan, services)` gives `{ lines, deploys }`. `componentStatusReport` calls it after the components, on every target, as it calls `checkStateReport`.
- **Where each part is read:**
  - **Running and before, on servers:** over `serverShell(deps, plan, APP_SERVER)`, one fixed read: the `APP_IMAGE` of `<appDir>/.env` and `.env.previous`, and `.env`'s modification time, written at the switch ("since").
  - **This computer:** the same files in the app's folder.
  - **Portainer:** the labels `opscrew-<env>` and `-previous`.
  - **Commit, message and build time:** `describeImage`. Without GHCR access, the short digest only, with why.
  - **The pause:** read from GitHub; `rollback.json` as the fallback.
- **Lines on a server:**
  ```
  Deploys (read from the server and GitHub now):
    Running: 9e8d7c6 "Add invoices page" (sha256:12ab34cd56ef), since 2026-10-31 10:04 UTC
    Before it: 3f2a1c9 "Fix checkout total" (sha256:ab12cd34ef56)
    Paused since 2026-10-31 10:02 UTC by `opscrew rollback`: prod stays on 9e8d7c6. Run
    `opscrew rollback --resume` when the fix is pushed (add --deploy to deploy main's latest commit now).
  ```
  or `Deploys: on (each push to main deploys)`.
- **The sites:** their rollback command becomes `opscrew rollback --to <id>` (`status/site.ts`), plus the pause line.
- **MCP:** `opscrew_status` data gains `deploys: { running?, previous?, paused? }`, and its description says so. The CLI prints the report's lines as today.

### 8. The plugin and the guide (T1911, T1912)

- **`plugin/skills/opscrew-troubleshoot/SKILL.md`:** a section "A release that deploys fine but is wrong".
  - Read `opscrew_status`'s `deploys`.
  - When a recent release is the likely cause, first state the caveat:
    - the data and the schema stay as they are;
    - the release command doesn't run;
    - the earlier version must work with the newer schema;
    - a backup restore is a separate step.
  - Then ask the user to run `npx opscrew rollback` (`--list`, `--to`) in a terminal, and `--resume` after the fix. Never through a tool.
- **`plugin/skills/opscrew-deploy/SKILL.md`:** the day-2 bullets (the sites' rollback, and promotion's `digest`) point to `npx opscrew rollback` and the pause.
- **The guide (FR-1915):**
  - **New `docs/guide/rollback.md`:**
    - when to roll back, and when to fix forward;
    - `rollback`, `--list` and `--to`;
    - what the approval shows;
    - the database caveat and the add-then-remove rule (linking `when-a-deploy-fails.md#migrations-and-the-previous-version`);
    - the pause and `--resume [--deploy]`;
    - each target;
    - in a script;
    - when the rollback fails;
    - how far back (retention's `keep`);
    - by hand, without OpsCrew.
  - **`when-a-deploy-fails.md`:**
    - "The release is healthy, but wrong" rewritten around `opscrew rollback` (it links to the new page);
    - `logs --failed`;
    - the worker hint;
    - a migration that stopped halfway;
    - "Other targets";
    - the table's last row.
  - **Other pages:**
    - `environments.md`'s "Rolling back";
    - the rollback lines of `cloudflare-hosting.md`, `github-pages.md`, `portainer-target.md` and `localhost.md`;
    - `logs-and-status.md` (`--failed`, the Deploys section);
    - `when-deploys-run.md` (the pause);
    - `supply-chain.md` (provenance on a rollback; D1);
    - `index.md`;
    - the `promote --version` mentions in `own-server.md` and `security.md`.
  - **The runbook's "Roll back"** (`runbook/shared.ts`, `site.ts`): `opscrew rollback`, and by hand: GitHub → Actions → Run workflow with `digest`, `tag` and `rollback`.

### 9. The live test (T1913)

`packages/cli/test/live/rollback.test.ts` (+ `rollback-support.ts`), gated on `OPSCREW_E2E_ROLLBACK=1` and the Hetzner pass's variables.
- **Setup:**
  - `LiveRun` with `label: "rollback"`;
  - the default example, `nextjs-postgres`;
  - one server, about 30 minutes;
  - the test sets `app.releaseCommand: "echo opscrew-e2e-release"` in `opscrew/plan.yaml` before provision. No example has a release command.
- **Steps, each a test:**
  1. Provision and the first deploy (A); a change, deployed (B), with `mergeChange` and `deployMain`.
  2. **The rollback:**
     - `opscrew rollback` in a script: exit 1, and an approval naming A as the target and B as the current version.
     - Then `--to <A> --approve <hash>`, under load (`underLoad`).
     - It must show:
       - no failed request;
       - the time from approval to success recorded (SC-1901, under 3 minutes);
       - the server's `.env` is A;
       - `release.log`'s modification time unchanged;
       - no build job in the run;
       - `opscrew-prod` is A.
  3. `status`: running A, and paused.
  4. A push of C: the run's `deploy` job is skipped, the `paused` job's summary is there, and the server still runs A (SC-1902).
  5. `rollback --list`: C, B and A, newest first, with A running. `--to` with a commit that isn't there is refused, with nothing changed (SC-1903).
  6. `rollback --resume --deploy --yes`: C is live.
  7. A change whose image never answers (a final `CMD` that prints a marker and sleeps, appended to the Dockerfile):
     - the run fails;
     - the server runs C;
     - `logs --failed` shows the marker (SC-1904);
     - then the change is reverted.
  8. The leak check (SC-1905), then destroy.
- **The site passes:** the rollback steps of `cloudflare-hosting.test.ts` and `github-pages.test.ts` call `opscrew rollback`, and `--resume`.
- **"Not tested live":** Portainer, an own server, this computer, a promoted environment, and a run held for a reviewer.

### 10. Risks, and the spikes first

**Spikes, in order** (T1901): S3 first (the job graph everything rests on), then S1, S2, S4 and S5. Done 2026-10-31 (research R6). S1: a dispatch works on any branch where the workflow has run once; an environment with a version to roll back to always has, and a 404 means it never ran there, so the refusal says "push to <branch> once".

**Risks:**
- **Every deploy workflow changes once.** Until `opscrew provision` runs and its pull request is merged, `rollback` refuses: `requireApplied` names it. The changelog and the guide say "run provision once after upgrading".
- **A wrong `if:`** stops every deploy, or never pauses one. The YAML tests cover each case, then S3 and the live pass.
- **Races:**
  - A push between the start check and the pause: `waitForDeploys` covers it.
  - Our dispatch queued behind a run that started in between, then cancelled by a later pending run (GitHub keeps only the newest waiting run): it is reported as failed, with the pause restored.
- **A stale `opscrew-<env>` label** (its label job failed): the current version shown and hashed may be wrong, but the switch still goes to the target. Status reads `.env`. A possible hardening: a `from` input the start step checks.
- **The earlier image with today's settings:**
  - missing services are refused;
  - added workers, cron jobs and variables are listed;
  - schema incompatibility is undetectable, so the guide states the add-then-remove rule.
- **GHCR access** (S2): the list and the default need the registry, as promote does. `OPSCREW_GHCR_READ_TOKEN` is the documented way.
- **A token without Variables: write** refuses before any change, since the pause is set first.
- **Long pauses:** builds made while paused count toward `keep`. The pinned image is protected by its label.
- **SC-1901's 3 minutes** (2 until live run 1 took 2 min 30 s; its run took 68 s): the approval run's drift check (`requireApplied`) and the image list, a poll interval after the pause is set, then `verify`'s queue time, the pull (the server keeps old images, since nothing prunes them), the switch, the check from outside and `label`. The live run measures it and logs where the time goes.
- **SC-1604 (016) becomes 90 seconds:** a Workers rollback now sets the deploy pause and waits for running deploys before it activates the version. The Cloudflare hosting pass of 2026-11-01 took 1 min 10 s.
- **D1 changes promote's security check:** T1904 tests both ways, and the review checks it.
- **The Portainer release placeholder** changes every Portainer stack once (S5).

### 11. Logins for Kafka, Redpanda and OpenSearch (T1920–T1923; US7, research R7 and R8)

**The plan's option** (`plan-schema/src/components.ts`)
- `kafka`'s options gain `login: boolean`, default `false`.
- `redpanda` gets options of its own, `{ login }`, joining `KINDS_WITH_OPTIONS`.
- OpenSearch has no option: its login is always on.

**The catalog** (`iac-templates/src/catalog/entries.ts`), as R8's spike ran it:
- **OpenSearch:**
  - a `PASSWORD` secret, as Elasticsearch has;
  - no `DISABLE_SECURITY_PLUGIN`;
  - `plugins.security.allow_default_init_securityindex=true` and the two transport keystore paths;
  - a `bash -c` command that makes `node.p12` with `keytool` when it is missing, writes `internal_users.yml` from `hash.sh` (`admin`, `reserved: false`), then runs the image's entrypoint;
  - the health check logs in with `curl -u`;
  - `address` is `http://admin:<password>@<host>:9200`.
- **Kafka with `login`:**
  - the `CLIENT` listener mapped to `SASL_PLAINTEXT`, and `PLAINTEXT://localhost:9094` advertised;
  - `KAFKA_SASL_ENABLED_MECHANISMS=SCRAM-SHA-512`, and the listener's JAAS entry;
  - the password as `SASL_PASSWORD`, a name without `KAFKA_`;
  - the command loops `kafka-configs.sh` on 9094 in the background, then runs `exec /etc/kafka/docker/run`;
  - the health check asks for the user's SCRAM entry on 9094.
- **Redpanda with `login`:**
  - the three loopback flags;
  - `RPK_USER`, `RPK_PASS` and `RPK_SASL_MECHANISM`;
  - the `login()` loop (`create || update`, then `superusers`, `enable_sasl` and `admin_api_require_auth`), then `exec /entrypoint.sh redpanda start …`;
  - the health check is `ready` plus `admin_api_require_auth`.
- **Kafka and Redpanda without `login`:** they stay exactly as today.
- **Secrets:** Kafka and Redpanda always carry their `PASSWORD` secret. It is used only with `login`, which keeps `secrets` a plain list and the env file's shape stable. Every `$` in Compose is `$$`.
- **Login variables:** with `login`, the conventional variables add `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME` (`app`), `KAFKA_SASL_PASSWORD` and `KAFKA_SECURITY_PROTOCOL`.

**Where `auth` is read.** One helper, `serviceAuth(service)` in iac-templates, gives `internal-only` for Kafka and Redpanda without `login`, and `password` otherwise. Every reader R7's code map lists goes through it:
- design's `noLoginLine` and `plan.ts`;
- the network runbook;
- `secure`'s login checks;
- the secops service checks.

Device grants stay refused for these three (`vpn/grants.ts` and the plan schema), with a new reason: the service's one login is the app's.

**Design's default** (FR-1919)
- When the analysis found the app reading `KAFKA_SASL_USERNAME` and `KAFKA_SASL_PASSWORD`, a new Kafka or Redpanda service gets `login: true`.
- Otherwise design's line says the service has no login, how to set `login: true` in `opscrew/plan.yaml`, and what the client must send.

**The example** `examples/kafka-app` sends SASL when `KAFKA_SASL_USERNAME` is set, so the Docker pass and the guide's example use it.

**Tests**
- **Units:** the rendered Compose for each case, and snapshots.
- **The Docker pass** (`cli/test/e2e/engines.test.ts`, `OPSCREW_DOCKER_TESTS=1`): OpenSearch's checks change from "answers without a login" to 401 without it and 200 with it. Kafka and Redpanda with `login` are added. Each runs SC-1906's four cases: a first start, a restart, a recreated container, and the login turned on over data written without one.
- **The live passes** of 013's examples that use these services (`kafka-app`, and `meili-search` with OpenSearch) run again in T1914.

**Risks**
- **Every deployment with OpenSearch changes on its next provision.** Its `OPENSEARCH_URL` gains the login. The changelog says so.
- **The Kafka image's start scripts are not a public interface.** Its `/etc/kafka/docker/run` and its `configure` rule on `SASL_*` names are pinned by the image digest. The Docker pass catches a change at the next pin bump.
- **Changing Redpanda's password** needs the old one (R8). OpsCrew generates it once and has no command to change it, so this doesn't arise. The guide says it.

### 12. The database on a rollback (T1930–T1938; US8, FR-1921–FR-1930, research R9)

The founder's follow-up of 2026-11-06, shipped with 023. ADR 0028 records D7–D12.

**12.1 The plan** (`plan-schema`, T1930):
- **`deploy.snapshots?: boolean`.** Absent means the environment's default: on for every
  environment except prod and a preview environment. `snapshotsOn(plan)` resolves it and is
  exported. It is false on:
  - Portainer and site targets;
  - a preview environment;
  - a plan with none of the four databases on the app's server.

  `true` is refused on a preview environment and on Portainer and site targets, saying that
  snapshots there come in a later release (024).
- **`deploy.keepSnapshots`:** an integer from 1 to 10, default 3.
- **`app.migrations?: { tool, status, down }`.**
  - `tool` is one of `rails`, `django`, `alembic`, `flask-migrate`, `knex`, `sequelize`,
    `typeorm`, `laravel`.
  - `status` and `down` are command lines, run like the release command (same folder prefix, same
    `FLASK_APP`, TypeORM data source).
  - `down`'s placeholders by unit:
    - `{version}` for `rails`, `alembic` and `flask-migrate`;
    - `{app}` and `{name}` for `django`;
    - `{count}` for `laravel`;
    - none for `knex`, `sequelize` and `typeorm`, whose `down` undoes the newest migration and
      runs once per migration.
  - It requires `app.releaseCommand`.
  - `MIGRATION_TOOLS` (exported) gives each tool's unit and placeholders, and the refinement
    checks `down` against them.

**12.2 Detection** (`detect` and design, T1932): the release detection that finds one of the eight
tools also returns its `migrations` (R9's commands, with the release command's folder and
options). Design writes `app.migrations` like `releaseCommand`:
- it keeps the user's own;
- it names what analyze found when it differs;
- it removes it with the release command.

The Django, Alembic, Flask-Migrate, Knex, TypeORM and Laravel examples' `expected.json` gain it.

**12.3 The files on the server** (the contract between T1933, T1934 and T1935). In the app's
folder (`appFolder(plan)`; this computer's under its local roots), every file has mode 600 and
every folder 700:

```
.snapshots/<hex>/taken             ISO time, written last: the snapshot is complete
.snapshots/<hex>/<service>.dump    one per database: PostgreSQL `-Fc`; MySQL, MariaDB SQL; MongoDB archive
.snapshots/<hex>.partial/          a snapshot being written (removed by the next deploy)
.snapshots/snapshot.log            the last dump's or restore's output (may quote data: never printed)
.schema/<hex>                      the migration record: `version=<v>`, `count=<n>`, or `app=<app> <name>` lines
.rollback-database                 the one-time approval: `<hex> <snapshot|migrations> <expiry epoch>`
```

`<hex>` is the image digest's 64 hex characters. A snapshot filed under a version holds the
database as it was when that version stopped running.

**12.4 The start script** (`iac-templates/src/workflow/switch.ts` and a new `snapshots.ts`, T1933;
`migrations.ts`, T1935):
- **The snapshot** (`MODE` `deploy`, after the services' setup, before the release command, with
  or without a release command):
  - It runs when `snapshotsOn(plan)` and `.env` names an image other than `$1`. The first deploy
    has nothing to snapshot.
  - If the app folder's filesystem has less than 1 GiB or 10% free, before or after a dump, it
    warns (`::warning::`), removes the partial snapshot and goes on.
  - Each database is dumped by `docker compose run --rm --no-deps -T -v <folder>:/snapshot
    --entrypoint sh <service> -c '<dump>'`. That is the service's own pinned image and env file,
    reaching the running service by its name, with the commands of R9:
    - PostgreSQL: `PGPASSWORD` set inside the container from `POSTGRES_PASSWORD`;
    - MySQL and MariaDB: root, with `MYSQL_PWD` set inside the container;
    - MongoDB: a `--config` file written inside the container.

    No password is ever in an argument.
  - Then `taken` is written and `.partial` renamed. The newest `keepSnapshots` complete snapshots
    stay; older ones and stale partials go.
  - A dump that fails stops the deploy (FR-1922). Its message says that the previous version keeps
    serving, where the log is, and `deploy.snapshots: false`.
- **The record** (T1935; `MODE` `deploy`, after the release command succeeds, with
  `app.migrations`):
  - `docker compose run --rm --no-deps -T release sh -c '<status>'` runs in the new image;
  - its output is normalized per tool into `.schema/<new hex>`;
  - the newest 20 records stay;
  - a failure warns only.
- **The rollback's database step** (`MODE` `rollback`):
  - It runs only when `.rollback-database` names `$1`'s hex and hasn't expired. The script removes
    the file before anything else, so it is used once.
    - **An expired file naming `$1`'s hex fails closed** (T1934's review, 2026-11-06): it is
      removed, an `::error::` says the one-time approval to restore or migrate the database expired
      before the run started, that nothing was changed, and to run `opscrew rollback` again; the
      script exits non-zero before the pause, the stop or the switch. The user approved the switch
      and the database step under one hash, never the switch alone.
    - A file naming another hex is removed with a note, and the rollback keeps the data.
    - With no file, the rollback keeps the data, as today.
  - Then, in order:
    1. `kamal-proxy pause` as the `recreate` path does, with its EXIT trap;
    2. `docker compose stop` of the web, workers and cron;
    3. the current database dumped under the running version, as at a deploy, for each of the four
       databases on the app's server, whether or not `snapshotsOn` (D11);
    4. `snapshot`: each database restored, exactly (R9):
       - PostgreSQL: drop with `FORCE` and create from database `postgres`, then
         `pg_restore --no-owner --single-transaction`;
       - MySQL and MariaDB: drop and create, then load;
       - MongoDB: `dropDatabase`, then `mongorestore`.

       `migrations` (T1935): the down command runs in the running version's image (the `release`
       service while `.env` still names it):
       - `{version}` comes from the earlier version's record;
       - count tools run `n = count(current) − count(earlier)` times, or Laravel's `--step=n`;
       - Django runs one `migrate <app> <name>`, or `zero`, per app in the current record, in
         reverse order.

       Every value from a record is checked against `^[A-Za-z0-9_.:-]+$` before use.
    5. the switch to `$1` by the `recreate` path, whatever `deploy.strategy` says, and the
       resume.
  - When step 4 fails:
    - step 3's dump is restored, if there is one;
    - the running version's web, workers and cron start again;
    - requests resume;
    - the script exits non-zero with a message naming the log.

    The workflow's rollback step then finds `.env` unchanged and says so.
  - **When the earlier version then fails** (its health check, a worker, or the check from outside,
    so the switch back to the running version runs): the start script leaves a marker that this
    run changed the database (`.database.changed`, removed at the start of every run and when a
    deploy saves `.env.previous`). The marker is written before the pause, names the run's target
    and the version that served, and says whether step 4 began. Every such failure, a cancelled run
    included (the workflow's rollback step also runs on a cancel), ends in the workflow's rollback
    script (`rollbackCommands`). It checks the marker before its early exits, and only a marker of
    this run counts:
    - when step 4 began, it holds requests, stops the earlier version, restores step 3's dump,
      removes the marker, and starts the version that served before the run;
    - otherwise it only starts that version again.

    A failed put-back leaves the app stopped with a clear message, never a version on the wrong
    data. Too little disk for step 3's dump refuses the rollback before any change (T1933's
    review). Without a
    step 3 dump (a database the step can't dump, such as SQLite or one on another server, after
    down migrations), the message says the database stays as the step left it, and that the next
    deploy's release command migrates it up again.
- **Unchanged:** with snapshots off and no approval file, a deploy and a rollback run exactly as
  before. Every server workflow's text changes once; the changelog says to run `opscrew provision`.

**12.5 The command** (`agents/src/rollback/**` and the CLI's `rollback`, T1934):
- **Reading the server:** after choosing the version, the command reads the snapshot list, each
  `taken`, and the two records. It uses a fixed read-only script over the access `opscrew logs`
  uses, or locally on this computer.
  - **When this computer can't reach the server** (no address or login for it here, or no
    answer), the rollback offers only keep and says why in one line: the snapshot and down
    migrations need this computer to reach the server (the computer that deployed it, or one
    restored from the recovery copy). It then runs exactly as before this follow-up, through
    GitHub alone. An explicit `--database snapshot|migrations` is refused before any change.
  - A keep rollback removes an earlier `.rollback-database` when the folder is reachable, as a
    best effort that never blocks it.
- **The choice:** "How should the rollback treat the database?":
  - **the snapshot**, offered when the target has one: "Restore the snapshot taken <time>, when
    <version> stopped running. Everything written since is lost.";
  - **down migrations**, offered when `app.migrations` is set, both records exist, and a count
    tool's count didn't grow going back: "Migrate it down with <tool> to <version>'s migrations.
    The tables and columns added since are dropped, with their data.";
  - **keep**, always: "Keep it as it is: <version> runs against today's schema."

  The default is the snapshot on an environment other than prod, and keep otherwise.
  `--database <choice>` chooses in a script, with the same default. A choice not offered is
  refused, with the reason, before any change.
- **The approval:** the rollback's hash covers the choice, the snapshot's `taken` and both
  records. The text says what is lost. A choice that changes data is a destroy-kind approval:
  `allowDestroy`, and the name `destroy --env` asks for, typed or given as `--confirm <name>`.
- **Before dispatching,** the command writes `.rollback-database` (expiry: 30 minutes) through the
  same access. If the dispatch or the run fails before its start step, it removes the file.
- **The result** says what happened to the database, and the rollback record keeps the choice.
- **Portainer, sites and previews:**
  - Portainer offers only keep, saying snapshots come with 024;
  - sites and previews refuse a database choice;
  - a database on another server or the app's own files are named in the "kept" line.

**12.6 The guide and the plugin** (T1936):
- `rollback.md` gains "The database": the choice, snapshots, down migrations, the defaults, the
  disk space, what isn't covered yet. Its "The database stays as it is" section becomes the keep
  option.
- `when-a-deploy-fails.md`, `environments.md` (the default per environment) and `databases.md`
  (where snapshots live, `deploy.snapshots`, `deploy.keepSnapshots`) link to it.
- The plugin's deploy skill says when to suggest each choice.

**12.7 Tests:**
- **Unit tests:** the scripts run under `sh` with shims for each path (T1933, T1935).
- **The local Docker pass** (`OPSCREW_DOCKER_TESTS=1`):
  - each database's dump and exact restore, with a table and a collection that weren't in the
    snapshot (T1933);
  - each tool's real status output, record and down, on the examples, plus small fixtures for
    Rails, Sequelize and Flask-Migrate (T1935).
- **The live pass** (T1937): `rollback.test.ts` gains a staging environment with `koa-knex`, which
  runs Knex on PostgreSQL. A v2 migration adds a column. Then:
  - the snapshot rollback;
  - `--resume --deploy`;
  - the down-migration rollback;
  - a hand-made dispatch with no approval file, which changes no data;
  - the leak search.

## Decisions (lead, 2026-10-31: D1–D6 accepted as recommended; ADR 0023)

- **D1:** provenance accepts `workflow_dispatch` builds from this repository's branch, in both checks. Recommended.
  - **Why:** `--resume --deploy`, and GitHub's own "Run workflow", build images that today can be neither promoted nor rolled back to.
  - **Alternative:** `--resume --deploy` deploys the latest push-built image by digest, through a forward dispatch with `digest` and `rollback: false`.
- **D2:** Cloudflare's hosting and GitHub Pages pause too, as FR-1906 reads. Recommended.
  - **Alternative:** servers only, with the output saying the next push undoes it.
- **D3:** `--resume` is a `github-settings` approval, which `--yes` grants. Recommended.
  - **Alternative:** no approval.
- **D4:** the default target rule of 3. Recommended.
  - **The trade-off:** after a rollback, it may pick a build that never ran. The approval shows it.
- **D5:** the hash includes the plan hash, as promote's does. Recommended.
- **D6:** refuse, rather than wait, when a run is in progress at the start (FR-1907). Wait only for runs created in the moment before the pause.

Lead decisions for the database follow-up (2026-11-06; ADR 0028). The founder chose the snapshot
as the default, on except for prod, and down migrations as an option.
- **D7: a logical dump per database, on the server,** filed under the outgoing version. Not a
  provider snapshot, which would take the whole server and minutes. Not a volume copy, which needs
  the database stopped.
- **D8: four databases now.** The app's own files, a database on another server and Portainer get
  snapshots in 024's commands. SQLite has no safe copy without a tool no pinned image carries.
- **D9: eight down-migration tools now,** the ones whose state and down commands are documented
  and checked against real containers (R9). The rest join as rows of `MIGRATION_TOOLS`.
- **D10: the one-time approval file on the server,** not a workflow input, so a hand-made dispatch
  can't delete data (constitution I: the bound is enforced on the target).
- **D11: the current database is saved before any restore or down migration,** so a failure puts
  it back, and rolling forward again can restore it.
- **D12: a database rollback always holds requests and recreates,** since the newer version must
  not write to a database that is being replaced. Held requests get 504 after 90 seconds, which is
  accepted on the environments where this is on by default.

## Order

T1901 → wave 1 {T1902, T1903, T1904} → wave 2 {T1905, T1906, T1907} → wave 3 {T1908, T1909} → wave 4 {T1910, T1911, T1912} → wave 5 {T1913} → fixes {T1917, T1918, T1919} → logins {T1920} → {T1921, T1922} → {T1923} → T1914 (live runs) → T1915 (simplify) → T1916 (release).

The database follow-up: T1930 → {T1932, T1933, T1934} → {T1935, T1936, T1937} → T1938 (live runs and simplify, lead). It ships with 023's release (T2319).

## Complexity Tracking

| Item | Why it's needed | Simpler alternative rejected because |
|---|---|---|
| A second image source in the branch workflow (`verify` beside `build`) | Every server environment takes a digest without a build (R5.1) | A separate rollback workflow per environment: a second file to keep applied, its own name for retention and the run checks, and the concurrency group shared by hand |
| The pause condition in every workflow | A rollback must outlast the next push (US2), set without a pull request | Rendering it only while paused needs a pull request per rollback |
| A release switch in the Portainer stack | The stack runs `release` with the image on every redeploy | Writing the old tree back would run the old release command too, and bring back the old settings |
