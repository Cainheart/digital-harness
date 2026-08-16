"""Project、Task 和任务依赖的 SQLAlchemy Core 仓储。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Connection

from app.domain.common import Page, ProjectStatus, TaskStatus
from app.domain.entities import Project, Task
from app.domain.errors import InvalidArgumentError, NotFoundError, VersionConflictError
from app.infra.repositories._common import (
    ensure_project_lifecycle_consistent,
    ensure_project_writable,
)
from app.infra.task2_schema import projects, task_dependencies, tasks


def _json(value: Any) -> str:
    """使用稳定 UTF-8 JSON 映射冻结 Schema 的 Text JSON 列。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _aware(value: datetime | None) -> datetime | None:
    """把 SQLite 返回的无时区 datetime 还原为领域要求的 UTC aware 值。"""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _status_value(value: object) -> str:
    """把领域状态枚举转换为冻结数据库中的中文字符串。"""
    return value.value if isinstance(value, (ProjectStatus, TaskStatus)) else str(value)


class ProjectTaskRepository:
    """持久化 Project、Task 的完整字段、乐观版本和项目范围依赖关系。"""

    def create_project(self, connection: Connection, project: Project) -> None:
        """插入 Project；数据库约束负责主键、状态、优先级和 JSON 合同校验。"""
        ensure_project_lifecycle_consistent(project.status, project.read_only)
        connection.execute(
            insert(projects).values(
                id=project.id,
                name=project.name,
                business_goal=project.business_goal,
                target_users=project.target_users,
                priority=project.priority,
                deadline=project.deadline,
                constraints_json=_json(project.constraints),
                stage=project.stage,
                status=_status_value(project.status),
                created_at=project.created_at,
                ended_at=project.ended_at,
                version=project.version,
                read_only=project.read_only,
            )
        )

    def get_project(self, connection: Connection, project_id: str) -> Project:
        """按主键读取 Project，并恢复状态枚举、JSON 和时区感知时间。"""
        row = connection.execute(select(projects).where(projects.c.id == project_id)).mappings().first()
        if row is None:
            raise NotFoundError(data={"projectId": project_id})
        return self._project_from_row(row)

    def find_project(self, connection: Connection, project_id: str) -> Project | None:
        """提供不抛异常的 Project 查询，供组合服务做幂等前置检查。"""
        row = connection.execute(select(projects).where(projects.c.id == project_id)).mappings().first()
        return None if row is None else self._project_from_row(row)

    def create_task(self, connection: Connection, task: Task) -> None:
        """插入 Task，并把依赖同时写入 JSON 快照和规范化依赖表。"""
        ensure_project_writable(connection, task.project_id)
        connection.execute(
            insert(tasks).values(
                id=task.id,
                project_id=task.project_id,
                title=task.title,
                owner_role=task.owner_role,
                specialist_tag=task.specialist_tag,
                assignment_reason=task.assignment_reason,
                priority=task.priority,
                dependencies_json=_json(task.dependencies),
                expected_deliverables_json=_json(task.expected_deliverables),
                status=_status_value(task.status),
                started_at=task.started_at,
                ended_at=task.ended_at,
                created_at=task.created_at,
                version=task.version,
            )
        )
        for dependency_id in task.dependencies:
            self.add_dependency(connection, task.project_id, task.id, dependency_id)

    def get_task(self, connection: Connection, task_id: str) -> Task:
        """按主键读取 Task，并优先从规范化依赖关系恢复依赖顺序。"""
        row = connection.execute(select(tasks).where(tasks.c.id == task_id)).mappings().first()
        if row is None:
            raise NotFoundError(data={"taskId": task_id})
        dependency_rows = connection.execute(
            select(task_dependencies.c.depends_on_task_id)
            .where(
                task_dependencies.c.project_id == row["project_id"],
                task_dependencies.c.task_id == task_id,
            )
            .order_by(task_dependencies.c.id)
        ).scalars().all()
        dependencies = tuple(dependency_rows) if dependency_rows else tuple(json.loads(row["dependencies_json"]))
        return self._task_from_row(row, dependencies)

    def find_task(self, connection: Connection, task_id: str) -> Task | None:
        """提供不抛异常的 Task 查询，保持仓储组合操作可回滚。"""
        row = connection.execute(select(tasks).where(tasks.c.id == task_id)).mappings().first()
        return None if row is None else self.get_task(connection, task_id)

    def update_project(self, connection: Connection, project: Project, expected_version: int) -> Project:
        """以 expected_version 条件更新 Project，成功后只增加一个版本。"""
        current = self.get_project(connection, project.id)
        ensure_project_writable(connection, current.id)
        ensure_project_lifecycle_consistent(project.status, project.read_only)
        if expected_version != current.version:
            raise self._version_conflict("project", project.id, expected_version, current.version)
        if project.id != current.id:
            raise InvalidArgumentError(message="project id cannot change")
        new_version = expected_version + 1
        result = connection.execute(
            update(projects)
            .where(projects.c.id == project.id, projects.c.version == expected_version)
            .values(
                name=project.name,
                business_goal=project.business_goal,
                target_users=project.target_users,
                priority=project.priority,
                deadline=project.deadline,
                constraints_json=_json(project.constraints),
                stage=project.stage,
                status=_status_value(project.status),
                ended_at=project.ended_at,
                version=new_version,
                read_only=project.read_only,
            )
        )
        if result.rowcount != 1:
            raise self._version_conflict("project", project.id, expected_version, current.version)
        return project.model_copy(update={"version": new_version})

    def update_task(self, connection: Connection, task: Task, expected_version: int) -> Task:
        """以 expected_version 条件更新 Task，并原子替换其规范化依赖集合。"""
        current = self.get_task(connection, task.id)
        ensure_project_writable(connection, current.project_id)
        if expected_version != current.version:
            raise self._version_conflict("task", task.id, expected_version, current.version)
        if task.project_id != current.project_id:
            raise InvalidArgumentError(message="task project id cannot change")
        new_version = expected_version + 1
        result = connection.execute(
            update(tasks)
            .where(tasks.c.id == task.id, tasks.c.version == expected_version)
            .values(
                title=task.title,
                owner_role=task.owner_role,
                specialist_tag=task.specialist_tag,
                assignment_reason=task.assignment_reason,
                priority=task.priority,
                dependencies_json=_json(task.dependencies),
                expected_deliverables_json=_json(task.expected_deliverables),
                status=_status_value(task.status),
                started_at=task.started_at,
                ended_at=task.ended_at,
                version=new_version,
            )
        )
        if result.rowcount != 1:
            raise self._version_conflict("task", task.id, expected_version, current.version)
        connection.execute(
            delete(task_dependencies).where(
                task_dependencies.c.project_id == task.project_id,
                task_dependencies.c.task_id == task.id,
            )
        )
        for dependency_id in task.dependencies:
            self.add_dependency(connection, task.project_id, task.id, dependency_id)
        return task.model_copy(update={"version": new_version})

    def add_dependency(self, connection: Connection, project_id: str, task_id: str, depends_on_task_id: str) -> None:
        """写入同一项目内的任务依赖，复用 Schema 的复合外键边界。"""
        ensure_project_writable(connection, project_id)
        if task_id == depends_on_task_id:
            raise InvalidArgumentError(message="task cannot depend on itself")
        connection.execute(
            insert(task_dependencies).values(
                project_id=project_id,
                task_id=task_id,
                depends_on_task_id=depends_on_task_id,
                created_at=datetime.now(timezone.utc),
            )
        )

    def list_tasks(self, connection: Connection, project_id: str, cursor: str | None, limit: int) -> Page[Task]:
        """按稳定 Task ID 游标分页，避免 offset 在并发写入时漂移。"""
        if limit <= 0:
            raise InvalidArgumentError(message="limit must be positive")
        statement = select(tasks.c.id).where(tasks.c.project_id == project_id).order_by(tasks.c.id).limit(limit + 1)
        if cursor is not None:
            statement = statement.where(tasks.c.id > cursor)
        ids = connection.execute(statement).scalars().all()
        has_more = len(ids) > limit
        visible_ids = ids[:limit]
        items = tuple(self.get_task(connection, task_id) for task_id in visible_ids)
        return Page(items=items, next_cursor=visible_ids[-1] if has_more and visible_ids else None, has_more=has_more)

    @staticmethod
    def _project_from_row(row: Any) -> Project:
        """把 SQLAlchemy RowMapping 映射为严格 Project 合同。"""
        return Project(
            id=row["id"], name=row["name"], business_goal=row["business_goal"], target_users=row["target_users"],
            priority=row["priority"], deadline=_aware(row["deadline"]), constraints=json.loads(row["constraints_json"]),
            stage=row["stage"], status=ProjectStatus(row["status"]), created_at=_aware(row["created_at"]),
            ended_at=_aware(row["ended_at"]), version=row["version"], read_only=bool(row["read_only"]),
        )

    @staticmethod
    def _task_from_row(row: Any, dependencies: tuple[str, ...]) -> Task:
        """把 SQLAlchemy RowMapping 映射为严格 Task 合同。"""
        return Task(
            id=row["id"], project_id=row["project_id"], title=row["title"], owner_role=row["owner_role"],
            specialist_tag=row["specialist_tag"], assignment_reason=row["assignment_reason"], priority=row["priority"],
            dependencies=dependencies, expected_deliverables=tuple(json.loads(row["expected_deliverables_json"])),
            status=TaskStatus(row["status"]), created_at=_aware(row["created_at"]), started_at=_aware(row["started_at"]),
            ended_at=_aware(row["ended_at"]), version=row["version"],
        )

    @staticmethod
    def _version_conflict(aggregate_type: str, aggregate_id: str, expected: int, actual: int) -> VersionConflictError:
        """统一构造稳定的 409 版本冲突错误，并说明最新版本。"""
        return VersionConflictError(data={"aggregateType": aggregate_type, "aggregateId": aggregate_id, "expectedVersion": expected, "actualVersion": actual})
