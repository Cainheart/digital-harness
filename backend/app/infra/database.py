from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, event, inspect, select, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from app.api.errors import RuntimeBoundaryError
from app.config.schema_revision import (
    SUPPORTED_SCHEMA_REVISION,
    validate_schema_revision,
)
from app.domain.common import ProjectStatus
from app.domain.errors import NotFoundError, ReadOnlyProjectError
from app.infra.task2_schema import (
    DOMAIN_EVENTS_IMMUTABLE_DELETE_TRIGGER,
    DOMAIN_EVENTS_IMMUTABLE_UPDATE_TRIGGER,
    SCHEMA_CHECK_CONTRACTS,
    SCHEMA_FOREIGN_KEY_CONTRACTS,
    SCHEMA_INDEX_CONTRACTS,
    SCHEMA_UNIQUE_CONTRACTS,
    TASK2_TABLE_ORDER,
    TASK2_TABLES,
    TRIGGER_SQL_CONTRACTS,
    projects,
)

# 修改说明：Task 2-AC 的领域表已纳入迁移基线；全应用只允许同一个 0002 目标。
SUPPORTED_REVISION = SUPPORTED_SCHEMA_REVISION
DEFAULT_APP_VERSION = "0.1.0"
TASK1_TABLES = frozenset(
    {"credential_configs", "runtime_events", "runtime_state", "worker_leases"}
)
BACKUP_DATA_DIRECTORIES = ("artifacts", "traces", "workspaces")
_SENSITIVE_BYTES_PATTERNS = (
    re.compile(rb"sk-[A-Za-z0-9_-]{8,}", re.IGNORECASE),
    re.compile(rb"Bearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE),
    re.compile(
        rb"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)"
        rb"\s*[:=]\s*[^\s,;]+",
        re.IGNORECASE,
    ),
)
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
BACKUP_CHUNK_SIZE = 1024 * 1024
BACKUP_MAX_FILE_SIZE = 64 * 1024 * 1024
BACKUP_MAX_TOTAL_SIZE = 256 * 1024 * 1024
BACKUP_SAFETY_STATUS = {
    "symlinkScan": "passed",
    "specialFileScan": "passed",
    "sensitiveContentScan": "passed",
    "credentialRedaction": "passed",
}


def validate_no_follow_path(path: Path) -> Path:
    """逐级 lstat 路径，拒绝 symlink/特殊文件并允许安全创建缺失尾部。"""
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    missing_seen = False
    for component in absolute.relative_to(Path(absolute.anchor)).parts:
        current /= component
        if not os.path.lexists(current):
            missing_seen = True
            continue
        if missing_seen:
            # 路径中间出现已存在项而前面缺失只可能依赖隐式解析，禁止继续。
            raise OSError("path component is not safely addressable")
        mode = current.lstat().st_mode
        if (
            stat.S_ISLNK(mode)
            or stat.S_ISFIFO(mode)
            or stat.S_ISCHR(mode)
            or stat.S_ISBLK(mode)
            or stat.S_ISSOCK(mode)
        ):
            raise OSError("path contains a symlink or special file")
        if current != absolute and not stat.S_ISDIR(mode):
            raise OSError("path parent is not a directory")
    return absolute


@dataclass(frozen=True)
class MigrationBackupContext:
    """描述 0001 -> 0002 迁移前一致性备份的完整上下文。"""

    persistent_root: Path
    database_path: Path
    app_version: str
    source_schema_revision: str
    target_schema_revision: str


@dataclass(frozen=True)
class BackupReceipt:
    """描述已落盘且通过完整性/敏感信息检查的迁移前备份。"""

    backup_id: str
    root: Path
    source_schema_revision: str
    target_schema_revision: str
    file_manifest: dict[str, Any]
    safety_status: dict[str, str]
    verified: bool = True
    persistent_root: Path | None = None
    database_path: Path | None = None


# 生产回调必须返回 BackupReceipt；True/None 不再能绕过真实备份前置。
BackupCallback = Callable[[MigrationBackupContext], BackupReceipt]


@dataclass(frozen=True)
class SchemaCheckResult:
    """描述数据库是否可由当前应用安全写入。"""

    writable: bool
    revision: str | None
    code: str | None
    message: str
    data_preserved: bool
    next_action: str | None


class Database:
    """提供只读诊断、受保护事务和批准 Schema migration 的 SQLite 边界。"""

    def __init__(
        self,
        path: Path,
        *,
        persistent_root: Path | None = None,
        app_version: str = DEFAULT_APP_VERSION,
        schema_revision: str = SUPPORTED_REVISION,
    ) -> None:
        """绑定 company.db 与持久化根，并拒绝可绕过兼容基线的构造参数。"""
        try:
            validate_schema_revision(schema_revision)
        except ValueError as error:
            raise RuntimeBoundaryError(
                code="SCHEMA_CONFIGURATION_INVALID",
                message="应用只支持 0002_task2_domain_foundation Schema 基线",
                impact="数据库未打开，业务写入和真实执行保持阻断",
                paused=True,
                data_preserved=True,
                next_action="修正 current_schema_revision、Database target 和 manifest 配置后重试",
                trace_id=f"tr_schema_config_{uuid4().hex[:12]}",
                schema_revision=SUPPORTED_REVISION,
            ) from error

        self.path = Path(path)
        self.persistent_root = Path(persistent_root) if persistent_root else self.path.parent
        self.app_version = app_version
        self.target_schema_revision = SUPPORTED_REVISION
        self._validate_path_binding()
        # 每个 SQLite DB-API 连接拥有独立 purge 状态；普通连接永远返回 0。
        self._purge_guard_states: dict[int, dict[str, str | None]] = {}
        self._engine = self._create_engine()

    def _validate_path_binding(self) -> None:
        """验证数据库只能是持久化根下的 company.db，且根/数据目录不跟随链接。"""
        try:
            root = validate_no_follow_path(self.persistent_root)
            database = validate_no_follow_path(self.path)
            if root.exists() and not root.is_dir():
                raise ValueError
            if database != root / "company.db":
                raise ValueError
            if database.exists() and not (database.is_file() or database.is_dir()):
                raise ValueError
            root_resolved = root.resolve(strict=False)
            database_resolved = database.resolve(strict=False)
            if database_resolved.parent != root_resolved:
                raise ValueError
            self.persistent_root = root
            self.path = database
            root.mkdir(parents=True, exist_ok=True)
            self._validate_storage_directories()
        except (OSError, ValueError) as error:
            raise RuntimeBoundaryError(
                code="SCHEMA_CONFIGURATION_INVALID",
                message="数据库路径必须是持久化根目录内的 company.db，且边界路径不得为符号链接",
                impact="数据库未打开，业务写入、真实执行和工作区写入保持阻断",
                paused=True,
                data_preserved=True,
                next_action="修正 persistent_root/company.db 路径和持久化目录后重试",
                trace_id=f"tr_schema_path_{uuid4().hex[:12]}",
                schema_revision=SUPPORTED_REVISION,
            ) from error

    def _validate_storage_directories(self) -> None:
        """拒绝 Task 2 备份边界中的符号链接、非目录和越界目录。"""
        root = validate_no_follow_path(self.persistent_root)
        root_resolved = root.resolve(strict=False)
        for name in (*BACKUP_DATA_DIRECTORIES, "backups"):
            candidate = self.persistent_root / name
            validate_no_follow_path(candidate)
            if not os.path.lexists(candidate):
                continue
            mode = candidate.lstat().st_mode
            if not stat.S_ISDIR(mode):
                raise ValueError(f"unsafe persistent directory: {name}")
            resolved = candidate.resolve(strict=True)
            if resolved != root_resolved / name or root_resolved not in resolved.parents:
                raise ValueError(f"persistent directory escapes root: {name}")

        for candidate in (
            self.path,
            Path(f"{self.path}-wal"),
            Path(f"{self.path}-shm"),
            self.persistent_root / "manifest.json",
        ):
            validate_no_follow_path(candidate)
            if not os.path.lexists(candidate):
                continue
            mode = candidate.lstat().st_mode
            if not stat.S_ISREG(mode):
                if candidate == self.path and stat.S_ISDIR(mode):
                    # company.db 目录由 readiness 归类为 PERSISTENCE_UNAVAILABLE；
                    # 构造阶段仍需保留可解释的 blocked 查询窗口。
                    continue
                raise ValueError(f"unsafe persistent file: {candidate.name}")
            resolved = candidate.resolve(strict=True)
            if resolved != root_resolved / candidate.relative_to(root) or root_resolved not in resolved.parents:
                raise ValueError(f"persistent file escapes root: {candidate.name}")

    def _create_engine(self) -> Engine:
        """创建只配置连接级外键的内部引擎，不在未知库上持久化切换 WAL。"""
        self.persistent_root.mkdir(parents=True, exist_ok=True)
        engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False},
            poolclass=NullPool,
        )

        @event.listens_for(engine, "connect")
        def configure_sqlite(dbapi_connection: Any, _connection_record: Any) -> None:
            """只开启连接级外键；WAL 只能在确认兼容或迁移成功后显式设置。"""
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
            state = {"authorized_project_id": None}
            self._purge_guard_states[id(dbapi_connection)] = state
            dbapi_connection.create_function(
                "task2_purge_guard",
                1,
                lambda project_id, state=state: 1
                if project_id is not None
                and state["authorized_project_id"] == project_id
                else 0,
            )

        @event.listens_for(engine, "close")
        def clear_sqlite_purge_state(dbapi_connection: Any, _connection_record: Any) -> None:
            """连接关闭时清除 guard 状态，避免连接 id 复用继承授权。"""
            self._purge_guard_states.pop(id(dbapi_connection), None)

        return engine

    @staticmethod
    def _create_readonly_engine(database_path: Path, *, immutable: bool = False) -> Engine:
        """为数据库快照创建 SQLite mode=ro 引擎，不连接生产 company.db。"""
        immutable_query = "&immutable=1" if immutable else ""
        read_only_url = f"sqlite:///file:{database_path}?mode=ro{immutable_query}&uri=true"
        engine = create_engine(
            read_only_url,
            connect_args={"check_same_thread": False, "uri": True},
            poolclass=NullPool,
        )

        @event.listens_for(engine, "connect")
        def configure_readonly_sqlite(dbapi_connection: Any, _connection_record: Any) -> None:
            """只保留连接级外键和 query_only，不触碰 journal_mode 或主库文件。"""
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA query_only=ON")
            cursor.close()

        return engine

    def initialize(self, *, backup_callback: BackupCallback | None = None) -> None:
        """执行批准的初始化/迁移，并在成功后才显式确保 WAL。"""
        try:
            # 先用 mode=ro 读取真实 revision；legacy/unknown/future 路径绝不能先
            # 打开可写 SQLite 连接，否则某些 SQLite 版本会改写 WAL/SHM sidecar。
            current = self.current_revision()
            if current is None:
                existing_tables = self.table_names() if self.path.exists() else set()
                if existing_tables:
                    # T2-AC-04/T2-AC-09：有表但无 revision 是 legacy，只读阻断。
                    raise self._schema_conflict_error(
                        revision=None,
                        next_action="备份持久化根目录并沿批准路径恢复或执行 Schema migration",
                    )
                self._run_upgrade()
            elif current == "0001_runtime_skeleton":
                # upgrade.md §迁移前置：一致性备份成功后才允许批准升级。
                self._ensure_migration_backup(
                    backup_callback,
                    source_schema_revision=current,
                )
                self._run_upgrade()
            elif current == SUPPORTED_REVISION:
                with self.read_connection() as connection:
                    self._validate_schema_contract(connection)
            else:
                raise self._schema_conflict_error(
                    revision=current,
                    next_action="备份持久化根目录并沿批准路径升级到 0002_task2_domain_foundation",
                )
        except RuntimeBoundaryError:
            raise
        except (SQLAlchemyError, OSError) as error:
            raise self._persistence_error(
                code="SCHEMA_MIGRATION_FAILED",
                next_action="检查 SQLite 文件、锁状态和批准 migration 日志后重试",
            ) from error
        except Exception as error:
            # Alembic CommandError 等非 SQLAlchemy 异常也必须脱敏为稳定契约。
            raise self._persistence_error(
                code="SCHEMA_MIGRATION_FAILED",
                next_action="检查批准 migration 和持久化根目录后重试",
            ) from error

        # 只有新库、批准升级或完整性确认后的 0002 才允许产生 WAL/SHM 副作用。
        self._ensure_wal()

    def _run_upgrade(self) -> None:
        """只在只读检查确认可迁移后打开内部写连接执行批准 Alembic upgrade。"""
        config = self._alembic_config()
        with self._migration_connection() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, SUPPORTED_REVISION)

    def _schema_conflict_error(
        self,
        *,
        revision: str | None,
        next_action: str,
        code: str = "VERSION_CONFLICT",
    ) -> RuntimeBoundaryError:
        """构造启动、readiness 和事务共用的结构化 schema 冲突错误。"""
        return RuntimeBoundaryError(
            code=code,
            message=(
                "Schema revision 不兼容或结构完整性校验失败；数据库保持只读阻断"
                if code != "VERSION_CONFLICT"
                else "VERSION_CONFLICT: 当前数据库 Schema revision 不兼容"
            ),
            impact="业务写入、真实执行和工作区写入均被阻断；诊断查询保持只读",
            paused=True,
            data_preserved=True,
            next_action=next_action,
            trace_id=f"tr_schema_{uuid4().hex[:12]}",
            schema_revision=revision,
        )

    @staticmethod
    def _persistence_error(*, code: str, next_action: str) -> RuntimeBoundaryError:
        """把底层打开、锁定、损坏和 migration 错误转换为不泄露细节的契约。"""
        return RuntimeBoundaryError(
            code=code,
            message=(
                "迁移前一致性备份未通过验证"
                if code == "MIGRATION_BACKUP_FAILED"
                else "持久化数据库当前不可用或 Schema migration 未完成"
            ),
            impact="业务写入、真实执行和工作区写入均被阻断；已存在数据保持不变",
            paused=True,
            data_preserved=True,
            next_action=next_action,
            trace_id=f"tr_persistence_{uuid4().hex[:12]}",
        )

    def _ensure_migration_backup(
        self,
        backup_callback: BackupCallback | None,
        *,
        source_schema_revision: str,
    ) -> BackupReceipt:
        """在 Alembic upgrade 前验证真实、完整且安全的根目录备份回执。"""
        context = MigrationBackupContext(
            persistent_root=self.persistent_root,
            database_path=self.path,
            app_version=self.app_version,
            source_schema_revision=source_schema_revision,
            target_schema_revision=SUPPORTED_REVISION,
        )
        callback = backup_callback or self._create_pre_migration_backup
        try:
            receipt = callback(context)
            if not isinstance(receipt, BackupReceipt):
                raise TypeError("backup callback did not return a BackupReceipt")
            self._validate_backup_receipt(receipt, context)
            return receipt
        except RuntimeBoundaryError:
            raise
        except Exception as error:
            # 重要安全边界：error 文本不得进入 API、app.state 或 legacyMessage。
            raise self._persistence_error(
                code="MIGRATION_BACKUP_FAILED",
                next_action="修复持久化根目录备份并重新执行批准的 Schema migration",
            ) from error

    def _create_pre_migration_backup(self, context: MigrationBackupContext) -> BackupReceipt:
        """创建根目录一致性备份包，并返回迁移前置所需的可验证回执。"""
        backup_dir = context.persistent_root / "backups"
        try:
            self._validate_storage_directories()
            backup_dir.mkdir(parents=True, exist_ok=True)
            self._validate_storage_directories()
        except (OSError, ValueError) as error:
            raise RuntimeError("backup root is not a safe directory") from error

        source_label = context.source_schema_revision.split("_", 1)[0]
        target_label = context.target_schema_revision.split("_", 1)[0]
        backup_id = f"migration-{source_label}-to-{target_label}-{uuid4().hex}"
        temporary_path: Path | None = Path(tempfile.mkdtemp(prefix=f".{backup_id}-", dir=backup_dir))
        backup_path = backup_dir / backup_id
        safety_status = dict(BACKUP_SAFETY_STATUS)
        try:
            records: dict[str, dict[str, Any]] = {}
            database_destination = temporary_path / "database" / context.database_path.name
            database_destination.parent.mkdir(parents=True, exist_ok=True)
            self._backup_sqlite_database(context.database_path, database_destination)
            self._redact_backup_credential_references(database_destination)
            records["database/company.db"] = self._stream_file_record(
                database_destination,
                scan_sensitive=True,
            )

            for directory in BACKUP_DATA_DIRECTORIES:
                copied = self._copy_persistent_directory(
                    context.persistent_root / directory,
                    temporary_path / directory,
                )
                records.update({f"{directory}/{path}": record for path, record in copied.items()})

            root_manifest = context.persistent_root / "manifest.json"
            if os.path.lexists(root_manifest):
                self._copy_checked_file(root_manifest, temporary_path / "manifest.json")
                records["manifest.json"] = self._stream_file_record(
                    temporary_path / "manifest.json",
                    scan_sensitive=True,
                )

            metadata = {
                "formatVersion": 1,
                "backupId": backup_id,
                "appVersion": context.app_version,
                "sourceSchemaRevision": context.source_schema_revision,
                "targetSchemaRevision": context.target_schema_revision,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "persistentRoot": str(context.persistent_root.resolve(strict=True)),
                "databasePath": str(context.database_path.resolve(strict=True)),
                "safetyStatus": safety_status,
            }
            self._write_backup_json(temporary_path / "backup_metadata.json", metadata)
            records["backup_metadata.json"] = self._stream_file_record(
                temporary_path / "backup_metadata.json",
                scan_sensitive=False,
            )
            file_manifest = self._build_backup_file_manifest(temporary_path, records)
            self._write_backup_json(temporary_path / "file_manifest.json", file_manifest)
            self._validate_backup_package(temporary_path, file_manifest)

            os.replace(temporary_path, backup_path)
            self._fsync_directory(backup_dir)
            temporary_path = None
            return BackupReceipt(
                backup_id=backup_id,
                root=backup_path,
                source_schema_revision=context.source_schema_revision,
                target_schema_revision=context.target_schema_revision,
                file_manifest=file_manifest,
                safety_status=safety_status,
                persistent_root=context.persistent_root.resolve(strict=True),
                database_path=context.database_path.resolve(strict=True),
            )
        finally:
            if temporary_path is not None and temporary_path.exists():
                shutil.rmtree(temporary_path)

    @staticmethod
    def _backup_sqlite_database(source_path: Path, destination_path: Path) -> None:
        """使用 SQLite backup API 创建一致性快照，并执行 integrity_check。"""
        source_stat = source_path.lstat()
        if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_size > BACKUP_MAX_FILE_SIZE:
            raise RuntimeError("source database is not a safe regular file")
        source = sqlite3.connect(str(source_path))
        destination = sqlite3.connect(str(destination_path))
        try:
            source.backup(destination)
            destination.commit()
            integrity = destination.execute("PRAGMA integrity_check").fetchone()
            if integrity != ("ok",):
                raise RuntimeError("backup integrity check failed")
        finally:
            source.close()
            destination.close()

    @staticmethod
    def _stream_file_record(path: Path, *, scan_sensitive: bool) -> dict[str, Any]:
        """以固定 chunk 读取文件，计算大小/SHA 并可在内存窗口内扫描凭据。"""
        file_stat = path.lstat()
        if not stat.S_ISREG(file_stat.st_mode):
            raise RuntimeError("backup package contains a non-regular file")
        if file_stat.st_size > BACKUP_MAX_FILE_SIZE:
            raise RuntimeError("backup file exceeds the configured size limit")
        digest = hashlib.sha256()
        scan_tail = b""
        size = 0
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(BACKUP_CHUNK_SIZE), b""):
                size += len(chunk)
                digest.update(chunk)
                if scan_sensitive:
                    scan_window = scan_tail + chunk
                    if any(pattern.search(scan_window) for pattern in _SENSITIVE_BYTES_PATTERNS):
                        raise RuntimeError("backup contains sensitive content")
                    scan_tail = scan_window[-8192:]
        if size != file_stat.st_size:
            raise RuntimeError("backup file changed while it was being scanned")
        return {"size": size, "sha256": digest.hexdigest()}

    @staticmethod
    def _redact_backup_credential_references(database_path: Path) -> None:
        """仅在备份副本中脱敏 secret_ref，原始数据库保持不变。"""
        connection = sqlite3.connect(str(database_path))
        try:
            table_exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential_configs'"
            ).fetchone()
            if table_exists:
                connection.execute(
                    "UPDATE credential_configs SET secret_ref = '[REDACTED_SECRET_REF]' "
                    "WHERE secret_ref IS NOT NULL"
                )
                connection.commit()
                if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise RuntimeError("redacted backup integrity check failed")
        finally:
            connection.close()

    def _copy_persistent_directory(
        self,
        source: Path,
        destination: Path,
    ) -> dict[str, dict[str, Any]]:
        """用 lstat/scandir 流式复制安全普通文件并返回已计算的文件摘要。"""
        destination.mkdir(parents=True, exist_ok=True)
        if not os.path.lexists(source):
            return {}
        validate_no_follow_path(source)
        source_stat = source.lstat()
        if not stat.S_ISDIR(source_stat.st_mode):
            raise RuntimeError("persistent backup source is not a real directory")
        source_root = source.resolve(strict=True)
        records: dict[str, dict[str, Any]] = {}

        def copy_directory(current: Path, target: Path) -> None:
            target.mkdir(parents=True, exist_ok=True)
            with os.scandir(current) as scanner:
                entries = sorted(scanner, key=lambda entry: entry.name)
            for entry in entries:
                source_path = Path(entry.path)
                entry_stat = entry.stat(follow_symlinks=False)
                mode = entry_stat.st_mode
                if stat.S_ISLNK(mode) or stat.S_ISSOCK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                    raise RuntimeError("persistent backup contains an unsafe filesystem entry")
                resolved = source_path.resolve(strict=True)
                if resolved != source_root and source_root not in resolved.parents:
                    raise RuntimeError("persistent backup path escapes its source directory")
                destination_path = target / entry.name
                if stat.S_ISDIR(mode):
                    copy_directory(source_path, destination_path)
                else:
                    record = self._copy_checked_file(source_path, destination_path)
                    records[destination_path.relative_to(destination).as_posix()] = record

        copy_directory(source, destination)
        return records

    def _copy_checked_file(self, source: Path, destination: Path) -> dict[str, Any]:
        """以固定 chunk 复制普通文件、扫描凭据并复用大小/SHA 结果。"""
        source_stat = source.lstat()
        if stat.S_ISLNK(source_stat.st_mode) or stat.S_ISSOCK(source_stat.st_mode) or not stat.S_ISREG(source_stat.st_mode):
            raise RuntimeError("persistent backup contains an unsafe file")
        if source_stat.st_size > BACKUP_MAX_FILE_SIZE:
            raise RuntimeError("backup file exceeds the configured size limit")
        destination.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        scan_tail = b""
        size = 0
        with source.open("rb") as source_handle, destination.open("wb") as destination_handle:
            for chunk in iter(lambda: source_handle.read(BACKUP_CHUNK_SIZE), b""):
                size += len(chunk)
                digest.update(chunk)
                scan_window = scan_tail + chunk
                if any(pattern.search(scan_window) for pattern in _SENSITIVE_BYTES_PATTERNS):
                    raise RuntimeError("persistent backup contains sensitive content")
                scan_tail = scan_window[-8192:]
                destination_handle.write(chunk)
            destination_handle.flush()
            os.fsync(destination_handle.fileno())
        if size != source_stat.st_size:
            raise RuntimeError("persistent backup source changed during copy")
        shutil.copystat(source, destination, follow_symlinks=False)
        return {"size": size, "sha256": digest.hexdigest()}

    @staticmethod
    def _write_backup_json(path: Path, value: dict[str, Any]) -> None:
        """以稳定 JSON 格式写入备份包元数据和文件清单。"""
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _iter_regular_files(root: Path) -> Iterator[Path]:
        """逐级扫描备份包，拒绝 symlink/设备/FIFO 并验证路径不越界。"""
        validate_no_follow_path(root)
        root_stat = root.lstat()
        if not stat.S_ISDIR(root_stat.st_mode):
            raise RuntimeError("backup package root is not a directory")
        root_resolved = root.resolve(strict=True)
        pending = [root]
        while pending:
            current = pending.pop()
            with os.scandir(current) as scanner:
                entries = sorted(scanner, key=lambda entry: entry.name, reverse=True)
            for entry in entries:
                path = Path(entry.path)
                mode = entry.stat(follow_symlinks=False).st_mode
                if stat.S_ISLNK(mode) or stat.S_ISSOCK(mode) or not (
                    stat.S_ISDIR(mode) or stat.S_ISREG(mode)
                ):
                    raise RuntimeError("backup package contains an unsafe filesystem entry")
                resolved = path.resolve(strict=True)
                if resolved != root_resolved and root_resolved not in resolved.parents:
                    raise RuntimeError("backup package path escapes its root")
                if stat.S_ISDIR(mode):
                    pending.append(path)
                else:
                    yield path

    @staticmethod
    def _build_backup_file_manifest(
        package_path: Path,
        records: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        """生成载荷清单；优先复用复制阶段的流式大小/SHA 结果。"""
        files: list[dict[str, Any]] = []
        total_size = 0
        for path in sorted(Database._iter_regular_files(package_path)):
            relative = path.relative_to(package_path).as_posix()
            if relative == "file_manifest.json":
                continue
            record = records.get(relative) or Database._stream_file_record(
                path,
                scan_sensitive=True,
            )
            total_size += record["size"]
            if total_size > BACKUP_MAX_TOTAL_SIZE:
                raise RuntimeError("backup package exceeds the configured total size limit")
            files.append({"path": relative, **record})
        return {"formatVersion": 1, "files": files}

    @staticmethod
    def _validate_backup_package(package_path: Path, file_manifest: dict[str, Any]) -> None:
        """严格校验清单类型、路径、重复项、大小和 SHA-256。"""
        validate_no_follow_path(package_path)
        if not isinstance(file_manifest, dict) or file_manifest.get("formatVersion") != 1:
            raise RuntimeError("invalid backup file manifest format")
        entries = file_manifest.get("files")
        if not isinstance(entries, list):
            raise RuntimeError("invalid backup file manifest entries")
        listed: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise RuntimeError("invalid backup file manifest entry")
            relative = entry.get("path")
            size = entry.get("size")
            sha256 = entry.get("sha256")
            if (
                not isinstance(relative, str)
                or not relative
                or relative in listed
                or Path(relative).as_posix() != relative
                or Path(relative).is_absolute()
                or ".." in Path(relative).parts
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or not isinstance(sha256, str)
                or not _SHA256_PATTERN.fullmatch(sha256)
            ):
                raise RuntimeError("invalid backup file manifest entry")
            listed.add(relative)
        actual = {
            path.relative_to(package_path).as_posix()
            for path in Database._iter_regular_files(package_path)
            if path.relative_to(package_path).as_posix() != "file_manifest.json"
        }
        if listed != actual:
            raise RuntimeError("backup file manifest does not cover the complete package")
        package_root = package_path.resolve(strict=True)
        total_size = 0
        for entry in entries:
            path = package_path / entry["path"]
            resolved = path.resolve(strict=True)
            if resolved != package_root and package_root not in resolved.parents:
                raise RuntimeError("backup file path escapes package")
            record = Database._stream_file_record(path, scan_sensitive=True)
            total_size += record["size"]
            if total_size > BACKUP_MAX_TOTAL_SIZE:
                raise RuntimeError("backup package exceeds the configured total size limit")
            if record["size"] != entry["size"] or record["sha256"] != entry["sha256"]:
                raise RuntimeError("backup hash validation failed")

    def _validate_backup_receipt(
        self,
        receipt: BackupReceipt,
        context: MigrationBackupContext,
    ) -> None:
        """验证回执绑定当前迁移上下文且指向真实完整的安全备份包。"""
        expected_root = context.persistent_root.resolve(strict=True)
        expected_database = context.database_path.resolve(strict=True)
        if (
            not receipt.verified
            or receipt.source_schema_revision != context.source_schema_revision
            or receipt.target_schema_revision != context.target_schema_revision
            or receipt.persistent_root is None
            or receipt.database_path is None
            or receipt.persistent_root.resolve(strict=False) != expected_root
            or receipt.database_path.resolve(strict=False) != expected_database
            or receipt.safety_status != BACKUP_SAFETY_STATUS
        ):
            raise RuntimeError("backup receipt safety status is not verified")
        backup_root_path = context.persistent_root / "backups"
        validate_no_follow_path(backup_root_path)
        backup_root = backup_root_path.resolve(strict=True)
        validate_no_follow_path(receipt.root)
        receipt_root = receipt.root.resolve(strict=True)
        if receipt_root == backup_root or backup_root not in receipt_root.parents:
            raise RuntimeError("backup receipt root is outside the backup directory")
        if receipt_root.name != receipt.backup_id or not receipt_root.is_dir():
            raise RuntimeError("backup receipt root does not match backup id")

        metadata_path = receipt_root / "backup_metadata.json"
        validate_no_follow_path(metadata_path)
        if not metadata_path.is_file() or metadata_path.lstat().st_size > 1024 * 1024:
            raise RuntimeError("backup receipt metadata is missing")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if (
            not isinstance(metadata, dict)
            or metadata.get("formatVersion") != 1
            or metadata.get("backupId") != receipt.backup_id
            or metadata.get("appVersion") != context.app_version
            or metadata.get("sourceSchemaRevision") != context.source_schema_revision
            or metadata.get("targetSchemaRevision") != context.target_schema_revision
            or metadata.get("persistentRoot") != str(expected_root)
            or metadata.get("databasePath") != str(expected_database)
            or metadata.get("safetyStatus") != BACKUP_SAFETY_STATUS
        ):
            raise RuntimeError("backup receipt metadata does not match migration context")

        for directory in BACKUP_DATA_DIRECTORIES:
            directory_path = receipt_root / directory
            validate_no_follow_path(directory_path)
            if not directory_path.is_dir():
                raise RuntimeError("backup receipt data directory is missing")

        database_path = receipt_root / "database" / "company.db"
        validate_no_follow_path(database_path)
        if not database_path.is_file() or not stat.S_ISREG(database_path.lstat().st_mode):
            raise RuntimeError("backup receipt database snapshot is missing")

        manifest_path = receipt_root / "file_manifest.json"
        validate_no_follow_path(manifest_path)
        if not manifest_path.is_file() or not stat.S_ISREG(manifest_path.lstat().st_mode):
            raise RuntimeError("backup receipt file manifest is missing")
        package_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if package_manifest != receipt.file_manifest:
            raise RuntimeError("backup receipt file manifest does not match package")
        self._validate_backup_package(receipt_root, receipt.file_manifest)
        listed_paths = {entry["path"] for entry in receipt.file_manifest.get("files", [])}
        if not {"database/company.db", "backup_metadata.json"}.issubset(listed_paths):
            raise RuntimeError("backup receipt file manifest omits required package files")

        try:
            sqlite_uri = f"file:{database_path}?mode=ro&immutable=1"
            with sqlite3.connect(sqlite_uri, uri=True) as connection:
                if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise RuntimeError("backup database integrity check failed")
                revision = connection.execute(
                    "SELECT version_num FROM alembic_version"
                ).fetchone()
                if revision is None or revision[0] != context.source_schema_revision:
                    raise RuntimeError("backup database revision does not match source revision")
        except (OSError, sqlite3.Error) as error:
            raise RuntimeError("backup database is not a valid readable SQLite snapshot") from error

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        """同步目录项，明确备份包发布使用的最小持久化保证。"""
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        """在同一 SQLite 连接上提供原子业务事务，并先验证可写 Schema。"""
        self._assert_writable()
        with self._engine.begin() as connection:
            yield connection

    @contextmanager
    def controlled_project_purge(
        self, connection: Connection, project_id: str
    ) -> Iterator[None]:
        """为指定的历史只读项目临时开启项目绑定的清理 guard。"""
        if not isinstance(project_id, str) or not project_id:
            raise ValueError("project_id is required")
        project = connection.execute(
            select(projects.c.status, projects.c.read_only).where(projects.c.id == project_id)
        ).first()
        if project is None:
            raise NotFoundError(f"project {project_id} was not found")
        if project.status not in {
            ProjectStatus.COMPLETED.value,
            ProjectStatus.TERMINATED.value,
        } or not project.read_only:
            raise ReadOnlyProjectError(
                "only completed or terminated read-only projects may be purged"
            )
        driver_connection = connection.connection.driver_connection
        state = self._purge_guard_states.get(id(driver_connection))
        if state is None:
            raise RuntimeError("purge guard is unavailable for this database connection")
        if state["authorized_project_id"] is not None:
            raise RuntimeError("purge guard is already enabled")
        state["authorized_project_id"] = project_id
        try:
            yield
        finally:
            state["authorized_project_id"] = None

    @contextmanager
    def read_connection(self) -> Iterator[Connection]:
        """提供公开只读连接；查询使用 DB/WAL/SHM 临时快照避免原库副作用。"""
        try:
            self._validate_storage_directories()
            if not self.path.is_file():
                raise OSError("database file is unavailable")
            with tempfile.TemporaryDirectory(prefix=".database-read-") as temporary_directory:
                temporary_root = Path(temporary_directory)
                snapshot_path = temporary_root / self.path.name
                shutil.copy2(self.path, snapshot_path)
                has_wal_sidecar = False
                for suffix in ("-wal", "-shm"):
                    sidecar = Path(f"{self.path}{suffix}")
                    if sidecar.exists():
                        has_wal_sidecar = True
                        shutil.copy2(sidecar, Path(f"{snapshot_path}{suffix}"))
                # WAL header without sidecars is a valid checkpointed database but a
                # copied mode=ro file cannot create its own SHM. immutable=1 reads the
                # stable main file without any side effect; active WAL snapshots keep
                # their copied sidecars and use normal mode=ro.
                read_engine = self._create_readonly_engine(
                    snapshot_path,
                    immutable=not has_wal_sidecar,
                )
                try:
                    with read_engine.connect() as connection:
                        yield connection
                finally:
                    read_engine.dispose()
        except (SQLAlchemyError, OSError) as error:
            raise self._persistence_error(
                code="PERSISTENCE_UNAVAILABLE",
                next_action="检查 SQLite 文件、权限、锁状态和持久化根目录",
            ) from error

    @contextmanager
    def _migration_connection(self) -> Iterator[Connection]:
        """仅供 Database/Alembic 内部使用的迁移连接，不作为生产写入口。"""
        with self._engine.begin() as connection:
            yield connection

    def _assert_writable(self) -> None:
        """拒绝不兼容或结构损坏 Schema，并保留其结构化 code。"""
        schema = self.check_schema()
        if schema.writable:
            return
        raise self._schema_conflict_error(
            revision=schema.revision,
            next_action=schema.next_action or "备份持久化根目录并执行批准的 Schema migration",
            code=schema.code or "VERSION_CONFLICT",
        )

    def _ensure_wal(self) -> None:
        """仅在新库/批准迁移/完整性确认后持久化开启 WAL。"""
        try:
            with self._engine.connect() as connection:
                connection.execute(text("PRAGMA journal_mode=WAL"))
                connection.commit()
        except (SQLAlchemyError, OSError) as error:
            raise self._persistence_error(
                code="PERSISTENCE_UNAVAILABLE",
                next_action="检查 SQLite WAL 权限和持久化根目录后重试",
            ) from error

    def journal_mode(self) -> str:
        """从 SQLite 文件头只读判断 journal mode，完全不打开原库连接。"""
        try:
            self._validate_storage_directories()
            if not self.path.exists():
                raise OSError("database file is missing")
            with self.path.open("rb") as handle:
                header = handle.read(20)
            if len(header) < 20 or header[:16] != b"SQLite format 3\x00":
                raise OSError("database header is invalid")
            # SQLite header offsets 18/19 are write/read versions: 2/2 means WAL,
            # 1/1 means rollback journal (DELETE/TRUNCATE/PERSIST variants).
            if header[18] == 2 and header[19] == 2:
                return "wal"
            return "delete"
        except RuntimeBoundaryError:
            raise
        except (SQLAlchemyError, OSError) as error:
            raise self._persistence_error(
                code="PERSISTENCE_UNAVAILABLE",
                next_action="检查 SQLite 文件、权限和锁状态",
            ) from error

    def current_revision(self) -> str | None:
        """只读真实 Alembic revision；空文件不被误判为 legacy。"""
        if not self.path.exists():
            return None
        try:
            with self.read_connection() as connection:
                return MigrationContext.configure(connection).get_current_revision()
        except RuntimeBoundaryError:
            raise
        except (SQLAlchemyError, OSError) as error:
            raise self._persistence_error(
                code="PERSISTENCE_UNAVAILABLE",
                next_action="检查 SQLite 文件、权限和锁状态后重试",
            ) from error

    def table_names(self) -> set[str]:
        """返回数据库表名，供只读诊断和结构验收使用。"""
        try:
            with self.read_connection() as connection:
                return set(inspect(connection).get_table_names())
        except RuntimeBoundaryError:
            raise
        except (SQLAlchemyError, OSError) as error:
            raise self._persistence_error(
                code="PERSISTENCE_UNAVAILABLE",
                next_action="检查 SQLite 文件、权限和锁状态",
            ) from error

    def check_schema(self) -> SchemaCheckResult:
        """读取 revision、WAL 前状态和结构合同；不会开启 WAL 或写入文件。"""
        if not self.path.exists():
            # 只读诊断不能为了探测新库而创建 company.db；正式初始化由 initialize() 负责。
            return SchemaCheckResult(
                writable=False,
                revision=None,
                code="VERSION_CONFLICT",
                message="Database has not been initialized",
                data_preserved=True,
                next_action="执行批准的 0002 Schema 初始化后重试",
            )
        try:
            with self.read_connection() as connection:
                revision = MigrationContext.configure(connection).get_current_revision()
                if revision != SUPPORTED_REVISION:
                    return SchemaCheckResult(
                        writable=False,
                        revision=revision,
                        code="VERSION_CONFLICT",
                        message="Database schema revision is incompatible with this application",
                        data_preserved=True,
                        next_action="Back up the persistent root and apply the approved migration path",
                    )
                try:
                    self._validate_schema_contract(connection)
                except RuntimeBoundaryError as error:
                    return SchemaCheckResult(
                        writable=False,
                        revision=revision,
                        code=error.code,
                        message=error.message,
                        data_preserved=error.data_preserved,
                        next_action=error.next_action,
                    )
                return SchemaCheckResult(
                    writable=True,
                    revision=revision,
                    code=None,
                    message="Schema revision and integrity contract are compatible",
                    data_preserved=True,
                    next_action=None,
                )
        except RuntimeBoundaryError:
            raise
        except (SQLAlchemyError, OSError) as error:
            raise self._persistence_error(
                code="PERSISTENCE_UNAVAILABLE",
                next_action="检查 SQLite 文件、权限和锁状态",
            ) from error

    def _validate_schema_contract(self, connection: Connection) -> None:
        """只读检查表、索引、FK、CHECK、唯一约束和不可变触发器。"""
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())
        required = TASK1_TABLES | set(TASK2_TABLES) | {"alembic_version"}
        if not required.issubset(tables):
            raise self._schema_conflict_error(
                revision=SUPPORTED_REVISION,
                code="SCHEMA_INTEGRITY_CONFLICT",
                next_action="恢复完整 Schema 或沿批准 migration 修复后重试",
            )

        actual_indexes = {
            (table_name, item.get("name"), tuple(item.get("column_names") or ()))
            for table_name, _, _ in SCHEMA_INDEX_CONTRACTS
            for item in inspector.get_indexes(table_name)
        }
        if not set(SCHEMA_INDEX_CONTRACTS).issubset(actual_indexes):
            raise self._schema_conflict_error(
                revision=SUPPORTED_REVISION,
                code="SCHEMA_INTEGRITY_CONFLICT",
                next_action="恢复关键索引及其 project_id 列定义后重试",
            )

        actual_uniques = {
            (table_name, item.get("name"), tuple(item.get("column_names") or ()))
            for table_name, _, _ in SCHEMA_UNIQUE_CONTRACTS
            for item in inspector.get_unique_constraints(table_name)
        }
        if not set(SCHEMA_UNIQUE_CONTRACTS).issubset(actual_uniques):
            raise self._schema_conflict_error(
                revision=SUPPORTED_REVISION,
                code="SCHEMA_INTEGRITY_CONFLICT",
                next_action="恢复关键唯一约束及其列定义后重试",
            )

        actual_foreign_keys = {
            (
                table_name,
                item.get("name") or "",
                tuple(item.get("constrained_columns") or ()),
                item.get("referred_table"),
                tuple(item.get("referred_columns") or ()),
            )
            for table_name, _, _, _, _ in SCHEMA_FOREIGN_KEY_CONTRACTS
            for item in inspector.get_foreign_keys(table_name)
        }
        if not set(SCHEMA_FOREIGN_KEY_CONTRACTS).issubset(actual_foreign_keys):
            raise self._schema_conflict_error(
                revision=SUPPORTED_REVISION,
                code="SCHEMA_INTEGRITY_CONFLICT",
                next_action="恢复关键外键及其复合列映射后重试",
            )

        def normalize_sql(value: str) -> str:
            """归一化 SQLite Inspector SQL，保留约束语义而忽略格式差异。"""
            return " ".join(value.lower().replace('"', "").strip().rstrip(";").split())

        actual_checks = {
            (table_name, item.get("name"), normalize_sql(item.get("sqltext") or ""))
            for table_name, _, _ in SCHEMA_CHECK_CONTRACTS
            for item in inspector.get_check_constraints(table_name)
        }
        expected_checks = {
            (table_name, name, normalize_sql(sqltext))
            for table_name, name, sqltext in SCHEMA_CHECK_CONTRACTS
        }
        if not expected_checks.issubset(actual_checks):
            raise self._schema_conflict_error(
                revision=SUPPORTED_REVISION,
                code="SCHEMA_INTEGRITY_CONFLICT",
                next_action="恢复状态、优先级、JSON 和非负计数 CHECK 后重试",
            )

        trigger_rows = connection.execute(
            text("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
        ).mappings()
        actual_triggers = {row["name"]: normalize_sql(row["sql"] or "") for row in trigger_rows}
        expected_triggers = {
            trigger_name: normalize_sql(sql)
            for trigger_name, sql in TRIGGER_SQL_CONTRACTS.items()
        }
        # 不能只看名称或若干 token：同名空 trigger、不可达 CASE 和缺少实体
        # 分支的弱化实现必须被判定为结构完整性冲突。
        if any(actual_triggers.get(name) != expected_sql for name, expected_sql in expected_triggers.items()):
            raise self._schema_conflict_error(
                revision=SUPPORTED_REVISION,
                code="SCHEMA_INTEGRITY_CONFLICT",
                next_action="恢复关键 immutable/TraceLink 项目隔离 trigger 后重试",
            )
        self._probe_trace_link_trigger_behavior(connection)

    def _probe_trace_link_trigger_behavior(
        self,
        connection: Connection,
    ) -> None:
        """在临时 SQLite 副本执行同项目、跨项目和 unsupported 探针。

        该探针只读取生产连接中的真实 DDL，再在内存库执行；不会向生产数据库
        写入任何行，避免 integrity checker 为了验证 trigger 而产生副作用。
        """
        try:
            table_rows = connection.execute(
                text(
                    "SELECT name, sql FROM sqlite_master "
                    "WHERE type = 'table' AND name IN ("
                    + ",".join(f"'{name}'" for name in TASK2_TABLE_ORDER)
                    + ")"
                )
            ).mappings()
            table_sql = {row["name"]: row["sql"] for row in table_rows}
            if set(table_sql) != set(TASK2_TABLE_ORDER):
                raise ValueError("trace link probe tables are incomplete")

            trigger_sql = {
                name: connection.execute(
                    text("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name"),
                    {"name": name},
                ).scalar_one()
                for name in TRIGGER_SQL_CONTRACTS
            }

            probe = sqlite3.connect(":memory:")
            try:
                probe.execute("PRAGMA foreign_keys=ON")
                for table_name in TASK2_TABLE_ORDER:
                    probe.executescript(table_sql[table_name])
                for trigger_name in (
                    "trg_trace_links_project_scope_insert",
                    "trg_trace_links_project_scope_update",
                ):
                    probe.executescript(trigger_sql[trigger_name])

                project_values = (
                    "INSERT INTO projects "
                    "(id,name,business_goal,target_users,priority,constraints_json,stage,status,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)"
                )
                for project_id in ("probe_project_one", "probe_project_two"):
                    probe.execute(
                        project_values,
                        (
                            project_id,
                            "Probe",
                            "Goal",
                            "Users",
                            "P0",
                            "{}",
                            "立项",
                            "准备中",
                            "2026-08-16T00:00:00+00:00",
                        ),
                    )
                task_values = (
                    "INSERT INTO tasks "
                    "(id,project_id,title,owner_role,specialist_tag,assignment_reason,priority,"
                    "dependencies_json,expected_deliverables_json,status,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                )
                for task_id, project_id in (
                    ("probe_task_one", "probe_project_one"),
                    ("probe_task_two", "probe_project_two"),
                ):
                    probe.execute(
                        task_values,
                        (
                            task_id,
                            project_id,
                            "Task",
                            "developer",
                            "backend",
                            "probe",
                            "P0",
                            "[]",
                            "[]",
                            "待处理",
                            "2026-08-16T00:00:00+00:00",
                        ),
                    )

                trace_values = (
                    "INSERT INTO trace_links "
                    "(id,project_id,source_type,source_id,target_type,target_id,relation,trace_id,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)"
                )
                probe.execute(
                    trace_values,
                    (
                        "probe_valid",
                        "probe_project_one",
                        "task",
                        "probe_task_one",
                        "task",
                        "probe_task_one",
                        "covers",
                        "probe_trace_valid",
                        "2026-08-16T00:00:00+00:00",
                    ),
                )
                probe.commit()

                def must_reject(parameters: tuple[str, ...], statement: str) -> None:
                    try:
                        probe.execute(statement, parameters)
                    except sqlite3.IntegrityError:
                        probe.rollback()
                        return
                    raise ValueError("TraceLink project-scope probe unexpectedly succeeded")

                must_reject(
                    (
                        "probe_cross_source",
                        "probe_project_two",
                        "task",
                        "probe_task_one",
                        "task",
                        "probe_task_two",
                        "covers",
                        "probe_trace_cross_source",
                        "2026-08-16T00:00:00+00:00",
                    ),
                    trace_values,
                )
                must_reject(
                    (
                        "probe_cross_target",
                        "probe_project_one",
                        "task",
                        "probe_task_one",
                        "task",
                        "probe_task_two",
                        "covers",
                        "probe_trace_cross_target",
                        "2026-08-16T00:00:00+00:00",
                    ),
                    trace_values,
                )
                must_reject(
                    ("probe_project_two", "probe_valid"),
                    "UPDATE trace_links SET project_id=? WHERE id=?",
                )
                must_reject(
                    (
                        "probe_unsupported",
                        "probe_project_one",
                        "unsupported",
                        "x",
                        "task",
                        "probe_task_one",
                        "covers",
                        "probe_trace_unsupported",
                        "2026-08-16T00:00:00+00:00",
                    ),
                    trace_values,
                )
            finally:
                probe.close()
        except (sqlite3.Error, TypeError, ValueError, SQLAlchemyError) as error:
            raise self._schema_conflict_error(
                revision=SUPPORTED_REVISION,
                code="SCHEMA_INTEGRITY_CONFLICT",
                next_action="恢复可执行的 TraceLink 项目隔离 trigger 后重试",
            ) from error

    def file_digest(self) -> str:
        """计算主库及 WAL/SHM sidecar 的逻辑摘要，证明阻断检查无副作用。"""
        try:
            self._validate_storage_directories()
            digest = hashlib.sha256()
            for path in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm")):
                digest.update(path.name.encode("utf-8"))
                if os.path.lexists(path):
                    if not stat.S_ISREG(path.lstat().st_mode):
                        raise OSError("database companion is not a regular file")
                    with path.open("rb") as handle:
                        for chunk in iter(lambda: handle.read(BACKUP_CHUNK_SIZE), b""):
                            digest.update(chunk)
                else:
                    digest.update(b"<absent>")
            return digest.hexdigest()
        except RuntimeBoundaryError:
            raise
        except (OSError, SQLAlchemyError) as error:
            raise self._persistence_error(
                code="PERSISTENCE_UNAVAILABLE",
                next_action="检查 SQLite 文件、权限和 WAL/SHM sidecar",
            ) from error

    def close(self) -> None:
        """释放内部连接资源；不暴露可写 engine。"""
        self._engine.dispose()

    def save_credential_config(
        self,
        provider: str,
        model: str,
        secret_ref: str,
        *,
        config_version: str = "1",
        connection_status: str = "unknown",
    ) -> None:
        """保存不含明文凭据的模型配置引用。"""
        now = datetime.now(timezone.utc)
        with self.transaction() as connection:
            connection.execute(
                text(
                    "INSERT INTO credential_configs "
                    "(provider, model, secret_ref, config_version, connection_status, created_at, updated_at) "
                    "VALUES (:provider, :model, :secret_ref, :config_version, :connection_status, :created_at, :updated_at)"
                ),
                {
                    "provider": provider,
                    "model": model,
                    "secret_ref": secret_ref,
                    "config_version": config_version,
                    "connection_status": connection_status,
                    "created_at": now,
                    "updated_at": now,
                },
            )

    def append_event(self, event_type: str, trace_id: str, payload: str) -> None:
        """追加一条带 trace 的运行事实事件。"""
        now = datetime.now(timezone.utc)
        with self.transaction() as connection:
            connection.execute(
                text(
                    "INSERT INTO runtime_events "
                    "(event_type, trace_id, payload, occurred_at) "
                    "VALUES (:event_type, :trace_id, :payload, :occurred_at)"
                ),
                {"event_type": event_type, "trace_id": trace_id, "payload": payload, "occurred_at": now},
            )

    def read_event_text(self) -> str:
        """读取事件载荷文本，供脱敏和安全测试扫描。"""
        with self.read_connection() as connection:
            rows = connection.execute(text("SELECT payload FROM runtime_events ORDER BY id")).scalars()
            return "\n".join(str(payload) for payload in rows)

    def write_runtime_state(self, status: str, reason: str) -> None:
        """原子替换当前运行状态，确保重启后能恢复最后提交事实。"""
        now = datetime.now(timezone.utc)
        with self.transaction() as connection:
            connection.execute(text("DELETE FROM runtime_state"))
            connection.execute(
                text(
                    "INSERT INTO runtime_state (status, reason, updated_at) "
                    "VALUES (:status, :reason, :updated_at)"
                ),
                {"status": status, "reason": reason, "updated_at": now},
            )

    def read_runtime_state(self):
        """读取最近一次运行状态。"""
        with self.read_connection() as connection:
            row = connection.execute(
                text("SELECT status, reason, updated_at FROM runtime_state ORDER BY id DESC LIMIT 1")
            ).mappings().first()
        return row

    def runtime_snapshot(self):
        """返回可序列化的当前运行状态快照。"""
        state = self.read_runtime_state()
        return dict(state) if state else None

    def execution_event_count(self) -> int:
        """统计执行类事件数量，确认 readiness 没有触发真实执行。"""
        with self.read_connection() as connection:
            return int(
                connection.execute(
                    text("SELECT COUNT(*) FROM runtime_events WHERE event_type LIKE '%Execution%'")
                ).scalar_one()
            )

    def save_worker_lease(self, worker_id: str, heartbeat_at: datetime, status: str) -> None:
        """保存 Worker 最新租约，避免同一 Worker 留下多条活动记录。"""
        with self.transaction() as connection:
            connection.execute(text("DELETE FROM worker_leases WHERE worker_id = :worker_id"), {"worker_id": worker_id})
            connection.execute(
                text(
                    "INSERT INTO worker_leases (worker_id, heartbeat_at, status) "
                    "VALUES (:worker_id, :heartbeat_at, :status)"
                ),
                {"worker_id": worker_id, "heartbeat_at": heartbeat_at, "status": status},
            )

    def read_worker_leases(self):
        """按 Worker 标识读取租约，供生命周期服务判断过期状态。"""
        with self.read_connection() as connection:
            return list(
                connection.execute(
                    text("SELECT worker_id, heartbeat_at, status FROM worker_leases ORDER BY worker_id")
                ).tuples()
            )

    def _alembic_config(self) -> Config:
        """构造绑定当前数据库和迁移目录的内部 Alembic 配置。"""
        backend_root = Path(__file__).resolve().parents[2]
        config = Config(str(backend_root / "alembic.ini"))
        config.set_main_option("script_location", str(backend_root / "alembic"))
        config.set_main_option("sqlalchemy.url", f"sqlite:///{self.path}")
        return config
