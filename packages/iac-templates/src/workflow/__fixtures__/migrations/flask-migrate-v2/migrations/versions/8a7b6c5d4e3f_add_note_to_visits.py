"""add note to visits

Revision ID: 8a7b6c5d4e3f
Revises: 3f1c2b4a5d6e
Create Date: 2026-11-06 00:00:00

"""

import sqlalchemy as sa
from alembic import op

revision = "8a7b6c5d4e3f"
down_revision = "3f1c2b4a5d6e"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("visits", sa.Column("note", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("visits", "note")
