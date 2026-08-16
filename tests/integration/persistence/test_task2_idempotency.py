from datetime import datetime, timezone

import pytest

from app.domain.commands import CommandResult
from app.domain.common import ProjectStatus
from app.domain.entities import Project
from app.domain.errors import IdempotencyKeyReusedError, ReadOnlyProjectError
from app.infra.database import Database
from app.infra.repositories.idempotency import (
    IdempotencyRecord,
    SqliteIdempotencyRepository,
)
from app.infra.repositories.project_task import ProjectTaskRepository
from app.infra.task2_schema import projects
from app.infra.transactions import UnitOfWork


@pytest.fixture
def database(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    return database


def result():
    return CommandResult(
        aggregateId="project_test",
        version=1,
        eventId="event_test",
        allowedActions=("pause", "terminate"),
        traceId="trace_original",
    )


def record(request_hash="hash_original"):
    return IdempotencyRecord(
        id="idempotency_test",
        project_id=None,
        idempotency_key="command-key",
        command_id="command_test",
        aggregate_type="project",
        aggregate_id="project_test",
        request_hash=request_hash,
        command_result=result(),
        event_id="event_test",
        created_at=datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc),
    )


def project():
    return Project(
        id="project_test",
        name="幂等测试项目",
        business_goal="验证项目范围写入",
        target_users="测试用户",
        priority="P0",
        deadline=None,
        constraints={},
        stage="立项",
        status=ProjectStatus.PREPARING,
        created_at=datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc),
        version=1,
        read_only=False,
    )


def test_same_request_fingerprint_returns_original_result_without_duplicate_record(database):
    repository = SqliteIdempotencyRepository()
    original = record()

    with UnitOfWork(database) as unit:
        repository.save(unit.connection, original)
        loaded = repository.get(unit.connection, original.idempotency_key)
        replay = repository.assert_reusable(loaded, "hash_original", "trace_replay")

    assert loaded == original
    assert replay == original.command_result


def test_different_request_fingerprint_raises_stable_reuse_error(database):
    repository = SqliteIdempotencyRepository()
    original = record()

    with UnitOfWork(database) as unit:
        repository.save(unit.connection, original)
        with pytest.raises(IdempotencyKeyReusedError) as error:
            repository.assert_reusable(existing=original, request_hash="hash_changed", trace_id="trace_replay")

    assert error.value.code == "IDEMPOTENCY_KEY_REUSED"
    assert error.value.status_code == 409


def test_idempotency_record_rolls_back_with_other_same_transaction_writes(database):
    repository = SqliteIdempotencyRepository()
    original = record()

    with pytest.raises(RuntimeError, match="injected failure"):
        with UnitOfWork(database) as unit:
            repository.save(unit.connection, original)
            raise RuntimeError("injected failure")

    with UnitOfWork(database) as unit:
        assert repository.get(unit.connection, original.idempotency_key) is None


@pytest.mark.parametrize(
    "status,read_only",
    [(ProjectStatus.COMPLETED, False), (ProjectStatus.PREPARING, True)],
)
def test_project_scoped_idempotency_save_rejects_terminal_or_read_only_project(
    database, status, read_only
):
    repository = SqliteIdempotencyRepository()
    original = record()
    original = IdempotencyRecord(
        **{**original.__dict__, "project_id": "project_test", "event_id": None}
    )

    with UnitOfWork(database) as unit:
        ProjectTaskRepository().create_project(unit.connection, project())
        unit.connection.execute(
            projects.update()
            .where(projects.c.id == "project_test")
            .values(status=status.value, read_only=read_only)
        )
        with pytest.raises(ReadOnlyProjectError):
            repository.save(unit.connection, original)
        assert repository.get(unit.connection, original.idempotency_key) is None
