---
description: "Tasks for 022-preview-environments"
---

# Tasks: Preview environments per pull request

**Input**: `specs/022-preview-environments/`:
- spec.md, plan.md, research.md (R1–R5), data-model.md;
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

- [ ] T2214 Live runs (lead): T2213's pass on the final code, recorded in `docs/e2e-coverage.md`;
  each finding becomes a task here.

## Phase 7: Finish

- [ ] T2215 Simplify (lead): a review of the feature's diff for reuse and simplicity; findings
  become tasks here. Known so far: one helper in plan-schema for the preview workflow's path
  (T2205's renderer and T2208's `env remove` each name it); the `.sequelizerc` reading shared by
  release and seed detection; the runner/build refusal sentence in both the CLI and agents; the
  preview test plan built inline in CLI and MCP tests (export agents' fixture from its testing entry).
  The make-once Ed25519 key file in three copies (`ensureDeployKey`, `ensureCheckKey`,
  `ensurePreviewKey`): one `ensureKeyPair`. Design's preview filter that drops the planned bucket's
  line by its opening words (`design/run.ts`, from `components.ts`).

- [ ] T2216 Release (lead): `docs/releasing.md`.
