from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.bootstrap.application import build_runtime


def test_restart_preserves_waiting_boss_state_and_does_not_start_new_work(tmp_path):
    first = build_runtime(tmp_path, test_mode=True)
    first.lifecycle.start_sync()
    first.lifecycle.record_runtime_state_sync("waiting_boss", "approval_required")
    before = first.database.runtime_snapshot()
    first.lifecycle.stop_sync()

    second = build_runtime(tmp_path, test_mode=True)
    second.lifecycle.start_sync()

    assert second.database.runtime_snapshot() == before
    assert second.lifecycle.current_state_sync() == "waiting_boss"
    assert second.database.execution_event_count() == 0
    second.lifecycle.stop_sync()


def test_expired_worker_lease_becomes_recovery_evidence_not_retry(tmp_path):
    runtime = build_runtime(tmp_path, test_mode=True)
    runtime.lifecycle.start_sync()
    runtime.leases.register_sync(
        "worker-1",
        heartbeat_at=datetime.now(timezone.utc) - timedelta(minutes=10),
    )

    statuses = runtime.lifecycle.check_worker_leases_sync()

    assert statuses[0].status == "expired"
    assert runtime.database.execution_event_count() == 0
    runtime.lifecycle.stop_sync()
