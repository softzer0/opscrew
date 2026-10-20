# Workers and cron jobs

Many apps do work outside a web request: sending emails, resizing images, cleaning up old sessions.
OpsCrew runs that work as **workers**, which take jobs from a queue, and **cron jobs**, which run
on a schedule. Both run from your app's own image, next to the web process, each in its own
container with a memory limit. They cost no more than the server memory they take, which design
shows with its share of the server's price (see [Components](components.md)).

## Where workers come from

- **A `Procfile`:** every process type except `web` and `release` becomes a worker with that
  command (`worker: bundle exec sidekiq` becomes the worker `worker`).
- **A background-job library** with a usual command: Celery (`celery -A <app> worker`), RQ,
  Dramatiq, Huey, Sidekiq (`bundle exec sidekiq`), GoodJob, Solid Queue, Resque, Laravel's queue
  (`php artisan queue:work`) and Horizon.
- **A library without one** (BullMQ, asynq, river): `npx opscrew interview` asks for the command
  that starts the worker from your code, for example `node dist/worker.js`.

Schedulers that must run only once, such as Celery beat or Laravel's `php artisan schedule:work`,
are workers marked `single`: they always run as one copy.

When your app runs jobs but OpsCrew finds no worker for them, design says so: the jobs would never
run. Add a `worker` line to your `Procfile`, or a worker in `opscrew/plan.yaml`.

## A worker's settings

Each worker is an entry under `processes.workers` in `opscrew/plan.yaml`:

```yaml
processes:
  workers:
    - name: worker
      command: "celery -A shop worker --loglevel=info --concurrency 2"
      count: 2              # copies, 1 to 10
      memoryMb: 256         # each copy's memory limit
      stopGraceSeconds: 30  # time to finish the current job when it is stopped, 5 to 600
      enabled: true         # false keeps the entry and runs nothing
```

Change them there, then run `npx opscrew design` (it keeps your values and checks that they fit
the server) and `npx opscrew provision`.

A worker publishes no port and has no health check: Docker restarts it if it stops. When it is
stopped (by a deploy, a restart or a scale-down), it gets SIGTERM and `stopGraceSeconds` to finish
its current job. OpsCrew starts the command so that the signal reaches it directly; your worker
only needs to handle SIGTERM, as Celery, Sidekiq and Laravel's queue already do.

## How a deploy updates them

1. The services start first (the database, the queue) and stay up.
2. The release command runs, if your app has one.
3. The web process switches to the new version, as in [Deploys without downtime](zero-downtime.md).
4. The workers and the cron container restart with the new version.
5. For 30 seconds, every worker must stay up. If one exits or restarts, the web process and the
   workers go back to the previous version, and the run names the worker and the command to read
   its log: `docker compose logs <worker>`.

## Cron jobs

Cron jobs run in one `cron` container of your app's image, with
[supercronic](https://github.com/aptible/supercronic), a small cron for containers. OpsCrew adds it
to your image at build time, checked against its pinned checksum. The jobs are in
`opscrew/runtime/crontab`, generated from `processes.cron` in `opscrew/plan.yaml`:

```yaml
processes:
  cron:
    - name: cleanup
      schedule: "0 3 * * *"          # every day at 03:00 UTC
      command: "python manage.py clearsessions"
    - name: digest
      schedule: "*/15 * * * *"
      route: "/api/cron/digest"      # a GET of your app's own route
```

- **Times are in UTC.** There is no time zone setting: a cron container runs every job in one
  time zone, and many small images have no time zone data at all.
- **A `command` job** runs in your app's image, with the app's environment.
- **A `route` job** calls your app's route with `Authorization: Bearer <CRON_SECRET>`, as Vercel
  does. OpsCrew generates `CRON_SECRET` and gives it to your app; your route should refuse a
  request without it. The `crons` of a `vercel.json` become route jobs, so Vercel cron routes keep
  working unchanged. OpsCrew calls the route with a tool your image already has (Node.js, Python,
  Ruby, PHP or bash). When the image has none of these, design plans the job turned off and says
  why: give it a `command` that runs the job's code instead.
- **A run that is still going** when the next one is due is skipped, so jobs never pile up.

The cron container's memory limit is the app's (`app.memoryMb`) when a job runs a command, since
it runs your app's code. When every job calls a route, the container only runs supercronic and
the tool that calls the route, so its limit is 64 MB. Turn a job off with `enabled: false`.
