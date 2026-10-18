# Research: image builders, zero-downtime deploys and the image supply chain (012)

Refreshed 2026-10-18 from official sources only (three Sonnet research passes; the first notes were
from 2026-10-13). **verify** marks what the hands-on comparison task (R7) settles with real builds.

## Founder decisions (2026-10-13 and 2026-10-14)

- Three builders, chosen per project automatically:
  - **Cloud Native Buildpacks (Paketo)** wherever it fully supports the project;
  - **Railpack** where it cannot;
  - the **generated Dockerfile** on request.
- The user can override the choice in `plan.yaml`, and a comparison build confirms the choice with numbers.
- Every builder meets the security baseline: non-root, pinned versions, no secrets in layers, scanned. If one cannot, OpsCrew says why and falls back. If Buildpacks falls short, the founder sees the numbers.
- Also in 012:
  - zero-downtime deploys with `docker-rollout`, with kamal-proxy as the fallback;
  - deploy tags or GitHub Releases, offered but off by default;
  - a generated `dependabot.yml`;
  - an SBOM and provenance for the pushed image, with keyless cosign signing optional.

## R1. Cloud Native Buildpacks (Paketo)

- **Versions.** `pack` v0.40.9 (2026-08-09, lifecycle v0.21.0) is still the latest. `buildpacks/github-actions` (setup-pack) is Apache-2.0; it pins pack, but only warns when the `.sha256` file cannot be fetched. Paketo Node.js is at v10.13.2 (2026-10-16).
- **Builders.** `paketobuildpacks/ubuntu-noble-builder` (Ubuntu 24.04) covers Java, Node.js, Go, Python, .NET, Ruby and NGINX. There are also Jammy Base, Jammy Full and Jammy Tiny builders, a Resolute (26.04) stack, and run images such as `ubuntu-noble-run`. Pin builder and run image by digest (`@sha256:` on `--builder` and `--run-image`; **verify**).
- **Language coverage:**
  - **Node.js:** npm or Yarn only. **pnpm is not supported**: nodejs#594 is still open, and RFCs #334 and #336 were closed without merging (2026-08/09). Bun is not supported. `BP_NODE_PROJECT_PATH` sets the app folder; workspaces are undocumented.
  - **Python:** pip, Poetry, uv, Pipenv, Conda and pixi.
  - **Go, Java (Maven, Gradle, Spring Boot), Ruby (Bundler, Rails), .NET:** in the Noble builder.
  - **PHP:** only in Jammy Full. It is deprecated, has no Noble equivalent, and is supported through April 2027 (RFC 0061).
  - **Rust:** only `paketo-community/rust`, which is in no builder.
- **Runtime.** Run images use a dedicated non-root user, a different one from the build image, and contain no compilers. Things to **verify**:
  - the user id;
  - dev dependencies left in a Node image;
  - Next.js standalone output;
  - how the app's port is set.
- **Procfile** process types are supported; `--default-process` defaults to `web`.
- **CI:** `pack build <ghcr ref> --publish --cache-image <ref>:buildcache --sbom-output-dir sbom --report-output-dir report`. pack runs the lifecycle in a container, so the runner's Docker is needed. Taking the digest from `report.toml` needs a **verify**. pack has no provenance flag, so provenance needs a separate step.
- **Secrets:** bindings such as `npmrc`. `--env` values are not available at runtime; whether `BPE_*` values end up in the image needs a **verify**.
- **Limits:** builder and stack naming is in flux (Jammy → Noble → Resolute, and stacks are deprecated in favour of base images), so pin by digest. Multi-arch support, image size and build time need a **verify**.

## R2. Railpack

- **Releases.** v0.42.0 (2026-10-15), with releases every one to three weeks. It is pre-1.0, and changes in mise lockfiles and Java/Node behaviour came in minor releases. License: MIT.
- **Pinned install.** The release tarball `railpack-v<ver>-x86_64-unknown-linux-musl.tar.gz` plus `checksums.txt` (SHA-256), checked with `sha256sum -c`.
- **Frontend.** `ghcr.io/railwayapp/railpack-frontend` has per-version tags matching the CLI (`v0.42.0`, plus `-amd64` and `-arm64`) with listed digests. Its version must match the CLI that made the plan. Pin it by digest in `BUILDKIT_SYNTAX` (**verify**).
- **CI path:**
  1. `railpack prepare DIR --plan-out railpack-plan.json --info-out railpack-info.json`. Exit code 75 means a transient failure, so retry; 1 means fail.
  2. `docker buildx build --build-arg BUILDKIT_SYNTAX=<frontend@digest> -f railpack-plan.json DIR`.
  - There is no official GitHub Action.
  - The `github-token` build arg raises mise's GitHub rate limits (source comment only).
- **Secrets.** `prepare --env NAME=…`, then `--secret id=NAME,env=NAME` and `--build-arg secrets-hash=…`. Names appear in the plan, values never do. Plain `--env` and `deploy.variables` are baked into the image.
- **Runtime image:**
  - The base is `ghcr.io/railwayapp/railpack-runtime:mise-<ver>`, minimal Debian, holding only the deploy inputs.
  - Entrypoint `bash -c <start>`, WorkingDir `/app`.
  - **It runs as root, with no setting to change that.** The deploy schema has no user field (`additionalProperties: false`), and issue #286 is open.
  - No `PORT`, no `EXPOSE`, no HEALTHCHECK, no OCI labels, no SBOM.
  - `RAILPACK_BUILT_AT` changes on every build.
- **Providers:**
  - Node: npm, pnpm, Yarn and Bun, with workspaces, Nx and the Turborepo cache (v0.42.0).
  - Also Python, Go, PHP, Java, Ruby, Rust, Elixir, Deno, .NET, Gleam, C++, Zig, static sites and shell.
  - The build directory is the argument. Workspace dependencies outside a subfolder build are lost.
  - Next.js standalone output is undocumented.
- **Limits.** Builds amd64 (the LLB is hardcoded to linux/amd64), Linux only. Versions float unless the runtime versions are exact and the CLI and frontend are pinned.

## R3. Zero-downtime deploys: docker-rollout and Caddy

- **The project.** `wowu/docker-rollout`: MIT, v0.14 (2026-07-12), one script per release asset (`docker-rollout`), one to two releases a year. Install it pinned from the release asset, with a SHA-256 OpsCrew records (the README only shows curl from `main`).
- **Requirements.** No `container_name` and no host `ports` on the service; a proxy routes traffic.
  - Flags: `-f`, `-t/--timeout` (60 s; waits for healthy), `-w/--wait` (10 s, when there is no healthcheck), `--wait-after-healthy`, `--env-file`, `-p`, `--pre-stop-hook` (or the label `docker-rollout.pre-stop-hook`, read from the old container).
  - It works with `docker compose`.
- **How it works:**
  1. `up -d --scale SVC=2N --no-recreate`.
  2. It polls the health status every second.
  3. If the new copy fails, it removes the new containers and the old ones keep serving.
  4. On success, it runs the pre-stop hook in the old containers, then `docker stop` and `rm`.
  - It never passes `-t` to `docker stop`, so Compose's `stop_grace_period` is probably ignored and Docker's 10-second kill applies. Draining has to be a pre-stop hook that makes the healthcheck fail, then sleeps (**verify**).
- **Caddy:**
  - `reverse_proxy` with `dynamic a <service> <port>` re-resolves the Compose service's DNS. Docker returns every replica's IP. The `refresh` default is 1 m, so set it to about 1 s.
  - `lb_retries` and `lb_try_duration` default to off. Set `lb_try_duration` (about 5 s) so a request that hits the stopping copy is retried.
  - Active health checks do not run for dynamic upstreams.
  - A static `app:3000` likely sticks to one address (**verify**).
- **Health check inside the image.** Do not assume curl or wget: slim images lack them, and distroless has no shell. Use the app's own runtime (`node -e "fetch(…)"`, `python -c`) or a small static probe.
- **Memory.** Two copies run during the switch; check this on 1 GB servers (**verify**).
- **Fallback.** kamal-proxy, if the handover is not clean for long requests, uploads or WebSockets.

### R3 results: the local spike (2026-10-18; `.tools/scratch/012-results-b.md`)

Load was 20 requests per second through Caddy (`caddy:2.11.7-alpine@sha256:d8542f48…`). Each
result below is failed requests out of all requests sent.

- **Today's switch** (`up -d` with a new tag): 1/689 for an app that starts instantly; **86/697**
  for an app that takes 3 s to start.
- **docker-rollout v0.14** (SHA-256 `cdeaba6ae9eee3b0b606286e585bbda6787283d801a6ad6d9b9d2bc347fda05b`; a
  `sh` script):
  - With a static `reverse_proxy app:3000`: 0 failures in 4 runs.
  - With `dynamic a app 3000 { refresh 1s }`, `lb_try_duration 5s` and `lb_try_interval 250ms`:
    **0/3,237** over 5 runs.
  - With `refresh 5s`: 9/2,190.
  - Adding `lb_retries 3`: 2/2,391. Don't set it.
- **Slow requests and drain.** A 20 s request is cut 10 s after SIGTERM when nothing extends that.
  It completes when either of these is set:
  - `stop_grace_period: 30s`. Compose sets the container's `StopTimeout`, and `docker stop` honours
    it, so R3's "probably ignored" was wrong.
  - A pre-stop hook `touch /tmp/draining; sleep 25`.
  A dynamic upstream ignores health, so the old copy keeps getting new requests until it stops.
  The sleep is what drains.
- **A broken release: the failing case.**
  - When `/health` returns 500 but pages return 200, docker-rollout exits 1 and removes the new copy,
    so no request failed (0/897). **But the unhealthy copy served visitors for about 20 s** (156
    requests in the Paketo run). Caddy routes to every address Docker's DNS lists, and the new copy
    is listed at once.
  - When every route returns 500: **185/996 failed**.
  - Caddy's passive health checks hide the broken copy, but break healthy rollouts: 403/980 failed
    with "no upstreams available".
  - This fails FR-1212.
- **kamal-proxy `basecamp/kamal-proxy:v0.10.2@sha256:a686220c…`** passed everything:
  - healthy rollout 0/1,097, and the slow request completed on the old copy;
  - a release returning 500 everywhere got **zero** requests, and the deploy exited 1 ("target
    failed to become healthy within configured timeout");
  - memory: 11 MiB.
- **Health check without curl or wget:**
  - slim image: `["CMD","node","-e","fetch('http://127.0.0.1:'+process.env.PORT+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`;
  - Buildpacks image: `["CMD","/cnb/lifecycle/launcher","--","node","-e","…"]`. `node` is not on its
    PATH, and **without `--` the launcher exits 0 whatever the command does**.
- **Memory during a switch:** two copies of `nextjs-postgres` (81 MiB each), Caddy (20 MiB) and
  postgres:17-alpine (62 MiB) come to about 246 MiB. With about 250 MiB for the OS and Docker that
  is about 500 MiB, so it fits a 1 GB server. Next.js's boot peak was not measured.
- **WebSockets** stay on the old copy and are cut (code 1006) when it stops, with either tool.

**Lead decision, confirmed by the founder (2026-10-18): kamal-proxy, the founder's named fallback
(2026-10-14), replaces docker-rollout.**
- **Why.** docker-rollout behind Caddy lets a release that fails its health check serve visitors
  until the health timeout, which breaks FR-1212. kamal-proxy routes only to a target that passed
  its health check, and drains the old one.
- **The setup:**
  - Caddy stays in front for TLS, headers and the tunnel.
  - kamal-proxy runs as one more small container on the internal network, and Caddy proxies to it.
- **The deploy script:**
  1. start the new app copy (`docker compose up -d --no-deps --no-recreate --scale app=2 app`);
  2. hand it to kamal-proxy (`kamal-proxy deploy app --target <new>:<port> --health-check-path <path>`
     with a deploy timeout and a drain timeout);
  3. remove the old copy on success, or the new one on failure.
- docker-rollout is not used.

### R7 results: the builder comparison (2026-10-18; `.tools/scratch/012-results-a.md`)

Local Docker 29 (containerd image store); every builder pushed to a local registry. Times are
wall-clock seconds, ±20% (another spike shared the engine). "net" leaves out pack's 5.5 GB
throwaway builder step (finding 1). Dockerfile = OpsCrew's generated Dockerfile (Node and Python
only). HIGH/CRIT = Trivy's counts.

| App | Builder | MB | Cold s | Warm s | Runs as | Dev deps in image | HIGH | CRIT | Starts |
|---|---|---|---|---|---|---|---|---|---|
| nextjs-postgres (npm, Next.js 16) | Buildpacks | fails: Turbopack cannot find `next/package.json` (node_modules is a symlink outside /workspace) | | | | | | | |
| | Railpack | 1113 | 53 | 33 | root | yes | 51 | 0 | yes |
| | Dockerfile | 304 | 31 | 38 | uid 1000 | no | 11 | 0 | yes |
| express-api (npm) | Buildpacks | 514 | 34 | 23 | uid 1002 | no | 45 | 0 | yes |
| | Railpack | 657 | 37 | 21 | root | yes | 51 | 0 | yes |
| | Dockerfile | 272 | 11 | 12 | uid 1000 | **yes** (template bug) | 11 | 0 | yes |
| fastapi-redis (pip) | Buildpacks (Procfile) | 527 | 35 | 17 | uid 1002 | – | 19 | 0 | yes |
| | Railpack | 571 | 67 | 23 | root | – | 47 | 0 | yes |
| | Dockerfile | 240 | 25 | 4 | uid 10001 | – | 48 | 0 | yes |
| django-postgres (pip) | Buildpacks | fails by default (Python 3.11; Django 6.1 needs ≥ 3.12; `.python-version` ignored) | | | | | | | |
| | Buildpacks, `BP_CPYTHON_VERSION=3.13` | 693 | 318 (42 net) | 322 (20 net) | uid 1002 | – | 19 | 0 | yes (no sqlite library in the run image) |
| | Railpack | 600 | 25 | 14 | root | – | 47 | 0 | yes |
| | Dockerfile | 270 | 15 | 4 | uid 10001 | – | 48 | 0 | yes |
| static-vite | Buildpacks (NGINX) | 209 | 318 (36 net) | 303 (19 net) | uid 1002 | – | 15 | 0 | yes |
| | Railpack | 221 | 23 | 11 | root | – | 47 | 0 | yes |
| | Dockerfile | 163 | 18 | 15 | uid 65534 | – | 8 | 0 | yes |
| monorepo web app (pnpm workspace) | Buildpacks | fails: ignores pnpm, unlocked npm install | | | | | | | |
| | Railpack | 1383 | 55 | 36 | root | – | 53 | 0 | yes |
| | Dockerfile | 339 | 46 | 47 | uid 1000 | – | 13 | 0 | yes |
| go-api | Buildpacks | 204 | 32 | 21 | uid 1002 | – | 21 | 0 | yes |
| | Railpack | 159 | 20 | 12 | root | – | 43 | 0 | yes |
| rails-api (Ruby 4.0.6) | Buildpacks | 731 | 52 | 17 | uid 1002 | – | 13 | 1 | yes (fails with Ruby 4.0.7: not offered yet) |
| | Railpack | 1033 | 81 | 15 | root | – | 43 | 1 | yes |
| laravel-app | Buildpacks (Noble) | 1095 | 389 (89 net) | 299 (24 net) | uid 1002 | – | 19 | 0 | **no**: NGINX has no front-controller rewrite (404/500) |
| | Railpack | 1637 | 62 | 36 | root | – | 141 | 4 | yes |
| spring-boot-api (Maven) | Buildpacks | 530 | 104 | 32 | uid 1002 | – | 29 | 6 | yes |
| | Railpack | 954 | 74 | 33 | root | – | 48 | 3 | yes |
| dotnet-api | Buildpacks | 427 | 120 | 44 | uid 1002 | – | 25 | 2 | yes |
| | Railpack | 1201 (full SDK) | 81 | 28 | root | – | 131 | 4 | yes |
| rust-api | Railpack | 153 | 64 | 14 | root | – | 43 | 0 | yes |

Findings:
1. **Every `pack build --env …` first builds a 5.5 GB throwaway builder image**, which took 280–340 s
   on the containerd image store (3 s without `--env`). That hits Node (`BP_NODE_RUN_SCRIPTS`), static
   sites, PHP and Python version pins. It still has to be checked on a GitHub runner. A `project.toml`
   with `[[io.buildpacks.build.env]]` may avoid it (**verify**).
2. **Buildpacks cannot build Next.js 16 or a pnpm workspace.**
3. **PHP is in the Noble builder** (R1's "Jammy Full only" is out of date), but the default NGINX
   config does not route Laravel's front controller.
4. **Most of Buildpacks' HIGH findings are in Paketo's own Go helper binaries** (15–37 per image).
   The Ubuntu Noble OS layer showed none; Railpack's Debian runtime base showed 43.
5. **Railpack images are large.** They keep dev dependencies, and the full SDK for .NET (624 MB) and
   Java.
6. **OpsCrew's `node-server` Dockerfile ships dev dependencies** (`typescript`). Fix it in 012. The
   Next.js standalone template is clean.
7. **pack's cache needs a persisted `PACK_HOME`.** The cache volume name comes from a random key kept
   there.
8. **`railpack prepare` for Python fails on Alpine (musl).** Run it on glibc (the GitHub runner is
   fine).
9. **Buildpacks' default Python is 3.11 and ignores `.python-version`.** Only `BP_CPYTHON_VERSION`
   sets it, so OpsCrew must pass the version it detected.

**Railpack as non-root.** No Railpack image sets a `USER`; all run as uid 0.
- Running with `--user 10001:10001` (Compose `user:`) works for 10 of 12 apps: Go, Rust, static,
  Express, FastAPI, Django, Spring, .NET, Next.js and the monorepo.
- It fails for Rails (`/app/tmp/cache`) and Laravel (`storage/`, `database/`), which write under
  `/app`.
- `deploy.base` with a `USER` does not carry through: the final image's `User` is empty.
- What works: a non-root user at runtime, plus, for apps that write under `/app`, one extra layer
  (`FROM <railpack image>`, `chown` of the writable folders, `USER`).

**arm64.**
- Buildpacks' Noble builder and run image have arm64 variants. Jammy Full has no arm64 builder.
- Railpack's frontend, builder and runtime images all have arm64, and a `--platform linux/arm64` Go
  build worked under emulation. R2's "amd64 only" is wrong.

**Pins used:**
- pack 0.40.9 (`buildpacksio/pack@sha256:4aec804c…`);
- Noble builder `@sha256:ba79c24b55830210fc5ee06768237ab989dbaeec36adb60a986bcb8e70e4d7cd`
  (lifecycle 0.21.22);
- Railpack 0.42.0 (tarball sha256 `81bca91d…194b`, matches `checksums.txt`);
- Railpack frontend `@sha256:a42a12399fa9e83a09e475f69dbf8a45a8a74ea38a4485fcb401356d84317a14`.

**What this means for the automatic choice (FR-1210).** On the projects it would be chosen for first
(npm Node, pip Python), Buildpacks falls short of OpsCrew's own Dockerfile:
- it fails on Next.js 16 and pnpm workspaces;
- its images are about 2× larger (514 MB against 272, 527 against 240, 693 against 270);
- it is much slower whenever a build setting is needed.

It is the best non-root option for Java, .NET, Go and Ruby, where OpsCrew has no template and
Railpack's images are 1.8–2.8× larger. **The founder decides.**

## R4. SBOM, provenance and signing

- **buildx.** Min-level provenance is on by default; `sbom: true` and `provenance: mode=max` are opt-in.
  - The attestations are extra manifests in the image index, so deploy by the index digest that `build-push-action` outputs.
  - They need the docker-container driver (setup-buildx). Whether GHCR displays them needs a **verify**.
  - pack builds need a separate step.
- **GitHub artifact attestations.**
  - Uses `actions/attest@v4` with `subject-name`, `subject-digest`, `push-to-registry` and optionally `sbom-path`.
  - Needs the permissions `id-token: write`, `attestations: write`, `packages: write` and `contents: read`.
  - Verify with `gh attestation verify oci://ghcr.io/… -R owner/repo`.
  - Public repos use Sigstore's public log. Private repos use GitHub's own instance, with no public log. Whether private repos on the Free plan can use them is unconfirmed (believed to need Enterprise Cloud).
- **cosign keyless.** Uses the GitHub OIDC token. The public Rekor entry's certificate holds the repo and workflow identity, so **a private repo's name and workflow path become public**. Keep it opt-in, with that warning.

## R5. Dependabot

- **Ecosystems:** `github-actions`, `docker`, `docker-compose`, `npm` (also pnpm; Yarn listed), `bun`, `pip` (pip, pip-compile, pipenv, poetry), `uv`, `gomod`, `cargo`, `bundler`, `composer`, `maven`, `gradle`, `nuget`.
- **Monorepos:** `directories` takes globs; blocks for one branch must not overlap.
- **Grouping:** groups (`patterns`, `update-types`) and `multi-ecosystem-groups` cut the number of pull requests.

## R6. Deploy tags and releases

- They need `contents: write`. `gh release create <tag> --target <sha>` creates the tag.
- Events from `GITHUB_TOKEN` do not start other workflows, so nothing may depend on a tag-triggered workflow.
- Tag as the last step, after a verified deploy.

## R7. To measure (the comparison task)

Build these examples with Buildpacks, Railpack and the generated Dockerfile, where each builder applies:
- `nextjs-postgres` (npm);
- a pnpm app;
- `fastapi-redis` (uv or pip);
- Django;
- Go;
- Rails;
- Laravel;
- Spring Boot;
- .NET;
- Rust.

For each build, record:
- image size;
- cold and warm build time;
- the user the app runs as;
- dev dependencies left in the image;
- the HIGH and CRITICAL counts from Trivy;
- whether the app starts and answers its health route on OpsCrew's port.

Also check:
- **Railpack non-root:** whether Railpack images run under Compose `user:` with a fixed non-root uid, and whether a `deploy.base` image with a `USER` carries through.
- **docker-rollout behind Caddy:** zero failed requests during `docker rollout` with `dynamic a` and `lb_try_duration`, under steady load and with a slow request in flight.
