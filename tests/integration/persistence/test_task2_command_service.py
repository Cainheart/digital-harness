from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from app.domain.commands import CommandEnvelope, CommandResult
from app.domain.common import Actor, ProjectStatus, TaskStatus
from app.domain.entities import Project, Task
from app.domain.errors import IdempotencyKeyReusedError, InvalidArgumentError, ReadOnlyProjectError
from app.domain.events import DomainEventDraft
from app.infra.database import Database
from app.infra.outbox import OutboxRepository
from app.infra.repositories.events import SqliteEventStore
from app.infra.repositories.idempotency import SqliteIdempotencyRepository
from app.infra.repositories.project_task import ProjectTaskRepository
from app.infra.task2_schema import domain_events, idempotency_records, outbox_messages, projects
from app.infra.transactions import UnitOfWork
from app.application.task2 import Task2CommandService


@pytest.fixture
def database(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    return database


def command(payload=None, key="project-create-key"):
    return CommandEnvelope(
        commandId="command_project_create",
        idempotencyKey=key,
        aggregateId="project_service",
        expectedVersion=0,
        actor=Actor(type="boss", id="boss-local"),
        payload=payload or {"name": "service"},
    )


def project():
    return Project(
        id="project_service",
        name="服务项目",
        business_goal="验证统一命令协调",
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


def draft():
    return DomainEventDraft(
        event_type="ProjectCreated",
        aggregate_type="project",
        aggregate_id="project_service",
        payload={"name": "service"},
        actor=Actor(type="boss", id="boss-local"),
        occurred_at=datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc),
        trace_id="trace_service",
    )


def result_factory(_command, appended, _state_result):
    return CommandResult(
        aggregateId="project_service",
        version=appended.aggregate_version,
        eventId=appended.events[-1].event_id,
        allowedActions=("pause", "terminate"),
        traceId=appended.events[-1].trace_id,
    )


def execute(service, request, *, state_writer, event_store=None, idempotency=None, metadata_writer=None):
    return service.execute(
        request,
        aggregate_type="project",
        state_writer=state_writer,
        event_drafts=(draft(),),
        metadata_writer=metadata_writer,
        result_factory=result_factory,
    )


def test_command_service_commits_state_event_outbox_and_idempotency_in_one_transaction(database):
    service = Task2CommandService(database)
    calls = []

    first = execute(
        service,
        command(),
        state_writer=lambda connection: (ProjectTaskRepository().create_project(connection, project()), project())[1],
        metadata_writer=lambda connection, state_result, appended: calls.append(
            (connection, state_result.id, appended.events[0].event_id)
        ),
    )
    replay = execute(
        service,
        command(),
        state_writer=lambda *_: (_ for _ in ()).throw(AssertionError("replay must not write state")),
    )

    assert replay == first
    assert len(calls) == 1
    with UnitOfWork(database) as unit:
        assert unit.connection.execute(select(func.count()).select_from(projects)).scalar_one() == 1
        assert unit.connection.execute(select(func.count()).select_from(domain_events)).scalar_one() == 1
        assert unit.connection.execute(select(func.count()).select_from(outbox_messages)).scalar_one() == 1
        assert unit.connection.execute(select(func.count()).select_from(idempotency_records)).scalar_one() == 1


def test_command_service_rejects_same_key_with_different_request_hash(database):
    service = Task2CommandService(database)
    execute(
        service,
        command(payload={"name": "first"}),
        state_writer=lambda connection: (ProjectTaskRepository().create_project(connection, project()), project())[1],
    )

    with pytest.raises(IdempotencyKeyReusedError):
        execute(
            service,
            command(payload={"name": "changed"}),
            state_writer=lambda *_: (_ for _ in ()).throw(AssertionError("reused request must not write state")),
        )


def test_project_repository_rejects_terminal_project_without_read_only_flag(database):
    repository = ProjectTaskRepository()
    terminal = project().model_copy(update={"status": ProjectStatus.COMPLETED, "read_only": False})

    with UnitOfWork(database) as unit:
        with pytest.raises(InvalidArgumentError):
            repository.create_project(unit.connection, terminal)
        assert unit.connection.execute(select(func.count()).select_from(projects)).scalar_one() == 0


def test_project_repository_update_rejects_terminal_project_without_read_only_flag(database):
    repository = ProjectTaskRepository()
    with UnitOfWork(database) as unit:
        repository.create_project(unit.connection, project())
        with pytest.raises(InvalidArgumentError):
            repository.update_project(
                unit.connection,
                project().model_copy(update={"status": ProjectStatus.TERMINATED, "read_only": False}),
                expected_version=1,
            )
        assert repository.get_project(unit.connection, "project_service").status is ProjectStatus.PREPARING


def test_task_write_and_command_service_reject_terminal_project_even_without_read_only_flag(database):
    repository = ProjectTaskRepository()
    with UnitOfWork(database) as unit:
        repository.create_project(unit.connection, project())
        unit.connection.execute(
            projects.update()
            .where(projects.c.id == "project_service")
            .values(status=ProjectStatus.COMPLETED.value, read_only=False)
        )
        task = Task(
            id="task_terminal_project",
            project_id="project_service",
            title="终态项目任务",
            owner_role="developer",
            specialist_tag="backend",
            assignment_reason="终态保护测试",
            priority="P0",
            dependencies=(),
            expected_deliverables=("test",),
            status=TaskStatus.PENDING,
            created_at=datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc),
            version=1,
        )
        with pytest.raises(ReadOnlyProjectError):
            repository.create_task(unit.connection, task)
        assert repository.find_task(unit.connection, task.id) is None

    calls = []
    service = Task2CommandService(database)
    request = command(key="terminal-command").model_copy(update={"expected_version": 1})
    with pytest.raises(ReadOnlyProjectError):
        execute(
            service,
            request,
            state_writer=lambda connection: calls.append(connection),
        )
    assert calls == []
    with UnitOfWork(database) as unit:
        assert unit.connection.execute(select(func.count()).select_from(domain_events)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(outbox_messages)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(idempotency_records)).scalar_one() == 0


@pytest.mark.parametrize("failure_kind", ["event", "outbox", "idempotency"])
def test_command_service_rolls_back_state_after_each_late_failure(database, failure_kind):
    from app.infra.outbox import OutboxRepository

    class FailingOutbox(OutboxRepository):
        def enqueue(self, connection, event, **kwargs):
            super().enqueue(connection, event, **kwargs)
            raise RuntimeError("injected outbox failure")

    class FailingEventStore(SqliteEventStore):
        def append(self, connection, *args, **kwargs):
            result = super().append(connection, *args, **kwargs)
            raise RuntimeError("injected event failure")

    class FailingIdempotency(SqliteIdempotencyRepository):
        def save(self, connection, record):
            result = super().save(connection, record)
            raise RuntimeError("injected idempotency failure")

    if failure_kind == "event":
        service = Task2CommandService(database, event_store=FailingEventStore())
    elif failure_kind == "outbox":
        service = Task2CommandService(database, event_store=SqliteEventStore(outbox=FailingOutbox()))
    else:
        service = Task2CommandService(database, idempotency_repository=FailingIdempotency())

    with pytest.raises(RuntimeError, match="injected"):
        execute(
            service,
            command(key=f"failure-{failure_kind}"),
            state_writer=lambda connection: (ProjectTaskRepository().create_project(connection, project()), project())[1],
        )

    with UnitOfWork(database) as unit:
        assert unit.connection.execute(select(func.count()).select_from(projects)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(domain_events)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(outbox_messages)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(idempotency_records)).scalar_one() == 0
