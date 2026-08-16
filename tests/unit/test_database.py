import pytest
from sqlalchemy import text

from app.infra.database import Database


TASK2_TABLES = {
    "projects",
    "tasks",
    "task_dependencies",
    "artifacts",
    "artifact_versions",
    "approvals",
    "reviews",
    "test_cases",
    "test_runs",
    "defects",
    "execution_attempts",
    "model_calls",
    "tool_calls",
    "notifications",
    "domain_events",
    "outbox_messages",
    "idempotency_records",
    "trace_links",
    "project_deletion_audits",
}


def test_database_uses_wal_and_initial_revision(tmp_path):
    database = Database(tmp_path / "company.db")

    database.initialize()

    assert database.journal_mode() == "wal"
    # 修改说明：Task 2 Schema 基线将当前兼容 revision 升至 0002，保护 Task 1 的 WAL/初始化行为。
    assert database.current_revision() == "0002_task2_domain_foundation"


def test_database_initializes_runtime_tables(tmp_path):
    database = Database(tmp_path / "company.db")

    database.initialize()

    # 修改说明：T2-AC-09 的迁移基线新增领域表，但必须保留 Task 1 四张运行时表。
    assert database.table_names() == {
        "alembic_version",
        "credential_configs",
        "runtime_events",
        "runtime_state",
        "worker_leases",
        *TASK2_TABLES,
    }


def test_database_transaction_rolls_back_on_error(tmp_path):
    """事务上下文必须让同一 SQLite 连接上的写入整体回滚。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with pytest.raises(RuntimeError, match="rollback me"):
        with database.transaction() as connection:
            connection.execute(
                text(
                    "INSERT INTO runtime_state (status, reason, updated_at) "
                    "VALUES ('running', 'rollback', '2026-08-16T00:00:00+00:00')"
                )
            )
            raise RuntimeError("rollback me")

    with database.read_connection() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM runtime_state")).scalar_one() == 0


def test_database_transaction_commits_on_success(tmp_path):
    """事务正常退出后，同一连接写入的数据必须对后续连接可见。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with database.transaction() as connection:
        connection.execute(
            text(
                "INSERT INTO runtime_state (status, reason, updated_at) "
                "VALUES ('running', 'committed', '2026-08-16T00:00:00+00:00')"
            )
        )
        assert connection.execute(text("SELECT COUNT(*) FROM runtime_state")).scalar_one() == 1

    with database.read_connection() as connection:
        assert connection.execute(
            text("SELECT status, reason FROM runtime_state")
        ).one() == ("running", "committed")
