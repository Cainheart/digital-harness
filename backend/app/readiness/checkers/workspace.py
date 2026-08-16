from __future__ import annotations

import os
from pathlib import Path

from app.readiness.models import CheckStatus, CheckView


class WorkspaceReadinessChecker:
    """检查本地项目工作区是否存在且同时可读写。"""

    name = "workspace"

    def __init__(self, workspace: Path) -> None:
        """绑定需要检查读写权限的工作区路径。"""
        self.workspace = Path(workspace)

    async def check(self) -> CheckView:
        """执行无业务副作用的工作区权限检查。"""
        if (
            not self.workspace.exists()
            or not self.workspace.is_dir()
            or not os.access(self.workspace, os.R_OK)
            or not os.access(self.workspace, os.W_OK)
        ):
            return CheckView(
                status=CheckStatus.BLOCKED,
                message="本地项目工作区不可访问",
                impact="本地项目工作区不可访问",
                nextAction="检查工作区路径并授予应用访问权限",
            )
        return CheckView(
            status=CheckStatus.READY,
            message="本地项目工作区可访问",
            details={"root": "workspace://local"},
        )
