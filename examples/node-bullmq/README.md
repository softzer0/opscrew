# Express + BullMQ (OpsCrew example)

An Express API that queues BullMQ jobs on Redis (`REDIS_URL`). The Procfile's `worker` runs them,
and `vercel.json` calls `/api/cron/tick` every minute with the `CRON_SECRET` bearer token.
`PUT /data` and `GET /data` write and read a value, `POST /jobs/<id>` queues a job and
`GET /jobs/<id>` answers 200 once it ran, `GET /cron` once the cron job ran.
