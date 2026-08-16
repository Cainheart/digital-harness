"""Task 2 核心领域实体的 Pydantic v2 合同。

实体只描述当前事实和证据引用，不负责工作流状态流转、仓储写入或外部调用。
所有模型拒绝额外字段；时间、版本、大小、哈希、相对路径和摘要在边界处验证。
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import PurePosixPath
import re
from typing import Annotated, Any, ClassVar, Literal, Optional, Union

from pydantic import (
    AfterValidator,
    AliasChoices,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from .common import Actor, ProjectStatus, TaskStatus


def _non_empty(value: str) -> str:
    """验证领域标识和短文本不是空白字符串。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("value must be non-empty")
    return value


def _aware_datetime(value: datetime) -> datetime:
    """要求领域时间带明确时区，避免本地时间在事件链中产生歧义。"""
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("datetime must be timezone-aware")
    return value.astimezone(timezone.utc)


def _json_object(value: dict[str, object]) -> dict[str, object]:
    """要求结构化字段可用标准 JSON 编码，禁止 set、bytes 等隐式内容。"""
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise ValueError("value must be JSON serializable") from error
    return value


_SENSITIVE_INLINE_PATTERN = re.compile(
    r"(?:api[_ -]?key|authorization|bearer|cookie|secret|password|system\s+prompt|prompt|access[_ -]?token|refresh[_ -]?token|tokens?)\s*[:=]|\bbearer\s+\S+|\bsk-[A-Za-z0-9][A-Za-z0-9_-]*",
    re.IGNORECASE,
)


def _safe_summary(value: str) -> str:
    """拒绝摘要中的凭据或提示词原文，而不是静默保存或吞掉非法输入。"""
    if _SENSITIVE_INLINE_PATTERN.search(value):
        raise ValueError("summary contains a credential or prompt value")
    return value


def _safe_data(value: Any, *, key: str | None = None) -> Any:
    """递归检查小型结构化摘要，阻止敏感字段进入事件或命令事实。"""
    if key and re.search(
        r"api[_ -]?key|authorization|bearer|cookie|secret|password|prompt|access[_ -]?token|refresh[_ -]?token|tokens?",
        key,
        re.IGNORECASE,
    ):
        raise ValueError("sensitive fields are not allowed in domain summaries")
    if isinstance(value, str):
        return _safe_summary(value)
    if isinstance(value, dict):
        return {str(item_key): _safe_data(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_safe_data(item) for item in value)
    return value


class FrozenDict(dict[str, Any]):
    """提供可 JSON 序列化且禁止常规原位修改的递归值容器。"""

    __slots__ = ()

    @staticmethod
    def _immutable(*args: Any, **kwargs: Any) -> None:
        raise TypeError("frozen mapping is immutable")

    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = _immutable
    __ior__ = _immutable


def _freeze_json_value(value: Any) -> Any:
    """递归冻结 JSON 对象；字典保持 JSON 兼容，数组变为 tuple。"""
    if isinstance(value, dict):
        return FrozenDict(
            {str(key): _freeze_json_value(item) for key, item in value.items()}
        )
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_json_value(item) for item in value)
    return value


def _coerce_actor(value: object) -> Actor:
    """把命令/事件 JSON 中的 actor 对象转换为冻结 Actor 值对象。"""
    if isinstance(value, Actor):
        return value
    if isinstance(value, dict):
        return Actor(**value)
    raise ValueError("actor must be an Actor or an object with type and id")


def _project_status(value: object) -> ProjectStatus:
    """把 API JSON 的冻结中文值解析为 ProjectStatus 枚举。"""
    if isinstance(value, ProjectStatus):
        return value
    try:
        return ProjectStatus(value)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid project status") from error


def _task_status(value: object) -> TaskStatus:
    """把 API JSON 的冻结中文值解析为 TaskStatus 枚举。"""
    if isinstance(value, TaskStatus):
        return value
    try:
        return TaskStatus(value)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid task status") from error


def _sha256(value: str) -> str:
    """验证 Artifact 内容寻址摘要为 64 位小写十六进制字符串。"""
    if re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("sha256 must be 64 lowercase hexadecimal characters")
    return value


def _relative_path(value: str) -> str:
    """仅接受项目 Artifact Store 内的 POSIX 相对路径。"""
    if not value or "\x00" in value or "\\" in value or value.startswith(("/", "~")):
        raise ValueError("relative_path must be a safe relative POSIX path")
    raw_segments = value.split("/")
    if any(segment in {"", ".", ".."} for segment in raw_segments):
        raise ValueError("relative_path must not contain empty, dot, or parent segments")
    path = PurePosixPath(value)
    if value == "." or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("relative_path must not contain empty, dot, or parent segments")
    return value


def _tupleize(value: object) -> object:
    """将 JSON 数组固定为不可变 tuple，避免领域集合被调用方原位修改。"""
    return tuple(value) if isinstance(value, list) else value


NonEmptyStr = Annotated[str, AfterValidator(_non_empty)]
AwareDateTime = Annotated[datetime, AfterValidator(_aware_datetime)]
JsonObject = Annotated[dict[str, Any], AfterValidator(_json_object)]
SafeSummary = Annotated[str, AfterValidator(_safe_summary)]
ActorValue = Annotated[Actor, BeforeValidator(_coerce_actor)]
Sha256 = Annotated[str, AfterValidator(_sha256)]
RelativePath = Annotated[str, AfterValidator(_relative_path)]
Version = Annotated[int, Field(ge=1)]
NonNegativeInt = Annotated[int, Field(ge=0)]
NonEmptyTuple = Annotated[tuple[NonEmptyStr, ...], BeforeValidator(_tupleize)]
Priority = Literal["P0", "P1", "P2", "P3"]
ProjectStatusValue = Annotated[ProjectStatus, BeforeValidator(_project_status)]
TaskStatusValue = Annotated[TaskStatus, BeforeValidator(_task_status)]


class DomainModel(BaseModel):
    """所有领域实体共享的严格 Pydantic v2 配置。"""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        strict=True,
        validate_assignment=True,
        validate_default=True,
    )


class Project(DomainModel):
    """保存项目目标、约束、阶段、主状态、生命周期时间和版本。"""

    id: NonEmptyStr
    name: NonEmptyStr
    business_goal: NonEmptyStr
    target_users: NonEmptyStr
    priority: Priority
    deadline: Optional[AwareDateTime] = None
    constraints: JsonObject
    stage: NonEmptyStr
    status: ProjectStatusValue
    created_at: AwareDateTime
    ended_at: Optional[AwareDateTime] = None
    version: Version = 1
    read_only: bool = False


class Task(DomainModel):
    """保存项目范围内任务的负责人、依赖、交付物预期、状态和版本。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    title: NonEmptyStr
    owner_role: NonEmptyStr
    specialist_tag: NonEmptyStr
    assignment_reason: NonEmptyStr
    priority: Priority
    dependencies: NonEmptyTuple
    expected_deliverables: NonEmptyTuple
    status: TaskStatusValue
    created_at: AwareDateTime
    started_at: Optional[AwareDateTime] = None
    ended_at: Optional[AwareDateTime] = None
    version: Version


class ArtifactRef(DomainModel):
    """指向 Artifact Store 内容的完整性引用，不承载文件正文。"""

    artifact_id: NonEmptyStr = Field(alias="artifactId")
    sha256: Sha256
    media_type: NonEmptyStr = Field(alias="mediaType")
    size: NonNegativeInt = Field(
        validation_alias=AliasChoices("size", "sizeBytes", "size_bytes")
    )
    created_at: AwareDateTime = Field(alias="createdAt")
    relative_path: RelativePath = Field(alias="relativePath")
    store_ref: Optional[NonEmptyStr] = Field(default=None, alias="storeRef")


class Artifact(DomainModel):
    """保存交付物逻辑对象及其项目、任务、责任人和当前可见状态。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    name: NonEmptyStr
    artifact_type: NonEmptyStr
    owner_role: NonEmptyStr
    status: NonEmptyStr
    created_at: AwareDateTime
    created_by: NonEmptyStr
    content_ref: Optional[ArtifactRef] = Field(default=None, alias="contentRef")
    upstream_links: NonEmptyTuple = ()
    downstream_links: NonEmptyTuple = ()
    version: Version = 1


class ArtifactVersion(DomainModel):
    """保存不可覆盖的交付物版本、父版本和内容寻址元数据。"""

    id: NonEmptyStr
    artifact_id: NonEmptyStr = Field(
        alias="artifactId", serialization_alias="artifactId"
    )
    project_id: NonEmptyStr = Field(
        alias="projectId", serialization_alias="projectId"
    )
    task_id: Optional[NonEmptyStr] = Field(
        default=None, alias="taskId", serialization_alias="taskId"
    )
    version: Version = Field(
        alias="versionNumber",
        validation_alias=AliasChoices("version", "versionNumber", "version_number"),
        serialization_alias="versionNumber",
    )
    content_ref: ArtifactRef = Field(
        alias="contentRef", serialization_alias="contentRef"
    )
    # 这些只读属性把领域的紧凑引用映射到现有 SQL Schema 字段，避免仓储重复解析。
    parent_version_id: Optional[NonEmptyStr] = Field(
        default=None, alias="parentVersionId", serialization_alias="parentVersionId"
    )
    change_reason: NonEmptyStr = Field(
        alias="changeReason", serialization_alias="changeReason"
    )
    store_ref: Optional[NonEmptyStr] = Field(
        default=None, alias="storeRef", serialization_alias="storeRef"
    )
    created_at: AwareDateTime = Field(
        alias="createdAt", serialization_alias="createdAt"
    )
    created_by: NonEmptyStr = Field(
        alias="createdBy", serialization_alias="createdBy"
    )

    @property
    def version_number(self) -> int:
        """返回与数据库列同名的版本号视图。"""
        return self.version

    @property
    def sha256(self) -> str:
        """返回内容引用的 SHA-256。"""
        return self.content_ref.sha256

    @property
    def media_type(self) -> str:
        """返回内容引用的 MIME 类型。"""
        return self.content_ref.media_type

    @property
    def size_bytes(self) -> int:
        """返回内容引用的非负大小。"""
        return self.content_ref.size

    @property
    def relative_path(self) -> str:
        """返回 Artifact Store 的项目相对路径。"""
        return self.content_ref.relative_path

    @model_validator(mode="before")
    @classmethod
    def normalize_storage_fields(cls, value: object) -> object:
        """兼容已冻结 SQL 列命名，并统一成领域的 version/content_ref 合同。"""
        if not isinstance(value, dict):
            return value
        values = dict(value)

        def promote(canonical: str, *aliases: str) -> None:
            """选择 canonical 值并移除其余历史输入名称。"""
            if canonical not in values:
                for alias in aliases:
                    if alias in values:
                        values[canonical] = values[alias]
                        break
            for alias in aliases:
                values.pop(alias, None)

        promote("artifact_id", "artifactId")
        promote("project_id", "projectId")
        promote("task_id", "taskId")
        promote("content_ref", "contentRef")
        promote("version", "version_number", "versionNumber")
        promote("parent_version_id", "parentVersionId")
        promote("change_reason", "changeReason")
        promote("created_by", "createdBy")
        promote("store_ref", "storeRef")
        promote("media_type", "mediaType")
        promote("size_bytes", "sizeBytes", "size")
        promote("relative_path", "relativePath")
        promote("created_at", "createdAt")
        legacy_ref_fields = {"sha256", "media_type", "size_bytes", "relative_path"}
        if "content_ref" not in values and legacy_ref_fields.issubset(values):
            values["content_ref"] = ArtifactRef(
                artifact_id=values["artifact_id"],
                sha256=values.pop("sha256"),
                media_type=values.pop("media_type"),
                size=values.pop("size_bytes"),
                created_at=values.get("created_at"),
                relative_path=values.pop("relative_path"),
            )
        return values

    @model_validator(mode="after")
    def materialize_store_reference(self) -> "ArtifactVersion":
        """在紧凑 ArtifactRef 与冻结 Schema 字段之间保持可读的 store_ref。"""
        if self.store_ref is None:
            self.store_ref = self.content_ref.store_ref or self.content_ref.relative_path
        return self


class Approval(DomainModel):
    """保存 Boss 审批对象、证据、决定、方向意见和响应任务。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    approval_type: NonEmptyStr
    subject_type: NonEmptyStr
    subject_id: NonEmptyStr
    artifact_version_id: Optional[NonEmptyStr] = None
    evidence_version_id: Optional[NonEmptyStr] = None
    decision: Optional[NonEmptyStr] = None
    direction: Optional[NonEmptyStr] = None
    boss_id: NonEmptyStr
    status: NonEmptyStr
    response_task_id: Optional[NonEmptyStr] = None
    created_at: AwareDateTime
    decided_at: Optional[AwareDateTime] = None
    version: Version


class Review(DomainModel):
    """保存交付物版本的 Review 决定、意见、证据和返工关联。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    artifact_version_id: NonEmptyStr
    reviewer_role: NonEmptyStr
    reviewer_id: NonEmptyStr
    decision: NonEmptyStr
    comments: NonEmptyStr
    evidence_version_id: Optional[NonEmptyStr] = None
    rework_task_id: Optional[NonEmptyStr] = None
    created_at: AwareDateTime
    decided_at: Optional[AwareDateTime] = None
    version: Version


class TestCase(DomainModel):
    """保存验收标准关联、前置条件、步骤、预期和测试责任人。"""

    __test__: ClassVar[bool] = False

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    acceptance_criteria: NonEmptyTuple
    preconditions: Union[NonEmptyStr, tuple[NonEmptyStr, ...]]
    steps: Union[NonEmptyStr, tuple[NonEmptyStr, ...]]
    expected_result: NonEmptyStr
    test_type: NonEmptyStr
    owner_role: NonEmptyStr
    created_at: AwareDateTime
    version: Version


class TestRun(DomainModel):
    """保存一次测试执行的基线、环境、结果、退出码、证据和 trace。"""

    __test__: ClassVar[bool] = False

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    test_case_id: NonEmptyStr
    baseline_version_id: Optional[NonEmptyStr] = None
    command_or_steps: NonEmptyStr
    environment: JsonObject
    started_at: AwareDateTime
    ended_at: Optional[AwareDateTime] = None
    actual_result: NonEmptyStr
    exit_code: Optional[NonNegativeInt] = None
    status: NonEmptyStr
    evidence: Annotated[tuple[ArtifactRef, ...], BeforeValidator(_tupleize)] = ()
    trace_id: NonEmptyStr
    version: Version = 1


class Defect(DomainModel):
    """保存测试来源、复现信息、严重级别、NPI 责任和回归结果关联。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    source_test_run_id: NonEmptyStr
    reproduction: NonEmptyStr
    severity: NonEmptyStr
    actual_result: NonEmptyStr
    expected_result: NonEmptyStr
    evidence: Annotated[tuple[ArtifactRef, ...], BeforeValidator(_tupleize)] = ()
    npi_owner_role: NonEmptyStr
    status: NonEmptyStr
    fixed_version_id: Optional[NonEmptyStr] = None
    regression_test_run_id: Optional[NonEmptyStr] = None
    created_at: AwareDateTime
    resolved_at: Optional[AwareDateTime] = None
    version: Version


class ExecutionAttempt(DomainModel):
    """保存一次任务执行尝试的租约、模型配置、重试关系和链路。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: NonEmptyStr
    role: NonEmptyStr
    model_config_version: NonEmptyStr
    workspace_ref: Optional[NonEmptyStr] = None
    worker_lease_id: Optional[NonEmptyStr] = None
    status: NonEmptyStr
    started_at: AwareDateTime
    ended_at: Optional[AwareDateTime] = None
    retry_of_attempt_id: Optional[NonEmptyStr] = None
    retry_count: NonNegativeInt
    trace_id: NonEmptyStr
    version: Version


class ModelCall(DomainModel):
    """保存模型调用的脱敏摘要、Token、成本、错误和 trace，不保存凭据/提示词。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    execution_attempt_id: NonEmptyStr
    role: NonEmptyStr
    provider: NonEmptyStr
    model: NonEmptyStr
    started_at: AwareDateTime
    ended_at: Optional[AwareDateTime] = None
    duration_ms: Optional[NonNegativeInt] = None
    summary: SafeSummary
    error_code: Optional[NonEmptyStr] = None
    input_tokens: Optional[NonNegativeInt] = None
    output_tokens: Optional[NonNegativeInt] = None
    cost_micros: Optional[NonNegativeInt] = None
    trace_id: NonEmptyStr
    version: Version = 1


class ToolCall(DomainModel):
    """保存工具调用的脱敏摘要、耗时、错误和 trace，不保存命令凭据或提示词。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    task_id: Optional[NonEmptyStr] = None
    execution_attempt_id: NonEmptyStr
    role: NonEmptyStr
    tool_name: NonEmptyStr
    started_at: AwareDateTime
    ended_at: Optional[AwareDateTime] = None
    duration_ms: Optional[NonNegativeInt] = None
    summary: SafeSummary
    error_code: Optional[NonEmptyStr] = None
    trace_id: NonEmptyStr
    version: Version = 1


class Notification(DomainModel):
    """保存事件通知的对象、等级、未读/待处理状态和处理时间线。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    event_id: NonEmptyStr
    notification_type: NonEmptyStr
    severity: NonEmptyStr
    subject_type: NonEmptyStr
    subject_id: NonEmptyStr
    unread: bool = True
    pending: bool = True
    handled_by: Optional[NonEmptyStr] = None
    action: Optional[NonEmptyStr] = None
    created_at: AwareDateTime
    read_at: Optional[AwareDateTime] = None
    handled_at: Optional[AwareDateTime] = None
    version: Version = 1


_TRACE_NODE_TYPES = {
    "requirement",
    "acceptance_criterion",
    "evidence",
    "project",
    "task",
    "artifact",
    "artifact_version",
    "approval",
    "review",
    "test_case",
    "test_run",
    "defect",
    "execution_attempt",
    "model_call",
    "tool_call",
    "notification",
    "domain_event",
}


class TraceLink(DomainModel):
    """保存跨对象双向追踪关系及其项目和 trace 范围。"""

    id: NonEmptyStr
    project_id: NonEmptyStr
    source_type: NonEmptyStr
    source_id: NonEmptyStr
    target_type: NonEmptyStr
    target_id: NonEmptyStr
    relation: NonEmptyStr
    trace_id: NonEmptyStr
    created_at: AwareDateTime
    version: Version = 1

    @field_validator("source_type", "target_type")
    @classmethod
    def validate_node_type(cls, value: str) -> str:
        """保留 Schema 冻结的多态节点类型，拒绝无法追踪的类型。"""
        if value not in _TRACE_NODE_TYPES:
            raise ValueError("TraceLink endpoint type is unsupported")
        return value


def __getattr__(name: str) -> Any:
    """延迟暴露 DomainEvent，避免实体模块与事件模块发生导入环。"""
    if name == "DomainEvent":
        from .events import DomainEvent

        return DomainEvent
    raise AttributeError(name)


__all__ = [
    "Approval",
    "Artifact",
    "ArtifactRef",
    "ArtifactVersion",
    "Defect",
    "DomainEvent",
    "DomainModel",
    "ExecutionAttempt",
    "ModelCall",
    "Notification",
    "Project",
    "Review",
    "Task",
    "TestCase",
    "TestRun",
    "ToolCall",
    "TraceLink",
]
