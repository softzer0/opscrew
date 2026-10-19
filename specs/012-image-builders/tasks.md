---
description: "Tasks for 012-image-builders"
---

# Tasks: Image builders, zero-downtime deploys and the image supply chain

**Input**: `specs/012-image-builders/` (spec.md, plan.md, research.md R1–R7 with the spike results,
data-model.md, contracts/builders.md, quickstart.md, ADR 0015) + features 000–011.

**Numbering**: T1201–T1299.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`.

**Rules for every task:**
- Fixtures never contain secret-shaped literals (`fakeSecret()`, or `{{FAKE:…}}` with
  `materializeFixture()`).
- No test touches the network, a real cloud or a model.
- The spikes' raw results are in `.tools/scratch/012-results-a.md` and `012-results-b.md`
  (gitignored, in the main checkout). The digests and checksums to pin are there and in
  research.md.

## Phase 1: Foundation (serial)

- [X] T1201 Plan fields, runtime versions, the pin table and the pin script in `packages/plan-schema/src/**`, `packages/detect/src/**`, `packages/iac-templates/src/{pins.ts,index.ts}`, `scripts/update-pins.mjs`
  - Owns: those paths (+ tests); `packages/iac-templates/src/index.ts` only for new exports
  - Reads: data-model.md; plan.md "1. Plan, facts and pins"; research.md (pins used, R3 and R7 results); `packages/iac-templates/src/workflow/shared.ts` (the actions and the Trivy image pinned today)
  - Depends: —
  - Accept:
    - **`plan.yaml`** gains `app.build`, `deploy`, `supplyChain`, `cicd.deployTags` and `cicd.imageRetention`, exactly as data-model.md, with zod validation and defaults. Existing plans without these fields still parse: `deploy` defaults to rolling with 30 s, signing off, tags off, and `app.build` absent until design sets it.
    - **`ProjectFacts.runtimeVersions`** gains `ruby`, `go`, `java`, `dotnet`, `php` and `rust`, read from the files in data-model.md. Detect tests use small fixtures per language.
    - **`pins.ts` exports `IMAGES`, `TOOLS`, `ACTIONS`, `RUNTIME_DEFAULTS` and `BUILDPACKS_OFFERS`:**
      - images as `repo:tag@sha256:…`: node 24 and its alpine variant, python, caddy, postgres, valkey, kamal-proxy v0.10.2, cloudflared, trivy, curl, the Paketo Noble builder and run image, the Railpack frontend v0.42.0;
      - tools with per-architecture SHA-256: pack 0.40.9, railpack 0.42.0, the cosign installer;
      - the actions in use, by SHA;
      - `RUNTIME_DEFAULTS` with Node "24".
    - **Pin sources.** Use the spike digests where they exist. Where a digest is not yet known, leave it out and list it in the report; do not invent one. The lead fills it with the script.
    - **`scripts/update-pins.mjs`** resolves tags to digests (registry API) and release checksums (GitHub API) and rewrites `pins.ts`. It is not run in tests, and its parsing helpers have unit tests.
    - **Exports.** `detectStack` is exported from the iac-templates root, for T1203.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/detect --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: high

## Phase 2: Spike on a GitHub runner (lead; runs in parallel with T1201)

- [X] T1202 GitHub-runner spike in the throwaway repository. It answers plan.md "2. The GitHub-runner spike", and the results go into research.md as R8:
  - pack with `project.toml` against `--env`: is the throwaway builder avoided, and what are the cold and warm times?
  - the seal keeping the Buildpacks launcher, and the launcher healthcheck;
  - attestations, read with `imagetools inspect`;
  - Railpack with the frontend pinned by digest;
  - an arm64 Buildpacks build.

## Phase 3: Packages (parallel)

- [X] T1203 [P] [US1] [US3] [US4] [US5] The builder choice, the deploy strategy and the interview questions in `packages/agents/src/{design,interview}/**`
  - Owns: those folders (+ tests)
  - Reads: contracts/builders.md "chooseBuilder"; spec FR-1201, FR-1202, FR-1215, FR-1219, FR-1223, FR-1228; research.md R7 "What this means"
  - Depends: T1201, T1212
  - Accept:
    - **`chooseBuilder`** follows the contract's rules and order. It is pure, and its reason is one plain sentence naming the deciding fact.
    - **Tests** cover the 19 example apps of today plus the six new languages. Use facts objects; the apps arrive in T1208. They include:
      - pnpm and Next.js going to the generated Dockerfile;
      - Spring Boot going to Buildpacks;
      - Rust and Laravel going to Railpack;
      - Ruby 4.0.7 not offered, so Railpack;
      - an own Dockerfile;
      - a user choice kept;
      - a user choice refused for the architecture.
    - **Design** writes `app.build` and `deploy` with their reasons, and shows both. The strategy is rolling unless the server type has less than 1 GiB (or the own server's host facts say so). Portainer is always recreate, with its sentence.
    - **Version resolution** follows FR-1228 rules 1–7:
      - exact as declared;
      - the newest supported version inside a range;
      - evidence before default (T1212's facts);
      - the conservative default from `RUNTIME_DEFAULTS`;
      - a version recorded in `plan.yaml` kept on later designs;
      - an end-of-life warning;
      - a major change only by the user, with a warning.
    - **The interview** offers signing (with the private-repository warning when the repository is private) and deploy tags. Both default to off.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [X] T1204 [P] [US1] [US4] Dockerfile templates, Dependabot and pin carry-over in `packages/iac-templates/src/{docker,dependabot}/**`
  - Owns: those folders (+ tests, snapshots); a new `src/pins-carry.ts` (+ test)
  - Reads: plan.md "4. Dockerfiles, Dependabot and pins"; spec FR-1204, FR-1208, FR-1220–FR-1222, FR-1228; research.md R5 and R7 finding 6
  - Depends: T1201
  - Accept:
    - **Node templates:**
      - use `app.build.runtime.version` (the declared major, else `RUNTIME_DEFAULTS.node`);
      - pin their base by digest. The default runtime images come from `pins.ts`. A declared non-default version (for example `node:20-alpine`) takes its digest from an injected `resolveImageDigest(ref)`, the registry lookup used by adapt in T1207. With no digest (offline), the image falls back to the tag, and the Dockerfile and output say so;
      - install production dependencies only in the runtime stage (npm, pnpm and Yarn), keeping the release command's tool when the release command needs it (for example `prisma`);
      - a test proves no devDependency is in the runtime stage's install for `express-api`.
    - **Python** uses the declared version or the default.
    - **Secret build values** become `RUN --mount=type=secret,id=NAME,env=NAME` lines. Non-secret ones stay `ARG`.
    - **`renderDependabot`:**
      - one entry per detected ecosystem and directory;
      - plus `github-actions`, `docker` (where a Dockerfile is) and `docker-compose` (the runtime folder);
      - weekly, with minor and patch updates grouped per ecosystem;
      - no major updates proposed for the runtime base images (FR-1228 rule 6);
      - a snapshot per kind of example.
    - **`keepNewerPins(committed, rendered)`:** the higher tag wins; on the same tag, the committed digest wins; an older committed pin is replaced. It covers images and actions, with tests.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T1205 [P] [US1] [US2] [US3] [US4] [US5] The build job per builder, the seal, the switch script, signing and deploy tags in `packages/iac-templates/src/workflow/**`
  - Owns: that folder (+ tests, snapshots)
  - Reads: contracts/builders.md "Build job" and "Switch"; plan.md "5. The build job" and "6. The switch"; research.md R3 results, R7 and R8
  - Depends: T1201, T1202
  - Accept:
    - **Build.** Each builder renders as the contract says.
      - Every image is built with buildx, and the final image with `provenance: mode=max`, `sbom: true` and the GHA cache.
      - setup-buildx uses `driver-opts: provenance-add-gha=false`, and the final build's job checks out the code, so the provenance has the repository and commit but no event payload (R8). A test asserts both.
      - pack gets its settings with `--env`, and its digest from `report.toml` (R8). Railpack caches with `type=gha,mode=min`.
      - Buildpacks and Railpack push `build-<sha>`, then seal. Railpack's seal does the `chown` of the framework's writable folders and sets `USER 10001:10001`.
      - Trivy scans the final digest.
      - The deploy uses the final index digest.
      - Every action, image and tool comes from `pins.ts`.
      - `OPSCREW_BUILD_ENV` becomes build args and `OPSCREW_BUILD_SECRETS` becomes secrets. A test proves no secret name reaches `build-args`.
    - **The switch.** `switchCommands` renders rolling and recreate as the contract says: the release command first, then `kamal-proxy deploy` through `docker compose exec -T proxy`. The old container is removed on success, and the new one on failure, with exit 1 and the builder hint (the automatic builder and its `plan.yaml` line). The database and cache are never named in an `up` after the release.
    - **Signing:** a separate job with `id-token: write` and `cosign sign --yes <digest>`, only with `supplyChain.sign`.
    - **Image retention** (FR-1229): a separate job after a healthy deploy, holding only `packages: write`.
      - With `cicd.imageRetention.enabled`, it keeps the newest `keep` deployed `<sha>` versions with their untagged children (attestations, platform manifests). It never deletes the running or the previous digest, and deletes the rest through the GitHub API.
      - It always deletes the `build-<sha>` intermediate versions once the seal is pushed.
      - A test covers the selection logic: an index with children, tags, and the running/previous digests.
    - **Deploy tags:** a separate job after a healthy deploy, holding only `contents: write`. It creates `deploy-<UTC yyyymmdd-hhmmss>` on the commit, plus a release naming the digest when `release`.
    - **Portainer workflow:** it gets the same build. Its deploy stays as today.
    - **Snapshots:** one per builder, per strategy, and per option on and off.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T1206 [P] [US3] [US4] The runtime Compose and Caddy files, kamal-proxy and image pins in `packages/iac-templates/src/{runtime,tunnel,portainer-target}/**`
  - Owns: those folders (+ tests, snapshots)
  - Reads: contracts/builders.md "Switch"; research.md R3 results (the healthcheck forms, memory); spec FR-1211–FR-1214, FR-1220
  - Depends: T1201
  - Accept:
    - **The app service** gets a `healthcheck` in the form for its builder:
      - `node -e` / `python -c` for the generated Dockerfile;
      - `["CMD","/cnb/lifecycle/launcher","--",…]` for Buildpacks;
      - the runtime's own form for Railpack, or the probe the plan names;
      - for an own Dockerfile, its `HEALTHCHECK` is left alone, and Compose adds none when the image has one.
      - It also gets `stop_grace_period: <drainSeconds + 5>s`.
    - **A `proxy` service** (kamal-proxy, pinned) on the internal network with the `kamal-proxy-config` volume and no host ports. Caddy proxies to `proxy:80`, including in tunnel mode.
    - **Pins.** Every service image (postgres, valkey, caddy, cloudflared, curl, kamal-proxy) comes from `pins.ts`, by digest.
    - **Portainer stacks** take the same pins. They get no proxy, since they recreate.
    - **Snapshots** change only by these additions.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T1212 [P] [US1] Runtime-version evidence in `packages/detect/src/**`
  - Owns: that folder (+ tests)
  - Reads: spec FR-1228 rules 2–3 (founder, 2026-10-18: library compatibility)
  - Depends: T1201
  - Accept:
    - **Facts.** `ProjectFacts` records, per language, the declared value as written (exact or range) and the evidence found with its source:
      - the CI workflows' `node-version:` / `python-version:` (setup-node, setup-python);
      - `.tool-versions` and `mise.toml`;
      - the `FROM` of an existing Dockerfile;
      - the `@types/node` major;
      - the Python range of the installed Django, from a small table in detect.
    - **Pure parsing.** The evidence is read deterministically. Every source has a fixture test.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect --filter=@opscrew/agents`
  - Effort: medium

## Phase 4: Flows

- [X] T1207 [US1] [US2] [US4] Adapt, provision, retarget and status wiring, and the own-Dockerfile checks, in `packages/agents/src/{adapt,provision,retarget,status,shared,portainer}/**`, `packages/secops/src/rules/**`
  - Owns: those paths (+ tests); the import lines that follow in `packages/cli/src/**` and `packages/mcp-server/src/**`
  - Reads: plan.md "7. Wiring"; spec FR-1202, FR-1205, FR-1206, FR-1221, FR-1222
  - Depends: T1203, T1204, T1205, T1206
  - Accept:
    - **adapt:**
      - writes the Dockerfile only for `generated-dockerfile`;
      - resolves the digest of a declared non-default runtime image through the registry (an injected fetch, faked in tests) before rendering; offline, it warns that the image is pinned by tag only;
      - passes the committed files through `keepNewerPins`;
      - adds `dependabot.yml` when absent, or lists the entries it would add (moved to provision's deploy-setup pull request by T1214);
      - adds the runtime version file (`.nvmrc`, `.python-version`, …) with the recorded version when the repository has none;
      - checks an own Dockerfile against the baseline, listing each finding with its fix. The new secops rule is a base image not pinned by digest.
    - **provision:**
      - hands `app.build`, `deploy`, `supplyChain` and `cicd.deployTags` to the workflow and runtime renderers;
      - keeps newer pins in the committed workflow and runtime files;
      - splits the build values into the two secrets: secret by the existing classification, non-secret otherwise.
      - sets the new `OPSCREW_BUILD_SECRETS` repository secret next to `OPSCREW_BUILD_ENV` in provision, and removes it in destroy (`DEPLOY_SECRETS.buildSecrets`);
    - **retarget** runs `chooseBuilder` for the new architecture before anything is created. A change of builder is shown and approved with the plan.
    - **status** shows the builder and the deploy strategy.
    - **Every target** works: Hetzner, DigitalOcean, own server and Portainer.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: xhigh

## Phase 5: Examples, surfaces and live tests

- [X] T1208 [US1] Six new examples and the Docker pass with builders in `examples/**`, `packages/cli/test/e2e/**`
  - Owns: those paths
  - Reads: `examples/README.md`; `.tools/scratch/012-examples/**` and `012-results-a.md` (the spike's notes); plan.md "8. Examples"
  - Depends: T1207
  - Accept:
    - **The six apps** move into `examples/`: `go-api`, `rails-api`, `laravel-app`, `spring-boot-api`, `dotnet-api` and `rust-api`.
      - Each has `expected.json`, which includes the expected builder.
      - Fixes first: Laravel's `composer.lock` is refreshed for `php ^8.4`; Rails pins a Ruby version the pinned Buildpacks builder offers.
      - No secret-shaped literal. Rails credentials and Laravel's `.env` are never committed.
    - **The e2e examples test** checks detection and the chosen builder for every example.
    - **The Docker pass** (`OPSCREW_DOCKER_TESTS=1`) builds every example with its builder, using the pinned tools in containers. It checks that:
      - the app runs as non-root;
      - `/health` answers on `PORT`;
      - Node images hold no devDependency;
      - for `nextjs-postgres` with Prisma: `npx --no-install prisma --version` runs, and the Prisma engine files are in the image. A future npm may block install scripts that are not allow-listed (npm 11.19 already warns), and this check catches it when the Node pin moves.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` (the Docker pass skipped without the flag)
  - Effort: high

- [X] T1209 [US1] [US2] [US3] [US4] [US5] The CLI, MCP tools, plugin and guide in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`
  - Owns: those paths (+ tests)
  - Reads: spec FR-1224, FR-1226; research.md R7 (the comparison table); quickstart.md
  - Depends: T1207
  - Accept:
    - **The CLI and MCP** show the builder, the strategy and the supply-chain settings, with their reasons, and accept the `plan.yaml` overrides.
    - **`repositoryPrivate`:** the CLI and MCP pass it into the interview (`InterviewOptions.repositoryPrivate`), read from GitHub's repository API, so the signing question shows the public-log warning for a private repository.
    - **The plugin's** deploy skill mentions the builder choice and zero-downtime deploys.
    - **New guide pages:**
      - `builders.md`: the choice and its order, the comparison table from R7, how to switch, the baseline, own Dockerfiles;
      - `zero-downtime.md`: the switch, the drain, migrations staying compatible, WebSockets being cut, requests longer than 300 s being cut, the recreate case and Portainer;
      - `supply-chain.md`: the read commands for the SBOM and provenance, signing and its warning, Dependabot, deploy tags.
    - **README** links the three pages from its "What OpsCrew does" section, at most one line each.
    - `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server` and `node plugin/validate.mjs`
  - Effort: high

- [X] T1210 [US1] [US3] [US4] Live tests for the builders, zero-downtime under load, a broken release and the attestations in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: plan.md "10. Live tests"; quickstart.md "Live"
  - Depends: T1208, T1209
  - Accept:
    - **The Hetzner pass** runs with `OPSCREW_E2E_APP` set to `nextjs-postgres`, `go-api` or `rust-api`, and checks that the expected builder was used.
    - **Under load:** a merged change deploys under a steady load (20 requests per second through the domain, logging every failure), and no request fails.
    - **A broken release:** a commit whose health route fails deploys. No request fails, the run fails with the builder hint, and the previous version still answers.
    - **Attestations:** the SBOM and provenance are read with the guide's command. The provenance names the repository and commit.
    - **Non-root:** the running container's user is not root.
    - **The leak search** covers the attestations.
    - **From T1205, to confirm live:**
      - pack with `repo:tag@sha256` builder and run-image refs;
      - Railpack keeping a secret whose value is empty at `prepare`;
      - image retention on an org-owned package (the `/orgs` endpoints);
      - kamal-proxy's `--target-timeout 300s` letting a 60 s request through.
      - a cosign signature surviving a prune (cosign v3 may store signatures as OCI referrers without a `sha256-*` tag);
      - after `build-<sha>` is deleted, the sealed image still pulling on a clean host (GHCR kept the shared layers).
    - **Docs.** `docs/e2e.md` documents the runs, and the coverage page marks them "added, not yet run live".
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` (live parts skipped)
  - Effort: high

- [X] T1213 [US1] Fixes from T1208's real Docker pass in `packages/iac-templates/src/workflow/**`, `packages/iac-templates/{src,scripts}` (`TOOL_RELEASES`), the agents' app-environment defaults, `packages/cli/test/e2e/**`
  - Reads: T1208's report (the lead summarises it in the brief); research.md R7
  - Depends: T1208
  - Accept:
    - **Laravel on Railpack:**
      - the PHP seal also makes `public` writable for uid 10001 (changed in review: `public` stays root's and the seal makes the `public/storage` link that `storage:link` needs);
      - it drops the file capabilities of FrankenPHP's binary (copy it over itself), since the app listens on its port (8080 by default), not on a low one;
      - the app then starts under `cap_drop: ALL` and no-new-privileges.
    - **Production defaults for Rails and Laravel**, through OpsCrew's existing derived and generated values:
      - Rails gets `RAILS_ENV=production`, and a generated `SECRET_KEY_BASE` (128 hex characters);
      - Laravel gets `APP_ENV=production`, `APP_DEBUG=false`, `LOG_CHANNEL=stderr` and a generated `APP_KEY` (`base64:` + 32 random bytes);
      - a value the user already set wins;
      - generated values are stored like the others and never printed.
    - **One `TOOL_RELEASES`:** it moves from the pin script's helpers into `packages/iac-templates/src` and is exported. The pin script, the workflow and the e2e Docker pass use it, with no copied download URLs.
    - **The Docker pass's dev-dependency check** accepts a devDependency that npm keeps because a production package lists it as a peer (`npm explain`). react-router-ssr's `typescript` passes.
    - **Rerun** the Docker pass for laravel-app, rails-api and react-router-ssr; all three pass every check.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents --filter=opscrew`, plus the Docker pass for the three apps with `OPSCREW_DOCKER_TESTS=1`
  - Effort: high

- [X] T1214 [US3] Dependabot's configuration arrives with the files it watches, in `packages/agents/src/{adapt,provision}/**`, `packages/iac-templates/src/dependabot/**`, `docs/guide/supply-chain.md`
  - Reads: spec FR-1221 (changed by the lead); plan §7; data-model's file table; `adapt/build-files.ts` `dependabotStep`; `provision/steps.ts` `publishDeployment`, `provision/publish.ts` `publishDeploySetup`
  - Depends: T1213 (merged)
  - Why: in T1211's live runs every first Dependabot run of `github_actions` and `docker_compose` failed ("/.github/workflows/<anything>.yml not found"; no `opscrew/runtime`). The adapt pull request adds `dependabot.yml`, and Dependabot checks at once, but the workflow and the runtime files come later, with provision's deploy-setup pull request. A user sees two failed Dependabot runs after merging the adapt pull request.
  - Accept:
    - adapt no longer writes `.github/dependabot.yml`, and its pull request body no longer mentions it;
    - provision runs `dependabotStep` and adds the file to the deploy-setup pull request's files when the repository has none. When the repository has one, it is left as it is, and the deploy-setup pull request body and provision's output list the missing entries, with the same wording adapt used;
    - a rerun of provision, after OpsCrew's file is committed, leaves it as it is;
    - **Portainer:** Dependabot reads only the default branch. Check where a Portainer target's Compose file is on that branch. If it is only on the orphan `opscrew-deploy` branch, the `docker-compose` entry points at no folder on the default branch, so leave it out for Portainer, with a comment that says why; otherwise point it at that folder;
    - `docs/guide/supply-chain.md` says the deploy-setup pull request adds the file;
    - tests: adapt writes no Dependabot file; provision's deploy-setup files include it when absent and not when present; the Portainer entry rule.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents --filter=opscrew`
  - Effort: high

- [X] T1211 Live runs (lead): the Hetzner pass with the three apps; the own-server and Portainer core passes, to check the new switch, pins and builds there; results in `docs/e2e.md` and `docs/e2e-coverage.md`

## Phase 6: End-of-feature review fixes

Four read-only reviewers (iac-templates; agents, plan-schema and detect; CLI, MCP, plugin, secops and docs; spec coverage) reviewed `e459f77..main` on 2026-10-19. The lead fixed the artefact drift in the spec, plan, data model, contract, quickstart and ADR. T1215–T1217 have disjoint Owns and run in parallel; T1218 follows.

- [X] T1215 [US1] Design keeps what the user chose, and the builder choice's gaps, in `packages/agents/src/**`, `packages/detect/src/**`, `packages/plan-schema/src/**`
  - Reads: spec FR-1201, FR-1202, FR-1206, FR-1215, FR-1219, FR-1228; `design/{builder,plan,run,strategy}.ts`, `interview/questions.ts`, `shared/phase-status.ts`
  - Depends: T1214
  - Accept:
    - **Only a production Dockerfile counts as the app's own.** `.devcontainer/**` and `Dockerfile.dev`, `.development`, `.test` and `.local` never become `docker.dockerfile` or `own-dockerfile`. Today an Express app whose only Dockerfile is `.devcontainer/Dockerfile` deploys the dev-container image. Fix it where it is smallest (detect or `chooseBuilder`), and make sure `app.dockerfile` never points at such a file.
    - **A later `opscrew design` keeps the user's edits:**
      - `app.dockerfile` when `app.build.chosen` is `user` and the builder is `own-dockerfile`;
      - for each `app.env` variable that still exists, its `secret`, `source` and `optional` (so `secret: true` on a build value and `source: user` on a Rails or Laravel production setting survive);
      - `deploy.strategy: rolling` that the user set on an own server. Drop `ownRolling` or record who chose the strategy, whichever is smaller.
    - **Rerunning the interview keeps `supplyChain.sign` and `cicd.deployTags` set in `plan.yaml`.** The interview's defaults for `signImages` and `deployTags` come from `plan.yaml` when it exists.
    - **The failure hint can name a builder for an own Dockerfile.** `app.build.automatic` is the builder OpsCrew would choose without the Dockerfile, not `own-dockerfile`.
    - **An app in a subfolder** (not a JavaScript workspace member) built with Buildpacks or Railpack gets `app.buildContext` = its folder, so `pack build --path` and `railpack prepare` build the app, not the repository root.
    - **The user's Buildpacks choice for PHP is refused with a reason.** The pinned Noble builder has no PHP; today design only warns.
    - **A Procfile with process types other than `web` and `release`** gives a design warning: OpsCrew deploys the web process only, and workers come with the component model (013).
    - **FR-1219 on the `plan.yaml` route:** the "Image signing: off" status line also carries the public-log warning (one fixed text).
    - **`app.build.probe` is required** whenever `app.build` is present. Nothing is released, so there is no migration.
    - **Simplify:**
      - `OptionToPlanInput.build` is required;
      - the branches for plans "from before the builder choice" go (`deriveCodeChanges`'s undefined builder, `PullRequestBuild.builder?` and its `?? "generated-dockerfile"`, the optional `retarget.from.deploy`/`from.build` and their restore branches);
      - remove the root exports nobody outside the package imports (`chooseBuilder`, `BuildArch`, `BuilderChoice`, `signingPublicLog`), unless the CLI or MCP import them;
      - inline `deploySentence(deploy, deploy)` in `retarget/start.ts`.
    - Tests for each item: the dev-container case; the design reruns keeping each edit; the interview defaults; `automatic` for Next.js with a Dockerfile; the subfolder Go app's `buildContext`; the PHP refusal; the Procfile warning; the signing line.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/detect --filter=@opscrew/agents --filter=@opscrew/mcp-server --filter=opscrew`
  - Effort: xhigh

- [X] T1216 [US1] Pinned build tools and the workflow's last gaps, in `packages/iac-templates/**`
  - Reads: spec FR-1203, FR-1206, FR-1220, FR-1222, FR-1228; `src/docker/stacks.ts`, `src/pins.ts`, `src/pins-carry.ts`, `src/workflow/{build,switch}.ts`, `src/runtime/healthcheck.ts`
  - Depends: T1214
  - Accept:
    - **Every build tool is pinned (FR-1203):**
      - `poetry`, `uv`, `pipenv` and `uvicorn` are installed at versions held in `pins.ts`, following `GUNICORN_VERSION`'s pattern;
      - when `package.json` has no `packageManager`, the Dockerfile runs `corepack prepare pnpm@<pin> --activate`, and the same for Yarn, instead of fetching the newest;
      - `scripts/update-pins.mjs` refreshes these pins, if that is cheap (PyPI's and npm's JSON). Otherwise report it.
    - **pack is checked against OpsCrew's own checksum.** It is installed like Railpack (download, `sha256sum -c` against `TOOLS.pack.sha256[arch]`), and `ACTIONS.setupPack` goes.
    - **A carried-over pin never changes the major version of an image Dependabot keeps on its major** (`NO_MAJOR_UPDATES`: caddy, node, postgres, python; share the list). Example: a committed `postgres:17` stays when OpsCrew's pin moves to 18.
    - **Yarn 2 and 3:** `yarn workspaces focus` is used only where it works (Yarn 4, or with the workspace-tools plugin). Otherwise a plain install, or a plain error that says what to do.
    - **One probe table:** `runtime/healthcheck.ts` uses `app.build.probe` (required after T1215; write `plan.app.build?.probe ?? "none"`) and drops its own table, so a static site's Caddy image gets no `node` probe.
    - **The failed-deploy hint** (`workflow/switch.ts`) names only `app.build.automatic` and says: set `app.build.builder` in `opscrew/plan.yaml`, then run `opscrew design`, `opscrew adapt` and `opscrew provision`. The wrong-port message names `app.port` in `opscrew/plan.yaml`.
    - **Railpack gets the recorded runtime version** (FR-1228), if Railpack v0.42.0 has a version setting per language (check its docs or source, official sources only). If it has none, report it, and the lead narrows FR-1228.
    - **Simplify:**
      - delete `IMAGES.node` (move its comment to `nodeAlpine`);
      - import `IMAGES`, `TOOLS` and `ACTIONS` directly instead of the aliases (`CHECKOUT_ACTION`, `DEFAULT_TRIVY_IMAGE`, `CLOUDFLARED_VERSION`, `CLOUDFLARED_SHA256`, `cloudflaredUrl`, `POSTGRES_IMAGE`, `VALKEY_IMAGE`, `CADDY_IMAGE`);
      - the retention script interpolates `DIGEST_REF_PATTERN` and `MANIFEST_ACCEPT` instead of repeating them;
      - unexport `registryOf`, `MANIFEST_ACCEPT` and `parseBearerChallenge`, unless used outside the file;
      - drop the unused `ImageKey` and `ActionKey`, the `TODO(pins)` handling and the by-tag action branch in the pin script, and `BP_PHP_VERSION`.
    - Rerun the Docker pass for the examples the Dockerfile changes touch: at least one each for pip/Poetry/uv/Pipenv if examples use them, one pnpm and one Yarn example. Same hygiene as T1213: remove only what the pass created, by id.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents --filter=opscrew`, plus that Docker pass
  - Effort: xhigh

- [X] T1217 [US4] Guide, plugin, secops and the test harnesses, in `docs/guide/**`, `README.md`, `plugin/**`, `packages/secops/**`, `packages/cli/test/**`
  - Reads: the guide's `builders.md`, `zero-downtime.md`, `supply-chain.md`, `domains.md`; `plugin/skills/opscrew-adapt/SKILL.md`; `packages/secops/src/rules/config.ts`; `packages/cli/test/live/{support,builder-checks,harness,live.test}.ts`, `packages/cli/test/e2e/docker.test.ts`
  - Depends: T1214
  - Accept:
    - **Guide:**
      - a short section (in `builders.md`, or its own page) on the production values OpsCrew sets: Rails `RAILS_ENV=production` and a generated `SECRET_KEY_BASE`; Laravel `APP_ENV=production`, `APP_DEBUG=false`, `LOG_CHANNEL=stderr` and a generated `APP_KEY`. Say how to override them: a value in the non-interactive `OPSCREW_APP_ENV_FILE` wins, or set the variable's `source: user` in `plan.yaml`, which a later `design` keeps (T1215);
      - `supply-chain.md`: `--certificate-identity` uses GitHub's own spelling of `<owner>/<repo>`, not lower case. Say that Dependabot cannot update the workflow's own pins (Paketo builder and run images, the Railpack frontend, the pack and Railpack versions, Trivy): those move with OpsCrew's releases;
      - `builders.md`: a `go` line in `go.mod` is a minimum within its release line, as the code does it;
      - `domains.md`: drop the duplicate "Settings only the registrar's dashboard can change" section;
      - README step 5: adapt brings the Dockerfile or the runtime version file, as the builder needs.
    - **Plugin:** the adapt skill no longer says "pinned major base image (`node:22-alpine`, `python:3.13-slim`)". It says what 012 does (digest pins, the app's declared version, else OpsCrew's default), and its health-route list adds Go, Java, .NET and Rust. `node plugin/validate.mjs` passes.
    - **secops:**
      - a secret-looking `ARG` (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*_KEY`), even without a value, is flagged with the BuildKit secret-mount fix;
      - `isTagOnly` folds into `imageTagProblem` (a third result);
      - the latest-tag remediation suggests the digest form.
    - **Test harnesses:**
      - `EXPECTED_BUILDERS` reads each example's `expected.json`;
      - the builder checks' `knownSecrets` fails loudly when the plan has generated variables and `generated_values.json` is missing;
      - one run-id helper for `harness.ts` and `live.test.ts`;
      - the live builder checks also check that a merged change's deploy does not restart `db`, `cache`, `proxy` or `caddy` (each container's `StartedAt` before and after);
      - the Docker pass searches each built image's history (`docker history --no-trunc`) and config (`docker image inspect`) for the example's known secret values. Run that pass for one example per builder, with T1213's hygiene.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops --filter=opscrew`, `node plugin/validate.mjs`, plus that Docker pass
  - Effort: high

- [X] T1219 [US1] pnpm and Yarn without corepack, and no download when the app starts, in `packages/iac-templates/src/docker/**`
  - Reads: spec FR-1203, FR-1204, FR-1228; T1216's report (the lead's brief); `src/docker/stacks.ts` (`pinnedPackageManager`, `jsInstall`, the node-server runtime stage), `src/pins.ts` `PACKAGE_MANAGERS`
  - Depends: T1216
  - Why: T1216 found that Node 25 and later ship no corepack (nodejs.org), so a pnpm or Yarn app on Node 26, which becomes LTS in late October 2026, fails at `corepack enable`. pnpm 12 also downloads a native binary on its first run, and Yarn 4 with `packageManager` downloads Yarn at every container start, so the app needs the network to start.
  - Accept:
    - the build stage installs the package manager without corepack: the version `packageManager` names, else the pin, installed with the image's npm (`npm install -g <pm>@<version>`), on every Node version;
    - the runtime stage needs no download to start: it runs the app's start script without a package manager where the script is plain (`npm run <script>`, or the script's own command). Where the app does need the package manager at run time (Yarn PnP, which needs Yarn's loader), the pinned one is installed into the image at build time;
    - corepack goes from both stages, unless something still needs it;
    - snapshot and unit tests: Node 24 and Node 26 bases, pnpm and Yarn, with and without `packageManager`, and Yarn PnP if OpsCrew supports it today;
    - the Docker pass for `monorepo-two-apps` (pnpm) and one npm example, plus a scratch build on Node 26 with pnpm, started with no network (`docker run --network none`) and answering on its health route. Same hygiene as T1213.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=opscrew`, plus that Docker pass
  - Effort: high

- [ ] T1220 [US2] The hint switches the builder, and no `.git` in a Buildpacks image, in `packages/iac-templates/src/workflow/**`, `packages/iac-templates/src/portainer-target/stack.ts`
  - Reads: the review of T1216's merged commit (the lead's brief); spec FR-1203, FR-1206; `src/workflow/{switch,build}.ts`; `packages/agents/src/design/builder.ts` (`chosen: user`)
  - Depends: T1216
  - Accept:
    - the failed-deploy hint says to set `app.build.builder: <automatic>` **with `app.build.chosen: user`** in `opscrew/plan.yaml`, then run design, adapt and provision. Design keeps a user's builder only with `chosen: user`. The test that asserts the hint has no "chosen" is changed;
    - **no `.git` in a Buildpacks image.** pack uploads the whole `--path`, and a committed secret file stays in `.git/objects` after the working copy is removed. While pack runs, `.git` is moved out of the build context when it is inside it, and moved back before the seal, whose provenance needs it. Restore it with a trap, so it is back even when pack fails;
    - a local pack build confirms it: a git checkout of a copy of `go-api` with a committed planted file, then `docker run --rm --entrypoint ls <image> -a /workspace` shows no `.git` and no planted file. Same Docker hygiene as before;
    - `CURL_IMAGE` (`src/portainer-target/stack.ts`) becomes `IMAGES.curl.ref`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=opscrew`, plus that pack build
  - Effort: high

- [ ] T1218 Live check after the fixes (lead): one Hetzner builder pass (`go-api` or `nextjs-postgres`) with the new restart check, and the Docker pass for a handful of examples; results in `docs/e2e.md` and `docs/e2e-coverage.md`

## Dependencies

{T1201, T1202} → {T1212 → T1203, T1204, T1205, T1206} → T1207 → {T1208, T1209} → T1210 → T1211.
T1201 and T1202 run in parallel. T1205 needs T1202's R8; T1203 needs T1212; T1204 and T1206 need
only T1201. Then T1213 → T1214 → {T1215, T1216, T1217} → {T1219, T1220} (after T1216) → T1218.
