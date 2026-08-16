"""Task 2 稳定领域错误和安全错误载荷。

错误对象保存机器可判断的 code、HTTP 状态、影响、暂停和数据保留信息；对外
载荷会递归脱敏，避免 API Key、Bearer、Cookie、Token 等原文进入错误消息。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import re
from typing import Any, Optional


_SENSITIVE_ASSIGNMENT = re.compile(
    r"(?:api[_ -]?key|authorization|bearer|cookie|secret|password|token|system\s+prompt|prompt)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+(?:\s+[^\s,;]+)?",
    re.IGNORECASE,
)
_BEARER = re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_SECRET_KEY = re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_-]*\b")


def _redact_text(value: str) -> str:
    """替换常见凭据赋值、Bearer 令牌和 sk- 开头的密钥。"""
    value = _SENSITIVE_ASSIGNMENT.sub("[REDACTED]", value)
    value = _BEARER.sub("Bearer [REDACTED]", value)
    return _SECRET_KEY.sub("[REDACTED]", value)


def _redact_data(value: Any, *, key: Optional[str] = None) -> Any:
    """递归脱敏结构化错误数据，同时保留安全诊断字段。"""
    if key and re.search(r"api[_ -]?key|authorization|bearer|cookie|secret|password|token|prompt", key, re.IGNORECASE):
        return "[REDACTED]"
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, Mapping):
        return {str(item_key): _redact_data(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_redact_data(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return "[REDACTED]"


class Task2DomainError(RuntimeError):
    """Task 2 领域边界错误的稳定基类和统一 JSON 载荷转换器。"""

    default_code = "DOMAIN_ERROR"
    default_status_code = 400
    default_message = "领域操作被拒绝"
    default_impact = "操作未完成"
    default_next_action = "检查请求和关联对象后重试"

    def __init__(
        self,
        message: Optional[str] = None,
        *,
        impact: Optional[str] = None,
        paused: bool = False,
        data_preserved: bool = True,
        next_action: Optional[str] = None,
        trace_id: str = "trace_unknown",
        status_code: Optional[int] = None,
        data: Optional[Mapping[str, Any]] = None,
    ) -> None:
        """保存稳定错误语义，并在保存前移除敏感输入。"""
        self.code = self.default_code
        self.message = _redact_text(message or self.default_message)
        self.impact = _redact_text(impact or self.default_impact)
        self.paused = paused
        self.data_preserved = data_preserved
        self.next_action = _redact_text(next_action or self.default_next_action)
        self.trace_id = _redact_text(trace_id) or "trace_unknown"
        self.status_code = status_code or self.default_status_code
        self.data = _redact_data(data or {})
        super().__init__(self.message)

    def to_payload(self) -> dict[str, Any]:
        """生成统一且不包含凭据原文的错误响应载荷。"""
        return {
            "code": self.code,
            "message": self.message,
            "impact": self.impact,
            "paused": self.paused,
            "dataPreserved": self.data_preserved,
            "nextAction": self.next_action,
            "traceId": self.trace_id,
            "statusCode": self.status_code,
            "data": self.data,
        }

    def payload(self) -> dict[str, Any]:
        """提供简短别名，便于异常处理器统一调用。"""
        return self.to_payload()

    def as_payload(self) -> dict[str, Any]:
        """提供显式序列化别名，兼容 API 层错误适配器。"""
        return self.to_payload()


class InvalidArgumentError(Task2DomainError):
    """表示请求字段、值域或 JSON 合同无效。"""

    default_code = "INVALID_ARGUMENT"
    default_status_code = 400
    default_message = "请求参数无效"


class VersionConflictError(Task2DomainError):
    """表示 expected_version 已落后于聚合当前版本。"""

    default_code = "VERSION_CONFLICT"
    default_status_code = 409
    default_message = "对象版本冲突，未覆盖最新事实"


class IdempotencyKeyReusedError(Task2DomainError):
    """表示幂等键对应的请求指纹与当前请求不一致。"""

    default_code = "IDEMPOTENCY_KEY_REUSED"
    default_status_code = 409
    default_message = "幂等键已被其他请求使用"


class NotFoundError(Task2DomainError):
    """表示请求的领域对象或证据引用不存在。"""

    default_code = "NOT_FOUND"
    default_status_code = 404
    default_message = "请求对象不存在"


class ReadOnlyProjectError(Task2DomainError):
    """表示历史项目只读边界阻止了写操作。"""

    default_code = "READ_ONLY_PROJECT"
    default_status_code = 409
    default_message = "历史项目处于只读状态，操作被策略拒绝"


class ArtifactIntegrityError(Task2DomainError):
    """表示 Artifact 内容或 SHA-256 校验失败。"""

    default_code = "ARTIFACT_INTEGRITY_FAILED"
    default_status_code = 422
    default_message = "Artifact 完整性校验失败"


class ArtifactTooLargeError(Task2DomainError, ValueError):
    """表示 Artifact 超过允许的大小边界。"""

    default_code = "ARTIFACT_TOO_LARGE"
    default_status_code = 413
    default_message = "Artifact 超过大小限制"


class TraceLinkInvalidError(Task2DomainError):
    """表示追踪关系端点、项目范围或关系合同无效。"""

    default_code = "TRACE_LINK_INVALID"
    default_status_code = 422
    default_message = "TraceLink 关系无效"


class EvidenceIncompleteError(Task2DomainError):
    """表示质量门禁缺少必要的证据引用。"""

    default_code = "EVIDENCE_INCOMPLETE"
    default_status_code = 422
    default_message = "证据不完整，无法通过质量门禁"
