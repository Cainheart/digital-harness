"""Task 2 领域合同包。

本包只提供稳定 ID、状态、实体、命令、事件和错误合同；数据库仓储与事务
编排属于后续 Task 2 实施步骤，不在领域包中实现。
"""

from .commands import CommandEnvelope, CommandResult, canonical_request_hash
from .common import Actor, Page, ProjectStatus, TaskStatus, new_object_id, utc_now
from .entities import (
    Approval,
    Artifact,
    ArtifactRef,
    ArtifactVersion,
    Defect,
    ExecutionAttempt,
    ModelCall,
    Notification,
    Project,
    Review,
    Task,
    TestCase,
    TestRun,
    ToolCall,
    TraceLink,
)
from .errors import (
    ArtifactIntegrityError,
    ArtifactTooLargeError,
    EvidenceIncompleteError,
    IdempotencyKeyReusedError,
    InvalidArgumentError,
    NotFoundError,
    ReadOnlyProjectError,
    Task2DomainError,
    TraceLinkInvalidError,
    VersionConflictError,
)
from .events import AppendResult, DomainEvent, DomainEventDraft, EventStore

__all__ = [
    "Actor",
    "Page",
    "ProjectStatus",
    "TaskStatus",
    "Task2DomainError",
    "InvalidArgumentError",
    "VersionConflictError",
    "IdempotencyKeyReusedError",
    "NotFoundError",
    "ReadOnlyProjectError",
    "ArtifactIntegrityError",
    "ArtifactTooLargeError",
    "TraceLinkInvalidError",
    "EvidenceIncompleteError",
    "Project",
    "Task",
    "Artifact",
    "ArtifactRef",
    "ArtifactVersion",
    "Approval",
    "Review",
    "TestCase",
    "TestRun",
    "Defect",
    "ExecutionAttempt",
    "ModelCall",
    "ToolCall",
    "Notification",
    "TraceLink",
    "DomainEventDraft",
    "DomainEvent",
    "AppendResult",
    "EventStore",
    "CommandEnvelope",
    "CommandResult",
    "canonical_request_hash",
    "new_object_id",
    "utc_now",
]
