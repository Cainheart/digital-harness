"""Task 2 SSE 查询的提交可见性、游标、过滤和本机访问验收。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json

import pytest
from fastapi.testclient import TestClient

from app.domain.common import Actor, ProjectStatus
from app.domain.entities import Project
from app.domain.events import DomainEventDraft
from app.infra.repositories.events import SqliteEventStore
from app.infra.repositories.project_task import ProjectTaskRepository
from app.infra.task2_schema import projects
from app.infra.transactions import UnitOfWork
from app.main import create_app


def _project(project_id: str) -> Project:
    """创建用于事件边界测试的最小可持久化 Project。"""
    return Project(
        id=project_id,
        name=f"测试项目-{project_id}",
        business_goal="验证 Task 2 事件查询",
        target_users="本地验收",
        priority="P0",
        deadline=None,
        constraints={},
        stage="立项",
        status=ProjectStatus.PREPARING,
        created_at=datetime(2026, 8, 16, tzinfo=timezone.utc),
        version=1,
        read_only=False,
    )


@pytest.fixture
def event_runtime(tmp_path):
    """初始化真实 0002 SQLite/WAL 应用，并提供同一数据库的 API 客户端。"""
    app = create_app(persistent_root=tmp_path, test_mode=True)
    with UnitOfWork(app.state.database) as unit:
        ProjectTaskRepository().create_project(unit.connection, _project("project-one"))
        ProjectTaskRepository().create_project(unit.connection, _project("project-two"))
    with TestClient(app) as client:
        yield app, client


def _append(
    app,
    *,
    project_id: str = "project-one",
    expected_version: int,
    event_type: str,
    payload: dict[str, object] | None = None,
    actor: Actor | None = None,
    trace_id: str = "trace-default",
    occurred_at: datetime | None = None,
):
    """在单一 UnitOfWork 中提交一个事件和对应 Project 版本。"""
    event_store = SqliteEventStore()
    draft = DomainEventDraft(
        event_type=event_type,
        aggregate_type="project",
        aggregate_id=project_id,
        payload=payload or {},
        actor=actor or Actor(type="boss", id="boss-local"),
        trace_id=trace_id,
        occurred_at=occurred_at or datetime.now(timezone.utc),
    )
    with UnitOfWork(app.state.database) as unit:
        result = event_store.append(
            unit.connection,
            aggregate_type="project",
            aggregate_id=project_id,
            expected_version=expected_version,
            events=(draft,),
        )
        unit.connection.execute(
            projects.update()
            .where(projects.c.id == project_id)
            # Project 的初始版本为 1；事件版本 1 对应写入后的对象版本 2。
            .values(version=expected_version + 2)
        )
    return result.events[0]


def _event_ids(body: str) -> list[str]:
    """从有限 SSE 响应中提取事件 ID，忽略空快照注释。"""
    return [line.removeprefix("id: ") for line in body.splitlines() if line.startswith("id: ")]


def _event_payloads(body: str) -> list[dict[str, object]]:
    """从 SSE data 行恢复 JSON，便于断言过滤后没有误发布事件。"""
    return [json.loads(line.removeprefix("data: ")) for line in body.splitlines() if line.startswith("data: ")]


def test_committed_event_is_visible_with_sse_headers(event_runtime):
    app, client = event_runtime
    event = _append(app, expected_version=0, event_type="ProjectCreated", trace_id="trace-committed")

    response = client.get("/api/v1/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert _event_ids(response.text) == [event.event_id]
    assert _event_payloads(response.text)[0]["traceId"] == "trace-committed"


def test_after_and_last_event_id_resume_without_replaying_cursor(event_runtime):
    app, client = event_runtime
    first = _append(app, expected_version=0, event_type="First")
    second = _append(app, expected_version=1, event_type="Second")

    after_response = client.get("/api/v1/events", params={"after": first.event_id})
    header_response = client.get("/api/v1/events", headers={"Last-Event-ID": first.event_id})

    assert _event_ids(after_response.text) == [second.event_id]
    assert _event_ids(header_response.text) == [second.event_id]
    assert first.event_id not in after_response.text


def test_project_task_artifact_trace_actor_and_time_filters_are_explicit(event_runtime):
    app, client = event_runtime
    base = datetime(2026, 8, 16, 1, 0, tzinfo=timezone.utc)
    task_event = _append(
        app,
        expected_version=0,
        event_type="TaskFact",
        payload={"taskId": "task-one"},
        trace_id="trace-task",
        occurred_at=base,
    )
    artifact_event = _append(
        app,
        expected_version=1,
        event_type="ArtifactFact",
        payload={"artifactId": "artifact-one"},
        actor=Actor(type="agent", id="agent-one"),
        trace_id="trace-artifact",
        occurred_at=base + timedelta(minutes=1),
    )
    other_project_event = _append(
        app,
        project_id="project-two",
        expected_version=0,
        event_type="OtherProjectFact",
        trace_id="trace-other",
        occurred_at=base + timedelta(minutes=2),
    )

    assert _event_ids(client.get("/api/v1/events", params={"projectId": "project-one"}).text) == [
        task_event.event_id,
        artifact_event.event_id,
    ]
    assert _event_ids(client.get("/api/v1/events", params={"taskId": "task-one"}).text) == [task_event.event_id]
    assert _event_ids(client.get("/api/v1/events", params={"artifactId": "artifact-one"}).text) == [artifact_event.event_id]
    assert _event_ids(client.get("/api/v1/events", params={"traceId": "trace-artifact"}).text) == [artifact_event.event_id]
    assert _event_ids(client.get("/api/v1/events", params={"actor": "agent:agent-one"}).text) == [artifact_event.event_id]
    assert _event_ids(
        client.get(
            "/api/v1/events",
            params={
                "from": base.isoformat(),
                "to": (base + timedelta(minutes=1)).isoformat(),
                "limit": "1",
            },
        ).text
    ) == [task_event.event_id]
    assert other_project_event.event_id not in client.get(
        "/api/v1/events", params={"projectId": "project-one"}
    ).text


def test_uncommitted_event_is_not_published(event_runtime):
    app, client = event_runtime
    event_store = SqliteEventStore()
    draft = DomainEventDraft(
        event_type="RolledBack",
        aggregate_type="project",
        aggregate_id="project-one",
        payload={},
        actor=Actor(type="boss", id="boss-local"),
        trace_id="trace-rollback",
    )
    with pytest.raises(RuntimeError, match="rollback test"):
        with UnitOfWork(app.state.database) as unit:
            event_store.append(
                unit.connection,
                aggregate_type="project",
                aggregate_id="project-one",
                expected_version=0,
                events=(draft,),
            )
            raise RuntimeError("rollback test")

    response = client.get("/api/v1/events", params={"traceId": "trace-rollback"})
    assert response.status_code == 200
    assert _event_ids(response.text) == []
    assert "RolledBack" not in response.text


@pytest.mark.parametrize(
    "params, expected_code",
    [
        ({"unsupported": "value"}, "INVALID_ARGUMENT"),
        ({"from": "not-a-date"}, "INVALID_ARGUMENT"),
        ({"after": "event_missing"}, "NOT_FOUND"),
    ],
)
def test_invalid_filters_and_cursor_use_stable_error_adapter(event_runtime, params, expected_code):
    _app, client = event_runtime

    response = client.get("/api/v1/events", params=params)

    assert response.status_code in {400, 404}
    assert response.json()["code"] == expected_code
    assert response.json()["traceId"]


def test_conflicting_reconnect_cursor_and_non_local_request_are_rejected(event_runtime):
    _app, client = event_runtime

    conflict = client.get(
        "/api/v1/events",
        params={"after": "event-one"},
        headers={"Last-Event-ID": "event-two"},
    )
    remote = client.get(
        "/api/v1/events",
        headers={"X-Test-Remote-Address": "192.0.2.10"},
    )

    assert conflict.status_code == 400
    assert conflict.json()["code"] == "INVALID_ARGUMENT"
    assert remote.status_code == 403
    assert remote.json()["code"] == "POLICY_DENIED"


def test_empty_snapshot_is_finite_and_does_not_busy_loop(event_runtime):
    _app, client = event_runtime

    response = client.get("/api/v1/events")

    assert response.status_code == 200
    assert response.text == ": no committed events\n\n"
