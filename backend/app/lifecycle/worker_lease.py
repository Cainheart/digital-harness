from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from app.infra.database import Database


@dataclass(frozen=True)
class WorkerLeaseStatus:
    """表示一个 Worker 的心跳、状态和可恢复性判断输入。"""
    worker_id: str
    status: str
    heartbeat_at: datetime


class WorkerLeaseStore:
    """持久化 Worker 租约，并将超时心跳标记为 expired。"""

    def __init__(self, database: Database, *, expiry_seconds: int = 300) -> None:
        """注入数据库并设置心跳过期阈值（秒）。"""
        self.database = database
        self.expiry_seconds = expiry_seconds

    def register_sync(self, worker_id: str, *, heartbeat_at: datetime | None = None) -> None:
        """注册或刷新 Worker 心跳租约。"""
        self.database.save_worker_lease(worker_id, heartbeat_at or datetime.now(timezone.utc), "active")

    def statuses_sync(self) -> list[WorkerLeaseStatus]:
        """读取租约并根据当前时间计算活动或过期状态。"""
        now = datetime.now(timezone.utc)
        statuses = []
        for worker_id, heartbeat_at, status in self.database.read_worker_leases():
            if isinstance(heartbeat_at, str):
                heartbeat_at = datetime.fromisoformat(heartbeat_at)
            if heartbeat_at.tzinfo is None:
                heartbeat_at = heartbeat_at.replace(tzinfo=timezone.utc)
            age = (now - heartbeat_at).total_seconds()
            current_status = "expired" if age > self.expiry_seconds else status
            if current_status == "expired" and status != "expired":
                self.database.save_worker_lease(worker_id, heartbeat_at, "expired")
            statuses.append(WorkerLeaseStatus(worker_id, current_status, heartbeat_at))
        return statuses
