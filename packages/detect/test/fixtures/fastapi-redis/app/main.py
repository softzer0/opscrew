import os

import redis
from fastapi import FastAPI

app = FastAPI(title="counter")
cache = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
API_TOKEN = os.environ["API_TOKEN"]


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/hits")
def hit() -> dict[str, int]:
    return {"hits": int(cache.incr("hits"))}
