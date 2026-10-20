import os

import redis
from celery import Celery

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery = Celery("tasks", broker=REDIS_URL)
celery.conf.beat_schedule = {"tick": {"task": "tasks.tick", "schedule": 30.0}}
store = redis.Redis.from_url(REDIS_URL)


@celery.task
def run_job(job_id):
    store.set(f"done:{job_id}", 1)


@celery.task
def tick():
    store.incr("beat-ticks")
