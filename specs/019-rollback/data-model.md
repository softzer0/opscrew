# Data model: rollback

## A version (derived, never stored)

| Field | From |
|---|---|
| `digest` | The digest the commit tag points to in GHCR |
| `image` | `ghcr.io/<owner>/<repo>[/<key>]@<digest>` |
| `tag` | `<commit>` (prod) or `<commit>-<env>`; for a promoted environment, its builder's form |
| `commit` | The build run's `head_sha` (the tag's commit) |
| `message` | The build run's `head_commit.message`, first line, redacted |
| `builtAt` | The build run's `created_at` |
| `runUrl` | The build run that the image's provenance names |
| `buildSucceeded` | That run's conclusion was `success` |
| `marks` | `running` (`opscrew-<env>`), `previous` (the default target, plan.md 3.), `skipped` (a Pages run whose publish job didn't run) |

- Only versions whose provenance and CPU check out are listed: newest first, at most 20.
- **This computer:** the images of `.env` and `.env.previous`.
- **The sites:** the Worker's versions, or the Pages runs, as `status` reads them.

## The rollback's approval

- Kind `promote`.
- Hash: SHA-256 of the canonical `{ environment: "<app>/<env>", current: <digest>, target: <digest>, targetPlanHash }` (`imageRollbackHash`). This computer hashes image references instead of digests.
- Site rollbacks keep 016's `rollbackHash`: target, version, plan hash and `oldSecrets`.

## In GitHub

**`OPSCREW_DEPLOY_PAUSED`** (repository variable, 018):
```json
{
  "example-app/prod": { "reason": "rollback", "since": "2026-10-31T10:02:11.000Z",
                        "image": "sha256:<64 hex>", "commit": "<40 hex>", "from": "<40 hex>" },
  "example-app/staging": { "reason": "move", "since": "2026-10-31T09:00:00.000Z" }
}
```
- There is one entry per environment.
  - A rollback replaces only a rollback's entry.
  - A move's entry stops a rollback, and a rollback's entry stops a move's window.
- The variable is deleted when it is empty.
- The deploy workflow's job-level `if:` reads it when the run is created.

**The deploy workflow's `workflow_dispatch` inputs:** `digest`, `tag` and `rollback`.

## In the registry

- After a rollback, `opscrew-<env>` names the target, and `opscrew-<env>-previous` the image rolled back from.
- A rollback run deletes nothing.
- While paused, push builds add `<commit>[-<env>]` tags. Nothing is labelled or deleted until a deploy runs.

## This computer (the environment's state folder, gitignored)

**`rollback.json`:**

| Field | |
|---|---|
| `digest`, `commit` | The target |
| `from` | `{ digest, commit }`: what ran before |
| `runUrl` | The deploy run (none on Cloudflare's hosting or this computer) |
| `at` | When it succeeded |
| `hash` | The approval's hash |
| `previous` | The record it replaced |

**`pending-rollback.json`,** while a run waits for a reviewer: `digest`, `from`, `runId`, `at`, `hash`, and `pauseBefore` (the pause entry it replaced, or `null`).

**`promotion.json`** (promoted environments): a rollback writes its image as the latest entry.

## On the servers, and on this computer

| Path | Mode | What |
|---|---|---|
| `<app folder>/.failed-deploy/` | 0700, deploy user | The last failed deploy's copy |
| `.failed-deploy/about` | 0600 | `image=`, `time=`, `failed=` (`health`, `process <name>` or `check`) |
| `.failed-deploy/<service>.log` | 0600 | Its last 500 lines, with Docker's timestamps |

- `.env` and `.env.previous` keep today's form. After a rollback, `.env.previous` names the version rolled back from.
- **Portainer:** the deploy branch gets a commit "Roll back to <image>", whose stack has `OPSCREW_RELEASE: skip`.
