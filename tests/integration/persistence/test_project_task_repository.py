from datetime import datetime, timezone

import pytest
from sqlalchemy import update

from app.domain.common import ProjectStatus, TaskStatus, new_object_id
from app.domain.entities import Project, Task
from app.domain.errors import NotFoundError, ReadOnlyProjectError, VersionConflictError
from app.infra.database import Database
from app.infra.repositories.project_task import ProjectTaskRepository
from app.infra.task2_schema import projects
from app.infra.transactions import UnitOfWork


NOW = datetime(2026, 8, 16, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def database(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    return database


def make_project(project_id="project_test"):
    return Project(
        id=project_id,
        name="项目管理小应用",
        business_goal="验证闭环",
        target_users="本地 Boss",
        priority="P0",
        deadline=None,
        constraints={"local_only": True},
        stage="立项",
        status=ProjectStatus.PREPARING,
        created_at=NOW,
        version=1,
        read_only=False,
    )


def make_task(task_id, project_id="project_test", dependencies=()):
    return Task(
        id=task_id,
        project_id=project_id,
        title=f"任务 {task_id}",
        owner_role="developer",
        specialist_tag="backend",
        assignment_reason="Task 2 持久化核心",
        priority="P0",
        dependencies=tuple(dependencies),
        expected_deliverables=("domain",),
        status=TaskStatus.PENDING,
        created_at=NOW,
        version=1,
    )


def test_project_and_task_round_trip_with_frozen_schema_fields_and_dependencies(database):
    repository = ProjectTaskRepository()
    project = make_project()
    prerequisite = make_task("task_prerequisite")
    task = make_task("task_test", dependencies=(prerequisite.id,))

    with UnitOfWork(database) as unit:
        repository.create_project(unit.connection, project)
        repository.create_task(unit.connection, prerequisite)
        repository.create_task(unit.connection, task)

    with UnitOfWork(database) as unit:
        assert repository.get_project(unit.connection, project.id) == project
        assert repository.get_task(unit.connection, task.id) == task


def test_project_and_task_updates_increment_version_and_reject_stale_expected_version(database):
    repository = ProjectTaskRepository()
    project = make_project()

    with UnitOfWork(database) as unit:
        repository.create_project(unit.connection, project)

    updated = project.model_copy(update={"name": "更新后的项目"})
    with UnitOfWork(database) as unit:
        result = repository.update_project(unit.connection, updated, expected_version=1)

    assert result.name == "更新后的项目"
    assert result.version == 2

    with UnitOfWork(database) as unit:
        with pytest.raises(VersionConflictError):
            repository.update_project(
                unit.connection,
                project.model_copy(update={"name": "不能覆盖"}),
                expected_version=1,
            )
        assert repository.get_project(unit.connection, project.id).name == "更新后的项目"


def test_list_tasks_uses_stable_id_cursor(database):
    repository = ProjectTaskRepository()
    project = make_project()

    with UnitOfWork(database) as unit:
        repository.create_project(unit.connection, project)
        for task_id in ("task_a", "task_b", "task_c"):
            repository.create_task(unit.connection, make_task(task_id))

    with UnitOfWork(database) as unit:
        first_page = repository.list_tasks(unit.connection, project.id, cursor=None, limit=2)
        second_page = repository.list_tasks(
            unit.connection,
            project.id,
            cursor=first_page.next_cursor,
            limit=2,
        )

    assert [task.id for task in first_page.items] == ["task_a", "task_b"]
    assert first_page.has_more is True
    assert [task.id for task in second_page.items] == ["task_c"]
    assert second_page.has_more is False


def test_project_task_writes_rollback_as_one_unit_of_work(database):
    repository = ProjectTaskRepository()
    project = make_project()
    task = make_task("task_rollback")

    with pytest.raises(RuntimeError, match="injected failure"):
        with UnitOfWork(database) as unit:
            repository.create_project(unit.connection, project)
            repository.create_task(unit.connection, task)
            raise RuntimeError("injected failure")

    with UnitOfWork(database) as unit:
        with pytest.raises(NotFoundError):
            repository.get_project(unit.connection, project.id)
        with pytest.raises(NotFoundError):
            repository.get_task(unit.connection, task.id)


def test_create_task_rejects_completed_read_only_project_before_inserting(database):
    repository = ProjectTaskRepository()
    project = make_project().model_copy(
        update={"status": ProjectStatus.COMPLETED, "read_only": True}
    )
    task = make_task("task_completed_read_only")

    with UnitOfWork(database) as unit:
        repository.create_project(unit.connection, project)

        with pytest.raises(ReadOnlyProjectError):
            repository.create_task(unit.connection, task)

        with pytest.raises(NotFoundError):
            repository.get_task(unit.connection, task.id)


def test_add_dependency_rejects_terminated_read_only_project_without_inserting(database):
    repository = ProjectTaskRepository()
    project = make_project()
    prerequisite = make_task("task_terminated_prerequisite")
    task = make_task("task_terminated_target")

    with UnitOfWork(database) as unit:
        repository.create_project(unit.connection, project)
        repository.create_task(unit.connection, prerequisite)
        repository.create_task(unit.connection, task)
        unit.connection.execute(
            update(projects)
            .where(projects.c.id == project.id)
            .values(status=ProjectStatus.TERMINATED.value, read_only=True)
        )

        with pytest.raises(ReadOnlyProjectError):
            repository.add_dependency(unit.connection, project.id, task.id, prerequisite.id)

        assert repository.get_task(unit.connection, task.id).dependencies == ()
