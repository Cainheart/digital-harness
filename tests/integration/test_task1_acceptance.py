from __future__ import annotations

from tests.support.database import set_revision_for_test

import asyncio

from fastapi.testclient import TestClient

from app.bootstrap.application import build_runtime
from app.main import create_app


def test_t1_ac_01_empty_environment_exposes_each_readiness_failure(tmp_path):
    client = TestClient(create_app(persistent_root=tmp_path, test_mode=True))

    response = client.get("/api/v1/readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert set(body["checks"]) == {"model", "research", "workspace", "docker", "persistence"}
    assert all(check["message"] for check in body["checks"].values())
    assert all("impact" in check and "nextAction" in check for check in body["checks"].values())


def test_t1_ac_02_incomplete_readiness_blocks_without_real_side_effects(tmp_path):
    app = create_app(persistent_root=tmp_path, test_mode=True)
    client = TestClient(app)

    response = client.get("/api/v1/readiness")

    assert response.json()["status"] == "blocked"
    assert response.json()["allowedActions"] == []
    assert app.state.database.execution_event_count() == 0


def test_t1_ac_03_incompatible_schema_is_read_only_and_data_unchanged(tmp_path):
    runtime = build_runtime(tmp_path, test_mode=True)
    runtime.lifecycle.start_sync()
    runtime.lifecycle.record_runtime_state_sync("waiting_boss", "approval_required")
    set_revision_for_test(runtime.database, "9999_future_revision")
    before = runtime.database.file_digest()

    result = runtime.database.check_schema()

    assert result.writable is False
    assert result.code == "VERSION_CONFLICT"
    assert runtime.database.file_digest() == before
    assert runtime.database.read_runtime_state()["status"] == "waiting_boss"
    # 修改说明：Schema blocked 后所有事务写入口均拒绝事件写入；恢复测试 revision 仅用于安全清理生命周期资源。
    set_revision_for_test(runtime.database, "0002_task2_domain_foundation")
    runtime.lifecycle.stop_sync()


def test_t1_ac_03_application_exposes_blocked_readiness_for_incompatible_schema(tmp_path):
    first = create_app(persistent_root=tmp_path, test_mode=True)
    set_revision_for_test(first.state.database, "9999_future_revision")

    second = create_app(persistent_root=tmp_path, test_mode=True)
    response = TestClient(second).get("/api/v1/readiness")

    assert response.status_code == 200
    assert response.json()["status"] == "blocked"
    assert response.json()["checks"]["persistence"]["status"] == "blocked"
    assert response.json()["checks"]["persistence"]["nextAction"]


def test_t1_ac_04_committed_runtime_state_survives_restart(tmp_path):
    first = build_runtime(tmp_path, test_mode=True)
    first.lifecycle.start_sync()
    first.lifecycle.record_runtime_state_sync("running", "startup_confirmed")
    before = first.database.runtime_snapshot()
    first.lifecycle.stop_sync()

    second = build_runtime(tmp_path, test_mode=True)
    second.lifecycle.start_sync()

    assert second.database.runtime_snapshot() == before
    # 修改说明：Task 2 Schema 基线将当前 revision 升至 0002，同时保护 T2-AC-09 的 Task 1 重启恢复行为。
    assert second.database.current_revision() == "0002_task2_domain_foundation"
    assert second.database.journal_mode() == "wal"
    second.lifecycle.stop_sync()


def test_t1_ac_05_secret_is_absent_from_all_persistent_and_visible_surfaces(tmp_path):
    app = create_app(persistent_root=tmp_path, test_mode=True)
    client = TestClient(app)
    secret = "sk-test-task1-DoNotPersist"
    credentials = app.state.readiness.checkers[0].credentials
    secret_ref = asyncio.run(credentials.save("openai", secret))
    app.state.database.save_credential_config("openai", "gpt-test", secret_ref)
    response = client.get("/api/v1/readiness")
    persisted_bytes = b"".join(
        path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()
    )
    client.close()

    assert secret.encode() not in persisted_bytes
    assert secret_ref.encode() in persisted_bytes
    assert secret not in response.text
    assert secret not in app.state.database.read_event_text()


def test_t1_ac_06_remote_request_is_rejected_and_creates_redacted_security_event(tmp_path):
    app = create_app(persistent_root=tmp_path, test_mode=True)
    client = TestClient(app)

    response = client.get(
        "/api/v1/readiness",
        headers={"X-Test-Remote-Address": "192.0.2.10", "Authorization": "Bearer secret-not-for-logs"},
    )

    assert response.status_code == 403
    assert response.json()["code"] == "POLICY_DENIED"
    assert response.json()["dataPreserved"] is True
    assert "secret-not-for-logs" not in app.state.database.read_event_text()


def test_t1_ac_07_waiting_or_paused_state_does_not_auto_resume_after_restart(tmp_path):
    first = build_runtime(tmp_path, test_mode=True)
    first.lifecycle.start_sync()
    first.lifecycle.record_runtime_state_sync("paused", "boss_requested")
    before_execution_events = first.database.execution_event_count()
    first.lifecycle.stop_sync()

    second = build_runtime(tmp_path, test_mode=True)
    second.lifecycle.start_sync()

    assert second.database.read_runtime_state()["status"] == "paused"
    assert second.database.execution_event_count() == before_execution_events
    second.lifecycle.stop_sync()
