---
description: "Tasks for 022-preview-environments"
---

# Tasks: Preview environments per pull request

**Input**: `specs/022-preview-environments/`:
- spec.md, plan.md, research.md (R1–R7), data-model.md;
- contracts/opscrew-preview.md;

plus `docs/adr/0026-preview-environments.md`, constitution 1.7.0, and features 000–021 (015's
environments, 013's several apps per server and shared edge, 017's check key, 012's builds and
retention above all).

**Numbering**: T2201–T2299.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.

**Rules for every task:**
- **The bound is the server:** nothing a pull request's job sends may widen what the approved recipe
  allows. Every value the server script writes comes from the recipe, a request word that matched
  its pattern, or `/dev/urandom` (contracts/opscrew-preview.md).
- **Fixtures** never contain secret-shaped literals: `fakeSecret()`, or `{{FAKE:…}}` with
  `materializeFixture()`.
- **No network in unit tests:** GitHub, Cloudflare, the providers and the servers are fakes or shims.
- **No leaks:** no token, key, generated value, preview value or server address in output, comments,
  workflow logs, audit entries, snapshots or MCP answers. Every task's tests include a leak check for
  what it handles.
- **Refusals** come before any change, in plain words, ending "Nothing was changed." with what to do
  next. User-facing text never names a feature number.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Shared index files:** when two tasks of a wave add export lines to the same `index.ts`, each adds
  its own; the lead merges them.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Neutral examples only:** `example.com`, `example-app`, `203.0.113.0/24`.

## Phase 1: Foundation

- [x] T2201 The spike, the ADR and the constitution (lead): research.md R5, `docs/adr/0026-preview-environments.md` accepted, `.specify/memory/constitution.md` 1.7.0.
  - S1 (one GitHub environment for every pull request) and S2 (GHCR from a pull request's job) on
    the throwaway repository; S3 and S4 are covered elsewhere (plan.md "2.").

## Phase 2: Wave 1 (parallel)

- [x] T2202 [P] The schema and the paths, in `packages/plan-schema/` and `packages/core/`
  - Owns: `packages/plan-schema/src/**` (+ tests), `packages/core/src/paths.ts`,
    `packages/core/src/index.ts` (+ their tests)
  - Reads: plan.md "1."; data-model.md "plan.environment.previews", "Architecture", "Paths"
  - Depends: none
  - Accept:
    - `EnvironmentSchema.previews` (`cap` 1–20 default 3, `lifetimeDays` 1–30 default 7, `domain`
      FQDN, `seed` string or null, optional) and every refinement of data-model.md, each with a
      plain message naming the field and the fix; a preview environment's plan parses with
      `dns.zone` and no `dns.domain` (the one exception to "a Cloudflare plan has a domain"); a plan
      without `previews` parses exactly as before (tests over the existing fixtures).
    - Another environment's `deploySource.source` naming a preview environment is refused.
    - The architecture's `facts.build.seedCommand` and `seedNote` (optional), beside the release
      command's fields.
    - `resolveProjectPaths` gains `previewKey` for an environment.
    - Exports from both packages' roots.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/core`
  - Effort: high

- [x] T2203 [P] [US4] Seed commands, in `packages/detect/`
  - Owns: `packages/detect/src/seed.ts`, `packages/detect/src/seed/**` (+ tests), the wiring in
    `packages/detect/src/detect.ts` and the export in `packages/detect/src/index.ts`
  - Reads: research.md R1.8, R2.7; `packages/detect/src/release.ts` and `release/**` (the pattern
    to follow, the folder handling `inFolder`)
  - Depends: none
  - Accept:
    - `detectSeed(inputs)` returns `{ command?: string; note?: string }`: Prisma (`npx prisma db
      seed` when `migrations.seed` is set in `prisma.config.ts`, or `prisma.seed` in
      `package.json`), Rails (`bin/rails db:seed` with `db/seeds.rb`), Laravel (`php artisan
      db:seed --force` with `database/seeders/DatabaseSeeder.php`), Knex (`npx knex seed:run` with
      a seeds folder or `seeds.directory`), Sequelize (`npx sequelize-cli db:seed:all` with
      `seeders/` or `seeders-path`), AdonisJS (`node ace db:seed` with `database/seeders/`), and a
      `db:seed` or `seed` script in `package.json` (run with the project's package manager).
      Django and Drizzle: no command, a note saying to set one.
    - An app in a folder gets `cd <dir> && …` as release commands do.
    - The detection result carries `seed` next to `release`; fixtures under `src/**/__fixtures__/`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect`
  - Effort: medium

- [x] T2206 [P] [US1] The previews host plan, in `packages/connectors/ssh-host/`
  - Owns: `packages/connectors/ssh-host/src/**` (+ tests)
  - Reads: plan.md "5."; data-model.md "On the preview server"; contracts/opscrew-preview.md;
    `planAddon` and the check key (`constants.ts`, `plan.ts`), `deployKeyStep`, `inspect.ts`
  - Depends: none
  - Accept:
    - `planAddon("previews", { app, runAs, facts?, repository, enable: { files, publicKey } })`:
      one step writing `files` (by path under `/srv/apps/<app>/`, each within a size cap,
      `bin/opscrew-preview` 0755) and `values.env` (0600) from `previewValues` supplied at apply,
      never in the plan or its hash input (the plan lists the values' names only); with
      `secretsChanged`, a change even when the facts show the recipe in place. The key line
      `previewKeyLine(publicKey, repository, app)` exactly as data-model.md shows (the line with the
      same comment replaced); the deploy user's cron line with a minute from the app name, never 0.
      On `runAs: "root"` (the user's own server) it installs `cron` when absent.
    - The plan is destroying (`deleteData`): applying it needs `allowDestroy` and the typed app
      name (tested through the gate's checks as monitoring's removal is).
    - `disable`: runs `opscrew-preview down` for each preview the facts list, then removes the
      recipe folder, the key line and the cron line; repeatable.
    - `deployKeyStep`'s reconciliation keeps preview key lines (`PREVIEW_KEY_LINE_RE`), and
      `inspectHost` leaves them out of the deploy keys it reports, as both do for the check's.
    - `inspectHost` facts list each preview app's previews (`/srv/apps/<app>-pr-<n>` folders).
    - Planning previews on a server whose facts show another app is refused.
    - With the sshd Docker harness (`sshd-docker.test.ts`, `OPSCREW_DOCKER_TESTS=1`): the installed
      key line runs only the forced command, which sees the request in `SSH_ORIGINAL_COMMAND` and
      stdin; a terminal and port forwarding are refused.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host`
  - Effort: high

- T2207 Dropped after the spike (research R5): a fine-grained personal token can't use the packages
  API, so images are deleted only by workflows (T2205).

## Phase 3: Wave 2 (parallel)

- [x] T2204 [US2] [US3] [US4] [US5] The recipe and `opscrew-preview`, in `packages/iac-templates/`
  - Owns: `packages/iac-templates/src/previews/**`, `packages/iac-templates/src/runtime/**`
    (+ tests), its export lines in `packages/iac-templates/src/index.ts`
  - Reads: plan.md "3."; contracts/opscrew-preview.md; data-model.md "On the preview server";
    `workflow/switch.ts` (`switchCommands`, `rollbackCommands`), `runtime/index.ts`
    (`renderRuntimeFiles`, `renderCompose`), `edge/index.ts`
  - Depends: T2202
  - Accept:
    - `renderPreviewRecipe(plan, { repository, imageName, env })` for a plan with `previews` returns
      the files of data-model.md: `settings.env` (every value validated before it is written),
      `template/` with every file a deploy uploads to an app's folder, the start and rollback
      scripts, the site with `X-Robots-Tag "noindex"`, `env/` from `env`, and with a seed a `seed`
      service (`renderCompose` option: the release service's image, env and user, `sh -c` around
      the command, never started), and `bin/opscrew-preview`.
    - Placeholders as plan.md "3." says (a token of at most 6 letters; the four secret formats); a
      test fills the recipe with 42 and fixed values and finds it equal to a direct rendering of
      the plan as `<app>-pr-42`.
    - The script does what the contract says, one test per row: each request form, each refusal
      (nothing written), the cap under the recipe lock, per-preview locks, creation vs update (the
      template filled again, generated values kept, new names generated), the seed until `.seeded`,
      the rollback on a failed update, `down` repeatable and finishing a half-done removal, `gc` by
      `LIFETIME_DAYS`, `list` lines, `logs` refused through the preview key, step output only in
      `up.log`, the registry login only during `up`, `previews.log` lines, the last line and exit
      code of each case. Tested under `sh` with shims for `docker`, `kamal-proxy` and `flock`.
    - A Docker-gated test (`OPSCREW_DOCKER_TESTS=1`) runs `up`, an update, `list`, `down` on a real
      Docker with a tiny pinned image and the edge, and finds nothing left.
    - No generated value, preview value or token in any output (leak test).
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [x] T2205 [US2] [US3] [US5] The preview workflow, the builds and the wildcard, in `packages/iac-templates/`
  - Owns: `packages/iac-templates/src/workflow/preview*.ts`, `workflow/build.ts`,
    `workflow/retention.ts` (+ tests), the preview root in `packages/iac-templates/src/infra/**`
    (+ tests), its export lines in `packages/iac-templates/src/index.ts`
  - Reads: plan.md "4."; contracts/opscrew-preview.md "Output and exit codes"; research.md R1.1–R1.3,
    R5; `workflow/shared.ts`, `workflow/index.ts` (the deploy job's SSH steps), `infra/cloudflare.ts`
  - Depends: T2202
  - Accept:
    - `renderPreviewWorkflow(plan, ctx)` renders `opscrew-preview[-<app key>].yml` as plan.md "4."
      says: triggers and types, the app's paths, top-level `contents: read`, the jobs `skipped`,
      `build`, `deploy`, `report` and `remove` with exactly the permissions plan.md gives each (the
      job that sends the token to the server may only read packages), the concurrency group per pull
      request, the same-repository and not-Dependabot condition on every job, drafts skipped, the
      deploy job's environment `url`, the `remove` job's `deployment: false` and its deployments
      marked `inactive`. Never `pull_request_target`; only `ubuntu-latest`.
    - `build.ts` gains the preview mode: tags `pr-<n>-<sha>`, `build-pr-<n>-<sha>`,
      `buildcache-<env>`; the other modes render exactly as before (snapshot tests unchanged).
    - The comment (marker `<!-- opscrew-preview:<app> -->`) is created or edited; its text comes
      only from the contract's state and detail (a test per state); never container output.
    - `report` deletes the images of pull requests no longer open and this one's versions other than
      the running one; `retention.ts`: every deploy workflow's prune also deletes `pr-*` and
      `build-pr-*` versions created more than 31 days ago, retention on or off, and never another
      tag (tests over `prunable`).
    - Every third-party action is pinned by SHA from the pin table; `actionlint` passes when
      present.
    - The preview environment's IaC root calls `cloudflare-dns` with `*.${var.preview_domain}`,
      `proxied = false`, `www = false`, no CAA issuers; `validate` passes with both engines.
    - No secret value in the rendered files (leak test).
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [x] T2208 [US1] [US4] Designing previews, in `packages/agents/` (environments, design, analyze)
  - Owns: `packages/agents/src/environments/**`, `packages/agents/src/design/**`,
    `packages/agents/src/analyze/**` (+ tests)
  - Reads: plan.md "6."; spec.md US1; data-model.md; `environments/add.ts`, `environments/remove.ts`,
    `design/sizing.ts`, `design/options.ts`, `design/cost.ts`
  - Depends: T2202, T2203
  - Accept:
    - `addEnvironment` with `previews` (default name `preview`): the questions of spec.md US1 with
      their defaults, or their flags' values; the size from the cap or the cap from the size, from
      the memory limits the runtime renders plus the reserve `sizeFor` keeps; the monthly cost and
      the budget warning; the plan's `dns` as data-model.md shows (zone, no domain).
    - Refusals before any change (FR-2202): Portainer, localhost, sites; an own server whose facts
      show any app; no Cloudflare zone; a record already at `*.<domain>` (the Cloudflare
      connector's `listDnsRecords`); a second preview environment for the app. A base on the zone
      apex is allowed, with a line saying every name without its own record reaches the preview
      server.
    - The seed: the architecture's `facts.build.seedCommand` offered for confirmation (its `seedNote` shown when there is none); `--seed` and
      `--no-seed`; none found says so.
    - The values come from `.env.<name>` as `env add` offers env files; prod's `.env` never.
    - The environment's requirements default to `dataCriticality: none`, `uptime: best-effort`.
    - `design --env <preview>` keeps the previews settings and the user's edits; it collapses
      `servers` and turns the add-ons off with a line each.
    - `env remove` of a preview environment also deletes its preview workflow and its committed
      recipe folder.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 4: Wave 3 (parallel)

- [x] T2209 [US1] [US3] Provisioning previews, in `packages/agents/`
  - Owns: `packages/agents/src/provision/**`, `packages/agents/src/shared/app-env.ts`,
    `packages/agents/src/previews/{setup,keys,index}.ts` (+ tests), its export lines in
    `packages/agents/src/index.ts`
  - Reads: plan.md "7."; spec.md US1, US3; data-model.md "Paths", "GitHub"; ADR 0026;
    `provision/run.ts`, `provision/secrets.ts`, `provision/render.ts`, `check/host.ts` (the check
    key's pattern), `shared/ssh-keys.ts`
  - Depends: T2204, T2205, T2206, T2208
  - Accept:
    - The secrets check of plan.md "7." first: refused while another environment's deploy secrets
      are repository secrets where GitHub enforces branch rules; the plan's warning where it doesn't.
    - Then in order: the IaC plan by hash; the server's host plans; `planAddon("previews")` with the
      rendered recipe, the preview key and the values from `.env.<env>` supplied at apply, approved
      by hash with `allowDestroy` and the typed `<app>-<env>`; the plan's text states the standing
      approval in the words of plan.md "7." and lists every bound and the values' names.
    - `assembleAppEnv` gains the placeholder value source and keeps the user's values apart; the
      env templates hold no secret (test).
    - The preview key (`ensurePreviewKey`, Ed25519, `previewKey` path) is the only key written to
      GitHub; the deploy key stays local (test: the secrets written hold the preview key's private
      half and never the deploy key's).
    - Secrets: only `…_HOST`, `…_SSH_PRIVATE_KEY`, `…_SSH_KNOWN_HOSTS` for the environment; no app
      or service env secrets; no branch rule on its GitHub environment; build values as any named
      environment.
    - The deploy-setup pull request carries the preview workflow and the rendered recipe (without
      values) in `opscrew/environments/<env>/previews/`, and no push-deploy workflow, scheduled
      check, Dependabot entry or monitoring for this environment; no first deploy; the summary says
      what happens on the next pull request.
    - A second provision with nothing changed applies nothing; a changed recipe, or changed values
      (a digest kept locally, `secretsChanged`), is a new host plan.
    - Provisioning previews leaves prod's plan, state and secrets untouched (test with fakes,
      SC-2205).
    - No secret in output, plans or the audit log (leak test).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2210 [US5] [US6] Preview commands, destroy and refusals, in `packages/agents/`
  - Owns: `packages/agents/src/previews/{list,logs,destroy,remote}.ts` (+ tests),
    `packages/agents/src/{destroy,promote,rollback,retarget,addons,move,status,verify,drift,secure,advise}/**`
    (+ tests), its export lines in `packages/agents/src/previews/index.ts` and `src/index.ts`
  - Reads: plan.md "8."; contracts/opscrew-preview.md; spec.md US6, edge cases
  - Depends: T2202, T2206 (runs beside T2209)
  - Accept:
    - `listPreviews`, `previewLogs(n)` (read-only) and `destroyPreview(n)` (typed `pr-<n>`, audited
      as `remote-exec`) over the environment's deploy key, parsing the contract's lines with zod.
    - `destroy --env <preview>`: the IaC destroy (server and record) or, on an own server,
      `planAddon("previews", { disable })` then the usual removal; the GitHub secrets and
      environment as today; a line saying the images of previews still running are deleted by the
      deploy workflows' image cleanup within 31 days.
    - `promote` (to or from), `rollback`, `retarget`, `addon enable` and `move` refuse a preview
      environment plainly before any change.
    - `status --env <preview>`: the server's figures and the previews list, no app health check;
      `verify --env <preview>`: the server's checks and each running preview's address; `drift`
      compares the preview root and the recipe as provision renders them; `secure` and `advise` run
      on the preview server without app-hostname checks (tests).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 5: Wave 4 (parallel)

- [x] T2211 [US1] [US6] [US7] The CLI, the MCP tool and the plugin
  - Owns: `packages/cli/src/commands/{env,preview}*.ts`, `packages/cli/src/commands/index.ts`
    (+ tests), `packages/mcp-server/src/**` (+ tests), `plugin/skills/opscrew-deploy/**`
  - Reads: plan.md "9."; spec.md US1, US6, US7
  - Depends: T2209, T2210
  - Accept:
    - `env add --previews [--cap n | --size type] [--lifetime days] [--domain name] [--seed cmd |
      --no-seed]`, refusing `--runner`/`--build` other than `github` with previews, and `--cap`
      with `--size` (design lets a size win over a cap).
    - `opscrew preview list|logs <n>|destroy <n> [--confirm pr-<n>]`, with `--env` and `--app` as
      every command, `--json` for `list`.
    - MCP `opscrew_preview_list` (read-only, `readOnlyHint`), with `environment` and `app`.
    - `verify` for a preview environment has no runbook (`VerifyResult.runbookPath` absent): the
      CLI's "read <runbook>" next step and the MCP deploy tool's runbook line are left out.
    - The deploy skill gains a previews section (when to suggest them, the comment's states, what
      previews don't do); `node plugin/validate.mjs` passes.
    - No secret in output or MCP answers (leak test).
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && node plugin/validate.mjs`
  - Effort: high

- [x] T2212 [US1] The guide page
  - Owns: `docs/guide/previews.md`, links in `docs/guide/environments.md`, `docs/guide/index.md`
    and `README.md`'s feature list
  - Reads: spec.md; plan.md; ADR 0026; `docs/guide/environments.md` (style and depth)
  - Depends: T2209 (flags from T2211's Accept)
  - Accept:
    - Setup, the standing approval and its bounds in plain words, the secrets check (and what it
      means on GitHub Free private repositories), which pull requests get a preview, addresses and
      certificates (the 50-a-week limit), data and seeds, the preview values (test keys only:
      anyone who can push a branch can read them), the cap and cleanup, the commands, changing the
      recipe, removing previews, and what previews don't do (forks, a login, sites, Portainer, this
      computer, prod's data).
    - No feature number; links resolve.
  - Verify: `pnpm lint`
  - Effort: medium

## Phase 6: Live

- [x] T2213 [US2] [US3] [US5] The live pass, in `packages/cli/test/live/`
  - Owns: `packages/cli/test/live/previews*.ts` (+ offline tests of its support code), `docs/e2e.md`
    "Previews", `docs/e2e-coverage.md` row
  - Reads: plan.md "10."; `packages/cli/test/live/advise*.ts` (the harness's pattern)
  - Depends: T2211
  - Accept: the pass of plan.md "10.", gated on `OPSCREW_E2E_PREVIEWS=1` and the Hetzner,
    Cloudflare and GitHub variables; pull requests opened, pushed and closed through the GitHub
    API on the throwaway repository; prod checked unchanged; a leak search; the cleanup always runs
    (previews, the environment, branches, pull requests, images).
  - Verify: `pnpm turbo run typecheck --filter=opscrew` (the live run is T2214's)
  - Effort: high

- [x] T2214 Live runs (lead): T2213's pass on the final code, recorded in `docs/e2e-coverage.md`;
  each finding becomes a task here.

## Phase 7: Finish

- [x] T2215 Simplify (lead): a review of the feature's diff for reuse and simplicity; findings
  become tasks here. Known so far: one helper in plan-schema for the preview workflow's path
  (T2205's renderer and T2208's `env remove` each name it); the `.sequelizerc` reading shared by
  release and seed detection; the runner/build refusal sentence in both the CLI and agents; the
  preview test plan built inline in CLI and MCP tests (export agents' fixture from its testing entry).
  The make-once Ed25519 key file in three copies (`ensureDeployKey`, `ensureCheckKey`,
  `ensurePreviewKey`): one `ensureKeyPair`. Design's preview filter that drops the planned bucket's
  line by its opening words (`design/run.ts`, from `components.ts`).

### Simplify tasks (from T2215's review, 2026-11-05)

Three read-only reviewers (iac-templates; agents and ssh-host; schema, detect, CLI, MCP, docs)
went over `04c52441..HEAD`. No change below alters behaviour, a refusal, an approval, the
script's contract or what is redacted; snapshots may change only where a test fixture does.

- [x] T2217 [P] Simplify iac-templates, and one helper for the preview workflow's path
  - Owns: `packages/iac-templates/src/**` (+ tests, fixtures, snapshots), `packages/plan-schema/src/apps.ts` (+ its test)
  - Accept:
    - `previewWorkflowPathFor(key)` in plan-schema's apps.ts beside `workflowPathFor`;
      `previewWorkflowPath` and `paths.ts`'s pattern use it.
    - One `reach(digests)` beside `registryCode` for the "what an index lists" walk of
      preview-images.ts and retention.ts; one `pages(path, what)` for their page loops.
    - One registry test fixture (`workflow/__fixtures__/registry.ts`) for preview-images and
      retention tests; one `previewPlan` fixture (`previews/__fixtures__/plans.ts` gains the
      options of `workflow/__fixtures__/previews.ts`, which goes).
    - script.ts: `on_exit` calls `finish`; `field`'s default used for `created`.
    - The pull request tag pattern and the secret placeholder pattern each written once.
    - Drop: `RunResult.last`, the `START_FAILURES` export and its redundant assertion, the
      exports of `sealsImage` and `PREVIEW_IMAGE_DAYS`, the infra test that repeats snapshots.
    - Small: own.ts's zone check once; `settingsFile` takes `previews` from its caller.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/plan-schema`
  - Effort: medium

- [x] T2218 Simplify agents and ssh-host
  - Owns: `packages/agents/src/**`, `packages/connectors/ssh-host/src/**` (+ tests),
    `packages/plan-schema/src/environments.ts`, `environments.test.ts`, `previews.test.ts`,
    `packages/plan-schema/src/__fixtures__/**`
  - Depends: T2217
  - Accept:
    - plan-schema exposes the preview environments' names it already collects in
      `environmentsOf`; environments/previews.ts and provision/dependabot.ts use it.
    - drift/previews.ts uses `previewRecipeDir` and `toPosixRelative`.
    - One `previewCommand(app)` (ssh-host, from `PREVIEW_COMMAND_FILE`, exported) for the five
      copies of `/srv/apps/<app>/bin/opscrew-preview`; one constant for the names a recipe
      leaves out (`values.env`, `previews.log`); the pointless `helpers` alias and the second
      "each name once" check go.
    - One helper for verify's report-each-check loop; `previewChecks` reads `ctx.flag`; the logs
      sentence built once.
    - One `answersWithDefaults` in environments/add.ts; one usable-server-type filter.
    - `previewEdits` returns only its lines; render.ts's unreachable INTERNAL guard goes;
      credentials.ts's two near-identical hints become one; remote.ts's `NUMBER` exported once,
      `commandFlags` only on error.
    - One `ensureKeyPair` for the deploy, check and preview keys.
    - environments/remove.ts uses `previewWorkflowPathFor`.
    - design's bucket-line filter keyed on something sturdier than the line's opening words.
    - The runner/build refusal sentence exported once for the CLI to reuse; the preview test
      plan exported from agents' testing entry.
    - Found live (T2214 run 3): `provision --env <preview>` refuses, before reading it, a values
      file `.env.<env>` that git doesn't ignore (`git check-ignore`), saying to add `.env.*` to
      `.gitignore`; a test. (The one behaviour change in this task.)
    - Tests that repeat another's assertion go (setup.test.ts's message and other-app refusal,
      design/previews.test.ts's "left out" lines); plan-schema's preview test plan built once.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-ssh-host --filter=@opscrew/plan-schema`
  - Effort: high

- [x] T2219 [P] Simplify detection, and the guide
  - Owns: `packages/detect/src/**` (+ tests, fixtures), `docs/guide/previews.md`
  - Accept:
    - seed.test.ts writes the folder case in memory (the on-disk fixture goes); `detectSeed` and
      its types not exported; `read` required; the `.sequelizerc` reading shared with release.
    - The guide's "Changing the recipe": edit `environment.previews` in
      `opscrew/environments/preview/plan.yaml`, then `design` (it resizes the server for a new
      cap), then `provision`, as design's own hint says; "What previews don't do" keeps only what
      the page doesn't already say; the seed retry said once.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect && pnpm lint`
  - Effort: medium

- [x] T2220 Simplify the CLI, MCP and the live harness
  - Owns: `packages/cli/src/**`, `packages/cli/test/live/**`, `packages/mcp-server/src/**` (+ tests)
  - Depends: T2218
  - Accept:
    - The CLI's runner/build refusal reuses agents' sentence; CLI and MCP tests use agents' exported
      preview test plan; env.test.ts's terminal refusal test keeps one flag.
    - Live harness: the preview key's SSH through `envs.shell` (an optional key file) instead of
      `previewKeySshArgs`; one `commentBodies(pull)`; one `parseJsonOr` in support.ts for the
      three JSON parsers; the two small tidy-ups (`page(...).then`, `list.previews[0]` whole).
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: medium

### Found in the live runs (T2214)

- [x] T2221 A GitHub environment without any rule gets OpsCrew's branch rule (found live, run 6)
  - Owns: `packages/agents/src/provision/secrets.ts` (+ its tests), `docs/guide/environments.md`, `docs/guide/previews.md`
  - Why: prod's deploy job names `production`, so GitHub creates that environment itself on the first
    deploy. Provision then finds an environment it didn't create and leaves its rules alone, so prod
    never gets its branch rule, and the previews' secrets check refuses for good (its hint, provision
    prod again, can't help).
  - Accept:
    - `setEnvironmentRules` also sets the branch rule (after the same `github-settings` approval)
      on a GitHub environment OpsCrew didn't create when it has no rule at all (every branch may
      deploy, no required reviewer, no wait timer): there is nothing of the user's to change. An
      environment with any rule of the user's stays as it is, as today. Such an environment is not
      recorded as created (destroy doesn't delete it).
    - The secrets check's hint for an environment without a branch rule stays accurate: provisioning
      it again now adds the rule, unless it has rules of the user's, then it says to set the branch
      rule in the repository's environment settings.
    - environments.md and previews.md say it in one sentence each; tests for both cases.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium

### Addresses nobody can guess (US8, research R6, plan.md "11.")

Added by the founder on 2026-11-05: previews on a domain of their own behind Cloudflare's proxy at
`pr-<n>-<random>.<zone>`; other environments get a suggested `<env>-<random>` name; no password
(later).

- [x] T2222 [P] [US8] The preview plan behind the proxy, in `packages/plan-schema/`
  - Owns: `packages/plan-schema/src/**` (+ tests, regenerated schemas)
  - Accept: a preview plan's `dns` must be proxied (the `proxied: false` rule becomes `proxied:
    true`), `previews.domain` must equal `dns.zone`, and `security.httpAllowedFrom` must be
    `cloudflare`; each with a plain message; plans without previews parse as before.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema`
  - Effort: medium

- [x] T2224 [P] [US8] The previews' Origin CA certificate on the preview server, in `packages/connectors/ssh-host/`
  - Owns: `packages/connectors/ssh-host/src/**` (+ tests)
  - Accept: `planAddon("previews")` takes `previewTls: { certificate, key }` at apply (never in the
    plan or its hash; the plan says a certificate is installed), checked as PEM, written to
    `/srv/edge/tls/<app>/origin.pem` (0644) and `origin.key` (0600); part of `secretsChanged`;
    `disable` removes them; the redactor gets the key; facts say whether they are there.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host`
  - Effort: medium

- [x] T2223 [US8] Hidden preview names in the recipe, the script, the workflow and the root, in `packages/iac-templates/`
  - Owns: `packages/iac-templates/src/**` (+ tests, snapshots, fixtures)
  - Depends: T2222
  - Accept:
    - The preview root's `dns` module makes `*.<zone>` proxied (web ports from Cloudflare, as a
      proxied app's root already does).
    - Each preview's Caddy site is `pr-<n>-<random>.<zone>` with `tls` on the Origin CA files in
      `/srv/edge/tls/<app>/` (no automatic HTTPS for it); the equality test covers the new
      placeholder.
    - The script draws `<random>` (10 of `[a-z0-9]`, `/dev/urandom`) at creation, keeps it in
      `.preview`, reuses it on updates, answers `running pr-<n>-<random>.<zone>`; `list` prints the
      address; the contract file is updated by the lead.
    - The workflow takes the address from `up`'s detail (checked against
      `^pr-<n>-[a-z0-9]{10}\.<zone>$`) for the comment, the health check and the deployment URL.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [x] T2225 [US8] Hidden addresses in agents: the preview domain, the certificate, the suggested names
  - Owns: `packages/agents/src/**` (+ tests)
  - Depends: T2222, T2223, T2224, T2227
  - Accept:
    - `env add --previews` asks for the preview domain (`--domain` in a script; no default),
      refuses the app's own zone and a zone with other A, AAAA or CNAME records (Cloudflare
      connector), points to `opscrew domain buy` when there is none, and designs the plan of T2222.
    - Provision makes the Origin CA certificate for `*.<zone>` and `<zone>` with the existing
      origin-TLS code (key local, kept with the generated values, redacted) and hands it to the
      previews host plan at apply as `previewTls`; nothing of it in a plan, GitHub, a log or the
      repository (leak test).
    - `env add <env>` suggests `<env>-<random>.<zone>` (10 random characters, injected randomness)
      when the app's DNS is proxied with a name one level below the zone, otherwise says the name
      would be public and suggests the plain one; a given hostname wins.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [x] T2227 [US8] A wildcard name in the Origin CA path, in `packages/core/` and `packages/connectors/cloudflare/`
  - Owns: `packages/core/src/crypto/**` (+ tests), `packages/connectors/cloudflare/src/**` (+ tests)
  - Why (found by T2225): `buildCsr` and the shared Cloudflare plan (`appHostnames`, the record's
    `tls.origin.hostnames`) refuse `*.<zone>`, and `inspectShared` reads per-hostname
    Authenticated Origin Pulls for every proxied name; previews need one Origin CA certificate for
    `*.<zone>` and `<zone>` through the same approved shared plan, with no client certificate.
  - Accept: `buildCsr` accepts a leading `*.` label (one, leftmost, followed by a valid name); the
    shared plan's TLS hostnames and its record accept `*.<name>`; per-hostname origin pulls are
    neither read nor set for a wildcard name; any rule expression built from the proxied hostnames
    covers a wildcard correctly (say how, or leave wildcards out where the rule doesn't apply); plain
    names behave exactly as before (existing tests and snapshots unchanged).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core --filter=@opscrew/connector-cloudflare`
  - Effort: medium

- [x] T2226 [US8] The CLI, the guide, the skill and the live pass for hidden addresses
  - Owns: `packages/cli/src/**`, `packages/cli/test/live/**` (+ tests), `packages/mcp-server/src/**` (+ tests),
    `plugin/skills/opscrew-deploy/**`, `docs/guide/environments.md`, `docs/guide/previews.md`, `docs/e2e.md`
  - Depends: T2225, T2227
  - Accept: `env add --previews --domain <zone>` (no default; refused in a script without it), `env add
    <env> --hostname <name>` (any name in a Cloudflare zone of the token, the suggested one by default),
    the CLI and MCP preview tests on the new address form (`list`'s 7th field, zone `example.net`); the
    previews page's addresses section rewritten (a domain of its own, the proxy and the Origin CA
    certificate, what hidden addresses protect against and what they don't, public repositories),
    the environments page's hidden addresses; the skill says the same; the live pass uses the
    preview zone `OPSCREW_E2E_PREVIEW_DOMAIN` and checks the address's form and that the preview
    server answers web requests only through Cloudflare.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew && node plugin/validate.mjs && pnpm lint`
  - Effort: medium

- [x] T2216 Release (lead): `docs/releasing.md`.

### Two opt-ins (US9, US10, research R7, plan.md "12.")

The founder added both on 2026-11-05, after 0.2.3: previews may run on another environment's
server (never prod's), and under the app's own zone with Cloudflare's Advanced Certificate Manager.
They aren't released on their own; they ship with 023. Waves: T2229 and T2230, then T2231 and T2232,
then T2233, then T2234.

- [x] T2228 Spec, plan, research R7, data model, ADR 0026 (D4, D6), constitution 1.8.0 (lead).

- [x] T2229 [P] [US9] [US10] The opt-ins in the schema, in `packages/plan-schema/`
  - Owns: `packages/plan-schema/src/**` (+ tests, regenerated schemas)
  - Accept:
    - `previews.server?: { environment }` (strict, an environment name, never `prod`), which needs
      `target.provider: own` with `access: public`, each with a plain message.
    - `previews.domain` equal to `dns.zone` or a name below it (the refinement's message names both).
    - Plans without these parse as before.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema`
  - Effort: medium

- [x] T2230 [P] [US10] Certificate packs and Total TLS, read-only, in `packages/connectors/cloudflare/`
  - Owns: `packages/connectors/cloudflare/src/**` (+ tests)
  - Accept: three read-only client calls, each checked with zod, each with a plain error that
    names the token permission (Zone → SSL and Certificates → Read) when Cloudflare refuses:
    - `certificatePackQuota(zoneId)`: `{ allocated, used }` from `GET
      /zones/{id}/ssl/certificate_packs/quota`; with no `advanced` in the answer, both are 0.
    - `totalTls(zoneId)`: `{ enabled }` from `GET /zones/{id}/acm/total_tls`.
    - `listCertificatePacks(zoneId)`: `[{ id, type, hosts, status }]` from `GET
      /zones/{id}/ssl/certificate_packs?status=all`, paged as the client pages.
    - Fake-fetch tests, with no token in any error.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare`
  - Effort: medium

- [x] T2231 [US10] The advanced certificate pack in the preview root, in `packages/iac-templates/`
  - Owns: `packages/iac-templates/src/**` (+ tests, snapshots, fixtures)
  - Depends: T2229
  - Accept:
    - With `previews.domain` below `dns.zone`, the preview root has
      `cloudflare_certificate_pack.previews` (data-model.md: the zone and `*.<domain>`, Let's
      Encrypt, `txt`, 90 days, `create_before_destroy`) and an output
      `previews_certificate_pack_id`. With the domain equal to the zone, nothing changes
      (snapshots).
    - A preview plan with `previews.server` renders as an own target's root does (DNS only, the
      wildcard to `server_ipv4`/`server_ipv6`), shown by a test.
    - Whatever matches a preview's address escapes the domain's dots, for a domain several labels
      deep.
    - `tofu validate` passes on the new root (the existing harness).
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: medium

- [x] T2232 [US9] Previews on another environment's server, in `packages/agents/`
  - Owns: `packages/agents/src/**` (+ tests)
  - Depends: T2229
  - Reads: research R7.3 (1), plan.md "12." A
  - Accept:
    - **One helper** resolves the host environment's paths, plan and logins. Everything that
      reaches the preview server uses it:
      - the previews host plan: on a server OpsCrew created, the deploy login (`runAs: "login"`);
        on the user's own, the recorded admin login as root;
      - `preview list`, `logs` and `destroy`;
      - `verify`, `drift` and `status`;
      - the GitHub secrets `HOST` and `KNOWN_HOSTS`;
      - the TF_VAR addresses of the preview root, from the host's root outputs or its
        `server.json`.

      Nothing of the host's address or logins is copied into the preview environment's state.
    - **`env add --previews`:**
      - `--share-server <env>` is the scripted opt-in. Interactively, "Where should previews run?"
        lists each eligible, provisioned environment's server, followed by a confirmation that
        defaults to no.
      - The warning (research R7.3 (1)) is printed both ways.
      - Refused before any change, each in plain words: prod, or a server prod runs on; a server
        with apps besides that environment's (from inspection); no public SSH or a tunnel; an edge
        other than Caddy; a preview environment, Portainer, localhost or a site as the host; a host
        not provisioned; a cap that doesn't fit the memory left after the host's needs (it says
        the cap that fits).
      - The plan written is T2229's (`target: own`, `previews.server`).
    - **Design:** no server price. The host environment's design and `advise` count the previews'
      memory (`cap` × a preview's limits) while a preview environment names it.
    - **Provision:** no server, base or edge switch. The approval names the host environment and
      repeats the warning.
    - **Refusals on the host environment:** `destroy`, `retarget`, and a proxy switch on its server,
      while previews run there. Each refusal names `opscrew destroy --env <preview>`.
      `destroy --env <preview>` removes the previews, the recipe and the wildcard, never the
      server.
    - **"Holds only this app" assumptions** (the edge switch, clean-up steps, container and disk
      checks in `verify`, `secure` and `status`) are checked with a host server carrying previews:
      each either holds or refuses plainly. Findings go in the report.
    - **Tests:** fakes for both hosts (a server OpsCrew created, and the user's own), and a leak
      test for addresses and keys.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2233 [US10] Previews under the app's zone, in `packages/agents/`; and two fixes found in T2232
  - Owns: `packages/agents/src/**`, `packages/iac-templates/src/previews/**` (+ tests)
  - Depends: T2230, T2231, T2232
  - Reads: research R7.1 and R7.3 (2), plan.md "12." B
  - Accept:
    - **`env add --previews --domain <name below the app's zone>`:**
      - `--app-zone` is the scripted opt-in. Interactively, a confirmation that defaults to no and
        first says what it costs (ACM, a paid add-on, with no price named) and what it shares
        (cookies set for the whole domain reach previews, where a pull request's code can read
        them, and previews can set such cookies).
      - Refused before any change, with the dashboard steps: no ACM (`allocated` 0); Total TLS on;
        records at or below the domain; a domain that is an app or environment hostname, or a
        parent of one.
      - Without the opt-in, today's refusal stands, and it names `--app-zone`.
    - **Provision:**
      - The same checks before any plan.
      - After apply, it polls the pack (read-only, injected clock) until `active`, for up to 10
        minutes; otherwise it says previews answer once Cloudflare issues it, and `verify` shows
        when.
      - The Origin CA certificate and the shared rules use `*.<domain>` and `<domain>`, beside the
        app's own in the app's zone; the app's own rules and certificate are unchanged (test).
    - **`verify` and `drift`:** the pack active and Total TLS off, each a check with a plain fix.
    - **`destroy --env <preview>`:** says that ACM stays on until the user turns it off in the
      dashboard.
    - **Found in T2232, the shared edge file:** previews on another environment's server render the
      edge's Compose file and Caddy's settings from the host's plan, not their own, so the host's
      deploys and a preview's `up` stop replacing each other's `/srv/edge/compose.yaml` and
      restarting Caddy. Today the ports differ (`0.0.0.0:` with the web filter) and so do
      Cloudflare's trusted ranges. A test shows that the host's edge files and the recipe's are
      equal.
    - **Found in T2232, a host gaining a private network:** the host's own provision refuses to add
      a private network, devices, granted services or dashboards on its server while a preview
      environment names it, with the same words as the previews' refusal.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: high

- [ ] T2234 [US9] [US10] The CLI, the guide, the skill and the live pass for the opt-ins
  - Owns: `packages/cli/src/**`, `packages/cli/test/live/**` (+ tests), `plugin/skills/opscrew-deploy/**`,
    `docs/guide/previews.md`, `docs/guide/environments.md`, `docs/e2e.md`
  - Depends: T2232, T2233
  - Accept:
    - **The CLI:** `env add --previews` gains `--share-server <env>` and `--app-zone`, with their
      help and prompts.
    - **The guide:** previews.md gets a "Fewer servers or one domain" section: both opt-ins, what
      each risks (the warning's words), the refusals, ACM and Total TLS, the cookie caveat, and how
      to undo each. environments.md links to it.
    - **The skill** says the same.
    - **The live pass:**
      - `OPSCREW_E2E_PREVIEWS_SHARED=1` provisions a dev environment on Hetzner and previews on its
        server: a pull request's preview answers; dev keeps answering; `destroy --env dev` is
        refused while previews run; `destroy --env preview` leaves dev's server and dev working;
        then dev is destroyed.
      - B's refusal runs on the preview zone, which has no ACM.
      - docs/e2e.md says how to run both.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew && node plugin/validate.mjs && pnpm lint`
  - Effort: high

- [ ] T2235 Live runs (lead): T2234's pass on the final code, recorded in `docs/e2e-coverage.md`.

- [ ] T2236 Simplify (lead): a review of the opt-ins' diff for reuse and simplicity.
