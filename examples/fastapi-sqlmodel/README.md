# FastAPI + SQLModel + Alembic (OpsCrew example)

A small FastAPI app that counts visits in Postgres through SQLModel and `DATABASE_URL`, with the table created by a committed Alembic migration (`alembic upgrade head`), and answers `/health` without the database.
