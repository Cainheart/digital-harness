"""Shared, schema-neutral mapping helpers for Task 2 repositories."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import re
from typing import Any, TypeVar

from pydantic import BaseModel

from app.domain.common import Page, ProjectStatus
from app.domain.errors import InvalidArgumentError, NotFoundError, ReadOnlyProjectError


ModelT = TypeVar("ModelT", bound=BaseModel)
_TERMINAL_PROJECT_STATUSES = frozenset(
    {ProjectStatus.COMPLETED.value, ProjectStatus.TERMINATED.value}
)
_SENSITIVE_VALUE = re.compile(
    r"(?:api[_ -]?key|authorization|bearer|cookie|secret|password|prompt|"
    r"access[_ -]?token|refresh[_ -]?token|tokens?)\s*[:=]|\bbearer\s+\S+|\bsk-[A-Za-z0-9][A-Za-z0-9_-]*",
    re.IGNORECASE,
)


def utc_datetime(value: datetime | None) -> datetime | None:
    """将 SQLite 返回的无时区时间恢复为 UTC，保持领域时间合同。"""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def json_text(value: Any) -> str:
    """将小型领域集合编码成稳定 JSON，Artifact 正文不经过此入口。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def json_value(value: str) -> Any:
    """解析 Schema 已通过 JSON1 校验的结构化列。"""
    return json.loads(value)


def reject_sensitive_summary(value: str) -> str:
    """拒绝凭据、Bearer、Cookie 和完整提示词进入调用摘要。"""
    if not isinstance(value, str) or _SENSITIVE_VALUE.search(value):
        raise ValueError("credential or prompt data is not allowed in summary")
    return value


def ensure_project(connection: Any, project_id: str) -> None:
    """确认对象所属项目存在，避免跨项目事实落库。"""
    from app.infra.task2_schema import projects

    if connection.execute(
        projects.select().with_only_columns(projects.c.id).where(projects.c.id == project_id)
    ).first() is None:
        raise NotFoundError(f"project {project_id} was not found")


def ensure_project_writable(connection: Any, project_id: str) -> None:
    """确认项目存在且只读/终态项目都不会接收新的写入事实。"""
    from app.infra.task2_schema import projects

    row = connection.execute(
        projects.select()
        .with_only_columns(projects.c.status, projects.c.read_only)
        .where(projects.c.id == project_id)
    ).first()
    if row is None:
        raise NotFoundError(f"project {project_id} was not found")
    if row.read_only or row.status in _TERMINAL_PROJECT_STATUSES:
        raise ReadOnlyProjectError("read-only or terminal projects reject new facts")


def ensure_project_lifecycle_consistent(status: Any, read_only: bool) -> None:
    """拒绝终态项目保持可写，避免 Project 状态与只读标志分裂。"""
    status_value = status.value if isinstance(status, ProjectStatus) else str(status)
    if status_value in _TERMINAL_PROJECT_STATUSES and not read_only:
        raise InvalidArgumentError(
            message="completed or terminated projects must be read-only",
            data={"status": status_value, "readOnly": read_only},
        )


def ensure_project_child(
    connection: Any,
    table: Any,
    project_id: str,
    object_id: str,
    *,
    label: str,
    id_column: str = "id",
) -> None:
    """确认带 project_id 的子对象存在且与当前项目一致。"""
    column = getattr(table.c, id_column)
    if connection.execute(
        table.select()
        .with_only_columns(table.c.project_id)
        .where(column == object_id)
    ).scalar_one_or_none() != project_id:
        raise NotFoundError(f"{label} {object_id} was not found in project {project_id}")


def model_data(model: BaseModel) -> dict[str, Any]:
    """获取模型的内部字段名映射，避免仓储依赖 API 别名。"""
    return model.model_dump(mode="python")


def page(items: list[ModelT], *, limit: int, cursor: str | None) -> Page[ModelT]:
    """把 limit+1 查询结果裁剪成稳定 Page。"""
    has_more = len(items) > limit
    visible = items[:limit]
    next_cursor = cursor if has_more else None
    return Page(items=tuple(visible), next_cursor=next_cursor, has_more=has_more)
