"""create visits

Revision ID: 3f1c2b4a5d6e
Revises:
Create Date: 2026-11-01 00:00:00

"""

import sqlalchemy as sa
from alembic import op

revision = "3f1c2b4a5d6e"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "visits",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade():
    op.drop_table("visits")
