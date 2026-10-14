import os

from sqlmodel import create_engine


def database_url() -> str:
    """DATABASE_URL for SQLAlchemy with the psycopg 3 driver (`postgres://` URLs are accepted)."""
    url = os.environ["DATABASE_URL"]
    for scheme in ("postgres://", "postgresql://"):
        if url.startswith(scheme):
            return "postgresql+psycopg://" + url[len(scheme) :]
    return url


# The engine connects on the first query, so the app starts without the database.
engine = create_engine(database_url(), pool_pre_ping=True)
