from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from app.infra.database import Database
from app.security.redaction import redact


class AuditWriter:
    """将运行和安全事件脱敏后写入持久化事件表。"""

    def __init__(self, database: Database) -> None:
        """绑定用于保存脱敏审计事件的数据库。"""
        self.database = database

    async def write(
        self,
        *,
        trace_id: str,
        event_type: str,
        result: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        """序列化并脱敏事件元数据，再追加到数据库。"""
        payload = {
            "result": result,
            "metadata": metadata or {},
        }
        serialized = redact(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))
        self.database.append_event(event_type, trace_id, serialized)
