"""历史项目删除边界、在线内容清理和最小删除审计。"""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select

from app.domain.common import ProjectStatus, utc_now
from app.domain.errors import NotFoundError, ReadOnlyProjectError
from app.infra.artifacts import ArtifactDeleteReport, FileArtifactStore
from app.infra.task2_schema import (
    approvals,
    artifact_versions,
    artifacts,
    defects,
    domain_events,
    execution_attempts,
    idempotency_records,
    model_calls,
    notifications,
    outbox_messages,
    project_deletion_audits,
    projects,
    reviews,
    task_dependencies,
    tasks,
    test_cases,
    test_runs,
    tool_calls,
    trace_links,
)
from ._common import utc_datetime


class ProjectDeletionRepository:
    """按生命周期删除在线历史项目，并只保留三字段最小审计。"""

    def __init__(self, database: Any, artifact_store: FileArtifactStore) -> None:
        """绑定数据库和在线 ArtifactStore，备份目录永远不作为删除目标。"""
        self.database = database
        self.artifact_store = artifact_store

    def delete_historical_project(self, project_id: str, actor_id: str) -> ArtifactDeleteReport:
        """只删除已结项/已终止且只读项目，并在同一事务保留最小审计。"""
        if not project_id or not actor_id:
            raise ValueError("project_id and actor_id are required")
        with self.database.transaction() as connection:
            project = connection.execute(
                select(projects.c.status, projects.c.read_only).where(projects.c.id == project_id)
            ).first()
            if project is None:
                raise NotFoundError(f"project {project_id} was not found")
            if project.status not in {ProjectStatus.COMPLETED.value, ProjectStatus.TERMINATED.value} or not project.read_only:
                raise ReadOnlyProjectError(
                    "only completed or terminated read-only projects may be deleted"
                )
            with self.database.controlled_project_purge(connection, project_id):
                self._delete_project_rows(connection, project_id)
            connection.execute(
                project_deletion_audits.insert().values(
                    project_id=project_id, deleted_at=utc_now(), actor_id=actor_id
                )
            )
        # 修改说明：T2-AC-10 要求业务元数据提交后才清理文件；失败路径必须返回而非伪造成功。
        return self.artifact_store.delete_for_project_sync(project_id)

    def project_exists(self, project_id: str) -> bool:
        """只读查询项目是否仍存在于在线业务库。"""
        with self.database.read_connection() as connection:
            return connection.execute(
                select(projects.c.id).where(projects.c.id == project_id)
            ).first() is not None

    def deletion_audit(self, project_id: str) -> dict[str, Any]:
        """读取 project_id/deleted_at/actor_id 三字段最小审计视图。"""
        with self.database.read_connection() as connection:
            row = connection.execute(
                select(
                    project_deletion_audits.c.project_id,
                    project_deletion_audits.c.deleted_at,
                    project_deletion_audits.c.actor_id,
                )
                .where(project_deletion_audits.c.project_id == project_id)
                .order_by(project_deletion_audits.c.id.desc())
                .limit(1)
            ).mappings().first()
        if row is None:
            raise NotFoundError(f"deletion audit for {project_id} was not found")
        return {
            "project_id": row["project_id"],
            "deleted_at": utc_datetime(row["deleted_at"]),
            "actor_id": row["actor_id"],
        }

    @staticmethod
    def _delete_project_rows(connection: Any, project_id: str) -> None:
        """按子表到父表的逆依赖顺序删除在线事实，不触碰删除审计。"""
        for table in (
            trace_links,
            notifications,
            outbox_messages,
            idempotency_records,
            model_calls,
            tool_calls,
            defects,
            test_runs,
            reviews,
            approvals,
            domain_events,
            execution_attempts,
            test_cases,
            artifact_versions,
            artifacts,
            task_dependencies,
            tasks,
        ):
            connection.execute(delete(table).where(table.c.project_id == project_id))
        connection.execute(delete(projects).where(projects.c.id == project_id))
