from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol

from app.readiness.models import CheckStatus, CheckView, ReadinessView


class ReadinessChecker(Protocol):
    """定义独立 readiness 检查器的最小契约。"""
    name: str

    async def check(self) -> CheckView | dict[str, Any]:
        """返回单项依赖的最新检查结果。"""
        ...


class ReadinessService:
    """聚合所有依赖检查，并按最严格失败状态计算总体结果。"""

    def __init__(self, checkers: Iterable[ReadinessChecker]) -> None:
        """按调用顺序保存独立检查器，检查器本身不共享状态。"""
        self.checkers = list(checkers)

    async def check(self, *, trace_id: str) -> ReadinessView:
        """重新执行所有检查并返回带 trace 的最新状态。"""
        results: dict[str, CheckView] = {}
        for checker in self.checkers:
            raw_result = await checker.check()
            if isinstance(raw_result, CheckView):
                result = raw_result
            else:
                result = CheckView.model_validate(raw_result)
            results[checker.name] = result

        statuses = [result.status for result in results.values()]
        if CheckStatus.BLOCKED in statuses:
            overall = CheckStatus.BLOCKED
            allowed_actions: list[str] = []
        elif CheckStatus.DEGRADED in statuses:
            overall = CheckStatus.DEGRADED
            allowed_actions = []
        else:
            overall = CheckStatus.READY
            allowed_actions = ["create_project"]

        return ReadinessView(
            status=overall,
            checks=results,
            allowedActions=allowed_actions,
            traceId=trace_id,
        )
