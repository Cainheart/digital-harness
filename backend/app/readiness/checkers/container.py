from __future__ import annotations

from app.infra.container_runtime import ContainerRuntime
from app.readiness.models import CheckStatus, CheckView


class ContainerReadinessChecker:
    """检查 Docker Engine 是否具备受限容器执行所需能力。"""

    name = "docker"

    def __init__(self, runtime: ContainerRuntime) -> None:
        """注入 Docker 能力查询实现。"""
        self.runtime = runtime

    async def check(self) -> CheckView:
        """将容器运行时能力汇总为 readiness 状态和诊断详情。"""
        capabilities = await self.runtime.capabilities()
        details = {
            "runtime": capabilities.runtime,
            "engineVersion": capabilities.engine_version,
            "apiVersion": capabilities.api_version,
            "nonRootContainerSupported": capabilities.non_root_supported,
            "workspaceMountSupported": capabilities.workspace_mount_supported,
            "resourceLimitsSupported": capabilities.resource_limits_supported,
            "networkPolicySupported": capabilities.network_policy_supported,
        }
        ready = all(
            (
                capabilities.available,
                capabilities.non_root_supported,
                capabilities.workspace_mount_supported,
                capabilities.resource_limits_supported,
                capabilities.network_policy_supported,
            )
        )
        if not ready:
            return CheckView(
                status=CheckStatus.BLOCKED,
                message=capabilities.message,
                impact="容器执行环境不可用",
                nextAction="启动 Docker Engine 或 Docker Desktop 并检查工作区文件共享",
                details=details,
            )
        return CheckView(status=CheckStatus.READY, message=capabilities.message, details=details)
