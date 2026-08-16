from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config.schema_revision import SUPPORTED_SCHEMA_REVISION, validate_schema_revision


class Settings(BaseSettings):
    """读取本地运行配置，并强制控制面只绑定回环地址。"""

    model_config = SettingsConfigDict(env_prefix="DIGITAL_HARNESS_", extra="ignore")

    persistent_root: Path
    host: str = "127.0.0.1"
    port: int = 8765
    app_version: str = "0.1.0"
    # 修改说明：Task 2 增加领域事实表后，应用必须只对 0002 基线开放可写启动。
    current_schema_revision: str = SUPPORTED_SCHEMA_REVISION
    # Task 2 ArtifactStore 的默认单文件上限，避免大型证据正文进入不可控范围。
    artifact_max_size_bytes: int = 64 * 1024 * 1024
    allow_real_execution: bool = False
    model_provider: str = "unconfigured"
    model_name: str = "unconfigured"
    model_secret_ref: str = "keyring://unconfigured"

    @field_validator("current_schema_revision")
    @classmethod
    def validate_current_schema_revision(cls, value: str) -> str:
        """把 Settings 与 Database、Alembic 和 readiness 绑定到同一个 0002 基线。"""
        try:
            return validate_schema_revision(value)
        except ValueError as error:
            raise ValueError("only 0002_task2_domain_foundation is supported") from error

    @field_validator("host")
    @classmethod
    def validate_local_host(cls, value: str) -> str:
        """拒绝非 127.0.0.1 的监听地址，保持 Task 1 的本机访问边界。"""
        if value != "127.0.0.1":
            raise ValueError("Task 1 only permits 127.0.0.1")
        return value

    @property
    def database_path(self) -> Path:
        """返回业务 SQLite 数据库路径。"""
        return self.persistent_root / "company.db"

    @property
    def artifact_path(self) -> Path:
        """返回交付物文件存储路径。"""
        return self.persistent_root / "artifacts"

    @property
    def trace_path(self) -> Path:
        """返回追踪和运行证据存储路径。"""
        return self.persistent_root / "traces"

    @property
    def workspace_path(self) -> Path:
        """返回本地项目工作区路径。"""
        return self.persistent_root / "workspaces"

    @property
    def backup_path(self) -> Path:
        """返回备份文件存储路径。"""
        return self.persistent_root / "backups"
