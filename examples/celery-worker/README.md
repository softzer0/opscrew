# Flask + Celery (OpsCrew example)

A Flask API that queues Celery jobs on Redis (`REDIS_URL`): a worker runs them, Celery beat
schedules a task every 30 seconds, and `heartbeat.py` is the command the Docker pass adds to the
plan as a cron job. `PUT /data` and `GET /data` write and read a value, `POST /jobs/<id>` queues a
job and `GET /jobs/<id>` answers 200 once it ran, `GET /cron` once the cron job ran.
