from fastapi import FastAPI
from sqlmodel import Session, func, select

from db import engine
from models import Visit

app = FastAPI(title="Visit counter (OpsCrew example)")


@app.get("/")
def index() -> dict[str, int]:
    """Records a visit in Postgres and returns the total."""
    with Session(engine) as session:
        session.add(Visit())
        session.commit()
        total = session.exec(select(func.count()).select_from(Visit)).one()
    return {"visits": total}


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness check; it does not touch the database."""
    return {"status": "ok"}
