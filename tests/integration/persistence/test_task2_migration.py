from tests.support.database import migration_connection
from alembic import command
import hashlib
import json
import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.api.errors import RuntimeBoundaryError
from app.infra.database import Database
from app.infra.persistence_root import PersistenceRoot
from app.infra.task2_schema import PROJECT_ID_INDEX_NAMES


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


def test_task2_migration_creates_domain_tables(tmp_path):
    """迁移必须升级到 0002 并创建 Task 2 的全部持久化表。"""
    database = Database(tmp_path / "company.db")

    database.initialize()

    assert database.current_revision() == "0002_task2_domain_foundation"
    assert TASK2_TABLES.issubset(database.table_names())


def test_task2_migration_upgrades_existing_task1_database(tmp_path):
    """已有 0001 数据库必须沿批准的迁移路径升级到 0002。"""
    first = Database(tmp_path / "company.db")
    config = first._alembic_config()
    command.upgrade(config, "0001_runtime_skeleton")
    with migration_connection(first) as connection:
        connection.execute(
            text(
                "INSERT INTO runtime_events "
                "(event_type, trace_id, payload, occurred_at) "
                "VALUES (:event_type, :trace_id, :payload, :occurred_at)"
            ),
            {
                "event_type": "Task1MigrationFixture",
                "trace_id": "tr_task2_migration",
                "payload": "preserve-me",
                "occurred_at": "2026-08-16T00:00:00+00:00",
            },
        )

    second = Database(tmp_path / "company.db")
    second.initialize()

    assert second.current_revision() == "0002_task2_domain_foundation"
    assert TASK2_TABLES.issubset(second.table_names())
    packages = list((tmp_path / "backups").glob("migration-0001-to-0002-*/"))
    assert len(packages) == 1
    assert (packages[0] / "database" / "company.db").is_file()
    with second.read_connection() as connection:
        assert connection.execute(
            text(
                "SELECT event_type, trace_id, payload FROM runtime_events "
                "WHERE event_type = 'Task1MigrationFixture'"
            )
        ).one() == ("Task1MigrationFixture", "tr_task2_migration", "preserve-me")


def test_task2_migration_runs_after_verified_backup_callback(tmp_path):
    """0001 -> 0002 必须先完成可验证备份，再执行批准迁移。"""
    first = Database(tmp_path / "company.db")
    config = first._alembic_config()
    command.upgrade(config, "0001_runtime_skeleton")
    with migration_connection(first) as connection:
        connection.execute(
            text(
                "INSERT INTO runtime_state (status, reason, updated_at) "
                "VALUES ('running', 'before-backup', '2026-08-16T00:00:00+00:00')"
            )
        )

    second = Database(tmp_path / "company.db")
    observations = []

    def verified_backup(context):
        observations.append(
            (
                context.persistent_root,
                context.database_path,
                context.source_schema_revision,
                context.target_schema_revision,
            )
        )
        # T2 迁移前置必须返回真实 BackupReceipt，True 不能绕过一致性备份验证。
        return second._create_pre_migration_backup(context)

    second.initialize(backup_callback=verified_backup)

    assert observations == [
        (
            tmp_path,
            tmp_path / "company.db",
            "0001_runtime_skeleton",
            "0002_task2_domain_foundation",
        )
    ]
    assert second.current_revision() == "0002_task2_domain_foundation"
    with second.read_connection() as connection:
        assert connection.execute(
            text("SELECT status, reason FROM runtime_state")
        ).one() == ("running", "before-backup")


def test_task2_migration_backup_failure_blocks_without_mutation(tmp_path):
    """备份失败必须阻断 0001 -> 0002，且 revision 与运行数据保持不变。"""
    manifest_before = (
        b'{"appVersion":"old","schemaRevision":"0001_runtime_skeleton",'
        b'"generatedAt":"2026-01-01T00:00:00+00:00"}'
    )
    (tmp_path / "manifest.json").write_bytes(manifest_before)
    root = PersistenceRoot(
        tmp_path,
        app_version="test-app",
        schema_revision="0002_task2_domain_foundation",
    )
    root.initialize(update_manifest=False)
    first = Database(tmp_path / "company.db")
    config = first._alembic_config()
    command.upgrade(config, "0001_runtime_skeleton")
    with migration_connection(first) as connection:
        connection.execute(
            text(
                "INSERT INTO runtime_events (event_type, trace_id, payload, occurred_at) "
                "VALUES ('BeforeBackupFailure', 'tr_backup_failure', 'preserve', "
                "'2026-08-16T00:00:00+00:00')"
            )
        )

    second = Database(tmp_path / "company.db")

    def failed_backup(_context):
        raise OSError("backup device unavailable")

    with pytest.raises(RuntimeBoundaryError) as error:
        root.initialize_database(second, backup_callback=failed_backup)

    assert error.value.code == "MIGRATION_BACKUP_FAILED"
    assert second.current_revision() == "0001_runtime_skeleton"
    assert TASK2_TABLES.isdisjoint(second.table_names())
    assert (tmp_path / "manifest.json").read_bytes() == manifest_before
    with second.read_connection() as connection:
        assert connection.execute(
            text("SELECT payload FROM runtime_events WHERE event_type = 'BeforeBackupFailure'")
        ).scalar_one() == "preserve"


def test_empty_database_does_not_call_migration_backup_callback(tmp_path):
    """真正的新空库可直接初始化，不把备份回调强加给首次建库。"""
    database = Database(tmp_path / "company.db")
    called = False

    def unexpected_backup(_database_path):
        nonlocal called
        called = True
        raise AssertionError("empty database must not require a migration backup")

    database.initialize(backup_callback=unexpected_backup)

    assert called is False
    assert database.current_revision() == "0002_task2_domain_foundation"


def test_default_migration_backup_is_a_verified_persistent_root_package(tmp_path):
    """默认前置必须备份 DB、四类目录和 manifest，并按清单校验 hash。"""
    manifest_bytes = (
        b'{"appVersion":"old-app","schemaRevision":"0001_runtime_skeleton",'
        b'"generatedAt":"2026-01-01T00:00:00+00:00","directories":[]}'
    )
    (tmp_path / "manifest.json").write_bytes(manifest_bytes)
    fixtures = {
        "artifacts": "artifact-content",
        "traces": "trace-content",
        "workspaces": "workspace-content",
    }
    for directory, content in fixtures.items():
        path = tmp_path / directory / "project-one" / f"{directory}.txt"
        path.parent.mkdir(parents=True)
        path.write_text(content)
    (tmp_path / "credentials.txt").write_text("keychain://do-not-copy-this")

    first = Database(
        tmp_path / "company.db",
        persistent_root=tmp_path,
        app_version="test-app",
        schema_revision="0002_task2_domain_foundation",
    )
    command.upgrade(first._alembic_config(), "0001_runtime_skeleton")
    with migration_connection(first) as connection:
        connection.execute(
            text(
                "INSERT INTO credential_configs "
                "(provider, model, secret_ref, config_version, connection_status, created_at, updated_at) "
                "VALUES ('test-provider', 'test-model', 'keychain://do-not-copy-this', '1', "
                "'unknown', '2026-08-16T00:00:00+00:00', '2026-08-16T00:00:00+00:00')"
            )
        )
    second = Database(
        tmp_path / "company.db",
        persistent_root=tmp_path,
        app_version="test-app",
        schema_revision="0002_task2_domain_foundation",
    )
    second.initialize()
    with second.read_connection() as connection:
        assert connection.execute(
            text("SELECT secret_ref FROM credential_configs WHERE provider = 'test-provider'")
        ).scalar_one() == "keychain://do-not-copy-this"

    packages = list((tmp_path / "backups").glob("migration-0001-to-0002-*/"))
    assert len(packages) == 1
    package = packages[0]
    assert (package / "database" / "company.db").is_file()
    for directory in ("artifacts", "traces", "workspaces"):
        assert (package / directory).is_dir()
        assert (
            package / directory / "project-one" / f"{directory}.txt"
        ).read_text() == fixtures[directory]
    assert (package / "manifest.json").read_bytes() == manifest_bytes
    assert not (package / "backups").exists()
    assert all(
        b"keychain://do-not-copy-this" not in path.read_bytes()
        for path in package.rglob("*")
        if path.is_file()
    )
    assert not any(
        "keychain://do-not-copy-this" in path.read_text(errors="ignore")
        for path in package.rglob("*")
        if path.is_file()
    )

    metadata = json.loads((package / "backup_metadata.json").read_text())
    assert metadata["appVersion"] == "test-app"
    assert metadata["sourceSchemaRevision"] == "0001_runtime_skeleton"
    assert metadata["targetSchemaRevision"] == "0002_task2_domain_foundation"
    assert metadata["backupId"]

    file_manifest = json.loads((package / "file_manifest.json").read_text())
    listed_paths = {entry["path"] for entry in file_manifest["files"]}
    assert {"database/company.db", "manifest.json", "backup_metadata.json"}.issubset(
        listed_paths
    )
    for entry in file_manifest["files"]:
        path = package / entry["path"]
        assert path.is_file()
        assert path.stat().st_size == entry["size"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"]


def test_successful_task1_upgrade_updates_manifest_after_database_migration(tmp_path):
    """只有 0001 -> 0002 成功后，根目录 manifest 才更新为 0002。"""
    root = PersistenceRoot(
        tmp_path,
        app_version="test-app",
        schema_revision="0002_task2_domain_foundation",
    )
    root.initialize(update_manifest=False)
    old_manifest = b'{"appVersion":"old","schemaRevision":"0001_runtime_skeleton"}'
    root.manifest_path.write_bytes(old_manifest)
    database = Database(
        tmp_path / "company.db",
        persistent_root=tmp_path,
        app_version="test-app",
        schema_revision="0002_task2_domain_foundation",
    )
    command.upgrade(database._alembic_config(), "0001_runtime_skeleton")

    root.initialize_database(database)

    manifest = json.loads(root.manifest_path.read_text())
    assert manifest["schemaRevision"] == "0002_task2_domain_foundation"
    assert root.manifest_path.read_bytes() != old_manifest


def test_existing_tables_without_revision_are_blocked_without_mutation(tmp_path):
    """有表但没有 Alembic revision 的 legacy 数据库必须保持只读。"""
    database = Database(tmp_path / "company.db")
    with migration_connection(database) as connection:
        connection.execute(text("CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"))
        connection.execute(
            text("INSERT INTO legacy_data (id, value) VALUES (1, 'must-preserve')")
        )

    before_tables = database.table_names()
    with pytest.raises(RuntimeError, match="VERSION_CONFLICT"):
        database.initialize()

    assert database.current_revision() is None
    assert database.table_names() == before_tables
    with database.read_connection() as connection:
        assert connection.execute(text("SELECT id, value FROM legacy_data")).one() == (
            1,
            "must-preserve",
        )


def test_empty_database_file_is_treated_as_new_database(tmp_path):
    """仅有空文件而没有用户表时，初始化仍必须执行批准迁移。"""
    database_path = tmp_path / "company.db"
    database_path.touch()
    database = Database(database_path)

    database.initialize()

    assert database.current_revision() == "0002_task2_domain_foundation"
    assert TASK2_TABLES.issubset(database.table_names())


def test_domain_events_are_append_only(tmp_path):
    """领域事件正文不得被直接 UPDATE 或 DELETE，保护 T2-AC-03 的追加历史。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with migration_connection(database) as connection:
        connection.exec_driver_sql(
            """
            INSERT INTO domain_events (
                event_id, event_type, aggregate_type, aggregate_id,
                aggregate_version, global_sequence, occurred_at,
                actor_type, actor_id, input_summary, output_summary,
                result, failure, retry_count, trace_id, payload_json
            ) VALUES (
                'evt_test', 'TestCreated', 'project', 'project_test',
                1, 1, '2026-08-16T00:00:00+00:00',
                'test', 'test', '{}', '{}',
                'success', NULL, 0, 'tr_test', '{}'
            )
            """
        )

        try:
            connection.exec_driver_sql(
                "UPDATE domain_events SET result = 'changed' WHERE event_id = 'evt_test'"
            )
        except Exception as error:
            assert "immutable" in str(error).lower()
        else:
            raise AssertionError("domain_events update must be rejected")

        with pytest.raises(IntegrityError, match="immutable"):
            connection.exec_driver_sql("DELETE FROM domain_events WHERE event_id = 'evt_test'")


def test_domain_events_persist_structured_duration(tmp_path):
    """事件必须持久化结构化耗时，满足 PRD §7.9/SR-EVT-001。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with migration_connection(database) as connection:
        _insert_domain_event(
            connection,
            event_id="evt_duration",
            aggregate_version=1,
            global_sequence=1,
            duration_ms=1250,
        )

    with database.read_connection() as connection:
        columns = {column["name"] for column in inspect(connection).get_columns("domain_events")}
        assert "duration_ms" in columns
        assert connection.execute(
            text("SELECT duration_ms FROM domain_events WHERE event_id = 'evt_duration'")
        ).scalar_one() == 1250


def _insert_domain_event(
    connection,
    *,
    event_id: str,
    aggregate_version: int,
    global_sequence: int,
    duration_ms: int = 0,
):
    """插入满足最小事件合同的测试事实，供唯一约束测试复用。"""
    connection.execute(
        text(
            "INSERT INTO domain_events ("
            "event_id, event_type, aggregate_type, aggregate_id, aggregate_version, "
            "global_sequence, occurred_at, duration_ms, actor_type, actor_id, input_summary, "
            "output_summary, result, failure, retry_count, trace_id, payload_json"
            ") VALUES ("
            ":event_id, 'TestCreated', 'project', 'project_test', :aggregate_version, "
            ":global_sequence, :occurred_at, :duration_ms, 'test', 'test', '{}', '{}', 'success', "
            "NULL, 0, 'tr_test', '{}'"
            ")"
        ),
        {
            "event_id": event_id,
            "aggregate_version": aggregate_version,
            "global_sequence": global_sequence,
            "occurred_at": "2026-08-16T00:00:00+00:00",
            "duration_ms": duration_ms,
        },
    )


def _insert_project(connection, project_id: str = "project_test"):
    """插入满足外键父表最小字段的测试项目。"""
    connection.execute(
        text(
            "INSERT INTO projects ("
            "id, name, business_goal, target_users, priority, constraints_json, "
            "stage, status, created_at"
            ") VALUES (:id, 'Test', 'Goal', 'Users', 'P0', '{}', '立项', '准备中', "
            "'2026-08-16T00:00:00+00:00')"
        ),
        {"id": project_id},
    )


def test_projects_and_tasks_reject_unknown_status(tmp_path):
    """项目和任务状态必须由数据库 CHECK 约束限制在冻结集合内。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with migration_connection(database) as connection:
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO projects ("
                    "id, name, business_goal, target_users, priority, constraints_json, "
                    "stage, status, created_at"
                    ") VALUES ('project_invalid', 'Test', 'Goal', 'Users', 'P0', '{}', "
                    "'立项', 'invalid', '2026-08-16T00:00:00+00:00')"
                )
            )

        _insert_project(connection)
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO tasks ("
                    "id, project_id, title, owner_role, specialist_tag, assignment_reason, "
                    "priority, dependencies_json, expected_deliverables_json, status, created_at"
                    ") VALUES ('task_invalid', 'project_test', 'Test', 'developer', 'backend', "
                    "'test', 'P0', '[]', '[]', 'invalid', '2026-08-16T00:00:00+00:00')"
                )
            )


def test_domain_event_aggregate_version_is_unique(tmp_path):
    """同一聚合版本只能对应一条领域事件。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        _insert_domain_event(connection, event_id="evt_one", aggregate_version=1, global_sequence=1)
    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            _insert_domain_event(connection, event_id="evt_two", aggregate_version=1, global_sequence=2)


def test_domain_event_global_sequence_is_unique(tmp_path):
    """全局事件序号只能对应一条领域事件，保障稳定排序游标。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        _insert_domain_event(connection, event_id="evt_one", aggregate_version=1, global_sequence=1)
    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            _insert_domain_event(connection, event_id="evt_two", aggregate_version=2, global_sequence=1)


def test_artifact_version_identity_is_unique(tmp_path):
    """同一 Artifact 的版本号不能重复。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        _insert_project(connection)
        connection.execute(
            text(
                "INSERT INTO artifacts ("
                "id, project_id, name, artifact_type, owner_role, status, created_at, created_by"
                ") VALUES ('artifact_test', 'project_test', 'Test', 'document', 'developer', "
                "'active', '2026-08-16T00:00:00+00:00', 'test')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO artifact_versions ("
                "id, artifact_id, project_id, version_number, change_reason, store_ref, sha256, "
                "media_type, size_bytes, relative_path, created_at, created_by"
                ") VALUES ('artifact_version_one', 'artifact_test', 'project_test', 1, 'initial', "
                "'store://one', :sha256, 'text/plain', 1, 'project_test/a', "
                "'2026-08-16T00:00:00+00:00', 'test')"
            ),
            {"sha256": "a" * 64},
        )
    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO artifact_versions ("
                    "id, artifact_id, project_id, version_number, change_reason, store_ref, sha256, "
                    "media_type, size_bytes, relative_path, created_at, created_by"
                    ") VALUES ('artifact_version_two', 'artifact_test', 'project_test', 1, 'duplicate', "
                    "'store://two', :sha256, 'text/plain', 1, 'project_test/b', "
                    "'2026-08-16T00:00:00+00:00', 'test')"
                ),
                {"sha256": "b" * 64},
            )


def test_task_dependency_pair_is_unique(tmp_path):
    """同一任务依赖边不能重复。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        _insert_project(connection)
        connection.execute(
            text(
                "INSERT INTO tasks ("
                "id, project_id, title, owner_role, specialist_tag, assignment_reason, priority, "
                "dependencies_json, expected_deliverables_json, status, created_at"
                ") VALUES ('task_one', 'project_test', 'One', 'developer', 'backend', 'test', 'P0', "
                "'[]', '[]', '待处理', '2026-08-16T00:00:00+00:00'), "
                "('task_two', 'project_test', 'Two', 'developer', 'backend', 'test', 'P0', "
                "'[]', '[]', '待处理', '2026-08-16T00:00:00+00:00')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO task_dependencies ("
                "project_id, task_id, depends_on_task_id, created_at"
                ") VALUES ('project_test', 'task_two', 'task_one', '2026-08-16T00:00:00+00:00')"
            )
        )
    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO task_dependencies ("
                    "project_id, task_id, depends_on_task_id, created_at"
                    ") VALUES ('project_test', 'task_two', 'task_one', '2026-08-16T00:00:00+00:00')"
                )
            )


def test_outbox_event_id_is_unique(tmp_path):
    """一个领域事件只能生成一条 Outbox 消息。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        _insert_domain_event(connection, event_id="evt_outbox", aggregate_version=1, global_sequence=1)
    with migration_connection(database) as connection:
        connection.execute(
            text(
                "INSERT INTO outbox_messages ("
                "id, event_id, topic, payload_json, created_at, status"
                ") VALUES ('outbox_one', 'evt_outbox', 'events', '{}', "
                "'2026-08-16T00:00:00+00:00', 'pending')"
            )
        )
    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO outbox_messages ("
                    "id, event_id, topic, payload_json, created_at, status"
                    ") VALUES ('outbox_two', 'evt_outbox', 'events', '{}', "
                    "'2026-08-16T00:00:00+00:00', 'pending')"
                )
            )


def test_idempotency_key_is_unique(tmp_path):
    """同一个幂等键只能保存一条命令结果。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        connection.execute(
            text(
                "INSERT INTO idempotency_records ("
                "id, idempotency_key, command_id, aggregate_type, aggregate_id, "
                "request_hash, response_json, created_at"
                ") VALUES ('idem_one', 'same-key', 'cmd_one', 'project', 'project_test', "
                "'hash_one', '{}', '2026-08-16T00:00:00+00:00')"
            )
        )
    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO idempotency_records ("
                    "id, idempotency_key, command_id, aggregate_type, aggregate_id, "
                    "request_hash, response_json, created_at"
                    ") VALUES ('idem_two', 'same-key', 'cmd_two', 'project', 'project_test', "
                    "'hash_two', '{}', '2026-08-16T00:00:00+00:00')"
                )
            )


def test_trace_link_identity_is_unique(tmp_path):
    """同一来源、目标和关系不能重复创建追踪链。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        _insert_project(connection)
        # trace_links 的多态 source/target 也必须落在同一 project_id；为测试
        # 合法关系先建立真实的 task -> artifact_version 对象，而不是只依赖
        # Python 声明层的唯一约束。
        connection.execute(
            text(
                "INSERT INTO tasks ("
                "id, project_id, title, owner_role, specialist_tag, assignment_reason, "
                "priority, dependencies_json, expected_deliverables_json, status, created_at"
                ") VALUES ('task_test', 'project_test', 'Task', 'developer', 'backend', 'test', "
                "'P0', '[]', '[]', '待处理', '2026-08-16T00:00:00+00:00')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO artifacts ("
                "id, project_id, task_id, name, artifact_type, owner_role, status, created_at, created_by"
                ") VALUES ('artifact_test', 'project_test', 'task_test', 'Artifact', 'document', "
                "'developer', 'active', '2026-08-16T00:00:00+00:00', 'test')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO artifact_versions ("
                "id, artifact_id, project_id, version_number, change_reason, store_ref, sha256, "
                "media_type, size_bytes, relative_path, created_at, created_by"
                ") VALUES ('artifact_test_v1', 'artifact_test', 'project_test', 1, 'initial', "
                "'store://artifact_test_v1', :sha256, 'text/plain', 1, 'project_test/artifact.txt', "
                "'2026-08-16T00:00:00+00:00', 'test')"
            ),
            {"sha256": "a" * 64},
        )
        connection.execute(
            text(
                "INSERT INTO trace_links ("
                "id, project_id, source_type, source_id, target_type, target_id, "
                "relation, trace_id, created_at"
                ") VALUES ('trace_one', 'project_test', 'task', 'task_test', 'artifact_version', "
                "'artifact_test_v1', 'produces', 'tr_one', '2026-08-16T00:00:00+00:00')"
            )
        )
    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO trace_links ("
                    "id, project_id, source_type, source_id, target_type, target_id, "
                    "relation, trace_id, created_at"
                    ") VALUES ('trace_two', 'project_test', 'task', 'task_test', 'artifact_version', "
                    "'artifact_test_v1', 'produces', 'tr_two', '2026-08-16T00:00:00+00:00')"
                )
            )


def test_trace_links_allow_documented_logical_nodes(tmp_path):
    """规格允许无独立表的 requirement/验收标准/evidence 作为逻辑节点。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    with migration_connection(database) as connection:
        _insert_project(connection)
        connection.execute(
            text(
                "INSERT INTO trace_links ("
                "id, project_id, source_type, source_id, target_type, target_id, "
                "relation, trace_id, created_at"
                ") VALUES ('trace_logical', 'project_test', 'requirement', 'req-1', "
                "'acceptance_criterion', 'ac-1', 'covers', 'tr_logical', "
                "'2026-08-16T00:00:00+00:00')"
            )
        )


def test_foreign_keys_are_enabled_and_reject_orphan_tasks(tmp_path):
    """SQLite 外键必须开启，并拒绝不存在项目的孤立任务。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with migration_connection(database) as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar_one() == 1
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO tasks ("
                    "id, project_id, title, owner_role, specialist_tag, assignment_reason, "
                    "priority, dependencies_json, expected_deliverables_json, status, created_at"
                    ") VALUES ('orphan_task', 'missing_project', 'Test', 'developer', 'backend', "
                    "'test', 'P0', '[]', '[]', '待处理', '2026-08-16T00:00:00+00:00')"
                )
            )


def test_core_foreign_keys_reject_orphans_and_match_inspector(tmp_path):
    """核心 FK 必须在 SQLite 中真实拒绝孤立引用，并与 Inspector 合同一致。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with migration_connection(database) as connection:
        _insert_project(connection)
        connection.execute(
            text(
                "INSERT INTO artifacts ("
                "id, project_id, name, artifact_type, owner_role, status, created_at, created_by"
                ") VALUES ('artifact_fk', 'project_test', 'Test', 'document', 'developer', 'active', "
                "'2026-08-16T00:00:00+00:00', 'test')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO tasks ("
                "id, project_id, title, owner_role, specialist_tag, assignment_reason, priority, "
                "dependencies_json, expected_deliverables_json, status, created_at"
                ") VALUES ('task_fk_one', 'project_test', 'One', 'developer', 'backend', 'test', 'P0', "
                "'[]', '[]', '待处理', '2026-08-16T00:00:00+00:00'), "
                "('task_fk_two', 'project_test', 'Two', 'developer', 'backend', 'test', 'P0', "
                "'[]', '[]', '待处理', '2026-08-16T00:00:00+00:00')"
            )
        )

    with database.read_connection() as connection:
        inspector = inspect(connection)
        expected = {
            ("artifact_versions", "artifact_id"): ("artifacts", "id"),
            ("artifact_versions", "parent_version_id"): ("artifact_versions", "id"),
            ("task_dependencies", "task_id"): ("tasks", "id"),
            ("task_dependencies", "depends_on_task_id"): ("tasks", "id"),
        }
        for (table_name, column_name), (referred_table, referred_column) in expected.items():
            matches = [
                foreign_key
                for foreign_key in inspector.get_foreign_keys(table_name)
                if foreign_key["constrained_columns"] == ["project_id", column_name]
            ]
            assert len(matches) == 1
            assert matches[0]["referred_table"] == referred_table
            assert matches[0]["referred_columns"] == ["project_id", referred_column]

    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO artifact_versions ("
                    "id, artifact_id, project_id, version_number, change_reason, store_ref, sha256, "
                    "media_type, size_bytes, relative_path, created_at, created_by"
                    ") VALUES ('artifact_version_orphan_artifact', 'missing_artifact', 'project_test', 1, "
                    "'initial', 'store://one', :sha256, 'text/plain', 1, 'project_test/a', "
                    "'2026-08-16T00:00:00+00:00', 'test')"
                ),
                {"sha256": "a" * 64},
            )

    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO artifact_versions ("
                    "id, artifact_id, project_id, version_number, parent_version_id, change_reason, "
                    "store_ref, sha256, media_type, size_bytes, relative_path, created_at, created_by"
                    ") VALUES ('artifact_version_orphan_parent', 'artifact_fk', 'project_test', 1, "
                    "'missing_version', 'initial', 'store://one', :sha256, 'text/plain', 1, "
                    "'project_test/a', '2026-08-16T00:00:00+00:00', 'test')"
                ),
                {"sha256": "b" * 64},
            )

    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id, created_at) "
                    "VALUES ('project_test', 'missing_task', 'task_fk_one', "
                    "'2026-08-16T00:00:00+00:00')"
                )
            )

    with pytest.raises(IntegrityError):
        with migration_connection(database) as connection:
            connection.execute(
                text(
                    "INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id, created_at) "
                    "VALUES ('project_test', 'task_fk_two', 'missing_dependency', "
                    "'2026-08-16T00:00:00+00:00')"
                )
            )


def test_every_project_scoped_table_has_project_id_index(tmp_path):
    """每个项目范围表必须有可预测的 project_id 索引。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with database.read_connection() as connection:
        inspector = inspect(connection)
        for table_name, index_name in PROJECT_ID_INDEX_NAMES.items():
            index_names = {index["name"] for index in inspector.get_indexes(table_name)}
            assert index_name in index_names


def test_project_scoped_foreign_keys_reject_cross_project_references(tmp_path):
    """项目范围对象的真实 SQLite 复合 FK 不得跨项目引用。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with migration_connection(database) as connection:
        _insert_project(connection, "project_one")
        _insert_project(connection, "project_two")
        connection.execute(
            text(
                "INSERT INTO tasks ("
                "id, project_id, title, owner_role, specialist_tag, assignment_reason, priority, "
                "dependencies_json, expected_deliverables_json, status, created_at"
                ") VALUES ('task_one', 'project_one', 'One', 'developer', 'backend', 'test', 'P0', "
                "'[]', '[]', '待处理', '2026-08-16T00:00:00+00:00'), "
                "('task_two', 'project_two', 'Two', 'developer', 'backend', 'test', 'P0', "
                "'[]', '[]', '待处理', '2026-08-16T00:00:00+00:00')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO artifacts ("
                "id, project_id, task_id, name, artifact_type, owner_role, status, created_at, created_by"
                ") VALUES ('artifact_one', 'project_one', 'task_one', 'One', 'document', 'developer', "
                "'active', '2026-08-16T00:00:00+00:00', 'test')"
            )
        )

        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO artifacts ("
                    "id, project_id, task_id, name, artifact_type, owner_role, status, created_at, created_by"
                    ") VALUES ('artifact_cross', 'project_two', 'task_one', 'Cross', 'document', 'developer', "
                    "'active', '2026-08-16T00:00:00+00:00', 'test')"
                )
            )
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id, created_at) "
                    "VALUES ('project_two', 'task_two', 'task_one', '2026-08-16T00:00:00+00:00')"
                )
            )
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO artifact_versions ("
                    "id, artifact_id, project_id, version_number, change_reason, store_ref, sha256, "
                    "media_type, size_bytes, relative_path, created_at, created_by"
                    ") VALUES ('version_cross', 'artifact_one', 'project_two', 1, 'cross', 'store://cross', "
                    ":sha256, 'text/plain', 1, 'project_two/a', '2026-08-16T00:00:00+00:00', 'test')"
                ),
                {"sha256": "c" * 64},
            )
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO trace_links ("
                    "id, project_id, source_type, source_id, target_type, target_id, "
                    "relation, trace_id, created_at"
                    ") VALUES ('trace_cross', 'project_two', 'task', 'task_one', 'task', "
                    "'task_two', 'cross-project', 'tr_cross', '2026-08-16T00:00:00+00:00')"
                )
            )


def test_project_scoped_composite_foreign_key_contract_is_inspectable(tmp_path):
    """所有持有 project_id 且引用领域对象的表必须实际声明复合 FK。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    expected = {
        ("artifacts", "task_id"): ("tasks", ["project_id", "id"]),
        ("artifact_versions", "artifact_id"): ("artifacts", ["project_id", "id"]),
        ("artifact_versions", "task_id"): ("tasks", ["project_id", "id"]),
        ("artifact_versions", "parent_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("task_dependencies", "task_id"): ("tasks", ["project_id", "id"]),
        ("task_dependencies", "depends_on_task_id"): ("tasks", ["project_id", "id"]),
        ("approvals", "task_id"): ("tasks", ["project_id", "id"]),
        ("approvals", "artifact_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("approvals", "evidence_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("approvals", "response_task_id"): ("tasks", ["project_id", "id"]),
        ("reviews", "task_id"): ("tasks", ["project_id", "id"]),
        ("reviews", "artifact_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("reviews", "evidence_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("reviews", "rework_task_id"): ("tasks", ["project_id", "id"]),
        ("test_cases", "task_id"): ("tasks", ["project_id", "id"]),
        ("test_runs", "task_id"): ("tasks", ["project_id", "id"]),
        ("test_runs", "test_case_id"): ("test_cases", ["project_id", "id"]),
        ("test_runs", "baseline_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("test_runs", "evidence_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("defects", "task_id"): ("tasks", ["project_id", "id"]),
        ("defects", "source_test_run_id"): ("test_runs", ["project_id", "id"]),
        ("defects", "evidence_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("defects", "fixed_version_id"): ("artifact_versions", ["project_id", "id"]),
        ("defects", "regression_test_run_id"): ("test_runs", ["project_id", "id"]),
        ("execution_attempts", "task_id"): ("tasks", ["project_id", "id"]),
        ("execution_attempts", "retry_of_attempt_id"): ("execution_attempts", ["project_id", "id"]),
        ("model_calls", "task_id"): ("tasks", ["project_id", "id"]),
        ("model_calls", "execution_attempt_id"): ("execution_attempts", ["project_id", "id"]),
        ("tool_calls", "task_id"): ("tasks", ["project_id", "id"]),
        ("tool_calls", "execution_attempt_id"): ("execution_attempts", ["project_id", "id"]),
        ("notifications", "event_id"): ("domain_events", ["project_id", "event_id"]),
        ("outbox_messages", "event_id"): ("domain_events", ["project_id", "event_id"]),
        ("idempotency_records", "event_id"): ("domain_events", ["project_id", "event_id"]),
    }
    with database.read_connection() as connection:
        inspector = inspect(connection)
        for (table_name, constrained_column), (referred_table, referred_columns) in expected.items():
            matches = [
                foreign_key
                for foreign_key in inspector.get_foreign_keys(table_name)
                if constrained_column in foreign_key["constrained_columns"]
                and foreign_key["referred_table"] == referred_table
            ]
            assert any(
                foreign_key["constrained_columns"] == ["project_id", constrained_column]
                and foreign_key["referred_columns"] == referred_columns
                for foreign_key in matches
            ), (table_name, constrained_column, matches)


def test_task2_numeric_priority_and_json_checks_reject_invalid_values(tmp_path):
    """Task 2 的优先级、版本/计数/大小和 JSON 字段约束必须由 SQLite 执行。"""
    database = Database(tmp_path / "company.db")
    database.initialize()

    with migration_connection(database) as connection:
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO projects ("
                    "id, name, business_goal, target_users, priority, constraints_json, stage, status, created_at"
                    ") VALUES ('bad_priority', 'Bad', 'Goal', 'Users', 'P4', '{}', '立项', '准备中', "
                    "'2026-08-16T00:00:00+00:00')"
                )
            )
        _insert_project(connection)
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO tasks ("
                    "id, project_id, title, owner_role, specialist_tag, assignment_reason, priority, "
                    "dependencies_json, expected_deliverables_json, status, version, created_at"
                    ") VALUES ('bad_json', 'project_test', 'Bad', 'developer', 'backend', 'test', 'P0', "
                    "'not-json', '[]', '待处理', 1, '2026-08-16T00:00:00+00:00')"
                )
            )
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO tasks ("
                    "id, project_id, title, owner_role, specialist_tag, assignment_reason, priority, "
                    "dependencies_json, expected_deliverables_json, status, version, created_at"
                    ") VALUES ('bad_version', 'project_test', 'Bad', 'developer', 'backend', 'test', 'P0', "
                    "'[]', '[]', '待处理', -1, '2026-08-16T00:00:00+00:00')"
                )
            )
        _insert_domain_event(connection, event_id="bad_duration", aggregate_version=1, global_sequence=10)
        with pytest.raises(IntegrityError):
            connection.execute(
                text("UPDATE domain_events SET duration_ms = -1 WHERE event_id = 'bad_duration'")
            )


def test_task2_downgrade_removes_domain_tables_and_triggers(tmp_path):
    """downgrade 必须保留 Task 1 表并清理 Task 2 表与 immutable triggers。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    config = database._alembic_config()
    with migration_connection(database) as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, "0001_runtime_skeleton")

    assert database.current_revision() == "0001_runtime_skeleton"
    assert TASK2_TABLES.isdisjoint(database.table_names())
    assert {"runtime_events", "runtime_state", "worker_leases", "credential_configs"}.issubset(
        database.table_names()
    )
    with database.read_connection() as connection:
        assert connection.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        ).all() == []
