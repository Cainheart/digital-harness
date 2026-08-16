from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol

from app.readiness.models import CheckStatus, CheckView


class ResearchProbe(Protocol):
    """定义本地调研适配器的无副作用可用性探针。"""
    async def check(self) -> bool:
        """返回调研适配器是否可启动。"""
        ...


class UnavailableResearchProbe:
    """测试模式下明确返回不可用，避免误触发真实浏览器。"""

    async def check(self) -> bool:
        """返回浏览器调研不可用。"""
        return False


class LocalBrowserProbe:
    """只检查本机浏览器可执行权限，不在 readiness 阶段访问网页。"""

    def __init__(self, *, executable: str) -> None:
        """绑定待检查的浏览器可执行文件路径。"""
        self.executable = Path(executable)

    async def check(self) -> bool:
        """确认配置路径存在且可执行。"""
        return self.executable.is_file() and os.access(self.executable, os.X_OK)


class ResearchReadinessChecker:
    """将调研适配器探针转换成阻断或就绪状态。"""

    name = "research"

    def __init__(self, probe: ResearchProbe) -> None:
        """注入无副作用的本地调研探针。"""
        self.probe = probe

    async def check(self) -> CheckView:
        """检查调研能力并提供面向用户的修复动作。"""
        if not await self.probe.check():
            return CheckView(
                status=CheckStatus.BLOCKED,
                message="公开资料调研适配器不可用",
                impact="公开资料调研不可用",
                nextAction="安装并启动支持的浏览器适配器",
            )
        return CheckView(status=CheckStatus.READY, message="公开资料调研适配器可启动")
