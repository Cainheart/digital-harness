from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CheckStatus(str, Enum):
    """定义单项和总体 readiness 的可观察状态。"""
    READY = "ready"
    BLOCKED = "blocked"
    DEGRADED = "degraded"


class CheckView(BaseModel):
    """描述单项依赖检查结果、影响和下一步动作。"""
    model_config = ConfigDict(populate_by_name=True)

    status: CheckStatus
    message: str
    code: Optional[str] = None
    impact: Optional[str] = None
    data_preserved: Optional[bool] = Field(default=None, alias="dataPreserved")
    schema_revision: Optional[str] = Field(default=None, alias="schemaRevision")
    next_action: Optional[str] = Field(default=None, alias="nextAction")
    details: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("message")
    @classmethod
    def message_must_not_be_empty(cls, value: str) -> str:
        """拒绝没有解释信息的检查结果，避免 UI 展示空错误。"""
        if not value.strip():
            raise ValueError("readiness check message must not be empty")
        return value


class ReadinessView(BaseModel):
    """描述一次完整运行准备检查及其允许动作。"""
    model_config = ConfigDict(populate_by_name=True)

    status: CheckStatus
    checked_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), alias="checkedAt")
    checks: Dict[str, CheckView]
    allowed_actions: List[str] = Field(default_factory=list, alias="allowedActions")
    trace_id: str = Field(alias="traceId")
