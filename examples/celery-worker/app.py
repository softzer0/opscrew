import os

import redis
from flask import Flask, request

from tasks import run_job

app = Flask(__name__)
store = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))


@app.get("/health")
def health():
    return {"status": "ok"}


@app.put("/data")
def write_data():
    store.set("data", request.get_data())
    return "", 204


@app.get("/data")
def read_data():
    value = store.get("data")
    return (value, 200) if value is not None else ("", 404)


@app.post("/jobs/<job_id>")
def queue_job(job_id):
    run_job.delay(job_id)
    return "", 202


@app.get("/jobs/<job_id>")
def job_done(job_id):
    return ("done", 200) if store.exists(f"done:{job_id}") else ("", 404)


@app.get("/cron")
def cron_runs():
    runs = int(store.get("cron-runs") or 0)
    return {"runs": runs}, 200 if runs > 0 else 404
