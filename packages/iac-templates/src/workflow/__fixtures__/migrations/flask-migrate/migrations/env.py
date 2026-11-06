"""Flask-Migrate's `flask db init` environment, trimmed to online migrations."""

import logging
from logging.config import fileConfig

from alembic import context
from flask import current_app

config = context.config
fileConfig(config.config_file_name)
logger = logging.getLogger("alembic.env")

target_db = current_app.extensions["migrate"].db
engine = target_db.engine
config.set_main_option(
    "sqlalchemy.url", engine.url.render_as_string(hide_password=False).replace("%", "%%")
)


def run_migrations_online():
    conf_args = current_app.extensions["migrate"].configure_args
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_db.metadata, **conf_args)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
