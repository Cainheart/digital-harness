from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4


@dataclass(frozen=True)
class TraceContext:
    """保存跨控制面、Worker 和证据事件传播的 trace/span 标识。"""
    trace_id: str
    span_id: str
    parent_span_id: str | None = None

    @classmethod
    def new(cls) -> "TraceContext":
        """创建新的根 trace 和 span。"""
        return cls(trace_id=f"tr_{uuid4().hex}", span_id=f"sp_{uuid4().hex}")

    def child(self) -> "TraceContext":
        """创建继承当前 trace、并以当前 span 为父级的新 span。"""
        return TraceContext(
            trace_id=self.trace_id,
            span_id=f"sp_{uuid4().hex}",
            parent_span_id=self.span_id,
        )
