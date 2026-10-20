import sqlite3

from flask import Flask, request

app = Flask(__name__)


def database():
    db = sqlite3.connect("data/app.db")
    db.execute("CREATE TABLE IF NOT EXISTS items (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return db


@app.get("/health")
def health():
    return {"status": "ok"}


@app.put("/data")
def write_data():
    with database() as db:
        db.execute("REPLACE INTO items (name, value) VALUES ('data', ?)", (request.get_data(as_text=True),))
    return "", 204


@app.get("/data")
def read_data():
    row = database().execute("SELECT value FROM items WHERE name = 'data'").fetchone()
    return (row[0], 200) if row is not None else ("", 404)
