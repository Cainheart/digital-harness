"""TraceLink 的项目隔离、双向查询和覆盖率报告。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import base64
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError

from app.domain.common import Page, utc_now
from app.domain.entities import TraceLink
from app.domain.errors import NotFoundError, TraceLinkInvalidError
from app.infra.task2_schema import (
    TRACE_LINK_ALLOWED_NODE_TYPES,
    domain_events,
    trace_links,
)

from ._common import ensure_project, ensure_project_child, ensure_project_writable, page, utc_datetime


@dataclass(frozen=True)
class TraceCoverage:
    """描述代表性追踪节点的已连接、断链和查询范围。"""

    expected_count: int
    actual_node_count: int
    connected_count: int
    broken_links: int
    broken_nodes: tuple[tuple[str, str], ...]
    percentage: float
    trace_id: str | None
    queried_at: datetime

    @property
    def actual_count(self) -> int:
        """兼容报告消费者使用的 actual_count 简名。"""
        return self.actual_node_count


@dataclass(frozen=True)
class TraceNode:
    """表示覆盖率报告中的一个逻辑节点。"""

    node_type: str
    node_id: str


def _trace_model(row: Any) -> TraceLink:
    """将 TraceLink 表行映射回严格领域对象。"""
    return TraceLink(
        id=row.id,
        project_id=row.project_id,
        source_type=row.source_type,
        source_id=row.source_id,
        target_type=row.target_type,
        target_id=row.target_id,
        relation=row.relation,
        trace_id=row.trace_id,
        created_at=utc_datetime(row.created_at),
        version=1,
    )


class TraceRepository:
    """保存和查询跨需求、任务、证据和执行事实的显式追踪关系。"""

    def create(self, connection: Any, link: TraceLink) -> None:
        """校验两端项目范围并插入唯一追踪关系，重复关系映射为稳定错误。"""
        if link.source_type not in TRACE_LINK_ALLOWED_NODE_TYPES or link.target_type not in TRACE_LINK_ALLOWED_NODE_TYPES:
            raise TraceLinkInvalidError("TraceLink endpoint type is unsupported")
        if link.source_type == link.target_type and link.source_id == link.target_id:
            raise TraceLinkInvalidError("TraceLink cannot point to itself")
        try:
            ensure_project_writable(connection, link.project_id)
        except NotFoundError as error:
            raise TraceLinkInvalidError("TraceLink project is not available") from error
        self._ensure_endpoint(connection, link.project_id, link.source_type, link.source_id)
        self._ensure_endpoint(connection, link.project_id, link.target_type, link.target_id)
        try:
            connection.execute(trace_links.insert().values(
                id=link.id, project_id=link.project_id, source_type=link.source_type,
                source_id=link.source_id, target_type=link.target_type, target_id=link.target_id,
                relation=link.relation, trace_id=link.trace_id, created_at=link.created_at,
            ))
        except IntegrityError as error:
            raise TraceLinkInvalidError("duplicate or cross-project TraceLink") from error

    def list_forward(
        self,
        connection: Any,
        source_type: str,
        source_id: str,
        cursor: str | None = None,
        limit: int = 50,
        *,
        project_id: str | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
        relation: str | None = None,
        trace_id: str | None = None,
        created_after: datetime | None = None,
        created_before: datetime | None = None,
    ) -> Page[TraceLink]:
        """按项目、端点、关系、trace、时间和游标查询 source -> target。"""
        return self._list(
            connection,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            target_type=target_type,
            target_id=target_id,
            relation=relation,
            trace_id=trace_id,
            created_after=created_after,
            created_before=created_before,
            cursor=cursor,
            limit=limit,
        )

    def list_reverse(
        self,
        connection: Any,
        target_type: str,
        target_id: str,
        cursor: str | None = None,
        limit: int = 50,
        *,
        project_id: str | None = None,
        source_type: str | None = None,
        source_id: str | None = None,
        relation: str | None = None,
        trace_id: str | None = None,
        created_after: datetime | None = None,
        created_before: datetime | None = None,
    ) -> Page[TraceLink]:
        """按项目、端点、关系、trace、时间和游标查询 target -> source。"""
        return self._list(
            connection,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            target_type=target_type,
            target_id=target_id,
            relation=relation,
            trace_id=trace_id,
            created_after=created_after,
            created_before=created_before,
            cursor=cursor,
            limit=limit,
        )

    def coverage(
        self, connection: Any, project_id: str,
        expected_nodes: tuple[tuple[str, str], ...],
    ) -> TraceCoverage:
        """计算项目节点的连接覆盖率和断链节点列表。"""
        ensure_project(connection, project_id)
        rows = connection.execute(
            select(trace_links).where(trace_links.c.project_id == project_id)
        ).mappings().all()
        connected = {
            (row["source_type"], row["source_id"]) for row in rows
        } | {
            (row["target_type"], row["target_id"]) for row in rows
        }
        expected = tuple(
            (node.node_type, node.node_id)
            if isinstance(node, TraceNode)
            else (node[0], node[1])
            for node in expected_nodes
        )
        broken_nodes = tuple(node for node in expected if node not in connected)
        expected_count = len(expected)
        connected_count = expected_count - len(broken_nodes)
        percentage = 100.0 if expected_count == 0 else round(connected_count * 100.0 / expected_count, 2)
        trace_ids = {row["trace_id"] for row in rows}
        return TraceCoverage(
            expected_count=expected_count,
            actual_node_count=len(connected),
            connected_count=connected_count,
            broken_links=len(broken_nodes),
            broken_nodes=broken_nodes,
            percentage=percentage,
            trace_id=next(iter(trace_ids)) if len(trace_ids) == 1 else None,
            queried_at=utc_now(),
        )

    def _list(
        self,
        connection: Any,
        *,
        project_id: str | None,
        source_type: str | None,
        source_id: str | None,
        target_type: str | None,
        target_id: str | None,
        relation: str | None,
        trace_id: str | None,
        created_after: datetime | None,
        created_before: datetime | None,
        cursor: str | None,
        limit: int,
    ) -> Page[TraceLink]:
        """执行统一双向分页查询并生成稳定下一游标。"""
        if limit <= 0:
            raise ValueError("limit must be positive")
        condition = []
        for key, value in {
            "project_id": project_id,
            "source_type": source_type,
            "source_id": source_id,
            "target_type": target_type,
            "target_id": target_id,
            "relation": relation,
            "trace_id": trace_id,
        }.items():
            if value is None:
                continue
            condition.append(getattr(trace_links.c, key) == value)
        if created_after is not None:
            condition.append(trace_links.c.created_at > created_after)
        if created_before is not None:
            condition.append(trace_links.c.created_at < created_before)
        statement = select(trace_links).where(and_(*condition)).order_by(
            trace_links.c.created_at, trace_links.c.id
        )
        if cursor:
            decoded = self._decode_cursor(cursor)
            cursor_row = connection.execute(
                select(trace_links.c.created_at, trace_links.c.id).where(trace_links.c.id == decoded)
            ).first()
            if cursor_row is None:
                raise TraceLinkInvalidError("TraceLink cursor is invalid")
            statement = statement.where(
                or_(
                    trace_links.c.created_at > cursor_row.created_at,
                    and_(trace_links.c.created_at == cursor_row.created_at, trace_links.c.id > cursor_row.id),
                )
            )
        rows = connection.execute(statement.limit(limit + 1)).all()
        values = [_trace_model(row) for row in rows]
        next_cursor = self._encode_cursor(values[limit - 1].id) if len(values) > limit else None
        return Page(items=tuple(values[:limit]), next_cursor=next_cursor, has_more=next_cursor is not None)

    def _ensure_endpoint(self, connection: Any, project_id: str, node_type: str, node_id: str) -> None:
        """校验实体端点确实属于项目；逻辑节点由 TraceLink 自身承载项目范围。"""
        logical = {"requirement", "acceptance_criterion", "evidence"}
        if node_type in logical:
            return
        if node_type == "domain_event":
            row = connection.execute(
                select(domain_events.c.project_id).where(domain_events.c.event_id == node_id)
            ).first()
            if row is None or row.project_id != project_id:
                raise NotFoundError(f"domain event {node_id} was not found in project")
            return
        from app.infra.task2_schema import metadata

        contracts = {
            "project": ("projects", "id"),
            "task": ("tasks", "id"),
            "artifact_version": ("artifact_versions", "id"),
            "approval": ("approvals", "id"),
            "review": ("reviews", "id"),
            "test_case": ("test_cases", "id"),
            "test_run": ("test_runs", "id"),
            "defect": ("defects", "id"),
            "execution_attempt": ("execution_attempts", "id"),
            "model_call": ("model_calls", "id"),
            "tool_call": ("tool_calls", "id"),
        }
        table_name, id_column = contracts.get(node_type, (None, None))
        if table_name is None:
            raise TraceLinkInvalidError(f"TraceLink endpoint type {node_type} is unsupported")
        table = metadata.tables[table_name]
        if node_type == "project":
            if node_id != project_id:
                raise TraceLinkInvalidError("project endpoint is outside TraceLink project")
            ensure_project(connection, project_id)
            return
        try:
            ensure_project_child(connection, table, project_id, node_id, label=node_type, id_column=id_column)
        except NotFoundError as error:
            raise TraceLinkInvalidError(str(error)) from error

    @staticmethod
    def _encode_cursor(value: str) -> str:
        """把内部主键包装成不依赖时间格式的游标。"""
        return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")

    @staticmethod
    def _decode_cursor(value: str) -> str:
        """解析查询游标，拒绝损坏值而不暴露底层异常。"""
        try:
            return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
        except (ValueError, UnicodeDecodeError) as error:
            raise TraceLinkInvalidError("TraceLink cursor is invalid") from error
