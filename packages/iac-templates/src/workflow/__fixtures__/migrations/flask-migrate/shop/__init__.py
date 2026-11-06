"""A small Flask app whose PostgreSQL migrations Flask-Migrate runs (OpsCrew's down-migration test)."""

import os

from flask import Flask
from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def create_app() -> Flask:
    app = Flask(__name__)
    url = os.environ["DATABASE_URL"]
    app.config["SQLALCHEMY_DATABASE_URI"] = url.replace("postgres://", "postgresql+psycopg://", 1)
    db.init_app(app)
    Migrate(app, db)
    return app
