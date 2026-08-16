from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable
from pathlib import Path

from app.config.settings import Settings
from app.infra.artifacts import FileArtifactStore
from app.infra.database import Database
from app.infra.persistence_root import PersistenceRoot
from app.lifecycle.service import ApplicationLifecycle
from app.lifecycle.worker_lease import WorkerLeaseStore
from app.observability.trace import TraceContext


@dataclass
class ApplicationRuntime:
    """汇总后续业务任务消费的基础运行时组件。"""
    settings: Settings
    database: Database
    lifecycle: ApplicationLifecycle
    leases: WorkerLeaseStore
    artifact_store: FileArtifactStore
    trace_context_factory: Callable[[], TraceContext]


def build_runtime(persistent_root: Path, *, test_mode: bool = False) -> ApplicationRuntime:
    """初始化持久化根目录并构造数据库、生命周期和证据存储组件。"""
    settings = Settings(persistent_root=persistent_root)
    root = PersistenceRoot(
        settings.persistent_root,
        app_version=settings.app_version,
        schema_revision=settings.current_schema_revision,
    )
    database = Database(
        settings.database_path,
        persistent_root=settings.persistent_root,
        app_version=settings.app_version,
        schema_revision=settings.current_schema_revision,
    )
    # 修改说明：Task 2 迁移前必须先检查真实 revision；只有新库/成功升级才更新 manifest。
    root.initialize_database(database)
    leases = WorkerLeaseStore(database)
    lifecycle = ApplicationLifecycle(database, leases)
    return ApplicationRuntime(
        settings,
        database,
        lifecycle,
        leases,
        FileArtifactStore(settings.artifact_path),
        TraceContext.new,
    )
