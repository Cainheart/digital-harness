"""DomainEvent 同事务 Outbox 的 SQLAlchemy Core 仓储。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import insert, or_, select, update
from sqlalchemy.engine import Connection

from app.domain.common import new_object_id
from app.domain.errors import NotFoundError
from app.infra.repositories._common import ensure_project_writable
from app.infra.task2_schema import outbox_messages


@dataclass(frozen=True)
class OutboxMessage:
    """描述待投递或已投递消息，正文只保存事件的 JSON 快照。"""

    id: str
    project_id: str | None
    event_id: str
    topic: str
    payload: dict[str, Any]
    created_at: datetime
    published_at: datetime | None
    status: str
    retry_count: int
    last_error: str | None
    available_at: datetime | None


def _aware(value: datetime | None) -> datetime | None:
    """恢复 SQLite DateTime 的 UTC 时区信息。"""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


class OutboxRepository:
    """在调用方 UnitOfWork 的连接中写入、查询和标记 Outbox 消息。"""

    def enqueue(
        self,
        connection: Connection,
        event: Any,
        *,
        topic: str = "domain.events",
        project_id: str | None = None,
    ) -> OutboxMessage:
        """把已构造 DomainEvent 写入待发布集合，唯一 event_id 防止重复投递记录。"""
        payload = event.model_dump(mode="json", by_alias=False)
        resolved_project_id = project_id if project_id is not None else self._project_id(connection, event)
        self._ensure_project_writable_if_scoped(connection, resolved_project_id)
        values = {
            "id": new_object_id("outbox"),
            "project_id": resolved_project_id,
            "event_id": event.event_id,
            "topic": topic,
            "payload_json": json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False),
            "created_at": event.occurred_at,
            "status": "pending",
            "retry_count": 0,
            "available_at": event.occurred_at,
        }
        connection.execute(insert(outbox_messages).values(**values))
        return self._message_from_values(values)

    def list_unpublished(self, connection: Connection, limit: int = 100) -> list[OutboxMessage]:
        """按创建顺序返回尚未发布且已到可用时间的消息。"""
        if limit <= 0:
            raise ValueError("limit must be positive")
        now = datetime.now(timezone.utc)
        rows = connection.execute(
            select(outbox_messages)
            .where(
                outbox_messages.c.published_at.is_(None),
                outbox_messages.c.status != "published",
                or_(outbox_messages.c.available_at.is_(None), outbox_messages.c.available_at <= now),
            )
            .order_by(outbox_messages.c.created_at, outbox_messages.c.id)
            .limit(limit)
        ).mappings().all()
        return [self._message_from_row(row) for row in rows]

    def mark_published(self, connection: Connection, message_id: str, published_at: datetime | None = None) -> OutboxMessage:
        """幂等标记消息已发布；重复标记返回已发布快照，不产生错误。"""
        current = connection.execute(select(outbox_messages).where(outbox_messages.c.id == message_id)).mappings().first()
        if current is None:
            raise NotFoundError(data={"outboxId": message_id})
        self._ensure_project_writable_if_scoped(connection, current["project_id"])
        if current["published_at"] is None or current["status"] != "published":
            connection.execute(
                update(outbox_messages).where(outbox_messages.c.id == message_id).values(
                    published_at=published_at or datetime.now(timezone.utc), status="published"
                )
            )
        row = connection.execute(select(outbox_messages).where(outbox_messages.c.id == message_id)).mappings().one()
        return self._message_from_row(row)

    def mark_failed(
        self,
        connection: Connection,
        message_id: str,
        *,
        error: str,
        available_at: datetime | None = None,
    ) -> OutboxMessage:
        """记录一次投递失败并递增重试次数，失败消息仍保留在 Outbox。"""
        current = self._get_row(connection, message_id)
        self._ensure_project_writable_if_scoped(connection, current["project_id"])
        connection.execute(
            update(outbox_messages)
            .where(outbox_messages.c.id == message_id, outbox_messages.c.published_at.is_(None))
            .values(
                status="failed",
                retry_count=current["retry_count"] + 1,
                last_error=error,
                available_at=available_at or datetime.now(timezone.utc),
            )
        )
        return self._message_from_row(self._get_row(connection, message_id))

    def record_failure(
        self,
        connection: Connection,
        message_id: str,
        *,
        error: str,
        available_at: datetime | None = None,
    ) -> OutboxMessage:
        """提供语义明确的失败记录别名，供投递器按领域命名调用。"""
        return self.mark_failed(connection, message_id, error=error, available_at=available_at)

    def schedule_retry(
        self,
        connection: Connection,
        message_id: str,
        *,
        available_at: datetime,
    ) -> OutboxMessage:
        """把未发布消息重新排入 pending 队列，不清除失败审计信息。"""
        current = self._get_row(connection, message_id)
        self._ensure_project_writable_if_scoped(connection, current["project_id"])
        connection.execute(
            update(outbox_messages)
            .where(outbox_messages.c.id == message_id, outbox_messages.c.published_at.is_(None))
            .values(status="pending", available_at=available_at)
        )
        return self._message_from_row(self._get_row(connection, message_id))

    def retry(
        self,
        connection: Connection,
        message_id: str,
        *,
        available_at: datetime,
    ) -> OutboxMessage:
        """提供简短的重试调度别名，保持失败与重试都使用同一事务连接。"""
        return self.schedule_retry(connection, message_id, available_at=available_at)

    @staticmethod
    def _project_id(connection: Connection, event: Any) -> str | None:
        """读取 DomainEvent 的可选项目范围，不为不存在的测试聚合制造 FK。"""
        value = getattr(event, "project_id", None)
        return value

    @staticmethod
    def _message_from_values(values: dict[str, Any]) -> OutboxMessage:
        """把刚插入的值转换为仓储返回合同。"""
        return OutboxMessage(
            id=values["id"], project_id=values["project_id"], event_id=values["event_id"], topic=values["topic"],
            payload=json.loads(values["payload_json"]), created_at=_aware(values["created_at"]), published_at=None,
            status=values["status"], retry_count=values["retry_count"], last_error=None,
            available_at=_aware(values["available_at"]),
        )

    @staticmethod
    def _message_from_row(row: Any) -> OutboxMessage:
        """把数据库行恢复为不可变 OutboxMessage。"""
        return OutboxMessage(
            id=row["id"], project_id=row["project_id"], event_id=row["event_id"], topic=row["topic"],
            payload=json.loads(row["payload_json"]), created_at=_aware(row["created_at"]),
            published_at=_aware(row["published_at"]), status=row["status"], retry_count=row["retry_count"],
            last_error=row["last_error"], available_at=_aware(row["available_at"]),
        )

    @staticmethod
    def _get_row(connection: Connection, message_id: str) -> Any:
        """读取 Outbox 当前行，统一处理不存在消息的稳定错误。"""
        row = connection.execute(select(outbox_messages).where(outbox_messages.c.id == message_id)).mappings().first()
        if row is None:
            raise NotFoundError(data={"outboxId": message_id})
        return row

    @staticmethod
    def _ensure_project_writable_if_scoped(connection: Connection, project_id: str | None) -> None:
        """仅对带项目范围的消息执行生命周期保护，系统消息保持可用。"""
        if project_id is not None:
            ensure_project_writable(connection, project_id)
