from __future__ import annotations

from app.api.errors import RuntimeBoundaryError
from app.readiness.models import CheckStatus


class StartupGate:
    """在真实执行前统一检查 readiness，并阻止绕过运行准备的调用。"""

    def __init__(self, readiness, *, allow_real_execution: bool = False) -> None:
        """注入 readiness 服务，并默认关闭真实执行放行。"""
        self.readiness = readiness
        self.allow_real_execution = allow_real_execution

    async def assert_ready_for_real_execution(self, *, project_id: str | None, trace_id: str) -> None:
        """在所有必要检查通过且显式允许时放行真实执行。"""
        view = await self.readiness.check(trace_id=trace_id)
        if view.status != CheckStatus.READY or not self.allow_real_execution:
            raise RuntimeBoundaryError(
                code="WORKFLOW_GUARD_BLOCKED",
                message="运行准备尚未完成，不能开始真实执行",
                impact="不会产生模型调用、网页访问、工作区写入或项目命令",
                paused=True,
                data_preserved=True,
                next_action="修复阻断项并完成明确的项目启动确认",
                trace_id=trace_id,
                status_code=409,
            )

    async def try_assert_ready(self, *, trace_id: str):
        """返回阻断异常而不是抛出，便于调用方展示统一的下一步。"""
        try:
            await self.assert_ready_for_real_execution(project_id=None, trace_id=trace_id)
        except RuntimeBoundaryError as error:
            return error
        return None
