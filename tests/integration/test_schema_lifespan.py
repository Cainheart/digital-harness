from tests.support.database import migration_connection, set_revision_for_test
from datetime import datetime, timezone
import json

import pytest
from sqlalchemy import text

from fastapi.testclient import TestClient

from app.api.errors import RuntimeBoundaryError
from app.bootstrap.application import build_runtime
from app.infra.database import Database
from app.main import create_app


LEGACY_MANIFEST_BYTES = (
    b'{"appVersion":"0.0.legacy","schemaRevision":"0001_runtime_skeleton",'
    b'"generatedAt":"2026-01-01T00:00:00+00:00","directories":[]}'
)


def _prepare_incompatible_database(tmp_path, revision):
    """准备指定不兼容 revision，并在启动前写入可比较的旧 manifest。"""
    manifest_path = tmp_path / "manifest.json"
    if revision == "legacy":
        database = Database(tmp_path / "company.db")
        with migration_connection(database) as connection:
            connection.execute(text("CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT)"))
            connection.execute(text("INSERT INTO legacy_data (id, value) VALUES (1, 'preserve')"))
    else:
        first = create_app(persistent_root=tmp_path, test_mode=True)
        set_revision_for_test(first.state.database, revision)
    manifest_path.write_bytes(LEGACY_MANIFEST_BYTES)
    return manifest_path


@pytest.mark.parametrize("initialize_runtime", [True, False])
@pytest.mark.parametrize(
    "revision",
    ["legacy", "9999_unknown_revision", "9999_future_revision"],
)
def test_blocked_schema_startup_preserves_existing_manifest_bytes(
    tmp_path, initialize_runtime, revision
):
    """legacy/unknown/future 启动阻断时不能重写既有 manifest。"""
    manifest_path = _prepare_incompatible_database(tmp_path, revision)
    before = manifest_path.read_bytes()

    app = create_app(
        persistent_root=tmp_path,
        test_mode=True,
        initialize_runtime=initialize_runtime,
    )
    with TestClient(app) as client:
        response = client.get("/api/v1/readiness")

    assert response.status_code == 200
    assert response.json()["status"] == "blocked"
    assert manifest_path.read_bytes() == before == LEGACY_MANIFEST_BYTES


def test_new_database_updates_manifest_only_after_successful_schema_initialization(tmp_path):
    """真正新空库成功初始化后才写入当前 0002 manifest 基线。"""
    manifest_path = tmp_path / "manifest.json"
    assert not manifest_path.exists()

    app = create_app(persistent_root=tmp_path, test_mode=True)

    manifest = json.loads(manifest_path.read_text())
    assert app.state.database.current_revision() == "0002_task2_domain_foundation"
    assert manifest["schemaRevision"] == "0002_task2_domain_foundation"
    assert manifest["appVersion"] == app.state.settings.app_version
    assert manifest["generatedAt"]


def test_build_runtime_preserves_manifest_when_legacy_schema_is_blocked(tmp_path):
    """bootstrap/application.py 的生产初始化路径也不得改写 blocked manifest。"""
    database = Database(tmp_path / "company.db")
    with migration_connection(database) as connection:
        connection.execute(text("CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT)"))
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_bytes(LEGACY_MANIFEST_BYTES)

    with pytest.raises(RuntimeBoundaryError) as error:
        build_runtime(tmp_path, test_mode=True)

    assert error.value.code == "VERSION_CONFLICT"
    assert manifest_path.read_bytes() == LEGACY_MANIFEST_BYTES


def test_incompatible_schema_keeps_asgi_app_queryable_during_lifespan(tmp_path):
    first = create_app(persistent_root=tmp_path, test_mode=True)
    set_revision_for_test(first.state.database, "9999_future_revision")

    second = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)
    with TestClient(second) as client:
        response = client.get("/api/v1/readiness")

    assert response.status_code == 200
    assert response.json()["status"] == "blocked"
    assert response.json()["checks"]["persistence"]["status"] == "blocked"


@pytest.mark.parametrize("revision", ["9999_unknown_revision", "9999_future_revision"])
def test_unknown_and_future_schema_return_structured_blocked_readiness(tmp_path, revision):
    """未知和未来 Schema 必须以机器可读契约提供只读诊断窗口。"""
    first = create_app(persistent_root=tmp_path, test_mode=True)
    set_revision_for_test(first.state.database, revision)

    second = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)
    with TestClient(second) as client:
        response = client.get("/api/v1/readiness")
        body = response.json()

    persistence = body["checks"]["persistence"]
    assert response.status_code == 200
    assert body["status"] == "blocked"
    assert body["allowedActions"] == []
    assert second.state.schema_initialization_error["code"] == "VERSION_CONFLICT"
    assert second.state.schema_initialization_error["schemaRevision"] == revision
    assert persistence["status"] == "blocked"
    assert persistence["code"] == "VERSION_CONFLICT"
    assert persistence["impact"]
    assert persistence["dataPreserved"] is True
    assert persistence["nextAction"]
    assert persistence["schemaRevision"] == revision
    assert persistence["details"]["schemaRevision"] == revision
    assert body["traceId"]


@pytest.mark.parametrize("revision", ["9999_unknown_revision", "9999_future_revision"])
def test_blocked_readiness_cannot_start_real_execution(tmp_path, revision):
    """Schema blocked 时诊断可查询，但真实执行必须继续被 StartupGate 拒绝。"""
    first = create_app(persistent_root=tmp_path, test_mode=True)
    set_revision_for_test(first.state.database, revision)
    app = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)

    with TestClient(app):
        with pytest.raises(RuntimeBoundaryError) as error:
            import asyncio

            asyncio.run(
                app.state.startup_gate.assert_ready_for_real_execution(
                    project_id="project_blocked", trace_id="tr_blocked_execution"
                )
            )

        assert error.value.code == "WORKFLOW_GUARD_BLOCKED"
        assert app.state.database.execution_event_count() == 0


@pytest.mark.parametrize("revision", ["9999_unknown_revision", "9999_future_revision"])
@pytest.mark.parametrize(
    "entrypoint",
    [
        "save_credential_config",
        "append_event",
        "write_runtime_state",
        "save_worker_lease",
        "transaction",
    ],
)
def test_blocked_startup_rejects_all_task1_write_entries_without_mutation(
    tmp_path, revision, entrypoint
):
    """未知/未来 revision 下所有 Task 1 写入口都必须使用同一冲突边界。"""
    database = Database(tmp_path / "company.db")
    database.initialize()
    database.write_runtime_state("running", "fixture")
    set_revision_for_test(database, revision)

    app = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)
    with TestClient(app):
        before_digest = app.state.database.file_digest()
        before_state = app.state.database.read_runtime_state()

        with pytest.raises(RuntimeBoundaryError) as error:
            if entrypoint == "save_credential_config":
                app.state.database.save_credential_config("openai", "model", "memory://secret")
            elif entrypoint == "append_event":
                app.state.database.append_event("BlockedWrite", "tr_blocked", "{}")
            elif entrypoint == "write_runtime_state":
                app.state.database.write_runtime_state("blocked", "must-not-write")
            elif entrypoint == "save_worker_lease":
                app.state.database.save_worker_lease(
                    "worker-blocked", datetime.now(timezone.utc), "active"
                )
            else:
                with app.state.database.transaction() as connection:
                    connection.execute(text("INSERT INTO runtime_events (event_type) VALUES ('nope')"))

        assert error.value.code == "VERSION_CONFLICT"
        assert app.state.database.file_digest() == before_digest
        assert app.state.database.read_runtime_state() == before_state


def test_blocked_startup_database_rejects_business_transaction_writes(tmp_path):
    """启动阻断后的 Database 不能绕过 Schema 保护写入业务数据。"""
    database = Database(tmp_path / "company.db")
    with migration_connection(database) as connection:
        connection.execute(text("CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"))
        connection.execute(text("INSERT INTO legacy_data (id, value) VALUES (1, 'original')"))

    app = create_app(persistent_root=tmp_path, test_mode=True, initialize_runtime=False)
    with TestClient(app):
        assert app.state.schema_initialization_error["code"] == "VERSION_CONFLICT"
        assert app.state.schema_initialization_error["dataPreserved"] is True
        with pytest.raises(RuntimeBoundaryError) as error:
            with app.state.database.transaction() as connection:
                connection.execute(
                    text("UPDATE legacy_data SET value = 'must-not-write' WHERE id = 1")
                )

        assert error.value.code == "VERSION_CONFLICT"

    with database.read_connection() as connection:
        assert connection.execute(text("SELECT value FROM legacy_data WHERE id = 1")).scalar_one() == "original"
