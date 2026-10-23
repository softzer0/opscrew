---
name: opscrew-adapt
description: Prepare the app's code for container deployment the OpsCrew way (production Dockerfile, .dockerignore, health endpoint, port from the environment, secrets moved to environment variables, build settings). Use after OpsCrew's design step, or whenever the user asks to containerize or productionize the app for OpsCrew.
---

# Prepare the code for deployment

The list of required changes is `codeChanges` in `opscrew/plan.yaml` (read it; do not edit it).
Work on a new branch, change only what each item needs, keep the app's behaviour, and do not add
dependencies unless there is no other way (then tell the user which and why).

In a repository with several apps, a further app's plan is `opscrew/apps/<key>/plan.yaml`
(`opscrew_app_list` names the apps): read the plan of the app the user means, and change only the
files in that app's folder.

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

## Workers, cron jobs and the storage key

`opscrew/plan.yaml` also lists what runs next to the web process. Check that the code works with it;
OpsCrew renders the containers itself.

- **Workers** (`processes.workers`): each runs in the app's own image with its `command`, as its
  own container, with the same environment as the app. Make sure that command starts the worker
  from the built image (for example the compiled `dist/worker.js`, not a TypeScript source file),
  that the web process does not also start the jobs, and that the worker finishes or hands back its
  current job when it gets SIGTERM, within `stopGraceSeconds`. A scheduler marked `single` (Celery
  beat, Laravel's scheduler) runs as one copy only.
- **Cron jobs** (`processes.cron`): schedules are in UTC. A `command` job runs in the app's image.
  A `route` job (from `vercel.json`) is a GET of the app's route with the header
  `Authorization: Bearer <CRON_SECRET>`: the route must compare it with the `CRON_SECRET`
  environment variable and refuse every other request, as on Vercel. Keep each job safe to run
  again: a run is skipped while the last one still runs.
- **Object storage** (`storage.objectStorage`): the app gets `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3` and the bucket under the variable it
  already reads. Read them from the environment; never hard-code a key or the endpoint. SDKs that
  ignore `AWS_ENDPOINT_URL_S3` (AWS SDK for JavaScript v2, Go v1, Java 1.x) need the endpoint
  passed to the client from that variable, and Garage needs path-style requests
  (`forcePathStyle: true` in the JavaScript SDK; Laravel gets `AWS_USE_PATH_STYLE_ENDPOINT`). The key itself is the user's: they create it in
  the provider's console and give it to `npx opscrew provision` in their terminal; never ask for it
  or write it into a file.
- **SQLite** (`storage.sqlite.dir`): the database file must live in that folder, which is a
  persistent volume. With the user's own Dockerfile, the folder must belong to the user the image
  runs as (`COPY --chown=…`, or `mkdir` and `chown` before `USER`): a folder copied as root stays
  root-owned, and the app cannot write its database.

## Static sites

A static SPA (Vite, CRA, Angular) needs no health endpoint; the container serves the built files
with Caddy on port 8080 and falls back to `index.html` for client-side routes.

## Finish

Show the user `git diff --stat` and the important hunks, then let them review and commit. Never push
or open a pull request without their explicit go-ahead.
