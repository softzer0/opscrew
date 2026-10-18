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

- [ ] T1201 Plan fields, runtime versions, the pin table and the pin script in `packages/plan-schema/src/**`, `packages/detect/src/**`, `packages/iac-templates/src/{pins.ts,index.ts}`, `scripts/update-pins.mjs`
  - Owns: those paths (+ tests); `packages/iac-templates/src/index.ts` only for new exports
  - Reads: data-model.md; plan.md "1. Plan, facts and pins"; research.md (pins used, R3 and R7 results); `packages/iac-templates/src/workflow/shared.ts` (the actions and the Trivy image pinned today)
  - Depends: —
  - Accept:
    - **`plan.yaml`** gains `app.build`, `deploy`, `supplyChain` and `cicd.deployTags`, exactly as data-model.md, with zod validation and defaults. Existing plans without these fields still parse: `deploy` defaults to rolling with 30 s, signing off, tags off, and `app.build` absent until design sets it.
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

- [ ] T1202 GitHub-runner spike in the throwaway repository. It answers plan.md "2. The GitHub-runner spike", and the results go into research.md as R8:
  - pack with `project.toml` against `--env`: is the throwaway builder avoided, and what are the cold and warm times?
  - the seal keeping the Buildpacks launcher, and the launcher healthcheck;
  - attestations, read with `imagetools inspect`;
  - Railpack with the frontend pinned by digest;
  - an arm64 Buildpacks build.

## Phase 3: Packages (parallel)

- [ ] T1203 [P] [US1] [US3] [US4] [US5] The builder choice, the deploy strategy and the interview questions in `packages/agents/src/{design,interview}/**`
  - Owns: those folders (+ tests)
  - Reads: contracts/builders.md "chooseBuilder"; spec FR-1201, FR-1202, FR-1215, FR-1219, FR-1223, FR-1228; research.md R7 "What this means"
  - Depends: T1201
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
    - **The interview** offers signing (with the private-repository warning when the repository is private) and deploy tags. Both default to off.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [ ] T1204 [P] [US1] [US4] Dockerfile templates, Dependabot and pin carry-over in `packages/iac-templates/src/{docker,dependabot}/**`
  - Owns: those folders (+ tests, snapshots); a new `src/pins-carry.ts` (+ test)
  - Reads: plan.md "4. Dockerfiles, Dependabot and pins"; spec FR-1204, FR-1208, FR-1220–FR-1222, FR-1228; research.md R5 and R7 finding 6
  - Depends: T1201
  - Accept:
    - **Node templates:**
      - use `app.build.runtime.version` (the declared major, else `RUNTIME_DEFAULTS.node`);
      - pin their base by digest from `pins.ts`;
      - install production dependencies only in the runtime stage (npm, pnpm and Yarn), keeping the release command's tool when the release command needs it (for example `prisma`);
      - a test proves no devDependency is in the runtime stage's install for `express-api`.
    - **Python** uses the declared version or the default.
    - **Secret build values** become `RUN --mount=type=secret,id=NAME,env=NAME` lines. Non-secret ones stay `ARG`.
    - **`renderDependabot`:**
      - one entry per detected ecosystem and directory;
      - plus `github-actions`, `docker` (where a Dockerfile is) and `docker-compose` (the runtime folder);
      - weekly, with minor and patch updates grouped per ecosystem;
      - a snapshot per kind of example.
    - **`keepNewerPins(committed, rendered)`:** the higher tag wins; on the same tag, the committed digest wins; an older committed pin is replaced. It covers images and actions, with tests.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [ ] T1205 [P] [US1] [US2] [US3] [US4] [US5] The build job per builder, the seal, the switch script, signing and deploy tags in `packages/iac-templates/src/workflow/**`
  - Owns: that folder (+ tests, snapshots)
  - Reads: contracts/builders.md "Build job" and "Switch"; plan.md "5. The build job" and "6. The switch"; research.md R3 results, R7 and R8
  - Depends: T1201, T1202
  - Accept:
    - **Build.** Each builder renders as the contract says.
      - Every image is built with buildx, and the final image with `provenance: mode=max`, `sbom: true` and the GHA cache.
      - Buildpacks and Railpack push `build-<sha>`, then seal. Railpack's seal does the `chown` of the framework's writable folders and sets `USER 10001:10001`.
      - Trivy scans the final digest.
      - The deploy uses the final index digest.
      - Every action, image and tool comes from `pins.ts`.
      - `OPSCREW_BUILD_ENV` becomes build args and `OPSCREW_BUILD_SECRETS` becomes secrets. A test proves no secret name reaches `build-args`.
    - **The switch.** `switchCommands` renders rolling and recreate as the contract says: the release command first, then `kamal-proxy deploy` through `docker compose exec -T proxy`. The old container is removed on success, and the new one on failure, with exit 1 and the builder hint (the automatic builder and its `plan.yaml` line). The database and cache are never named in an `up` after the release.
    - **Signing:** a separate job with `id-token: write` and `cosign sign --yes <digest>`, only with `supplyChain.sign`.
    - **Deploy tags:** a separate job after a healthy deploy, holding only `contents: write`. It creates `deploy-<UTC yyyymmdd-hhmmss>` on the commit, plus a release naming the digest when `release`.
    - **Portainer workflow:** it gets the same build. Its deploy stays as today.
    - **Snapshots:** one per builder, per strategy, and per option on and off.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [ ] T1206 [P] [US3] [US4] The runtime Compose and Caddy files, kamal-proxy and image pins in `packages/iac-templates/src/{runtime,tunnel,portainer-target}/**`
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

## Phase 4: Flows

- [ ] T1207 [US1] [US2] [US4] Adapt, provision, retarget and status wiring, and the own-Dockerfile checks, in `packages/agents/src/{adapt,provision,retarget,status,shared,portainer}/**`, `packages/secops/src/rules/**`
  - Owns: those paths (+ tests); the import lines that follow in `packages/cli/src/**` and `packages/mcp-server/src/**`
  - Reads: plan.md "7. Wiring"; spec FR-1202, FR-1205, FR-1206, FR-1221, FR-1222
  - Depends: T1203, T1204, T1205, T1206
  - Accept:
    - **adapt:**
      - writes the Dockerfile only for `generated-dockerfile`;
      - passes the committed files through `keepNewerPins`;
      - adds `dependabot.yml` when absent, or lists the entries it would add;
      - checks an own Dockerfile against the baseline, listing each finding with its fix. The new secops rule is a base image not pinned by digest.
    - **provision:**
      - hands `app.build`, `deploy`, `supplyChain` and `cicd.deployTags` to the workflow and runtime renderers;
      - keeps newer pins in the committed workflow and runtime files;
      - splits the build values into the two secrets: secret by the existing classification, non-secret otherwise.
    - **retarget** runs `chooseBuilder` for the new architecture before anything is created. A change of builder is shown and approved with the plan.
    - **status** shows the builder and the deploy strategy.
    - **Every target** works: Hetzner, DigitalOcean, own server and Portainer.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: xhigh

## Phase 5: Examples, surfaces and live tests

- [ ] T1208 [US1] Six new examples and the Docker pass with builders in `examples/**`, `packages/cli/test/e2e/**`
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
      - Node images hold no devDependency.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` (the Docker pass skipped without the flag)
  - Effort: high

- [ ] T1209 [US1] [US2] [US3] [US4] [US5] The CLI, MCP tools, plugin and guide in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`
  - Owns: those paths (+ tests)
  - Reads: spec FR-1224, FR-1226; research.md R7 (the comparison table); quickstart.md
  - Depends: T1207
  - Accept:
    - **The CLI and MCP** show the builder, the strategy and the supply-chain settings, with their reasons, and accept the `plan.yaml` overrides.
    - **The plugin's** deploy skill mentions the builder choice and zero-downtime deploys.
    - **New guide pages:**
      - `builders.md`: the choice and its order, the comparison table from R7, how to switch, the baseline, own Dockerfiles;
      - `zero-downtime.md`: the switch, the drain, migrations staying compatible, WebSockets being cut, the recreate case and Portainer;
      - `supply-chain.md`: the read commands for the SBOM and provenance, signing and its warning, Dependabot, deploy tags.
    - **README** links the three pages from its "What OpsCrew does" section, at most one line each.
    - `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server` and `node plugin/validate.mjs`
  - Effort: high

- [ ] T1210 [US1] [US3] [US4] Live tests for the builders, zero-downtime under load, a broken release and the attestations in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
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
    - **Docs.** `docs/e2e.md` documents the runs, and the coverage page marks them "added, not yet run live".
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` (live parts skipped)
  - Effort: high

- [ ] T1211 Live runs (lead): the Hetzner pass with the three apps; the own-server and Portainer core passes, to check the new switch, pins and builds there; results in `docs/e2e.md` and `docs/e2e-coverage.md`

## Dependencies

{T1201, T1202} → {T1203, T1204, T1205, T1206} → T1207 → {T1208, T1209} → T1210 → T1211. T1201 and
T1202 run in parallel; T1205 needs T1202's R8, while T1203, T1204 and T1206 need only T1201.
