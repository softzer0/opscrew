# Feature Specification: First real run and release

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/008-first-real-run`)
**Created**: 2026-10-13
**Status**: Implemented (T801–T817; T810 dropped)
**Input**: Founder go-ahead 2026-10-13 (real end-to-end run before more providers; tokens for a
throwaway Hetzner project, a throwaway GitHub repository, a Cloudflare account and the founder's
Namecheap account with poasjet.com, connected to Cloudflare for the test and restored to Afternic
afterwards); findings of the first live runs.

## Why

Features 000–007 were tested with fakes only (2,621 tests). The plan's Phase 1b exit criterion — a
stranger deploys Next.js + Postgres to Hetzner with a custom domain in under 20 minutes — has never
been checked against real services. The first live run (2026-10-13) created a real server and
reached the deploy workflow, which failed: the Next.js image needs `output: "standalone"`, a change
only the Code-change agent made, so every Next.js app deployed without a model failed to build.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy without a model (Priority: P1)

1. **Given** a Next.js app and no model credentials, **When** the user runs `opscrew adapt
   --no-ai`, merges the pull request and provisions, **Then** the image builds and the app is
   served: OpsCrew applies the build-critical change itself when the config file is a simple
   object, and the image builds without it otherwise.

### User Story 2 - The live runs pass (Priority: P1)

1. **When** the gated live test runs on Hetzner (with and without a Cloudflare domain), **Then**
   every step succeeds and teardown leaves nothing billable behind.

### User Story 3 - Honest domain answers (Priority: P2)

1. **When** the user searches for a domain that is already in their own registrar account,
   **Then** OpsCrew says so and names `opscrew domain connect <domain>` instead of "registered by
   someone else".
2. **When** a connected domain has a null MX record (`0 .`, "accepts no mail"), **Then** the copy
   plan names it as a null MX, not as "has no mail server".

### User Story 4 - Ready to release (Priority: P2)

1. **When** the CLI package is packed, **Then** `npx` from the tarball runs `opscrew --version`
   and `opscrew --help` in an empty folder; the README has a quickstart. Publishing to npm needs
   the founder's explicit approval and is not done by this feature.

## Requirements *(mandatory)*

- **FR-801**: Every supported stack MUST build its image without a model. Next.js MUST also serve
  without one: OpsCrew applies its build-critical edits and creates the health route itself where
  safe, and the generated Dockerfile builds without them. For other stacks, where the health route
  is an edit to existing code, OpsCrew says plainly that deploys fail their health check until it
  exists.
- **FR-802**: The gated live passes (Hetzner; Hetzner + Cloudflare domain) MUST succeed against
  real accounts and leave nothing billable behind.
- **FR-803**: Domain search MUST distinguish a domain in the user's own account (any registrar)
  from one registered by someone else; at Porkbun, Namecheap or GoDaddy it names
  `opscrew domain connect`, at Cloudflare it says the DNS is there already.
- **FR-804**: The connect copy plan MUST name null MX records correctly.
- **FR-805**: The CLI package MUST pack into a tarball that runs with `npx` on a clean folder
  (version 0.1.0, quickstart in the README); no publishing without approval.
- **FR-807**: Re-running OpsCrew after an earlier OpsCrew branch or pull request (open, merged or
  closed) MUST never fail a push, force-push or commit on a stale branch; deploy branches start
  from the integration branch (T808, T811, T816).
- **FR-808**: `opscrew drift` MUST report only what someone changed: values the cloud maintains
  itself (read-only in the provider schema) and relationships a provider mirrors from the other
  resource are not drift (T812, T813).
- **FR-809**: The server address MUST never be published: never in `opscrew/plan.yaml`, pull
  requests or commit messages, and not in the runbook or reports when the domain is behind
  Cloudflare's proxy; it lives in `.opscrew/server.json` with OpenTofu outputs as the fallback
  (T814, ADR 0010).
- **FR-810**: A move between providers MUST identify its old and new servers by provider (the
  `servers` output) and stop when it cannot tell them apart (T815).
- **FR-806**: Every live run is recorded in `docs/e2e.md` ("Live results": date, pass, outcome,
  findings).
- **FR-811**: The live Hetzner pass MUST run for any app in `examples/` or a public GitHub
  repository at a pinned commit (copied into the throwaway repository; the source is never
  written to), and an opt-in local Docker pass MUST build and start every example's image and get
  an answer from its health route before any server is created (founder, 2026-10-14). The matrix:
  Django + Postgres, FastAPI + Redis, Flask + SQLAlchemy + Celery (the founder's
  `softzer0/slog_cvrp_app`; its web process now, its Celery worker with feature 013's component
  model, whose acceptance test it becomes), Express, NestJS, Fastify, Hono, Vite + React, Angular,
  Next.js, Nuxt, SvelteKit, React Router and Astro. Stacks without a recipe today (Rust, Go,
  Rails, Laravel, Spring Boot, .NET) wait for feature 012's builders.
- **FR-813**: Database migrations MUST run on every deploy before the new version takes traffic:
  the plan records a release command (a Procfile `release:` line, else the framework's own:
  Django `manage.py migrate`, Flask-Migrate, Flask-DB, Alembic, Prisma `migrate deploy`), the user
  can change or remove it in `opscrew/plan.yaml`, and a failed release command fails the deploy
  while the previous version keeps serving (found by the Django pass: tables never created).
- **FR-814**: Connection settings MUST reach the app under the names it reads: every variable the
  app reads for the planned Postgres (`DATABASE_URI`, `SQLALCHEMY_DATABASE_URI`, `POSTGRES_URL`,
  `DB_URL` and similar) or Redis (`*REDIS_URL`/`*REDIS_URI`, Celery's broker and result backend)
  is derived from the service OpsCrew runs; Redis is planned when the app uses it through a
  library (`flask-redis`, `django-redis`, Celery with a Redis broker); variables loaded by prefix
  (Flask's `from_prefixed_env`) are found by name from committed example env files, and secret
  keys among them are generated (found by the founder's Flask + SQLAlchemy + Celery app).
- **FR-815**: The release command MUST cover the migration tools apps commonly use (founder,
  2026-10-14: "you just covered too little"): Python (Django, Alembic incl. SQLModel, Flask-Migrate,
  Flask-DB, Tortoise/Aerich, Piccolo, peewee-migrate, Yoyo, Masonite), Node/TS (Prisma, Drizzle,
  TypeORM, Sequelize, Knex/Objection, MikroORM, Kysely, node-pg-migrate, db-migrate, AdonisJS
  Lucid, Payload, Medusa, KeystoneJS, Redwood), and, detected now for feature 012's builders,
  Rails, Hanami, Sequel, Laravel, Symfony/Doctrine, golang-migrate, goose, Atlas, Diesel, sqlx,
  SeaORM, Phoenix/Ecto and EF Core. Apps that migrate at startup (Spring with Flyway/Liquibase,
  GORM AutoMigrate, `sqlx::migrate!`, Strapi) get no command and `design` says why. A command is
  planned only when the image can run it; otherwise OpsCrew says what to change.
- **FR-816**: Without a model, OpsCrew MUST add a health route itself for the common frameworks
  (founder, 2026-10-14: "a fuckton of variety"): file-routed (Next.js app and pages router, Nuxt,
  SvelteKit, Astro, Remix, React Router, SolidStart) by adding a file; Python (FastAPI, Flask incl.
  app factories, Django, Starlette, Litestar, Sanic, Quart, Falcon, aiohttp, Bottle, Tornado,
  Pyramid) and Node (Express, Fastify, Hono, Koa, NestJS, Elysia, Hapi, Restify, AdonisJS,
  Feathers) by a small edit next to the app object, only when it finds that object unambiguously;
  built-in endpoints (Rails `/up`, Laravel `/up`, Spring Boot Actuator) are used as they are. Any
  other case stays with the Code-change agent and is named in the pull request.
- **FR-812**: When a web app also runs background jobs (Celery, RQ, Dramatiq, BullMQ, Sidekiq …),
  OpsCrew MUST say plainly in `design` and the adapt pull request that only the web
  process is deployed for now and the jobs will not run until worker support arrives.

## Success Criteria *(mandatory)*

- **SC-801**: The Hetzner live pass passes end to end.
- **SC-802**: The Hetzner + Cloudflare pass serves `https://e2e.poasjet.com` with a valid
  certificate, then tears down.
- **SC-803**: `npx ./opscrew-0.1.0.tgz --version` prints 0.1.0 in an empty folder.
- **SC-804**: Every app of the FR-811 matrix deploys to Hetzner with `verify`, `secure` and `drift`
  clean and nothing left behind; at least one run with a model has `adapt` add a missing health
  route itself.

## Assumptions

- DigitalOcean, the Namecheap sandbox purchase and the Cloudflare Registrar sandbox are not part of
  this run (no credentials); their passes stay skipped.
- poasjet.com is restored to Afternic's nameservers after the test, on the founder's instruction.
- More tasks are appended as the live runs find problems.
- SC-804 holds for the examples; the founder's `softzer0/slog_cvrp_app` deploys once feature 012
  checks a found Dockerfile (its own does not build) and 012 runs its Celery worker.
