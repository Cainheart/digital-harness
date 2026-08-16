"""Task 2 写命令信封、结果和稳定请求指纹。

命令模型只做输入边界校验；幂等记录和真正的事件提交由后续应用服务/仓储
实现。请求哈希采用 JSON canonicalization，保证重放比较不依赖字典插入顺序。
"""

from __future__ import annotations

import hashlib
import json

from pydantic import Field, field_validator

from .common import Actor
from .entities import (
    ActorValue,
    DomainModel,
    JsonObject,
    NonEmptyStr,
    NonEmptyTuple,
    Version,
    NonNegativeInt,
)


class CommandEnvelope(DomainModel):
    """统一所有 Task 2 写命令的幂等、版本和操作者信封。"""

    command_id: NonEmptyStr = Field(alias="commandId")
    idempotency_key: NonEmptyStr = Field(alias="idempotencyKey")
    aggregate_id: NonEmptyStr = Field(alias="aggregateId")
    expected_version: NonNegativeInt = Field(alias="expectedVersion")
    actor: ActorValue
    payload: JsonObject

    @field_validator("payload")
    @classmethod
    def reject_reserved_envelope_keys(cls, value: dict[str, object]) -> dict[str, object]:
        """避免把命令信封字段伪装成业务 payload，尤其是非法版本值。"""
        reserved = {
            "commandId",
            "command_id",
            "idempotencyKey",
            "idempotency_key",
            "aggregateId",
            "aggregate_id",
            "expectedVersion",
            "expected_version",
            "actor",
            "payload",
        }
        if reserved.intersection(value):
            raise ValueError("payload contains reserved command envelope fields")
        return value


class CommandResult(DomainModel):
    """返回一次已提交命令的稳定结果，供幂等重放。"""

    aggregate_id: NonEmptyStr = Field(alias="aggregateId")
    version: Version
    event_id: NonEmptyStr = Field(alias="eventId")
    allowed_actions: NonEmptyTuple = Field(alias="allowedActions")
    trace_id: NonEmptyStr = Field(alias="traceId")


def canonical_request_hash(envelope: CommandEnvelope) -> str:
    """用排序键、无空格 JSON 和 SHA-256 生成稳定的命令请求指纹。"""
    request = envelope.model_dump(mode="json")
    canonical = json.dumps(
        request,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()
