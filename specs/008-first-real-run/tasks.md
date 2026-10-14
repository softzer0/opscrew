---
description: "Tasks for 008-first-real-run"
---

# Tasks: First real run and release

**Input**: `specs/008-first-real-run/` (spec.md, plan.md) + features 000–007 + live-run findings.
**Numbering**: T801–T899. Tasks are appended as live runs find problems.

## Phase 1: Spec (lead)

- [X] T801 Spec, plan and tasks from the first live runs (lead)

## Phase 2: Fixes from the first live runs

- [X] T802 [P] [US1] Next.js builds without a model in `packages/agents/src/adapt/` and `packages/iac-templates/src/docker/`
  - Owns: `packages/agents/src/adapt/**`, `packages/iac-templates/src/docker/**`
  - Reads: plan.md "Next.js without a model"; the Next.js playbook; the Dockerfile stacks and their tests
  - Accept: deterministic `output: "standalone"` edit for the plain-object config shapes (and a new `next.config.mjs` when none exists; `outputFileTracingRoot` for monorepo apps), shown in the PR as an OpsCrew change; other shapes stay agent/manual changes; the generated Next.js Dockerfile builds whether or not the config has standalone output (a real `docker build` test of `examples/nextjs-postgres` with and without the edit, run with OPSCREW_DOCKER_TESTS=1); existing tests pass.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T803 [P] [US3] Owned domains and null MX in `packages/agents/src/domain/` and `packages/connectors/cloudflare/src/records.ts`
  - Owns: `packages/agents/src/domain/{search,connect-bind}.ts` (+ tests), `packages/connectors/cloudflare/src/records.ts` (+ test)
  - Accept: a name the registrar reports unavailable but the account holds → "already in your <Registrar> account" + `opscrew domain connect <domain>` (Porkbun/Namecheap/GoDaddy via `ownsDomain`, Cloudflare via `getDomain`), in search and compare; ownership lookups failing never fail the search; null MX (`0 .`) from a BIND file or a registrar named as a null MX ("accepts no mail") with one message.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-cloudflare`
  - Effort: medium

- [X] T808 [US1] Re-runs and the health route without a model in `packages/agents/src/adapt/` (and the deploy PR flow)
  - Owns: `packages/agents/src/adapt/**`, `packages/agents/src/provision/**`, `packages/connectors/github/src/**`
  - Accept: (a) a remote OpsCrew branch left from an earlier run never makes the push fail: with an open pull request from it, OpsCrew says so and stops before changing anything (or updates it when the remote head is OpsCrew's own commit — implementer's choice, explained); with none (merged or closed), it pushes to a new branch name and opens the PR; same for every branch OpsCrew pushes (adapt, the deploy/infra PR); (b) without a model, the Next.js health route is created deterministically (`app/api/health/route.ts` for the app router, `pages/api/health.ts` for the pages router, matching the plan's health path, never overwriting an existing file) and shown as an OpsCrew change; for stacks where the health route needs an edit to existing code, adapt says plainly that deploys fail their health check until it is added.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-github`
  - Effort: high

- [X] T809 Live test hygiene: the throwaway repository is reset (OpsCrew branches deleted, open PRs closed) before each pass (lead)

- [X] T810 Dropped by the founder (2026-10-13): the opt-in Docker build test (T802, `OPSCREW_DOCKER_TESTS=1`) already checks the image build locally, and the deploy job needs a real server, so `act` would add a large download and little coverage

- [X] T811 [US1] T808 review fixes: provision re-runs from another branch, a health route that type-checks on TypeScript < 5.2, the real created path in the PR, push failures after an unreachable origin, retarget's publish phase, route groups, `--no-push` advice
  - Owns: `packages/agents/src/adapt/**`, `packages/agents/src/provision/**`, `packages/agents/src/retarget/finish.ts`, `packages/connectors/github/src/**`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-github --filter=opscrew`
  - Effort: high

- [X] T812 Hetzner firewall drift false positive: `apply_to` mirrored from the server's `firewall_ids` is ignored (lead)

- [X] T813 Drift ignores read-only attributes for every provider (from the provider schema), keeping the explicit mirrored-relationship list (`hcloud_firewall.apply_to`)
  - Owns: `packages/iac-engine/src/**`, `packages/agents/src/drift/**`, `packages/agents/src/providers/**`
  - Accept: an optional `ProviderSchemaReader` capability of `@opscrew/iac-engine` (`tofu|terraform providers schema -json` after init, cached per run; the `IacEngine` contract is unchanged; zod parsing in drift); drift drops attributes that are computed and neither optional nor required for their resource type, and the mirrored ones; an update left with no attributes is dropped; schema unreadable → drift reports everything as today with a plain note; tests with recorded schema excerpts for digitalocean_tag counts, digitalocean_firewall status/pending_changes, hcloud_server status, cloudflare_dns_record modified_on, and real changes still reported (size, rules, firewall_ids, delete).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-engine --filter=@opscrew/agents`
  - Effort: high

- [X] T814 The server address is never published: no IP in pull requests ever; no IP in committed files (`opscrew/plan.yaml`, `opscrew/RUNBOOK.md`, reports) when the domain is behind Cloudflare's proxy — kept in OpsCrew's local state instead
  - Owns: `packages/plan-schema/src/plan.ts` (+ tests), `packages/agents/src/**` except `drift/**` beyond the address read, `packages/iac-templates/src/runbook/**`, `packages/iac-templates/src/types.ts`, `packages/cli/src/**` where it prints or reads the address
  - Accept: PR bodies say "the server" or the domain, never an IP; `plan.yaml` never contains the server address (founder: no backward compatibility, OpsCrew is unreleased); with a proxied domain the runbook and the security/verify reports contain none either (tests grep committed files, commits and PR bodies for the fake IPs); every command reads the address through one helper from `.opscrew/server.json` (gitignored) with OpenTofu outputs as the fallback; the CLI shows it locally (`opscrew status`, `status --ip`).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/agents --filter=@opscrew/iac-templates --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: xhigh

- [X] T815 T814 review fixes: retarget never infers old/new servers from the step (outputs mapped by module, or stop when ambiguous); a fresh clone without local state gets a plain "run it where the server was provisioned" instead of a failed DNS check or "run provision"; the address is refreshed after a failed apply that replaced the server
  - Owns: `packages/agents/src/{retarget,verify,design,shared,provision}/**`, `packages/iac-templates/src/infra/**`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T816 Converge fixes (agents and CLI): provision/dns never branch from a stale or wrong HEAD; `.terraform/` gitignored; runbook stable between provision and verify; `status` survives a damaged `server.json`; `--finish` completes after the old server is gone; outputs read after `init` on a computer with copied state; a note when an already-public address goes behind the proxy
  - Owns: `packages/agents/src/{provision,dns,init,shared,retarget}/**`, `packages/cli/src/commands/status.ts` (+ test)
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew`
  - Effort: high

- [X] T817 Converge fixes (templates, adapt, live test): Django builds without `STATIC_ROOT`; a Next.js `basePath` is handled or warned about for the health route; the runbook's SSH line works for `npx` users; the live domain pass asserts that the server address is in no committed file, commit message or pull request
  - Owns: `packages/iac-templates/src/{docker,runbook}/**`, `packages/agents/src/adapt/**`, `packages/cli/test/live/live.test.ts`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents --filter=opscrew`
  - Effort: medium

- [X] T818 The AI path works for real: the SDK's `StructuredOutput` tool is allowed by the tool policy (agents can return their structured result), and tool gating has one clear path (the PreToolUse hook) without the SDK's "canUseTool will not be invoked" shadowing
  - Owns: `packages/runtime-claude/src/**`, `packages/core/src/policy.ts` (+ tests)
  - Accept: a real `opscrew adapt` with a model returns the Code-change agent's report (found 2026-10-14: "StructuredOutput denied: Unknown tool"); every phase with an output schema works; the PreToolUse gate still denies what the policy denies (shell interpreters, paths outside the project, web access) for built-in and MCP tools; no SDK shadowing warning; tests with the fake runtime and the SDK option shapes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/runtime-claude --filter=@opscrew/core --filter=@opscrew/agents`
  - Effort: high

- [X] T819 T818 review follow-ups: a tool call that never passed the PreToolUse gate stops the phase (audited as ungated); explicit hook timeouts (PreToolUse long enough for a human approval, PostToolUse redaction never skipped); hook-level tests for `node -e`, `sh -c`, a Grep path outside the project and a second foreign MCP prefix
  - Owns: `packages/runtime-claude/src/**`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/runtime-claude --filter=@opscrew/agents`
  - Effort: medium

## Phase 2b: Framework matrix (founder, 2026-10-14; FR-811, SC-804)

- [ ] T820 [P] Example apps, Python and Node backends: `examples/django-postgres` (Postgres), `examples/express-api` (Postgres), `examples/nestjs-api`, `examples/fastify-api` (Redis), `examples/hono-api`
  - Owns: `examples/django-postgres/**`, `examples/express-api/**`, `examples/nestjs-api/**`, `examples/fastify-api/**`, `examples/hono-api/**`
  - Accept: FR-811. Each app is small and idiomatic for its framework (the way its docs start a project), pins exact dependency versions, serves a health route that `@opscrew/detect` finds (so a run works without a model, `codeChanges` without `health-endpoint`), starts without its database or Redis being reachable (connect lazily, the health route touches neither), reads its port and connection URLs from the environment, and has an `expected.json` that `packages/cli/test/e2e/examples.test.ts` checks; any planted `.env` uses `{{FAKE:<kind>}}` markers. Where detection or the generated Dockerfile gets one of them wrong, keep the app idiomatic and report the gap instead of bending the app around it.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: medium
- [ ] T821 [P] Example apps, frontends: `examples/angular-static`, `examples/nuxt-ssr`, `examples/sveltekit-ssr` (adapter-node), `examples/react-router-ssr` (framework mode), `examples/astro-ssr` (`@astrojs/node` standalone)
  - Owns: `examples/angular-static/**`, `examples/nuxt-ssr/**`, `examples/sveltekit-ssr/**`, `examples/react-router-ssr/**`, `examples/astro-ssr/**`
  - Accept: FR-811, with the same rules as T820; the server-rendered apps serve a health route the framework's own way (Nuxt server route, SvelteKit `+server.ts`, React Router resource route, Astro endpoint).
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: medium
- [X] T822 [P] The live test deploys any app: `OPSCREW_E2E_APP` is an example name (default `nextjs-postgres`) or `github:<owner>/<repo>@<commit>` (a public repository fetched at that full commit SHA and committed into the throwaway repository; the source repository is never written to); the test name, commit message and logs name the app; the health check uses the plan's health path; `docs/e2e.md` documents the variable and how to run the matrix one app after another
  - Owns: `packages/cli/test/live/live.test.ts`, `docs/e2e.md`
  - Accept: FR-811; without `OPSCREW_E2E_APP` the pass is unchanged; an unknown example or a ref that is not a full commit SHA stops before any cloud call with a plain message.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: medium
- [ ] T823 [P] Local Docker pass over every example: an opt-in test (`OPSCREW_DOCKER_TESTS=1`, skipped with a clear reason otherwise) that drives each example with a server through `analyze --no-ai`, `interview --answers`, `design` and `adapt --no-ai --no-push` like `examples.test.ts`, builds the image from the Dockerfile in the repository afterwards, starts it with the plan's port and placeholder connection URLs, and requires HTTP 200 from the plan's health path within two minutes; a failure names the example and shows the tail of the build or container log; containers and images are always removed; `OPSCREW_DOCKER_EXAMPLES=a,b` limits the run
  - Owns: `packages/cli/test/e2e/docker.test.ts`
  - Accept: FR-811; static examples are served and answer on `/`.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` and `OPSCREW_DOCKER_TESTS=1 OPSCREW_DOCKER_EXAMPLES=nextjs-postgres,static-vite pnpm --filter opscrew exec vitest run test/e2e/docker.test.ts`
  - Effort: high
- [ ] T826 [P] Background jobs are not silently dropped: when the facts show a web app that also uses a worker library (a `queue` service or a worker dependency such as celery, rq, dramatiq, huey, arq, bullmq, bull, sidekiq), `design` warns that only the web process is deployed for now and the background jobs will not run until worker support arrives (naming the library), and the adapt pull request body says the same
  - Owns: `packages/agents/src/design/**`, `packages/agents/src/adapt/**`
  - Accept: FR-812; no warning for an app without worker libraries; the wording is plain English and says what to do meanwhile (run the worker yourself, e.g. on the same server).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: medium
- [ ] T827 [P] Static sites start under the production hardening: the static-site image's `caddy` binary carries a file capability (`cap_net_bind_service`), which the kernel refuses under the Compose file's `cap_drop: ALL` and `no-new-privileges` ("exec /usr/bin/caddy: operation not permitted"), so every static app would crash-loop on the server; the final stage runs a copy of the binary without file capabilities (port 8080 needs none), still as a non-root user
  - Owns: `packages/iac-templates/src/docker/**`
  - Accept: found by T823's local Docker pass; `docker run --cap-drop ALL --security-opt no-new-privileges:true` of the generated static image serves `/`; the Dockerfile test pins the change.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `OPSCREW_DOCKER_TESTS=1 OPSCREW_DOCKER_EXAMPLES=static-vite pnpm --filter opscrew exec vitest run test/e2e/docker.test.ts` (after T823 is merged)
  - Effort: medium
- [ ] T828 [P] NestJS and similar TypeScript servers start in the image: the start command prefers a production script (`start:prod`, else `node dist/main` style when `start` runs a compiler or watcher such as `nest start`, `ts-node`, `tsx`, `nodemon`), because `nest start` recompiles at boot and fails as the non-root user (`EACCES: rmdir '/app/dist'`); health routes declared with decorators are detected (`@Get("health")`, and `@Controller("health")` with `@Get()`); the Django recipe installs no unpinned extra `gunicorn` when the requirements already pin it; and (found by T821) SSR frameworks: health routes of Nuxt (`server/routes`, `server/api`), SvelteKit (`+server.ts`), Astro endpoints and React Router (`app/routes.ts`) are detected, SvelteKit with adapter-node starts with `node build` and Astro with `@astrojs/node` with `node ./dist/server/entry.mjs` when there is no `start` script, React Router framework mode is server-rendered (not a static site), and the Node image sets `HOST=0.0.0.0`
  - Owns: `packages/detect/src/detect.ts`, `packages/detect/src/sources.ts`, `packages/detect/src/detect.test.ts`, `packages/detect/src/sources.test.ts`, `packages/detect/src/frameworks.ts` (and its tests), `packages/iac-templates/src/docker/**`
  - Accept: found by T820; `examples/nestjs-api` gets `npm run start:prod` (or `node dist/main`) and its health route without a `health-endpoint` code change (update its `expected.json` if the change makes that entry obsolete — tell the lead, it is outside your Owns); the Django image still runs gunicorn.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect --filter=@opscrew/iac-templates --filter=opscrew`
  - Effort: medium
- [ ] T829 [P] Variables with a default in the code are optional, and host lists are filled from the deployment: detection records when a variable has a default where it is read (`os.environ.get("X", …)`, `os.getenv("X", …)`, `process.env.X ?? …`, `process.env.X || …`, and similar); such variables are optional in the plan: `provision` asks for them but an empty answer or a missing value keeps the app's default instead of stopping with "Production values are missing"; host-list variables (`ALLOWED_HOSTS`, `*_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `*_CSRF_TRUSTED_ORIGINS`) are derived: the domain (`https://<domain>` for trusted origins), or without a domain the server address from local state (only in the deploy secrets, never in a committed file, FR-809)
  - Owns: `packages/detect/src/env.ts`, `packages/detect/src/env.test.ts`, `packages/plan-schema/src/**`, `packages/agents/src/design/plan.ts`, `packages/agents/src/design/plan.test.ts`, `packages/agents/src/shared/app-env.ts`, `packages/agents/src/shared/app-env.test.ts`, `packages/agents/src/provision/**`
  - Accept: found by T820 (Django answers 400 to every host but localhost, and asks for `DJANGO_DEBUG`, which has a default); `examples/django-postgres` provisions with an empty `OPSCREW_APP_ENV_FILE` and its `DJANGO_ALLOWED_HOSTS` holds the domain or address; a variable without a default is still required; no value is ever logged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect --filter=@opscrew/plan-schema --filter=@opscrew/agents --filter=opscrew`
  - Effort: high
- [ ] T830 [P] Migrations run on every deploy (FR-813): detection records a release command (a Procfile `release:` line first; else Django `python manage.py migrate --noinput`; Flask-Migrate `flask db upgrade`; Flask-DB `flask db migrate`; Alembic with `alembic.ini` `alembic upgrade head`; Prisma with a `prisma/migrations` folder `npx prisma migrate deploy`, only when the image keeps the Prisma CLI); the plan carries it as `app.releaseCommand` (editable, removable); the deploy runs it in a one-off container of the new image after the backing services are up and before the app container is replaced, and stops the deploy with the command's output when it fails, leaving the previous version serving; `design` and the adapt pull request say which command will run
  - Owns: `packages/detect/src/**`, `packages/plan-schema/src/**`, `packages/plan-schema/schemas/**`, `packages/agents/src/design/**`, `packages/agents/src/adapt/**`, `packages/iac-templates/src/**`, `packages/cli/test/e2e/docker.test.ts` (the local Docker pass runs the release step)
  - Accept: FR-813; `examples/django-postgres` deployed by the live pass answers 200 on `/` (it writes a row); an app without migrations gets no release command and an unchanged deploy; the Docker test and snapshots cover the deploy step; no secret or address in the command's logged output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect --filter=@opscrew/plan-schema --filter=@opscrew/agents --filter=@opscrew/iac-templates --filter=opscrew`
  - Effort: high
- [ ] T831 [P] A move between providers restores the database onto an empty schema and then runs the release command: the window recreates the app database empty (instead of relying on `pg_restore --clean`), restores the dump, runs `docker compose run --rm --no-deps -T release` when the compose file has a `release` service, and only then starts the app, so a new server deployed at a newer commit than the old one ends with the old data migrated forward (not newer tables beside old ones, lost columns, or a migration table that blocks every later release)
  - Owns: `packages/agents/src/retarget/**`
  - Accept: found by the T830 review (FR-813 with retarget, FR-810); a failed release in the window rolls back like any other window step and says so plainly; moves without a release command behave as before; tests cover both.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high
- [ ] T832 [P] Connection settings under the app's own names (FR-814): variables the app reads for the planned Postgres under other names (`DATABASE_URI`, `SQLALCHEMY_DATABASE_URI`, `POSTGRES_URL`, `POSTGRES_URI`, `DB_URL`, `DB_URI`, `*_DATABASE_URL`/`_URI`) and for Redis (`REDIS_URL`/`_URI` and `*_REDIS_URL`/`_URI`, `CELERY_BROKER_URL`/`_URI`, `CELERY_RESULT_BACKEND`, `BROKER_URL`) become derived and are filled from the services OpsCrew runs; Redis is planned when the app uses it through `flask-redis`, `django-redis`, `redis-om`, `rq`, or Celery whose broker is Redis (a Redis broker variable name, a `redis://` URL in code or committed example env/compose files, or `celery[redis]`); Flask apps that call `from_prefixed_env()` get the `FLASK_*` names listed in committed env files (`.env.example`, `.env.sample`, `docker/**/.env*`; names only, never values) as variables, and secret-key names among them (`FLASK_SECRET_KEY`, `FLASK_JWT_SECRET_KEY`) are generated
  - Owns: `packages/detect/src/**`, `packages/agents/src/design/plan.ts`, `packages/agents/src/design/plan.test.ts`, `packages/agents/src/shared/app-env.ts`, `packages/agents/src/shared/app-env.test.ts`
  - Accept: FR-814; `softzer0/slog_cvrp_app` at 2b23564 plans Postgres and Redis, derives `DATABASE_URI` and `CELERY_BROKER_URI` (and `FLASK_REDIS_URL`), generates `FLASK_SECRET_KEY`, and leaves only real user values (`MAPBOX_API_KEY`, mail settings, `FLASK_ENV` if it has no default); apps reading only `DATABASE_URL`/`REDIS_URL` are unchanged; no value is ever read from a committed env file or logged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect --filter=@opscrew/agents --filter=opscrew`
  - Effort: high
- [ ] T824 Local Docker pass green over every example; fixes appended as tasks (lead)
- [ ] T825 Hetzner pass for every app of the matrix, `fastapi-redis` and `slog_cvrp_app` with a model; results in `docs/e2e.md` (lead)

## Phase 3: Live runs (lead)

- [X] T804 Hetzner live pass green after the fixes; results in `docs/e2e.md` (lead)
- [X] T805 Hetzner + Cloudflare pass on `e2e.poasjet.com` (TLS, DNS, WAF) green; results in `docs/e2e.md` (lead)

## Phase 4: Release prep

- [X] T806 [US4] Version 0.1.0, README quickstart, pack and `npx` smoke test of the tarball
  - Owns: `packages/cli/package.json`, `README.md`, `scripts/pack-smoke.*`
  - Accept: SC-803; no publish.
  - Verify: `pnpm turbo run typecheck test build --filter=opscrew && node scripts/pack-smoke.mjs`
  - Effort: medium

## Phase 5: Verification

- [X] T807 Feature verification (lead): `pnpm check`, live passes recorded, converge review; remind the founder to restore poasjet.com to Afternic
