"""命令请求指纹、原始响应和幂等键冲突仓储。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from app.domain.commands import CommandResult
from app.domain.errors import IdempotencyKeyReusedError
from app.infra.repositories._common import ensure_project_writable
from app.infra.task2_schema import idempotency_records


def _aware(value: datetime | None) -> datetime | None:
    """恢复 SQLite DateTime 的 UTC 时区信息。"""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class IdempotencyRecord:
    """保存一次命令的完整请求指纹和可原样重放的 CommandResult。"""

    id: str
    project_id: str | None
    idempotency_key: str
    command_id: str
    aggregate_type: str
    aggregate_id: str
    request_hash: str
    command_result: CommandResult
    event_id: str | None
    created_at: datetime


class SqliteIdempotencyRepository:
    """在同一事务中读写幂等记录，确保重复命令不产生第二次副作用。"""

    def get(self, connection: Connection, idempotency_key: str) -> IdempotencyRecord | None:
        """按唯一幂等键读取原始响应和指纹。"""
        row = connection.execute(
            select(idempotency_records).where(idempotency_records.c.idempotency_key == idempotency_key)
        ).mappings().first()
        return None if row is None else self._from_row(row)

    def save(self, connection: Connection, record: IdempotencyRecord) -> IdempotencyRecord:
        """保存幂等记录；并发唯一键竞争时返回同请求记录或报告键复用。"""
        if record.project_id is not None:
            ensure_project_writable(connection, record.project_id)
        values = {
            "id": record.id,
            "project_id": record.project_id,
            "idempotency_key": record.idempotency_key,
            "command_id": record.command_id,
            "aggregate_type": record.aggregate_type,
            "aggregate_id": record.aggregate_id,
            "request_hash": record.request_hash,
            "response_json": json.dumps(record.command_result.model_dump(mode="json", by_alias=True), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False),
            "event_id": record.event_id,
            "created_at": record.created_at,
        }
        try:
            connection.execute(insert(idempotency_records).values(**values))
        except IntegrityError:
            existing = self.get(connection, record.idempotency_key)
            if existing is None:
                raise
            self.assert_reusable(existing, record.request_hash, "trace_idempotency_save")
            return existing
        return record

    @staticmethod
    def assert_reusable(existing: IdempotencyRecord, request_hash: str, trace_id: str) -> CommandResult:
        """同指纹返回原结果，不同指纹抛出稳定 IDEMPOTENCY_KEY_REUSED。"""
        if existing.request_hash != request_hash:
            raise IdempotencyKeyReusedError(
                trace_id=trace_id,
                data={"idempotencyKey": existing.idempotency_key, "originalCommandId": existing.command_id},
            )
        return existing.command_result

    @staticmethod
    def _from_row(row: Any) -> IdempotencyRecord:
        """把数据库行映射回不可变幂等记录。"""
        return IdempotencyRecord(
            id=row["id"], project_id=row["project_id"], idempotency_key=row["idempotency_key"],
            command_id=row["command_id"], aggregate_type=row["aggregate_type"], aggregate_id=row["aggregate_id"],
            request_hash=row["request_hash"], command_result=CommandResult.model_validate(json.loads(row["response_json"])),
            event_id=row["event_id"], created_at=_aware(row["created_at"]),
        )
