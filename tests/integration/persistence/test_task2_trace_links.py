from __future__ import annotations

from datetime import timezone
from pathlib import Path

import pytest

from app.domain.common import utc_now
from app.domain.entities import TraceLink
from app.domain.errors import ReadOnlyProjectError, TraceLinkInvalidError
from app.infra.database import Database
from app.infra.repositories.trace import TraceRepository
from app.infra.task2_schema import projects, tasks


def _database(tmp_path: Path) -> Database:
    database = Database(tmp_path / "company.db")
    database.initialize()
    with database.transaction() as connection:
        connection.execute(
            projects.insert().values(
                id="project_test", name="项目", business_goal="目标", target_users="用户",
                priority="P0", deadline=None, constraints_json="{}", stage="验证",
                status="运行中", created_at=utc_now(), version=1, read_only=False,
            )
        )
        connection.execute(
            tasks.insert().values(
                id="task_test", project_id="project_test", title="任务", owner_role="agent_b",
                specialist_tag="backend", assignment_reason="测试", priority="P0",
                dependencies_json="[]", expected_deliverables_json="[]", status="进行中",
                created_at=utc_now(), version=1,
            )
        )
    return database


def _link(source_type: str, source_id: str, target_type: str, target_id: str) -> TraceLink:
    return TraceLink(
        id=f"trace_{source_id}_{target_id}", project_id="project_test", source_type=source_type,
        source_id=source_id, target_type=target_type, target_id=target_id, relation="covers",
        trace_id="trace_test", created_at=utc_now(), version=1,
    )


def test_trace_links_support_forward_reverse_and_coverage(tmp_path: Path):
    database = _database(tmp_path)
    repository = TraceRepository()
    links = (
        _link("acceptance_criterion", "AC-02", "task", "task_test"),
        _link("task", "task_test", "evidence", "evidence_test"),
    )
    with database.transaction() as connection:
        for link in links:
            repository.create(connection, link)
    with database.read_connection() as connection:
        forward = repository.list_forward(connection, "task", "task_test", None, 50)
        reverse = repository.list_reverse(connection, "evidence", "evidence_test", None, 50)
        coverage = repository.coverage(
            connection,
            "project_test",
            (("acceptance_criterion", "AC-02"), ("task", "task_test"), ("evidence", "evidence_test")),
        )
    assert {link.target_id for link in forward.items} == {"evidence_test"}
    assert {link.source_id for link in reverse.items} == {"task_test"}
    assert coverage.broken_links == 0
    assert coverage.percentage == 100.0
    assert coverage.queried_at.tzinfo is timezone.utc
    assert coverage.queried_at.utcoffset() == timezone.utc.utcoffset(None)
    database.close()


def test_trace_links_reject_duplicate_and_cross_project_endpoints(tmp_path: Path):
    database = _database(tmp_path)
    repository = TraceRepository()
    link = _link("task", "task_test", "evidence", "evidence_test")
    with database.transaction() as connection:
        repository.create(connection, link)
        with pytest.raises(TraceLinkInvalidError):
            repository.create(connection, link)
        with pytest.raises(TraceLinkInvalidError):
            repository.create(
                connection,
                link.model_copy(update={"id": "trace_cross", "project_id": "other_project"}),
            )
    database.close()


def test_trace_link_filters_are_available_in_both_directions(tmp_path: Path):
    database = _database(tmp_path)
    repository = TraceRepository()
    first = _link("acceptance_criterion", "AC-03", "task", "task_test")
    second = first.model_copy(
        update={
            "id": "trace_second",
            "target_type": "evidence",
            "target_id": "evidence_test",
            "relation": "proves",
            "trace_id": "trace_second",
        }
    )
    with database.transaction() as connection:
        repository.create(connection, first)
        repository.create(connection, second)
    with database.read_connection() as connection:
        result = repository.list_forward(
            connection,
            source_type="acceptance_criterion",
            source_id="AC-03",
            project_id="project_test",
            target_type="evidence",
            relation="proves",
            trace_id="trace_second",
            created_after=utc_now().replace(year=2020),
            created_before=utc_now().replace(year=2030),
            cursor=None,
            limit=10,
        )
        reverse = repository.list_reverse(
            connection,
            target_type="evidence",
            target_id="evidence_test",
            project_id="project_test",
            source_type="acceptance_criterion",
            relation="proves",
            trace_id="trace_second",
            limit=10,
        )
    assert [link.id for link in result.items] == ["trace_second"]
    assert [link.id for link in reverse.items] == ["trace_second"]
    database.close()


@pytest.mark.parametrize("node_type", ["artifact", "notification", "outbox_message", "idempotency_record"])
def test_trace_link_allowlist_rejects_non_design_nodes(tmp_path: Path, node_type: str):
    database = _database(tmp_path)
    repository = TraceRepository()
    link = TraceLink.model_construct(
        id=f"trace_AC-04_{node_type}", project_id="project_test",
        source_type="acceptance_criterion", source_id="AC-04",
        target_type=node_type, target_id="node", relation="covers",
        trace_id="trace_test", created_at=utc_now(), version=1,
    )
    with database.transaction() as connection:
        with pytest.raises(TraceLinkInvalidError):
            repository.create(connection, link)
    database.close()


def test_trace_create_rejects_completed_read_only_project(tmp_path: Path):
    database = _database(tmp_path)
    with database.transaction() as connection:
        connection.execute(
            projects.update()
            .where(projects.c.id == "project_test")
            .values(status="已结项", read_only=True)
        )
    with database.transaction() as connection:
        with pytest.raises(ReadOnlyProjectError):
            TraceRepository().create(
                connection, _link("acceptance_criterion", "AC-05", "evidence", "evidence")
            )
    database.close()


def test_trace_create_rejects_active_read_only_project(tmp_path: Path):
    database = _database(tmp_path)
    with database.transaction() as connection:
        connection.execute(
            projects.update()
            .where(projects.c.id == "project_test")
            .values(read_only=True)
        )
    with database.transaction() as connection:
        with pytest.raises(ReadOnlyProjectError):
            TraceRepository().create(
                connection, _link("acceptance_criterion", "AC-06", "evidence", "evidence")
            )
    database.close()
