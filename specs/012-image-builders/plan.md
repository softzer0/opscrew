# Implementation Plan: Image builders, zero-downtime deploys and the image supply chain

**Branch**: `main` | **Date**: 2026-10-18 | **Spec**: `specs/012-image-builders/spec.md` |
**Research**: `specs/012-image-builders/research.md` (R1–R7 with the two spikes' results)

## Summary

**Builders.** OpsCrew picks one of three builders per project, deterministically:
1. its own generated Dockerfile for its Node and Python stacks;
2. Paketo Buildpacks for Go, Java, .NET and Ruby;
3. Railpack for everything else.

**Sealing.** Every image ends in one "seal" build through `docker/build-push-action`. The seal
attaches an SBOM and a provenance record to the image in GHCR. For Railpack it also sets a non-root
user. So every builder meets the same baseline: non-root, pinned, no secrets, scanned.

**Pins.** One table holds every image and tool OpsCrew uses, pinned by digest or checksum. Dependabot
keeps the user's copies current, and OpsCrew never reverts a newer pin.

**Zero-downtime switch.** On server targets, the switch runs through **kamal-proxy** behind Caddy:
the new copy gets traffic only once healthy, and the old one is drained, then removed. Signing is
opt-in, and deploy tags are off by default.

## Technical Context

- **Stack:** the same as 000–011. No new package, and no new runtime dependency in the CLI.
- **Where the new tools run:** pack, Railpack, kamal-proxy and cosign run only in the user's GitHub
  Actions or on the user's server. They are pinned by version and digest, and downloaded tools are
  checked by checksum.
- **Licenses:** pack and Paketo are Apache-2.0, Railpack and kamal-proxy MIT, cosign Apache-2.0. None
  is linked into the CLI.
- **Measured facts:** builder sizes, users, non-root behaviour, arm64 variants, the docker-rollout
  versus kamal-proxy results and memory are in research R3 and R7.
- **To verify on a GitHub runner** (T1202):
  - pack with a `project.toml` instead of `--env` (R7 finding 1);
  - the seal keeping the Buildpacks launcher;
  - attestations visible in GHCR;
  - Railpack's frontend pinned by digest;
  - an arm64 Buildpacks build.
- **Tests:** fakes and snapshots as before. The local Docker pass (`OPSCREW_DOCKER_TESTS=1`) builds
  every example with its chosen builder. The gated live tests run on Hetzner.

## Constitution Check

- **I (safety gate).** No new mutation path:
  - Builds, deploys, signing and tags run in the workflow that `provision` writes and the user
    merges.
  - kamal-proxy is part of the runtime Compose file that the provision pull request carries.
  - Server changes for the own-server target stay in the host plan.
  - The deploy script only replaces the app's containers. It never touches the database, the cache
    or the proxy.
- **II (user owns everything).** Every generated file is plain and in the repository: the
  Dockerfile, `project.toml` when needed, the seal step, Compose and Caddy files, and
  `dependabot.yml`. Builders and versions are in `plan.yaml` and can be changed there. The user's own
  Dockerfile and own `dependabot.yml` are never rewritten.
- **III (dual engine).** No HCL change beyond what the runtime files need. Both engines still
  validate every root.
- **IV (secrets).** Secret build values reach the build only as BuildKit secret mounts, never as
  build args (mode=max provenance records build args). The leak search covers the image layers,
  config and attestations, and signing never sends a secret.
- **V (deterministic first).**
  - The builder choice, the versions, the deploy strategy and Dependabot are pure functions of the
    facts and the plan.
  - The model is still only used for code changes the templates cannot make.
- **VI (contracts first).** The new `plan.yaml` fields and `ProjectFacts.runtimeVersions` change in
  one serial task (T1201), recorded in ADR 0015.
- **VIII (typed adapters).** Nothing new mutates through a provider API.
- **IX (plain language).** Every choice has a one-sentence reason. Every fallback says what was
  missing. A failed deploy names the builder to switch to.
- **X (simplicity).**
  - One seal step instead of per-builder attestation tools.
  - One pin table.
  - kamal-proxy only for the switch: Caddy keeps TLS.
  - No new CLI command.
  - The comparison numbers decided the order, so builders are not run speculatively.

## Project Structure

| Package | Change |
|---|---|
| `packages/plan-schema` | `app.build` (builder, chosen, reason, runtime), `deploy` (strategy, drainSeconds, reason), `supplyChain.sign`, `cicd.deployTags`; `ProjectFacts.runtimeVersions` for Ruby, Go, Java, .NET, PHP, Rust (T1201) |
| `packages/detect` | read every language's version file (T1201) |
| `packages/iac-templates` | `pins.ts` (one table: images by tag@digest, tools by version and checksum, actions by SHA), runtime defaults per language, the Buildpacks version matrix (T1201) |
| `scripts/update-pins.mjs`, `docs/adr/0015-image-builders.md` | the pin refresh script and the ADR (T1201, lead) |
| — | the GitHub-runner spike in the throwaway repository (T1202, lead) |
| `packages/agents` (design) | `chooseBuilder` and the deploy strategy; interview questions for signing and tags (T1203) |
| `packages/iac-templates` (docker) | Node templates on the declared or LTS version with no dev dependencies; digest pins; secret mounts; `renderDependabot`; `keepNewerPins` (T1204) |
| `packages/iac-templates` (workflow) | the build job per builder with the seal, Trivy on the final digest, signing, the deploy-tags job, and the failure message naming the builder (T1205) |
| `packages/iac-templates` (runtime) | the `proxy` service (kamal-proxy), Caddy to proxy, the app healthcheck and `stop_grace_period`, the rolling and recreate deploy script (T1206) |
| `packages/agents`, `packages/secops` | adapt (Dockerfile only for the generated builder, Dependabot), provision, retarget (architecture check), status; the own-Dockerfile digest rule (T1207) |
| `examples/`, `packages/cli/test/e2e` | six new examples and the Docker pass with builders (T1208) |
| `packages/cli`, `packages/mcp-server`, `plugin`, `docs/guide` | surfaces and the guide pages (T1209) |
| `packages/cli/test/live`, `docs/e2e*.md` | live builder matrix, zero-downtime under load, broken release, SBOM and provenance (T1210) |

## Design

### 1. Plan, facts and pins (T1201, serial, lead-reviewed)

The schemas are in [data-model.md](data-model.md).

**`plan.yaml`:**
- **`app.build`:**
  - `builder`: `generated-dockerfile | own-dockerfile | buildpacks | railpack`;
  - `chosen`: `auto | user`;
  - `reason`;
  - `runtime`: `{ language, version }`, the version handed to the builder.
- **`deploy`:**
  - `strategy`: `rolling | recreate`;
  - `drainSeconds` (default 30);
  - `reason`, when not rolling.
- **`supplyChain.sign`:** default false.
- **`cicd.deployTags`:** `{ enabled: false, release: false }`.

**Facts:** `ProjectFacts.runtimeVersions` gains `ruby`, `go`, `java`, `dotnet`, `php` and `rust`.
Detection reads `.ruby-version` and the Gemfile `ruby`, `go.mod` `go`/`toolchain`, the Maven or
Gradle release level, `TargetFramework`, `composer.json` `require.php`, and `rust-toolchain(.toml)`.

**`pins.ts`** is the only place versions live:
- images as `repo:tag@sha256` (node, python, caddy, postgres, valkey, kamal-proxy, cloudflared,
  trivy, curl, the Paketo builder and run images, the Railpack frontend);
- tools as version and SHA-256 (pack, railpack, cosign installer);
- GitHub actions by commit SHA;
- runtime defaults per language: Node 24 (LTS); Python, Ruby, Go, Java, .NET, PHP and Rust at the
  newest version OpsCrew tested;
- the Buildpacks offer, meaning which major/minor versions the pinned builder provides per
  language.

`scripts/update-pins.mjs` refreshes the table from the registries and GitHub releases. The lead runs
it at release time; no test touches the network.

### 2. The GitHub-runner spike (T1202, lead)

In the throwaway repository, one workflow checks:
- pack with a `project.toml` holding `BP_*` settings: is the throwaway-builder step avoided, and how
  long do cold and warm builds take?
- the seal `FROM <temp>@digest`: the Buildpacks launcher still starts the app, and the healthcheck's
  launcher form works;
- `docker buildx imagetools inspect --format '{{json .SBOM}}'` and `.Provenance` on the sealed image;
- Railpack with `BUILDKIT_SYNTAX=<frontend>@sha256:…`;
- an arm64 Buildpacks build on `ubuntu-24.04-arm`.

The results go into research R8 before T1205 starts.

### 3. The builder choice (T1203)

The contract is in [contracts/builders.md](contracts/builders.md).

`chooseBuilder(facts, plan, arch)` is pure:
- the user's `app.build.builder` (when `chosen: user`) wins, unless it cannot meet the baseline or
  the architecture;
- an existing Dockerfile in the repository means `own-dockerfile`;
- then the order of FR-1201.

The reason names the deciding fact, for example "Next.js with pnpm: OpsCrew's Dockerfile builds it;
Buildpacks has no pnpm". The interview offers signing (with the private-repository warning) and
deploy tags. Design shows the builder, the strategy and both reasons.

**The deploy strategy** is `rolling` unless the server has less than 1 GiB of memory, taken from the
provider's server type, or from the host facts on the user's own server. Portainer stays recreate,
and OpsCrew says so.

### 4. Dockerfiles, Dependabot and pins (T1204)

- **Node templates:**
  - use the declared major or the LTS default (`pins.ts`) instead of the fixed `node:22-alpine`;
  - run `npm ci --omit=dev` (and the pnpm and Yarn equivalents) in the runtime stage, keeping the
    release command's tool, such as `prisma`;
  - pin every base by digest.
- **Python** uses the declared version or the default.
- **Secret build values** reach the build as `RUN --mount=type=secret,id=NAME,env=NAME`.
- **`renderDependabot(facts, plan)`:**
  - one entry per detected ecosystem and directory, plus `github-actions`, `docker` where a
    Dockerfile is, and `docker-compose` for the runtime folder;
  - weekly, with minor and patch updates grouped per ecosystem.
- **`keepNewerPins(committed, rendered)`:**
  - for each image or action in the rendered file, the higher version wins;
  - on the same version, the committed digest wins (Dependabot's update);
  - it is used by every renderer of a committed file.

### 5. The build job (T1205)

The contract is in [contracts/builders.md](contracts/builders.md), section "Build job".

**Every builder:**
- `docker/setup-buildx-action`;
- GHCR login;
- an image named `ghcr.io/<repo>:<sha>`;
- the deploy job takes the final digest from `build-push-action`;
- Trivy scans the final digest.

**Per builder:**
- **`generated-dockerfile` / `own-dockerfile`:** `build-push-action`, with
  - `provenance: mode=max`;
  - `sbom: true`;
  - `cache-from`/`cache-to: type=gha`;
  - non-secret build args;
  - `secrets:` for the secret build values.
- **`buildpacks`:**
  1. setup-pack, pinned;
  2. `pack build <ghcr>:build-<sha> --builder <pin> --run-image <pin> --descriptor project.toml --publish --cache-image <ghcr>:buildcache`;
  3. the seal: an inline Dockerfile `FROM <ghcr>:build-<sha>@<digest>`, built with the same
     attestation settings and pushed as the final tag.
- **`railpack`:**
  1. install the pinned CLI with a checksum;
  2. `railpack prepare . --plan-out railpack-plan.json`;
  3. `build-push-action` with the plan as the file and `BUILDKIT_SYNTAX=<frontend pin>`, pushed to
     `build-<sha>`;
  4. the seal `FROM …` with `chown` of the framework's writable folders (Rails `tmp log storage db`,
     Laravel `storage bootstrap/cache database`) and `USER 10001:10001`.
- **Signing** (`supplyChain.sign`): `sigstore/cosign-installer`, then `cosign sign --yes <digest>`.
  `id-token: write` is held only by that job.
- **Deploy tags** (`cicd.deployTags.enabled`): a final job after a healthy deploy, holding only
  `contents: write`, creates the tag `deploy-<UTC yyyymmdd-hhmmss>` on the commit through the API.
  With `release`, it also creates a GitHub Release naming the digest.
- **The health-failure message** names the builder `chooseBuilder` would pick automatically (computed
  when rendering) and the `plan.yaml` line that selects it.

### 6. The switch (T1206)

The contract is in [contracts/builders.md](contracts/builders.md), section "Switch".

**Compose:**
- the app gets a `healthcheck` in the form for its builder (R3 results: plain runtime, or
  `/cnb/lifecycle/launcher --` for Buildpacks) and `stop_grace_period: <drainSeconds + 5>s`;
- a new `proxy` service (kamal-proxy pin) runs on the internal network with the named volume
  `kamal-proxy-config`;
- Caddy proxies to `proxy:80` instead of `app:<port>`.

**The deploy script** (in `switchCommands`, after the release command as today):
1. **Rolling:**
   1. note the running app container;
   2. `docker compose up -d --no-deps --no-recreate --scale app=2 app`;
   3. `docker compose exec -T proxy kamal-proxy deploy app --target <new container>:<port> --health-check-path <healthPath> --deploy-timeout 60s --drain-timeout <drainSeconds>s`;
   4. on success, stop and remove the old container; on failure, remove the new one and exit 1 with
      the builder hint.
2. **Recreate:** `docker compose up -d app` as today, then the same `kamal-proxy deploy` to the
   container.
3. **First deploy:** the same deploy registers the first target.

The database and cache are never restarted. Portainer stacks are unchanged.

### 7. Wiring (T1207)

- **adapt:**
  - writes a Dockerfile only for `generated-dockerfile`;
  - adds `dependabot.yml` when absent, or lists what it would add;
  - checks an own Dockerfile against the baseline. The secops rule for an unpinned base image is
    new; the root, latest-tag and secret-arg rules exist.
- **provision** hands the build choice and the strategy to the renderers.
- **retarget** checks the builder for the new architecture first.
- **status** shows the builder and the strategy.

### 8. Examples (T1208)

The six apps move from `.tools/scratch/012-examples` into `examples/`: `go-api`, `rails-api`,
`laravel-app`, `spring-boot-api`, `dotnet-api` and `rust-api`.
- Each gets an `expected.json`.
- Fixes before the move: Laravel's `composer.lock` is refreshed, and Rails pins a Ruby the builder
  offers.
- The e2e examples test checks detection and the chosen builder.
- The Docker pass builds every example with its builder, using the pinned tools in containers, and
  checks non-root, the health route, and no dev dependencies in Node images.

### 9. Surfaces and guide (T1209)

- The CLI and MCP show the builder, the strategy and the supply-chain settings, and accept the
  `plan.yaml` overrides. The plugin's skills mention them.
- New guide pages:
  - `builders.md`: the choice, the comparison table from R7, how to switch, the baseline;
  - `zero-downtime.md`: the switch, migrations, WebSockets and their limits;
  - `supply-chain.md`: reading the SBOM and provenance, signing, Dependabot, deploy tags.

### 10. Live tests (T1210)

The Hetzner pass runs a builder per app: `nextjs-postgres` (generated Dockerfile), `go-api`
(Buildpacks) and `rust-api` (Railpack), selected by `OPSCREW_E2E_APP`. Then:
- a merged change deploys under a steady load from the test machine, and no request fails;
- a commit whose health route fails deploys, and no request fails;
- the old version still answers;
- the image's SBOM and provenance are read with the documented command;
- non-root is checked on the running container;
- the leak search covers the attestations.

## Order

1. T1201.
2. T1202 (lead).
3. T1203, T1204, T1205 and T1206 in parallel. T1205 needs R8.
4. T1207.
5. T1208.
6. T1209.
7. T1210.
8. T1211 (live runs, lead).

## Complexity Tracking

| Addition | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| A seal build after Buildpacks and Railpack | One way to attach SBOM and provenance, and to make Railpack non-root | Per-builder tools: pack has no provenance, GitHub's attestations may need Enterprise for private repositories, and Compose `user:` alone fails for Rails and Laravel |
| kamal-proxy next to Caddy | Only it kept a broken release away from visitors (R3 results) | docker-rollout behind Caddy routed visitors to the unhealthy copy for about 20 s |
| A pin table with carry-over | One place to update, and Dependabot's updates survive re-rendering | Pins spread over templates drift, and re-rendering would revert the user's updates |
