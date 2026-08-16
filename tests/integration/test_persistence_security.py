"""Task 2 持久化边界的真实 SQLite 安全验收。"""

from __future__ import annotations

from tests.support.database import migration_connection, set_revision_for_test

import os
import sqlite3
import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text

from app.api.errors import RuntimeBoundaryError
from app.infra.database import BackupReceipt, Database
from app.infra.persistence_root import PersistenceRoot
from app.config.settings import Settings
from app.main import create_app


def _make_task1_database(root: Path) -> Database:
    """创建只到 0001 的测试数据库，确保迁移前置测试走真实 Alembic 路径。"""
    database = Database(root / "company.db", persistent_root=root)
    command.upgrade(database._alembic_config(), "0001_runtime_skeleton")
    return database


def _assert_backup_blocked_without_mutation(database: Database) -> None:
    """断言不安全备份只阻断升级，不修改已有 revision 或产生临时包。"""
    before_revision = database.current_revision()
    with pytest.raises(RuntimeBoundaryError) as error:
        database.initialize()
    assert error.value.code == "MIGRATION_BACKUP_FAILED"
    assert database.current_revision() == before_revision
    backup_root = database.persistent_root / "backups"
    assert not list(backup_root.glob(".migration-*"))


@pytest.mark.parametrize("payload", [b"sk-test-secret-123456", b"Authorization: Bearer test-token-123456"])
def test_migration_backup_blocks_obvious_secrets_in_persistent_files(tmp_path, payload):
    """artifact/traces/workspaces 中的明显凭据不得进入迁移备份包。"""
    database = _make_task1_database(tmp_path)
    artifact = tmp_path / "artifacts" / "payload.bin"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(payload)

    _assert_backup_blocked_without_mutation(database)


def test_migration_backup_rejects_file_and_directory_symlinks(tmp_path):
    """备份源目录中的文件和目录符号链接都必须阻断，不能跟随越界。"""
    database = _make_task1_database(tmp_path)
    outside = tmp_path.parent / f"outside-{tmp_path.name}"
    outside.mkdir()
    (outside / "secret.txt").write_text("sk-outside-secret-123456")
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()

    symlink = artifacts / "outside.txt"
    directory_link = artifacts / "outside-dir"
    try:
        symlink.symlink_to(outside / "secret.txt")
        directory_link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("filesystem does not support symlinks")

    _assert_backup_blocked_without_mutation(database)


def test_migration_backup_rejects_special_files_and_cleans_temporary_package(tmp_path):
    """FIFO 等特殊文件不能被读取或复制，失败时临时备份目录必须清理。"""
    database = _make_task1_database(tmp_path)
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    fifo = artifacts / "blocked.fifo"
    try:
        os.mkfifo(fifo)
    except (OSError, NotImplementedError):
        pytest.skip("filesystem does not support FIFOs")

    _assert_backup_blocked_without_mutation(database)


def test_callback_failure_message_does_not_leak_exception_text(tmp_path):
    """备份回调的原始异常（凭据和绝对路径）不得进入结构化错误。"""
    database = _make_task1_database(tmp_path)

    def failed_callback(_context):
        raise RuntimeError("sk-secret-123456 Bearer bearer-secret /private/absolute/path")

    with pytest.raises(RuntimeBoundaryError) as error:
        database.initialize(backup_callback=failed_callback)

    assert error.value.code == "MIGRATION_BACKUP_FAILED"
    safe_text = str(error.value)
    assert "sk-secret-123456" not in safe_text
    assert "Bearer bearer-secret" not in safe_text
    assert "/private/absolute/path" not in safe_text


def test_true_callback_without_receipt_cannot_bypass_migration_backup(tmp_path):
    """兼容旧回调返回 True 不能在生产迁移路径绕过落盘备份。"""
    database = _make_task1_database(tmp_path)

    with pytest.raises(RuntimeBoundaryError) as error:
        database.initialize(backup_callback=lambda _context: True)

    assert error.value.code == "MIGRATION_BACKUP_FAILED"
    assert database.current_revision() == "0001_runtime_skeleton"
    assert not list((tmp_path / "backups").glob("migration-0001-to-0002-*/"))


def test_schema_integrity_conflict_blocks_transaction_after_trigger_removed(tmp_path):
    """revision=0002 但 immutable trigger 被删除时必须进入只读阻断。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        connection.execute(text("DROP TRIGGER trg_domain_events_immutable_update"))

    result = database.check_schema()
    assert result.writable is False
    assert result.code == "SCHEMA_INTEGRITY_CONFLICT"
    with pytest.raises(RuntimeBoundaryError) as error:
        database.append_event("blocked", "tr_integrity", "must-not-write")
    assert error.value.code == "SCHEMA_INTEGRITY_CONFLICT"


@pytest.mark.parametrize(
    "trigger_name",
    [
        "trg_trace_links_project_scope_insert",
        "trg_trace_links_project_scope_update",
    ],
)
def test_schema_integrity_conflict_blocks_after_trace_scope_trigger_removed(tmp_path, trigger_name):
    """TraceLink 项目隔离 trigger 缺失时不能继续 readiness 或业务写入。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        connection.execute(text(f"DROP TRIGGER {trigger_name}"))

    result = database.check_schema()
    assert result.writable is False
    assert result.code == "SCHEMA_INTEGRITY_CONFLICT"
    with pytest.raises(RuntimeBoundaryError) as error:
        with database.transaction():
            pass
    assert error.value.code == "SCHEMA_INTEGRITY_CONFLICT"


def test_schema_integrity_conflict_rejects_same_name_empty_trace_trigger(tmp_path):
    """仅保留同名空 trigger 不能伪造 TraceLink 项目隔离合同。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        connection.execute(text("DROP TRIGGER trg_trace_links_project_scope_insert"))
        connection.execute(
            text(
                "CREATE TRIGGER trg_trace_links_project_scope_insert "
                "BEFORE INSERT ON trace_links BEGIN SELECT 1; END"
            )
        )

    result = database.check_schema()
    assert result.writable is False
    assert result.code == "SCHEMA_INTEGRITY_CONFLICT"


@pytest.mark.parametrize("event_name", ["INSERT", "UPDATE"])
def test_schema_integrity_rejects_same_name_trace_trigger_with_weak_unreachable_logic(
    tmp_path, event_name
):
    """只在 SQL 中放入关键片段但没有可达项目分支的 trigger 必须 blocked。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    trigger_name = (
        "trg_trace_links_project_scope_insert"
        if event_name == "INSERT"
        else "trg_trace_links_project_scope_update"
    )
    id_column = "source" if event_name == "INSERT" else "target"
    with migration_connection(database) as connection:
        connection.execute(text(f"DROP TRIGGER {trigger_name}"))
        connection.execute(
            text(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {event_name} ON trace_links
                BEGIN
                    SELECT CASE
                        WHEN 0
                         AND NEW.{id_column}_type = 'task'
                         AND NEW.project_id = NEW.project_id
                         AND EXISTS (SELECT 1 FROM tasks WHERE 0)
                         AND EXISTS (SELECT 1 FROM artifacts WHERE 0)
                        THEN RAISE(ABORT, 'unreachable trace branch')
                    END;
                END
                """
            )
        )

    result = database.check_schema()
    assert result.writable is False
    assert result.code == "SCHEMA_INTEGRITY_CONFLICT"
    with pytest.raises(RuntimeBoundaryError) as error:
        with database.transaction():
            pass
    assert error.value.code == "SCHEMA_INTEGRITY_CONFLICT"


def _make_empty_backup_receipt(database: Database, context) -> BackupReceipt:
    """构造没有真实载荷的回执，验证空包不能绕过迁移前置。"""
    package = context.persistent_root / "backups" / "fake-empty"
    package.mkdir(parents=True, exist_ok=True)
    (package / "file_manifest.json").write_text(
        '{"formatVersion": 1, "files": []}\n', encoding="utf-8"
    )
    return BackupReceipt(
        backup_id="fake-empty",
        root=package,
        source_schema_revision=context.source_schema_revision,
        target_schema_revision=context.target_schema_revision,
        file_manifest={"formatVersion": 1, "files": []},
        safety_status={
            "symlinkScan": "passed",
            "specialFileScan": "passed",
            "sensitiveContentScan": "passed",
        },
    )


def test_empty_backup_receipt_cannot_bypass_migration(tmp_path):
    """只有 file_manifest 的空包回执必须阻断 0001 -> 0002。"""
    database = _make_task1_database(tmp_path)
    with pytest.raises(RuntimeBoundaryError) as error:
        database.initialize(backup_callback=lambda context: _make_empty_backup_receipt(database, context))
    assert error.value.code == "MIGRATION_BACKUP_FAILED"
    assert database.current_revision() == "0001_runtime_skeleton"


@pytest.mark.parametrize(
    "mutation",
    ["database", "metadata", "artifacts", "source_revision", "not_sqlite", "receipt_binding"],
)
def test_incomplete_backup_receipt_preserves_0001_and_manifest(tmp_path, mutation):
    """备份包缺少关键内容或绑定上下文不符时不得改变数据库和 manifest。"""
    manifest = b'{"appVersion":"old","schemaRevision":"0001_runtime_skeleton"}'
    (tmp_path / "manifest.json").write_bytes(manifest)
    database = _make_task1_database(tmp_path)

    def callback(context):
        receipt = database._create_pre_migration_backup(context)
        if mutation == "database":
            (receipt.root / "database" / "company.db").unlink()
        elif mutation == "metadata":
            (receipt.root / "backup_metadata.json").unlink()
        elif mutation == "artifacts":
            (receipt.root / "artifacts").rmdir()
        elif mutation == "source_revision":
            metadata_path = receipt.root / "backup_metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["sourceSchemaRevision"] = "other_revision"
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        elif mutation == "not_sqlite":
            (receipt.root / "database" / "company.db").write_bytes(b"not sqlite")
        elif mutation == "receipt_binding":
            receipt = replace(receipt, database_path=tmp_path / "other.db")
        return receipt

    with pytest.raises(RuntimeBoundaryError) as error:
        database.initialize(backup_callback=callback)
    assert error.value.code == "MIGRATION_BACKUP_FAILED"
    assert database.current_revision() == "0001_runtime_skeleton"
    assert (tmp_path / "manifest.json").read_bytes() == manifest


def test_persistent_root_rejects_symlinked_parent_before_mkdir(tmp_path):
    """root 缺失但父级为 symlink 时不能在外部目录创建持久化数据。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    parent_link = tmp_path / "parent-link"
    try:
        parent_link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("filesystem does not support symlinks")
    requested_root = parent_link / "new-root"

    with pytest.raises(RuntimeBoundaryError):
        PersistenceRoot(
            requested_root,
            app_version="test-app",
            schema_revision="0002_task2_domain_foundation",
        ).initialize(update_manifest=False)
    assert not (outside / "new-root").exists()


def test_database_rejects_symlinked_wal_or_shm_without_reading_target(tmp_path):
    """WAL/SHM sidecar 只接受根目录内 regular file，不能跟随外部 symlink。"""
    database_path = tmp_path / "company.db"
    database = Database(database_path, persistent_root=tmp_path)
    database.initialize()
    database.close()
    outside = tmp_path.parent / f"sidecar-outside-{tmp_path.name}"
    outside.write_bytes(b"outside-secret")
    sidecar = Path(f"{database_path}-wal")
    try:
        sidecar.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("filesystem does not support symlinks")

    with pytest.raises(RuntimeBoundaryError) as error:
        database.file_digest()
    assert error.value.code == "PERSISTENCE_UNAVAILABLE"
    with pytest.raises(RuntimeBoundaryError) as error:
        with database.read_connection():
            pass
    assert error.value.code == "PERSISTENCE_UNAVAILABLE"


def test_migration_backup_rejects_file_over_size_limit(tmp_path):
    """备份对单文件大小设上限，且在读取内容前阻断超限文件。"""
    from app.infra.database import BACKUP_MAX_FILE_SIZE

    database = _make_task1_database(tmp_path)
    artifact = tmp_path / "artifacts" / "too-large.bin"
    artifact.parent.mkdir(parents=True)
    with artifact.open("wb") as handle:
        handle.truncate(BACKUP_MAX_FILE_SIZE + 1)

    _assert_backup_blocked_without_mutation(database)


def test_schema_integrity_conflict_blocks_transaction_after_task_table_removed(tmp_path):
    """alembic_version 不能单独证明领域表仍完整。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        connection.execute(text("DROP TABLE task_dependencies"))

    result = database.check_schema()
    assert result.writable is False
    assert result.code == "SCHEMA_INTEGRITY_CONFLICT"


@pytest.mark.parametrize("corruption", ["index_columns", "unique_constraint", "foreign_key_columns", "priority_check"])
def test_schema_integrity_contract_blocks_structural_corruption(tmp_path, corruption):
    """Schema revision=0002 仍必须满足关键 index/unique/FK/CHECK 的结构合同。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        if corruption == "index_columns":
            connection.execute(text("DROP INDEX ix_tasks_project_id"))
            connection.execute(text("CREATE INDEX ix_tasks_project_id ON tasks (id)"))
        elif corruption == "unique_constraint":
            connection.execute(text("PRAGMA foreign_keys=OFF"))
            connection.execute(text("DROP INDEX ix_tasks_project_id"))
            table_sql = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
            ).scalar_one()
            table_sql = table_sql.replace(
                "CONSTRAINT uq_tasks_project_id_id UNIQUE (project_id, id),", ""
            )
            connection.execute(text("ALTER TABLE tasks RENAME TO tasks_corrupt"))
            connection.exec_driver_sql(table_sql)
            connection.execute(text("DROP TABLE tasks_corrupt"))
            connection.execute(text("PRAGMA foreign_keys=ON"))
        elif corruption == "foreign_key_columns":
            connection.execute(text("PRAGMA foreign_keys=OFF"))
            table_sql = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'")
            ).scalar_one()
            table_sql = table_sql.replace(
                "FOREIGN KEY(project_id, task_id) REFERENCES tasks (project_id, id)",
                "FOREIGN KEY(task_id) REFERENCES tasks (id)",
            )
            connection.execute(text("ALTER TABLE artifacts RENAME TO artifacts_corrupt"))
            connection.exec_driver_sql(table_sql)
            connection.execute(text("DROP TABLE artifacts_corrupt"))
            connection.execute(text("PRAGMA foreign_keys=ON"))
        else:
            connection.execute(text("PRAGMA foreign_keys=OFF"))
            connection.execute(text("DROP INDEX ix_tasks_project_id"))
            table_sql = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
            ).scalar_one()
            table_sql = table_sql.replace(
                "CONSTRAINT ck_tasks_priority CHECK (priority IN ('P0','P1','P2','P3')),", ""
            )
            connection.execute(text("ALTER TABLE tasks RENAME TO tasks_corrupt"))
            connection.exec_driver_sql(table_sql)
            connection.execute(text("DROP TABLE tasks_corrupt"))
            connection.execute(text("PRAGMA foreign_keys=ON"))

    result = database.check_schema()
    assert result.writable is False
    assert result.code == "SCHEMA_INTEGRITY_CONFLICT"
    with pytest.raises(RuntimeBoundaryError) as error:
        with database.transaction():
            pass
    assert error.value.code == "SCHEMA_INTEGRITY_CONFLICT"


@pytest.mark.parametrize("revision", ["unknown_revision", "9999_future_revision"])
def test_blocked_readiness_is_structured_and_does_not_write(tmp_path, revision):
    """unknown/future revision 允许诊断查询，但 readiness 必须 blocked 且无动作。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    set_revision_for_test(database, revision)
    before = database.file_digest()
    app = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)

    with TestClient(app) as client:
        response = client.get("/api/v1/readiness")

    payload = response.json()
    persistence = payload["checks"]["persistence"]
    assert payload["status"] == "blocked"
    assert payload["allowedActions"] == []
    assert persistence["status"] == "blocked"
    assert persistence["code"] == "VERSION_CONFLICT"
    assert persistence["dataPreserved"] is True
    assert persistence["schemaRevision"] == revision
    assert persistence["nextAction"]
    assert database.file_digest() == before


def test_wal_unknown_readiness_preserves_database_and_sidecar_bytes(tmp_path):
    """WAL unknown/future readiness 前后主库和 sidecar 的存在性/字节必须不变。"""
    database_path = tmp_path / "company.db"
    database = Database(database_path, persistent_root=tmp_path)
    database.initialize()
    set_revision_for_test(database, "9999_future_revision")
    database.close()

    def snapshot():
        return {
            path.name: (path.exists(), path.read_bytes() if path.exists() else None)
            for path in (
                database_path,
                Path(f"{database_path}-wal"),
                Path(f"{database_path}-shm"),
            )
        }

    before_mode = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True).execute(
        "PRAGMA journal_mode"
    ).fetchone()[0]
    # raw sqlite3 的 WAL 只读探针本身可能刷新 shm；以 journal mode 查询完成后的
    # 磁盘状态作为基线，确保下面只验证应用启动路径没有额外副作用。
    before = snapshot()
    app = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)
    with TestClient(app) as client:
        response = client.get("/api/v1/readiness")
    assert response.json()["checks"]["persistence"]["code"] == "VERSION_CONFLICT"
    assert snapshot() == before
    assert sqlite3.connect(f"file:{database_path}?mode=ro", uri=True).execute(
        "PRAGMA journal_mode"
    ).fetchone()[0] == before_mode


def test_all_task1_write_entrypoints_are_blocked_on_future_revision(tmp_path):
    """Task 1 的所有业务写入口都复用同一个 blocked transaction 边界。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    set_revision_for_test(database, "9999_future_revision")
    before = database.file_digest()
    entrypoints = (
        lambda: database.save_credential_config("provider", "model", "keychain://ref"),
        lambda: database.append_event("blocked", "tr_blocked", "no-write"),
        lambda: database.write_runtime_state("running", "no-write"),
        lambda: database.save_worker_lease("worker", datetime.now(timezone.utc), "active"),
    )

    for entrypoint in entrypoints:
        with pytest.raises(RuntimeBoundaryError) as error:
            entrypoint()
        assert error.value.code == "VERSION_CONFLICT"
    assert database.file_digest() == before


@pytest.mark.parametrize("configured_revision", ["0001_runtime_skeleton", "unknown_revision", ""])
def test_settings_rejects_noncanonical_revision(tmp_path, configured_revision):
    """Settings 不得把可变 revision 传给 readiness 或 manifest。"""
    with pytest.raises(ValidationError):
        Settings(persistent_root=tmp_path, current_schema_revision=configured_revision)


def test_migration_sql_failure_is_structured_and_does_not_leak_details(tmp_path, monkeypatch):
    """Alembic/SQLAlchemy 失败不得把底层 SQL、路径或异常文本暴露给调用方。"""
    database = _make_task1_database(tmp_path)

    def failed_upgrade(*_args, **_kwargs):
        raise RuntimeError("SQL failed at /private/db company.db Bearer secret-value")

    monkeypatch.setattr("app.infra.database.command.upgrade", failed_upgrade)
    with pytest.raises(RuntimeBoundaryError) as error:
        database.initialize(backup_callback=lambda context: database._create_pre_migration_backup(context))

    assert error.value.code == "SCHEMA_MIGRATION_FAILED"
    assert "SQL failed" not in str(error.value)
    assert "/private/db" not in str(error.value)
    assert "Bearer secret-value" not in str(error.value)
    assert database.current_revision() == "0001_runtime_skeleton"


def test_app_state_schema_error_is_safe_when_backup_callback_fails(tmp_path, monkeypatch):
    """启动保存的 schema_initialization_error 也不能携带回调异常原文。"""
    _make_task1_database(tmp_path)

    def failed_backup(_self, _context):
        raise RuntimeError("sk-app-state-secret Bearer app-state-token /private/path")

    monkeypatch.setattr(Database, "_create_pre_migration_backup", failed_backup)
    app = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=True)
    state_text = json.dumps(app.state.schema_initialization_error, ensure_ascii=False)
    assert "sk-app-state-secret" not in state_text
    assert "Bearer app-state-token" not in state_text
    assert "/private/path" not in state_text
    assert app.state.schema_initialization_error["code"] == "MIGRATION_BACKUP_FAILED"


def test_blocked_database_has_no_public_writable_engine_and_read_connection_is_read_only(tmp_path):
    """blocked 数据库只能诊断查询，不能通过公开连接逃逸写保护。"""
    database = _make_task1_database(tmp_path)
    assert not hasattr(database, "engine")
    set_revision_for_test(database, "9999_future_revision")

    with pytest.raises(RuntimeBoundaryError) as error:
        with database.transaction():
            pass
    assert error.value.code == "VERSION_CONFLICT"

    with database.read_connection() as connection:
        with pytest.raises(Exception):
            connection.execute(
                text(
                    "INSERT INTO runtime_events (event_type, trace_id, payload, occurred_at) "
                    "VALUES ('escaped', 'trace', 'must-not-write', '2026-08-16T00:00:00+00:00')"
                )
            )


def test_delete_mode_legacy_check_does_not_enable_wal_or_create_sidecars(tmp_path):
    """legacy DELETE-mode 数据库被阻断前后文件和 journal mode 必须完全不变。"""
    database_path = tmp_path / "company.db"
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete"
        connection.execute("CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO legacy_data (value) VALUES ('preserve')")
        connection.commit()
    before_bytes = database_path.read_bytes()
    sidecars_before = {path.name: path.read_bytes() for path in tmp_path.glob("company.db-*")}

    database = Database(database_path, persistent_root=tmp_path)
    result = database.check_schema()

    assert result.writable is False
    assert result.code == "VERSION_CONFLICT"
    assert database.journal_mode() == "delete"
    assert database_path.read_bytes() == before_bytes
    assert {path.name: path.read_bytes() for path in tmp_path.glob("company.db-*")} == sidecars_before


def test_database_unavailable_is_structured_in_readiness(tmp_path):
    """数据库目录/损坏文件不得把 SQLAlchemy 原始异常暴露为 readiness 500。"""
    database_path = tmp_path / "company.db"
    database_path.mkdir()
    app = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)

    with TestClient(app) as client:
        response = client.get("/api/v1/readiness")

    assert response.status_code == 200
    persistence = response.json()["checks"]["persistence"]
    assert persistence["status"] == "blocked"
    assert persistence["code"] == "PERSISTENCE_UNAVAILABLE"
    assert str(database_path) not in response.text
    assert "OperationalError" not in response.text


def test_database_rejects_noncanonical_schema_configuration(tmp_path):
    """Database 的目标 revision 必须与唯一支持基线绑定。"""
    with pytest.raises(RuntimeBoundaryError) as error:
        Database(
            tmp_path / "company.db",
            schema_revision="0001_runtime_skeleton",
        )
    assert error.value.code == "SCHEMA_CONFIGURATION_INVALID"


def test_persistent_root_rejects_root_and_data_directory_symlinks(tmp_path):
    """持久化根及其受保护子目录不能通过符号链接逃逸。"""
    outside = tmp_path.parent / f"root-outside-{tmp_path.name}"
    outside.mkdir()
    root_link = tmp_path / "root-link"
    try:
        root_link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("filesystem does not support symlinks")

    with pytest.raises(RuntimeBoundaryError):
        PersistenceRoot(
            root_link,
            app_version="test-app",
            schema_revision="0002_task2_domain_foundation",
        ).initialize(update_manifest=False)

    root = tmp_path / "root"
    root.mkdir()
    artifacts_link = root / "artifacts"
    artifacts_link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(RuntimeBoundaryError):
        PersistenceRoot(
            root,
            app_version="test-app",
            schema_revision="0002_task2_domain_foundation",
        ).initialize(update_manifest=False)

    with pytest.raises(RuntimeBoundaryError) as error:
        Database(tmp_path / "outside.db", persistent_root=root)
    assert error.value.code == "SCHEMA_CONFIGURATION_INVALID"

    with pytest.raises(RuntimeBoundaryError):
        Database(root_link / "company.db", persistent_root=root_link)
