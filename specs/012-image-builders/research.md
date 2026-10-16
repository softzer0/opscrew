# Research: Railpack as the default image builder (2026-10-13)

Founder decision 2026-10-13: Railpack builds the app image by default; the user can choose
OpsCrew's generated Dockerfile instead. Official sources only (railpack.com, github.com/railwayapp/railpack);
items marked **verify** are checked by a real build in the feature's first task.

## Project

- MIT license. Latest release v0.40.1 (2026-09-28); releases every one to two weeks; 0.x semver
  with breaking changes in minor releases (v0.38.0 moved pnpm from Corepack to mise; v0.37.1
  stopped reading `RAILPACK_DISABLE_CACHES` from the host). Pin the version and upgrade on purpose.
- Install pinned: `curl -sSL https://railpack.com/install.sh | RAILPACK_VERSION=<ver> sh -s -- --bin-dir ~/.local/bin`
  (or GitHub release binaries, or `mise use github:railwayapp/railpack@<ver>`).
- README calls it the successor to Nixpacks.

## Building in CI

- Two routes: `railpack build DIR` (drives BuildKit itself; needs `BUILDKIT_HOST`) or, recommended
  for production, `railpack prepare DIR --plan-out railpack-plan.json --info-out railpack-info.json`
  then `docker buildx build --build-arg BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:<tag>
  -f railpack-plan.json DIR` (frontend docs). The frontend version must match the CLI that made the
  plan; docs only show `:latest` — **verify** a per-version tag on GHCR, pin by digest.
- `prepare` exits 75 on a transient failure, 1 when the app cannot be planned.
- Frontend build args: `cache-key`, `secrets-hash`, `github-token` (mise downloads from GitHub:
  pass the Actions token to avoid rate limits).
- No official GitHub Action (docs link a third-party one). Plan: `docker/setup-buildx-action` +
  install pinned CLI + `prepare` + `docker/build-push-action` (`file: railpack-plan.json`,
  `push: true`, digest from the action's output, `cache-from/to: type=gha`, `platforms: linux/amd64`).
- Output is a standard image (BuildKit LLB); tag, push and digest as with any buildx build.

## Detection and Node

- Providers: php, golang, java, rust, ruby, elixir, python, deno, dotnet, node, gleam, cpp,
  staticfile, shell. File-based detection (Node: `package.json`).
- Node version: `RAILPACK_NODE_VERSION` → `devEngines.runtime` → `engines.node` → `.nvmrc` →
  `.node-version` → mise files → `lts`. Package manager from `packageManager`, mise files,
  lockfiles, `engines`; default npm. Start: `start` script → `main` → `index.js/ts`.
- Next.js: static export served as an SPA (Caddy); otherwise the `start` script (`next start`,
  full node_modules). Standalone output not documented.
- Monorepos: npm/bun/yarn workspaces, pnpm workspaces, Nx (`RAILPACK_NX_APP`). No root-dir
  variable: the build directory is the argument (a subfolder build lacks workspace deps outside it).

## Configuration and secrets

- `railpack.json` at the build root (`RAILPACK_CONFIG_FILE` overrides; schema
  `https://schema.railpack.com`): `provider`, `buildAptPackages`, `packages`, `caches`, `secrets`,
  `steps` (inputs, commands, secrets, assets, variables, caches, deployOutputs), `deploy` (base,
  startCommand, variables, paths, inputs, aptPackages).
- Build variables (`RAILPACK_START_CMD`, `RAILPACK_BUILD_CMD`, `RAILPACK_INSTALL_CMD`,
  `RAILPACK_PACKAGES`, `RAILPACK_*_APT_PACKAGES`, `RAILPACK_PRUNE_DEPS`, `RAILPACK_NO_SPA`,
  `RAILPACK_SPA_OUTPUT_DIR`, …) are passed with `--env`, not read from the environment.
- Secrets are BuildKit secret mounts (kept out of layers and logs); `prepare --env K=V` lists the
  names in the plan, buildx gets `--secret id=K,env=K`; `secrets-hash` busts the cache.
  **Verify** that secret values never land in the plan. Plain `--env`/`deploy.variables` are baked
  into the image (never secrets).
- No documented port setting (the app must listen on the port OpsCrew uses) — **verify**.

## Runtime image

- Not documented: base image, user (likely root by default), size, build tools in the final
  image — **verify** with a real build (`docker inspect` `.Config.User`, image size, packages).
  The final image is `deploy.base` + `deploy.inputs`; build steps and mount caches are not in it.
- No HEALTHCHECK; static sites served by Caddy (custom Caddyfile at the root overrides).

## Caching and reproducibility

- BuildKit layer cache (any backend, e.g. `type=gha`); mount caches not persisted by `type=gha`.
- mise resolves fuzzy versions to the latest match and reduces manifest ranges to the major
  version: builds float unless runtimes and the Railpack/frontend versions are pinned.

## Limits

- Windows not officially supported (CI runs on Linux; local `opscrew` on Windows only prepares
  files). Multi-arch not documented (stay `linux/amd64`). GitHub issues not reviewed.

## Risks as a default

1. Pre-1.0: pin and upgrade deliberately. 2. Frontend tag/digest pinning unverified. 3. Root user
likely: needs a non-root step or a fallback. 4. Floating runtime versions. 5. Port/health/Next.js
standalone undocumented; `next start` images larger. 6. GitHub rate limits during mise downloads.
7. Secret values in `prepare` output unverified. 8. Weak mount-cache persistence on GHA runners.

# Cloud Native Buildpacks (Paketo) — compared for the default (2026-10-13)

Founder decision 2026-10-13: Buildpacks by default *if* the comparison build confirms it beats
Railpack; Railpack and the generated Dockerfile stay user choices. Official sources (buildpacks.io,
paketo.io, their GitHub repos); **verify** = checked by the comparison build.

- Apache-2.0 (github-actions, Paketo Node.js confirmed; pack and lifecycle per project knowledge).
  pack v0.40.9 (2026-08-09, CVE fixes, lifecycle v0.21.0); Paketo Node.js v10.13.1 (2026-10-09);
  CNB is a CNCF project, Paketo under the Cloud Foundry Foundation (**verify**).
- CI: `buildpacks/github-actions/setup-pack` (pin by SHA; it only warns when the checksum cannot be
  fetched) + `pack build <ghcr ref> --builder <builder>@sha256:… --run-image <run>@sha256:…
  --publish --cache-image <ghcr ref>:buildcache --sbom-output-dir sbom`; needs the runner's Docker
  daemon; digest via `crane digest` (setup-tools) or the build report. **Verify** flags.
- Builders: Ubuntu Noble/Resolute/Jammy Base (Java, Node.js, Go, Python, .NET, Ruby, NGINX), Jammy
  Full (adds PHP, HTTPD, C libraries — native npm modules may need it), Tiny (Go/Java), UBI (Java,
  Node.js).
- Security: SBOM in Syft, CycloneDX and SPDX (confirmed); `pack rebase` swaps the OS layers;
  non-root user (cnb, uid 1002) and the run-image contents are **verify** items.
- Node.js: version from `BP_NODE_VERSION` → `engines.node` → `.nvmrc` → `.node-version`; npm and
  Yarn only — **pnpm is not supported** (open since 2022, paketo-buildpacks/nodejs#594, RFC #336);
  start from the `start` script, `BP_LAUNCHPOINT` or a Procfile; `BP_NODE_RUN_SCRIPTS=build`;
  `BP_NODE_PROJECT_PATH` for a subfolder (workspaces not documented); dev dependencies are
  installed and stay in the run image; **Next.js standalone output is effectively ignored**
  (larger images; older discussion — **verify** with a current build).
- Process types: Procfile (`web`, `worker`, …), `--default-process`; the launcher runs a type by
  name. Secrets: no BuildKit-style mounts — bindings (`--volume`, `npmrc`/`yarnrc` types);
  `BPE_*` and `--env` end up in the image. No PORT setting or health-check buildpack.

Comparison (to measure in the first task): non-root by default — Buildpacks likely, Railpack
likely root; SBOM — Buildpacks yes, Railpack no; pnpm — Buildpacks no, Railpack yes; Next.js —
both run `next start` (Railpack serves static exports via Caddy); monorepos — Railpack documents
workspaces and Nx, Buildpacks only a project path; Procfile — Buildpacks yes; image size and CI
build time — unknown for both.

## To research for this feature: zero-downtime deploys with docker-rollout

Founder decision 2026-10-14: zero-downtime deploys come with this feature, through `docker-rollout`
(https://github.com/wowu/docker-rollout), a Docker CLI plugin that starts a second copy of a Compose
service, waits until it is healthy and then removes the old one (the old copy keeps serving if the
new one never gets healthy). It is chosen over kamal-proxy, which is also zero-downtime but is its own proxy (with TLS) and would replace or sit behind Caddy; kamal-proxy stays the fallback if docker-rollout's handover is not clean enough for long requests, uploads or WebSockets (the old copy needs a graceful-stop period either way). Before
building, confirm: the license and a version to pin (installed on the server with a checksum); the
documented requirements (no `container_name` or host ports on the service, a healthcheck or a wait);
how Caddy must route to both copies (dynamic upstreams, retries while the old copy goes away); a
health-check tool inside slim and distroless images; and the memory headroom on 1 GB servers while
two copies run.
