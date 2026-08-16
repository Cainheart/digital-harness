from __future__ import annotations

from dataclasses import dataclass

from app.infra.database import Database
from app.lifecycle.worker_lease import WorkerLeaseStatus, WorkerLeaseStore


@dataclass
class ApplicationLifecycle:
    """管理应用停止标记、运行状态持久化和 Worker 租约查询。"""

    database: Database
    leases: WorkerLeaseStore
    closing: bool = False

    def start_sync(self) -> None:
        """开始本地生命周期；缺少数据库时先完成基础初始化。"""
        self.closing = False
        if self.database.current_revision() is None:
            self.database.initialize()

    def stop_sync(self) -> None:
        """标记应用正在关闭，并记录已提交的停止事件。"""
        self.closing = True
        self.database.append_event("ApplicationStopped", "tr_lifecycle", '{"result":"stopped"}')

    def record_runtime_state_sync(self, status: str, reason: str) -> None:
        """保存运行状态及其原因，供重启恢复和审计查询。"""
        self.database.write_runtime_state(status, reason)
        self.database.append_event("RuntimeStateChanged", "tr_lifecycle", '{"result":"committed"}')

    def current_state_sync(self) -> str | None:
        """读取当前持久化运行状态。"""
        state = self.database.read_runtime_state()
        return state.status if state else None

    def check_worker_leases_sync(self) -> list[WorkerLeaseStatus]:
        """查询 Worker 租约并将过期判断交给租约存储层。"""
        return self.leases.statuses_sync()
