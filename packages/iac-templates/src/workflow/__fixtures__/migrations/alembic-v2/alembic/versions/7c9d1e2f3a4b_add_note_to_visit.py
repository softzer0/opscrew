"""add note to visit

Revision ID: 7c9d1e2f3a4b
Revises: e1b6e5756be1
Create Date: 2026-11-06 00:00:00

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "7c9d1e2f3a4b"
down_revision: Union[str, Sequence[str], None] = "e1b6e5756be1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("visit", sa.Column("note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("visit", "note")
