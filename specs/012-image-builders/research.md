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
