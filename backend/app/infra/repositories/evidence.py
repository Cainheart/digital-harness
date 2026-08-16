"""Artifact、审批、Review、测试和缺陷的 SQLAlchemy Core 映射。"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from app.domain.common import Page
from app.domain.entities import (
    Approval,
    Artifact,
    ArtifactRef,
    ArtifactVersion,
    Defect,
    Review,
    TestCase,
    TestRun,
)
from app.domain.errors import NotFoundError
from app.infra.task2_schema import (
    approvals,
    artifact_versions,
    artifacts,
    defects,
    reviews,
    test_cases,
    test_runs,
)

from ._common import (
    ensure_project_writable,
    ensure_project_child,
    json_text,
    json_value,
    model_data,
    page,
    utc_datetime,
)


def _artifact_ref(row: Any) -> ArtifactRef:
    """把冻结 artifact_versions 存储列组装回紧凑 ArtifactRef。"""
    return ArtifactRef(
        artifactId=row.artifact_id,
        sha256=row.sha256,
        mediaType=row.media_type,
        size=row.size_bytes,
        createdAt=utc_datetime(row.created_at),
        relativePath=row.relative_path,
        storeRef=row.store_ref,
    )


def _artifact_version(row: Any) -> ArtifactVersion:
    """把不可覆盖版本行映射为领域版本合同。"""
    return ArtifactVersion(
        id=row.id,
        artifactId=row.artifact_id,
        projectId=row.project_id,
        taskId=row.task_id,
        versionNumber=row.version_number,
        parentVersionId=row.parent_version_id,
        changeReason=row.change_reason,
        contentRef=_artifact_ref(row),
        storeRef=row.store_ref,
        createdAt=utc_datetime(row.created_at),
        createdBy=row.created_by,
    )


def _json_or_text(value: str) -> Any:
    """恢复测试用例中兼容文本或 JSON 数组的冻结字段。"""
    try:
        return json_value(value)
    except (TypeError, ValueError):
        return value


class EvidenceRepository:
    """保存 Artifact 元数据、版本链和其他证据型领域对象，历史记录只追加。"""

    def create_artifact(self, connection: Any, artifact: Artifact) -> None:
        """插入逻辑 Artifact；内容正文只存在 ArtifactStore，表中仅保存元数据。"""
        data = model_data(artifact)
        ensure_project_writable(connection, data["project_id"])
        if data["task_id"] is not None:
            from app.infra.task2_schema import tasks

            ensure_project_child(connection, tasks, data["project_id"], data["task_id"], label="task")
        connection.execute(
            artifacts.insert().values(
                id=data["id"],
                project_id=data["project_id"],
                task_id=data["task_id"],
                name=data["name"],
                artifact_type=data["artifact_type"],
                owner_role=data["owner_role"],
                status=data["status"],
                created_at=data["created_at"],
                created_by=data["created_by"],
            )
        )

    def get_artifact(self, connection: Any, artifact_id: str) -> Artifact:
        """读取 Artifact 元数据，并从最新不可变版本恢复当前内容引用。"""
        row = connection.execute(
            select(artifacts).where(artifacts.c.id == artifact_id)
        ).mappings().first()
        if row is None:
            raise NotFoundError(f"artifact {artifact_id} was not found")
        latest = connection.execute(
            select(artifact_versions)
            .where(artifact_versions.c.artifact_id == artifact_id)
            .order_by(artifact_versions.c.version_number.desc())
            .limit(1)
        ).mappings().first()
        content_ref = _artifact_ref(latest) if latest is not None else None
        return Artifact(
            id=row["id"],
            project_id=row["project_id"],
            task_id=row["task_id"],
            name=row["name"],
            artifact_type=row["artifact_type"],
            owner_role=row["owner_role"],
            status=row["status"],
            created_at=utc_datetime(row["created_at"]),
            created_by=row["created_by"],
            contentRef=content_ref,
        )

    def create_artifact_version(self, connection: Any, version: ArtifactVersion) -> None:
        """追加 ArtifactVersion，校验父版本同项目同 Artifact 且不覆盖旧行。"""
        data = model_data(version)
        ref = ArtifactRef.model_validate(data["content_ref"])
        ensure_project_writable(connection, data["project_id"])
        ensure_project_child(connection, artifacts, data["project_id"], data["artifact_id"], label="artifact")
        if ref.artifact_id != data["artifact_id"]:
            raise ValueError("artifact reference does not match artifact version")
        if not ref.relative_path.startswith(f"{data['project_id']}/sha256/"):
            raise ValueError("artifact reference is outside project content namespace")
        if data["task_id"] is not None:
            from app.infra.task2_schema import tasks

            ensure_project_child(connection, tasks, data["project_id"], data["task_id"], label="task")
        if data["parent_version_id"] is not None:
            parent = connection.execute(
                select(artifact_versions).where(artifact_versions.c.id == data["parent_version_id"])
            ).mappings().first()
            if (
                parent is None
                or parent["project_id"] != data["project_id"]
                or parent["artifact_id"] != data["artifact_id"]
                or parent["version_number"] >= data["version"]
            ):
                raise NotFoundError("parent artifact version was not found in the same chain")
        connection.execute(
            artifact_versions.insert().values(
                id=data["id"],
                artifact_id=data["artifact_id"],
                project_id=data["project_id"],
                task_id=data["task_id"],
                version_number=data["version"],
                parent_version_id=data["parent_version_id"],
                change_reason=data["change_reason"],
                store_ref=data["store_ref"] or ref.store_ref or ref.relative_path,
                sha256=ref.sha256,
                media_type=ref.media_type,
                size_bytes=ref.size,
                relative_path=ref.relative_path,
                created_at=data["created_at"],
                created_by=data["created_by"],
            )
        )

    def get_artifact_version(self, connection: Any, version_id: str) -> ArtifactVersion:
        """读取单个不可变 ArtifactVersion，不把正文加载进业务对象。"""
        row = connection.execute(
            select(artifact_versions).where(artifact_versions.c.id == version_id)
        ).mappings().first()
        if row is None:
            raise NotFoundError(f"artifact version {version_id} was not found")
        return _artifact_version(row)

    def list_artifact_versions(
        self, connection: Any, artifact_id: str, limit: int = 50
    ) -> Page[ArtifactVersion]:
        """按版本号倒序分页读取完整版本链。"""
        if limit <= 0:
            raise ValueError("limit must be positive")
        rows = connection.execute(
            select(artifact_versions)
            .where(artifact_versions.c.artifact_id == artifact_id)
            .order_by(artifact_versions.c.version_number.desc())
            .limit(limit + 1)
        ).mappings().all()
        values = [_artifact_version(row) for row in rows]
        return page(values, limit=limit, cursor=values[-1].id if len(values) > limit else None)

    def create_approval(self, connection: Any, approval: Approval) -> None:
        """插入审批事实并校验项目、任务和证据版本引用。"""
        data = model_data(approval)
        ensure_project_writable(connection, data["project_id"])
        self._ensure_optional_task(connection, data["project_id"], data["task_id"])
        self._ensure_optional_version(connection, data["project_id"], data["artifact_version_id"])
        self._ensure_optional_version(connection, data["project_id"], data["evidence_version_id"])
        self._ensure_optional_task(connection, data["project_id"], data["response_task_id"])
        connection.execute(approvals.insert().values(**data))

    def create_review(self, connection: Any, review: Review) -> None:
        """插入 Review 事实并校验交付物、证据和返工任务引用。"""
        data = model_data(review)
        ensure_project_writable(connection, data["project_id"])
        self._ensure_optional_task(connection, data["project_id"], data["task_id"])
        self._ensure_version(connection, data["project_id"], data["artifact_version_id"])
        self._ensure_optional_version(connection, data["project_id"], data["evidence_version_id"])
        self._ensure_optional_task(connection, data["project_id"], data["rework_task_id"])
        connection.execute(reviews.insert().values(**data))

    def create_test_case(self, connection: Any, test_case: TestCase) -> None:
        """插入验收用例，并把标准/步骤作为小型 JSON 或文本事实保存。"""
        data = model_data(test_case)
        ensure_project_writable(connection, data["project_id"])
        self._ensure_optional_task(connection, data["project_id"], data["task_id"])
        connection.execute(
            test_cases.insert().values(
                id=data["id"], project_id=data["project_id"], task_id=data["task_id"],
                acceptance_criteria_json=json_text(data["acceptance_criteria"]),
                preconditions=json_text(data["preconditions"]) if isinstance(data["preconditions"], tuple) else data["preconditions"],
                steps=json_text(data["steps"]) if isinstance(data["steps"], tuple) else data["steps"],
                expected_result=data["expected_result"], test_type=data["test_type"],
                owner_role=data["owner_role"], created_at=data["created_at"], version=data["version"],
            )
        )

    def create_test_run(self, connection: Any, test_run: TestRun) -> None:
        """插入测试运行，并把证据引用压缩到冻结单列 evidence_version_id。"""
        data = model_data(test_run)
        ensure_project_writable(connection, data["project_id"])
        self._ensure_optional_task(connection, data["project_id"], data["task_id"])
        ensure_project_child(connection, test_cases, data["project_id"], data["test_case_id"], label="test case")
        self._ensure_optional_version(connection, data["project_id"], data["baseline_version_id"])
        evidence_ref = (
            ArtifactRef.model_validate(data["evidence"][0])
            if data["evidence"] else None
        )
        evidence_id = self._version_id_for_ref(connection, data["project_id"], evidence_ref)
        self._ensure_optional_version(connection, data["project_id"], evidence_id)
        connection.execute(
            test_runs.insert().values(
                id=data["id"], project_id=data["project_id"], task_id=data["task_id"],
                test_case_id=data["test_case_id"], baseline_version_id=data["baseline_version_id"],
                command_or_steps=data["command_or_steps"], environment_json=json_text(data["environment"]),
                started_at=data["started_at"], ended_at=data["ended_at"], actual_result=data["actual_result"],
                exit_code=data["exit_code"], status=data["status"], evidence_version_id=evidence_id,
                trace_id=data["trace_id"],
            )
        )

    def create_defect(self, connection: Any, defect: Defect) -> None:
        """插入缺陷事实，并校验来源测试、证据、修复版本和回归测试。"""
        data = model_data(defect)
        ensure_project_writable(connection, data["project_id"])
        self._ensure_optional_task(connection, data["project_id"], data["task_id"])
        ensure_project_child(connection, test_runs, data["project_id"], data["source_test_run_id"], label="test run")
        evidence_ref = (
            ArtifactRef.model_validate(data["evidence"][0])
            if data["evidence"] else None
        )
        evidence_id = self._version_id_for_ref(connection, data["project_id"], evidence_ref)
        self._ensure_optional_version(connection, data["project_id"], evidence_id)
        self._ensure_optional_version(connection, data["project_id"], data["fixed_version_id"])
        self._ensure_optional_test_run(connection, data["project_id"], data["regression_test_run_id"])
        connection.execute(
            defects.insert().values(
                id=data["id"], project_id=data["project_id"], task_id=data["task_id"],
                source_test_run_id=data["source_test_run_id"], reproduction=data["reproduction"],
                severity=data["severity"], actual_result=data["actual_result"], expected_result=data["expected_result"],
                evidence_version_id=evidence_id, npi_owner_role=data["npi_owner_role"], status=data["status"],
                fixed_version_id=data["fixed_version_id"], regression_test_run_id=data["regression_test_run_id"],
                created_at=data["created_at"], resolved_at=data["resolved_at"], version=data["version"],
            )
        )

    def get_test_run(self, connection: Any, test_run_id: str) -> TestRun:
        """读取测试运行及其单个冻结证据引用。"""
        row = connection.execute(select(test_runs).where(test_runs.c.id == test_run_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"test run {test_run_id} was not found")
        evidence = self._version_ref(connection, row["evidence_version_id"])
        return TestRun(
            id=row["id"], project_id=row["project_id"], task_id=row["task_id"],
            test_case_id=row["test_case_id"], baseline_version_id=row["baseline_version_id"],
            command_or_steps=row["command_or_steps"], environment=json_value(row["environment_json"]),
            started_at=utc_datetime(row["started_at"]), ended_at=utc_datetime(row["ended_at"]),
            actual_result=row["actual_result"], exit_code=row["exit_code"], status=row["status"],
            evidence=(evidence,) if evidence else (), trace_id=row["trace_id"], version=1,
        )

    def get_defect(self, connection: Any, defect_id: str) -> Defect:
        """读取缺陷及其测试/证据/修复/回归关联。"""
        row = connection.execute(select(defects).where(defects.c.id == defect_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"defect {defect_id} was not found")
        evidence = self._version_ref(connection, row["evidence_version_id"])
        return Defect(
            id=row["id"], project_id=row["project_id"], task_id=row["task_id"],
            source_test_run_id=row["source_test_run_id"], reproduction=row["reproduction"],
            severity=row["severity"], actual_result=row["actual_result"], expected_result=row["expected_result"],
            evidence=(evidence,) if evidence else (), npi_owner_role=row["npi_owner_role"], status=row["status"],
            fixed_version_id=row["fixed_version_id"], regression_test_run_id=row["regression_test_run_id"],
            created_at=utc_datetime(row["created_at"]), resolved_at=utc_datetime(row["resolved_at"]),
            version=row["version"],
        )

    def get_approval(self, connection: Any, approval_id: str) -> Approval:
        """读取审批及其项目内对象引用。"""
        row = connection.execute(select(approvals).where(approvals.c.id == approval_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"approval {approval_id} was not found")
        return Approval(**dict(row))

    def get_review(self, connection: Any, review_id: str) -> Review:
        """读取 Review 决定、意见和返工关联。"""
        row = connection.execute(select(reviews).where(reviews.c.id == review_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"review {review_id} was not found")
        return Review(**dict(row))

    def get_test_case(self, connection: Any, test_case_id: str) -> TestCase:
        """读取验收标准、前置条件、步骤和测试责任人。"""
        row = connection.execute(select(test_cases).where(test_cases.c.id == test_case_id)).mappings().first()
        if row is None:
            raise NotFoundError(f"test case {test_case_id} was not found")
        return TestCase(
            id=row["id"], project_id=row["project_id"], task_id=row["task_id"],
            acceptance_criteria=tuple(json_value(row["acceptance_criteria_json"])),
            preconditions=_json_or_text(row["preconditions"]),
            steps=_json_or_text(row["steps"]),
            expected_result=row["expected_result"], test_type=row["test_type"],
            owner_role=row["owner_role"], created_at=utc_datetime(row["created_at"]),
            version=row["version"],
        )

    def _ensure_version(self, connection: Any, project_id: str, version_id: str) -> None:
        ensure_project_child(connection, artifact_versions, project_id, version_id, label="artifact version")

    def _ensure_optional_version(self, connection: Any, project_id: str, version_id: str | None) -> None:
        if version_id is not None:
            self._ensure_version(connection, project_id, version_id)

    def _ensure_optional_task(self, connection: Any, project_id: str, task_id: str | None) -> None:
        if task_id is not None:
            from app.infra.task2_schema import tasks

            ensure_project_child(connection, tasks, project_id, task_id, label="task")

    def _ensure_optional_test_run(self, connection: Any, project_id: str, test_run_id: str | None) -> None:
        if test_run_id is not None:
            ensure_project_child(connection, test_runs, project_id, test_run_id, label="test run")

    def _version_ref(self, connection: Any, version_id: str | None) -> ArtifactRef | None:
        if version_id is None:
            return None
        row = connection.execute(select(artifact_versions).where(artifact_versions.c.id == version_id)).mappings().first()
        return _artifact_ref(row) if row is not None else None

    def _version_id_for_ref(
        self, connection: Any, project_id: str, reference: ArtifactRef | None
    ) -> str | None:
        """把证据紧凑引用解析到冻结 artifact_versions 主键。"""
        if reference is None:
            return None
        row = connection.execute(
            select(artifact_versions.c.id)
            .where(
                artifact_versions.c.project_id == project_id,
                artifact_versions.c.sha256 == reference.sha256,
                artifact_versions.c.relative_path == reference.relative_path,
            )
            .order_by(artifact_versions.c.version_number.desc())
            .limit(1)
        ).first()
        if row is None:
            raise NotFoundError("evidence artifact reference was not found")
        return row.id
