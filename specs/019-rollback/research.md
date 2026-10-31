# Research: rollback (019)

Research from 2026-10-31. Two parts:
- A Sonnet agent read only official documentation: Kamal, Vercel, Heroku, Render, Fly.io,
  Cloudflare Workers, GitHub Pages, GitHub Container Registry and GitHub Actions.
- A Sonnet agent mapped what OpsCrew already has, with file and line.

"Unconfirmed" marks a fact no fetched official page stated. Sections R1–R4 are findings; R5 holds
the lead's decisions, which the spec builds on. The plan phase adds its own sections below.

## R1. How other tools roll back

**Kamal.** Source: https://kamal-deploy.org/docs/commands/rollback/
- `kamal rollback <version>` stops the current container and starts one from the target version's
  image: "Nothing needs to be downloaded from the registry". No rebuild.
- The versions are the old containers still on the hosts (`kamal app containers -q`). "By default,
  old containers are pruned after 3 days when you run `kamal deploy`."
- Unconfirmed: what the next deploy does after a rollback.

**Vercel.** Source: https://vercel.com/docs/instant-rollback
- Instant Rollback points the production domains back at an earlier production deployment, with
  no rebuild. Environment variables changed since then are not applied.
- Pro plans can choose any earlier production deployment; Hobby only the one before.
- "After a rollback, Vercel turns off auto-assignment of production domains. This means new
  pushes to your production branch won't replace the rolled-back deployment." "Undo Rollback"
  (or `vercel promote`) turns it back on.

**Heroku.** Source: https://devcenter.heroku.com/articles/releases
- `heroku rollback [vN]` makes a new release that "copies the compiled slug or OCI image and config
  vars" of the target. No rebuild.
- Artifacts of releases older than 30 days and outside the latest 20 are destroyed, and can't be
  rolled back to.
- Add-ons are not reverted: "It's your responsibility to reconcile these resources after rolling
  back." Heroku calls a rollback "a temporary fix" and prefers `git revert` and a new deploy.

**Render.** Source: https://render.com/docs/rollbacks
- A rollback is a new deploy "using the target deploy's build artifact", with no rebuild. Only a
  fixed number of recent artifacts is kept; the number is unconfirmed.
- A rollback from the dashboard turns autodeploy off, and the user turns it on again after the fix.
  A rollback through the API does not, which is a trap.
- "A tag may resolve to a newer image… a digest always points to the same image." A rollback to an
  image that is gone fails.

**Fly.io.** Source: https://docs.fly.io/flyctl/deploy
- `fly deploy --image` deploys a prebuilt image. Unconfirmed: a rollback command, its retention,
  and what auto-deploy does after it.

**Data.** No tool reverts the database. Heroku and Cloudflare say so outright, Vercel reminds the
user of databases in its dialog, and Render says disks "cannot be rolled back".

## R2. The targets' own version history

**Cloudflare Workers.** Sources:
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/

What they say:
- A rollback can go to any of "the 100 most recently published versions". `wrangler rollback`
  makes a new deployment of the chosen version at 100% of traffic.
- A version holds code, static assets, bindings and compatibility settings; KV, R2, D1 and Durable
  Object data are not versioned.
- Cloudflare blocks a rollback across a Durable Object migration, or to a version bound to an R2
  bucket, KV namespace or queue that no longer exists.
- OpsCrew already uses this: `promote --version` on a Worker (`agents/src/promote/site.ts`,
  `rollBackWorker`) deploys an earlier version at 100%. It asks for `--allow-old-secrets` when
  secrets changed since that version.

**GitHub Pages** (`actions/deploy-pages`). Sources: https://github.com/actions/deploy-pages and the
Actions artifact docs.
- The documentation shows no way to deploy an earlier site artifact again without a build.
  Artifacts are kept for the repository's retention, which the user can shorten; the default
  number of days is unconfirmed on the fetched pages.
- OpsCrew's `promote --version` on Pages (`site.ts`, `rollBackPages`) re-runs that version's
  workflow run. That builds the site again from the run's commit.

**GitHub Actions re-runs.** Source:
https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs
- "Workflow runs can be re-run for up to 30 days." A re-run uses the original `GITHUB_SHA` and
  `GITHUB_REF`, so it rebuilds that commit; a base image or a dependency may have changed since.

**GitHub Container Registry.** Sources:
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package

What they say:
- No automatic deletion is documented, only deletion by the owner. That is an absence, not a
  promise.
- An image can be pulled by its digest.
- A deleted version can be restored for 30 days.

## R3. What OpsCrew has to build on (code map, 2026-10-31)

**Images.**
- The deploy workflow pushes `<name>:<commit SHA>` for prod and `<commit>-<env>` for other
  environments (`iac-templates/src/workflow/build.ts`, `environmentTag`).
- The `record` step outputs the digest reference `name@sha256:…`, and every deploy uses that
  reference. There is no `latest` tag.
- After a healthy deploy, `labelJob` (`workflow/jobs.ts`) tags the digest `opscrew-<env>`, and
  tags the image it replaced `opscrew-<env>-previous`. Both are overwritten by the next deploy.
- Retention (`workflow/retention.ts`, on by default with `keep: 10`, `plan-schema/src/plan.ts`)
  deletes older commit-tagged images of the environment. It never deletes the running or previous
  image, an image any environment's label names, or the user's own tags.
- Nothing on the server prunes images.

**The server's record.**
- `/srv/apps/<app>/.env` holds one line, `APP_IMAGE=<digest reference>` (`workflow/switch.ts`).
- Each deploy first copies it to `.env.previous`, and the processes to `.processes.previous`
  (`workflow/index.ts`, `SAVE_PREVIOUS`).
- The automatic switch back (`rollbackCommands`, `switch.ts`) reads `.env.previous`, switches the
  app and restores the workers that ran before. It never runs the release command.
- This computer (`agents/src/localhost/apply.ts`) does the same with local images
  (`opscrew-local/*`), which are not in the registry.

**promote** (`agents/src/promote/**`):
- **The image.** It deploys an existing image by digest, with no build: `chooseImage`, then
  `checkProvenance` (built by a push to the builder branch of this repository) and `checkPlatform`.
- **Readiness.** The target must be provisioned with nothing pending, and its services must still
  exist (`requireReady`, `requireRollbackServices`).
- **The approval.** It is of kind `promote`, bound to `promotionHash`. `--yes` never grants it;
  scripts give `--approve <hash>`.
- **The run.** It dispatches the workflow with `digest` and `tag` inputs and follows the run.
  The workflow's `verify` job checks provenance again (and the cosign signature when signing is
  on). It records the result in `promotion.json`, with the one before.
- **Its limits:**
  - `--digest` accepts only the source's image or the target's `opscrew-<env>-previous`.
  - It refuses an environment that deploys from a branch (`promote/run.ts`), which is the default
    prod. That environment's workflow has `workflow_dispatch` with no inputs, and a build job
    instead of `verify` (`workflow/shared.ts`).
  - A promoted deploy runs the release command of the image it deploys
    (`switchCommands`, `switch.ts`). For a rollback, that would run the old version's migrations
    against the newer schema.

**Portainer.**
- The deploy commits `compose.yaml` with the digest image onto an orphan deploy branch, one commit
  per version (`workflow/portainer.ts`), so the branch holds the whole history.
- Its failure rollback commits the previous tree on top.

**History and status.**
- `plan.yaml`'s `deployment` holds no list of versions.
- Branch-following environments keep no record of their versions on this computer.
- `opscrew status` shows containers and their state on servers, but not the running image or
  version. Only sites show versions (`status/site.ts`).

**Runners.**
- A deploy with no build still needs the registry: GitHub-hosted, the server's own runner or this
  computer's.
- The `verify` job runs on GitHub-hosted `ubuntu-latest`.
- With public SSH closed, only the server's or this computer's runner reaches the servers.

**Split placement (018).**
- The app's image runs only on the app's server, which is where the switch and the switch back
  happen. Services on other servers run pinned catalogue images and are not part of an app
  rollback.
- A paused move (`OPSCREW_DEPLOY_PAUSED`) skips deploys.

## R4. Gaps found while writing the failed-deploy guide

1. **A failed copy's logs are lost.** `docker rm -f "$new"` in `switchApp` (`switch.ts`) removes
   the copy that failed its health check together with its logs.
2. **The worker hint shows the wrong lines.** When a worker fails, the hint (`processFailed`,
   `switch.ts`) says to run `docker compose logs <service>`. After the switch back has restarted
   the old version's workers, that shows the old version's lines.
3. **Half-applied migrations get no advice.** A failed release command points to `release.log`
   (`releaseFailed`, `switch.ts`), but nothing says what to do about a migration that stopped
   halfway.

## R5. Lead decisions for the spec

1. **Redeploy an image by its digest, never rebuild,** through the path `promote` already has:
   dispatch with a digest, provenance and platform checks, the `verify` job, and an approval bound
   to a hash.
   - Every server environment's workflow, branch-following too, accepts a rollback dispatch:
     inputs `digest` and `rollback`, no build.
   - Sites keep their own history: Workers through versions, Pages by re-running the run, which
     rebuilds and is labelled as such.
2. **The versions offered** are this environment's images still in the registry, newest first:
   its commit-tagged versions within retention, each with commit, message and time. The default is
   the one before the current (`opscrew-<env>-previous`).
   - Only an image whose provenance checks out is offered.
   - An image that is gone stops with a plain message that names the oldest version still there.
3. **A rollback never runs a release command.** The switch is the same as a deploy otherwise:
   health check, check from outside, and the automatic switch back on failure.
   - It says before it switches that the data and schema stay as they are, and that the earlier
     version must work with them.
4. **After a rollback, deploys of that environment pause,** as on Vercel and Render, so the next
   push doesn't silently undo it. `status` shows the pause, and one command resumes deploys.
   - The pause reuses the job-level `if:` on a repository variable that 018 built for moves.
     GitHub reads it when the run is created (018's live run); the rollback also waits until no
     deploy of the environment runs.
5. **This computer:** goes back to the previous local image (`.env.previous`), when that image is
   still there.
6. **Recovery gaps (R4):**
   - keep a failed copy's last log lines on the server where `opscrew logs` shows them;
   - point the worker hint at those lines;
   - make the release command's failure message say what to do about a migration that stopped
     halfway.
7. **`status` shows the running version** on servers: commit, short digest and time.

## R6. Spikes (T1901, 2026-10-31)

On the private throwaway repository, then local Docker. Everything created was removed afterwards.

### S3. The job graph on real runs

A workflow with plan.md 1.'s jobs, the three inputs, `on: push`, and the pause `contains(vars.SPIKE_DEPLOY_PAUSED, '"app/prod"')`. It added `sign` (`needs: build`), `prune` (`needs: [build, deploy]`, no `if:`) and a job printing each expression.

| Case | paused | build, sign | verify | deploy | prune | label |
|---|---|---|---|---|---|---|
| 1. push | skip | ran | skip | ran (build's image) | **skip** | ran |
| 2. push, paused | ran | ran | skip | skip | skip | skip |
| 3. dispatch `rollback=true` + digest | skip | skip | ran | ran (verify's image) | skip | ran |
| 4. dispatch, no inputs | skip | ran | skip | ran | **skip** | ran |
| 5. as 3., paused | skip | skip | ran | ran | skip | ran |

Nothing was cancelled, and every run concluded `success`.

**What the expressions saw:**
- **On a push:** `inputs` is `{}`, so `!inputs.rollback` is true. No fallback is needed.
- **A boolean from the API:** `gh workflow run -f rollback=true`, REST `"true"` and REST JSON `true` all gave `inputs.rollback` the boolean `true`, and `github.event.inputs.rollback` the string `"true"`. Without inputs: `false` and `"false"`.
  - So `inputs.rollback == 'true'` is false on a rollback.
  - `!github.event.inputs.rollback` is false on every dispatch.
- **One need skipped:** `deploy`'s condition worked with either need skipped.

**Finding:** the implicit `success()` skips a job when any job upstream was skipped, even indirectly. `prune` was skipped on every push, because `deploy` needs `verify`. With `${{ !cancelled() && needs.build.result == 'success' && needs.deploy.result == 'success' }}` it ran in cases 1 and 4 only.

**Working `if:` texts:**
- **paused:** `${{ !inputs.rollback && contains(vars.X, '"app/prod"') }}`
- **build:** `${{ !inputs.rollback }}`
- **verify:** `${{ inputs.rollback }}`
- **deploy:** `${{ !cancelled() && (needs.build.result == 'success' || needs.verify.result == 'success') && (inputs.rollback || !contains(vars.X, '"app/prod"')) }}`
- **label:** `${{ !cancelled() && needs.deploy.result == 'success' }}`

The image output `needs.build.outputs.image || needs.verify.outputs.image` was right, and so was the mode `inputs.rollback && 'rollback' || 'deploy'`.

### S1. A dispatch on a branch that isn't the default

- **S3's workflow,** only on its branch, after its first push run: a dispatch with `--ref` got 204 and ran.
- **A dispatch-only file** on a second branch, never run: `HTTP 404: Not Found (https://api.github.com/repos/<owner>/<repo>/actions/workflows/spike-019-s1.yml)`. The REST dispatch got 404 too.
- **The same with a push trigger** whose branch filter didn't match: also 404. GitHub knows a workflow once it has run on that branch, or once its file is on the default branch.
- **The file on both branches:** one commit on `main`, reverted by a second. The dispatch got 204 and used the branch's version of the file.
- **After the revert:** a dispatch on the branch still worked.

### S2. GHCR's tag list

`GITHUB_TOKEN` (`packages: write`) pushed three private versions, `spike-1` to `spike-3`.

**The pull token** came back 200 for every token; anonymous got 401.

**`tags/list`:**
- **Classic `read:packages` token:** 200.
- **Fine-grained token,** and **`gh auth token`** (`repo`, `workflow`, no `read:packages`): 403 `DENIED`, "The token provided does not match expected scopes."
- **`GITHUB_TOKEN`:** 200.

**Paging:**
- `?n=1` gave one tag and `Link: </v2/<owner>/<repo>/spike-019/tags/list?last=spike-1&n=1>; rel="next"`, a relative path.
- The last page had no `Link`. Without `n`, all came back with no `Link`.
- The order was lexical.
- A deleted package gave 404 `NAME_UNKNOWN`.

**The Packages REST API** (`…/versions`) answered the same way: 200 for the classic token (9 versions, since each push added two untagged manifests) and `GITHUB_TOKEN`, 403 for the other two.

### S4. Re-runs

The first run had `vars.SPIKE_S4` = `A`. It was then set to `B`, and the run re-run with `gh run rerun`.
- **Attempt 2** printed `B`, and the jobs gated on `${{ github.run_attempt > 1 }}` and `${{ vars.SPIKE_S4 == 'B' }}` ran.
- **`${{ github.run_attempt > 1 || vars.SPIKE_S4 != 'B' }}`** ran on both.

A re-run reads `vars` again, so a paused environment blocks re-runs. The Pages exemption is needed, and it works.

### S5. Compose's `release` service

Docker 29.9.2, Compose 5.6.1:
- **Nothing changed:** `up -d` restarted the exited `release`, which printed `ran` again.
- **Only its environment changed:** `release` was recreated and ran. `app` was untouched.
- **The wrapper with `skip`:** `release` exited 0 silently, and `app` started after it.
- **Back to `run`,** with `app` changed: `release` ran, then `app` started.

### Corrections for plan.md

1. **1.:** `tag` and `prune` need the `if:` from S3's finding, or they skip on every push. The same holds for any job that needs `deploy` without its own `if:`.
2. **Technical Context:** drop the `github.event.inputs` fallback. Never compare `inputs.rollback` with `'true'`.
3. **3.:**
   - Only a classic `read:packages` token reads the tag list from this computer. "Else the user's token" usually gets 403, so the hint should name `OPSCREW_GHCR_READ_TOKEN`.
   - Paging follows the relative `Link`.
4. **10., S1:** an environment with a version to roll back to has already run its workflow on its branch, so the dispatch works. A 404 means it never ran there, and "push to <branch> once" is the fix, not a merge into the default branch.
5. **5., Portainer:**
   - The switch works.
   - Every `up -d` restarts `release`, with the value written in the stack file, even when nothing changed. That predates 019.
