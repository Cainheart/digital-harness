from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from app.domain.common import utc_now
from app.domain.errors import NotFoundError, ReadOnlyProjectError
from app.infra.artifacts import FileArtifactStore
from app.infra.database import Database
from app.infra.repositories.deletion import ProjectDeletionRepository
from app.infra.task2_schema import (
    artifact_versions,
    artifacts,
    domain_events,
    idempotency_records,
    outbox_messages,
    projects,
    trace_links,
)


def _database(tmp_path: Path, *, status: str, read_only: bool) -> Database:
    database = Database(tmp_path / "company.db")
    database.initialize()
    with database.transaction() as connection:
        connection.execute(
            projects.insert().values(
                id="project_test", name="历史项目", business_goal="目标", target_users="用户",
                priority="P0", deadline=None, constraints_json="{}", stage="结项",
                status=status, created_at=utc_now(), ended_at=utc_now(), version=1, read_only=read_only,
            )
        )
    return database


def test_active_project_cannot_be_deleted(tmp_path: Path):
    database = _database(tmp_path, status="运行中", read_only=False)
    repository = ProjectDeletionRepository(database, FileArtifactStore(tmp_path / "artifacts"))
    with pytest.raises(ReadOnlyProjectError):
        repository.delete_historical_project("project_test", "boss-local")
    database.close()


@pytest.mark.asyncio
async def test_completed_project_delete_removes_online_content_but_keeps_minimal_audit(tmp_path: Path):
    database = _database(tmp_path, status="已结项", read_only=True)
    store = FileArtifactStore(tmp_path / "artifacts")
    reference = await store.put(b"evidence", media_type="text/plain", metadata={"projectId": "project_test"})
    repository = ProjectDeletionRepository(database, store)

    report = repository.delete_historical_project("project_test", "boss-local")

    assert report.project_id == "project_test"
    assert repository.project_exists("project_test") is False
    assert repository.deletion_audit("project_test") == {
        "project_id": "project_test", "actor_id": "boss-local",
        "deleted_at": repository.deletion_audit("project_test")["deleted_at"],
    }
    assert not (store.root / reference.relative_path).exists()
    assert report.failed_paths == ()
    database.close()


def test_completed_project_deletion_purges_immutable_history_and_keeps_audit(
    tmp_path: Path,
):
    database = _database(tmp_path, status="已结项", read_only=True)
    now = utc_now()
    with database.transaction() as connection:
        connection.execute(
            artifacts.insert().values(
                id="artifact_history", project_id="project_test", task_id=None,
                name="历史证据", artifact_type="test-output", owner_role="agent_b",
                status="active", created_at=now, created_by="agent_b",
            )
        )
        connection.execute(
            artifact_versions.insert().values(
                id="artifact_version_history", artifact_id="artifact_history",
                project_id="project_test", task_id=None, version_number=1,
                parent_version_id=None, change_reason="初版", store_ref="ref",
                sha256="0" * 64, media_type="text/plain", size_bytes=0,
                relative_path="project_test/sha256/00/" + "0" * 64,
                created_at=now, created_by="agent_b",
            )
        )
        connection.execute(
            domain_events.insert().values(
                event_id="evt_history", project_id="project_test",
                event_type="EvidenceCreated", aggregate_type="project",
                aggregate_id="project_test", aggregate_version=1, global_sequence=1,
                occurred_at=now, duration_ms=0, actor_type="agent", actor_id="agent_b",
                input_summary="{}", output_summary="{}", result="success",
                failure=None, retry_count=0, trace_id="trace_history", payload_json="{}",
            )
        )
        connection.execute(
            outbox_messages.insert().values(
                id="outbox_history", project_id="project_test", event_id="evt_history",
                topic="task2", payload_json="{}", created_at=now, published_at=None,
                status="pending", retry_count=0, last_error=None, available_at=None,
            )
        )
        connection.execute(
            idempotency_records.insert().values(
                id="idempotency_history", project_id="project_test",
                idempotency_key="history-key", command_id="cmd-history",
                aggregate_type="project", aggregate_id="project_test",
                request_hash="0" * 64, response_json="{}",
                event_id="evt_history", created_at=now,
            )
        )
        connection.execute(
            trace_links.insert().values(
                id="trace_history", project_id="project_test",
                source_type="acceptance_criterion", source_id="AC-02",
                target_type="evidence", target_id="evidence-history",
                relation="proves", trace_id="trace_history", created_at=now,
            )
        )

    repository = ProjectDeletionRepository(database, FileArtifactStore(tmp_path / "artifacts"))
    repository.delete_historical_project("project_test", "boss-local")

    with database.read_connection() as connection:
        for table in (
            artifacts, artifact_versions, domain_events, outbox_messages,
            idempotency_records, trace_links,
        ):
            assert connection.execute(
                table.select().where(table.c.project_id == "project_test")
            ).first() is None
    audit = repository.deletion_audit("project_test")
    assert set(audit) == {"project_id", "deleted_at", "actor_id"}
    assert audit["project_id"] == "project_test"
    assert audit["actor_id"] == "boss-local"
    assert audit["deleted_at"] is not None
    database.close()


def test_direct_domain_event_update_and_delete_remain_blocked(tmp_path: Path):
    database = _database(tmp_path, status="已结项", read_only=True)
    now = utc_now()
    with database.transaction() as connection:
        connection.execute(
            domain_events.insert().values(
                event_id="evt_direct", project_id="project_test",
                event_type="Test", aggregate_type="project", aggregate_id="project_test",
                aggregate_version=1, global_sequence=1, occurred_at=now, duration_ms=0,
                actor_type="agent", actor_id="agent_b", input_summary="{}",
                output_summary="{}", result="success", failure=None, retry_count=0,
                trace_id="trace_direct", payload_json="{}",
            )
        )
        with pytest.raises(Exception):
            connection.execute(
                domain_events.update()
                .where(domain_events.c.event_id == "evt_direct")
                .values(result="tampered")
            )
        with pytest.raises(Exception):
            connection.execute(
                domain_events.delete().where(domain_events.c.event_id == "evt_direct")
            )
    database.close()


def test_controlled_project_purge_is_project_scoped_and_rechecks_lifecycle(tmp_path: Path):
    database = _database(tmp_path, status="已结项", read_only=True)
    now = utc_now()
    with database.transaction() as connection:
        connection.execute(
            projects.insert().values(
                id="project_other", name="另一个历史项目", business_goal="目标", target_users="用户",
                priority="P0", deadline=None, constraints_json="{}", stage="结项",
                status="已终止", created_at=now, ended_at=now, version=1, read_only=True,
            )
        )
        for event_id, project_id, sequence in (
            ("evt_scoped_test", "project_test", 10),
            ("evt_scoped_other", "project_other", 11),
        ):
            connection.execute(
                domain_events.insert().values(
                    event_id=event_id, project_id=project_id,
                    event_type="Test", aggregate_type="project", aggregate_id=project_id,
                    aggregate_version=1, global_sequence=sequence, occurred_at=now, duration_ms=0,
                    actor_type="agent", actor_id="agent_b", input_summary="{}",
                    output_summary="{}", result="success", failure=None, retry_count=0,
                    trace_id=event_id, payload_json="{}",
                )
            )

    with database.transaction() as connection:
        with database.controlled_project_purge(connection, "project_test"):
            with pytest.raises(IntegrityError):
                connection.execute(
                    domain_events.delete().where(domain_events.c.event_id == "evt_scoped_other")
                )
            connection.execute(
                domain_events.delete().where(domain_events.c.event_id == "evt_scoped_test")
            )

    with database.read_connection() as connection:
        assert connection.execute(
            domain_events.select().where(domain_events.c.event_id == "evt_scoped_other")
        ).first() is not None
        assert connection.execute(
            domain_events.select().where(domain_events.c.event_id == "evt_scoped_test")
        ).first() is None
    database.close()


def test_controlled_project_purge_rechecks_project_existence_and_read_only_lifecycle(tmp_path: Path):
    database = _database(tmp_path, status="运行中", read_only=True)
    with database.transaction() as connection:
        with pytest.raises(ReadOnlyProjectError):
            with database.controlled_project_purge(connection, "project_test"):
                pass
        with pytest.raises(NotFoundError):
            with database.controlled_project_purge(connection, "missing_project"):
                pass
    database.close()
