"""DomainEvent 追加、不可变历史读取和全局游标。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import NamedTuple
from typing import Any, Sequence

from sqlalchemy import func, insert, select
from sqlalchemy.engine import Connection

from app.domain.common import Actor, new_object_id
from app.domain.errors import InvalidArgumentError, NotFoundError, VersionConflictError
from app.domain.events import AppendResult, DomainEvent, DomainEventDraft
from app.infra.outbox import OutboxRepository
from app.infra.repositories._common import ensure_project_writable
from app.infra.task2_schema import (
    approvals,
    artifacts,
    artifact_versions,
    defects,
    domain_events,
    execution_attempts,
    model_calls,
    notifications,
    projects,
    reviews,
    tasks,
    test_cases,
    test_runs,
    tool_calls,
)
from app.infra.transactions import AsyncUnitOfWork


def _aware(value: datetime | None) -> datetime | None:
    """恢复 SQLite DateTime 的 UTC 时区信息。"""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


class _AggregateSpec(NamedTuple):
    """描述可接收领域事件的对象表及其项目/对象版本列。"""

    table: Any
    id_column: str
    project_column: str
    version_column: str | None = None


_AGGREGATE_REGISTRY: dict[str, _AggregateSpec] = {
    "project": _AggregateSpec(projects, "id", "id", "version"),
    "task": _AggregateSpec(tasks, "id", "project_id", "version"),
    "artifact": _AggregateSpec(artifacts, "id", "project_id", None),
    "artifact_version": _AggregateSpec(artifact_versions, "id", "project_id", "version_number"),
    "approval": _AggregateSpec(approvals, "id", "project_id", "version"),
    "review": _AggregateSpec(reviews, "id", "project_id", "version"),
    "test_case": _AggregateSpec(test_cases, "id", "project_id", "version"),
    "test_run": _AggregateSpec(test_runs, "id", "project_id", None),
    "defect": _AggregateSpec(defects, "id", "project_id", "version"),
    "execution_attempt": _AggregateSpec(execution_attempts, "id", "project_id", "version"),
    "model_call": _AggregateSpec(model_calls, "id", "project_id", None),
    "tool_call": _AggregateSpec(tool_calls, "id", "project_id", None),
    "notification": _AggregateSpec(notifications, "id", "project_id", None),
    "domain_event": _AggregateSpec(domain_events, "event_id", "project_id", None),
}


class SqliteEventStore:
    """使用 SQLAlchemy Core 追加不可变 DomainEvent，并在同一连接写 Outbox。"""

    def __init__(self, outbox: OutboxRepository | None = None) -> None:
        """注入可替换 Outbox 仓储；默认使用同一套冻结 Schema。"""
        self.outbox = outbox or OutboxRepository()

    def append(
        self,
        connection: Connection,
        aggregate_type: str,
        aggregate_id: str,
        expected_version: int,
        events: Sequence[DomainEventDraft],
    ) -> AppendResult:
        """校验聚合版本后连续分配版本/全局序号，并追加事件与 Outbox。"""
        drafts = tuple(events)
        project_id, object_version = self._require_aggregate(connection, aggregate_type, aggregate_id)
        ensure_project_writable(connection, project_id)
        current_version = connection.execute(
            select(func.max(domain_events.c.aggregate_version)).where(
                domain_events.c.aggregate_type == aggregate_type,
                domain_events.c.aggregate_id == aggregate_id,
            )
        ).scalar_one() or 0
        if current_version != expected_version:
            raise VersionConflictError(
                data={"aggregateType": aggregate_type, "aggregateId": aggregate_id, "expectedVersion": expected_version, "actualVersion": current_version}
            )
        for draft in drafts:
            if draft.aggregate_type != aggregate_type or draft.aggregate_id != aggregate_id:
                raise InvalidArgumentError(message="all event drafts must target the appended aggregate")
        expected_object_version = expected_version + len(drafts)
        if object_version is not None and object_version != expected_object_version:
            raise VersionConflictError(
                data={
                    "aggregateType": aggregate_type,
                    "aggregateId": aggregate_id,
                    "expectedVersion": expected_version,
                    "actualVersion": current_version,
                    "objectVersion": object_version,
                    "expectedObjectVersion": expected_object_version,
                }
            )
        last_sequence = connection.execute(select(func.max(domain_events.c.global_sequence))).scalar_one() or 0
        appended: list[DomainEvent] = []
        for offset, draft in enumerate(drafts, start=1):
            event = self._materialize(
                draft,
                event_id=new_object_id("event"),
                aggregate_version=expected_version + offset,
                global_sequence=last_sequence + offset,
            )
            payload_json = self._payload_json(draft)
            connection.execute(
                insert(domain_events).values(
                    event_id=event.event_id,
                    project_id=project_id,
                    event_type=event.event_type,
                    aggregate_type=event.aggregate_type,
                    aggregate_id=event.aggregate_id,
                    aggregate_version=event.aggregate_version,
                    global_sequence=event.global_sequence,
                    occurred_at=event.occurred_at,
                    duration_ms=event.duration_ms,
                    actor_type=event.actor.type,
                    actor_id=event.actor.id,
                    input_summary=self._json_or_text(event.input_summary),
                    output_summary=self._json_or_text(event.output_summary),
                    result=event.result,
                    failure=event.failure,
                    retry_count=event.retry_count,
                    trace_id=event.trace_id,
                    payload_json=payload_json,
                )
            )
            appended.append(event)
            self.outbox.enqueue(connection, event, topic="domain.events", project_id=project_id)
        return AppendResult(
            aggregate_type=aggregate_type,
            aggregate_id=aggregate_id,
            expected_version=expected_version,
            aggregate_version=expected_version + len(appended),
            events=tuple(appended),
        )

    def list_after(
        self,
        connection: Connection,
        event_id: str | None,
        project_id: str | None = None,
        limit: int | None = None,
    ) -> list[DomainEvent]:
        """以 event_id 对应的 global_sequence 为游标读取之后的事件。"""
        cursor_sequence = 0
        if event_id is not None:
            cursor_sequence = connection.execute(
                select(domain_events.c.global_sequence).where(domain_events.c.event_id == event_id)
            ).scalar_one_or_none()
            if cursor_sequence is None:
                raise NotFoundError(data={"eventId": event_id})
        statement = select(domain_events).where(domain_events.c.global_sequence > cursor_sequence)
        if project_id is not None:
            statement = statement.where(domain_events.c.project_id == project_id)
        statement = statement.order_by(domain_events.c.global_sequence, domain_events.c.occurred_at, domain_events.c.event_id)
        if limit is not None:
            if limit <= 0:
                raise InvalidArgumentError(message="limit must be positive")
            statement = statement.limit(limit)
        return [self._event_from_row(row) for row in connection.execute(statement).mappings().all()]

    def list_for_aggregate(self, connection: Connection, aggregate_type: str, aggregate_id: str) -> list[DomainEvent]:
        """按聚合版本读取完整不可变事件历史。"""
        rows = connection.execute(
            select(domain_events)
            .where(domain_events.c.aggregate_type == aggregate_type, domain_events.c.aggregate_id == aggregate_id)
            .order_by(domain_events.c.aggregate_version)
        ).mappings().all()
        return [self._event_from_row(row) for row in rows]

    def count_for_aggregate(self, connection: Connection, aggregate_type: str, aggregate_id: str) -> int:
        """返回聚合事件数量，供幂等/回滚验收使用。"""
        return connection.execute(
            select(func.count()).select_from(domain_events).where(
                domain_events.c.aggregate_type == aggregate_type,
                domain_events.c.aggregate_id == aggregate_id,
            )
        ).scalar_one()

    @staticmethod
    def _require_aggregate(connection: Connection, aggregate_type: str, aggregate_id: str) -> tuple[str, int | None]:
        """通过固定 registry 定位已存在对象、项目范围和可用对象版本。"""
        spec = _AGGREGATE_REGISTRY.get(aggregate_type)
        if spec is None:
            raise InvalidArgumentError(
                message=f"unsupported aggregate type: {aggregate_type}",
                data={"aggregateType": aggregate_type, "aggregateId": aggregate_id},
            )

        table = spec.table
        selected_columns = [getattr(table.c, spec.project_column)]
        if spec.version_column is not None:
            selected_columns.append(getattr(table.c, spec.version_column))
        row = connection.execute(
            select(*selected_columns).where(getattr(table.c, spec.id_column) == aggregate_id)
        ).first()
        if row is None or row[0] is None:
            raise NotFoundError(data={"aggregateType": aggregate_type, "aggregateId": aggregate_id})
        return row[0], row[1] if spec.version_column is not None else None

    async def _append_async(
        self,
        database,
        aggregate_type: str,
        aggregate_id: str,
        expected_version: int,
        events: Sequence[DomainEventDraft],
    ) -> AppendResult:
        """在异步适配器内部复用同步追加实现。"""
        async with AsyncUnitOfWork(database) as unit:
            return self.append(unit.connection, aggregate_type, aggregate_id, expected_version, events)

    @staticmethod
    def _materialize(draft: DomainEventDraft, *, event_id: str, aggregate_version: int, global_sequence: int) -> DomainEvent:
        """将 draft 加上仓储分配的不可变身份和序号。"""
        return DomainEvent(
            eventId=event_id,
            eventType=draft.event_type,
            aggregateType=draft.aggregate_type,
            aggregateId=draft.aggregate_id,
            aggregateVersion=aggregate_version,
            globalSequence=global_sequence,
            payload=draft.payload,
            inputSummary=draft.input_summary,
            outputSummary=draft.output_summary,
            result=draft.result,
            failure=draft.failure,
            retry_count=draft.retry_count,
            duration_ms=draft.duration_ms,
            actor=draft.actor,
            traceId=draft.trace_id,
            occurredAt=draft.occurred_at,
            attemptId=draft.attempt_id,
            rejectionReason=draft.rejection_reason,
            redactionReason=draft.redaction_reason,
            eventCategory=draft.event_category,
        )

    @staticmethod
    def _payload_json(draft: DomainEventDraft) -> str:
        """保存 payload 与非列化事件上下文，读取时恢复原始 payload。"""
        metadata = {
            key: value
            for key, value in {
                "attemptId": draft.attempt_id,
                "rejectionReason": draft.rejection_reason,
                "redactionReason": draft.redaction_reason,
                "eventCategory": draft.event_category,
            }.items()
            if value is not None
        }
        envelope = {"__task2_payload": draft.payload, "__task2_metadata": metadata}
        return json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

    @staticmethod
    def _json_or_text(value: Any) -> str:
        """按 Schema Text 列稳定保存字典摘要或普通摘要字符串。"""
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

    @classmethod
    def _event_from_row(cls, row: Any) -> DomainEvent:
        """恢复 DomainEvent，兼容迁移测试中直接写入的旧式 payload JSON。"""
        envelope = json.loads(row["payload_json"])
        if isinstance(envelope, dict) and "__task2_payload" in envelope:
            payload = envelope["__task2_payload"]
            metadata = envelope.get("__task2_metadata", {})
        else:
            payload = envelope
            metadata = {}
        return DomainEvent(
            eventId=row["event_id"], eventType=row["event_type"], aggregateType=row["aggregate_type"],
            aggregateId=row["aggregate_id"], aggregateVersion=row["aggregate_version"], globalSequence=row["global_sequence"],
            occurredAt=_aware(row["occurred_at"]), duration_ms=row["duration_ms"], actor=Actor(type=row["actor_type"], id=row["actor_id"]),
            inputSummary=cls._decode_summary(row["input_summary"]), outputSummary=cls._decode_summary(row["output_summary"]),
            result=row["result"], failure=row["failure"], retry_count=row["retry_count"], traceId=row["trace_id"],
            payload=payload, attemptId=metadata.get("attemptId"), rejectionReason=metadata.get("rejectionReason"),
            redactionReason=metadata.get("redactionReason"), eventCategory=metadata.get("eventCategory", "ordinary"),
        )

    @staticmethod
    def _decode_summary(value: str) -> Any:
        """把 JSON 摘要还原为对象，普通文本保持字符串。"""
        try:
            return json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return value


class AsyncEventStoreAdapter:
    """把同步 SQLite EventStore 适配为领域 EventStore 的异步 Protocol 外观。"""

    def __init__(self, database, store: SqliteEventStore | None = None) -> None:
        """注入 Database 和可选同步事件仓储，读写仍复用相同的 Core 实现。"""
        self.database = database
        self.store = store or SqliteEventStore()

    async def append(
        self,
        aggregate_type: str,
        aggregate_id: str,
        expected_version: int,
        events: Sequence[DomainEventDraft],
    ) -> AppendResult:
        """在 AsyncUnitOfWork 中追加事件、Outbox，并由异常触发回滚。"""
        async with AsyncUnitOfWork(self.database) as unit:
            return self.store.append(
                unit.connection,
                aggregate_type,
                aggregate_id,
                expected_version,
                events,
            )

    async def list_after(
        self,
        event_id: str | None,
        project_id: str | None = None,
    ) -> list[DomainEvent]:
        """在只读快照中执行领域协议要求的异步游标查询。"""
        with self.database.read_connection() as connection:
            return self.store.list_after(connection, event_id, project_id)
