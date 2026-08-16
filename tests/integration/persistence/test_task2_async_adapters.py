from datetime import datetime, timezone

import pytest

from app.domain.common import Actor, ProjectStatus
from app.domain.entities import Project
from app.domain.errors import ReadOnlyProjectError
from app.domain.events import DomainEventDraft
from app.infra.database import Database
from app.infra.outbox import OutboxRepository
from app.infra.repositories.events import AsyncEventStoreAdapter, SqliteEventStore
from app.infra.repositories.project_task import ProjectTaskRepository
from app.infra.task2_schema import projects
from app.infra.transactions import AsyncUnitOfWork, UnitOfWork


@pytest.fixture
def database(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    project = Project(
        id="project_async",
        name="异步测试项目",
        business_goal="验证异步适配器",
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
    from app.infra.transactions import UnitOfWork

    with UnitOfWork(database) as unit:
        ProjectTaskRepository().create_project(unit.connection, project)
    return database


def make_draft():
    return DomainEventDraft(
        event_type="ProjectCreated",
        aggregate_type="project",
        aggregate_id="project_async",
        payload={"name": "async"},
        actor=Actor(type="system", id="async-test"),
        occurred_at=datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc),
        trace_id="trace_async",
    )


@pytest.mark.asyncio
async def test_async_unit_of_work_and_event_store_adapter_follow_domain_protocol(database):
    adapter = AsyncEventStoreAdapter(database, SqliteEventStore())

    async with AsyncUnitOfWork(database) as unit:
        assert unit.connection is not None

    result = await adapter.append(
        aggregate_type="project",
        aggregate_id="project_async",
        expected_version=0,
        events=(make_draft(),),
    )
    events = await adapter.list_after(None, project_id="project_async")

    assert result.events[0].aggregate_version == 1
    assert [event.event_id for event in events] == [result.events[0].event_id]


@pytest.mark.asyncio
async def test_async_event_store_rejects_direct_write_to_completed_read_only_project(database):
    adapter = AsyncEventStoreAdapter(database, SqliteEventStore())
    with UnitOfWork(database) as unit:
        unit.connection.execute(
            projects.update()
            .where(projects.c.id == "project_async")
            .values(status=ProjectStatus.COMPLETED.value, read_only=True)
        )

    with pytest.raises(ReadOnlyProjectError):
        await adapter.append(
            aggregate_type="project",
            aggregate_id="project_async",
            expected_version=0,
            events=(make_draft(),),
        )

    with UnitOfWork(database) as unit:
        assert SqliteEventStore().count_for_aggregate(
            unit.connection, "project", "project_async"
        ) == 0
        assert OutboxRepository().list_unpublished(unit.connection) == []
