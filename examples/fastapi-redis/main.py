import os

import redis
from fastapi import FastAPI

app = FastAPI(title="Visit counter (OpsCrew example)")
cache = redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))


@app.get("/")
def index() -> dict[str, int]:
    return {"visits": int(cache.incr("visits"))}
