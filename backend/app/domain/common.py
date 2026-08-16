"""Task 2 领域层共享值对象。

这里冻结上游文档规定的项目/任务状态，并提供不依赖数据库的对象标识、UTC
时间、操作者和游标分页合同。
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
import re
from secrets import token_bytes
import time
from typing import Generic, Optional, TypeVar


_OBJECT_KIND_PATTERN = re.compile(r"^[a-z](?:[a-z0-9_-]{0,62}[a-z0-9])?$")
_SAFE_VALUE_PATTERN = re.compile(r"^[^\x00-\x1f\x7f\s/\\]+$")
T = TypeVar("T")

try:
    # Python 3.12 的标准 StrEnum 是 Task 2 的正式运行时合同。
    from enum import StrEnum
except ImportError:  # pragma: no cover - only exercised by the legacy 3.9 test env
    class StrEnum(str, Enum):
        """为项目仍需回归的 Python 3.9 环境提供等价的字符串枚举。"""

        def __str__(self) -> str:
            """保持旧解释器上的字符串化结果与 Python 3.12 StrEnum 一致。"""
            return self.value


class ProjectStatus(StrEnum):
    """限制项目主状态为 PRD 和需求矩阵冻结的八个值。"""

    PREPARING = "准备中"
    RUNNING = "运行中"
    WAITING_BOSS = "等待 Boss"
    PAUSED = "已暂停"
    BLOCKED = "已阻塞"
    CLOSING = "结项中"
    COMPLETED = "已结项"
    TERMINATED = "已终止"


class TaskStatus(StrEnum):
    """限制任务状态为 PRD 和需求矩阵冻结的八个值。"""

    PENDING = "待处理"
    RUNNING = "进行中"
    WAITING_REVIEW = "等待 Review"
    WAITING_APPROVAL = "等待审批"
    BLOCKED = "阻塞"
    REWORK = "返工"
    COMPLETED = "已完成"
    TERMINATED = "已终止"


def _validate_non_empty_value(value: str, *, field_name: str) -> str:
    """拒绝空白、控制字符和路径分隔符，避免标识混入不可见数据。"""
    if not isinstance(value, str) or not value or not value.strip():
        raise ValueError(f"{field_name} must be non-empty")
    if not _SAFE_VALUE_PATTERN.fullmatch(value):
        raise ValueError(f"{field_name} contains unsafe characters")
    return value


@dataclass(frozen=True)
class Actor:
    """记录领域事实的责任角色和操作者，不携带凭据或自由文本。"""

    type: str
    id: str

    def __post_init__(self) -> None:
        """保证事件责任主体有稳定、可展示的非空标识。"""
        object.__setattr__(self, "type", _validate_non_empty_value(self.type, field_name="actor.type"))
        object.__setattr__(self, "id", _validate_non_empty_value(self.id, field_name="actor.id"))


@dataclass(frozen=True)
class Page(Generic[T]):
    """描述稳定游标分页结果，避免把会移动的 cursor 当作 offset 使用。"""

    items: tuple[T, ...] = field(default_factory=tuple)
    next_cursor: Optional[str] = None
    has_more: bool = False

    def __post_init__(self) -> None:
        """将结果容器固定为 tuple，并校验下一页游标的一致性。"""
        object.__setattr__(self, "items", tuple(self.items))
        if self.next_cursor is not None:
            _validate_non_empty_value(self.next_cursor, field_name="next_cursor")
        if self.has_more and self.next_cursor is None:
            raise ValueError("next_cursor is required when has_more is true")


def utc_now() -> datetime:
    """返回带 UTC 时区的当前时间，统一所有 Task 2 时间字段。"""
    return datetime.now(timezone.utc)


def new_object_id(kind: str) -> str:
    """生成带类型前缀、不可猜测且按时间大致有序的对象 ID。

    13 位毫秒时间只用于排序，后接 96 位随机数防止调用方猜测后续 ID；kind
    只允许安全的 ASCII 类型名，避免生成路径或日志注入内容。
    """
    if not isinstance(kind, str) or not _OBJECT_KIND_PATTERN.fullmatch(kind):
        raise ValueError("kind must start/end with an ASCII letter or digit and contain only safe characters")
    random_part = token_bytes(12)
    random_suffix = base64.b32encode(random_part).decode("ascii").rstrip("=").lower()
    value = f"{time.time_ns() // 1_000_000:013d}{random_suffix}"
    return f"{kind}_{value}"
