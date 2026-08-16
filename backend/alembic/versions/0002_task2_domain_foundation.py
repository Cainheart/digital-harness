"""Create the Task 2 domain foundation tables and immutable event history.

Revision ID: 0002_task2_domain_foundation
Revises: 0001_runtime_skeleton
Create Date: 2026-08-16
"""

from alembic import op
import sqlalchemy as sa

from app.infra.task2_schema import (
    ARTIFACT_VERSIONS_IMMUTABLE_DELETE_TRIGGER,
    ARTIFACT_VERSIONS_IMMUTABLE_UPDATE_TRIGGER,
    DOMAIN_EVENTS_IMMUTABLE_DELETE_TRIGGER,
    DOMAIN_EVENTS_IMMUTABLE_UPDATE_TRIGGER,
    PROJECT_ID_INDEXES,
    TASK2_TABLE_ORDER,
    TRACE_LINKS_PROJECT_INSERT_TRIGGER,
    TRACE_LINKS_PROJECT_UPDATE_TRIGGER,
    TRIGGER_SQL_CONTRACTS,
    metadata,
)


revision = "0002_task2_domain_foundation"
down_revision = "0001_runtime_skeleton"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create Task 2 tables and execute the single-source trigger contracts."""
    connection = op.get_bind()
    task2_tables = [metadata.tables[name] for name in TASK2_TABLE_ORDER]

    # 修改说明：T2-AC-03/T2-AC-08 和 SR-EVT-001 要求迁移与后续仓储共享同一组
    # 外键、索引、唯一约束和 domain_events.duration_ms 耗时字段，因此由 task2_schema
    # 的 SQLAlchemy Table 合同驱动 Alembic 建表，避免两套定义漂移。
    metadata.create_all(connection, tables=task2_tables, checkfirst=False)

    # 显式补建项目范围索引；checkfirst 兼容不同 SQLite/SQLAlchemy 版本对 Table.create
    # 是否级联创建 Index 的差异。
    for index in PROJECT_ID_INDEXES:
        index.create(connection, checkfirst=True)

    # 修改说明：T2-AC-03 要求 immutable 和 TraceLink project-scope trigger 的规范
    # SQL 只有一个来源；checker 也复用 task2_schema.TRIGGER_SQL_CONTRACTS。
    for trigger_name in (
        DOMAIN_EVENTS_IMMUTABLE_UPDATE_TRIGGER,
        ARTIFACT_VERSIONS_IMMUTABLE_UPDATE_TRIGGER,
        TRACE_LINKS_PROJECT_INSERT_TRIGGER,
        TRACE_LINKS_PROJECT_UPDATE_TRIGGER,
        ARTIFACT_VERSIONS_IMMUTABLE_DELETE_TRIGGER,
        DOMAIN_EVENTS_IMMUTABLE_DELETE_TRIGGER,
    ):
        op.execute(sa.text(TRIGGER_SQL_CONTRACTS[trigger_name]))


def downgrade() -> None:
    """Drop immutable event triggers and Task 2 tables in dependency order."""
    connection = op.get_bind()
    for trigger_name in (
        DOMAIN_EVENTS_IMMUTABLE_DELETE_TRIGGER,
        ARTIFACT_VERSIONS_IMMUTABLE_DELETE_TRIGGER,
        ARTIFACT_VERSIONS_IMMUTABLE_UPDATE_TRIGGER,
        DOMAIN_EVENTS_IMMUTABLE_UPDATE_TRIGGER,
        TRACE_LINKS_PROJECT_UPDATE_TRIGGER,
        TRACE_LINKS_PROJECT_INSERT_TRIGGER,
    ):
        op.execute(sa.text(f"DROP TRIGGER IF EXISTS {trigger_name}"))
    for table_name in reversed(TASK2_TABLE_ORDER):
        metadata.tables[table_name].drop(connection, checkfirst=True)
