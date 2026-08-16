from __future__ import annotations

from dataclasses import dataclass
import os

from app.infra.database import Database
from app.infra.keychain import MemoryCredentialAdapter
from app.infra.container_runtime import ContainerCapabilities
from app.readiness.checkers.container import ContainerReadinessChecker
from app.readiness.checkers.model import ModelReadinessChecker
from app.readiness.checkers.persistence import PersistenceReadinessChecker
from app.readiness.checkers.research import ResearchReadinessChecker
from app.readiness.checkers.workspace import WorkspaceReadinessChecker


@dataclass
class StubBrowserProbe:
    available: bool = True

    async def check(self) -> bool:
        return self.available


@dataclass
class StubContainerRuntime:
    available: bool = True

    async def capabilities(self) -> ContainerCapabilities:
        return ContainerCapabilities(
            available=self.available,
            runtime="docker-desktop",
            engine_version="27.0",
            api_version="1.46",
            non_root_supported=self.available,
            workspace_mount_supported=self.available,
            resource_limits_supported=self.available,
            network_policy_supported=self.available,
            message="Docker probe completed",
        )


async def test_model_checker_uses_credential_check_without_model_generation():
    credentials = MemoryCredentialAdapter()
    secret_ref = await credentials.save("openai", "sk-test-private")
    checker = ModelReadinessChecker(credentials, provider="openai", model="gpt-test", secret_ref=secret_ref)

    result = await checker.check()

    assert result.status == "ready"
    assert result.details["provider"] == "openai"
    assert result.details["model"] == "gpt-test"


async def test_research_checker_blocks_when_browser_probe_is_unavailable():
    checker = ResearchReadinessChecker(StubBrowserProbe(available=False))

    result = await checker.check()

    assert result.status == "blocked"
    assert result.impact == "公开资料调研不可用"
    assert result.next_action == "安装并启动支持的浏览器适配器"


async def test_workspace_checker_reports_missing_workspace_without_writing_files(tmp_path):
    workspace = tmp_path / "missing-workspace"
    checker = WorkspaceReadinessChecker(workspace)

    result = await checker.check()

    assert result.status == "blocked"
    assert not workspace.exists()
    assert result.impact == "本地项目工作区不可访问"


async def test_workspace_checker_blocks_workspace_without_read_write_access(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    workspace.chmod(0o500)
    assert os.access(workspace, os.R_OK)
    assert not os.access(workspace, os.W_OK)

    result = await WorkspaceReadinessChecker(workspace).check()

    assert result.status == "blocked"
    assert result.next_action == "检查工作区路径并授予应用访问权限"


async def test_container_checker_requires_non_root_mount_limits_and_network_capabilities():
    checker = ContainerReadinessChecker(StubContainerRuntime(available=False))

    result = await checker.check()

    assert result.status == "blocked"
    assert result.details["runtime"] == "docker-desktop"
    assert result.impact == "容器执行环境不可用"


async def test_persistence_checker_reports_wal_and_schema(tmp_path):
    database = Database(tmp_path / "company.db")
    database.initialize()
    # 修改说明：Task 2 Schema 基线更新 readiness 兼容 revision，但保护 Task 1 的 WAL/Schema 检查语义。
    # 修改说明：Task 2 Schema 基线由唯一支持常量绑定，保护 Task 1 readiness/WAL 检查语义。
    checker = PersistenceReadinessChecker(database)

    result = await checker.check()

    assert result.status == "ready"
    assert result.details["journalMode"] == "wal"
    # 修改说明：T2-AC-04/T2-AC-09 使用 0002 作为当前基线，readiness 仍必须报告真实 revision。
    assert result.details["schemaRevision"] == "0002_task2_domain_foundation"
