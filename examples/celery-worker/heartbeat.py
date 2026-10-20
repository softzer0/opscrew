"""The app's cron job: counts its runs, which `GET /cron` reports."""

import os

import redis

redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0")).incr("cron-runs")
