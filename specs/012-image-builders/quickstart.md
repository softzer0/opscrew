# Quickstart: validating 012

## Unit and integration tests (no network)

```bash
export OPSCREW_TEST_TMP="D:\\opscrew-test-tmp" PATH="/d/opscrew/.tools/bin:$PATH"
pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/detect \
  --filter=@opscrew/iac-templates --filter=@opscrew/agents --filter=opscrew
```

They check:
- **`chooseBuilder`:** every example's facts give the builder in the table of research R7
  ("What this means").
- **Versions:** a declared version reaches the builder, and the defaults apply otherwise.
- **Workflow snapshots:**
  - one per builder;
  - no secret is passed as a build arg;
  - every action and image is pinned;
  - the final build has `provenance: mode=max` and `sbom: true`.
- **Compose and Caddy snapshots:** the app healthcheck form per builder; Caddy to `proxy`.
- **Pins:** `keepNewerPins` keeps a newer or Dependabot-updated pin, and replaces an older one.
- **Dependabot:** one entry per ecosystem, grouped; an existing file is untouched.

## Local Docker pass (gated: `OPSCREW_DOCKER_TESTS=1`)

```bash
OPSCREW_DOCKER_TESTS=1 pnpm --filter opscrew exec vitest run test/e2e/docker.test.ts
```

Every example in `examples/` is built with its chosen builder, using the pinned tools in containers.
The pass then checks:
- the app runs as non-root;
- it answers `/health` on `PORT`;
- a Node image has no dev dependency.

## Live (gated, see docs/e2e.md)

Run the Hetzner pass with `OPSCREW_E2E_APP=nextjs-postgres`, then `go-api`, then `rust-api`.
For each:
1. The deploy builds with the expected builder. `docker buildx imagetools inspect <image>
   --format '{{json .Provenance}}'` shows the repository and commit (and the build's run, no GitHub event data), and `.SBOM` lists
   packages.
2. Under a steady load (20 requests per second through the domain), a merged change deploys with
   zero failed requests.
3. A commit whose `/health` fails deploys with zero failed requests. The run fails with the builder
   hint, and the previous version still answers.
4. The running container's user is not root. The leak search finds no secret in the attestations.
