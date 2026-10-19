# ADR 0015: Image builders, the seal step, kamal-proxy and the image supply chain

- Status: accepted
- Date: 2026-10-18
- Decision makers: founder, lead

## Context

OpsCrew packaged apps without a model only for Node and Python, using its own Dockerfile
templates. Base images were not pinned by digest, builds had no SBOM or provenance, and a deploy
stopped the old container before the new one was ready. The founder asked for three builders
chosen per project (2026-10-13), each held to one security baseline: non-root, pinned, no secrets,
scanned. He also asked for zero-downtime deploys (2026-10-14) and a supply chain kept current by
Dependabot.

Two local spikes measured the options (`specs/012-image-builders/research.md`, R3 and R7 results).

## Decision

- **Builder order** (founder, 2026-10-18, from the measured comparison):
  1. OpsCrew's generated Dockerfile for its Node and Python stacks: the smallest images, and the only
     builder that built Next.js 16 and pnpm workspaces;
  2. Paketo Buildpacks for Go, Java, .NET and Ruby whose runtime version the pinned builder offers
     and that have no secret build value: non-root by default, and 1.4–2.8× smaller than Railpack
     for Java, .NET and Rails;
  3. Railpack for everything else, Bun projects included.

  The choice is deterministic, recorded with its reason in `plan.yaml`, and overridable there. A
  repository's own Dockerfile is used as it is.
- **One seal step.**
  - Buildpacks and Railpack images are pushed to an intermediate tag.
  - A thin `FROM <intermediate>@digest` build follows. For Railpack it also does a `chown` of the
    framework's writable folders and sets `USER 10001`; for PHP it also drops FrankenPHP's file
    capability and makes Laravel's storage link, so the web root stays root's.
  - The seal runs through `docker/build-push-action` with `provenance: mode=max` and `sbom: true`.
  - Dockerfile builds use the same action directly.
  - Every image therefore carries buildx SBOM and provenance attestations in GHCR, and runs as
    non-root.
  - Secret build values are passed only as BuildKit secret mounts, because mode=max records build
    args.
- **Runtime versions.** Each builder gets the version the app declares, else one default per
  language: Node's current LTS, otherwise the second-newest minor version.
- **One pin table** (`packages/iac-templates/src/pins.ts`) holds every image by tag and digest,
  every downloaded tool by version and checksum, and every action by SHA.
  - A script refreshes it at release time.
  - The renderers keep a newer pin found in the user's committed file, so Dependabot's updates
    survive.
- **Zero-downtime with kamal-proxy behind Caddy** on the server targets (founder's named fallback,
  confirmed 2026-10-18).
  - With docker-rollout behind Caddy, a release failing its health check served visitors for about
    20 s. kamal-proxy sent it no request.
  - Caddy keeps TLS and headers. kamal-proxy runs as an internal Compose service and only switches
    between app copies.
  - The deploy is rolling: a second copy starts, kamal-proxy switches once it is healthy and drains
    the old copy, and the old copy is removed. A broken copy is removed without traffic.
  - Servers below 1 GiB of memory use recreate. The Portainer target recreates, and says so.
- **Supply chain.**
  - A generated `dependabot.yml` covers the detected ecosystems, the actions, Dockerfiles and
    Compose. It comes with provision's deploy-setup pull request, together with the files it
    watches (T1214). The workflow's own pins (builder images, the Railpack frontend, tools) move
    only with OpsCrew's releases.
  - Signing with cosign keyless is opt-in, with a warning that a private repository's name and
    workflow become public in Sigstore's log.
  - Deploy tags and releases are off by default, created by a job holding only `contents: write`.

## Consequences

- **Workflows.** Every build uses buildx. Buildpacks and Railpack builds take one more short build
  and one more push.
- **Servers.** They run one more small container (kamal-proxy, about 11 MiB). Caddy proxies to it
  instead of to the app.
- **Health checks.** The app service gets a Compose health check. Buildpacks images need the
  launcher form, `/cnb/lifecycle/launcher -- …`.
- **The comparison table** is published in the guide, and repeated when the pins move to new
  builder releases.
- **No constitution change:** builds and deploys still run in the workflow the user merges, and
  server changes keep their existing gates.
