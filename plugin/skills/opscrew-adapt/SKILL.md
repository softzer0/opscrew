---
name: opscrew-adapt
description: Prepare the app's code for container deployment the OpsCrew way (production Dockerfile, .dockerignore, health endpoint, port from the environment, secrets moved to environment variables, build settings). Use after OpsCrew's design step, or whenever the user asks to containerize or productionize the app for OpsCrew.
---

# Prepare the code for deployment

The list of required changes is `codeChanges` in `opscrew/plan.yaml` (read it; do not edit it).
Work on a new branch, change only what each item needs, keep the app's behaviour, and do not add
dependencies unless there is no other way (then tell the user which and why).

## Per change kind

- **dockerfile / dockerignore / env-example:** prefer OpsCrew's templates — they run as a non-root
  user and match the detected stack. If the files are missing, generate them with the same structure
  as OpsCrew's templates: multi-stage build, base images pinned by tag and `@sha256` digest, at the
  runtime version in `app.build.runtime.version` of `opscrew/plan.yaml` (the version the app
  declares, else OpsCrew's default), dependencies installed from the lockfile, `USER` set to a
  non-root user, the app listening on `0.0.0.0:$PORT`. Write no Dockerfile when `app.build.builder`
  is `buildpacks`, `railpack` or `own-dockerfile`. `.env.example` lists variable names only, never
  values.
- **health-endpoint:** add a route that returns HTTP 200 with a tiny JSON body (`{"ok":true}`) and
  does no expensive work. Path: `/api/health` for Next.js (`app/api/health/route.ts` in the app
  router, `pages/api/health.ts` in the pages router); `/health` for Express, Fastify, NestJS, Hono,
  FastAPI, Flask, Django, Go, Java, .NET and Rust.
- **port-config:** read the port from `PORT` with the current value as the default.
- **build-config (Next.js):** set `output: "standalone"` in `next.config.*`.
- **secret-removal:** replace the hard-coded value with an environment variable read, add the name
  to `.env.example`, and tell the user the old value must be rotated at the provider.

## Static sites

A static SPA (Vite, CRA, Angular) needs no health endpoint; the container serves the built files
with Caddy on port 8080 and falls back to `index.html` for client-side routes.

## Finish

Show the user `git diff --stat` and the important hunks, then let them review and commit. Never push
or open a pull request without their explicit go-ahead.
