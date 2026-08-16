"""Task 2 领域事件只追加合同和 EventStore 协议。

本模块不实现数据库写入；它只保证事件载荷可序列化、事件事实不可变，并为
后续仓储提供带 expected_version 的异步接口边界。
"""

from __future__ import annotations

from typing import Any, Literal, Optional, Protocol, Sequence, Union, runtime_checkable

from pydantic import AliasChoices, ConfigDict, Field, field_validator, model_validator

from .common import Actor, utc_now
from .entities import AwareDateTime, ActorValue, DomainModel, JsonObject, NonEmptyStr, NonNegativeInt, SafeSummary, Version


SummaryValue = Union[JsonObject, SafeSummary]
EventCategory = Literal["ordinary", "call", "security"]
_REGISTERED_CONTEXT_EVENT_TYPES = frozenset(
    {
        "InvocationStarted",
        "InvocationCompleted",
        "InvocationFinished",
        "InvocationFailed",
        "InvocationRejected",
        "InvocationSecurity",
        "InvocationPolicy",
        "InvocationSecurityBlocked",
        "InvocationPolicyBlocked",
        "ProviderInvocationStarted",
        "ProviderInvocationCompleted",
        "ProviderInvocationFinished",
        "ProviderInvocationFailed",
        "ProviderInvocationRejected",
        "ProviderInvocationSecurity",
        "ProviderInvocationPolicy",
        "ProviderInvocationSecurityBlocked",
        "ProviderInvocationPolicyBlocked",
        "ModelCallStarted",
        "ModelCallCompleted",
        "ModelCallFinished",
        "ModelCallFailed",
        "ModelCallRejected",
        "ModelCallSecurity",
        "ModelCallPolicy",
        "ModelCallSecurityBlocked",
        "ModelCallPolicyBlocked",
        "ToolCallStarted",
        "ToolCallCompleted",
        "ToolCallFinished",
        "ToolCallFailed",
        "ToolCallRejected",
        "ToolCallSecurity",
        "ToolCallPolicy",
        "ToolCallSecurityBlocked",
        "ToolCallPolicyBlocked",
    }
)
_REGISTERED_CONTEXT_EVENT_TYPES_CASEFOLDED = frozenset(
    event_type.casefold() for event_type in _REGISTERED_CONTEXT_EVENT_TYPES
)


def _safe_event_value(value: Any) -> Any:
    """拒绝事件摘要和小型 payload 中的凭据、提示词和令牌字段。"""
    from .entities import _freeze_json_value, _safe_data

    return _freeze_json_value(_safe_data(value))


class DomainEventDraft(DomainModel):
    """描述待提交的领域事实，不包含大型证据正文或敏感信息。"""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        strict=True,
        frozen=True,
        validate_assignment=False,
        validate_default=True,
    )

    event_type: NonEmptyStr = Field(alias="eventType")
    aggregate_type: NonEmptyStr = Field(alias="aggregateType")
    aggregate_id: NonEmptyStr = Field(alias="aggregateId")
    aggregate_version: NonNegativeInt = Field(
        default=0,
        validation_alias=AliasChoices(
            "aggregate_version", "aggregateVersion", "expected_version", "expectedVersion"
        ),
        serialization_alias="aggregateVersion",
    )
    payload: JsonObject = Field(default_factory=dict)
    input_summary: SummaryValue = Field(default="", alias="inputSummary")
    output_summary: SummaryValue = Field(default="", alias="outputSummary")
    result: NonEmptyStr = "success"
    failure: Optional[NonEmptyStr] = None
    retry_count: NonNegativeInt = 0
    duration_ms: NonNegativeInt = 0
    actor: ActorValue = Field(default_factory=lambda: Actor(type="system", id="domain"))
    trace_id: NonEmptyStr = Field(default="trace_unknown", alias="traceId")
    occurred_at: AwareDateTime = Field(default_factory=utc_now, alias="occurredAt")
    attempt_id: Optional[NonEmptyStr] = Field(default=None, alias="attemptId")
    rejection_reason: Optional[SafeSummary] = Field(default=None, alias="rejectionReason")
    redaction_reason: Optional[SafeSummary] = Field(default=None, alias="redactionReason")
    event_category: EventCategory = Field(default="ordinary", alias="eventCategory")

    _check_event_values = field_validator(
        "input_summary",
        "output_summary",
        "failure",
        "payload",
        "rejection_reason",
        "redaction_reason",
        mode="after",
    )(_safe_event_value)

    @model_validator(mode="after")
    def validate_context_event_contract(self) -> "DomainEventDraft":
        """安全/调用事件必须带执行尝试、显式操作者和脱敏原因。"""
        event_type = self.event_type.casefold()
        if (
            event_type not in _REGISTERED_CONTEXT_EVENT_TYPES_CASEFOLDED
            and self.event_category == "ordinary"
        ):
            return self

        missing: list[str] = []
        if self.attempt_id is None:
            missing.append("attempt_id")
        if "actor" not in self.model_fields_set:
            missing.append("actor")
        if self.rejection_reason is None or not self.rejection_reason.strip():
            missing.append("rejection_reason")
        if self.redaction_reason is None or not self.redaction_reason.strip():
            missing.append("redaction_reason")
        if missing:
            raise ValueError(
                "context event requires: " + ", ".join(missing)
            )
        return self


class DomainEvent(DomainEventDraft):
    """保存已经定位到聚合和版本的不可变领域事实。"""

    event_id: NonEmptyStr = Field(alias="eventId")
    aggregate_version: Version = Field(
        validation_alias=AliasChoices(
            "aggregate_version", "aggregateVersion", "expected_version", "expectedVersion"
        ),
        serialization_alias="aggregateVersion",
    )
    global_sequence: NonNegativeInt = Field(default=0, alias="globalSequence")


class AppendResult(DomainModel):
    """描述一次事件追加的聚合版本结果，供后续事务仓储返回。"""

    aggregate_type: NonEmptyStr
    aggregate_id: NonEmptyStr
    expected_version: NonNegativeInt
    aggregate_version: NonNegativeInt
    events: tuple[DomainEvent, ...]

    @model_validator(mode="after")
    def validate_version_sequence(self) -> "AppendResult":
        """确保事件数量和首尾版本不会在合同层自相矛盾。"""
        if self.aggregate_version != self.expected_version + len(self.events):
            raise ValueError("aggregate_version must equal expected_version plus event count")
        return self


@runtime_checkable
class EventStore(Protocol):
    """定义后续 SQLAlchemy 事件仓储需要实现的追加和游标读取接口。"""

    async def append(
        self,
        aggregate_type: str,
        aggregate_id: str,
        expected_version: int,
        events: Sequence[DomainEventDraft],
    ) -> AppendResult:
        """原子追加一组事件并校验聚合 expected_version。"""
        ...

    async def list_after(
        self,
        event_id: Optional[str],
        project_id: Optional[str] = None,
    ) -> list[DomainEvent]:
        """按稳定 event_id 游标读取事件，不把游标解释为 offset。"""
        ...
