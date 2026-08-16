"""Create Task 1 runtime skeleton tables.

Revision ID: 0001_runtime_skeleton
Revises:
Create Date: 2026-08-12
"""

from alembic import op
import sqlalchemy as sa


revision = "0001_runtime_skeleton"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "runtime_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("reason", sa.String(length=255), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "runtime_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(length=128), nullable=False),
        sa.Column("trace_id", sa.String(length=128), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "worker_leases",
        sa.Column("worker_id", sa.String(length=128), primary_key=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
    )
    op.create_table(
        "credential_configs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(length=128), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("secret_ref", sa.String(length=255), nullable=False),
        sa.Column("config_version", sa.String(length=64), nullable=False),
        sa.Column("connection_status", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("credential_configs")
    op.drop_table("worker_leases")
    op.drop_table("runtime_events")
    op.drop_table("runtime_state")
