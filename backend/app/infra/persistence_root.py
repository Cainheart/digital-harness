import json
import os
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Protocol

from app.infra.database import BackupCallback, validate_no_follow_path
from app.api.errors import RuntimeBoundaryError
from app.config.schema_revision import SUPPORTED_SCHEMA_REVISION, validate_schema_revision


class DatabaseInitializer(Protocol):
    """定义持久化根目录提交 manifest 所需的最小数据库初始化接口。"""

    def current_revision(self) -> Optional[str]:
        """返回 Schema 检查前的真实 revision。"""
        ...

    def initialize(self, *, backup_callback: Optional[BackupCallback] = None) -> None:
        """执行数据库初始化或批准的 Schema migration。"""
        ...


class PersistenceRoot:
    """初始化并维护业务数据、证据、工作区和备份的持久化根目录。"""

    # 这些目录构成 Task 1 的数据边界，安装目录不应承担业务持久化职责。
    DATA_DIRECTORIES = ("artifacts", "traces", "workspaces", "backups")

    def __init__(self, root: Path, *, app_version: str, schema_revision: str) -> None:
        """绑定持久化根目录及其应用和 Schema 版本信息。"""
        self.root = Path(root)
        self.app_version = app_version
        try:
            self.schema_revision = validate_schema_revision(schema_revision)
        except ValueError as error:
            raise RuntimeBoundaryError(
                code="SCHEMA_CONFIGURATION_INVALID",
                message="持久化根目录只接受 0002_task2_domain_foundation Schema 基线",
                impact="manifest 未写入，业务写入和真实执行保持阻断",
                paused=True,
                data_preserved=True,
                next_action="修正 current_schema_revision 配置后重试",
                trace_id="tr_persistence_root_schema",
                schema_revision=SUPPORTED_SCHEMA_REVISION,
            ) from error

    @property
    def database_path(self) -> Path:
        """返回持久化根目录下的业务数据库路径。"""
        return self.root / "company.db"

    @property
    def manifest_path(self) -> Path:
        """返回描述应用和 Schema 版本的数据清单路径。"""
        return self.root / "manifest.json"

    def initialize(self, *, update_manifest: Optional[bool] = None) -> Optional[dict[str, Any]]:
        """创建数据目录，并按需要原子写入当前版本清单。

        默认只在 manifest 缺失时创建；既有 manifest 原样保留。显式
        update_manifest=False 是启动 Schema 检查前的非破坏性前置，显式 True
        仅由新库初始化或批准迁移成功后的调用方使用。
        """
        self.ensure_layout()
        if update_manifest is False:
            return None
        if update_manifest is None and self.manifest_path.is_file():
            try:
                value = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
            return value if isinstance(value, dict) else None

        manifest = {
            "appVersion": self.app_version,
            "schemaRevision": self.schema_revision,
            "directories": list(self.DATA_DIRECTORIES),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }
        self._write_manifest_atomically(manifest)
        return manifest

    def ensure_layout(self) -> None:
        """只创建持久化根目录及数据子目录，不改写任何既有文件。"""
        try:
            root = validate_no_follow_path(self.root)
            self.root = root
            if root.exists() and not root.is_dir():
                raise ValueError
            root.mkdir(parents=True, exist_ok=True)
            resolved_root = root.resolve(strict=True)
            for directory in self.DATA_DIRECTORIES:
                child = root / directory
                validate_no_follow_path(child)
                if os.path.lexists(child):
                    child_stat = child.lstat()
                    if not stat.S_ISDIR(child_stat.st_mode):
                        raise ValueError
                    if child.resolve(strict=True) != resolved_root / directory:
                        raise ValueError
                child.mkdir(parents=True, exist_ok=True)

            for file_path in (root / "company.db", root / "manifest.json"):
                validate_no_follow_path(file_path)
                if os.path.lexists(file_path) and not stat.S_ISREG(file_path.lstat().st_mode):
                    raise ValueError
            for sidecar in (root / "company.db-wal", root / "company.db-shm"):
                validate_no_follow_path(sidecar)
                if os.path.lexists(sidecar) and not stat.S_ISREG(sidecar.lstat().st_mode):
                    raise ValueError
        except (OSError, ValueError) as error:
            raise RuntimeBoundaryError(
                code="PERSISTENCE_UNAVAILABLE",
                message="持久化根目录或数据子目录不可安全使用",
                impact="业务写入、真实执行和工作区写入均被阻断",
                paused=True,
                data_preserved=True,
                next_action="修正持久化根目录权限、目录类型和符号链接后重试",
                trace_id="tr_persistence_root_layout",
                schema_revision=self.schema_revision,
            ) from error

    def initialize_database(
        self,
        database: DatabaseInitializer,
        *,
        backup_callback: Optional[BackupCallback] = None,
    ) -> None:
        """先检查真实 revision，再在新库/成功升级后提交 manifest 基线。"""
        self.ensure_layout()
        previous_revision = database.current_revision()
        database.initialize(backup_callback=backup_callback)
        if previous_revision is None or previous_revision == "0001_runtime_skeleton":
            # 修改说明：SR-DAT-004 要求 blocked/失败路径不改写既有 manifest；
            # 只有新空库或 0001 -> 0002 成功后才提交当前 Schema 基线。
            self.initialize(update_manifest=True)

    def _write_manifest_atomically(self, manifest: dict[str, Any]) -> None:
        """通过临时文件和原子替换写入 manifest，避免半写状态。"""
        self.root.mkdir(parents=True, exist_ok=True)
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.root,
                prefix=".manifest-",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_path = handle.name
                json.dump(manifest, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.manifest_path)
            directory_descriptor = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
            temporary_path = None
        finally:
            if temporary_path is not None:
                Path(temporary_path).unlink(missing_ok=True)
