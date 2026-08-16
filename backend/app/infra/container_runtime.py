from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol


@dataclass(frozen=True)
class ContainerCapabilities:
    """描述 Docker Engine 是否满足隔离执行所需的能力集合。"""
    available: bool
    runtime: str
    engine_version: str | None
    api_version: str | None
    non_root_supported: bool
    workspace_mount_supported: bool
    resource_limits_supported: bool
    network_policy_supported: bool
    message: str


class ContainerRuntime(Protocol):
    """定义 readiness 所需的容器运行时能力查询接口。"""
    async def capabilities(self) -> ContainerCapabilities:
        """返回隔离执行所需的容器能力。"""


def _default_docker_executable() -> str:
    """优先使用 PATH 中的 Docker CLI，再回退到 macOS Docker Desktop 安装路径。"""
    executable = shutil.which("docker")
    if executable:
        return executable
    # 修改说明：macOS Docker Desktop 可能未将 CLI 放入 PATH，回退到安装目录可避免 readiness 误报 Engine 不可用。
    for candidate in (
        Path("/Applications/Docker.app/Contents/Resources/bin/docker"),
        Path("/Applications/Docker Desktop.app/Contents/Resources/bin/docker"),
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return "docker"


class UnavailableContainerRuntime:
    """在测试或明确无容器运行时场景下返回阻断能力。"""

    async def capabilities(self) -> ContainerCapabilities:
        """返回不可用状态，不启动任何容器。"""
        return ContainerCapabilities(
            available=False,
            runtime="unavailable",
            engine_version=None,
            api_version=None,
            non_root_supported=False,
            workspace_mount_supported=False,
            resource_limits_supported=False,
            network_policy_supported=False,
            message="Docker Engine 或 Docker Desktop 不可用",
        )


class DockerCliRuntime:
    """通过 Docker CLI 查询 Engine，并用隔离探针验证最小执行能力。"""

    def __init__(
        self,
        *,
        runner: Callable[..., object] | None = None,
        executable: str | None = None,
        probe_enabled: bool = True,
    ) -> None:
        """配置 Docker CLI、命令执行器和是否运行隔离能力探针。"""
        self.runner = runner or subprocess.run
        self.executable = executable or _default_docker_executable()
        self.probe_enabled = probe_enabled

    async def capabilities(self) -> ContainerCapabilities:
        """读取 Engine 信息并检查非 root、挂载、资源和网络策略能力。"""
        try:
            completed = await asyncio.to_thread(
                self.runner,
                [self.executable, "info", "--format", "{{json .}}"],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return self._unavailable(str(error))

        if completed.returncode != 0:
            return self._unavailable(completed.stderr.strip() or "Docker Engine 不可用")

        try:
            info = json.loads(completed.stdout)
        except (TypeError, json.JSONDecodeError):
            return self._unavailable("Docker Engine 返回了无法识别的能力信息")

        operating_system = str(info.get("OperatingSystem", ""))
        runtime = "docker-desktop" if "desktop" in operating_system.lower() else "docker-engine"
        if self.probe_enabled:
            probe = await self._capability_probe()
            if probe is not None:
                return ContainerCapabilities(
                    available=True,
                    runtime=runtime,
                    engine_version=str(info.get("ServerVersion")) if info.get("ServerVersion") else None,
                    api_version=str(info.get("ApiVersion")) if info.get("ApiVersion") else None,
                    non_root_supported=probe,
                    workspace_mount_supported=probe,
                    resource_limits_supported=probe,
                    network_policy_supported=probe,
                    message=(
                        "Docker 容器执行环境可用"
                        if probe
                        else "Docker Engine 可用，但隔离容器能力探针未通过"
                    ),
                )
        return ContainerCapabilities(
            available=True,
            runtime=runtime,
            engine_version=str(info.get("ServerVersion")) if info.get("ServerVersion") else None,
            api_version=str(info.get("ApiVersion")) if info.get("ApiVersion") else None,
            non_root_supported=True,
            workspace_mount_supported=True,
            resource_limits_supported=True,
            network_policy_supported=True,
            message="Docker 容器执行环境可用",
        )

    async def _capability_probe(self) -> bool:
        """启动一次受限 Alpine 探针，不触碰真实项目工作区或业务任务。"""
        with tempfile.TemporaryDirectory(prefix="digital-harness-docker-probe-") as probe_root:
            try:
                completed = await asyncio.to_thread(
                    self.runner,
                    [
                        self.executable,
                        "run",
                        "--rm",
                        "--read-only",
                        "--user",
                        "65532:65532",
                        "--network",
                        "none",
                        "--cpus",
                        "0.25",
                        "--memory",
                        "128m",
                        "--pids-limit",
                        "64",
                        "-v",
                        f"{probe_root}:/probe:rw",
                        "alpine:3.20",
                        "sh",
                        "-c",
                        "test \"$(id -u)\" = 65532 && test -w /probe && printf 'NON_ROOT_MOUNT=PASS\\n'",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            except (OSError, subprocess.TimeoutExpired):
                return False
            return completed.returncode == 0 and "NON_ROOT_MOUNT=PASS" in completed.stdout

    @staticmethod
    def _unavailable(reason: str) -> ContainerCapabilities:
        """将 CLI、Engine 或能力探针异常统一转换为阻断结果。"""
        return ContainerCapabilities(
            available=False,
            runtime="unavailable",
            engine_version=None,
            api_version=None,
            non_root_supported=False,
            workspace_mount_supported=False,
            resource_limits_supported=False,
            network_policy_supported=False,
            message=f"Docker Engine 或 Docker Desktop 不可用：{reason}",
        )
