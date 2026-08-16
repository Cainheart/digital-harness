from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.domain.common import Actor
from app.domain.common import ProjectStatus
from app.domain.entities import Project
from app.domain.errors import InvalidArgumentError, ReadOnlyProjectError, VersionConflictError
from app.domain.events import DomainEventDraft
from app.infra.database import Database
from app.infra.outbox import OutboxRepository
from app.infra.repositories.events import SqliteEventStore
from app.infra.repositories.project_task import ProjectTaskRepository
from app.infra.task2_schema import domain_events, outbox_messages, projects
from app.infra.transactions import UnitOfWork


@pytest.fixture
def database(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    project = Project(
        id="project_test",
        name="测试项目",
        business_goal="验证持久化",
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
    with UnitOfWork(database) as unit:
        ProjectTaskRepository().create_project(unit.connection, project)
    return database


def draft(event_type, aggregate_id="project_test", version=0, aggregate_type="project"):
    return DomainEventDraft(
        event_type=event_type,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        aggregate_version=version,
        payload={"name": event_type},
        actor=Actor(type="boss", id="boss-local"),
        occurred_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        trace_id="trace_task2",
    )


def test_append_event_assigns_sequential_versions_global_sequence_and_outbox(database):
    store = SqliteEventStore()

    with UnitOfWork(database) as first_unit:
        first = store.append(
            first_unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=0,
            events=(draft("ProjectCreated"),),
        )
        first_unit.connection.execute(
            projects.update().where(projects.c.id == "project_test").values(version=2)
        )
    with UnitOfWork(database) as second_unit:
        second = store.append(
            second_unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=1,
            events=(draft("ProjectStarted"),),
        )

    assert first.events[0].aggregate_version == 1
    assert second.events[0].aggregate_version == 2
    assert second.events[0].global_sequence > first.events[0].global_sequence

    with UnitOfWork(database) as unit:
        pending = OutboxRepository().list_unpublished(unit.connection)
        after_first = store.list_after(unit.connection, first.events[0].event_id)

    assert len(pending) == 2
    assert [event.event_id for event in after_first] == [second.events[0].event_id]


def test_stale_expected_version_writes_nothing(database):
    store = SqliteEventStore()

    with UnitOfWork(database) as unit:
        store.append(
            unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=0,
            events=(draft("ProjectCreated"),),
        )

    with UnitOfWork(database) as unit:
        with pytest.raises(VersionConflictError):
            store.append(
                unit.connection,
                aggregate_type="project",
                aggregate_id="project_test",
                expected_version=0,
                events=(draft("ProjectStarted"),),
            )
        assert unit.connection.execute(
            select(func.count()).select_from(domain_events)
        ).scalar_one() == 1
        assert unit.connection.execute(
            select(func.count()).select_from(outbox_messages)
        ).scalar_one() == 1


def test_business_event_and_outbox_rollback_together(database):
    store = SqliteEventStore()

    with pytest.raises(RuntimeError, match="injected failure"):
        with UnitOfWork(database) as unit:
            store.append(
                unit.connection,
                aggregate_type="project",
                aggregate_id="project_test",
                expected_version=0,
                events=(draft("ProjectCreated"),),
            )
            raise RuntimeError("injected failure")

    with UnitOfWork(database) as unit:
        assert store.list_for_aggregate(
            unit.connection, "project", "project_test"
        ) == []
        assert OutboxRepository().list_unpublished(unit.connection) == []


def test_outbox_publish_marker_is_idempotent(database):
    store = SqliteEventStore()
    with UnitOfWork(database) as unit:
        appended = store.append(
            unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=0,
            events=(draft("ProjectCreated"),),
        )
        outbox = OutboxRepository()
        pending = outbox.list_unpublished(unit.connection)
        marked = outbox.mark_published(unit.connection, pending[0].id)
        marked_again = outbox.mark_published(unit.connection, pending[0].id)

    assert marked.event_id == appended.events[0].event_id
    assert marked.status == "published"
    assert marked_again.status == "published"
    with UnitOfWork(database) as unit:
        assert outbox.list_unpublished(unit.connection) == []


def test_known_project_is_required_before_event_append(database):
    store = SqliteEventStore()

    with UnitOfWork(database) as unit:
        with pytest.raises(Exception) as error:
            store.append(
                unit.connection,
                aggregate_type="project",
                aggregate_id="project_missing",
                expected_version=0,
                events=(draft("ProjectCreated", aggregate_id="project_missing"),),
            )
        assert error.value.code == "NOT_FOUND"
        assert unit.connection.execute(select(func.count()).select_from(domain_events)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(outbox_messages)).scalar_one() == 0


def test_unknown_aggregate_type_is_rejected_before_event_and_outbox_insert(database):
    store = SqliteEventStore()

    with UnitOfWork(database) as unit:
        with pytest.raises(InvalidArgumentError):
            store.append(
                unit.connection,
                aggregate_type="bogus_aggregate",
                aggregate_id="bogus_aggregate_id",
                expected_version=0,
                events=(draft(
                    "BogusAggregateCreated",
                    aggregate_id="bogus_aggregate_id",
                    aggregate_type="bogus_aggregate",
                ),),
            )
        assert unit.connection.execute(select(func.count()).select_from(domain_events)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(outbox_messages)).scalar_one() == 0


@pytest.mark.parametrize("status", [ProjectStatus.PREPARING, ProjectStatus.COMPLETED])
def test_direct_event_append_rejects_any_read_only_project_before_event_and_outbox_insert(database, status):
    store = SqliteEventStore()

    with UnitOfWork(database) as unit:
        unit.connection.execute(
            projects.update()
            .where(projects.c.id == "project_test")
            .values(status=status.value, read_only=True)
        )
        with pytest.raises(ReadOnlyProjectError):
            store.append(
                unit.connection,
                aggregate_type="project",
                aggregate_id="project_test",
                expected_version=0,
                events=(draft("ProjectCreated"),),
            )
        assert unit.connection.execute(select(func.count()).select_from(domain_events)).scalar_one() == 0
        assert unit.connection.execute(select(func.count()).select_from(outbox_messages)).scalar_one() == 0


def test_project_object_version_must_match_event_append_version(database):
    store = SqliteEventStore()
    with UnitOfWork(database) as unit:
        store.append(
            unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=0,
            events=(draft("ProjectCreated"),),
        )
        unit.connection.execute(
            projects.update().where(projects.c.id == "project_test").values(version=3)
        )
        with pytest.raises(VersionConflictError):
            store.append(
                unit.connection,
                aggregate_type="project",
                aggregate_id="project_test",
                expected_version=1,
                events=(draft("ProjectStarted"),),
            )
        assert unit.connection.execute(select(func.count()).select_from(domain_events)).scalar_one() == 1


def test_outbox_available_at_filters_future_messages_and_allows_due_messages(database):
    store = SqliteEventStore()
    with UnitOfWork(database) as unit:
        store.append(
            unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=0,
            events=(draft("ProjectCreated"),),
        )
        outbox = OutboxRepository()
        pending = outbox.list_unpublished(unit.connection)
        unit.connection.execute(
            outbox_messages.update().where(outbox_messages.c.id == pending[0].id).values(
                available_at=datetime(2099, 1, 1, tzinfo=timezone.utc)
            )
        )
        assert outbox.list_unpublished(unit.connection) == []
        unit.connection.execute(
            outbox_messages.update().where(outbox_messages.c.id == pending[0].id).values(
                available_at=datetime(2000, 1, 1, tzinfo=timezone.utc)
            )
        )
        assert [message.id for message in outbox.list_unpublished(unit.connection)] == [pending[0].id]


def test_outbox_failure_and_retry_update_retry_count_and_availability(database):
    store = SqliteEventStore()
    with UnitOfWork(database) as unit:
        store.append(
            unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=0,
            events=(draft("ProjectCreated"),),
        )
        outbox = OutboxRepository()
        message = outbox.list_unpublished(unit.connection)[0]
        failed = outbox.mark_failed(
            unit.connection,
            message.id,
            error="temporary delivery failure",
            available_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
        )
        assert failed.retry_count == 1
        assert failed.last_error == "temporary delivery failure"
        assert outbox.list_unpublished(unit.connection) == []
        retried = outbox.schedule_retry(
            unit.connection,
            message.id,
            available_at=datetime(2000, 1, 1, tzinfo=timezone.utc),
        )
        assert retried.status == "pending"
        assert [item.id for item in outbox.list_unpublished(unit.connection)] == [message.id]


@pytest.mark.parametrize("operation", ["enqueue", "published", "failed", "retry"])
@pytest.mark.parametrize(
    "status,read_only",
    [(ProjectStatus.COMPLETED, False), (ProjectStatus.PREPARING, True)],
)
def test_project_scoped_outbox_writes_reject_terminal_or_read_only_project(
    database, operation, status, read_only
):
    store = SqliteEventStore()
    outbox = OutboxRepository()

    with UnitOfWork(database) as unit:
        appended = store.append(
            unit.connection,
            aggregate_type="project",
            aggregate_id="project_test",
            expected_version=0,
            events=(draft("ProjectCreated"),),
        )
        message = outbox.list_unpublished(unit.connection)[0]
        unit.connection.execute(
            projects.update()
            .where(projects.c.id == "project_test")
            .values(status=status.value, read_only=read_only)
        )

        with pytest.raises(ReadOnlyProjectError):
            if operation == "enqueue":
                outbox.enqueue(
                    unit.connection,
                    appended.events[0],
                    project_id="project_test",
                )
            elif operation == "published":
                outbox.mark_published(unit.connection, message.id)
            elif operation == "failed":
                outbox.mark_failed(unit.connection, message.id, error="blocked")
            else:
                outbox.schedule_retry(
                    unit.connection,
                    message.id,
                    available_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
                )

        assert len(outbox.list_unpublished(unit.connection)) == 1
        assert outbox.list_unpublished(unit.connection)[0].status == "pending"
